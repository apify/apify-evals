import { describe, expect, it } from 'vitest';

import { runChecks, type Evidence } from '../src/checks.js';
import { surfaceApplies, surfacesOfCall, surfacesUsed, validateSurface } from '../src/index.js';

const bash = (command: string) => ({ tool: 'Bash', input: { command } });

describe('surfacesOfCall', () => {
    it('counts only the Apify MCP server as the mcp surface', () => {
        expect(surfacesOfCall('mcp__apify__call-actor', {})).toEqual(['mcp']);
        expect(surfacesOfCall('mcp__notion__API-post-search', {})).toEqual([]);
    });

    it('finds the CLI at a command boundary, also through npx and in pipes', () => {
        for (const command of [
            'apify call apify/google-search-scraper --input-file in.json',
            'cd work && apify actors call apify/instagram-scraper',
            'npx -y apify-cli call apify/web-scraper',
            'echo {} | apify call x/y',
            'apify --version',
        ]) {
            expect(surfacesOfCall('Bash', { command }), command).toEqual(['cli']);
        }
    });

    it('counts mcpc, the MCP CLI client, as the CLI surface', () => {
        expect(surfacesOfCall('Bash', { command: 'mcpc @apify tools-call search-actors keywords:=maps' })).toEqual([
            'cli',
        ]);
        expect(surfacesOfCall('Bash', { command: 'npx -y @apify/mcpc @apify tools-list' })).toEqual(['cli']);
        expect(surfacesOfCall('Bash', { command: 'ls ~/.mcpc' })).toEqual([]);
    });

    it('does not take Apify hosts or paths for the CLI', () => {
        expect(surfacesOfCall('Bash', { command: 'cat ~/.apify/auth.json' })).toEqual([]);
        expect(surfacesOfCall('Bash', { command: 'curl https://docs.apify.com/cli' })).toEqual([]);
    });

    it('finds raw HTTP to the API from Bash and WebFetch', () => {
        expect(
            surfacesOfCall('Bash', {
                command:
                    'curl -s -X POST "https://api.apify.com/v2/acts/apify~web-scraper/runs" -H "Authorization: Bearer $APIFY_TOKEN"',
            }),
        ).toEqual(['api']);
        expect(surfacesOfCall('WebFetch', { url: 'https://api.apify.com/v2/store?search=maps' })).toEqual(['api']);
        expect(surfacesOfCall('WebFetch', { url: 'https://docs.apify.com/api/v2' })).toEqual([]);
    });

    it('reports both when one command uses the CLI and the API', () => {
        expect(surfacesOfCall('Bash', { command: 'apify call a/b && curl api.apify.com/v2/users/me' })).toEqual([
            'cli',
            'api',
        ]);
    });
});

describe('surfacesUsed', () => {
    it('collects every surface once, in a stable order', () => {
        expect(
            surfacesUsed([
                bash('curl https://api.apify.com/v2/users/me'),
                { tool: 'mcp__apify__search-actors', input: {} },
                bash('apify call a/b'),
                bash('ls'),
            ]),
        ).toEqual(['mcp', 'cli', 'api']);
        expect(surfacesUsed([bash('ls')])).toEqual([]);
    });
});

describe('surfaceApplies', () => {
    it('matches the surface name or kind; no list applies everywhere', () => {
        expect(surfaceApplies(undefined, { name: 'cli', kind: 'cli' })).toBe(true);
        expect(surfaceApplies([], { name: 'cli', kind: 'cli' })).toBe(true);
        expect(surfaceApplies(['mcp'], { name: 'mcp-staging', kind: 'mcp' })).toBe(true);
        expect(surfaceApplies(['mcp-staging'], { name: 'mcp-staging', kind: 'mcp' })).toBe(true);
        expect(surfaceApplies(['mcp'], { name: 'cli', kind: 'cli' })).toBe(false);
    });
});

describe('validateSurface', () => {
    it('accepts the built-in shapes and rejects unknown fields', () => {
        expect(
            validateSurface({
                name: 'cli',
                kind: 'cli',
                mcp: false,
                bash: true,
                env: { APIFY_TOKEN: '${APIFY_TOKEN}' },
            }),
        ).toBe(true);
        expect(validateSurface({ name: 'cli', kind: 'cli', mcp: false, shell: true })).toBe(false);
        expect(validateSurface({ name: 'x', kind: 'sdk', mcp: false })).toBe(false);
    });
});

describe('surface.used check', () => {
    const base: Evidence = {
        prompt: 'p',
        finalResult: 'a',
        toolCalls: [],
        actorRuns: [],
        datasets: {},
        surfacesUsed: ['cli', 'api'],
        session: {
            timedOut: false,
            stdoutTruncated: false,
            harnessBroke: false,
            exitCode: 0,
            subtype: 'success',
            surface: { name: 'cli', kind: 'cli' },
        },
    };
    const run = (check: Record<string, unknown>, ev: Evidence = base) =>
        runChecks([{ id: 's', type: 'surface.used', ...check } as never], ev)[0];

    it('defaults to the configured surface kind and names the fallback', () => {
        const r = run({});
        expect(r.passed).toBe(false);
        expect(r.comment).toContain('fell back to api');
        expect(run({}, { ...base, surfacesUsed: ['cli'] }).passed).toBe(true);
    });

    it('takes an explicit only list or an includes kind', () => {
        expect(run({ only: ['cli', 'api'] }).passed).toBe(true);
        expect(run({ includes: 'api' }).passed).toBe(true);
        expect(run({ includes: 'mcp' }).passed).toBe(false);
    });

    it('is not applicable without classification or without a surface to compare with', () => {
        expect(run({}, { ...base, surfacesUsed: undefined }).applicable).toBe(false);
        expect(run({}, { ...base, session: { ...base.session, surface: undefined } }).applicable).toBe(false);
    });
});
