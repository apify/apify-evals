/**
 * Deterministic check engine.
 *
 * Pure: takes the scenario's checks and an evidence snapshot, returns one
 * result per check. The runner builds the evidence right after a session
 * (tool calls with full inputs, the Actor runs the agent triggered and their
 * dataset items, an optional reference run, workspace files) and persists it,
 * so the judge and any later re-judge see the same facts.
 *
 * Every check yields `value` 1/0 (answer.grounded: 0..1) and a comment that
 * says what mismatched. `applicable: false` means the evidence could not be
 * collected (dataset expired, no runs); such checks are reported, not failed.
 */
import { Ajv } from 'ajv';

import type { DeterministicCheck } from './index.js';

export interface ActorRunEvidence {
    /** `owner/name` as the agent named it (from call-actor input or CLI). */
    actor: string;
    actorId?: string;
    runId: string;
    datasetId?: string;
    status?: string;
    itemCount?: number;
    input?: unknown;
    consoleUrl?: string;
    /** Total platform cost of the run when known (USD). */
    costUsd?: number;
}

export interface ToolCallEvidence {
    tool: string;
    input: unknown;
    isError?: boolean;
}

export interface ReferenceEvidence {
    actor: string;
    input: unknown;
    runId?: string;
    datasetId?: string;
    status?: string;
    items: unknown[];
    error?: string;
}

export interface Evidence {
    prompt: string;
    finalResult: string;
    toolCalls: ToolCallEvidence[];
    actorRuns: ActorRunEvidence[];
    /** datasetId -> items (capped by the collector). Missing id = not fetched. */
    datasets: Record<string, unknown[]>;
    reference?: ReferenceEvidence | null;
    workspaceFiles?: { path: string; content?: string }[];
    session: {
        timedOut: boolean;
        stdoutTruncated: boolean;
        harnessBroke: boolean;
        exitCode: number | null;
        subtype: string | null;
    };
}

export interface CheckResult {
    id: string;
    type: string;
    value: number;
    severity: 'fail' | 'warn';
    applicable: boolean;
    comment: string;
}

type AnyCheck = DeterministicCheck & Record<string, unknown>;

const TERMINAL_BAD = new Set(['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMING-OUT', 'ABORTING']);

/** Infrastructure health of one session: 0 means "do not charge the team". */
export function infraStatus(evidence: Evidence): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (evidence.session.harnessBroke) reasons.push('harness broke');
    if (evidence.session.timedOut) reasons.push('session timed out');
    if (evidence.session.stdoutTruncated) reasons.push('session log truncated');
    for (const r of evidence.actorRuns) {
        if (r.status && TERMINAL_BAD.has(r.status)) reasons.push(`Actor run ${r.runId} (${r.actor}) ${r.status}`);
    }
    if (evidence.reference?.error) reasons.push(`reference run failed: ${evidence.reference.error}`);
    return { ok: reasons.length === 0, reasons };
}

export function runChecks(checks: DeterministicCheck[], evidence: Evidence): CheckResult[] {
    return checks.map((raw, i) => {
        const check = raw as AnyCheck;
        const id = typeof check.id === 'string' && check.id ? check.id : `${check.type.replace(/\W+/g, '_')}_${i + 1}`;
        const severity: 'fail' | 'warn' = check.severity === 'warn' ? 'warn' : 'fail';
        try {
            const r = evaluate(check, evidence);
            return { id, type: check.type, severity, ...r };
        } catch (err) {
            return { id, type: check.type, severity, value: 0, applicable: true, comment: `check error: ${err}` };
        }
    });
}

type Partial = { value: number; applicable: boolean; comment: string };
const pass = (comment: string): Partial => ({ value: 1, applicable: true, comment });
const fail = (comment: string): Partial => ({ value: 0, applicable: true, comment });
const na = (comment: string): Partial => ({ value: 0, applicable: false, comment });

function evaluate(check: AnyCheck, ev: Evidence): Partial {
    switch (check.type) {
        case 'contains':
        case 'answer.contains': {
            const v = String(check.value ?? '');
            return ev.finalResult.toLowerCase().includes(v.toLowerCase())
                ? pass(`answer contains "${v}"`)
                : fail(`answer does not contain "${v}"`);
        }
        case 'regex':
        case 'answer.regex': {
            const v = String(check.value ?? '');
            return new RegExp(v, 'i').test(ev.finalResult) ? pass(`answer matches /${v}/`) : fail(`answer does not match /${v}/`);
        }
        case 'answer.grounded':
            return grounded(check, ev);
        case 'subject.used':
            return subjectUsed(check, ev);
        case 'apify.run':
            return apifyRun(check, ev);
        case 'apify.input':
            return apifyInput(check, ev);
        case 'apify.items':
            return apifyItems(check, ev);
        case 'tool.called':
            return toolCalled(check, ev);
        case 'workspace.file':
            return workspaceFile(check, ev);
        case 'reference':
            return reference(check, ev);
        default:
            return na(`unknown check type "${check.type}"`);
    }
}

// ---------------------------------------------------------------------------
// subject.used: which Actor / tool / command the agent actually used.
// ---------------------------------------------------------------------------

function candidatesUsed(ev: Evidence): string[] {
    const out = new Set<string>();
    for (const r of ev.actorRuns) out.add(r.actor);
    for (const c of ev.toolCalls) {
        out.add(c.tool.replace(/^mcp__[^_]+__/, ''));
        const input = c.input as Record<string, unknown> | undefined;
        if (input && typeof input.actor === 'string') out.add(input.actor);
        if (input && typeof input.command === 'string') out.add(input.command);
    }
    return [...out];
}

function subjectUsed(check: AnyCheck, ev: Evidence): Partial {
    const used = candidatesUsed(ev);
    const wanted = typeof check.value === 'string' ? [check.value] : [];
    const allowOthers = Array.isArray(check.allowOthers) ? (check.allowOthers as string[]) : [];
    const pattern = typeof check.pattern === 'string' ? new RegExp(check.pattern) : null;
    const accepted = (s: string) =>
        wanted.includes(s) || allowOthers.includes(s) || (pattern !== null && pattern.test(s));
    const hits = used.filter(accepted);
    if (hits.length > 0) return pass(`used ${hits.join(', ')}`);
    const actors = ev.actorRuns.map((r) => r.actor);
    const summary = actors.length > 0 ? `used ${[...new Set(actors)].join(', ')}` : 'no Actor run and no matching tool call';
    return fail(`${summary}; expected ${wanted[0] ?? check.pattern}`);
}

// ---------------------------------------------------------------------------
// apify.run / apify.input / apify.items: the agent's Actor runs.
// ---------------------------------------------------------------------------

function runsFor(check: AnyCheck, ev: Evidence): ActorRunEvidence[] {
    const actor = typeof check.actor === 'string' ? check.actor : null;
    return actor ? ev.actorRuns.filter((r) => r.actor === actor) : ev.actorRuns;
}

function apifyRun(check: AnyCheck, ev: Evidence): Partial {
    const runs = runsFor(check, ev);
    const minRuns = typeof check.minRuns === 'number' ? check.minRuns : 1;
    const maxRuns = typeof check.maxRuns === 'number' ? check.maxRuns : Infinity;
    const status = typeof check.status === 'string' ? check.status : 'SUCCEEDED';
    if (runs.length < minRuns) return fail(`${runs.length} Actor run(s), expected at least ${minRuns}`);
    if (runs.length > maxRuns) return fail(`${runs.length} Actor run(s), expected at most ${maxRuns}`);
    const bad = runs.filter((r) => r.status && r.status !== status);
    if (bad.length > 0) return fail(bad.map((r) => `${r.actor} run ${r.runId}: ${r.status}`).join('; '));
    return pass(`${runs.length} run(s) ${status}`);
}

function apifyInput(check: AnyCheck, ev: Evidence): Partial {
    const runs = runsFor(check, ev).filter((r) => r.input !== undefined);
    if (runs.length === 0) return fail('no Actor run with a recorded input');
    const problems: string[] = [];
    for (const r of runs) {
        const input = r.input as Record<string, unknown>;
        if (Array.isArray(check.required)) {
            const missing = (check.required as string[]).filter((p) => getPath(input, p) === undefined);
            if (missing.length > 0) problems.push(`${r.actor}: missing ${missing.join(', ')}`);
        }
        if (typeof check.path === 'string') {
            const actual = getPath(input, check.path);
            const ok = compare(actual, String(check.op ?? 'equals'), check.value);
            if (!ok) problems.push(`${r.actor}: ${check.path} = ${JSON.stringify(actual)} (expected ${check.op ?? 'equals'} ${JSON.stringify(check.value)})`);
        }
    }
    return problems.length === 0
        ? pass(`input ok on ${runs.length} run(s)${typeof check.path === 'string' ? `: ${check.path}` : ''}`)
        : fail(problems.join('; '));
}

function itemsFor(check: AnyCheck, ev: Evidence): { items: unknown[]; missing: string[] } {
    const runs = runsFor(check, ev);
    const items: unknown[] = [];
    const missing: string[] = [];
    for (const r of runs) {
        if (!r.datasetId) continue;
        const got = ev.datasets[r.datasetId];
        if (got) items.push(...got);
        else missing.push(r.datasetId);
    }
    return { items, missing };
}

function apifyItems(check: AnyCheck, ev: Evidence): Partial {
    const runs = runsFor(check, ev);
    if (runs.length === 0) return fail('no Actor run to read items from');
    const { items, missing } = itemsFor(check, ev);
    if (missing.length > 0 && items.length === 0) return na(`dataset(s) ${missing.join(', ')} not available (expired or not fetched)`);
    const problems: string[] = [];
    const count = check.count as { min?: number; max?: number } | undefined;
    if (count) {
        if (typeof count.min === 'number' && items.length < count.min) problems.push(`${items.length} items, expected at least ${count.min}`);
        if (typeof count.max === 'number' && items.length > count.max) problems.push(`${items.length} items, expected at most ${count.max}`);
    }
    if (Array.isArray(check.requiredFields)) {
        for (const f of check.requiredFields as string[]) {
            const bad = items.filter((it) => isEmpty(getPath(it, f))).length;
            if (bad > 0) problems.push(`${bad} of ${items.length} items missing ${f}`);
        }
    }
    if (typeof check.field === 'string' && check.set === undefined) {
        const op = String(check.op ?? 'equals');
        const bad = items.filter((it) => !compare(getPath(it, check.field as string), op, check.value)).length;
        if (bad > 0) problems.push(`${bad} of ${items.length} items fail ${check.field} ${op} ${JSON.stringify(check.value)}`);
    }
    if (typeof check.field === 'string' && check.set && typeof check.set === 'object') {
        const set = check.set as { mode?: string; value?: unknown[] };
        const expected = new Set((set.value ?? []).map(String));
        const actual = new Set(items.map((it) => getPath(it, check.field as string)).filter((v) => v !== undefined).map(String));
        const mode = set.mode ?? 'equals';
        const missingVals = [...expected].filter((v) => !actual.has(v));
        const extra = [...actual].filter((v) => !expected.has(v));
        if (mode === 'equals' && (missingVals.length > 0 || extra.length > 0)) {
            problems.push(`${check.field} set differs: missing ${missingVals.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`);
        } else if (mode === 'superset' && missingVals.length > 0) {
            problems.push(`${check.field} missing expected values: ${missingVals.join(', ')}`);
        } else if (mode === 'intersects' && missingVals.length === expected.size) {
            problems.push(`${check.field} shares no value with the expected set`);
        }
    }
    if (check.jsonSchema && typeof check.jsonSchema === 'object') {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(check.jsonSchema as object);
        const bad = items.filter((it) => !validate(it)).length;
        if (bad > 0) problems.push(`${bad} of ${items.length} items violate the schema`);
    }
    if (problems.length === 0) {
        const note = missing.length > 0 ? ` (${missing.length} dataset(s) unavailable)` : '';
        return pass(`${items.length} items ok${note}`);
    }
    return fail(problems.join('; '));
}

// ---------------------------------------------------------------------------
// answer.grounded: numbers in the answer must exist in what the Actor returned.
// ---------------------------------------------------------------------------

const NUMBER_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*([kKmMbB](?![a-zA-Z]))?/g;

/** Numbers in free text, normalised: "1,234" -> 1234, "39.6M" -> 39600000. */
export function extractNumbers(text: string, minDigits: number): number[] {
    const out: number[] = [];
    for (const m of text.matchAll(NUMBER_RE)) {
        const whole = m[1].replace(/,/g, '');
        const frac = m[2] ?? '';
        const suffix = (m[3] ?? '').toLowerCase();
        let n = Number(`${whole}${frac ? `.${frac}` : ''}`);
        if (suffix === 'k') n *= 1e3;
        else if (suffix === 'm') n *= 1e6;
        else if (suffix === 'b') n *= 1e9;
        if (!Number.isFinite(n)) continue;
        if (String(Math.round(n)).length >= minDigits) out.push(n);
    }
    return out;
}

function flattenNumbers(value: unknown, into: number[], depth = 0): void {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === 'number') into.push(value);
    else if (typeof value === 'string') {
        const n = Number(value.replace(/,/g, ''));
        if (value.trim() !== '' && Number.isFinite(n)) into.push(n);
        else for (const x of extractNumbers(value, 1)) into.push(x);
    } else if (Array.isArray(value)) for (const v of value) flattenNumbers(v, into, depth + 1);
    else if (typeof value === 'object') for (const v of Object.values(value as object)) flattenNumbers(v, into, depth + 1);
}

function grounded(check: AnyCheck, ev: Evidence): Partial {
    const minDigits = typeof check.minDigits === 'number' ? check.minDigits : 4;
    const tolerancePct = typeof check.tolerancePct === 'number' ? check.tolerancePct : 1;
    const minFraction = typeof check.minFraction === 'number' ? check.minFraction : 1;
    const ignoreFromPrompt = check.ignoreFromPrompt !== false;
    const promptNums = new Set(ignoreFromPrompt ? extractNumbers(ev.prompt, 1) : []);
    const answerNums = [...new Set(extractNumbers(ev.finalResult, minDigits))].filter((n) => !promptNums.has(n));
    if (answerNums.length === 0) return pass('no numbers to ground in the answer');
    const pool: number[] = [];
    for (const items of Object.values(ev.datasets)) flattenNumbers(items, pool);
    if (ev.reference?.items) flattenNumbers(ev.reference.items, pool);
    for (const c of ev.toolCalls) flattenNumbers(c.input, pool);
    if (pool.length === 0) return na('no Actor output to ground against');
    const found = answerNums.filter((n) => pool.some((p) => Math.abs(p - n) <= Math.abs(n) * (tolerancePct / 100)));
    const missing = answerNums.filter((n) => !found.includes(n));
    const fraction = found.length / answerNums.length;
    const comment =
        missing.length === 0
            ? `all ${answerNums.length} numbers found in Actor output`
            : `${missing.length} of ${answerNums.length} numbers not in Actor output: ${missing.slice(0, 6).map((n) => n.toLocaleString('en-US')).join(', ')}`;
    return { value: Number(fraction.toFixed(3)), applicable: true, comment: fraction >= minFraction ? comment : `FAIL: ${comment}` };
}

// ---------------------------------------------------------------------------
// tool.called / workspace.file: CLI and SDK suites.
// ---------------------------------------------------------------------------

function toolCalled(check: AnyCheck, ev: Evidence): Partial {
    const nameRe = typeof check.name === 'string' ? new RegExp(`^(mcp__[^_]+__)?${check.name}$`) : null;
    const inputRe = typeof check.inputRegex === 'string' ? new RegExp(check.inputRegex) : null;
    const min = typeof check.min === 'number' ? check.min : 1;
    const hits = ev.toolCalls.filter(
        (c) => (!nameRe || nameRe.test(c.tool)) && (!inputRe || inputRe.test(JSON.stringify(c.input ?? ''))),
    );
    return hits.length >= min
        ? pass(`${hits.length} matching tool call(s)`)
        : fail(`${hits.length} matching tool call(s), expected at least ${min}`);
}

function workspaceFile(check: AnyCheck, ev: Evidence): Partial {
    const files = ev.workspaceFiles ?? [];
    const glob = typeof check.path === 'string' ? check.path : '*';
    const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`);
    const hits = files.filter((f) => re.test(f.path));
    if (hits.length === 0) return fail(`no file matches ${glob}`);
    if (check.jsonSchema && typeof check.jsonSchema === 'object') {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(check.jsonSchema as object);
        for (const f of hits) {
            if (f.content === undefined) return na(`${f.path} content not captured`);
            try {
                if (!validate(JSON.parse(f.content))) return fail(`${f.path} violates the schema: ${ajv.errorsText(validate.errors)}`);
            } catch (err) {
                return fail(`${f.path} is not JSON: ${err}`);
            }
        }
    }
    return pass(`${hits.map((f) => f.path).join(', ')} present`);
}

// ---------------------------------------------------------------------------
// reference: compare against a fresh run made by the eval.
// ---------------------------------------------------------------------------

function reference(check: AnyCheck, ev: Evidence): Partial {
    const ref = ev.reference;
    if (!ref) return na('no reference run configured or collected');
    if (ref.error) return na(`reference run failed: ${ref.error}`);
    const compares = Array.isArray(check.compare) ? (check.compare as Record<string, unknown>[]) : [];
    const problems: string[] = [];
    const notes: string[] = [];
    for (const c of compares) {
        if (typeof c.answerRegex === 'string' && typeof c.field === 'string') {
            const m = ev.finalResult.match(new RegExp(c.answerRegex, 'i'));
            // First defined capture group wins (alternations leave the others undefined).
            const captured = m ? (m.slice(1).find((g) => g !== undefined) ?? m[0]) : undefined;
            const answerVal = captured !== undefined ? Number(String(captured).replace(/,/g, '')) : NaN;
            const item = ref.items[typeof c.itemIndex === 'number' ? c.itemIndex : 0];
            const refVal = Number(getPath(item, c.field));
            const tol = typeof c.tolerance === 'number' ? c.tolerance : 0.02;
            if (!Number.isFinite(answerVal)) problems.push(`answer has no value for /${c.answerRegex}/`);
            else if (!Number.isFinite(refVal)) problems.push(`reference item has no numeric ${c.field}`);
            else if (Math.abs(answerVal - refVal) > Math.abs(refVal) * tol) {
                problems.push(`${c.field}: answer ${answerVal.toLocaleString('en-US')} vs reference ${refVal.toLocaleString('en-US')} (tolerance ${tol * 100}%)`);
            } else notes.push(`${c.field} within ${tol * 100}%`);
        }
        if (c.itemsOverlap && typeof c.itemsOverlap === 'object') {
            const { keyField, min } = c.itemsOverlap as { keyField: string; min?: number };
            const refKeys = new Set(ref.items.map((it) => String(getPath(it, keyField))));
            const subjectItems = Object.values(ev.datasets).flat();
            const subjectKeys = subjectItems.map((it) => String(getPath(it, keyField)));
            const overlap = subjectKeys.filter((k) => refKeys.has(k)).length / Math.max(1, subjectKeys.length);
            if (overlap < (min ?? 0.5)) problems.push(`items overlap ${(overlap * 100).toFixed(0)}% on ${keyField}, expected >= ${(min ?? 0.5) * 100}%`);
            else notes.push(`items overlap ${(overlap * 100).toFixed(0)}%`);
        }
        if (typeof c.countWithinPct === 'number') {
            const subjectCount = Object.values(ev.datasets).flat().length;
            const diff = Math.abs(subjectCount - ref.items.length) / Math.max(1, ref.items.length);
            if (diff * 100 > c.countWithinPct) problems.push(`item count ${subjectCount} vs reference ${ref.items.length}`);
            else notes.push('item count within tolerance');
        }
    }
    return problems.length === 0 ? pass(notes.join('; ') || 'reference matches') : fail(problems.join('; '));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Dot path with [i] indexes: "a.b[0].c". */
export function getPath(value: unknown, path: string): unknown {
    let cur: unknown = value;
    for (const part of path.split('.').flatMap((p) => p.split(/\[(\d+)\]/).filter(Boolean))) {
        if (cur === null || cur === undefined) return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

function isEmpty(v: unknown): boolean {
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function compare(actual: unknown, op: string, expected: unknown): boolean {
    switch (op) {
        case 'equals':
            return JSON.stringify(actual) === JSON.stringify(expected) || String(actual) === String(expected);
        case 'notEquals':
            return !compare(actual, 'equals', expected);
        case 'lte':
            return typeof actual === 'number' && actual <= Number(expected);
        case 'gte':
            return typeof actual === 'number' && actual >= Number(expected);
        case 'in':
            return Array.isArray(expected) && expected.map(String).includes(String(actual));
        case 'regex':
            return actual !== undefined && new RegExp(String(expected)).test(String(actual));
        case 'exists':
            return !isEmpty(actual);
        default:
            throw new Error(`unknown op "${op}"`);
    }
}
