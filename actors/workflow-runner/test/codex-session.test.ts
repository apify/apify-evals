import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { parseCodexEvents } from '../src/adapters/codex-events.js';
import { runSession, validateHarness, type SessionContext } from '../src/harness.js';

const tracing = vi.hoisted(() => ({
    agentUpdate: vi.fn(),
    start: vi.fn((_name: string, _attributes: unknown, _options: unknown) => ({ update: vi.fn(), end: vi.fn() })),
    adapter: vi.fn(),
}));
vi.mock('../src/adapters/codex.js', () => ({ runCodex: tracing.adapter }));
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
    enrichFromApify: async () => ({ actorRuns: [], datasets: {}, actorRunsCostUsd: 0 }),
}));

describe('Codex wiring into the unchanged session pipeline', () => {
    it('registers both harnesses and rejects unknown adapters', () => {
        for (const kind of ['claude-code', 'codex']) {
            expect(() => validateHarness({ kind, model: 'test-model', maxTurns: 12 })).not.toThrow();
        }
        expect(() => validateHarness({ kind: 'missing', model: 'test-model', maxTurns: 12 })).toThrow(
            'Unknown harness.kind',
        );
    });

    it('emits generations, MCP observations, contract-valid evidence, and deterministic scores', async () => {
        const fixture = readFileSync(new URL('./fixtures/codex-mcp.jsonl', import.meta.url), 'utf8');
        const parsed = parseCodexEvents(fixture, [], 1000);
        tracing.adapter.mockResolvedValue({
            output: parsed.finalResult,
            conversation: parsed.conversation,
            timeline: parsed.timeline,
            startedAt: 900,
            rawStdout: fixture,
            metrics: {
                exitCode: 0,
                subtype: 'success',
                mcpServers: [{ name: 'apify', status: 'connected' }],
                mcpToolCount: 1,
                mcpExpected: true,
                mcpRestarts: 0,
            },
            harnessBroke: false,
            stderr: '',
        });
        const ref = { url: 'https://example.test/artifact', hash: `sha256:${'0'.repeat(64)}` };
        const putJson = vi.fn().mockResolvedValue(ref);
        const putLog = vi.fn().mockResolvedValue(ref);
        const writeScore = vi.fn().mockResolvedValue(undefined);
        const ctx = {
            item: {
                input: { prompt: 'Find a crawler' },
                metadata: {
                    tools: ['search-actors'],
                    checks: [{ id: 'actor', type: 'answer.contains', value: 'apify/website-content-crawler' }],
                },
            },
            harness: { kind: 'codex', model: 'openai/gpt-5-mini', maxTurns: 12 },
            datasetName: 'store-actors',
            artifactStore: { putJson, putLog },
            snapshots: { get: vi.fn().mockResolvedValue(ref) },
            references: { run: vi.fn() },
            writeScore,
        } as unknown as SessionContext;
        await expect(runSession(ctx)).resolves.toEqual({ output: parsed.finalResult });
        expect(tracing.start.mock.calls.map(([name]) => name)).toEqual(['turn 1', 'search-actors', 'turn 2']);
        expect(tracing.start.mock.calls.map((call) => call[2])).toMatchObject([
            { asType: 'generation' },
            { asType: 'tool' },
            { asType: 'generation' },
        ]);
        expect(putLog).toHaveBeenCalledWith('a'.repeat(32), fixture);
        const { evidence, infra } = putJson.mock.calls[0][1];
        expect(evidence.toolCalls).toMatchObject([{ tool: 'mcp__apify__search-actors', input: { limit: 1 } }]);
        expect(evidence.session).toMatchObject({
            timedOut: false,
            stdoutTruncated: false,
            harnessBroke: false,
            exitCode: 0,
            subtype: 'success',
            mcpExpected: true,
            mcpToolCount: 1,
            mcpRestarts: 0,
        });
        expect(infra).toEqual({ ok: true, reasons: [] });
        expect(writeScore.mock.calls.map(([score]) => [score.name, score.value])).toEqual([
            ['check.actor', 1],
            ['check.all', 1],
            ['check.infra', 1],
        ]);
        expect(tracing.agentUpdate.mock.calls[0][0].metadata).toMatchObject({
            harness: 'codex',
            toolsUsed: ['search-actors'],
            infraOk: true,
        });
    });
});
