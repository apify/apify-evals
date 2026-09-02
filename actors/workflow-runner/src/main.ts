import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { DatasetItemMetadata, DeterministicCheck } from '@apify-evals/contract';
import { Actor, log } from 'apify';

const execFile = promisify(execFileCb);

const OUTPUT_PREVIEW_CAP = 500;
const DEFAULT_JUDGE_ACTOR = 'artogahr/eval-judge';

interface Input {
    datasetName?: string;
    /** Deprecated: the experiment is always named after the dataset so all runs share one compare view. */
    experimentName?: string;
    runName?: string;
    model?: string;
    harness?: Partial<{ kind: string; model: string; maxTurns: number }>;
    repeats?: number;
    judge?: boolean;
    judgeModel?: string;
    concurrency?: number;
    perItemTimeoutSecs?: number;
    itemLimit?: number;
    categories?: string[];
    mcpUrl?: string;
    useOpenRouterProxy?: boolean;
    artifactStore?: string;
    langfuseBaseUrl?: string;
    langfusePublicKey?: string;
    langfuseSecretKey?: string;
}

interface JudgeOutput {
    items?: number;
    judged?: number;
    passed?: number;
    passRate?: number | null;
    foundRate?: number | null;
    worksRate?: number | null;
    errors?: number;
    scoreboard?: unknown[];
    fixAreas?: Record<string, number>;
}

await Actor.init();
const input = ((await Actor.getInput()) ?? {}) as Input;
const {
    datasetName = 'store-actors',
    runName,
    model: modelInput,
    harness: harnessInput,
    repeats = 1,
    judge = true,
    judgeModel = 'anthropic/claude-sonnet-4.6',
    concurrency = 4,
    perItemTimeoutSecs = 300,
    itemLimit = 0,
    categories = [],
    mcpUrl = 'https://mcp.apify.com',
    useOpenRouterProxy = true,
    artifactStore: artifactStoreId,
} = input;
if (input.experimentName && input.experimentName !== datasetName) {
    log.warning(`experimentName is ignored; runs are grouped under the dataset name "${datasetName}"`);
}

// Credentials: input wins, env fallback. Env must be set BEFORE the Langfuse
// modules load, because parts of the SDK capture process.env at module load;
// the dynamic imports below guarantee that ordering.
for (const [inputKey, envKey] of [
    ['langfuseBaseUrl', 'LANGFUSE_BASE_URL'],
    ['langfusePublicKey', 'LANGFUSE_PUBLIC_KEY'],
    ['langfuseSecretKey', 'LANGFUSE_SECRET_KEY'],
] as const) {
    if (input[inputKey]) process.env[envKey] = input[inputKey];
    if (!process.env[envKey]) throw new Error(`Missing ${envKey} (set it as Actor input or env var)`);
}

const { LangfuseClient } = await import('@langfuse/client');
const { LangfuseSpanProcessor } = await import('@langfuse/otel');
const { NodeSDK } = await import('@opentelemetry/sdk-node');
const { runSession, validateHarness, DEFAULT_MAX_TURNS } = await import('./harness.js');
const { ArtifactStore, SnapshotCache } = await import('./artifacts.js');

// `model` is the team-facing input; the `harness` object stays accepted for
// older callers. Merge partial harness input over defaults.
const harness = {
    kind: 'claude-code',
    model: 'anthropic/claude-haiku-4.5',
    maxTurns: DEFAULT_MAX_TURNS,
    ...(harnessInput ?? {}),
    ...(modelInput ? { model: modelInput } : {}),
};
validateHarness(harness);

// APIFY token: injected on platform; via CLI when run locally. Always required
// now: the named artifact store lives in the cloud even for local runs.
let apifyToken = process.env.APIFY_TOKEN;
if (!apifyToken) {
    try {
        apifyToken = (await execFile('apify', ['auth', 'token'], { timeout: 10_000 })).stdout.trim();
        process.env.APIFY_TOKEN = apifyToken;
    } catch {
        /* stays undefined */
    }
}
if (!apifyToken) throw new Error('No APIFY_TOKEN available (needed for artifacts, MCP, and the OpenRouter proxy)');

const otel = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
otel.start();
const langfuse = new LangfuseClient();
const artifactStore = await ArtifactStore.open(artifactStoreId);
const snapshots = new SnapshotCache(artifactStore, mcpUrl, apifyToken);

const dataset = await langfuse.dataset.get(datasetName);
const filtered = dataset.items
    .filter((i) => i.status !== 'ARCHIVED')
    .filter((i) => categories.length === 0 || categories.includes((i.metadata as DatasetItemMetadata)?.category ?? ''));
const selected = itemLimit > 0 ? filtered.slice(0, itemLimit) : filtered;
// Repeats: each repeat is its own experiment item, so every average (compare
// view, dashboards) already accounts for it and flaky scenarios show as x/N.
const safeRepeats = Math.max(1, Math.min(10, Math.floor(repeats)));
const items = Array.from({ length: safeRepeats }, () => selected).flat();
log.info(
    `Dataset "${datasetName}": ${selected.length} scenarios x${safeRepeats}, concurrency ${concurrency}, harness ${harness.kind}/${harness.model}`,
);
if (items.length === 0) throw new Error(`No scenarios selected (categories=${JSON.stringify(categories)})`);

/** Deterministic health-gate checks declared per item as metadata.checks.
 * A malformed check writes a failing `check-error` score instead of vanishing. */
function runChecks(output: unknown, metadata: unknown) {
    const checks = ((metadata as DatasetItemMetadata)?.checks ?? []) as DeterministicCheck[];
    const text = String(output);
    return checks.flatMap((check) => {
        try {
            if (check.type === 'contains') {
                return [
                    {
                        name: 'check.contains',
                        value: text.toLowerCase().includes(check.value.toLowerCase()) ? 1 : 0,
                        comment: `contains: ${check.value}`,
                    },
                ];
            }
            if (check.type === 'regex') {
                return [
                    {
                        name: 'check.regex',
                        value: new RegExp(check.value, 'i').test(text) ? 1 : 0,
                        comment: `regex: ${check.value}`,
                    },
                ];
            }
            return [];
        } catch (err) {
            return [{ name: 'check.error', value: 0, comment: `${check.type}: ${check.value} → ${err}` }];
        }
    });
}

// Human-readable run name: "<dataset> · <model> · 2026-09-02 14:05". The
// experiment is always the dataset, so every run lands in one compare view.
const shortModel = harness.model.replace(/^[^/]+\//, '');
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const effectiveRunName = runName ?? `${datasetName} · ${shortModel} · ${stamp}`;
const actorRunId = process.env.ACTOR_RUN_ID ?? null;
const consoleRunUrl = actorRunId ? `https://console.apify.com/actors/runs/${actorRunId}` : null;

const suiteStarted = Date.now();
let result;
try {
    result = await langfuse.experiment.run({
        name: datasetName,
        runName: effectiveRunName,
        description: [`Runner: ${harness.kind} / ${harness.model}`, judge ? `Judge: ${judgeModel}` : 'Not judged', consoleRunUrl]
            .filter(Boolean)
            .join(' · '),
        metadata: {
            harness: harness.kind,
            model: harness.model,
            surface: 'mcp',
            runner: 'workflow-runner',
            actorRunId,
            repeats: safeRepeats,
            environment: actorRunId ? 'apify' : 'local',
        },
        data: items,
        maxConcurrency: concurrency,
        task: async (item) => {
            const r = await runSession({
                item: item as never,
                datasetName,
                harness,
                mcpUrl,
                apifyToken,
                useOpenRouterProxy,
                perItemTimeoutSecs,
                artifactStore,
                snapshots,
            });
            return r.output;
        },
        // Real scoring belongs to the Judge Actor (#244); these are health gates.
        evaluators: [async ({ output, metadata }) => runChecks(output, metadata)],
    });
} finally {
    // Flush all telemetry even when the run fails, so completed items keep
    // their traces (the judge handoff depends on them).
    try {
        await otel.shutdown();
    } catch (err) {
        log.warning(`OTel shutdown failed: ${err}`);
    }
    try {
        await langfuse.flush();
    } catch (err) {
        log.warning(`Langfuse flush failed: ${err}`);
    }
}

const suiteMs = Date.now() - suiteStarted;
const datasetRunId = result.datasetRunId ?? null;

// The compare view is the team-facing results page: one row per scenario,
// scores as columns, this run as the baseline.
const datasetRunUrl: string | null = result.datasetRunUrl ?? null;
const urlParts = datasetRunUrl?.match(/^(https?:\/\/[^/]+)\/project\/([^/]+)\//);
const resultsUrl =
    urlParts && datasetRunId
        ? `${urlParts[1]}/project/${urlParts[2]}/experiments/results?baseline=${datasetRunId}`
        : datasetRunUrl;

// Judge: a separate Actor (re-gradable, spec D9) that the runner starts so a
// single Run click produces scored results. Its Langfuse credentials come from
// its own Actor env vars; only the run id and the artifact grant are passed.
let judgeOutput: JudgeOutput | null = null;
let judgeRunUrl: string | null = null;
if (judge && datasetRunId) {
    const judgeActor = process.env.JUDGE_ACTOR ?? DEFAULT_JUDGE_ACTOR;
    log.info(`Starting judge ${judgeActor} for run ${datasetRunId}`);
    try {
        const judgeRun = await Actor.call(
            judgeActor,
            { datasetRunId, judgeModel, ...(artifactStoreId ? { artifactStore: artifactStoreId } : {}) },
            { memory: 1024, timeout: 1800 },
        );
        judgeRunUrl = `https://console.apify.com/actors/runs/${judgeRun.id}`;
        if (judgeRun.status !== 'SUCCEEDED') {
            log.error(`Judge run ${judgeRun.id} ended with ${judgeRun.status}`);
        } else {
            const record = await Actor.apifyClient.keyValueStore(judgeRun.defaultKeyValueStoreId).getRecord('OUTPUT');
            judgeOutput = (record?.value ?? null) as JudgeOutput | null;
        }
    } catch (err) {
        log.error(`Judge failed: ${err}`);
    }
}

const summary = {
    resultsUrl,
    passRate: judgeOutput?.passRate ?? null,
    passed: judgeOutput?.passed ?? null,
    judged: judgeOutput?.judged ?? null,
    foundRate: judgeOutput?.foundRate ?? null,
    worksRate: judgeOutput?.worksRate ?? null,
    fixAreas: judgeOutput?.fixAreas ?? null,
    scoreboard: judgeOutput?.scoreboard ?? null,
    judgeRunUrl,
    datasetName,
    datasetRunId,
    datasetRunName: result.runName ?? null,
    datasetRunUrl,
    scenarios: selected.length,
    repeats: safeRepeats,
    items: items.length,
    // itemResults excludes items whose task threw (broken harness); the gap
    // between items and completed is the health signal (spec D13).
    completed: result.itemResults.length,
    suiteMs,
    harness: harness.kind,
    model: harness.model,
    judgeModel: judge ? judgeModel : null,
};
log.info(`SUMMARY: ${JSON.stringify(summary, null, 2)}`);

await Actor.pushData(
    result.itemResults.map((r) => ({
        input: r.input,
        output: typeof r.output === 'string' ? r.output.slice(0, OUTPUT_PREVIEW_CAP) : r.output,
        expectedOutput: r.expectedOutput ?? null,
        evaluations: r.evaluations ?? [],
        traceId: r.traceId ?? null,
    })),
);
await Actor.setValue('OUTPUT', summary);
if (summary.passRate !== null) {
    log.info(`Pass rate ${Math.round(summary.passRate * 100)}% (${summary.passed}/${summary.judged} scenarios)`);
}
log.info(`Results: ${resultsUrl}`);
await Actor.exit();
