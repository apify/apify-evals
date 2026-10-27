import { describe, expect, it } from 'vitest';

import type { JevCaller, JevRequest } from '../src/jev.js';
import {
    type Classification,
    classifierState,
    classifyBatch,
    type ClassifyBatchOptions,
    classifyTurn,
    EVALUABLE_QUESTION,
    EVALUABLE_QUESTION_NAME,
    type Ineligible,
    MAX_STATE_BYTES,
    ruleVerdict,
    type TraceClassification,
    traceClassifier,
    withCircuitBreaker,
} from '../src/online-classify.js';
import type { OnlineTurn } from '../src/online-turn.js';
import { RULE_CASES } from './fixtures/classifier-prompts.js';

const config = { apifyToken: 'tok', model: 'typesafe/jev-1.13', threshold: 0.3 };

/** A Jev fake answering P(yes) = `p`, recording every request. */
function fakeJev(p: number | (() => number), model = 'typesafe/jev-1.13-20261001') {
    const requests: JevRequest[] = [];
    const callJev: JevCaller = async (request) => {
        requests.push(request);
        return {
            noul: { [EVALUABLE_QUESTION_NAME]: typeof p === 'number' ? p : p() },
            model,
            usage: null,
            costUsd: 0.000002,
        };
    };
    return { callJev, requests };
}

describe('ruleVerdict (fixture)', () => {
    it('has about 20 prompts', () => {
        expect(RULE_CASES.length).toBeGreaterThanOrEqual(20);
    });

    for (const c of RULE_CASES) {
        it(`${c.name}: ${c.rule ?? 'passes to Jev'}`, () => {
            expect(ruleVerdict(c)).toBe(c.rule);
        });
    }
});

describe('classifierState', () => {
    it('is the prompt and the earlier messages, never the agent answer to this turn', () => {
        const turn = {
            prompt: 'Now export it as CSV',
            priorMessages: [{ role: 'assistant' as const, text: 'Done.' }],
            finalText: 'SECRET_FINAL_ANSWER',
        };
        const state = classifierState(turn);
        expect(state).toEqual({
            prompt: 'Now export it as CSV',
            priorMessages: [{ role: 'assistant', text: 'Done.' }],
        });
        expect(JSON.stringify(state)).not.toContain('SECRET_FINAL_ANSWER');
    });

    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

    for (const [script, char] of [
        ['Latin', 'm'],
        ['CJK (3 bytes per char)', '数'],
        ['emoji (4 bytes per char)', '😀'],
    ] as const) {
        it(`caps the JSON state in UTF-8 bytes, ${script}: texts cut in the middle, oldest messages dropped`, () => {
            const state = classifierState({
                prompt: char.repeat(30_000),
                priorMessages: Array.from({ length: 10 }, (_, i) => ({
                    role: 'user' as const,
                    text: `${i}${char.repeat(5_000)}`,
                })),
            });
            expect(bytes(state)).toBeLessThanOrEqual(MAX_STATE_BYTES);
            expect(state.prompt).toContain('chars omitted');
            expect(state.priorMessages.length).toBeGreaterThan(0);
            // The newest message is kept.
            expect(state.priorMessages.at(-1)?.text.startsWith('9')).toBe(true);
            // No broken surrogate pair from a cut inside a 4-byte character.
            expect(JSON.stringify(state)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/);
        });
    }
});

describe('classifyTurn', () => {
    it('a rule rejects without calling Jev', async () => {
        const { callJev, requests } = fakeJev(0.99);
        const c = await classifyTurn({ prompt: '2', priorMessages: [] }, { ...config, callJev });
        expect(c).toEqual({ verdict: 'ineligible', stage: 'rule', rule: 'digits-only' });
        expect(requests).toEqual([]);
    });

    it('asks one hard-coded noul question with the model and the state', async () => {
        const { callJev, requests } = fakeJev(0.9);
        await classifyTurn({ prompt: 'hello', priorMessages: [] }, { ...config, callJev });
        expect(requests).toEqual([
            {
                apifyToken: 'tok',
                model: 'typesafe/jev-1.13',
                state: { prompt: 'hello', priorMessages: [] },
                questions: { [EVALUABLE_QUESTION_NAME]: EVALUABLE_QUESTION },
            },
        ]);
        expect(EVALUABLE_QUESTION.type).toBe('noul');
        expect(Object.keys(EVALUABLE_QUESTION.criteria)).toEqual(['true', 'false']);
    });

    it('skips only below the threshold', async () => {
        const turn = { prompt: 'hello', priorMessages: [] };
        expect(await classifyTurn(turn, { ...config, callJev: fakeJev(0.29).callJev })).toEqual({
            verdict: 'ineligible',
            stage: 'model',
            probability: 0.29,
            servedModel: 'typesafe/jev-1.13-20261001',
            costUsd: 0.000002,
        });
        expect(await classifyTurn(turn, { ...config, callJev: fakeJev(0.3).callJev })).toMatchObject({
            verdict: 'eligible',
            probability: 0.3,
        });
    });

    it('fails open: a Jev error is a failed classification, never a throw', async () => {
        const callJev: JevCaller = async () => {
            throw new Error('Jev HTTP 503');
        };
        const c = await classifyTurn({ prompt: 'hello', priorMessages: [] }, { ...config, callJev });
        expect(c).toEqual({ verdict: 'failed', error: 'Error: Jev HTTP 503' });
    });
});

describe('withCircuitBreaker', () => {
    it('stops calling after the limit of failures in a row; a success resets the count', async () => {
        let calls = 0;
        let fail = true;
        const inner: JevCaller = async () => {
            calls++;
            if (fail) throw new Error('down');
            return { noul: {}, model: null, usage: null, costUsd: null };
        };
        const guarded = withCircuitBreaker(inner, 2);
        const request = { apifyToken: 't', model: 'm', state: {}, questions: {} };
        await expect(guarded(request)).rejects.toThrow('down');
        fail = false;
        await guarded(request);
        fail = true;
        await expect(guarded(request)).rejects.toThrow('down');
        await expect(guarded(request)).rejects.toThrow('down');
        await expect(guarded(request)).rejects.toThrow('Jev skipped');
        expect(calls).toBe(4);
    });
});

describe('traceClassifier', () => {
    const observations = [
        {
            id: 'g1',
            type: 'GENERATION',
            name: 'chat',
            startTime: '2026-09-08T10:00:00.000Z',
            input: JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }]),
            output: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'SECRET_ANSWER' }] }]),
        },
    ];

    it('rebuilds the turn, classifies it and keeps the turn for the judge', async () => {
        const { callJev, requests } = fakeJev(0.8);
        const langfuse = { api: { observations: { getMany: async () => ({ data: observations, meta: {} }) } } };
        const result = await traceClassifier({ langfuse, ...config, callJev })('tr1');
        expect(result.classification.verdict).toBe('eligible');
        expect(result.turn?.prompt).toBe('hello');
        expect(JSON.stringify(requests)).not.toContain('SECRET_ANSWER');
    });

    it('fails open when the trace cannot be read', async () => {
        const langfuse = {
            api: {
                observations: {
                    getMany: async () => {
                        throw new Error('langfuse 500');
                    },
                },
            },
        };
        const result = await traceClassifier({ langfuse, ...config, callJev: fakeJev(0.8).callJev })('tr1');
        expect(result.classification.verdict).toBe('failed');
        expect(result.turn).toBeUndefined();
    });
});

describe('classifyBatch', () => {
    const turnFor = (traceId: string) => ({ traceId, prompt: traceId }) as OnlineTurn;
    const ELIGIBLE: Classification = { verdict: 'eligible', probability: 0.9, servedModel: 'jev', costUsd: null };
    const RULE_SKIP: Classification = { verdict: 'ineligible', stage: 'rule', rule: 'digits-only' };
    const MODEL_SKIP: Classification = {
        verdict: 'ineligible',
        stage: 'model',
        probability: 0.1,
        servedModel: 'jev',
        costUsd: 0.000004,
    };
    const FAILED: Classification = { verdict: 'failed', error: 'Jev HTTP 503' };
    const BY_PREFIX: Record<string, Classification> = { 'bad-r': RULE_SKIP, 'bad-m': MODEL_SKIP, fail: FAILED };

    /** Classifies by id prefix: `bad-r*` rule skip, `bad-m*` model skip, `fail*` failed, else eligible. */
    function setup(overrides: Partial<ClassifyBatchOptions> = {}) {
        const classified: string[] = [];
        const recorded: { traceId: string; classification: Ineligible }[] = [];
        const filtered: string[][] = [];
        const opts: ClassifyBatchOptions = {
            mode: 'enforce',
            initial: [],
            reserve: [],
            maxAttempts: 100,
            concurrency: 2,
            classify: async (traceId): Promise<TraceClassification> => {
                classified.push(traceId);
                const prefix = Object.keys(BY_PREFIX).find((p) => traceId.startsWith(p));
                return { classification: prefix ? BY_PREFIX[prefix] : ELIGIBLE, turn: turnFor(traceId) };
            },
            filterProcessed: async (traceIds) => {
                filtered.push(traceIds);
                return traceIds.filter((id) => !id.startsWith('done'));
            },
            onIneligible: async (traceId, classification) => {
                recorded.push({ traceId, classification });
            },
            ...overrides,
        };
        return { opts, classified, recorded, filtered };
    }

    it('enforce: drops the skipped traces and tops up from the reserve until the target is reached', async () => {
        const { opts, classified, recorded, filtered } = setup({
            initial: ['a', 'bad-r1', 'bad-m1'],
            reserve: ['done1', 'b', 'bad-r2', 'c', 'unused'],
        });
        const r = await classifyBatch(opts);
        expect(r.target).toBe(3);
        expect(r.targetReached).toBe(true);
        expect(r.toJudge).toEqual(['a', 'b', 'c']);
        // The reserve is filtered by skipAlreadyJudged before it is classified.
        expect(filtered[0]).toEqual(['done1', 'b']);
        expect(classified).not.toContain('done1');
        expect(classified).not.toContain('unused');
        expect(recorded.map((x) => x.traceId).sort()).toEqual(['bad-m1', 'bad-r1', 'bad-r2']);
        expect(r.counters).toEqual({
            attempts: 6,
            skippedIneligible: { rule: 2, model: 1 },
            classifierFailed: 0,
            toppedUp: 3,
            skipScoreWriteFailed: 0,
            budgetExceeded: 0,
            costUsd: 0.000004,
        });
        expect([...r.turns.keys()]).toEqual(['a', 'b', 'c']);
        expect(r.ineligible.sort()).toEqual(['bad-m1', 'bad-r1', 'bad-r2']);
        expect(r.toppedUp).toEqual(['b', 'bad-r2', 'c']);
    });

    it('enforce: the top-up stops at maxAttempts and reports the missed target', async () => {
        const { opts, classified } = setup({
            initial: ['bad-r1', 'bad-r2'],
            reserve: ['bad-r3', 'bad-r4', 'bad-r5', 'bad-r6', 'ok'],
            maxAttempts: 6,
        });
        const r = await classifyBatch(opts);
        expect(r.counters.attempts).toBe(6);
        expect(classified).toHaveLength(6);
        expect(classified).not.toContain('ok');
        expect(r.toJudge).toEqual([]);
        expect(r.targetReached).toBe(false);
    });

    it('enforce: the top-up stops when the reserve runs out', async () => {
        const { opts } = setup({ initial: ['bad-r1', 'a'], reserve: ['done1'] });
        const r = await classifyBatch(opts);
        expect(r.toJudge).toEqual(['a']);
        expect(r.targetReached).toBe(false);
        expect(r.counters.toppedUp).toBe(0);
    });

    it('fails open: a failed classification is judged, counted and not replaced', async () => {
        const { opts, recorded } = setup({ initial: ['fail1', 'a'], reserve: ['b'] });
        const r = await classifyBatch(opts);
        expect(r.toJudge).toEqual(['fail1', 'a']);
        expect(r.counters.classifierFailed).toBe(1);
        expect(r.counters.toppedUp).toBe(0);
        expect(r.targetReached).toBe(true);
        expect(recorded).toEqual([]);
    });

    it('shadow: judges every sampled trace, writes the skips, never tops up', async () => {
        const { opts, classified, recorded, filtered } = setup({
            mode: 'shadow',
            initial: ['a', 'bad-r1', 'bad-m1'],
            reserve: ['b', 'c'],
        });
        const r = await classifyBatch(opts);
        expect(r.toJudge).toEqual(['a', 'bad-r1', 'bad-m1']);
        expect(classified.sort()).toEqual(['a', 'bad-m1', 'bad-r1']);
        expect(filtered).toEqual([]);
        expect(recorded.map((x) => x.traceId).sort()).toEqual(['bad-m1', 'bad-r1']);
        expect(r.counters.toppedUp).toBe(0);
        expect(r.targetReached).toBe(true);
        expect(r.turns.size).toBe(3);
    });

    it('a failed skip-score write is counted and the trace is still not judged in enforce mode', async () => {
        const { opts } = setup({
            initial: ['bad-r1', 'a'],
            onIneligible: async () => {
                throw new Error('langfuse down');
            },
        });
        const r = await classifyBatch(opts);
        expect(r.toJudge).toEqual(['a']);
        expect(r.counters.skipScoreWriteFailed).toBe(1);
    });

    it('enforce: a failed score read during the top-up stops the top-up, not the run', async () => {
        const { opts } = setup({
            initial: ['a', 'bad-r1'],
            reserve: ['b', 'c'],
            filterProcessed: async () => {
                throw new Error('langfuse 500');
            },
        });
        const r = await classifyBatch(opts);
        expect(r.toJudge).toEqual(['a']);
        expect(r.targetReached).toBe(false);
        expect(r.counters.toppedUp).toBe(0);
    });

    it('fails open after the time budget: the rest goes to the judge unclassified and the top-up stops', async () => {
        let clock = 0;
        const { opts, classified } = setup({
            initial: ['a', 'bad-r1', 'b', 'c'],
            reserve: ['d'],
            concurrency: 1,
            budgetMs: 100,
            now: () => clock,
        });
        const { classify } = opts;
        opts.classify = async (traceId) => {
            clock += 60;
            return classify(traceId);
        };
        const r = await classifyBatch(opts);
        // a (t=0) and bad-r1 (t=60) are classified; b and c start after the deadline.
        expect(classified).toEqual(['a', 'bad-r1']);
        expect(r.toJudge).toEqual(['a', 'b', 'c']);
        expect(r.counters.budgetExceeded).toBe(2);
        expect(r.counters.classifierFailed).toBe(2);
        expect(r.counters.toppedUp).toBe(0);
        expect(r.targetReached).toBe(false);
    });
});
