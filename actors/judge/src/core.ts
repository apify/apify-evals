import { createHash } from 'node:crypto';

import {
    type AgentSpanMetadata,
    type AgentSpanOutput,
    type CheckResult,
    type ConversationEntry,
    type ScoreMetadata,
    isPreContract,
    normalizeSkill,
    validateAgentSpanOutput,
} from '@apify-evals/contract';
import type { LangfuseClient } from '@langfuse/client';
import { Ajv } from 'ajv';
import { log } from 'apify';

import { conversationFromFullLog, fetchEvidence, renderFacts } from './evidence.js';
import { judgeLlmCall } from './llm.js';
import { fixAreaPromptSection, type JudgeProfile } from './profile.js';
import { mergeVerdict, type MergedVerdict } from './verdict.js';

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

export const RUBRIC_VERSION = '1203-draft-3';
export const JUDGE_IMPL_VERSION = '0.3.0';

/** Fix areas come from the suite profile (see profile.ts); this is the type only. */
export type FixArea = string;

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
    /** The experiment-item observation: scores must attach HERE to show up in
     * the Experiments compare view (the agent span is a child of it). */
    observationId: string;
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
    /** Merged verdict (deterministic checks beat the model). */
    verdict?: MergedVerdict;
    verdictLabel?: string;
    /** Model's raw taskCompletion, kept for disagreement analysis. */
    overall?: Verdict;
    dimensions?: Record<string, Verdict>;
    schemaValidity?: Verdict;
    notApplicable?: string[];
    fixArea?: FixArea;
    fixAreaSource?: 'deterministic' | 'model' | 'none';
    fixAreaEvidence?: string;
    overallEvidence?: string;
    disagreement?: 0 | 1;
    found?: 0 | 1 | null;
    works?: 0 | 1 | null;
    checksPassed?: number;
    checksTotal?: number;
    actorRunsCostUsd?: number;
    title?: string;
    itemActor?: string;
    itemTeam?: string;
    itemSkill?: string;
    itemOwner?: string;
    itemSubject?: string;
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
                observationId: String(it.id),
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
 * judge.verdict scores of this run WITH metadata ('details' field group; the
 * experiments listItems scores omit metadata entirely), and returns the set of
 * traceIds already judged under this exact version tuple.
 */
const TRACE_ID_CHUNK = 50;

interface ScorePage {
    data?: {
        name?: string;
        value?: unknown;
        metadata?: Partial<ScoreMetadata>;
        subject?: { kind?: string; id?: string; traceId?: string };
    }[];
    meta?: { cursor?: string };
}

/** Paginate scores-v3 scoped to the given traces (comma-list filters), in
 * chunks so queries stay bounded no matter how large the project grows. */
async function loadScoresForTraces(
    langfuse: LangfuseClient,
    traceIds: string[],
    names: string | undefined,
): Promise<NonNullable<ScorePage['data']>> {
    const out: NonNullable<ScorePage['data']> = [];
    for (let i = 0; i < traceIds.length; i += TRACE_ID_CHUNK) {
        const chunk = traceIds.slice(i, i + TRACE_ID_CHUNK).join(',');
        let cursor: string | undefined;
        do {
            const page = (await langfuse.api.scoresV3.getManyV3({
                traceId: chunk,
                ...(names ? { name: names } : {}),
                fields: 'details,subject',
                limit: 100,
                cursor,
            })) as unknown as ScorePage;
            out.push(...(page.data ?? []));
            cursor = page.meta?.cursor;
        } while (cursor);
    }
    return out;
}

export async function loadJudgedTraceIds(
    langfuse: LangfuseClient,
    datasetRunId: string,
    version: VersionTuple,
    traceIds: string[],
): Promise<Set<string>> {
    const judged = new Set<string>();
    for (const s of await loadScoresForTraces(langfuse, traceIds, 'judge.verdict')) {
        const traceId = s.subject?.traceId;
        const m = (s.metadata ?? {}) as Partial<ScoreMetadata>;
        if (traceId && m.datasetRunId === datasetRunId && tuplesMatch(m, version)) judged.add(traceId);
    }
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

## Facts (recorded by the harness, verified against the Apify API)
{{facts}}
Treat these facts as ground truth. Deterministic checks listed as FAIL or PASS
are already decided; explain them, do not overrule them.

## Agent conversation (tool calls, tool result previews, agent text)
Tool results below may be truncated previews. The agent saw the full result.
A value missing from a preview is NOT evidence that the agent invented it;
only call data invented when it contradicts the facts or the previews, or no
tool returned data of that kind at all.
{{conversation}}

## Agent final answer
{{finalResult}}

Score these dimensions IN ORDER. For each, first write one sentence of evidence
citing the conversation or the facts, then the verdict: "pass", "fail", or "not_applicable".
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

Then name the ONE area the subject's team should change first ("fixArea"),
derived from the verdicts above and citing the specific tool call or output
that shows the problem. Never suggest changing the agent's system prompt
unless it is listed below.
{{fixAreas}}

Reply with ONLY this JSON, no other text:
{"dimensions": {"toolSelection": {"evidence": "...", "verdict": "..."},
"argumentCorrectness": {...}, "resultUtilization": {...}, "errorRecovery": {...},
"planEfficiency": {...}, "taskCompletion": {...}},
"fixArea": {"area": "...", "evidence": "..."}}`;

/** JSON Schema for the structured reply (response_format). */
export const JUDGE_REPLY_SCHEMA = {
    type: 'object',
    properties: {
        dimensions: {
            type: 'object',
            properties: Object.fromEntries(
                DIMENSIONS.map((d) => [
                    d,
                    {
                        type: 'object',
                        properties: {
                            evidence: { type: 'string' },
                            verdict: { type: 'string', enum: ['pass', 'fail', 'not_applicable'] },
                        },
                        required: ['evidence', 'verdict'],
                    },
                ]),
            ),
            required: [...DIMENSIONS],
        },
        fixArea: {
            type: 'object',
            properties: { area: { type: 'string' }, evidence: { type: 'string' } },
            required: ['area', 'evidence'],
        },
    },
    required: ['dimensions', 'fixArea'],
};

/** Single pass with function replacements: immune to $-patterns in values and
 * to template tokens smuggled inside dataset content. */
function compileTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}

interface LlmJudgeReply {
    dimensions: Record<string, { evidence?: string; verdict?: string }>;
    fixArea?: { area?: string; evidence?: string };
}

/** Case-tolerant; anything unrecognized counts as fail (v1 fail-bias, see design record). */
function normalizeVerdict(v: unknown): Verdict {
    const s = String(v ?? '')
        .trim()
        .toLowerCase();
    return s === 'pass' || s === 'not_applicable' ? (s as Verdict) : 'fail';
}

export interface JudgeCallRecord {
    traceId: string;
    parentObservationId: string;
    startedAt: number;
    endedAt: number;
    model: string;
    input: string;
    output: unknown;
    usage: Record<string, number> | null;
    metadata: Record<string, unknown>;
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
    /** Langfuse project id, required by the comments API. */
    projectId: string;
    /** Runner-side deterministic verdict per trace (legacy fallback when the
     * trace has no evidence artifact): 1 = all checks passed, 0 = one failed. */
    deterministic?: number;
    /** Suite profile: fix-area taxonomy and labels. */
    profile: JudgeProfile;
    /** Records the LLM call as an evaluator observation under the item. */
    recordJudgeCall?: (rec: JudgeCallRecord) => void;
}

/** Deterministic checks in the shape the merge expects when only the legacy
 * runner-side 0/1 exists (traces from before the evidence artifact). */
function legacyChecks(deterministic: number | undefined, skill: 'find' | 'use' | null): CheckResult[] {
    if (deterministic === undefined) return [];
    return [
        {
            id: skill === 'find' ? 'rightActor' : 'answerShape',
            type: skill === 'find' ? 'subject.used' : 'answer.regex',
            value: deterministic,
            passed: deterministic === 1,
            severity: 'fail',
            applicable: true,
            comment: deterministic === 1 ? 'runner check passed' : 'runner check failed (legacy trace, no evidence artifact)',
        },
    ];
}

export async function judgeOne(opts: JudgeOneOptions): Promise<JudgeItemResult> {
    const {
        langfuse,
        item,
        apifyToken,
        judgeModel,
        promptTemplate,
        version,
        datasetRunId,
        judgedTraceIds,
        force,
        projectId,
        deterministic,
        profile,
        recordJudgeCall,
    } = opts;
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
    const finalResult = String(output.finalResult ?? '');
    const skill = normalizeSkill(obs.metadata.itemSkill);
    const intendedSubject = (obs.metadata as { itemSubject?: string }).itemSubject ?? obs.metadata.itemActor ?? null;

    // Frozen facts from the runner (evidence + check results), and the full
    // session log for a conversation with generous previews.
    const artifact = await fetchEvidence(obs.metadata, apifyToken);
    const conversation =
        (await conversationFromFullLog(obs.metadata, apifyToken)) ?? ((output.conversation ?? []) as ConversationEntry[]);
    const checks = artifact ? artifact.checks : legacyChecks(deterministic, skill);
    const infra = artifact?.infra ?? { ok: !obs.metadata.timedOut, reasons: obs.metadata.timedOut ? ['session timed out'] : [] };

    // Schema validity from full tool inputs when we have evidence, else from the span.
    const schemaConversation: ConversationEntry[] = artifact
        ? artifact.evidence.toolCalls.map((c) => ({ role: 'assistant', type: 'tool_call', tool: c.tool, input: c.input }))
        : conversation;
    const schema = degraded && !artifact
        ? { verdict: 'not_applicable' as Verdict, detail: pre ? 'contract_v0_trace' : 'contract_invalid_span' }
        : await schemaValidityCheck(schemaConversation, obs.metadata, apifyToken);

    const facts = renderFacts({ intendedSubject, skill, artifact, session: obs.metadata });
    const prompt = compileTemplate(promptTemplate, {
        input: JSON.stringify(item.input),
        expectedOutput: String(item.expectedOutput ?? '(none provided)'),
        facts,
        conversation: JSON.stringify(conversation),
        finalResult,
        fixAreas: fixAreaPromptSection(profile),
    });
    const call = await judgeLlmCall({ apifyToken, model: judgeModel, prompt, schema: JUDGE_REPLY_SCHEMA });
    const reply = call.json as LlmJudgeReply;

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

    // One verdict: deterministic evidence first, the model second.
    const merged = mergeVerdict({
        llm: {
            taskCompletion: results.taskCompletion.verdict,
            fixArea: typeof reply.fixArea?.area === 'string' ? reply.fixArea.area.trim().toLowerCase() : null,
            anyDimensionFailed: DIMENSIONS.some((d) => results[d].verdict === 'fail'),
        },
        checks,
        infraOk: infra.ok,
        infraReasons: infra.reasons,
        skill,
        profile,
    });
    const overallEvidence = results.taskCompletion.evidence;
    const fixAreaEvidence =
        merged.fixAreaSource === 'deterministic'
            ? merged.reasons.join('; ')
            : String(reply.fixArea?.evidence ?? overallEvidence);

    const scoreMetadata: ScoreMetadata & Record<string, unknown> = {
        ...version,
        contractVersion: pre ? 'none' : invalid ? 'invalid' : String((output as AgentSpanOutput).contractVersion),
        datasetRunId,
        experimentItemId: item.experimentItemId,
        notApplicable,
        verdict: merged.verdict,
        fixAreaSource: merged.fixAreaSource,
        evidence: artifact ? 'artifact' : deterministic !== undefined ? 'legacy-scores' : 'none',
    };

    // Subject = the experiment-item observation (item.observationId), NOT the
    // agent span: the Experiments compare view and run aggregates only read
    // scores attached to the item observation.
    const write = (name: string, value: number | string, comment: string, dataType?: 'NUMERIC' | 'CATEGORICAL') =>
        langfuse.api.scores.create({
            traceId: item.traceId,
            observationId: item.observationId,
            name,
            value,
            ...(dataType ? { dataType } : {}),
            comment: comment.slice(0, 1000),
            metadata: scoreMetadata,
        });

    // Rubric dimensions (maintainer-facing) under rubric.*; deterministic schema validity under check.*.
    for (const dim of DIMENSIONS) {
        const r = results[dim];
        if (r.verdict === 'not_applicable') continue;
        await write(`rubric.${dim}`, r.verdict === 'pass' ? 1 : 0, r.evidence);
    }
    if (schema.verdict !== 'not_applicable') {
        await write('check.schemaValidity', schema.verdict === 'pass' ? 1 : 0, schema.detail);
    }

    // Team-facing scores.
    await write('judge.fixArea', merged.fixArea, fixAreaEvidence, 'CATEGORICAL');
    if (merged.disagreement === 1 || checks.some((c) => c.applicable)) {
        await write('judge.disagreement', merged.disagreement, merged.disagreement ? 'model and deterministic checks disagree' : 'model and checks agree');
    }
    if (merged.found !== null) await write('eval.found', merged.found, merged.found ? 'intended subject used' : 'intended subject not used');
    if (merged.works !== null) await write('eval.works', merged.works, merged.works ? 'usage scenario passed' : 'usage scenario failed');
    if (merged.overall !== null) {
        await write('judge.overall', merged.overall, `${merged.overall ? 'PASS' : 'FAIL'}: ${merged.reasons[0] ?? overallEvidence}`);
    }

    // Why-it-failed, readable without expanding scores.
    if (merged.verdict !== 'pass') {
        const failedDims = DIMENSIONS.filter((d) => results[d].verdict === 'fail');
        const lines = [
            `**${merged.verdictLabel.toUpperCase()}** · fix area: \`${merged.fixArea}\` (${merged.fixAreaSource})`,
            '',
            ...merged.reasons.map((r) => `- ${r}`),
            ...failedDims.map((d) => `- **${d}**: ${results[d].evidence}`),
            ...(schema.verdict === 'fail' ? [`- **schemaValidity**: ${schema.detail}`] : []),
            '',
            `_${fixAreaEvidence}_`,
            '',
            `judge ${version.judgeModel} · prompt v${version.promptVersion} · rubric ${version.rubricVersion}`,
        ];
        try {
            await langfuse.api.comments.create({
                projectId,
                objectType: 'TRACE',
                objectId: item.traceId,
                content: lines.join('\n').slice(0, 4900),
            });
        } catch (err) {
            log.warning(`trace comment failed for ${item.traceId}: ${err}`);
        }
    }

    // The judge's own call, visible in the trace under the experiment item
    // (input = the prompt it saw, output = its structured reply).
    recordJudgeCall?.({
        traceId: item.traceId,
        parentObservationId: item.observationId,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        model: judgeModel,
        input: prompt,
        output: { ...reply, merged: { verdict: merged.verdictLabel, fixArea: merged.fixArea, reasons: merged.reasons } },
        usage: call.usage,
        metadata: { ...version, evidence: scoreMetadata.evidence, checks: checks.length },
    });

    // Written last: the idempotency marker.
    await write('judge.verdict', merged.verdictLabel, merged.reasons[0] ?? overallEvidence, 'CATEGORICAL');

    return {
        ...base,
        status: 'judged',
        degraded,
        verdict: merged.verdict,
        verdictLabel: merged.verdictLabel,
        overall: results.taskCompletion.verdict,
        dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, results[d].verdict])),
        schemaValidity: schema.verdict,
        notApplicable,
        fixArea: merged.fixArea,
        fixAreaSource: merged.fixAreaSource,
        fixAreaEvidence,
        overallEvidence,
        disagreement: merged.disagreement,
        found: merged.found,
        works: merged.works,
        checksPassed: checks.filter((c) => c.applicable && c.passed).length,
        checksTotal: checks.filter((c) => c.applicable).length,
        actorRunsCostUsd: typeof (obs.metadata as { actorRunsCostUsd?: number }).actorRunsCostUsd === 'number' ? (obs.metadata as { actorRunsCostUsd: number }).actorRunsCostUsd : undefined,
        title: obs.metadata.itemTitle,
        itemActor: obs.metadata.itemActor,
        itemTeam: obs.metadata.itemTeam,
        itemSkill: obs.metadata.itemSkill,
        itemOwner: (obs.metadata as { itemOwner?: string }).itemOwner,
        itemSubject: intendedSubject ?? undefined,
    };
}

// ---------------------------------------------------------------------------
// Scoreboard: the team-facing rollup. Two signals per actor answer everything:
// Found (discovery items: did the deterministic check pick the intended
// actor?) and Works (usage items: judge.overall). See the runner README.
// ---------------------------------------------------------------------------

export interface ScoreboardRow {
    actor: string;
    team: string;
    found: { pass: number; total: number };
    works: { pass: number; total: number };
    schemaFails: number;
    verdict: string;
}

/** Deterministic check results (check.contains / check.regex) per trace,
 * written by the runner at run time; fetched once per batch, scoped to the
 * run's traces. A trace with multiple checks passes only if all pass. */
export async function loadDeterministicResults(
    langfuse: LangfuseClient,
    traceIds: string[],
): Promise<Map<string, number>> {
    const byTrace = new Map<string, number>();
    // Runner-side checks are named `check.<id>` (or the legacy per-type names),
    // so fetch every score of the traces and keep the check.* family, minus the
    // judge's own schema validity, which is not a scenario gate.
    for (const s of await loadScoresForTraces(langfuse, traceIds, undefined)) {
        const t = s.subject?.traceId;
        const name = String(s.name ?? '');
        if (!t || !name.startsWith('check.') || name === 'check.schemaValidity') continue;
        byTrace.set(t, Math.min(byTrace.get(t) ?? 1, Number(s.value ?? 0)));
    }
    return byTrace;
}

export function buildScoreboard(results: JudgeItemResult[], deterministic: Map<string, number>): ScoreboardRow[] {
    const rows = new Map<string, ScoreboardRow>();
    for (const r of results) {
        if (r.status !== 'judged' || r.verdict === 'inconclusive') continue;
        const actor = r.itemSubject ?? r.itemActor ?? 'unknown';
        const row = rows.get(actor) ?? {
            actor,
            team: r.itemOwner ?? r.itemTeam ?? 'unknown',
            found: { pass: 0, total: 0 },
            works: { pass: 0, total: 0 },
            schemaFails: 0,
            verdict: '',
        };
        // Found / Works come from the merged verdict (deterministic first).
        if (r.found !== null && r.found !== undefined) {
            row.found.total++;
            if (r.found === 1) row.found.pass++;
        } else if (r.works !== null && r.works !== undefined) {
            row.works.total++;
            if (r.works === 1) row.works.pass++;
        } else if (normalizeSkill(r.itemSkill) === 'find' && deterministic.has(r.traceId)) {
            row.found.total++;
            if (deterministic.get(r.traceId) === 1) row.found.pass++;
        } else if (normalizeSkill(r.itemSkill) === 'use') {
            row.works.total++;
            if (r.verdict === 'pass') row.works.pass++;
        } else {
            log.warning(`scoreboard: item ${r.experimentItemId} has unrecognized skill "${r.itemSkill}"`);
        }
        if (r.schemaValidity === 'fail') row.schemaFails++;
        rows.set(actor, row);
    }
    for (const row of rows.values()) {
        const found = row.found.total === 0 ? null : row.found.pass === row.found.total;
        const works = row.works.total === 0 ? null : row.works.pass === row.works.total;
        row.verdict =
            found && works
                ? 'AI-ready'
                : found === false && works
                  ? 'Invisible: fix discoverability (naming, description, search)'
                  : found && works === false
                    ? 'Unusable: fix the actor (schema, README, output)'
                    : found === false && works === false
                      ? 'Both: discoverability AND usability'
                      : 'Partial coverage';
        if (row.schemaFails > 0) row.verdict += ` | ${row.schemaFails} schema-validity failure(s)`;
    }
    return [...rows.values()].sort((a, b) => a.actor.localeCompare(b.actor));
}

export function renderScoreboard(rows: ScoreboardRow[], datasetRunId: string, skipped: number): string {
    const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const fmt = (x: { pass: number; total: number }) => (x.total === 0 ? '–' : `${x.pass}/${x.total}`);
    const lines = [
        `# Eval scoreboard — dataset run ${esc(datasetRunId)}`,
        '',
        '| Actor | Team | Found | Works | Verdict |',
        '|-------|------|:---:|:---:|---------|',
        ...rows.map(
            (r) => `| ${esc(r.actor)} | ${esc(r.team)} | ${fmt(r.found)} | ${fmt(r.works)} | ${esc(r.verdict)} |`,
        ),
        '',
        '**Found** = discovery scenarios where the agent picked the intended actor unaided.',
        '**Works** = usage scenarios (actor pinned, discovery removed) the judge graded as completed.',
        'Not-found failures belong to store search and actor presentation; not-working failures belong to the actor itself.',
    ];
    if (skipped > 0) {
        lines.push(
            '',
            `NOTE: ${skipped} item(s) were skipped (already judged under this rubric/model/prompt version) and are NOT included above. Re-run with force: true for a complete regenerated scoreboard.`,
        );
    }
    return lines.join('\n');
}
