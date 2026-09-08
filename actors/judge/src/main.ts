import { Actor, log } from 'apify';

interface Input {
    mode?: 'datasetRun' | 'online';
    datasetRunId?: string;
    sampleRate?: number;
    maxItems?: number;
    windowStart?: string;
    windowEnd?: string;
    judgeModel?: string;
    promptLabel?: string;
    force?: boolean;
    concurrency?: number;
    langfuseBaseUrl?: string;
    langfusePublicKey?: string;
    langfuseSecretKey?: string;
}

await Actor.init();
const input = ((await Actor.getInput()) ?? {}) as Input;
const {
    mode = 'datasetRun',
    datasetRunId,
    sampleRate = 0.2,
    maxItems = 100,
    judgeModel = 'anthropic/claude-sonnet-4.6',
    promptLabel = 'production',
    force = false,
    concurrency = 4,
} = input;
if (mode === 'datasetRun' && !datasetRunId) {
    throw new Error('datasetRunId is required (the Runner returns it in its OUTPUT)');
}

// Env must be set before the Langfuse SDK loads (it captures env at module load).
for (const [inputKey, envKey] of [
    ['langfuseBaseUrl', 'LANGFUSE_BASE_URL'],
    ['langfusePublicKey', 'LANGFUSE_PUBLIC_KEY'],
    ['langfuseSecretKey', 'LANGFUSE_SECRET_KEY'],
] as const) {
    if (input[inputKey]) process.env[envKey] = input[inputKey];
    if (!process.env[envKey]) throw new Error(`Missing ${envKey} (set it as Actor input or env var)`);
}

const { LangfuseClient } = await import('@langfuse/client');

/** Seam for #269: judge the sampled traces. Until then nothing is judged. */
// TODO(#269): replace with the online judge. TODO(#270): write the scores AND
// move the checkpoint write (now inside selectTraces) behind the score write;
// with it before scoring, a process death mid-batch loses the window's sample.
async function judgeOnline(_traceIds: string[]): Promise<{ judged: number; failedToJudge: number }> {
    return { judged: 0, failedToJudge: 0 };
}

if (mode === 'online') {
    const { actorCheckpointStore, langfuseObservationFetcher, selectTraces } = await import('./select.js');
    const selection = await selectTraces({
        now: new Date(),
        sampleRate,
        maxItems,
        override: { windowStart: input.windowStart, windowEnd: input.windowEnd },
        rng: Math.random,
        fetchPage: langfuseObservationFetcher(new LangfuseClient()),
        checkpoints: actorCheckpointStore(),
        runId: Actor.getEnv().actorRunId,
    });
    const { judged, failedToJudge } = await judgeOnline(selection.sampledTraceIds);
    const summary = {
        mode,
        window: selection.window
            ? { start: selection.window.start.toISOString(), end: selection.window.end.toISOString() }
            : null,
        checkpointWritten: selection.checkpointWritten,
        tracesInWindow: selection.tracesInWindow,
        completedTraces: selection.completedTraces,
        sampled: selection.sampled,
        judged,
        failedToJudge,
        sampledTraceIds: selection.sampledTraceIds,
    };
    log.info(`SUMMARY: ${JSON.stringify(summary, null, 2)}`);
    await Actor.setValue('OUTPUT', summary);
    // Actor.exit() ends the process; the datasetRun flow below never runs in this mode.
    await Actor.exit();
}
// Type narrowing only: the datasetRun guard above already threw when it was missing.
if (!datasetRunId) throw new Error('unreachable: datasetRunId checked above');

const {
    DEFAULT_JUDGE_PROMPT,
    JUDGE_IMPL_VERSION,
    JUDGE_PROMPT_NAME,
    RUBRIC_VERSION,
    buildScoreboard,
    judgeOne,
    loadDeterministicResults,
    loadJudgedTraceIds,
    loadRunItems,
    renderScoreboard,
} = await import('./core.js');

const apifyToken = process.env.APIFY_TOKEN;
if (!apifyToken) throw new Error('No APIFY_TOKEN available (needed for the judge LLM and artifact reads)');

const langfuse = new LangfuseClient();

// Resolve the judge prompt by label ONCE per batch and stamp that exact version
// into every score (decision 5): never judge mid-batch off a mutable label.
async function resolvePrompt() {
    try {
        return await langfuse.prompt.get(JUDGE_PROMPT_NAME, { label: promptLabel, type: 'text' });
    } catch (err) {
        // Seed ONLY on not-found; any other failure (network, auth) must not
        // create a surprise new "production" prompt version.
        const notFound =
            (err as { statusCode?: number })?.statusCode === 404 ||
            /not found/i.test(String((err as Error)?.message ?? ''));
        if (!notFound) throw err;
        log.info(`Judge prompt "${JUDGE_PROMPT_NAME}" not found, seeding the default`);
        return langfuse.prompt.create({
            name: JUDGE_PROMPT_NAME,
            type: 'text',
            prompt: DEFAULT_JUDGE_PROMPT,
            labels: [promptLabel],
        });
    }
}
const promptClient = await resolvePrompt();
const version = {
    rubricVersion: RUBRIC_VERSION,
    judgeModel,
    promptVersion: promptClient.version,
    judgeImplVersion: JUDGE_IMPL_VERSION,
};

const items = await loadRunItems(langfuse, datasetRunId);
const judgedTraceIds = await loadJudgedTraceIds(
    langfuse,
    datasetRunId,
    version,
    items.map((i) => i.traceId),
);
log.info(
    `Judging dataset run ${datasetRunId}: ${items.length} items, model ${judgeModel}, prompt v${promptClient.version}`,
);

const results: Awaited<ReturnType<typeof judgeOne>>[] = [];
let next = 0;
async function worker() {
    while (next < items.length) {
        const item = items[next++];
        try {
            const r = await judgeOne({
                langfuse,
                item,
                apifyToken: apifyToken as string,
                judgeModel,
                promptTemplate: promptClient.prompt as string,
                version,
                datasetRunId: datasetRunId as string,
                judgedTraceIds,
                force,
            });
            results.push(r);
            log.info(`${item.experimentItemId}: ${r.status}${r.overall ? ` overall=${r.overall}` : ''}`);
        } catch (err) {
            log.error(`${item.experimentItemId}: judge failed: ${err}`);
            results.push({
                experimentItemId: item.experimentItemId,
                traceId: item.traceId,
                status: 'error',
                error: String(err).slice(0, 300),
            });
        }
    }
}
await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
await langfuse.flush();

const judged = results.filter((r) => r.status === 'judged');
const deterministic = await loadDeterministicResults(
    langfuse,
    items.map((i) => i.traceId),
);
const scoreboard = buildScoreboard(results, deterministic);
const skippedCount = results.filter((r) => r.status === 'skipped-already-judged').length;
await Actor.setValue('SCOREBOARD', renderScoreboard(scoreboard, datasetRunId, skippedCount), {
    contentType: 'text/markdown',
});
const summary = {
    datasetRunId,
    items: items.length,
    judged: judged.length,
    passed: judged.filter((r) => r.overall === 'pass').length,
    skippedAlreadyJudged: results.filter((r) => r.status === 'skipped-already-judged').length,
    skippedNoTrace: results.filter((r) => r.status === 'skipped-no-trace').length,
    errors: results.filter((r) => r.status === 'error').length,
    degraded: judged.filter((r) => r.degraded).length,
    version,
    scoreboard,
};
log.info(`SUMMARY: ${JSON.stringify(summary, null, 2)}`);

await Actor.pushData(results as unknown as Record<string, unknown>[]);
await Actor.setValue('OUTPUT', summary);
await Actor.exit();
