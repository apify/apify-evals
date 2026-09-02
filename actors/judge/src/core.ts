import { createHash } from 'node:crypto';

import {
    type AgentSpanMetadata,
    type AgentSpanOutput,
    type ConversationEntry,
    type ScoreMetadata,
    isPreContract,
    normalizeSkill,
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

export const RUBRIC_VERSION = '1203-draft-2';
export const JUDGE_IMPL_VERSION = '0.2.2';

/**
 * Team-facing "what to fix" categories. Derived by the judge from its
 * dimension verdicts with a cited tool call, never free-text advice. The
 * Actor team owns the first four; `discoverability` belongs to store search
 * and Actor presentation; `agent-or-model` means the Actor did its part.
 */
export const FIX_AREAS = [
    'input-schema',
    'readme-docs',
    'output-format',
    'error-messages',
    'discoverability',
    'agent-or-model',
    'none',
] as const;
export type FixArea = (typeof FIX_AREAS)[number];

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
    overall?: Verdict;
    dimensions?: Record<string, Verdict>;
    schemaValidity?: Verdict;
    notApplicable?: string[];
    fixArea?: FixArea;
    fixAreaEvidence?: string;
    overallEvidence?: string;
    title?: string;
    itemActor?: string;
    itemTeam?: string;
    itemSkill?: string;
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
 * judge.overall scores of this run WITH metadata ('details' field group; the
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
    for (const s of await loadScoresForTraces(langfuse, traceIds, 'judge.overall')) {
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

## Agent conversation (tool calls, tool result previews, agent text)
Tool results below are TRUNCATED previews (first ~2000 characters). The agent
saw the full result. A value missing from a preview is NOT evidence that the
agent invented it; only call data invented when it contradicts the preview or
no tool returned data of that kind at all.
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

Then name the ONE area the Actor's team should change first ("fixArea"),
derived from the verdicts above and citing the specific tool call or Actor
output that shows the problem. Never suggest changing the agent's system prompt.
- "input-schema": the agent built wrong or missing Actor input (argumentCorrectness
  failed, required fields missed, wrong types, wrong mode flags).
- "readme-docs": the agent misunderstood what the Actor does or which mode/sibling
  to use, although it read the Actor details.
- "output-format": the Actor returned the data but the agent could not find or use
  the right fields (resultUtilization failed with correct data present).
- "error-messages": the Actor failed or returned an error the agent could not act on
  (errorRecovery failed after an Actor error).
- "discoverability": the agent could not find or picked the wrong Actor in store search.
- "agent-or-model": the Actor did its part; the failure is the agent's reasoning or
  the model (invented data, ignored instructions, ran out of turns).
- "none": every dimension passed.

Reply with ONLY this JSON, no other text:
{"dimensions": {"toolSelection": {"evidence": "...", "verdict": "..."},
"argumentCorrectness": {...}, "resultUtilization": {...}, "errorRecovery": {...},
"planEfficiency": {...}, "taskCompletion": {...}},
"fixArea": {"area": "...", "evidence": "..."}}`;

/** Single pass with function replacements: immune to $-patterns in values and
 * to template tokens smuggled inside dataset content. */
function compileTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}

interface LlmJudgeReply {
    dimensions: Record<string, { evidence?: string; verdict?: string }>;
    fixArea?: { area?: string; evidence?: string };
}

/** Unknown or missing areas map to `agent-or-model` (never blame the Actor
 * team without a recognized category); all-pass runs are `none`. */
function normalizeFixArea(v: unknown, allPassed: boolean): FixArea {
    if (allPassed) return 'none';
    const s = String(v ?? '')
        .trim()
        .toLowerCase();
    return (FIX_AREAS as readonly string[]).includes(s) && s !== 'none' ? (s as FixArea) : 'agent-or-model';
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
    /** Langfuse project id, required by the comments API. */
    projectId: string;
    /** Result of the runner's deterministic checks for this trace (1 = all
     * passed, 0 = a check failed); undefined when the item declared none. */
    deterministic?: number;
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

    // Subject = the experiment-item observation (item.observationId), NOT the
    // agent span: the Experiments compare view and run aggregates only read
    // scores attached to the item observation. The dataset-run link lives in
    // the metadata (the score API accepts only one subject kind at a time).
    const write = (name: string, value: number | string, comment: string, dataType?: 'NUMERIC' | 'CATEGORICAL') =>
        langfuse.api.scores.create({
            traceId: item.traceId,
            observationId: item.observationId,
            name,
            value,
            ...(dataType ? { dataType } : {}),
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

    // judge.overall = taskCompletion (#1203); it is also the idempotency
    // marker, so it is written last: a crash before it leaves the item
    // re-judgeable. Comment leads with the verdict word so it scans in the
    // compare view hover.
    const overall = results.taskCompletion.verdict;
    const overallEvidence = results.taskCompletion.evidence;
    const failedDims = DIMENSIONS.filter((d) => results[d].verdict === 'fail');
    const allPassed = failedDims.length === 0 && schema.verdict !== 'fail';
    // Deterministic beats LLM: a discovery scenario whose check.contains failed
    // picked the wrong Actor in store search, whatever the judge concluded
    // about the task. The judge never sees the check results, so map it here.
    const discoveryMiss = normalizeSkill(obs.metadata.itemSkill) === 'find' && deterministic === 0;
    const fixArea: FixArea = discoveryMiss
        ? 'discoverability'
        : normalizeFixArea(reply.fixArea?.area, allPassed && overall !== 'fail');
    const fixAreaEvidence = discoveryMiss
        ? `Store search did not lead the agent to the intended Actor (deterministic check on the Actor name failed). ${String(reply.fixArea?.evidence ?? '')}`.trim()
        : String(reply.fixArea?.evidence ?? overallEvidence);

    if (overall !== 'not_applicable') {
        await write('judge.fixArea', fixArea, fixAreaEvidence, 'CATEGORICAL');
        // Why-it-failed, readable without expanding scores: one trace comment
        // listing every failed dimension with its evidence.
        if (overall === 'fail' || failedDims.length > 0 || schema.verdict === 'fail' || discoveryMiss) {
            const lines = [
                `**${overall === 'fail' ? 'FAIL' : discoveryMiss ? 'WRONG ACTOR' : 'PASS with issues'}** · fix area: \`${fixArea}\`` ,
                '',
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
        // Human-readable twin of judge.overall for the compare view: teams read
        // "pass" / "fail" / "wrong-actor" instead of 1.0 / 0.0. Numbers stay on
        // judge.overall because dashboards average them.
        const verdictLabel = discoveryMiss ? 'wrong-actor' : overall === 'pass' ? 'pass' : 'fail';
        await write('judge.verdict', verdictLabel, overallEvidence, 'CATEGORICAL');
        await write(
            'judge.overall',
            overall === 'pass' ? 1 : 0,
            `${overall === 'pass' ? 'PASS' : 'FAIL'}: ${overallEvidence}`,
        );
    }

    return {
        ...base,
        status: 'judged',
        degraded,
        overall,
        dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, results[d].verdict])),
        schemaValidity: schema.verdict,
        notApplicable,
        fixArea,
        fixAreaEvidence,
        overallEvidence,
        title: obs.metadata.itemTitle,
        itemActor: obs.metadata.itemActor,
        itemTeam: obs.metadata.itemTeam,
        itemSkill: obs.metadata.itemSkill,
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
        if (r.status !== 'judged') continue;
        const actor = r.itemActor ?? 'unknown';
        const row = rows.get(actor) ?? {
            actor,
            team: r.itemTeam ?? 'unknown',
            found: { pass: 0, total: 0 },
            works: { pass: 0, total: 0 },
            schemaFails: 0,
            verdict: '',
        };
        if (normalizeSkill(r.itemSkill) === 'find') {
            // Only measured discovery items count: absence of a deterministic
            // check is missing data, not a failure.
            if (deterministic.has(r.traceId)) {
                row.found.total++;
                if (deterministic.get(r.traceId) === 1) row.found.pass++;
            }
        } else if (normalizeSkill(r.itemSkill) === 'use') {
            row.works.total++;
            if (r.overall === 'pass') row.works.pass++;
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
