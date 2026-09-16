import { describe, expect, it } from 'vitest';

import { sessionTimeoutSecs } from '../src/harness.js';

describe('sessionTimeoutSecs', () => {
    it('uses the Actor-level default when the scenario sets no override', () => {
        expect(sessionTimeoutSecs({}, 300)).toBe(300);
    });

    it('honours a per-scenario timeoutSecs', () => {
        expect(sessionTimeoutSecs({ timeoutSecs: 600 }, 300)).toBe(600);
        expect(sessionTimeoutSecs({ timeoutSecs: 120 }, 300)).toBe(120);
    });

    it('falls back on values that are not a positive number', () => {
        for (const bad of [0, -1, Number.NaN, '600', null, undefined]) {
            expect(sessionTimeoutSecs({ timeoutSecs: bad } as Record<string, unknown>, 300)).toBe(300);
        }
    });
});
