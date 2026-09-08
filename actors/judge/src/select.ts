import { Actor } from 'apify';

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
 * Every apify-ai observation whose start falls in the window. The window is
 * repeated inside `filter` because the endpoint documents `filter` as taking
 * precedence over the fromStartTime/toStartTime query params; both are sent.
 */
export function traceFilter(window: Window): FilterCondition[] {
    return [
        { type: 'datetime', column: 'startTime', operator: '>=', value: window.start.toISOString() },
        { type: 'datetime', column: 'startTime', operator: '<', value: window.end.toISOString() },
        { type: 'arrayOptions', column: 'traceTags', operator: 'any of', value: [TRACE_TAG] },
    ];
}

/**
 * Only the completion-signal spans. `completed` is matched as the string
 * 'true' because the observations `metadata` column accepts only
 * `stringObject` filters, which is why the agent writes it as a string.
 */
export function completedFilter(window: Window): FilterCondition[] {
    return [
        ...traceFilter(window),
        { type: 'string', column: 'name', operator: '=', value: TURN_COMPLETE_SPAN_NAME },
        { type: 'stringObject', column: 'metadata', key: 'completed', operator: '=', value: 'true' },
    ];
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
    return shuffled.slice(0, Math.max(0, size));
}

export interface SelectionCounters {
    /** Distinct apify-ai traces with at least one span starting in the window. */
    tracesInWindow: number;
    /** Those whose completion signal starts in the window. */
    completedTraces: number;
    sampled: number;
}

export interface Selection extends SelectionCounters {
    window: Window | null;
    sampledTraceIds: string[];
    /** True when the window came from the checkpoint or default, so the checkpoint moved. */
    checkpointWritten: boolean;
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
 * fails before this point is retried over the same window. #270 may move the
 * write behind the score-write step once there is one; either is defensible,
 * because a failed judge call on a sampled trace is counted in
 * `failedToJudge`, not silently lost.
 */
export async function selectTraces(opts: SelectTracesOptions): Promise<Selection> {
    const { now, sampleRate, maxItems, override = {}, rng, fetchPage, checkpoints, runId } = opts;
    const isOverridden = Boolean(override.windowStart || override.windowEnd);
    const checkpoint = isOverridden ? null : await checkpoints.read();
    const window = computeWindow(now, checkpoint, override);
    const empty = { tracesInWindow: 0, completedTraces: 0, sampled: 0, sampledTraceIds: [], checkpointWritten: false };
    if (!window) return { ...empty, window: null };

    const all = await collectTraceIds(fetchPage, window, traceFilter(window));
    const completed = await collectTraceIds(fetchPage, window, completedFilter(window));
    // Intersect defensively: both queries share the tag and window, so this is
    // a no-op unless a completion span arrives under a trace with no other span.
    const completedIds = [...completed].filter((id) => all.has(id));
    const sampledTraceIds = sampleTraceIds(completedIds, sampleRate, maxItems, rng);

    if (!isOverridden) {
        await checkpoints.write({ upperBound: window.end.toISOString(), runId, writtenAt: now.toISOString() });
    }
    return {
        window,
        tracesInWindow: all.size,
        completedTraces: completedIds.length,
        sampled: sampledTraceIds.length,
        sampledTraceIds,
        checkpointWritten: !isOverridden,
    };
}

// ---------------------------------------------------------------------------
// Production adapters
// ---------------------------------------------------------------------------

interface ObservationsApi {
    api: { observations: { getMany(request: Record<string, unknown>): Promise<unknown> } };
}

/** `GET /api/public/v2/observations` with the window as query params and the conditions as `filter` JSON. */
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
