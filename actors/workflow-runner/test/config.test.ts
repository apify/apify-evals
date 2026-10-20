import { describe, expect, it } from 'vitest';

import {
    DEFAULT_HEALTH_THRESHOLD,
    judgeLangfuseInput,
    resolveModelEntries,
    resolveHealthThreshold,
    resolveTrigger,
    shouldNotify,
} from '../src/config.js';

describe('resolveHealthThreshold', () => {
    it('parses the string the Console sends', () => {
        expect(resolveHealthThreshold('0.75')).toBe(0.75);
        expect(resolveHealthThreshold(' 0.5 ')).toBe(0.5);
    });

    it('keeps 0, which means never fail on health', () => {
        expect(resolveHealthThreshold('0')).toBe(0);
        expect(resolveHealthThreshold(0)).toBe(0);
    });

    it('falls back to the default only for missing or unparseable values', () => {
        expect(resolveHealthThreshold(undefined)).toBe(DEFAULT_HEALTH_THRESHOLD);
        expect(resolveHealthThreshold('')).toBe(DEFAULT_HEALTH_THRESHOLD);
        expect(resolveHealthThreshold('abc')).toBe(DEFAULT_HEALTH_THRESHOLD);
        expect(resolveHealthThreshold(Number.NaN)).toBe(DEFAULT_HEALTH_THRESHOLD);
    });

    it('clamps to [0, 1]', () => {
        expect(resolveHealthThreshold('1.5')).toBe(1);
        expect(resolveHealthThreshold('-2')).toBe(0);
    });
});

describe('resolveTrigger', () => {
    it('normalises the platform scheduler origin to "schedule"', () => {
        expect(resolveTrigger(undefined, 'SCHEDULER')).toBe('schedule');
        expect(resolveTrigger('SCHEDULER', undefined)).toBe('schedule');
    });

    it('lowercases other origins and prefers the explicit input', () => {
        expect(resolveTrigger(undefined, 'WEB')).toBe('web');
        expect(resolveTrigger('nightly', 'API')).toBe('nightly');
    });

    it('falls back to "unknown" without an origin', () => {
        expect(resolveTrigger(undefined, undefined)).toBe('unknown');
        expect(resolveTrigger(undefined, '')).toBe('unknown');
    });
});

describe('shouldNotify', () => {
    it('posts by default for scheduled runs only', () => {
        expect(shouldNotify(undefined, resolveTrigger(undefined, 'SCHEDULER'))).toBe(true);
        expect(shouldNotify(undefined, resolveTrigger(undefined, 'WEB'))).toBe(false);
        expect(shouldNotify(undefined, 'unknown')).toBe(false);
    });

    it('lets an explicit input win either way', () => {
        expect(shouldNotify(false, 'schedule')).toBe(false);
        expect(shouldNotify(true, 'web')).toBe(true);
    });
});

describe('judgeLangfuseInput', () => {
    it('always forwards the credentials the runner resolved, from inputs or its own env', () => {
        const env = {
            LANGFUSE_BASE_URL: 'https://other.langfuse.dev',
            LANGFUSE_PUBLIC_KEY: 'pk-other',
            LANGFUSE_SECRET_KEY: 'sk-other',
        };
        expect(judgeLangfuseInput(env)).toEqual({
            langfuseBaseUrl: 'https://other.langfuse.dev',
            langfusePublicKey: 'pk-other',
            langfuseSecretKey: 'sk-other',
        });
    });

    it('leaves out what the runner does not have, so the judge falls back to its own env for it', () => {
        expect(judgeLangfuseInput({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' })).toEqual({
            langfusePublicKey: 'pk',
            langfuseSecretKey: 'sk',
        });
        expect(judgeLangfuseInput({})).toEqual({});
    });
});

describe('resolveModelEntries', () => {
    const base = { kind: 'claude-code', model: 'anthropic/claude-haiku-4.5' };

    it('runs plain ids on the base harness and objects on the harness they name', () => {
        expect(
            resolveModelEntries(
                ['~anthropic/claude-haiku-latest', { model: '~openai/gpt-luna-latest', harness: 'codex' }],
                base,
            ),
        ).toEqual([
            { model: '~anthropic/claude-haiku-latest', kind: 'claude-code' },
            { model: '~openai/gpt-luna-latest', kind: 'codex' },
        ]);
        expect(resolveModelEntries(undefined, base)).toEqual([{ model: base.model, kind: 'claude-code' }]);
        expect(resolveModelEntries(['a', 'a', { model: 'a' }], base)).toEqual([{ model: 'a', kind: 'claude-code' }]);
    });

    it('refuses an OpenAI model on Claude Code and an unknown harness', () => {
        expect(() => resolveModelEntries(['~openai/gpt-luna-latest'], base)).toThrow(
            /cannot run on the claude-code harness/,
        );
        expect(() => resolveModelEntries(['openai/gpt-6-luna'], base)).toThrow(/apify-evals#44/);
        expect(() => resolveModelEntries([{ model: 'x', harness: 'cursor' }], base)).toThrow(
            /unknown harness "cursor"/,
        );
        expect(() => resolveModelEntries([{ harness: 'codex' }], base)).toThrow(/without a model id/);
        expect(() => resolveModelEntries([null as never], base)).toThrow(/without a model id/);
    });
});
