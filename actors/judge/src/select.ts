import { Actor, log } from 'apify';

/**
 * Online-eval trace selection (ai-team#267): given a time window, return the
 * production traces that should be scored. Selection only; scoring is #269
 * and score writing is #270.
 *
 * Pure parts (window arithmetic, filter construction, sampling, counters) are
 * exported and take no I/O. The two I/O dependencies (Langfuse observation
 * pages, the checkpoint store) are injected into `selectTraces()` so the whole
 * flow is testable against fakes; `langfuseObservationFetcher()` and
 * `actorCheckpointStore()` are the production adapters.
 */

/** apify-ai-agent `server.requestTimeoutMs` (30 min today): the longest a turn can still be running. */
export const AGENT_REQUEST_TIMEOUT_MS = 30 * 60_000;

/** Langfuse export lag observed at 1 to 3 min; the conservative end so a finished
 * turn's completion span has landed before its trace can fall inside a window. */
export const EXPORT_LAG_MS = 3 * 60_000;

/** First run, or a lost checkpoint: look back one day. */
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60_000;

/** Default KV-store record holding the last window's upper bound. */
export const CHECKPOINT_KEY = 'ONLINE_CHECKPOINT';

/** Trace tag every production apify-ai trace carries (apify-ai-agent `TRACE_SOURCE`). */
export const TRACE_TAG = 'apify-ai';

/** Completion-signal span name (apify-ai-agent `TURN_COMPLETE_SPAN_NAME`). */
export const TURN_COMPLETE_SPAN_NAME = 'apify-ai.turn-complete';

/** Max page size the observations v2 endpoint allows. */
const PAGE_LIMIT = 1000;

export interface Checkpoint {
    /** Exclusive upper bound of the last selected window, ISO 8601. */
    upperBound: string;
    /** Actor run that wrote it; null when run locally. */
    runId: string | null;
    writtenAt: string;
}

export interface CheckpointStore {
    read(): Promise<Checkpoint | null>;
    write(checkpoint: Checkpoint): Promise<void>;
}

export interface Window {
    /** Inclusive. */
    start: Date;
    /** Exclusive. */
    end: Date;
}

export interface WindowOverride {
    windowStart?: string;
    windowEnd?: string;
}

/** Newest instant whose traces are guaranteed complete and exported: a turn that
 * started before it has hit the request timeout and had time to export. */
export function safeUpperBound(now: Date): Date {
    return new Date(now.getTime() - AGENT_REQUEST_TIMEOUT_MS - EXPORT_LAG_MS);
}

function windowStart(now: Date, checkpoint: Checkpoint | null, override: WindowOverride): Date {
    if (override.windowStart) return new Date(override.windowStart);
    if (checkpoint) return new Date(checkpoint.upperBound);
    return new Date(now.getTime() - DEFAULT_LOOKBACK_MS);
}

/**
 * `[checkpoint ?? now-24h, safeUpperBound(now))`, or the explicit override when
 * given (either bound may be overridden alone). Returns null for an empty or
 * inverted window so the caller can skip both the fetch and the checkpoint.
 */
export function computeWindow(now: Date, checkpoint: Checkpoint | null, override: WindowOverride = {}): Window | null {
    const start = windowStart(now, checkpoint, override);
    const end = override.windowEnd ? new Date(override.windowEnd) : safeUpperBound(now);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error(`Invalid window bound: ${JSON.stringify(override)}`);
    }
    if (start >= end) return null;
    return { start, end };
}

/** One condition of the observations v2 `filter` JSON (see GetObservationsV2Request). */
export interface FilterCondition {
    type: 'datetime' | 'string' | 'arrayOptions' | 'stringObject';
    column: string;
    operator: string;
    value: string | string[];
    key?: string;
}

/**
 * Both window bounds, and every filter this module builds starts with them.
 * Verified live 2026-09-09: a `startTime` condition inside `filter` REPLACES
 * the `fromStartTime`/`toStartTime` query params rather than intersecting with
 * them (a `<`-only filter returned rows from two weeks before `fromStartTime`),
 * so a filter carrying one bound and not the other silently unbounds the query.
 * The `datetime` operators `>=`, `>`, `<`, `<=` behave as named; `=`/`!=` are 400.
 */
function windowBounds(window: Window): FilterCondition[] {
    return [
        { type: 'datetime', column: 'startTime', operator: '>=', value: window.start.toISOString() },
        { type: 'datetime', column: 'startTime', operator: '<', value: window.end.toISOString() },
    ];
}

/**
 * Coverage query: the root spans of apify-ai traces started in the window.
 * `traceTags` matches PER OBSERVATION and the tag lives only on the ROOT span
 * (`metadata["attributes.langfuse.trace.tags"]`), so this returns one row per
 * trace and cannot be combined with a condition on a child span's name.
 */
export function traceFilter(window: Window): FilterCondition[] {
    return [
        ...windowBounds(window),
        { type: 'arrayOptions', column: 'traceTags', operator: 'any of', value: [TRACE_TAG] },
    ];
}

/**
 * The completion-signal spans, selected by name inside the window and nothing
 * else. No `traceTags` condition: the tag is only on the root span while this
 * matches an event span, and the tag filter is evaluated per observation, so
 * tag AND name returns zero rows forever (verified live 2026-09-09: tag `user`
 * AND name `apify-ai_search-actors` returned 0 rows on a day where each half
 * returned 3). The name is unique to this service, which is the selectivity.
 *
 * No `metadata` condition either: the agent's `completed: 'true'` is TRACE
 * metadata set on every span of this name, so it would add no selectivity,
 * only an unproven match that could zero `completedTraces` for good.
 */
export function completedFilter(window: Window): FilterCondition[] {
    return [...windowBounds(window), { type: 'string', column: 'name', operator: '=', value: TURN_COMPLETE_SPAN_NAME }];
}

export interface ObservationPage {
    data: { traceId: string | null }[];
    meta?: { cursor?: string };
}

export type ObservationFetcher = (params: {
    window: Window;
    filter: FilterCondition[];
    cursor?: string;
}) => Promise<ObservationPage>;

/** Walk every page of one filter and return the distinct trace ids. */
export async function collectTraceIds(fetchPage: ObservationFetcher, window: Window, filter: FilterCondition[]) {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await fetchPage({ window, filter, cursor });
        for (const row of page.data) if (row.traceId) ids.add(row.traceId);
        cursor = page.meta?.cursor;
    } while (cursor);
    return ids;
}

export type Rng = () => number;

/**
 * Fisher-Yates shuffle, then take `ceil(sampleRate * n)` capped at `maxItems`.
 * Shuffling before the cap keeps a capped sample uniform over the window
 * instead of biased toward whatever order Langfuse returned.
 */
export function sampleTraceIds(traceIds: string[], sampleRate: number, maxItems: number, rng: Rng): string[] {
    const shuffled = [...traceIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const size = Math.min(Math.ceil(sampleRate * traceIds.length), maxItems);
    return shuffled.slice(0, size);
}

export interface SelectionCounters {
    /**
     * Coverage counter only: distinct apify-ai traces whose ROOT span (the tag
     * carrier) starts in the window. It is NOT a superset of
     * `completedTraces` and may differ from it in both directions: a turn whose
     * root started before the window but completed inside it is counted only in
     * `completedTraces`, and a turn whose root started at the end of the window
     * but completes after it is counted only here. Do not treat a gap between
     * the two as loss.
     */
    tracesInWindow: number;
    /** The selection key: traces whose completion span starts in the window. */
    completedTraces: number;
    sampled: number;
}

export interface Selection extends SelectionCounters {
    window: Window | null;
    sampledTraceIds: string[];
    /** True when this call wrote the checkpoint. */
    checkpointWritten: boolean;
    /** The record that moves the checkpoint past this window; null under an
     * override, an empty window or a broken completion gate. #270 stops writing
     * it here and writes this record itself, once the window's scores are safe. */
    checkpoint: Checkpoint | null;
}

export interface SelectTracesOptions {
    now: Date;
    sampleRate: number;
    maxItems: number;
    override?: WindowOverride;
    rng: Rng;
    fetchPage: ObservationFetcher;
    checkpoints: CheckpointStore;
    runId: string | null;
}

/**
 * The whole selection step. An explicit window override never reads or moves
 * the checkpoint: a backfill of an old range must not rewind production.
 *
 * The checkpoint is written here, after selection succeeds, so a run that
 * fails before this point (or hits a broken completion gate) is retried over
 * the same window. The record is also returned, so once #270 writes scores the
 * write MUST move behind the score-write step: with it here, a process death
 * during scoring loses the window's sample for good.
 */
export async function selectTraces(opts: SelectTracesOptions): Promise<Selection> {
    const { now, sampleRate, maxItems, override = {}, rng, fetchPage, checkpoints, runId } = opts;
    const isOverridden = Boolean(override.windowStart || override.windowEnd);
    const checkpoint = isOverridden ? null : await checkpoints.read();
    const window = computeWindow(now, checkpoint, override);
    const empty = {
        tracesInWindow: 0,
        completedTraces: 0,
        sampled: 0,
        sampledTraceIds: [],
        checkpointWritten: false,
        checkpoint: null,
    };
    if (!window) {
        const start = windowStart(now, checkpoint, override).toISOString();
        const end = (override.windowEnd ? new Date(override.windowEnd) : safeUpperBound(now)).toISOString();
        log.warning(`Empty window: start ${start} is at or past the upper bound ${end}; nothing selected`);
        return { ...empty, window: null };
    }

    const all = await collectTraceIds(fetchPage, window, traceFilter(window));
    // The completion span's own start time is the selection key. The two
    // queries are NOT nested sets (see `tracesInWindow`), so intersecting them
    // would drop every turn whose root started before the window: on a live day
    // (2026-09-07) the tag query and a name query shared only 1 of 3 traces.
    const completedIds = [...(await collectTraceIds(fetchPage, window, completedFilter(window)))];
    // A window with traffic but no completion span at all is the signature of
    // the trace contract not being deployed, or of the span name drifting, not
    // of unfinished traffic. Selecting nothing is correct; advancing the
    // checkpoint over it would burn the window silently, so leave it and let
    // the next run retry. The run's OUTPUT shows both counters.
    const isGateBroken = all.size > 0 && completedIds.length === 0;
    if (isGateBroken) {
        log.warning(
            `${all.size} apify-ai traces in the window but none carry a "${TURN_COMPLETE_SPAN_NAME}" span: ` +
                'that is the signature of a broken completion gate (the trace contract is not deployed, or the ' +
                'span name drifted), not of unfinished traffic; the checkpoint is left in place for a retry',
        );
    }
    const sampledTraceIds = sampleTraceIds(completedIds, sampleRate, maxItems, rng);

    const nextCheckpoint =
        isOverridden || isGateBroken
            ? null
            : { upperBound: window.end.toISOString(), runId, writtenAt: now.toISOString() };
    if (nextCheckpoint) await checkpoints.write(nextCheckpoint);
    return {
        window,
        tracesInWindow: all.size,
        completedTraces: completedIds.length,
        sampled: sampledTraceIds.length,
        sampledTraceIds,
        checkpointWritten: nextCheckpoint !== null,
        checkpoint: nextCheckpoint,
    };
}

// ---------------------------------------------------------------------------
// Production adapters
// ---------------------------------------------------------------------------

interface ObservationsApi {
    api: { observations: { getMany(request: Record<string, unknown>): Promise<unknown> } };
}

/** `GET /api/public/v2/observations` with the conditions as `filter` JSON. The
 * window is also sent as query params for readability of the request, but the
 * `startTime` conditions inside `filter` are what actually bound the query:
 * they REPLACE these params (see `windowBounds`). `limit: 1000` is the exact
 * documented max; 1001 is a 400. */
export function langfuseObservationFetcher(langfuse: ObservationsApi): ObservationFetcher {
    return async ({ window, filter, cursor }) =>
        (await langfuse.api.observations.getMany({
            fromStartTime: window.start.toISOString(),
            toStartTime: window.end.toISOString(),
            filter: JSON.stringify(filter),
            fields: 'core',
            limit: PAGE_LIMIT,
            cursor,
        })) as ObservationPage;
}

/** The Actor's default key-value store, one JSON record under CHECKPOINT_KEY. */
export function actorCheckpointStore(): CheckpointStore {
    return {
        read: async () => Actor.getValue<Checkpoint>(CHECKPOINT_KEY),
        write: async (checkpoint) => Actor.setValue(CHECKPOINT_KEY, checkpoint),
    };
}
