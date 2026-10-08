import { describe, expect, it } from 'vitest';

import {
    AGENT_REQUEST_TIMEOUT_MS,
    type Checkpoint,
    type CheckpointStore,
    collectTraceIds,
    completedFilter,
    computeWindow,
    DEFAULT_ENVIRONMENT,
    EXPORT_LAG_MS,
    type FilterCondition,
    isCompletionGateBroken,
    langfuseObservationFetcher,
    type ObservationFetcher,
    type ObservationPage,
    requestedWindow,
    safeUpperBound,
    sampleTraceIds,
    selectTraces,
    settledBefore,
    traceFilter,
    TURN_COMPLETE_SPAN_NAME,
} from '../src/select.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const HOUR_MS = 60 * 60_000;
const ENV = 'prod';

/** Deterministic RNG: cycles through fixed fractions. */
function fixedRng(values: number[]) {
    let i = 0;
    return () => values[i++ % values.length];
}

function memoryCheckpoints(initial: Checkpoint | null = null) {
    const writes: Checkpoint[] = [];
    const store: CheckpointStore = {
        read: async () => initial,
        write: async (c) => {
            writes.push(c);
        },
    };
    return { store, writes };
}

/** A root start time that is settled in every window these tests use: well before `settledBefore(window)`. */
const SETTLED_START = '2026-09-08T08:00:00.000Z';

/**
 * Fake Langfuse: the completed query is recognised by its name condition. Root
 * rows start at `SETTLED_START` unless `rootStart` says otherwise.
 */
function fakeFetcher(allIds: string[], completedIds: string[], pageSize = 2, rootStart: string | null = SETTLED_START) {
    const calls: { filter: FilterCondition[]; cursor?: string }[] = [];
    const fetchPage: ObservationFetcher = async ({ filter, cursor }) => {
        calls.push({ filter, cursor });
        const isCompleted = filter.some((c) => c.column === 'name' && c.value === TURN_COMPLETE_SPAN_NAME);
        const ids = isCompleted ? completedIds : allIds;
        const offset = cursor ? Number(cursor) : 0;
        const slice = ids.slice(offset, offset + pageSize);
        const next = offset + pageSize < ids.length ? String(offset + pageSize) : undefined;
        return {
            data: slice.map((traceId) => (rootStart && !isCompleted ? { traceId, startTime: rootStart } : { traceId })),
            meta: next ? { cursor: next } : {},
        };
    };
    return { fetchPage, calls };
}

describe('safeUpperBound', () => {
    it('subtracts the agent request timeout plus export lag', () => {
        expect(AGENT_REQUEST_TIMEOUT_MS).toBe(30 * 60_000);
        expect(EXPORT_LAG_MS).toBe(3 * 60_000);
        expect(safeUpperBound(NOW).toISOString()).toBe('2026-09-08T11:27:00.000Z');
    });
});

describe('computeWindow', () => {
    it('defaults to the last 24h without a checkpoint', () => {
        const w = computeWindow(NOW, null);
        expect(w?.start.toISOString()).toBe('2026-09-07T12:00:00.000Z');
        expect(w?.end).toEqual(safeUpperBound(NOW));
    });

    it('starts at the checkpoint when present', () => {
        const checkpoint = { upperBound: '2026-09-08T09:00:00.000Z', runId: 'r1', writtenAt: 'x' };
        const w = computeWindow(NOW, checkpoint);
        expect(w?.start.toISOString()).toBe('2026-09-08T09:00:00.000Z');
        expect(w?.end).toEqual(safeUpperBound(NOW));
    });

    it('requestedWindow returns the bounds even when they are empty or inverted', () => {
        const atBound = { upperBound: safeUpperBound(NOW).toISOString(), runId: null, writtenAt: 'x' };
        const w = requestedWindow(NOW, atBound);
        expect(w.start).toEqual(safeUpperBound(NOW));
        expect(w.end).toEqual(safeUpperBound(NOW));
        expect(computeWindow(NOW, atBound)).toBeNull();
    });

    it('returns null for an empty or inverted window', () => {
        const atBound = { upperBound: safeUpperBound(NOW).toISOString(), runId: null, writtenAt: 'x' };
        expect(computeWindow(NOW, atBound)).toBeNull();
        const future = { upperBound: NOW.toISOString(), runId: null, writtenAt: 'x' };
        expect(computeWindow(NOW, future)).toBeNull();
    });

    it('honours explicit overrides over the checkpoint, each bound alone', () => {
        const checkpoint = { upperBound: '2026-09-08T09:00:00.000Z', runId: null, writtenAt: 'x' };
        const both = computeWindow(NOW, checkpoint, {
            windowStart: '2026-09-01T00:00:00Z',
            windowEnd: '2026-09-02T00:00:00Z',
        });
        expect(both?.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
        expect(both?.end.toISOString()).toBe('2026-09-02T00:00:00.000Z');
        const startOnly = computeWindow(NOW, checkpoint, { windowStart: '2026-09-08T10:00:00Z' });
        expect(startOnly?.start.toISOString()).toBe('2026-09-08T10:00:00.000Z');
        expect(startOnly?.end).toEqual(safeUpperBound(NOW));
    });

    it('rejects an unparseable override', () => {
        expect(() => computeWindow(NOW, null, { windowStart: 'yesterday' })).toThrow(/Invalid window bound/);
    });
});

describe('filters', () => {
    const window = { start: new Date(NOW.getTime() - HOUR_MS), end: NOW };

    it('traceFilter carries the window bounds, the environment and the apify-ai tag', () => {
        expect(traceFilter(window, ENV)).toEqual([
            { type: 'datetime', column: 'startTime', operator: '>=', value: '2026-09-08T11:00:00.000Z' },
            { type: 'datetime', column: 'startTime', operator: '<', value: '2026-09-08T12:00:00.000Z' },
            { type: 'stringOptions', column: 'environment', operator: 'any of', value: ['prod'] },
            { type: 'arrayOptions', column: 'traceTags', operator: 'any of', value: ['apify-ai'] },
        ]);
    });

    it('completedFilter is the bounds and environment plus the span name, with no tag or metadata condition', () => {
        expect(completedFilter(window, ENV)).toEqual([
            { type: 'datetime', column: 'startTime', operator: '>=', value: '2026-09-08T11:00:00.000Z' },
            { type: 'datetime', column: 'startTime', operator: '<', value: '2026-09-08T12:00:00.000Z' },
            { type: 'stringOptions', column: 'environment', operator: 'any of', value: ['prod'] },
            { type: 'string', column: 'name', operator: '=', value: 'apify-ai.turn-complete' },
        ]);
        // The tag lives only on the root span and matches per observation, so
        // tag AND name can never return a row (live-verified 2026-09-09).
        expect(completedFilter(window, ENV).some((c) => c.column === 'traceTags')).toBe(false);
        expect(completedFilter(window, ENV).some((c) => c.column === 'metadata')).toBe(false);
    });

    it('every filter the module builds carries both window bounds, because filter replaces the query params', () => {
        for (const filter of [traceFilter(window, ENV), completedFilter(window, ENV)]) {
            const bounds = filter.filter((c) => c.type === 'datetime' && c.column === 'startTime');
            expect(bounds).toEqual([
                { type: 'datetime', column: 'startTime', operator: '>=', value: window.start.toISOString() },
                { type: 'datetime', column: 'startTime', operator: '<', value: window.end.toISOString() },
            ]);
        }
    });

    it('every filter the module builds pins the environment, so dev and staging turns are never scored', () => {
        expect(DEFAULT_ENVIRONMENT).toBe('prod');
        for (const filter of [traceFilter(window, 'staging'), completedFilter(window, 'staging')]) {
            expect(filter).toContainEqual({
                type: 'stringOptions',
                column: 'environment',
                operator: 'any of',
                value: ['staging'],
            });
        }
    });
});

describe('langfuseObservationFetcher', () => {
    const window = { start: new Date(NOW.getTime() - HOUR_MS), end: NOW };

    it('sends the window, the filter as a JSON string, fields core, limit 1000 and the cursor', async () => {
        const requests: Record<string, unknown>[] = [];
        const pages: ObservationPage[] = [
            { data: [{ traceId: 'a' }, { traceId: null }], meta: { cursor: 'next' } },
            { data: [{ traceId: 'b' }], meta: {} },
        ];
        const fake = {
            api: {
                observations: {
                    getMany: async (request: Record<string, unknown>) => {
                        requests.push(request);
                        return pages[requests.length - 1];
                    },
                },
            },
        };

        const ids = await collectTraceIds(langfuseObservationFetcher(fake), window, traceFilter(window, ENV));

        expect([...ids]).toEqual(['a', 'b']);
        expect(requests.length).toBe(2);
        expect(requests[0]).toMatchObject({
            fromStartTime: '2026-09-08T11:00:00.000Z',
            toStartTime: '2026-09-08T12:00:00.000Z',
            fields: 'core',
            limit: 1000,
            cursor: undefined,
        });
        expect(typeof requests[0].filter).toBe('string');
        expect(JSON.parse(requests[0].filter as string)).toEqual(traceFilter(window, ENV));
        expect(requests[1].cursor).toBe('next');
    });
});

describe('collectTraceIds', () => {
    const window = { start: new Date(NOW.getTime() - HOUR_MS), end: NOW };

    it('follows meta.cursor across every page and dedupes trace ids', async () => {
        const pages: ObservationPage[] = [
            { data: [{ traceId: 'a' }, { traceId: 'b' }], meta: { cursor: 'p2' } },
            { data: [{ traceId: 'b' }, { traceId: null }], meta: { cursor: 'p3' } },
            { data: [{ traceId: 'c' }], meta: {} },
        ];
        const seen: (string | undefined)[] = [];
        const fetchPage: ObservationFetcher = async ({ cursor }) => {
            seen.push(cursor);
            return pages[seen.length - 1];
        };
        const ids = await collectTraceIds(fetchPage, window, traceFilter(window, ENV));
        expect([...ids].sort()).toEqual(['a', 'b', 'c']);
        expect(seen).toEqual([undefined, 'p2', 'p3']);
    });
});

describe('sampleTraceIds', () => {
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'];

    it('takes ceil(rate * n)', () => {
        expect(sampleTraceIds(ids, 0.2, 100, fixedRng([0.5])).length).toBe(2);
        expect(sampleTraceIds(ids, 0.25, 100, fixedRng([0.5])).length).toBe(3);
        expect(sampleTraceIds(ids, 0, 100, fixedRng([0.5]))).toEqual([]);
        expect(sampleTraceIds([], 1, 100, fixedRng([0.5]))).toEqual([]);
    });

    it('caps at maxItems after shuffling', () => {
        const sample = sampleTraceIds(ids, 1, 3, fixedRng([0.1, 0.9, 0.3]));
        expect(sample.length).toBe(3);
        // A capped sample is not the input prefix: the shuffle ran first.
        expect(sample).not.toEqual(ids.slice(0, 3));
        for (const id of sample) expect(ids).toContain(id);
    });

    it('is a permutation-based subset with no duplicates', () => {
        const sample = sampleTraceIds(ids, 1, 100, fixedRng([0.37, 0.82, 0.05]));
        expect([...sample].sort()).toEqual([...ids].sort());
        expect(sample).not.toBe(ids);
    });
});

describe('isCompletionGateBroken', () => {
    const window = { start: new Date('2026-09-08T00:00:00.000Z'), end: new Date('2026-09-08T12:00:00.000Z') };
    const settled = { traceId: 'a', startTime: '2026-09-08T11:29:59.000Z' };
    const late = { traceId: 'b', startTime: '2026-09-08T11:30:00.000Z' };

    it('settledBefore is the window end minus the agent request timeout', () => {
        expect(settledBefore(window).toISOString()).toBe('2026-09-08T11:30:00.000Z');
    });

    it('is broken only when a settled root has no completion at all', () => {
        expect(isCompletionGateBroken([settled], 0, window)).toBe(true);
        expect(isCompletionGateBroken([settled, late], 0, window)).toBe(true);
        expect(isCompletionGateBroken([late], 0, window)).toBe(false);
        expect(isCompletionGateBroken([], 0, window)).toBe(false);
        expect(isCompletionGateBroken([settled], 1, window)).toBe(false);
    });

    it('does not count a row without a parseable start time as settled', () => {
        expect(isCompletionGateBroken([{ traceId: 'c' }], 0, window)).toBe(false);
        expect(isCompletionGateBroken([{ traceId: 'c', startTime: 'garbage' }], 0, window)).toBe(false);
        expect(isCompletionGateBroken([{ traceId: null, startTime: settled.startTime }], 0, window)).toBe(false);
    });
});

describe('selectTraces', () => {
    it('counts, samples only completed traces, and returns the checkpoint record for the upper bound', async () => {
        const all = ['a', 'b', 'c', 'd', 'e'];
        const completed = ['a', 'c', 'e'];
        const { fetchPage } = fakeFetcher(all, completed);
        const { store, writes } = memoryCheckpoints();

        const s = await selectTraces({
            now: NOW,
            sampleRate: 0.5,
            maxItems: 10,
            rng: fixedRng([0.2, 0.7]),
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: 'run-1',
        });

        expect(s.tracesInWindow).toBe(5);
        expect(s.completedTraces).toBe(3);
        expect(s.isGateBroken).toBe(false);
        expect(s.sampled).toBe(2);
        expect(s.sampledTraceIds.length).toBe(2);
        for (const id of s.sampledTraceIds) expect(['a', 'c', 'e']).toContain(id);
        expect(s.checkpoint).toEqual({
            upperBound: safeUpperBound(NOW).toISOString(),
            runId: 'run-1',
            writtenAt: NOW.toISOString(),
        });
        // Never written here: the online flow writes it after the window's scores (#270).
        expect(writes).toEqual([]);
    });

    it('keeps a completed trace whose root span is outside the window (no intersection)', async () => {
        // Live 2026-09-07: the tag query and a name query over the same day
        // shared only 1 of 3 trace ids, so intersecting them would drop turns
        // that started before the window and completed inside it.
        const { fetchPage } = fakeFetcher(['root-only'], ['completed-elsewhere']);
        const { store } = memoryCheckpoints();

        const s = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 10,
            rng: Math.random,
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: null,
        });

        expect(s.tracesInWindow).toBe(1);
        expect(s.completedTraces).toBe(1);
        expect(s.sampledTraceIds).toEqual(['completed-elsewhere']);
    });

    it('returns no checkpoint record when settled traffic has no completion span (broken gate)', async () => {
        const { fetchPage } = fakeFetcher(['a', 'b'], []);
        const { store, writes } = memoryCheckpoints();

        const s = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 10,
            rng: Math.random,
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: 'run-1',
        });

        expect(s.tracesInWindow).toBe(2);
        expect(s.completedTraces).toBe(0);
        expect(s.sampledTraceIds).toEqual([]);
        expect(s.checkpoint).toBeNull();
        expect(s.isGateBroken).toBe(true);
        expect(writes).toEqual([]);
    });

    it('a turn that starts in the last 30 min of the window and has not completed is not a broken gate', async () => {
        // Root at 11:20, window end 11:27: the turn may run until 11:50, so its
        // completion legitimately lands in the next window. One such turn on a
        // quiet day (1 in, 0 completed) must not fail the run, and a backfill
        // with a fixed windowEnd over it must not fail every time.
        const lateStart = new Date(safeUpperBound(NOW).getTime() - 7 * 60_000).toISOString();
        const { fetchPage } = fakeFetcher(['late'], [], 2, lateStart);
        const { store } = memoryCheckpoints();

        const s = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 10,
            rng: Math.random,
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: 'run-1',
        });

        expect(s.tracesInWindow).toBe(1);
        expect(s.completedTraces).toBe(0);
        expect(s.isGateBroken).toBe(false);
        expect(s.checkpoint).not.toBeNull();
    });

    it('still returns a checkpoint record over a genuinely empty window', async () => {
        const { fetchPage } = fakeFetcher([], []);
        const { store } = memoryCheckpoints();

        const s = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 10,
            rng: Math.random,
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: null,
        });

        expect(s.checkpoint).not.toBeNull();
        // No traffic at all is an idle window, not a broken gate: the run stays green.
        expect(s.isGateBroken).toBe(false);
    });

    it('returns zero counts and does not move the checkpoint on an empty window', async () => {
        const checkpoint = { upperBound: safeUpperBound(NOW).toISOString(), runId: null, writtenAt: 'x' };
        const { fetchPage, calls } = fakeFetcher(['a'], ['a']);
        const { store, writes } = memoryCheckpoints(checkpoint);

        const s = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 10,
            rng: Math.random,
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: null,
        });

        expect(s).toMatchObject({
            window: null,
            tracesInWindow: 0,
            completedTraces: 0,
            sampled: 0,
            checkpoint: null,
            isGateBroken: false,
        });
        expect(calls).toEqual([]);
        expect(writes).toEqual([]);
    });

    it('propagates a failed fetch', async () => {
        const fetchPage: ObservationFetcher = async () => {
            throw new Error('langfuse down');
        };
        const { store } = memoryCheckpoints();
        await expect(
            selectTraces({
                now: NOW,
                sampleRate: 1,
                maxItems: 10,
                rng: Math.random,
                fetchPage,
                checkpoints: store,
                environment: ENV,
                runId: null,
            }),
        ).rejects.toThrow('langfuse down');
    });

    it('neither reads nor writes the checkpoint under an explicit window override', async () => {
        const { fetchPage, calls } = fakeFetcher(['a', 'b'], ['a']);
        let reads = 0;
        const writes: Checkpoint[] = [];
        const store: CheckpointStore = {
            read: async () => {
                reads++;
                return null;
            },
            write: async (c) => {
                writes.push(c);
            },
        };

        const s = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 10,
            override: { windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-09-02T00:00:00Z' },
            rng: Math.random,
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: null,
        });

        expect(reads).toBe(0);
        expect(writes).toEqual([]);
        expect(s.checkpoint).toBeNull();
        expect(s.sampledTraceIds).toEqual(['a']);
        expect(calls[0].filter[0].value).toBe('2026-09-01T00:00:00.000Z');
    });

    it('returns no checkpoint record under an override or an empty window', async () => {
        const { fetchPage } = fakeFetcher(['a'], ['a']);
        const { store } = memoryCheckpoints();
        const overridden = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 10,
            override: { windowStart: '2026-09-01T00:00:00Z' },
            rng: Math.random,
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: null,
        });
        expect(overridden.checkpoint).toBeNull();

        const atBound = { upperBound: safeUpperBound(NOW).toISOString(), runId: null, writtenAt: 'x' };
        const empty = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 10,
            rng: Math.random,
            fetchPage,
            checkpoints: memoryCheckpoints(atBound).store,
            environment: ENV,
            runId: null,
        });
        expect(empty.checkpoint).toBeNull();
    });

    it('paginates both queries fully', async () => {
        const all = Array.from({ length: 7 }, (_, i) => `t${i}`);
        const { fetchPage, calls } = fakeFetcher(all, all.slice(0, 5), 3);
        const { store } = memoryCheckpoints();
        const s = await selectTraces({
            now: NOW,
            sampleRate: 1,
            maxItems: 100,
            rng: Math.random,
            fetchPage,
            checkpoints: store,
            environment: ENV,
            runId: null,
        });
        expect(s.tracesInWindow).toBe(7);
        expect(s.completedTraces).toBe(5);
        // 3 pages for 7 ids, 2 pages for 5 ids.
        expect(calls.length).toBe(5);
    });
});
