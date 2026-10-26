import { describe, expect, it } from 'vitest';

import { canonicalExperimentIds } from '../src/aggregate.js';
import type { Observation } from '../src/collect.js';

const obs = (
    experimentId: string,
    scenarioId: string,
    day: string,
    startTime: string,
    trigger = 'scheduler',
    model: string | null = null,
): Observation =>
    ({
        scenarioId,
        experimentId,
        experimentName: experimentId,
        model,
        resolvedModel: null,
        judgeModel: null,
        trigger,
        repeats: 1,
        fullScope: true,
        startTime,
        day,
        traceId: 't',
        observationId: 'o',
        traceUrl: '',
        subject: null,
        owner: null,
        skill: null,
        title: null,
        scores: {},
        verdict: 'pass',
        fixArea: null,
        found: null,
        works: null,
        subjectCalled: null,
        infraOk: true,
        failedChecks: [],
        judgeComment: null,
    }) as Observation;

describe('canonicalExperimentIds', () => {
    it('keeps one scheduled run per day, preferring the most complete and then the later one', () => {
        const ids = canonicalExperimentIds([
            // 26th: restarted after a migration; the 04:10 run judged more items
            obs('early', 'a', '2026-09-26', '2026-09-26T04:00:00Z'),
            obs('late', 'a', '2026-09-26', '2026-09-26T04:10:00Z'),
            obs('late', 'b', '2026-09-26', '2026-09-26T04:10:00Z'),
            // 27th: tie on count → later start wins
            obs('x', 'a', '2026-09-27', '2026-09-27T04:00:00Z'),
            obs('y', 'a', '2026-09-27', '2026-09-27T04:10:00Z'),
            // 28th: no scheduled run, a single manual full run is canonical
            obs('manual', 'a', '2026-09-28', '2026-09-28T09:00:00Z', 'cli'),
            // 29th: two manual full runs, none canonical
            obs('m1', 'a', '2026-09-29', '2026-09-29T09:00:00Z', 'cli'),
            obs('m2', 'a', '2026-09-29', '2026-09-29T10:00:00Z', 'cli'),
        ]);
        expect([...ids].sort()).toEqual(['late', 'manual', 'y']);
    });

    it('keeps one scheduled run per day and model slot, mapping legacy Haiku 4.5 into the alias slot', () => {
        const ids = canonicalExperimentIds([
            obs('haiku-old', 'a', '2026-10-15', '2026-10-15T04:00:00Z', 'scheduler', 'anthropic/claude-haiku-4.5'),
            obs('haiku', 'a', '2026-10-16', '2026-10-16T04:00:00Z', 'scheduler', '~anthropic/claude-haiku-latest'),
            obs('luna', 'a', '2026-10-16', '2026-10-16T04:25:00Z', 'scheduler', '~openai/gpt-luna-latest'),
            obs('flash', 'a', '2026-10-16', '2026-10-16T04:50:00Z', 'scheduler', '~deepseek/deepseek-flash-latest'),
            // a restarted Haiku run on the 16th: more items wins, not the later start
            obs(
                'haiku-restart',
                'a',
                '2026-10-16',
                '2026-10-16T04:10:00Z',
                'scheduler',
                '~anthropic/claude-haiku-latest',
            ),
            obs('haiku', 'b', '2026-10-16', '2026-10-16T04:00:00Z', 'scheduler', '~anthropic/claude-haiku-latest'),
        ]);
        expect([...ids].sort()).toEqual(['flash', 'haiku', 'haiku-old', 'luna']);
    });

    it('leaves comparison runs (several skill sets in one Actor run) out of the day', () => {
        const comparison = (experimentId: string, day: string, startTime: string) => ({
            ...obs(experimentId, 'a', day, startTime, 'cli'),
            comparison: true,
        });
        const ids = canonicalExperimentIds([
            // 1st: one manual full run and a two-variant comparison run, same model
            obs('manual', 'a', '2026-10-01', '2026-10-01T09:00:00Z', 'cli'),
            comparison('skills-none', '2026-10-01', '2026-10-01T10:00:00Z'),
            comparison('skills-apify', '2026-10-01', '2026-10-01T10:20:00Z'),
            // 2nd: only a comparison run, nothing canonical
            comparison('only-none', '2026-10-02', '2026-10-02T10:00:00Z'),
            comparison('only-apify', '2026-10-02', '2026-10-02T10:20:00Z'),
        ]);
        expect([...ids].sort()).toEqual(['manual']);
    });
});
