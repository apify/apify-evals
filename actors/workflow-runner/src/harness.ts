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
    validateAgentSpanMetadata,
    validateAgentSpanOutput,
} from '@apify-evals/contract';
import { startActiveObservation } from '@langfuse/tracing';
import { log } from 'apify';

import { toolsUrl, type ArtifactStore, type SnapshotCache } from './artifacts.js';

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
    item: { input?: unknown; metadata?: DatasetItemMetadata | null };
    harness: HarnessConfig;
    mcpUrl: string;
    apifyToken: string;
    useOpenRouterProxy: boolean;
    perItemTimeoutSecs: number;
    artifactStore: ArtifactStore;
    snapshots: SnapshotCache;
}

interface AdapterResult {
    output: string;
    conversation: ConversationEntry[];
    rawStdout: string;
    metrics: Record<string, unknown>;
    harnessBroke: boolean;
    stderr: string;
}

export const DEFAULT_MAX_TURNS = 6;
const OPENROUTER_PROXY_URL = 'https://openrouter.apify.actor/api';
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const TEXT_BLOCK_CAP = 4000;
const TOOL_INPUT_CAP = 2000;
const TOOL_RESULT_CAP = 2000;
const STDERR_CAP = 2000;
const EXIT_GRACE_MS = 1000;

function readFileSafe(path: string): string | null {
    try {
        return readFileSync(path, 'utf8').trim();
    } catch {
        return null;
    }
}

/** Keep tool inputs small on the span (spec D10): objects pass through when
 * compact, oversized ones become a truncated JSON string preview. */
function capToolInput(input: unknown): unknown {
    const json = JSON.stringify(input ?? null);
    return json.length <= TOOL_INPUT_CAP ? input : json.slice(0, TOOL_INPUT_CAP);
}

interface ParsedSession {
    conversation: ConversationEntry[];
    finalResult: string | null;
    subtype: string | null;
    isError: boolean;
    usage: unknown;
    costUsd: number | null;
    numTurns: number | null;
}

/** Parse the claude --output-format stream-json session output into a
 * judge-ready conversation plus the final result summary. */
function parseSessionOutput(ndjson: string): ParsedSession {
    const conversation: ConversationEntry[] = [];
    let finalResult: string | null = null;
    let subtype: string | null = null;
    let isError = false;
    let usage: unknown = null;
    let costUsd: number | null = null;
    let numTurns: number | null = null;
    for (const line of ndjson.split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try {
            ev = JSON.parse(line);
        } catch {
            continue;
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
    return { conversation, finalResult, subtype, isError, usage, costUsd, numTurns };
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

function runClaudeCode(ctx: SessionContext & { prompt: string }): Promise<AdapterResult> {
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
        let stdoutTruncated = false;
        let errOut = '';
        let settled = false;
        let timedOut = false;
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

        const killTree = () => {
            try {
                process.kill(-(child.pid as number), 'SIGKILL');
            } catch {
                try {
                    child.kill('SIGKILL');
                } catch {
                    /* already gone */
                }
            }
        };
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

            const { conversation, finalResult, subtype, isError, usage, costUsd, numTurns } = parseSessionOutput(out);

            // Agent exhausted turns or hit our timeout: an eval result, not breakage.
            const ranOutOfTurns = subtype === 'error_max_turns';
            const harnessBroke =
                Boolean(spawnError) || (!timedOut && !ranOutOfTurns && finalResult === null && exitCode !== 0);

            resolve({
                output: finalResult ?? lastAssistantText(conversation),
                conversation,
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
                out += outDecoder.write(d);
                outBytes += d.length;
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

    return startActiveObservation(
        'agent',
        async (span) => {
            const r = await adapter({ ...ctx, prompt });

            const traceId = span.otelSpan.spanContext().traceId;
            const logRef = await ctx.artifactStore.putLog(traceId, r.rawStdout);

            const tools = item.metadata?.tools;
            let snapshotRef = null;
            if (Array.isArray(tools) && tools.length > 0) {
                snapshotRef = await ctx.snapshots.get(tools).catch((err) => {
                    log.warning(`tool-schema snapshot failed (judge will mark schema-validity n/a): ${err}`);
                    return null;
                });
            }

            const output: AgentSpanOutput = {
                contractVersion: CONTRACT_VERSION,
                conversation: r.conversation,
                finalResult: r.output,
            };
            const metadata: AgentSpanMetadata = {
                ...(r.metrics as object),
                harness: harness.kind,
                model: harness.model,
                harnessBroke: r.harnessBroke,
                fullLogUrl: logRef.url,
                fullLogHash: logRef.hash,
                ...(snapshotRef ? { toolSchemaSnapshotUrl: snapshotRef.url, toolSchemaHash: snapshotRef.hash } : {}),
            };

            // Emit-side contract enforcement: an invalid span is a runner bug.
            if (!validateAgentSpanOutput(output)) {
                throw new Error(`contract violation (output): ${JSON.stringify(validateAgentSpanOutput.errors)}`);
            }
            if (!validateAgentSpanMetadata(metadata)) {
                throw new Error(`contract violation (metadata): ${JSON.stringify(validateAgentSpanMetadata.errors)}`);
            }

            span.update({ input: prompt, output, metadata });
            if (r.harnessBroke) throw new Error(`Harness broke: ${r.stderr || 'no output'}`);
            return { output: r.output };
        },
        { asType: 'agent' },
    );
}
