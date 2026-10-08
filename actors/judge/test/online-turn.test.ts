import { describe, expect, it } from 'vitest';

import {
    bareToolName,
    fetchTraceObservations,
    generationsOf,
    MAX_PRIOR_MESSAGES,
    reconstructTurn,
    toolCallsOf,
    traceMetadataOf,
    type TraceObservation,
    turnGenerationsOf,
    TurnReconstructionError,
} from '../src/online-turn.js';
import {
    LIVE_FINAL_TEXT,
    LIVE_PROMPT,
    LIVE_TITLE,
    LIVE_TRACE_ID,
    liveErrorToolObservation,
    liveTraceObservations,
} from './fixtures/live-trace.js';

/**
 * The synthetic fixtures below follow the shape confirmed against staging on
 * 2026-09-09 (see `fixtures/live-trace.ts` for the verbatim rows): the turn's
 * `chat` GENERATION whose input is the pre-loop message array in OTel GenAI
 * shape and whose output is the final `{text}` as one assistant text part,
 * carrying the thread id as `sessionId`; one TOOL observation per tool call
 * with input = arguments, output = result and the call id under
 * `attributes.gen_ai.tool.call.id`; the trace metadata as the
 * `attributes.mastra.metadata.langfuse` JSON string.
 */

/** The thread id every span of a real turn carries; it is what marks a generation as the turn's own. */
const SESSION = 'thread-1';
const system = { role: 'system', parts: [{ type: 'text', content: 'You are Apify AI.' }] };
const user = (content: string) => ({ role: 'user', parts: [{ type: 'text', content }] });
const assistantText = (content: string) => ({ role: 'assistant', parts: [{ type: 'text', content }] });

/** Langfuse returns io as raw JSON strings; the fixtures do the same. */
function chat(id: string, startTime: string, input: unknown[], text: string): TraceObservation {
    return {
        id,
        type: 'GENERATION',
        name: 'chat',
        startTime,
        sessionId: SESSION,
        input: JSON.stringify(input),
        output: JSON.stringify([assistantText(text)]),
        model: 'anthropic.claude-sonnet-4-6',
    };
}

function tool(
    id: string,
    startTime: string,
    name: string,
    args: unknown,
    result: unknown,
    extra: Partial<TraceObservation> = {},
): TraceObservation {
    return {
        id,
        type: 'TOOL',
        name,
        startTime,
        sessionId: SESSION,
        input: JSON.stringify(args),
        output: result === undefined ? undefined : JSON.stringify(result),
        metadata: { 'attributes.gen_ai.tool.call.id': `call-${id}`, 'attributes.gen_ai.tool.name': `apify-ai_${name}` },
        ...extra,
    };
}

const completion: TraceObservation = {
    id: 'ev1',
    type: 'EVENT',
    name: 'apify-ai.turn-complete',
    startTime: '2026-09-08T10:00:09.000Z',
    metadata: {
        'attributes.mastra.metadata.langfuse': JSON.stringify({ completed: 'true', outcome: 'completed', steps: 2 }),
    },
};
const root: TraceObservation = {
    id: 'root',
    type: 'AGENT',
    name: 'invoke_agent',
    startTime: '2026-09-08T10:00:00.000Z',
    metadata: {
        'attributes.mastra.metadata.langfuse': JSON.stringify({ source: 'apify-ai', toolSchemaHash: 'sha256:abc' }),
    },
};

const history = [system, user('Find cheap flights')];
const search = tool(
    't1',
    '2026-09-08T10:00:02.000Z',
    'search-actors',
    { query: 'flights', limit: 5 },
    {
        actors: [{ name: 'flights-scraper' }],
    },
);
const details = tool(
    't2',
    '2026-09-08T10:00:04.000Z',
    'fetch-actor-details',
    { actor: 'flights-scraper' },
    { readme: '...' },
);

/** Two tool calls then the answer, returned by Langfuse in no particular order. */
const twoCalls: TraceObservation[] = [
    completion,
    details,
    chat('g1', '2026-09-08T10:00:00.500Z', history, 'Use flights-scraper.'),
    search,
    root,
];

describe('reconstructTurn from the real export shape', () => {
    const turn = reconstructTurn('t1', twoCalls);

    it('takes the prompt from the GENERATION input and the answer from its output', () => {
        expect(turn.prompt).toBe('Find cheap flights');
        expect(turn.finalText).toBe('Use flights-scraper.');
        expect(turn.priorMessages).toEqual([]);
        expect(turn.droppedPriorMessages).toBe(0);
        expect(turn.generationIds).toEqual(['g1']);
        expect(turn.excludedGenerations).toBe(0);
    });

    it('builds one step per TOOL observation in start-time order, citing that observation', () => {
        expect(turn.steps.map((s) => s.index)).toEqual([1, 2]);
        expect(turn.steps.map((s) => s.calls)).toEqual([
            [
                {
                    callId: 'call-t1',
                    name: 'search-actors',
                    arguments: { query: 'flights', limit: 5 },
                    result: { actors: [{ name: 'flights-scraper' }] },
                    isError: false,
                    observationId: 't1',
                },
            ],
            [
                {
                    callId: 'call-t2',
                    name: 'fetch-actor-details',
                    arguments: { actor: 'flights-scraper' },
                    result: { readme: '...' },
                    isError: false,
                    observationId: 't2',
                },
            ],
        ]);
        expect(turn.hasToolError).toBe(false);
    });

    it('reads trace metadata from the exporter attribute across observations, plus the model', () => {
        expect(turn.metadataFound).toBe(true);
        expect(turn.metadata).toEqual({
            toolSchemaHash: 'sha256:abc',
            outcome: 'completed',
            steps: 2,
            model: 'anthropic.claude-sonnet-4-6',
        });
    });

    it('keeps the last user message as the prompt and caps earlier text as context', () => {
        const long = Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? user(`q${i}`) : assistantText(`a${i}`)));
        const observations = [chat('g1', '2026-09-08T10:00:00.000Z', [system, ...long, user('now')], 'ok')];
        const withMemory = reconstructTurn('t2', observations);
        expect(withMemory.prompt).toBe('now');
        expect(withMemory.priorMessages).toHaveLength(MAX_PRIOR_MESSAGES);
        expect(withMemory.priorMessages[0]).toEqual({ role: 'user', text: 'q4' });
        expect(withMemory.droppedPriorMessages).toBe(4);
    });
});

describe('toolCallsOf', () => {
    it('flags an errored span by level, statusMessage, isError, or a serialised error in the output', () => {
        const byLevel = tool('e1', '1', 'search-actors', {}, undefined, { level: 'ERROR', statusMessage: 'MCP error' });
        const byStatus = tool('e2', '2', 'search-actors', {}, 'boom', { statusMessage: 'failed' });
        const byOutput = tool('e3', '3', 'search-actors', {}, { isError: true, content: [] });
        // The live payload of a failed MCP call, on a span the exporter left at level DEFAULT:
        // a tool that reports failure without throwing must still count as an error.
        const byPayload = tool(
            'e4',
            '4',
            'call-actor',
            {},
            {
                name: 'Error',
                cause: { message: 'Input validation failed', domain: 'MCP', category: 'THIRD_PARTY' },
                id: 'TOOL_EXECUTION_FAILED',
                domain: 'TOOL',
                category: 'USER',
                details: { errorMessage: '...' },
            },
        );
        const ok = tool('e5', '5', 'search-actors', {}, { content: [] });
        const calls = toolCallsOf([byLevel, byStatus, byOutput, byPayload, ok]);
        expect(calls.map((c) => c.isError)).toEqual([true, true, true, true, false]);
        expect(calls[0]).not.toHaveProperty('result');
        expect(calls[1].result).toBe('boom');
    });

    it('does not read a scraped record that merely has name and id as a failed call', () => {
        // A tool result is user-controlled: without domain and category, which every
        // live MastraError carries, this is data the agent fetched, not an error.
        const record = tool('s1', '1', 'get-dataset-items', {}, { name: 'Error', id: 42 });
        expect(toolCallsOf([record])[0].isError).toBe(false);
    });

    it('reads arguments and result from the attribute bag when the span has no mapped input/output', () => {
        const attributed: TraceObservation = {
            id: 'a1',
            type: 'TOOL',
            name: 'apify-ai_call-actor',
            startTime: '1',
            metadata: {
                'attributes.gen_ai.tool.call.id': 'tooluse_1',
                'attributes.gen_ai.tool.call.arguments': '{"actor":"apify/rag-web-browser"}',
                'attributes.gen_ai.tool.call.result': '{"ok":true}',
            },
        };
        expect(toolCallsOf([attributed])[0]).toEqual({
            callId: 'tooluse_1',
            name: 'call-actor',
            arguments: { actor: 'apify/rag-web-browser' },
            result: { ok: true },
            isError: false,
            observationId: 'a1',
        });
    });

    it('records no arguments at all when neither the input nor the attribute bag carried any', () => {
        const bare: TraceObservation = { id: 'b1', type: 'TOOL', name: 'apify-ai_search-actors', startTime: '1' };
        expect(toolCallsOf([bare])[0]).not.toHaveProperty('arguments');
    });

    it('takes the tool name from gen_ai.tool.name when present, else the observation name, stripping prefixes', () => {
        const named = { ...tool('n1', '1', 'execute_tool apify-ai_call-actor', {}, {}), metadata: {} };
        const attributed = {
            ...tool('n2', '2', 'whatever', {}, {}),
            metadata: { 'attributes.gen_ai.tool.name': 'apify-ai_search-actors' },
        };
        expect(toolCallsOf([named, attributed]).map((c) => c.name)).toEqual(['call-actor', 'search-actors']);
        expect(toolCallsOf([named])[0].callId).toBe('n1');
        expect(bareToolName("mcp_tool: 'search-actors' on 'apify-ai'")).toBe('search-actors');
        expect(bareToolName('search-actors')).toBe('search-actors');
    });
});

describe('reconstructTurn: fallback to GENERATION message parts', () => {
    const call = {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'c1', name: 'apify-ai_search-actors', arguments: '{"query":"flights"}' }],
    };
    const result = (response: unknown) => ({
        role: 'tool',
        parts: [
            {
                type: 'tool_call_response',
                id: 'c1',
                name: 'apify-ai_search-actors',
                response: JSON.stringify(response),
            },
        ],
    });
    const generation = (id: string, startTime: string, input: unknown[], output: unknown[]): TraceObservation => ({
        id,
        type: 'GENERATION',
        startTime,
        sessionId: SESSION,
        input: JSON.stringify(input),
        output: JSON.stringify(output),
    });

    it('is used only when the trace has no TOOL observation, and dedupes the repeated history', () => {
        const turn = reconstructTurn('f1', [
            generation('g1', '1', [...history], [call]),
            generation('g2', '2', [...history, call, result({ ok: true })], [assistantText('Done.')]),
        ]);
        expect(turn.steps).toHaveLength(1);
        expect(turn.steps[0].calls[0]).toEqual({
            callId: 'c1',
            name: 'search-actors',
            arguments: { query: 'flights' },
            result: { ok: true },
            isError: false,
            observationId: 'g1',
        });
        expect(turn.finalText).toBe('Done.');
        expect(turn.generationIds).toEqual(['g1', 'g2']);
        expect(turn.metadataFound).toBe(false);
        expect(turn.metadata).toEqual({});

        const withTool = reconstructTurn('f2', [generation('g1', '1', history, [call]), search]);
        expect(withTool.steps.flatMap((s) => s.calls.map((c) => c.observationId))).toEqual(['t1']);
    });

    it('flags errors in GenAI responses (isError, error-typed output) and Mastra tool-error / tool-result parts', () => {
        const genAi = reconstructTurn('f3', [
            generation('g1', '1', history, [call]),
            generation('g2', '2', [...history, call, result({ type: 'error-text', value: 'x' })], [assistantText('.')]),
        ]);
        expect(genAi.hasToolError).toBe(true);
        const mastra = reconstructTurn('f4', [
            generation('g1', '1', history, [
                {
                    role: 'assistant',
                    content: [
                        { type: 'tool-call', toolCallId: 'c9', toolName: 'apify-ai_call-actor', input: { actor: 'x' } },
                    ],
                },
            ]),
            generation(
                'g2',
                '2',
                [
                    ...history,
                    {
                        role: 'tool',
                        content: [
                            {
                                type: 'tool-error',
                                toolCallId: 'c9',
                                toolName: 'apify-ai_call-actor',
                                input: {},
                                error: 'timeout',
                            },
                        ],
                    },
                ],
                [assistantText('.')],
            ),
        ]);
        expect(mastra.steps[0].calls[0]).toMatchObject({
            callId: 'c9',
            name: 'call-actor',
            result: 'timeout',
            isError: true,
        });
        const errorTyped = reconstructTurn('f5', [
            generation('g1', '1', history, [
                {
                    role: 'assistant',
                    content: [{ type: 'tool-call', toolCallId: 'c8', toolName: 'call-actor', input: {} }],
                },
            ]),
            generation(
                'g2',
                '2',
                [
                    ...history,
                    {
                        role: 'tool',
                        content: [
                            {
                                type: 'tool-result',
                                toolCallId: 'c8',
                                toolName: 'call-actor',
                                output: { type: 'error-json', value: { m: 1 } },
                            },
                        ],
                    },
                ],
                [assistantText('.')],
            ),
        ]);
        expect(errorTyped.steps[0].calls[0]).toMatchObject({ result: { m: 1 }, isError: true });
    });

    it('does not mistake an assistant preamble before a call for the final answer', () => {
        const preamble = { role: 'assistant', parts: [{ type: 'text', content: 'Let me search.' }, ...call.parts] };
        const ended = reconstructTurn('f6', [generation('g1', '1', history, [preamble])]);
        expect(ended.steps).toHaveLength(1);
        expect(ended.finalText).toBe('');
    });
});

describe('reconstructTurn: refusals and tolerance', () => {
    it('throws when the trace has no GENERATION or no user message', () => {
        expect(() => reconstructTurn('r1', [completion, search])).toThrow(TurnReconstructionError);
        expect(() => reconstructTurn('r1', [completion])).toThrow(/no GENERATION/);
        expect(() => reconstructTurn('r2', [chat('g1', '1', [system], 'hi')])).toThrow(/no user message/);
    });

    it('accepts a raw `{text}` output and a non-JSON output as the assistant text', () => {
        const raw = { ...chat('g1', '1', history, ''), output: JSON.stringify({ text: 'from object' }) };
        expect(reconstructTurn('r3', [raw]).finalText).toBe('from object');
        expect(reconstructTurn('r4', [{ ...raw, output: 'plain' }]).finalText).toBe('plain');
    });

    it('orders generations by startTime whatever order Langfuse returned', () => {
        const a = chat('g2', '2026-09-08T10:00:05.000Z', history, 'later');
        const b = chat('g1', '2026-09-08T10:00:00.000Z', history, 'earlier');
        expect(generationsOf([a, b]).map((g) => g.id)).toEqual(['g1', 'g2']);
        expect(reconstructTurn('r5', [a, b]).finalText).toBe('later');
    });
});

describe('traceMetadataOf', () => {
    const expected = { toolSchemaHash: 'sha256:1', outcome: 'aborted', steps: 3 };

    it('reads a top-level key', () => {
        const obs: TraceObservation[] = [{ id: 'a', type: 'SPAN', startTime: '1', metadata: JSON.stringify(expected) }];
        expect(traceMetadataOf(obs)).toEqual({ metadata: expected, found: true });
    });

    it('reads a nested langfuse object', () => {
        const obs: TraceObservation[] = [{ id: 'a', type: 'SPAN', startTime: '1', metadata: { langfuse: expected } }];
        expect(traceMetadataOf(obs)).toEqual({ metadata: expected, found: true });
    });

    it('reads the attributes.mastra.metadata.langfuse JSON string', () => {
        const obs: TraceObservation[] = [
            {
                id: 'a',
                type: 'SPAN',
                startTime: '1',
                metadata: { 'attributes.mastra.metadata.langfuse': JSON.stringify(expected) },
            },
        ];
        expect(traceMetadataOf(obs)).toEqual({ metadata: expected, found: true });
    });

    it('merges across observations, first value wins, and reports when nothing was found', () => {
        const obs: TraceObservation[] = [
            { id: 'a', type: 'SPAN', startTime: '1', metadata: { langfuse: { toolSchemaHash: 'sha256:1' } } },
            { id: 'b', type: 'EVENT', startTime: '2', metadata: JSON.stringify({ outcome: 'aborted', steps: '3' }) },
            {
                id: 'c',
                type: 'EVENT',
                startTime: '3',
                metadata: { 'attributes.mastra.metadata.langfuse': '{"outcome":"completed"}' },
            },
        ];
        expect(traceMetadataOf(obs)).toEqual({ metadata: expected, found: true });
        expect(traceMetadataOf([{ id: 'd', type: 'SPAN', startTime: '1', metadata: 'not json' }])).toEqual({
            metadata: {},
            found: false,
        });
        expect(
            traceMetadataOf([{ id: 'e', type: 'SPAN', startTime: '1', metadata: { callerOrigin: 'console' } }]).found,
        ).toBe(false);
    });
});

describe('fetchTraceObservations', () => {
    it('asks for the trace with io, metadata and model fields and follows the cursor', async () => {
        const requests: Record<string, unknown>[] = [];
        const pages = [
            { data: [{ id: 'g1' }], meta: { cursor: 'next' } },
            { data: [{ id: 'g2' }], meta: {} },
        ];
        const fake = {
            api: {
                observations: {
                    getMany: async (request: Record<string, unknown>) => {
                        requests.push(request);
                        return pages[requests.length - 1];
                    },
                },
            },
        };
        const observations = await fetchTraceObservations(fake, 'trace-1');
        expect(observations.map((o) => o.id)).toEqual(['g1', 'g2']);
        expect(requests[0]).toEqual({
            traceId: 'trace-1',
            fields: 'core,basic,io,metadata,model',
            expandMetadata: 'attributes.mastra.metadata.langfuse',
            limit: 1000,
            cursor: undefined,
        });
        expect(requests[1].cursor).toBe('next');
    });
});

describe('turnGenerationsOf', () => {
    it('keeps only the generations that carry a session, so a real trace ignores the memory generation', () => {
        const { generations, excluded } = turnGenerationsOf(liveTraceObservations);
        expect(generations.map((g) => g.name)).toEqual(['chat us.anthropic.claude-sonnet-5']);
        expect(excluded.map((g) => g.name)).toEqual(['chat us.anthropic.claude-haiku-4-5-20251001-v1:0']);
    });

    it('falls back to the generation that parents the TOOL spans when nothing carries a session', () => {
        const first: TraceObservation = { id: 'g1', type: 'GENERATION', startTime: '1' };
        const second: TraceObservation = { id: 'g2', type: 'GENERATION', startTime: '2' };
        const call: TraceObservation = { id: 't1', type: 'TOOL', startTime: '3', parentObservationId: 'g2' };
        expect(turnGenerationsOf([first, second, call]).generations.map((g) => g.id)).toEqual(['g2']);
        expect(turnGenerationsOf([first, second, call]).excluded.map((g) => g.id)).toEqual(['g1']);
    });

    it('falls back to the earliest generation when nothing carries a session and there is no tool call', () => {
        const first: TraceObservation = { id: 'g1', type: 'GENERATION', startTime: '1' };
        const second: TraceObservation = { id: 'g2', type: 'GENERATION', startTime: '2' };
        expect(turnGenerationsOf([second, first]).generations.map((g) => g.id)).toEqual(['g1']);
        expect(turnGenerationsOf([]).generations).toEqual([]);
    });
});

describe('reconstructTurn on real staging observations', () => {
    const turn = reconstructTurn(LIVE_TRACE_ID, liveTraceObservations);

    it('judges the turn, not the thread-title generation that follows it', () => {
        expect(turn.prompt).toBe(LIVE_PROMPT);
        expect(turn.finalText).toBe(LIVE_FINAL_TEXT);
        expect(turn.finalText).not.toBe(LIVE_TITLE);
        expect(turn.generationIds).toEqual(['3b7c8647974abea2']);
        expect(turn.excludedGenerations).toBe(1);
        // The system prompts are neither the prompt nor context.
        expect(turn.priorMessages).toEqual([]);
    });

    it('reads the call, its arguments and its result from the TOOL observation', () => {
        expect(turn.steps).toHaveLength(1);
        expect(turn.steps[0].calls[0]).toMatchObject({
            callId: 'tooluse_zdCncYypAAoOJpXKvbeZa7',
            name: 'search-actors',
            arguments: { keywords: 'Google Maps reviews' },
            isError: false,
            observationId: '6f10b5aeb816f8fe',
        });
        expect(turn.hasToolError).toBe(false);
    });

    it('takes the model from the `model` field the endpoint returns, and finds no trace metadata yet', () => {
        expect(turn.metadata.model).toBe('us.anthropic.claude-sonnet-5');
        // apify-ai-agent `feat/trace-contract` is undeployed, so no observation carries
        // `attributes.mastra.metadata.langfuse`; the run counts this as metadataMissing.
        expect(turn.metadataFound).toBe(false);
        expect(turn.metadata.outcome).toBeUndefined();
        expect(turn.metadata.toolSchemaHash).toBeUndefined();
    });

    it('keeps the live TOOL result shape, so a change in what search-actors returns shows up here', () => {
        const [call] = toolCallsOf(liveTraceObservations);
        // The fixture trims the actor list, not the envelope: the judge is shown the
        // real top-level keys, so a rename upstream fails this test.
        expect(Object.keys(call.result as Record<string, unknown>)).toEqual([
            'actors',
            'query',
            'count',
            'userTier',
            'instructions',
        ]);
        const result = call.result as { actors: unknown[]; count: number };
        expect(result.count).toBe(5);
        expect(Object.keys(result.actors[0] as Record<string, unknown>)).toEqual([
            'title',
            'url',
            'id',
            'fullName',
            'pictureUrl',
            'developer',
            'description',
            'categories',
            'pricing',
            'stats',
            'rating',
            'isDeprecated',
            'inputFields',
        ]);
        // The other four actors are one trim marker, so the trimming is visible in the data.
        expect(result.actors[1]).toMatch(/trimmed for the fixture/);
    });

    it('flags a real failed tool call and keeps its error payload as the result', () => {
        const [call] = toolCallsOf([liveErrorToolObservation]);
        expect(call.isError).toBe(true);
        expect(call.name).toBe('call-actor');
        // No gen_ai.tool.call.id in that exporter's bag, so the observation id is cited.
        expect(call.callId).toBe(liveErrorToolObservation.id);
        expect(call.result).toMatchObject({ name: 'Error', id: 'TOOL_EXECUTION_FAILED', domain: 'TOOL' });
    });
});
