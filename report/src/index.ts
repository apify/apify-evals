/**
 * @apify-evals/report: build the suite report from Langfuse.
 *
 *   const { html, json } = await buildReport(langfuse, { suite, days: 7, rootDir, projectId });
 */
import type { LangfuseClient } from '@langfuse/client';

import { aggregate, ownerPrefixesFromExpected, type Aggregate } from './aggregate.js';
import { collectReportData, expectedFromDataset, type ReportData } from './collect.js';
import { loadReportProfile } from './profile.js';
import { renderHtml } from './render.js';
import { renderHtmlV2 } from './render-v2.js';

export * from './aggregate.js';
export * from './collect.js';
export * from './profile.js';
export { renderHtml } from './render.js';
export { renderHtmlV2, buildV2Model } from './render-v2.js';

export interface BuildReportOptions {
    suite: string;
    days?: number;
    /** Repo or image root holding profiles/<suite>.yaml. */
    rootDir: string;
    projectId?: string;
    baseUrl?: string;
    now?: Date;
    /** 'v2' renders the Actor-table page; default is the v1 narrative page. */
    variant?: 'v1' | 'v2';
}

export interface BuiltReport {
    data: ReportData;
    agg: Aggregate;
    html: string;
    json: string;
}

export async function buildReport(langfuse: LangfuseClient, opts: BuildReportOptions): Promise<BuiltReport> {
    const profile = loadReportProfile(opts.rootDir, opts.suite);
    const expected = await expectedFromDataset(langfuse, opts.suite);
    const data = await collectReportData(langfuse, {
        suite: opts.suite,
        days: opts.days ?? 7,
        expected,
        profile,
        projectId: opts.projectId,
        baseUrl: opts.baseUrl,
        now: opts.now,
    });
    const agg = aggregate(data, ownerPrefixesFromExpected(data.expected));
    const html = opts.variant === 'v2' ? renderHtmlV2(data, agg) : renderHtml(data, agg);
    return { data, agg, html, json: JSON.stringify(data, null, 1) };
}
