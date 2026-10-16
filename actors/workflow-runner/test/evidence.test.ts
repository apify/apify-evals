import { describe, expect, it } from 'vitest';

import { datasetIdsInText, extractFromTools, runsInText } from '../src/evidence.js';

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
                    input: {
                        actor: 'apify/instagram-scraper',
                        input: { directUrls: ['https://www.instagram.com/nasa/'], resultsLimit: 20 },
                    },
                },
                {
                    id: 't3',
                    name: 'mcp__apify__get-dataset-items',
                    input: { datasetId: 'pMQuUldn4gAmchHbP', limit: 20 },
                },
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
            [
                {
                    toolUseId: 'b',
                    content: 'Run: https://console.apify.com/actors/runs/AbCdEfGhIjKlMnOpQ finished',
                    isError: false,
                },
            ],
        );
        expect(out.actorRuns).toEqual([
            expect.objectContaining({ actor: 'apify/web-scraper', runId: 'AbCdEfGhIjKlMnOpQ' }),
        ]);
    });

    it('finds runs in the URL the Apify CLI 1.x prints (actors/<actId>/runs/<runId>)', () => {
        // Output shape of `apify call` (src/commands/actors/call.ts, CLI 1.7.0).
        const out = extractFromTools(
            [
                {
                    id: 'b',
                    name: 'Bash',
                    input: { command: 'apify call apify/google-search-scraper -i \'{"queries":"apify"}\'' },
                },
            ],
            [
                {
                    toolUseId: 'b',
                    content: [
                        'Started: 2026-10-15 13:20:01',
                        'Status: SUCCEEDED',
                        'View on Apify Console: https://console.apify.com/actors/nFJndFXA5zjCTuudP/runs/Xy9kLmNoPqRsTuVwZ',
                    ].join('\n'),
                    isError: false,
                },
            ],
        );
        expect(out.actorRuns).toEqual([
            expect.objectContaining({
                actor: 'apify/google-search-scraper',
                runId: 'Xy9kLmNoPqRsTuVwZ',
                origin: 'cli',
            }),
        ]);
    });

    it('finds runs started with curl from the API response and names the Actor from the URL', () => {
        const response = JSON.stringify({
            data: {
                id: 'Run1234567890abcd',
                actId: 'nFJndFXA5zjCTuudP',
                status: 'READY',
                defaultDatasetId: 'Dataset890abcdefg',
                defaultKeyValueStoreId: 'Store1234567890ab',
            },
        });
        const out = extractFromTools(
            [
                {
                    id: 'c',
                    name: 'Bash',
                    input: {
                        command:
                            'curl -s -X POST "https://api.apify.com/v2/acts/apify~google-search-scraper/runs" -H "Authorization: Bearer $APIFY_TOKEN" -d @in.json',
                    },
                },
            ],
            [{ toolUseId: 'c', content: response, isError: false }],
        );
        expect(out.actorRuns).toEqual([
            expect.objectContaining({
                actor: 'apify/google-search-scraper',
                runId: 'Run1234567890abcd',
                actorId: 'nFJndFXA5zjCTuudP',
                datasetId: 'Dataset890abcdefg',
                origin: 'api',
            }),
        ]);
    });

    it('finds a run when the curl command has an inline JSON body and the output is pretty-printed', () => {
        const response = JSON.stringify(
            {
                data: {
                    id: 'Run1234567890abcd',
                    actId: 'nFJndFXA5zjCTuudP',
                    status: 'READY',
                    defaultDatasetId: 'Dataset890abcdefg',
                    defaultKeyValueStoreId: 'Store1234567890ab',
                },
            },
            null,
            2,
        );
        const out = extractFromTools(
            [
                {
                    id: 'c',
                    name: 'Bash',
                    input: {
                        command:
                            'curl -s -X POST "https://api.apify.com/v2/acts/apify~google-search-scraper/runs" -H "Authorization: Bearer $APIFY_TOKEN" -H "Content-Type: application/json" -d \'{"queries": "apify", "maxPagesPerQuery": 1}\' | jq .',
                    },
                },
            ],
            [{ toolUseId: 'c', content: response, isError: false }],
        );
        expect(out.actorRuns).toEqual([
            expect.objectContaining({
                actor: 'apify/google-search-scraper',
                runId: 'Run1234567890abcd',
                actorId: 'nFJndFXA5zjCTuudP',
                datasetId: 'Dataset890abcdefg',
                status: 'READY',
                origin: 'api',
            }),
        ]);
    });

    it('finds a run URL in the command even when the output is not JSON', () => {
        const out = extractFromTools(
            [
                {
                    id: 'c',
                    name: 'Bash',
                    input: {
                        command:
                            'curl -s "https://api.apify.com/v2/actor-runs/Run1234567890abcd?token=$APIFY_TOKEN" -d \'{"x": 1}\'',
                    },
                },
            ],
            [{ toolUseId: 'c', content: 'curl: (6) Could not resolve host', isError: false }],
        );
        expect(out.actorRuns).toEqual([expect.objectContaining({ runId: 'Run1234567890abcd', origin: 'api' })]);
    });

    it('finds nothing in a run-sync response, which carries items and no run', () => {
        const out = extractFromTools(
            [
                {
                    id: 'c',
                    name: 'Bash',
                    input: {
                        command:
                            'curl -s -X POST "https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=$APIFY_TOKEN" -d @in.json',
                    },
                },
            ],
            [{ toolUseId: 'c', content: '[{"searchQuery":{"term":"apify"},"organicResults":[]}]', isError: false }],
        );
        expect(out.actorRuns).toEqual([]);
    });
});

describe('runsInText', () => {
    it('reads every Console and API run URL form', () => {
        const text = [
            'https://console.apify.com/actors/runs/AAAAAAAAAAAAAAAA1',
            'https://console.apify.com/actors/nFJndFXA5zjCTuudP/runs/AAAAAAAAAAAAAAAA2',
            'https://console.apify.com/view/runs/AAAAAAAAAAAAAAAA3',
            'https://api.apify.com/v2/actor-runs/AAAAAAAAAAAAAAAA4/dataset/items',
            'https://api.apify.com/v2/acts/apify~web-scraper/runs/AAAAAAAAAAAAAAAA5',
            'https://api.apify.com/v2/acts/apify~web-scraper/runs/last',
        ].join('\n');
        expect(runsInText(text).map((r) => r.runId)).toEqual([
            'AAAAAAAAAAAAAAAA1',
            'AAAAAAAAAAAAAAAA2',
            'AAAAAAAAAAAAAAAA3',
            'AAAAAAAAAAAAAAAA4',
            'AAAAAAAAAAAAAAAA5',
        ]);
    });

    it('reads run objects from JSON lines and lists, not builds', () => {
        const run = {
            id: 'RunRunRunRunRun01',
            actId: 'ActActActActAct01',
            defaultKeyValueStoreId: 'KvsKvsKvsKvsKvs01',
        };
        const build = { id: 'BldBldBldBldBld01', actId: 'ActActActActAct01', buildNumber: '0.0.1' };
        expect(runsInText(JSON.stringify({ data: { items: [run, build] } })).map((r) => r.runId)).toEqual([
            'RunRunRunRunRun01',
        ]);
        expect(runsInText(`progress...\n${JSON.stringify(run)}\ndone`).map((r) => r.runId)).toEqual([
            'RunRunRunRunRun01',
        ]);
    });
});

describe('runs through mcpc', () => {
    it('reads the run id from `mcpc --json` output', () => {
        const out = JSON.stringify({
            structuredContent: { runId: 'RunRunRunRunRun02', datasetId: 'DsDsDsDsDsDsDsD02' },
        });
        expect(runsInText(out).map((r) => r.runId)).toEqual(['RunRunRunRunRun02']);
    });

    it('reads the run id from mcpc arguments', () => {
        // Commands seen in a matrix run (2026-10-15).
        const commands = [
            `sleep 30 && mcpc @apify tools-call get-actor-run runId:='"7NjnNnxy9HBOz6hWO"' waitSecs:=45`,
            'mcpc @apify tools-call get-actor-run runId:=7NjnNnxy9HBOz6hWP',
        ];
        expect(commands.flatMap((c) => runsInText(c).map((r) => r.runId))).toEqual([
            '7NjnNnxy9HBOz6hWO',
            '7NjnNnxy9HBOz6hWP',
        ]);
    });

    it('keeps the dataset id of the readable output as a hint for its run', () => {
        // Readable output of `mcpc @apify tools-call get-actor-run` (mcpc 0.7.0, apify-mcp-server 0.18.2).
        const text =
            'SUCCEEDED in 5.04s. 1 item; 1 fields available.\nUse get-dataset-items with datasetId=FApemntw8aw0dJBKf and limit (for example 20) to fetch items';
        expect(datasetIdsInText(text)).toEqual(['FApemntw8aw0dJBKf']);
        const out = extractFromTools(
            [
                {
                    id: 'm',
                    name: 'Bash',
                    input: { command: "mcpc @apify tools-call call-actor actor:=apify/web-scraper input:='{}'" },
                },
            ],
            [{ toolUseId: 'm', content: text, isError: false }],
        );
        expect(out.actorRuns).toEqual([]);
        expect(out.datasetHints).toEqual([{ datasetId: 'FApemntw8aw0dJBKf', actor: null, origin: 'cli' }]);
    });

    it('finds dataset ids in JSON and URLs', () => {
        expect(
            datasetIdsInText(
                '{"defaultDatasetId": "AAAAAAAAAAAAAAAA1"} https://console.apify.com/storage/datasets/AAAAAAAAAAAAAAAA2 https://api.apify.com/v2/datasets/AAAAAAAAAAAAAAAA3/items',
            ),
        ).toEqual(['AAAAAAAAAAAAAAAA1', 'AAAAAAAAAAAAAAAA2', 'AAAAAAAAAAAAAAAA3']);
    });
});
