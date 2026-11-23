import type { ConversationEntry } from '@apify-evals/contract';

import type { TimelineEvent } from '../harness.js';
import { capToolInput, TEXT_BLOCK_CAP, TOOL_RESULT_CAP } from './shared.js';

type AssistantTurn = Extract<TimelineEvent, { kind: 'assistant' }>;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function parseOpenCodeLine(line: string): JsonObject | null {
    try {
        return object(JSON.parse(line));
    } catch {
        return null;
    }
}

/**
 * OpenCode built-in tools under the names Claude Code gives them, so the
 * evidence extractor and the surface detection (`Bash` commands, `WebFetch`
 * URLs) read an OpenCode session like a Claude Code one. The inputs already
 * match (`command`, `url`, `filePath`).
 */
const BUILTIN_TOOL_NAMES: Record<string, string> = {
    shell: 'Bash',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    read: 'Read',
    glob: 'Glob',
    grep: 'Grep',
    edit: 'Edit',
    write: 'Write',
    skill: 'Skill',
};

/** OpenCode's registry namespace for an MCP server (`McpTool.namespace` in its source). */
export function openCodeNamespace(server: string): string {
    return server.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * `apify_search-actors` becomes `mcp__apify__search-actors`, the Claude Code
 * form the checks and the judge expect. OpenCode joins the server namespace
 * and the tool with `_`, so the configured server names decide the split.
 */
export function openCodeToolName(tool: string, mcpServers: string[]): string {
    if (BUILTIN_TOOL_NAMES[tool]) return BUILTIN_TOOL_NAMES[tool];
    // Longest namespace first: `apify_x` must not take a tool of server `apify_x_y`.
    const servers = [...mcpServers].sort((a, b) => b.length - a.length);
    for (const server of servers) {
        const prefix = `${openCodeNamespace(server)}_`;
        if (tool.startsWith(prefix) && tool.length > prefix.length)
            return `mcp__${server}__${tool.slice(prefix.length)}`;
    }
    return tool;
}

export interface ParsedOpenCodeSession {
    conversation: ConversationEntry[];
    timeline: TimelineEvent[];
    finalResult: string;
    /** Summed over steps, in the Anthropic-style keys the trace and the metrics use. */
    usage: Record<string, number> | null;
    /** Model calls (OpenCode "steps"). */
    numTurns: number;
    /** Steps that called at least one tool. */
    toolRounds: number;
    /** Skill ids the agent loaded through the skill tool. */
    skillsUsed: string[];
    errors: string[];
    /** Provider errors OpenCode retried (it retries transport failures with backoff until the session ends). */
    retries: string[];
    sessionId: string | null;
}

/** OpenCode step tokens: `input` excludes cache reads; `output` excludes reasoning, which is billed as output. */
function stepUsage(tokens: unknown): Record<string, number> | null {
    const t = object(tokens);
    if (!t) return null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const cache = object(t.cache);
    return {
        input_tokens: n(t.input),
        output_tokens: n(t.output) + n(t.reasoning),
        reasoning_tokens: n(t.reasoning),
        cache_read_input_tokens: n(cache?.read),
        cache_creation_input_tokens: n(cache?.write),
    };
}

/**
 * Parse `opencode run --format json`. Each step (one model call) opens with
 * `step_start` and closes with `step_finish` (its token usage); `text` and
 * `tool_use` events in between belong to it. A `tool_use` event arrives when
 * the tool has finished and carries both the input and the result, so it
 * becomes one tool call on the turn and one tool result after it.
 */
export function parseOpenCodeEvents(
    ndjson: string,
    opts: { mcpServers?: string[]; lineTimes?: number[]; fallbackTime?: number } = {},
): ParsedOpenCodeSession {
    const mcpServers = opts.mcpServers ?? [];
    const lineTimes = opts.lineTimes ?? [];
    const fallbackTime = opts.fallbackTime ?? Date.now();
    const conversation: ConversationEntry[] = [];
    const timeline: TimelineEvent[] = [];
    const errors: string[] = [];
    const retries: string[] = [];
    const skillsUsed = new Set<string>();
    const seenTools = new Set<string>();
    let current: AssistantTurn | undefined;
    let finalResult = '';
    let usage: Record<string, number> | null = null;
    let numTurns = 0;
    let toolRounds = 0;
    let sessionId: string | null = null;
    const turn = (t: number): AssistantTurn => {
        if (!current) {
            current = { kind: 'assistant', t, text: [], toolUses: [], usage: null };
            timeline.push(current);
        }
        return current;
    };

    for (const [index, line] of ndjson.split('\n').entries()) {
        const event = parseOpenCodeLine(line);
        if (!event) continue;
        const t =
            typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
                ? event.timestamp
                : (lineTimes[index] ?? fallbackTime);
        if (typeof event.sessionID === 'string' && event.sessionID) sessionId ??= event.sessionID;
        const part = object(event.part);
        if (event.type === 'step_start') {
            numTurns++;
            current = undefined;
            turn(t);
        } else if (event.type === 'text' && typeof part?.text === 'string') {
            if (!part.text.trim()) continue;
            const time = object(part.time);
            const at = typeof time?.end === 'number' ? time.end : t;
            const target = turn(at);
            target.text.push(part.text);
            target.t = Math.max(target.t, at);
            finalResult = part.text;
            conversation.push({ role: 'assistant', type: 'text', text: part.text.slice(0, TEXT_BLOCK_CAP) });
        } else if (event.type === 'reasoning' && typeof part?.text === 'string' && part.text.trim()) {
            // Reasoning belongs in the generation, not in the judge's answer.
            turn(t).text.push(`[Reasoning] ${part.text}`);
        } else if (event.type === 'tool_use' && part && typeof part.tool === 'string') {
            const id = typeof part.id === 'string' && part.id ? part.id : `tool_${index}`;
            if (seenTools.has(id)) continue;
            seenTools.add(id);
            const state = object(part.state) ?? {};
            const input = state.input ?? {};
            const name = openCodeToolName(part.tool, mcpServers);
            const time = object(state.time);
            const started = typeof time?.start === 'number' ? time.start : t;
            const target = turn(started);
            // The generation ended when its first tool started.
            if (target.toolUses.length === 0 && target.text.length === 0) target.t = started;
            if (target.toolUses.length === 0) toolRounds++;
            target.toolUses.push({ id, name, input });
            conversation.push({ role: 'assistant', type: 'tool_call', tool: name, input: capToolInput(input) });
            const isError = state.status === 'error';
            const content = isError
                ? String(state.error ?? 'tool failed')
                : typeof state.output === 'string'
                  ? state.output
                  : JSON.stringify(state.output ?? null);
            if (part.tool === 'skill' && !isError) {
                const skill = object(input)?.id;
                if (typeof skill === 'string') skillsUsed.add(skill);
            }
            timeline.push({ kind: 'tool_result', t, toolUseId: id, content, isError });
            conversation.push({ role: 'tool', type: 'tool_result', preview: content.slice(0, TOOL_RESULT_CAP) });
        } else if (event.type === 'step_finish') {
            const u = stepUsage(part?.tokens);
            if (u) {
                if (current) current.usage = u;
                usage ??= {};
                for (const [key, value] of Object.entries(u)) usage[key] = (usage[key] ?? 0) + value;
            }
            current = undefined;
        } else if (event.type === 'retry') {
            const error = object(event.error);
            retries.push(typeof error?.message === 'string' ? error.message : JSON.stringify(event.error ?? event));
        } else if (event.type === 'error') {
            const error = object(event.error);
            const message = typeof error?.message === 'string' ? error.message : JSON.stringify(event.error ?? event);
            errors.push(message);
        }
    }
    return {
        conversation,
        timeline,
        finalResult,
        usage,
        numTurns,
        toolRounds,
        skillsUsed: [...skillsUsed].sort(),
        errors,
        retries,
        sessionId,
    };
}
