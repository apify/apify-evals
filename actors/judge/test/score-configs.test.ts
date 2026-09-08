import { describe, expect, it } from 'vitest';

import { ONLINE_RUBRIC, ONLINE_SCORE_NAMES } from '../src/rubric.js';
import { desiredOnlineScoreConfigs, type ExistingScoreConfig, planScoreConfigs } from '../src/score-configs.js';

const desired = desiredOnlineScoreConfigs();

function existingBoolean(name: string, overrides: Partial<ExistingScoreConfig> = {}): ExistingScoreConfig {
    return { id: `id-${name}`, name, dataType: 'BOOLEAN', isArchived: false, ...overrides };
}

describe('desiredOnlineScoreConfigs', () => {
    it('is one BOOLEAN config per online score name, stamped with the rubric version', () => {
        expect(desired.map((c) => c.name)).toEqual(ONLINE_SCORE_NAMES);
        for (const c of desired) {
            expect(c.dataType).toBe('BOOLEAN');
            expect(c.description).toContain('1 = pass, 0 = fail');
            expect(c.description).toContain(`Rubric ${ONLINE_RUBRIC.name} v${ONLINE_RUBRIC.version}.`);
        }
    });

    it('reuses the rubric descriptions verbatim', () => {
        expect(desired[0].description).toContain(ONLINE_RUBRIC.holistic.description);
        expect(desired[1].description).toContain(ONLINE_RUBRIC.criteria[0].description);
    });
});

describe('planScoreConfigs', () => {
    it('creates everything when the project has no configs', () => {
        const plan = planScoreConfigs(desired, []);
        expect(plan).toHaveLength(desired.length);
        expect(plan.every((e) => e.action === 'create')).toBe(true);
        expect(plan[0]).toEqual({ name: 'agent_judge', action: 'create', config: desired[0] });
    });

    it('creates only the missing ones when some exist', () => {
        const existing = [existingBoolean('agent_judge'), existingBoolean('agent_judge_taskCompletion')];
        const plan = planScoreConfigs(desired, existing);
        expect(plan.filter((e) => e.action === 'exists').map((e) => e.name)).toEqual([
            'agent_judge',
            'agent_judge_taskCompletion',
        ]);
        expect(plan.filter((e) => e.action === 'create')).toHaveLength(desired.length - 2);
    });

    it('creates nothing when all exist, and ignores unrelated configs', () => {
        const existing = [...ONLINE_SCORE_NAMES.map((n) => existingBoolean(n)), existingBoolean('judge.overall')];
        const plan = planScoreConfigs(desired, existing);
        expect(plan.every((e) => e.action === 'exists')).toBe(true);
        expect(plan.map((e) => e.name)).toEqual(ONLINE_SCORE_NAMES);
    });

    it('reports a same-name config with another dataType as a conflict, never as existing', () => {
        const plan = planScoreConfigs(desired, [existingBoolean('agent_judge', { dataType: 'NUMERIC' })]);
        expect(plan[0]).toEqual({
            name: 'agent_judge',
            action: 'conflict',
            id: 'id-agent_judge',
            reason: 'exists with dataType NUMERIC, expected BOOLEAN',
        });
        expect(plan.slice(1).every((e) => e.action === 'create')).toBe(true);
    });

    it('reports an archived same-name config as a conflict', () => {
        const plan = planScoreConfigs(desired, [existingBoolean('agent_judge', { isArchived: true })]);
        expect(plan[0]).toMatchObject({ action: 'conflict', reason: 'exists but is archived' });
    });

    it('prefers a usable config when an archived duplicate also exists', () => {
        const existing = [
            existingBoolean('agent_judge', { id: 'old', isArchived: true }),
            existingBoolean('agent_judge', { id: 'live' }),
        ];
        expect(planScoreConfigs(desired, existing)[0]).toEqual({ name: 'agent_judge', action: 'exists', id: 'live' });
    });
});
