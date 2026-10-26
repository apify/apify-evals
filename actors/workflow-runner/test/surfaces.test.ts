import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildClaudeArgs, buildClaudeEnv } from '../src/harness.js';
import {
    MARKER_PRELOAD,
    cliShim,
    curlrc,
    installCliShim,
    loadSurface,
    mcpcConnectUrl,
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
        expect(s.mcpc).toEqual({ package: '@apify/mcpc', version: '0.7.0' });
    });

    it('takes the run-level mcpc version override', () => {
        expect(resolveSurface(cli, { env: { APIFY_TOKEN: 't' }, mcpcVersion: 'beta' }).mcpc?.version).toBe('beta');
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

    it('puts the session shim first on PATH', () => {
        expect(sessionPath('/usr/bin', undefined)).toBe('/usr/bin');
        expect(sessionPath('/usr/bin', '/s/bin')).toBe('/s/bin:/usr/bin');
    });

    it('runs the CLI with its own empty HOME, so it never sees the developer login', () => {
        const { binDir, script } = cliShim('/tmp/s', { ...cli, cliBinDir: '/opt/cli/bin' });
        expect(binDir).toBe('/tmp/s/bin');
        expect(script).toBe(
            "#!/bin/sh\nexport APIFY_DISABLE_KEYRING=1\nHOME='/tmp/s/cli-home' exec '/opt/cli/bin/apify' \"$@\"\n",
        );
    });

    it('marks the CLI requests with the session marker through a Node preload', () => {
        const { script } = cliShim('/tmp/s', { ...cli, cliBinDir: '/opt/cli/bin' }, 'apify-evals/abc');
        expect(script).toContain("export APIFY_EVALS_MARKER='apify-evals/abc'");
        expect(script).toContain('export NODE_OPTIONS="--import=/tmp/s/bin/apify-evals-marker.mjs $NODE_OPTIONS"');
    });

    it('the preload appends the marker to api.apify.com requests only', async () => {
        const home = mkdtempSync(join(tmpdir(), 'preload-'));
        try {
            const file = join(home, 'mark.mjs');
            writeFileSync(file, MARKER_PRELOAD);
            const probe = [
                "import https from 'node:https';",
                "const a = https.request('https://api.apify.com/v2/users/me', { headers: { 'User-Agent': 'ApifyClient/2' } });",
                "const b = https.request('https://example.com/');",
                "console.log(JSON.stringify([a.getHeader('user-agent'), b.getHeader('user-agent') ?? null]));",
                // No traffic: drop both requests before they connect.
                "for (const r of [a, b]) { r.on('error', () => {}); r.destroy(); }",
            ].join('\n');
            const out = execFileSync(process.execPath, [`--import=${file}`, '--input-type=module', '-e', probe], {
                encoding: 'utf8',
                env: { ...process.env, APIFY_EVALS_MARKER: 'apify-evals/abc' },
            });
            expect(JSON.parse(out)).toEqual(['ApifyClient/2 apify-evals/abc', null]);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it('runs mcpc with its own state folder in the session', () => {
        const { mcpcScript } = cliShim('/tmp/s', { ...cli, mcpcBinDir: '/opt/mcpc/bin' });
        expect(mcpcScript).toBe("#!/bin/sh\nexport MCPC_HOME_DIR='/tmp/s/mcpc'\nexec '/opt/mcpc/bin/mcpc' \"$@\"\n");
    });

    it('hides any apify or mcpc on PATH on a surface without them', () => {
        expect(cliShim('/tmp/s', api).script).toContain('exit 127');
        expect(cliShim('/tmp/s', api).mcpcScript).toContain('mcpc: command not found');
    });

    it('works end to end: the shim answers and keeps HOME apart', () => {
        const home = mkdtempSync(join(tmpdir(), 'shim-'));
        try {
            const fakeBin = join(home, 'fake');
            mkdirSync(fakeBin);
            writeFileSync(join(fakeBin, 'apify'), '#!/bin/sh\necho "home=$HOME args=$*"\n', { mode: 0o755 });
            const dir = installCliShim(home, { ...cli, cliBinDir: fakeBin });
            const out = execFileSync(join(dir, 'apify'), ['call', 'a/b'], { encoding: 'utf8' });
            expect(out.trim()).toBe(`home=${join(home, 'cli-home')} args=call a/b`);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it('marks the curl user agent with the session marker', () => {
        expect(curlrc('apify-evals/abc')).toBe('user-agent = "apify-evals/abc curl"\n');
    });
});

describe('mcpcConnectUrl', () => {
    const mcpUrl = 'https://mcp.apify.com/?telemetry=false';

    it('narrows the Apify MCP server to the scenario tools, as the mcp surface does', () => {
        expect(mcpcConnectUrl({ tools: ['search-actors', 'call-actor'] }, mcpUrl)).toBe(
            'https://mcp.apify.com/?telemetry=false&tools=search-actors%2Ccall-actor',
        );
    });

    it('keeps the bare URL when the scenario has no tools or names another MCP server', () => {
        expect(mcpcConnectUrl({}, mcpUrl)).toBe(mcpUrl);
        expect(mcpcConnectUrl({ tools: [] }, mcpUrl)).toBe(mcpUrl);
        expect(
            mcpcConnectUrl(
                {
                    tools: ['notion-search'],
                    mcp: { name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp' },
                },
                mcpUrl,
            ),
        ).toBe(mcpUrl);
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
        // No MCP config still means strict: no developer or claude.ai connector servers.
        expect(args).toContain('--strict-mcp-config');
    });

    it('gives the session the surface env, the CLI on PATH and the curl marker home', () => {
        const env = buildClaudeEnv({
            home: '/tmp/session',
            harness,
            apifyToken: 'runner-token',
            useOpenRouterProxy: true,
            surface: api,
            shimDir: '/tmp/session/bin',
        });
        expect(env.APIFY_TOKEN).toBe('apify_api_secret');
        expect(env.CURL_HOME).toBe('/tmp/session');
        expect(env.PATH?.startsWith('/tmp/session/bin:')).toBe(true);
        expect(env.APIFY_CLI_SKIP_UPDATE_CHECK).toBe('1');
        // The harness settings win over anything a surface sets.
        expect(env.HOME).toBe('/tmp/session');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('runner-token');
    });
});
