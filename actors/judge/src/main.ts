import { Actor, log } from 'apify';

interface Input {
    datasetRunId?: string;
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
    datasetRunId,
    judgeModel = 'anthropic/claude-sonnet-4.6',
    promptLabel = 'production',
    force = false,
    concurrency = 4,
} = input;
if (!datasetRunId) throw new Error('datasetRunId is required (the Runner returns it in its OUTPUT)');

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

// The comments API needs the project id; the key is project-scoped.
const projectId = ((await langfuse.api.projects.get()) as { data?: { id: string }[] }).data?.[0]?.id;
if (!projectId) throw new Error('Could not resolve the Langfuse project id from the API key');

const items = await loadRunItems(langfuse, datasetRunId);
// Deterministic check results (runner-side) feed the fix-area override for
// discovery misses, so they are loaded before judging, not only for the board.
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
                projectId: projectId as string,
                deterministic: deterministic.get(item.traceId),
            });
            results.push(r);
            log.info(
                `${item.experimentItemId}: ${r.status}${r.overall ? ` overall=${r.overall}` : ''}${r.fixArea ? ` fix=${r.fixArea}` : ''}`,
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
await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

const judged = results.filter((r) => r.status === 'judged');
const scoreboard = buildScoreboard(results, deterministic);
const skippedCount = results.filter((r) => r.status === 'skipped-already-judged').length;

// Run-level numbers: Found (discovery scenarios whose deterministic check
// passed) and Works (usage scenarios the judge passed) split "whose problem";
// pass_rate is the OKR headline. Denominator = judged items in this batch.
const passed = judged.filter((r) => r.overall === 'pass').length;
const found = scoreboard.reduce((acc, row) => ({ pass: acc.pass + row.found.pass, total: acc.total + row.found.total }), {
    pass: 0,
    total: 0,
});
const works = scoreboard.reduce((acc, row) => ({ pass: acc.pass + row.works.pass, total: acc.total + row.works.total }), {
    pass: 0,
    total: 0,
});
const rate = (x: { pass: number; total: number }) => (x.total === 0 ? null : x.pass / x.total);
const passRate = judged.length === 0 ? null : passed / judged.length;
const foundRate = rate(found);
const worksRate = rate(works);
const fixAreas: Record<string, number> = {};
for (const r of judged) {
    if (r.fixArea && r.fixArea !== 'none') fixAreas[r.fixArea] = (fixAreas[r.fixArea] ?? 0) + 1;
}

// Run-level scores attach to the dataset run itself (subject kind
// "experiment"), which is what the experiments list and compare-view header
// show. Only written when this batch judged something new, so a re-run that
// skipped everything does not stack duplicate run scores.
if (judged.length > 0) {
    const runScore = (name: string, value: number, comment: string) =>
        langfuse.api.scores.create({
            datasetRunId,
            name,
            value,
            comment,
            metadata: version as Record<string, unknown>,
        });
    await runScore('pass_rate', passRate as number, `${passed}/${judged.length} scenarios passed`);
    if (foundRate !== null) await runScore('found_rate', foundRate, `${found.pass}/${found.total} discovery scenarios found the intended Actor`);
    if (worksRate !== null) await runScore('works_rate', worksRate, `${works.pass}/${works.total} usage scenarios completed`);
}
await langfuse.flush();

await Actor.setValue('SCOREBOARD', renderScoreboard(scoreboard, datasetRunId, skippedCount), {
    contentType: 'text/markdown',
});
const summary = {
    datasetRunId,
    items: items.length,
    judged: judged.length,
    passed,
    passRate,
    foundRate,
    worksRate,
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
