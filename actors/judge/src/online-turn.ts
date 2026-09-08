/**
 * Online-eval turn reconstruction (ai-team#269): rebuild what the agent saw
 * and did in one production turn from the trace's observations, so the judge
 * can score it without re-running the agent.
 *
 * Source of truth is the GENERATION observations' mapped `input` / `output`:
 * apify-ai-agent's exporter writes the whole message array there in the OTel
 * GenAI shape (`{role, parts:[{type:'text'|'tool_call'|'tool_call_response'}]}`),
 * untruncated. The `metadata["attributes.*"]` bag is never read: Langfuse cuts
 * those values at 200 characters unless each key is named in `expandMetadata`.
 *
 * Every GENERATION's input repeats the history so far (system prompt, memory,
 * the user message and the tool calls of earlier steps), so a multi-step turn
 * carries each message several times. Items are deduped by tool-call id, and
 * text messages by role plus content, keeping the first observation that
 * carried each one as its provenance.
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
    providedModelName?: string | null;
}

export interface TurnToolCall {
    /** Tool-call id from the model, the key that pairs a call with its result. */
    callId: string;
    /** Tool name as the model called it (the Mastra-namespaced key, e.g. `apify-ai_search-actors`). */
    name: string;
    /** Parsed arguments; a string when the recorded arguments were not JSON. */
    arguments: unknown;
    /** The tool result as recorded, a string when it was not JSON. Undefined when no result was recorded. */
    result?: unknown;
    isError: boolean;
    /** GENERATION observation that first carried the call: the span id a score comment can cite. */
    observationId: string;
}

export interface TurnStep {
    /** 1-based position of the assistant message that issued these calls. */
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

export interface OnlineTurn {
    traceId: string;
    /** The user message this turn answers: the last user message in the history. */
    prompt: string;
    /** Earlier user/assistant text, context for the judge and not the subject of the verdict. */
    priorMessages: TurnMessage[];
    steps: TurnStep[];
    /** The assistant text after the last tool result; empty when the turn produced none. */
    finalText: string;
    hasToolError: boolean;
    /** GENERATION observation ids in start-time order; the last one is the turn-level span to cite. */
    generationIds: string[];
    metadata: TurnTraceMetadata;
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

/**
 * One message part after normalising the two shapes the exporter produces:
 * GenAI parts (`tool_call` / `tool_call_response`, arguments and response as
 * JSON strings) and, for messages its converter did not recognise, Mastra's
 * own parts (`tool-call` / `tool-result` / `tool-error`). A `tool-error` is
 * what an MCP `isError` result becomes in the agent (`onToolError: 'throw'`).
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
            return {
                kind: 'result',
                callId: String(part.id ?? ''),
                result,
                isError: asRecord(result)?.isError === true,
            };
        }
        case 'tool-result': {
            const output = asRecord(part.output);
            const isError = typeof output?.type === 'string' && output.type.startsWith('error');
            const result = output && 'value' in output ? output.value : part.output;
            return { kind: 'result', callId: String(part.toolCallId ?? ''), result, isError };
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
    if (typeof parsed === 'string' && parsed.length > 0)
        return [{ role: 'assistant', parts: [{ type: 'text', content: parsed }] }];
    const record = asRecord(parsed);
    if (record && Array.isArray(record.messages)) return record.messages;
    if (record && typeof record.text === 'string')
        return [{ role: 'assistant', parts: [{ type: 'text', content: record.text }] }];
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
 * each into one deduped item list. Results are attached to their call by id
 * wherever they appear (the `tool` message of the next generation's input).
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
            name: c.name,
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

/**
 * Trace metadata as the agent writes it (`metadata.langfuse.*` becomes
 * `langfuse.trace.metadata.*`). Where it surfaces on an events-only instance
 * is not pinned, so both the top level and a nested `langfuse` object of
 * every observation's metadata are read; the first value found wins.
 */
export function traceMetadataOf(observations: TraceObservation[]): TurnTraceMetadata {
    const found: Record<string, unknown> = {};
    for (const observation of observations) {
        const metadata = asRecord(parseMaybeJson(observation.metadata));
        if (!metadata) continue;
        for (const source of [metadata, asRecord(metadata.langfuse)]) {
            if (!source) continue;
            for (const key of TRACE_METADATA_KEYS)
                if (found[key] === undefined && source[key] !== undefined) found[key] = source[key];
        }
    }
    const steps = found.steps === undefined ? undefined : Number(found.steps);
    return {
        ...(typeof found.toolSchemaHash === 'string' ? { toolSchemaHash: found.toolSchemaHash } : {}),
        ...(found.outcome !== undefined ? { outcome: String(found.outcome) } : {}),
        ...(steps !== undefined && Number.isFinite(steps) ? { steps } : {}),
    };
}

/** GENERATION observations, oldest first; ties broken by id so the order is stable. */
export function generationsOf(observations: TraceObservation[]): TraceObservation[] {
    return observations
        .filter((o) => o.type === 'GENERATION')
        .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
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

    const priorMessages = items
        .slice(0, promptIndex)
        .filter((item): item is Extract<Item, { kind: 'text' }> => item.kind === 'text')
        .map(({ role, text }) => ({ role, text }));

    const steps: TurnStep[] = [];
    let finalText = '';
    for (const item of items.slice(promptIndex + 1)) {
        if (item.kind === 'calls') {
            steps.push({ index: steps.length + 1, calls: item.calls });
            finalText = '';
        } else if (item.role === 'assistant') {
            finalText = item.text;
        }
    }

    const model = generations[generations.length - 1].providedModelName ?? undefined;
    return {
        traceId,
        prompt: promptItem.text,
        priorMessages,
        steps,
        finalText,
        hasToolError: steps.some((s) => s.calls.some((c) => c.isError)),
        generationIds: generations.map((g) => g.id),
        metadata: { ...traceMetadataOf(observations), ...(model ? { model } : {}) },
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
