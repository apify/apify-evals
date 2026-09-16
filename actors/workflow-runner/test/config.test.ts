import { describe, expect, it } from 'vitest';

import { DEFAULT_HEALTH_THRESHOLD, resolveHealthThreshold, resolveTrigger, shouldNotify } from '../src/config.js';

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
