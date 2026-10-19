import { describe, expect, it } from 'vitest';

import { derive, latestScores, modelLabel, modelSlot } from '../src/collect.js';

describe('report collect', () => {
    it('keeps only the newest version of each score and reads categorical values from value', () => {
        const scores = latestScores([
            { name: 'judge.verdict', value: 'fail', timestamp: '2026-09-21T14:00:00Z' },
            { name: 'judge.verdict', value: 'pass', timestamp: '2026-09-21T16:00:00Z' },
            { name: 'judge.overall', value: 1, comment: 'PASS: fine', timestamp: '2026-09-21T16:00:00Z' },
            { name: 'eval.found', value: 1, timestamp: '2026-09-21T16:00:00Z' },
            { name: 'check.infra', value: 1, timestamp: '2026-09-21T16:00:00Z' },
            { name: 'check.shape', value: 0, timestamp: '2026-09-21T16:00:00Z' },
        ]);
        expect(scores['judge.verdict'].stringValue).toBe('pass');
        const d = derive(scores, 'wrong-actor');
        expect(d.verdict).toBe('pass');
        expect(d.found).toBe(1);
        expect(d.works).toBeNull();
        expect(d.infraOk).toBe(true);
        expect(d.failedChecks).toEqual(['shape']);
        expect(d.judgeComment).toBe('PASS: fine');
    });

    it('maps the profile wrong-subject label and unjudged items', () => {
        expect(
            derive(latestScores([{ name: 'judge.verdict', value: 'wrong-actor', timestamp: 't' }]), 'wrong-actor')
                .verdict,
        ).toBe('wrong-actor');
        expect(
            derive(latestScores([{ name: 'judge.verdict', value: 'wrong-command', timestamp: 't' }]), 'wrong-command')
                .verdict,
        ).toBe('wrong-actor');
        expect(derive({}, 'wrong-actor').verdict).toBe('unjudged');
        expect(derive({}, 'wrong-actor').infraOk).toBeNull();
    });

    it('maps the configured model to a slot and derives a label from the alias', () => {
        expect(modelSlot('anthropic/claude-haiku-4.5')).toBe('~anthropic/claude-haiku-latest');
        expect(modelSlot('~openai/gpt-luna-latest')).toBe('~openai/gpt-luna-latest');
        expect(modelSlot(null)).toBe('unknown');
        expect(modelLabel('~anthropic/claude-haiku-latest')).toBe('Haiku');
        expect(modelLabel('~anthropic/claude-sonnet-latest')).toBe('Sonnet');
        expect(modelLabel('~openai/gpt-luna-latest')).toBe('GPT Luna');
        expect(modelLabel('~deepseek/deepseek-flash-latest')).toBe('DeepSeek Flash');
        expect(modelLabel('moonshotai/kimi-k2.5')).toBe('Kimi K2.5');
        expect(modelLabel('~openai/gpt-luna-latest', { '~openai/gpt-luna-latest': 'Luna' })).toBe('Luna');
    });

    it('keeps score metadata so the judge model can be read', () => {
        const scores = latestScores([
            {
                name: 'judge.verdict',
                value: 'pass',
                timestamp: 't',
                metadata: {
                    judgeModel: '~anthropic/claude-sonnet-latest',
                    judgeModelResolved: 'anthropic/claude-sonnet-5.5',
                },
            },
        ]);
        expect(scores['judge.verdict'].metadata).toMatchObject({ judgeModelResolved: 'anthropic/claude-sonnet-5.5' });
    });
});
