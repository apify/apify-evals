import { describe, expect, it } from 'vitest';

import {
    fetchTraceObservations,
    generationsOf,
    reconstructTurn,
    traceMetadataOf,
    type TraceObservation,
    TurnReconstructionError,
} from '../src/online-turn.js';

/** Messages in the OTel GenAI shape apify-ai-agent's exporter writes to Langfuse `input`/`output`. */
const system = { role: 'system', parts: [{ type: 'text', content: 'You are Apify AI.' }] };
const user = (content: string) => ({ role: 'user', parts: [{ type: 'text', content }] });
const assistantText = (content: string) => ({ role: 'assistant', parts: [{ type: 'text', content }] });
const toolCall = (id: string, name: string, args: unknown, preamble?: string) => ({
    role: 'assistant',
    parts: [
        ...(preamble ? [{ type: 'text', content: preamble }] : []),
        { type: 'tool_call', id, name, arguments: JSON.stringify(args) },
    ],
});
const toolResult = (id: string, name: string, response: unknown) => ({
    role: 'tool',
    parts: [{ type: 'tool_call_response', id, name, response: JSON.stringify(response) }],
});

/** Langfuse returns io as raw JSON strings; the fixture does the same. */
function generation(id: string, startTime: string, input: unknown[], output: unknown[]): TraceObservation {
    return {
        id,
        type: 'GENERATION',
        name: 'chat',
        startTime,
        input: JSON.stringify(input),
        output: JSON.stringify(output),
        providedModelName: 'anthropic.claude-sonnet-4-6',
    };
}

const completion: TraceObservation = {
    id: 'ev1',
    type: 'EVENT',
    name: 'apify-ai.turn-complete',
    startTime: '2026-09-08T10:00:09.000Z',
    metadata: JSON.stringify({ completed: 'true', outcome: 'completed', steps: 2, toolSchemaHash: 'sha256:abc' }),
};

const call1 = toolCall('c1', 'apify-ai_search-actors', { query: 'flights', limit: 5 }, 'Let me search.');
const result1 = toolResult('c1', 'apify-ai_search-actors', { actors: [{ name: 'flights-scraper' }] });

/** One tool-calling step then the answer: two GENERATIONs. */
const singleStep: TraceObservation[] = [
    completion,
    generation(
        'g2',
        '2026-09-08T10:00:05.000Z',
        [system, user('Find cheap flights'), call1, result1],
        [assistantText('Use flights-scraper.')],
    ),
    generation('g1', '2026-09-08T10:00:00.000Z', [system, user('Find cheap flights')], [call1]),
];

describe('reconstructTurn: single step', () => {
    const turn = reconstructTurn('t1', singleStep);

    it('takes the user message as the prompt and the last assistant text as the final answer', () => {
        expect(turn.prompt).toBe('Find cheap flights');
        expect(turn.finalText).toBe('Use flights-scraper.');
        expect(turn.priorMessages).toEqual([]);
    });

    it('pairs the call with its result, parses both, and cites the span that carried the call', () => {
        expect(turn.steps).toHaveLength(1);
        expect(turn.steps[0].calls).toEqual([
            {
                callId: 'c1',
                name: 'apify-ai_search-actors',
                arguments: { query: 'flights', limit: 5 },
                result: { actors: [{ name: 'flights-scraper' }] },
                isError: false,
                observationId: 'g1',
            },
        ]);
        expect(turn.hasToolError).toBe(false);
    });

    it('orders generations by startTime whatever order Langfuse returned', () => {
        expect(turn.generationIds).toEqual(['g1', 'g2']);
        expect(generationsOf(singleStep).map((g) => g.id)).toEqual(['g1', 'g2']);
    });

    it('reads trace metadata from whichever observation carries it, plus the model', () => {
        expect(turn.metadata).toEqual({
            toolSchemaHash: 'sha256:abc',
            outcome: 'completed',
            steps: 2,
            model: 'anthropic.claude-sonnet-4-6',
        });
    });

    it('does not mistake the preamble before a call for the final answer', () => {
        const ended = reconstructTurn('t2', [singleStep[2]]);
        expect(ended.steps).toHaveLength(1);
        expect(ended.finalText).toBe('');
    });
});

describe('reconstructTurn: multi-step', () => {
    const call2 = toolCall('c2', 'apify-ai_fetch-actor-details', { actor: 'flights-scraper' });
    const result2 = toolResult('c2', 'apify-ai_fetch-actor-details', { readme: '...' });
    const history = [system, user('Earlier question'), assistantText('Earlier answer'), user('Find cheap flights')];
    const observations: TraceObservation[] = [
        generation('g1', '2026-09-08T10:00:00.000Z', history, [call1]),
        generation('g2', '2026-09-08T10:00:03.000Z', [...history, call1, result1], [call2]),
        generation(
            'g3',
            '2026-09-08T10:00:06.000Z',
            [...history, call1, result1, call2, result2],
            [assistantText('Done.')],
        ),
    ];
    const turn = reconstructTurn('t3', observations);

    it('yields one step per tool-calling assistant message, each call once', () => {
        expect(turn.steps.map((s) => s.index)).toEqual([1, 2]);
        expect(turn.steps.flatMap((s) => s.calls.map((c) => c.callId))).toEqual(['c1', 'c2']);
        expect(turn.steps[1].calls[0]).toMatchObject({ observationId: 'g2', result: { readme: '...' } });
    });

    it('dedupes the repeated history: the prompt is the last user message, earlier text is context', () => {
        expect(turn.prompt).toBe('Find cheap flights');
        expect(turn.priorMessages).toEqual([
            { role: 'user', text: 'Earlier question' },
            { role: 'assistant', text: 'Earlier answer' },
        ]);
        expect(turn.finalText).toBe('Done.');
        expect(turn.generationIds).toEqual(['g1', 'g2', 'g3']);
    });
});

describe('reconstructTurn: tool errors', () => {
    it('flags an MCP isError result', () => {
        const errored = toolResult('c1', 'apify-ai_search-actors', { isError: true, content: [{ text: 'boom' }] });
        const turn = reconstructTurn('t4', [
            generation('g1', '2026-09-08T10:00:00.000Z', [user('q')], [call1]),
            generation('g2', '2026-09-08T10:00:01.000Z', [user('q'), call1, errored], [assistantText('Sorry.')]),
        ]);
        expect(turn.steps[0].calls[0].isError).toBe(true);
        expect(turn.hasToolError).toBe(true);
    });

    it("flags a Mastra tool-error part, which the exporter's converter passes through unchanged", () => {
        const raw = {
            role: 'tool',
            content: [
                {
                    type: 'tool-error',
                    toolCallId: 'c1',
                    toolName: 'apify-ai_search-actors',
                    input: {},
                    error: 'timeout',
                },
            ],
        };
        const turn = reconstructTurn('t5', [
            generation('g1', '2026-09-08T10:00:00.000Z', [user('q')], [call1]),
            generation('g2', '2026-09-08T10:00:01.000Z', [user('q'), call1, raw], [assistantText('Sorry.')]),
        ]);
        expect(turn.steps[0].calls[0]).toMatchObject({ isError: true, result: 'timeout' });
        expect(turn.hasToolError).toBe(true);
    });

    it('accepts Mastra-shaped tool-call and error-typed tool-result parts too', () => {
        const mastraCall = {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: 'c9', toolName: 'apify-ai_call-actor', input: { actor: 'x' } }],
        };
        const mastraResult = {
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'c9',
                    toolName: 'apify-ai_call-actor',
                    output: { type: 'error-text', value: 'failed' },
                },
            ],
        };
        const turn = reconstructTurn('t6', [
            generation('g1', '2026-09-08T10:00:00.000Z', [user('q')], [mastraCall]),
            generation('g2', '2026-09-08T10:00:01.000Z', [user('q'), mastraCall, mastraResult], [assistantText('.')]),
        ]);
        expect(turn.steps[0].calls[0]).toMatchObject({
            callId: 'c9',
            arguments: { actor: 'x' },
            result: 'failed',
            isError: true,
        });
    });
});

describe('reconstructTurn: refusals', () => {
    it('throws when the trace has no GENERATION', () => {
        expect(() => reconstructTurn('t7', [completion])).toThrow(TurnReconstructionError);
        expect(() => reconstructTurn('t7', [completion])).toThrow(/no GENERATION/);
    });

    it('throws when no user message can be found', () => {
        const noUser = generation('g1', '2026-09-08T10:00:00.000Z', [system], [assistantText('hi')]);
        expect(() => reconstructTurn('t8', [noUser])).toThrow(/no user message/);
    });

    it('tolerates a non-JSON output by treating it as the assistant text', () => {
        const turn = reconstructTurn('t9', [
            {
                id: 'g1',
                type: 'GENERATION',
                startTime: '2026-09-08T10:00:00.000Z',
                input: JSON.stringify([user('q')]),
                output: 'plain',
            },
        ]);
        expect(turn.finalText).toBe('plain');
    });
});

describe('traceMetadataOf', () => {
    it('reads top-level and nested langfuse keys, string or object metadata, first value wins', () => {
        const observations: TraceObservation[] = [
            { id: 'a', type: 'SPAN', startTime: '1', metadata: { langfuse: { toolSchemaHash: 'sha256:1' } } },
            { id: 'b', type: 'EVENT', startTime: '2', metadata: JSON.stringify({ outcome: 'aborted', steps: '3' }) },
            { id: 'c', type: 'EVENT', startTime: '3', metadata: { outcome: 'completed' } },
        ];
        expect(traceMetadataOf(observations)).toEqual({ toolSchemaHash: 'sha256:1', outcome: 'aborted', steps: 3 });
        expect(traceMetadataOf([{ id: 'd', type: 'SPAN', startTime: '1', metadata: 'not json' }])).toEqual({});
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
            limit: 1000,
            cursor: undefined,
        });
        expect(requests[1].cursor).toBe('next');
    });
});
