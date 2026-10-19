/**
 * Report v2: one page, Actor as the unit of navigation, with trend charts.
 * Scope (team, period) and the open Actor / task / day live in the URL
 * fragment; the same client script (assets/client-v2.js) renders the default
 * view at build time and re-renders in the browser. Data is embedded as a
 * compact model: canonical attempts only, and only the score fields the page
 * shows. Design from the ASTRA-REPORT workshop (25 Sept 2026).
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import type { Aggregate } from './aggregate.js';
import { modelLabel, type Observation, type ReportData } from './collect.js';

const CLIENT_JS = readFileSync(new URL('../assets/client-v2.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../assets/report-v2.css', import.meta.url), 'utf8');

/**
 * Score fields the client reads, and nothing more: the page embeds every
 * canonical observation, so each kept comment is paid for once per attempt.
 * - judge.fixArea: comment (the judge's diagnosis), except the pass / nothing-to-fix boilerplate
 * - judge.disagreement, check.all, rubric.taskCompletion: value only, and only on a disagreement
 * - check.infra: comment only on infrastructure failures
 * - check.<id>: comment for failed checks (the evidence list)
 */
type CompactScore = { value?: number | null; comment?: string | null };

function compactScores(o: Observation): Record<string, CompactScore> {
    const out: Record<string, CompactScore> = {};
    const s = o.scores;
    // The pass-with-nothing-to-fix diagnosis is boilerplate; the page says so without it.
    if (s['judge.fixArea']?.comment && !(o.verdict === 'pass' && (o.fixArea === 'none' || o.fixArea === null)))
        out['judge.fixArea'] = { comment: s['judge.fixArea'].comment };
    // The page reads check.all and the rubric only to explain a disagreement.
    if (s['judge.disagreement']?.value === 1)
        for (const name of ['judge.disagreement', 'check.all', 'rubric.taskCompletion'])
            if (s[name] && s[name].value !== null) out[name] = { value: s[name].value };
    if (s['check.infra'] && o.infraOk === false && s['check.infra'].comment)
        out['check.infra'] = { comment: s['check.infra'].comment };
    for (const c of o.failedChecks) {
        const sc = s[`check.${c}`];
        if (sc) out[`check.${c}`] = { value: sc.value, comment: sc.comment };
    }
    return out;
}

export interface V2ModelSlot {
    /** The configured alias, e.g. `~anthropic/claude-haiku-latest`. */
    id: string;
    label: string;
    /** First day with a canonical attempt; the model counts as expected from here on. */
    firstDay: string;
    /** Resolved model id per day, when the runner recorded one. */
    resolvedByDay: Record<string, string>;
}

export interface V2Model {
    suite: string;
    generatedAt: string;
    days: string[];
    excludedAttempts: number;
    latestJsonUrl?: string;
    /** Common prefix of every traceUrl; the client prepends it. */
    traceBaseUrl: string;
    expected: ReportData['expected'];
    /** Fix areas of the suite profile, for labels and descriptions in the client. */
    fixAreas: ReportData['profile']['fixAreas'];
    /** Model slots present in the data, in first-seen order. */
    models: V2ModelSlot[];
    /** Judge model (resolved id when recorded) per day. */
    judgeByDay: Record<string, string>;
    observations: (Pick<
        Observation,
        | 'scenarioId'
        | 'day'
        | 'verdict'
        | 'found'
        | 'infraOk'
        | 'failedChecks'
        | 'fixArea'
        | 'subjectCalled'
        | 'judgeComment'
        | 'traceUrl'
    > & { model: string; scores: Record<string, CompactScore> })[];
}

/** Longest common prefix ending at a `/`, so links stay valid after the strip. */
export function commonUrlPrefix(urls: string[]): string {
    if (urls.length === 0) return '';
    let prefix = urls[0];
    for (const u of urls) {
        let i = 0;
        while (i < prefix.length && i < u.length && prefix[i] === u[i]) i++;
        prefix = prefix.slice(0, i);
        if (!prefix) return '';
    }
    const cut = prefix.lastIndexOf('/');
    return cut >= 0 ? prefix.slice(0, cut + 1) : '';
}

export function buildV2Model(data: ReportData, agg: Aggregate, latestJsonUrl?: string): V2Model {
    // One canonical result per task and day is the contract every number on
    // the page relies on. Two scheduled full runs on one day would otherwise be
    // merged silently (the client keeps whichever comes last), so refuse to
    // publish rather than present inconsistent totals.
    const seen = new Map<string, string>();
    for (const o of agg.canonical) {
        const key = `${o.scenarioId}|${o.day}|${o.model ?? 'unknown'}`;
        const other = seen.get(key);
        if (other && other !== o.experimentId)
            throw new Error(
                `report v2: two canonical attempts for ${o.scenarioId} on ${o.day} (${o.model ?? 'unknown'}; experiments ${other} and ${o.experimentId}); resolve before publishing`,
            );
        seen.set(key, o.experimentId);
    }
    const traceBaseUrl = commonUrlPrefix(agg.canonical.map((o) => o.traceUrl));
    const slots = new Map<string, V2ModelSlot>();
    const judgeByDay: Record<string, string> = {};
    for (const o of agg.canonical) {
        const id = o.model ?? 'unknown';
        const slot = slots.get(id) ?? {
            id,
            label: modelLabel(id, data.profile.modelLabels),
            firstDay: o.day,
            resolvedByDay: {},
        };
        if (o.day < slot.firstDay) slot.firstDay = o.day;
        if (o.resolvedModel && !slot.resolvedByDay[o.day]) slot.resolvedByDay[o.day] = o.resolvedModel;
        slots.set(id, slot);
        if (o.judgeModel && !judgeByDay[o.day]) judgeByDay[o.day] = o.judgeModel;
    }
    const observations = agg.canonical.map((o) => ({
        scenarioId: o.scenarioId,
        day: o.day,
        model: o.model ?? 'unknown',
        verdict: o.verdict,
        found: o.found,
        infraOk: o.infraOk,
        failedChecks: o.failedChecks,
        fixArea: o.fixArea,
        subjectCalled: o.subjectCalled,
        // A passing result's comment restates the pass; keep it only when it explains a disagreement.
        judgeComment: o.verdict === 'pass' && o.scores['judge.disagreement']?.value !== 1 ? null : o.judgeComment,
        traceUrl: o.traceUrl.startsWith(traceBaseUrl) ? o.traceUrl.slice(traceBaseUrl.length) : o.traceUrl,
        scores: compactScores(o),
    }));
    return {
        suite: data.suite,
        generatedAt: data.generatedAt,
        days: [...new Set(agg.canonical.map((o) => o.day))].sort(),
        excludedAttempts: agg.diagnostics.length,
        latestJsonUrl,
        traceBaseUrl,
        expected: data.expected,
        fixAreas: data.profile.fixAreas,
        models: [...slots.values()].sort((a, b) => a.firstDay.localeCompare(b.firstDay) || a.id.localeCompare(b.id)),
        judgeByDay,
        observations,
    };
}

export function renderHtmlV2(data: ReportData, agg: Aggregate, opts: { latestJsonUrl?: string } = {}): string {
    const model = buildV2Model(data, agg, opts.latestJsonUrl);
    const sandbox: Record<string, unknown> = { module: { exports: {} }, URLSearchParams };
    vm.runInNewContext(CLIENT_JS, sandbox);
    const application = (
        sandbox.module as {
            exports: {
                application: (m: V2Model) => { render: (s: unknown) => string; state: (h?: string) => unknown };
            };
        }
    ).exports.application;
    const app = application(model);
    const initial = app.render(app.state(''));
    const json = JSON.stringify(model).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Can agents find and use our Actors? · ${model.days.at(-1) ?? ''}</title><style>${CSS}</style></head><body><noscript><p style="padding:12px 24px;margin:0;background:#edf3fc">Showing the default view (all teams, 7 days). Team and period filters need JavaScript; charts and expandable evidence work without it.</p></noscript><main id="report">${initial}</main><script type="application/json" id="report-data">${json}</script><script>${CLIENT_JS}\nreportBoot();</script></body></html>`;
}
