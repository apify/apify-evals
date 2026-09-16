import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
    CONTRACT_VERSION,
    type AgentSpanMetadata,
    type AgentSpanOutput,
    type ConversationEntry,
    type DatasetItemMetadata,
    type DeterministicCheck,
    type Evidence,
    infraStatus,
    runChecks,
    validateAgentSpanMetadata,
    validateAgentSpanOutput,
} from '@apify-evals/contract';
import { propagateAttributes, startActiveObservation, startObservation } from '@langfuse/tracing';
import { trace } from '@opentelemetry/api';
import { log } from 'apify';

import { runCodex } from './adapters/codex.js';
import {
    capToolInput,
    EXIT_GRACE_MS,
    killProcessTree,
    MAX_MCP_RESTARTS,
    MAX_STDOUT_BYTES,
    STDERR_CAP,
    TEXT_BLOCK_CAP,
    TOOL_RESULT_CAP,
} from './adapters/shared.js';
import { toolsUrl, type ArtifactStore, type SnapshotCache } from './artifacts.js';
import {
    enrichFromApify,
    extractFromTools,
    summarizeRuns,
    type RawToolCall,
    type RawToolResult,
    type ReferenceRunner,
} from './evidence.js';

/**
 * Harness adapters (spec D5: one image, discriminator picks the harness).
 * Each adapter runs ONE isolated agent session as a child process of this
 * container. The session's Langfuse span carries the judge-ready conversation
 * as JSON (spec D10) and pointers to durable full-fidelity artifacts.
 *
 * Failure semantics (spec D13/D14): a broken harness (spawn failure, crash
 * with no result) is a health problem and drops the item with an error; an
 * agent that ran out of turns or hit the timeout is an EVAL result and gets
 * scored, not dropped.
 */

export interface HarnessConfig {
    kind: string;
    model: string;
    maxTurns: number;
}

export interface SessionContext {
    item: { id?: string; input?: unknown; metadata?: DatasetItemMetadata | null };
    datasetName: string;
    harness: HarnessConfig;
    mcpUrl: string;
    apifyToken: string;
    useOpenRouterProxy: boolean;
    perItemTimeoutSecs: number;
    artifactStore: ArtifactStore;
    snapshots: SnapshotCache;
    /** Reference runs (fresh ground truth), shared across sessions of one experiment. */
    references: ReferenceRunner;
    /** Writes one score onto an observation (the experiment item root). */
    writeScore: (score: {
        traceId: string;
        observationId: string;
        name: string;
        value: number;
        comment: string;
    }) => Promise<void>;
}

/** One assistant turn or one tool result, with its arrival time, used to
 * rebuild the session as child observations (generations + tool spans). */
export type TimelineEvent =
    | {
          kind: 'assistant';
          t: number;
          text: string[];
          toolUses: { id: string; name: string; input: unknown }[];
          usage: Record<string, unknown> | null;
      }
    | { kind: 'tool_result'; t: number; toolUseId: string; content: string; isError: boolean };

export interface AdapterResult {
    output: string;
    conversation: ConversationEntry[];
    timeline: TimelineEvent[];
    startedAt: number;
    rawStdout: string;
    metrics: Record<string, unknown>;
    harnessBroke: boolean;
    stderr: string;
}

export const DEFAULT_MAX_TURNS = 6;
const OPENROUTER_PROXY_URL = 'https://openrouter.apify.actor/api';
/** Child tool observations carry more of the result than the judge-facing
 * conversation JSON: the trace is where a human reads what the Actor returned. */
const CHILD_OUTPUT_CAP = 20_000;

function readFileSafe(path: string): string | null {
    try {
        return readFileSync(path, 'utf8').trim();
    } catch {
        return null;
    }
}

interface ParsedSession {
    conversation: ConversationEntry[];
    timeline: TimelineEvent[];
    mcpServers: { name: string; status: string }[] | null;
    mcpToolCount: number | null;
    finalResult: string | null;
    subtype: string | null;
    isError: boolean;
    usage: unknown;
    costUsd: number | null;
    numTurns: number | null;
}

/** Parse the claude --output-format stream-json session output into a
 * judge-ready conversation plus the final result summary. */
function parseSessionOutput(ndjson: string, lineTimes: number[] = [], fallbackTime = Date.now()): ParsedSession {
    const conversation: ConversationEntry[] = [];
    const timeline: TimelineEvent[] = [];
    let finalResult: string | null = null;
    let subtype: string | null = null;
    let isError = false;
    let usage: unknown = null;
    let costUsd: number | null = null;
    let numTurns: number | null = null;
    let mcpServers: ParsedSession['mcpServers'] = null;
    let mcpToolCount: number | null = null;
    const lines = ndjson.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let ev;
        try {
            ev = JSON.parse(line);
        } catch {
            continue;
        }
        const t = lineTimes[i] ?? fallbackTime;
        if (ev.type === 'system' && ev.subtype === 'init') {
            const init = parseInitEvent(ev);
            mcpServers = init.mcpServers;
            mcpToolCount = init.mcpToolCount;
            continue;
        }
        // Claude Code streams one assistant event per content block, sharing
        // message.id; fold them into one turn so the trace shows one
        // generation per model call, with that call's token usage.
        if (ev.type === 'assistant') {
            const last = timeline[timeline.length - 1];
            const msgId = ev.message?.id ?? null;
            let turn =
                last?.kind === 'assistant' && msgId && (last as { msgId?: string }).msgId === msgId ? last : null;
            if (!turn) {
                turn = { kind: 'assistant', t, text: [], toolUses: [], usage: null };
                (turn as { msgId?: string }).msgId = msgId;
                timeline.push(turn);
            }
            turn.t = t;
            turn.usage = ev.message?.usage ?? turn.usage;
            for (const block of ev.message?.content ?? []) {
                if (block.type === 'text' && block.text?.trim()) turn.text.push(String(block.text));
                else if (block.type === 'tool_use') {
                    turn.toolUses.push({ id: String(block.id ?? ''), name: String(block.name), input: block.input });
                }
            }
        } else if (ev.type === 'user') {
            for (const block of ev.message?.content ?? []) {
                if (block.type !== 'tool_result') continue;
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
                timeline.push({
                    kind: 'tool_result',
                    t,
                    toolUseId: String(block.tool_use_id ?? ''),
                    content,
                    isError: Boolean(block.is_error),
                });
            }
        }
        if (ev.type === 'assistant' || ev.type === 'user') {
            for (const block of ev.message?.content ?? []) {
                if (block.type === 'text' && block.text?.trim()) {
                    conversation.push({ role: ev.type, type: 'text', text: block.text.slice(0, TEXT_BLOCK_CAP) });
                } else if (block.type === 'tool_use') {
                    conversation.push({
                        role: 'assistant',
                        type: 'tool_call',
                        tool: block.name,
                        input: capToolInput(block.input),
                    });
                } else if (block.type === 'tool_result') {
                    const content =
                        typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
                    conversation.push({
                        role: 'tool',
                        type: 'tool_result',
                        preview: content.slice(0, TOOL_RESULT_CAP),
                    });
                }
            }
        } else if (ev.type === 'result') {
            subtype = ev.subtype ?? null;
            isError = ev.is_error ?? false;
            finalResult = ev.result ?? null;
            usage = ev.usage ?? null;
            costUsd = ev.total_cost_usd ?? null;
            numTurns = ev.num_turns ?? null;
        }
    }
    return {
        conversation,
        timeline,
        mcpServers,
        mcpToolCount,
        finalResult,
        subtype,
        isError,
        usage,
        costUsd,
        numTurns,
    };
}

/** The `system/init` event lists the MCP servers and every tool the agent has. */
function parseInitEvent(ev: { mcp_servers?: unknown; tools?: unknown }): {
    mcpServers: { name: string; status: string }[];
    mcpToolCount: number;
} {
    const servers = Array.isArray(ev.mcp_servers)
        ? (ev.mcp_servers as { name?: unknown; status?: unknown }[]).map((s) => ({
              name: String(s.name ?? 'unknown'),
              status: String(s.status ?? 'unknown'),
          }))
        : [];
    const tools = Array.isArray(ev.tools) ? (ev.tools as unknown[]).map(String) : [];
    return { mcpServers: servers, mcpToolCount: tools.filter((t) => t.startsWith('mcp__')).length };
}

/** True when the init line has arrived and shows an MCP server without any
 * mcp__ tools: the session is doomed to "I have no tools"; restart it. */
function initShowsMissingMcpTools(stdoutSoFar: string): boolean {
    const nl = stdoutSoFar.indexOf('\n');
    if (nl === -1) return false;
    try {
        const ev = JSON.parse(stdoutSoFar.slice(0, nl));
        if (ev.type !== 'system' || ev.subtype !== 'init') return false;
        const init = parseInitEvent(ev);
        return init.mcpServers.length > 0 && init.mcpToolCount === 0;
    } catch {
        return false;
    }
}

function lastAssistantText(conversation: ConversationEntry[]): string {
    return conversation.findLast((c) => c.role === 'assistant' && c.type === 'text')?.text ?? '';
}

function buildClaudeArgs(opts: {
    prompt: string;
    meta: DatasetItemMetadata;
    harness: HarnessConfig;
    mcpConfigPath: string | null;
}): string[] {
    const { prompt, meta, harness, mcpConfigPath } = opts;
    const allowedTools: string[] = [];
    if (meta.allowBash) allowedTools.push('Bash');

    const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        String(meta.maxTurns ?? harness.maxTurns),
        '--model',
        harness.model,
    ];
    if (mcpConfigPath) {
        args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
        allowedTools.push('mcp__apify__*');
    }
    if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(' '));
    return args;
}

function buildClaudeEnv(opts: {
    home: string;
    harness: HarnessConfig;
    apifyToken: string;
    useOpenRouterProxy: boolean;
}): Record<string, string | undefined> {
    const { home, harness, apifyToken, useOpenRouterProxy } = opts;
    return {
        PATH: process.env.PATH,
        // USER/LOGNAME/TMPDIR: required for macOS Keychain auth lookup in local
        // dev mode; harmless in the container.
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME ?? process.env.USER,
        TMPDIR: process.env.TMPDIR,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        ...(useOpenRouterProxy
            ? {
                  // Platform path: LLM access via the run's own APIFY_TOKEN, no
                  // external keys. HOME is the throwaway session dir so each
                  // session gets isolated claude state.
                  HOME: home,
                  ANTHROPIC_BASE_URL: OPENROUTER_PROXY_URL,
                  ANTHROPIC_AUTH_TOKEN: apifyToken,
                  ANTHROPIC_MODEL: harness.model,
                  ANTHROPIC_SMALL_FAST_MODEL: harness.model,
              }
            : // Local dev path: the real HOME, because the developer's own
              // Claude credentials live there.
              { HOME: process.env.HOME }),
    };
}

/**
 * Claude Code sometimes reports the MCP server as connected while exposing
 * none of its tools; the agent then answers "I have no tools" and the
 * scenario is lost for a reason that has nothing to do with the subject.
 * Detect it on the init line and restart the session once.
 */
async function runClaudeCode(ctx: SessionContext & { prompt: string }): Promise<AdapterResult> {
    const expectsMcp = Array.isArray(ctx.item.metadata?.tools) && ctx.item.metadata.tools.length > 0;
    let restarts = 0;
    for (;;) {
        const r = await runClaudeCodeOnce(ctx, expectsMcp && restarts < MAX_MCP_RESTARTS);
        const m = r.metrics as { mcpToolsMissing?: boolean };
        if (m.mcpToolsMissing && expectsMcp && restarts < MAX_MCP_RESTARTS) {
            restarts++;
            log.warning(`MCP tools missing at init; restarting session (${restarts}/${MAX_MCP_RESTARTS})`);
            continue;
        }
        (r.metrics as Record<string, unknown>).mcpRestarts = restarts;
        (r.metrics as Record<string, unknown>).mcpExpected = expectsMcp;
        return r;
    }
}

function runClaudeCodeOnce(
    ctx: SessionContext & { prompt: string },
    abortOnMissingMcp: boolean,
): Promise<AdapterResult> {
    const { prompt, item, harness, mcpUrl, apifyToken, useOpenRouterProxy, perItemTimeoutSecs } = ctx;
    return new Promise((resolve) => {
        const started = Date.now();
        const home = mkdtempSync(join(tmpdir(), 'eval-session-'));
        const meta = item.metadata ?? {};

        // All filesystem effects live here: session dir, then the token-bearing
        // MCP config when the item restricts tools.
        let mcpConfigPath: string | null = null;
        if (Array.isArray(meta.tools) && meta.tools.length > 0) {
            mcpConfigPath = join(home, 'mcp.json');
            writeFileSync(
                mcpConfigPath,
                JSON.stringify({
                    mcpServers: {
                        apify: {
                            type: 'http',
                            // Same URL builder as the schema snapshot, by construction.
                            url: toolsUrl(mcpUrl, meta.tools),
                            headers: { Authorization: `Bearer ${apifyToken}` },
                        },
                    },
                }),
            );
        }

        const args = buildClaudeArgs({ prompt, meta, harness, mcpConfigPath });
        const env = buildClaudeEnv({ home, harness, apifyToken, useOpenRouterProxy });

        // detached: the child leads its own process group, so the timeout kill
        // reaches grandchildren (Bash tool shells) that share the stdio pipes.
        const child = spawn('claude', args, {
            cwd: home,
            env: env as NodeJS.ProcessEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });

        // StringDecoder keeps multi-byte UTF-8 intact across chunk boundaries.
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        let out = '';
        let outBytes = 0;
        // Arrival time of every newline-terminated stdout line, by line index,
        // so the trace's child observations get real timings.
        const lineTimes: number[] = [];
        let stdoutTruncated = false;
        let errOut = '';
        let settled = false;
        let timedOut = false;
        let mcpToolsMissing = false;
        let initChecked = false;
        let peakRssMb = 0;
        let graceTimer: NodeJS.Timeout | null = null;

        // Linux/container only; /proc does not exist on macOS.
        const rssTimer =
            process.platform === 'linux'
                ? setInterval(() => {
                      const m = readFileSafe(`/proc/${child.pid}/status`)?.match(/VmRSS:\s+(\d+) kB/);
                      if (m) peakRssMb = Math.max(peakRssMb, Math.round(Number(m[1]) / 1024));
                  }, 1000)
                : null;

        const killTree = () => killProcessTree(child);
        const killer = setTimeout(() => {
            timedOut = true;
            killTree();
        }, perItemTimeoutSecs * 1000);

        const settle = ({
            exitCode = null,
            spawnError = null,
        }: {
            exitCode?: number | null;
            spawnError?: string | null;
        }) => {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            if (graceTimer) clearTimeout(graceTimer);
            if (rssTimer) clearInterval(rssTimer);
            try {
                rmSync(home, { recursive: true, force: true });
            } catch {
                /* best effort */
            }

            const {
                conversation,
                timeline,
                mcpServers,
                mcpToolCount,
                finalResult,
                subtype,
                isError,
                usage,
                costUsd,
                numTurns,
            } = parseSessionOutput(out, lineTimes);

            // Agent exhausted turns or hit our timeout: an eval result, not breakage.
            const ranOutOfTurns = subtype === 'error_max_turns';
            const harnessBroke =
                Boolean(spawnError) ||
                (!timedOut && !ranOutOfTurns && !mcpToolsMissing && finalResult === null && exitCode !== 0);

            resolve({
                output: finalResult ?? lastAssistantText(conversation),
                conversation,
                timeline,
                startedAt: started,
                rawStdout: out,
                metrics: {
                    harness: harness.kind,
                    model: harness.model,
                    exitCode,
                    subtype,
                    isError,
                    timedOut,
                    stdoutTruncated,
                    durationMs: Date.now() - started,
                    numTurns,
                    usage,
                    costUsd,
                    peakChildRssMb: peakRssMb || null,
                    toolCalls: conversation.filter((c) => c.type === 'tool_call').length,
                    mcpServers,
                    mcpToolCount,
                    mcpToolsMissing,
                },
                harnessBroke,
                stderr: (spawnError ?? errOut).slice(0, STDERR_CAP),
            });
        };

        // Cap is approximate: checked pre-append, so the final chunk may
        // overshoot. The dropped tail is tolerated because parseSessionOutput
        // skips unparseable lines.
        child.stdout.on('data', (d: Buffer) => {
            if (outBytes < MAX_STDOUT_BYTES) {
                const chunk = outDecoder.write(d);
                out += chunk;
                outBytes += d.length;
                const now = Date.now();
                for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) lineTimes.push(now);
                // First complete line = the init event. Kill early when the MCP
                // server exposed no tools; the caller restarts the session.
                if (!initChecked && out.includes('\n')) {
                    initChecked = true;
                    if (initShowsMissingMcpTools(out)) {
                        mcpToolsMissing = true;
                        if (abortOnMissingMcp) killTree();
                    }
                }
            } else {
                stdoutTruncated = true;
            }
        });
        child.stderr.on('data', (d: Buffer) => {
            if (errOut.length < STDERR_CAP) errOut += errDecoder.write(d);
        });
        child.on('error', (err) => settle({ spawnError: String(err.message ?? err) }));
        // close = stdio drained (normal path). exit + grace covers a grandchild
        // holding the pipes open after a kill, which would block close forever.
        child.on('close', (code) => settle({ exitCode: code }));
        child.on('exit', (code) => {
            graceTimer = setTimeout(() => settle({ exitCode: code }), EXIT_GRACE_MS);
        });
    });
}

const ADAPTERS: Record<string, (ctx: SessionContext & { prompt: string }) => Promise<AdapterResult>> = {
    'claude-code': runClaudeCode,
    codex: runCodex,
};

/** Validate harness config up front so a bad input fails fast, before any
 * Langfuse work starts. Single source of truth for supported kinds. */
export function validateHarness(harness: HarnessConfig): void {
    if (!ADAPTERS[harness.kind]) {
        throw new Error(`Unknown harness.kind "${harness.kind}" (supported: ${Object.keys(ADAPTERS).join(', ')})`);
    }
    if (typeof harness.model !== 'string' || harness.model.length === 0) {
        throw new Error('harness.model must be a non-empty model id string');
    }
}

/** Build the evidence snapshot for one finished session. */
async function collectEvidence(
    ctx: SessionContext,
    meta: DatasetItemMetadata,
    prompt: string,
    r: AdapterResult,
): Promise<Evidence> {
    const calls: RawToolCall[] = [];
    const results: RawToolResult[] = [];
    for (const e of r.timeline) {
        if (e.kind === 'assistant')
            for (const tu of e.toolUses) calls.push({ id: tu.id, name: tu.name, input: tu.input });
        else results.push({ toolUseId: e.toolUseId, content: e.content, isError: e.isError });
    }
    const extracted = extractFromTools(calls, results);
    const enriched = await enrichFromApify(extracted.actorRuns, extracted.datasetsRead);

    let reference = null;
    const refSpec = meta.reference as
        | { actor?: string; input: unknown; maxSecs?: number; cacheKey?: string }
        | undefined;
    if (refSpec?.input !== undefined) {
        const actor = refSpec.actor ?? (meta.subject as { id?: string } | undefined)?.id ?? meta.actor;
        if (actor)
            reference = await ctx.references.run({
                actor,
                input: refSpec.input,
                maxSecs: refSpec.maxSecs,
                cacheKey: refSpec.cacheKey,
            });
    }

    const m = r.metrics as {
        timedOut?: boolean;
        stdoutTruncated?: boolean;
        exitCode?: number | null;
        subtype?: string | null;
        mcpServers?: { name: string; status: string }[] | null;
        mcpToolCount?: number | null;
        mcpExpected?: boolean;
        mcpRestarts?: number;
    };
    return {
        prompt,
        finalResult: r.output,
        toolCalls: extracted.toolCalls,
        actorRuns: enriched.actorRuns,
        datasets: enriched.datasets,
        reference,
        session: {
            timedOut: Boolean(m.timedOut),
            stdoutTruncated: Boolean(m.stdoutTruncated),
            harnessBroke: r.harnessBroke,
            exitCode: m.exitCode ?? null,
            subtype: m.subtype ?? null,
            ...(m.mcpServers ? { mcpServers: m.mcpServers } : {}),
            ...(typeof m.mcpToolCount === 'number' ? { mcpToolCount: m.mcpToolCount } : {}),
            mcpExpected: Boolean(m.mcpExpected),
            mcpRestarts: m.mcpRestarts ?? 0,
        },
    };
}

/**
 * Write check.<id> per check (not-applicable checks are skipped, not failed),
 * plus check.all (every fail-severity check passed) and check.infra (no
 * infrastructure failure: Actor runs finished, session did not time out).
 */
async function writeCheckScores(
    ctx: SessionContext,
    traceId: string,
    observationId: string,
    checks: ReturnType<typeof runChecks>,
    infra: ReturnType<typeof infraStatus>,
): Promise<void> {
    const write = (name: string, value: number, comment: string) =>
        ctx.writeScore({ traceId, observationId, name, value, comment: comment.slice(0, 1000) }).catch((err) => {
            log.warning(`score ${name} failed: ${err}`);
        });
    for (const c of checks) {
        if (!c.applicable) {
            log.info(`check.${c.id} not applicable: ${c.comment}`);
            continue;
        }
        await write(
            `check.${c.id}`,
            c.value,
            `${c.passed ? 'PASS' : 'FAIL'}${c.severity === 'warn' ? ' (warn)' : ''}: ${c.comment}`,
        );
    }
    const gating = checks.filter((c) => c.applicable && c.severity === 'fail');
    const failed = gating.filter((c) => !c.passed);
    const skipped = checks.filter((c) => !c.applicable);
    if (gating.length > 0 || skipped.length > 0) {
        await write(
            'check.all',
            failed.length === 0 ? 1 : 0,
            failed.length === 0
                ? `${gating.length} check(s) passed${skipped.length ? `; ${skipped.length} not applicable` : ''}`
                : `failed: ${failed.map((c) => c.id).join(', ')}${skipped.length ? `; not applicable: ${skipped.map((c) => c.id).join(', ')}` : ''}`,
        );
    }
    await write('check.infra', infra.ok ? 1 : 0, infra.ok ? 'no infrastructure failure' : infra.reasons.join('; '));
}

/**
 * Rebuild the session as child observations of the agent span so the trace
 * view shows the flow: one generation per model turn (text, tool calls,
 * token usage) and one tool observation per tool call (arguments in, result
 * out, errors marked). Times come from stdout arrival, so durations are real.
 * The judge does not read these; it reads the conversation JSON on the span.
 */
function emitTimeline(
    span: { otelSpan: { spanContext: () => unknown } },
    timeline: TimelineEvent[],
    startedAt: number,
    prompt: string,
    model: string,
): void {
    type Child = { update: (attrs: Record<string, unknown>) => unknown; end: (t?: Date) => void };
    // The top-level startObservation honours startTime; the parent link is
    // explicit because these are created after the fact, not in the active
    // context of the moment they happened.
    const parentSpanContext = span.otelSpan.spanContext();
    const start = (name: string, attrs: Record<string, unknown>, asType: 'generation' | 'tool', t: number): Child =>
        (startObservation as unknown as (n: string, a: unknown, o: unknown) => Child)(name, attrs, {
            asType,
            startTime: new Date(t),
            parentSpanContext,
        });

    const pending = new Map<string, { obs: Child; name: string }>();
    let lastInput: unknown = prompt;
    let pendingResults: { tool: string; result: string }[] = [];
    let prevT = startedAt;
    let turnNo = 0;
    for (const e of timeline) {
        if (e.kind === 'assistant') {
            turnNo++;
            const u = (e.usage ?? {}) as Record<string, number>;
            const usageDetails: Record<string, number> = {};
            if (typeof u.input_tokens === 'number') usageDetails.input = u.input_tokens;
            if (typeof u.output_tokens === 'number') usageDetails.output = u.output_tokens;
            if (typeof u.cache_read_input_tokens === 'number') usageDetails.cache_read = u.cache_read_input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number') {
                usageDetails.cache_creation = u.cache_creation_input_tokens;
            }
            const gen = start(
                `turn ${turnNo}`,
                {
                    model,
                    input: lastInput,
                    output: {
                        text: e.text.join('\n\n').slice(0, CHILD_OUTPUT_CAP),
                        toolCalls: e.toolUses.map((tu) => ({ tool: tu.name, input: capToolInput(tu.input) })),
                    },
                    ...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
                },
                'generation',
                prevT,
            );
            gen.end(new Date(e.t));
            for (const tu of e.toolUses) {
                const name = tu.name.replace(/^mcp__apify__/, '');
                pending.set(tu.id, { obs: start(name, { input: tu.input }, 'tool', e.t), name });
            }
            pendingResults = [];
            lastInput = null;
        } else {
            const p = pending.get(e.toolUseId);
            const out = e.content.slice(0, CHILD_OUTPUT_CAP);
            if (p) {
                // Actor run links straight from the trace: the most useful
                // thing for an Actor engineer reading a failed scenario.
                const links: Record<string, string> = {};
                if (p.name === 'call-actor' || p.name === 'get-actor-run') {
                    const m = e.content.match(/"runId"\s*:\s*"([A-Za-z0-9]{17})"/);
                    if (m) links.apifyRunUrl = `https://console.apify.com/actors/runs/${m[1]}`;
                    const d = e.content.match(
                        /"datasets"\s*:\s*\{\s*"default"\s*:\s*\{\s*"id"\s*:\s*"([A-Za-z0-9]{17})"/,
                    );
                    if (d) links.datasetUrl = `https://console.apify.com/storage/datasets/${d[1]}`;
                }
                p.obs.update({
                    output: out,
                    ...(Object.keys(links).length > 0 ? { metadata: links } : {}),
                    ...(e.isError ? { level: 'ERROR', statusMessage: 'tool returned an error' } : {}),
                });
                p.obs.end(new Date(e.t));
                pending.delete(e.toolUseId);
            }
            pendingResults.push({ tool: p?.name ?? 'unknown', result: out.slice(0, TOOL_RESULT_CAP) });
            lastInput = pendingResults;
        }
        prevT = e.t;
    }
    for (const { obs } of pending.values()) {
        obs.update({ level: 'WARNING', statusMessage: 'no result before the session ended' });
        obs.end(new Date(prevT));
    }
}

/**
 * Run one session inside a Langfuse "agent" span attached to the experiment
 * trace. Emits the v1 contract: validated output + metadata, full log and
 * tool-schema snapshot in the named artifact store, pointers on the span.
 */
export async function runSession(ctx: SessionContext): Promise<{ output: string }> {
    const { item, harness } = ctx;
    const input = item.input as { prompt?: string } | string | undefined;
    const prompt = typeof input === 'string' ? input : (input?.prompt ?? JSON.stringify(input));
    const adapter = ADAPTERS[harness.kind];

    // Trace tags are what Langfuse dashboards can group by, so this is where
    // the team-facing slicing (per actor / team / skill) is wired in.
    const meta = item.metadata ?? {};
    const tags = [
        `dataset:${ctx.datasetName}`,
        `model:${harness.model}`,
        ...(meta.actor ? [`actor:${meta.actor}`] : []),
        ...(meta.team ? [`team:${meta.team}`] : []),
        ...(meta.skill ? [`skill:${meta.skill}`] : []),
    ];
    // The experiment-item-run span is active here (the SDK opened it around
    // the task): checks are scored onto it, because that is the observation
    // the compare view and the run aggregates read.
    const rootSpanId = trace.getActiveSpan()?.spanContext().spanId ?? null;

    const runInSpan = () =>
        startActiveObservation(
            'agent',
            async (span) => {
                const r = await adapter({ ...ctx, prompt });
                emitTimeline(span, r.timeline, r.startedAt, prompt, harness.model);

                const traceId = span.otelSpan.spanContext().traceId;
                const logRef = await ctx.artifactStore.putLog(traceId, r.rawStdout);

                // Evidence: what the agent actually did, from full tool results,
                // enriched from the Apify API, frozen as an artifact. Checks run
                // here so the judge (and any re-judge) reads results, not live data.
                const evidence = await collectEvidence(ctx, meta, prompt, r);
                const checks = runChecks((meta.checks ?? []) as DeterministicCheck[], evidence);
                const infra = infraStatus(evidence);
                const evidenceRef = await ctx.artifactStore
                    .putJson(`evidence-${traceId}`, { evidence, checks, infra })
                    .catch((err) => {
                        log.warning(`evidence artifact failed: ${err}`);
                        return null;
                    });
                if (rootSpanId) {
                    await writeCheckScores(ctx, traceId, rootSpanId, checks, infra);
                } else {
                    log.warning('no active experiment span; check scores not written');
                }

                const tools = item.metadata?.tools;
                let snapshotRef = null;
                if (Array.isArray(tools) && tools.length > 0) {
                    snapshotRef = await ctx.snapshots.get(tools).catch((err) => {
                        log.warning(`tool-schema snapshot failed (judge will mark schema-validity n/a): ${err}`);
                        return null;
                    });
                }

                // finalResult first: the collapsed preview in the trace reads the answer.
                const output: AgentSpanOutput = {
                    finalResult: r.output,
                    contractVersion: CONTRACT_VERSION,
                    conversation: r.conversation,
                };
                const metadata: AgentSpanMetadata = {
                    ...(r.metrics as object),
                    harness: harness.kind,
                    model: harness.model,
                    harnessBroke: r.harnessBroke,
                    fullLogUrl: logRef.url,
                    fullLogHash: logRef.hash,
                    ...(snapshotRef
                        ? { toolSchemaSnapshotUrl: snapshotRef.url, toolSchemaHash: snapshotRef.hash }
                        : {}),
                    // Item identity for the judge's per-actor scoreboard.
                    ...(item.id ? { itemId: String(item.id) } : {}),
                    ...(meta.title ? { itemTitle: String(meta.title) } : {}),
                    ...(meta.actor ? { itemActor: String(meta.actor) } : {}),
                    ...(meta.team ? { itemTeam: String(meta.team) } : {}),
                    ...(meta.skill ? { itemSkill: String(meta.skill) } : {}),
                    ...(meta.profile ? { itemProfile: String(meta.profile) } : {}),
                    ...(meta.owner ? { itemOwner: String(meta.owner) } : {}),
                    ...((meta.subject as { id?: string } | undefined)?.id
                        ? { itemSubject: String((meta.subject as { id: string }).id) }
                        : {}),
                    // Evidence pointers and the deterministic verdicts, for the judge.
                    ...(evidenceRef ? { evidenceUrl: evidenceRef.url, evidenceHash: evidenceRef.hash } : {}),
                    actorRuns: summarizeRuns(evidence),
                    actorRunsCostUsd: evidence.actorRuns.reduce((acc, run) => acc + (run.costUsd ?? 0), 0),
                    toolsUsed: [...new Set(evidence.toolCalls.map((c) => c.tool.replace(/^mcp__[^_]+__/, '')))],
                    checksPassed: checks.filter((c) => c.applicable && c.passed).length,
                    checksTotal: checks.filter((c) => c.applicable).length,
                    infraOk: infra.ok,
                    infraReasons: infra.reasons,
                };

                // Emit-side contract enforcement: an invalid span is a runner bug.
                if (!validateAgentSpanOutput(output)) {
                    throw new Error(`contract violation (output): ${JSON.stringify(validateAgentSpanOutput.errors)}`);
                }
                if (!validateAgentSpanMetadata(metadata)) {
                    throw new Error(
                        `contract violation (metadata): ${JSON.stringify(validateAgentSpanMetadata.errors)}`,
                    );
                }

                span.update({ input: prompt, output, metadata });
                if (r.harnessBroke) throw new Error(`Harness broke: ${r.stderr || 'no output'}`);
                return { output: r.output };
            },
            { asType: 'agent' },
        );

    // Langfuse dashboards can group scores only by a fixed set of trace
    // attributes (tags group by the whole array, not per tag; a score's
    // sessionId is its own subject, not the trace's), so the team-facing
    // slices are mapped onto them: userId = Actor (per-Actor widgets),
    // version = model, sessionId = Actor too (the Sessions page then lists
    // every trace of one Actor). Team stays a tag (dashboard-level filter);
    // skill has no slot (Found vs Works uses the run-level rates).
    return propagateAttributes(
        {
            tags,
            version: harness.model,
            ...(meta.actor ? { sessionId: String(meta.actor), userId: String(meta.actor) } : {}),
            ...(typeof meta.title === 'string' && meta.title ? { traceName: meta.title } : {}),
        },
        runInSpan,
    );
}
