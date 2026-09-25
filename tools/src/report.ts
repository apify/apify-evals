/**
 * Build the suite report for the last N days, the same way the judge does
 * after every full run.
 *
 *   npm run report -w tools -- --suite store-actors --days 7 --out /tmp/report.json
 *
 * Needs LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY, and
 * LANGFUSE_PROJECT_ID for deep links into traces. Writes <out> and the HTML
 * twin next to it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReport } from '@apify-evals/report';
import { LangfuseClient } from '@langfuse/client';

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const suite = flag('suite', 'store-actors');
const days = Number(flag('days', '7'));
const out = flag('out', `/tmp/eval-report-${suite}.json`);
const variant = args.includes('--v2') ? 'v2' : 'v1';
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const k of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
    if (!process.env[k]) throw new Error(`Missing ${k}`);
}
const langfuse = new LangfuseClient();
const { data, agg, html, json } = await buildReport(langfuse, {
    suite,
    days,
    rootDir,
    projectId: process.env.LANGFUSE_PROJECT_ID,
    variant,
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, json);
const htmlPath = out.replace(/\.json$/, '') + '.html';
writeFileSync(htmlPath, html);

const byVerdict = new Map<string, number>();
for (const o of data.observations) byVerdict.set(o.verdict, (byVerdict.get(o.verdict) ?? 0) + 1);
console.log(
    `${suite}: ${data.experiments.length} experiments, ${data.observations.length} observations in the last ${days} days`,
);
console.log(`  verdicts: ${[...byVerdict.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(
    `  expected scenarios: ${data.expected.length}; canonical attempts ${agg.canonical.length}, on-demand ${agg.diagnostics.length}`,
);
console.log(`  recurring ${agg.recurring.length}, new ${agg.fresh.length}; wrote ${out} and ${htmlPath}`);
