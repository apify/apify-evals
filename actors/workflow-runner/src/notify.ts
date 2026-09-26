/**
 * Slack digest after a run: one message per owner whose subjects were in
 * scope, with the pass rate and its delta against the previous full-scope
 * run on the same model, the scenarios that did not pass (with trace links),
 * the fix-area tally, cost and the results link.
 *
 * Posting needs a webhook: `SLACK_WEBHOOK_URL` (one channel for everyone) or
 * `SLACK_WEBHOOKS_BY_OWNER` (JSON: owner -> webhook, `*` for the rest).
 * Nothing is posted when neither is set.
 */
import { log } from 'apify';

export interface DigestScenario {
    title: string;
    owner: string;
    subject: string;
    verdict: string;
    fixArea: string;
    traceUrl: string | null;
    reason: string;
}

export interface DigestInput {
    suite: string;
    model: string;
    scope: string;
    fullScope: boolean;
    trigger: string;
    resultsUrl: string | null;
    runName: string | null;
    passRate: number | null;
    previousPassRate: number | null;
    judged: number;
    passed: number;
    inconclusive: number;
    disagreements: number;
    actorRunsCostUsd: number | null;
    fixAreas: Record<string, number>;
    scenarios: DigestScenario[];
}

function pct(v: number | null): string {
    return v === null ? 'n/a' : `${Math.round(v * 100)}%`;
}

export function renderDigest(d: DigestInput, owner: string | null): string {
    const scenarios = owner ? d.scenarios.filter((s) => s.owner === owner) : d.scenarios;
    const failing = scenarios.filter((s) => s.verdict !== 'pass' && s.verdict !== 'inconclusive');
    const inconclusive = scenarios.filter((s) => s.verdict === 'inconclusive');
    const ownerPassed = scenarios.filter((s) => s.verdict === 'pass').length;
    const ownerConclusive = scenarios.length - inconclusive.length;
    const head = owner
        ? `*${owner}* · ${ownerPassed}/${ownerConclusive} scenarios pass`
        : `*${d.suite}* · ${d.passed}/${d.judged - d.inconclusive} scenarios pass`;
    const delta =
        !owner && d.passRate !== null && d.previousPassRate !== null
            ? ` (${d.passRate >= d.previousPassRate ? '+' : ''}${Math.round((d.passRate - d.previousPassRate) * 100)} pts vs previous run)`
            : '';
    const lines = [`${head}${delta} · ${d.model}${d.fullScope ? '' : ` · scope ${d.scope}`}`];
    if (failing.length > 0) {
        lines.push('*Not passing:*');
        for (const s of failing.slice(0, 12)) {
            const link = s.traceUrl ? `<${s.traceUrl}|trace>` : '';
            lines.push(`• ${s.title} — \`${s.verdict}\`, fix area \`${s.fixArea}\` ${link}\n    ${s.reason.slice(0, 180)}`);
        }
        if (failing.length > 12) lines.push(`• …and ${failing.length - 12} more`);
    } else if (scenarios.length > 0) {
        lines.push('All scenarios passed.');
    }
    if (inconclusive.length > 0) lines.push(`_${inconclusive.length} inconclusive (infrastructure), not counted._`);
    const areas = Object.entries(d.fixAreas).filter(([k]) => k !== 'none');
    if (!owner && areas.length > 0) lines.push(`Fix areas: ${areas.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (!owner && d.disagreements > 0) lines.push(`_${d.disagreements} judge/check disagreement(s)._`);
    if (!owner && d.actorRunsCostUsd !== null) lines.push(`Actor compute this run: $${d.actorRunsCostUsd.toFixed(2)}`);
    if (d.resultsUrl) lines.push(`<${d.resultsUrl}|Results in Langfuse>`);
    return lines.join('\n');
}

export async function postDigest(d: DigestInput): Promise<number> {
    const single = process.env.SLACK_WEBHOOK_URL;
    let byOwner: Record<string, string> = {};
    if (process.env.SLACK_WEBHOOKS_BY_OWNER) {
        try {
            byOwner = JSON.parse(process.env.SLACK_WEBHOOKS_BY_OWNER) as Record<string, string>;
        } catch (err) {
            log.warning(`SLACK_WEBHOOKS_BY_OWNER is not JSON: ${err}`);
        }
    }
    if (!single && Object.keys(byOwner).length === 0) return 0;

    const owners = [...new Set(d.scenarios.map((s) => s.owner).filter(Boolean))];
    const posts: { url: string; text: string }[] = [];
    if (single) posts.push({ url: single, text: renderDigest(d, null) });
    for (const owner of owners) {
        const url = byOwner[owner] ?? byOwner['*'];
        if (url && url !== single) posts.push({ url, text: renderDigest(d, owner) });
    }
    let sent = 0;
    for (const p of posts) {
        try {
            const res = await fetch(p.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: p.text }),
                signal: AbortSignal.timeout(15_000),
            });
            if (res.ok) sent++;
            else log.warning(`Slack webhook HTTP ${res.status}`);
        } catch (err) {
            log.warning(`Slack post failed: ${err}`);
        }
    }
    return sent;
}
