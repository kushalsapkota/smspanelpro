'use strict';
const $=(s,r=document)=>r.querySelector(s);
const h=html=>{const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstChild;};
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let VIEW_TZ=localStorage.getItem('viewtz')||'Asia/Kathmandu';
let TZ_LIST=[['Asia/Kathmandu','Nepal — NPT (UTC+5:45)'],['UTC','UTC']];
const fdate=d=>{if(!d)return '—';try{return new Date(d).toLocaleString([], {timeZone:VIEW_TZ,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch(_){return new Date(d).toLocaleString();}};
const tzAbbr=tz=>({'Asia/Kathmandu':'NPT','UTC':'UTC','America/New_York':'ET','America/Chicago':'CT','America/Denver':'MT','America/Phoenix':'MST','America/Los_Angeles':'PT','America/Anchorage':'AKT','Pacific/Honolulu':'HST'}[tz]||tz);
const ymd=(d,tz)=>{try{return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}catch(_){return new Date(d).toISOString().slice(0,10);}};
const n2=n=>Number(n||0).toLocaleString();
const eur=n=>'€'+Number(n||0).toFixed(3);
async function api(p,o={}){const r=await fetch('/api'+p,{method:o.method||'GET',headers:{'Content-Type':'application/json'},body:o.body?JSON.stringify(o.body):undefined});let d=null;try{d=await r.json();}catch(_){}if(!r.ok)throw new Error(d&&d.error||('HTTP '+r.status));return d;}
function toast(m,e){const t=h(`<div class="toast ${e?'err':''}">${esc(m)}</div>`);document.body.appendChild(t);setTimeout(()=>t.remove(),2600);}
function copy(t){return `<span class="copy mono" onclick="navigator.clipboard.writeText('${esc(t)}');window.__t('Copied')">${esc(t)}</span>`;}
window.__t=toast;
function modal(title,body,onMount){const root=$('#modalRoot');const bg=h(`<div class="modal-bg"><div class="modal"><h3>${esc(title)}</h3><div class="mbody">${body}</div></div></div>`);bg.addEventListener('mousedown',e=>{if(e.target===bg)close();});root.appendChild(bg);function close(){bg.remove();}if(onMount)onMount($('.mbody',bg),close);return{close};}
const dlrBadge=s=>{const m={delivered:'green',accepted:'blue',undelivered:'red',pending:'gray',unknown:'gray'};return `<span class="badge ${m[s]||'gray'}">${esc(s)}</span>`;};
const stBadge=s=>{const m={sent:'green',submitted:'blue',failed:'red'};return `<span class="badge ${m[s]||'gray'}">${esc(s)}</span>`;};

let ME=null;
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#lerr').textContent='';try{await api('/login',{method:'POST',body:{username:$('#lu').value,password:$('#lp').value}});boot();}catch(err){$('#lerr').textContent=err.message;}});
$('#logout').onclick=async()=>{await api('/logout',{method:'POST'}).catch(()=>{});location.reload();};

function nav(){const items=[['dashboard','📊 Dashboard'],['send','✉️ Send SMS'],['logs','📨 Logs'],['usage','📅 Usage by date'],['billing','💳 Billing'],['invoices','🧾 Invoices'],['api','🔌 API'],['settings','⚙️ Settings']];if(ME.role==='reseller'){items.splice(7,0,['clients','🏢 My clients'],['bills','🧾 Bills']);}return items;}
const invStatusBadge=s=>{const m={paid:'green',partial:'yellow',unpaid:'gray',void:'red'};return `<span class="badge ${m[s]||'gray'}">${esc(s)}</span>`;};
function invoiceHtml(inv){
  return `<div class="row" style="margin-bottom:12px"><div class="card"><div class="k">Status</div><div class="v sm">${invStatusBadge(inv.status)}</div></div>
    <div class="card"><div class="k">Total</div><div class="v sm">${inv.total} ${esc(inv.currency)}</div></div>
    <div class="card"><div class="k">Paid</div><div class="v sm">${inv.paid||0}</div></div>
    <div class="card"><div class="k">Balance</div><div class="v sm">${(inv.total-(inv.paid||0)).toFixed(2)}</div></div></div>
  <p class="muted" style="font-size:12px">Issued ${fdate(inv.issued_date)}${inv.due_date?' · due '+fdate(inv.due_date):''}${inv.note?' · '+esc(inv.note):''}</p>
  <div class="table-wrap"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th style="text-align:right">Amount</th></tr></thead><tbody>${(inv.items||[]).map(it=>`<tr><td class="wrap">${esc(it.description)}</td><td>${it.qty}</td><td>${it.unit_price}</td><td style="text-align:right">${it.amount}</td></tr>`).join('')}
    <tr style="font-weight:700"><td colspan="3" style="text-align:right">Total</td><td style="text-align:right">${inv.total} ${esc(inv.currency)}</td></tr></tbody></table></div>
  ${(inv.payments&&inv.payments.length)?`<h3 style="margin:16px 0 8px;font-size:14px">Payments received</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Amount</th><th>Method</th><th>Ref</th></tr></thead><tbody>${inv.payments.map(p=>`<tr><td>${fdate(p.createdAt)}</td><td>${p.amount}</td><td>${esc(p.method)}</td><td>${esc(p.reference||'')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No payments recorded yet.</p>'}`;
}
async function boot(){
  try{ME=await api('/me');}catch(_){$('#login').style.display='grid';$('#app').style.display='none';return;}
  $('#login').style.display='none';$('#app').style.display='block';
  $('#who').innerHTML=`<b>${esc(ME.username)}</b> · ${ME.role}`;
  $('#balPill').innerHTML=`Balance <b>${eur(ME.credits)}</b>`;
  $('#nav').innerHTML=nav().map(([k,l])=>`<div class="nav-item" data-nav="${k}"><span class="ic">${l.split(' ')[0]}</span>${l.split(' ').slice(1).join(' ')}</div>`).join('');
  $('#nav').querySelectorAll('.nav-item').forEach(n=>n.onclick=()=>go(n.dataset.nav));
  await initTz();
  go('dashboard');
}
async function initTz(){
  try{const d=await api('/timezones');TZ_LIST=d.list||TZ_LIST;if(!localStorage.getItem('viewtz'))VIEW_TZ=d.user||d.panel||VIEW_TZ;}catch(_){}
  const sel=$('#tzSel');if(!sel)return;
  sel.innerHTML=TZ_LIST.map(([tz,label])=>`<option value="${esc(tz)}" ${tz===VIEW_TZ?'selected':''}>🌐 ${esc(label)}</option>`).join('');
  sel.onchange=()=>{VIEW_TZ=sel.value;localStorage.setItem('viewtz',VIEW_TZ);go(CUR);};
}
function setActive(k){$('#nav').querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.nav===k));const t={dashboard:'Dashboard',send:'Send SMS',logs:'Logs',usage:'Usage by date',billing:'Billing',invoices:'Invoices',api:'API',settings:'Settings',clients:'My clients',bills:'Bills'};$('#pageTitle').textContent=t[k]||k;}
let CUR='dashboard';
async function go(k){CUR=k;setActive(k);const v=$('#view');v.innerHTML='<p class="muted">Loading…</p>';try{await VIEWS[k](v);}catch(e){v.innerHTML=`<p class="err">${esc(e.message)}</p>`;}}
window.__goinv=()=>go('invoices');
const VIEWS={};

function logsTable(logs){if(!logs||!logs.length)return '<p class="muted">No messages.</p>';return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>From</th><th>To</th><th>Text</th><th>Parts</th><th>Status</th><th>DLR</th></tr></thead><tbody>${logs.map(l=>`<tr><td>${fdate(l.createdAt)}</td><td>${esc(l.source||'—')}</td><td>${esc(l.destination)}</td><td class="wrap">${esc((l.text||'').slice(0,40))}</td><td>${l.parts}</td><td>${stBadge(l.status)}</td><td>${dlrBadge(l.dlr_status)}</td></tr>`).join('')}</tbody></table></div>`;}

VIEWS.dashboard=async v=>{
  const d=await api('/dashboard');
  $('#balPill').innerHTML=`Balance <b>${eur(d.credits)}</b>`;
  const max=Math.max(1,...d.daily.map(x=>x.count));const bars=d.daily.slice().reverse();
  v.innerHTML=`<h2 class="title">Dashboard</h2>
  <div class="cards">
    <div class="card"><div class="ic">💳</div><div class="k">Credits</div><div class="v sm">${eur(d.credits)}</div></div>
    <div class="card"><div class="ic">📨</div><div class="k">Today</div><div class="v">${n2(d.todayCount)}</div></div>
    <div class="card"><div class="ic">✅</div><div class="k">Total sent</div><div class="v">${n2(d.sentCount)}</div></div>
    <div class="card"><div class="ic">💱</div><div class="k">Cost / SMS</div><div class="v sm">${eur(d.cost_per_sms)}</div></div>
    ${d.outstanding>0?`<div class="card" style="cursor:pointer" onclick="window.__goinv()"><div class="ic">🧾</div><div class="k">Outstanding invoices</div><div class="v sm" style="color:var(--yellow)">${n2(d.outstanding)} ${esc(d.currency||'')}</div></div>`:''}
  </div>
  <div class="grid2">
    <div class="panel"><h3>📡 Your SMPP connection</h3>
      <div class="row" style="margin-bottom:12px"><div class="card"><div class="k">Host</div><div class="v sm">${copy(d.smpp.host)}</div></div><div class="card"><div class="k">Port</div><div class="v sm">${copy(String(d.smpp.port))}</div></div></div>
      <p class="muted">system_id: ${copy(d.smpp.system_id)} — bind as transmitter / receiver / transceiver with your password. Or use the HTTP API (see API tab).</p>
    </div>
    <div class="panel"><h3>📈 Last 14 days</h3><div class="chart">${bars.map(b=>`<div class="bar" style="height:${Math.round(b.count/max*120)}px"><span>${b.count}</span></div>`).join('')||'<p class="muted">No data</p>'}</div><div class="chart-x">${bars.map(b=>`<div>${(b.day||'').slice(5)}</div>`).join('')}</div></div>
  </div>
  <div class="panel"><h3>📨 Recent</h3>${logsTable(d.recent)}</div>`;
};

VIEWS.send=async v=>{
  v.innerHTML=`<h2 class="title">Send SMS</h2><div class="panel" style="max-width:560px">
    <div class="field"><label>To (destination number)</label><input id="s_to" placeholder="9779800000000"/></div>
    <div class="field"><label>Message</label><textarea id="s_text" rows="4" placeholder="Your message…"></textarea></div>
    <div class="err" id="s_err"></div><div class="ok" id="s_ok"></div>
    <button class="primary" id="s_send">Send</button>
  </div>`;
  $('#s_send').onclick=async()=>{$('#s_err').textContent='';$('#s_ok').textContent='';try{const r=await api('/send',{method:'POST',body:{to:$('#s_to').value,text:$('#s_text').value}});$('#s_ok').textContent='Queued · message_id '+r.message_id;$('#s_text').value='';ME=await api('/me');$('#balPill').innerHTML=`Balance <b>${eur(ME.credits)}</b>`;}catch(e){$('#s_err').textContent=e.message;}};
};

VIEWS.logs=async v=>{
  v.innerHTML=`<h2 class="title">Logs</h2><div class="toolbar"><div class="field" style="flex:0 0 170px"><label>Destination</label><input id="f_d" placeholder="prefix"/></div><div class="field" style="flex:0 0 140px"><label>DLR</label><select id="f_l"><option value="">Any</option><option>delivered</option><option>undelivered</option><option>pending</option></select></div><button class="primary" id="go">Search</button></div><div id="lt"></div>`;
  const run=async()=>{const p=new URLSearchParams();if($('#f_d').value)p.set('dest',$('#f_d').value);if($('#f_l').value)p.set('dlr',$('#f_l').value);$('#lt').innerHTML='<div class="panel">'+logsTable(await api('/logs?'+p))+'</div>';};
  $('#go').onclick=run;run();
};

VIEWS.invoices=async v=>{
  const d=await api('/invoices');
  v.innerHTML=`<h2 class="title">Invoices ${d.outstanding>0?`<span class="badge yellow" style="font-size:13px">outstanding ${d.outstanding}</span>`:'<span class="badge green" style="font-size:13px">all settled</span>'}</h2>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Number</th><th>Issued</th><th>Due</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>${d.invoices.map(i=>`<tr><td class="mono">${esc(i.number)}</td><td>${fdate(i.issued_date)}</td><td>${i.due_date?fdate(i.due_date):'—'}</td><td>${i.total} ${esc(i.currency)}</td><td>${i.paid||0}</td><td>${invStatusBadge(i.status)}</td><td><button class="sm" data-v="${i._id}">View</button></td></tr>`).join('')||'<tr><td colspan="7" class="muted">No invoices.</td></tr>'}</tbody></table></div></div>`;
  v.querySelectorAll('[data-v]').forEach(b=>b.onclick=async()=>{const inv=await api('/invoices/'+b.dataset.v);modal('Invoice '+inv.number,invoiceHtml(inv)+`<div class="actions"><button id="cl">Close</button></div>`,(bb,c)=>{$('#cl',bb).onclick=c;});});
};
VIEWS.billing=async v=>{
  const t=await api('/transactions');
  v.innerHTML=`<h2 class="title">Billing history</h2><div class="panel"><div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Balance</th><th>Note</th></tr></thead><tbody>${t.map(x=>`<tr><td>${fdate(x.createdAt)}</td><td><span class="badge ${x.amount>=0?'green':'gray'}">${esc(x.type)}</span></td><td>${x.amount}</td><td>${x.balance_after}</td><td class="wrap">${esc(x.note)}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No transactions</td></tr>'}</tbody></table></div></div>`;
};

VIEWS.api=async v=>{
  const base=location.origin;
  v.innerHTML=`<h2 class="title">HTTP SMS API</h2>
  <div class="panel"><h3>🔑 Your API keys <button class="sm right" id="addkey">+ Generate key</button></h3>
    <p class="muted" style="font-size:12px">Authenticate with a key via the <span class="mono">X-API-Key</span> header — safer than sending your password, and you can revoke it anytime. The full key is shown once on creation (and copied to your clipboard).</p>
    <div id="keylist" class="table-wrap"></div></div>
  <div class="panel"><h3>Send a message</h3>
  <pre class="mono" style="background:var(--bg2);padding:16px;border-radius:10px;overflow:auto">curl -X POST ${base}/api/v1/sms/send \\
  -H 'X-API-Key: YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{"to":"9779800000000","text":"Hello from API"}'</pre>
  <p class="muted">Responses: <b>202</b> queued · <b>401</b> bad key · <b>402</b> insufficient credits · <b>403</b> template mismatch · <b>400</b> bad request. <span class="muted">(Legacy <span class="mono">x-api-user</span>/<span class="mono">x-api-pass</span> still works.)</span></p>
  </div>
  <div class="panel"><h3>Coverage</h3><pre class="mono" style="background:var(--bg2);padding:14px;border-radius:10px">GET ${base}/api/v1/sms/coverage</pre></div>`;
  const loadKeys=async()=>{
    const keys=await api('/apikeys');
    $('#keylist').innerHTML=`<table><thead><tr><th>Key</th><th>Label</th><th>Calls</th><th>Last used</th><th>State</th><th></th></tr></thead><tbody>${keys.map(k=>`<tr><td class="mono">${copy(k.key)}</td><td>${esc(k.label||'—')}</td><td>${n2(k.calls)}</td><td>${k.last_used_at?fdate(k.last_used_at):'never'}</td><td>${k.is_active?'<span class="badge green">active</span>':'<span class="badge gray">revoked</span>'}</td><td><button class="sm" data-tk="${k._id}" data-ak="${k.is_active?1:0}">${k.is_active?'Revoke':'Enable'}</button> <button class="sm danger" data-dk="${k._id}">Del</button></td></tr>`).join('')||'<tr><td colspan="6" class="muted">No keys yet — generate one to use the API.</td></tr>'}</tbody></table>`;
    $('#keylist').querySelectorAll('[data-tk]').forEach(x=>x.onclick=async()=>{await api('/apikeys/'+x.dataset.tk,{method:'PATCH',body:{is_active:x.dataset.ak!=='1'}});loadKeys();});
    $('#keylist').querySelectorAll('[data-dk]').forEach(x=>x.onclick=async()=>{if(confirm('Delete this API key? Apps using it will stop working.')){await api('/apikeys/'+x.dataset.dk,{method:'DELETE'});loadKeys();}});
  };
  $('#addkey').onclick=async()=>{const label=window.prompt('Label for this key (optional):')||'';const r=await api('/apikeys',{method:'POST',body:{label}});try{await navigator.clipboard.writeText(r.key);}catch(_){}toast('Key generated & copied: '+r.key.slice(0,14)+'…');loadKeys();};
  loadKeys();
};

VIEWS.usage=async v=>{
  const tzOpts=TZ_LIST.map(([tz,label])=>`<option value="${esc(tz)}" ${tz===VIEW_TZ?'selected':''}>${esc(label)}</option>`).join('');
  const to=ymd(new Date(),VIEW_TZ), from=ymd(new Date(Date.now()-29*864e5),VIEW_TZ);
  v.innerHTML=`<h2 class="title">📅 Usage by date</h2>
  <p class="muted">How much you sent on each date. History is kept permanently. Dates are bucketed in the selected timezone.</p>
  <div class="toolbar">
    <div class="field" style="flex:0 0 150px"><label>From</label><input id="us_from" type="date" value="${from}"/></div>
    <div class="field" style="flex:0 0 150px"><label>To</label><input id="us_to" type="date" value="${to}"/></div>
    <div class="field" style="flex:0 0 220px"><label>Timezone</label><select id="us_tz">${tzOpts}</select></div>
    <button class="primary" id="us_go">Run</button>
    <button id="us_csv">⬇ CSV</button>
  </div>
  <div id="us_out"></div>`;
  let LAST=[];
  const run=async()=>{
    const p=new URLSearchParams({from:$('#us_from').value,to:$('#us_to').value,tz:$('#us_tz').value});
    const d=await api('/usage?'+p);const rows=d.rows||[];LAST=rows;
    const tot=rows.reduce((a,r)=>({c:a.c+r.count,s:a.s+r.sent,f:a.f+r.failed,p:a.p+r.parts,cr:a.cr+r.credits}),{c:0,s:0,f:0,p:0,cr:0});
    $('#us_out').innerHTML=`<div class="panel"><div class="muted" style="margin-bottom:8px;font-size:12px">Buckets in <b>${esc(tzAbbr(d.tz))}</b> (${esc(d.tz)}) · ${rows.length} day(s)</div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Messages</th><th>Sent</th><th>Failed</th><th>Segments</th><th>Credits</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="mono">${esc(r.day)}</td><td>${n2(r.count)}</td><td><span class="badge green">${n2(r.sent)}</span></td><td>${r.failed?`<span class="badge red">${n2(r.failed)}</span>`:'0'}</td><td>${n2(r.parts)}</td><td>${eur(r.credits)}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No sends in this range.</td></tr>'}<tr style="font-weight:700;border-top:2px solid var(--border)"><td>Total</td><td>${n2(tot.c)}</td><td>${n2(tot.s)}</td><td>${n2(tot.f)}</td><td>${n2(tot.p)}</td><td>${eur(tot.cr)}</td></tr></tbody></table></div></div>`;
  };
  $('#us_go').onclick=run;
  $('#us_csv').onclick=()=>{const head='date,messages,sent,failed,segments,credits\n';const body=LAST.map(r=>[r.day,r.count,r.sent,r.failed,r.parts,r.credits].join(',')).join('\n');const blob=new Blob([head+body],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='my-usage.csv';a.click();};
  run();
};

VIEWS.settings=async v=>{
  const me=await api('/me');
  const tzOpts=TZ_LIST.map(([tz,label])=>`<option value="${esc(tz)}" ${me.timezone===tz?'selected':''}>${esc(label)}</option>`).join('');
  v.innerHTML=`<h2 class="title">Settings</h2>
  <div class="panel"><h3>🕑 Timezone</h3>
    <div class="row" style="align-items:flex-end"><div class="field" style="max-width:320px"><label>Your default timezone (reports &amp; dates)</label><select id="set_tz"><option value="">— panel default —</option>${tzOpts}</select></div><button class="sm" id="tzsave">Save</button> <span class="ok" id="tzok"></span></div>
    <p class="muted" style="font-size:12px;margin-top:6px">You can also switch your view live anytime from the 🌐 picker in the top bar.</p></div>
  <div class="grid2">
    <div class="panel"><h3>🪝 Delivery webhook</h3>
      <div class="field"><label>Webhook URL (we POST DLRs here)</label><input id="wh" value="${esc(me.webhook_url||'')}"/></div>
      <div class="field"><label>Default sender ID</label><input id="sid" value="${esc(me.default_sender_id||'')}"/></div>
      <button class="primary" id="ws">Save</button> <span class="ok" id="wok"></span>
    </div>
    <div class="panel"><h3>🔐 Change password</h3>
      <div class="field"><label>Current</label><input id="cp_c" type="password"/></div>
      <div class="field"><label>New</label><input id="cp_n" type="password"/></div>
      <div class="err" id="cpe"></div><div class="ok" id="cpo"></div>
      <button class="primary" id="cps">Update</button>
    </div>
  </div>`;
  $('#ws').onclick=async()=>{await api('/settings',{method:'POST',body:{webhook_url:$('#wh').value,default_sender_id:$('#sid').value}});$('#wok').textContent='Saved.';};
  $('#tzsave').onclick=async()=>{const tz=$('#set_tz').value;await api('/settings',{method:'POST',body:{timezone:tz}});$('#tzok').textContent='Saved.';if(tz){VIEW_TZ=tz;localStorage.setItem('viewtz',tz);const ts=$('#tzSel');if(ts)ts.value=tz;}};
  $('#cps').onclick=async()=>{$('#cpe').textContent='';$('#cpo').textContent='';try{await api('/change-password',{method:'POST',body:{current:$('#cp_c').value,next:$('#cp_n').value}});$('#cpo').textContent='Password updated.';}catch(e){$('#cpe').textContent=e.message;}};
};

// reseller
VIEWS.clients=async v=>{
  const list=await api('/reseller/clients');
  v.innerHTML=`<h2 class="title">My clients</h2><div class="section-actions"><button class="primary" id="nc">+ New client</button></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Username</th><th>Credits</th><th>Rate/credit</th><th></th></tr></thead><tbody>${list.map(c=>`<tr><td><b>${esc(c.username)}</b></td><td>${n2(c.credits)}</td><td>${c.rate_per_credit}</td><td><button class="sm" data-t="${c.id}">Top up</button></td></tr>`).join('')||'<tr><td colspan="4" class="muted">No clients yet</td></tr>'}</tbody></table></div></div>`;
  $('#nc').onclick=()=>modal('New client',`<div class="row"><div class="field"><label>Username</label><input id="cu"/></div><div class="field"><label>Password</label><input id="cpw" value="${Math.random().toString(36).slice(2,10)}"/></div></div><div class="row"><div class="field"><label>Cost per SMS (€)</label><input id="cc" type="number" step="0.001" value="1"/></div><div class="field"><label>Rate per credit (€)</label><input id="cr" type="number" step="0.001" value="1"/></div></div><div class="err" id="ce"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="cs">Create</button></div>`,(b,c)=>{b.querySelector('[data-x]').onclick=c;$('#cs',b).onclick=async()=>{try{await api('/reseller/clients',{method:'POST',body:{username:$('#cu',b).value,password:$('#cpw',b).value,cost_per_sms:$('#cc',b).value,rate_per_credit:$('#cr',b).value}});c();toast('Client created');go('clients');}catch(e){$('#ce',b).textContent=e.message;}};});
  v.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>modal('Top up client',`<div class="field"><label>Credits to transfer (from your balance)</label><input id="tc" type="number"/></div><div class="err" id="te"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="ts">Top up</button></div>`,(bb,cc)=>{bb.querySelector('[data-x]').onclick=cc;$('#ts',bb).onclick=async()=>{try{await api('/reseller/clients/'+b.dataset.t+'/topup',{method:'POST',body:{credits:Number($('#tc',bb).value)}});cc();toast('Topped up');go('clients');}catch(e){$('#te',bb).textContent=e.message;}};}));
};
VIEWS.bills=async v=>{
  const list=await api('/reseller/bills');
  v.innerHTML=`<h2 class="title">Client bills</h2><div class="panel"><div class="table-wrap"><table><thead><tr><th>When</th><th>Client</th><th>Credits</th><th>Rate</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>${list.map(b=>`<tr><td>${fdate(b.createdAt)}</td><td>${esc(b.client_username)}</td><td>${n2(b.credits)}</td><td>${b.rate}</td><td>${b.total}</td><td>${b.paid}</td><td><span class="badge ${b.status==='paid'?'green':b.status==='partial'?'yellow':'gray'}">${b.status}</span></td><td><button class="sm" data-p="${b._id}" data-t="${b.total}">Record payment</button></td></tr>`).join('')||'<tr><td colspan="8" class="muted">No bills</td></tr>'}</tbody></table></div></div>`;
  v.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>modal('Record payment',`<div class="field"><label>Amount received</label><input id="pa" type="number" value="${b.dataset.t}"/></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="ps">Save</button></div>`,(bb,cc)=>{bb.querySelector('[data-x]').onclick=cc;$('#ps',bb).onclick=async()=>{await api('/reseller/bills/'+b.dataset.p+'/pay',{method:'POST',body:{amount:Number($('#pa',bb).value)}});cc();toast('Recorded');go('bills');};}));
};

boot();
