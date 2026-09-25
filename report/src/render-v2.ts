/**
 * Report v2: one page, Actor as the unit of navigation. A short factual
 * answer for the selected scope, an Actor table with counts (not words) that
 * expands in place into dated attempts and evidence, and diagnostics folded
 * away. Team / period / expanded Actor live in the URL fragment. The same
 * client script renders the default view at build time (so the page reads
 * without JavaScript) and re-renders in the browser on interaction.
 */
import vm from 'node:vm';

import type { Aggregate } from './aggregate.js';
import type { Observation, ReportData } from './collect.js';

export interface V2Attempt {
    day: string;
    /** P pass, F fail, W other Actor used, I not counted (our infrastructure), U no verdict */
    v: 'P' | 'F' | 'W' | 'I' | 'U';
    /** Discovery selection: 1 ours, 0 not ours, null not measured / n.a. */
    sel: 0 | 1 | null;
    ran: string | null;
    checks: string[];
    fix: string | null;
    note: string | null;
    url: string;
}

export interface V2Task {
    id: string;
    skill: string;
    title: string;
    prompt: string;
    attempts: V2Attempt[];
}

export interface V2Actor {
    subject: string;
    owner: string;
    tasks: V2Task[];
}

export interface V2Model {
    suite: string;
    generatedAt: string;
    latestDay: string | null;
    days: string[];
    expectedTasks: number;
    latest: { judged: number; excluded: number; missing: number } | null;
    teams: string[];
    ours: string[];
    skillLabels: Record<string, string>;
    actors: V2Actor[];
    excluded: { experiment: string; day: string; attempts: number; reason: string }[];
    disagreements: { subject: string; task: string; day: string; url: string; note: string | null }[];
}

const LETTER: Record<Observation['verdict'], V2Attempt['v']> = {
    pass: 'P',
    fail: 'F',
    'wrong-actor': 'W',
    inconclusive: 'I',
    unjudged: 'U',
};

export function buildV2Model(data: ReportData, agg: Aggregate): V2Model {
    const byScenario = new Map<string, Observation[]>();
    for (const o of agg.canonical) {
        const list = byScenario.get(o.scenarioId) ?? [];
        list.push(o);
        byScenario.set(o.scenarioId, list);
    }
    const days = [...new Set(agg.canonical.map((o) => o.day))].sort();
    const latestDay = days.at(-1) ?? null;
    const actors = new Map<string, V2Actor>();
    for (const e of data.expected) {
        const actor = actors.get(e.subject) ?? { subject: e.subject, owner: e.owner, tasks: [] };
        const attempts: V2Attempt[] = (byScenario.get(e.id) ?? [])
            .sort((a, b) => b.startTime.localeCompare(a.startTime))
            .map((o) => ({
                day: o.day,
                v: LETTER[o.verdict],
                sel: e.skill === 'find' ? o.found : null,
                ran: o.subjectCalled && o.subjectCalled !== 'intended' ? o.subjectCalled : null,
                checks: o.failedChecks,
                fix: o.fixArea,
                note: o.judgeComment ? o.judgeComment.replace(/^(PASS|FAIL):\s*/i, '').slice(0, 400) : null,
                url: o.traceUrl,
            }));
        actor.tasks.push({ id: e.id, skill: e.skill, title: e.title, prompt: e.prompt ?? '', attempts });
        actors.set(e.subject, actor);
    }
    for (const a of actors.values())
        a.tasks.sort((x, y) => (x.skill === y.skill ? x.id.localeCompare(y.id) : x.skill === 'find' ? -1 : 1));

    const latestObs = latestDay ? agg.canonical.filter((o) => o.day === latestDay) : [];
    const latest = latestDay
        ? {
              judged: latestObs.filter((o) => o.verdict !== 'unjudged' && o.verdict !== 'inconclusive').length,
              excluded: latestObs.filter((o) => o.verdict === 'inconclusive').length,
              missing: data.expected.length - latestObs.length,
          }
        : null;

    // Excluded attempts, grouped by experiment.
    const exc = new Map<string, { experiment: string; day: string; attempts: number; reason: string }>();
    for (const o of agg.diagnostics) {
        const key = o.experimentId;
        const cur = exc.get(key) ?? {
            experiment: o.experimentName,
            day: o.day,
            attempts: 0,
            reason:
                o.fullScope !== true
                    ? 'filtered team run (not full scope)'
                    : (o.repeats ?? 1) > 1
                      ? 'repeat diagnostic'
                      : 'extra full run on a day that already has a scheduled one',
        };
        cur.attempts++;
        exc.set(key, cur);
    }
    const ourAccounts = [...new Set(data.expected.map((e) => e.subject.split('/')[0].toLowerCase()))];

    return {
        suite: data.suite,
        generatedAt: data.generatedAt,
        latestDay,
        days,
        expectedTasks: data.expected.length,
        latest,
        teams: [...new Set(data.expected.map((e) => e.owner))].sort(),
        ours: ourAccounts,
        skillLabels: Object.fromEntries(Object.entries(data.profile.skills).map(([k, v]) => [k, v.label])),
        actors: [...actors.values()].sort(
            (a, b) => a.owner.localeCompare(b.owner) || a.subject.localeCompare(b.subject),
        ),
        excluded: [...exc.values()].sort((a, b) => a.day.localeCompare(b.day)),
        disagreements: agg.maintainers.disagreements.map((o) => ({
            subject: o.subject ?? '',
            task: o.scenarioId,
            day: o.day,
            url: o.traceUrl,
            note: o.judgeComment,
        })),
    };
}

/* The client script. No backticks or template literals inside: it is embedded in one. */
const CLIENT_JS = String.raw`
(function (root) {
  var SYM = { P: '✓', F: '✕', W: '↷', I: '◌', U: '?' };
  var WORD = { P: 'passed', F: 'failed', W: 'used another Actor', I: 'not counted (our infrastructure)', U: 'no verdict' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nice(id) { var s = id.split('/').pop() || id; return s.split('-').map(function (w) { return w ? w[0].toUpperCase() + w.slice(1) : w; }).join(' '); }
  function daysInRange(model, range) { var d = model.days.slice(); return range >= d.length ? d : d.slice(d.length - range); }
  function inRange(att, days) { return days.indexOf(att.day) >= 0; }
  function counts(task, days) {
    var a = task.attempts.filter(function (x) { return inRange(x, days); });
    var concl = a.filter(function (x) { return x.v === 'P' || x.v === 'F' || x.v === 'W'; });
    var latest = a.length ? a[0] : null;
    var sel = task.skill === 'find' ? a.filter(function (x) { return x.sel === 0 || x.sel === 1; }) : [];
    return { attempts: a, concl: concl.length, pass: concl.filter(function (x) { return x.v === 'P'; }).length, latest: latest, selN: sel.length, selYes: sel.filter(function (x) { return x.sel === 1; }).length };
  }
  function status(model, actor, days) {
    var latestDay = days[days.length - 1];
    var failing = false, current = false;
    actor.tasks.forEach(function (t) { var c = counts(t, days); if (c.latest && c.latest.day === latestDay) { current = true; if (c.latest.v === 'F' || c.latest.v === 'W') failing = true; } });
    return failing ? 0 : current ? 2 : 1; // 0 failing latest, 1 no current result, 2 passing
  }
  function cellRow(task, days) {
    return '<div class="hist">' + days.map(function (d) {
      var att = null; for (var i = 0; i < task.attempts.length; i++) if (task.attempts[i].day === d) { att = task.attempts[i]; break; }
      if (!att) return '<span class="c none" title="' + esc(d) + ': no result">·</span>';
      return '<a class="c v' + att.v + '" href="' + esc(att.url) + '" title="' + esc(d + ': ' + WORD[att.v] + (att.ran ? ' (' + att.ran + ')' : '')) + '">' + SYM[att.v] + '</a>';
    }).join('') + '</div>';
  }
  function countCell(c, latestDay, what) {
    if (!c.latest) return '<td class="num muted">not tested in period</td>';
    var stale = c.latest.day !== latestDay ? ' <span class="muted">(last ' + esc(c.latest.day.slice(5)) + ')</span>' : '';
    if (what === 'sel') { if (c.selN === 0) return '<td class="num muted">not measured</td>'; var last = c.latest.sel; var cls = last === 1 ? 'ok' : last === 0 ? 'bad' : 'muted'; return '<td class="num"><span class="' + cls + '">' + (last === 1 ? 'ours' : last === 0 ? 'other' : 'n/a') + '</span>' + stale + '<br><span class="muted">' + c.selYes + ' of ' + c.selN + ' picked ours</span></td>'; }
    var cls2 = c.latest.v === 'P' ? 'ok' : (c.latest.v === 'F' || c.latest.v === 'W') ? 'bad' : 'muted';
    return '<td class="num"><span class="' + cls2 + '">' + esc(WORD[c.latest.v]) + '</span>' + stale + '<br><span class="muted">' + c.pass + ' of ' + c.concl + ' completed</span></td>';
  }
  function finding(actor, days) {
    var best = null;
    actor.tasks.forEach(function (t) { var c = counts(t, days); if (c.latest && (c.latest.v === 'F' || c.latest.v === 'W') && (!best || c.latest.day > best.day)) best = { day: c.latest.day, att: c.latest, task: t }; });
    if (!best) return '<td class="muted">—</td>';
    var a = best.att; var bits = [];
    if (a.v === 'W' && a.ran) bits.push('the agent ran <code>' + esc(a.ran) + '</code> instead');
    if (a.checks.length) bits.push('failed checks: ' + a.checks.map(function (c) { return '<code>' + esc(c) + '</code>'; }).join(' '));
    var note = a.note ? '<div class="note">' + esc(a.note.length > 180 ? a.note.slice(0, 177) + '…' : a.note) + '</div>' : '';
    return '<td><div>' + esc(best.task.skill === 'find' ? 'Discovery task' : 'Named task') + ' ' + esc(WORD[a.v]) + ' on ' + esc(best.day.slice(5)) + (bits.length ? ': ' + bits.join('; ') : '') + '</div>' + note + (a.fix ? '<span class="tag">' + esc(a.fix) + '</span>' : '') + '</td>';
  }
  function detail(model, actor, days) {
    return '<tr class="detail"><td colspan="7">' + actor.tasks.map(function (t) {
      var c = counts(t, days);
      var rows = c.attempts.map(function (a) {
        return '<tr><td class="nowrap">' + esc(a.day) + '</td><td><span class="v' + a.v + '">' + SYM[a.v] + '</span> ' + esc(WORD[a.v]) + (t.skill === 'find' && a.sel !== null ? '<br><span class="muted">picked ' + (a.sel === 1 ? 'ours' : 'another Actor') + '</span>' : '') + '</td><td>' + (a.ran ? '<code>' + esc(a.ran) + '</code>' : '') + '</td><td>' + a.checks.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(' ') + '</td><td>' + (a.fix ? '<span class="tag">' + esc(a.fix) + '</span>' : '') + '</td><td class="ev">' + esc(a.note || '') + '</td><td><a href="' + esc(a.url) + '">session</a></td></tr>';
      }).join('');
      return '<div class="task"><div class="task-h"><b>' + esc(model.skillLabels[t.skill] || t.skill) + '</b> <span class="muted">' + esc(t.id) + '</span></div><blockquote>' + esc(t.prompt) + '</blockquote>' + (c.attempts.length ? '<table class="att"><tr><th>Day</th><th>Outcome</th><th>Ran instead</th><th>Failed checks</th><th>Fix area (judge)</th><th>Evidence (judge note)</th><th></th></tr>' + rows + '</table>' : '<p class="muted">No attempts in this period.</p>') + '</div>';
    }).join('') + '</td></tr>';
  }
  function render(model, state) {
    var days = daysInRange(model, state.range);
    var latestDay = days[days.length - 1];
    var actors = model.actors.filter(function (a) { return state.team === 'all' || a.owner === state.team; });
    var scored = actors.map(function (a) { return { a: a, s: status(model, a, days) }; }).sort(function (x, y) { return x.s - y.s || x.a.owner.localeCompare(y.a.owner) || x.a.subject.localeCompare(y.a.subject); });
    var nFail = scored.filter(function (x) { return x.s === 0; }).length, nNone = scored.filter(function (x) { return x.s === 1; }).length, nOk = scored.filter(function (x) { return x.s === 2; }).length;
    var h = '';
    h += '<div class="controls"><span class="lbl">Team</span>' + ['all'].concat(model.teams).map(function (t) { return '<a class="btn' + (state.team === t ? ' on' : '') + '" href="#' + frag({ team: t, range: state.range, actor: null }) + '">' + esc(t === 'all' ? 'All teams' : t[0].toUpperCase() + t.slice(1)) + '</a>'; }).join('') + '<span class="lbl">Period</span>' + [7, 28].map(function (r) { return '<a class="btn' + (state.range === r ? ' on' : '') + '" href="#' + frag({ team: state.team, range: r, actor: state.actor }) + '">' + r + ' days</a>'; }).join('') + '</div>';
    h += '<p class="answer">' + (days.length ? esc(String(days.length)) + ' evaluated day' + (days.length === 1 ? '' : 's') + ' (' + esc(days[0]) + ' to ' + esc(latestDay) + ') in this view. ' : 'No evaluated days in this period. ') + '<b class="bad">' + nFail + '</b> ' + (nFail === 1 ? 'Actor has' : 'Actors have') + ' a failing latest result, <b>' + nNone + '</b> ' + (nNone === 1 ? 'has' : 'have') + ' no result on the latest day, <b class="ok">' + nOk + '</b> passed both tasks on the latest day.</p>';
    h += '<table class="main"><tr><th>Actor</th><th>Discovery: picked ours?</th><th>Discovery: completed</th><th>Named task: completed</th><th>History (' + esc(model.skillLabels.find || 'find') + ' / ' + esc(model.skillLabels.use || 'use') + ')</th><th>Latest finding</th><th></th></tr>';
    scored.forEach(function (x) {
      var a = x.a; var find = a.tasks.filter(function (t) { return t.skill === 'find'; }); var use = a.tasks.filter(function (t) { return t.skill === 'use'; });
      var cf = find.length ? counts(find[0], days) : null; var cu = use.length ? counts(use[0], days) : null;
      var open = state.actor === a.subject;
      h += '<tr class="row s' + x.s + (open ? ' open' : '') + '" id="' + esc(a.subject.replace(/[^a-z0-9]+/gi, '-')) + '"><td><a class="name" href="#' + frag({ team: state.team, range: state.range, actor: open ? null : a.subject }) + '">' + esc(nice(a.subject)) + '</a><br><span class="muted small">' + esc(a.owner) + ' · <a href="https://apify.com/' + esc(a.subject) + '">' + esc(a.subject) + '</a></span></td>' + (cf ? countCell(cf, latestDay, 'sel') : '<td class="muted">no discovery task</td>') + (cf ? countCell(cf, latestDay, 'done') : '<td></td>') + (cu ? countCell(cu, latestDay, 'done') : '<td class="muted">no named task</td>') + '<td>' + (find.length ? cellRow(find[0], days) : '') + (use.length ? cellRow(use[0], days) : '') + '</td>' + finding(a, days) + '<td><a class="btn small" href="#' + frag({ team: state.team, range: state.range, actor: open ? null : a.subject }) + '">' + (open ? 'close' : 'details') + '</a></td></tr>';
      if (open) h += detail(model, a, days);
    });
    h += '</table>';
    return h;
  }
  function frag(s) { var p = ['team=' + encodeURIComponent(s.team), 'range=' + s.range]; if (s.actor) p.push('actor=' + encodeURIComponent(s.actor)); return p.join('&'); }
  function parse(hash, model) { var s = { team: 'all', range: 7, actor: null }; (hash || '').replace(/^#/, '').split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i < 0) return; var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1)); if (k === 'team' && (v === 'all' || model.teams.indexOf(v) >= 0)) s.team = v; if (k === 'range' && (v === '7' || v === '28')) s.range = Number(v); if (k === 'actor') s.actor = v; }); return s; }
  function boot() {
    var model = JSON.parse(document.getElementById('report-data').textContent);
    var main = document.getElementById('report-main');
    function draw() { var st = parse(location.hash, model); main.innerHTML = render(model, st); if (st.actor) { var el = document.getElementById(st.actor.replace(/[^a-z0-9]+/gi, '-')); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' }); } }
    window.addEventListener('hashchange', draw); draw();
  }
  root.EvalReportV2 = { render: render, parse: parse, boot: boot };
})(typeof window !== 'undefined' ? window : globalThis);
`;

const CSS = `
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--ok:#1a7f37;--bad:#b42318;--soft:#f5f5f7;--link:#0a58ca;--warn:#b54708}
body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:var(--fg);margin:0;padding:24px 28px 60px;max-width:1280px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 14px}.cov{margin:0 0 10px}.cov b{font-weight:600}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 12px}.lbl{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:0 4px 0 10px}
.btn{display:inline-block;padding:3px 10px;border:1px solid var(--line);border-radius:14px;color:var(--fg);text-decoration:none;font-size:13px}.btn.on{background:var(--fg);color:#fff;border-color:var(--fg)}.btn.small{padding:1px 8px;font-size:12px}
.answer{margin:0 0 14px;font-size:15px}
table.main{border-collapse:collapse;width:100%}table.main th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid var(--line)}
table.main td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}tr.s0 td:first-child{border-left:3px solid var(--bad)}tr.s1 td:first-child{border-left:3px solid var(--line)}tr.s2 td:first-child{border-left:3px solid var(--ok)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}a.name{font-weight:650;color:var(--fg);font-size:15px}.small{font-size:12px}.muted{color:var(--muted)}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
td.num{white-space:nowrap}code{font:12px ui-monospace,Menlo,monospace;background:var(--soft);padding:1px 4px;border-radius:3px}.tag{display:inline-block;background:var(--soft);border-radius:10px;padding:0 8px;font-size:12px;margin-top:4px}
.hist{display:flex;gap:2px;margin:2px 0}.c{display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:3px;font-size:12px;text-decoration:none;color:#fff}.c.none{background:transparent;color:var(--muted)}.vP{background:var(--ok)}.vF{background:var(--bad)}.vW{background:var(--warn)}.vI{background:#c7c7cc}.vU{background:#c7c7cc}
span.vP,span.vF,span.vW,span.vI,span.vU{display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;border-radius:3px;color:#fff;font-size:11px}
.note{color:var(--muted);font-size:13px;margin-top:3px}tr.detail>td{background:var(--soft);padding:12px 14px}.task{margin:0 0 14px}.task-h{margin-bottom:4px}blockquote{margin:4px 0 8px;padding:6px 10px;border-left:3px solid var(--line);color:var(--muted);font-size:13px}
table.att{border-collapse:collapse;width:100%;font-size:13px;background:#fff}table.att th{text-align:left;color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;padding:4px 6px;border-bottom:1px solid var(--line)}table.att td{padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}.nowrap{white-space:nowrap}.ev{max-width:460px}
details{margin-top:36px;color:var(--muted);font-size:13px}summary{cursor:pointer;color:var(--fg)}details ul{padding-left:18px}
.legend span{margin-right:10px}
`;

export function renderHtmlV2(data: ReportData, agg: Aggregate): string {
    const model = buildV2Model(data, agg);
    const json = JSON.stringify(model);
    // Pre-render the default view so the page reads without JavaScript.
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(CLIENT_JS, sandbox);
    const api = (
        sandbox as {
            EvalReportV2: { render: (m: V2Model, s: { team: string; range: number; actor: string | null }) => string };
        }
    ).EvalReportV2;
    const prerendered = api.render(model, { team: 'all', range: 7, actor: null });
    const esc = (s: unknown) =>
        String(s ?? '').replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
        );
    const cov =
        model.latest && model.latestDay
            ? `Latest evaluated day <b>${esc(model.latestDay)}</b>: ${model.latest.judged} of ${model.expectedTasks} tasks judged, ${model.latest.excluded} not counted (our infrastructure failed), ${model.latest.missing} missing. Generated ${esc(model.generatedAt.replace('T', ' ').slice(0, 16))} UTC.`
            : 'No evaluated days yet.';
    const excludedList = model.excluded.length
        ? `<ul>${model.excluded.map((e) => `<li>${esc(e.day)} · ${esc(e.experiment)} · ${e.attempts} attempts · ${esc(e.reason)}</li>`).join('')}</ul>`
        : '<p>None.</p>';
    const disList = model.disagreements.length
        ? `<ul>${model.disagreements.map((d) => `<li>${esc(d.day)} · <code>${esc(d.task)}</code> · <a href="${esc(d.url)}">session</a>${d.note ? ` · ${esc(d.note.slice(0, 160))}` : ''}</li>`).join('')}</ul>`
        : '<p>None.</p>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent evals · ${esc(model.suite)} · ${esc(model.latestDay ?? '')}</title><style>${CSS}</style></head><body>
<h1>Are our Actors ready for AI agents?</h1>
<p class="sub">Every morning an AI agent gets one discovery task and one named task per Actor. One result per task per day counts; on-demand reruns are listed under diagnostics. Legend: <span class="legend"><span class="vP">✓</span> passed <span class="vF">✕</span> failed <span class="vW">↷</span> used another Actor <span class="vI">◌</span> not counted (our infrastructure) · no result</span>. Click a cell to open that session; click an Actor for its tasks and evidence.</p>
<p class="cov">${cov}</p>
<div id="report-main">${prerendered}</div>
<details><summary>How this is counted, and details for the eval team</summary>
<p><b>Counting rule.</b> One canonical result per task per day: the scheduled 06:00 run, or, on a day without one, the only full run of that day. "Completed" = passed / conclusive attempts (not counted and no-verdict excluded from the denominator). "Picked ours" comes from the hard check on which Actor the agent called, independent of whether the task then succeeded. The fix area is the judge's suggestion, not a confirmed cause; the evidence note is the judge's, quoted.</p>
<p><b>Attempts excluded from the counts</b> (${model.excluded.reduce((n, e) => n + e.attempts, 0)})</p>${excludedList}
<p><b>Judge and hard checks disagreed</b> (${model.disagreements.length})</p>${disList}
<p>Suite <code>${esc(model.suite)}</code>, ${model.expectedTasks} tasks over ${model.actors.length} Actors, days with data: ${model.days.map(esc).join(', ')}.</p>
</details>
<script id="report-data" type="application/json">${json.replace(/<\//g, '<\\/')}</script>
<script>${CLIENT_JS}</script>
<script>EvalReportV2.boot();</script>
</body></html>`;
}
