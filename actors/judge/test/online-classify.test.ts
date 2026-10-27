import { describe, expect, it } from 'vitest';

import type { JevCaller, JevRequest } from '../src/jev.js';
import {
    classifierState,
    classifyTurn,
    EVALUABLE_QUESTION,
    EVALUABLE_QUESTION_NAME,
    MAX_STATE_BYTES,
    ruleVerdict,
    traceClassifier,
    withCircuitBreaker,
} from '../src/online-classify.js';
import { RULE_CASES } from './fixtures/classifier-prompts.js';

const config = { apifyToken: 'tok', model: 'typesafe/jev-1.13', threshold: 0.3 };

/** A Jev fake answering P(yes) = `p`, recording every request. */
function fakeJev(p: number, model = 'typesafe/jev-1.13-20261001') {
    const requests: JevRequest[] = [];
    const callJev: JevCaller = async (request) => {
        requests.push(request);
        return { noul: { [EVALUABLE_QUESTION_NAME]: p }, model };
    };
    return { callJev, requests };
}

describe('ruleVerdict (fixture)', () => {
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
    const messages = (char: string) =>
        Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, text: `${i}${char.repeat(4_000)}` }));

    for (const [script, char] of [
        ['Latin', 'm'],
        ['CJK (3 bytes per char)', '数'],
        ['emoji (4 bytes per char)', '😀'],
    ] as const) {
        it(`caps the JSON state in UTF-8 bytes, ${script}`, () => {
            // Too many earlier messages: the oldest are dropped, the newest kept.
            const dropped = classifierState({ prompt: 'hello', priorMessages: messages(char) });
            expect(bytes(dropped)).toBeLessThanOrEqual(MAX_STATE_BYTES);
            expect(dropped.priorMessages.length).toBeLessThan(10);
            expect(dropped.priorMessages.at(-1)?.text.startsWith('9')).toBe(true);
            // A prompt too long alone: it is cut at the end and no earlier message is left.
            const cut = classifierState({ prompt: char.repeat(40_000), priorMessages: messages(char) });
            expect(bytes(cut)).toBeLessThanOrEqual(MAX_STATE_BYTES);
            expect(bytes(cut)).toBeGreaterThan(MAX_STATE_BYTES - 10);
            expect(cut.priorMessages).toEqual([]);
            // No broken surrogate pair from a cut inside a 4-byte character.
            expect(JSON.stringify(cut)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/);
        });

        it(`cuts the newest earlier message instead of dropping it, ${script}`, () => {
            const state = classifierState({
                prompt: '2',
                priorMessages: [
                    { role: 'user', text: 'Find me a scraper' },
                    { role: 'assistant', text: `Pick one: 1, 2 or 3. ${char.repeat(40_000)}` },
                ],
            });
            expect(bytes(state)).toBeLessThanOrEqual(MAX_STATE_BYTES);
            expect(bytes(state)).toBeGreaterThan(MAX_STATE_BYTES - 100);
            expect(state.priorMessages).toHaveLength(1);
            expect(state.priorMessages[0].text.startsWith('Pick one: 1, 2 or 3.')).toBe(true);
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
    });

    it('skips only below the threshold', async () => {
        const turn = { prompt: 'hello', priorMessages: [] };
        expect(await classifyTurn(turn, { ...config, callJev: fakeJev(0.29).callJev })).toEqual({
            verdict: 'ineligible',
            stage: 'model',
            probability: 0.29,
            servedModel: 'typesafe/jev-1.13-20261001',
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
            return { noul: {}, model: null };
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

    it('rebuilds the turn and classifies it without the agent answer', async () => {
        const { callJev, requests } = fakeJev(0.8);
        const langfuse = { api: { observations: { getMany: async () => ({ data: observations, meta: {} }) } } };
        const c = await traceClassifier({ langfuse, ...config, callJev })('tr1');
        expect(c.verdict).toBe('eligible');
        expect(requests[0].state).toEqual({ prompt: 'hello', priorMessages: [] });
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
        const c = await traceClassifier({ langfuse, ...config, callJev: fakeJev(0.8).callJev })('tr1');
        expect(c.verdict).toBe('failed');
    });
});
