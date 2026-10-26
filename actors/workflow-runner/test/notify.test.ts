import { describe, expect, it } from 'vitest';

import { previousPassRate, renderDigest, type DigestInput, type PastExperiment } from '../src/notify.js';

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

describe('previousPassRate', () => {
    // Shapes as GET /api/public/experiments?fields=core,metadata,scores returns them
    // (metadata values stringified, newest first).
    const exp = (
        id: string,
        startTime: string,
        metadata: Record<string, unknown>,
        passRates: [string, number][] = [[startTime, 0.5]],
    ): PastExperiment => ({
        id,
        startTime,
        metadata: { harness: 'claude-code', fullScope: 'true', ...metadata },
        scores: passRates.map(([timestamp, value]) => ({ name: 'pass_rate', value, timestamp })),
    });
    const haiku = { harness: 'claude-code', model: '~anthropic/claude-haiku-latest', skillSet: 'none' };

    it('skips runs of another model, harness or skill set, partial runs and the current run', () => {
        const experiments = [
            exp('current', '2026-10-26T05:01:00Z', { model: haiku.model }, []),
            exp('luna', '2026-10-26T04:40:00Z', { harness: 'codex', model: '~openai/gpt-luna-latest' }),
            exp('skills', '2026-10-26T04:20:00Z', { model: haiku.model, skillSet: 'apify-actor-usage' }),
            exp('partial', '2026-10-26T04:10:00Z', { model: haiku.model, fullScope: 'false' }),
            exp('yesterday', '2026-10-25T05:08:00Z', { model: haiku.model }, [['2026-10-25T05:30:00Z', 0.51]]),
        ];
        expect(previousPassRate(experiments, { datasetRunId: 'current', variant: haiku })).toBe(0.51);
    });

    it('treats a run without skill set metadata as the bare harness and takes its newest pass_rate', () => {
        const experiments = [
            exp('old', '2026-10-20T05:00:00Z', { model: haiku.model }, [
                ['2026-10-20T05:30:00Z', 0.4],
                ['2026-10-21T08:00:00Z', 0.45],
            ]),
        ];
        expect(previousPassRate(experiments, { datasetRunId: 'current', variant: haiku })).toBe(0.45);
        expect(
            previousPassRate(experiments, { datasetRunId: 'current', variant: { ...haiku, skillSet: 'a+b' } }),
        ).toBeNull();
    });

    it('skips a matching run that has no pass_rate yet', () => {
        const experiments = [
            exp('unjudged', '2026-10-25T05:00:00Z', { model: haiku.model }, []),
            exp('judged', '2026-10-24T05:00:00Z', { model: haiku.model }, [['2026-10-24T05:30:00Z', 0.6]]),
        ];
        expect(previousPassRate(experiments, { datasetRunId: 'current', variant: haiku })).toBe(0.6);
    });
});
