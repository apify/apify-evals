import { describe, expect, it } from 'vitest';

import { JUDGE_IMPL_VERSION } from '../src/core.js';
import { type Classification, ELIGIBLE_SCORE_NAME, type TraceClassification } from '../src/online-classify.js';
import { assertClassifierModel, prepareOnlineBatch, type PrepareOnlineBatchOptions } from '../src/online-run.js';
import {
    type CreateScoreRequest,
    eligibleScoreId,
    type ExistingOnlineScore,
    NO_CLASSIFIER_COUNTERS,
    type OnlineScoreVersion,
    skipAlreadyJudged,
} from '../src/online-scores.js';
import type { OnlineTurn } from '../src/online-turn.js';
import { HOLISTIC_SCORE_NAME } from '../src/rubric.js';

const version: OnlineScoreVersion = { promptVersion: 3, judgeImplVersion: JUDGE_IMPL_VERSION, judgeModel: 'm' };
const eligibility = { judgeImplVersion: JUDGE_IMPL_VERSION, classifierModel: 'typesafe/jev-1.13' };

const holistic = (traceId: string): ExistingOnlineScore => ({
    name: HOLISTIC_SCORE_NAME,
    traceId,
    metadata: { ...version },
});
const skipScore = (traceId: string): ExistingOnlineScore => ({
    id: eligibleScoreId(traceId, eligibility),
    name: ELIGIBLE_SCORE_NAME,
    traceId,
    value: false,
});

/** `bad*` is rejected by a rule, everything else is eligible. */
function setup(overrides: Partial<PrepareOnlineBatchOptions> = {}, existing: ExistingOnlineScore[] = []) {
    const classified: string[] = [];
    const reads: string[][] = [];
    const writes: CreateScoreRequest[] = [];
    const opts: PrepareOnlineBatchOptions = {
        classifier: 'enforce',
        selection: { sampled: 3, sampledTraceIds: ['a', 'bad1', 'old'], unsampledTraceIds: ['b', 'bad2', 'c', 'd'] },
        maxClassifyFactor: 3,
        concurrency: 2,
        force: false,
        version,
        eligibility,
        threshold: 0.3,
        environment: 'prod',
        readScores: async (traceIds) => {
            reads.push(traceIds);
            return existing.filter((s) => s.traceId && traceIds.includes(s.traceId));
        },
        classify: async (traceId): Promise<TraceClassification> => {
            classified.push(traceId);
            const classification: Classification = traceId.startsWith('bad')
                ? { verdict: 'ineligible', stage: 'rule', rule: 'digits-only' }
                : { verdict: 'eligible', probability: 0.9, servedModel: 'jev', costUsd: 0.000001 };
            return { classification, turn: { traceId, prompt: traceId } as OnlineTurn };
        },
        writeScore: async (request) => {
            writes.push(request);
        },
        ...overrides,
    };
    return { opts, classified, reads, writes };
}

describe('prepareOnlineBatch', () => {
    it('off: the old flow, skipAlreadyJudged only, no classification and no skip-score reads', async () => {
        const existing = [holistic('old'), skipScore('a')];
        const { opts, classified, writes } = setup({ classifier: 'off' }, existing);
        const r = await prepareOnlineBatch(opts);
        const before = await skipAlreadyJudged({
            traceIds: opts.selection.sampledTraceIds,
            version,
            force: false,
            readScores: opts.readScores,
        });
        expect(r.toJudge).toEqual(before.toJudge);
        expect(r.toJudge).toEqual(['a', 'bad1']);
        expect(r.skipped).toEqual(['old']);
        expect(classified).toEqual([]);
        expect(writes).toEqual([]);
        expect(r.turns.size).toBe(0);
        expect(r.coverage).toEqual(NO_CLASSIFIER_COUNTERS);
        expect(r.output).toMatchObject({ classifier: 'off', targetReached: true, classifierAttempts: 0 });
    });

    it('only enforce treats an existing skip score as processed', async () => {
        const existing = [skipScore('a')];
        const enforce = await prepareOnlineBatch(setup({}, existing).opts);
        expect(enforce.skipped).toEqual(['a']);
        const shadow = await prepareOnlineBatch(setup({ classifier: 'shadow' }, existing).opts);
        expect(shadow.skipped).toEqual([]);
        expect(shadow.toJudge).toContain('a');
    });

    it('enforce: tops up, writes skip scores, hands the judge the rebuilt turns, and OUTPUT adds up', async () => {
        const { opts, writes } = setup();
        const r = await prepareOnlineBatch(opts);
        expect(r.toJudge).toEqual(['a', 'old', 'b']);
        expect([...r.turns.keys()]).toEqual(r.toJudge);
        expect(writes.map((w) => w.id)).toEqual([eligibleScoreId('bad1', eligibility)]);
        expect(writes[0]).toMatchObject({ value: 0, environment: 'prod', metadata: { mode: 'enforce' } });
        expect(r.output).toMatchObject({
            classifierTarget: 3,
            targetReached: true,
            classifierAttempts: 4,
            toppedUp: 1,
            ineligibleTraceIds: ['bad1'],
            toppedUpTraceIds: ['b'],
            classifierCostUsd: 0.000003,
        });
        // Every classified trace is judged, skipped or failed open.
        const { output } = r;
        expect(output.classifierAttempts).toBe(
            r.toJudge.length + output.skippedIneligible.rule + output.skippedIneligible.model,
        );
        expect(r.coverage).toEqual({
            skippedIneligibleRule: 1,
            skippedIneligibleModel: 0,
            classifierFailed: 0,
            targetMissed: 0,
        });
    });

    it('enforce: classifies at most ceil(maxClassifyFactor * sampled) traces', async () => {
        const allBad = {
            sampled: 3,
            sampledTraceIds: ['bad1', 'bad2', 'bad3'],
            unsampledTraceIds: Array.from({ length: 20 }, (_, i) => `bad-r${i}`),
        };
        const { opts, classified } = setup({ selection: allBad, maxClassifyFactor: 1.5 });
        const r = await prepareOnlineBatch(opts);
        expect(classified).toHaveLength(Math.ceil(1.5 * 3));
        expect(r.output.targetReached).toBe(false);
        expect(r.coverage.targetMissed).toBe(1);
    });

    it('shadow: judges the whole sample with the skips recorded, no top-up', async () => {
        const { opts, writes, classified } = setup({ classifier: 'shadow' });
        const r = await prepareOnlineBatch(opts);
        expect(r.toJudge).toEqual(['a', 'bad1', 'old']);
        expect(classified.sort()).toEqual(['a', 'bad1', 'old']);
        expect(writes).toHaveLength(1);
        expect(writes[0].metadata).toMatchObject({ mode: 'shadow' });
        expect(r.output).toMatchObject({ toppedUp: 0, toppedUpTraceIds: [], targetReached: true });
    });
});

describe('assertClassifierModel', () => {
    it('accepts the default and rejects a model that makes the skip score id invalid', () => {
        expect(() => assertClassifierModel(eligibility)).not.toThrow();
        expect(() => assertClassifierModel({ ...eligibility, classifierModel: `x/${'y'.repeat(300)}` })).toThrow(
            'cannot be used',
        );
    });
});
