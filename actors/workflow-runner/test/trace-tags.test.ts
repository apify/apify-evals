import { describe, expect, it } from 'vitest';

import { buildTraceTags } from '../src/harness.js';

const ctx = {
    datasetName: 'store-actors',
    harness: { kind: 'claude-code', model: 'anthropic/claude-haiku-4.5' },
} as never;

describe('buildTraceTags', () => {
    it('marks the scheduled daily run and single repeats', () => {
        const tags = buildTraceTags({ ...(ctx as object), trigger: 'schedule', repeats: 1 } as never, {
            actor: 'apify/instagram-scraper',
            team: 'socials',
            skill: 'find',
            tags: ['family:instagram'],
        });
        expect(tags).toEqual([
            'dataset:store-actors',
            'model:anthropic/claude-haiku-4.5',
            'trigger:schedule',
            'repeats:1',
            'actor:apify/instagram-scraper',
            'team:socials',
            'skill:find',
            'family:instagram',
        ]);
    });
    it('treats the platform scheduler origin as schedule', () => {
        for (const trigger of ['scheduler', 'SCHEDULER', 'schedule']) {
            expect(buildTraceTags({ ...(ctx as object), trigger, repeats: 1 } as never, {})).toContain(
                'trigger:schedule',
            );
        }
    });
    it('folds every non-schedule origin into manual and keeps repeats', () => {
        for (const trigger of ['web', 'api', 'cli', 'WEB']) {
            const tags = buildTraceTags({ ...(ctx as object), trigger, repeats: 3 } as never, {});
            expect(tags).toContain('trigger:manual');
            expect(tags).toContain('repeats:3');
        }
    });
    it('defaults to unknown trigger and one repeat', () => {
        const tags = buildTraceTags(ctx, {});
        expect(tags).toContain('trigger:unknown');
        expect(tags).toContain('repeats:1');
    });
});
