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
    /** Run-level scores feed the OKR trend; the runner passes false for filtered (partial) runs. */
    writeRunScores?: boolean;
    /** Langfuse annotation queue that receives every non-pass plus a sample of passes for human review ('' disables). */
    auditQueue?: string;
    auditPassSample?: number | string;
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
    writeRunScores = true,
    auditQueue = 'judge-audit',
    auditPassSample: auditPassSampleInput = 0.1,
} = input;
// Per-mode default: the offline suite keeps Sonnet; online scoring runs on
// every sampled production turn, so it defaults to the cheaper flash model.
const judgeModel =
    input.judgeModel ?? (mode === 'online' ? 'deepseek/deepseek-v4-flash' : 'anthropic/claude-sonnet-4.6');
if (mode === 'datasetRun' && !datasetRunId) {
    throw new Error('datasetRunId is required (the Runner returns it in its OUTPUT)');
}
const auditPassSample = Math.min(1, Math.max(0, Number(auditPassSampleInput) || 0));

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
    const { JUDGE_IMPL_VERSION } = await import('./core.js');
    const { finishOnlineRun, langfuseOnlineScoreReader, skipAlreadyJudged } = await import('./online-scores.js');
    const langfuse = new LangfuseClient();
    const now = new Date();

    /** Score every trace (ai-team#269). Returns the verdicts; writing them is the step after. */
    async function judgeOnline(traceIds: string[], prompt: { version: number; template: string }) {
        if (traceIds.length === 0) return { judged: 0, failedToJudge: 0, metadataMissing: 0, verdicts: [] };
        // One tools/list per batch; a failure omits argumentCorrectness for the
        // whole batch rather than failing every trace.
        const schemas = await mcpToolSchemaSource({ token: apifyToken as string })
            .load()
            .catch((err: unknown) => {
                log.warning(`MCP tools/list failed, argumentCorrectness will be omitted: ${err}`);
                return null;
            });
        const toolset = schemas ? `live toolset ${schemas.hash}` : 'no live toolset (argumentCorrectness omitted)';
        log.info(`Judging ${traceIds.length} traces: model ${judgeModel}, prompt v${prompt.version}, ${toolset}`);

        const verdicts: Awaited<ReturnType<typeof judgeOnlineTrace>>['verdicts'][] = [];
        let failedToJudge = 0;
        let metadataMissing = 0;
        let next = 0;
        async function onlineWorker() {
            while (next < traceIds.length) {
                const traceId = traceIds[next++];
                try {
                    const { verdicts: v, traceMetadataFound } = await judgeOnlineTrace({
                        langfuse,
                        traceId,
                        apifyToken: apifyToken as string,
                        judgeModel,
                        promptTemplate: prompt.template,
                        promptVersion: prompt.version,
                        schemas,
                    });
                    verdicts.push(v);
                    if (!traceMetadataFound) metadataMissing++;
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
        // Which of the three metadata locations is real is unproven; a batch where
        // none yielded anything says the reader, not the traces, is wrong.
        if (metadataMissing > 0) {
            log.warning(
                `${metadataMissing} of ${verdicts.length} judged traces carried no trace metadata (outcome, toolSchemaHash)`,
            );
        }
        return { judged: verdicts.length, failedToJudge, metadataMissing, verdicts };
    }

    // 1. Select. The checkpoint is NOT written here (writeCheckpoint: false):
    // it moves only after the window's scores and rollup are in Langfuse.
    const checkpoints = actorCheckpointStore();
    const selection = await selectTraces({
        now,
        sampleRate,
        maxItems,
        override: { windowStart: input.windowStart, windowEnd: input.windowEnd },
        rng: Math.random,
        fetchPage: langfuseObservationFetcher(langfuse),
        checkpoints,
        runId: Actor.getEnv().actorRunId,
        environment,
        writeCheckpoint: false,
    });

    // 2. Resolve the prompt once per batch (its version is part of the score
    // id), then drop traces already judged under this exact version BEFORE
    // judging, so a re-run costs no LLM calls.
    const prompt =
        selection.sampled > 0
            ? await resolveOrSeedPrompt(langfuse, {
                  name: ONLINE_JUDGE_PROMPT_NAME,
                  label: promptLabel,
                  defaultPrompt: DEFAULT_ONLINE_JUDGE_PROMPT,
              })
            : { version: 0, template: '' };
    const { toJudge, skipped } = await skipAlreadyJudged({
        traceIds: selection.sampledTraceIds,
        version: { promptVersion: prompt.version, judgeImplVersion: JUDGE_IMPL_VERSION, judgeModel },
        force,
        readScores: langfuseOnlineScoreReader(langfuse),
    });
    if (skipped.length > 0) log.info(`${skipped.length} sampled traces already judged under this version, skipped`);

    // 3. Judge, then 4. write both copies of every score, 5. roll the batch up
    // into the day's dataset item and 6. move the checkpoint, in that order;
    // finishOnlineRun() documents why a rollup failure or an all-failed batch
    // holds the checkpoint back and a single trace's write failure does not.
    // Run copies and the rollup are keyed on the window START day (the day the
    // traffic is from), so a backfill lands on its own day.
    const { judged, failedToJudge, metadataMissing, verdicts } = await judgeOnline(toJudge, prompt);
    const finished = await finishOnlineRun({
        verdicts,
        scores: langfuse.api.scores,
        rollupApi: langfuse.api,
        checkpoints,
        checkpoint: selection.checkpoint,
        date: selection.window?.start ?? now,
        sampleRate,
        maxItems,
        coverage: {
            tracesInWindow: selection.tracesInWindow,
            completedTraces: selection.completedTraces,
            sampled: selection.sampled,
            judged,
            failedToJudge,
        },
    });

    const summary = {
        mode,
        environment,
        window: selection.window
            ? { start: selection.window.start.toISOString(), end: selection.window.end.toISOString() }
            : null,
        checkpointWritten: finished.checkpointWritten,
        isGateBroken: selection.isGateBroken,
        tracesInWindow: selection.tracesInWindow,
        completedTraces: selection.completedTraces,
        sampled: selection.sampled,
        scoresSkipped: skipped.length,
        judged,
        failedToJudge,
        metadataMissing,
        scoresWritten: finished.scoresWritten,
        failedToWrite: finished.failedToWrite,
        rollupItemId: finished.rollupItemId,
        sampledTraceIds: selection.sampledTraceIds,
    };
    log.info(`SUMMARY: ${JSON.stringify(summary, null, 2)}`);
    await Actor.setValue('OUTPUT', summary);
    // Actor.exit()/fail() end the process; the datasetRun flow below never runs in this mode.
    // Fail the run on a broken completion gate, after OUTPUT is written: a
    // SUCCEEDED run selecting nothing forever is invisible, while an Apify
    // run-status alert already covers a FAILED one (#271 needs no extra monitor).
    if (selection.isGateBroken) {
        await Actor.fail(
            `Completion gate broken: ${selection.tracesInWindow} traces in the window, none completed. ` +
                'The checkpoint was not moved; see OUTPUT.',
        );
    }
    // A failed rollup, an all-failed judge batch or an all-failed write batch exits non-zero so the schedule shows a
    // failed run and the window is retried.
    if (finished.error !== null) await Actor.fail(`Online run incomplete: ${finished.error}`);
    await Actor.exit();
}
// Type narrowing only: the datasetRun guard above already threw when it was missing.
if (!datasetRunId) throw new Error('unreachable: datasetRunId checked above');

const { LangfuseSpanProcessor } = await import('@langfuse/otel');
const { startObservation } = await import('@langfuse/tracing');
const { NodeSDK } = await import('@opentelemetry/sdk-node');
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
const { loadJudgeProfile } = await import('./profile.js');

// OTel so the judge's own LLM call can be attached under each experiment item
// as an evaluator observation (Robert's ask: see the judge output in the trace).
const otel = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
otel.start();
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

// The comments API needs the project id; the key is project-scoped.
const projectId = ((await langfuse.api.projects.get()) as { data?: { id: string }[] }).data?.[0]?.id;
if (!projectId) throw new Error('Could not resolve the Langfuse project id from the API key');

const items = await loadRunItems(langfuse, datasetRunId);
// Legacy fallback for traces without an evidence artifact: the runner-side
// check.* scores collapsed to one 0/1 per trace.
const deterministic = await loadDeterministicResults(
    langfuse,
    items.map((i) => i.traceId),
);
const judgedTraceIds = await loadJudgedTraceIds(
    langfuse,
    datasetRunId,
    version,
    items.map((i) => i.traceId),
);
log.info(
    `Judging dataset run ${datasetRunId}: ${items.length} items, model ${judgeModel}, prompt v${promptClient.version}`,
);

/** Judge LLM call as an `evaluator` observation under the experiment item. */
function recordJudgeCall(rec: {
    traceId: string;
    parentObservationId: string;
    startedAt: number;
    endedAt: number;
    model: string;
    input: string;
    output: unknown;
    usage: Record<string, number> | null;
    metadata: Record<string, unknown>;
}) {
    try {
        const usageDetails: Record<string, number> = {};
        if (rec.usage) {
            if (typeof rec.usage.prompt_tokens === 'number') usageDetails.input = rec.usage.prompt_tokens;
            if (typeof rec.usage.completion_tokens === 'number') usageDetails.output = rec.usage.completion_tokens;
            if (typeof rec.usage.total_tokens === 'number') usageDetails.total = rec.usage.total_tokens;
        }
        const obs = (
            startObservation as unknown as (
                n: string,
                a: unknown,
                o: unknown,
            ) => { end: (t?: Date) => void }
        )(
            'judge',
            {
                model: rec.model,
                input: rec.input,
                output: rec.output,
                metadata: rec.metadata,
                ...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
            },
            {
                asType: 'evaluator',
                startTime: new Date(rec.startedAt),
                parentSpanContext: { traceId: rec.traceId, spanId: rec.parentObservationId, traceFlags: 1, isRemote: true },
            },
        );
        obs.end(new Date(rec.endedAt));
    } catch (err) {
        log.warning(`judge observation failed for ${rec.traceId}: ${err}`);
    }
}

const results: Awaited<ReturnType<typeof judgeOne>>[] = [];
let next = 0;
async function worker() {
    while (next < items.length) {
        const item = items[next++];
        try {
            // Profile comes from the trace's own metadata (stamped by the runner).
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
                projectId: projectId as string,
                deterministic: deterministic.get(item.traceId),
                profile: loadJudgeProfile(await profileNameFor(item.traceId)),
                recordJudgeCall,
            });
            results.push(r);
            log.info(
                `${item.experimentItemId}: ${r.status}${r.verdictLabel ? ` verdict=${r.verdictLabel}` : ''}${r.fixArea ? ` fix=${r.fixArea}` : ''}${r.disagreement ? ' DISAGREEMENT' : ''}`,
            );
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

/** Cheap lookup of the profile name stamped on the agent span. */
const profileCache = new Map<string, string | undefined>();
async function profileNameFor(traceId: string): Promise<string | undefined> {
    if (profileCache.has(traceId)) return profileCache.get(traceId);
    let name: string | undefined;
    try {
        const res = (await langfuse.api.observations.getMany({ traceId, name: 'agent', fields: 'core,metadata', limit: 1 })) as unknown as {
            data?: { metadata?: unknown }[];
        };
        const meta = res.data?.[0]?.metadata;
        const parsed = typeof meta === 'string' ? (JSON.parse(meta) as Record<string, unknown>) : (meta as Record<string, unknown> | undefined);
        name = typeof parsed?.itemProfile === 'string' ? parsed.itemProfile : undefined;
    } catch {
        name = undefined;
    }
    profileCache.set(traceId, name);
    return name;
}

await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

const judged = results.filter((r) => r.status === 'judged');
const conclusive = judged.filter((r) => r.verdict !== 'inconclusive');
const inconclusive = judged.length - conclusive.length;
const scoreboard = buildScoreboard(results, deterministic);
const skippedCount = results.filter((r) => r.status === 'skipped-already-judged').length;

// Run-level numbers. Denominator = conclusive judged items of this batch:
// inconclusive (infrastructure) results are reported separately, never
// charged as failures.
const passed = conclusive.filter((r) => r.verdict === 'pass').length;
const found = scoreboard.reduce((acc, row) => ({ pass: acc.pass + row.found.pass, total: acc.total + row.found.total }), {
    pass: 0,
    total: 0,
});
const works = scoreboard.reduce((acc, row) => ({ pass: acc.pass + row.works.pass, total: acc.total + row.works.total }), {
    pass: 0,
    total: 0,
});
const rate = (x: { pass: number; total: number }) => (x.total === 0 ? null : x.pass / x.total);
const passRate = conclusive.length === 0 ? null : passed / conclusive.length;
const foundRate = rate(found);
const worksRate = rate(works);
const checksTotal = conclusive.reduce((a, r) => a + (r.checksTotal ?? 0), 0);
const checksPassed = conclusive.reduce((a, r) => a + (r.checksPassed ?? 0), 0);
const disagreements = conclusive.filter((r) => r.disagreement === 1).length;
const fixAreas: Record<string, number> = {};
for (const r of conclusive) {
    if (r.fixArea && r.fixArea !== 'none') fixAreas[r.fixArea] = (fixAreas[r.fixArea] ?? 0) + 1;
}
const actorRunsCostUsd = Number(judged.reduce((a, r) => a + (r.actorRunsCostUsd ?? 0), 0).toFixed(4));

// Repeats: the same scenario judged N times in this run. passAtN = any repeat
// passed; consistency = share of repeats agreeing with the majority. Written on
// every repeat's item so the compare view shows x/N without arithmetic.
const byScenario = new Map<string, typeof conclusive>();
for (const r of conclusive) byScenario.set(r.experimentItemId, [...(byScenario.get(r.experimentItemId) ?? []), r]);
const flaky: { scenario: string; passed: number; repeats: number }[] = [];
for (const [scenario, group] of byScenario) {
    if (group.length < 2) continue;
    const passes = group.filter((r) => r.verdict === 'pass').length;
    const majority = Math.max(passes, group.length - passes) / group.length;
    if (passes > 0 && passes < group.length) flaky.push({ scenario, passed: passes, repeats: group.length });
    for (const r of group) {
        const obs = items.find((i) => i.traceId === r.traceId);
        if (!obs) continue;
        await langfuse.api.scores.create({ traceId: r.traceId, observationId: obs.observationId, name: 'eval.passAtN', value: passes > 0 ? 1 : 0, comment: `${passes}/${group.length} repeats passed`, metadata: version as Record<string, unknown> });
        await langfuse.api.scores.create({ traceId: r.traceId, observationId: obs.observationId, name: 'eval.consistency', value: Number(majority.toFixed(3)), comment: `${passes}/${group.length} passed; majority agreement ${Math.round(majority * 100)}%`, metadata: version as Record<string, unknown> });
    }
}

// Run-level scores attach to the dataset run itself (subject kind
// "experiment"), which is what the experiments list and compare-view header
// show. Only written when this batch judged something new, and only for
// full-scope runs (a team's filtered run must not move the OKR trend).
if (judged.length > 0 && writeRunScores) {
    const runScore = (name: string, value: number, comment: string) =>
        langfuse.api.scores.create({
            datasetRunId,
            name,
            value,
            comment,
            metadata: version as Record<string, unknown>,
        });
    if (passRate !== null) await runScore('pass_rate', passRate, `${passed}/${conclusive.length} scenarios passed`);
    if (foundRate !== null) await runScore('found_rate', foundRate, `${found.pass}/${found.total} discovery scenarios used the intended subject`);
    if (worksRate !== null) await runScore('works_rate', worksRate, `${works.pass}/${works.total} usage scenarios passed`);
    await runScore('inconclusive_rate', judged.length ? inconclusive / judged.length : 0, `${inconclusive}/${judged.length} scenarios inconclusive (infrastructure)`);
    if (checksTotal > 0) await runScore('checks_pass_rate', checksPassed / checksTotal, `${checksPassed}/${checksTotal} deterministic checks passed`);
    if (conclusive.length > 0) await runScore('judge_disagreement_rate', disagreements / conclusive.length, `${disagreements}/${conclusive.length} model vs checks disagreements`);
    await runScore('actor_runs_cost_usd', actorRunsCostUsd, `USD spent by the Actors the agents triggered in this run`);
} else if (judged.length > 0) {
    log.info('run-level scores skipped (partial scope run)');
}
// Human calibration: every non-pass and a sample of passes go to an annotation
// queue where a reviewer marks human.verdict agree/disagree; the calibrate tool
// turns that into calibration.agreement. Failures here never fail the run.
if (auditQueue && judged.length > 0) {
    try {
        const queues = (await langfuse.api.annotationQueues.listQueues({ limit: 100 })) as unknown as { data?: { id: string; name: string }[] };
        let queue = queues.data?.find((q) => q.name === auditQueue);
        if (!queue) {
            queue = (await langfuse.api.annotationQueues.createQueue({
                name: auditQueue,
                description: 'Judge audit: review judge.verdict / judge.fixArea and score human.verdict (agree / disagree / unsure).',
                scoreConfigIds: [],
            })) as { id: string; name: string };
        }
        let queued = 0;
        for (const r of judged) {
            const sample = r.verdict === 'pass' ? Math.random() < auditPassSample : true;
            if (!sample) continue;
            await langfuse.api.annotationQueues.createQueueItem(queue.id, { objectId: r.traceId, objectType: 'TRACE' });
            queued++;
        }
        log.info(`audit queue "${auditQueue}": ${queued} trace(s) queued for human review`);
    } catch (err) {
        log.warning(`audit queue failed: ${err}`);
    }
}

await langfuse.flush();
try {
    await otel.shutdown();
} catch (err) {
    log.warning(`OTel shutdown failed: ${err}`);
}

await Actor.setValue('SCOREBOARD', renderScoreboard(scoreboard, datasetRunId, skippedCount), {
    contentType: 'text/markdown',
});
const summary = {
    datasetRunId,
    items: items.length,
    judged: judged.length,
    conclusive: conclusive.length,
    inconclusive,
    passed,
    passRate,
    foundRate,
    worksRate,
    checksPassed,
    checksTotal,
    disagreements,
    actorRunsCostUsd,
    flaky,
    fixAreas,
    skippedAlreadyJudged: skippedCount,
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
