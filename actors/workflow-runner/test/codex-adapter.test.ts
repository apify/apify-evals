import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { infraStatus, type Evidence } from '@apify-evals/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { codexSkillsRead, parseCodexEvents } from '../src/adapters/codex-events.js';
import { probeCodexSandbox, runCodex } from '../src/adapters/codex.js';
import { extractFromTools } from '../src/evidence.js';

const mcp = vi.hoisted(() => ({ listTools: vi.fn(), connect: vi.fn(), close: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
        connect = mcp.connect;
        listTools = mcp.listTools;
        close = mcp.close;
    },
}));

const fixture = readFileSync(new URL('./fixtures/codex-mcp.jsonl', import.meta.url), 'utf8');
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

function sessionInfra(result: Awaited<ReturnType<typeof runCodex>>) {
    return infraStatus({
        prompt: '',
        finalResult: result.output,
        actorRuns: [],
        datasets: {},
        toolCalls: [],
        session: { ...result.metrics, harnessBroke: result.harnessBroke },
    } as Evidence);
}

describe('Codex event parser', () => {
    it('rebuilds generations and MCP observations from a captured CLI session', () => {
        const parsed = parseCodexEvents(fixture, [1, 2, 3, 4, 5, 6, 7]);
        expect(parsed.completed).toBe(true);
        expect(parsed.failed).toBe(false);
        expect(parsed.numTurns).toBe(2);
        expect(parsed.toolRounds).toBe(1);
        expect(parsed.timeline.map((e) => [e.kind, e.t])).toEqual([
            ['assistant', 4],
            ['tool_result', 5],
            ['assistant', 6],
        ]);
        expect(parsed.timeline[0]).toMatchObject({
            toolUses: [
                {
                    id: 'item_1',
                    name: 'mcp__apify__search-actors',
                    input: { keywords: 'website content crawler', limit: 1 },
                },
            ],
            usage: null,
        });
        expect(parsed.usage).toMatchObject({ input_tokens: 23035, output_tokens: 212, cached_input_tokens: 10624 });
        expect(parsed.finalResult).toContain('apify/website-content-crawler');
        expect(parsed.conversation.map((e) => e.type)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
    });

    it('preserves structured Actor and dataset evidence without changing downstream extraction', () => {
        const call = (id: string, tool: string, args: unknown, result: unknown) => ({
            type: 'item.completed',
            item: {
                id,
                type: 'mcp_tool_call',
                server: 'apify',
                tool,
                arguments: args,
                result,
                error: null,
                status: 'completed',
            },
        });
        const parsed = parseCodexEvents(
            jsonl(
                call(
                    'run',
                    'call-actor',
                    { actor: 'apify/example', input: { limit: 2 } },
                    {
                        structured_content: {
                            runId: '12345678901234567',
                            status: 'SUCCEEDED',
                            defaultDatasetId: 'dataset1234567890',
                        },
                    },
                ),
                call(
                    'items',
                    'get-dataset-items',
                    { datasetId: 'dataset1234567890' },
                    { content: [{ type: 'text', text: '[]' }] },
                ),
            ),
        );
        const calls = parsed.timeline.flatMap((e) => (e.kind === 'assistant' ? e.toolUses : []));
        const results = parsed.timeline.flatMap((e) => (e.kind === 'tool_result' ? [e] : []));
        const evidence = extractFromTools(calls, results);
        expect(evidence.actorRuns).toMatchObject([
            { actor: 'apify/example', runId: '12345678901234567', status: 'SUCCEEDED', input: { limit: 2 } },
        ]);
        expect(evidence.datasetsRead).toEqual(['dataset1234567890']);
    });

    it('handles parallel calls, repeated updates, MCP errors, reasoning, and partial output', () => {
        const tool = (id: string) => ({
            id,
            type: 'mcp_tool_call',
            server: 'apify',
            tool: 'get-actor-run',
            arguments: {},
        });
        const parsed = parseCodexEvents(
            jsonl(
                { type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'Check both runs.' } },
                { type: 'item.started', item: tool('a') },
                { type: 'item.started', item: tool('b') },
                { type: 'item.updated', item: tool('a') },
                { type: 'item.completed', item: { ...tool('a'), status: 'failed', error: { message: 'not found' } } },
                { type: 'item.completed', item: { ...tool('a'), status: 'failed', error: { message: 'not found' } } },
                {
                    type: 'item.completed',
                    item: {
                        ...tool('b'),
                        status: 'completed',
                        result: { content: [{ type: 'text', text: '{"status":"RUNNING"}' }] },
                    },
                },
            ) + '\nnot-json\n{"type":',
        );
        expect(parsed.toolRounds).toBe(1);
        expect(parsed.timeline).toHaveLength(3);
        expect(parsed.timeline[0]).toMatchObject({ text: ['[Reasoning] Check both runs.'] });
        expect(parsed.timeline[1]).toMatchObject({ isError: true, toolUseId: 'a' });
        expect(parsed.timeline[2]).toMatchObject({ isError: false, content: '{"status":"RUNNING"}' });
        expect(parsed.finalResult).toBe('');
    });

    it('distinguishes metadata warnings from a failed turn and does not invent usage', () => {
        const failure = parseCodexEvents(
            readFileSync(new URL('./fixtures/codex-provider-failure.jsonl', import.meta.url), 'utf8'),
        );
        expect(failure.failed).toBe(true);
        expect(failure.completed).toBe(false);
        expect(failure.timeline).toEqual([]);
        expect(failure.usage).toBeNull();
        const good = parseCodexEvents(
            jsonl(
                { type: 'item.completed', item: { id: 'warning', type: 'error', message: 'Metadata unavailable' } },
                { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'OK' } },
                { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 1 } },
            ),
        );
        expect(good.failed).toBe(false);
        expect(good.timeline[0]).toMatchObject({
            usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 1 },
        });
    });

    it('records shell commands as Bash tool calls with their output', () => {
        const cmd = (status: string, extra: object = {}) => ({
            id: 'c1',
            type: 'command_execution',
            command: "/bin/bash -lc 'cat SKILL.md'",
            status,
            ...extra,
        });
        const parsed = parseCodexEvents(
            jsonl(
                { type: 'item.started', item: cmd('in_progress', { aggregated_output: '', exit_code: null }) },
                { type: 'item.completed', item: cmd('completed', { aggregated_output: 'skill body', exit_code: 0 }) },
                { type: 'item.started', item: { id: 'c2', type: 'command_execution', command: 'touch x' } },
                {
                    type: 'item.completed',
                    item: {
                        id: 'c2',
                        type: 'command_execution',
                        command: 'touch x',
                        aggregated_output: 'Read-only file system',
                        exit_code: 1,
                        status: 'failed',
                    },
                },
                { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'done' } },
            ),
        );
        expect(parsed.timeline[0]).toMatchObject({
            toolUses: [{ id: 'c1', name: 'Bash', input: { command: "/bin/bash -lc 'cat SKILL.md'" } }],
        });
        expect(parsed.timeline[1]).toMatchObject({ kind: 'tool_result', content: 'skill body', isError: false });
        expect(parsed.timeline[3]).toMatchObject({ kind: 'tool_result', isError: true });
        expect(parsed.timeline.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
        expect(parsed.conversation.map((e) => e.type)).toEqual([
            'tool_call',
            'tool_result',
            'tool_call',
            'tool_result',
            'text',
        ]);
        expect(parsed.toolRounds).toBe(2);
    });

    it('records which injected skills the agent opened', () => {
        const events = jsonl(
            {
                type: 'item.completed',
                item: {
                    id: 'c1',
                    type: 'command_execution',
                    command: "/bin/bash -lc 'cat /tmp/s/home/.agents/skills/alpha/SKILL.md'",
                    aggregated_output: 'body',
                    exit_code: 0,
                    status: 'completed',
                },
            },
            {
                type: 'item.started',
                item: {
                    id: 'm1',
                    type: 'mcp_tool_call',
                    server: 'fs',
                    tool: 'read',
                    arguments: { path: '/tmp/s/home/.agents/skills/beta/SKILL.md' },
                },
            },
            {
                type: 'item.completed',
                item: { id: 'a', type: 'agent_message', text: 'skills/gamma/SKILL.md is only mentioned' },
            },
        );
        expect(codexSkillsRead(events, ['alpha', 'beta', 'gamma'])).toEqual(['alpha', 'beta']);
        expect(codexSkillsRead(events, [])).toEqual([]);
        expect(codexSkillsRead(fixture, ['alpha'])).toEqual([]);
    });
});

describe('Codex process adapter (stub executable, no network)', () => {
    let dir: string;
    let ctx: Parameters<typeof runCodex>[0];
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'codex-adapter-test-'));
        vi.stubEnv('PATH', dir);
        mcp.connect.mockReset().mockResolvedValue(undefined);
        mcp.close.mockReset().mockResolvedValue(undefined);
        mcp.listTools.mockReset().mockResolvedValue({ tools: [{ name: 'search-actors' }] });
        ctx = {
            prompt: 'Find a crawler. Unicode: žluťoučký.',
            item: { metadata: { tools: ['search-actors'] } },
            harness: { kind: 'codex', model: 'openai/gpt-5-mini', maxTurns: 12 },
            mcpUrl: 'https://mcp.invalid?existing=1',
            apifyToken: 'test-token-not-a-secret',
            useOpenRouterProxy: true,
            perItemTimeoutSecs: 5,
        };
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    });

    function stub(body: string): void {
        const script = `#!${process.execPath}
const fs = require('node:fs');
const capturePath = ${JSON.stringify(join(dir, 'capture.json'))};
const fixture = ${JSON.stringify(fixture)};
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
    const home = process.env.CODEX_HOME;
    fs.writeFileSync(capturePath, JSON.stringify({
        args: process.argv.slice(2), prompt, cwd: process.cwd(), home,
        config: fs.readFileSync(home + '/config.toml', 'utf8'),
        envKeys: Object.keys(process.env),
        skills: fs.existsSync(home + '/.agents/skills') ? fs.readdirSync(home + '/.agents/skills') : [],
        skillBody: fs.existsSync(home + '/.agents/skills/alpha/SKILL.md')
            ? fs.readFileSync(home + '/.agents/skills/alpha/SKILL.md', 'utf8')
            : null,
        workEntries: fs.readdirSync(process.cwd()),
    }));
    ${body}
});
`;
        writeFileSync(join(dir, 'codex'), script);
        chmodSync(join(dir, 'codex'), 0o755);
    }

    it('passes stdin, isolates config/environment, retains events, and cleans up', async () => {
        vi.stubEnv('UNRELATED_SECRET', 'must-not-inherit');
        stub('process.stdout.write(fixture);');
        const result = await runCodex(ctx);
        expect(result.harnessBroke).toBe(false);
        expect(result.metrics).toMatchObject({
            exitCode: 0,
            mcpToolCount: 1,
            mcpExpected: true,
            mcpRestarts: 0,
            numTurns: 2,
        });
        expect(result.timeline).toHaveLength(3);
        const captured = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
        expect(captured.prompt).toBe(ctx.prompt);
        expect(captured.args).toEqual([
            'exec',
            '--json',
            '--ephemeral',
            '--skip-git-repo-check',
            '--ignore-rules',
            '-C',
            join(captured.home, '..', 'work'),
            '--model',
            ctx.harness.model,
            '-',
        ]);
        expect(captured.envKeys).not.toContain('UNRELATED_SECRET');
        expect(captured.config).toContain('wire_api = "responses"');
        expect(captured.config).toContain('shell_tool = true');
        expect(captured.config).toContain('inherit = "none"');
        // The shell gets the session HOME and a system PATH, never a login shell.
        expect(captured.config).toContain('allow_login_shell = false');
        expect(captured.config).toContain(
            `set = { HOME = ${JSON.stringify(captured.home)}, PATH = "/usr/local/bin:/usr/bin:/bin" }`,
        );
        expect(captured.config.indexOf('allow_login_shell')).toBeLessThan(captured.config.indexOf('['));
        expect(captured.config).toContain('web_search = "disabled"');
        expect(captured.config).toContain('approval_policy = "never"');
        expect(captured.config).toContain('sandbox_mode = "read-only"');
        expect(captured.config).toContain('required = true');
        expect(captured.config).toContain('default_tools_approval_mode = "approve"');
        expect(captured.config).toContain('existing=1&tools=search-actors');
        expect(captured.config).not.toContain(ctx.apifyToken);
        expect(captured.home).not.toBe(captured.cwd);
        expect(existsSync(captured.home)).toBe(false);
        expect(existsSync(captured.cwd)).toBe(false);
        expect(mcp.close).toHaveBeenCalledOnce();
    });

    it('installs skills where Codex discovers them and keeps the config of the no-skills variant', async () => {
        const skillsRoot = mkdtempSync(join(tmpdir(), 'codex-skills-root-'));
        try {
            for (const name of ['alpha', 'beta']) {
                mkdirSync(join(skillsRoot, name, 'references'), { recursive: true });
                writeFileSync(join(skillsRoot, name, 'SKILL.md'), `---\nname: ${name}\ndescription: t\n---\nbody\n`);
                writeFileSync(join(skillsRoot, name, 'references', 'notes.md'), 'notes');
            }
            const read = jsonl({
                type: 'item.completed',
                item: {
                    id: 'c1',
                    type: 'command_execution',
                    command: 'cat ~/.agents/skills/alpha/SKILL.md',
                    status: 'completed',
                },
            });
            stub(`process.stdout.write(${JSON.stringify(`${read}\n`)} + fixture);`);
            const baseline = await runCodex(ctx);
            const plain = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
            expect(plain.skills).toEqual([]);
            expect(baseline.metrics).toMatchObject({ skillsLoaded: [], skillsRead: [] });

            const result = await runCodex({ ...ctx, skillSet: ['alpha'], skillsRoot });
            const withSkills = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
            expect(withSkills.skills).toEqual(['alpha']);
            expect(withSkills.skillBody).toContain('body');
            expect(withSkills.workEntries).toEqual([]);
            // Only the skill files differ between the variants, never the Codex config.
            // The session HOME is a fresh temporary path in every session.
            expect(withSkills.config.replaceAll(withSkills.home, '<home>')).toBe(
                plain.config.replaceAll(plain.home, '<home>'),
            );
            expect(result.metrics).toMatchObject({ skillsLoaded: ['alpha'], skillsRead: ['alpha'] });
            expect(result.harnessBroke).toBe(false);
        } finally {
            rmSync(skillsRoot, { recursive: true, force: true });
        }
    });

    it('retries zero MCP tools once before spawning', async () => {
        mcp.listTools.mockResolvedValueOnce({ tools: [] });
        stub('process.stdout.write(fixture);');
        const result = await runCodex(ctx);
        expect(result.metrics).toMatchObject({ mcpRestarts: 1, mcpToolCount: 1, mcpToolsMissing: false });
        expect(mcp.listTools).toHaveBeenCalledTimes(2);
    });

    it('waits the retryAfter the MCP server asks for before the restart', async () => {
        mcp.listTools.mockRejectedValueOnce(
            new Error(
                'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32050,"message":"Rate limit exceeded","data":{"retryAfter":1}}}',
            ),
        );
        stub('process.stdout.write(fixture);');
        const t0 = Date.now();
        const result = await runCodex(ctx);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
        expect(result.metrics).toMatchObject({ mcpRestarts: 1, mcpToolsMissing: false });
        expect(mcp.listTools).toHaveBeenCalledTimes(2);
    });

    it('returns inconclusive MCP evidence after repeated initialization failure', async () => {
        mcp.connect.mockRejectedValue(new Error('connection failed'));
        const result = await runCodex(ctx);
        expect(result.harnessBroke).toBe(false);
        expect(result.metrics).toMatchObject({
            mcpRestarts: 3,
            mcpToolCount: 0,
            mcpServers: [{ name: 'apify', status: 'failed' }],
        });
        expect(mcp.close).toHaveBeenCalledTimes(4);
        expect(sessionInfra(result).ok).toBe(false);
    });

    it('restarts when Codex itself fails MCP startup after the independent probe succeeded', async () => {
        stub(`
            const marker = ${JSON.stringify(join(dir, 'retried'))};
            if (!fs.existsSync(marker)) {
                fs.writeFileSync(marker, 'yes');
                process.stderr.write('Error: required MCP server apify failed to initialize');
                process.exitCode = 1;
            } else process.stdout.write(fixture);
        `);
        const result = await runCodex(ctx);
        expect(result.metrics).toMatchObject({ mcpRestarts: 1, exitCode: 0 });
        expect(result.harnessBroke).toBe(false);
    });

    it('times out a process group and preserves partial evidence', async () => {
        ctx.perItemTimeoutSecs = 1;
        stub(`process.stdout.write(fixture); setInterval(() => {}, 1000);`);
        const result = await runCodex(ctx);
        expect(result.metrics).toMatchObject({ timedOut: true, subtype: 'error_timeout' });
        expect(result.harnessBroke).toBe(false);
        expect(result.output).toContain('apify/website-content-crawler');
        expect(sessionInfra(result).ok).toBe(false);
    });

    it('scores max-turn exhaustion without treating the killed process as broken', async () => {
        ctx.item.metadata!.maxTurns = 1;
        const next = jsonl({
            type: 'item.started',
            item: { id: 'extra', type: 'mcp_tool_call', server: 'apify', tool: 'search-actors', arguments: {} },
        });
        stub(`process.stdout.write(fixture + ${JSON.stringify(`${next}\n`)}); setInterval(() => {}, 1000);`);
        const result = await runCodex(ctx);
        expect(result.metrics).toMatchObject({ subtype: 'error_max_turns', toolRounds: 1, timedOut: false });
        expect(result.harnessBroke).toBe(false);
        expect(sessionInfra(result).ok).toBe(true);
    });

    it('stops at the turn budget when a shell command never completes', async () => {
        // Unified exec keeps `sleep`/`tail -f` running: item.started, no item.completed.
        ctx.harness.maxTurns = 2;
        const cmd = (id: string, command: string, done: boolean) => ({
            type: done ? 'item.completed' : 'item.started',
            item: {
                id,
                type: 'command_execution',
                command,
                aggregated_output: done ? 'ok' : '',
                exit_code: done ? 0 : null,
                status: done ? 'completed' : 'in_progress',
            },
        });
        const events =
            jsonl(
                { type: 'thread.started', thread_id: 't' },
                { type: 'turn.started' },
                cmd('long', 'sleep 25', false),
                cmd('r2', 'echo r2', false),
                cmd('r2', 'echo r2', true),
                cmd('r3', 'echo r3', false),
                cmd('r3', 'echo r3', true),
                cmd('r4', 'echo r4', false),
                cmd('r4', 'echo r4', true),
            ) + '\n';
        stub(`process.stdout.write(${JSON.stringify(events)}); setInterval(() => {}, 1000);`);
        const result = await runCodex(ctx);
        expect(result.metrics).toMatchObject({ subtype: 'error_max_turns', toolRounds: 2, timedOut: false });
        expect(result.harnessBroke).toBe(false);
        // The trace holds the same two rounds; the third is only in the raw log.
        const traced = result.timeline.filter((e) => e.kind === 'assistant' && e.toolUses.length > 0);
        expect(traced.map((e) => (e.kind === 'assistant' ? e.toolUses.map((u) => u.id) : []))).toEqual([
            ['long', 'r2'],
            ['r3'],
        ]);
        expect(result.rawStdout).toContain('echo r4');
    });

    it('keeps parallel tools in one budget round and retains both results', async () => {
        ctx.harness.maxTurns = 1;
        const tool = (id: string) => ({
            id,
            type: 'mcp_tool_call',
            server: 'apify',
            tool: 'search-actors',
            arguments: {},
        });
        const initial =
            jsonl(
                { type: 'item.started', item: tool('a') },
                { type: 'item.started', item: tool('b') },
                {
                    type: 'item.completed',
                    item: { ...tool('a'), result: { content: [{ type: 'text', text: 'a' }] }, status: 'completed' },
                },
            ) + '\n';
        const last =
            jsonl({
                type: 'item.completed',
                item: { ...tool('b'), result: { content: [{ type: 'text', text: 'b' }] }, status: 'completed' },
            }) + '\n';
        stub(
            `process.stdout.write(${JSON.stringify(initial)}); setTimeout(() => process.stdout.write(${JSON.stringify(last)}), 30); setInterval(() => {}, 1000);`,
        );
        const result = await runCodex(ctx);
        expect(result.metrics).toMatchObject({ subtype: 'error_max_turns', toolRounds: 1, toolCalls: 2 });
        expect(result.timeline.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
        expect(sessionInfra(result).ok).toBe(true);
    });

    it('includes MCP discovery in the timeout and closes its transport', async () => {
        ctx.perItemTimeoutSecs = 0.05;
        mcp.connect.mockImplementation(
            (_transport, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                }),
        );
        const result = await runCodex(ctx);
        expect(result.metrics).toMatchObject({ timedOut: true, mcpRestarts: 0 });
        expect(mcp.close).toHaveBeenCalledOnce();
        expect(sessionInfra(result).ok).toBe(false);
    });

    it('treats a deadline abort of MCP discovery as a timeout even when the clock lags the timer', async () => {
        ctx.perItemTimeoutSecs = 0.05;
        const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
        mcp.connect.mockImplementation(
            (_transport, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                }),
        );
        try {
            const result = await runCodex(ctx);
            expect(result.metrics).toMatchObject({ timedOut: true, mcpRestarts: 0, mcpToolsMissing: false });
        } finally {
            now.mockRestore();
        }
    });

    it.each([
        ['empty output', ''],
        ['nonzero exit with a final answer', 'process.stdout.write(fixture); process.exitCode = 2;'],
        ['unparseable events', 'process.stdout.write("not JSON\\n");'],
        ['incomplete session', 'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"a"}) + "\\n");'],
    ])('marks %s as harness failure', async (_name, body) => {
        stub(body);
        const result = await runCodex(ctx);
        expect(result.harnessBroke).toBe(true);
        expect(sessionInfra(result).ok).toBe(false);
    });

    it('handles a missing executable', async () => {
        const result = await runCodex(ctx);
        expect(result.harnessBroke).toBe(true);
        expect(result.stderr).toContain('ENOENT');
    });

    it('flags a truncated stdout stream without leaking the authentication token', async () => {
        stub(
            `process.stdout.write(fixture); process.stdout.write(process.env.APIFY_TOKEN + '\\n'); process.stderr.write(process.env.APIFY_TOKEN); process.stdout.write('x'.repeat(11 * 1024 * 1024));`,
        );
        const result = await runCodex(ctx);
        expect(result.metrics.stdoutTruncated).toBe(true);
        expect(result.rawStdout.length).toBeLessThan(11 * 1024 * 1024);
        expect(result.rawStdout).not.toContain(ctx.apifyToken);
        expect(result.stderr).not.toContain(ctx.apifyToken);
        expect(sessionInfra(result).ok).toBe(false);
    });
});

describe('Codex sandbox probe (stub executable)', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'codex-probe-test-'));
        vi.stubEnv('PATH', dir);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    });
    const stub = (body: string) => {
        writeFileSync(join(dir, 'codex'), `#!${process.execPath}\n${body}\n`);
        chmodSync(join(dir, 'codex'), 0o755);
    };

    it('passes when the sandboxed command prints the probe file', async () => {
        // `codex sandbox -- cat <file>` with a read-only config in an isolated CODEX_HOME.
        stub(`const fs = require('node:fs');
const args = process.argv.slice(2);
const config = fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8');
if (args[0] !== 'sandbox' || args[1] !== '--' || args[2] !== 'cat' || !config.includes('read-only')) process.exit(2);
process.stdout.write(fs.readFileSync(args[3], 'utf8'));`);
        expect(await probeCodexSandbox()).toBeNull();
    });

    it('reports the reason when the sandbox cannot start', async () => {
        stub(`process.stderr.write('bwrap: No permissions to create a new namespace\\n'); process.exit(1);`);
        expect(await probeCodexSandbox()).toContain('No permissions to create a new namespace');
    });

    it('reports a missing executable', async () => {
        expect(await probeCodexSandbox()).toMatch(/ENOENT/);
    });
});
