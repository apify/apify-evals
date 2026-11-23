import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { parseOpenCodeEvents } from '../src/adapters/opencode-events.js';
import { runSession, type SessionContext } from '../src/harness.js';

const tracing = vi.hoisted(() => ({
    agentUpdate: vi.fn(),
    start: vi.fn((_name: string, _attributes: unknown, _options: unknown) => ({ update: vi.fn(), end: vi.fn() })),
    adapter: vi.fn(),
}));
vi.mock('../src/adapters/opencode.js', () => ({ runOpenCode: tracing.adapter }));
vi.mock('@langfuse/tracing', () => ({
    propagateAttributes: (_attributes: unknown, fn: () => unknown) => fn(),
    startObservation: tracing.start,
    startActiveObservation: (_name: string, fn: (span: unknown) => unknown) =>
        fn({
            otelSpan: { spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }) },
            update: tracing.agentUpdate,
        }),
}));
vi.mock('@opentelemetry/api', () => ({
    trace: { getActiveSpan: () => ({ spanContext: () => ({ spanId: 'c'.repeat(16) }) }) },
}));
vi.mock('../src/evidence.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/evidence.js')>()),
    enrichFromApify: async (runs: unknown[]) => ({ actorRuns: runs, datasets: {}, actorRunsCostUsd: 0 }),
}));

describe('OpenCode wiring into the unchanged session pipeline', () => {
    it('emits generations, MCP observations, contract-valid evidence and check scores', async () => {
        // Captured from opencode 2.3.2 with a scripted model and the real Apify MCP server.
        const fixture = readFileSync(new URL('./fixtures/opencode-call-actor.jsonl', import.meta.url), 'utf8');
        const parsed = parseOpenCodeEvents(fixture, { mcpServers: ['apify'] });
        tracing.adapter.mockResolvedValue({
            output: parsed.finalResult,
            conversation: parsed.conversation,
            timeline: parsed.timeline,
            startedAt: 900,
            rawStdout: fixture,
            metrics: {
                exitCode: 0,
                subtype: 'success',
                numTurns: parsed.numTurns,
                usage: parsed.usage,
                mcpServers: [{ name: 'apify', status: 'connected' }],
                mcpToolCount: 5,
                mcpExpected: true,
                mcpRestarts: 0,
                skillsLoaded: [],
                skillsUsed: [],
                durationMs: 1000,
            },
            harnessBroke: false,
            stderr: '',
        });
        const ref = { url: 'https://example.test/artifact', hash: `sha256:${'0'.repeat(64)}` };
        const putJson = vi.fn().mockResolvedValue(ref);
        const writeScore = vi.fn().mockResolvedValue(undefined);
        const ctx = {
            item: {
                input: { prompt: 'Run apify/hello-world' },
                metadata: {
                    tools: ['call-actor'],
                    checks: [{ id: 'ran', type: 'tool.called', name: 'call-actor' }],
                },
            },
            harness: { kind: 'opencode', model: 'z-ai/glm-5.3', maxTurns: 6 },
            datasetName: 'store-actors',
            mcpUrl: 'https://mcp.apify.com',
            apifyToken: 'apify_test_token',
            mcpEnv: { APIFY_TOKEN: 'apify_test_token' },
            skillSet: [],
            skillsRoot: '/nonexistent',
            artifactStore: { putJson, putLog: vi.fn().mockResolvedValue(ref) },
            snapshots: { get: vi.fn().mockResolvedValue(ref) },
            references: { run: vi.fn() },
            writeScore,
        } as unknown as SessionContext;
        await expect(runSession(ctx)).resolves.toEqual({ output: parsed.finalResult });
        expect(tracing.start.mock.calls.map(([name]) => name)).toEqual(['turn 1', 'call-actor', 'turn 2']);
        expect(tracing.start.mock.calls[0][1]).toMatchObject({
            usageDetails: { output: 10, cache_read: 5 },
        });
        const { evidence, infra } = putJson.mock.calls[0][1];
        expect(evidence.toolCalls).toEqual([
            { tool: 'mcp__apify__call-actor', input: { actor: 'apify/hello-world', input: {}, waitSecs: 30 } },
        ]);
        expect(evidence.actorRuns).toMatchObject([{ runId: 'QWAskMNL4ydjKfguF', actor: 'apify/hello-world' }]);
        expect(evidence.surfacesUsed).toEqual(['mcp']);
        expect(infra).toEqual({ ok: true, reasons: [] });
        expect(writeScore.mock.calls.map(([score]) => [score.name, score.value])).toEqual([
            ['check.ran', 1],
            ['check.all', 1],
            ['check.infra', 1],
        ]);
        expect(tracing.agentUpdate.mock.calls[0][0].metadata).toMatchObject({
            harness: 'opencode',
            toolsUsed: ['call-actor'],
            infraOk: true,
        });
    });
});
