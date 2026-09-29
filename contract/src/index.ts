/**
 * Eval trace contract (ai-team#245).
 *
 * The JSON Schemas below are the canonical contract; the TS types are derived
 * from them and the ajv validators enforce them at both borders: the runner
 * validates on emit, the judge validates on read. Non-TS consumers (e.g. the
 * production Apify AI tracer) implement the same schemas.
 *
 * Versioning: bump CONTRACT_VERSION on any change a reader could observe.
 * Traces without a contractVersion are "pre-contract" (v0); the judge grades
 * them in degraded mode (see judge docs).
 */
import { createHash } from 'node:crypto';

import { Ajv } from 'ajv';
import type { FromSchema } from 'json-schema-to-ts';

export const CONTRACT_VERSION = '1.1.0';

/** Contract-wide hash convention for artifact pointers: the stored bytes are
 * exactly the hashed bytes, so any consumer can verify a fetched record. */
export function sha256(text: string): string {
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** One entry of the judge-ready conversation on the agent span's output. */
const conversationEntrySchema = {
    type: 'object',
    properties: {
        role: { enum: ['assistant', 'user', 'tool'] },
        type: { enum: ['text', 'tool_call', 'tool_result'] },
        text: { type: 'string' },
        tool: { type: 'string' },
        // object when compact; truncated JSON string when it exceeded the cap
        input: {},
        preview: { type: 'string' },
    },
    required: ['role', 'type'],
    additionalProperties: false,
} as const;

/** The agent span's `output` field. */
export const agentSpanOutputSchema = {
    $id: 'agent-span-output',
    type: 'object',
    properties: {
        contractVersion: { type: 'string' },
        conversation: { type: 'array', items: conversationEntrySchema },
        finalResult: { type: 'string' },
    },
    required: ['contractVersion', 'conversation', 'finalResult'],
    additionalProperties: false,
} as const;

/** The agent span's `metadata` field: session metrics plus artifact pointers. */
export const agentSpanMetadataSchema = {
    $id: 'agent-span-metadata',
    type: 'object',
    properties: {
        harness: { type: 'string' },
        model: { type: 'string' },
        exitCode: { type: ['integer', 'null'] },
        subtype: { type: ['string', 'null'] },
        isError: { type: 'boolean' },
        timedOut: { type: 'boolean' },
        stdoutTruncated: { type: 'boolean' },
        durationMs: { type: 'integer' },
        numTurns: { type: ['integer', 'null'] },
        usage: {},
        costUsd: { type: ['number', 'null'] },
        peakChildRssMb: { type: ['integer', 'null'] },
        toolCalls: { type: 'integer' },
        harnessBroke: { type: 'boolean' },
        // Named eval-artifacts KV store pointers (survive platform retention;
        // required for re-judging historical traces, see #242).
        fullLogUrl: { type: 'string' },
        fullLogHash: { type: 'string' },
        toolSchemaSnapshotUrl: { type: 'string' },
        toolSchemaHash: { type: 'string' },
        // Item identity, stamped by the runner so the judge can aggregate
        // per-actor scoreboards without extra dataset lookups.
        itemId: { type: 'string' },
        itemTitle: { type: 'string' },
        itemActor: { type: 'string' },
        itemTeam: { type: 'string' },
        itemSkill: { type: 'string' },
        itemProfile: { type: 'string' },
        itemOwner: { type: 'string' },
        itemSubject: { type: 'string' },
        // Evidence (contract 1.1): the frozen facts the checks ran against.
        evidenceUrl: { type: 'string' },
        evidenceHash: { type: 'string' },
        actorRuns: { type: 'array', items: { type: 'object', additionalProperties: true } },
        actorRunsCostUsd: { type: 'number' },
        toolsUsed: { type: 'array', items: { type: 'string' } },
        checksPassed: { type: 'integer' },
        checksTotal: { type: 'integer' },
        infraOk: { type: 'boolean' },
        infraReasons: { type: 'array', items: { type: 'string' } },
    },
    required: ['harness', 'model', 'harnessBroke', 'fullLogUrl', 'fullLogHash'],
    additionalProperties: true,
} as const;

/**
 * Deterministic check declared on a scenario. `type` picks the checker (see
 * checks.ts); the remaining fields are type-specific and validated there, so
 * new check types do not need a schema change. `id` names the score
 * (`check.<id>`); `severity: warn` never gates the verdict.
 */
export const CHECK_TYPES = [
    // legacy aliases of answer.contains / answer.regex
    'contains',
    'regex',
    // final-answer checks (runner, no I/O)
    'answer.contains',
    'answer.regex',
    'answer.grounded',
    // evidence checks (runner, after evidence extraction)
    'subject.used',
    'apify.run',
    'apify.input',
    'apify.items',
    'tool.called',
    'workspace.file',
    'reference',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

const checkSchema = {
    type: 'object',
    properties: {
        id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,40}$' },
        type: { enum: [...CHECK_TYPES] },
        severity: { enum: ['fail', 'warn'] },
        value: {},
    },
    required: ['type'],
    additionalProperties: true,
} as const;

/** Skills: generic `find` / `use`; the store aliases stay valid. */
export const SKILLS = ['find', 'use', 'actor-discovery', 'actor-usage'] as const;
export type Skill = (typeof SKILLS)[number];

/** Collapse the store aliases onto the generic skills; unknown -> null. */
export function normalizeSkill(skill: unknown): 'find' | 'use' | null {
    if (skill === 'find' || skill === 'actor-discovery') return 'find';
    if (skill === 'use' || skill === 'actor-usage') return 'use';
    return null;
}

/** The thing under test. `kind` comes from the suite profile. */
export const SUBJECT_KINDS = ['actor', 'mcp-tool', 'cli-command', 'sdk-feature', 'agent'] as const;

/** Dataset item `metadata` (the question bank's item anatomy). */
export const datasetItemMetadataSchema = {
    $id: 'dataset-item-metadata',
    type: 'object',
    properties: {
        title: { type: 'string' },
        // Generic identity (any suite): what is under test and who owns it.
        suite: { type: 'string' },
        profile: { type: 'string' },
        subject: {
            type: 'object',
            properties: { kind: { enum: [...SUBJECT_KINDS] }, id: { type: 'string' } },
            required: ['kind', 'id'],
            additionalProperties: false,
        },
        owner: { type: 'string' },
        skill: { enum: [...SKILLS] },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        // Store-suite sugar, kept for the existing items and filters.
        actor: { type: 'string' },
        team: { type: 'string' },
        category: { type: 'string' },
        // Harness setup for this scenario.
        tools: { type: 'array', items: { type: 'string' } },
        allowBash: { type: 'boolean' },
        maxTurns: { type: 'integer' },
        timeoutSecs: { type: 'integer' },
        checks: { type: 'array', items: checkSchema },
        // Fresh ground truth: the runner runs this Actor once per experiment
        // and compares per `compare` entries (see checks.ts).
        reference: {
            type: 'object',
            properties: {
                actor: { type: 'string' },
                input: {},
                maxSecs: { type: 'integer' },
                cacheKey: { type: 'string' },
                compare: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
            required: ['input'],
            additionalProperties: true,
        },
    },
    additionalProperties: true,
} as const;

/** Metadata the judge stamps on every score it writes (idempotency key). */
export const scoreMetadataSchema = {
    $id: 'score-metadata',
    type: 'object',
    properties: {
        rubricVersion: { type: 'string' },
        judgeModel: { type: 'string' },
        promptVersion: { type: ['string', 'integer'] },
        judgeImplVersion: { type: 'string' },
        contractVersion: { type: 'string' },
        datasetRunId: { type: 'string' },
        experimentItemId: { type: 'string' },
        notApplicable: { type: 'array', items: { type: 'string' } },
    },
    required: ['rubricVersion', 'judgeModel', 'promptVersion', 'judgeImplVersion'],
    additionalProperties: true,
} as const;

export type ConversationEntry = FromSchema<typeof conversationEntrySchema>;
export type AgentSpanOutput = FromSchema<typeof agentSpanOutputSchema>;
export type AgentSpanMetadata = FromSchema<typeof agentSpanMetadataSchema>;
export type DatasetItemMetadata = FromSchema<typeof datasetItemMetadataSchema>;
export type DeterministicCheck = FromSchema<typeof checkSchema>;
export type ScoreMetadata = FromSchema<typeof scoreMetadataSchema>;

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
export const validateAgentSpanOutput = ajv.compile<AgentSpanOutput>(agentSpanOutputSchema);
export const validateAgentSpanMetadata = ajv.compile<AgentSpanMetadata>(agentSpanMetadataSchema);
export const validateDatasetItemMetadata = ajv.compile<DatasetItemMetadata>(datasetItemMetadataSchema);
export const validateScoreMetadata = ajv.compile<ScoreMetadata>(scoreMetadataSchema);

/** True when a span output predates the contract (v0): judge uses degraded mode. */
export function isPreContract(output: unknown): boolean {
    return typeof output !== 'object' || output === null || !('contractVersion' in output);
}

export * from './checks.js';
