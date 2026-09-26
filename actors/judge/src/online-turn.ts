/**
 * Online-eval turn reconstruction (ai-team#269): rebuild what the agent saw
 * and did in one production turn from the trace's observations, so the judge
 * can score it without re-running the agent.
 *
 * What the exporter writes, confirmed against staging traces on 2026-09-09
 * (apify-ai-agent on Mastra 1.61 with `@mastra/otel-exporter` 1.3.9):
 *
 * - The turn's `chat <model>` GENERATION, child of the root `invoke_agent`
 *   AGENT span, covering the whole agentic loop. Its `input` is the message
 *   array captured before the first step (system prompt, memory, the user
 *   message) as a JSON string in the OTel GenAI shape
 *   `{role, parts:[{type:'text', content}]}`; its `output` is `{text}` turned
 *   into a single assistant text part. No `tool_call` parts appear on it.
 * - A SECOND `chat` GENERATION, also a child of the root, for Memory's thread
 *   title and compaction (a haiku model). It is not part of the turn and must
 *   never be judged; `turnGenerationsOf` excludes it.
 * - One TOOL observation (`mcp_tool_call` span) per tool call, child of the
 *   turn GENERATION: `input` = the arguments as a JSON string, `output` = the
 *   result as a JSON string, both untruncated, the namespaced tool key as the
 *   observation name and under `attributes.gen_ai.tool.name`, the model's call
 *   id under `attributes.gen_ai.tool.call.id`.
 * - Trace metadata (`toolSchemaHash`, `outcome`, `steps`) is set through
 *   `tracingOptions.metadata.langfuse` and serialised as the attribute
 *   `mastra.metadata.langfuse`, a JSON string. That path is not yet observable
 *   (the agent's `feat/trace-contract` is undeployed), but every other
 *   `tracingOptions.metadata.<key>` does arrive as
 *   `attributes.mastra.metadata.<key>` (`userId`, `threadId`, `runId`), so the
 *   attribute name is the one to read.
 *
 * So the prompt, the earlier conversation and the final answer come from the
 * turn GENERATION, and the steps from the TOOL observations ordered by start
 * time. Parsing `tool_call` / `tool_call_response` parts out of GENERATION
 * messages is kept only as a fallback for a trace with no TOOL observations.
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
    /** Thread id on the turn's own spans, empty string on Memory's title/compaction generation. */
    sessionId?: string | null;
    parentObservationId?: string | null;
    /** What the live endpoint returns for the `model` field group; documented as `providedModelName`. */
    model?: string | null;
    providedModelName?: string | null;
}

export interface TurnToolCall {
    /** The model's tool-call id when the span recorded one, else the observation id. */
    callId: string;
    /** Bare MCP tool name (`search-actors`); any `apify-ai_` namespace prefix is stripped. */
    name: string;
    /**
     * Parsed arguments; a string when the recorded arguments were not JSON.
     * Absent when the span recorded none, which makes the call unverifiable
     * rather than wrong: `argumentCorrectness` skips it instead of failing it.
     */
    arguments?: unknown;
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
    /** The TURN's GENERATION ids in start-time order; the last one is the turn-level span to cite. */
    generationIds: string[];
    /** GENERATIONs of the same trace that belong to something else (Memory's title/compaction call). */
    excludedGenerations: number;
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

/**
 * Whether a recorded tool result is a failure.
 *
 * The live shape (staging, 2026-09-09) is a serialised MastraError on the
 * span's `output`: `{name:'Error', cause:{...}, id:'TOOL_EXECUTION_FAILED',
 * domain:'TOOL', category:'USER', details:{...}}`. It is matched here and not
 * only by span `level`, because a tool that reports failure without throwing
 * leaves the span at level DEFAULT with that same payload.
 *
 * `name`, `domain`, `category` and an `id` or `cause` are all required: a tool
 * result is user-controlled data, and all eight live MastraErrors carry every
 * one of them, so demanding the full set keeps a scraped record that merely
 * happens to have `name` and `id` from being read as a failure.
 */
function isErrorOutput(output: unknown): boolean {
    const record = asRecord(output);
    if (!record) return false;
    if (record.isError === true) return true;
    if (typeof record.type === 'string' && record.type.startsWith('error')) return true;
    return (
        record.name === 'Error' &&
        record.domain !== undefined &&
        record.category !== undefined &&
        (record.id !== undefined || record.cause !== undefined)
    );
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
            ...(c.arguments === undefined ? {} : { arguments: c.arguments }),
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

// Ties (parallel tool calls share a millisecond) fall back to the id, which is
// stable but arbitrary: the export carries nothing that recovers the real order.
function byStartTime(a: TraceObservation, b: TraceObservation): number {
    return a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id);
}

/** GENERATION observations, oldest first; ties broken by id so the order is stable. */
export function generationsOf(observations: TraceObservation[]): TraceObservation[] {
    return observations.filter((o) => o.type === 'GENERATION').sort(byStartTime);
}

/**
 * Split the trace's GENERATIONs into the turn's own and the rest.
 *
 * A live trace carries two: the turn's `chat us.anthropic.claude-sonnet-5` and
 * a later `chat us.anthropic.claude-haiku-...` that Memory uses for the thread
 * title and compaction. Taking every GENERATION let the memory one become the
 * judged turn, with its summarisation prompt as the question and the generated
 * title as the answer.
 *
 * The discriminator is the top-level `sessionId`: the turn's spans carry the
 * thread id, the memory generation is exported with an empty one and with no
 * thread metadata at all (confirmed on three staging traces, 2026-09-09).
 * Fallbacks for a trace where no generation carries a session: the one that
 * parents the TOOL spans, else the earliest.
 */
export function turnGenerationsOf(observations: TraceObservation[]): {
    generations: TraceObservation[];
    excluded: TraceObservation[];
} {
    const generations = generationsOf(observations);
    const split = (kept: TraceObservation[]) => ({
        generations: kept,
        excluded: generations.filter((g) => !kept.includes(g)),
    });

    const withSession = generations.filter((g) => typeof g.sessionId === 'string' && g.sessionId.length > 0);
    if (withSession.length > 0) return split(withSession);

    const toolParents = new Set(observations.filter((o) => o.type === 'TOOL').map((o) => o.parentObservationId));
    const toolCallers = generations.filter((g) => toolParents.has(g.id));
    if (toolCallers.length > 0) return split(toolCallers);

    return split(generations.slice(0, 1));
}

function attribute(metadata: Record<string, unknown> | null, key: string): unknown {
    return metadata?.[`attributes.${key}`];
}

/** The attribute-bag copies of a call's payloads; the fallback when the span has no mapped `input`/`output`. */
const TOOL_ARGUMENTS_ATTRIBUTE = 'gen_ai.tool.call.arguments';
const TOOL_RESULT_ATTRIBUTE = 'gen_ai.tool.call.result';

/** The model id a GENERATION was served by; the live field is `model`, the SDK documents `providedModelName`. */
function modelOf(generation: TraceObservation): string | undefined {
    const metadata = asRecord(parseMaybeJson(generation.metadata));
    const model =
        generation.model ||
        generation.providedModelName ||
        attribute(metadata, 'gen_ai.response.model') ||
        attribute(metadata, 'gen_ai.request.model');
    return typeof model === 'string' && model.length > 0 ? model : undefined;
}

/**
 * One call per TOOL observation, in start-time order. Arguments and result
 * come from the mapped `input`/`output` (the live shape), falling back to the
 * attribute bag; a call with neither keeps no `arguments` at all, so the
 * argument check can skip it instead of validating `undefined`.
 */
export function toolCallsOf(observations: TraceObservation[]): TurnToolCall[] {
    return observations
        .filter((o) => o.type === 'TOOL')
        .sort(byStartTime)
        .map((o) => {
            const metadata = asRecord(parseMaybeJson(o.metadata));
            const rawArguments = o.input ?? attribute(metadata, TOOL_ARGUMENTS_ATTRIBUTE);
            const rawResult = o.output ?? attribute(metadata, TOOL_RESULT_ATTRIBUTE);
            const result = parseMaybeJson(rawResult);
            const toolName = attribute(metadata, 'gen_ai.tool.name') ?? o.name ?? '';
            return {
                callId: String(attribute(metadata, 'gen_ai.tool.call.id') ?? attribute(metadata, 'toolCallId') ?? o.id),
                name: bareToolName(String(toolName)),
                ...(rawArguments === undefined || rawArguments === null
                    ? {}
                    : { arguments: parseMaybeJson(rawArguments) }),
                ...(rawResult === undefined || rawResult === null ? {} : { result }),
                isError: o.level === 'ERROR' || Boolean(o.statusMessage) || isErrorOutput(result),
                observationId: o.id,
            };
        });
}

/** Pure: the turn from one trace's observations. Throws when there is nothing to judge. */
export function reconstructTurn(traceId: string, observations: TraceObservation[]): OnlineTurn {
    const { generations, excluded } = turnGenerationsOf(observations);
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
    //
    // One TOOL observation becomes one step, so N tool calls the model issued in
    // parallel within a single model step count as N steps here. The export
    // carries no grouping back to the model step that requested them, so this is
    // a count of tool calls, not of model turns, and `planEfficiency` is worded
    // that way.
    const toolCalls = toolCallsOf(observations);
    const steps = toolCalls.length > 0 ? toolCalls.map((call, i) => ({ index: i + 1, calls: [call] })) : fallbackSteps;

    const model = modelOf(generations[generations.length - 1]);
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
        excludedGenerations: excluded.length,
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
 * The one metadata key this module reads that can exceed the endpoint's
 * 200-character default truncation, so it is requested in full by name.
 */
const EXPANDED_METADATA_KEYS = 'attributes.mastra.metadata.langfuse';

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
            expandMetadata: EXPANDED_METADATA_KEYS,
            limit: PAGE_LIMIT,
            cursor,
        })) as { data?: TraceObservation[]; meta?: { cursor?: string } };
        observations.push(...(page.data ?? []));
        cursor = page.meta?.cursor;
    } while (cursor);
    return observations;
}
