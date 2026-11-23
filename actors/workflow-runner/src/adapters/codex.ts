import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from 'apify';

import { toolsUrl } from '../artifacts.js';
import type { AdapterResult, SessionContext } from '../harness.js';
import { availableSkills, CODEX_SKILLS_DIR, installSkills } from '../skills.js';
import { codexSkillsRead, parseCodexEvents, parseCodexLine, ToolRounds } from './codex-events.js';
import { startModelRelay, type ModelRelay } from './codex-relay.js';
import {
    EXIT_GRACE_MS,
    killProcessTree,
    MAX_STDOUT_BYTES,
    STDERR_CAP,
    snapshotWorkspace,
    trackChild,
    untrackChild,
} from './shared.js';

/** Kept together so the provider can change without touching process handling. */
export const CODEX_PROVIDER = {
    name: 'Apify OpenRouter',
    base_url: 'https://openrouter.apify.actor/api/v1',
    env_key: 'APIFY_TOKEN',
    wire_api: 'responses',
    requires_openai_auth: false,
} as const;

/**
 * Secret values in a Codex login file (auth.json): every string long enough
 * to be a token or key, and each segment of a JWT, longest first so a full
 * token is replaced before its parts.
 */
export function codexAuthSecrets(auth: unknown): string[] {
    const found = new Set<string>();
    const walk = (value: unknown): void => {
        if (typeof value === 'string') {
            if (value.length < 16 || /^\d{4}-\d{2}-\d{2}T/.test(value)) return; // short ids, timestamps
            found.add(value);
            for (const part of value.split('.')) if (part.length >= 16) found.add(part);
        } else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(auth);
    return [...found].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: string[]): string {
    let out = text;
    for (const secret of secrets) if (secret) out = out.replaceAll(secret, '[REDACTED]');
    return out;
}

/** Skill directory names in Codex's `failed to load skill <dir>/SKILL.md: <reason>` errors. */
export function skillLoadFailures(stderr: string): string[] {
    return [...stderr.matchAll(/failed to load skill (.+?)\/SKILL\.md:/g)].map((m) => m[1].split('/').at(-1) as string);
}

const SANDBOX_PROBE_MARKER = 'codex-sandbox-probe-ok';

/**
 * Run one command in the Codex read-only sandbox, the way a session's shell
 * runs it. On Linux the sandbox is bubblewrap, which needs unprivileged user
 * namespaces; a container that forbids them fails every shell command, so a
 * session could not read a skill and the shell would only burn turns. Returns
 * null when the command ran, else the reason.
 */
export function probeCodexSandbox(timeoutMs = 30_000): Promise<string | null> {
    const root = mkdtempSync(join(tmpdir(), 'codex-sandbox-probe-'));
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'config.toml'), 'sandbox_mode = "read-only"\n');
    const probe = join(root, 'probe.txt');
    writeFileSync(probe, SANDBOX_PROBE_MARKER);
    return new Promise((resolve) => {
        execFile(
            'codex',
            ['sandbox', '--', 'cat', probe],
            {
                cwd: root,
                env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, CODEX_HOME: home },
                timeout: timeoutMs,
            },
            (error, stdout, stderr) => {
                rmSync(root, { recursive: true, force: true });
                if (stdout.includes(SANDBOX_PROBE_MARKER)) return resolve(null);
                const detail = `${stderr}\n${error?.message ?? ''}`.trim().split('\n').filter(Boolean).at(-1);
                resolve(detail?.slice(0, 300) ?? 'no output');
            },
        );
    });
}

type CodexContext = Pick<
    SessionContext,
    'item' | 'harness' | 'mcpUrl' | 'apifyToken' | 'useOpenRouterProxy' | 'perItemTimeoutSecs'
> &
    Partial<Pick<SessionContext, 'skillSet' | 'skillsRoot'>> & {
        prompt: string;
        /** Where the model relay sends model calls; CODEX_PROVIDER.base_url unless a test or smoke run says otherwise. */
        modelUpstream?: string;
    };

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

/** The shell's PATH in the image: the system tools (cat, ls, grep, find, curl) and node. */
export const CODEX_SHELL_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * The shell's PATH. On Apify (the image) the system directories hold every
 * tool. Off Apify, node and the apify CLI usually live elsewhere (Homebrew,
 * nvm), so the directories where the runner's own `node` and `apify` resolve
 * are appended; nothing else from the developer's PATH. Both are the same for
 * every variant of a run.
 */
export function codexShellPath(env: Record<string, string | undefined> = process.env): string {
    if (env.APIFY_IS_AT_HOME === '1') return CODEX_SHELL_PATH;
    const dirs = CODEX_SHELL_PATH.split(':');
    const add = (dir: string | undefined) => {
        if (dir && !dirs.includes(dir)) dirs.push(dir);
    };
    add(dirname(process.execPath));
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (dir && existsSync(join(dir, 'apify'))) {
            add(dir);
            break;
        }
    }
    return dirs.join(':');
}

function buildConfig(ctx: CodexContext, home: string, modelBaseUrl: string | null): string {
    // JSON strings are valid TOML basic strings, including quoted URLs and ids.
    const q = JSON.stringify;
    const lines = [
        `model = ${q(ctx.harness.model)}`,
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        'project_doc_max_bytes = 0',
        // A login shell (`zsh -lc`) sources the developer's profile and, on
        // macOS, resets HOME to the real home: the agent would see the
        // developer's ~/.agents/skills and environment instead of the session.
        'allow_login_shell = false',
        '[features]',
        // The shell is the only tool that reads a file in Codex: a skill's
        // SKILL.md and references are listed in the prompt by path, not
        // inlined. On in every variant, so the variants differ only in the
        // skill files; the read-only sandbox blocks writes and network.
        // The shell is unified exec (`exec_command` + `write_stdin`): Codex
        // 0.162 ignores `unified_exec = false` outside managed requirements.
        'shell_tool = true',
        ...[
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
        // With nothing inherited the shell has no HOME (`~` does not expand)
        // and only Codex's own PATH entry; set both to the session's.
        `set = { HOME = ${q(home)}, PATH = ${q(codexShellPath())} }`,
    ];
    if (ctx.useOpenRouterProxy) {
        lines.unshift('model_provider = "apify"');
        lines.push(
            '[model_providers.apify]',
            // Model calls go through the session's relay, which counts them.
            ...Object.entries({ ...CODEX_PROVIDER, base_url: modelBaseUrl ?? CODEX_PROVIDER.base_url }).map(
                ([key, value]) => `${key} = ${q(value)}`,
            ),
        );
    }
    const tools = ctx.item.metadata?.tools;
    if (tools?.length) {
        lines.push(
            '[mcp_servers.apify]',
            `url = ${q(toolsUrl(ctx.mcpUrl, tools))}`,
            'bearer_token_env_var = "APIFY_TOKEN"',
            `enabled_tools = ${q(tools)}`,
            // Codex asks for approval before any MCP tool it does not consider
            // read-only (call-actor, create-actor-task). With approval_policy
            // "never" such calls would be rejected outright, so pre-approve the
            // allowlisted tools: the ?tools= list is already the permission boundary.
            'default_tools_approval_mode = "approve"',
            'required = true',
            'startup_timeout_sec = 20',
        );
    }
    return `${lines.join('\n')}\n`;
}

/** mcp.apify.com rate-limits initialization bursts and names the seconds to
 * wait; an immediate restart only keeps the rate up and fails again. */
function restartDelayMs(failure: string): number {
    const m = /"retryAfter":\s*([\d.]+)/.exec(failure);
    return (m ? Number(m[1]) : 1) * 1000;
}

/** Two refusals in a row happen under the rate limit; one restart was not enough. */
const CODEX_MCP_RESTARTS = 3;

export async function runCodex(ctx: CodexContext): Promise<AdapterResult> {
    const maxTurns = ctx.item.metadata?.maxTurns ?? ctx.harness.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('Codex maxTurns must be a positive integer');
    const startedAt = Date.now();
    const deadline = startedAt + ctx.perItemTimeoutSecs * 1000;
    const expected = Boolean(ctx.item.metadata?.tools?.length);
    let restarts = 0;
    for (;;) {
        const result = await runCodexOnce(ctx, deadline, expected);
        if (result.metrics.mcpToolsMissing && restarts < CODEX_MCP_RESTARTS && Date.now() < deadline) {
            restarts++;
            const waitMs = Math.min(restartDelayMs(result.stderr), deadline - Date.now());
            log.warning(
                `Codex MCP startup failed (${result.stderr.slice(0, 200)}); restarting session in ${waitMs} ms (${restarts}/${CODEX_MCP_RESTARTS})`,
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

async function runCodexOnce(ctx: CodexContext, deadline: number, expected: boolean): Promise<AdapterResult> {
    let mcpToolCount: number | null = null;
    let mcpFailure: string | null = null;
    const remaining = () => Math.max(1, deadline - Date.now());
    // The abort timer can fire while Date.now() is still short of the deadline.
    let timedOut = false;
    if (expected) {
        const signal = AbortSignal.timeout(remaining());
        try {
            mcpToolCount = await listMcpTools(ctx, signal);
            if (mcpToolCount === 0) mcpFailure = 'MCP server exposed no allowed tools';
        } catch (error) {
            mcpToolCount = 0;
            if (signal.aborted) timedOut = true;
            else mcpFailure = String(error);
        }
    }
    timedOut ||= Date.now() >= deadline;
    if (mcpFailure || timedOut) {
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
                timedOut,
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

    // Through the proxy every model call passes the session's relay, which
    // enforces the turn budget; a local login talks to OpenAI directly. A
    // relay that cannot start fails this session, never the whole run.
    let relay: ModelRelay | null = null;
    if (ctx.useOpenRouterProxy) {
        try {
            relay = await startModelRelay({
                upstream: ctx.modelUpstream ?? CODEX_PROVIDER.base_url,
                maxCalls: ctx.item.metadata?.maxTurns ?? ctx.harness.maxTurns,
            });
        } catch (error) {
            return {
                output: '',
                conversation: [],
                timeline: [],
                startedAt: Date.now(),
                rawStdout: '',
                harnessBroke: true,
                stderr: `Codex model relay could not start: ${(error as Error).message}`.slice(0, STDERR_CAP),
                metrics: {
                    harness: ctx.harness.kind,
                    model: ctx.harness.model,
                    exitCode: null,
                    subtype: 'error_session',
                    isError: true,
                    timedOut: false,
                    stdoutTruncated: false,
                    numTurns: 0,
                    usage: null,
                    costUsd: null,
                    toolCalls: 0,
                    mcpToolCount,
                    mcpToolsMissing: false,
                    mcpServers: [],
                },
            };
        }
    }

    const root = mkdtempSync(join(tmpdir(), 'eval-codex-'));
    const home = join(root, 'home');
    const work = join(root, 'work');
    mkdirSync(home);
    mkdirSync(work);
    const skillSet = ctx.skillSet ?? [];
    try {
        // Skills change only the files in HOME, never config.toml: the
        // no-skills variant stays the exact setup of the daily baseline.
        installSkills(home, skillSet, ctx.skillsRoot ?? '', CODEX_SKILLS_DIR);
        writeFileSync(join(home, 'config.toml'), buildConfig(ctx, home, relay?.url ?? null), { mode: 0o600 });
        let secrets = () => [ctx.apifyToken];
        if (!ctx.useOpenRouterProxy) {
            // Reuse only local login, never the developer's MCP servers, skills,
            // or config. No credentials are copied into the temporary directory,
            // but Codex reads the login from CODEX_HOME, which the read-only
            // sandbox lets the shell read too: its values never leave redacted.
            const auth = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'), 'auth.json');
            if (existsSync(auth)) {
                symlinkSync(auth, join(home, 'auth.json'));
                // Read at the start and again at the end: Codex may refresh
                // the tokens mid-session, and both generations can be printed.
                const readLogin = (): string[] => {
                    try {
                        return codexAuthSecrets(JSON.parse(readFileSync(auth, 'utf8')));
                    } catch {
                        return []; // unreadable login: Codex fails to authenticate and says so
                    }
                };
                const atStart = readLogin();
                secrets = () => [ctx.apifyToken, ...atStart, ...readLogin()];
            }
            log.warningOnce(
                'Local Codex sessions (useOpenRouterProxy: false) give the agent a shell that can read any file the developer can, under a read-only sandbox. The Codex login values are redacted from session output; other files are not.',
            );
        }
        const result = await spawnCodex(ctx, {
            home,
            work,
            timeoutMs: remaining(),
            mcpToolCount,
            expected,
            secrets,
            relay,
        });
        if (ctx.item.metadata?.allowBash) result.workspaceFiles = snapshotWorkspace(work);
        // Codex has no init event that lists skills (Claude Code's `skills`):
        // loaded = injected, present where Codex discovers them, and not named
        // in a Codex "failed to load skill" error. Read = SKILL.md shown.
        const installed = new Set(availableSkills(join(home, CODEX_SKILLS_DIR)));
        const failed = new Set(result.metrics.skillsFailed as string[]);
        result.metrics.skillsLoaded = skillSet.filter((name) => installed.has(name) && !failed.has(name));
        result.metrics.skillsRead = codexSkillsRead(result.rawStdout, skillSet, join(home, CODEX_SKILLS_DIR));
        return result;
    } finally {
        await relay?.close();
        rmSync(root, { recursive: true, force: true });
    }
}

interface SpawnOptions {
    home: string;
    work: string;
    timeoutMs: number;
    mcpToolCount: number | null;
    expected: boolean;
    /** Values to redact from everything the session returns; read again at the end. */
    secrets: () => string[];
    /** Counts model calls and enforces the turn budget; null for a local login (item-order fallback). */
    relay: ModelRelay | null;
}

/** Cut text at its last newline: a value split by a size cap must not leave its prefix behind. */
function cutAtLine(text: string): string {
    const end = text.lastIndexOf('\n');
    return end < 0 ? '' : text.slice(0, end + 1);
}

function spawnCodex(
    ctx: CodexContext,
    { home, work, timeoutMs, mcpToolCount, expected, secrets, relay }: SpawnOptions,
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
        // The Actor's abort handler kills every tracked session.
        trackChild(child);
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
        let errLines = '';
        let stderrCapped = false;
        const skillsFailed = new Set<string>();
        const rounds = new ToolRounds();
        /** Lines from this index on belong to a round past the budget: kept in the log, not in the trace. */
        let cutLine: number | null = null;
        let settled = false;
        let grace: NodeJS.Timeout | undefined;
        const killer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
        }, timeoutMs);
        if (relay) {
            relay.onRefused = () => {
                turnLimit = true;
                killProcessTree(child);
            };
        }
        const settle = (exitCode: number | null, spawnError?: string) => {
            if (settled) return;
            settled = true;
            untrackChild(child);
            clearTimeout(killer);
            clearTimeout(grace);
            const ordered = [...new Set(secrets().filter(Boolean))].sort((a, b) => b.length - a.length);
            const redact = (s: string) => redactSecrets(s, ordered);
            stdout = stdoutTruncated ? cutAtLine(stdout) : stdout + decoder.end();
            stderr = stderrCapped ? cutAtLine(stderr) : stderr + errDecoder.end();
            const rawStdout = redact(stdout);
            const traced = cutLine === null ? rawStdout : rawStdout.split('\n').slice(0, cutLine).join('\n');
            const parsed = parseCodexEvents(traced, lineTimes, Date.now());
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
                    // Model calls as the relay counted them; without a relay the
                    // trace's own grouping and the item-order rounds (approximate).
                    numTurns: relay ? relay.calls : parsed.numTurns,
                    toolRounds: relay ? relay.toolCalls : Math.min(rounds.count, maxTurns),
                    turnCounting: relay ? 'model-calls' : 'item-order',
                    // Compaction and other non-turn model requests, and requests without a readable kind.
                    ...(relay
                        ? { modelRequestsUncounted: relay.uncounted, modelRequestsUnlabelled: relay.unlabelled }
                        : {}),
                    usage: parsed.usage,
                    usageScope: 'session',
                    costUsd: null,
                    peakChildRssMb: null,
                    toolCalls: parsed.conversation.filter((c) => c.type === 'tool_call').length,
                    mcpToolCount: missing ? 0 : mcpToolCount,
                    mcpServers: expected ? [{ name: 'apify', status: missing ? 'failed' : 'connected' }] : [],
                    mcpToolsMissing: missing,
                    skillsFailed: [...skillsFailed, ...skillLoadFailures(errLines)].sort(),
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
                // The relay counts model calls exactly; item order is only the
                // fallback for a local login, whose model calls bypass it.
                if (relay) continue;
                const event = parseCodexLine(line);
                const item = event?.item as { id?: string; type?: string } | undefined;
                // Shell commands count toward the turn budget like MCP calls.
                if (!item?.id || (item.type !== 'mcp_tool_call' && item.type !== 'command_execution')) continue;
                if (turnLimit) {
                    // Events already in the pipe after the kill: a call past the
                    // budget and everything after it stay out of the trace.
                    if (cutLine === null && rounds.start(item.id)) cutLine = lineTimes.length - 1;
                    continue;
                }
                // Exec has no max-turns option. A call that would open a round
                // past the budget stops the session; the trace keeps the rounds
                // before it. Stream delivery can race the next model call, so
                // this is not an exact billing cap.
                if (rounds.start(item.id) && rounds.count > maxTurns) {
                    turnLimit = true;
                    cutLine = lineTimes.length - 1;
                    killProcessTree(child);
                    continue;
                }
                // The last allowed round has all its results: stop before the
                // next model call. A command that never ends (unified exec keeps
                // it running) never completes its round; the next call does.
                if (event?.type === 'item.completed' && rounds.complete(item.id) && rounds.count >= maxTurns) {
                    turnLimit = true;
                    killProcessTree(child);
                }
            }
        });
        child.stderr.on('data', (data: Buffer) => {
            if (stderr.length < STDERR_CAP) stderr += errDecoder.write(data);
            else stderrCapped = true;
            // Past the stderr cap too: Codex logs each skill it cannot load.
            errLines += data.toString('utf8');
            const lines = errLines.split('\n');
            errLines = lines.pop() ?? '';
            for (const name of skillLoadFailures(lines.join('\n'))) skillsFailed.add(name);
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
