import { createHash } from 'node:crypto';

import {
    type AgentSpanMetadata,
    type AgentSpanOutput,
    type ConversationEntry,
    type ScoreMetadata,
    isPreContract,
    validateAgentSpanOutput,
} from '@apify-evals/contract';
import type { LangfuseClient } from '@langfuse/client';
import { Ajv } from 'ajv';
import { log } from 'apify';

import { judgeLlmCall } from './llm.js';

/**
 * Judge core (ai-team#242): read one eval trace, apply the versioned rubric,
 * write versioned scores back. Never starts the evaluated agent.
 *
 * Rubric = the 6 dimensions from apify-mcp-server#1203 (LLM-judged, one
 * structured call, taskCompletion last) plus the deterministic schema-validity
 * check (`check.schemaValidity`) when the trace carries a tool-schema snapshot.
 * `judge.overall` mirrors `judge.taskCompletion` by design (#1203: overall =
 * taskCompletion); it exists so dashboards have one canonical score name.
 *
 * v1 scope: judges from the span's conversation JSON only; fetching the full
 * log via the span's fullLogUrl pointer is future work. Pre-contract traces
 * (no contractVersion) and contract-invalid spans are judged in degraded
 * mode: conversation-only, schema-validity not_applicable, contractVersion
 * "none"/"invalid" stamped into score metadata.
 */

export const RUBRIC_VERSION = '1203-draft-1';
export const JUDGE_IMPL_VERSION = '0.1.0';

export const DIMENSIONS = [
    'toolSelection',
    'argumentCorrectness',
    'resultUtilization',
    'errorRecovery',
    'planEfficiency',
    'taskCompletion', // judged last on purpose: verdict comes after the evidence dims
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type Verdict = 'pass' | 'fail' | 'not_applicable';

export interface RunItem {
    experimentItemId: string;
    traceId: string;
    input: unknown;
    expectedOutput: unknown;
}

export interface JudgeItemResult {
    experimentItemId: string;
    traceId: string;
    status: 'judged' | 'skipped-already-judged' | 'skipped-no-trace' | 'error';
    error?: string;
    degraded?: boolean;
    overall?: Verdict;
    dimensions?: Record<string, Verdict>;
    schemaValidity?: Verdict;
    notApplicable?: string[];
}

export interface VersionTuple {
    rubricVersion: string;
    judgeModel: string;
    promptVersion: string | number;
    judgeImplVersion: string;
}

/** List all items of one dataset run (experiment). fromStartTime is required
 * by the API; 2000-01-01 keeps historical backfill runs (#242) fully visible.
 * (Not the Unix epoch: ClickHouse rejects DateTime64 value 0.) */
export async function loadRunItems(langfuse: LangfuseClient, datasetRunId: string): Promise<RunItem[]> {
    const items: RunItem[] = [];
    let cursor: string | undefined;
    do {
        const page = await langfuse.api.experiments.listItems({
            experimentId: datasetRunId,
            fields: 'core,io',
            fromStartTime: '2000-01-01T00:00:00Z',
            limit: 50,
            cursor,
        });
        for (const it of (page as unknown as { data?: Record<string, unknown>[] }).data ?? []) {
            items.push({
                experimentItemId: String(it.experimentItemId ?? it.id),
                traceId: String(it.traceId),
                input: it.input,
                expectedOutput: it.expectedOutput,
            });
        }
        cursor = (page as unknown as { meta?: { nextCursor?: string } }).meta?.nextCursor;
    } while (cursor);
    return items;
}

function tuplesMatch(m: Partial<ScoreMetadata>, v: VersionTuple): boolean {
    return (
        m.rubricVersion === v.rubricVersion &&
        m.judgeModel === v.judgeModel &&
        String(m.promptVersion) === String(v.promptVersion) &&
        m.judgeImplVersion === v.judgeImplVersion
    );
}

/**
 * Idempotency (decision 4): one scores-v3 query per batch fetches all existing
 * judge.overall scores of this run WITH metadata ('details' field group; the
 * experiments listItems scores omit metadata entirely), and returns the set of
 * traceIds already judged under this exact version tuple.
 */
export async function loadJudgedTraceIds(
    langfuse: LangfuseClient,
    datasetRunId: string,
    version: VersionTuple,
): Promise<Set<string>> {
    const judged = new Set<string>();
    let cursor: string | undefined;
    do {
        // Filter by name server-side, by datasetRunId client-side via the score
        // metadata we stamp: the native experimentId filter only matches scores
        // created with a dataset-run link, which older writers did not set.
        const page = (await langfuse.api.scoresV3.getManyV3({
            name: 'judge.overall',
            fields: 'details,subject',
            limit: 100,
            cursor,
        } as never)) as unknown as {
            data?: { metadata?: Partial<ScoreMetadata>; subject?: { traceId?: string }; traceId?: string }[];
            meta?: { nextCursor?: string };
        };
        for (const s of page.data ?? []) {
            const traceId = s.subject?.traceId ?? s.traceId;
            const m = (s.metadata ?? {}) as Partial<ScoreMetadata>;
            if (traceId && m.datasetRunId === datasetRunId && tuplesMatch(m, version)) judged.add(traceId);
        }
        cursor = page.meta?.nextCursor;
    } while (cursor);
    return judged;
}

interface AgentObservation {
    id: string;
    output: AgentSpanOutput | Record<string, unknown>;
    metadata: Partial<AgentSpanMetadata>;
}

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return { finalResult: value };
    }
}

/** Fetch the agent span of one trace, retrying briefly while ingestion
 * finishes. The v2 observations API returns io as raw strings; parse here. */
export async function fetchAgentObservation(
    langfuse: LangfuseClient,
    traceId: string,
    attempts = 3,
): Promise<AgentObservation | null> {
    for (let i = 0; i < attempts; i++) {
        const res = (await langfuse.api.observations.getMany({
            traceId,
            name: 'agent',
            fields: 'core,io,metadata',
            limit: 1,
        })) as unknown as { data?: { id: string; output?: unknown; metadata?: unknown }[] };
        const obs = res.data?.[0];
        if (obs?.output) {
            return {
                id: obs.id,
                output: parseMaybeJson(obs.output) as AgentObservation['output'],
                metadata: (parseMaybeJson(obs.metadata) ?? {}) as Partial<AgentSpanMetadata>,
            };
        }
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
}

/** Deterministic check: every compact tool_call input validates against the
 * schema the agent actually saw (from the trace's snapshot artifact). */
export async function schemaValidityCheck(
    conversation: ConversationEntry[],
    metadata: Partial<AgentSpanMetadata>,
    apifyToken: string,
): Promise<{ verdict: Verdict; detail: string }> {
    const { toolSchemaSnapshotUrl, toolSchemaHash } = metadata;
    if (!toolSchemaSnapshotUrl || !toolSchemaHash) return { verdict: 'not_applicable', detail: 'no snapshot on trace' };

    let raw: string;
    try {
        const res = await fetch(toolSchemaSnapshotUrl, {
            headers: { Authorization: `Bearer ${apifyToken}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return { verdict: 'not_applicable', detail: `snapshot fetch failed: HTTP ${res.status}` };
        raw = await res.text();
    } catch (err) {
        return { verdict: 'not_applicable', detail: `snapshot fetch failed: ${err}` };
    }
    const gotHash = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    if (gotHash !== toolSchemaHash) return { verdict: 'not_applicable', detail: 'snapshot hash mismatch' };

    const snapshot = JSON.parse(raw) as { tools: { name: string; inputSchema: unknown }[] };
    const byName = new Map(snapshot.tools.map((t) => [t.name, t.inputSchema]));

    // Fresh ajv per call: MCP schemas may carry $ids that a shared instance
    // would reject on re-registration across items.
    const ajv = new Ajv({ allErrors: true, strict: false });
    let checked = 0;
    const failures: string[] = [];
    for (const entry of conversation) {
        if (entry.type !== 'tool_call' || typeof entry.tool !== 'string') continue;
        const toolName = entry.tool.replace(/^mcp__apify__/, '');
        const schema = byName.get(toolName);
        // Skip non-MCP tools, and inputs that were truncated to strings on the span.
        if (!schema || typeof entry.input === 'string') continue;
        try {
            const validate = ajv.compile(schema as object);
            checked++;
            if (!validate(entry.input)) failures.push(`${toolName}: ${ajv.errorsText(validate.errors)}`);
        } catch (err) {
            log.warning(`schema compile failed for ${toolName}, call not counted: ${err}`);
        }
    }
    if (checked === 0) return { verdict: 'not_applicable', detail: 'no validatable tool calls' };
    return failures.length === 0
        ? { verdict: 'pass', detail: `${checked} tool calls valid` }
        : { verdict: 'fail', detail: failures.join('; ').slice(0, 800) };
}

export const JUDGE_PROMPT_NAME = 'workflow-judge';

/** Seeded into Langfuse prompt management on first run; edited there afterwards (spec D11). */
export const DEFAULT_JUDGE_PROMPT = `You are an evaluation judge for AI agent runs on the Apify platform.
Judge the agent conversation below against the task and the expected outcome.

## Task given to the agent
{{input}}

## What a correct run looks like (reference for you, not a string to match)
{{expectedOutput}}

## Agent conversation (tool calls, tool result previews, agent text)
{{conversation}}

## Agent final answer
{{finalResult}}

Score these dimensions IN ORDER. For each, first write one sentence of evidence
citing the conversation, then the verdict: "pass", "fail", or "not_applicable".
- toolSelection: did the agent choose appropriate tools/actors for the task?
  Use "not_applicable" when the task required no tools.
- argumentCorrectness: were tool inputs well-formed and sensible for the task?
  Use "not_applicable" when no tools were called.
- resultUtilization: did the agent actually use retrieved data (not invent it)?
  Use "not_applicable" when no tools were called.
- errorRecovery: if errors occurred, did the agent handle them reasonably?
  Use "not_applicable" when the conversation contains no errors.
- planEfficiency: was the path reasonably direct (no pointless repetition)?
  Use "not_applicable" for trivial one-call tasks.
- taskCompletion: judged LAST. Did the final answer fulfil the task, grounded
  in retrieved data? An honest report of failure to retrieve data is still a
  "fail" for taskCompletion (the task was not completed), but should not fail
  errorRecovery.

Reply with ONLY this JSON, no other text:
{"dimensions": {"toolSelection": {"evidence": "...", "verdict": "..."},
"argumentCorrectness": {...}, "resultUtilization": {...}, "errorRecovery": {...},
"planEfficiency": {...}, "taskCompletion": {...}}}`;

/** Single pass with function replacements: immune to $-patterns in values and
 * to template tokens smuggled inside dataset content. */
function compileTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}

interface LlmJudgeReply {
    dimensions: Record<string, { evidence?: string; verdict?: string }>;
}

/** Case-tolerant; anything unrecognized counts as fail (v1 fail-bias, see design record). */
function normalizeVerdict(v: unknown): Verdict {
    const s = String(v ?? '')
        .trim()
        .toLowerCase();
    return s === 'pass' || s === 'not_applicable' ? (s as Verdict) : 'fail';
}

export interface JudgeOneOptions {
    langfuse: LangfuseClient;
    item: RunItem;
    apifyToken: string;
    judgeModel: string;
    promptTemplate: string;
    version: VersionTuple;
    datasetRunId: string;
    judgedTraceIds: Set<string>;
    force: boolean;
}

export async function judgeOne(opts: JudgeOneOptions): Promise<JudgeItemResult> {
    const { langfuse, item, apifyToken, judgeModel, promptTemplate, version, datasetRunId, judgedTraceIds, force } =
        opts;
    const base = { experimentItemId: item.experimentItemId, traceId: item.traceId };

    if (!force && judgedTraceIds.has(item.traceId)) return { ...base, status: 'skipped-already-judged' };

    const obs = await fetchAgentObservation(langfuse, item.traceId);
    if (!obs) return { ...base, status: 'skipped-no-trace' };

    // Read-side contract enforcement: invalid contract-versioned spans get
    // degraded treatment, same as pre-contract ones, and are marked as such.
    const pre = isPreContract(obs.output);
    const invalid = !pre && !validateAgentSpanOutput(obs.output);
    const degraded = pre || invalid;
    const output = obs.output as Partial<AgentSpanOutput>;
    const conversation = (output.conversation ?? []) as ConversationEntry[];
    const finalResult = String(output.finalResult ?? '');

    const schema = degraded
        ? { verdict: 'not_applicable' as Verdict, detail: pre ? 'contract_v0_trace' : 'contract_invalid_span' }
        : await schemaValidityCheck(conversation, obs.metadata, apifyToken);

    const prompt = compileTemplate(promptTemplate, {
        input: JSON.stringify(item.input),
        expectedOutput: String(item.expectedOutput ?? '(none provided)'),
        conversation: JSON.stringify(conversation),
        finalResult,
    });
    const reply = (await judgeLlmCall({ apifyToken, model: judgeModel, prompt })) as LlmJudgeReply;

    const results = {} as Record<Dimension, { evidence: string; verdict: Verdict }>;
    for (const dim of DIMENSIONS) {
        const r = reply.dimensions?.[dim];
        results[dim] = {
            evidence: String(r?.evidence ?? 'missing from judge reply'),
            verdict: normalizeVerdict(r?.verdict),
        };
    }

    const notApplicable = DIMENSIONS.filter((d) => results[d].verdict === 'not_applicable').map(String);
    if (schema.verdict === 'not_applicable') notApplicable.push('schemaValidity');

    const scoreMetadata: ScoreMetadata = {
        ...version,
        contractVersion: pre ? 'none' : invalid ? 'invalid' : String((output as AgentSpanOutput).contractVersion),
        datasetRunId,
        experimentItemId: item.experimentItemId,
        notApplicable,
    };

    const write = (name: string, value: number, comment: string) =>
        // Subject = the agent observation. The dataset-run link lives in the
        // metadata (the score API accepts only one subject kind at a time).
        langfuse.api.scores.create({
            traceId: item.traceId,
            observationId: obs.id,
            name,
            value,
            comment: comment.slice(0, 1000),
            metadata: scoreMetadata as Record<string, unknown>,
        });

    for (const dim of DIMENSIONS) {
        const r = results[dim];
        if (r.verdict === 'not_applicable') continue; // excluded from aggregates (decision 7)
        await write(`judge.${dim}`, r.verdict === 'pass' ? 1 : 0, r.evidence);
    }
    // Deterministic family uses the check.* prefix, matching the runner's gates.
    if (schema.verdict !== 'not_applicable') {
        await write('check.schemaValidity', schema.verdict === 'pass' ? 1 : 0, schema.detail);
    }
    // judge.overall = taskCompletion (#1203). Written LAST so a partial write
    // leaves the item re-judgeable. Skipped when taskCompletion is n/a.
    const overall = results.taskCompletion.verdict;
    if (overall !== 'not_applicable') {
        await write('judge.overall', overall === 'pass' ? 1 : 0, results.taskCompletion.evidence);
    }

    return {
        ...base,
        status: 'judged',
        degraded,
        overall,
        dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, results[d].verdict])),
        schemaValidity: schema.verdict,
        notApplicable,
    };
}
