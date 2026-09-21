import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { type DatasetItemMetadata, validateDatasetItemMetadata } from '@apify-evals/contract';
import { Actor, log } from 'apify';

const execFile = promisify(execFileCb);

const OUTPUT_PREVIEW_CAP = 500;
const DEFAULT_JUDGE_ACTOR = 'artogahr/eval-judge';
const OPENROUTER_PROXY_URL = 'https://openrouter.apify.actor/api';

/**
 * Exit codes (spec D14: run status = system health, scores = results).
 * 0 ran and judged (scenario failures are results, not errors);
 * 10 health: too few sessions completed; 11 judge failed; 12 nothing
 * selected; 13 telemetry flush failed; 14 preflight failed (MCP or proxy).
 */
const EXIT = { ok: 0, health: 10, judge: 11, nothing: 12, flush: 13, preflight: 14 } as const;

interface Input {
    datasetName?: string;
    /** Deprecated: the experiment is always named after the dataset so all runs share one compare view. */
    experimentName?: string;
    runName?: string;
    model?: string;
    models?: string[];
    harness?: Partial<{ kind: string; model: string; maxTurns: number }>;
    repeats?: number;
    judge?: boolean;
    judgeModel?: string;
    concurrency?: number;
    perItemTimeoutSecs?: number;
    itemLimit?: number;
    /** Team-facing filters: subject ids (owner/name) and owners (teams). */
    subjects?: string[];
    owners?: string[];
    /** Deprecated alias of subjects, matched against metadata.category (slug). */
    categories?: string[];
    healthThreshold?: number | string;
    skipPreflight?: boolean;
    trigger?: string;
    /** Post the Slack digest for this run (scheduled runs post by default). */
    notify?: boolean;
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
    conclusive?: number;
    inconclusive?: number;
    passed?: number;
    passRate?: number | null;
    foundRate?: number | null;
    worksRate?: number | null;
    checksPassed?: number;
    checksTotal?: number;
    disagreements?: number;
    actorRunsCostUsd?: number;
    errors?: number;
    scoreboard?: unknown[];
    fixAreas?: Record<string, number>;
    flaky?: unknown[];
}

await Actor.init();
const input = ((await Actor.getInput()) ?? {}) as Input;
const {
    datasetName = 'store-actors',
    runName,
    model: modelInput,
    models: modelsInput,
    harness: harnessInput,
    repeats = 1,
    judge = true,
    judgeModel = 'anthropic/claude-sonnet-4.6',
    concurrency = 4,
    perItemTimeoutSecs = 300,
    itemLimit = 0,
    subjects = [],
    owners = [],
    categories = [],
    healthThreshold: healthThresholdInput = 0.9,
    skipPreflight = false,
    mcpUrl = 'https://mcp.apify.com',
    useOpenRouterProxy = true,
} = input;
// The schema carries the threshold as a string (Apify has no float editor).
const healthThreshold = Math.min(1, Math.max(0, Number(healthThresholdInput) || 0.9));
// Artifact store: the resource-picker grant when given, else the store id
// from the Actor environment (schedules and tasks do not need the picker).
const artifactStoreId = input.artifactStore ?? process.env.ARTIFACT_STORE_ID ?? undefined;
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
const { CODEX_PROVIDER } = await import('./adapters/codex.js');
const { ArtifactStore, SnapshotCache, fetchToolSchemas } = await import('./artifacts.js');
const { ReferenceRunner } = await import('./evidence.js');
const { postDigest } = await import('./notify.js');

// `model` / `models` are the team-facing inputs; the `harness` object stays
// accepted for older callers. Merge partial harness input over defaults.
const baseHarness = {
    kind: 'claude-code',
    model: 'anthropic/claude-haiku-4.5',
    maxTurns: DEFAULT_MAX_TURNS,
    ...(harnessInput ?? {}),
    ...(modelInput ? { model: modelInput } : {}),
};
validateHarness(baseHarness);
const models = modelsInput && modelsInput.length > 0 ? [...new Set(modelsInput)] : [baseHarness.model];

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
const references = new ReferenceRunner();
const writeScore = async (score: {
    traceId: string;
    observationId: string;
    name: string;
    value: number;
    comment: string;
}) => {
    await langfuse.api.scores.create({ ...score, dataType: 'NUMERIC' });
};

// ---------------------------------------------------------------------------
// Scenario selection and scope
// ---------------------------------------------------------------------------

const dataset = await langfuse.dataset.get(datasetName);
// Fail fast on malformed scenarios: a typo in `skill` or `checks` would
// otherwise silently drop the item from every aggregate.
const invalid = dataset.items
    .filter((i) => i.status !== 'ARCHIVED' && !validateDatasetItemMetadata(i.metadata ?? {}))
    .map((i) => `${i.id}: ${JSON.stringify(validateDatasetItemMetadata.errors)}`);
if (invalid.length > 0) throw new Error(`Invalid scenario metadata in "${datasetName}":\n${invalid.join('\n')}`);

type Meta = DatasetItemMetadata & { subject?: { id?: string }; owner?: string };
const meta = (i: { metadata?: unknown }) => (i.metadata ?? {}) as Meta;
const subjectOf = (m: Meta) => m.subject?.id ?? m.actor ?? '';
const ownerOf = (m: Meta) => m.owner ?? m.team ?? '';
const slugOf = (s: string) => s.split('/').pop() ?? s;
const wantSubjects = new Set([...subjects, ...categories].map((s) => s.trim()).filter(Boolean));
const wantOwners = new Set(owners.map((o) => o.trim()).filter(Boolean));

const filtered = dataset.items
    .filter((i) => i.status !== 'ARCHIVED')
    .filter((i) => {
        const m = meta(i);
        const subject = subjectOf(m);
        const bySubject =
            wantSubjects.size === 0 ||
            wantSubjects.has(subject) ||
            wantSubjects.has(slugOf(subject)) ||
            wantSubjects.has(m.category ?? '');
        const byOwner = wantOwners.size === 0 || wantOwners.has(ownerOf(m));
        return bySubject && byOwner;
    });
const selected = itemLimit > 0 ? filtered.slice(0, itemLimit) : filtered;
const safeRepeats = Math.max(1, Math.min(10, Math.floor(repeats)));
// Repeats: each repeat is its own experiment item, so every average (compare
// view, dashboards) already accounts for it and flaky scenarios show as x/N.
const items = Array.from({ length: safeRepeats }, () => selected).flat();

// Scope: what this run covers. Full-scope runs feed the OKR trend; filtered
// runs (a team checking their own Actors) are compared in the compare view
// and must not move the run-level averages.
const scopeParts: string[] = [];
if (wantOwners.size > 0) scopeParts.push(`owner:${[...wantOwners].join(',')}`);
if (wantSubjects.size > 0) scopeParts.push(`subject:${[...wantSubjects].map(slugOf).join(',')}`);
if (itemLimit > 0) scopeParts.push(`limit:${itemLimit}`);
const scope = scopeParts.length === 0 ? 'all' : scopeParts.join(' ');
const fullScope = scope === 'all';
const trigger = input.trigger ?? (process.env.APIFY_META_ORIGIN ?? 'unknown').toLowerCase();

log.info(
    `Dataset "${datasetName}": ${selected.length} scenarios x${safeRepeats}, scope ${scope}, models ${models.join(', ')}, concurrency ${concurrency}, trigger ${trigger}`,
);
if (items.length === 0) {
    log.error(
        `No scenarios selected (subjects=${JSON.stringify(subjects)}, owners=${JSON.stringify(owners)}, categories=${JSON.stringify(categories)})`,
    );
    await Actor.setValue('OUTPUT', { error: 'no scenarios selected', scope, datasetName });
    await Actor.exit({ exitCode: EXIT.nothing, statusMessage: 'No scenarios matched the filters' });
}

// ---------------------------------------------------------------------------
// Preflight: fail in seconds, not after 18 sessions fail the same way.
// ---------------------------------------------------------------------------

if (!skipPreflight) {
    const problems: string[] = [];
    const firstTools = (meta(selected[0]).tools ?? ['fetch-actor-details']) as string[];
    try {
        const schemas = await fetchToolSchemas(mcpUrl, firstTools, apifyToken);
        if (schemas.length === 0) problems.push(`MCP server ${mcpUrl} returned no tools for ${firstTools.join(',')}`);
    } catch (err) {
        problems.push(`MCP server ${mcpUrl} unreachable: ${String((err as Error).message ?? err).slice(0, 200)}`);
    }
    if (useOpenRouterProxy) {
        try {
            const codex = baseHarness.kind === 'codex';
            const res = await fetch(
                codex ? `${CODEX_PROVIDER.base_url}/responses` : `${OPENROUTER_PROXY_URL}/v1/chat/completions`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${apifyToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(
                        codex
                            ? { model: models[0], input: 'ping', max_output_tokens: 16 }
                            : { model: models[0], max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
                    ),
                    signal: AbortSignal.timeout(20_000),
                },
            );
            if (!res.ok)
                problems.push(
                    `LLM proxy HTTP ${res.status} for model ${models[0]}: ${(await res.text()).slice(0, 200)}`,
                );
        } catch (err) {
            problems.push(`LLM proxy unreachable: ${String((err as Error).message ?? err).slice(0, 200)}`);
        }
    }
    if (problems.length > 0) {
        for (const p of problems) log.error(`preflight: ${p}`);
        await Actor.setValue('OUTPUT', { error: 'preflight failed', problems, scope, datasetName });
        await Actor.exit({ exitCode: EXIT.preflight, statusMessage: `Preflight failed: ${problems[0]}` });
    }
    log.info('preflight ok: MCP tools listed, LLM proxy answered');
}

// ---------------------------------------------------------------------------
// One experiment per model (spec D6), sequential so pass rates stay comparable.
// ---------------------------------------------------------------------------

const actorRunId = process.env.ACTOR_RUN_ID ?? null;
const consoleRunUrl = actorRunId ? `https://console.apify.com/actors/runs/${actorRunId}` : null;
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

interface ModelRunSummary {
    model: string;
    resultsUrl: string | null;
    datasetRunId: string | null;
    datasetRunName: string | null;
    datasetRunUrl: string | null;
    items: number;
    completed: number;
    suiteMs: number;
    judge: JudgeOutput | null;
    judgeRunUrl: string | null;
    judgeError: string | null;
    judgeDatasetId: string | null;
    projectBase: string | null;
}

const summaries: ModelRunSummary[] = [];
let flushFailed = false;

for (const model of models) {
    const harness = { ...baseHarness, model };
    const shortModel = model.replace(/^[^/]+\//, '');
    const nameParts = [datasetName, shortModel];
    if (harness.kind !== 'claude-code') nameParts.push(harness.kind);
    if (!fullScope) nameParts.push(scope);
    if (safeRepeats > 1) nameParts.push(`×${safeRepeats}`);
    nameParts.push(stamp);
    if (trigger !== 'unknown') nameParts.push(trigger);
    const effectiveRunName = runName ?? nameParts.join(' · ');

    const started = Date.now();
    let result;
    try {
        result = await langfuse.experiment.run({
            name: datasetName,
            runName: effectiveRunName,
            description: [
                `Runner: ${harness.kind} / ${model}`,
                `Scope: ${scope}`,
                judge ? `Judge: ${judgeModel}` : 'Not judged',
                consoleRunUrl,
            ]
                .filter(Boolean)
                .join(' · '),
            metadata: {
                harness: harness.kind,
                model,
                surface: 'mcp',
                runner: 'workflow-runner',
                actorRunId,
                repeats: safeRepeats,
                scope,
                fullScope,
                trigger,
                scenarioCount: selected.length,
                models,
                environment: actorRunId ? 'apify' : 'local',
            },
            data: items,
            maxConcurrency: concurrency,
            task: async (item) => {
                const r = await runSession({
                    item: item as never,
                    datasetName,
                    trigger,
                    repeats: safeRepeats,
                    harness,
                    mcpUrl,
                    apifyToken,
                    useOpenRouterProxy,
                    perItemTimeoutSecs,
                    artifactStore,
                    snapshots,
                    references,
                    writeScore,
                });
                return r.output;
            },
            // Deterministic checks are scored inside runSession (they need the
            // evidence); the LLM rubric belongs to the Judge Actor.
            evaluators: [],
        });
    } finally {
        // Flush telemetry after every model so completed items keep their
        // traces even if a later model breaks (the judge handoff depends on them).
        try {
            await langfuse.flush();
        } catch (err) {
            flushFailed = true;
            log.warning(`Langfuse flush failed: ${err}`);
        }
    }

    const datasetRunId = result.datasetRunId ?? null;
    const datasetRunUrl: string | null = result.datasetRunUrl ?? null;
    const urlParts = datasetRunUrl?.match(/^(https?:\/\/[^/]+)\/project\/([^/]+)\//);
    // The compare view is the team-facing results page: one row per scenario,
    // scores as columns, this run as the baseline.
    const resultsUrl =
        urlParts && datasetRunId
            ? `${urlParts[1]}/project/${urlParts[2]}/experiments/results?baseline=${datasetRunId}`
            : datasetRunUrl;

    // Judge: a separate Actor (re-gradable, spec D9) that the runner starts so a
    // single Run click produces scored results. Its Langfuse credentials come from
    // its own Actor env vars; only the run id and the artifact grant are passed.
    let judgeOutput: JudgeOutput | null = null;
    let judgeRunUrl: string | null = null;
    let judgeError: string | null = null;
    let judgeDatasetId: string | null = null;
    if (judge && datasetRunId) {
        const judgeActor = process.env.JUDGE_ACTOR ?? DEFAULT_JUDGE_ACTOR;
        log.info(`Starting judge ${judgeActor} for run ${datasetRunId}`);
        try {
            const judgeRun = await Actor.call(
                judgeActor,
                {
                    datasetRunId,
                    judgeModel,
                    writeRunScores: fullScope,
                    ...(artifactStoreId ? { artifactStore: artifactStoreId } : {}),
                },
                { memory: 1024, timeout: 1800 },
            );
            judgeRunUrl = `https://console.apify.com/actors/runs/${judgeRun.id}`;
            judgeDatasetId = judgeRun.defaultDatasetId;
            if (judgeRun.status !== 'SUCCEEDED') {
                judgeError = `judge run ${judgeRun.id} ended with ${judgeRun.status}`;
                log.error(judgeError);
            } else {
                const record = await Actor.apifyClient
                    .keyValueStore(judgeRun.defaultKeyValueStoreId)
                    .getRecord('OUTPUT');
                judgeOutput = (record?.value ?? null) as JudgeOutput | null;
            }
        } catch (err) {
            judgeError = String((err as Error).message ?? err).slice(0, 300);
            log.error(`Judge failed: ${judgeError}`);
        }
    }

    await Actor.pushData(
        result.itemResults.map((r) => ({
            model,
            input: r.input,
            output: typeof r.output === 'string' ? r.output.slice(0, OUTPUT_PREVIEW_CAP) : r.output,
            expectedOutput: r.expectedOutput ?? null,
            traceId: r.traceId ?? null,
        })),
    );

    summaries.push({
        model,
        resultsUrl,
        datasetRunId,
        datasetRunName: result.runName ?? null,
        datasetRunUrl,
        items: items.length,
        // itemResults excludes items whose task threw (broken harness); the gap
        // between items and completed is the health signal (spec D13).
        completed: result.itemResults.length,
        suiteMs: Date.now() - started,
        judge: judgeOutput,
        judgeRunUrl,
        judgeError,
        judgeDatasetId,
        projectBase: urlParts ? `${urlParts[1]}/project/${urlParts[2]}` : null,
    });
    log.info(`Model ${model}: ${result.itemResults.length}/${items.length} sessions completed; results ${resultsUrl}`);
}

try {
    await otel.shutdown();
} catch (err) {
    log.warning(`OTel shutdown failed: ${err}`);
}

// ---------------------------------------------------------------------------
// OUTPUT and exit code
// ---------------------------------------------------------------------------

const first = summaries[0];
const totalItems = summaries.reduce((a, s) => a + s.items, 0);
const totalCompleted = summaries.reduce((a, s) => a + s.completed, 0);
const completedRatio = totalItems === 0 ? 1 : totalCompleted / totalItems;
const judgeFailed = judge && summaries.some((s) => s.judgeError !== null);

const summary = {
    resultsUrl: first.resultsUrl,
    passRate: first.judge?.passRate ?? null,
    passed: first.judge?.passed ?? null,
    judged: first.judge?.judged ?? null,
    inconclusive: first.judge?.inconclusive ?? null,
    foundRate: first.judge?.foundRate ?? null,
    worksRate: first.judge?.worksRate ?? null,
    checksPassed: first.judge?.checksPassed ?? null,
    checksTotal: first.judge?.checksTotal ?? null,
    disagreements: first.judge?.disagreements ?? null,
    actorRunsCostUsd: first.judge?.actorRunsCostUsd ?? null,
    fixAreas: first.judge?.fixAreas ?? null,
    flaky: first.judge?.flaky ?? null,
    scoreboard: first.judge?.scoreboard ?? null,
    judgeRunUrl: first.judgeRunUrl,
    datasetName,
    scope,
    fullScope,
    trigger,
    datasetRunId: first.datasetRunId,
    datasetRunName: first.datasetRunName,
    datasetRunUrl: first.datasetRunUrl,
    scenarios: selected.length,
    repeats: safeRepeats,
    items: first.items,
    completed: first.completed,
    suiteMs: first.suiteMs,
    harness: baseHarness.kind,
    model: first.model,
    models,
    judgeModel: judge ? judgeModel : null,
    health: { completedRatio: Number(completedRatio.toFixed(3)), threshold: healthThreshold, judgeFailed, flushFailed },
    // One entry per model when `models` was given; the top-level fields mirror the first.
    runs: summaries,
};
log.info(`SUMMARY: ${JSON.stringify(summary, null, 2)}`);
await Actor.setValue('OUTPUT', summary);
if (summary.passRate !== null) {
    log.info(`Pass rate ${Math.round(summary.passRate * 100)}% (${summary.passed}/${summary.judged} scenarios)`);
}
for (const s of summaries) log.info(`Results (${s.model}): ${s.resultsUrl}`);

// Slack digest: scheduled runs post by default, manual runs only when asked.
// Per-scenario rows come from the judge's dataset; the previous pass rate
// from the last run-level pass_rate score that is not this run's.
if (input.notify ?? trigger === 'schedule') {
    for (const s of summaries) {
        if (!s.judge || !s.judgeDatasetId) continue;
        try {
            const judgeItems = (
                await Actor.apifyClient.dataset(s.judgeDatasetId).listItems({ clean: true, limit: 1000 })
            ).items as {
                title?: string;
                itemOwner?: string;
                itemTeam?: string;
                itemSubject?: string;
                itemActor?: string;
                verdictLabel?: string;
                fixArea?: string;
                traceId?: string;
                overallEvidence?: string;
                status?: string;
            }[];
            let previousPassRate: number | null = null;
            if (fullScope) {
                try {
                    const page = (await langfuse.api.scoresV3.getManyV3({
                        name: 'pass_rate',
                        limit: 10,
                        fields: 'subject',
                    })) as unknown as {
                        data?: { value?: unknown; subject?: { id?: string } }[];
                    };
                    const prev = (page.data ?? []).find((sc) => sc.subject?.id && sc.subject.id !== s.datasetRunId);
                    previousPassRate = prev && typeof prev.value === 'number' ? prev.value : null;
                } catch (err) {
                    log.warning(`previous pass rate lookup failed: ${err}`);
                }
            }
            const sent = await postDigest({
                suite: datasetName,
                model: s.model,
                scope,
                fullScope,
                trigger,
                resultsUrl: s.resultsUrl,
                runName: s.datasetRunName,
                passRate: s.judge.passRate ?? null,
                previousPassRate,
                judged: s.judge.judged ?? 0,
                passed: s.judge.passed ?? 0,
                inconclusive: s.judge.inconclusive ?? 0,
                disagreements: s.judge.disagreements ?? 0,
                actorRunsCostUsd: s.judge.actorRunsCostUsd ?? null,
                fixAreas: s.judge.fixAreas ?? {},
                scenarios: judgeItems
                    .filter((it) => it.status === 'judged')
                    .map((it) => ({
                        title: it.title ?? 'untitled scenario',
                        owner: it.itemOwner ?? it.itemTeam ?? 'unknown',
                        subject: it.itemSubject ?? it.itemActor ?? 'unknown',
                        verdict: it.verdictLabel ?? 'unknown',
                        fixArea: it.fixArea ?? 'none',
                        traceUrl: it.traceId && s.projectBase ? `${s.projectBase}/traces/${it.traceId}` : null,
                        reason: it.overallEvidence ?? '',
                    })),
            });
            log.info(`Slack digest: ${sent} message(s) posted for ${s.model}`);
        } catch (err) {
            log.warning(`Slack digest failed: ${err}`);
        }
    }
}

let exitCode: number = EXIT.ok;
let statusMessage = `${totalCompleted}/${totalItems} sessions, pass rate ${summary.passRate === null ? 'n/a' : `${Math.round(summary.passRate * 100)}%`}`;
if (completedRatio < healthThreshold) {
    exitCode = EXIT.health;
    statusMessage = `Health: only ${totalCompleted}/${totalItems} sessions completed (threshold ${healthThreshold})`;
} else if (judgeFailed) {
    exitCode = EXIT.judge;
    statusMessage = `Judge failed: ${summaries.find((s) => s.judgeError)?.judgeError}`;
} else if (flushFailed) {
    exitCode = EXIT.flush;
    statusMessage = 'Langfuse flush failed; some traces may be missing';
}
if (exitCode !== EXIT.ok) log.error(statusMessage);
await Actor.exit({ exitCode, statusMessage });
