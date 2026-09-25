/* Report v2 client. Runs in the browser and, via vm, at build time to pre-render the default view. Design: ASTRA-REPORT workshop, 25 Sept 2026. */
function application(raw) {
  const tidy = x => String(x ?? '').replace(/ = undefined \(expected exists undefined\)/g,' is missing (expected to be set)').replace(/ = undefined \(expected (\w+) /g,' is missing (expected $1 ');
  const esc = x => tidy(x).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names = {P:'Passed', F:'Failed', W:'Other Actor', I:'Not counted', U:'No result'};
  const symbols = {P:'✓', F:'×', W:'↗', I:'∕', U:'?'};
  const code = x => !x ? 'U' : x.infraOk === false || x.verdict === 'inconclusive' ? 'I' : ({pass:'P',fail:'F','wrong-actor':'W'}[x.verdict] || 'U');
  const valid = x => ['P','F','W'].includes(code(x));
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const nice = s => s.split('/').pop().split('-').map(cap).join(' ').replace(/^Ai /,'AI ').replace(/^Rag /,'RAG ').replace(/^Tiktok /,'TikTok ').replace(/^Youtube /,'YouTube ');
  const score = (a,k) => a?.scores?.[k];
  const canonical = raw.observations;
  const days = raw.days.length ? raw.days.slice() : [...new Set(canonical.map(x=>x.day))].sort();
  const latest = days.at(-1);
  const index = new Map(canonical.map(x=>[x.scenarioId+'|'+x.day,x]));
  const actors = [...new Set(raw.expected.map(t=>t.subject))].map(id=>({id,name:nice(id),team:raw.expected.find(t=>t.subject===id).owner,tasks:raw.expected.filter(t=>t.subject===id)}));
  const teams = [...new Set(actors.map(a=>a.team))].sort();
  const get = (task,day) => index.get(task.id+'|'+day);
  function selected(a) { return code(a)==='I' ? null : (a?.found===0 || a?.found===1 ? a.found : null); }
  function dates(range) {
    const first = new Date(latest+'T00:00:00Z'); first.setUTCDate(first.getUTCDate()-range+1);
    const start = first.toISOString().slice(0,10) < days[0] ? days[0] : first.toISOString().slice(0,10);
    const result=[]; for(let d=new Date(start+'T00:00:00Z');d.toISOString().slice(0,10)<=latest;d.setUTCDate(d.getUTCDate()+1)) result.push(d.toISOString().slice(0,10));
    return result;
  }
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const longDate = d => { const [y,m,dd]=d.split('-'); return `${MONTHS[+m-1]} ${+dd}, ${y}`; };
  const windowLabel = (a,b) => { const [ya,ma,da]=a.split('-'), [yb,mb,db]=b.split('-'); return ma===mb&&ya===yb ? `${MONTHS[+ma-1]} ${+da} to ${+db}, ${ya}` : `${MONTHS[+ma-1]} ${+da}${ya!==yb?', '+ya:''} to ${MONTHS[+mb-1]} ${+db}, ${yb}`; };
  const href = (s,extra={}) => '#'+new URLSearchParams(Object.entries({...s,...extra}).filter(([k,v])=>v!==null && v!==undefined && v!==''));
  const badge = (c,label) => `<span class="status ${c}"><b aria-hidden="true">${symbols[c]}</b> ${esc(label||names[c])}</span>`;
  const listFor = (tasks,ds) => tasks.flatMap(t=>ds.map(d=>get(t,d)).filter(Boolean));
  function tally(tasks,ds) {
    const as=listFor(tasks,ds), ok=as.filter(valid), sel=as.filter(a=>selected(a)!==null);
    return {pass:ok.filter(a=>code(a)==='P').length,n:ok.length,sel:sel.filter(a=>selected(a)===1).length,sn:sel.length,infra:as.filter(a=>code(a)==='I').length,missing:tasks.length*ds.length-as.filter(a=>code(a)!=='U').length,total:tasks.length*ds.length};
  }
  function state(hash='') {
    const p=new URLSearchParams(hash.replace(/^#/,''));
    return {team:teams.includes(p.get('team'))?p.get('team'):'all',range:[7,28,90].includes(+p.get('range'))?+p.get('range'):7,actor:p.has('actor')?p.get('actor'):'',task:p.get('task')||'',day:p.get('day')||'',metric:p.get('metric')||''};
  }
  function overall(actor) { const a=actor.tasks.map(t=>get(t,latest)); return a.some(x=>['F','W'].includes(code(x)))?0:a.every(x=>code(x)==='P')?2:1; }
  function chart(tasks,ds,skill,s) {
    const data=ds.map(day=>({day,...tally(tasks,[day])}));
    const last=data.at(-1), color=skill==='find'?'#255fc2':'#784ab0';
    const x=i=>48+(data.length===1?240:i*480/(data.length-1)), y=v=>142-v*1.12;
    let svg=`<svg viewBox="0 0 560 216" role="group" aria-label="${skill==='find'?'Discovery':'Named task'} daily pass rate and coverage"><title>Daily rates with eligible evaluation counts. Exact values follow in the chart data table.</title>`;
    for(const n of [0,50,100]) svg+=`<line x1="48" y1="${y(n)}" x2="528" y2="${y(n)}" stroke="#e1e5eb"/><text x="35" y="${y(n)+4}" text-anchor="end">${n}%</text>`;
    const series=[{field:'pass',denom:'n',color,dash:false}];
    if(skill==='find')series.unshift({field:'sel',denom:'sn',color:'#66788e',dash:true});
    for(const se of series){
      let seg=[];
      const flush=()=>{if(seg.length>1)svg+=`<polyline points="${seg.join(' ')}" fill="none" stroke="${se.color}" stroke-width="2.3" ${se.dash?'stroke-dasharray="5 4"':''}/>`;seg=[];};
      data.forEach((d,i)=>{if(!d[se.denom]){flush();return;}seg.push(`${x(i)},${y(d[se.field]/d[se.denom]*100)}`);});flush();
      data.forEach((d,i)=>{if(!d[se.denom])return; const tip=`${d.day}: ${d[se.field]}/${d[se.denom]} ${se.dash?'selected expected Actor':'passed'}; ${d.n}/${d.total} eligible, ${d.infra} not counted, ${d.missing} no result`;
        svg+=`<a href="${esc(href(s,{day:d.day,metric:skill}))}" aria-label="${esc(tip)}"><circle cx="${x(i)}" cy="${y(d[se.field]/d[se.denom]*100)}" r="5" fill="${se.dash?'white':se.color}" stroke="${se.color}" stroke-width="2"><title>${esc(tip)}</title></circle></a>`;
      });
    }
    data.forEach((d,i)=>{
      const width=Math.min(36,400/data.length);
      svg+=`<rect x="${x(i)-width/2}" y="164" width="${width}" height="6" rx="2" fill="#e1e5eb"/><rect x="${x(i)-width/2}" y="164" width="${d.total?width*d.n/d.total:0}" height="6" rx="2" fill="${color}"/>`;
      if(data.length<=7 || i===0 || i===data.length-1)svg+=`<text x="${x(i)}" y="185" text-anchor="middle">${d.n}/${d.total}</text><text x="${x(i)}" y="207" text-anchor="middle">${d.day.slice(5).replace('-','/')}</text>`;
    });
    svg+='</svg>';
    const exact=`<details class="chart-values"><summary>Exact counts and coverage</summary><table><thead><tr><th>Date</th>${skill==='find'?'<th>Selected</th>':''}<th>Passed</th><th>Eligible</th><th>Not counted</th><th>No result</th></tr></thead><tbody>${data.map(d=>`<tr><td>${d.day}</td>${skill==='find'?`<td>${d.sel}/${d.sn}</td>`:''}<td>${d.pass}/${d.n}</td><td>${d.n}/${d.total}</td><td>${d.infra}</td><td>${d.missing}</td></tr>`).join('')}</tbody></table></details>`;
    return `<article class="chart"><div class="chart-top"><div><h3>${skill==='find'?'Discovery tasks':'Named-Actor tasks'}</h3><p>${skill==='find'?'The agent chooses an Actor.':'The prompt specifies the Actor.'}</p></div><div class="chart-stat">${last.n?Math.round(last.pass/last.n*100)+'%':'N/A'}<small>${last.pass}/${last.n} passed latest</small></div></div><div class="chart-key"><span style="--series:${color}">● Task passed</span>${skill==='find'?'<span class="dashed">○ Expected Actor selected</span>':''}</div>${svg}<div class="coverage-caption">Bars: eligible / expected evaluations</div>${exact}</article>`;
  }
  function metric(tasks,ds,skill) {
    if(!tasks.length)return '<span class="muted">No task</span>';
    const now=tasks.map(t=>get(t,latest)), c=tally(tasks,ds), cs=now.map(code);
    const outcome=cs.includes('F')?'F':cs.includes('W')?'W':cs.includes('I')?'I':cs.includes('U')?'U':'P';
    const word=tasks.length>1?`${now.filter(a=>code(a)==='P').length}/${tasks.length} passed latest`:names[outcome];
    return `${badge(outcome,word)}<div class="counts">${c.pass}<span> / ${c.n} passed</span>${skill==='find'?`<br>${c.sel}<span> / ${c.sn} selected expected</span>`:`${tasks.length>1?`<br><span>${tasks.length} named tasks</span>`:''}`}</div>`;
  }
  function history(a,ds,s) {
    const recent=ds.slice(-7);
    return `<div class="history"><div class="history-dates"><span class="track-name">Date</span>${recent.map(d=>`<span>${d.slice(-2)}</span>`).join('')}</div>${a.tasks.map((t,i)=>`<div class="track"><span class="track-name">${t.skill==='find'?'Discover':a.tasks.filter(x=>x.skill==='use').length>1?'Named '+(a.tasks.filter(x=>x.skill==='use').indexOf(t)+1):'Named'}</span>${recent.map(d=>{const at=get(t,d),c=code(at);return `<a class="day-cell ${c}" data-history="1" href="${esc(href(s,{actor:a.id,task:t.id,day:d,metric:''}))}" title="${esc(t.title+' · '+d+' · '+names[c])}" aria-label="${esc(t.title+' · '+d+' · '+names[c])}">${symbols[c]}</a>`;}).join('')}</div>`).join('')}</div>`;
  }
  function evidence(t,at,s,ds) {
    const c=code(at), taskLabel=t.skill==='find'?'Discovery task':'Named task';
    const checks=(at?.failedChecks||[]).map(k=>`<li><code>${esc(k)}</code><span>${esc(score(at,'check.'+k)?.comment||'Failed')}</span></li>`).join('');
    const diagnosis=score(at,'judge.fixArea')?.comment;
    const selectedText=t.skill==='find'?(selected(at)===1?'Expected Actor selected':selected(at)===0?'Expected Actor not selected':'Selection not measured'):'';
    return `<article class="evidence${s.task===t.id?' selected-evidence':''}" id="evidence-${esc(t.id)}"><div class="evidence-title"><h4>${taskLabel}</h4>${badge(c)}<span class="muted">${esc(at?.day||latest)}</span></div><p class="task-prompt">${esc(t.prompt)}</p><div class="evidence-columns"><div><h5>Observed result</h5><p>${esc(at?.judgeComment?.replace(/^(FAIL|PASS):\s*/, '')||(c==='I'?(score(at,'check.infra')?.comment||'Infrastructure failure; excluded from rates.'):'No result is available for this date.'))}</p>${selectedText?`<p class="selection-note">${esc(selectedText)}</p>`:''}${at?.subjectCalled && at.subjectCalled!=='intended'?`<p class="small">Reported alternative: <code>${esc(at.subjectCalled)}</code></p>`:''}${checks?`<ul class="checks">${checks}</ul>`:''}</div><div><h5>Judge's suggested fix area</h5><p class="fix-area">${esc(at?.fixArea||'Not available')}</p><p class="small">${esc(diagnosis||'No additional diagnosis recorded.')}</p>${score(at,'judge.disagreement')?.value===1?`<div class="disagreement">Check/judge disagreement. Hard checks: ${score(at,'check.all')?.value===1?'passed':'failed'}. Task-completion rubric: ${score(at,'rubric.taskCompletion')?.value===1?'passed':'failed or unavailable'}.</div>`:''}</div></div><div class="evidence-foot">${at?.traceUrl?`<a href="${esc(at.traceUrl)}" target="_blank" rel="noreferrer">Open full session ↗</a>`:''}<details><summary>Task ID</summary><code>${esc(t.id)}</code></details></div><details class="attempt-history"><summary>All ${ds.length} daily results for this task</summary><table><thead><tr><th>Date</th><th>Outcome</th><th>Evidence</th><th>Session</th></tr></thead><tbody>${[...ds].reverse().map(d=>{const x=get(t,d);return `<tr><td>${d}</td><td>${badge(code(x))}</td><td>${esc(x?.judgeComment||'No result')}</td><td>${x?`<a href="${esc(x.traceUrl)}">Open</a>`:''}</td></tr>`;}).join('')}</tbody></table></details></article>`;
  }
  function render(s) {
    const ds=dates(s.range), scoped=actors.filter(a=>s.team==='all'||a.team===s.team), tasks=scoped.flatMap(a=>a.tasks), totals=tally(tasks,ds), current=tally(tasks,[latest]);
    const fail=scoped.filter(a=>overall(a)===0).length, pass=scoped.filter(a=>overall(a)===2).length, unknown=scoped.length-fail-pass;
    const ordered=scoped.slice().sort((a,b)=>a.team.localeCompare(b.team)||overall(a)-overall(b)||a.id.localeCompare(b.id));
    let h=`<header class="page-header"><div><p class="eyebrow">Apify · Agent evaluations</p><h1>Can agents find and use your Actors?</h1><p class="subtitle">Daily tests of selection and task completion.</p></div><div class="freshness">Latest run <strong>${longDate(latest)}</strong><span>${current.n}/${current.total} eligible · ${current.infra} not counted · ${current.missing} no result</span></div></header><nav class="scope" aria-label="Report scope"><div class="team-tabs">${['all',...teams].map(t=>`<a class="${t===s.team?'active':''}" href="${esc(href(s,{team:t,actor:'',task:'',day:'',metric:''}))}" ${t===s.team?'aria-current="true"':''}>${t==='all'?'All teams':cap(t)}</a>`).join('')}</div><div class="period"><span>Period</span>${[7,28,90].map(r=>`<a href="${esc(href(s,{range:r}))}" class="${r===s.range?'active':''}">${r} days</a>`).join('')}</div></nav><section class="overview" aria-label="Latest outcomes"><div><h2>${fail} of ${scoped.length} Actors had a failing task in the latest run.</h2><p>${pass} passed every task${unknown?` · ${unknown} have incomplete results`:''}. Review a row to see the task and evidence.</p></div><div class="window-label">${windowLabel(ds[0],latest)}<span>${ds.length} days available in this ${s.range}-day view</span></div></section><section class="trends" aria-label="Trends">${chart(tasks.filter(t=>t.skill==='find'),ds,'find',s)}${chart(tasks.filter(t=>t.skill==='use'),ds,'use',s)}</section>`;
    if(s.metric && ds.includes(s.day)){
      const picked=tasks.filter(t=>t.skill===s.metric), stat=tally(picked,[s.day]);
      h+=`<aside class="point-detail"><strong>${esc(s.day)} · ${s.metric==='find'?'Discovery':'Named'} tasks</strong><span>${stat.pass}/${stat.n} passed · ${stat.infra} not counted · ${stat.missing} no result</span><a href="${esc(href(s,{metric:'',day:''}))}">Clear date</a><div>${picked.map(t=>{const a=get(t,s.day);return `<a href="${esc(href(s,{actor:t.subject,task:t.id,metric:'',day:s.day}))}">${badge(code(a))} ${esc(nice(t.subject))}</a>`;}).join('')}</div></aside>`;
    }
    h+=`<section class="actors-section" aria-labelledby="actors-title"><div class="section-title"><div><h2 id="actors-title">Actors <span>${scoped.length}</span></h2><p>Latest outcome first. Counts cover the selected period.</p></div><div class="legend">${Object.keys(names).map(c=>`<span><i class="day-cell ${c}">${symbols[c]}</i>${names[c]}</span>`).join('')}</div></div><div class="column-head"><span>Actor</span><span>Discovery task</span><span>Named task</span><span>Recent outcomes <small class="date-head">${ds.slice(-7).map(d=>`<span>${d.slice(-2)}</span>`).join('')}</small></span></div><div class="actor-list">`;
    let previous='';
    for(const a of ordered){
      if(s.team==='all'&&a.team!==previous){h+=`<div class="team-divider">${cap(a.team)} <span>${scoped.filter(x=>x.team===a.team).length} Actors</span></div>`;previous=a.team;}
      const open=a.id===s.actor;
      h+=`<details class="actor" data-actor="${esc(a.id)}" id="actor-${a.id.replace(/[^a-z0-9]/gi,'-')}" ${open?'open':''}><summary class="actor-row"><div class="actor-name"><span class="chevron">›</span><div><strong>${esc(a.name)}</strong><span>${esc(a.team)}${a.tasks.length!==2?' · '+a.tasks.length+' tasks':''}</span></div></div><div class="metric"><span class="mobile-label">Discovery</span>${metric(a.tasks.filter(t=>t.skill==='find'),ds,'find')}</div><div class="metric"><span class="mobile-label">Named task</span>${metric(a.tasks.filter(t=>t.skill==='use'),ds,'use')}</div>${history(a,ds,s)}</summary><div class="actor-detail"><div class="detail-heading"><span>Tasks and evidence</span><a href="https://apify.com/${esc(a.id)}" target="_blank" rel="noreferrer">${esc(a.id)} ↗</a></div>${a.tasks.map(t=>evidence(t,get(t,s.task===t.id&&ds.includes(s.day)?s.day:latest),s,ds)).join('')}</div></details>`;
    }
    const disagreements=listFor(tasks,ds).filter(a=>score(a,'judge.disagreement')?.value===1);
    h+=`</div></section><details class="diagnostics"><summary><span>Evaluation diagnostics</span><span>${totals.n}/${totals.total} eligible · ${totals.infra} infrastructure exclusions · ${disagreements.length} disagreements</span></summary><div><p>One canonical attempt per task and date: the scheduled run, or on a day without one the only full run of that day. ${raw.excludedAttempts} on-demand or duplicate attempts in the period are excluded from every number here; these are separate from infrastructure exclusions.</p><p>Rates use eligible task attempts, not Actors. Discovery selection uses the exported <code>found</code> field separately from the verdict. A pass means the task met this evaluation's checks, including expected-Actor requirements.</p><p>${tasks.filter(t=>t.skill==='find').length} discovery tasks and ${tasks.filter(t=>t.skill==='use').length} named tasks in this scope. Cost data is not included in this source export.</p><details><summary>Check/judge disagreements (${disagreements.length})</summary><ul>${disagreements.map(a=>`<li>${a.day} · ${esc(a.scenarioId)} · ${esc(a.judgeComment)} · <a href="${esc(a.traceUrl)}">Session</a></li>`).join('')}</ul></details></div></details><footer>Suite ${esc(raw.suite)} · generated ${esc(raw.generatedAt.replace('T',' ').slice(0,16))} UTC · one result per task per day<span><a href="${esc(raw.latestJsonUrl||'#')}">Data (JSON)</a></span></footer>`;
    return h;
  }
  return {render,state,canonical,actors,tally,dates};
}

function reportBoot(){
  var reportRaw=JSON.parse(document.getElementById('report-data').textContent); var reportApp=application(reportRaw); var main=document.getElementById('report');
  function draw(){var s=reportApp.state(location.hash);main.innerHTML=reportApp.render(s);if(s.actor&&s.task){var el=document.getElementById('evidence-'+s.task);if(el&&el.scrollIntoView)el.scrollIntoView({block:'start'});}}
  if(location.hash)draw(); window.addEventListener('hashchange',draw);
  document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-history]');if(a){e.preventDefault();e.stopPropagation();location.hash=a.getAttribute('href').slice(1);}});
  document.addEventListener('toggle',function(e){if(e.target.matches&&e.target.matches('details.actor')){var s=reportApp.state(location.hash);if(e.target.open){s.actor=e.target.dataset.actor;}else if(s.actor===e.target.dataset.actor){s.actor='';}else{return;}history.replaceState(null,'','#'+new URLSearchParams(Object.entries(s).filter(function(kv){return kv[1]!==null&&kv[1]!==undefined&&kv[1]!=='';})));}},true);
}
if (typeof module !== 'undefined') module.exports = { application: application };
