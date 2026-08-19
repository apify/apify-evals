import { Actor, log } from 'apify';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const OUTPUT_PREVIEW_CAP = 500;

const DEMO_ITEMS = [
    {
        input: { prompt: 'What is 2+2? Reply with just the number.' },
        expectedOutput: '4',
        metadata: { category: 'basic' },
    },
    {
        input: { prompt: 'Use the Bash tool to compute 17*23 and report just the number.' },
        expectedOutput: '391',
        metadata: { category: 'tools', allowBash: true },
    },
    {
        input: {
            prompt: 'Using the Apify tools, search the Apify store for an Instagram scraper and reply with the full name (username/name) of the most popular one.',
        },
        expectedOutput: 'apify/instagram-scraper',
        metadata: { category: 'mcp', tools: ['search-actors'], maxTurns: 8 },
    },
];

await Actor.init();
const input = (await Actor.getInput()) ?? {};
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
} = input;

// Credentials: input wins, env fallback. Env must be set BEFORE the Langfuse
// modules load, because parts of the SDK capture process.env at module load;
// the dynamic imports below guarantee that ordering.
for (const [inputKey, envKey] of [
    ['langfuseBaseUrl', 'LANGFUSE_BASE_URL'],
    ['langfusePublicKey', 'LANGFUSE_PUBLIC_KEY'],
    ['langfuseSecretKey', 'LANGFUSE_SECRET_KEY'],
]) {
    if (input[inputKey]) process.env[envKey] = input[inputKey];
    if (!process.env[envKey]) throw new Error(`Missing ${envKey} (set it as Actor input or env var)`);
}

const { LangfuseClient } = await import('@langfuse/client');
const { LangfuseSpanProcessor } = await import('@langfuse/otel');
const { NodeSDK } = await import('@opentelemetry/sdk-node');
const { runSession, validateHarness, DEFAULT_MAX_TURNS } = await import('./harness.js');

// Merge partial harness input over defaults so {kind:'claude-code'} still gets a model.
const harness = {
    kind: 'claude-code',
    model: 'anthropic/claude-haiku-4.5',
    maxTurns: DEFAULT_MAX_TURNS,
    ...(harnessInput ?? {}),
};
validateHarness(harness);

// APIFY token: injected on platform; via CLI when run locally. Required for
// the OpenRouter proxy and for items that use MCP tools (checked after the
// dataset is loaded, so proxy-less runs without MCP items need no token).
let apifyToken = process.env.APIFY_TOKEN;
if (!apifyToken) {
    try {
        apifyToken = (await execFile('apify', ['auth', 'token'], { timeout: 10_000 })).stdout.trim();
    } catch {
        /* stays undefined */
    }
}

const otel = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
otel.start();
const langfuse = new LangfuseClient();

async function ensureDataset() {
    try {
        return await langfuse.dataset.get(datasetName);
    } catch (err) {
        // PoC shortcut: the SDK throws no typed 404, so fall back to message
        // sniffing. Tighten once the SDK exposes a status code reliably.
        const notFound = err?.statusCode === 404 || /not found/i.test(String(err?.message ?? ''));
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
    .filter((i) => categories.length === 0 || categories.includes(i.metadata?.category));
const items = itemLimit > 0 ? filtered.slice(0, itemLimit) : filtered;
log.info(
    `Dataset "${datasetName}": running ${items.length} items, concurrency ${concurrency}, harness ${harness.kind}/${harness.model}`,
);

const needsApifyToken = useOpenRouterProxy || items.some((i) => i.metadata?.tools?.length > 0);
if (needsApifyToken && !apifyToken) {
    throw new Error('No APIFY_TOKEN available (needed for the OpenRouter proxy and MCP items)');
}

const suiteStarted = Date.now();
let result;
try {
    result = await langfuse.experiment.run({
        name: experimentName,
        ...(runName ? { runName } : {}),
        description: `Runner PoC: ${harness.kind} / ${harness.model}`,
        metadata: {
            harness: harness.kind,
            model: harness.model,
            surface: 'mcp',
            runner: 'runner-poc',
            actorRunId: process.env.ACTOR_RUN_ID ?? null,
            environment: process.env.ACTOR_RUN_ID ? 'apify' : 'local',
        },
        data: items,
        maxConcurrency: concurrency,
        task: async (item) => {
            const r = await runSession({ item, harness, mcpUrl, apifyToken, useOpenRouterProxy, perItemTimeoutSecs });
            return r.output;
        },
        // Deterministic health-gate evaluator; real scoring belongs to the Judge Actor (#244)
        evaluators: [
            async ({ output, expectedOutput }) => {
                if (expectedOutput == null || expectedOutput === '') return []; // no ground truth, no score
                return [
                    {
                        name: 'contains-expected',
                        value: String(output).toLowerCase().includes(String(expectedOutput).toLowerCase()) ? 1 : 0,
                    },
                ];
            },
        ],
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
