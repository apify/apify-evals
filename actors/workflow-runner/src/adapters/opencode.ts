/**
 * OpenCode harness: any OpenRouter model through the Apify OpenRouter proxy.
 *
 * One session is two processes of the pinned OpenCode CLI, both in a
 * throwaway directory: `opencode serve` (the agent runtime, with the MCP
 * connection) and `opencode run --server` (sends the prompt, prints the
 * session as JSON lines). They are split so the session starts only after the
 * MCP server reports `connected`: `opencode run --standalone` waits at most 2
 * seconds for MCP and then sends the first model call without the tools.
 *
 * Isolation: HOME, the XDG directories, OPENCODE_CONFIG and
 * OPENCODE_CONFIG_DIR all point into the session directory, so no global
 * config, skills, plugins, MCP servers or credentials of the machine reach the
 * agent. Built-in skills and tools that ship inside the binary stay as they
 * are, except the tools the permission list below denies.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';

import type { DatasetItemMetadata, McpServerSpec } from '@apify-evals/contract';
import { log } from 'apify';

import type { AdapterResult, HarnessConfig, SessionContext } from '../harness.js';
import { ALL_TOOLS, apifyMcpSpec, toolsUrl } from '../mcp.js';
import { installSkills } from '../skills.js';
import { curlrc, type ResolvedSurface } from '../surfaces.js';
import { openCodeNamespace, parseOpenCodeEvents } from './opencode-events.js';
import {
    EXIT_GRACE_MS,
    killProcessTree,
    MAX_STDOUT_BYTES,
    STDERR_CAP,
    snapshotWorkspace,
    trackChild,
    untrackChild,
} from './shared.js';

/** The OpenAI-compatible (chat completions) endpoint of the Apify OpenRouter proxy. */
export const OPENCODE_PROVIDER = {
    id: 'apify',
    name: 'Apify OpenRouter',
    npm: '@ai-sdk/openai-compatible',
    baseURL: 'https://openrouter.apify.actor/api/v1',
} as const;

/** Where OpenCode discovers project skills, relative to its working directory. */
export const OPENCODE_SKILLS_DIR = join('.opencode', 'skills');

/**
 * Built-in tools every session gets, in both arms of a skills comparison: the
 * skill tool (OpenCode has built-in skills, so it exists without ours too) and
 * the read-only file tools an agent needs to open a skill's reference files.
 */
export const OPENCODE_BASE_TOOLS = ['read', 'glob', 'grep', 'skill'] as const;

const MCP_STARTUP_MS = 20_000;
const SERVER_START_MS = 30_000;
/** mcp.apify.com refuses initialization bursts; same budget as the Codex adapter. */
const OPENCODE_MCP_RESTARTS = 3;

type OpenCodeContext = Pick<
    SessionContext,
    | 'item'
    | 'harness'
    | 'mcpUrl'
    | 'apifyToken'
    | 'mcpEnv'
    | 'skillSet'
    | 'skillsRoot'
    | 'surface'
    | 'runMarker'
    | 'perItemTimeoutSecs'
> & { prompt: string };

interface PermissionRule {
    action: string;
    resource: string;
    effect: 'allow' | 'deny' | 'ask';
}

/** The turn limit as OpenCode agent steps: maxTurns tool rounds, then one text-only answer. */
export function openCodeSteps(meta: DatasetItemMetadata, harness: HarnessConfig): number {
    return (meta.maxTurns ?? harness.maxTurns) + 1;
}

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/** `${VAR}` placeholders become OpenCode `{env:VAR}` references, so the config file holds no secret. */
function envRefs(value: string, vars: Set<string>): string {
    return value.replace(PLACEHOLDER, (_, name: string) => {
        vars.add(name);
        return `{env:${name}}`;
    });
}

export interface OpenCodeMcp {
    name: string;
    config: Record<string, unknown>;
    /** Permission actions that let the agent call the server's tools. */
    actions: string[];
    /** Environment variables the config references. */
    envVars: string[];
}

/** The item's MCP server as an OpenCode `mcp` entry; null when the item has no tools. */
export function openCodeMcp(meta: DatasetItemMetadata, mcpUrl: string): OpenCodeMcp | null {
    const tools = meta.tools ?? [];
    if (tools.length === 0) return null;
    const raw: McpServerSpec = meta.mcp ?? apifyMcpSpec(mcpUrl);
    const vars = new Set<string>();
    // Code Mode off: the agent calls the MCP tools directly, as in the other
    // harnesses, and Code Mode's own `fetch` would add web access.
    const common = { codemode: false, timeout: { startup: MCP_STARTUP_MS } };
    let config: Record<string, unknown>;
    if (raw.transport === 'http') {
        if (!raw.url) throw new Error(`MCP server "${raw.name}": http transport needs a url`);
        config = {
            type: 'remote',
            url: raw.toolsQuery ? toolsUrl(raw.url, tools) : raw.url,
            ...(raw.headers
                ? {
                      headers: Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, envRefs(v, vars)])),
                  }
                : {}),
            oauth: false,
            ...common,
        };
    } else {
        if (!raw.command) throw new Error(`MCP server "${raw.name}": stdio transport needs a command`);
        config = {
            type: 'local',
            command: [raw.command, ...(raw.args ?? [])],
            ...(raw.env
                ? { environment: Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, envRefs(v, vars)])) }
                : {}),
            ...common,
        };
    }
    const ns = openCodeNamespace(raw.name);
    const all = raw.toolsQuery || tools.includes(ALL_TOOLS);
    const actions = all ? [`${ns}_*`] : tools.map((t) => `${ns}_${t.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    return { name: raw.name, config, actions, envVars: [...vars].sort() };
}

/**
 * Deny everything, then allow the base tools, the scenario's MCP tools, the
 * shell when the scenario allows Bash and web fetch when the surface adds it.
 * A tool whose last matching rule is a `*` deny is removed from the model's
 * tool list, so denied tools are never offered. Nothing is `ask`: a
 * non-interactive run would reject it anyway.
 */
export function openCodePermissions(opts: {
    mcpActions: string[];
    bash: boolean;
    webFetch: boolean;
}): PermissionRule[] {
    const allow = (action: string): PermissionRule => ({ action, resource: '*', effect: 'allow' });
    return [
        { action: '*', resource: '*', effect: 'deny' },
        ...OPENCODE_BASE_TOOLS.map(allow),
        // The shell can reach any path anyway; without this, paths outside the
        // working directory (curl -o /tmp/...) would be refused.
        ...(opts.bash ? [allow('shell'), allow('external_directory')] : []),
        ...(opts.webFetch ? [allow('webfetch')] : []),
        ...opts.mcpActions.map(allow),
    ];
}

export function buildOpenCodeConfig(opts: {
    model: string;
    baseURL: string;
    steps: number;
    mcp: OpenCodeMcp | null;
    bash: boolean;
    webFetch: boolean;
}): Record<string, unknown> {
    return {
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        // Undo history for the TUI; the agent never sees it.
        snapshot: false,
        provider: {
            [OPENCODE_PROVIDER.id]: {
                npm: OPENCODE_PROVIDER.npm,
                name: OPENCODE_PROVIDER.name,
                options: { baseURL: opts.baseURL, apiKey: '{env:APIFY_TOKEN}' },
                models: { [opts.model]: { name: opts.model } },
            },
        },
        ...(opts.mcp ? { mcp: { servers: { [opts.mcp.name]: opts.mcp.config } } } : {}),
        permissions: openCodePermissions({
            mcpActions: opts.mcp?.actions ?? [],
            bash: opts.bash,
            webFetch: opts.webFetch,
        }),
        agents: { build: { steps: opts.steps } },
    };
}

export function buildOpenCodeEnv(opts: {
    home: string;
    apifyToken: string;
    password: string;
    surface?: ResolvedSurface;
    extra?: Record<string, string | undefined>;
}): Record<string, string | undefined> {
    const { home } = opts;
    return {
        // The surface and the MCP secrets first, so they cannot override the isolation below.
        ...(opts.surface?.env ?? {}),
        ...(opts.extra ?? {}),
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        CURL_HOME: home,
        OPENCODE_CONFIG: join(home, 'opencode.json'),
        OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_FREE_MODELS: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_PASSWORD: opts.password,
        APIFY_TOKEN: opts.apifyToken,
    };
}

export function buildOpenCodeRunArgs(serverUrl: string, model: string): string[] {
    // --title skips the extra model call that names the session.
    return [
        'run',
        '--server',
        serverUrl,
        '--format',
        'json',
        '--title',
        'eval',
        '--model',
        `${OPENCODE_PROVIDER.id}/${model}`,
    ];
}

/** The `mcp connected ... tools=N` line of the server log: how many tools OpenCode registered. */
export function mcpToolCountFromLog(logText: string, server: string): number | null {
    let count: number | null = null;
    for (const line of logText.split('\n')) {
        if (!line.includes('message="mcp connected"') || !line.includes(`server=${server} `)) continue;
        const m = / tools=(\d+)/.exec(line);
        if (m) count = Number(m[1]);
    }
    return count;
}

/**
 * Config entries OpenCode dropped. It skips a malformed entry with a log
 * warning and goes on, so a session could silently run without its MCP server
 * or its turn limit; the adapter refuses to start one instead.
 */
export function configDiagnosticsFromLog(logText: string): string[] {
    const out: string[] = [];
    for (const line of logText.split('\n')) {
        if (!line.includes('message="configuration normalization diagnostic"')) continue;
        const path = / path=(\S+)/.exec(line)?.[1] ?? '?';
        const action = / action="([^"]*)"/.exec(line)?.[1] ?? '';
        out.push(`${path}: ${action}`);
    }
    return [...new Set(out)];
}

function restartDelayMs(failure: string): number {
    const m = /"?retryAfter"?:\s*([\d.]+)/.exec(failure);
    return (m ? Number(m[1]) : 1) * 1000;
}

export async function runOpenCode(ctx: OpenCodeContext): Promise<AdapterResult> {
    const meta = ctx.item.metadata ?? {};
    const maxTurns = meta.maxTurns ?? ctx.harness.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('OpenCode maxTurns must be a positive integer');
    const startedAt = Date.now();
    const timeoutSecs = (meta as { timeoutSecs?: unknown }).timeoutSecs;
    const secs = typeof timeoutSecs === 'number' && timeoutSecs > 0 ? timeoutSecs : ctx.perItemTimeoutSecs;
    const deadline = startedAt + secs * 1000;
    const expected = Boolean(meta.tools?.length);
    let restarts = 0;
    for (;;) {
        const result = await runOpenCodeOnce(ctx, deadline, expected);
        if (result.metrics.mcpToolsMissing && restarts < OPENCODE_MCP_RESTARTS && Date.now() < deadline) {
            restarts++;
            const waitMs = Math.min(restartDelayMs(result.stderr), deadline - Date.now());
            log.warning(
                `OpenCode MCP startup failed (${result.stderr.slice(0, 200)}); restarting session in ${waitMs} ms (${restarts}/${OPENCODE_MCP_RESTARTS})`,
            );
            await sleep(waitMs);
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

interface Server {
    child: ChildProcess;
    url: string;
    auth: string;
}

/** Start `opencode serve` and read its `{"url": ...}` line. */
function startServer(env: Record<string, string | undefined>, cwd: string, timeoutMs: number): Promise<Server> {
    return new Promise((resolve, reject) => {
        const child = spawn('opencode', ['serve', '--stdio', '--port', '0'], {
            cwd,
            env: env as NodeJS.ProcessEnv,
            detached: true,
            // stdin stays open: the server treats its EOF as the end of the session.
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        trackChild(child);
        const decoder = new StringDecoder('utf8');
        let out = '';
        let err = '';
        const fail = (message: string) => {
            clearTimeout(timer);
            stopServer(child);
            reject(new Error(`${message}${err ? `: ${err.slice(0, 500)}` : ''}`));
        };
        const timer = setTimeout(() => fail('opencode serve did not report its URL in time'), timeoutMs);
        child.stdout.on('data', (data: Buffer) => {
            out += decoder.write(data);
            const nl = out.indexOf('\n');
            if (nl === -1) return;
            clearTimeout(timer);
            try {
                const { url } = JSON.parse(out.slice(0, nl)) as { url?: string };
                if (typeof url !== 'string') throw new Error('no url');
                const auth = `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString('base64')}`;
                resolve({ child, url, auth });
            } catch {
                fail(`opencode serve printed an unexpected line: ${out.slice(0, 200)}`);
            }
        });
        child.stderr.on('data', (data: Buffer) => {
            if (err.length < STDERR_CAP) err += data.toString('utf8');
        });
        child.on('error', (error) => fail(`opencode serve failed to start: ${error.message}`));
        child.on('exit', (code) => fail(`opencode serve exited with code ${code}`));
        child.stdin.on('error', () => {
            /* EPIPE after the server is gone */
        });
    });
}

function stopServer(child: ChildProcess): void {
    try {
        child.stdin?.end();
    } catch {
        /* already closed */
    }
    killProcessTree(child);
    untrackChild(child);
}

async function getJson(server: Server, path: string, signal: AbortSignal): Promise<unknown> {
    const res = await fetch(`${server.url}${path}`, { headers: { Authorization: server.auth }, signal });
    if (!res.ok) throw new Error(`GET ${path} returned HTTP ${res.status}`);
    return res.json();
}

/** Wait until the MCP server is connected or has failed; null = connected. */
async function waitForMcp(server: Server, name: string, deadline: number): Promise<{ status: string; error?: string }> {
    let last = 'pending';
    while (Date.now() < deadline) {
        try {
            const body = (await getJson(server, '/api/mcp', AbortSignal.timeout(5_000))) as {
                data?: { name?: string; status?: { status?: string; error?: string } }[];
            };
            const entry = body.data?.find((s) => s.name === name);
            last = entry?.status?.status ?? 'pending';
            if (last === 'connected') return { status: last };
            if (last === 'failed' || last === 'needs_auth' || last === 'disabled') {
                return { status: 'failed', error: `MCP server ${name} ${last}: ${entry?.status?.error ?? ''}` };
            }
        } catch {
            /* the location is still booting */
        }
        await sleep(200);
    }
    return {
        status: 'failed',
        error: `MCP server ${name} not connected after ${MCP_STARTUP_MS} ms (last status ${last})`,
    };
}

async function runOpenCodeOnce(ctx: OpenCodeContext, deadline: number, expected: boolean): Promise<AdapterResult> {
    const meta = ctx.item.metadata ?? {};
    const mcp = openCodeMcp(meta, ctx.mcpUrl);
    // The real path: OpenCode keys a session's directory by PWD, the server by its cwd
    // (macOS /var is a symlink), and both must name the same directory.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'eval-opencode-')));
    const home = join(root, 'home');
    const work = join(root, 'work');
    mkdirSync(home);
    mkdirSync(work);
    const password = randomBytes(24).toString('base64url');
    const mcpSecrets = Object.fromEntries((mcp?.envVars ?? []).map((name) => [name, ctx.mcpEnv[name]]));
    const secrets = [
        ctx.apifyToken,
        password,
        ...Object.values(mcpSecrets).filter((v): v is string => Boolean(v)),
        ...(ctx.surface?.secrets ?? []),
    ].filter(Boolean);
    const redact = (text: string) => secrets.reduce((acc, s) => acc.replaceAll(s, '[REDACTED]'), text);
    let server: Server | null = null;
    try {
        installSkills(work, ctx.skillSet, ctx.skillsRoot, OPENCODE_SKILLS_DIR);
        if (ctx.runMarker) writeFileSync(join(home, '.curlrc'), curlrc(ctx.runMarker));
        const config = buildOpenCodeConfig({
            model: ctx.harness.model,
            baseURL: process.env.OPENCODE_EVAL_BASE_URL || OPENCODE_PROVIDER.baseURL,
            steps: openCodeSteps(meta, ctx.harness),
            mcp,
            bash: Boolean(meta.allowBash),
            webFetch: Boolean(ctx.surface?.spec.webFetch),
        });
        writeFileSync(join(home, 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
        const env = buildOpenCodeEnv({
            home,
            apifyToken: ctx.apifyToken,
            password,
            surface: ctx.surface,
            extra: mcpSecrets,
        });

        const remaining = () => Math.max(1, deadline - Date.now());
        let mcpFailure: string | null = null;
        let mcpToolCount: number | null = null;
        let skills: string[] | null = null;
        const serverLog = () => readFileSafe(join(home, '.local', 'share', 'opencode', 'log', 'opencode.log'));
        try {
            server = await startServer(env, work, Math.min(SERVER_START_MS, remaining()));
            // The first request boots the session directory and loads the config.
            const body = (await getJson(server, '/api/skill', AbortSignal.timeout(Math.min(30_000, remaining())))) as {
                data?: { id?: string }[];
            };
            skills = body.data?.map((s) => String(s.id)) ?? null;
            const diagnostics = configDiagnosticsFromLog(serverLog());
            if (diagnostics.length > 0)
                throw new Error(`OpenCode rejected the session config: ${diagnostics.join('; ')}`);
            if (mcp) {
                const ready = await waitForMcp(
                    server,
                    mcp.name,
                    Math.min(Date.now() + MCP_STARTUP_MS + 5_000, deadline),
                );
                if (ready.status !== 'connected') mcpFailure = ready.error ?? 'MCP server not connected';
                else {
                    // The log is written asynchronously; the status can be ahead of it.
                    for (let i = 0; i < 15 && mcpToolCount === null; i++) {
                        mcpToolCount = mcpToolCountFromLog(serverLog(), mcp.name);
                        if (mcpToolCount === null) await sleep(200);
                    }
                    if (mcpToolCount === 0) mcpFailure = 'MCP server exposed no tools';
                }
            }
        } catch (error) {
            if (server) stopServer(server.child);
            server = null;
            const timedOut = Date.now() >= deadline;
            return earlyResult(ctx, mcp?.name ?? null, redact(String((error as Error).message ?? error)), {
                timedOut,
                harnessBroke: !timedOut,
            });
        }
        if (mcpFailure || Date.now() >= deadline) {
            return earlyResult(ctx, mcp?.name ?? null, redact(mcpFailure ?? 'Session timed out'), {
                timedOut: !mcpFailure,
                harnessBroke: false,
                mcpMissing: Boolean(mcpFailure),
            });
        }

        const result = await spawnRun(ctx, server, env, work, remaining(), redact, mcp?.name ?? null);
        // Skill discovery finishes after the directory boots; by now it has.
        const listed = (await getJson(server, '/api/skill', AbortSignal.timeout(5_000)).catch(() => null)) as {
            data?: { id?: string }[];
        } | null;
        if (listed?.data) skills = listed.data.map((s) => String(s.id));
        Object.assign(result.metrics, {
            mcpToolCount: expected ? mcpToolCount : null,
            mcpServers: mcp ? [{ name: mcp.name, status: 'connected' }] : [],
            mcpToolsMissing: false,
            ...(mcp ? { mcpServer: mcp.name } : {}),
            // Which of the injected skills OpenCode discovered, and which skills the agent loaded.
            skillsLoaded: skills ? skills.filter((name) => ctx.skillSet.includes(name)) : [],
        });
        if (meta.allowBash) result.workspaceFiles = snapshotWorkspace(work);
        return result;
    } finally {
        if (server) stopServer(server.child);
        rmSync(root, { recursive: true, force: true });
    }
}

function readFileSafe(path: string): string {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

function earlyResult(
    ctx: OpenCodeContext,
    mcpName: string | null,
    message: string,
    opts: { timedOut: boolean; harnessBroke: boolean; mcpMissing?: boolean },
): AdapterResult {
    return {
        output: '',
        conversation: [],
        timeline: [],
        startedAt: Date.now(),
        rawStdout: '',
        harnessBroke: opts.harnessBroke,
        stderr: message.slice(0, STDERR_CAP),
        metrics: {
            harness: ctx.harness.kind,
            model: ctx.harness.model,
            exitCode: null,
            subtype: opts.mcpMissing
                ? 'error_mcp_startup'
                : opts.timedOut
                  ? 'error_timeout'
                  : opts.harnessBroke
                    ? 'error_session'
                    : 'success',
            isError: true,
            timedOut: opts.timedOut,
            stdoutTruncated: false,
            numTurns: 0,
            usage: null,
            costUsd: null,
            toolCalls: 0,
            mcpToolCount: mcpName ? 0 : null,
            mcpToolsMissing: Boolean(opts.mcpMissing),
            mcpServers: mcpName ? [{ name: mcpName, status: 'failed' }] : [],
            skillsLoaded: [],
            skillsUsed: [],
        },
    };
}

function spawnRun(
    ctx: OpenCodeContext,
    server: Server,
    env: Record<string, string | undefined>,
    work: string,
    timeoutMs: number,
    redact: (s: string) => string,
    mcpName: string | null,
): Promise<AdapterResult> {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const maxTurns = ctx.item.metadata?.maxTurns ?? ctx.harness.maxTurns;
        const child = spawn('opencode', buildOpenCodeRunArgs(server.url, ctx.harness.model), {
            cwd: work,
            env: { ...env, PWD: work } as NodeJS.ProcessEnv,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        trackChild(child);
        const decoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        let stdout = '';
        let bytes = 0;
        let stderr = '';
        const lineTimes: number[] = [];
        let timedOut = false;
        let stdoutTruncated = false;
        let settled = false;
        let grace: NodeJS.Timeout | undefined;
        const killer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
            killProcessTree(server.child);
        }, timeoutMs);
        const settle = (exitCode: number | null, spawnError?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            clearTimeout(grace);
            untrackChild(child);
            stdout += decoder.end();
            stderr += errDecoder.end();
            const rawStdout = redact(stdout);
            const parsed = parseOpenCodeEvents(rawStdout, {
                mcpServers: mcpName ? [mcpName] : [],
                lineTimes,
                fallbackTime: Date.now(),
            });
            // OpenCode runs the last allowed step without tools and stops itself.
            const turnLimit = parsed.numTurns > maxTurns;
            const harnessBroke =
                Boolean(spawnError) ||
                (!timedOut && (exitCode !== 0 || parsed.numTurns === 0 || parsed.errors.length > 0));
            resolve({
                output: parsed.finalResult,
                conversation: parsed.conversation,
                timeline: parsed.timeline,
                startedAt,
                rawStdout,
                harnessBroke,
                stderr: redact(
                    spawnError ??
                        [stderr, ...parsed.errors, ...parsed.retries.slice(-1).map((r) => `retrying: ${r}`)]
                            .filter(Boolean)
                            .join('\n'),
                ).slice(0, STDERR_CAP),
                metrics: {
                    harness: ctx.harness.kind,
                    model: ctx.harness.model,
                    exitCode,
                    subtype: timedOut
                        ? 'error_timeout'
                        : harnessBroke
                          ? 'error_session'
                          : turnLimit
                            ? 'error_max_turns'
                            : 'success',
                    isError: harnessBroke || timedOut,
                    timedOut,
                    stdoutTruncated,
                    numTurns: parsed.numTurns,
                    toolRounds: parsed.toolRounds,
                    usage: parsed.usage,
                    usageScope: 'session',
                    // OpenCode prices only models it knows; the proxy's custom provider has no prices.
                    costUsd: null,
                    peakChildRssMb: null,
                    toolCalls: parsed.conversation.filter((c) => c.type === 'tool_call').length,
                    skillsUsed: parsed.skillsUsed,
                    providerRetries: parsed.retries.length,
                    ...(parsed.sessionId ? { openCodeSessionId: parsed.sessionId } : {}),
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
            const now = Date.now();
            for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) lineTimes.push(now);
        });
        child.stderr.on('data', (data: Buffer) => {
            if (stderr.length < STDERR_CAP) stderr += errDecoder.write(data);
        });
        child.stdin.on('error', () => {
            /* EPIPE when the client fails before reading the prompt */
        });
        // The prompt goes in on stdin: message arguments with spaces get quoted by the CLI.
        child.stdin.end(ctx.prompt);
        child.on('error', (error) => settle(null, error.message));
        child.on('close', (code) => settle(code));
        child.on('exit', (code) => {
            grace = setTimeout(() => settle(code), EXIT_GRACE_MS);
        });
    });
}
