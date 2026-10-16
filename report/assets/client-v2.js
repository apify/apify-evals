/* Report v2 client. Runs in the browser and, via vm, at build time to pre-render the default view. Design: ASTRA-REPORT workshop, 25 Sept 2026; model dimension from the Gemini workshop, 15 Oct 2026. */
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
  const url = a => a?.traceUrl ? (raw.traceBaseUrl||'') + a.traceUrl : '';
  const METRICS=[
    {id:'selection',label:'Expected Actor selected',help:'The agent used the expected Actor in a discovery task, whether or not the task passed.'},
    {id:'discovery',label:'Discovery tasks passed',help:"The agent chose an Actor and passed this task's evaluation, which also requires the expected Actor."},
    {id:'named',label:'Named-Actor tasks passed',help:"The prompt named an Actor, and the agent passed this task's evaluation."},
    {id:'model',label:'Model',help:'The agent model that ran the task. Models are configured as moving aliases (for example claude-haiku-latest), so the concrete version can change; the Model updates menu and the chart markers show when it did.'},
    {id:'counted',label:'Results counted',help:'These task results have a verdict that can be used in pass-rate calculations.'},
    {id:'notcounted',label:'Not counted',help:'A failure in the evaluation infrastructure prevented this task from counting.'},
    {id:'noresult',label:'No result',help:'An expected task has no recorded attempt or is still awaiting a verdict.'},
    {id:'failedchecks',label:'Failed checks',help:'These recorded checks failed in the selected attempt; the comments explain what each check tested.'},
    {id:'change',label:'Change',help:'Percentage points between the after and before fractions, shown only when both sides have at least 3 eligible results.'},
    {id:'fixarea',label:'Suggested fix area',help:"The judge's diagnosis of what to change first after a failed attempt. A suggestion, not a proven cause."},
    {id:'alternative',label:'Alternative reported',help:'In a discovery task that did not pass, the Actor the agent ran instead of the expected one, as recorded by the harness.'},
    {id:'marker',label:'Change marker',help:'A date you choose, such as the day a README fix went live. Results from that date on count as after; results before it count as before. The daily run is at 06:00 UTC, so a change made later in the day belongs on the next date.'}
  ];
  const metricDef = id => METRICS.find(m=>m.id===id) || {label:id,help:''};
  const metricHelp = m => m.id==='change'&&multi ? m.help+' With several models, only models with eligible results on both sides are pooled.' : m.help;
  const fixAreaDefs = raw.fixAreas || [];
  const fixAreaDef = id => fixAreaDefs.find(f=>f.id===id) || {id, label:id, description:''};
  const canonical = raw.observations;
  const days = raw.days.length ? raw.days.slice() : [...new Set(canonical.map(x=>x.day))].sort();
  const latest = days.at(-1);
  // Model slots: one per configured alias, in first-seen order. One slot renders exactly as the single-model page did.
  const PALETTE=['#255fc2','#14695e','#73469b','#b8641a','#2d7d9a'];
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const slots = (raw.models && raw.models.length ? raw.models : [{id:'unknown',label:'Model',firstDay:days[0]||'',resolvedByDay:{}}]).map((m,i)=>({...m,color:PALETTE[i%PALETTE.length],key:slug(m.label)}));
  const slotById = new Map(slots.map(m=>[m.id,m])), slotByKey = new Map(slots.map(m=>[m.key,m]));
  const multi = slots.length>1;
  const index = new Map(canonical.map(x=>[x.scenarioId+'|'+x.day+'|'+(x.model||slots[0].id),x]));
  const actors = [...new Set(raw.expected.map(t=>t.subject))].map(id=>({id,name:nice(id),team:raw.expected.find(t=>t.subject===id).owner,tasks:raw.expected.filter(t=>t.subject===id)}));
  const teams = [...new Set(actors.map(a=>a.team))].sort();
  const active = day => slots.filter(m=>m.firstDay<=day);
  /** Models in scope on a day: the selected one, or every model expected on that day. */
  const modelsFor = (s,day) => s.model ? [slotById.get(s.model)] : active(day);
  const get = (task,day,model) => index.get(task.id+'|'+day+'|'+model);
  /** Attempts of one task on one day across the models in scope, with their slot. */
  const attempts = (task,day,s) => modelsFor(s,day).map(m=>({m,a:get(task,day,m.id)}));
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
  const href = (s,extra={}) => { const o={...s,...extra}; if(o.model){o.model=slotById.get(o.model)?.key||'';} return '#'+new URLSearchParams(Object.entries(o).filter(([k,v])=>v!==null && v!==undefined && v!=='')); };
  const badge = (c,label) => `<span class="status ${c}"><b aria-hidden="true">${symbols[c]}</b> ${esc(label||names[c])}</span>`;
  /** Attempts of these tasks on these dates, models in scope, existing results only. */
  const listFor = (tasks,ds,s) => tasks.flatMap(t=>ds.flatMap(d=>attempts(t,d,s).map(x=>x.a).filter(Boolean)));
  function tally(tasks,ds,s) {
    const as=listFor(tasks,ds,s), ok=as.filter(valid), sel=as.filter(a=>selected(a)!==null);
    const total=tasks.length*ds.reduce((n,d)=>n+modelsFor(s,d).length,0);
    return {pass:ok.filter(a=>code(a)==='P').length,n:ok.length,sel:sel.filter(a=>selected(a)===1).length,sn:sel.length,infra:as.filter(a=>code(a)==='I').length,missing:total-as.filter(a=>code(a)!=='U').length,total};
  }
  /** A real calendar date in YYYY-MM-DD (UTC), else ''. */
  function validDate(v) {
    if(!v||!/^\d{4}-\d{2}-\d{2}$/.test(v))return '';
    const d=new Date(v+'T00:00:00Z');
    return Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==v?'':v;
  }
  function state(hash='') {
    const p=new URLSearchParams(hash.replace(/^#/,''));
    const m=multi&&slotByKey.has(p.get('model'))?slotByKey.get(p.get('model')).id:'';
    return {team:teams.includes(p.get('team'))?p.get('team'):'all',model:m,range:[7,28,90].includes(+p.get('range'))?+p.get('range'):7,actor:p.has('actor')?p.get('actor'):'',task:p.get('task')||'',day:p.get('day')||'',metric:p.get('metric')||'',how:p.get('how')==='1'?'1':'',mark:validDate(p.get('mark'))};
  }
  /** Latest-run status of an Actor over the models in scope: failing attempts first, then incomplete, then all passed. */
  function overall(actor,s) {
    const cs=actor.tasks.flatMap(t=>attempts(t,latest,s).map(x=>code(x.a)));
    const fails=cs.filter(c=>c==='F'||c==='W').length;
    return {bucket: fails?0:cs.every(c=>c==='P')?2:1, fails};
  }
  /** Days on which a model's resolved id, or the judge's, changed from the previous known one. */
  function moves(ds,s) {
    const out=[]; const ms=s.model?[slotById.get(s.model)]:slots;
    for(const m of ms){ let prev=null; for(const d of days){ const r=m.resolvedByDay?.[d]; if(!r)continue; if(prev&&r!==prev&&ds.includes(d))out.push({day:d,who:m.label,from:prev,to:r}); prev=r; } }
    let prev=null; for(const d of days){ const r=raw.judgeByDay?.[d]; if(!r)continue; if(prev&&r!==prev&&ds.includes(d))out.push({day:d,who:'Judge',from:prev,to:r}); prev=r; }
    return out.sort((a,b)=>a.day.localeCompare(b.day));
  }
  const short = id => String(id||'').replace(/^~?[^/]+\//,'');
  function modelsLine(ds,s) {
    // The tabs name the models and "How this is measured" carries the resolved ids; a move in the period opens from the window line.
    const mv=moves(ds,s);
    return mv.length?`<details class="line-menu"><summary>Model update${mv.length>1?'s':''} (${mv.length})</summary><div><p>Model update in this period: ${mv.map(x=>`${esc(x.who)} changed from ${esc(short(x.from))} to ${esc(short(x.to))} on ${esc(longDate(x.day))}`).join('; ')}.</p><p class="small">An alias such as ~anthropic/claude-haiku-latest moves when the provider releases a new model. Results before and after a move come from different models.</p></div></details>`:'';
  }
  function metricHelpMenu() {
    return `<details class="line-menu"><summary>What these numbers mean</summary><div><dl>${METRICS.filter(m=>multi||m.id!=='model').map(m=>`<dt>${esc(m.label)}</dt><dd>${esc(metricHelp(m))}</dd>`).join('')}</dl></div></details>`;
  }
  function chart(tasks,ds,skill,s) {
    const one = s.model||!multi ? (s.model?slotById.get(s.model):slots[0]) : null;
    const data=ds.map(day=>({day,...tally(tasks,[day],s)}));
    const last=data.at(-1), color=one?(one===slots[0]&&!multi?(skill==='find'?'#255fc2':'#784ab0'):one.color):'#607086';
    const x=i=>48+(data.length===1?240:i*480/(data.length-1)), y=v=>142-v*1.12;
    let svg=`<svg viewBox="0 0 560 216" role="group" aria-label="${skill==='find'?'Discovery':'Named task'} daily pass rate and coverage"><title>Daily rates with eligible evaluation counts. Exact values follow in the chart data table.</title>`;
    for(const n of [0,50,100]) svg+=`<line x1="48" y1="${y(n)}" x2="528" y2="${y(n)}" stroke="#e1e5eb"/><text x="35" y="${y(n)+4}" text-anchor="end">${n}%</text>`;
    const series=[];
    if(one){ series.push({field:'pass',denom:'n',color,dash:false,data,label:'passed'}); if(skill==='find')series.unshift({field:'sel',denom:'sn',color:'#66788e',dash:true,data,label:'selected expected Actor'}); }
    else for(const m of slots){ const ms={model:m.id}; series.push({field:'pass',denom:'n',color:m.color,dash:false,m,label:`passed on ${m.label}`,data:ds.map(day=>({day,...(m.firstDay<=day?tally(tasks,[day],ms):{pass:0,n:0,sel:0,sn:0,infra:0,missing:0,total:0})}))}); }
    for(const se of series){
      let seg=[];
      const flush=()=>{if(seg.length>1)svg+=`<polyline points="${seg.join(' ')}" fill="none" stroke="${se.color}" stroke-width="2.3" ${se.dash?'stroke-dasharray="5 4"':''}/>`;seg=[];};
      se.data.forEach((d,i)=>{if(!d[se.denom]){flush();return;}seg.push(`${x(i)},${y(d[se.field]/d[se.denom]*100)}`);});flush();
      se.data.forEach((d,i)=>{if(!d[se.denom])return; const tip=`${d.day}: ${d[se.field]}/${d[se.denom]} ${se.label}; ${d.n}/${d.total} eligible, ${d.infra} not counted, ${d.missing} no result`;
        svg+=`<a href="${esc(href(s,{day:d.day,metric:skill,model:se.m?se.m.id:s.model}))}" aria-label="${esc(tip)}"><circle cx="${x(i)}" cy="${y(d[se.field]/d[se.denom]*100)}" r="5" fill="${se.dash?'white':se.color}" stroke="${se.color}" stroke-width="2"><title>${esc(tip)}</title></circle></a>`;
      });
    }
    const step=data.length>1?480/(data.length-1):0;
    // Vertical markers: model moves (grey) and the reader's change marker (red). The line is
    // always visible; a short label appears on hover or focus. Markers on the same day share
    // one hover target. Details live in the Model updates menu and the change-marker form.
    const md=d=>d.slice(5).replace('-','/');
    const byDay=new Map();
    for(const mv of moves(ds,s)) if(!byDay.has(mv.day)) byDay.set(mv.day,[{label:`Model update ${md(mv.day)}`,stroke:'#607086'}]);
    if(s.mark) byDay.set(s.mark,[...(byDay.get(s.mark)||[]),{label:`Marker ${md(s.mark)}`,stroke:'#a63d27'}]);
    for(const [day,items] of byDay){
      const i=ds.indexOf(day); if(i<0)continue;
      const mx=i>0?x(i)-step/2:x(0)-10, w=Math.max(...items.map(t=>t.label.length))*6, anchor=mx-w/2<4?'start':mx+w/2>556?'end':'middle';
      svg+=`<g class="marker" tabindex="0"><title>${esc(items.map(t=>t.label).join(' · '))}</title><rect x="${mx-7}" y="4" width="14" height="168" fill="transparent"/>${items.map((t,k)=>`<line x1="${mx+(k?1.5:0)}" y1="22" x2="${mx+(k?1.5:0)}" y2="170" stroke="${t.stroke}" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${mx}" y="${k?20:9}" text-anchor="${anchor}" fill="${t.stroke}">${esc(t.label)}</text>`).join('')}</g>`;
    }
    data.forEach((d,i)=>{
      const width=Math.min(36,400/data.length);
      svg+=`<rect x="${x(i)-width/2}" y="164" width="${width}" height="6" rx="2" fill="#e1e5eb"/><rect x="${x(i)-width/2}" y="164" width="${d.total?width*d.n/d.total:0}" height="6" rx="2" fill="${color}"/>`;
      if(data.length<=7 || i===0 || i===data.length-1)svg+=`<text x="${x(i)}" y="185" text-anchor="middle">${d.n}/${d.total}</text><text x="${x(i)}" y="207" text-anchor="middle">${d.day.slice(5).replace('-','/')}</text>`;
    });
    svg+='</svg>';
    const exact = one
      ? `<details class="chart-values"><summary>Exact counts and coverage</summary><table><thead><tr><th>Date</th>${skill==='find'?'<th>Selected</th>':''}<th>Passed</th><th>Eligible</th><th>Not counted</th><th>No result</th></tr></thead><tbody>${data.map(d=>`<tr><td>${d.day}</td>${skill==='find'?`<td>${d.sel}/${d.sn}</td>`:''}<td>${d.pass}/${d.n}</td><td>${d.n}/${d.total}</td><td>${d.infra}</td><td>${d.missing}</td></tr>`).join('')}</tbody></table></details>`
      : `<details class="chart-values"><summary>Exact counts and coverage</summary><table><thead><tr><th>Date</th><th>Model</th><th>Resolved model</th>${skill==='find'?'<th>Selected</th>':''}<th>Passed</th><th>Eligible</th><th>Not counted</th><th>No result</th></tr></thead><tbody>${ds.flatMap(day=>active(day).map(m=>{const d=tally(tasks,[day],{model:m.id});return `<tr><td>${day}</td><td>${esc(m.label)}</td><td>${esc(short(m.resolvedByDay?.[day]||''))}</td>${skill==='find'?`<td>${d.sel}/${d.sn}</td>`:''}<td>${d.pass}/${d.n}</td><td>${d.n}/${d.total}</td><td>${d.infra}</td><td>${d.missing}</td></tr>`;})).join('')}</tbody></table></details>`;
    const key = one
      ? `<span style="--series:${color}">● Task passed</span>${skill==='find'?'<span class="dashed">○ Expected Actor selected</span>':''}`
      : series.map(se=>{const l=se.data.at(-1);return `<span style="--series:${se.color}">● ${esc(se.m.label)}${l.n?` ${Math.round(l.pass/l.n*100)}%`:''}</span>`;}).join('');
    return `<article class="chart"><div class="chart-top"><div><h3>${skill==='find'?'Discovery tasks':'Named-Actor tasks'}</h3><p>${skill==='find'?'The agent chooses an Actor.':'The prompt specifies the Actor.'}</p></div><div class="chart-stat">${last.n?Math.round(last.pass/last.n*100)+'%':'N/A'}<small>${last.pass}/${last.n} passed latest${one?'':' across models'}</small></div></div><div class="chart-key">${key}</div>${svg}<div class="coverage-caption">Bars: eligible / expected evaluations${one?'':' (all models)'}</div>${exact}</article>`;
  }
  /** Before/after the marker: per model, and pooled over the models with eligible results on both sides. */
  function beforeAfter(tasks,ds,s) {
    const mark=s.mark, before=ds.filter(d=>d<mark), after=ds.filter(d=>d>=mark);
    const find=tasks.filter(t=>t.skill==='find'), use=tasks.filter(t=>t.skill==='use');
    const ms=s.model?[slotById.get(s.model)]:slots;
    const side=(ts,dd,num,den,ms)=>{const c=tally(ts,dd,ms);const withResults=dd.filter(d=>tally(ts,[d],ms)[den]>0).length;return {num:c[num],den:c[den],days:withResults};};
    const row=(id,ts,num,den,unit)=>{
      const per=ms.map(m=>({m,before:side(ts,before,num,den,{model:m.id}),after:side(ts,after,num,den,{model:m.id})}));
      const pooledModels=per.filter(p=>p.before.den>0&&p.after.den>0);
      const sum=(k)=>pooledModels.reduce((acc,p)=>({num:acc.num+p[k].num,den:acc.den+p[k].den,days:Math.max(acc.days,p[k].days)}),{num:0,den:0,days:0});
      const b=sum('before'), a=sum('after');
      const enough=b.den>=3&&a.den>=3;
      const pp=enough?Math.round((a.num/a.den-b.num/b.den)*100):null;
      return {id,label:metricDef(id).label,unit,before:b,after:a,pp,per,pooledModels:pooledModels.map(p=>p.m)};
    };
    return {mark,before,after,rows:[row('selection',find,'sel','sn','selected'),row('discovery',find,'pass','n','passed'),row('named',use,'pass','n','passed')]};
  }
  const frac=x=>x.den?`${x.num}/${x.den}`:'No eligible results';
  function beforeAfterTable(tasks,ds,s) {
    const form=`<form class="marker-form" hidden><label>Change marker <input type="date" name="mark" min="${days[0]}" max="${latest}" value="${esc(s.mark)}"></label>${s.mark?`<a href="${esc(href(s,{mark:''}))}">Clear</a>`:''}</form>`;
    if(!s.mark)return `<section class="comparison before-after" aria-labelledby="before-after-title"><div class="comparison-head"><h2 id="before-after-title">Did a change help?</h2>${form}</div><p class="comparison-note">Pick the date a change went live (a README fix, a schema change) to compare results before and from that date. Any date between ${esc(longDate(days[0]))} and ${esc(longDate(latest))} works; it does not need to be a run date.</p></section>`;
    const span=dd=>dd.length?windowLabel(dd[0],dd.at(-1)):'none';
    const ba=beforeAfter(tasks,ds,s);
    const notes=[];
    if(s.mark<days[0])notes.push(`The marker is before the earliest loaded result (${longDate(days[0])}), so nothing can be compared.`);
    else if(s.mark>latest)notes.push(`The marker is after the latest loaded result (${longDate(latest)}), so nothing can be compared.`);
    else if(!ba.before.length)notes.push('No results before the marker in this period; choose a longer period to see the before side.');
    const showPer = multi && !s.model;
    const rows=ba.rows.map(r=>{
      const change=r.pp===null?(r.before.den&&r.after.den?'<span class="muted">too few results on one side</span>':'<span class="muted">—</span>'):`${r.pp>0?'+':r.pp<0?'−':''}${Math.abs(r.pp)} pp`;
      const perLine=showPer?`<small class="per-model">${r.per.map(p=>`${esc(p.m.label)} ${p.before.den?`${p.before.num}/${p.before.den}`:'—'} → ${p.after.den?`${p.after.num}/${p.after.den}`:'—'}`).join(' · ')}</small>`:'';
      const cell=(x,label)=>`<td><span class="comparison-field" aria-hidden="true">${label}</span>${frac(x)}${x.den?`<small class="days">${x.days} day${x.days===1?'':'s'}</small>`:''}</td>`;
      return `<tr><th scope="row" title="${esc(metricDef(r.id).help)}">${esc(r.label)}${perLine}</th>${cell(r.before,'Before')}${cell(r.after,'After')}<td><span class="comparison-field" aria-hidden="true">Change</span>${change}</td></tr>`;
    }).join('');
    const dayCounts=`Calendar: ${span(ba.before)} before, ${span(ba.after)} from the marker. Day counts in the cells are dates with eligible results for that measure`;
    const pooledNote=showPer?(()=>{const sets=[...new Set(ba.rows.map(r=>r.pooledModels.map(m=>m.label).join(', ')))].filter(Boolean);return sets.length?` Pooled over ${sets.join(' / ')}: only models with eligible results on both sides are pooled; the line under each measure shows every model.`:' No model has eligible results on both sides, so only the per-model lines apply.';})():'';
    return `<section class="comparison before-after" aria-labelledby="before-after-title"><div class="comparison-head"><h2 id="before-after-title">Before vs after ${esc(longDate(s.mark))}</h2>${form}</div><p class="comparison-note">${esc(dayCounts)}. Pooled over every eligible task result in the selected period; not matched by task.${esc(pooledNote)}</p>${notes.length?`<p class="comparison-note">${esc(notes.join(' '))}</p>`:''}<table class="comparison-table" aria-labelledby="before-after-title"><thead><tr><th scope="col">Measure</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Change</th></tr></thead><tbody>${rows}</tbody></table><p class="comparison-note comparison-foot">Results on the marked date count as after; the daily run is at 06:00 UTC, so a change made later in the day belongs on the next date. Percentage points are shown only when both sides have at least 3 eligible results. A changed scenario set shifts both sides. This comparison does not establish that the change caused the difference.</p></section>`;
  }
  function summary(scoped,current,s) {
    const st=scoped.map(a=>overall(a,s));
    const fail=st.filter(x=>x.bucket===0).length;
    let h;
    if(multi&&!s.model){
      const n=active(latest).length;
      const all=scoped.filter(a=>active(latest).every(m=>a.tasks.some(t=>['F','W'].includes(code(get(t,latest,m.id)))))).length;
      h=`<strong>${fail} of ${scoped.length} Actors had a failing task in the latest run</strong>${fail?` (${all} on all ${n} models, ${fail-all} on ${n===2?'1':'1 or '+(n-1)}). `:'. '}`;
    } else h=`<strong>${fail} of ${scoped.length} Actors had a failing task${s.model?' on '+esc(slotById.get(s.model).label):''} in the latest run.</strong> `;
    const unusable=current.total-current.n;
    if(unusable>0)h+=`${unusable} of ${current.total} task results in the latest run have no usable verdict. `;
    return h+'Expand an Actor for its evidence, fix areas and alternatives.';
  }
  const byTaskId = new Map(raw.expected.map(t=>[t.id,t]));
  const ourActors = new Set(raw.expected.map(t=>t.subject));
  /** Failed attempts (F or W after the infrastructure override) of these tasks on these dates, with the judge's fix areas and the alternatives the agent reported. */
  function patterns(tasks,ds,s) {
    const fails=listFor(tasks,ds,s).filter(a=>['F','W'].includes(code(a)));
    const areas=new Map(); let noFix=0;
    const alts=new Map(); let noActor=0;
    for(const a of fails){
      const t=byTaskId.get(a.scenarioId);
      const id=a.fixArea&&a.fixArea!=='none'?a.fixArea:null;
      if(!id)noFix++; else { const e=areas.get(id)||{id,n:0,subjects:new Set()}; e.n++; e.subjects.add(t?.subject); areas.set(id,e); }
      if(t?.skill!=='find')continue;
      const sc=a.subjectCalled;
      if(!sc||sc==='intended')continue;
      if(sc==='none'){noActor++;continue;}
      const e=alts.get(sc)||{id:sc,n:0,lost:new Map()}; e.n++; e.lost.set(t.subject,(e.lost.get(t.subject)||0)+1); alts.set(sc,e);
    }
    const byN=(x,y)=>y.n-x.n||x.id.localeCompare(y.id);
    return {failures:fails.length,noFix,areas:[...areas.values()].sort(byN),alts:[...alts.values()].sort(byN),noActor};
  }
  const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;
  /** One line for the Actor row: the plurality fix area over the period, ties listed. */
  function patternLine(a,ds,s) {
    const p=patterns(a.tasks,ds,s);
    if(!p.failures||!p.areas.length)return '';
    const top=p.areas[0].n, tops=p.areas.filter(x=>x.n===top);
    const label=tops.map(x=>fixAreaDef(x.id).label).join(', ');
    return `<span class="pattern" title="${esc(tops.map(x=>fixAreaDef(x.id).description).filter(Boolean).join(' '))}">Top suggested fix${tops.length>1?'es':''}: ${esc(label)} (${top}${tops.length>1?' each':''} of ${plural(p.failures,'failure')})</span>`;
  }
  function altLink(id){ return `<a href="https://apify.com/${esc(id)}" target="_blank" rel="noreferrer">${esc(id)}</a>${ourActors.has(id)?' <span class="ours">ours</span>':''}`; }
  /** Inside the Actor detail: before/after for this Actor, per model when several are in scope. */
  function markerLines(a,ds,s) {
    if(!s.mark)return '';
    const ba=beforeAfter(a.tasks,ds,s);
    const rows=ba.rows.filter(r=>r.id!=='selection'||a.tasks.some(t=>t.skill==='find'));
    const showPer=multi&&!s.model;
    return `<div class="marker-lines"><h5>Before vs after ${esc(longDate(s.mark))}</h5><ul class="pattern-list">${rows.map(r=>`<li><span>${esc(r.label)}${showPer?`<small class="per-model">${r.per.map(p=>`${esc(p.m.label)} ${p.before.den?`${p.before.num}/${p.before.den}`:'—'} → ${p.after.den?`${p.after.num}/${p.after.den}`:'—'}`).join(' · ')}</small>`:''}</span><b>${frac(r.before)} → ${frac(r.after)}</b></li>`).join('')}</ul></div>`;
  }
  function patternsBlock(a,ds,s) {
    const p=patterns(a.tasks,ds,s);
    const period=windowLabel(ds[0],ds.at(-1));
    if(!p.failures)return `<div class="patterns-detail"><div><h5>Over ${esc(period)}</h5><p class="small">No failed attempts in this period.</p></div>${markerLines(a,ds,s)}</div>`;
    const areas=p.areas.map(x=>`<li><span title="${esc(fixAreaDef(x.id).description)}">${esc(fixAreaDef(x.id).label)}</span><b>${x.n}</b></li>`).join('')+(p.noFix?`<li><span class="muted">No suggested fix recorded</span><b>${p.noFix}</b></li>`:'');
    const alts=p.alts.map(x=>`<li><span>${altLink(x.id)}</span><b>${x.n}</b></li>`).join('')+(p.noActor?`<li><span class="muted">No Actor reported</span><b>${p.noActor}</b></li>`:'');
    return `<div class="patterns-detail"><div><h5>Judge's suggested fix areas · ${plural(p.failures,'failed attempt')} over ${esc(period)}${multi&&!s.model?', all models':''}</h5><ul class="pattern-list">${areas}</ul><p class="small">Diagnoses, not proven causes. Read the evidence before changing the Actor.</p></div><div><h5>Alternatives the agent reported instead</h5>${alts?`<ul class="pattern-list">${alts}</ul>`:'<p class="small">None recorded on discovery tasks in this period.</p>'}</div>${markerLines(a,ds,s)}</div>`;
  }
  /** Worst code of a set: F beats W beats I beats U; all-W stays W. */
  const worst = cs => cs.includes('F')?'F':cs.includes('W')?'W':cs.includes('I')?'I':cs.includes('U')?'U':'P';
  function metric(a,tasks,ds,skill,s) {
    if(!tasks.length)return '<span class="muted">No task</span>';
    const c=tally(tasks,ds,s), kind=skill==='find'?'discovery':'named';
    const link=(txt,task,aria,cls='fail')=>`<a class="cell-note ${cls}" data-history="1" href="${esc(href(s,{actor:a.id,task:task.id,day:latest,metric:''}))}" aria-label="${esc(aria)}">${txt}</a>`;
    const counts=`<div class="counts">${c.pass}<span> / ${c.n} passed</span>${skill==='find'?`<br>${c.sel}<span> / ${c.sn} selected expected</span>`:`${tasks.length>1?`<br><span>${tasks.length} named tasks</span>`:''}`}</div>`;
    if(multi&&!s.model){
      const ms=active(latest);
      const perModel=ms.map(m=>{const cs=tasks.map(t=>code(get(t,latest,m.id)));return {m,c:worst(cs),fails:cs.filter(x=>x==='F'||x==='W').length,pass:cs.filter(x=>x==='P').length};});
      const eligible=perModel.filter(p=>['P','F','W'].includes(p.c)), passed=eligible.filter(p=>p.c==='P').length;
      const outcome=eligible.length?(passed===eligible.length?'P':worst(eligible.map(p=>p.c))):worst(perModel.map(p=>p.c));
      const word=eligible.length?(outcome==='P'?`Passed (${passed}/${eligible.length})`:`${passed}/${eligible.length} passed`):names[outcome];
      const pills=`<div class="model-pills">${perModel.map(p=>`<span class="pill ${p.c}" title="${esc(p.m.label+': '+names[p.c])}">${esc(p.m.label)} <b>${symbols[p.c]}</b></span>`).join('')}</div>`;
      const firstBad=perModel.find(p=>p.fails>0);
      let note='';
      if(firstBad){
        const failed=tasks.flatMap(t=>(get(t,latest,firstBad.m.id)?.failedChecks||[]).map(k=>({task:t,k})));
        const badTask=tasks.find(t=>['F','W'].includes(code(get(t,latest,firstBad.m.id))))||tasks[0];
        note=failed.length?link(`× ${failed.length} failed check${failed.length>1?'s':''} on ${esc(firstBad.m.label)}`,failed[0].task,`${failed.length} failed checks on ${firstBad.m.label}'s latest ${kind} tasks. Opens the evidence.`):link(`See judge's finding (${esc(firstBad.m.label)})`,badTask,`No recorded check failed on ${firstBad.m.label}; the judge's finding explains the outcome. Opens the evidence.`);
      } else if(outcome==='I')note=`<span class="cell-note muted" title="${esc(metricDef('notcounted').help)}">Test did not count</span>`;
      else if(outcome==='U')note=`<span class="cell-note muted" title="${esc(metricDef('noresult').help)}">Result pending or missing</span>`;
      return `${badge(outcome,word)}${pills}${counts}${note}`;
    }
    const now=tasks.map(t=>attempts(t,latest,s)[0]?.a), cs=now.map(code);
    const outcome=worst(cs);
    const word=tasks.length>1?`${now.filter(x=>code(x)==='P').length}/${tasks.length} passed latest`:names[outcome];
    const failed=now.flatMap((at,i)=>(at?.failedChecks||[]).map(k=>({task:tasks[i],k})));
    const firstBad=tasks.find((t,i)=>['F','W'].includes(cs[i]))||tasks[0];
    let note='';
    if(failed.length&&(outcome==='F'||outcome==='W'))note=link(`× ${failed.length} failed check${failed.length>1?'s':''}`,failed[0].task,`${failed.length} failed checks across this Actor's latest ${kind} tasks. Opens the evidence.`);
    else if(failed.length)note=link(`${failed.length} check${failed.length>1?'s':''} failed, task still passed`,failed[0].task,`${failed.length} recorded check${failed.length>1?'s':''} failed, but the task still passed. Opens the evidence.`,'muted');
    else if(outcome==='F'||outcome==='W')note=link("See judge's finding",firstBad,"No recorded check failed; the judge's finding explains the outcome. Opens the evidence.");
    else if(outcome==='I')note=`<span class="cell-note muted" title="${esc(metricDef('notcounted').help)}">Test did not count</span>`;
    else if(outcome==='U')note=`<span class="cell-note muted" title="${esc(metricDef('noresult').help)}">Result pending or missing</span>`;
    return `${badge(outcome,word)}${counts}${note}`;
  }
  /** One day cell of the track: the single attempt's code, or across models: all passed, all failed, or k/n with the split. */
  function dayCell(t,d,s) {
    const as=attempts(t,d,s);
    if(as.length<=1){const c=code(as[0]?.a);return {c,text:symbols[c],tip:`${t.title} · ${d} · ${names[c]}`};}
    const cs=as.map(x=>code(x.a)), el=cs.filter(c=>['P','F','W'].includes(c)), pass=el.filter(c=>c==='P').length;
    const tip=`${t.title} · ${d} · ${as.map(x=>`${x.m.label}: ${names[code(x.a)]}`).join(', ')}`;
    if(!el.length){const c=worst(cs);return {c,text:symbols[c],tip};}
    if(pass===el.length)return {c:'P',text:'✓',tip};
    if(pass===0){const c=worst(el);return {c,text:symbols[c],tip};}
    return {c:worst(el)+' mixed',text:`${pass}/${el.length}`,tip};
  }
  function history(a,ds,s) {
    const recent=ds.slice(-7);
    return `<div class="history"><div class="history-dates"><span class="track-name">Date</span>${recent.map(d=>`<span>${d.slice(-2)}</span>`).join('')}</div>${a.tasks.map((t,i)=>`<div class="track"><span class="track-name">${t.skill==='find'?'Discover':a.tasks.filter(x=>x.skill==='use').length>1?'Named '+(a.tasks.filter(x=>x.skill==='use').indexOf(t)+1):'Named'}</span>${recent.map(d=>{const cell=dayCell(t,d,s);return `<a class="day-cell ${cell.c}" data-history="1" href="${esc(href(s,{actor:a.id,task:t.id,day:d,metric:''}))}" title="${esc(cell.tip)}" aria-label="${esc(cell.tip)}">${cell.text}</a>`;}).join('')}</div>`).join('')}</div>`;
  }
  /** The two-column result of one attempt plus its session link. */
  function resultBody(t,at,c) {
    const checks=(at?.failedChecks||[]).map(k=>`<li><code>${esc(k)}</code><span>${esc(score(at,'check.'+k)?.comment||'Failed')}</span></li>`).join('');
    const diagnosis=score(at,'judge.fixArea')?.comment;
    const selectedText=t.skill==='find'?(selected(at)===1?'Expected Actor selected':selected(at)===0?'Expected Actor not selected':'Selection not measured'):'';
    return `<div class="evidence-columns"><div><h5>Observed result</h5><p>${esc(at?.judgeComment?.replace(/^(FAIL|PASS):\s*/, '')||(c==='P'?'The task passed; checks and judge agree.':c==='I'?(score(at,'check.infra')?.comment||'Infrastructure failure; excluded from rates.'):'No result is available for this date.'))}</p>${selectedText?`<p class="selection-note">${esc(selectedText)}</p>`:''}${at?.subjectCalled && at.subjectCalled!=='intended'?`<p class="small">Reported alternative: <code>${esc(at.subjectCalled)}</code></p>`:''}${checks?`<ul class="checks">${checks}</ul>`:''}</div><div><h5>Judge's suggested fix area</h5><p class="fix-area" title="${esc(at?.fixArea?fixAreaDef(at.fixArea).description:'')}">${esc(at?.fixArea==='none'?'None, nothing to fix':at?.fixArea?fixAreaDef(at.fixArea).label:'Not available')}</p><p class="small">${esc(diagnosis||(at&&c==='P'?'Nothing to add; the task passed.':'No additional diagnosis recorded.'))}</p>${score(at,'judge.disagreement')?.value===1?`<div class="disagreement">Check/judge disagreement. Hard checks: ${score(at,'check.all')?.value===1?'passed':score(at,'check.all')?.value===0?'failed':'not recorded'}. Task-completion rubric: ${score(at,'rubric.taskCompletion')?.value===1?'passed':'failed or unavailable'}.</div>`:''}</div></div><div class="evidence-foot">${url(at)?`<a href="${esc(url(at))}" target="_blank" rel="noreferrer">Open full session ↗</a>`:''}<details><summary>Task ID</summary><code>${esc(t.id)}</code></details></div>`;
  }
  function evidence(t,day,s,ds) {
    const taskLabel=t.skill==='find'?'Discovery task':'Named task';
    const as=attempts(t,day,s);
    const multiView=multi&&!s.model;
    const historyRows=[...ds].reverse().flatMap(d=>attempts(t,d,s).map(x=>{const c=code(x.a);return `<tr><td>${d}</td>${multiView?`<td>${esc(x.m.label)}</td>`:''}<td>${badge(c)}</td><td>${esc(x.a?.judgeComment||(c==='P'?'Passed':x.a?'No comment recorded':'No result'))}</td><td>${x.a?`<a href="${esc(url(x.a))}">Open</a>`:''}</td></tr>`;})).join('');
    const historyTable=`<details class="attempt-history"><summary>All ${ds.length} daily results for this task${multiView?', every model':''}</summary><table><thead><tr><th>Date</th>${multiView?'<th>Model</th>':''}<th>Outcome</th><th>Evidence</th><th>Session</th></tr></thead><tbody>${historyRows}</tbody></table></details>`;
    if(!multiView){
      const at=as[0]?.a, c=code(at);
      return `<article class="evidence${s.task===t.id?' selected-evidence':''}" id="evidence-${esc(t.id)}"><div class="evidence-title"><h4>${taskLabel}</h4>${badge(c)}<span class="muted">${esc(day)}</span></div><p class="task-prompt">${esc(t.prompt)}</p>${resultBody(t,at,c)}${historyTable}</article>`;
    }
    const codes=as.map(x=>code(x.a)), allPass=codes.every(c=>c==='P');
    const order=as.slice().sort((p,q)=>(['F','W','I','U','P'].indexOf(code(p.a)))-(['F','W','I','U','P'].indexOf(code(q.a))));
    const blocks=order.map(x=>{const c=code(x.a), resolved=x.m.resolvedByDay?.[day]; const head=`${badge(c)} <strong>${esc(x.m.label)}</strong>${resolved?` <span class="muted">${esc(short(resolved))}</span>`:''}`;
      if(c==='P'&&!allPass)return `<details class="model-result"><summary>${head}${url(x.a)?` · <a href="${esc(url(x.a))}" target="_blank" rel="noreferrer">Open full session ↗</a>`:''}</summary>${resultBody(t,x.a,c)}</details>`;
      return `<div class="model-result open"><div class="model-result-head">${head}</div>${resultBody(t,x.a,c)}</div>`;}).join('');
    return `<article class="evidence${s.task===t.id?' selected-evidence':''}" id="evidence-${esc(t.id)}"><div class="evidence-title"><h4>${taskLabel}</h4>${badge(allPass?'P':worst(codes),allPass?`Passed on all ${as.length}`:`${codes.filter(c=>c==='P').length}/${as.length} passed`)}<span class="muted">${esc(day)}</span></div><p class="task-prompt">${esc(t.prompt)}</p><div class="model-results">${blocks}</div>${historyTable}</article>`;
  }
  function render(s) {
    const ds=dates(s.range), scoped=actors.filter(a=>s.team==='all'||a.team===s.team), tasks=scoped.flatMap(a=>a.tasks), totals=tally(tasks,ds,s), current=tally(tasks,[latest],s);
    const st=new Map(scoped.map(a=>[a.id,overall(a,s)]));
    const ordered=scoped.slice().sort((a,b)=>a.team.localeCompare(b.team)||st.get(a.id).bucket-st.get(b.id).bucket||st.get(b.id).fails-st.get(a.id).fails||a.id.localeCompare(b.id));
    const modelTabs=multi?`<div class="model-tabs"><span>Model</span><a class="${s.model?'':'active'}" href="${esc(href(s,{model:'',actor:'',task:'',day:'',metric:''}))}" ${s.model?'':'aria-current="true"'}>All models</a>${slots.map(m=>`<a class="${s.model===m.id?'active':''}" href="${esc(href(s,{model:m.id,actor:'',task:'',day:'',metric:''}))}" ${s.model===m.id?'aria-current="true"':''}>${esc(m.label)}</a>`).join('')}</div>`:'';
    let h=`<header class="page-header"><div><p class="eyebrow">Apify · Agent evaluations</p><h1>Can agents find and use your Actors?</h1><p class="subtitle">Daily tests of selection and task completion${multi?', on '+slots.length+' agent models':''}.</p><a class="how-link" data-history="1" href="${esc(href(s,{how:'1'}))}">How this is measured</a></div><div class="freshness">Latest run <strong>${longDate(latest)}</strong><span>${current.n}/${current.total} eligible · ${current.infra} not counted · ${current.missing} no result${multi?` (${s.model?esc(slotById.get(s.model).label):active(latest).length+' models'})`:''}</span></div></header><nav class="scope" aria-label="Report scope"><div class="team-tabs">${['all',...teams].map(t=>`<a class="${t===s.team?'active':''}" href="${esc(href(s,{team:t,actor:'',task:'',day:'',metric:''}))}" ${t===s.team?'aria-current="true"':''}>${t==='all'?'All teams':cap(t)}</a>`).join('')}</div>${modelTabs}<div class="period"><span>Period</span>${[7,28,90].map(r=>`<a href="${esc(href(s,{range:r}))}" class="${r===s.range?'active':''}">${r} days</a>`).join('')}</div></nav><p class="summary">${summary(scoped,current,s)}</p><div class="window-line"><span>${windowLabel(ds[0],latest)} · ${ds.length} days available in this ${s.range}-day view</span>${metricHelpMenu()}${modelsLine(ds,s)}</div><section class="trends" aria-label="Trends">${chart(tasks.filter(t=>t.skill==='find'),ds,'find',s)}${chart(tasks.filter(t=>t.skill==='use'),ds,'use',s)}</section>`;
    if(s.metric && ds.includes(s.day)){
      const picked=tasks.filter(t=>t.skill===s.metric), stat=tally(picked,[s.day],s);
      h+=`<aside class="point-detail"><strong>${esc(s.day)} · ${s.metric==='find'?'Discovery':'Named'} tasks${s.model?' · '+esc(slotById.get(s.model).label):''}</strong><span>${stat.pass}/${stat.n} passed · ${stat.infra} not counted · ${stat.missing} no result</span><a href="${esc(href(s,{metric:'',day:''}))}">Clear date</a><div>${picked.map(t=>{const cell=dayCell(t,s.day,s);return `<a href="${esc(href(s,{actor:t.subject,task:t.id,metric:'',day:s.day}))}" title="${esc(cell.tip)}">${badge(cell.c.split(' ')[0],cell.text==='✓'||symbols[cell.c]?undefined:cell.text+' passed')} ${esc(nice(t.subject))}</a>`;}).join('')}</div></aside>`;
    }
    h+=beforeAfterTable(tasks,ds,s);
    h+=`<section class="actors-section" aria-labelledby="actors-title"><div class="section-title"><div><h2 id="actors-title">Actors <span>${scoped.length}</span></h2><p>Latest outcome first. Counts cover the selected period${multi&&!s.model?' and every model':''}.</p></div><div class="legend">${Object.keys(names).map(c=>`<span><i class="day-cell ${c}">${symbols[c]}</i>${names[c]}</span>`).join('')}${multi&&!s.model?'<span><i class="day-cell F mixed">2/3</i>Models disagreed</span>':''}</div></div><div class="column-head"><span>Actor</span><span>Discovery task</span><span>Named task</span><span>Recent outcomes <small class="date-head">${ds.slice(-7).map(d=>`<span>${d.slice(-2)}</span>`).join('')}</small></span></div><div class="actor-list">`;
    let previous='';
    for(const a of ordered){
      if(s.team==='all'&&a.team!==previous){h+=`<div class="team-divider">${cap(a.team)} <span>${scoped.filter(x=>x.team===a.team).length} Actors</span></div>`;previous=a.team;}
      const open=a.id===s.actor;
      const evidenceDay=t=>s.task===t.id&&ds.includes(s.day)?s.day:latest;
      h+=`<details class="actor" data-actor="${esc(a.id)}" id="actor-${a.id.replace(/[^a-z0-9]/gi,'-')}" ${open?'open':''}><summary class="actor-row"><div class="actor-name"><span class="chevron">›</span><div><strong>${esc(a.name)}</strong><span>${esc(a.team)}${a.tasks.length!==2?' · '+a.tasks.length+' tasks':''}</span>${patternLine(a,ds,s)}</div></div><div class="metric"><span class="mobile-label">Discovery</span>${metric(a,a.tasks.filter(t=>t.skill==='find'),ds,'find',s)}</div><div class="metric"><span class="mobile-label">Named task</span>${metric(a,a.tasks.filter(t=>t.skill==='use'),ds,'use',s)}</div>${history(a,ds,s)}</summary><div class="actor-detail"><div class="detail-heading"><span>Tasks and evidence</span><a href="https://apify.com/${esc(a.id)}" target="_blank" rel="noreferrer">${esc(a.id)} ↗</a></div>${patternsBlock(a,ds,s)}${a.tasks.map(t=>evidence(t,evidenceDay(t),s,ds)).join('')}</div></details>`;
    }
    const disagreements=listFor(tasks,ds,s).filter(a=>score(a,'judge.disagreement')?.value===1);
    const nFind=tasks.filter(t=>t.skill==='find').length, nUse=tasks.filter(t=>t.skill==='use').length;
    const judge=raw.judgeByDay?.[latest];
    const modelSentence=multi?`Each day, ${slots.length} agent models (${slots.map(m=>m.label).join(', ')}, configured as moving aliases through the OpenRouter proxy) each receive`:'Each day, an agent receives';
    h+=`</div></section><details class="how" id="how-measured" ${s.how?'open':''}><summary>How this is measured</summary><p>${modelSentence} ${nFind+nUse} tasks for ${scoped.length} Apify-maintained Actors${s.team==='all'?'':' owned by the '+cap(s.team)+' team'}: ${nFind} discovery tasks, where it chooses an Actor, and ${nUse} named tasks, where the prompt specifies one. Recorded checks and an AI judge${judge?` (${esc(short(judge))})`:''} assess the result. The judge reads the captured session and the check results. A pass means the task passed this evaluation, including any expected-Actor requirement.</p><p>We count one canonical attempt per task${multi?', model':''} and day: the scheduled run, or on a day without one the only full run of that day. Additional reruns are kept out of these rates. Failures in the evaluation infrastructure are shown separately as “not counted”.${multi?' A model counts as expected only from the first day it ran, so earlier days are not shown as missing results.':''}</p><h4>What these results cannot tell you</h4><ul><li>These are selected test tasks, not a sample of all customer requests.</li><li>One changed outcome does not prove that an Actor changed or that a fix worked.</li><li>Results can change when the agent${multi?' model version':''}, task, judge, checks, runner, or target website changes.${multi?' Model aliases move on their own; the models line and the chart markers show when.':''}</li><li>Choosing another maintained Actor can still be useful to the user; the expected-Actor check can nevertheless fail.</li><li>A judge's suggested fix area is an interpretation. Read the evidence before changing an Actor.</li></ul></details><details class="diagnostics"><summary><span>Evaluation diagnostics</span><span>${totals.n}/${totals.total} eligible · ${totals.infra} infrastructure exclusions · ${disagreements.length} disagreements</span></summary><div><p>One canonical attempt per task${multi?', model':''} and date: the scheduled run, or on a day without one the only full run of that day. ${raw.excludedAttempts} on-demand or duplicate attempts in the exported ${raw.days.length}-day dataset are excluded from every number here; these are separate from infrastructure exclusions.</p><p>Rates use eligible task attempts, not Actors. Discovery selection uses the exported <code>found</code> field separately from the verdict. A pass means the task met this evaluation's checks, including expected-Actor requirements.</p><p>${nFind} discovery tasks and ${nUse} named tasks in this scope. Cost data is not included in this source export.</p>${multi?`<p>Models in this export: ${slots.map(m=>`${esc(m.label)} (${esc(m.id)}, since ${esc(m.firstDay)})`).join('; ')}.${moves(days,{model:''}).length?` Resolved-model changes: ${moves(days,{model:''}).map(x=>`${esc(x.who)} ${esc(short(x.from))} → ${esc(short(x.to))} on ${x.day}`).join('; ')}.`:''}</p>`:''}<details><summary>Check/judge disagreements (${disagreements.length})</summary><ul>${disagreements.map(a=>`<li>${a.day} · ${esc(a.scenarioId)}${multi?' · '+esc(slotById.get(a.model)?.label||a.model):''} · ${esc(a.judgeComment)} · <a href="${esc(url(a))}">Session</a></li>`).join('')}</ul></details></div></details><footer>Suite ${esc(raw.suite)} · generated ${esc(raw.generatedAt.replace('T',' ').slice(0,16))} UTC · one result per task${multi?', model':''} and day<span><a href="${esc(raw.latestJsonUrl||'#')}">Data (JSON)</a></span></footer>`;
    return h;
  }
  return {render,state,canonical,actors,tally,dates,slots};
}

function reportBoot(){
  var reportRaw=JSON.parse(document.getElementById('report-data').textContent); var reportApp=application(reportRaw); var main=document.getElementById('report');
  function enableForms(){var fs=document.querySelectorAll('form.marker-form');for(var i=0;i<fs.length;i++)fs[i].hidden=false;}
  var scrolledTo='';
  function draw(){var s=reportApp.state(location.hash);main.innerHTML=reportApp.render(s);enableForms();var id=s.actor&&s.task?'evidence-'+s.task:s.how?'how-measured':'';var el=id?document.getElementById(id):null;
    // Scroll only when the target is new: a re-render for a filter or marker change keeps the reader where they are.
    if(el&&el.scrollIntoView&&id!==scrolledTo)el.scrollIntoView({block:'start'});scrolledTo=id;}
  if(location.hash)draw(); else enableForms(); window.addEventListener('hashchange',draw);
  function hashOf(s){var o={};for(var k in s)o[k]=s[k];if(o.model){var m=reportApp.slots.filter(function(x){return x.id===o.model;})[0];o.model=m?m.key:'';}return '#'+new URLSearchParams(Object.entries(o).filter(function(kv){return kv[1]!==null&&kv[1]!==undefined&&kv[1]!=='';}));}
  function applyMarker(f){var s=reportApp.state(location.hash);s.mark=f.elements.mark.value||'';location.hash=hashOf(s);}
  document.addEventListener('submit',function(e){var f=e.target;if(!(f.matches&&f.matches('form.marker-form')))return;e.preventDefault();applyMarker(f);});
  document.addEventListener('change',function(e){var el=e.target;if(el&&el.name==='mark'&&el.form&&el.form.matches('form.marker-form'))applyMarker(el.form);});
  document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-history]');if(a){e.preventDefault();e.stopPropagation();location.hash=a.getAttribute('href').slice(1);}});
  document.addEventListener('toggle',function(e){if(e.target.matches&&e.target.matches('details.actor')){var s=reportApp.state(location.hash);if(e.target.open){s.actor=e.target.dataset.actor;}else if(s.actor===e.target.dataset.actor){s.actor='';}else{return;}history.replaceState(null,'',hashOf(s));}},true);
}
if (typeof module !== 'undefined') module.exports = { application: application };
