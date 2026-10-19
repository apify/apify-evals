import { describe, expect, it, vi } from 'vitest';

import { effectiveJudgeModel, tuplesMatch, type VersionTuple } from '../src/core.js';
import { isModelAlias, resolveModelAlias } from '../src/llm.js';

const reply = (status: number, body: unknown) =>
    ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe('resolveModelAlias', () => {
    it('returns a pinned id without calling the proxy', async () => {
        const fetchImpl = vi.fn();
        await expect(
            resolveModelAlias({ apifyToken: 't', model: 'anthropic/claude-sonnet-4.6' }, fetchImpl),
        ).resolves.toBe('anthropic/claude-sonnet-4.6');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('resolves an alias to the model named in the reply', async () => {
        const fetchImpl = vi.fn(async () => reply(200, { model: 'anthropic/claude-sonnet-5.5', choices: [] }));
        await expect(
            resolveModelAlias({ apifyToken: 't', model: '~anthropic/claude-sonnet-latest' }, fetchImpl),
        ).resolves.toBe('anthropic/claude-sonnet-5.5');
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toMatchObject({
            model: '~anthropic/claude-sonnet-latest',
            max_tokens: 1,
        });
    });

    it('throws when the proxy rejects the alias', async () => {
        const fetchImpl = vi.fn(async () => reply(400, { error: { message: 'not a valid model ID' } }));
        await expect(resolveModelAlias({ apifyToken: 't', model: '~nope/x-latest' }, fetchImpl)).rejects.toThrow(
            /HTTP 400/,
        );
    });

    it('throws when the reply names no model', async () => {
        const fetchImpl = vi.fn(async () => reply(200, { choices: [] }));
        await expect(resolveModelAlias({ apifyToken: 't', model: '~a/b-latest' }, fetchImpl)).rejects.toThrow(
            /names no model/,
        );
    });

    it('isModelAlias is the leading tilde', () => {
        expect(isModelAlias('~anthropic/claude-haiku-latest')).toBe(true);
        expect(isModelAlias('anthropic/claude-haiku-4.5')).toBe(false);
    });
});

describe('tuplesMatch with a resolved judge model', () => {
    const base: VersionTuple = {
        rubricVersion: 'r1',
        judgeModel: '~anthropic/claude-sonnet-latest',
        judgeModelResolved: 'anthropic/claude-sonnet-5.5',
        promptVersion: 2,
        judgeImplVersion: '0.4.1',
    };

    it('compares the resolved model, so an alias move re-judges', () => {
        const scored = { ...base, judgeModelResolved: 'anthropic/claude-sonnet-5.1' };
        expect(tuplesMatch(scored, base)).toBe(false);
        expect(tuplesMatch({ ...base }, base)).toBe(true);
    });

    it('treats a legacy score without judgeModelResolved as judged by its judgeModel', () => {
        const legacy = {
            rubricVersion: 'r1',
            judgeModel: 'anthropic/claude-sonnet-4.6',
            promptVersion: '2',
            judgeImplVersion: '0.4.1',
        };
        const pinned: VersionTuple = {
            ...base,
            judgeModel: 'anthropic/claude-sonnet-4.6',
            judgeModelResolved: 'anthropic/claude-sonnet-4.6',
        };
        expect(tuplesMatch(legacy, pinned)).toBe(true);
        expect(effectiveJudgeModel(legacy)).toBe('anthropic/claude-sonnet-4.6');
        expect(effectiveJudgeModel(base)).toBe('anthropic/claude-sonnet-5.5');
    });

    it('an alias that resolves to the pinned id counts as the same judge', () => {
        const legacy = {
            rubricVersion: 'r1',
            judgeModel: 'anthropic/claude-sonnet-5.5',
            promptVersion: 2,
            judgeImplVersion: '0.4.1',
        };
        expect(tuplesMatch(legacy, base)).toBe(true);
    });
});
