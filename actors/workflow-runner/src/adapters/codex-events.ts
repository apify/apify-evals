import type { ConversationEntry } from '@apify-evals/contract';

import type { TimelineEvent } from '../harness.js';
import { capToolInput, TEXT_BLOCK_CAP, TOOL_RESULT_CAP } from './shared.js';

type AssistantTurn = Extract<TimelineEvent, { kind: 'assistant' }>;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function parseCodexLine(line: string): JsonObject | null {
    try {
        return object(JSON.parse(line));
    } catch {
        return null;
    }
}

export function codexToolName(server: string, tool: string): string {
    return tool.startsWith('mcp__') ? tool : `mcp__${server}__${tool}`;
}

function toolContent(item: JsonObject): string {
    const result = object(item.result);
    // Preserve machine-readable data for extractFromTools, rather than a JSON
    // envelope around escaped text blocks that the evidence parser cannot read.
    if (result?.structured_content != null) return JSON.stringify(result.structured_content);
    if (result?.structuredContent != null) return JSON.stringify(result.structuredContent);
    if (Array.isArray(result?.content)) {
        return result.content
            .map((block) => {
                const b = object(block);
                return b?.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(block);
            })
            .join('\n');
    }
    return JSON.stringify(item.error ?? item.result ?? null);
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Injected skills whose `SKILL.md` the agent read. Codex emits no skill event:
 * it lists skills in the prompt by path and the model reads the file with its
 * shell. A skill counts when a command that succeeded names its `SKILL.md`
 * (`.../<name>/SKILL.md`, or `cd .../<name> && cat SKILL.md`) and its output
 * shows the file's frontmatter `name:` line, so `ls`, `test -f`, `wc` or a
 * failed `cat` do not count. MCP calls (a URL that names a SKILL.md) do not.
 */
export function codexSkillsRead(ndjson: string, skillSet: string[]): string[] {
    if (skillSet.length === 0) return [];
    const read = new Set<string>();
    for (const line of ndjson.split('\n')) {
        const event = parseCodexLine(line);
        const item = object(event?.item);
        if (event?.type !== 'item.completed' || item?.type !== 'command_execution' || item.exit_code !== 0) continue;
        const command = typeof item.command === 'string' ? item.command : '';
        const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
        for (const name of skillSet) {
            const n = escapeRe(name);
            // A path segment: not part of a longer name such as foo-bar for bar.
            const names =
                new RegExp(`(?:^|[\\s/'"=])${n}/SKILL\\.md\\b`).test(command) ||
                (new RegExp(`(?:^|[\\s/'"=])${n}/?(?:[\\s'";&|)]|$)`).test(command) && /\bSKILL\.md\b/.test(command));
            const body = new RegExp(`^name:\\s*['"]?${n}['"]?\\s*$`, 'm').test(output);
            if (names && body) read.add(name);
        }
    }
    return [...read].sort();
}

/**
 * Tool rounds, the unit of the turn budget, by the rule the trace uses for
 * generations: calls started together form one round, and a call that starts
 * after any call of the current round returned opens the next one. A call that
 * is still running (unified exec keeps a long command alive) does not hold the
 * round open. Codex emits no item for `write_stdin` or for a refused
 * escalation request, so those cost no round.
 */
export class ToolRounds {
    count = 0;
    private open = false;
    private returned = false;
    private readonly seen = new Set<string>();
    /** Calls of the current round that have not returned. */
    private pending = new Set<string>();

    /** Record a call's first event; true when it opens a new round. */
    start(id: string): boolean {
        if (this.seen.has(id)) return false;
        this.seen.add(id);
        if (this.open && !this.returned) {
            this.pending.add(id);
            return false;
        }
        this.count++;
        this.open = true;
        this.returned = false;
        this.pending = new Set([id]);
        return true;
    }

    /** Record a call's result; true when every call of the current round has returned. */
    complete(id: string): boolean {
        if (!this.pending.delete(id)) return false;
        this.returned = true;
        return this.pending.size === 0;
    }
}

export interface ParsedCodexSession {
    conversation: ConversationEntry[];
    timeline: TimelineEvent[];
    finalResult: string;
    usage: Record<string, number> | null;
    numTurns: number;
    toolRounds: number;
    completed: boolean;
    failed: boolean;
    errors: string[];
}

/** Codex's user turn can contain several model calls. Group assistant items
 * until a tool result arrives, then start the next generation. JSONL does not
 * expose per-model-call usage, so keep aggregate usage on session metrics. */
export function parseCodexEvents(
    ndjson: string,
    lineTimes: number[] = [],
    fallbackTime = Date.now(),
): ParsedCodexSession {
    const conversation: ConversationEntry[] = [];
    const timeline: TimelineEvent[] = [];
    const errors: string[] = [];
    const calls = new Set<string>();
    const completedItems = new Set<string>();
    let current: AssistantTurn | undefined;
    const rounds = new ToolRounds();
    let finalResult = '';
    let usage: Record<string, number> | null = null;
    let completed = false;
    let failed = false;
    const turn = (t: number): AssistantTurn => {
        if (!current) {
            current = { kind: 'assistant', t, text: [], toolUses: [], usage: null };
            timeline.push(current);
        }
        current.t = t;
        return current;
    };

    for (const [index, line] of ndjson.split('\n').entries()) {
        const event = parseCodexLine(line);
        if (!event) continue;
        const t = lineTimes[index] ?? fallbackTime;
        if (event.type === 'turn.started') current = undefined;
        if (event.type === 'turn.completed') {
            completed = true;
            failed = false;
            const raw = object(event.usage);
            if (raw) {
                usage ??= {};
                for (const [key, value] of Object.entries(raw)) {
                    if (typeof value === 'number' && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
                }
            }
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
            failed = true;
            const message = object(event.error)?.message ?? event.message;
            if (typeof message === 'string') errors.push(message);
        }
        const item = object(event.item);
        if (!item || typeof item.id !== 'string') continue;
        const isCompleted = event.type === 'item.completed';
        if (isCompleted && completedItems.has(item.id)) continue;
        if (isCompleted) completedItems.add(item.id);

        if (item.type === 'agent_message' && isCompleted && typeof item.text === 'string' && item.text.trim()) {
            turn(t).text.push(item.text);
            finalResult = item.text;
            conversation.push({ role: 'assistant', type: 'text', text: item.text.slice(0, TEXT_BLOCK_CAP) });
        } else if (item.type === 'reasoning' && isCompleted && typeof item.text === 'string') {
            // Reasoning is useful in the generation, but is not an answer for the judge.
            turn(t).text.push(`[Reasoning] ${item.text}`);
        } else if (item.type === 'mcp_tool_call' && typeof item.server === 'string' && typeof item.tool === 'string') {
            if (!calls.has(item.id)) {
                calls.add(item.id);
                rounds.start(item.id);
                const name = codexToolName(item.server, item.tool);
                turn(t).toolUses.push({ id: item.id, name, input: item.arguments });
                conversation.push({
                    role: 'assistant',
                    type: 'tool_call',
                    tool: name,
                    input: capToolInput(item.arguments),
                });
            }
            if (isCompleted) {
                rounds.complete(item.id);
                const content = toolContent(item);
                const result = object(item.result);
                const isError =
                    item.status === 'failed' || item.error != null || Boolean(result?.isError ?? result?.is_error);
                timeline.push({ kind: 'tool_result', t, toolUseId: item.id, content, isError });
                conversation.push({ role: 'tool', type: 'tool_result', preview: content.slice(0, TOOL_RESULT_CAP) });
                current = undefined;
            }
        } else if (item.type === 'command_execution' && typeof item.command === 'string') {
            // Recorded as `Bash`, the name Claude Code uses, so the evidence
            // extraction reads shell commands of both harnesses the same way.
            if (!calls.has(item.id)) {
                calls.add(item.id);
                rounds.start(item.id);
                const input = { command: item.command };
                turn(t).toolUses.push({ id: item.id, name: 'Bash', input });
                conversation.push({ role: 'assistant', type: 'tool_call', tool: 'Bash', input: capToolInput(input) });
            }
            if (isCompleted) {
                rounds.complete(item.id);
                const content = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
                const isError =
                    item.status === 'failed' ||
                    item.status === 'declined' ||
                    (typeof item.exit_code === 'number' && item.exit_code !== 0);
                timeline.push({ kind: 'tool_result', t, toolUseId: item.id, content, isError });
                conversation.push({ role: 'tool', type: 'tool_result', preview: content.slice(0, TOOL_RESULT_CAP) });
                current = undefined;
            }
        } else if (item.type === 'error' && isCompleted && typeof item.message === 'string') {
            // Metadata warnings also use item/error. Only turn.failed or a
            // terminal error makes a session fail; warnings alone do not.
            errors.push(item.message);
        }
    }
    const turns = timeline.filter((e): e is AssistantTurn => e.kind === 'assistant');
    if (turns.length === 1 && usage) {
        turns[0].usage = { ...usage, cache_read_input_tokens: usage.cached_input_tokens ?? 0 };
    }
    return {
        conversation,
        timeline,
        finalResult,
        usage,
        numTurns: turns.length,
        toolRounds: rounds.count,
        completed,
        failed,
        errors,
    };
}
