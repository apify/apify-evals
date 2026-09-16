import { describe, expect, it } from 'vitest';

import { extractFromTools } from '../src/evidence.js';

// Shapes captured from real mcp.apify.com results on 2026-09-02.
const callActorResult = JSON.stringify({
    runId: 'TUPx3ybSYSdWg63cP',
    actorId: 'shu8hvrXbJbY3Eb9W',
    actorName: 'apify/instagram-scraper',
    status: 'SUCCEEDED',
    storages: { datasets: { default: { id: 'pMQuUldn4gAmchHbP', itemCount: 18, fields: ['likesCount'] } } },
    summary: 'SUCCEEDED in 14.301s. 18 items',
});

describe('extractFromTools', () => {
    it('reads Actor runs, inputs and dataset ids from MCP results', () => {
        const out = extractFromTools(
            [
                { id: 't1', name: 'mcp__apify__fetch-actor-details', input: { actor: 'apify/instagram-scraper' } },
                {
                    id: 't2',
                    name: 'mcp__apify__call-actor',
                    input: { actor: 'apify/instagram-scraper', input: { directUrls: ['https://www.instagram.com/nasa/'], resultsLimit: 20 } },
                },
                { id: 't3', name: 'mcp__apify__get-dataset-items', input: { datasetId: 'pMQuUldn4gAmchHbP', limit: 20 } },
            ],
            [
                { toolUseId: 't1', content: '{"actorInfo":{}}', isError: false },
                { toolUseId: 't2', content: callActorResult, isError: false },
                { toolUseId: 't3', content: '{"datasetId":"pMQuUldn4gAmchHbP","items":[]}', isError: false },
            ],
        );
        expect(out.toolCalls).toHaveLength(3);
        expect(out.actorRuns).toEqual([
            expect.objectContaining({
                actor: 'apify/instagram-scraper',
                runId: 'TUPx3ybSYSdWg63cP',
                datasetId: 'pMQuUldn4gAmchHbP',
                status: 'SUCCEEDED',
                itemCount: 18,
                input: { directUrls: ['https://www.instagram.com/nasa/'], resultsLimit: 20 },
                consoleUrl: 'https://console.apify.com/actors/runs/TUPx3ybSYSdWg63cP',
            }),
        ]);
        expect(out.datasetsRead).toEqual(['pMQuUldn4gAmchHbP']);
    });

    it('keeps a failed call-actor as evidence of the Actor the agent tried', () => {
        const out = extractFromTools(
            [{ id: 't1', name: 'mcp__apify__call-actor', input: { actor: 'x/y', input: {} } }],
            [{ toolUseId: 't1', content: 'Error: Actor not found', isError: true }],
        );
        expect(out.actorRuns).toEqual([expect.objectContaining({ actor: 'x/y', status: 'CALL-FAILED' })]);
    });

    it('finds runs in CLI output (Bash)', () => {
        const out = extractFromTools(
            [{ id: 'b', name: 'Bash', input: { command: 'apify actors call apify/web-scraper --input-file in.json' } }],
            [{ toolUseId: 'b', content: 'Run: https://console.apify.com/actors/runs/AbCdEfGhIjKlMnOpQ finished', isError: false }],
        );
        expect(out.actorRuns).toEqual([expect.objectContaining({ actor: 'apify/web-scraper', runId: 'AbCdEfGhIjKlMnOpQ' })]);
    });
});
