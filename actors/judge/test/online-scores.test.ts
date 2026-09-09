import { NotFoundError } from '@langfuse/core';
import { describe, expect, it } from 'vitest';

import { JUDGE_IMPL_VERSION } from '../src/core.js';
import type { OnlineVerdicts } from '../src/online-judge.js';
import {
    AllJudgementsFailedError,
    AllScoreWritesFailedError,
    computeRollup,
    type CreateDatasetItemRequest,
    type CreateScoreRequest,
    type ExistingOnlineScore,
    finishOnlineRun,
    InvalidScoreIdError,
    isNotFound,
    judgedUnderVersion,
    langfuseOnlineScoreReader,
    MAX_SCORE_ID_LENGTH,
    mergeRollup,
    onlineRunId,
    onlineScoreId,
    type OnlineScoreVersion,
    orderedRequests,
    pendingScores,
    type Rollup,
    ROLLUP_DATASET_NAME,
    type RollupApi,
    rollupItemId,
    rollupItemRequest,
    RUN_COPY_SUFFIX,
    sanitiseIdPart,
    scoreRequests,
    skipAlreadyJudged,
    upsertDailyRollup,
    utcDate,
    writeOnlineScores,
} from '../src/online-scores.js';
import { HOLISTIC_SCORE_NAME, ONLINE_SCORE_NAMES } from '../src/rubric.js';
import type { Checkpoint, CheckpointStore } from '../src/select.js';

const NOW = new Date('2026-09-09T10:15:00.000Z');
const TRACE_ID = 'abc123def4567890abc123def4567890';
const MODEL = 'deepseek/deepseek-v4-flash';

const version: OnlineScoreVersion = { promptVersion: 3, judgeImplVersion: JUDGE_IMPL_VERSION, judgeModel: MODEL };

function verdictsFor(
    traceId: string,
    values: Partial<Record<string, 0 | 1 | 'omitted'>> = {},
    v: OnlineScoreVersion = version,
): OnlineVerdicts {
    return {
        traceId,
        scores: ONLINE_SCORE_NAMES.map((name) => {
            const value = values[name] ?? 1;
            if (value === 'omitted') return { name, omitted: true as const, reason: 'no tool call errored' };
            return { name, value, comment: `${value ? 'PASS' : 'FAIL'}; span g9`, evidence: 'the user asked SECRET' };
        }),
        metadata: {
            rubricName: 'apify-ai-turn',
            rubricVersion: 1,
            judgeModel: v.judgeModel,
            promptVersion: v.promptVersion,
            judgeImplVersion: v.judgeImplVersion,
            toolSchemaHash: 'sha256:abc',
            schemaMatch: true,
            outcome: 'completed',
            spanId: 'g9',
        },
    };
}

function fakeScoresApi(failOn: (request: CreateScoreRequest) => boolean = () => false) {
    const requests: CreateScoreRequest[] = [];
    return {
        requests,
        api: {
            create: async (request: CreateScoreRequest) => {
                if (failOn(request)) throw new Error(`refused ${request.id}`);
                requests.push(request);
                return { id: request.id };
            },
        },
    };
}

const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });

function fakeRollupApi(opts: { existingItem?: unknown; failCreate?: boolean } = {}) {
    const calls: string[] = [];
    const items: CreateDatasetItemRequest[] = [];
    const api: RollupApi = {
        datasets: {
            create: async (request) => {
                calls.push(`datasets.create ${request.name}`);
                return request;
            },
        },
        datasetItems: {
            get: async (id) => {
                calls.push(`datasetItems.get ${id}`);
                if (opts.existingItem === undefined) throw notFound();
                return { metadata: opts.existingItem };
            },
            create: async (request) => {
                calls.push(`datasetItems.create ${request.id}`);
                if (opts.failCreate) throw new Error('langfuse down');
                items.push(request);
                return { id: request.id as string };
            },
        },
    };
    return { api, calls, items };
}

function memoryCheckpoints() {
    const writes: Checkpoint[] = [];
    const store: CheckpointStore = {
        read: async () => null,
        write: async (c) => {
            writes.push(c);
        },
    };
    return { store, writes };
}

describe('pendingScores (the adapter over #269)', () => {
    it('flattens every scored criterion and drops omitted ones', () => {
        const v = verdictsFor('t1', { agent_judge_errorRecovery: 'omitted', agent_judge_taskCompletion: 0 });
        const pending = pendingScores(v);
        expect(pending.map((p) => p.name)).toEqual(ONLINE_SCORE_NAMES.filter((n) => n !== 'agent_judge_errorRecovery'));
        expect(pending.find((p) => p.name === 'agent_judge_taskCompletion')?.value).toBe(0);
        expect(pending[0]).toMatchObject({ traceId: 't1', version, evidence: 'the user asked SECRET' });
        expect(pending[0].metadata).toEqual(v.metadata);
    });
});

describe('ids', () => {
    it('utcDate is the ISO date in UTC', () => {
        expect(utcDate(NOW)).toBe('2026-09-09');
        expect(utcDate(new Date('2026-09-09T23:59:59.999Z'))).toBe('2026-09-09');
    });

    it('sanitiseIdPart replaces runs of /, : and . with one hyphen', () => {
        expect(sanitiseIdPart('deepseek/deepseek-v4-flash')).toBe('deepseek-deepseek-v4-flash');
        expect(sanitiseIdPart('anthropic/claude-sonnet-4.6')).toBe('anthropic-claude-sonnet-4-6');
        expect(sanitiseIdPart('openrouter:x/y.z')).toBe('openrouter-x-y-z');
        expect(sanitiseIdPart('0.1.0')).toBe('0-1-0');
        expect(sanitiseIdPart('a b')).toBe('a-b');
        expect(sanitiseIdPart('safe_name-1')).toBe('safe_name-1');
    });

    it('onlineScoreId is <traceId>-<name>-p<prompt>-i<impl>-<model>, plus -run for the archival copy', () => {
        const key = { traceId: TRACE_ID, scoreName: 'agent_judge_toolSelection', version };
        expect(onlineScoreId(key, 'trace')).toBe(
            `${TRACE_ID}-agent_judge_toolSelection-p3-i0-1-0-deepseek-deepseek-v4-flash`,
        );
        expect(onlineScoreId(key, 'run')).toBe(`${onlineScoreId(key, 'trace')}${RUN_COPY_SUFFIX}`);
        expect(JUDGE_IMPL_VERSION).toBe('0.1.0');
    });

    it('a bumped prompt, impl or model changes the id', () => {
        const key = { traceId: TRACE_ID, scoreName: HOLISTIC_SCORE_NAME, version };
        const base = onlineScoreId(key, 'trace');
        expect(onlineScoreId({ ...key, version: { ...version, promptVersion: 4 } }, 'trace')).not.toBe(base);
        expect(onlineScoreId({ ...key, version: { ...version, judgeImplVersion: '0.2.0' } }, 'trace')).not.toBe(base);
        expect(onlineScoreId({ ...key, version: { ...version, judgeModel: 'x/y' } }, 'trace')).not.toBe(base);
    });

    it('rejects an id over the length cap', () => {
        const key = { traceId: 'x'.repeat(MAX_SCORE_ID_LENGTH), scoreName: HOLISTIC_SCORE_NAME, version };
        expect(() => onlineScoreId(key, 'trace')).toThrow(InvalidScoreIdError);
        expect(() => onlineScoreId(key, 'trace')).toThrow(/max is 255/);
    });

    it('every online score name fits with a 32-hex trace id and a long model id', () => {
        const long = { ...version, judgeModel: 'anthropic/claude-sonnet-4.6-20260901-extended-thinking' };
        for (const scoreName of ONLINE_SCORE_NAMES) {
            const id = onlineScoreId({ traceId: TRACE_ID, scoreName, version: long }, 'run');
            expect(id.length).toBeLessThan(MAX_SCORE_ID_LENGTH);
            expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    });

    it('onlineRunId and rollupItemId are keyed on the UTC date', () => {
        expect(onlineRunId(NOW)).toBe('apify-ai-online-2026-09-09');
        expect(rollupItemId(NOW)).toBe('rollup-2026-09-09');
    });
});

describe('scoreRequests', () => {
    const [pending] = pendingScores(verdictsFor(TRACE_ID));
    const { trace, run } = scoreRequests(pending, NOW);

    it('trace copy: readable id, traceId subject, BOOLEAN, comment, metadata plus evidence', () => {
        expect(trace).toEqual({
            id: onlineScoreId({ traceId: TRACE_ID, scoreName: HOLISTIC_SCORE_NAME, version }, 'trace'),
            traceId: TRACE_ID,
            name: HOLISTIC_SCORE_NAME,
            value: 1,
            dataType: 'BOOLEAN',
            comment: 'PASS; span g9',
            metadata: { ...pending.metadata, evidence: 'the user asked SECRET' },
        });
    });

    it('run copy: suffixed id, datasetRunId subject only, no traceId, no evidence', () => {
        expect(run).toEqual({
            id: `${trace.id}${RUN_COPY_SUFFIX}`,
            datasetRunId: 'apify-ai-online-2026-09-09',
            name: HOLISTIC_SCORE_NAME,
            value: 1,
            dataType: 'BOOLEAN',
            comment: 'PASS; span g9',
            metadata: pending.metadata,
        });
        expect(run).not.toHaveProperty('traceId');
        expect(JSON.stringify(run)).not.toContain('SECRET');
    });

    it('neither copy sets source (API is the endpoint default; EVAL is refused)', () => {
        expect(trace).not.toHaveProperty('source');
        expect(run).not.toHaveProperty('source');
    });

    it('keys the run copy on the date given (the window start), not on today', () => {
        const backfill = scoreRequests(pending, new Date('2026-09-01T05:27:00.000Z')).run;
        expect(backfill.datasetRunId).toBe('apify-ai-online-2026-09-01');
    });

    it('does not add evidence when the score has none', () => {
        const noEvidence = { ...pending, evidence: undefined };
        expect(scoreRequests(noEvidence, NOW).trace.metadata).toEqual(pending.metadata);
    });
});

describe('orderedRequests', () => {
    it('writes criteria (trace, run) first and the holistic trace copy last', () => {
        const requests = orderedRequests(pendingScores(verdictsFor(TRACE_ID)), NOW);
        expect(requests.length).toBe(ONLINE_SCORE_NAMES.length * 2);
        const last = requests[requests.length - 1];
        expect(last.name).toBe(HOLISTIC_SCORE_NAME);
        expect(last.traceId).toBe(TRACE_ID);
        expect(requests[requests.length - 2]).toMatchObject({
            name: HOLISTIC_SCORE_NAME,
            datasetRunId: onlineRunId(NOW),
        });
        expect(requests[0]).toMatchObject({ name: 'agent_judge_toolSelection', traceId: TRACE_ID });
        expect(requests[1]).toMatchObject({ name: 'agent_judge_toolSelection', datasetRunId: onlineRunId(NOW) });
    });
});

describe('writeOnlineScores', () => {
    it('writes two copies per scored criterion and none for omitted ones', async () => {
        const { api, requests } = fakeScoresApi();
        const verdicts = [verdictsFor('t1', { agent_judge_errorRecovery: 'omitted' }), verdictsFor('t2')];
        const result = await writeOnlineScores({ verdicts, scores: api, date: NOW });

        expect(result).toMatchObject({ scoresWritten: 2, failedToWrite: 0 });
        expect(result.written).toEqual(verdicts);
        expect(requests.length).toBe((ONLINE_SCORE_NAMES.length - 1) * 2 + ONLINE_SCORE_NAMES.length * 2);
        expect(requests.filter((r) => r.name === 'agent_judge_errorRecovery').map((r) => r.traceId)).toEqual([
            't2',
            undefined,
        ]);
        expect(new Set(requests.map((r) => r.id)).size).toBe(requests.length);
    });

    it('counts a failing trace and keeps writing the others', async () => {
        const { api, requests } = fakeScoresApi((r) => r.id?.startsWith('bad-') ?? false);
        const result = await writeOnlineScores({
            verdicts: [verdictsFor('bad'), verdictsFor('good')],
            scores: api,
            date: NOW,
        });
        expect(result).toMatchObject({ scoresWritten: 1, failedToWrite: 1 });
        expect(result.written.map((v) => v.traceId)).toEqual(['good']);
        expect(requests.every((r) => r.id?.startsWith('good-'))).toBe(true);
    });

    it('a trace whose writes die halfway has no holistic trace copy, so the pre-filter will retry it', async () => {
        let count = 0;
        const { api, requests } = fakeScoresApi(() => ++count === 5);
        await writeOnlineScores({ verdicts: [verdictsFor('t1')], scores: api, date: NOW });
        expect(requests.some((r) => r.name === HOLISTIC_SCORE_NAME && r.traceId === 't1')).toBe(false);
    });
});

describe('idempotency', () => {
    const existing = (traceId: string, v: OnlineScoreVersion, name = HOLISTIC_SCORE_NAME): ExistingOnlineScore => ({
        name,
        traceId,
        metadata: { promptVersion: v.promptVersion, judgeImplVersion: v.judgeImplVersion, judgeModel: v.judgeModel },
    });

    it('judgedUnderVersion matches only the holistic score with the exact prompt, impl and model', () => {
        const scores = [
            existing('same', version),
            existing('prompt', { ...version, promptVersion: 2 }),
            existing('impl', { ...version, judgeImplVersion: '0.0.9' }),
            existing('model', { ...version, judgeModel: 'other/model' }),
            existing('criterion-only', version, 'agent_judge_toolSelection'),
            { name: HOLISTIC_SCORE_NAME, traceId: 'no-metadata' },
            { name: HOLISTIC_SCORE_NAME, traceId: null, metadata: {} },
        ];
        expect([...judgedUnderVersion(scores, version)]).toEqual(['same']);
    });

    it('round trip: the trace copy the writer produces is what the reader recognises', () => {
        const [holistic, criterion] = pendingScores(verdictsFor('rt'));
        const asRead = (r: CreateScoreRequest): ExistingOnlineScore => ({
            name: r.name,
            traceId: r.traceId ?? null,
            metadata: r.metadata,
        });
        expect(holistic.name).toBe(HOLISTIC_SCORE_NAME);
        expect(judgedUnderVersion([asRead(scoreRequests(holistic, NOW).trace)], version).has('rt')).toBe(true);
        // The run copy has no trace subject and a criterion is not the marker: neither counts.
        expect(judgedUnderVersion([asRead(scoreRequests(holistic, NOW).run)], version).size).toBe(0);
        expect(judgedUnderVersion([asRead(scoreRequests(criterion, NOW).trace)], version).size).toBe(0);
        const bumped = { ...version, promptVersion: version.promptVersion + 1 };
        expect(judgedUnderVersion([asRead(scoreRequests(holistic, NOW).trace)], bumped).size).toBe(0);
    });

    it('promptVersion matches across number and string metadata', () => {
        const s: ExistingOnlineScore = {
            name: HOLISTIC_SCORE_NAME,
            traceId: 't',
            metadata: { promptVersion: '3', judgeImplVersion: JUDGE_IMPL_VERSION, judgeModel: MODEL },
        };
        expect(judgedUnderVersion([s], version).has('t')).toBe(true);
    });

    it('skipAlreadyJudged splits the sample and preserves order', async () => {
        const readScores = async () => [existing('b', version)];
        const r = await skipAlreadyJudged({ traceIds: ['a', 'b', 'c'], version, force: false, readScores });
        expect(r).toEqual({ toJudge: ['a', 'c'], skipped: ['b'] });
    });

    it('a bumped version skips nothing, so the new score lands beside the old one', async () => {
        const readScores = async () => [existing('b', version)];
        const bumped = { ...version, promptVersion: 4 };
        const r = await skipAlreadyJudged({ traceIds: ['a', 'b'], version: bumped, force: false, readScores });
        expect(r.skipped).toEqual([]);
        const oldId = onlineScoreId({ traceId: 'b', scoreName: HOLISTIC_SCORE_NAME, version }, 'trace');
        const newId = onlineScoreId({ traceId: 'b', scoreName: HOLISTIC_SCORE_NAME, version: bumped }, 'trace');
        expect(newId).not.toBe(oldId);
    });

    it('force judges everything and does not read scores; an empty sample reads nothing', async () => {
        let reads = 0;
        const readScores = async () => {
            reads++;
            return [existing('a', version)];
        };
        expect(await skipAlreadyJudged({ traceIds: ['a'], version, force: true, readScores })).toEqual({
            toJudge: ['a'],
            skipped: [],
        });
        expect(await skipAlreadyJudged({ traceIds: [], version, force: false, readScores })).toEqual({
            toJudge: [],
            skipped: [],
        });
        expect(reads).toBe(0);
    });
});

describe('langfuseOnlineScoreReader', () => {
    it('queries v3 scores by trace-id chunk with details and subject, follows the cursor, reads both subject kinds', async () => {
        const requests: Record<string, unknown>[] = [];
        const pages = [
            {
                data: [
                    { name: HOLISTIC_SCORE_NAME, metadata: { promptVersion: 3 }, subject: { kind: 'trace', id: 'a' } },
                    { name: HOLISTIC_SCORE_NAME, subject: { kind: 'observation', id: 'o1', traceId: 'b' } },
                ],
                meta: { cursor: 'p2' },
            },
            { data: [{ name: HOLISTIC_SCORE_NAME, subject: { kind: 'session', id: 's' } }], meta: {} },
            { data: [], meta: {} },
        ];
        const fake = {
            api: {
                scoresV3: {
                    getManyV3: async (request: Record<string, unknown>) => {
                        requests.push(request);
                        return pages[requests.length - 1];
                    },
                },
            },
        };
        const traceIds = Array.from({ length: 51 }, (_, i) => `t${i}`);
        const scores = await langfuseOnlineScoreReader(fake)(traceIds);

        expect(requests[0]).toMatchObject({
            traceId: traceIds.slice(0, 50).join(','),
            name: HOLISTIC_SCORE_NAME,
            fields: 'details,subject',
            limit: 100,
            cursor: undefined,
        });
        expect(requests[1].cursor).toBe('p2');
        expect(requests[2]).toMatchObject({ traceId: 't50' });
        expect(scores.slice(0, 3).map((s) => s.traceId)).toEqual(['a', 'b', null]);
        expect(scores[0].metadata).toEqual({ promptVersion: 3 });
    });
});

const judgeCoverage = { tracesInWindow: 40, completedTraces: 30, sampled: 6, judged: 4, failedToJudge: 2 };
const coverage = { ...judgeCoverage, scoresWritten: 4, failedToWrite: 0 };

describe('computeRollup', () => {
    it('pass rate per score name, omitted criteria excluded from n', () => {
        const verdicts = [
            verdictsFor('t1', { agent_judge: 1, agent_judge_errorRecovery: 'omitted' }),
            verdictsFor('t2', { agent_judge: 0, agent_judge_errorRecovery: 1, agent_judge_taskCompletion: 0 }),
            verdictsFor('t3', { agent_judge: 1, agent_judge_errorRecovery: 0 }),
        ];
        const r = computeRollup({ date: NOW, verdicts, sampleRate: 0.2, maxItems: 100, coverage });

        expect(r.date).toBe('2026-09-09');
        expect(r.runs).toBe(1);
        expect(r.n.agent_judge).toBe(3);
        expect(r.passes.agent_judge).toBe(2);
        expect(r.passRate.agent_judge).toBeCloseTo(2 / 3);
        expect(r.n.agent_judge_errorRecovery).toBe(2);
        expect(r.passRate.agent_judge_errorRecovery).toBe(0.5);
        expect(r.passRate.agent_judge_taskCompletion).toBeCloseTo(2 / 3);
        expect(r.passRate.agent_judge_toolSelection).toBe(1);
        expect(r.sampleRate).toBe(0.2);
        expect(r.coverage).toEqual(coverage);
        expect(Object.keys(r.n)).toEqual(ONLINE_SCORE_NAMES);
    });

    it('empty verdicts give n 0 and a null pass rate for every name, and keep the coverage', () => {
        const r = computeRollup({ date: NOW, verdicts: [], sampleRate: 0.2, maxItems: 100, coverage });
        for (const name of ONLINE_SCORE_NAMES) {
            expect(r.n[name]).toBe(0);
            expect(r.passRate[name]).toBeNull();
        }
        expect(r.coverage).toEqual(coverage);
    });
});

describe('mergeRollup', () => {
    const fresh = computeRollup({
        date: NOW,
        verdicts: [verdictsFor('t1', { agent_judge: 0 })],
        sampleRate: 0.5,
        maxItems: 10,
        coverage,
    });

    it('returns the fresh rollup when nothing exists or the existing item is not a rollup', () => {
        expect(mergeRollup(null, fresh)).toEqual(fresh);
        expect(mergeRollup(undefined, fresh)).toEqual(fresh);
        expect(mergeRollup({ some: 'other shape' }, fresh)).toEqual(fresh);
        expect(mergeRollup({ ...fresh, passes: { agent_judge: 'x' } }, fresh)).toEqual(fresh);
    });

    it('sums counts and coverage, recomputes rates, keeps the latest run parameters', () => {
        const earlier: Rollup = computeRollup({
            date: NOW,
            verdicts: [verdictsFor('a'), verdictsFor('b')],
            sampleRate: 0.2,
            maxItems: 100,
            coverage,
        });
        const merged = mergeRollup(earlier, fresh);
        expect(merged.runs).toBe(2);
        expect(merged.n.agent_judge).toBe(3);
        expect(merged.passes.agent_judge).toBe(2);
        expect(merged.passRate.agent_judge).toBeCloseTo(2 / 3);
        expect(merged.coverage).toEqual({
            tracesInWindow: 80,
            completedTraces: 60,
            sampled: 12,
            judged: 8,
            failedToJudge: 4,
            scoresWritten: 8,
            failedToWrite: 0,
        });
        expect(merged.sampleRate).toBe(0.5);
        expect(merged.maxItems).toBe(10);
        expect(merged.date).toBe('2026-09-09');
    });
});

describe('rollupItemRequest', () => {
    it('targets the rollups dataset, keyed by date, run parameters as input and the numbers as metadata', () => {
        const rollup = computeRollup({ date: NOW, verdicts: [], sampleRate: 0.2, maxItems: 100, coverage });
        expect(rollupItemRequest(rollup)).toEqual({
            datasetName: ROLLUP_DATASET_NAME,
            id: 'rollup-2026-09-09',
            input: { date: '2026-09-09', sampleRate: 0.2, maxItems: 100 },
            metadata: rollup,
        });
        expect(ROLLUP_DATASET_NAME).toBe('apify-ai-online-rollups');
    });
});

describe('upsertDailyRollup', () => {
    const rollup = computeRollup({
        date: NOW,
        verdicts: [verdictsFor('t1')],
        sampleRate: 0.2,
        maxItems: 100,
        coverage,
    });

    it('always calls datasets.create (idempotent by name), reads the existing item, then upserts', async () => {
        const { api, calls, items } = fakeRollupApi();
        expect(await upsertDailyRollup({ api, rollup })).toEqual({ id: 'rollup-2026-09-09' });
        expect(calls).toEqual([
            `datasets.create ${ROLLUP_DATASET_NAME}`,
            'datasetItems.get rollup-2026-09-09',
            'datasetItems.create rollup-2026-09-09',
        ]);
        expect(items[0].metadata).toEqual(rollup);
    });

    it('the dataset name is permanent (no public API deletes a dataset): pin it', () => {
        expect(ROLLUP_DATASET_NAME).toBe('apify-ai-online-rollups');
    });

    it('isNotFound recognises the real client NotFoundError by its statusCode and nothing else', () => {
        const real = new NotFoundError({ message: 'dataset item not found' });
        expect(real.statusCode).toBe(404);
        expect(isNotFound(real)).toBe(true);
        expect(isNotFound(Object.assign(new Error('x'), { statusCode: 500 }))).toBe(false);
        expect(isNotFound(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
        expect(isNotFound(new Error('not found'))).toBe(false);
        expect(isNotFound(undefined)).toBe(false);
    });

    it('merges into the existing item of the day', async () => {
        const { api, items } = fakeRollupApi({ existingItem: rollup });
        await upsertDailyRollup({ api, rollup });
        expect((items[0].metadata as Rollup).runs).toBe(2);
        expect((items[0].metadata as Rollup).n.agent_judge).toBe(2);
    });

    it('propagates a non-404 error', async () => {
        const { api } = fakeRollupApi({ failCreate: true });
        await expect(upsertDailyRollup({ api, rollup })).rejects.toThrow('langfuse down');
    });
});

describe('finishOnlineRun', () => {
    const checkpoint: Checkpoint = {
        upperBound: '2026-09-09T09:42:00.000Z',
        runId: 'r1',
        writtenAt: NOW.toISOString(),
    };
    const base = { date: NOW, sampleRate: 0.2, maxItems: 100, coverage: judgeCoverage, checkpoint };

    it('writes scores, then the rollup, then the checkpoint', async () => {
        const order: string[] = [];
        const scores = {
            create: async (r: CreateScoreRequest) => {
                order.push(`score ${r.id}`);
                return {};
            },
        };
        const rollupApi = fakeRollupApi();
        const { store, writes } = memoryCheckpoints();
        store.write = async (c) => {
            order.push('checkpoint');
            writes.push(c);
        };

        const result = await finishOnlineRun({
            ...base,
            verdicts: [verdictsFor('t1')],
            scores,
            rollupApi: rollupApi.api,
            checkpoints: store,
        });

        expect(result).toMatchObject({
            scoresWritten: 1,
            failedToWrite: 0,
            rollupItemId: 'rollup-2026-09-09',
            error: null,
            checkpointWritten: true,
        });
        expect(rollupApi.items[0].metadata).toMatchObject({
            coverage: { ...judgeCoverage, scoresWritten: 1, failedToWrite: 0 },
        });
        expect(writes).toEqual([checkpoint]);
        expect(order[order.length - 1]).toBe('checkpoint');
        expect(order.filter((o) => o.startsWith('score')).length).toBe(ONLINE_SCORE_NAMES.length * 2);
        expect(rollupApi.calls[rollupApi.calls.length - 1]).toBe('datasetItems.create rollup-2026-09-09');
    });

    it('does not write the checkpoint when the rollup fails, and reports the error', async () => {
        const { api } = fakeScoresApi();
        const rollupApi = fakeRollupApi({ failCreate: true });
        const { store, writes } = memoryCheckpoints();

        const result = await finishOnlineRun({
            ...base,
            verdicts: [verdictsFor('t1')],
            scores: api,
            rollupApi: rollupApi.api,
            checkpoints: store,
        });

        expect(result.scoresWritten).toBe(1);
        expect(result.rollupItemId).toBeNull();
        expect(String(result.error)).toContain('langfuse down');
        expect(result.checkpointWritten).toBe(false);
        expect(writes).toEqual([]);
    });

    it('a single trace write failure is counted and does not hold the checkpoint back', async () => {
        const { api } = fakeScoresApi((r) => r.id?.startsWith('bad-') ?? false);
        const rollupApi = fakeRollupApi();
        const { store, writes } = memoryCheckpoints();

        const result = await finishOnlineRun({
            ...base,
            verdicts: [verdictsFor('bad'), verdictsFor('good')],
            scores: api,
            rollupApi: rollupApi.api,
            checkpoints: store,
        });

        expect(result).toMatchObject({ scoresWritten: 1, failedToWrite: 1, checkpointWritten: true, error: null });
        expect(writes).toEqual([checkpoint]);
        // Only the written trace is rolled up; the coverage shows the discrepancy.
        const rollup = rollupApi.items[0].metadata as Rollup;
        expect(rollup.n[HOLISTIC_SCORE_NAME]).toBe(1);
        expect(rollup.coverage).toMatchObject({ judged: 4, scoresWritten: 1, failedToWrite: 1 });
    });

    it('a batch whose writes all fail is a failure: no rollup, no checkpoint, an error for Actor.fail', async () => {
        const { api } = fakeScoresApi(() => true);
        const rollupApi = fakeRollupApi();
        const { store, writes } = memoryCheckpoints();

        const result = await finishOnlineRun({
            ...base,
            verdicts: [verdictsFor('a'), verdictsFor('b')],
            scores: api,
            rollupApi: rollupApi.api,
            checkpoints: store,
        });

        expect(result).toMatchObject({
            scoresWritten: 0,
            failedToWrite: 2,
            rollupItemId: null,
            checkpointWritten: false,
        });
        expect(result.error).toBeInstanceOf(AllScoreWritesFailedError);
        expect(rollupApi.calls).toEqual([]);
        expect(writes).toEqual([]);
    });

    it('a batch where every trace failed to judge is a failure: no rollup, no checkpoint, typed error', async () => {
        const { api, requests } = fakeScoresApi();
        const rollupApi = fakeRollupApi();
        const { store, writes } = memoryCheckpoints();

        const result = await finishOnlineRun({
            ...base,
            coverage: { tracesInWindow: 20, completedTraces: 10, sampled: 5, judged: 0, failedToJudge: 3 },
            verdicts: [],
            scores: api,
            rollupApi: rollupApi.api,
            checkpoints: store,
        });

        expect(result).toMatchObject({ scoresWritten: 0, rollupItemId: null, checkpointWritten: false });
        expect(result.error).toBeInstanceOf(AllJudgementsFailedError);
        expect(String(result.error)).toContain('3 traces');
        expect(requests).toEqual([]);
        expect(rollupApi.calls).toEqual([]);
        expect(writes).toEqual([]);
    });

    it('everything pre-filtered (judged 0, failedToJudge 0) is not a judge failure', async () => {
        const { api } = fakeScoresApi();
        const rollupApi = fakeRollupApi();
        const { store, writes } = memoryCheckpoints();

        const result = await finishOnlineRun({
            ...base,
            coverage: { tracesInWindow: 20, completedTraces: 10, sampled: 5, judged: 0, failedToJudge: 0 },
            verdicts: [],
            scores: api,
            rollupApi: rollupApi.api,
            checkpoints: store,
        });

        expect(result).toMatchObject({ error: null, checkpointWritten: true, rollupItemId: 'rollup-2026-09-09' });
        expect(writes).toEqual([checkpoint]);
    });

    it('skips the rollup when nothing was sampled or judged, but still moves the checkpoint', async () => {
        const { api } = fakeScoresApi();
        const rollupApi = fakeRollupApi();
        const { store, writes } = memoryCheckpoints();

        const result = await finishOnlineRun({
            ...base,
            coverage: { tracesInWindow: 3, completedTraces: 0, sampled: 0, judged: 0, failedToJudge: 0 },
            verdicts: [],
            scores: api,
            rollupApi: rollupApi.api,
            checkpoints: store,
        });

        expect(result).toMatchObject({ rollupItemId: null, error: null, checkpointWritten: true });
        expect(rollupApi.calls).toEqual([]);
        expect(writes).toEqual([checkpoint]);
    });

    it('writes no checkpoint when selection returned none (override or empty window)', async () => {
        const { api } = fakeScoresApi();
        const rollupApi = fakeRollupApi();
        const { store, writes } = memoryCheckpoints();

        const result = await finishOnlineRun({
            ...base,
            checkpoint: null,
            coverage: { ...judgeCoverage, judged: 0, failedToJudge: 0 },
            verdicts: [],
            scores: api,
            rollupApi: rollupApi.api,
            checkpoints: store,
        });

        expect(result.checkpointWritten).toBe(false);
        expect(writes).toEqual([]);
        // Everything was skipped by the pre-filter (sampled > 0, judged 0): the rollup still records the coverage.
        expect(result.rollupItemId).toBe('rollup-2026-09-09');
    });
});
