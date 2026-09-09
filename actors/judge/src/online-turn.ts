/**
 * Online-eval turn reconstruction (ai-team#269): rebuild what the agent saw
 * and did in one production turn from the trace's observations, so the judge
 * can score it without re-running the agent.
 *
 * What the exporter actually writes (apify-ai-agent on Mastra 1.61 with
 * `@mastra/otel-exporter`; read from the dist sources, see the README):
 *
 * - ONE `chat` GENERATION per `agent.stream()` call, covering the whole agentic
 *   loop. Its `input` is the message array captured before the first step
 *   (system prompt, memory, the user message) in the OTel GenAI shape
 *   `{role, parts:[{type:'text', content}]}`; its `output` is `{text}` turned
 *   into a single assistant text part. No `tool_call` parts appear on it.
 * - One TOOL observation (`mcp_tool_call` span) per tool call: `input` = the
 *   arguments, `output` = the result, `.error()` on failure (Langfuse `level`
 *   ERROR plus `statusMessage`), the tool name as `entityName` and the model's
 *   call id under `attributes.toolCallId`.
 * - Trace metadata (`toolSchemaHash`, `outcome`, `steps`) is set through
 *   `tracingOptions.metadata.langfuse` and serialised as the attribute
 *   `mastra.metadata.langfuse`, a JSON string.
 *
 * So the prompt, the earlier conversation and the final answer come from the
 * GENERATION, and the steps from the TOOL observations ordered by start time.
 * Parsing `tool_call` / `tool_call_response` parts out of GENERATION messages
 * is kept only as a fallback for a trace with no TOOL observations.
 *
 * The `metadata["attributes.*"]` bag is read for exactly three short values
 * (tool name, call id, the trace-metadata JSON), all well under the 200-char
 * cap at which Langfuse truncates those values.
 *
 * A first live trace must confirm: (a) the chat GENERATION output carries no
 * `tool_call` parts, (b) TOOL observations have `input`/`output` populated,
 * (c) how an MCP `isError` result surfaces (level ERROR, `statusMessage`,
 * `attributes.success=false` or `isError` in the output; all four are read).
 */

/** The fields of an observation this module reads (a subset of Langfuse's ObservationV2). */
export interface TraceObservation {
    id: string;
    type: string;
    name?: string | null;
    startTime: string;
    /** Raw JSON string on the v2 endpoint (`parseIoAsJson` is gone); objects are accepted too. */
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
    level?: string | null;
    statusMessage?: string | null;
    providedModelName?: string | null;
}

export interface TurnToolCall {
    /** The model's tool-call id when the span recorded one, else the observation id. */
    callId: string;
    /** Bare MCP tool name (`search-actors`); any `apify-ai_` namespace prefix is stripped. */
    name: string;
    /** Parsed arguments; a string when the recorded arguments were not JSON. */
    arguments: unknown;
    /** The tool result as recorded, a string when it was not JSON. Undefined when no result was recorded. */
    result?: unknown;
    isError: boolean;
    /** The TOOL observation (or, in the fallback, the GENERATION) that carried the call: the span id a comment cites. */
    observationId: string;
}

export interface TurnStep {
    /** 1-based position in start-time order. */
    index: number;
    calls: TurnToolCall[];
}

export interface TurnMessage {
    role: 'user' | 'assistant';
    text: string;
}

/** Trace-level facts the agent writes as trace metadata (apify-ai-agent `trace-contract.ts`). */
export interface TurnTraceMetadata {
    toolSchemaHash?: string;
    outcome?: string;
    steps?: number;
    model?: string;
}

/** Most earlier messages kept as judge context; a long memory must not swamp the turn. */
export const MAX_PRIOR_MESSAGES = 10;

export interface OnlineTurn {
    traceId: string;
    /** The user message this turn answers: the last user message in the history. */
    prompt: string;
    /** The last MAX_PRIOR_MESSAGES earlier user/assistant texts: context for the judge, not the subject. */
    priorMessages: TurnMessage[];
    /** Earlier messages beyond the cap, not shown to the judge. */
    droppedPriorMessages: number;
    steps: TurnStep[];
    /** The assistant text after the last tool result; empty when the turn produced none. */
    finalText: string;
    hasToolError: boolean;
    /** GENERATION observation ids in start-time order; the last one is the turn-level span to cite. */
    generationIds: string[];
    metadata: TurnTraceMetadata;
    /** False when no observation carried any trace metadata: the judge then cannot know the outcome or the hash. */
    metadataFound: boolean;
}

export class TurnReconstructionError extends Error {
    constructor(
        readonly traceId: string,
        reason: string,
    ) {
        super(`Cannot reconstruct turn ${traceId}: ${reason}`);
        this.name = 'TurnReconstructionError';
    }
}

/** The agent's MCP server name: `@mastra/mcp` prefixes every tool key with it. */
const AGENT_TOOL_PREFIX = 'apify-ai_';

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function isErrorOutput(output: unknown): boolean {
    const record = asRecord(output);
    if (!record) return false;
    return record.isError === true || (typeof record.type === 'string' && record.type.startsWith('error'));
}

/** Bare MCP tool name from a span or tool-call name: `execute_tool apify-ai_search-actors` -> `search-actors`. */
export function bareToolName(name: string): string {
    const withoutOperation = name.replace(/^execute_tool\s+/, '').replace(/^mcp_tool: '([^']+)'.*$/, '$1');
    return withoutOperation.startsWith(AGENT_TOOL_PREFIX)
        ? withoutOperation.slice(AGENT_TOOL_PREFIX.length)
        : withoutOperation;
}

/**
 * One message part after normalising the two shapes the exporter produces:
 * GenAI parts (`tool_call` / `tool_call_response`, arguments and response as
 * JSON strings) and, for messages its converter did not recognise, Mastra's
 * own parts (`tool-call` / `tool-result` / `tool-error`).
 */
type Part =
    | { kind: 'text'; text: string }
    | { kind: 'call'; callId: string; name: string; arguments: unknown }
    | { kind: 'result'; callId: string; result: unknown; isError: boolean }
    | { kind: 'other' };

function normalizePart(raw: unknown): Part {
    const part = asRecord(raw);
    if (!part) return typeof raw === 'string' ? { kind: 'text', text: raw } : { kind: 'other' };
    switch (part.type) {
        case 'text':
            return { kind: 'text', text: String(part.content ?? part.text ?? '') };
        case 'tool_call':
            return {
                kind: 'call',
                callId: String(part.id ?? ''),
                name: String(part.name ?? ''),
                arguments: parseMaybeJson(part.arguments),
            };
        case 'tool-call':
            return {
                kind: 'call',
                callId: String(part.toolCallId ?? ''),
                name: String(part.toolName ?? ''),
                arguments: part.input,
            };
        case 'tool_call_response': {
            const result = parseMaybeJson(part.response);
            return { kind: 'result', callId: String(part.id ?? ''), result, isError: isErrorOutput(result) };
        }
        case 'tool-result': {
            const output = asRecord(part.output);
            const result = output && 'value' in output ? output.value : part.output;
            return {
                kind: 'result',
                callId: String(part.toolCallId ?? ''),
                result,
                isError: isErrorOutput(part.output) || isErrorOutput(result),
            };
        }
        case 'tool-error':
            return { kind: 'result', callId: String(part.toolCallId ?? ''), result: part.error, isError: true };
        default:
            return { kind: 'other' };
    }
}

function messageParts(message: unknown): { role: string; parts: Part[] } | null {
    const record = asRecord(message);
    if (!record) return null;
    const raw = record.parts ?? record.content;
    const parts = Array.isArray(raw) ? raw.map(normalizePart) : [normalizePart({ type: 'text', content: raw ?? '' })];
    return { role: String(record.role ?? ''), parts };
}

/** `input` / `output` as a message array; a bare string output is one assistant text message. */
function messagesOf(io: unknown): unknown[] {
    const parsed = parseMaybeJson(io);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string' && parsed.length > 0) {
        return [{ role: 'assistant', parts: [{ type: 'text', content: parsed }] }];
    }
    const record = asRecord(parsed);
    if (record && Array.isArray(record.messages)) return record.messages;
    if (record && typeof record.text === 'string') {
        return [{ role: 'assistant', parts: [{ type: 'text', content: record.text }] }];
    }
    return [];
}

/** A message flattened to what the turn needs, tagged with where it was first seen. */
type Item =
    | { kind: 'text'; role: 'user' | 'assistant'; text: string; observationId: string }
    | { kind: 'calls'; calls: TurnToolCall[] };

function textOf(parts: Part[]): string {
    return parts
        .filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
}

/**
 * Walk the generations in start-time order and flatten input then output of
 * each into one deduped item list: a multi-generation trace repeats the
 * history in every input. Tool-call parts are collected too, for the fallback.
 */
function collectItems(generations: TraceObservation[]): Item[] {
    const items: Item[] = [];
    const callsById = new Map<string, TurnToolCall>();
    const seenText = new Set<string>();
    const hasResultFor = new Set<string>();

    const add = (message: unknown, observationId: string) => {
        const parsed = messageParts(message);
        if (!parsed) return;
        const { role, parts } = parsed;
        for (const part of parts) {
            if (part.kind !== 'result') continue;
            const call = callsById.get(part.callId);
            if (!call || hasResultFor.has(part.callId)) continue;
            call.result = part.result;
            call.isError = part.isError;
            hasResultFor.add(part.callId);
        }
        // Text before calls: an assistant preamble ("Let me search...") precedes
        // the calls it announces, so it must not survive them as the final answer.
        const textRole = role === 'user' || role === 'assistant' ? role : null;
        const text = textRole ? textOf(parts) : '';
        if (textRole && text && !seenText.has(`${role} ${text}`)) {
            seenText.add(`${role} ${text}`);
            items.push({ kind: 'text', role: textRole, text, observationId });
        }
        const calls = parts.filter(
            (p): p is Extract<Part, { kind: 'call' }> => p.kind === 'call' && !callsById.has(p.callId),
        );
        if (calls.length === 0) return;
        const step = calls.map<TurnToolCall>((c) => ({
            callId: c.callId,
            name: bareToolName(c.name),
            arguments: c.arguments,
            isError: false,
            observationId,
        }));
        for (const call of step) callsById.set(call.callId, call);
        items.push({ kind: 'calls', calls: step });
    };

    for (const generation of generations) {
        for (const message of messagesOf(generation.input)) add(message, generation.id);
        for (const message of messagesOf(generation.output)) add(message, generation.id);
    }
    return items;
}

const TRACE_METADATA_KEYS = ['toolSchemaHash', 'outcome', 'steps'] as const;

/** The attribute the exporter writes `tracingOptions.metadata.langfuse` to, as a JSON string. */
const LANGFUSE_METADATA_ATTRIBUTE = 'attributes.mastra.metadata.langfuse';

/**
 * Trace metadata as the agent writes it. Which of three places it surfaces on
 * an events-only instance is unproven, so all are read from every observation,
 * in order: a top-level key, a nested `langfuse` object, and the exporter's
 * `attributes.mastra.metadata.langfuse` JSON string. First value found wins;
 * `found` is false when none of them yielded anything, so the caller can count
 * it and the first live run can tell which path is real.
 */
export function traceMetadataOf(observations: TraceObservation[]): { metadata: TurnTraceMetadata; found: boolean } {
    const values: Record<string, unknown> = {};
    for (const observation of observations) {
        const metadata = asRecord(parseMaybeJson(observation.metadata));
        if (!metadata) continue;
        const sources = [
            metadata,
            asRecord(metadata.langfuse),
            asRecord(parseMaybeJson(metadata[LANGFUSE_METADATA_ATTRIBUTE])),
        ];
        for (const source of sources) {
            if (!source) continue;
            for (const key of TRACE_METADATA_KEYS) {
                if (values[key] === undefined && source[key] !== undefined) values[key] = source[key];
            }
        }
    }
    const steps = values.steps === undefined ? undefined : Number(values.steps);
    const metadata: TurnTraceMetadata = {
        ...(typeof values.toolSchemaHash === 'string' ? { toolSchemaHash: values.toolSchemaHash } : {}),
        ...(values.outcome !== undefined ? { outcome: String(values.outcome) } : {}),
        ...(steps !== undefined && Number.isFinite(steps) ? { steps } : {}),
    };
    return { metadata, found: Object.keys(metadata).length > 0 };
}

function byStartTime(a: TraceObservation, b: TraceObservation): number {
    return a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id);
}

/** GENERATION observations, oldest first; ties broken by id so the order is stable. */
export function generationsOf(observations: TraceObservation[]): TraceObservation[] {
    return observations.filter((o) => o.type === 'GENERATION').sort(byStartTime);
}

function attribute(metadata: Record<string, unknown> | null, key: string): unknown {
    return metadata?.[`attributes.${key}`];
}

/** One call per TOOL observation, in start-time order. */
export function toolCallsOf(observations: TraceObservation[]): TurnToolCall[] {
    return observations
        .filter((o) => o.type === 'TOOL')
        .sort(byStartTime)
        .map((o) => {
            const metadata = asRecord(parseMaybeJson(o.metadata));
            const result = parseMaybeJson(o.output);
            const toolName = attribute(metadata, 'gen_ai.tool.name') ?? o.name ?? '';
            return {
                callId: String(attribute(metadata, 'gen_ai.tool.call.id') ?? attribute(metadata, 'toolCallId') ?? o.id),
                name: bareToolName(String(toolName)),
                arguments: parseMaybeJson(o.input),
                ...(o.output === undefined || o.output === null ? {} : { result }),
                isError:
                    o.level === 'ERROR' ||
                    Boolean(o.statusMessage) ||
                    attribute(metadata, 'success') === false ||
                    isErrorOutput(result),
                observationId: o.id,
            };
        });
}

/** Pure: the turn from one trace's observations. Throws when there is nothing to judge. */
export function reconstructTurn(traceId: string, observations: TraceObservation[]): OnlineTurn {
    const generations = generationsOf(observations);
    if (generations.length === 0) throw new TurnReconstructionError(traceId, 'no GENERATION observation');

    const items = collectItems(generations);
    let promptIndex = -1;
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.kind === 'text' && item.role === 'user') {
            promptIndex = i;
            break;
        }
    }
    if (promptIndex === -1) throw new TurnReconstructionError(traceId, 'no user message in any generation');
    const promptItem = items[promptIndex] as Extract<Item, { kind: 'text' }>;

    const allPrior = items
        .slice(0, promptIndex)
        .filter((item): item is Extract<Item, { kind: 'text' }> => item.kind === 'text')
        .map(({ role, text }) => ({ role, text }));
    const priorMessages = allPrior.slice(-MAX_PRIOR_MESSAGES);

    const fallbackSteps: TurnStep[] = [];
    let finalText = '';
    for (const item of items.slice(promptIndex + 1)) {
        if (item.kind === 'calls') {
            fallbackSteps.push({ index: fallbackSteps.length + 1, calls: item.calls });
            finalText = '';
        } else if (item.role === 'assistant') {
            finalText = item.text;
        }
    }

    // The exporter files tool calls as TOOL observations; the GENERATION carries
    // no tool_call parts. The message-part steps are only for a trace that
    // somehow has none (see the module comment, point (a)).
    const toolCalls = toolCallsOf(observations);
    const steps = toolCalls.length > 0 ? toolCalls.map((call, i) => ({ index: i + 1, calls: [call] })) : fallbackSteps;

    const model = generations[generations.length - 1].providedModelName ?? undefined;
    const trace = traceMetadataOf(observations);
    return {
        traceId,
        prompt: promptItem.text,
        priorMessages,
        droppedPriorMessages: allPrior.length - priorMessages.length,
        steps,
        finalText,
        hasToolError: steps.some((s) => s.calls.some((c) => c.isError)),
        generationIds: generations.map((g) => g.id),
        metadata: { ...trace.metadata, ...(model ? { model } : {}) },
        metadataFound: trace.found,
    };
}

// ---------------------------------------------------------------------------
// Production adapter
// ---------------------------------------------------------------------------

interface ObservationsApi {
    api: { observations: { getMany(request: Record<string, unknown>): Promise<unknown> } };
}

/** Max page size the observations v2 endpoint allows. */
const PAGE_LIMIT = 1000;

/**
 * Every observation of one trace: `GET /api/public/v2/observations?traceId=`
 * with the `io`, `metadata` and `model` field groups (the default `core,basic`
 * carries neither input/output nor the model name), following `meta.cursor`.
 */
export async function fetchTraceObservations(langfuse: ObservationsApi, traceId: string): Promise<TraceObservation[]> {
    const observations: TraceObservation[] = [];
    let cursor: string | undefined;
    do {
        const page = (await langfuse.api.observations.getMany({
            traceId,
            fields: 'core,basic,io,metadata,model',
            limit: PAGE_LIMIT,
            cursor,
        })) as { data?: TraceObservation[]; meta?: { cursor?: string } };
        observations.push(...(page.data ?? []));
        cursor = page.meta?.cursor;
    } while (cursor);
    return observations;
}
