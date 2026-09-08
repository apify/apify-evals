import { describe, expect, it } from 'vitest';

import {
    AGENT_REQUEST_TIMEOUT_MS,
    type Checkpoint,
    type CheckpointStore,
    collectTraceIds,
    completedFilter,
    computeWindow,
    EXPORT_LAG_MS,
    type FilterCondition,
    langfuseObservationFetcher,
    type ObservationFetcher,
    type ObservationPage,
    safeUpperBound,
    sampleTraceIds,
    selectTraces,
    traceFilter,
    TURN_COMPLETE_SPAN_NAME,
} from '../src/select.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const HOUR_MS = 60 * 60_000;

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

/** Fake Langfuse: the completed query is recognised by its name condition. */
function fakeFetcher(allIds: string[], completedIds: string[], pageSize = 2) {
    const calls: { filter: FilterCondition[]; cursor?: string }[] = [];
    const fetchPage: ObservationFetcher = async ({ filter, cursor }) => {
        calls.push({ filter, cursor });
        const isCompleted = filter.some((c) => c.column === 'name' && c.value === TURN_COMPLETE_SPAN_NAME);
        const ids = isCompleted ? completedIds : allIds;
        const offset = cursor ? Number(cursor) : 0;
        const slice = ids.slice(offset, offset + pageSize);
        const next = offset + pageSize < ids.length ? String(offset + pageSize) : undefined;
        return { data: slice.map((traceId) => ({ traceId })), meta: next ? { cursor: next } : {} };
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

    it('traceFilter carries the window bounds and the apify-ai tag', () => {
        expect(traceFilter(window)).toEqual([
            { type: 'datetime', column: 'startTime', operator: '>=', value: '2026-09-08T11:00:00.000Z' },
            { type: 'datetime', column: 'startTime', operator: '<', value: '2026-09-08T12:00:00.000Z' },
            { type: 'arrayOptions', column: 'traceTags', operator: 'any of', value: ['apify-ai'] },
        ]);
    });

    it('completedFilter adds only the span name, never a metadata condition', () => {
        const extra = completedFilter(window).slice(3);
        expect(extra).toEqual([{ type: 'string', column: 'name', operator: '=', value: 'apify-ai.turn-complete' }]);
        expect(completedFilter(window).some((c) => c.column === 'metadata')).toBe(false);
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

        const ids = await collectTraceIds(langfuseObservationFetcher(fake), window, traceFilter(window));

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
        expect(JSON.parse(requests[0].filter as string)).toEqual(traceFilter(window));
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
        const ids = await collectTraceIds(fetchPage, window, traceFilter(window));
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

describe('selectTraces', () => {
    it('counts, samples only completed traces, and checkpoints the upper bound', async () => {
        const all = ['a', 'b', 'c', 'd', 'e'];
        const completed = ['a', 'c', 'e', 'zzz-no-other-span'];
        const { fetchPage } = fakeFetcher(all, completed);
        const { store, writes } = memoryCheckpoints();

        const s = await selectTraces({
            now: NOW,
            sampleRate: 0.5,
            maxItems: 10,
            rng: fixedRng([0.2, 0.7]),
            fetchPage,
            checkpoints: store,
            runId: 'run-1',
        });

        expect(s.tracesInWindow).toBe(5);
        expect(s.completedTraces).toBe(3);
        expect(s.sampled).toBe(2);
        expect(s.sampledTraceIds.length).toBe(2);
        for (const id of s.sampledTraceIds) expect(['a', 'c', 'e']).toContain(id);
        expect(s.checkpointWritten).toBe(true);
        expect(writes).toEqual([
            { upperBound: safeUpperBound(NOW).toISOString(), runId: 'run-1', writtenAt: NOW.toISOString() },
        ]);
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
            runId: null,
        });

        expect(s).toMatchObject({ window: null, tracesInWindow: 0, completedTraces: 0, sampled: 0 });
        expect(calls).toEqual([]);
        expect(writes).toEqual([]);
    });

    it('does not write the checkpoint when the fetch fails', async () => {
        const fetchPage: ObservationFetcher = async () => {
            throw new Error('langfuse down');
        };
        const { store, writes } = memoryCheckpoints();
        await expect(
            selectTraces({
                now: NOW,
                sampleRate: 1,
                maxItems: 10,
                rng: Math.random,
                fetchPage,
                checkpoints: store,
                runId: null,
            }),
        ).rejects.toThrow('langfuse down');
        expect(writes).toEqual([]);
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
            runId: null,
        });

        expect(reads).toBe(0);
        expect(writes).toEqual([]);
        expect(s.checkpointWritten).toBe(false);
        expect(s.sampledTraceIds).toEqual(['a']);
        expect(calls[0].filter[0].value).toBe('2026-09-01T00:00:00.000Z');
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
            runId: null,
        });
        expect(s.tracesInWindow).toBe(7);
        expect(s.completedTraces).toBe(5);
        // 3 pages for 7 ids, 2 pages for 5 ids.
        expect(calls.length).toBe(5);
    });
});
