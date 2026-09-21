/** Self-contained HTML for the suite report. No scripts, no external assets. */
import type { ReportData } from './collect.js';
import type { Aggregate, ObservationGroup, PortfolioRow, SkillCell } from './aggregate.js';

const esc = (s: unknown): string =>
    String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
    );
const pct = (n: number, d: number): string => (d === 0 ? '–' : `${n}/${d}`);

const CSS = `
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--ok:#1a7f37;--bad:#b42318;--warn:#b54708;--soft:#f5f5f7;--link:#0a58ca}
body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:var(--fg);margin:0;padding:24px 32px;max-width:1200px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px;padding-top:12px;border-top:1px solid var(--line)}
p.lead{color:var(--muted);margin:0 0 16px}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 4px;border-radius:3px}
.seq{font:12px ui-monospace,Menlo,monospace;letter-spacing:1px}.seq b{color:var(--ok)}.seq s{text-decoration:none;color:var(--bad)}.seq i{font-style:normal;color:var(--muted)}
details{margin:6px 0}summary{cursor:pointer}blockquote{margin:6px 0 0;padding:6px 10px;border-left:3px solid var(--line);color:var(--muted)}
.kpis{display:flex;gap:24px;flex-wrap:wrap;margin:12px 0 4px}.kpi{min-width:140px}.kpi .v{font-size:22px;font-weight:600}.kpi .l{color:var(--muted);font-size:12px}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}.tag{display:inline-block;background:var(--soft);border-radius:10px;padding:0 8px;font-size:12px;margin-right:4px}
`;

function seq(s: string): string {
    return `<span class="seq">${[...s].map((c) => (c === 'P' ? '<b>P</b>' : c === 'F' || c === 'W' ? `<s>${c}</s>` : `<i>${c}</i>`)).join('')}</span>`;
}

function cell(c: SkillCell | undefined): string {
    if (!c || c.attempts === 0) return '<td class="num muted">not measured</td>';
    const bad = c.fail + c.wrongSubject;
    const cls = bad === 0 && c.pass > 0 ? 'ok' : bad > 0 ? 'bad' : 'muted';
    const parts = [`<span class="${cls}">${c.pass} pass</span>`];
    if (c.fail) parts.push(`${c.fail} fail`);
    if (c.wrongSubject) parts.push(`${c.wrongSubject} wrong Actor`);
    if (c.inconclusive) parts.push(`<span class="muted">${c.inconclusive} not counted</span>`);
    if (c.notMeasured) parts.push(`<span class="muted">${c.notMeasured} not measured</span>`);
    const link = c.latest ? ` <a href="${esc(c.latest.traceUrl)}">latest</a>` : '';
    return `<td class="num">${parts.join(' · ')}<br>${seq(c.sequence)}${link}</td>`;
}

function portfolioTable(rows: PortfolioRow[], skills: Record<string, { label: string }>, subjectKind: string): string {
    const skillIds = Object.keys(skills);
    const head = `<tr><th>Team</th><th>${esc(subjectKind === 'actor' ? 'Actor' : 'Subject')}</th>${skillIds.map((s) => `<th>${esc(skills[s].label)}</th>`).join('')}<th>Not run</th></tr>`;
    const body = rows
        .map(
            (r) =>
                `<tr><td>${esc(r.owner)}</td><td><code>${esc(r.subject)}</code></td>${skillIds.map((s) => cell(r.cells[s])).join('')}<td class="muted">${r.missing.length ? r.missing.map(esc).join('<br>') : ''}</td></tr>`,
        )
        .join('');
    return `<table>${head}${body}</table>`;
}

function groupTable(groups: ObservationGroup[], skills: Record<string, { label: string }>): string {
    if (groups.length === 0) return '<p class="muted">Nothing here.</p>';
    return groups
        .map(
            (g) => `<details>
<summary><code>${esc(g.subject)}</code> · ${esc(skills[g.skill]?.label ?? g.skill)} · <span class="tag">${esc(g.fixArea)}</span> ${g.occurrences} of ${g.eligible} attempts on ${g.days.length} day${g.days.length === 1 ? '' : 's'} · ${seq(g.sequence)} · <a href="${esc(g.latestUrl)}">latest session</a></summary>
<div>
<p><b>${esc(g.title)}</b> <span class="muted">(${esc(g.scenarioId)}, ${esc(g.model)})</span><br>
first seen ${esc(g.firstSeen)}, last seen ${esc(g.lastSeen)}${g.failedChecks.length ? ` · failed checks: ${g.failedChecks.map((c) => `<code>${esc(c)}</code>`).join(' ')}` : ''}${g.lostTo.length ? ` · the agent ran instead: ${g.lostTo.map((c) => `<code>${esc(c)}</code>`).join(' ')}` : ''}</p>
${g.evidence ? `<blockquote>${esc(g.evidence)}</blockquote>` : ''}
<p class="muted">Judge's suggestion, not a confirmed diagnosis. Sessions: ${g.urls.map((u, i) => `<a href="${esc(u)}">${i + 1}</a>`).join(' ')}</p>
</div></details>`,
        )
        .join('\n');
}

export function renderHtml(data: ReportData, agg: Aggregate): string {
    const { header } = agg;
    const skills = data.profile.skills;
    const findLabel = skills.find?.label ?? 'Found';
    const kpi = (v: string, l: string) =>
        `<div class="kpi"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`;
    const t = header.totals;
    const conclusive = (t.pass ?? 0) + (t.fail ?? 0) + (t['wrong-actor'] ?? 0);
    const discRows = agg.discovery
        .map(
            (r) =>
                `<tr><td>${esc(r.owner)}</td><td><code>${esc(r.subject)}</code></td><td class="num">${r.attempts}</td><td class="num ok">${r.intended}</td><td class="num">${r.none}</td><td class="num muted">${r.notMeasured}</td><td class="num muted">${r.inconclusive}</td><td>${r.lostTo
                    .map(
                        (l) =>
                            `<code>${esc(l.subject)}</code>${l.count > 1 ? ` ×${l.count}` : ''}${l.ours ? ' <span class="tag">ours</span>' : ''}`,
                    )
                    .join('<br>')}</td></tr>`,
        )
        .join('');
    const maint = agg.maintainers;
    const list = (xs: typeof maint.inconclusive) =>
        xs.length
            ? `<ul>${xs.map((o) => `<li><code>${esc(o.scenarioId)}</code> ${esc(o.day)} <a href="${esc(o.traceUrl)}">session</a>${o.judgeComment ? ` <span class="muted">${esc(o.judgeComment.slice(0, 160))}</span>` : ''}</li>`).join('')}</ul>`
            : '<p class="muted">None.</p>';

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(data.suite)} evals · ${esc(header.window.to.slice(0, 10))}</title><style>${CSS}</style></head><body>
<h1>Agent evals · ${esc(data.suite)}</h1>
<p class="lead">Last ${header.window.days} days (${esc(header.window.from.slice(0, 10))} to ${esc(header.window.to.slice(0, 10))}), generated ${esc(header.generatedAt.replace('T', ' ').slice(0, 16))} UTC. Counts, not percentages; one attempt per scenario per scheduled run. Sequences read left to right, oldest first: <span class="seq"><b>P</b></span> pass, <span class="seq"><s>F</s></span> fail, <span class="seq"><s>W</s></span> wrong Actor, <span class="seq"><i>I</i></span> not counted (our infrastructure).</p>
<div class="kpis">
${kpi(String(header.canonicalRuns), 'scheduled runs in window')}
${header.latestRun ? kpi(`${header.latestRun.judged}/${header.latestRun.expected}`, `scenarios judged on ${header.latestRun.day}`) : ''}
${kpi(pct(t.pass ?? 0, conclusive), 'attempts passed')}
${kpi(String(t.inconclusive ?? 0), 'not counted (infrastructure)')}
${kpi(String(agg.diagnostics.length), 'on-demand attempts, excluded from counts')}
</div>

<h2>Which ${esc(data.profile.subjectKind === 'actor' ? 'Actors' : 'subjects')} agents can find and use</h2>
<p class="lead">${esc(findLabel)}: the agent was not told the Actor and had to pick it in store search. ${esc(skills.use?.label ?? 'Works')}: the Actor was named and the agent had to run it correctly. "Not run" lists expected scenarios that produced no attempt in the window.</p>
${portfolioTable(agg.portfolio, skills, data.profile.subjectKind)}

<h2>Recurring observations (seen on two or more days)</h2>
<p class="lead">Grouped by Actor, scenario, model and the judge's fix area. The quote is the judge's note from the latest occurrence. Open the session for the full timeline.</p>
${groupTable(agg.recurring, skills)}

<h2>New observations (one day so far)</h2>
${groupTable(agg.fresh, skills)}

<h2>Discovery: who got the run</h2>
<p class="lead">Find scenarios only. When the agent did not pick our Actor, this names the Actor it ran instead. "ours" marks an Actor owned by one of our own accounts (a sibling, a store decision) as opposed to a third party (a search ranking question).</p>
<table><tr><th>Team</th><th>Actor</th><th>Attempts</th><th>Ours called</th><th>None called</th><th>Not measured</th><th>Not counted</th><th>Ran instead</th></tr>${discRows}</table>

<h2>For the maintainers</h2>
<p><b>Not counted, our infrastructure failed</b> (${maint.inconclusive.length})</p>${list(maint.inconclusive)}
<p><b>Attempts without a verdict</b> (${maint.unjudged.length})</p>${list(maint.unjudged)}
<p><b>Judge and checks disagreed</b> (${maint.disagreements.length})</p>${list(maint.disagreements)}
</body></html>`;
}
