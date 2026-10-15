import { describe, expect, it } from 'vitest';

import { buildV2Model, commonUrlPrefix } from '../src/render-v2.js';
import type { Aggregate } from '../src/aggregate.js';
import type { Observation, ReportData } from '../src/collect.js';

const obs = (over: Partial<Observation>): Observation =>
    ({
        scenarioId: 'a-find',
        experimentId: 'e1',
        experimentName: 'e1',
        model: '~anthropic/claude-haiku-latest',
        resolvedModel: 'anthropic/claude-haiku-5.5',
        judgeModel: 'anthropic/claude-sonnet-5.5',
        trigger: 'scheduler',
        repeats: 1,
        fullScope: true,
        startTime: '2026-10-16T04:00:00Z',
        day: '2026-10-16',
        traceId: 't1',
        observationId: 'o1',
        traceUrl: 'https://lf/project/p/traces/t1?observation=o1',
        subject: 'x/a',
        owner: 'google',
        skill: 'find',
        title: 'a / find',
        scores: {
            'judge.verdict': { value: null, stringValue: 'fail', comment: null, timestamp: 't' },
            'judge.overall': { value: 0, stringValue: null, comment: 'FAIL: wrong', timestamp: 't' },
            'judge.fixArea': { value: null, stringValue: 'discoverability', comment: 'diagnosis', timestamp: 't' },
            'rubric.taskCompletion': {
                value: 0,
                stringValue: null,
                comment: 'FAIL: wrong (duplicate)',
                timestamp: 't',
            },
            'check.all': { value: 0, stringValue: null, comment: 'failed: rightActor', timestamp: 't' },
            'check.infra': { value: 1, stringValue: null, comment: 'no infrastructure failure', timestamp: 't' },
            'check.rightActor': { value: 0, stringValue: null, comment: 'FAIL: used y/b', timestamp: 't' },
            'check.ranOk': { value: 1, stringValue: null, comment: 'PASS: 1 run', timestamp: 't' },
            'judge.disagreement': { value: 0, stringValue: null, comment: 'agree', timestamp: 't' },
        },
        verdict: 'fail',
        fixArea: 'discoverability',
        found: 0,
        works: null,
        subjectCalled: 'y/b',
        infraOk: true,
        failedChecks: ['rightActor'],
        judgeComment: 'FAIL: wrong',
        ...over,
    }) as Observation;

const data = (observations: Observation[]): ReportData =>
    ({
        suite: 'store-actors',
        profile: {
            name: 'store-actors',
            subjectKind: 'actor',
            skills: { find: { label: 'Found' }, use: { label: 'Works' } },
            wrongSubjectLabel: 'wrong-actor',
            fixAreas: [],
            modelLabels: {},
        },
        projectId: 'p',
        baseUrl: 'https://lf',
        generatedAt: '2026-10-16T05:00:00Z',
        window: { from: '', to: '', days: 7 },
        expected: [{ id: 'a-find', subject: 'x/a', owner: 'google', skill: 'find', title: 'a / find', tags: [] }],
        observations,
        experiments: [],
    }) as unknown as ReportData;
const agg = (canonical: Observation[]): Aggregate => ({ canonical, diagnostics: [] }) as unknown as Aggregate;

describe('buildV2Model', () => {
    it('keeps only the score fields the page shows and strips the shared trace prefix', () => {
        const o = obs({});
        const m = buildV2Model(data([o]), agg([o]));
        expect(m.traceBaseUrl).toBe('https://lf/project/p/traces/');
        expect(m.observations[0].traceUrl).toBe('t1?observation=o1');
        expect(Object.keys(m.observations[0].scores).sort()).toEqual(['check.rightActor', 'judge.fixArea']);
        expect(m.observations[0].scores['judge.fixArea']).toEqual({ comment: 'diagnosis' });
        expect(m.observations[0].scores['check.rightActor']).toEqual({ value: 0, comment: 'FAIL: used y/b' });
        expect(m.observations[0].scores['check.infra']).toBeUndefined();
    });

    it('keeps the diagnosis on passes and the infra comment only on infra failures', () => {
        const pass = obs({ verdict: 'pass', failedChecks: [] });
        const infra = obs({
            day: '2026-10-15',
            verdict: 'inconclusive',
            infraOk: false,
            failedChecks: [],
            scores: {
                ...obs({}).scores,
                'check.infra': { value: 0, stringValue: null, comment: 'MCP returned no tools', timestamp: 't' },
            },
        });
        const m = buildV2Model(data([pass, infra]), agg([pass, infra]));
        expect(m.observations[0].scores['judge.fixArea']).toEqual({ comment: 'diagnosis' });
        expect(m.observations[0].scores['check.infra']).toBeUndefined();
        expect(m.observations[1].scores['check.infra']).toEqual({ comment: 'MCP returned no tools' });
        const boiler = obs({ verdict: 'pass', fixArea: 'none', failedChecks: [] });
        expect(buildV2Model(data([boiler]), agg([boiler])).observations[0].scores['judge.fixArea']).toBeUndefined();
        const dis = obs({
            scores: {
                ...obs({}).scores,
                'judge.disagreement': { value: 1, stringValue: null, comment: null, timestamp: 't' },
            },
        });
        expect(Object.keys(buildV2Model(data([dis]), agg([dis])).observations[0].scores).sort()).toEqual([
            'check.all',
            'check.rightActor',
            'judge.disagreement',
            'judge.fixArea',
            'rubric.taskCompletion',
        ]);
    });

    it('lists model slots with first day and resolved ids, and the judge per day', () => {
        const old = obs({
            day: '2026-10-15',
            experimentId: 'e0',
            model: '~anthropic/claude-haiku-latest',
            resolvedModel: 'anthropic/claude-haiku-4.5',
            judgeModel: 'anthropic/claude-sonnet-4.6',
        });
        const haiku = obs({});
        const luna = obs({ experimentId: 'e2', model: '~openai/gpt-luna-latest', resolvedModel: 'openai/gpt-6-luna' });
        const m = buildV2Model(data([old, haiku, luna]), agg([old, haiku, luna]));
        expect(m.models.map((s) => [s.id, s.label, s.firstDay])).toEqual([
            ['~anthropic/claude-haiku-latest', 'Haiku', '2026-10-15'],
            ['~openai/gpt-luna-latest', 'GPT Luna', '2026-10-16'],
        ]);
        expect(m.models[0].resolvedByDay).toEqual({
            '2026-10-15': 'anthropic/claude-haiku-4.5',
            '2026-10-16': 'anthropic/claude-haiku-5.5',
        });
        expect(m.judgeByDay).toEqual({
            '2026-10-15': 'anthropic/claude-sonnet-4.6',
            '2026-10-16': 'anthropic/claude-sonnet-5.5',
        });
        expect(m.observations.map((o) => o.model)).toEqual([
            '~anthropic/claude-haiku-latest',
            '~anthropic/claude-haiku-latest',
            '~openai/gpt-luna-latest',
        ]);
    });

    it('refuses two canonical attempts for one task, day and model, but allows one per model', () => {
        const a = obs({});
        const b = obs({ experimentId: 'e9' });
        expect(() => buildV2Model(data([a, b]), agg([a, b]))).toThrow(/two canonical attempts/);
        const c = obs({ experimentId: 'e2', model: '~openai/gpt-luna-latest' });
        expect(() => buildV2Model(data([a, c]), agg([a, c]))).not.toThrow();
    });

    it('commonUrlPrefix stops at a slash', () => {
        expect(commonUrlPrefix(['https://x/traces/abc?o=1', 'https://x/traces/abd?o=2'])).toBe('https://x/traces/');
        expect(commonUrlPrefix([])).toBe('');
    });
});
