import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildClaudeArgs, buildClaudeEnv } from '../src/harness.js';
import {
    curlrc,
    loadSurface,
    parseCliVersion,
    resolveSurface,
    resolveSurfaceNames,
    sessionPath,
    surfaceAllowedTools,
    surfaceItemMetadata,
    surfacePrompt,
    surfacesRoot,
} from '../src/surfaces.js';

const root = surfacesRoot({}, join(import.meta.dirname, '..'));

describe('surface files in this repo', () => {
    it('load and validate mcp, cli and api', () => {
        expect(loadSurface(root, 'mcp')).toMatchObject({ name: 'mcp', kind: 'mcp', mcp: true });
        expect(loadSurface(root, 'cli')).toMatchObject({
            kind: 'cli',
            mcp: false,
            bash: true,
            cli: { version: '1.10.0' },
        });
        expect(loadSurface(root, 'api')).toMatchObject({ kind: 'api', mcp: false, bash: true, webFetch: true });
    });

    it('fail fast on an unknown or invalid name', () => {
        expect(() => loadSurface(root, 'sdk')).toThrow(/Unknown surface "sdk"/);
        expect(() => loadSurface(root, '../profiles/store-actors')).toThrow(/Invalid surface name/);
    });
});

describe('resolveSurfaceNames', () => {
    it('defaults to mcp and deduplicates', () => {
        expect(resolveSurfaceNames(undefined)).toEqual(['mcp']);
        expect(resolveSurfaceNames([])).toEqual(['mcp']);
        expect(resolveSurfaceNames(['cli', ' cli ', 'api'])).toEqual(['cli', 'api']);
    });
});

describe('resolveSurface', () => {
    const cli = loadSurface(root, 'cli');

    it('fills the environment from the runner and records the secrets', () => {
        const s = resolveSurface(cli, { env: { APIFY_TOKEN: 'apify_api_secret' } });
        expect(s.env).toEqual({ APIFY_TOKEN: 'apify_api_secret' });
        expect(s.secrets).toEqual(['apify_api_secret']);
        expect(s.cli).toEqual({ package: 'apify-cli', version: '1.10.0' });
    });

    it('takes the run-level CLI version override', () => {
        expect(resolveSurface(cli, { env: { APIFY_TOKEN: 't' }, cliVersion: 'beta' }).cli?.version).toBe('beta');
        expect(resolveSurface(cli, { env: { APIFY_TOKEN: 't' }, cliVersion: ' ' }).cli?.version).toBe('1.10.0');
    });

    it('fails when a placeholder has no value', () => {
        expect(() => resolveSurface(cli, { env: {} })).toThrow(/surface "cli" needs APIFY_TOKEN/);
    });
});

describe('the session a surface builds', () => {
    const env = { APIFY_TOKEN: 't' };
    const mcp = resolveSurface(loadSurface(root, 'mcp'), { env });
    const cli = resolveSurface(loadSurface(root, 'cli'), { env });
    const api = resolveSurface(loadSurface(root, 'api'), { env });
    const item = { tools: ['call-actor', 'search-actors'], maxTurns: 12 };

    it('keeps the item as is on mcp, drops MCP and turns on Bash on cli and api', () => {
        expect(surfaceItemMetadata(item, undefined)).toBe(item);
        expect(surfaceItemMetadata(item, mcp)).toEqual(item);
        expect(surfaceItemMetadata(item, cli)).toEqual({ tools: [], maxTurns: 12, allowBash: true });
        expect(surfaceItemMetadata(item, api)).toEqual({ tools: [], maxTurns: 12, allowBash: true });
    });

    it('adds WebFetch on api only', () => {
        expect(surfaceAllowedTools(mcp)).toEqual([]);
        expect(surfaceAllowedTools(cli)).toEqual([]);
        expect(surfaceAllowedTools(api)).toEqual(['WebFetch']);
    });

    it('appends the prompt suffix', () => {
        expect(surfacePrompt('Task.', mcp)).toBe('Task.');
        expect(surfacePrompt('Task.', api)).toMatch(/^Task\.\n\nYou can call the Apify API/);
    });

    it('puts the installed CLI first on PATH', () => {
        expect(sessionPath('/usr/bin', cli)).toBe('/usr/bin');
        expect(sessionPath('/usr/bin', { ...cli, cliBinDir: '/opt/cli/bin' })).toBe('/opt/cli/bin:/usr/bin');
    });

    it('marks the curl user agent with the session marker', () => {
        expect(curlrc('apify-evals/abc')).toBe('user-agent = "apify-evals/abc curl"\n');
    });
});

describe('parseCliVersion', () => {
    it('reads the version from `apify --version`', () => {
        expect(parseCliVersion('apify-cli/1.7.0 (1832d57) running on darwin-arm64 with node-26.4.0')).toBe('1.7.0');
        expect(parseCliVersion('nope')).toBeNull();
    });
});

describe('Claude Code session setup per surface', () => {
    const api = resolveSurface(loadSurface(root, 'api'), { env: { APIFY_TOKEN: 'apify_api_secret' } });
    const harness = { kind: 'claude-code', model: 'anthropic/claude-haiku-4.5', maxTurns: 6 };

    it('allows Bash and WebFetch on api, and no MCP server', () => {
        const args = buildClaudeArgs({
            prompt: 'p',
            meta: surfaceItemMetadata({ tools: ['call-actor'] }, api),
            harness,
            mcpConfigPath: null,
            extraAllowedTools: surfaceAllowedTools(api),
        });
        expect(args[args.indexOf('--allowedTools') + 1]).toBe('Bash WebFetch');
        expect(args).not.toContain('--mcp-config');
    });

    it('gives the session the surface env, the CLI on PATH and the curl marker home', () => {
        const env = buildClaudeEnv({
            home: '/tmp/session',
            harness,
            apifyToken: 'runner-token',
            useOpenRouterProxy: true,
            surface: { ...api, cliBinDir: '/opt/cli/bin' },
        });
        expect(env.APIFY_TOKEN).toBe('apify_api_secret');
        expect(env.CURL_HOME).toBe('/tmp/session');
        expect(env.PATH?.startsWith('/opt/cli/bin:')).toBe(true);
        // The harness settings win over anything a surface sets.
        expect(env.HOME).toBe('/tmp/session');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('runner-token');
    });
});
