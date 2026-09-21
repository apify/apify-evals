/**
 * Build the suite report data (and, later, the HTML) for the last N days.
 *
 *   npm run report -- --suite store-actors --days 7 --out /tmp/report.json
 *
 * Needs LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY, and
 * LANGFUSE_PROJECT_ID for deep links into traces.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LangfuseClient } from '@langfuse/client';

import { aggregate, ownerPrefixesFromExpected } from './report/aggregate.js';
import { collectReportData } from './report/collect.js';
import { renderHtml } from './report/render.js';

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const suite = flag('suite', 'store-actors');
const days = Number(flag('days', '7'));
const out = flag('out', `/tmp/eval-report-${suite}.json`);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const k of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
    if (!process.env[k]) throw new Error(`Missing ${k}`);
}
const langfuse = new LangfuseClient();
const data = await collectReportData(langfuse, { rootDir, suite, days, projectId: process.env.LANGFUSE_PROJECT_ID });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 1));
const agg = aggregate(data, ownerPrefixesFromExpected(data.expected));
const html = out.replace(/\.json$/, '') + '.html';
writeFileSync(html, renderHtml(data, agg));
console.log(
    `  portfolio rows ${agg.portfolio.length}, recurring ${agg.recurring.length}, new ${agg.fresh.length}, discovery rows ${agg.discovery.length}; wrote ${html}`,
);

const byVerdict = new Map<string, number>();
for (const o of data.observations) byVerdict.set(o.verdict, (byVerdict.get(o.verdict) ?? 0) + 1);
const measured = new Set(data.observations.map((o) => o.scenarioId));
const unmeasured = data.expected.filter((e) => !measured.has(e.id));
console.log(
    `${suite}: ${data.experiments.length} experiments, ${data.observations.length} observations in the last ${days} days`,
);
console.log(`  verdicts: ${[...byVerdict.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(
    `  expected scenarios: ${data.expected.length}, never observed in window: ${unmeasured.length}${
        unmeasured.length
            ? ` (${unmeasured
                  .map((e) => e.id)
                  .slice(0, 5)
                  .join(', ')}${unmeasured.length > 5 ? ', …' : ''})`
            : ''
    }`,
);
const scheduled = data.experiments.filter((e) => e.trigger === 'schedule' || e.trigger === 'scheduler').length;
console.log(`  scheduled experiments: ${scheduled}, full-scope: ${data.experiments.filter((e) => e.fullScope).length}`);
console.log(`  wrote ${out}`);
