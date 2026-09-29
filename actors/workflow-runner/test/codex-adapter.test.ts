import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { infraStatus, type Evidence } from '@apify-evals/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseCodexEvents } from '../src/adapters/codex-events.js';
import { runCodex } from '../src/adapters/codex.js';
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
        expect(captured.config).toContain('shell_tool = false');
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

    it('retries zero MCP tools once before spawning', async () => {
        mcp.listTools.mockResolvedValueOnce({ tools: [] });
        stub('process.stdout.write(fixture);');
        const result = await runCodex(ctx);
        expect(result.metrics).toMatchObject({ mcpRestarts: 1, mcpToolCount: 1, mcpToolsMissing: false });
        expect(mcp.listTools).toHaveBeenCalledTimes(2);
    });

    it('returns inconclusive MCP evidence after repeated initialization failure', async () => {
        mcp.connect.mockRejectedValue(new Error('connection failed'));
        const result = await runCodex(ctx);
        expect(result.harnessBroke).toBe(false);
        expect(result.metrics).toMatchObject({
            mcpRestarts: 1,
            mcpToolCount: 0,
            mcpServers: [{ name: 'apify', status: 'failed' }],
        });
        expect(mcp.close).toHaveBeenCalledTimes(2);
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
