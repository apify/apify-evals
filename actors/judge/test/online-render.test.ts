import { describe, expect, it } from 'vitest';

import { PAYLOAD_CHAR_BUDGET, renderTurnForJudge, truncateHeadTail } from '../src/online-render.js';
import type { OnlineTurn } from '../src/online-turn.js';

const MARKER = /\[\.\.\. (\d+) chars omitted \.\.\.\]/;

describe('truncateHeadTail', () => {
    it('returns short text unchanged, at the budget included', () => {
        expect(truncateHeadTail('abc', 10)).toBe('abc');
        expect(truncateHeadTail('a'.repeat(10), 10)).toBe('a'.repeat(10));
    });

    it('keeps head and tail around an omission marker naming the omitted count', () => {
        const text = `${'H'.repeat(50)}${'M'.repeat(100)}${'T'.repeat(50)}`;
        const out = truncateHeadTail(text, 100);
        const match = out.match(MARKER);
        expect(match).not.toBeNull();
        const omitted = Number(match![1]);
        expect(omitted).toBe(text.length - (out.length - match![0].length));
        expect(out.startsWith('H'.repeat(36))).toBe(true);
        expect(out.endsWith('T'.repeat(35))).toBe(true);
        expect(out).not.toContain('M');
    });

    it('returns the marker alone when the budget is smaller than the marker', () => {
        expect(truncateHeadTail('x'.repeat(100), 5)).toBe('[... 100 chars omitted ...]');
    });

    it('never exceeds the budget, and hits it exactly when the count keeps its digit width', () => {
        // 9000 - (4096 - 28) = 4932: same number of digits as 9000, so the marker sized for 9000 fits exactly.
        expect(truncateHeadTail('x'.repeat(9000)).length).toBe(PAYLOAD_CHAR_BUDGET);
        for (const length of [4097, 5000, 10_000, 123_456]) {
            expect(truncateHeadTail('x'.repeat(length)).length).toBeLessThanOrEqual(PAYLOAD_CHAR_BUDGET);
        }
        expect(PAYLOAD_CHAR_BUDGET).toBe(4096);
    });
});

const turn: OnlineTurn = {
    traceId: 't1',
    prompt: 'Find cheap flights',
    priorMessages: [{ role: 'user', text: 'hello' }],
    droppedPriorMessages: 3,
    steps: [
        {
            index: 1,
            calls: [
                {
                    callId: 'c1',
                    name: 'search-actors',
                    arguments: { query: 'flights' },
                    result: { actors: ['flights-scraper'] },
                    isError: false,
                    observationId: 'g1',
                },
                {
                    callId: 'c2',
                    name: 'call-actor',
                    arguments: { actor: 'x' },
                    result: 'timeout',
                    isError: true,
                    observationId: 'g1',
                },
            ],
        },
    ],
    finalText: 'Use flights-scraper.',
    hasToolError: true,
    generationIds: ['g1', 'g2'],
    excludedGenerations: 0,
    metadata: { outcome: 'completed' },
    metadataFound: true,
};

describe('renderTurnForJudge', () => {
    const text = renderTurnForJudge(turn);

    it('shows the prompt, the context, every call with arguments AND result, the answer and the outcome', () => {
        expect(text).toContain('## User request\nFind cheap flights');
        expect(text).toContain('(3 earlier messages not shown)\n[user] hello');
        expect(renderTurnForJudge({ ...turn, droppedPriorMessages: 0 })).not.toContain('not shown');
        expect(text).toContain('tool call: search-actors (span g1, call c1)');
        expect(text).toContain('arguments: {"query":"flights"}');
        expect(text).toContain('result: {"actors":["flights-scraper"]}');
        expect(text).toContain('result [TOOL ERROR]: timeout');
        expect(text).toContain('## Final answer to the user\nUse flights-scraper.');
        expect(text).toContain('completed; 1 tool-calling step(s); at least one tool call errored');
    });

    it('caps each payload on its own so one huge result cannot crowd out the rest', () => {
        const huge = {
            ...turn,
            steps: [{ index: 1, calls: [{ ...turn.steps[0].calls[0], result: 'r'.repeat(20_000) }] }],
        };
        const out = renderTurnForJudge(huge, 100);
        expect(out).toMatch(MARKER);
        expect(out).toContain('Find cheap flights');
        expect(out).toContain('Use flights-scraper.');
        expect(out.length).toBeLessThan(1000);
    });

    it('says so when there were no tool calls, no result or no final text', () => {
        const bare = renderTurnForJudge({
            ...turn,
            priorMessages: [],
            steps: [],
            finalText: '',
            hasToolError: false,
            metadata: {},
        });
        expect(bare).toContain('(no tool calls)');
        expect(bare).toContain('(no final text)');
        expect(bare).toContain('unknown; 0 tool-calling step(s); no tool call errored');
        expect(bare).not.toContain('Earlier conversation');
        const noResult = { ...turn, steps: [{ index: 1, calls: [{ ...turn.steps[0].calls[0], result: undefined }] }] };
        expect(renderTurnForJudge(noResult)).toContain('result: (none recorded)');
        const { arguments: _dropped, ...withoutArguments } = turn.steps[0].calls[0];
        const noArguments = { ...turn, steps: [{ index: 1, calls: [withoutArguments] }] };
        expect(renderTurnForJudge(noArguments)).toContain('arguments: (none recorded)');
    });
});
