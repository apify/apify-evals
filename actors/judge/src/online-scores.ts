import type { LangfuseClient } from '@langfuse/client';
import { log } from 'apify';

import type { OnlineVerdicts } from './online-judge.js';
import { HOLISTIC_SCORE_NAME, ONLINE_SCORE_NAMES } from './rubric.js';
import type { Checkpoint, CheckpointStore } from './select.js';

/**
 * Online score writing (ai-team#270): every verdict from #269 goes to Langfuse
 * twice, idempotently, and the day's batch is summarised in one dataset item.
 *
 * - The trace copy is what the Langfuse trace view and the score tables show.
 *   It dies with the trace: the retention sweep deletes user traces after 30
 *   days, and a trace's scores go with it.
 * - The run copy is the same score under an invented `datasetRunId`
 *   (`apify-ai-online-YYYY-MM-DD`, no dataset, no items). Langfuse takes any
 *   one subject per score without checking that the run exists, so the copy
 *   survives the sweep, reads back as an experiment subject and is aggregated
 *   by the metrics API.
 * - The daily rollup is a dataset item keyed `rollup-YYYY-MM-DD` in
 *   `apify-ai-online-rollups`, upserted on its id, holding pass rate and n per
 *   score plus the coverage counters. Runs on the same UTC day merge into it.
 *
 * Only `pendingScores()` reads #269's `OnlineVerdicts` shape; everything else
 * works on `PendingScore`, so a change upstream lands in one place.
 */

/** The API request types, taken from the client so the shapes below are the ones Langfuse actually accepts. */
export type CreateScoreRequest = Parameters<LangfuseClient['api']['scores']['create']>[0];
export type CreateDatasetItemRequest = Parameters<LangfuseClient['api']['datasetItems']['create']>[0];

export const ONLINE_RUN_ID_PREFIX = 'apify-ai-online-';
export const ROLLUP_DATASET_NAME = 'apify-ai-online-rollups';
export const ROLLUP_ITEM_PREFIX = 'rollup-';

/** Suffix that tells the run copy's id apart from the trace copy's: same id would dedup the second write away. */
export const RUN_COPY_SUFFIX = '-run';

/**
 * The typings document no charset or length for a score id. The dataset item
 * id cap (255) is the only documented id limit in the API, so it is used as a
 * conservative bound; the charset is pinned to what the sanitiser produces.
 */
export const MAX_SCORE_ID_LENGTH = 255;
export const SCORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface OnlineScoreVersion {
    promptVersion: number;
    judgeImplVersion: string;
    judgeModel: string;
}

/** One score ready to write, detached from #269's verdict shape. */
export interface PendingScore {
    traceId: string;
    name: string;
    value: 0 | 1;
    comment: string;
    /** The judge's words; may quote the turn, so it goes only where the turn already is (the trace copy). */
    evidence?: string;
    metadata: Record<string, unknown>;
    version: OnlineScoreVersion;
}

/** The adapter over #269: flattens one trace's verdicts, dropping omitted criteria (they write no score). */
export function pendingScores(verdicts: OnlineVerdicts): PendingScore[] {
    const { traceId, metadata } = verdicts;
    const version: OnlineScoreVersion = {
        promptVersion: metadata.promptVersion,
        judgeImplVersion: metadata.judgeImplVersion,
        judgeModel: metadata.judgeModel,
    };
    const out: PendingScore[] = [];
    for (const score of verdicts.scores) {
        if (!('value' in score)) continue;
        out.push({
            traceId,
            name: score.name,
            value: score.value,
            comment: score.comment,
            evidence: score.evidence,
            metadata: { ...metadata },
            version,
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` in UTC; the date every online id and run id is keyed on. */
export function utcDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Model ids (`deepseek/deepseek-v4-flash`) and semver (`0.1.0`) carry `/`, `:` and `.`; every run of such characters becomes one `-`. */
export function sanitiseIdPart(part: string): string {
    return part.replace(/[^A-Za-z0-9_-]+/g, '-');
}

export class InvalidScoreIdError extends Error {
    constructor(
        readonly scoreId: string,
        reason: string,
    ) {
        super(`Score id "${scoreId}" ${reason}`);
        this.name = 'InvalidScoreIdError';
    }
}

/**
 * `<traceId>-<scoreName>-p<promptVersion>-i<judgeImplVersion>-<judgeModel>`,
 * plus `-run` for the archival copy. Readable on purpose: the id says what was
 * judged and under which versions, and a bumped version yields a new id, so
 * the new score lands beside the old one instead of replacing it.
 */
export function onlineScoreId(
    { traceId, scoreName, version }: { traceId: string; scoreName: string; version: OnlineScoreVersion },
    copy: 'trace' | 'run',
): string {
    const parts = [
        sanitiseIdPart(traceId),
        sanitiseIdPart(scoreName),
        `p${version.promptVersion}`,
        `i${sanitiseIdPart(version.judgeImplVersion)}`,
        sanitiseIdPart(version.judgeModel),
    ];
    const id = parts.join('-') + (copy === 'run' ? RUN_COPY_SUFFIX : '');
    if (id.length > MAX_SCORE_ID_LENGTH) {
        throw new InvalidScoreIdError(id, `is ${id.length} chars, max is ${MAX_SCORE_ID_LENGTH}`);
    }
    if (!SCORE_ID_PATTERN.test(id))
        throw new InvalidScoreIdError(id, `contains characters outside ${SCORE_ID_PATTERN}`);
    return id;
}

/** The invented dataset run the archival copies hang off; one per UTC day of writing. */
export function onlineRunId(date: Date): string {
    return `${ONLINE_RUN_ID_PREFIX}${utcDate(date)}`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The two requests for one score. `date` is the WINDOW START, which keys the
 * run copy's `datasetRunId`: a backfill of last week then lands on last week's
 * day, not on today's. `CreateScoreRequest` has no timestamp field and the
 * SDK's ingestion path stamps its own, so neither copy can be pinned to the
 * trace's time: both carry the write time. Langfuse's scores table is a
 * ReplacingMergeTree ordered by (project, toDate(timestamp), name, id), so a
 * same-day write with the same id REPLACES the row (idempotent for identical
 * content; under `force` it overwrites the verdict), while a write on a later
 * UTC day with the same id is a second row. The pre-filter in
 * `skipAlreadyJudged()` is what stops that; the partial-write retry path
 * (`orderedRequests`) is the one exception. `source` is left at its default,
 * API: the request type accepts API or ANNOTATION, and EVAL is refused.
 */
export function scoreRequests(score: PendingScore, date: Date): { trace: CreateScoreRequest; run: CreateScoreRequest } {
    const key = { traceId: score.traceId, scoreName: score.name, version: score.version };
    const common = {
        name: score.name,
        value: score.value,
        dataType: 'BOOLEAN' as const,
        comment: score.comment,
    };
    return {
        trace: {
            ...common,
            id: onlineScoreId(key, 'trace'),
            traceId: score.traceId,
            metadata: score.evidence === undefined ? score.metadata : { ...score.metadata, evidence: score.evidence },
        },
        run: {
            ...common,
            id: onlineScoreId(key, 'run'),
            datasetRunId: onlineRunId(date),
            // No evidence here: the archival copy outlives the trace's retention, and evidence may quote the user.
            metadata: score.metadata,
        },
    };
}

/**
 * Every request for one trace, in write order: criteria first (trace copy
 * then run copy), the holistic run copy, and the holistic trace copy LAST. The
 * holistic trace copy is what `skipAlreadyJudged()` looks for, so a trace whose
 * writes died halfway is not marked done; the retry rewrites everything and,
 * on the same UTC day, the id replaces the rows already there. A retry after
 * UTC midnight is the one case that leaves a second row per criterion (the
 * dedup key includes toDate(timestamp)); its run copies still land under the
 * window's day because the run id is keyed on the window start.
 */
export function orderedRequests(scores: PendingScore[], date: Date): CreateScoreRequest[] {
    const holistic = scores.find((s) => s.name === HOLISTIC_SCORE_NAME);
    const criteria = scores.filter((s) => s.name !== HOLISTIC_SCORE_NAME);
    const out: CreateScoreRequest[] = [];
    for (const score of criteria) {
        const { trace, run } = scoreRequests(score, date);
        out.push(trace, run);
    }
    if (holistic) {
        const { trace, run } = scoreRequests(holistic, date);
        out.push(run, trace);
    }
    return out;
}

export interface ScoresApi {
    create(request: CreateScoreRequest): Promise<unknown>;
}

export interface WriteResult {
    /** Traces whose whole score set (both copies) was written. */
    scoresWritten: number;
    /** Traces with at least one failed write; the run goes on and the trace is retried next window. */
    failedToWrite: number;
    /** The verdicts behind `scoresWritten`: only these go into the rollup. */
    written: OnlineVerdicts[];
}

/** Write every trace's scores; one trace's failure is counted, logged and skipped, never fatal to the batch. */
export async function writeOnlineScores({
    verdicts,
    scores,
    date,
}: {
    verdicts: OnlineVerdicts[];
    scores: ScoresApi;
    /** The window start; keys the run copies' `datasetRunId`. */
    date: Date;
}): Promise<WriteResult> {
    const written: OnlineVerdicts[] = [];
    let failedToWrite = 0;
    for (const v of verdicts) {
        try {
            for (const request of orderedRequests(pendingScores(v), date)) await scores.create(request);
            written.push(v);
        } catch (err) {
            failedToWrite++;
            log.error(`${v.traceId}: score write failed: ${err}`);
        }
    }
    return { scoresWritten: written.length, failedToWrite, written };
}

export class AllScoreWritesFailedError extends Error {
    constructor(readonly traces: number) {
        super(
            `Every score write failed for all ${traces} judged traces; checkpoint not written so the window is retried`,
        );
        this.name = 'AllScoreWritesFailedError';
    }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export interface ExistingOnlineScore {
    name: string;
    traceId: string | null;
    metadata?: Record<string, unknown>;
}

/** Existing holistic scores for the given traces; `langfuseOnlineScoreReader()` in production, a fake in tests. */
export type OnlineScoreReader = (traceIds: string[]) => Promise<ExistingOnlineScore[]>;

function versionsMatch(metadata: Record<string, unknown> | undefined, version: OnlineScoreVersion): boolean {
    if (!metadata) return false;
    return (
        String(metadata.promptVersion) === String(version.promptVersion) &&
        metadata.judgeImplVersion === version.judgeImplVersion &&
        metadata.judgeModel === version.judgeModel
    );
}

/** Traces that already carry a holistic score under exactly this prompt, impl and model. */
export function judgedUnderVersion(existing: ExistingOnlineScore[], version: OnlineScoreVersion): Set<string> {
    const judged = new Set<string>();
    for (const s of existing) {
        if (s.name === HOLISTIC_SCORE_NAME && s.traceId && versionsMatch(s.metadata, version)) judged.add(s.traceId);
    }
    return judged;
}

/**
 * Runs BEFORE judging so a re-run spends nothing on the LLM. A bumped prompt,
 * impl or model does not match, so the trace is judged again and the new
 * score lands beside the old one. `force` judges and writes everything; the
 * ids still dedup same-day repeats at the server.
 */
export async function skipAlreadyJudged({
    traceIds,
    version,
    force,
    readScores,
}: {
    traceIds: string[];
    version: OnlineScoreVersion;
    force: boolean;
    readScores: OnlineScoreReader;
}): Promise<{ toJudge: string[]; skipped: string[] }> {
    if (force || traceIds.length === 0) return { toJudge: traceIds, skipped: [] };
    const judged = judgedUnderVersion(await readScores(traceIds), version);
    return {
        toJudge: traceIds.filter((id) => !judged.has(id)),
        skipped: traceIds.filter((id) => judged.has(id)),
    };
}

const TRACE_ID_CHUNK = 50;

interface ScoresV3Page {
    data?: {
        name?: string;
        metadata?: Record<string, unknown>;
        subject?: { kind?: string; id?: string; traceId?: string };
    }[];
    meta?: { cursor?: string };
}

interface ScoresV3Api {
    api: { scoresV3: { getManyV3(request: Record<string, unknown>): Promise<unknown> } };
}

/** A v3 subject is `{kind: 'trace', id}` for a trace score and `{kind: 'observation', id, traceId}` for a span score. */
function subjectTraceId(subject: NonNullable<ScoresV3Page['data']>[number]['subject']): string | null {
    if (!subject) return null;
    if (subject.kind === 'trace') return subject.id ?? null;
    return subject.traceId ?? null;
}

/**
 * `GET /api/public/v3/scores` (the endpoint that works in `events_only` mode),
 * holistic name only, `details` for the metadata and `subject` for the trace
 * id, in trace-id chunks so one query stays bounded. Sibling of core.ts's
 * offline reader rather than a generalisation of it: that one is keyed on
 * observation subjects and the offline behaviour must not move.
 */
export function langfuseOnlineScoreReader(langfuse: ScoresV3Api): OnlineScoreReader {
    return async (traceIds) => {
        const out: ExistingOnlineScore[] = [];
        for (let i = 0; i < traceIds.length; i += TRACE_ID_CHUNK) {
            const chunk = traceIds.slice(i, i + TRACE_ID_CHUNK).join(',');
            let cursor: string | undefined;
            do {
                const page = (await langfuse.api.scoresV3.getManyV3({
                    traceId: chunk,
                    name: HOLISTIC_SCORE_NAME,
                    fields: 'details,subject',
                    limit: 100,
                    cursor,
                })) as ScoresV3Page;
                for (const s of page.data ?? []) {
                    out.push({ name: s.name ?? '', traceId: subjectTraceId(s.subject), metadata: s.metadata });
                }
                cursor = page.meta?.cursor;
            } while (cursor);
        }
        return out;
    };
}

// ---------------------------------------------------------------------------
// Daily rollup
// ---------------------------------------------------------------------------

export interface CoverageCounters {
    tracesInWindow: number;
    completedTraces: number;
    sampled: number;
    judged: number;
    failedToJudge: number;
    /** Traces whose scores reached Langfuse; the rollup's n counts only these. */
    scoresWritten: number;
    failedToWrite: number;
}

/** What the caller knows before the writes; `finishOnlineRun()` fills in the write counters. */
export type JudgeCounters = Omit<CoverageCounters, 'scoresWritten' | 'failedToWrite'>;

export interface Rollup {
    date: string;
    /** Judge runs merged into this item so far. */
    runs: number;
    /** Per score name: how many traces scored 1. */
    passes: Record<string, number>;
    /** Per score name: how many traces were scored at all (omitted criteria are not counted). */
    n: Record<string, number>;
    /** passes / n, or null when n is 0. `avg` over the day's scores in Langfuse gives the same number. */
    passRate: Record<string, number | null>;
    sampleRate: number;
    maxItems: number;
    /** Summed over the merged runs. */
    coverage: CoverageCounters;
}

function passRates(passes: Record<string, number>, n: Record<string, number>): Record<string, number | null> {
    return Object.fromEntries(ONLINE_SCORE_NAMES.map((name) => [name, n[name] > 0 ? passes[name] / n[name] : null]));
}

/** One run's batch as a rollup; pure, from the verdicts whose scores were WRITTEN this run. `date` is the window start. */
export function computeRollup({
    date,
    verdicts,
    sampleRate,
    maxItems,
    coverage,
}: {
    date: Date;
    verdicts: OnlineVerdicts[];
    sampleRate: number;
    maxItems: number;
    coverage: CoverageCounters;
}): Rollup {
    const passes = Object.fromEntries(ONLINE_SCORE_NAMES.map((name) => [name, 0]));
    const n = Object.fromEntries(ONLINE_SCORE_NAMES.map((name) => [name, 0]));
    for (const v of verdicts) {
        for (const score of pendingScores(v)) {
            if (!(score.name in n)) continue;
            n[score.name]++;
            if (score.value === 1) passes[score.name]++;
        }
    }
    return { date: utcDate(date), runs: 1, passes, n, passRate: passRates(passes, n), sampleRate, maxItems, coverage };
}

function isCountRecord(value: unknown): value is Record<string, number> {
    return (
        typeof value === 'object' &&
        value !== null &&
        Object.values(value as Record<string, unknown>).every((v) => typeof v === 'number')
    );
}

function isRollup(value: unknown): value is Rollup {
    const r = value as Partial<Rollup> | null;
    return (
        typeof r === 'object' &&
        r !== null &&
        typeof r.date === 'string' &&
        typeof r.runs === 'number' &&
        isCountRecord(r.passes) &&
        isCountRecord(r.n) &&
        isCountRecord(r.coverage)
    );
}

const sumRecords = (a: Record<string, number>, b: Record<string, number>): Record<string, number> =>
    Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]));

const sumCoverage = (a: CoverageCounters, b: CoverageCounters): CoverageCounters => ({
    tracesInWindow: a.tracesInWindow + b.tracesInWindow,
    completedTraces: a.completedTraces + b.completedTraces,
    sampled: a.sampled + b.sampled,
    judged: a.judged + b.judged,
    failedToJudge: a.failedToJudge + b.failedToJudge,
    scoresWritten: a.scoresWritten + b.scoresWritten,
    failedToWrite: a.failedToWrite + b.failedToWrite,
});

/**
 * Several judge runs on one UTC day share one item, so counts are summed and
 * the rates recomputed; `sampleRate` and `maxItems` are the latest run's. An
 * existing item that is not a rollup (hand-edited, older shape) is replaced,
 * with a warning, rather than trusted. A retry over the SAME window (after a
 * failed rollup or failed writes) sums its `tracesInWindow`, `completedTraces`
 * and `sampled` a second time; `n` and `passes` stay exact because the retry
 * only writes traces the pre-filter did not skip.
 */
export function mergeRollup(existing: unknown, fresh: Rollup): Rollup {
    if (existing === null || existing === undefined) return fresh;
    if (!isRollup(existing)) {
        log.warning(`Rollup ${fresh.date}: existing item metadata is not a rollup, replacing it`);
        return fresh;
    }
    const passes = sumRecords(existing.passes, fresh.passes);
    const n = sumRecords(existing.n, fresh.n);
    return {
        ...fresh,
        runs: existing.runs + fresh.runs,
        passes,
        n,
        passRate: passRates(passes, n),
        coverage: sumCoverage(existing.coverage, fresh.coverage),
    };
}

export function rollupItemId(date: Date): string {
    return `${ROLLUP_ITEM_PREFIX}${utcDate(date)}`;
}

/** The dataset item request: the run parameters as `input`, the numbers as `metadata`. */
export function rollupItemRequest(rollup: Rollup): CreateDatasetItemRequest {
    return {
        datasetName: ROLLUP_DATASET_NAME,
        id: `${ROLLUP_ITEM_PREFIX}${rollup.date}`,
        input: { date: rollup.date, sampleRate: rollup.sampleRate, maxItems: rollup.maxItems },
        metadata: rollup,
    };
}

export interface RollupApi {
    datasets: {
        get(datasetName: string): Promise<unknown>;
        create(request: { name: string; description?: string }): Promise<unknown>;
    };
    datasetItems: {
        get(id: string): Promise<{ metadata?: unknown }>;
        create(request: CreateDatasetItemRequest): Promise<{ id: string }>;
    };
}

const isNotFound = (err: unknown) => (err as { statusCode?: number })?.statusCode === 404;

/** `datasets.create` is not documented as idempotent by name, so look first and create only on 404. */
async function ensureRollupDataset(api: RollupApi): Promise<void> {
    try {
        await api.datasets.get(ROLLUP_DATASET_NAME);
    } catch (err) {
        if (!isNotFound(err)) throw err;
        log.info(`Creating dataset ${ROLLUP_DATASET_NAME}`);
        await api.datasets.create({
            name: ROLLUP_DATASET_NAME,
            description: 'Daily rollups of the online Apify AI judge (ai-team#270); one item per UTC day.',
        });
    }
}

async function existingRollup(api: RollupApi, id: string): Promise<unknown> {
    try {
        return (await api.datasetItems.get(id)).metadata ?? null;
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
}

/**
 * Merge the run into the day's item and upsert it (dataset items upsert on id,
 * per the API docs). Dataset items and datasets live in Postgres, not in the
 * events store, so they are expected to work in `events_only` mode where the
 * dataset-RUN lookups are refused; that expectation is unverified against a
 * live instance, and a failure here fails the run (see main.ts).
 */
export async function upsertDailyRollup({ api, rollup }: { api: RollupApi; rollup: Rollup }): Promise<{ id: string }> {
    await ensureRollupDataset(api);
    const id = `${ROLLUP_ITEM_PREFIX}${rollup.date}`;
    const merged = mergeRollup(await existingRollup(api, id), rollup);
    const item = await api.datasetItems.create(rollupItemRequest(merged));
    return { id: item.id };
}

// ---------------------------------------------------------------------------
// The tail of an online run: write, roll up, then checkpoint
// ---------------------------------------------------------------------------

export interface FinishOnlineRunOptions {
    verdicts: OnlineVerdicts[];
    scores: ScoresApi;
    rollupApi: RollupApi;
    checkpoints: CheckpointStore;
    /** From `selectTraces()`; null under a window override or an empty window, and then nothing is written. */
    checkpoint: Checkpoint | null;
    /** The window start: keys the run copies and the rollup item on the day the traffic is from. */
    date: Date;
    sampleRate: number;
    maxItems: number;
    coverage: JudgeCounters;
}

export interface FinishOnlineRunResult extends Omit<WriteResult, 'written'> {
    rollupItemId: string | null;
    /** Non-null when every write failed or the rollup failed; the caller fails the run with it. */
    error: unknown;
    checkpointWritten: boolean;
}

/**
 * Scores first, rollup second, checkpoint last. The checkpoint moves only when
 * the rollup succeeded and at least one trace was written: a batch whose
 * writes ALL failed (Langfuse down, subject rejected) must not look like
 * success, or the window and its LLM spend are silently lost. Either failure
 * leaves the window to be retried, which is safe because every score id
 * dedups and `skipAlreadyJudged()` spends no LLM calls on the traces already
 * written. A failed score write for SOME traces does not hold the checkpoint
 * back: each is one sampled item of many, counted in `failedToWrite` and in
 * the rollup's coverage, and holding the whole window for it would re-sample
 * and re-judge the rest of the window for nothing. The rollup is skipped when
 * the run sampled and judged nothing (an empty window has nothing to record).
 */
export async function finishOnlineRun(opts: FinishOnlineRunOptions): Promise<FinishOnlineRunResult> {
    const { verdicts, scores, rollupApi, checkpoints, checkpoint, date, sampleRate, maxItems } = opts;
    const { written, scoresWritten, failedToWrite } = await writeOnlineScores({ verdicts, scores, date });
    const coverage: CoverageCounters = { ...opts.coverage, scoresWritten, failedToWrite };

    let rollupId: string | null = null;
    let error: unknown = null;
    if (verdicts.length > 0 && scoresWritten === 0) {
        error = new AllScoreWritesFailedError(verdicts.length);
        log.error(String(error));
    } else if (coverage.sampled > 0 || coverage.judged > 0) {
        try {
            const rollup = computeRollup({ date, verdicts: written, sampleRate, maxItems, coverage });
            rollupId = (await upsertDailyRollup({ api: rollupApi, rollup })).id;
        } catch (err) {
            error = err;
            log.error(`Daily rollup failed, checkpoint not written so the window is retried: ${err}`);
        }
    }

    const checkpointWritten = checkpoint !== null && error === null;
    if (checkpointWritten && checkpoint) await checkpoints.write(checkpoint);
    return { scoresWritten, failedToWrite, rollupItemId: rollupId, error, checkpointWritten };
}
