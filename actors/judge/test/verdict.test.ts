import type { CheckResult } from '@apify-evals/contract';
import { describe, expect, it } from 'vitest';

import { mergeVerdict, STORE_PROFILE_FOR_VERDICT } from '../src/verdict.js';

const check = (over: Partial<CheckResult>): CheckResult => ({
    id: 'x',
    type: 'answer.regex',
    value: 1,
    passed: true,
    severity: 'fail',
    applicable: true,
    comment: 'ok',
    ...over,
});

const base = {
    llm: { taskCompletion: 'pass' as const, fixArea: 'none', anyDimensionFailed: false },
    infraOk: true,
    infraReasons: [],
    skill: 'use' as const,
    profile: STORE_PROFILE_FOR_VERDICT,
};

describe('mergeVerdict', () => {
    it('passes when checks and the model agree', () => {
        const r = mergeVerdict({ ...base, checks: [check({})] });
        expect(r.verdict).toBe('pass');
        expect(r.overall).toBe(1);
        expect(r.fixArea).toBe('none');
        expect(r.works).toBe(1);
        expect(r.disagreement).toBe(0);
    });

    it('a failed input check beats a model pass and forces input-schema', () => {
        const r = mergeVerdict({
            ...base,
            checks: [check({ id: 'limit', type: 'apify.input', value: 0, passed: false, comment: 'resultsLimit = 20' })],
        });
        expect(r.verdict).toBe('fail');
        expect(r.fixArea).toBe('input-schema');
        expect(r.fixAreaSource).toBe('deterministic');
        expect(r.disagreement).toBe(1);
        expect(r.reasons[0]).toContain('resultsLimit = 20');
    });

    it('wrong subject on a find scenario is discoverability; on use it is readme-docs', () => {
        const miss = check({ id: 'rightActor', type: 'subject.used', value: 0, passed: false, comment: 'used x/y' });
        const find = mergeVerdict({ ...base, skill: 'find', checks: [miss] });
        expect(find.verdict).toBe('wrong-subject');
        expect(find.verdictLabel).toBe('wrong-actor');
        expect(find.fixArea).toBe('discoverability');
        expect(find.found).toBe(0);
        const use = mergeVerdict({ ...base, skill: 'use', checks: [miss] });
        expect(use.fixArea).toBe('readme-docs');
        expect(use.works).toBe(0);
    });

    it('infrastructure failure is inconclusive and writes no overall', () => {
        const r = mergeVerdict({ ...base, infraOk: false, infraReasons: ['Actor run abc FAILED'], checks: [] });
        expect(r.verdict).toBe('inconclusive');
        expect(r.overall).toBeNull();
        expect(r.found).toBeNull();
        expect(r.works).toBeNull();
        expect(r.fixArea).toBe('none');
    });

    it('warn-severity and not-applicable checks never gate', () => {
        const r = mergeVerdict({
            ...base,
            checks: [
                check({ id: 'w', type: 'apify.items', value: 0, passed: false, severity: 'warn' }),
                check({ id: 'na', type: 'apify.items', value: 0, passed: false, applicable: false }),
            ],
        });
        expect(r.verdict).toBe('pass');
    });

    it('model fail with all checks passing is a fail with the model fix area and a disagreement flag', () => {
        const r = mergeVerdict({
            ...base,
            llm: { taskCompletion: 'fail', fixArea: 'readme-docs', anyDimensionFailed: true },
            checks: [check({})],
        });
        expect(r.verdict).toBe('fail');
        expect(r.fixArea).toBe('readme-docs');
        expect(r.fixAreaSource).toBe('model');
        expect(r.disagreement).toBe(1);
    });

    it('an unknown model fix area falls back to agent-or-model', () => {
        const r = mergeVerdict({ ...base, llm: { taskCompletion: 'fail', fixArea: 'system-prompt', anyDimensionFailed: true }, checks: [] });
        expect(r.fixArea).toBe('agent-or-model');
        expect(r.disagreement).toBe(0);
    });
});
