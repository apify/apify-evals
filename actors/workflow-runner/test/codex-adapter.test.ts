import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { infraStatus, surfacesOfCall, type Evidence } from '@apify-evals/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { codexSkillsRead, parseCodexEvents, unwrapShellCommand } from '../src/adapters/codex-events.js';
import { codexAuthSecrets, codexShellPath, probeCodexSandbox, runCodex } from '../src/adapters/codex.js';
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
            toolUses: [{ id: 'c1', name: 'Bash', input: { command: 'cat SKILL.md' } }],
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

    it.each([
        ["/bin/zsh -c 'apify call apify/web-scraper'", 'apify call apify/web-scraper'],
        ['/bin/bash -lc \'echo "HOME=[$HOME]"; ls ~\'', 'echo "HOME=[$HOME]"; ls ~'],
        ["/bin/sh -c 'echo '\\''quoted'\\'''", "echo 'quoted'"],
        ["/bin/sh -c 'echo '\"'\"'x'\"'\"''", "echo 'x'"],
        ['/bin/sh -c "curl -s \\"https://api.apify.com/v2/store\\""', 'curl -s "https://api.apify.com/v2/store"'],
        ['cat SKILL.md', 'cat SKILL.md'],
        ["/bin/sh -c 'unterminated", "/bin/sh -c 'unterminated"],
        ["/bin/sh -c 'a' 'b'", "/bin/sh -c 'a' 'b'"],
    ])('reads the agent command out of %s', (wrapped, command) => {
        expect(unwrapShellCommand(wrapped)).toBe(command);
    });

    it('classifies a wrapped shell command by the agent command', () => {
        const parsed = parseCodexEvents(
            jsonl({
                type: 'item.completed',
                item: {
                    id: 'c',
                    type: 'command_execution',
                    command: "/bin/zsh -c 'apify call apify/web-scraper'",
                    aggregated_output: '',
                    exit_code: 0,
                    status: 'completed',
                },
            }),
        );
        const calls = parsed.timeline.flatMap((e) => (e.kind === 'assistant' ? e.toolUses : []));
        expect(surfacesOfCall(calls[0].name, calls[0].input)).toEqual(['cli']);
    });

    describe('which injected skills the agent read', () => {
        const body = (name: string) => `---\nname: ${name}\ndescription: test\n---\n# ${name}\n`;
        const run = (command: string, output: string, exitCode = 0) =>
            jsonl({
                type: 'item.completed',
                item: {
                    id: 'c',
                    type: 'command_execution',
                    command,
                    aggregated_output: output,
                    exit_code: exitCode,
                    status: exitCode === 0 ? 'completed' : 'failed',
                },
            });
        const read = (events: string, skills = ['alpha', 'bar', 'foo-bar']) => codexSkillsRead(events, skills);

        it.each([
            ['cat on the full path', "/bin/sh -c 'cat /h/.agents/skills/alpha/SKILL.md'", body('alpha'), ['alpha']],
            ['cat after cd', "/bin/sh -c 'cd /h/.agents/skills/alpha && cat SKILL.md'", body('alpha'), ['alpha']],
            ['sed of the file', 'sed -n 1,200p ~/.agents/skills/bar/SKILL.md', body('bar'), ['bar']],
            ['a suffix name only', 'cat ~/.agents/skills/foo-bar/SKILL.md', body('foo-bar'), ['foo-bar']],
        ])('counts %s', (_name, command, output, expected) => {
            expect(read(run(command, output))).toEqual(expected);
        });

        it.each([
            ['ls of the path', 'ls -la ~/.agents/skills/alpha/SKILL.md', '-rw-r--r-- 1 u u 70 alpha/SKILL.md'],
            ['test -f', 'test -f ~/.agents/skills/alpha/SKILL.md && echo yes', 'yes'],
            ['wc', 'wc -l ~/.agents/skills/alpha/SKILL.md', '5 /h/.agents/skills/alpha/SKILL.md'],
            ['a body without the command naming the file', 'echo hi', body('alpha')],
        ])('ignores %s', (_name, command, output) => {
            expect(read(run(command, output))).toEqual([]);
        });

        it('ignores a failed read', () => {
            expect(read(run('cat ~/.agents/skills/alpha/SKILL.md', `${body('alpha')}\ncat: write error`, 1))).toEqual(
                [],
            );
        });

        it('ignores MCP arguments, such as a URL that names the file', () => {
            const events = jsonl({
                type: 'item.completed',
                item: {
                    id: 'm1',
                    type: 'mcp_tool_call',
                    server: 'apify',
                    tool: 'apify--web-fetch',
                    arguments: { url: 'https://github.com/apify/agent-skills/blob/main/skills/alpha/SKILL.md' },
                    result: { content: [{ type: 'text', text: body('alpha') }] },
                },
            });
            expect(read(events)).toEqual([]);
        });

        it('does not take bar from foo-bar', () => {
            expect(read(run('cat ~/.agents/skills/foo-bar/SKILL.md', body('foo-bar')), ['bar'])).toEqual([]);
        });

        it('reads nothing without injected skills', () => {
            expect(read(run('cat ~/.agents/skills/alpha/SKILL.md', body('alpha')), [])).toEqual([]);
            expect(read(fixture, ['alpha'])).toEqual([]);
        });
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
            // The stub makes no model call through the relay.
            numTurns: 0,
            turnCounting: 'model-calls',
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
            `set = { HOME = ${JSON.stringify(captured.home)}, PATH = ${JSON.stringify(codexShellPath())} }`,
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
                    aggregated_output: '---\nname: alpha\ndescription: t\n---\nbody\n',
                    exit_code: 0,
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
            // The session HOME and the relay port are fresh in every session.
            const normalize = (c: { config: string; home: string }) =>
                c.config.replaceAll(c.home, '<home>').replace(/127\.0\.0\.1:\d+/, '<relay>');
            expect(normalize(withSkills)).toBe(normalize(plain));
            expect(result.metrics).toMatchObject({ skillsLoaded: ['alpha'], skillsRead: ['alpha'] });
            expect(result.harnessBroke).toBe(false);
        } finally {
            rmSync(skillsRoot, { recursive: true, force: true });
        }
    });

    it('does not count a skill Codex failed to load', async () => {
        const skillsRoot = mkdtempSync(join(tmpdir(), 'codex-skills-root-'));
        try {
            for (const name of ['alpha', 'beta']) {
                mkdirSync(join(skillsRoot, name));
                writeFileSync(join(skillsRoot, name, 'SKILL.md'), `---\nname: ${name}\ndescription: t\n---\n`);
            }
            // The real 0.162.1 message, padded past the stderr cap the adapter keeps.
            stub(`process.stderr.write('x'.repeat(3000) + '\\n');
                process.stderr.write('ERROR codex_core::session::session: failed to load skill ' + home + '/.agents/skills/alpha/SKILL.md: missing YAML frontmatter delimited by ---\\n');
                process.stdout.write(fixture);`);
            const result = await runCodex({ ...ctx, skillSet: ['alpha', 'beta'], skillsRoot });
            expect(result.metrics).toMatchObject({ skillsLoaded: ['beta'], skillsFailed: ['alpha'] });
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

    describe('turn budget through the model relay', () => {
        let upstream: Server;
        let requests: number;
        beforeEach(async () => {
            requests = 0;
            // Fake provider: every model call answers with two parallel tool calls.
            upstream = createServer((req, res) => {
                req.resume();
                req.on('end', () => {
                    requests++;
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
                    send({ type: 'response.created', response: { id: `r${requests}` } });
                    for (const i of [0, 1]) {
                        send({
                            type: 'response.output_item.done',
                            item: { type: 'function_call', name: 'exec_command', call_id: `c${requests}_${i}` },
                        });
                    }
                    send({ type: 'response.completed', response: { id: `r${requests}` } });
                    res.end();
                });
            });
            await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
            ctx.modelUpstream = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
            ctx.item = { metadata: {} };
        });
        afterEach(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

        // Like Codex: call the model at the configured base_url until refused,
        // print one shell command per tool call, never finish on its own.
        const modelLoop = `
            const config = fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8');
            const base = /base_url = "([^"]+)"/.exec(config)[1];
            let n = 0;
            const next = async () => {
                const res = await fetch(base + '/responses', { method: 'POST', body: '{}' });
                const text = await res.text();
                if (res.status !== 200) { process.stdout.write(JSON.stringify({ type: 'error', message: text }) + '\\n'); return; }
                for (const i of [0, 1]) {
                    const item = { id: 'i' + n + '_' + i, type: 'command_execution', command: 'sleep 300', aggregated_output: '', exit_code: null, status: 'in_progress' };
                    process.stdout.write(JSON.stringify({ type: 'item.started', item }) + '\\n');
                }
                n++;
                next();
            };
            process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\\n');
            next();
            setInterval(() => {}, 1000);`;

        it('allows maxTurns model calls and stops the session at the next one', async () => {
            ctx.harness.maxTurns = 3;
            stub(modelLoop);
            const result = await runCodex(ctx);
            expect(requests).toBe(3);
            expect(result.metrics).toMatchObject({
                subtype: 'error_max_turns',
                numTurns: 3,
                toolRounds: 3,
                turnCounting: 'model-calls',
                timedOut: false,
            });
            expect(result.harnessBroke).toBe(false);
            expect(sessionInfra(result).ok).toBe(true);
            // Never-ending commands do not hide the calls: all six are in the trace.
            expect(result.metrics.toolCalls).toBe(6);
            const captured = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
            expect(captured.config).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+"/);
        });
    });

    it('falls back to item order for a local login, replaying a recorded Codex session', async () => {
        // Recorded with codex 0.162.1: `echo a` returned, then `sleep 300` started.
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-login-'));
        vi.stubEnv('CODEX_HOME', codexHome);
        try {
            ctx.useOpenRouterProxy = false;
            ctx.item = { metadata: {} };
            ctx.harness.maxTurns = 1;
            const real = readFileSync(new URL('./fixtures/codex-shell-real.jsonl', import.meta.url), 'utf8');
            stub(`process.stdout.write(${JSON.stringify(real)}); setInterval(() => {}, 1000);`);
            const result = await runCodex(ctx);
            expect(result.metrics).toMatchObject({
                subtype: 'error_max_turns',
                toolRounds: 1,
                turnCounting: 'item-order',
            });
            expect(result.harnessBroke).toBe(false);
            // The trace keeps the allowed round; the rest stays in the raw log.
            const calls = result.timeline.flatMap((e) => (e.kind === 'assistant' ? e.toolUses : []));
            expect(calls.map((c) => (c.input as { command: string }).command)).toEqual(['echo a']);
            expect(result.rawStdout).toContain('sleep 301');
        } finally {
            rmSync(codexHome, { recursive: true, force: true });
        }
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

    it('redacts the local Codex login from everything the session returns', async () => {
        // Local mode links the developer's auth.json into CODEX_HOME; the shell can read it.
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-login-'));
        const auth = {
            auth_mode: 'chatgpt',
            tokens: {
                id_token:
                    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXN1YmplY3QtMTIzNDUifQ.c2lnbmF0dXJlLXBhcnQtZm9yLXRlc3Rz',
                access_token: 'access-token-for-tests-0123456789',
                refresh_token: 'refresh-token-for-tests-0123456789',
                account_id: '6a1c2a3e-1111-2222-3333-444455556666',
            },
            last_refresh: '2026-11-22T00:00:00Z',
        };
        writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(auth));
        vi.stubEnv('CODEX_HOME', codexHome);
        try {
            ctx.useOpenRouterProxy = false;
            const read = (id: string, done: boolean) => ({
                type: done ? 'item.completed' : 'item.started',
                item: {
                    id,
                    type: 'command_execution',
                    command: 'cat ~/auth.json',
                    aggregated_output: done ? 'AUTH' : '',
                    exit_code: done ? 0 : null,
                    status: done ? 'completed' : 'in_progress',
                },
            });
            const events = `${jsonl(read('c1', false), read('c1', true))}\n`;
            stub(`const login = fs.readFileSync(home + '/auth.json', 'utf8');
                process.stdout.write(${JSON.stringify(events)}.replace('AUTH', JSON.stringify(login).slice(1, -1)) + fixture);
                process.stderr.write(login);`);
            const result = await runCodex(ctx);
            const everything = JSON.stringify(result);
            expect(everything).toContain('[REDACTED]');
            for (const secret of [
                auth.tokens.id_token,
                ...auth.tokens.id_token.split('.'),
                auth.tokens.access_token,
                auth.tokens.refresh_token,
                auth.tokens.account_id,
            ]) {
                expect(everything).not.toContain(secret);
            }
            expect(result.harnessBroke).toBe(false);
        } finally {
            rmSync(codexHome, { recursive: true, force: true });
        }
    });

    it('finds the secret values of a Codex login', () => {
        expect(
            codexAuthSecrets({
                auth_mode: 'chatgpt',
                OPENAI_API_KEY: 'sk-test-0123456789abcdef',
                tokens: { id_token: 'aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cc', short: 'abc' },
                last_refresh: '2026-11-22T00:00:00.000000Z',
            }),
        ).toEqual([
            'aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cc',
            'sk-test-0123456789abcdef',
            'aaaaaaaaaaaaaaaaaaaa',
            'bbbbbbbbbbbbbbbbbbbb',
        ]);
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
