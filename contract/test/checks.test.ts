import { describe, expect, it } from 'vitest';

import {
    compare,
    extractNumbers,
    getPath,
    globToRegExp,
    infraStatus,
    runChecks,
    type Evidence,
} from '../src/checks.js';

const items = [
    { shortCode: 'C1abc', likesCount: 267546, ownerUsername: 'nasa', caption: 'Roman launch' },
    { shortCode: 'C1def', likesCount: 89378, ownerUsername: 'nasa', caption: 'Spacewalk' },
    { shortCode: 'C1ghi', likesCount: 103684, ownerUsername: 'nasa', caption: null },
];

const evidence: Evidence = {
    prompt: 'Using apify/instagram-scraper, get the 3 most recent posts from @nasa and report like counts.',
    finalResult:
        'Top post C1abc has 267,546 likes; C1def 89,378; C1ghi 103,684. Average 153,536 likes.\nActor: apify/instagram-scraper',
    toolCalls: [
        { tool: 'mcp__apify__fetch-actor-details', input: { actor: 'apify/instagram-scraper' } },
        {
            tool: 'mcp__apify__call-actor',
            input: {
                actor: 'apify/instagram-scraper',
                input: { directUrls: ['https://www.instagram.com/nasa/'], resultsType: 'posts', resultsLimit: 3 },
            },
        },
        { tool: 'mcp__apify__get-dataset-items', input: { datasetId: 'ds1', limit: 20 } },
    ],
    actorRuns: [
        {
            actor: 'apify/instagram-scraper',
            runId: 'run1',
            datasetId: 'ds1',
            status: 'SUCCEEDED',
            itemCount: 3,
            input: { directUrls: ['https://www.instagram.com/nasa/'], resultsType: 'posts', resultsLimit: 3 },
        },
    ],
    datasets: { ds1: items },
    reference: { actor: 'apify/instagram-scraper', input: {}, items: [{ followersCount: 104_400_000 }] },
    session: { timedOut: false, stdoutTruncated: false, harnessBroke: false, exitCode: 0, subtype: 'success' },
};

const byId = (results: ReturnType<typeof runChecks>) => Object.fromEntries(results.map((r) => [r.id, r]));

describe('runChecks', () => {
    it('answer checks and legacy aliases', () => {
        const r = byId(
            runChecks(
                [
                    { id: 'a', type: 'answer.contains', value: 'apify/instagram-scraper' },
                    { type: 'contains', value: 'nope' },
                    { id: 'c', type: 'answer.regex', value: '\\d{1,3},\\d{3}' },
                ],
                evidence,
            ),
        );
        expect(r.a.value).toBe(1);
        expect(r.contains_2.value).toBe(0);
        expect(r.c.value).toBe(1);
    });

    it('subject.used reads tool calls, not the answer', () => {
        const ev = { ...evidence, finalResult: 'I used something else' };
        const r = byId(
            runChecks(
                [
                    { id: 'exact', type: 'subject.used', value: 'apify/instagram-scraper' },
                    { id: 'pattern', type: 'subject.used', pattern: '^maxcopell/zillow' },
                    { id: 'others', type: 'subject.used', value: 'x/y', allowOthers: ['apify/instagram-scraper'] },
                    { id: 'folded', type: 'subject.used', value: 'APIFY/Instagram-Scraper' },
                ],
                ev,
            ),
        );
        expect(r.exact.value).toBe(1);
        expect(r.pattern.value).toBe(0);
        expect(r.pattern.comment).toMatch(/used apify\/instagram-scraper/);
        expect(r.others.value).toBe(1);
        expect(r.folded.value).toBe(1);
    });

    it('apify.run and apify.input', () => {
        const r = byId(
            runChecks(
                [
                    { id: 'run', type: 'apify.run', maxRuns: 1 },
                    { id: 'limit', type: 'apify.input', path: 'resultsLimit', op: 'lte', value: 3 },
                    { id: 'tooMany', type: 'apify.input', path: 'resultsLimit', op: 'gte', value: 10 },
                    { id: 'req', type: 'apify.input', required: ['directUrls', 'resultsType'] },
                    { id: 'reqMissing', type: 'apify.input', required: ['search'] },
                    {
                        id: 'url',
                        type: 'apify.input',
                        path: 'directUrls[0]',
                        op: 'regex',
                        value: 'instagram\\.com/nasa',
                    },
                ],
                evidence,
            ),
        );
        expect(r.run.value).toBe(1);
        expect(r.limit.value).toBe(1);
        expect(r.tooMany.value).toBe(0);
        expect(r.tooMany.comment).toContain('resultsLimit = 3');
        expect(r.req.value).toBe(1);
        expect(r.reqMissing.comment).toContain('missing search');
        expect(r.url.value).toBe(1);
    });

    it('apify.input: boolean flags are compared by value, not presence', () => {
        // The agent set every required flag, but two of them the wrong way round.
        const ev: Evidence = {
            ...evidence,
            actorRuns: [
                {
                    ...evidence.actorRuns[0],
                    input: {
                        zipCodes: ['85251'],
                        forSaleByAgent: true,
                        forSaleByOwner: true,
                        forRent: true,
                        sold: true,
                    },
                },
            ],
        };
        const r = byId(
            runChecks(
                [
                    {
                        id: 'present',
                        type: 'apify.input',
                        required: ['forSaleByAgent', 'forSaleByOwner', 'forRent', 'sold'],
                    },
                    { id: 'agent', type: 'apify.input', path: 'forSaleByAgent', op: 'equals', value: true },
                    { id: 'rent', type: 'apify.input', path: 'forRent', op: 'equals', value: false },
                    { id: 'sold', type: 'apify.input', path: 'sold', op: 'equals', value: false },
                    { id: 'absent', type: 'apify.input', path: 'daysOnZillow', op: 'equals', value: false },
                ],
                ev,
            ),
        );
        expect(r.present.value).toBe(1);
        expect(r.agent.value).toBe(1);
        expect(r.rent.value).toBe(0);
        expect(r.rent.comment).toContain('forRent = true');
        expect(r.sold.value).toBe(0);
        // A flag the agent never set must not count as "false".
        expect(r.absent.value).toBe(0);
    });

    it('apify.items: count, fields, predicates, sets, schema', () => {
        const r = byId(
            runChecks(
                [
                    { id: 'count', type: 'apify.items', count: { min: 3, max: 3 } },
                    { id: 'countMax', type: 'apify.items', count: { max: 1 } },
                    { id: 'fields', type: 'apify.items', requiredFields: ['shortCode', 'likesCount'] },
                    { id: 'fieldsMissing', type: 'apify.items', requiredFields: ['caption'] },
                    { id: 'owner', type: 'apify.items', field: 'ownerUsername', op: 'equals', value: 'nasa' },
                    {
                        id: 'setSuper',
                        type: 'apify.items',
                        field: 'shortCode',
                        set: { mode: 'superset', value: ['C1abc', 'C1def'] },
                    },
                    { id: 'setEq', type: 'apify.items', field: 'shortCode', set: { mode: 'equals', value: ['C1abc'] } },
                    {
                        id: 'schema',
                        type: 'apify.items',
                        jsonSchema: { type: 'object', required: ['shortCode', 'likesCount'] },
                    },
                ],
                evidence,
            ),
        );
        expect(r.count.value).toBe(1);
        expect(r.countMax.value).toBe(0);
        expect(r.fields.value).toBe(1);
        expect(r.fieldsMissing.comment).toContain('1 of 3 items missing caption');
        expect(r.owner.value).toBe(1);
        expect(r.setSuper.value).toBe(1);
        expect(r.setEq.value).toBe(0);
        expect(r.schema.value).toBe(1);
    });

    it('apify.items is not applicable when the dataset was not captured', () => {
        const ev = { ...evidence, datasets: {} };
        const [r] = runChecks([{ id: 'count', type: 'apify.items', count: { min: 1 } }], ev);
        expect(r.applicable).toBe(false);
    });

    it('answer.grounded finds numbers in Actor output and flags invented ones', () => {
        const ok = runChecks([{ id: 'g', type: 'answer.grounded', minDigits: 4 }], evidence)[0];
        // 153,536 (an average) is not in the data; it is the only miss.
        expect(ok.value).toBeCloseTo(0.75, 2);
        expect(ok.comment).toContain('153,536');
        const lenient = runChecks([{ id: 'g', type: 'answer.grounded', minDigits: 4, minFraction: 0.7 }], evidence)[0];
        expect(lenient.passed).toBe(true);
        expect(ok.passed).toBe(false);
        const invented = runChecks([{ id: 'g', type: 'answer.grounded' }], {
            ...evidence,
            finalResult: 'The post has 39,600,000 plays and 3.9M likes.',
        })[0];
        expect(invented.value).toBe(0);
        expect(invented.comment).toContain('39,600,000');
    });

    it('reference: answer value against the fresh run', () => {
        const ev = { ...evidence, finalResult: 'NASA has 104,414,382 followers.' };
        const r = byId(
            runChecks(
                [
                    {
                        id: 'ref',
                        type: 'reference',
                        compare: [
                            {
                                answerRegex: 'followers?[^0-9]{0,20}([\\d,]+)|([\\d,]+) followers',
                                field: 'followersCount',
                                tolerance: 0.02,
                            },
                        ],
                    },
                ],
                ev,
            ),
        );
        expect(r.ref.value).toBe(1);
        const far = runChecks(
            [
                {
                    id: 'ref',
                    type: 'reference',
                    compare: [{ answerRegex: '([\\d,]+) followers', field: 'followersCount', tolerance: 0.02 }],
                },
            ],
            { ...evidence, finalResult: 'NASA has 90,000,000 followers.' },
        )[0];
        expect(far.value).toBe(0);
    });

    it('tool.called and workspace.file', () => {
        const ev: Evidence = {
            ...evidence,
            toolCalls: [
                { tool: 'Bash', input: { command: 'apify actors call apify/instagram-scraper --input-file in.json' } },
            ],
            workspaceFiles: [{ path: 'out/result.json', content: '{"count": 3}' }],
        };
        const r = byId(
            runChecks(
                [
                    { id: 'cli', type: 'tool.called', name: 'Bash', inputRegex: 'apify (actors )?call' },
                    {
                        id: 'file',
                        type: 'workspace.file',
                        path: 'out/*.json',
                        jsonSchema: { type: 'object', required: ['count'] },
                    },
                    { id: 'noFile', type: 'workspace.file', path: 'out/*.csv' },
                ],
                ev,
            ),
        );
        expect(r.cli.value).toBe(1);
        expect(r.file.value).toBe(1);
        expect(r.noFile.value).toBe(0);
    });

    it('workspace.file matches recursive globs', () => {
        const ev: Evidence = {
            ...evidence,
            workspaceFiles: [{ path: 'a/b/c.json' }, { path: 'c.json' }, { path: 'a/b/c.csv' }],
        };
        const r = byId(
            runChecks(
                [
                    { id: 'deep', type: 'workspace.file', path: '**/*.json' },
                    { id: 'oneLevel', type: 'workspace.file', path: 'a/*.json' },
                    { id: 'wrongExt', type: 'workspace.file', path: '**/*.txt' },
                ],
                ev,
            ),
        );
        expect(r.deep.value).toBe(1);
        // `**/` also matches zero directories, so both JSON files are hits.
        expect(r.deep.comment).toContain('a/b/c.json');
        expect(r.deep.comment).toContain('c.json');
        expect(r.oneLevel.value).toBe(0);
        expect(r.wrongExt.value).toBe(0);
    });

    it('answer.grounded does not ground numbers in the agent own tool inputs', () => {
        const ev: Evidence = {
            ...evidence,
            finalResult: 'The account has 123456 followers.',
            datasets: {},
            reference: null,
            toolCalls: [{ tool: 'Bash', input: { command: 'echo 123456' } }],
        };
        const [noPool] = runChecks([{ id: 'g', type: 'answer.grounded' }], ev);
        expect(noPool.applicable).toBe(false);
        const [invented] = runChecks([{ id: 'g', type: 'answer.grounded' }], {
            ...ev,
            datasets: { ds1: [{ followersCount: 999888 }] },
        });
        expect(invented.value).toBe(0);
        expect(invented.comment).toContain('123,456');
    });

    it('reference comparisons only look at the scoped Actor datasets', () => {
        const ev: Evidence = {
            ...evidence,
            actorRuns: [
                { actor: 'wrong/one', runId: 'r0', datasetId: 'dsW', status: 'SUCCEEDED' },
                { actor: 'right/one', runId: 'r1', datasetId: 'dsR', status: 'SUCCEEDED' },
            ],
            datasets: {
                dsW: [{ k: 'x1' }, { k: 'x2' }, { k: 'x3' }, { k: 'x4' }, { k: 'x5' }],
                dsR: [{ k: 'a' }, { k: 'b' }, { k: 'c' }],
            },
            reference: { actor: 'right/one', input: {}, items: [{ k: 'a' }, { k: 'b' }, { k: 'c' }] },
        };
        const compareSpec = [{ itemsOverlap: { keyField: 'k', min: 0.5 } }, { countWithinPct: 20 }];
        const [scoped] = runChecks([{ id: 'ref', type: 'reference', actor: 'right/one', compare: compareSpec }], ev);
        expect(scoped.value).toBe(1);
        // Without the scoping the stray Actor's dataset still counts.
        const [unscoped] = runChecks([{ id: 'ref', type: 'reference', compare: compareSpec }], ev);
        expect(unscoped.value).toBe(0);
    });

    it('severity and generated ids', () => {
        const [warn, auto] = runChecks(
            [{ type: 'answer.contains', value: 'zzz', severity: 'warn' }, { type: 'apify.run' }],
            evidence,
        );
        expect(warn.severity).toBe('warn');
        expect(warn.id).toBe('answer_contains_1');
        expect(auto.id).toBe('apify_run_2');
    });
});

describe('globToRegExp', () => {
    it('keeps ** and * apart and escapes the rest', () => {
        expect(globToRegExp('**/*.json').test('a/b/c.json')).toBe(true);
        expect(globToRegExp('**/*.json').test('c.json')).toBe(true);
        expect(globToRegExp('*.json').test('a/b.json')).toBe(false);
        expect(globToRegExp('out/**').test('out/a/b.csv')).toBe(true);
        expect(globToRegExp('a.b').test('axb')).toBe(false);
    });
});

describe('infraStatus', () => {
    it('flags failed Actor runs and timeouts, not agent failures', () => {
        expect(infraStatus(evidence).ok).toBe(true);
        const bad = infraStatus({
            ...evidence,
            actorRuns: [{ ...evidence.actorRuns[0], status: 'FAILED' }],
            session: { ...evidence.session, timedOut: true },
        });
        expect(bad.ok).toBe(false);
        expect(bad.reasons).toHaveLength(2);
    });
    it('flags an MCP server that exposed no tools', () => {
        const r = infraStatus({
            ...evidence,
            session: {
                ...evidence.session,
                mcpExpected: true,
                mcpToolCount: 0,
                mcpServers: [{ name: 'apify', status: 'connected' }],
            },
        });
        expect(r.ok).toBe(false);
        expect(r.reasons[0]).toContain('no tools');
        const ok = infraStatus({ ...evidence, session: { ...evidence.session, mcpExpected: true, mcpToolCount: 12 } });
        expect(ok.ok).toBe(true);
    });
});

describe('helpers', () => {
    it('extractNumbers normalises commas and suffixes', () => {
        expect(extractNumbers('1,234 and 39.6M and 3.9k and 42', 4)).toEqual([1234, 39_600_000, 3900]);
    });
    it('getPath handles indexes', () => {
        expect(getPath({ a: { b: [{ c: 1 }] } }, 'a.b[0].c')).toBe(1);
    });
    it('compare ops', () => {
        expect(compare(3, 'lte', 3)).toBe(true);
        expect(compare('posts', 'in', ['posts', 'reels'])).toBe(true);
        expect(compare(undefined, 'exists', null)).toBe(false);
    });
});
