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
  const METRICS=[
    {id:'selection',label:'Expected Actor selected',help:'The agent used the expected Actor in a discovery task, whether or not the task passed.'},
    {id:'discovery',label:'Discovery tasks passed',help:"The agent chose an Actor and passed this task's evaluation, which also requires the expected Actor."},
    {id:'named',label:'Named-Actor tasks passed',help:"The prompt named an Actor, and the agent passed this task's evaluation."},
    {id:'counted',label:'Results counted',help:'These task results have a verdict that can be used in pass-rate calculations.'},
    {id:'notcounted',label:'Not counted',help:'A failure in the evaluation infrastructure prevented this task from counting.'},
    {id:'noresult',label:'No result',help:'An expected task has no recorded attempt or is still awaiting a verdict.'},
    {id:'failedchecks',label:'Failed checks',help:'These recorded checks failed in the selected attempt; the comments explain what each check tested.'},
    {id:'change',label:'Change',help:'This compares the same tasks with usable results in both labeled runs.'}
  ];
  const metricDef = id => METRICS.find(m=>m.id===id) || {label:id,help:''};
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
    return {team:teams.includes(p.get('team'))?p.get('team'):'all',range:[7,28,90].includes(+p.get('range'))?+p.get('range'):7,actor:p.has('actor')?p.get('actor'):'',task:p.get('task')||'',day:p.get('day')||'',metric:p.get('metric')||'',compare:['selection','discovery','named','all'].includes(p.get('compare'))?p.get('compare'):'',how:p.get('how')==='1'?'1':''};
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
  function compare(tasks) {
    const prev=days.length>1?days[days.length-2]:null;
    if(!prev)return null;
    const find=tasks.filter(t=>t.skill==='find'), use=tasks.filter(t=>t.skill==='use');
    const pairs=(ts,ok)=>ts.map(t=>({t,a:get(t,prev),b:get(t,latest)})).filter(p=>ok(p.a)&&ok(p.b));
    const mk=(id,ts,ok,val,words)=>{
      const ps=pairs(ts,ok), before=ps.filter(p=>val(p.a)).length, after=ps.filter(p=>val(p.b)).length;
      return {id,label:metricDef(id).label,n:ps.length,before,after,delta:after-before,down:ps.filter(p=>val(p.a)&&!val(p.b)),up:ps.filter(p=>!val(p.a)&&val(p.b)),omitted:ts.length-ps.length,words};
    };
    const gap=Math.round((new Date(latest+'T00:00:00Z')-new Date(prev+'T00:00:00Z'))/864e5)-1;
    return {prev,latest,gap,rows:[
      mk('selection',find,a=>selected(a)!==null,a=>selected(a)===1,{unit:'selected',down:'Selected before, not selected now',up:'Not selected before, selected now'}),
      mk('discovery',find,valid,a=>code(a)==='P',{unit:'passed',down:'Passed before, failed now',up:'Failed before, passed now'}),
      mk('named',use,valid,a=>code(a)==='P',{unit:'passed',down:'Passed before, failed now',up:'Failed before, passed now'})
    ]};
  }
  const deltaText = r => r.n===0?'No tasks could be compared':r.delta===0?'No net change':(r.delta>0?'+':'−')+Math.abs(r.delta)+' '+r.words.unit;
  function transitions(cmp,s) {
    const rows=s.compare==='all'?cmp.rows.filter(r=>r.id!=='selection'):cmp.rows.filter(r=>r.id===s.compare);
    const item=p=>`<li>${badge(code(p.a))}<span class="arrow" aria-hidden="true">→</span>${badge(code(p.b))}<span class="who"><strong>${esc(nice(p.t.subject))}</strong> · ${esc(p.t.title)}</span><span class="links"><a data-history="1" href="${esc(href(s,{actor:p.t.subject,task:p.t.id,day:latest,metric:'',compare:''}))}">Latest evidence</a><a data-history="1" href="${esc(href(s,{actor:p.t.subject,task:p.t.id,day:cmp.prev,metric:'',compare:''}))}">Previous</a></span></li>`;
    const group=(title,list)=>`<div class="transition-group"><h4>${esc(title)} <span>${list.length}</span></h4>${list.length?`<ul>${list.map(item).join('')}</ul>`:'<p class="muted">None</p>'}</div>`;
    return `<div class="transitions" id="transitions"><div class="transitions-head"><strong>${rows.map(r=>r.label).join(' and ')} · ${longDate(cmp.prev)} → ${longDate(cmp.latest)}</strong><a href="${esc(href(s,{compare:''}))}">Close</a></div>${rows.map(r=>`${rows.length>1?`<h3>${esc(r.label)}</h3>`:''}${group(r.words.down,r.down)}${group(r.words.up,r.up)}`).join('')}</div>`;
  }
  function comparison(cmp,s) {
    if(!cmp)return `<section class="comparison" aria-labelledby="comparison-title"><div class="comparison-head"><h2 id="comparison-title">Compared with the previous run</h2></div><p class="comparison-note">No earlier run to compare.</p></section>`;
    const when=cmp.gap>0?`${longDate(cmp.prev)} to ${longDate(cmp.latest)} · no scheduled result on the ${cmp.gap===1?'day':cmp.gap+' days'} between`:windowLabel(cmp.prev,cmp.latest);
    const rowsHtml=cmp.rows.map(r=>`<tr><th scope="row" title="${esc(metricDef(r.id).help)}">${esc(r.label)}</th><td><span class="comparison-field" aria-hidden="true">Previous</span>${r.n?`${r.before}/${r.n}`:'—'}</td><td><span class="comparison-field" aria-hidden="true">Latest</span>${r.n?`${r.after}/${r.n}`:'—'}</td><td><span class="comparison-field" aria-hidden="true">Change</span>${r.n&&(r.down.length||r.up.length)?`<a href="${esc(href(s,{compare:r.id,actor:'',task:'',day:'',metric:''}))}" aria-current="${s.compare===r.id}">${deltaText(r)}</a>`:deltaText(r)}</td></tr>`).join('');
    const [sel,disc,named]=cmp.rows;
    const foot=[];
    if(disc.omitted||named.omitted)foot.push(`Tasks without a usable result on both dates are left out: ${disc.omitted} discovery, ${named.omitted} named.`);
    if(sel.omitted>disc.omitted)foot.push(`Selection was not measured for ${sel.omitted-disc.omitted} discovery task${sel.omitted-disc.omitted>1?'s':''}.`);
    foot.push('Task and scoring versions were not recorded; results are matched by task ID.');
    return `<section class="comparison" aria-labelledby="comparison-title"><div class="comparison-head"><h2 id="comparison-title">Compared with the previous run</h2><p>${esc(when)}</p></div><p class="comparison-note" id="comparison-note">Matched by task ID; only tasks scored in both runs count here. Click a change to list the tasks behind it.</p><table class="comparison-table" aria-labelledby="comparison-title" aria-describedby="comparison-note"><thead><tr><th scope="col">Measure</th><th scope="col">Previous</th><th scope="col">Latest</th><th scope="col" title="${esc(metricDef('change').help)}">Change</th></tr></thead><tbody>${rowsHtml}</tbody></table><p class="comparison-note comparison-foot">${esc(foot.join(' '))}</p>${s.compare?transitions(cmp,s):''}</section>`;
  }
  function summary(scoped,current,cmp,s) {
    const fail=scoped.filter(a=>overall(a)===0).length;
    let h=`<strong>${fail} of ${scoped.length} Actors had a failing task in the latest run.</strong> `;
    const unusable=current.total-current.n;
    if(unusable>0)h+=`${unusable} of ${current.total} task results in the latest run have no usable verdict. `;
    if(!cmp)return h+'No earlier comparable run is available.';
    const [,disc,named]=cmp.rows, down=disc.down.length+named.down.length, up=disc.up.length+named.up.length, paired=disc.n+named.n;
    if(!paired)return h+`No tasks could be compared with the run on ${longDate(cmp.prev)}.`;
    if(!down&&!up)return h+`No pass/fail outcomes changed among the ${paired} tasks compared with ${longDate(cmp.prev)}.`;
    const link=(n,txt)=>n?`<a href="${esc(href(s,{compare:'all',actor:'',task:'',day:'',metric:''}))}">${n} ${txt}</a>`:`${n} ${txt}`;
    return h+`Among the ${paired} tasks scored on both ${longDate(cmp.prev)} and ${longDate(cmp.latest)}, ${link(down,'passed before and failed now')}; ${link(up,'failed before and passed now')}.`;
  }
  function metric(a,tasks,ds,skill,s) {
    if(!tasks.length)return '<span class="muted">No task</span>';
    const now=tasks.map(t=>get(t,latest)), c=tally(tasks,ds), cs=now.map(code);
    const outcome=cs.includes('F')?'F':cs.includes('W')?'W':cs.includes('I')?'I':cs.includes('U')?'U':'P';
    const word=tasks.length>1?`${now.filter(a=>code(a)==='P').length}/${tasks.length} passed latest`:names[outcome];
    const failed=now.flatMap((at,i)=>(at?.failedChecks||[]).map(k=>({task:tasks[i],k})));
    const firstBad=tasks.find((t,i)=>['F','W'].includes(cs[i]))||tasks[0];
    const link=(txt,task,aria)=>`<a class="cell-note fail" data-history="1" href="${esc(href(s,{actor:a.id,task:task.id,day:latest,metric:'',compare:''}))}" aria-label="${esc(aria)}">${txt}</a>`;
    const kind=skill==='find'?'discovery':'named';
    let note='';
    if(failed.length&&(outcome==='F'||outcome==='W'))note=link(`× ${failed.length} failed check${failed.length>1?'s':''}`,failed[0].task,`${failed.length} failed checks across this Actor's latest ${kind} tasks. Opens the evidence.`);
    else if(failed.length)note=`<a class="cell-note muted" data-history="1" href="${esc(href(s,{actor:a.id,task:failed[0].task.id,day:latest,metric:'',compare:''}))}" aria-label="${failed.length} recorded check${failed.length>1?'s':''} failed, but the task still passed. Opens the evidence.">${failed.length} check${failed.length>1?'s':''} failed, task still passed</a>`;
    else if(outcome==='F'||outcome==='W')note=link("See judge's finding",firstBad,"No recorded check failed; the judge's finding explains the outcome. Opens the evidence.");
    else if(outcome==='I')note=`<span class="cell-note muted" title="${esc(metricDef('notcounted').help)}">Test did not count</span>`;
    else if(outcome==='U')note=`<span class="cell-note muted" title="${esc(metricDef('noresult').help)}">Result pending or missing</span>`;
    return `${badge(outcome,word)}<div class="counts">${c.pass}<span> / ${c.n} passed</span>${skill==='find'?`<br>${c.sel}<span> / ${c.sn} selected expected</span>`:`${tasks.length>1?`<br><span>${tasks.length} named tasks</span>`:''}`}</div>${note}`;
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
    return `<article class="evidence${s.task===t.id?' selected-evidence':''}" id="evidence-${esc(t.id)}"><div class="evidence-title"><h4>${taskLabel}</h4>${badge(c)}<span class="muted">${esc(at?.day||latest)}</span></div><p class="task-prompt">${esc(t.prompt)}</p><div class="evidence-columns"><div><h5>Observed result</h5><p>${esc(at?.judgeComment?.replace(/^(FAIL|PASS):\s*/, '')||(c==='I'?(score(at,'check.infra')?.comment||'Infrastructure failure; excluded from rates.'):'No result is available for this date.'))}</p>${selectedText?`<p class="selection-note">${esc(selectedText)}</p>`:''}${at?.subjectCalled && at.subjectCalled!=='intended'?`<p class="small">Reported alternative: <code>${esc(at.subjectCalled)}</code></p>`:''}${checks?`<ul class="checks">${checks}</ul>`:''}</div><div><h5>Judge's suggested fix area</h5><p class="fix-area">${esc(at?.fixArea||'Not available')}</p><p class="small">${esc(diagnosis||'No additional diagnosis recorded.')}</p>${score(at,'judge.disagreement')?.value===1?`<div class="disagreement">Check/judge disagreement. Hard checks: ${score(at,'check.all')?.value===1?'passed':score(at,'check.all')?.value===0?'failed':'not recorded'}. Task-completion rubric: ${score(at,'rubric.taskCompletion')?.value===1?'passed':'failed or unavailable'}.</div>`:''}</div></div><div class="evidence-foot">${at?.traceUrl?`<a href="${esc(at.traceUrl)}" target="_blank" rel="noreferrer">Open full session ↗</a>`:''}<details><summary>Task ID</summary><code>${esc(t.id)}</code></details></div><details class="attempt-history"><summary>All ${ds.length} daily results for this task</summary><table><thead><tr><th>Date</th><th>Outcome</th><th>Evidence</th><th>Session</th></tr></thead><tbody>${[...ds].reverse().map(d=>{const x=get(t,d);return `<tr><td>${d}</td><td>${badge(code(x))}</td><td>${esc(x?.judgeComment||'No result')}</td><td>${x?`<a href="${esc(x.traceUrl)}">Open</a>`:''}</td></tr>`;}).join('')}</tbody></table></details></article>`;
  }
  function render(s) {
    const ds=dates(s.range), scoped=actors.filter(a=>s.team==='all'||a.team===s.team), tasks=scoped.flatMap(a=>a.tasks), totals=tally(tasks,ds), current=tally(tasks,[latest]);
    const cmp=compare(tasks);
    const ordered=scoped.slice().sort((a,b)=>a.team.localeCompare(b.team)||overall(a)-overall(b)||a.id.localeCompare(b.id));
    let h=`<header class="page-header"><div><p class="eyebrow">Apify · Agent evaluations</p><h1>Can agents find and use your Actors?</h1><p class="subtitle">Daily tests of selection and task completion.</p><a class="how-link" data-history="1" href="${esc(href(s,{how:'1'}))}">How this is measured</a></div><div class="freshness">Latest run <strong>${longDate(latest)}</strong><span>${current.n}/${current.total} eligible · ${current.infra} not counted · ${current.missing} no result</span></div></header><nav class="scope" aria-label="Report scope"><div class="team-tabs">${['all',...teams].map(t=>`<a class="${t===s.team?'active':''}" href="${esc(href(s,{team:t,actor:'',task:'',day:'',metric:'',compare:''}))}" ${t===s.team?'aria-current="true"':''}>${t==='all'?'All teams':cap(t)}</a>`).join('')}</div><div class="period"><span>Period</span>${[7,28,90].map(r=>`<a href="${esc(href(s,{range:r}))}" class="${r===s.range?'active':''}">${r} days</a>`).join('')}</div></nav><p class="summary">${summary(scoped,current,cmp,s)}</p><p class="window-line">${windowLabel(ds[0],latest)} · ${ds.length} days available in this ${s.range}-day view</p><section class="trends" aria-label="Trends">${chart(tasks.filter(t=>t.skill==='find'),ds,'find',s)}${chart(tasks.filter(t=>t.skill==='use'),ds,'use',s)}</section>`;
    if(s.metric && ds.includes(s.day)){
      const picked=tasks.filter(t=>t.skill===s.metric), stat=tally(picked,[s.day]);
      h+=`<aside class="point-detail"><strong>${esc(s.day)} · ${s.metric==='find'?'Discovery':'Named'} tasks</strong><span>${stat.pass}/${stat.n} passed · ${stat.infra} not counted · ${stat.missing} no result</span><a href="${esc(href(s,{metric:'',day:''}))}">Clear date</a><div>${picked.map(t=>{const a=get(t,s.day);return `<a href="${esc(href(s,{actor:t.subject,task:t.id,metric:'',day:s.day}))}">${badge(code(a))} ${esc(nice(t.subject))}</a>`;}).join('')}</div></aside>`;
    }
    h+=comparison(cmp,s);
    h+=`<details class="metric-help"><summary>What these numbers mean</summary><dl>${METRICS.map(m=>`<dt>${esc(m.label)}</dt><dd>${esc(m.help)}</dd>`).join('')}</dl></details>`;
    h+=`<section class="actors-section" aria-labelledby="actors-title"><div class="section-title"><div><h2 id="actors-title">Actors <span>${scoped.length}</span></h2><p>Latest outcome first. Counts cover the selected period.</p></div><div class="legend">${Object.keys(names).map(c=>`<span><i class="day-cell ${c}">${symbols[c]}</i>${names[c]}</span>`).join('')}</div></div><div class="column-head"><span>Actor</span><span>Discovery task</span><span>Named task</span><span>Recent outcomes <small class="date-head">${ds.slice(-7).map(d=>`<span>${d.slice(-2)}</span>`).join('')}</small></span></div><div class="actor-list">`;
    let previous='';
    for(const a of ordered){
      if(s.team==='all'&&a.team!==previous){h+=`<div class="team-divider">${cap(a.team)} <span>${scoped.filter(x=>x.team===a.team).length} Actors</span></div>`;previous=a.team;}
      const open=a.id===s.actor;
      h+=`<details class="actor" data-actor="${esc(a.id)}" id="actor-${a.id.replace(/[^a-z0-9]/gi,'-')}" ${open?'open':''}><summary class="actor-row"><div class="actor-name"><span class="chevron">›</span><div><strong>${esc(a.name)}</strong><span>${esc(a.team)}${a.tasks.length!==2?' · '+a.tasks.length+' tasks':''}</span></div></div><div class="metric"><span class="mobile-label">Discovery</span>${metric(a,a.tasks.filter(t=>t.skill==='find'),ds,'find',s)}</div><div class="metric"><span class="mobile-label">Named task</span>${metric(a,a.tasks.filter(t=>t.skill==='use'),ds,'use',s)}</div>${history(a,ds,s)}</summary><div class="actor-detail"><div class="detail-heading"><span>Tasks and evidence</span><a href="https://apify.com/${esc(a.id)}" target="_blank" rel="noreferrer">${esc(a.id)} ↗</a></div>${a.tasks.map(t=>evidence(t,get(t,s.task===t.id&&ds.includes(s.day)?s.day:latest),s,ds)).join('')}</div></details>`;
    }
    const disagreements=listFor(tasks,ds).filter(a=>score(a,'judge.disagreement')?.value===1);
    const nFind=tasks.filter(t=>t.skill==='find').length, nUse=tasks.filter(t=>t.skill==='use').length;
    h+=`</div></section><details class="how" id="how-measured" ${s.how?'open':''}><summary>How this is measured</summary><p>Each day, an agent receives ${nFind+nUse} tasks for ${scoped.length} Apify-maintained Actors${s.team==='all'?'':' owned by the '+cap(s.team)+' team'}: ${nFind} discovery tasks, where it chooses an Actor, and ${nUse} named tasks, where the prompt specifies one. Recorded checks and an AI judge assess the result. The judge reads the captured session and the check results. A pass means the task passed this evaluation, including any expected-Actor requirement.</p><p>We count one canonical attempt per task per day: the scheduled run, or on a day without one the only full run of that day. Additional reruns are kept out of these rates. Failures in the evaluation infrastructure are shown separately as “not counted”.</p><h4>What these results cannot tell you</h4><ul><li>These are selected test tasks, not a sample of all customer requests.</li><li>One changed outcome does not prove that an Actor changed or that a fix worked.</li><li>Results can change when the agent, task, judge, checks, runner, or target website changes.</li><li>Choosing another maintained Actor can still be useful to the user; the expected-Actor check can nevertheless fail.</li><li>A judge's suggested fix area is an interpretation. Read the evidence before changing an Actor.</li></ul></details><details class="diagnostics"><summary><span>Evaluation diagnostics</span><span>${totals.n}/${totals.total} eligible · ${totals.infra} infrastructure exclusions · ${disagreements.length} disagreements</span></summary><div><p>One canonical attempt per task and date: the scheduled run, or on a day without one the only full run of that day. ${raw.excludedAttempts} on-demand or duplicate attempts in the exported ${raw.days.length}-day dataset are excluded from every number here; these are separate from infrastructure exclusions.</p><p>Rates use eligible task attempts, not Actors. Discovery selection uses the exported <code>found</code> field separately from the verdict. A pass means the task met this evaluation's checks, including expected-Actor requirements.</p><p>${tasks.filter(t=>t.skill==='find').length} discovery tasks and ${tasks.filter(t=>t.skill==='use').length} named tasks in this scope. Cost data is not included in this source export.</p><details><summary>Check/judge disagreements (${disagreements.length})</summary><ul>${disagreements.map(a=>`<li>${a.day} · ${esc(a.scenarioId)} · ${esc(a.judgeComment)} · <a href="${esc(a.traceUrl)}">Session</a></li>`).join('')}</ul></details></div></details><footer>Suite ${esc(raw.suite)} · generated ${esc(raw.generatedAt.replace('T',' ').slice(0,16))} UTC · one result per task per day<span><a href="${esc(raw.latestJsonUrl||'#')}">Data (JSON)</a></span></footer>`;
    return h;
  }
  return {render,state,canonical,actors,tally,dates};
}

function reportBoot(){
  var reportRaw=JSON.parse(document.getElementById('report-data').textContent); var reportApp=application(reportRaw); var main=document.getElementById('report');
  function draw(){var s=reportApp.state(location.hash);main.innerHTML=reportApp.render(s);var el=s.actor&&s.task?document.getElementById('evidence-'+s.task):s.compare?document.getElementById('transitions'):s.how?document.getElementById('how-measured'):null;if(el&&el.scrollIntoView)el.scrollIntoView({block:'start'});}
  if(location.hash)draw(); window.addEventListener('hashchange',draw);
  document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-history]');if(a){e.preventDefault();e.stopPropagation();location.hash=a.getAttribute('href').slice(1);}});
  document.addEventListener('toggle',function(e){if(e.target.matches&&e.target.matches('details.actor')){var s=reportApp.state(location.hash);if(e.target.open){s.actor=e.target.dataset.actor;}else if(s.actor===e.target.dataset.actor){s.actor='';}else{return;}history.replaceState(null,'','#'+new URLSearchParams(Object.entries(s).filter(function(kv){return kv[1]!==null&&kv[1]!==undefined&&kv[1]!=='';})));}},true);
}
if (typeof module !== 'undefined') module.exports = { application: application };
