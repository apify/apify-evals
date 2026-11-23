import { describe, expect, it, vi } from 'vitest';

import { runCodex } from '../src/adapters/codex.js';

// The relay cannot listen (EMFILE, EADDRNOTAVAIL): the session fails, the runner goes on.
vi.mock('../src/adapters/codex-relay.js', () => ({
    startModelRelay: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('listen EMFILE: too many open files'), { code: 'EMFILE' })),
}));

describe('Codex model relay start failure', () => {
    it('marks the session as a harness error instead of throwing', async () => {
        const result = await runCodex({
            prompt: 'p',
            item: { metadata: {} },
            harness: { kind: 'codex', model: 'openai/gpt-5-mini', maxTurns: 4 },
            mcpUrl: 'https://mcp.invalid',
            apifyToken: 'test-token-not-a-secret',
            useOpenRouterProxy: true,
            perItemTimeoutSecs: 5,
        });
        expect(result.harnessBroke).toBe(true);
        expect(result.metrics).toMatchObject({ subtype: 'error_session', isError: true });
        expect(result.stderr).toContain('model relay could not start: listen EMFILE');
    });
});
