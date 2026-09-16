import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from 'apify';

import { toolsUrl } from '../artifacts.js';
import type { AdapterResult, SessionContext } from '../harness.js';
import { parseCodexEvents, parseCodexLine } from './codex-events.js';
import { EXIT_GRACE_MS, killProcessTree, MAX_MCP_RESTARTS, MAX_STDOUT_BYTES, STDERR_CAP } from './shared.js';

/** Kept together so the provider can change without touching process handling. */
export const CODEX_PROVIDER = {
    name: 'Apify OpenRouter',
    base_url: 'https://openrouter.apify.actor/api/v1',
    env_key: 'APIFY_TOKEN',
    wire_api: 'responses',
    requires_openai_auth: false,
} as const;

type CodexContext = Pick<
    SessionContext,
    'item' | 'harness' | 'mcpUrl' | 'apifyToken' | 'useOpenRouterProxy' | 'perItemTimeoutSecs'
> & { prompt: string };

/** Codex exec has no tools/list event. Independently check the exact MCP URL
 * and enforce required=true in Codex, so its own initialization must also
 * succeed. A failed tools/list or zero allowed tools gets one fresh attempt. */
async function listMcpTools(ctx: CodexContext, signal: AbortSignal): Promise<number> {
    const allowed = ctx.item.metadata?.tools ?? [];
    const client = new Client({ name: 'workflow-runner-codex', version: '0.2.0' });
    const transport = new StreamableHTTPClientTransport(new URL(toolsUrl(ctx.mcpUrl, allowed)), {
        requestInit: { headers: { Authorization: `Bearer ${ctx.apifyToken}` }, signal },
    });
    try {
        await client.connect(transport, { signal, timeout: 20_000 });
        const names = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: 20_000 });
            for (const tool of page.tools) if (allowed.includes(tool.name)) names.add(tool.name);
            cursor = page.nextCursor;
        } while (cursor);
        return names.size;
    } finally {
        await client.close();
    }
}

function buildConfig(ctx: CodexContext): string {
    // JSON strings are valid TOML basic strings, including quoted URLs and ids.
    const q = JSON.stringify;
    const lines = [
        `model = ${q(ctx.harness.model)}`,
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        'project_doc_max_bytes = 0',
        '[features]',
        ...[
            'shell_tool',
            'unified_exec',
            'shell_snapshot',
            'apps',
            'plugins',
            'skill_search',
            'multi_agent',
            'browser_use',
            'computer_use',
            'image_generation',
            'view_image',
        ].map((feature) => `${feature} = false`),
        '[shell_environment_policy]',
        'inherit = "none"',
    ];
    if (ctx.useOpenRouterProxy) {
        lines.unshift('model_provider = "apify"');
        lines.push(
            '[model_providers.apify]',
            ...Object.entries(CODEX_PROVIDER).map(([key, value]) => `${key} = ${q(value)}`),
        );
    }
    const tools = ctx.item.metadata?.tools;
    if (tools?.length) {
        lines.push(
            '[mcp_servers.apify]',
            `url = ${q(toolsUrl(ctx.mcpUrl, tools))}`,
            'bearer_token_env_var = "APIFY_TOKEN"',
            `enabled_tools = ${q(tools)}`,
            'required = true',
            'startup_timeout_sec = 20',
        );
    }
    return `${lines.join('\n')}\n`;
}

export async function runCodex(ctx: CodexContext): Promise<AdapterResult> {
    const maxTurns = ctx.item.metadata?.maxTurns ?? ctx.harness.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('Codex maxTurns must be a positive integer');
    const startedAt = Date.now();
    const deadline = startedAt + ctx.perItemTimeoutSecs * 1000;
    const expected = Boolean(ctx.item.metadata?.tools?.length);
    let restarts = 0;
    for (;;) {
        const result = await runCodexOnce(ctx, deadline, expected);
        if (result.metrics.mcpToolsMissing && restarts < MAX_MCP_RESTARTS && Date.now() < deadline) {
            restarts++;
            log.warning(`Codex MCP startup failed; restarting session (${restarts}/${MAX_MCP_RESTARTS})`);
            continue;
        }
        result.startedAt = startedAt;
        Object.assign(result.metrics, {
            mcpExpected: expected,
            mcpRestarts: restarts,
            durationMs: Date.now() - startedAt,
        });
        return result;
    }
}

async function runCodexOnce(ctx: CodexContext, deadline: number, expected: boolean): Promise<AdapterResult> {
    let mcpToolCount: number | null = null;
    let mcpFailure: string | null = null;
    const remaining = () => Math.max(1, deadline - Date.now());
    if (expected) {
        try {
            mcpToolCount = await listMcpTools(ctx, AbortSignal.timeout(remaining()));
            if (mcpToolCount === 0) mcpFailure = 'MCP server exposed no allowed tools';
        } catch (error) {
            mcpToolCount = 0;
            mcpFailure = String(error);
        }
    }
    if (mcpFailure || Date.now() >= deadline) {
        return {
            output: '',
            conversation: [],
            timeline: [],
            startedAt: Date.now(),
            rawStdout: '',
            harnessBroke: false,
            stderr: (mcpFailure ?? 'Session timed out').replaceAll(ctx.apifyToken, '[REDACTED]').slice(0, STDERR_CAP),
            metrics: {
                harness: ctx.harness.kind,
                model: ctx.harness.model,
                exitCode: null,
                subtype: mcpFailure ? 'error_mcp_startup' : 'error_timeout',
                isError: true,
                timedOut: Date.now() >= deadline,
                stdoutTruncated: false,
                numTurns: 0,
                usage: null,
                costUsd: null,
                toolCalls: 0,
                mcpToolCount,
                mcpToolsMissing: Boolean(mcpFailure),
                mcpServers: expected ? [{ name: 'apify', status: 'failed' }] : [],
            },
        };
    }

    const root = mkdtempSync(join(tmpdir(), 'eval-codex-'));
    const home = join(root, 'home');
    const work = join(root, 'work');
    mkdirSync(home);
    mkdirSync(work);
    try {
        writeFileSync(join(home, 'config.toml'), buildConfig(ctx), { mode: 0o600 });
        if (!ctx.useOpenRouterProxy) {
            // Reuse only local login, never the developer's MCP servers, skills,
            // or config. No credentials are copied into the temporary directory.
            const auth = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'), 'auth.json');
            if (existsSync(auth)) symlinkSync(auth, join(home, 'auth.json'));
        }
        return await spawnCodex(ctx, home, work, remaining(), mcpToolCount, expected);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function spawnCodex(
    ctx: CodexContext,
    home: string,
    work: string,
    timeoutMs: number,
    mcpToolCount: number | null,
    expected: boolean,
): Promise<AdapterResult> {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const maxTurns = ctx.item.metadata?.maxTurns ?? ctx.harness.maxTurns;
        const child = spawn(
            'codex',
            [
                'exec',
                '--json',
                '--ephemeral',
                '--skip-git-repo-check',
                '--ignore-rules',
                '-C',
                work,
                '--model',
                ctx.harness.model,
                '-',
            ],
            {
                cwd: work,
                env: {
                    PATH: process.env.PATH,
                    TMPDIR: process.env.TMPDIR,
                    HOME: home,
                    CODEX_HOME: home,
                    APIFY_TOKEN: ctx.apifyToken,
                },
                detached: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );
        const decoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        let stdout = '';
        let bytes = 0;
        let stderr = '';
        let lineBuffer = '';
        const lineTimes: number[] = [];
        let timedOut = false;
        let stdoutTruncated = false;
        let turnLimit = false;
        let toolRounds = 0;
        let inToolRound = false;
        const calls = new Set<string>();
        const pendingCalls = new Set<string>();
        let settled = false;
        let grace: NodeJS.Timeout | undefined;
        const killer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
        }, timeoutMs);
        const redact = (s: string) => (ctx.apifyToken ? s.replaceAll(ctx.apifyToken, '[REDACTED]') : s);
        const settle = (exitCode: number | null, spawnError?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            clearTimeout(grace);
            stdout += decoder.end();
            stderr += errDecoder.end();
            const rawStdout = redact(stdout);
            const parsed = parseCodexEvents(rawStdout, lineTimes, Date.now());
            const diagnostics = redact([stderr, ...parsed.errors].join('\n'));
            const missing =
                expected &&
                /(?:required MCP server.*failed|MCP.*(?:startup|initializ|connect).*failed|mcp startup: failed)/i.test(
                    diagnostics,
                );
            const harnessBroke =
                Boolean(spawnError) ||
                (!timedOut &&
                    !turnLimit &&
                    !missing &&
                    (exitCode !== 0 || parsed.failed || !parsed.completed || parsed.timeline.length === 0));
            resolve({
                output: parsed.finalResult,
                conversation: parsed.conversation,
                timeline: parsed.timeline,
                startedAt,
                rawStdout,
                harnessBroke,
                stderr: redact(spawnError ?? diagnostics).slice(0, STDERR_CAP),
                metrics: {
                    harness: ctx.harness.kind,
                    model: ctx.harness.model,
                    exitCode,
                    subtype: turnLimit
                        ? 'error_max_turns'
                        : timedOut
                          ? 'error_timeout'
                          : missing
                            ? 'error_mcp_startup'
                            : harnessBroke
                              ? 'error_session'
                              : 'success',
                    isError: harnessBroke || timedOut || missing,
                    timedOut,
                    stdoutTruncated,
                    numTurns: parsed.numTurns,
                    toolRounds,
                    usage: parsed.usage,
                    usageScope: 'session',
                    costUsd: null,
                    peakChildRssMb: null,
                    toolCalls: parsed.conversation.filter((c) => c.type === 'tool_call').length,
                    mcpToolCount: missing ? 0 : mcpToolCount,
                    mcpServers: expected ? [{ name: 'apify', status: missing ? 'failed' : 'connected' }] : [],
                    mcpToolsMissing: missing,
                },
            });
        };
        child.stdout.on('data', (data: Buffer) => {
            if (bytes >= MAX_STDOUT_BYTES) {
                stdoutTruncated = true;
                return;
            }
            const chunk = decoder.write(data);
            bytes += data.length;
            if (bytes > MAX_STDOUT_BYTES) stdoutTruncated = true;
            stdout += chunk;
            lineBuffer += chunk;
            let newline: number;
            while ((newline = lineBuffer.indexOf('\n')) >= 0) {
                const line = lineBuffer.slice(0, newline);
                lineBuffer = lineBuffer.slice(newline + 1);
                lineTimes.push(Date.now());
                const event = parseCodexLine(line);
                const item = event?.item as { id?: string; type?: string } | undefined;
                if (item?.type !== 'mcp_tool_call' || !item.id) continue;
                if (!calls.has(item.id) && !turnLimit) {
                    calls.add(item.id);
                    pendingCalls.add(item.id);
                    if (!inToolRound) {
                        inToolRound = true;
                        toolRounds++;
                    }
                }
                if (event?.type === 'item.completed' && pendingCalls.delete(item.id) && pendingCalls.size === 0) {
                    inToolRound = false;
                    // Exec has no max-turns option. Preserve the last allowed
                    // round's results before stopping. Stream delivery can race
                    // the next model call, so this is not an exact billing cap.
                    if (toolRounds >= maxTurns) {
                        turnLimit = true;
                        killProcessTree(child);
                    }
                }
            }
        });
        child.stderr.on('data', (data: Buffer) => {
            if (stderr.length < STDERR_CAP) stderr += errDecoder.write(data);
        });
        child.stdin.on('error', () => {
            /* EPIPE when startup fails before reading the prompt. */
        });
        child.stdin.end(ctx.prompt);
        child.on('error', (error) => settle(null, error.message));
        child.on('close', (code) => settle(code));
        child.on('exit', (code) => {
            grace = setTimeout(() => settle(code), EXIT_GRACE_MS);
        });
    });
}
