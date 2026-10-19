import { describe, expect, it } from 'vitest';

import { buildV2Model } from '../src/render-v2.js';
import { FLASH, HAIKU, LUNA, syntheticData } from './fixtures/multi-model.js';

describe('multi-model fixture', () => {
    it('builds a model with three slots, staggered first days and resolved-model moves', () => {
        const { data, agg } = syntheticData();
        const m = buildV2Model(data, agg);
        expect(m.models.map((s) => [s.id, s.firstDay])).toEqual([
            [HAIKU, '2026-10-05'],
            [FLASH, '2026-10-09'],
            [LUNA, '2026-10-09'],
        ]);
        expect(m.models[0].resolvedByDay['2026-10-12']).toBe('anthropic/claude-haiku-5.5');
        expect(m.models[0].resolvedByDay['2026-10-13']).toBe('anthropic/claude-haiku-5.6');
        expect(m.judgeByDay['2026-10-13']).toBe('anthropic/claude-sonnet-5.5');
        expect(m.days).toHaveLength(12);
        expect(m.observations.length).toBe(4 * 12 + 8 * 36 - 2);
    });
});
