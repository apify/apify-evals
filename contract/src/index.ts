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

export const CONTRACT_VERSION = '1.0.0';

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
        itemActor: { type: 'string' },
        itemTeam: { type: 'string' },
        itemSkill: { type: 'string' },
    },
    required: ['harness', 'model', 'harnessBroke', 'fullLogUrl', 'fullLogHash'],
    additionalProperties: true,
} as const;

/** Deterministic health-gate check declared on a dataset item. */
const checkSchema = {
    type: 'object',
    properties: {
        type: { enum: ['contains', 'regex'] },
        value: { type: 'string' },
    },
    required: ['type', 'value'],
    additionalProperties: false,
} as const;

/** Dataset item `metadata` (the question bank's item anatomy). */
export const datasetItemMetadataSchema = {
    $id: 'dataset-item-metadata',
    type: 'object',
    properties: {
        title: { type: 'string' },
        actor: { type: 'string' },
        team: { type: 'string' },
        skill: { enum: ['actor-discovery', 'actor-usage'] },
        category: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        allowBash: { type: 'boolean' },
        maxTurns: { type: 'integer' },
        checks: { type: 'array', items: checkSchema },
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
