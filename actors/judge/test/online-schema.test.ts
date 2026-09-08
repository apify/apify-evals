import { describe, expect, it } from 'vitest';

import {
    agentToolKey,
    checkArgumentCorrectness,
    stableStringify,
    toolSchemaHash,
    type ToolSchemaSet,
    toolSchemaSetFromMcp,
} from '../src/online-schema.js';
import type { OnlineTurn, TurnToolCall } from '../src/online-turn.js';

/**
 * The toolset apify-ai-agent's own `toolSchemaHash()` was run on
 * (`src/mastra/trace-contract.ts`, 2026-09-08) and the hash it produced.
 * If this test fails, the port has drifted and schemaMatch is false forever.
 */
const AGENT_TOOLSET = {
    'apify-ai_search-actors': {
        description: 'Search the Apify Store',
        inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
            required: ['query'],
            additionalProperties: false,
        },
    },
    'apify-ai_call-actor': {
        description: '',
        inputSchema: {
            type: 'object',
            properties: { actor: { type: 'string' }, input: { type: 'object' } },
            required: ['actor'],
        },
    },
    'apify-ai_fetch-actor-details': {
        description: 'Fetch details',
        inputSchema: {
            type: 'object',
            properties: { actor: { type: 'string', description: 'id' } },
            required: ['actor'],
        },
    },
};
const AGENT_HASH = 'sha256:6e8c30f47d3b56ca7ba7a05db90da04060064254f863cb5b1b273af0612111ee';

describe('toolSchemaHash (port of the agent algorithm)', () => {
    it('reproduces the hash the agent computed on the same toolset', () => {
        expect(toolSchemaHash(AGENT_TOOLSET)).toBe(AGENT_HASH);
    });

    it('caps the depth exactly like the agent', () => {
        const deep = {
            'apify-ai_deep': {
                description: 'd',
                inputSchema: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } },
            },
        };
        expect(toolSchemaHash(deep)).toBe('sha256:acf30149416bc43eb28eca41773bd13f3f6132cc308dcc9fcf235091ff6d476c');
    });

    it('ignores key order and drops functions, like the agent', () => {
        const reordered = {
            'apify-ai_call-actor': {
                inputSchema: {
                    required: ['actor'],
                    properties: { input: { type: 'object' }, actor: { type: 'string' } },
                    type: 'object',
                },
                description: '',
            },
            'apify-ai_fetch-actor-details': AGENT_TOOLSET['apify-ai_fetch-actor-details'],
            'apify-ai_search-actors': { ...AGENT_TOOLSET['apify-ai_search-actors'], execute: () => undefined },
        };
        expect(toolSchemaHash(reordered)).toBe(AGENT_HASH);
        expect(stableStringify({ b: 1, a: [undefined, () => 1] })).toBe('{"a":[null,null],"b":1}');
    });
});

describe('toolSchemaSetFromMcp', () => {
    const mcpTools = [
        {
            name: 'search-actors',
            description: 'Search the Apify Store',
            inputSchema: AGENT_TOOLSET['apify-ai_search-actors'].inputSchema,
        },
        { name: 'call-actor', inputSchema: AGENT_TOOLSET['apify-ai_call-actor'].inputSchema },
        {
            name: 'fetch-actor-details',
            description: 'Fetch details',
            inputSchema: AGENT_TOOLSET['apify-ai_fetch-actor-details'].inputSchema,
        },
    ];

    it('namespaces tool names the way @mastra/mcp does for the apify-ai server and hashes to the agent value', () => {
        const set = toolSchemaSetFromMcp(mcpTools);
        expect(agentToolKey('search-actors')).toBe('apify-ai_search-actors');
        expect(set.tools.map((t) => t.key)).toEqual([
            'apify-ai_search-actors',
            'apify-ai_call-actor',
            'apify-ai_fetch-actor-details',
        ]);
        expect(set.tools[1].description).toBe('');
        expect(set.hash).toBe(AGENT_HASH);
    });
});

const schemas: ToolSchemaSet = toolSchemaSetFromMcp([
    {
        name: 'search-actors',
        description: 'Search the Apify Store',
        inputSchema: AGENT_TOOLSET['apify-ai_search-actors'].inputSchema,
    },
    { name: 'call-actor', inputSchema: AGENT_TOOLSET['apify-ai_call-actor'].inputSchema },
]);

function call(name: string, args: unknown, callId = 'c1'): TurnToolCall {
    return { callId, name, arguments: args, result: {}, isError: false, observationId: `g-${callId}` };
}

function turnWith(calls: TurnToolCall[], traceHash?: string): OnlineTurn {
    return {
        traceId: 't',
        prompt: 'p',
        priorMessages: [],
        steps: calls.length > 0 ? [{ index: 1, calls }] : [],
        finalText: '',
        hasToolError: false,
        generationIds: ['g1'],
        metadata: traceHash ? { toolSchemaHash: traceHash } : {},
    };
}

describe('checkArgumentCorrectness', () => {
    it('passes valid arguments and reports schemaMatch when the trace hash equals the live one', () => {
        const result = checkArgumentCorrectness(
            turnWith([call('apify-ai_search-actors', { query: 'x', limit: 5 })], schemas.hash),
            schemas,
        );
        expect(result).toMatchObject({
            verdict: 'pass',
            schemaMatch: true,
            liveHash: schemas.hash,
            unvalidatedTools: [],
        });
        expect(result.validated).toEqual([
            { callId: 'c1', name: 'apify-ai_search-actors', observationId: 'g-c1', valid: true, errors: [] },
        ]);
    });

    it('fails on invalid arguments with paths and messages but never the values', () => {
        const args = { query: 'SECRET_VALUE', limit: 'many' };
        const result = checkArgumentCorrectness(
            turnWith([call('apify-ai_search-actors', args)], schemas.hash),
            schemas,
        );
        expect(result.verdict).toBe('fail');
        expect(result.validated[0].valid).toBe(false);
        expect(result.validated[0].errors.join(' ')).toContain('/limit must be integer');
        expect(JSON.stringify(result)).not.toContain('SECRET_VALUE');
    });

    it('omits the criterion when there are no tool calls', () => {
        expect(checkArgumentCorrectness(turnWith([], schemas.hash), schemas)).toMatchObject({
            verdict: 'omitted',
            reason: 'no tool calls in the turn',
        });
    });

    it('omits the criterion with the tool names when no called tool has a schema', () => {
        const result = checkArgumentCorrectness(turnWith([call('apify-ai_unknown-tool', {})], schemas.hash), schemas);
        expect(result).toMatchObject({
            verdict: 'omitted',
            reason: 'no schema for the called tool(s): apify-ai_unknown-tool',
        });
        expect(result.validated[0].valid).toBeNull();
    });

    it('validates what it can and lists the rest when only some tools have schemas', () => {
        const calls = [call('apify-ai_search-actors', { query: 'x' }, 'c1'), call('apify-ai_unknown-tool', {}, 'c2')];
        const result = checkArgumentCorrectness(turnWith(calls, schemas.hash), schemas);
        expect(result.verdict).toBe('pass');
        expect(result.unvalidatedTools).toEqual(['apify-ai_unknown-tool']);
    });

    it('still validates on a hash mismatch, and marks schemaMatch false', () => {
        const result = checkArgumentCorrectness(turnWith([call('apify-ai_call-actor', {})], 'sha256:other'), schemas);
        expect(result).toMatchObject({ verdict: 'fail', schemaMatch: false });
        expect(result.validated[0].errors[0]).toContain("must have required property 'actor'");
    });

    it('reports schemaMatch null when the trace carries no hash, and falls back to the bare tool name', () => {
        const result = checkArgumentCorrectness(turnWith([call('search-actors', { query: 'x' })]), schemas);
        expect(result).toMatchObject({ verdict: 'pass', schemaMatch: null });
    });
});
