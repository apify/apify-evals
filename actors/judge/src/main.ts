import { Actor, log } from 'apify';

interface Input {
    mode?: 'datasetRun' | 'online';
    datasetRunId?: string;
    sampleRate?: number;
    maxItems?: number;
    windowStart?: string;
    windowEnd?: string;
    environment?: string;
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
    promptLabel = 'production',
    force = false,
    concurrency = 4,
} = input;
// Per-mode default: the offline suite keeps Sonnet; online scoring runs on
// every sampled production turn, so it defaults to the cheaper flash model.
const judgeModel =
    input.judgeModel ?? (mode === 'online' ? 'deepseek/deepseek-v4-flash' : 'anthropic/claude-sonnet-4.6');
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
const { resolveOrSeedPrompt } = await import('./prompt.js');

const apifyToken = process.env.APIFY_TOKEN;
if (!apifyToken) throw new Error('No APIFY_TOKEN available (needed for the judge LLM and artifact reads)');

if (mode === 'online') {
    const { actorCheckpointStore, DEFAULT_ENVIRONMENT, langfuseObservationFetcher, selectTraces } =
        await import('./select.js');
    const environment = input.environment ?? DEFAULT_ENVIRONMENT;
    const { DEFAULT_ONLINE_JUDGE_PROMPT, ONLINE_JUDGE_PROMPT_NAME, judgeOnlineTrace } =
        await import('./online-judge.js');
    const { mcpToolSchemaSource } = await import('./online-schema.js');
    const langfuse = new LangfuseClient();

    /**
     * Score every sampled trace (ai-team#269). Returns the verdicts and writes
     * NOTHING to Langfuse: TODO(#270) write the scores from `verdicts`, AND move
     * the checkpoint write (now inside selectTraces) behind that write; with it
     * before scoring, a process death mid-batch loses the window's sample.
     */
    async function judgeOnline(traceIds: string[]) {
        if (traceIds.length === 0) return { judged: 0, failedToJudge: 0, verdicts: [] };
        const prompt = await resolveOrSeedPrompt(langfuse, {
            name: ONLINE_JUDGE_PROMPT_NAME,
            label: promptLabel,
            defaultPrompt: DEFAULT_ONLINE_JUDGE_PROMPT,
        });
        // One tools/list per batch; a failure omits argumentCorrectness for the
        // whole batch rather than failing every trace.
        const schemas = await mcpToolSchemaSource({ token: apifyToken as string })
            .load()
            .catch((err: unknown) => {
                log.warning(`MCP tools/list failed, argumentCorrectness will be omitted: ${err}`);
                return null;
            });
        log.info(
            `Judging ${traceIds.length} traces: model ${judgeModel}, prompt v${prompt.version}, live toolset ${schemas?.hash}`,
        );

        const verdicts: Awaited<ReturnType<typeof judgeOnlineTrace>>[] = [];
        let failedToJudge = 0;
        let next = 0;
        async function onlineWorker() {
            while (next < traceIds.length) {
                const traceId = traceIds[next++];
                try {
                    const v = await judgeOnlineTrace({
                        langfuse,
                        traceId,
                        apifyToken: apifyToken as string,
                        judgeModel,
                        promptTemplate: prompt.template,
                        promptVersion: prompt.version,
                        schemas,
                    });
                    verdicts.push(v);
                    const holistic = v.scores.find((s) => s.name === 'agent_judge');
                    log.info(
                        `${traceId}: judged, agent_judge=${holistic && 'value' in holistic ? holistic.value : 'n/a'}`,
                    );
                } catch (err) {
                    // One bad trace must not abort the batch.
                    failedToJudge++;
                    log.error(`${traceId}: judge failed: ${err}`);
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, traceIds.length) }, onlineWorker));
        return { judged: verdicts.length, failedToJudge, verdicts };
    }

    const selection = await selectTraces({
        now: new Date(),
        sampleRate,
        maxItems,
        override: { windowStart: input.windowStart, windowEnd: input.windowEnd },
        rng: Math.random,
        fetchPage: langfuseObservationFetcher(langfuse),
        checkpoints: actorCheckpointStore(),
        runId: Actor.getEnv().actorRunId,
        environment,
    });
    const { judged, failedToJudge } = await judgeOnline(selection.sampledTraceIds);
    const summary = {
        mode,
        environment,
        window: selection.window
            ? { start: selection.window.start.toISOString(), end: selection.window.end.toISOString() }
            : null,
        checkpointWritten: selection.checkpointWritten,
        isGateBroken: selection.isGateBroken,
        tracesInWindow: selection.tracesInWindow,
        completedTraces: selection.completedTraces,
        sampled: selection.sampled,
        judged,
        failedToJudge,
        sampledTraceIds: selection.sampledTraceIds,
    };
    log.info(`SUMMARY: ${JSON.stringify(summary, null, 2)}`);
    await Actor.setValue('OUTPUT', summary);
    // Fail the run on a broken completion gate, after OUTPUT is written: a
    // SUCCEEDED run selecting nothing forever is invisible, while an Apify
    // run-status alert already covers a FAILED one (#271 needs no extra monitor).
    if (selection.isGateBroken) {
        await Actor.fail(
            `Completion gate broken: ${selection.tracesInWindow} traces in the window, none completed. ` +
                'The checkpoint was not moved; see OUTPUT.',
        );
    }
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

const langfuse = new LangfuseClient();

// Resolve the judge prompt by label ONCE per batch and stamp that exact version
// into every score (decision 5): never judge mid-batch off a mutable label.
const promptClient = await resolveOrSeedPrompt(langfuse, {
    name: JUDGE_PROMPT_NAME,
    label: promptLabel,
    defaultPrompt: DEFAULT_JUDGE_PROMPT,
});
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
                promptTemplate: promptClient.template,
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
