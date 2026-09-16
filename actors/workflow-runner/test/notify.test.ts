import { describe, expect, it } from 'vitest';

import { renderDigest, type DigestInput } from '../src/notify.js';

const digest: DigestInput = {
    suite: 'store-actors',
    model: 'anthropic/claude-haiku-4.5',
    scope: 'all',
    fullScope: true,
    trigger: 'schedule',
    resultsUrl: 'https://langfuse.example/results?baseline=abc',
    runName: 'store-actors · claude-haiku-4.5 · 2026-09-03 06:00 · schedule',
    passRate: 0.5,
    previousPassRate: 0.4,
    judged: 4,
    passed: 2,
    inconclusive: 0,
    disagreements: 1,
    actorRunsCostUsd: 0.1234,
    fixAreas: { discoverability: 2, none: 2 },
    scenarios: [
        { title: 'Discovery: gyms', owner: 'google', subject: 'compass/crawler-google-places', verdict: 'wrong-actor', fixArea: 'discoverability', traceUrl: 'https://t/1', reason: 'used gio21/gym-scraper' },
        { title: 'Usage: coffee', owner: 'google', subject: 'compass/crawler-google-places', verdict: 'pass', fixArea: 'none', traceUrl: 'https://t/2', reason: '' },
        { title: 'Discovery: nasa', owner: 'socials', subject: 'apify/instagram-scraper', verdict: 'wrong-actor', fixArea: 'discoverability', traceUrl: null, reason: 'used post scraper' },
        { title: 'Usage: nasa', owner: 'socials', subject: 'apify/instagram-scraper', verdict: 'pass', fixArea: 'none', traceUrl: 'https://t/4', reason: '' },
    ],
};

describe('renderDigest', () => {
    it('renders the suite digest with delta, failures, fix areas and cost', () => {
        const text = renderDigest(digest, null);
        expect(text).toContain('2/4 scenarios pass (+10 pts vs previous run)');
        expect(text).toContain('Discovery: gyms');
        expect(text).toContain('<https://t/1|trace>');
        expect(text).toContain('discoverability 2');
        expect(text).not.toContain('none 2');
        expect(text).toContain('$0.12');
        expect(text).toContain('Results in Langfuse');
    });

    it('renders a per-owner digest with only that owner\'s scenarios', () => {
        const text = renderDigest(digest, 'socials');
        expect(text).toContain('*socials* · 1/2 scenarios pass');
        expect(text).toContain('Discovery: nasa');
        expect(text).not.toContain('Discovery: gyms');
    });
});
