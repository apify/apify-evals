import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { DatasetItemMetadata, DeterministicCheck } from '@apify-evals/contract';
import { Actor, log } from 'apify';

import { DEMO_ITEMS } from './demo-dataset.js';

const execFile = promisify(execFileCb);

const OUTPUT_PREVIEW_CAP = 500;

interface Input {
    datasetName?: string;
    experimentName?: string;
    runName?: string;
    harness?: Partial<{ kind: string; model: string; maxTurns: number }>;
    concurrency?: number;
    perItemTimeoutSecs?: number;
    itemLimit?: number;
    categories?: string[];
    mcpUrl?: string;
    useOpenRouterProxy?: boolean;
    createDemoDataset?: boolean;
    artifactStore?: string;
    langfuseBaseUrl?: string;
    langfusePublicKey?: string;
    langfuseSecretKey?: string;
}

await Actor.init();
const input = ((await Actor.getInput()) ?? {}) as Input;
const {
    datasetName = 'runner-poc',
    experimentName = 'runner-poc',
    runName,
    harness: harnessInput,
    concurrency = 4,
    perItemTimeoutSecs = 300,
    itemLimit = 0,
    categories = [],
    mcpUrl = 'https://mcp.apify.com',
    useOpenRouterProxy = true,
    createDemoDataset = false,
    artifactStore: artifactStoreId,
} = input;

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

// Merge partial harness input over defaults so {kind:'claude-code'} still gets a model.
const harness = {
    kind: 'claude-code',
    model: 'anthropic/claude-haiku-4.5',
    maxTurns: DEFAULT_MAX_TURNS,
    ...(harnessInput ?? {}),
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

async function ensureDataset() {
    try {
        return await langfuse.dataset.get(datasetName);
    } catch (err) {
        // PoC shortcut: the SDK throws no typed 404, so fall back to message
        // sniffing. Tighten once the SDK exposes a status code reliably.
        const notFound =
            (err as { statusCode?: number })?.statusCode === 404 ||
            /not found/i.test(String((err as Error)?.message ?? ''));
        if (!createDemoDataset || !notFound) throw err;
        log.info(`Dataset "${datasetName}" not found, creating demo dataset`);
        await langfuse.api.datasets.create({ name: datasetName, description: 'Runner PoC demo dataset' });
        for (const item of DEMO_ITEMS) {
            await langfuse.dataset.createItem({ datasetName, ...item });
        }
        // Re-fetch: the create API returns no items; get() returns the full FetchedDataset.
        return langfuse.dataset.get(datasetName);
    }
}

const dataset = await ensureDataset();
const filtered = dataset.items
    .filter((i) => i.status !== 'ARCHIVED')
    .filter((i) => categories.length === 0 || categories.includes((i.metadata as DatasetItemMetadata)?.category ?? ''));
const items = itemLimit > 0 ? filtered.slice(0, itemLimit) : filtered;
log.info(
    `Dataset "${datasetName}": running ${items.length} items, concurrency ${concurrency}, harness ${harness.kind}/${harness.model}`,
);

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

const suiteStarted = Date.now();
let result;
try {
    result = await langfuse.experiment.run({
        name: experimentName,
        ...(runName ? { runName } : {}),
        description: `Runner: ${harness.kind} / ${harness.model}`,
        metadata: {
            harness: harness.kind,
            model: harness.model,
            surface: 'mcp',
            runner: 'workflow-runner',
            actorRunId: process.env.ACTOR_RUN_ID ?? null,
            environment: process.env.ACTOR_RUN_ID ? 'apify' : 'local',
        },
        data: items,
        maxConcurrency: concurrency,
        task: async (item) => {
            const r = await runSession({
                item: item as never,
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

const summary = {
    datasetName,
    datasetRunId: result.datasetRunId ?? null,
    datasetRunName: result.runName ?? null,
    datasetRunUrl: result.datasetRunUrl ?? null,
    items: items.length,
    // itemResults excludes items whose task threw (broken harness); the gap
    // between items and completed is the health signal (spec D13).
    completed: result.itemResults.length,
    suiteMs,
    harness: harness.kind,
    model: harness.model,
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
await Actor.exit();
