import { describe, expect, it } from 'vitest';

import {
    CONTRACT_VERSION,
    isPreContract,
    validateAgentSpanMetadata,
    validateAgentSpanOutput,
    validateDatasetItemMetadata,
} from '../src/index.js';

// Conversation captured from a real 19 Aug cloud run (pre-contract trace
// 0817a42c...), plus the v1 envelope the ported runner adds around it.
const realConversation = [
    {
        role: 'assistant',
        type: 'text',
        text: "I'll use the Instagram scraper Actor to get @nasa's profile data and recent posts.",
    },
    {
        role: 'assistant',
        type: 'tool_call',
        tool: 'mcp__apify__fetch-actor-details',
        input: { actor: 'apify/instagram-scraper', output: { inputSchema: true } },
    },
    { role: 'tool', type: 'tool_result', preview: '{"inputSchema":{"title":"Instagram Scraper"…' },
    {
        role: 'assistant',
        type: 'tool_call',
        tool: 'mcp__apify__call-actor',
        input: {
            actor: 'apify/instagram-scraper',
            input: { resultsType: 'posts', directUrls: ['https://www.instagram.com/nasa/'], resultsLimit: 30 },
        },
    },
    { role: 'assistant', type: 'text', text: '**@nasa Instagram Engagement Analysis** …' },
];

const v1Output = {
    contractVersion: CONTRACT_VERSION,
    conversation: realConversation,
    finalResult: '**@nasa Instagram Engagement Analysis** …',
};

const v1Metadata = {
    harness: 'claude-code',
    model: 'anthropic/claude-haiku-4.5',
    exitCode: 0,
    subtype: 'success',
    isError: false,
    timedOut: false,
    stdoutTruncated: false,
    durationMs: 98756,
    numTurns: 8,
    usage: { input_tokens: 12000, output_tokens: 900 },
    costUsd: 0.19,
    peakChildRssMb: 290,
    toolCalls: 6,
    harnessBroke: false,
    fullLogUrl: 'https://api.apify.com/v2/key-value-stores/abc/records/log-0817a42c',
    fullLogHash: 'sha256:2f3a…',
    toolSchemaSnapshotUrl: 'https://api.apify.com/v2/key-value-stores/abc/records/toolschema-9be1',
    toolSchemaHash: 'sha256:9be1…',
};

describe('agent span contract', () => {
    it('accepts a v1 span output built around a real captured conversation', () => {
        expect(validateAgentSpanOutput(v1Output)).toBe(true);
    });

    it('accepts v1 span metadata with artifact pointers', () => {
        expect(validateAgentSpanMetadata(v1Metadata)).toBe(true);
    });

    it('rejects a span output missing the conversation', () => {
        const bad = { contractVersion: CONTRACT_VERSION, finalResult: 'x' };
        expect(validateAgentSpanOutput(bad)).toBe(false);
    });

    it('rejects metadata without artifact pointers (pointers are required in v1)', () => {
        const { fullLogUrl: _u, fullLogHash: _h, ...rest } = v1Metadata;
        expect(validateAgentSpanMetadata(rest)).toBe(false);
    });

    it('classifies the 19 Aug span shape as pre-contract', () => {
        const preContract = { conversation: realConversation, finalResult: 'x' };
        expect(isPreContract(preContract)).toBe(true);
        expect(isPreContract(v1Output)).toBe(false);
    });
});

describe('dataset item metadata', () => {
    it('accepts a real store-actors item', () => {
        expect(
            validateDatasetItemMetadata({
                title: 'Usage: agent drives the pinned flagship actor to compute engagement',
                actor: 'apify/instagram-scraper',
                team: 'socials',
                skill: 'actor-usage',
                category: 'instagram-scraper',
                tools: ['fetch-actor-details', 'call-actor', 'get-actor-run', 'get-dataset-items'],
                maxTurns: 16,
                checks: [{ type: 'regex', value: '\\d[\\d,]{5,}' }],
            }),
        ).toBe(true);
    });

    it('rejects a malformed check', () => {
        expect(validateDatasetItemMetadata({ checks: [{ type: 'jq', value: '.' }] })).toBe(false);
    });
});
