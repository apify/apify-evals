import { describe, expect, it } from 'vitest';

import { InvalidJevReplyError, jevDecide, parseJevReply } from '../src/jev.js';
import { MAX_ATTEMPTS } from '../src/llm.js';

const QUESTION = {
    type: 'noul' as const,
    instructions: 'Can this turn be evaluated?',
    criteria: { true: 'yes', false: 'no' },
};
const request = { apifyToken: 'tok', model: 'typesafe/jev-1.13', state: { prompt: 'hi' }, questions: { q: QUESTION } };
const reply = {
    id: 'gen-1',
    model: 'typesafe/jev-1.13-20261001',
    provider: 'TypeSafe',
    answers: { q: { type: 'noul', noul: 0.95 } },
    usage: { input_tokens: 40, output_tokens: 1 },
};

/** A fetch fake that answers from a list, one response per call, recording each call. */
function fakeFetch(responses: (() => Response)[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return responses[Math.min(calls.length - 1, responses.length - 1)]();
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

describe('parseJevReply', () => {
    it('reads P(yes) and the served model', () => {
        expect(parseJevReply(reply, ['q'])).toEqual({ noul: { q: 0.95 }, model: 'typesafe/jev-1.13-20261001' });
    });

    it('throws on a missing, mistyped or out-of-range answer', () => {
        expect(() => parseJevReply(null, ['q'])).toThrow(InvalidJevReplyError);
        expect(() => parseJevReply({}, ['q'])).toThrow('answers is missing');
        expect(() => parseJevReply({ answers: {} }, ['q'])).toThrow('not a noul answer');
        expect(() => parseJevReply({ answers: { q: { type: 'choice', noul: 0.5 } } }, ['q'])).toThrow(
            'not a noul answer',
        );
        expect(() => parseJevReply({ answers: { q: { type: 'noul', noul: 1.5 } } }, ['q'])).toThrow(
            'not a probability',
        );
        expect(() => parseJevReply({ answers: { q: { type: 'noul', noul: '0.5' } } }, ['q'])).toThrow(
            'not a probability',
        );
    });
});

describe('jevDecide', () => {
    it('posts {model, state, questions} to /systemone with the Apify token, nothing else', async () => {
        const { impl, calls } = fakeFetch([ok(reply)]);
        const result = await jevDecide(request, impl, 0);
        expect(result.noul.q).toBe(0.95);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://openrouter.apify.actor/api/v1/systemone');
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
        expect(JSON.parse(calls[0].init.body as string)).toEqual({
            model: 'typesafe/jev-1.13',
            state: { prompt: 'hi' },
            questions: { q: QUESTION },
        });
    });

    it('retries an HTTP error, a network error and a bad body, then succeeds', async () => {
        const { impl, calls } = fakeFetch([
            () => new Response('<html>502</html>', { status: 502 }),
            () => new Response('<html>', { status: 200 }),
            ok(reply),
        ]);
        expect((await jevDecide(request, impl, 0)).noul.q).toBe(0.95);
        expect(calls).toHaveLength(3);
        let n = 0;
        const flaky = (async () => {
            n++;
            if (n === 1) throw new TypeError('fetch failed');
            return ok(reply)();
        }) as unknown as typeof fetch;
        expect((await jevDecide(request, flaky, 0)).noul.q).toBe(0.95);
        expect(n).toBe(2);
    });

    it('aborts an attempt at the timeout and retries it, then throws the timeout', async () => {
        const calls: AbortSignal[] = [];
        const hanging = (async (_url: string, init: RequestInit) => {
            const signal = init.signal as AbortSignal;
            calls.push(signal);
            return new Promise<Response>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason));
            });
        }) as unknown as typeof fetch;
        await expect(jevDecide(request, hanging, 0, 20)).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(calls).toHaveLength(MAX_ATTEMPTS);
        expect(calls.every((signal) => signal.aborted)).toBe(true);
    });

    it('throws the last error after MAX_ATTEMPTS', async () => {
        const { impl, calls } = fakeFetch([() => new Response('down', { status: 503 })]);
        await expect(jevDecide(request, impl, 0)).rejects.toThrow('Jev HTTP 503');
        expect(calls).toHaveLength(MAX_ATTEMPTS);
        const badAnswer = fakeFetch([ok({ answers: {} })]);
        await expect(jevDecide(request, badAnswer.impl, 0)).rejects.toThrow(InvalidJevReplyError);
        expect(badAnswer.calls).toHaveLength(MAX_ATTEMPTS);
    });
});
