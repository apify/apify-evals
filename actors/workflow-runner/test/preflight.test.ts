import { describe, expect, it, vi } from 'vitest';

import { pingModel, preflightModels } from '../src/preflight.js';

const reply = (status: number, body: unknown) =>
    ({
        ok: status < 400,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }) as unknown as Response;

const base = { url: 'https://proxy.test/v1/chat/completions', apifyToken: 'tok', codex: false };

describe('pingModel', () => {
    it('reports the model named in a successful reply', async () => {
        const fetchImpl = vi.fn(async () => reply(200, { model: 'anthropic/claude-haiku-5.5' }));
        const r = await pingModel({ ...base, model: '~anthropic/claude-haiku-latest' }, fetchImpl);
        expect(r).toMatchObject({ ok: true, status: 200, resolvedModel: 'anthropic/claude-haiku-5.5' });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(base.url);
        expect(JSON.parse(init.body as string)).toEqual({
            model: '~anthropic/claude-haiku-latest',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
        });
    });

    it('uses the Responses API shape for Codex', async () => {
        const fetchImpl = vi.fn(async () => reply(200, { model: 'gpt-6-luna' }));
        await pingModel({ ...base, codex: true, model: '~openai/gpt-luna-latest' }, fetchImpl);
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toEqual({
            model: '~openai/gpt-luna-latest',
            input: 'ping',
            max_output_tokens: 16,
        });
    });

    it('a non-JSON 200 is reachable with an unknown resolved model', async () => {
        const fetchImpl = vi.fn(async () => reply(200, 'OK'));
        expect(await pingModel({ ...base, model: 'x' }, fetchImpl)).toMatchObject({ ok: true, resolvedModel: null });
    });

    it('an error status is not ok and keeps the body for the message', async () => {
        const fetchImpl = vi.fn(async () => reply(400, { error: { message: 'not a valid model ID' } }));
        const r = await pingModel({ ...base, model: 'openai/gpt-6' }, fetchImpl);
        expect(r.ok).toBe(false);
        expect(r.status).toBe(400);
        expect(r.resolvedModel).toBeNull();
        expect(r.text).toContain('not a valid model ID');
    });
});

describe('preflightModels', () => {
    it('pings every model and collects the problems and resolved ids', async () => {
        const answers: Record<string, Response> = {
            '~anthropic/claude-haiku-latest': reply(200, { model: 'anthropic/claude-haiku-5.5' }),
            'openai/gpt-6': reply(400, { error: { message: 'not a valid model ID' } }),
            '~deepseek/deepseek-flash-latest': reply(200, { model: 'deepseek/deepseek-v4.1-flash' }),
        };
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            const { model } = JSON.parse(init?.body as string) as { model: string };
            return answers[model];
        }) as unknown as typeof fetch;
        const r = await preflightModels(Object.keys(answers), base, fetchImpl);
        expect(r.resolved).toEqual({
            '~anthropic/claude-haiku-latest': 'anthropic/claude-haiku-5.5',
            'openai/gpt-6': null,
            '~deepseek/deepseek-flash-latest': 'deepseek/deepseek-v4.1-flash',
        });
        expect(r.problems).toEqual([expect.stringMatching(/HTTP 400 for model openai\/gpt-6: .*not a valid model ID/)]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('a thrown fetch becomes an unreachable problem for that model only', async () => {
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            const { model } = JSON.parse(init?.body as string) as { model: string };
            if (model === 'b') throw new Error('ECONNRESET');
            return reply(200, { model });
        }) as unknown as typeof fetch;
        const r = await preflightModels(['a', 'b'], base, fetchImpl);
        expect(r.problems).toEqual(['LLM proxy unreachable for model b: ECONNRESET']);
        expect(r.resolved).toEqual({ a: 'a', b: null });
    });
});
