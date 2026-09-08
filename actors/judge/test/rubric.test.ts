import { describe, expect, it } from 'vitest';

import {
    assertScoreConfigName,
    criterionScoreName,
    HOLISTIC_SCORE_NAME,
    InvalidScoreConfigNameError,
    MAX_SCORE_CONFIG_NAME_LENGTH,
    ONLINE_CRITERIA,
    ONLINE_RUBRIC,
    ONLINE_SCORE_NAMES,
    onlineScoreNames,
} from '../src/rubric.js';

describe('online rubric', () => {
    it('is the named, versioned apify-ai-turn v1 rubric', () => {
        expect(ONLINE_RUBRIC.name).toBe('apify-ai-turn');
        expect(ONLINE_RUBRIC.version).toBe(1);
    });

    it('has exactly the six criteria, each with a one-paragraph description', () => {
        expect(ONLINE_RUBRIC.criteria.map((c) => c.id)).toEqual([
            'toolSelection',
            'argumentCorrectness',
            'resultUtilization',
            'taskCompletion',
            'errorRecovery',
            'planEfficiency',
        ]);
        expect(ONLINE_RUBRIC.criteria.map((c) => c.id)).toEqual([...ONLINE_CRITERIA]);
        for (const c of ONLINE_RUBRIC.criteria) {
            expect(c.description.length).toBeGreaterThan(80);
            expect(c.description).not.toContain('\n');
        }
    });

    it('describes the holistic verdict as its own judgment, not derived from taskCompletion', () => {
        expect(ONLINE_RUBRIC.holistic.description).toMatch(/separate/i);
        expect(ONLINE_RUBRIC).not.toHaveProperty('overall');
    });
});

describe('online score names', () => {
    it('derives agent_judge plus one agent_judge_<criterion> per criterion, in rubric order', () => {
        expect(ONLINE_SCORE_NAMES).toEqual([
            'agent_judge',
            'agent_judge_toolSelection',
            'agent_judge_argumentCorrectness',
            'agent_judge_resultUtilization',
            'agent_judge_taskCompletion',
            'agent_judge_errorRecovery',
            'agent_judge_planEfficiency',
        ]);
        expect(onlineScoreNames(ONLINE_RUBRIC)).toEqual(ONLINE_SCORE_NAMES);
        expect(criterionScoreName('x')).toBe(`${HOLISTIC_SCORE_NAME}_x`);
    });

    it('follows the rubric so the two cannot drift', () => {
        const rubric = { ...ONLINE_RUBRIC, criteria: [{ id: 'toolSelection' as const, description: 'd' }] };
        expect(onlineScoreNames(rubric)).toEqual(['agent_judge', 'agent_judge_toolSelection']);
    });

    it('all fit the 35-character Langfuse score config name cap', () => {
        expect(MAX_SCORE_CONFIG_NAME_LENGTH).toBe(35);
        for (const name of ONLINE_SCORE_NAMES) {
            expect(name.length).toBeLessThanOrEqual(MAX_SCORE_CONFIG_NAME_LENGTH);
            expect(() => assertScoreConfigName(name)).not.toThrow();
        }
    });
});

describe('assertScoreConfigName', () => {
    it('rejects a name over the cap with a typed error', () => {
        const long = criterionScoreName('a'.repeat(30));
        expect(() => assertScoreConfigName(long)).toThrow(InvalidScoreConfigNameError);
        expect(() => assertScoreConfigName(long)).toThrow(/max is 35/);
    });

    it('rejects characters Langfuse does not accept', () => {
        expect(() => assertScoreConfigName('agent/judge')).toThrow(InvalidScoreConfigNameError);
        expect(() => assertScoreConfigName('agent:judge')).toThrow(/characters outside/);
    });
});
