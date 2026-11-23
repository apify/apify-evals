import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { infraStatus, surfacesUsed, type Evidence } from '@apify-evals/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCodeToolName, parseOpenCodeEvents } from '../src/adapters/opencode-events.js';
import {
    buildOpenCodeConfig,
    buildOpenCodeEnv,
    buildOpenCodeRunArgs,
    configDiagnosticsFromLog,
    mcpToolCountFromLog,
    openCodeMcp,
    openCodePermissions,
    openCodeSteps,
    OPENCODE_PROVIDER,
    runOpenCode,
} from '../src/adapters/opencode.js';
import { extractFromTools } from '../src/evidence.js';

// Captured from opencode 2.3.2 (`opencode run --format json`) against a scripted
// chat-completions model and the real Apify MCP server / API.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/opencode-${name}.jsonl`, import.meta.url), 'utf8');

function evidenceOf(parsed: ReturnType<typeof parseOpenCodeEvents>) {
    const calls = parsed.timeline.flatMap((e) => (e.kind === 'assistant' ? e.toolUses : []));
    const results = parsed.timeline.flatMap((e) =>
        e.kind === 'tool_result' ? [{ toolUseId: e.toolUseId, content: e.content, isError: e.isError }] : [],
    );
    return extractFromTools(calls, results);
}

describe('OpenCode event parser', () => {
    it('reads a captured call-actor session like a Claude Code one', () => {
        const parsed = parseOpenCodeEvents(fixture('call-actor'), { mcpServers: ['apify'] });
        expect(parsed.numTurns).toBe(2);
        expect(parsed.toolRounds).toBe(1);
        expect(parsed.errors).toEqual([]);
        expect(parsed.sessionId).toMatch(/^ses_/);
        expect(parsed.timeline.map((e) => e.kind)).toEqual(['assistant', 'tool_result', 'assistant']);
        expect(parsed.timeline[0]).toMatchObject({
            toolUses: [
                {
                    id: 'call_1',
                    name: 'mcp__apify__call-actor',
                    input: { actor: 'apify/hello-world', input: {}, waitSecs: 30 },
                },
            ],
            usage: { input_tokens: expect.any(Number), output_tokens: 10, cache_read_input_tokens: 5 },
        });
        expect(parsed.conversation.map((e) => [e.type, e.tool ?? null])).toEqual([
            ['tool_call', 'mcp__apify__call-actor'],
            ['tool_result', null],
            ['text', null],
        ]);
        expect(parsed.usage).toMatchObject({ output_tokens: 20, cache_read_input_tokens: 10 });
        // The tool result keeps the JSON the evidence extractor reads.
        const evidence = evidenceOf(parsed);
        expect(evidence.toolCalls).toEqual([
            { tool: 'mcp__apify__call-actor', input: { actor: 'apify/hello-world', input: {}, waitSecs: 30 } },
        ]);
        expect(evidence.actorRuns).toMatchObject([
            {
                actor: 'apify/hello-world',
                runId: 'QWAskMNL4ydjKfguF',
                datasetId: 'rQosSH7AjYhDvbhTY',
                status: 'SUCCEEDED',
                input: {},
                origin: 'mcp',
            },
        ]);
    });

    it('records the skills the agent loaded', () => {
        const parsed = parseOpenCodeEvents(fixture('skill'), { mcpServers: ['apify'] });
        expect(parsed.skillsUsed).toEqual(['project-codeword']);
        expect(parsed.conversation[0]).toEqual({
            role: 'assistant',
            type: 'tool_call',
            tool: 'Skill',
            input: { id: 'project-codeword' },
        });
        expect(parsed.finalResult).toBe('TANGERINE-PELICAN-7731');
    });

    it('names shell and web fetch calls as Bash and WebFetch, so the API surface is detected', () => {
        const parsed = parseOpenCodeEvents(fixture('api-surface'));
        const tools = parsed.conversation.flatMap((e) => (e.type === 'tool_call' ? [e.tool] : []));
        expect(tools).toEqual(['Bash', 'WebFetch']);
        expect(surfacesUsed(evidenceOf(parsed).toolCalls)).toEqual(['api']);
        expect(parsed.finalResult).toBe('apify-evals/drive-test');
    });

    it('counts the steps of a session that reached the step limit', () => {
        // maxTurns 2 = 3 steps; the third runs with tools disabled.
        const parsed = parseOpenCodeEvents(fixture('max-steps'), { mcpServers: ['apify'] });
        expect(parsed.numTurns).toBe(3);
        const last = parsed.timeline.at(-1);
        expect(last).toMatchObject({ kind: 'tool_result', isError: true });
        expect(last?.kind === 'tool_result' && last.content).toContain('maximum agent steps');
    });

    it('reports provider errors and retries', () => {
        expect(parseOpenCodeEvents(fixture('provider-error')).errors).toEqual(['Invalid model id']);
        const retry = parseOpenCodeEvents(fixture('retry'));
        expect(retry.errors).toEqual([]);
        expect(retry.retries.length).toBeGreaterThan(0);
        expect(retry.retries[0]).toContain('ECONNREFUSED');
    });

    it('ignores partial lines and repeated tool events', () => {
        const tool = {
            type: 'tool_use',
            timestamp: 5,
            sessionID: 'ses_x',
            part: { id: 't1', tool: 'apify_search-actors', state: { status: 'error', input: { q: 1 }, error: 'boom' } },
        };
        const parsed = parseOpenCodeEvents(
            [
                JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: {} }),
                JSON.stringify(tool),
                JSON.stringify(tool),
                '{"type":"text","part":{"text":"cut',
            ].join('\n'),
            { mcpServers: ['apify'] },
        );
        expect(parsed.timeline).toEqual([
            {
                kind: 'assistant',
                t: 5,
                text: [],
                toolUses: [{ id: 't1', name: 'mcp__apify__search-actors', input: { q: 1 } }],
                usage: null,
            },
            { kind: 'tool_result', t: 5, toolUseId: 't1', content: 'boom', isError: true },
        ]);
        expect(parsed.finalResult).toBe('');
    });

    it('maps OpenCode tool names to Claude Code names', () => {
        expect(openCodeToolName('apify_call-actor', ['apify'])).toBe('mcp__apify__call-actor');
        expect(openCodeToolName('my_srv_tool', ['my', 'my_srv'])).toBe('mcp__my_srv__tool');
        expect(openCodeToolName('notion_x', ['notion.v2'])).toBe('notion_x');
        expect(openCodeToolName('notion_v2_x', ['notion.v2'])).toBe('mcp__notion.v2__x');
        expect(openCodeToolName('shell', [])).toBe('Bash');
        expect(openCodeToolName('webfetch', [])).toBe('WebFetch');
        expect(openCodeToolName('question', [])).toBe('question');
    });
});

describe('OpenCode session config', () => {
    const harness = { kind: 'opencode', model: 'z-ai/glm-5.3', maxTurns: 6 };

    it('gives maxTurns tool rounds plus one text-only step', () => {
        expect(openCodeSteps({}, harness)).toBe(7);
        expect(openCodeSteps({ maxTurns: 2 }, harness)).toBe(3);
    });

    it('connects the Apify MCP server directly, with the tool filter and no token in the file', () => {
        const mcp = openCodeMcp({ tools: ['search-actors', 'call-actor'] }, 'https://mcp.apify.com?x=1');
        expect(mcp).toEqual({
            name: 'apify',
            config: {
                type: 'remote',
                url: 'https://mcp.apify.com/?x=1&tools=search-actors%2Ccall-actor',
                headers: { Authorization: 'Bearer {env:APIFY_TOKEN}' },
                oauth: false,
                codemode: false,
                timeout: { startup: 20000 },
            },
            actions: ['apify_*'],
            envVars: ['APIFY_TOKEN'],
        });
        expect(openCodeMcp({ tools: [] }, 'https://mcp.apify.com')).toBeNull();
    });

    it('allows only the listed tools of a server without the tools filter', () => {
        const mcp = openCodeMcp(
            {
                tools: ['notion-search', 'notion-fetch'],
                mcp: {
                    name: 'notion',
                    transport: 'stdio',
                    command: 'npx',
                    args: ['-y', 'notion-mcp'],
                    env: { NOTION_TOKEN: '${NOTION_TOKEN}' },
                },
            },
            'https://mcp.apify.com',
        );
        expect(mcp?.config).toMatchObject({
            type: 'local',
            command: ['npx', '-y', 'notion-mcp'],
            environment: { NOTION_TOKEN: '{env:NOTION_TOKEN}' },
        });
        expect(mcp?.actions).toEqual(['notion_notion-search', 'notion_notion-fetch']);
        expect(mcp?.envVars).toEqual(['NOTION_TOKEN']);
    });

    it('denies every tool first, then allows the same base tools in every arm', () => {
        const base = openCodePermissions({ mcpActions: ['apify_*'], bash: false, webFetch: false });
        expect(base[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
        expect(base.slice(1).map((r) => [r.action, r.effect])).toEqual([
            ['read', 'allow'],
            ['glob', 'allow'],
            ['grep', 'allow'],
            ['skill', 'allow'],
            ['apify_*', 'allow'],
        ]);
        const api = openCodePermissions({ mcpActions: [], bash: true, webFetch: true }).map((r) => r.action);
        expect(api).toEqual(['*', 'read', 'glob', 'grep', 'skill', 'shell', 'external_directory', 'webfetch']);
        expect(api).not.toContain('websearch');
    });

    it('builds the provider for the proxy and the step limit', () => {
        const mcp = openCodeMcp({ tools: ['search-actors'] }, 'https://mcp.apify.com');
        const config = buildOpenCodeConfig({
            model: '~anthropic/claude-haiku-latest',
            baseURL: OPENCODE_PROVIDER.baseURL,
            steps: 7,
            mcp,
            bash: false,
            webFetch: false,
        });
        expect(config).toMatchObject({
            autoupdate: false,
            share: 'disabled',
            provider: {
                apify: {
                    npm: '@ai-sdk/openai-compatible',
                    options: { baseURL: 'https://openrouter.apify.actor/api/v1', apiKey: '{env:APIFY_TOKEN}' },
                    models: { '~anthropic/claude-haiku-latest': { name: '~anthropic/claude-haiku-latest' } },
                },
            },
            mcp: { servers: { apify: { type: 'remote', codemode: false } } },
            agents: { build: { steps: 7 } },
        });
        expect(buildOpenCodeRunArgs('http://127.0.0.1:1', '~anthropic/claude-haiku-latest')).toEqual([
            'run',
            '--server',
            'http://127.0.0.1:1',
            '--format',
            'json',
            '--title',
            'eval',
            '--model',
            'apify/~anthropic/claude-haiku-latest',
        ]);
    });

    it('points every config and data location into the session home', () => {
        vi.stubEnv('UNRELATED_SECRET', 'must-not-inherit');
        const env = buildOpenCodeEnv({ home: '/s/home', apifyToken: 'tok', password: 'pw' });
        expect(env).toMatchObject({
            HOME: '/s/home',
            XDG_CONFIG_HOME: '/s/home/.config',
            XDG_DATA_HOME: '/s/home/.local/share',
            XDG_CACHE_HOME: '/s/home/.cache',
            XDG_STATE_HOME: '/s/home/.local/state',
            OPENCODE_CONFIG: '/s/home/opencode.json',
            OPENCODE_CONFIG_DIR: '/s/home/.config/opencode',
            OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_DISABLE_MODELS_FETCH: '1',
            OPENCODE_DISABLE_CLAUDE_CODE: '1',
            APIFY_TOKEN: 'tok',
        });
        expect(env).not.toHaveProperty('UNRELATED_SECRET');
        // A surface cannot override the isolation.
        const surface = { name: 'x', kind: 'api', spec: {}, env: { HOME: '/elsewhere', EXTRA: '1' }, secrets: [] };
        expect(
            buildOpenCodeEnv({ home: '/s/home', apifyToken: 'tok', password: 'pw', surface } as never),
        ).toMatchObject({
            HOME: '/s/home',
            EXTRA: '1',
        });
        vi.unstubAllEnvs();
    });

    it('reads the MCP tool count and dropped config entries from the server log', () => {
        const log = [
            'level=WARN message="configuration normalization diagnostic" source=/x/opencode.json path=$.mcp.apify kind=invalid action="skipped malformed recognized value" role=server',
            'level=INFO message="mcp connected" server=apify tools=5 http.span=846 role=server server=apify',
            'level=INFO message="mcp connected" server=apify2 tools=9 http.span=1',
        ].join('\n');
        expect(mcpToolCountFromLog(log, 'apify')).toBe(5);
        expect(mcpToolCountFromLog(log, 'other')).toBeNull();
        expect(configDiagnosticsFromLog(log)).toEqual(['$.mcp.apify: skipped malformed recognized value']);
    });
});

describe('runOpenCode process handling', () => {
    let dir: string;
    let ctx: Parameters<typeof runOpenCode>[0];
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'opencode-adapter-test-'));
        vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
        vi.stubEnv('UNRELATED_SECRET', 'must-not-inherit');
        ctx = {
            prompt: 'Find a crawler. Unicode: žluťoučký.',
            item: { metadata: { tools: ['call-actor'] } },
            harness: { kind: 'opencode', model: 'z-ai/glm-5.3', maxTurns: 6 },
            mcpUrl: 'https://mcp.invalid',
            apifyToken: 'test-token-not-a-secret',
            mcpEnv: { APIFY_TOKEN: 'test-token-not-a-secret' },
            skillSet: [],
            skillsRoot: '/nonexistent',
            runMarker: 'apify-evals/test',
            perItemTimeoutSecs: 20,
        };
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    });

    /**
     * A fake `opencode`: `serve` answers /api/mcp and /api/skill and writes the
     * server log; `run` records what it got and prints `runOutput`.
     */
    function stub(opts: { mcpStatus?: string; runOutput?: string; runBody?: string; logLines?: string[] } = {}): void {
        const script = `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const [cmd] = process.argv.slice(2);
if (cmd === 'serve') {
    const logDir = path.join(process.env.XDG_DATA_HOME, 'opencode', 'log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'opencode.log'), ${JSON.stringify(
        (opts.logLines ?? ['level=INFO message="mcp connected" server=apify tools=5 http.span=1']).join('\n') + '\n',
    )});
    const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
    const server = http.createServer((req, res) => {
        if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/mcp') res.end(JSON.stringify({ data: [{ name: 'apify', status: { status: ${JSON.stringify(opts.mcpStatus ?? 'connected')}, error: 'down "retryAfter":0' } }] }));
        else if (req.url === '/api/skill') {
            const skills = fs.existsSync(path.join(process.cwd(), '.opencode/skills')) ? fs.readdirSync(path.join(process.cwd(), '.opencode/skills')) : [];
            res.end(JSON.stringify({ data: [{ id: 'opencode' }, ...skills.map((id) => ({ id }))] }));
        } else res.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port }) + '\\n'));
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
} else {
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (prompt += c));
    process.stdin.on('end', () => {
        fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({
            args: process.argv.slice(2), prompt, cwd: process.cwd(), env: process.env,
            config: fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8'),
            skills: fs.existsSync('.opencode/skills') ? fs.readdirSync('.opencode/skills') : [],
        }));
        ${opts.runBody ?? `process.stdout.write(${JSON.stringify(opts.runOutput ?? fixture('call-actor'))});`}
    });
}
`;
        writeFileSync(join(dir, 'opencode'), script);
        chmodSync(join(dir, 'opencode'), 0o755);
    }

    it('starts the server, waits for MCP, sends the prompt on stdin and cleans up', async () => {
        stub();
        const result = await runOpenCode(ctx);
        expect(result.harnessBroke).toBe(false);
        expect(result.metrics).toMatchObject({
            exitCode: 0,
            subtype: 'success',
            numTurns: 2,
            mcpToolCount: 5,
            mcpServers: [{ name: 'apify', status: 'connected' }],
            mcpExpected: true,
            mcpRestarts: 0,
            skillsLoaded: [],
        });
        expect(result.output).toContain('runId');
        const captured = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
        expect(captured.prompt).toBe(ctx.prompt);
        expect(captured.args.slice(0, 2)).toEqual(['run', '--server']);
        expect(captured.args.slice(3)).toEqual([
            '--format',
            'json',
            '--title',
            'eval',
            '--model',
            'apify/z-ai/glm-5.3',
        ]);
        expect(captured.env.UNRELATED_SECRET).toBeUndefined();
        expect(captured.env.HOME).not.toBe(process.env.HOME);
        expect(captured.env.PWD).toBe(captured.cwd);
        expect(captured.config).not.toContain(ctx.apifyToken);
        expect(captured.config).toContain('tools=call-actor');
        expect(existsSync(captured.env.HOME)).toBe(false);
        expect(existsSync(captured.cwd)).toBe(false);
    });

    it('installs the skill set as OpenCode project skills and reports which loaded', async () => {
        const root = mkdtempSync(join(tmpdir(), 'opencode-skills-'));
        mkdirSync(join(root, 'apify-ultimate-scraper'));
        writeFileSync(join(root, 'apify-ultimate-scraper', 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
        stub({ runOutput: fixture('skill') });
        const result = await runOpenCode({ ...ctx, skillSet: ['apify-ultimate-scraper'], skillsRoot: root });
        const captured = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
        expect(captured.skills).toEqual(['apify-ultimate-scraper']);
        expect(result.metrics).toMatchObject({
            skillsLoaded: ['apify-ultimate-scraper'],
            skillsUsed: ['project-codeword'],
        });
        rmSync(root, { recursive: true, force: true });
    });

    it('restarts a session whose MCP server failed and then reports it inconclusive', async () => {
        stub({ mcpStatus: 'failed' });
        const result = await runOpenCode(ctx);
        expect(result.harnessBroke).toBe(false);
        expect(result.metrics).toMatchObject({
            subtype: 'error_mcp_startup',
            mcpRestarts: 3,
            mcpToolCount: 0,
            mcpToolsMissing: true,
            mcpServers: [{ name: 'apify', status: 'failed' }],
        });
        expect(existsSync(join(dir, 'capture.json'))).toBe(false);
        const infra = infraStatus({
            prompt: '',
            finalResult: '',
            actorRuns: [],
            datasets: {},
            toolCalls: [],
            session: { ...result.metrics, harnessBroke: result.harnessBroke },
        } as Evidence);
        expect(infra.ok).toBe(false);
    });

    it('refuses to run when OpenCode dropped part of the config', async () => {
        stub({
            logLines: [
                'level=WARN message="configuration normalization diagnostic" path=$.mcp.servers.apify kind=invalid action="skipped malformed recognized value"',
            ],
        });
        const result = await runOpenCode(ctx);
        expect(result.harnessBroke).toBe(true);
        expect(result.stderr).toContain('$.mcp.servers.apify');
        expect(existsSync(join(dir, 'capture.json'))).toBe(false);
    });

    it('scores a step-limit session as max turns, not as broken', async () => {
        stub({ runOutput: fixture('max-steps') });
        const result = await runOpenCode({ ...ctx, item: { metadata: { tools: ['call-actor'], maxTurns: 2 } } });
        expect(result.harnessBroke).toBe(false);
        expect(result.metrics).toMatchObject({ subtype: 'error_max_turns', numTurns: 3 });
        const captured = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
        expect(JSON.parse(captured.config).agents.build.steps).toBe(3);
    });

    it('treats a provider error as a broken session', async () => {
        stub({ runBody: `process.stdout.write(${JSON.stringify(fixture('provider-error'))}); process.exitCode = 1;` });
        const result = await runOpenCode({ ...ctx, item: { metadata: {} } });
        expect(result.harnessBroke).toBe(true);
        expect(result.stderr).toContain('Invalid model id');
        expect(result.metrics).toMatchObject({ subtype: 'error_session', exitCode: 1, mcpServers: [] });
    });

    it('times out the process groups and keeps the partial session', async () => {
        stub({
            runBody: `process.stdout.write(${JSON.stringify(fixture('retry'))}); setInterval(() => {}, 1000);`,
        });
        const result = await runOpenCode({ ...ctx, perItemTimeoutSecs: 3 });
        expect(result.harnessBroke).toBe(false);
        expect(result.metrics).toMatchObject({ timedOut: true, subtype: 'error_timeout' });
        expect(result.stderr).toContain('retrying: ECONNREFUSED');
    });

    it('never puts the token into the stored log', async () => {
        stub({
            runOutput: [
                JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: {} }),
                JSON.stringify({
                    type: 'text',
                    timestamp: 1,
                    sessionID: 'ses_x',
                    part: { text: `token ${ctx.apifyToken}` },
                }),
            ].join('\n'),
        });
        const result = await runOpenCode({ ...ctx, item: { metadata: {} } });
        expect(result.rawStdout).not.toContain(ctx.apifyToken);
        expect(result.output).toBe('token [REDACTED]');
    });
});
