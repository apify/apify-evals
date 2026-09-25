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
import type { Observation, ReportData } from './collect.js';

const CLIENT_JS = readFileSync(new URL('../assets/client-v2.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../assets/report-v2.css', import.meta.url), 'utf8');

const KEEP_SCORES = new Set([
    'judge.fixArea',
    'judge.disagreement',
    'check.all',
    'check.infra',
    'rubric.taskCompletion',
]);

export interface V2Model {
    suite: string;
    generatedAt: string;
    days: string[];
    excludedAttempts: number;
    latestJsonUrl?: string;
    expected: ReportData['expected'];
    observations: Pick<
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
    >[] &
        { scores?: unknown }[];
}

export function buildV2Model(data: ReportData, agg: Aggregate, latestJsonUrl?: string): V2Model {
    const observations = agg.canonical.map((o) => {
        const scores: Record<string, { value: number | null; comment: string | null }> = {};
        for (const [name, s] of Object.entries(o.scores)) {
            if (KEEP_SCORES.has(name) || o.failedChecks.some((c) => name === `check.${c}`))
                scores[name] = { value: s.value, comment: s.comment };
        }
        return {
            scenarioId: o.scenarioId,
            day: o.day,
            verdict: o.verdict,
            found: o.found,
            infraOk: o.infraOk,
            failedChecks: o.failedChecks,
            fixArea: o.fixArea,
            subjectCalled: o.subjectCalled,
            judgeComment: o.judgeComment,
            traceUrl: o.traceUrl,
            scores,
        };
    });
    return {
        suite: data.suite,
        generatedAt: data.generatedAt,
        days: [...new Set(agg.canonical.map((o) => o.day))].sort(),
        excludedAttempts: agg.diagnostics.length,
        latestJsonUrl,
        expected: data.expected,
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
