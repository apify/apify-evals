import { describe, expect, it } from 'vitest';

import { canonicalExperimentIds } from '../src/aggregate.js';
import type { Observation } from '../src/collect.js';

const obs = (experimentId: string, scenarioId: string, day: string, startTime: string, trigger = 'scheduler'): Observation =>
    ({
        scenarioId,
        experimentId,
        experimentName: experimentId,
        model: null,
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
});
