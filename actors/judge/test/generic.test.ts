import { describe, expect, it } from 'vitest';

import { renderFacts } from '../src/evidence.js';
import { GENERIC_PROFILE_NAME, fixAreaPromptSection, loadJudgeProfile } from '../src/profile.js';

describe('generic judging (items with no store scenario metadata)', () => {
    it('renders no store find/use framing when the item declares none', () => {
        const facts = renderFacts({ intendedSubject: null, skill: null, artifact: null, session: {} });
        expect(facts).not.toMatch(/Scenario type|Intended subject|Actor runs/);
        expect(facts).toBe('- None beyond the conversation below.');
    });

    it('keeps the store framing for store scenarios', () => {
        const facts = renderFacts({ intendedSubject: 'apify/web-scraper', skill: 'find', artifact: null, session: {} });
        expect(facts).toContain('store search');
        expect(facts).toContain('Intended subject: apify/web-scraper');
        expect(facts).toContain('Actor runs the agent started: none');
    });

    it('names the agent setup and the surfaces used (contract 1.3 traces only)', () => {
        const facts = renderFacts({
            intendedSubject: 'apify/web-scraper',
            skill: 'use',
            artifact: null,
            session: {
                surface: 'cli',
                surfaceKind: 'cli',
                cliVersion: '1.10.0',
                surfacesUsed: ['cli', 'api'],
                agentSkills: ['apify-ultimate-scraper'],
                skillsLoaded: ['apify-ultimate-scraper'],
            },
        });
        expect(facts).toContain(
            '- Agent setup: surface cli (the Apify CLI in Bash 1.10.0); agent skills apify-ultimate-scraper (loaded: apify-ultimate-scraper). Apify surfaces the agent used: cli, api.',
        );
        expect(renderFacts({ intendedSubject: null, skill: null, artifact: null, session: {} })).not.toContain(
            'Agent setup',
        );
    });

    it('offers no store fix areas and maps checks onto its own ids', () => {
        const profile = loadJudgeProfile(GENERIC_PROFILE_NAME);
        const section = fixAreaPromptSection(profile);
        expect(section).not.toMatch(/store|discoverability|readme-docs|input-schema/);
        const ids = new Set(profile.fixAreaIds);
        for (const area of Object.values(profile.forcedFixAreas)) {
            for (const id of typeof area === 'string' ? [area] : [area.find, area.use]) expect(ids.has(id)).toBe(true);
        }
    });
});
