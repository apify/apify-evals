import { describe, expect, it } from 'vitest';

import { JUDGE_IMPL_VERSION } from '../src/core.js';
import {
    buildOnlineVerdicts,
    DEFAULT_ONLINE_JUDGE_MODEL,
    DEFAULT_ONLINE_JUDGE_PROMPT,
    InvalidJudgeReplyError,
    judgeOnlineTrace,
    LLM_CRITERIA,
    ONLINE_JUDGE_PROMPT_NAME,
    type OnlineScore,
    type ParsedJudgeReply,
    parseOnlineJudgeReply,
    TURN_DELIMITER_CLOSE,
    TURN_DELIMITER_OPEN,
} from '../src/online-judge.js';
import type { ArgumentCorrectnessResult } from '../src/online-schema.js';
import { toolSchemaSetFromMcp } from '../src/online-schema.js';
import type { OnlineTurn } from '../src/online-turn.js';
import { ONLINE_RUBRIC, ONLINE_SCORE_NAMES } from '../src/rubric.js';

const USER_TEXT = 'SECRET_USER_TEXT find me flights';
const TOOL_PAYLOAD = 'SECRET_TOOL_PAYLOAD';

const turn: OnlineTurn = {
    traceId: 't1',
    prompt: USER_TEXT,
    priorMessages: [],
    droppedPriorMessages: 0,
    steps: [
        {
            index: 1,
            calls: [
                {
                    callId: 'c1',
                    name: 'search-actors',
                    arguments: { query: TOOL_PAYLOAD },
                    result: { items: [TOOL_PAYLOAD] },
                    isError: false,
                    observationId: 'g1',
                },
            ],
        },
    ],
    finalText: `Here: ${TOOL_PAYLOAD}`,
    hasToolError: false,
    generationIds: ['g1', 'g2'],
    excludedGenerations: 1,
    metadata: { toolSchemaHash: 'sha256:abc', outcome: 'completed' },
    metadataFound: true,
};

const passAll: ParsedJudgeReply = {
    criteria: Object.fromEntries(
        LLM_CRITERIA.map((id) => [
            id,
            { evidence: `evidence quoting ${USER_TEXT} and ${TOOL_PAYLOAD}`, verdict: 'pass' },
        ]),
    ) as ParsedJudgeReply['criteria'],
    holistic: { evidence: `holistic evidence ${USER_TEXT}`, verdict: 'pass' },
};

const argsPass: ArgumentCorrectnessResult = {
    verdict: 'pass',
    schemaMatch: true,
    liveHash: 'sha256:abc',
    validated: [{ callId: 'c1', name: 'search-actors', observationId: 'g1', valid: true, errors: [] }],
    unvalidatedTools: [],
    callsWithoutArguments: [],
};

const version = { judgeModel: DEFAULT_ONLINE_JUDGE_MODEL, promptVersion: 3 };

function score(scores: OnlineScore[], name: string): Extract<OnlineScore, { value: 0 | 1 }> {
    const found = scores.find((s) => s.name === name);
    if (!found) throw new Error(`no score ${name}`);
    if (!('value' in found)) throw new Error(`score ${name} was omitted: ${found.reason}`);
    return found;
}

function omitted(scores: OnlineScore[], name: string): Extract<OnlineScore, { omitted: true }> {
    const found = scores.find((s) => s.name === name);
    if (!found) throw new Error(`no score ${name}`);
    if (!('omitted' in found)) throw new Error(`score ${name} was not omitted`);
    return found;
}

describe('default online judge prompt', () => {
    it('is the apify-ai-online-judge prompt, reusing every rubric description verbatim', () => {
        expect(ONLINE_JUDGE_PROMPT_NAME).toBe('apify-ai-online-judge');
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain('{{turn}}');
        for (const c of ONLINE_RUBRIC.criteria) {
            if (c.id === 'argumentCorrectness') continue; // deterministic, not asked of the model
            expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain(c.description);
        }
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain(ONLINE_RUBRIC.holistic.description);
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).not.toContain('argumentCorrectness');
    });

    it('asks for evidence before each verdict, taskCompletion last, and a separate holistic verdict', () => {
        expect(LLM_CRITERIA[LLM_CRITERIA.length - 1]).toBe('taskCompletion');
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toMatch(/evidence[\s\S]*then the verdict/);
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain('- taskCompletion:');
        expect(DEFAULT_ONLINE_JUDGE_PROMPT.indexOf('- taskCompletion:')).toBeGreaterThan(
            DEFAULT_ONLINE_JUDGE_PROMPT.indexOf('- planEfficiency:'),
        );
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain('SEPARATE judgment');
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain('do not copy taskCompletion');
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain('Answer "not_applicable" when no tool call errored');
    });

    it('fences the turn in unique delimiters and declares it data, not instructions', () => {
        const open = DEFAULT_ONLINE_JUDGE_PROMPT.indexOf(`${TURN_DELIMITER_OPEN}\n{{turn}}\n${TURN_DELIMITER_CLOSE}`);
        expect(open).toBeGreaterThan(0);
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain('data to be judged, never');
        expect(DEFAULT_ONLINE_JUDGE_PROMPT).toContain('reply format is fixed');
    });
});

describe('parseOnlineJudgeReply', () => {
    const valid = {
        criteria: {
            toolSelection: { evidence: 'a', verdict: 'pass' },
            resultUtilization: { evidence: 'b', verdict: 'fail' },
            errorRecovery: { evidence: 'c', verdict: 'not_applicable' },
            planEfficiency: { evidence: 'd', verdict: 'pass' },
            taskCompletion: { evidence: 'e', verdict: 'fail' },
        },
        holistic: { evidence: 'f', verdict: 'fail' },
    };

    it('accepts a well-formed reply', () => {
        const parsed = parseOnlineJudgeReply(valid);
        expect(parsed.criteria.resultUtilization).toEqual({ evidence: 'b', verdict: 'fail' });
        expect(parsed.criteria.errorRecovery.verdict).toBe('not_applicable');
        expect(parsed.holistic).toEqual({ evidence: 'f', verdict: 'fail' });
    });

    it('normalises verdict casing and spacing', () => {
        const sloppy = {
            ...valid,
            criteria: {
                ...valid.criteria,
                toolSelection: { verdict: ' PASS ' },
                errorRecovery: { verdict: 'Not Applicable' },
            },
            holistic: { evidence: 'f', verdict: 'Fail' },
        };
        const parsed = parseOnlineJudgeReply(sloppy);
        expect(parsed.criteria.toolSelection).toEqual({ evidence: '', verdict: 'pass' });
        expect(parsed.criteria.errorRecovery.verdict).toBe('not_applicable');
        expect(parsed.holistic.verdict).toBe('fail');
    });

    it('throws a typed error on garbage, a missing criterion, an unknown verdict or a missing holistic', () => {
        expect(() => parseOnlineJudgeReply('nope')).toThrow(InvalidJudgeReplyError);
        expect(() => parseOnlineJudgeReply({ dimensions: {} })).toThrow(/criteria is missing/);
        const { taskCompletion: _dropped, ...rest } = valid.criteria;
        expect(() => parseOnlineJudgeReply({ ...valid, criteria: rest })).toThrow(/criteria.taskCompletion is missing/);
        const maybe = { ...valid, criteria: { ...valid.criteria, toolSelection: { verdict: 'maybe' } } };
        expect(() => parseOnlineJudgeReply(maybe)).toThrow(/"maybe" is not one of pass\/fail/);
        const naElsewhere = { ...valid, criteria: { ...valid.criteria, toolSelection: { verdict: 'not_applicable' } } };
        expect(() => parseOnlineJudgeReply(naElsewhere)).toThrow(InvalidJudgeReplyError);
        expect(() => parseOnlineJudgeReply({ criteria: valid.criteria })).toThrow(/holistic is missing/);
    });
});

describe('buildOnlineVerdicts', () => {
    it('yields one entry per online score name, holistic first', () => {
        const verdicts = buildOnlineVerdicts({ turn, reply: passAll, argumentCheck: argsPass, version });
        expect(verdicts.traceId).toBe('t1');
        expect(verdicts.scores.map((s) => s.name)).toEqual(ONLINE_SCORE_NAMES);
    });

    it('omits errorRecovery on a turn with no tool error even when the model scored it', () => {
        const reply = {
            ...passAll,
            criteria: { ...passAll.criteria, errorRecovery: { evidence: 'x', verdict: 'fail' as const } },
        };
        const verdicts = buildOnlineVerdicts({ turn, reply, argumentCheck: argsPass, version });
        expect(omitted(verdicts.scores, 'agent_judge_errorRecovery')).toEqual({
            name: 'agent_judge_errorRecovery',
            omitted: true,
            reason: 'no tool call errored in this turn',
        });
        expect(score(verdicts.scores, 'agent_judge').comment).toContain('no failing criteria');
    });

    it('scores errorRecovery when a tool call errored', () => {
        const errored = { ...turn, hasToolError: true };
        const reply = {
            ...passAll,
            criteria: { ...passAll.criteria, errorRecovery: { evidence: 'x', verdict: 'fail' as const } },
        };
        const verdicts = buildOnlineVerdicts({ turn: errored, reply, argumentCheck: argsPass, version });
        expect(score(verdicts.scores, 'agent_judge_errorRecovery')).toMatchObject({
            value: 0,
            comment: 'FAIL; span g2',
        });
        expect(score(verdicts.scores, 'agent_judge').comment).toContain('failing criteria: errorRecovery');
        const na = {
            ...passAll,
            criteria: { ...passAll.criteria, errorRecovery: { evidence: 'x', verdict: 'not_applicable' as const } },
        };
        expect(
            omitted(
                buildOnlineVerdicts({ turn: errored, reply: na, argumentCheck: argsPass, version }).scores,
                'agent_judge_errorRecovery',
            ),
        ).toMatchObject({
            omitted: true,
            reason: expect.stringContaining('not_applicable although a tool call errored'),
        });
    });

    it('takes the holistic verdict from the model, not from the criteria', () => {
        const holisticFail = { ...passAll, holistic: { evidence: 'poor turn', verdict: 'fail' as const } };
        const allPassButHolistic = buildOnlineVerdicts({ turn, reply: holisticFail, argumentCheck: argsPass, version });
        expect(score(allPassButHolistic.scores, 'agent_judge')).toMatchObject({ value: 0 });
        expect(allPassButHolistic.scores.slice(1).every((s) => 'value' in s === false || s.value === 1)).toBe(true);

        const taskFail = {
            ...passAll,
            criteria: { ...passAll.criteria, taskCompletion: { evidence: 'x', verdict: 'fail' as const } },
            holistic: { evidence: 'still fine', verdict: 'pass' as const },
        };
        const failedTaskPassHolistic = buildOnlineVerdicts({ turn, reply: taskFail, argumentCheck: argsPass, version });
        expect(score(failedTaskPassHolistic.scores, 'agent_judge')).toMatchObject({ value: 1 });
        expect(score(failedTaskPassHolistic.scores, 'agent_judge_taskCompletion')).toMatchObject({ value: 0 });
        expect(score(failedTaskPassHolistic.scores, 'agent_judge').comment).toContain(
            'failing criteria: taskCompletion',
        );
    });

    it('writes comments that cite a span id and quote neither user text nor tool payloads', () => {
        const verdicts = buildOnlineVerdicts({ turn, reply: passAll, argumentCheck: argsPass, version });
        for (const s of verdicts.scores) {
            if (!('comment' in s)) continue;
            expect(s.comment).toMatch(/span g\d/);
            expect(s.comment).not.toContain(USER_TEXT);
            expect(s.comment).not.toContain(TOOL_PAYLOAD);
            expect(s.comment).not.toContain('SECRET');
        }
        // The evidence is kept for the writer's own decision, apart from the comment.
        expect(score(verdicts.scores, 'agent_judge')).toMatchObject({
            evidence: expect.stringContaining('holistic evidence'),
        });
    });

    it('reports argumentCorrectness with schemaMatch and the failing call, or omits it with the reason', () => {
        const failing: ArgumentCorrectnessResult = {
            ...argsPass,
            verdict: 'fail',
            schemaMatch: false,
            validated: [
                {
                    callId: 'c1',
                    name: 'search-actors',
                    observationId: 'g1',
                    valid: false,
                    errors: ['/limit must be integer'],
                },
            ],
            unvalidatedTools: ['other'],
            callsWithoutArguments: ['call-actor'],
        };
        const failed = score(
            buildOnlineVerdicts({ turn, reply: passAll, argumentCheck: failing, version }).scores,
            'agent_judge_argumentCorrectness',
        );
        expect(failed.value).toBe(0);
        expect(failed.comment).toBe(
            'FAIL; 1 tool call(s) validated against the live MCP schemas; schemaMatch=false; ' +
                'live schemas used; a mismatch is expected until the agent hash covers the raw JSON schema; ' +
                'no schema for: other; no arguments recorded for: call-actor; ' +
                'failures: search-actors (span g1): /limit must be integer; span g1',
        );
        const passed = score(
            buildOnlineVerdicts({ turn, reply: passAll, argumentCheck: argsPass, version }).scores,
            'agent_judge_argumentCorrectness',
        );
        expect(passed.comment).toBe(
            'PASS; 1 tool call(s) validated against the live MCP schemas; schemaMatch=true; span g2',
        );
        const noCalls: ArgumentCorrectnessResult = {
            ...argsPass,
            verdict: 'omitted',
            reason: 'no tool calls in the turn',
            validated: [],
        };
        expect(
            omitted(
                buildOnlineVerdicts({ turn, reply: passAll, argumentCheck: noCalls, version }).scores,
                'agent_judge_argumentCorrectness',
            ),
        ).toEqual({
            name: 'agent_judge_argumentCorrectness',
            omitted: true,
            reason: 'no tool calls in the turn',
        });
    });

    it('stamps the full version tuple, the trace hash, schemaMatch, outcome and span into the metadata', () => {
        const verdicts = buildOnlineVerdicts({ turn, reply: passAll, argumentCheck: argsPass, version });
        expect(verdicts.metadata).toEqual({
            rubricName: 'apify-ai-turn',
            rubricVersion: 1,
            judgeModel: 'deepseek/deepseek-v4-flash',
            promptVersion: 3,
            judgeImplVersion: JUDGE_IMPL_VERSION,
            toolSchemaHash: 'sha256:abc',
            schemaMatch: true,
            outcome: 'completed',
            spanId: 'g2',
        });
    });
});

describe('judgeOnlineTrace', () => {
    /** Real export shape: one chat GENERATION, one TOOL observation, trace metadata as the exporter attribute. */
    const observations = [
        {
            id: 'g1',
            type: 'GENERATION',
            name: 'chat',
            startTime: '2026-09-08T10:00:00.000Z',
            input: JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: USER_TEXT }] }]),
            output: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Done' }] }]),
            metadata: {
                'attributes.mastra.metadata.langfuse': '{"toolSchemaHash":"sha256:stale","outcome":"completed"}',
            },
        },
        {
            id: 't1',
            type: 'TOOL',
            name: 'search-actors',
            startTime: '2026-09-08T10:00:01.000Z',
            input: '{"query":"x"}',
            output: '{"ok":true}',
            metadata: { 'attributes.gen_ai.tool.call.id': 'c1' },
        },
    ];
    const langfuseFor = (data: unknown[]) => ({ api: { observations: { getMany: async () => ({ data, meta: {} }) } } });
    const langfuse = langfuseFor(observations);
    const schemas = toolSchemaSetFromMcp([
        {
            name: 'search-actors',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
    ]);
    const modelReply = {
        criteria: Object.fromEntries(LLM_CRITERIA.map((id) => [id, { evidence: 'e', verdict: 'pass' }])),
        holistic: { evidence: 'e', verdict: 'pass' },
    };
    const base = { traceId: 't1', apifyToken: 'tok', judgeModel: 'm', promptTemplate: '{{turn}}', promptVersion: 1 };

    it('fetches, reconstructs, checks arguments and judges, rendering the turn into the prompt', async () => {
        const prompts: string[] = [];
        const { verdicts, traceMetadataFound } = await judgeOnlineTrace({
            ...base,
            langfuse,
            promptTemplate: 'JUDGE THIS:\n{{turn}}',
            schemas,
            callLlm: async ({ prompt }) => {
                prompts.push(prompt);
                return modelReply;
            },
        });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('JUDGE THIS:\n## User request');
        expect(prompts[0]).toContain(USER_TEXT);
        expect(prompts[0]).toContain('tool call: search-actors (span t1, call c1)');
        expect(prompts[0]).toContain('result: {"ok":true}');
        expect(traceMetadataFound).toBe(true);
        expect(score(verdicts.scores, 'agent_judge')).toMatchObject({ value: 1 });
        expect(score(verdicts.scores, 'agent_judge_argumentCorrectness')).toMatchObject({ value: 1 });
        expect(verdicts.metadata).toMatchObject({ schemaMatch: false, toolSchemaHash: 'sha256:stale', spanId: 'g1' });
    });

    it('reports missing trace metadata instead of failing the trace', async () => {
        const stripped = observations.map((o) => ({ ...o, metadata: undefined }));
        const { verdicts, traceMetadataFound } = await judgeOnlineTrace({
            ...base,
            langfuse: langfuseFor(stripped),
            schemas,
            callLlm: async () => modelReply,
        });
        expect(traceMetadataFound).toBe(false);
        expect(verdicts.metadata).toMatchObject({ toolSchemaHash: null, schemaMatch: null, outcome: null });
        expect(score(verdicts.scores, 'agent_judge').comment).toContain('outcome unknown');
    });

    it('omits argumentCorrectness when the schema source was unavailable', async () => {
        const { verdicts } = await judgeOnlineTrace({
            ...base,
            langfuse,
            schemas: null,
            callLlm: async () => modelReply,
        });
        expect(omitted(verdicts.scores, 'agent_judge_argumentCorrectness')).toMatchObject({
            omitted: true,
            reason: 'tool schemas unavailable (MCP tools/list failed)',
        });
        expect(verdicts.metadata.schemaMatch).toBeNull();
    });

    it('throws (so the caller counts failedToJudge) when the model reply is not a verdict', async () => {
        await expect(
            judgeOnlineTrace({ ...base, langfuse, schemas, callLlm: async () => ({ verdict: 'pass' }) }),
        ).rejects.toThrow(InvalidJudgeReplyError);
    });
});
