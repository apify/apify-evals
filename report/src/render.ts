/**
 * Self-contained HTML for the suite report, written for a reader who does not
 * know how the eval works: problems first in plain sentences, then the big
 * picture with a trend, then one row per Actor. Machinery is folded away at
 * the bottom. No scripts, no external assets; charts are inline SVG.
 */
import type { Observation, ReportData } from './collect.js';
import type { Aggregate, ObservationGroup, PortfolioRow, SkillCell } from './aggregate.js';

const esc = (s: unknown): string =>
    String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
    );

const CSS = `
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--ok:#1a7f37;--bad:#b42318;--soft:#f5f5f7;--link:#0a58ca}
body{font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:var(--fg);margin:0;padding:28px 36px 60px;max-width:980px}
h1{font-size:24px;margin:0 0 2px}h2{font-size:18px;margin:36px 0 10px}h3{font-size:15px;margin:22px 0 6px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--muted);margin:0 0 18px}.kpis{display:flex;gap:28px;flex-wrap:wrap;margin:14px 0 8px}.kpi .v{font-size:30px;font-weight:650;line-height:1.1}.kpi .l{color:var(--muted);font-size:13px}
.problem{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}.problem .who{font-weight:650}.problem .what{margin:2px 0 4px}.problem .meta{color:var(--muted);font-size:13px}
.problem blockquote{margin:6px 0 0;padding:4px 10px;border-left:3px solid var(--line);color:var(--muted);font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:middle}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.yes{color:var(--ok);font-weight:600}.no{color:var(--bad);font-weight:600}.some{color:#b54708;font-weight:600}.na{color:var(--muted)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}code{font:13px ui-monospace,Menlo,monospace}
details{margin-top:40px;color:var(--muted);font-size:13px}details table{font-size:13px}summary{cursor:pointer;color:var(--fg)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.muted{color:var(--muted)}svg{display:block}
`;

const short = (id: string): string => id.split('/').pop() ?? id;
const nice = (id: string): string =>
    short(id)
        .split('-')
        .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');

/** Plain-language status of one skill over the window. */
function status(c: SkillCell | undefined): { cls: string; text: string } {
    if (!c || c.attempts === 0) return { cls: 'na', text: 'not tested yet' };
    const counted = c.pass + c.fail + c.wrongSubject;
    if (counted === 0) return { cls: 'na', text: 'not measured' };
    if (c.pass === counted) return { cls: 'yes', text: 'Yes' };
    if (c.pass === 0) return { cls: 'no', text: 'No' };
    return { cls: 'some', text: `Sometimes (${c.pass} of ${counted})` };
}

/** One sentence a developer understands, from the judge's fix area and who won. */
function explain(g: ObservationGroup, ours: (id: string) => boolean, findLabel: string): string {
    const name = nice(g.subject);
    if (g.fixArea === 'discoverability') {
        if (g.lostTo.length === 0) return `Agents don't find ${name} when they are not told about it.`;
        const alt = g.lostTo[0];
        return ours(alt)
            ? `Agents don't pick ${name}; they use our own ${nice(alt)} instead. That is a store decision (naming, or which Actor should answer this task), not a bug in your Actor.`
            : `Agents don't pick ${name}; they use a third-party Actor instead (${alt}). Store search ranks it above ours for this task.`;
    }
    const pre =
        g.skill === 'find'
            ? `Agents find ${name} but then fail to use it: `
            : `Agents are told to use ${name} and fail: `;
    switch (g.fixArea) {
        case 'input-schema':
            return pre + 'the input they build is wrong or incomplete.';
        case 'readme-docs':
            return pre + 'they misunderstand what it does or which mode to use, even after reading its details.';
        case 'output-format':
            return pre + 'they get data back but cannot find or use the fields they need.';
        case 'error-messages':
            return pre + 'the run fails with an error the agent cannot act on.';
        case 'agent-or-model':
            return `${name} did its part; the agent itself got the task wrong. Nothing to fix on your side unless this keeps happening.`;
        default:
            return pre + `the ${findLabel.toLowerCase()} check failed.`;
    }
}

function problemCard(g: ObservationGroup, ours: (id: string) => boolean, findLabel: string, totalDays: number): string {
    const when =
        g.days.length === 1
            ? `Seen once, on ${g.lastSeen}.`
            : `Seen on ${g.days.length} of the last ${totalDays} days, last on ${g.lastSeen}.`;
    const quote = g.evidence ? g.evidence.replace(/^(PASS|FAIL):\s*/i, '').replace(/^check \w+:\s*/i, '') : null;
    return `<div class="problem"><div class="who">${esc(nice(g.subject))}</div><div class="what">${esc(explain(g, ours, findLabel))}</div><div class="meta">${esc(when)} <a href="${esc(g.latestUrl)}">Open an example</a></div>${quote ? `<blockquote>${esc(quote.length > 220 ? quote.slice(0, 217) + '…' : quote)}</blockquote>` : ''}</div>`;
}

/** Daily share of passed attempts, per skill, as an SVG line chart. */
function trendSvg(obs: Observation[], skills: Record<string, { label: string }>, days: string[]): string {
    const W = 640;
    const H = 150;
    const L = 36;
    const R = 12;
    const T = 10;
    const B = 26;
    const colors: Record<string, string> = { find: '#0a58ca', use: '#1a7f37' };
    const series = Object.keys(skills).map((skill) => {
        const pts = days.map((d) => {
            const xs = obs.filter(
                (o) =>
                    o.day === d &&
                    o.skill === skill &&
                    (o.verdict === 'pass' || o.verdict === 'fail' || o.verdict === 'wrong-actor'),
            );
            return xs.length ? xs.filter((o) => o.verdict === 'pass').length / xs.length : null;
        });
        return { skill, label: skills[skill].label, pts };
    });
    const x = (i: number) => (days.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (days.length - 1));
    const y = (v: number) => T + (1 - v) * (H - T - B);
    const grid = [0, 0.5, 1]
        .map(
            (v) =>
                `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="#e5e5ea"/><text x="${L - 6}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="#6e6e73">${Math.round(v * 100)}%</text>`,
        )
        .join('');
    const labels = days
        .map((d, i) =>
            days.length <= 10 || i % Math.ceil(days.length / 8) === 0
                ? `<text x="${x(i)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#6e6e73">${d.slice(5)}</text>`
                : '',
        )
        .join('');
    const lines = series
        .map((s) => {
            const d = s.pts
                .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
                .filter(Boolean);
            const dots = s.pts
                .map((v, i) =>
                    v === null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${colors[s.skill] ?? '#333'}"/>`,
                )
                .join('');
            return `${d.length > 1 ? `<polyline fill="none" stroke="${colors[s.skill] ?? '#333'}" stroke-width="2" points="${d.join(' ')}"/>` : ''}${dots}`;
        })
        .join('');
    const legend = series
        .map(
            (s, i) =>
                `<rect x="${L + i * 150}" y="${H - 2}" width="10" height="3" fill="${colors[s.skill] ?? '#333'}"/><text x="${L + i * 150 + 14}" y="${H + 2}" font-size="11" fill="#6e6e73">${esc(s.label)}: share of tasks agents completed</text>`,
        )
        .join('');
    return `<svg viewBox="0 0 ${W} ${H + 8}" width="${W}" height="${H + 8}" role="img" aria-label="Daily share of tasks agents completed">${grid}${labels}${lines}${legend}</svg>`;
}

function actorRow(r: PortfolioRow, skills: string[], days: string[], obs: Observation[]): string {
    const cells = skills.map((s) => {
        const st = status(r.cells[s]);
        const latest = r.cells[s]?.latest;
        return `<td><span class="${st.cls}">${esc(st.text)}</span>${latest ? ` <a href="${esc(latest.traceUrl)}" class="muted">see</a>` : ''}</td>`;
    });
    // Tiny per-Actor trend: daily pass share across both skills.
    const pts = days.map((d) => {
        const xs = obs.filter(
            (o) =>
                o.day === d &&
                o.subject === r.subject &&
                (o.verdict === 'pass' || o.verdict === 'fail' || o.verdict === 'wrong-actor'),
        );
        return xs.length ? xs.filter((o) => o.verdict === 'pass').length / xs.length : null;
    });
    const w = 90;
    const h = 22;
    const xx = (i: number) => (days.length === 1 ? w / 2 : (i * (w - 6)) / (days.length - 1) + 3);
    const yy = (v: number) => 2 + (1 - v) * (h - 4);
    const path = pts.map((v, i) => (v === null ? null : `${xx(i)},${yy(v)}`)).filter(Boolean);
    const spark = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${path.length > 1 ? `<polyline fill="none" stroke="#6e6e73" stroke-width="1.5" points="${path.join(' ')}"/>` : ''}${pts.map((v, i) => (v === null ? '' : `<circle cx="${xx(i)}" cy="${yy(v)}" r="2" fill="${v === 1 ? '#1a7f37' : v === 0 ? '#b42318' : '#b54708'}"/>`)).join('')}</svg>`;
    return `<tr><td>${esc(nice(r.subject))}<br><code class="muted">${esc(r.subject)}</code></td>${cells.join('')}<td>${spark}</td></tr>`;
}

export function renderHtml(data: ReportData, agg: Aggregate): string {
    const skills = data.profile.skills;
    const skillIds = Object.keys(skills);
    const findLabel = skills.find?.label ?? 'Found';
    const useLabel = skills.use?.label ?? 'Works';
    const owners = [...new Set(agg.portfolio.map((r) => r.owner))].sort();
    const ourPrefixes = new Set(data.expected.map((e) => e.subject.split('/')[0].toLowerCase()));
    const ours = (id: string) => ourPrefixes.has(id.split('/')[0].toLowerCase());
    const days = [...new Set(agg.canonical.map((o) => o.day))].sort();
    const totalDays = Math.max(days.length, 1);

    // Big picture: Actors, not attempts.
    const st = (r: PortfolioRow, s: string) => status(r.cells[s]).cls;
    const both = agg.portfolio.filter((r) => st(r, 'find') === 'yes' && st(r, 'use') === 'yes').length;
    const notFound = agg.portfolio.filter((r) => ['no', 'some'].includes(st(r, 'find'))).length;
    const notUsable = agg.portfolio.filter((r) => ['no', 'some'].includes(st(r, 'use'))).length;
    const tested = agg.portfolio.filter((r) => skillIds.some((s) => (r.cells[s]?.attempts ?? 0) > 0)).length;

    // Problems: recurring first, then one-day ones; agent-only failures last.
    const rank = (g: ObservationGroup) => (g.fixArea === 'agent-or-model' ? 1 : 0);
    const problems = [...agg.recurring, ...agg.fresh].sort(
        (a, b) => rank(a) - rank(b) || b.days.length - a.days.length || b.lastSeen.localeCompare(a.lastSeen),
    );
    const byOwner = (owner: string) => problems.filter((g) => g.owner === owner);

    const teamSections = owners
        .map((owner) => {
            const ps = byOwner(owner);
            const rows = agg.portfolio.filter((r) => r.owner === owner);
            const head =
                ps.length === 0
                    ? 'No problems right now.'
                    : `${ps.length} ${ps.length === 1 ? 'problem' : 'problems'} right now`;
            return `<h2 id="${esc(owner)}">${esc(owner[0].toUpperCase() + owner.slice(1))} team <span class="muted" style="font-weight:400">· ${esc(head)}</span></h2>
${ps.map((g) => problemCard(g, ours, findLabel, totalDays)).join('\n')}
<h3>All ${esc(owner)} Actors</h3>
<table><tr><th>Actor</th><th>Agents find it?</th><th>Agents can use it?</th><th>Last ${totalDays} day${totalDays === 1 ? '' : 's'}</th></tr>
${rows.map((r) => actorRow(r, skillIds, days, agg.canonical)).join('\n')}</table>`;
        })
        .join('\n');

    const m = agg.maintainers;
    const li = (xs: Observation[]) =>
        xs.length
            ? `<ul>${xs.map((o) => `<li><code>${esc(o.scenarioId)}</code> ${esc(o.day)} <a href="${esc(o.traceUrl)}">session</a>${o.judgeComment ? ` · ${esc(o.judgeComment.slice(0, 140))}` : ''}</li>`).join('')}</ul>`
            : '<p>None.</p>';
    const discRows = agg.discovery
        .filter((r) => r.lostTo.length || r.none)
        .map(
            (r) =>
                `<tr><td>${esc(nice(r.subject))}</td><td>${r.attempts}</td><td>${r.intended}</td><td>${r.none}</td><td>${r.lostTo.map((l) => `<code>${esc(l.subject)}</code>${l.count > 1 ? ` ×${l.count}` : ''}${l.ours ? ' (ours)' : ''}`).join('<br>')}</td></tr>`,
        )
        .join('');
    const to = data.window.to.slice(0, 10);

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Are our Actors ready for AI agents? · ${esc(to)}</title><style>${CSS}</style></head><body>
<h1>Are our Actors ready for AI agents?</h1>
<p class="sub">Every morning an AI agent is given real user tasks that our Actors should solve. This is what happened over the last ${totalDays} day${totalDays === 1 ? '' : 's'}, up to ${esc(to)}. Teams: ${owners.map((o) => `<a href="#${esc(o)}">${esc(o)}</a>`).join(' · ')}.</p>

<div class="kpis">
<div class="kpi"><div class="v">${both} <span class="muted" style="font-size:16px;font-weight:400">of ${tested}</span></div><div class="l">Actors agents both find and use correctly</div></div>
<div class="kpi"><div class="v bad">${notFound}</div><div class="l">Actors agents fail to find (they pick something else)</div></div>
<div class="kpi"><div class="v bad">${notUsable}</div><div class="l">Actors agents find but fail to use</div></div>
</div>
${trendSvg(agg.canonical, skills, days)}
<p class="sub" style="margin-top:6px">${esc(findLabel)}: the agent is not told which Actor to use and has to pick it. ${esc(useLabel)}: the agent is told the Actor and has to run it correctly. ${days.length < 2 ? 'One day of data so far; the lines fill in from tomorrow.' : ''}</p>

${teamSections}

<details><summary>How this is measured, and details for the eval team</summary>
<p>Each Actor has two tasks a day, run by Claude Haiku 4.5 through the Apify MCP server. A second model reads the whole session and names one thing to fix; hard checks (right Actor used, run succeeded, sane input, expected output fields) run first and win on disagreement. Only the scheduled daily run counts here; ${agg.diagnostics.length} on-demand attempts in the window are excluded. Attempts where our own infrastructure failed are not counted against anyone.</p>
<p><b>Who got the run when agents did not pick ours</b></p>
<table><tr><th>Actor</th><th>Attempts</th><th>Ours</th><th>None</th><th>Ran instead</th></tr>${discRows || '<tr><td colspan="5">Nothing lost.</td></tr>'}</table>
<p><b>Not counted, our infrastructure failed</b> (${m.inconclusive.length})</p>${li(m.inconclusive)}
<p><b>Attempts without a verdict</b> (${m.unjudged.length})</p>${li(m.unjudged)}
<p><b>Judge and hard checks disagreed</b> (${m.disagreements.length})</p>${li(m.disagreements)}
<p>Generated ${esc(data.generatedAt.replace('T', ' ').slice(0, 16))} UTC from Langfuse project <code>${esc(data.projectId ?? '')}</code>, dataset <code>${esc(data.suite)}</code>.</p>
</details>
</body></html>`;
}
