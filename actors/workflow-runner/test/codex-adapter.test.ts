import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseCodexEvents } from '../src/adapters/codex-events.js';
import { extractFromTools } from '../src/evidence.js';

const fixture = readFileSync(new URL('./fixtures/codex-mcp.jsonl', import.meta.url), 'utf8');
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

describe('Codex event parser', () => {
    it('rebuilds generations and MCP observations from a captured CLI session', () => {
        const parsed = parseCodexEvents(fixture, [1, 2, 3, 4, 5, 6, 7]);
        expect(parsed.completed).toBe(true);
        expect(parsed.failed).toBe(false);
        expect(parsed.numTurns).toBe(2);
        expect(parsed.toolRounds).toBe(1);
        expect(parsed.timeline.map((e) => [e.kind, e.t])).toEqual([
            ['assistant', 4],
            ['tool_result', 5],
            ['assistant', 6],
        ]);
        expect(parsed.timeline[0]).toMatchObject({
            toolUses: [
                {
                    id: 'item_1',
                    name: 'mcp__apify__search-actors',
                    input: { keywords: 'website content crawler', limit: 1 },
                },
            ],
            usage: null,
        });
        expect(parsed.usage).toMatchObject({ input_tokens: 23035, output_tokens: 212, cached_input_tokens: 10624 });
        expect(parsed.finalResult).toContain('apify/website-content-crawler');
        expect(parsed.conversation.map((e) => e.type)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
    });

    it('preserves structured Actor and dataset evidence without changing downstream extraction', () => {
        const call = (id: string, tool: string, args: unknown, result: unknown) => ({
            type: 'item.completed',
            item: {
                id,
                type: 'mcp_tool_call',
                server: 'apify',
                tool,
                arguments: args,
                result,
                error: null,
                status: 'completed',
            },
        });
        const parsed = parseCodexEvents(
            jsonl(
                call(
                    'run',
                    'call-actor',
                    { actor: 'apify/example', input: { limit: 2 } },
                    {
                        structured_content: {
                            runId: '12345678901234567',
                            status: 'SUCCEEDED',
                            defaultDatasetId: 'dataset1234567890',
                        },
                    },
                ),
                call(
                    'items',
                    'get-dataset-items',
                    { datasetId: 'dataset1234567890' },
                    { content: [{ type: 'text', text: '[]' }] },
                ),
            ),
        );
        const calls = parsed.timeline.flatMap((e) => (e.kind === 'assistant' ? e.toolUses : []));
        const results = parsed.timeline.flatMap((e) => (e.kind === 'tool_result' ? [e] : []));
        const evidence = extractFromTools(calls, results);
        expect(evidence.actorRuns).toMatchObject([
            { actor: 'apify/example', runId: '12345678901234567', status: 'SUCCEEDED', input: { limit: 2 } },
        ]);
        expect(evidence.datasetsRead).toEqual(['dataset1234567890']);
    });

    it('handles parallel calls, repeated updates, MCP errors, reasoning, and partial output', () => {
        const tool = (id: string) => ({
            id,
            type: 'mcp_tool_call',
            server: 'apify',
            tool: 'get-actor-run',
            arguments: {},
        });
        const parsed = parseCodexEvents(
            jsonl(
                { type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'Check both runs.' } },
                { type: 'item.started', item: tool('a') },
                { type: 'item.started', item: tool('b') },
                { type: 'item.updated', item: tool('a') },
                { type: 'item.completed', item: { ...tool('a'), status: 'failed', error: { message: 'not found' } } },
                { type: 'item.completed', item: { ...tool('a'), status: 'failed', error: { message: 'not found' } } },
                {
                    type: 'item.completed',
                    item: {
                        ...tool('b'),
                        status: 'completed',
                        result: { content: [{ type: 'text', text: '{"status":"RUNNING"}' }] },
                    },
                },
            ) + '\nnot-json\n{"type":',
        );
        expect(parsed.toolRounds).toBe(1);
        expect(parsed.timeline).toHaveLength(3);
        expect(parsed.timeline[0]).toMatchObject({ text: ['[Reasoning] Check both runs.'] });
        expect(parsed.timeline[1]).toMatchObject({ isError: true, toolUseId: 'a' });
        expect(parsed.timeline[2]).toMatchObject({ isError: false, content: '{"status":"RUNNING"}' });
        expect(parsed.finalResult).toBe('');
    });

    it('distinguishes metadata warnings from a failed turn and does not invent usage', () => {
        const failure = parseCodexEvents(
            readFileSync(new URL('./fixtures/codex-provider-failure.jsonl', import.meta.url), 'utf8'),
        );
        expect(failure.failed).toBe(true);
        expect(failure.completed).toBe(false);
        expect(failure.timeline).toEqual([]);
        expect(failure.usage).toBeNull();
        const good = parseCodexEvents(
            jsonl(
                { type: 'item.completed', item: { id: 'warning', type: 'error', message: 'Metadata unavailable' } },
                { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'OK' } },
                { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 1 } },
            ),
        );
        expect(good.failed).toBe(false);
        expect(good.timeline[0]).toMatchObject({
            usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 1 },
        });
    });
});
