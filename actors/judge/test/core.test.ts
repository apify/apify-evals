import { createHash } from 'node:crypto';

import type { AgentSpanMetadata, ConversationEntry } from '@apify-evals/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { schemaValidityCheck } from '../src/core.js';

const SNAPSHOT = JSON.stringify({
    tools: [
        {
            name: 'call-actor',
            inputSchema: {
                type: 'object',
                properties: { actor: { type: 'string' } },
                required: ['actor'],
                additionalProperties: false,
            },
        },
    ],
});

const metadata: Partial<AgentSpanMetadata> = {
    toolSchemaSnapshotUrl: 'https://api.apify.com/v2/key-value-stores/s/records/snapshot',
    toolSchemaHash: `sha256:${createHash('sha256').update(SNAPSHOT).digest('hex')}`,
};

const stubFetch = (body: string) =>
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));

const toolCall = (tool: string, input: unknown): ConversationEntry =>
    ({ role: 'assistant', type: 'tool_call', tool, input }) as ConversationEntry;

afterEach(() => vi.unstubAllGlobals());

describe('schemaValidityCheck', () => {
    it('validates calls behind any MCP server prefix, not just the Apify one', async () => {
        stubFetch(SNAPSHOT);
        const conversation = [
            toolCall('mcp__apify__call-actor', { actor: 'apify/instagram-scraper' }),
            toolCall('mcp__sbo__call-actor', { actor: 'apify/rag-web-browser' }),
            toolCall('call-actor', { actor: 'apify/web-fetch' }),
        ];
        const res = await schemaValidityCheck(conversation, metadata, 'token');
        expect(res).toEqual({ verdict: 'pass', detail: '3 tool calls valid' });
    });

    it('fails a prefixed call whose input violates the snapshot schema', async () => {
        stubFetch(SNAPSHOT);
        const res = await schemaValidityCheck([toolCall('mcp__sbo__call-actor', { wrong: 1 })], metadata, 'token');
        expect(res.verdict).toBe('fail');
        expect(res.detail).toContain('call-actor');
    });

    it('skips tools that are not in the snapshot', async () => {
        stubFetch(SNAPSHOT);
        const res = await schemaValidityCheck([toolCall('Bash', { command: 'ls' })], metadata, 'token');
        expect(res).toEqual({ verdict: 'not_applicable', detail: 'no validatable tool calls' });
    });

    it('is not_applicable when the trace carries no snapshot', async () => {
        const res = await schemaValidityCheck([toolCall('mcp__apify__call-actor', { actor: 'a/b' })], {}, 'token');
        expect(res).toEqual({ verdict: 'not_applicable', detail: 'no snapshot on trace' });
    });

    it('is not_applicable when the snapshot does not match its hash', async () => {
        stubFetch(`${SNAPSHOT} `);
        const res = await schemaValidityCheck([toolCall('mcp__apify__call-actor', { actor: 'a/b' })], metadata, 'token');
        expect(res).toEqual({ verdict: 'not_applicable', detail: 'snapshot hash mismatch' });
    });
});
