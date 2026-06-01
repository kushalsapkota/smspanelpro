'use strict';
const $=(s,r=document)=>r.querySelector(s);
const h=html=>{const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstChild;};
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let VIEW_TZ=localStorage.getItem('viewtz')||'Asia/Kathmandu';
let TZ_LIST=[['Asia/Kathmandu','Nepal — NPT (UTC+5:45)'],['UTC','UTC']];
const fdate=d=>{if(!d)return '—';try{return new Date(d).toLocaleString([], {timeZone:VIEW_TZ,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch(_){return new Date(d).toLocaleString();}};
const tzAbbr=tz=>{const m={'Asia/Kathmandu':'NPT','UTC':'UTC','America/New_York':'ET','America/Chicago':'CT','America/Denver':'MT','America/Phoenix':'MST','America/Los_Angeles':'PT','America/Anchorage':'AKT','Pacific/Honolulu':'HST'};return m[tz]||tz;};
const n2=n=>Number(n||0).toLocaleString();
const eur=n=>'€'+Number(n||0).toFixed(3);
async function api(p,o={}){const r=await fetch('/api'+p,{method:o.method||'GET',headers:{'Content-Type':'application/json'},body:o.body?JSON.stringify(o.body):undefined});let d=null;try{d=await r.json();}catch(_){}if(!r.ok)throw new Error(d&&d.error||('HTTP '+r.status));return d;}
function toast(m,e){const t=h(`<div class="toast ${e?'err':''}">${esc(m)}</div>`);document.body.appendChild(t);setTimeout(()=>t.remove(),2600);}
function copy(t){return `<span class="copy mono" onclick="navigator.clipboard.writeText('${esc(t)}');window.__t('Copied')">${esc(t)}</span>`;}
window.__t=toast;
function modal(title,body,onMount){const root=$('#modalRoot');const bg=h(`<div class="modal-bg"><div class="modal"><h3>${esc(title)}</h3><div class="mbody">${body}</div></div></div>`);bg.addEventListener('mousedown',e=>{if(e.target===bg)close();});root.appendChild(bg);function close(){bg.remove();}if(onMount)onMount($('.mbody',bg),close);return{close};}
function prompt2(title,label,val,onSave){modal(title,`<div class="field"><label>${esc(label)}</label><input id="pv" value="${esc(val)}"/></div><div class="err" id="pe"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="ps">Save</button></div>`,(b,c)=>{b.querySelector('[data-x]').onclick=c;const i=$('#pv',b);i.focus();i.select();$('#ps',b).onclick=async()=>{try{await onSave(i.value);c();}catch(e){$('#pe',b).textContent=e.message;}};});}

const dlrBadge=s=>{const m={delivered:'green',accepted:'blue',undelivered:'red',rejected:'red',expired:'yellow',pending:'gray',unknown:'gray'};return `<span class="badge ${m[s]||'gray'}">${esc(s)}</span>`;};
const stBadge=s=>{const m={sent:'green',submitted:'blue',failed:'red',refunded:'yellow'};return `<span class="badge ${m[s]||'gray'}">${esc(s)}</span>`;};
const yn=b=>b?'<span class="badge green">yes</span>':'<span class="badge gray">no</span>';

const NAV=[
  ['MAIN',[['dashboard','📊 Dashboard'],['users','👥 Users'],['connections','🔌 Connections']]],
  ['ROUTING',[['routes','🛰️ Routes'],['rules','🧭 Routing rules']]],
  ['TRAFFIC',[['logs','📨 Logs / DLR'],['webhooks','🪝 Webhooks'],['analytics','📈 Analytics'],['usage','📅 Usage by date']]],
  ['TOOLS',[['test','🧪 SMS Tester']]],
  ['POLICY',[['blacklist','🚫 Blacklist'],['words','🔤 Blocked words'],['templates','📝 Templates']]],
  ['BUSINESS',[['invoices','🧾 Invoices'],['resellers','🏢 Resellers'],['bills','📑 Reseller bills']]],
  ['SYSTEM',[['status','🖥️ Status'],['settings','⚙️ Settings']]],
];
let ROUTES_CACHE=[];
let CONFIG={smppHost:'your-server-ip',smppPort:2775};
let _statusTimer=null;
function pass8(){const c='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';let p='';for(let i=0;i<8;i++)p+=c[Math.floor(Math.random()*c.length)];return p;}
function fmtBytes(b){b=Number(b||0);const u=['B','KB','MB','GB','TB'];let i=0;while(b>=1024&&i<u.length-1){b/=1024;i++;}return (b<10&&i>0?b.toFixed(1):Math.round(b))+' '+u[i];}
function fmtUptime(s){s=Math.floor(s||0);const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'d ':'')+(h?h+'h ':'')+m+'m';}

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#lerr').textContent='';try{await api('/login',{method:'POST',body:{username:$('#lu').value,password:$('#lp').value}});boot();}catch(err){$('#lerr').textContent=err.message;}});
$('#logout').onclick=async()=>{await api('/logout',{method:'POST'}).catch(()=>{});location.reload();};

async function boot(){
  let me;try{me=await api('/me');}catch(_){$('#login').style.display='grid';$('#app').style.display='none';return;}
  $('#login').style.display='none';$('#app').style.display='block';
  $('#who').innerHTML=`<b>${esc(me.username)}</b> · admin`;
  try{CONFIG=await api('/config');}catch(_){}
  $('#nav').innerHTML=NAV.map(([g,items])=>`<div class="nav-group">${g}</div>`+items.map(([k,l])=>`<div class="nav-item" data-nav="${k}"><span class="ic">${l.split(' ')[0]}</span>${l.split(' ').slice(1).join(' ')}</div>`).join('')).join('');
  $('#nav').querySelectorAll('.nav-item').forEach(n=>n.onclick=()=>go(n.dataset.nav));
  await initTz();
  go('dashboard');setInterval(refreshConnPill,8000);
}
async function initTz(){
  try{const d=await api('/timezones');TZ_LIST=d.list||TZ_LIST;if(!localStorage.getItem('viewtz'))VIEW_TZ=d.panel||VIEW_TZ;}catch(_){}
  const sel=$('#tzSel');if(!sel)return;
  sel.innerHTML=TZ_LIST.map(([tz,label])=>`<option value="${esc(tz)}" ${tz===VIEW_TZ?'selected':''}>🌐 ${esc(label)}</option>`).join('');
  sel.onchange=()=>{VIEW_TZ=sel.value;localStorage.setItem('viewtz',VIEW_TZ);go(CUR);};
}
function setActive(k){$('#nav').querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.nav===k));const t={dashboard:'Dashboard',users:'Users',connections:'Connections',routes:'Routes',rules:'Routing rules',logs:'Logs / DLR',analytics:'Analytics',blacklist:'Blacklist',words:'Blocked words',templates:'Templates',webhooks:'Webhooks',invoices:'Invoices',resellers:'Resellers',bills:'Reseller bills',status:'System status',settings:'Settings',test:'SMS Tester',usage:'Usage by date'};$('#pageTitle').textContent=t[k]||k;}
async function refreshConnPill(){try{const d=await api('/connections');$('#connPill').innerHTML=`<span class="dot ${d.length?'on':'off'}"></span><b>${d.length}</b> bound`;}catch(_){}}

let CUR='dashboard';
async function go(k){CUR=k;if(_statusTimer){clearInterval(_statusTimer);_statusTimer=null;}setActive(k);const v=$('#view');v.innerHTML='<p class="muted">Loading…</p>';try{await VIEWS[k](v);}catch(e){v.innerHTML=`<p class="err">${esc(e.message)}</p>`;}}

const VIEWS={};

VIEWS.dashboard=async v=>{
  const d=await api('/dashboard');
  $('#connPill').innerHTML=`<span class="dot ${d.activeConnections?'on':'off'}"></span><b>${d.activeConnections}</b> bound`;
  const daily=await api('/analytics/daily?days=14').catch(()=>[]);
  const max=Math.max(1,...daily.map(x=>x.count));
  const bars=daily.slice().reverse();
  v.innerHTML=`<h2 class="title">Dashboard</h2>
  <div class="cards">
    <div class="card"><div class="ic">👥</div><div class="k">Tenants</div><div class="v">${n2(d.users)}</div></div>
    <div class="card"><div class="ic">📨</div><div class="k">Messages today</div><div class="v">${n2(d.messagesToday)}</div></div>
    <div class="card"><div class="ic">✅</div><div class="k">Sent today</div><div class="v">${n2(d.sentToday)}</div></div>
    <div class="card"><div class="ic">🛰️</div><div class="k">Routes</div><div class="v">${n2(d.routes)}</div></div>
    <div class="card"><div class="ic">🔌</div><div class="k">Bound now</div><div class="v">${n2(d.activeConnections)}</div></div>
  </div>
  <div class="grid2">
    <div class="panel"><h3>📈 Traffic — last 14 days</h3>
      <div class="chart">${bars.map(b=>`<div class="bar" style="height:${Math.round(b.count/max*120)}px"><span>${b.count}</span></div>`).join('')||'<p class="muted">No data</p>'}</div>
      <div class="chart-x">${bars.map(b=>`<div>${(b.day||'').slice(5)}</div>`).join('')}</div>
    </div>
    <div class="panel"><h3>🩺 Route health</h3><div class="table-wrap"><table><thead><tr><th>Route</th><th>Avg ms</th><th>Fails</th><th>State</th></tr></thead><tbody id="rh"></tbody></table></div></div>
  </div>
  <div class="grid2">
    <div class="panel"><h3>🟢 Live activity <span class="right muted" style="font-size:12px">↻ live</span></h3><div id="livefeed" class="mono" style="font-size:12px;line-height:1.9;max-height:240px;overflow:auto">…</div></div>
    <div class="panel"><h3>📨 Recent messages <a class="right" onclick="window.__go('logs')">view all →</a></h3>${logsTable(d.recent)}</div>
  </div>`;
  const routes=await api('/routes');const hmap={};routes.forEach(r=>hmap[r.id]=r.name);
  $('#rh').innerHTML=Object.entries(d.routeHealth||{}).map(([id,hh])=>`<tr><td>${esc(hmap[id]||id.slice(-6))}</td><td>${hh.avgLatencyMs??'—'}</td><td>${hh.consecutiveFails}</td><td>${hh.suspended?'<span class="badge red">suspended</span>':'<span class="badge green">healthy</span>'}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">No traffic yet</td></tr>';
  const fmtEvent=e=>{const x=e.data||{};const t=new Date(e.at||e.ts||Date.now()).toLocaleTimeString();if(e.type==='bind')return `<span class="muted">${t}</span> 🔌 <b>${esc(x.username)}</b> bound (${esc(x.bindType||'')}) ${esc(x.ip||'')}`;if(e.type==='unbind')return `<span class="muted">${t}</span> ⏏ ${esc(x.username)} unbound`;if(e.type==='submit')return `<span class="muted">${t}</span> ➡️ ${esc(x.username)} → ${esc(x.dest)} <span class="muted">(${x.parts||1}p)</span>`;return `<span class="muted">${t}</span> ${esc(e.type)}`;};
  const refreshLive=async()=>{try{const l=await api('/live');const fl=$('#livefeed');if(fl)fl.innerHTML=(l.events||[]).map(fmtEvent).join('<br/>')||'<span class="muted">waiting for activity…</span>';}catch(_){}};
  refreshLive();_statusTimer=setInterval(refreshLive,3000);
};
window.__go=go;

// ---- Usage by date (timezone-aware, persistent history) ----
const ymd=(d,tz)=>{try{return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}catch(_){return new Date(d).toISOString().slice(0,10);}};
VIEWS.usage=async v=>{
  const users=await api('/users');
  const tzOpts=TZ_LIST.map(([tz,label])=>`<option value="${esc(tz)}" ${tz===VIEW_TZ?'selected':''}>${esc(label)}</option>`).join('');
  const to=ymd(new Date(),VIEW_TZ), from=ymd(new Date(Date.now()-29*864e5),VIEW_TZ);
  v.innerHTML=`<h2 class="title">📅 Usage by date</h2>
  <p class="muted">Per-user daily sending — how much each user sent on each date. History is kept permanently (unlike Logs, which expire after 7 days). Dates are bucketed in the selected timezone.</p>
  <div class="toolbar">
    <div class="field" style="flex:0 0 190px"><label>User</label><select id="us_u"><option value="">All users</option>${users.map(u=>`<option>${esc(u.username)}</option>`).join('')}</select></div>
    <div class="field" style="flex:0 0 150px"><label>From</label><input id="us_from" type="date" value="${from}"/></div>
    <div class="field" style="flex:0 0 150px"><label>To</label><input id="us_to" type="date" value="${to}"/></div>
    <div class="field" style="flex:0 0 220px"><label>Timezone</label><select id="us_tz">${tzOpts}</select></div>
    <button class="primary" id="us_go">Run</button>
    <button id="us_csv">⬇ CSV</button>
  </div>
  <div id="us_out"></div>`;
  const params=()=>{const p=new URLSearchParams({from:$('#us_from').value,to:$('#us_to').value,tz:$('#us_tz').value});if($('#us_u').value)p.set('username',$('#us_u').value);return p;};
  const run=async()=>{
    const d=await api('/usage/daily?'+params());const rows=d.rows||[];
    const tot=rows.reduce((a,r)=>({c:a.c+r.count,s:a.s+r.sent,f:a.f+r.failed,p:a.p+r.parts,cr:a.cr+r.credits}),{c:0,s:0,f:0,p:0,cr:0});
    $('#us_out').innerHTML=`<div class="panel"><div class="muted" style="margin-bottom:8px;font-size:12px">Buckets in <b>${esc(tzAbbr(d.tz))}</b> (${esc(d.tz)}) · ${rows.length} day(s)</div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Messages</th><th>Sent</th><th>Failed</th><th>Segments</th><th>Credits</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="mono">${esc(r.day)}</td><td>${n2(r.count)}</td><td><span class="badge green">${n2(r.sent)}</span></td><td>${r.failed?`<span class="badge red">${n2(r.failed)}</span>`:'0'}</td><td>${n2(r.parts)}</td><td>${eur(r.credits)}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No sends in this range.</td></tr>'}<tr style="font-weight:700;border-top:2px solid var(--border)"><td>Total</td><td>${n2(tot.c)}</td><td>${n2(tot.s)}</td><td>${n2(tot.f)}</td><td>${n2(tot.p)}</td><td>${eur(tot.cr)}</td></tr></tbody></table></div></div>`;
  };
  $('#us_go').onclick=run;
  $('#us_csv').onclick=()=>window.open('/api/usage/daily.csv?'+params(),'_blank');
  run();
};

// ---- SMS Tester ----
const _G7B="@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const _G7E="^{}\\[~]|€";
function segParts(text){if(!text)return{parts:0,enc:'GSM-7',chars:0,max:160};let g=true;for(const ch of text){if(_G7B.indexOf(ch)===-1&&_G7E.indexOf(ch)===-1){g=false;break;}}if(!g){const n=[...text].length;return{parts:n<=70?1:Math.ceil(n/67),enc:'UCS-2',chars:n,max:n<=70?70:67};}let len=0;for(const ch of text)len+=_G7E.indexOf(ch)!==-1?2:1;return{parts:len<=160?1:Math.ceil(len/153),enc:'GSM-7',chars:len,max:len<=160?160:153};}
const _TERMINAL=new Set(['delivered','accepted','undelivered','rejected','expired','unknown']);
VIEWS.test=async v=>{
  const [routes,users]=await Promise.all([api('/routes'),api('/users').catch(()=>[])]);
  const userOpts=users.map(u=>`<option value="${esc(u.username)}">${esc(u.username)} · ${eur(u.credits)}</option>`).join('')||'<option value="">— no users —</option>';
  const routeOpts=routes.map(r=>`<option value="${r.id}">${esc(r.name)} (${esc(r.type)})</option>`).join('')||'<option value="">— no routes —</option>';
  v.innerHTML=`<h2 class="title">🧪 SMS Tester</h2>
  <p class="muted">Send a real SMS to verify delivery. <b>Pipeline</b> runs the full client path (billing, policy, routing, log + DLR) — it shows up in Logs and charges the user. <b>Raw route</b> hits one provider directly, no billing or logging.</p>
  <div class="grid2">
    <div class="panel"><h3>Compose</h3>
      <div class="field"><label>Mode</label>
        <div class="row" style="gap:18px">
          <label class="rdo"><input type="radio" name="t_mode" value="pipeline" checked/> Full pipeline (bill + log + DLR)</label>
          <label class="rdo"><input type="radio" name="t_mode" value="raw"/> Raw route (direct)</label>
        </div>
      </div>
      <div class="field" id="t_userf"><label>Send as user</label><select id="t_user">${userOpts}</select></div>
      <div class="field" id="t_routef" style="display:none"><label>Route</label><select id="t_route">${routeOpts}</select></div>
      <div class="row">
        <div class="field"><label>To (destination)</label><input id="t_to" placeholder="9779812345678"/></div>
        <div class="field"><label>Sender ID (optional)</label><input id="t_sender" placeholder="BRIDGE"/></div>
      </div>
      <div class="field"><label>Message</label><textarea id="t_text" rows="4" placeholder="Type your test message…">Test from SMS Tester</textarea></div>
      <div class="muted" id="t_seg" style="font-size:12px;margin:-4px 0 10px"></div>
      <button class="primary" id="t_send">📤 Send live</button>
    </div>
    <div class="panel"><h3>Result</h3><div id="t_result"><p class="muted">No send yet. Fill the form and hit <b>Send live</b>.</p></div></div>
  </div>`;
  const seg=()=>{const s=segParts($('#t_text').value);$('#t_seg').textContent=`${s.chars} chars · ${s.enc} · ${s.parts} segment${s.parts===1?'':'s'} (${s.max}/segment)`;};
  $('#t_text').addEventListener('input',seg);seg();
  const setMode=()=>{const m=v.querySelector('input[name=t_mode]:checked').value;$('#t_userf').style.display=m==='pipeline'?'':'none';$('#t_routef').style.display=m==='raw'?'':'none';};
  v.querySelectorAll('input[name=t_mode]').forEach(r=>r.onchange=setMode);setMode();

  const card=html=>{$('#t_result').innerHTML=html;};
  let pollN=0;
  const pollLog=async logId=>{
    if(_statusTimer){clearInterval(_statusTimer);_statusTimer=null;}
    const tick=async()=>{
      pollN++;
      let l;try{l=await api('/test-sms/'+logId);}catch(_){return;}
      renderLog(l,true);
      if(_TERMINAL.has(l.dlr_status)||l.status==='failed'||pollN>16){if(_statusTimer){clearInterval(_statusTimer);_statusTimer=null;}}
    };
    pollN=0;_statusTimer=setInterval(tick,2500);tick();
  };
  const renderLog=(l,polling)=>{
    const pr=l.provider_response&&Object.keys(l.provider_response).length?`<pre class="mono mini">${esc(JSON.stringify(l.provider_response,null,2)).slice(0,800)}</pre>`:'';
    card(`<div class="kv"><span>Status</span>${stBadge(l.status)}</div>
      <div class="kv"><span>DLR</span>${dlrBadge(l.dlr_status)} ${polling&&!_TERMINAL.has(l.dlr_status)&&l.status!=='failed'?'<span class="muted">polling…</span>':''}</div>
      <div class="kv"><span>Segments</span><b>${l.parts}</b> · charged <b>${l.credits_used}</b></div>
      <div class="kv"><span>Route</span>${esc(l.route_name||'—')}</div>
      <div class="kv"><span>Message ID</span>${copy(l.message_id||'—')}</div>
      <div class="kv"><span>Provider ID</span>${copy(l.provider_message_id||'—')}</div>
      ${l.error?`<div class="kv"><span>Error</span><span class="err">${esc(l.error)}</span></div>`:''}
      ${pr}
      <p class="muted" style="margin-top:10px"><a onclick="window.__go('logs')">View in Logs →</a></p>`);
  };
  $('#t_send').onclick=async()=>{
    const mode=v.querySelector('input[name=t_mode]:checked').value;
    const body={mode,to:$('#t_to').value.trim(),text:$('#t_text').value,sender:$('#t_sender').value.trim()};
    if(!body.to)return toast('Enter a destination number',true);
    if(mode==='pipeline')body.username=$('#t_user').value;else body.route_id=$('#t_route').value;
    card('<p class="muted">⏳ Sending…</p>');
    const btn=$('#t_send');btn.disabled=true;
    try{
      const r=await api('/test-sms',{method:'POST',body});
      if(mode==='raw'){
        card(r.success
          ?`<div class="kv"><span>Result</span><span class="badge green">sent</span></div>
            <div class="kv"><span>Route</span>${esc(r.route_name||'—')}</div>
            <div class="kv"><span>Provider ID</span>${copy(r.messageId||'—')}</div>
            <div class="kv"><span>Latency</span>${r.latencyMs||0} ms</div>
            <pre class="mono mini">${esc(JSON.stringify(r.rawData||{},null,2)).slice(0,800)}</pre>`
          :`<div class="kv"><span>Result</span><span class="badge red">failed</span></div><div class="kv"><span>Error</span><span class="err">${esc(r.error||'unknown')}</span></div>`);
      }else if(!r.accepted){
        card(`<div class="kv"><span>Result</span><span class="badge red">rejected</span></div><div class="kv"><span>Reason</span><span class="err">${esc(r.reason||'rejected')}</span></div><p class="muted">The pipeline blocked this before sending (credits, policy, blacklist, dedup, or MPS).</p>`);
      }else{
        renderLog({status:r.dispatch.success?'sent':'failed',dlr_status:r.dispatch.success?'pending':'undelivered',parts:r.parts,credits_used:r.credits_used,route_name:r.route_name,message_id:r.messageId,provider_message_id:r.dispatch.providerId,error:r.dispatch.success?'':r.dispatch.error,provider_response:{}},true);
        if(r.dispatch.success)pollLog(r.logId);
      }
    }catch(e){card(`<div class="kv"><span>Result</span><span class="badge red">error</span></div><div class="kv"><span>Error</span><span class="err">${esc(e.message)}</span></div>`);}
    finally{btn.disabled=false;}
  };
};

function logsTable(logs){if(!logs||!logs.length)return '<p class="muted">No messages.</p>';return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>From</th><th>To</th><th>Text</th><th>Parts</th><th>Status</th><th>DLR</th><th>Route</th></tr></thead><tbody>${logs.map(l=>`<tr><td>${fdate(l.createdAt)}</td><td>${esc(l.username)}</td><td>${esc(l.source||'—')}</td><td>${esc(l.destination)}</td><td class="wrap">${esc((l.text||'').slice(0,40))}</td><td>${l.parts}</td><td>${stBadge(l.status)}</td><td>${dlrBadge(l.dlr_status)}</td><td>${esc(l.route_name||'—')}</td></tr>`).join('')}</tbody></table></div>`;}

VIEWS.users=async v=>{
  const [users,routes]=await Promise.all([api('/users'),api('/routes')]);ROUTES_CACHE=routes;
  v.innerHTML=`<h2 class="title">Users</h2><div class="section-actions"><button class="primary" id="nu">+ New user</button></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th><th>Credits</th><th>Cost/SMS</th><th>Plan</th><th>MPS</th><th>Route</th><th>Content</th><th>Conn</th><th>Status</th><th></th></tr></thead><tbody>${users.map(u=>`<tr>
    <td><b>${esc(u.username)}</b></td><td><span class="badge ${u.role==='admin'?'purple':u.role==='reseller'?'blue':'gray'}">${u.role}</span></td>
    <td>${eur(u.credits)}</td><td>${eur(u.cost_per_sms)}</td><td>${esc(u.plan_name)}</td><td>${u.max_mps}</td>
    <td><select class="rsel sm" data-u="${u.id}" style="min-width:150px;padding:4px 8px">${routeOptions(routes,u.route_id)}</select></td>
    <td>${u.bypass_template?'<span class="badge gray">passthrough</span>':(u.templates&&u.templates.length?'<span class="badge purple">auto-template</span>':'<span class="badge blue">whitelist</span>')}</td>
    <td><span class="dot ${u.is_connected?'on':'off'}"></span></td>
    <td>${u.is_suspended?'<span class="badge red">suspended</span>':u.is_active?'<span class="badge green">active</span>':'<span class="badge gray">off</span>'}</td>
    <td><button class="sm" data-m="${u.id}">Manage</button></td></tr>`).join('')}</tbody></table></div></div>`;
  $('#nu').onclick=()=>userModal(routes);
  v.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>userDetail(b.dataset.m,routes));
  v.querySelectorAll('.rsel').forEach(s=>s.onchange=async()=>{try{await api('/users/'+s.dataset.u,{method:'PATCH',body:{route_id:s.value||null}});toast('Route updated');}catch(e){toast(e.message,true);}});
};
function routeOptions(routes,sel){return `<option value="">— none —</option>`+routes.map(r=>`<option value="${r.id}" ${String(sel)===r.id?'selected':''}>${esc(r.name)} (${esc(r.type)})</option>`).join('');}

// Reusable content-mode (auto-templating) picker — shared by create + policy editor.
function contentModeFields(cur){
  cur=cur||{};const mode=cur.bypass_template?'pass':(cur.templates&&cur.templates.length?'inject':'white');
  const opt=(v,l)=>`<label class="switch" style="flex:1;border:1px solid var(--border);padding:9px;border-radius:9px;justify-content:center">${''}<input type="radio" name="cmode" value="${v}" ${mode===v?'checked':''}/> ${l}</label>`;
  return `<div class="field"><label>Content mode</label><div class="row" style="gap:8px">${opt('pass','Passthrough')}${opt('inject','Auto-template')}${opt('white','Whitelist')}</div></div>
  <div class="cmodeHelp muted" style="font-size:12px;margin:-4px 0 10px"></div>
  <div class="field" id="injectBox" style="display:none"><label>Auto-template messages — one per line. The client sends only the code (any length — <b>4 / 6 / 8 digits</b>); the gateway picks a template (round-robin) and inserts it. Placeholder: <b>{{code}}</b>, <b>{otp}</b>, a run of <b>X</b>'s (XXXX) or <b>#</b>'s — expands to whatever length the code is.</label>
    <textarea id="u_tpls" rows="4" placeholder="Your verification code is {{code}}. Valid for 5 min.">${esc((cur.templates||[]).join('\n'))}</textarea></div>`;}
// Mirror of engine.injectCode for the live preview.
function injectCodeClient(tpl,code){return String(tpl).replace(/\{\{\s*(code|otp|pin)\s*\}\}/gi,code).replace(/\{\s*(code|otp|pin)\s*\}/gi,code).replace(/X{3,}/gi,code).replace(/#{3,}/g,code);}
function wireContentMode(b){
  const help={pass:'Passthrough — sent exactly as the client submits it.',inject:'Auto-template — client sends only a code; the gateway wraps it in your branded template (you control the wording).',white:'Whitelist — message must match an approved Template (Policy → Templates), else blocked.'};
  const upd=()=>{const m=b.querySelector('input[name=cmode]:checked').value;b.querySelector('#injectBox').style.display=m==='inject'?'block':'none';b.querySelector('.cmodeHelp').textContent=help[m];};
  b.querySelectorAll('input[name=cmode]').forEach(r=>r.onchange=upd);upd();
}
function readContentMode(b){const m=b.querySelector('input[name=cmode]:checked').value;if(m==='inject')return{bypass_template:false,templates:$('#u_tpls',b).value.split('\n').map(s=>s.trim()).filter(Boolean)};return{bypass_template:m==='pass',templates:[]};}

function userModal(routes){modal('New user',`
  <div class="row"><div class="field"><label>Username *</label><input id="u_user"/></div><div class="field"><label>Password * (exactly 8 chars)</label><input id="u_pass" maxlength="8" value="${pass8()}"/></div></div>
  <div class="field"><label>📡 Route (where this user's SMS go)</label><select id="u_route" style="font-weight:600">${routeOptions(routes)}</select></div>
  <div class="field"><label>🔒 Allowed IP(s) — client can bind ONLY from these (comma-separated; blank = any IP)</label><input id="u_ips" placeholder="e.g. 203.0.113.7, 198.51.100.4"/></div>
  <div class="row"><div class="field"><label>Initial balance (€)</label><input id="u_cr" type="number" step="0.001" value="0"/></div><div class="field"><label>Price per SMS (€)</label><input id="u_cost" type="number" step="0.001" value="1"/></div></div>
  ${contentModeFields({bypass_template:true})}
  <details><summary class="muted" style="cursor:pointer;margin:6px 0">Advanced (role, plan, MPS, backup route, IPs)</summary>
    <div class="row"><div class="field"><label>Role</label><select id="u_role"><option value="client">client</option><option value="reseller">reseller</option><option value="admin">admin</option></select></div>
    <div class="field"><label>Plan</label><select id="u_plan"><option>standard</option><option>gold</option></select></div>
    <div class="field"><label>Max MPS</label><input id="u_mps" type="number" value="10"/></div></div>
    <div class="field"><label>Backup route (failover)</label><select id="u_broute">${routeOptions(routes)}</select></div>
    <div class="field"><label>Default sender ID</label><input id="u_sender"/></div>
  </details>
  <div class="err" id="u_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="u_save">Create</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;wireContentMode(b);
    $('#u_save',b).onclick=async()=>{try{if($('#u_pass',b).value.length!==8){$('#u_err',b).textContent='Password must be exactly 8 characters';return;}const cm=readContentMode(b);await api('/users',{method:'POST',body:{username:$('#u_user',b).value,password:$('#u_pass',b).value,role:$('#u_role',b).value,plan_name:$('#u_plan',b).value,credits:$('#u_cr',b).value,cost_per_sms:$('#u_cost',b).value,max_mps:$('#u_mps',b).value,route_id:$('#u_route',b).value||null,backup_route_id:$('#u_broute',b).value||null,allowed_ips:$('#u_ips',b).value,default_sender_id:$('#u_sender',b).value,bypass_template:cm.bypass_template,templates:cm.templates}});c();toast('User created');go('users');}catch(e){$('#u_err',b).textContent=e.message;}};});}

async function userDetail(id,routes){
  const u=await api('/users/'+id);
  modal('User: '+u.username,`
  <div class="cards" style="grid-template-columns:1fr 1fr 1fr">
    <div class="card"><div class="k">Balance</div><div class="v sm">${eur(u.credits)}</div></div>
    <div class="card"><div class="k">Price/SMS</div><div class="v sm">${eur(u.cost_per_sms)}</div></div>
    <div class="card"><div class="k">MPS</div><div class="v sm">${u.max_mps}</div></div>
  </div>
  <div class="section-actions">
    <button class="sm" id="d_top">Top up / adjust</button>
    <button class="sm" id="d_route">Route</button>
    <button class="sm" id="d_susp">${u.is_suspended?'Unsuspend':'Suspend'}</button>
    <button class="sm" id="d_pw">Reset password</button>
    <button class="sm" id="d_tpl">Auto-template / policy</button>
    ${u.is_connected?'<button class="sm danger" id="d_drop">Drop connection</button>':''}
  </div>
  <div class="panel"><h3>🔌 SMPP connection details <button class="sm right" id="copyall">📋 Copy all</button></h3>
    <div class="cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:10px">
      <div class="card"><div class="k">Host</div><div class="v sm">${copy(CONFIG.smppHost)}</div></div>
      <div class="card"><div class="k">Port</div><div class="v sm">${copy(String(CONFIG.smppPort))}</div></div>
      <div class="card"><div class="k">system_id</div><div class="v sm">${copy(u.username)}</div></div>
      <div class="card"><div class="k">Password</div><div class="v sm muted" style="font-size:13px">set by admin · <a id="pwreset" style="cursor:pointer">reset</a></div></div>
    </div>
    <p class="muted" style="font-size:12px">Bind type: transmitter / receiver / transceiver · Allowed IPs: <b>${u.allowed_ips&&u.allowed_ips.length?esc(u.allowed_ips.join(', ')):'any'}</b> · Content mode: <b>${u.bypass_template?'passthrough':(u.templates&&u.templates.length?'auto-template':'whitelist')}</b></p></div>
  <div class="panel"><h3>Recent transactions</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Balance</th><th>Note</th></tr></thead><tbody>${(u.transactions||[]).map(t=>`<tr><td>${fdate(t.createdAt)}</td><td>${esc(t.type)}</td><td>${t.amount}</td><td>${t.balance_after}</td><td class="wrap">${esc(t.note)}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">none</td></tr>'}</tbody></table></div></div>
  <div class="panel"><h3>🕑 Timezone <span class="muted" style="font-size:12px;font-weight:400">— this user's report/panel default</span></h3>
    <div class="row" style="align-items:flex-end"><div class="field" style="max-width:300px"><label>Timezone</label><select id="d_tz"><option value="">— panel default —</option>${TZ_LIST.map(([tz,label])=>`<option value="${esc(tz)}" ${u.timezone===tz?'selected':''}>${esc(label)}</option>`).join('')}</select></div><button class="sm" id="d_tzsave">Save</button></div></div>
  <div class="panel"><h3>⚠️ Low-balance alert</h3>
    <div class="row" style="align-items:flex-end"><div class="field" style="max-width:240px"><label>Alert when balance ≤ (€)</label><input id="d_thr" type="number" step="0.001" value="${u.low_balance_threshold!=null?u.low_balance_threshold:''}" placeholder="uses global default"/></div><button class="sm" id="d_thrsave">Save</button> <span class="ok" id="d_throk"></span></div>
    <p class="muted" style="font-size:12px;margin-top:6px">Current balance <b>${eur(u.credits)}</b>. When it drops to/under this, a Telegram alert fires (operator bot + this client's own bot if set). Blank = use the global threshold in Settings. Requires the System Telegram bot to be configured.</p></div>
  <div class="panel"><h3>🔑 API keys <button class="sm right" id="d_addkey">+ Generate key</button></h3>
    <p class="muted" style="font-size:12px">Public HTTP API: <span class="mono">POST ${esc(location.protocol)}//${esc(location.hostname)}:4000/api/v1/sms/send</span> with header <span class="mono">X-API-Key: &lt;key&gt;</span> and JSON <span class="mono">{"to":"977…","text":"…"}</span></p>
    <div id="keylist" class="table-wrap"></div></div>
  <div class="panel"><h3>Recent messages</h3>${logsTable(u.recentMessages)}</div>`,
  (b,c)=>{const reload=()=>{c();userDetail(id,routes);};
    $('#copyall',b).onclick=()=>{const txt=`SMPP connection — ${u.username}\nHost: ${CONFIG.smppHost}\nPort: ${CONFIG.smppPort}\nsystem_id: ${u.username}\npassword: (set by admin)\nbind: transceiver`;navigator.clipboard.writeText(txt);toast('Connection details copied');};
    if($('#pwreset',b))$('#pwreset',b).onclick=()=>prompt2('Reset bind password','New password',pass8(),async val=>{await api('/users/'+id+'/password',{method:'POST',body:{password:val}});navigator.clipboard.writeText(val);toast('Password set & copied: '+val);});
    $('#d_top',b).onclick=()=>prompt2('Top up / adjust','Amount (negative to deduct)','',async val=>{const r=await api('/users/'+id+'/topup',{method:'POST',body:{amount:Number(val)}});toast('Balance: '+r.balance);reload();});
    $('#d_route',b).onclick=()=>modal('Set routes',`<div class="field"><label>Primary route</label><select id="pr">${routeOptions(routes,u.route_id)}</select></div><div class="field"><label>Backup route</label><select id="br">${routeOptions(routes,u.backup_route_id)}</select></div><div class="field"><label>Plan</label><select id="pl"><option ${u.plan_name==='standard'?'selected':''}>standard</option><option ${u.plan_name==='gold'?'selected':''}>gold</option></select></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="rs">Save</button></div>`,(bb,cc)=>{bb.querySelector('[data-x]').onclick=cc;$('#rs',bb).onclick=async()=>{await api('/users/'+id,{method:'PATCH',body:{route_id:$('#pr',bb).value||null,backup_route_id:$('#br',bb).value||null,plan_name:$('#pl',bb).value}});toast('Saved');cc();reload();};});
    $('#d_susp',b).onclick=async()=>{await api('/users/'+id,{method:'PATCH',body:{is_suspended:!u.is_suspended}});toast('Updated');reload();};
    $('#d_pw',b).onclick=()=>prompt2('Reset password','New password',pass8(),async val=>{await api('/users/'+id+'/password',{method:'POST',body:{password:val}});toast('Password reset');});
    $('#d_tpl',b).onclick=()=>policyModal(u,reload);
    if($('#d_drop',b))$('#d_drop',b).onclick=async()=>{await api('/users/'+id+'/drop',{method:'POST'});toast('Drop command queued');};
    $('#d_tzsave',b).onclick=async()=>{await api('/users/'+id,{method:'PATCH',body:{timezone:$('#d_tz',b).value}});toast('Timezone saved');};
    $('#d_thrsave',b).onclick=async()=>{const raw=$('#d_thr',b).value.trim();const val=raw===''?null:Number(raw);await api('/users/'+id,{method:'PATCH',body:{low_balance_threshold:val}});$('#d_throk',b).textContent='Saved.';toast('Low-balance threshold saved');};
    const loadKeys=async()=>{
      const keys=await api('/users/'+id+'/apikeys');
      $('#keylist',b).innerHTML=`<table><thead><tr><th>Key</th><th>Label</th><th>Calls</th><th>Last used</th><th>State</th><th></th></tr></thead><tbody>${keys.map(k=>`<tr><td class="mono">${copy(k.key)}</td><td>${esc(k.label||'—')}</td><td>${n2(k.calls)}</td><td>${k.last_used_at?fdate(k.last_used_at):'never'}</td><td>${k.is_active?'<span class="badge green">active</span>':'<span class="badge gray">revoked</span>'}</td><td><button class="sm" data-tk="${k._id}" data-ak="${k.is_active?1:0}">${k.is_active?'Revoke':'Enable'}</button> <button class="sm danger" data-dk="${k._id}">Del</button></td></tr>`).join('')||'<tr><td colspan="6" class="muted">No keys yet — generate one.</td></tr>'}</tbody></table>`;
      $('#keylist',b).querySelectorAll('[data-tk]').forEach(x=>x.onclick=async()=>{await api('/apikeys/'+x.dataset.tk,{method:'PATCH',body:{is_active:x.dataset.ak!=='1'}});loadKeys();});
      $('#keylist',b).querySelectorAll('[data-dk]').forEach(x=>x.onclick=async()=>{if(confirm('Delete this API key?')){await api('/apikeys/'+x.dataset.dk,{method:'DELETE'});loadKeys();}});
    };
    $('#d_addkey',b).onclick=()=>prompt2('Generate API key','Label (optional)','',async label=>{const r=await api('/users/'+id+'/apikeys',{method:'POST',body:{label}});try{await navigator.clipboard.writeText(r.key);}catch(_){}toast('Key generated & copied: '+r.key.slice(0,14)+'…');loadKeys();});
    loadKeys();
  });
}
function policyModal(u,reload){modal('Content / auto-templating: '+u.username,
  contentModeFields({bypass_template:u.bypass_template,templates:u.templates})+
  `<div class="field" id="previewBox" style="display:none"><label>Preview — same template, codes of different length (4 / 6 / 8):</label><div class="panel mono" style="margin:0;background:var(--bg2);font-size:12px;line-height:1.7" id="prev"></div></div>
   <div class="err" id="pe"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="sv">Save</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;wireContentMode(b);
    const ta=$('#u_tpls',b);const upd=()=>{const m=b.querySelector('input[name=cmode]:checked').value;$('#previewBox',b).style.display=m==='inject'?'block':'none';if(m==='inject'&&ta){const first=ta.value.split('\n').map(s=>s.trim()).filter(Boolean)[0]||'';$('#prev',b).innerHTML=first?['1234','123456','12345678'].map(code=>`<div><span class="muted">${code.length}-digit:</span> ${esc(injectCodeClient(first,code))}</div>`).join(''):'(add a template above)';}};
    b.querySelectorAll('input[name=cmode]').forEach(r=>r.addEventListener('change',upd));if(ta)ta.addEventListener('input',upd);upd();
    $('#sv',b).onclick=async()=>{try{const cm=readContentMode(b);await api('/users/'+u.id,{method:'PATCH',body:{bypass_template:cm.bypass_template,templates:cm.templates}});toast('Saved');c();reload();}catch(e){$('#pe',b).textContent=e.message;}};});}

VIEWS.routes=async v=>{
  const routes=await api('/routes');
  v.innerHTML=`<h2 class="title">Routes</h2><div class="section-actions"><button class="primary" id="nr">+ New route</button></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Endpoint</th><th>Cost</th><th>Health</th><th>Active</th><th></th></tr></thead><tbody>${routes.map(r=>`<tr>
    <td><b>${esc(r.name)}</b></td><td><span class="badge blue">${esc(r.type)}</span></td><td class="wrap mono">${esc(r.api_url||(r.smpp_host?r.smpp_host+':'+r.smpp_port:'—'))}</td><td>${r.cost_per_sms}</td>
    <td>${r.health?(r.health.suspended?'<span class="badge red">suspended</span>':`<span class="badge green">${r.health.avgLatencyMs??'?'}ms</span>`):'<span class="badge gray">—</span>'}</td>
    <td>${yn(r.is_active)}</td>
    <td><button class="sm" data-t="${r.id}">Test</button> <button class="sm" data-e="${r.id}">Edit</button> <button class="sm danger" data-d="${r.id}">Del</button></td></tr>`).join('')||'<tr><td colspan="7" class="muted">No routes yet — add one.</td></tr>'}</tbody></table></div></div>`;
  $('#nr').onclick=()=>routeModal();
  v.querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>routeModal(routes.find(r=>r.id===b.dataset.e)));
  v.querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{if(confirm('Delete route?')){await api('/routes/'+b.dataset.d,{method:'DELETE'});toast('Deleted');go('routes');}});
  v.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{
    const rt=routes.find(x=>x.id===b.dataset.t)||{};
    const fmt=r=>r.success?(r.mode==='auth-check'?'✓ Login OK — credentials valid':('✓ Sent · id '+r.messageId+' · '+(r.latencyMs||0)+'ms')):('✗ '+(r.error||'failed'));
    // QuickConnect (and any auth-check provider) verifies login without sending — no number needed.
    if(rt.type==='quickconnect'){api('/routes/'+b.dataset.t+'/test',{method:'POST',body:{}}).then(r=>toast(fmt(r),!r.success)).catch(e=>toast('✗ '+e.message,true));return;}
    prompt2('Test route — send a real SMS','Destination number','9779800000000',async to=>{const r=await api('/routes/'+b.dataset.t+'/test',{method:'POST',body:{to,text:'Route test',send:true}});toast(fmt(r),!r.success);});
  });
};
function routeModal(r){r=r||{};modal((r.id?'Edit':'New')+' route',`
  <div class="row"><div class="field"><label>Name *</label><input id="r_name" value="${esc(r.name||'')}"/></div>
  <div class="field"><label>Type</label><select id="r_type">${['quickconnect','custom','smpp','aakash','sociair','globalzms','nestsms','nepal2rs','hms','insoftsms','arcbridge'].map(t=>`<option ${r.type===t?'selected':''}>${t}</option>`).join('')}</select></div></div>
  <div class="field"><label>API URL (HTTP providers)</label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="https://api.provider.com/send"/></div>
  <div class="field" id="qcHint" style="display:none"><div class="panel" style="margin:0;background:var(--bg2)"><b>QuickConnect auth</b> — put a JSON blob in the Auth token field below:<br/><span class="mono" style="font-size:12px">{"apiToken":"$2y$10$…","mobile":"9823309151","password":"YOUR_LOGIN_PASSWORD"}</span><br/><span class="muted" style="font-size:12px">It logs in (mobile/email + password) to mint a Bearer JWT, then sends with Api-Token + Bearer. Use "email" instead of "mobile" if you prefer.</span></div></div>
  <div class="row"><div class="field"><label>Auth token</label><textarea id="r_tok" rows="2">${esc(r.auth_token||'')}</textarea></div>
  <div class="field"><label>HTTP method</label><select id="r_method"><option ${r.http_method==='POST'?'selected':''}>POST</option><option ${r.http_method==='GET'?'selected':''}>GET</option></select></div></div>
  <div class="row"><div class="field"><label>Sender ID</label><input id="r_sender" value="${esc(r.sender_id||'')}"/></div><div class="field"><label>Cost per SMS (€)</label><input id="r_cost" type="number" step="0.001" value="${r.cost_per_sms||1}"/></div></div>
  <details><summary class="muted" style="cursor:pointer;margin:8px 0">Onward-SMPP (type=smpp) & advanced</summary>
    <div class="row"><div class="field"><label>SMPP host</label><input id="r_sh" value="${esc(r.smpp_host||'')}"/></div><div class="field"><label>Port</label><input id="r_sp" type="number" value="${r.smpp_port||2775}"/></div></div>
    <div class="row"><div class="field"><label>SMPP system_id</label><input id="r_sid" value="${esc(r.smpp_system_id||'')}"/></div><div class="field"><label>SMPP password</label><input id="r_spw" value="${esc(r.smpp_password||'')}"/></div></div>
    <div class="field"><label>Custom config JSON (field maps, headers)</label><textarea id="r_cfg" rows="3">${esc(r.config?JSON.stringify(r.config):'')}</textarea></div>
  </details>
  <label class="switch" style="margin-top:8px"><input type="checkbox" id="r_active" ${r.is_active!==false?'checked':''}/> Active</label>
  <label class="switch" style="margin-top:8px"><input type="checkbox" id="r_dlr" ${r.provides_dlr?'checked':''}/> Provider returns REAL delivery receipts (DLRs)</label>
  <p class="muted" style="font-size:12px">Leave OFF for providers that only confirm acceptance (e.g. QuickConnect) — those messages show <b>accepted</b>, never a fake <b>delivered</b>.</p>
  <div class="err" id="r_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="r_save">Save</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    const tsel=$('#r_type',b);const toggleHint=()=>{$('#qcHint',b).style.display=tsel.value==='quickconnect'?'block':'none';};tsel.onchange=toggleHint;toggleHint();
    $('#r_save',b).onclick=async()=>{try{let cfg={};const raw=$('#r_cfg',b).value.trim();if(raw)cfg=JSON.parse(raw);const body={name:$('#r_name',b).value,type:$('#r_type',b).value,api_url:$('#r_url',b).value,auth_token:$('#r_tok',b).value,http_method:$('#r_method',b).value,sender_id:$('#r_sender',b).value,cost_per_sms:Number($('#r_cost',b).value),smpp_host:$('#r_sh',b).value,smpp_port:Number($('#r_sp',b).value),smpp_system_id:$('#r_sid',b).value,smpp_password:$('#r_spw',b).value,config:cfg,is_active:$('#r_active',b).checked,provides_dlr:$('#r_dlr',b).checked};if(r.id)await api('/routes/'+r.id,{method:'PATCH',body});else await api('/routes',{method:'POST',body});c();toast('Saved');go('routes');}catch(e){$('#r_err',b).textContent=e.message;}};});}

VIEWS.rules=async v=>{
  const [rules,routes]=await Promise.all([api('/rules'),api('/routes')]);
  const rmap={};routes.forEach(r=>rmap[r.id]=r.name);
  v.innerHTML=`<h2 class="title">Routing rules (LCR)</h2><p class="muted">Longest matching destination prefix wins, then user route. Higher priority breaks ties.</p>
  <div class="section-actions"><button class="primary" id="nr">+ New rule</button></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Prefix</th><th>Route</th><th>Priority</th><th></th></tr></thead><tbody>${rules.map(r=>`<tr><td class="mono">${esc(r.prefix)}</td><td>${esc(rmap[String(r.route_id)]||'?')}</td><td>${r.priority}</td><td><button class="sm danger" data-d="${r._id}">Del</button></td></tr>`).join('')||'<tr><td colspan="4" class="muted">No rules</td></tr>'}</tbody></table></div></div>`;
  $('#nr').onclick=()=>modal('New routing rule',`<div class="field"><label>Destination prefix</label><input id="rp" placeholder="97798"/></div><div class="field"><label>Route</label><select id="rr">${routeOptions(routes)}</select></div><div class="field"><label>Priority</label><input id="rpr" type="number" value="0"/></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="rs">Add</button></div>`,(b,c)=>{b.querySelector('[data-x]').onclick=c;$('#rs',b).onclick=async()=>{await api('/rules',{method:'POST',body:{prefix:$('#rp',b).value,route_id:$('#rr',b).value,priority:Number($('#rpr',b).value)}});c();toast('Added');go('rules');};});
  v.querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{await api('/rules/'+b.dataset.d,{method:'DELETE'});go('rules');});
};

VIEWS.logs=async v=>{
  const users=await api('/users');
  v.innerHTML=`<h2 class="title">Logs / DLR</h2>
  <div class="toolbar">
    <div class="field" style="flex:0 0 170px"><label>User</label><select id="f_u"><option value="">All</option>${users.map(u=>`<option>${esc(u.username)}</option>`).join('')}</select></div>
    <div class="field" style="flex:0 0 150px"><label>Destination</label><input id="f_d" placeholder="prefix"/></div>
    <div class="field" style="flex:0 0 130px"><label>Status</label><select id="f_s"><option value="">Any</option><option>sent</option><option>failed</option><option>submitted</option></select></div>
    <div class="field" style="flex:0 0 130px"><label>DLR</label><select id="f_l"><option value="">Any</option><option>delivered</option><option>accepted</option><option>undelivered</option><option>unknown</option><option>pending</option></select></div>
    <button class="primary" id="f_go">Search</button><button id="f_csv">Export CSV</button>
  </div><div id="dsum"></div><div id="lt"></div>`;
  const qs=()=>{const p=new URLSearchParams();if($('#f_u').value)p.set('username',$('#f_u').value);if($('#f_d').value)p.set('dest',$('#f_d').value);if($('#f_s').value)p.set('status',$('#f_s').value);if($('#f_l').value)p.set('dlr',$('#f_l').value);return p.toString();};
  const sumBar=async()=>{
    const u=$('#f_u').value?('?username='+encodeURIComponent($('#f_u').value)):'';
    const s=await api('/delivery-summary'+u);
    $('#dsum').innerHTML=`<div class="panel" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <div><div class="muted" style="font-size:11px">DELIVERED</div><b style="color:var(--green,#34d399);font-size:18px">${n2(s.delivered)}</b> <span class="muted">(${s.deliveredPct}%)</span></div>
      <div><div class="muted" style="font-size:11px">ACCEPTED</div><b style="color:var(--cyan,#38bdf8);font-size:18px">${n2(s.accepted||0)}</b></div>
      <div><div class="muted" style="font-size:11px">FAILED</div><b style="color:var(--red,#fb7185);font-size:18px">${n2(s.failed)}</b></div>
      <div><div class="muted" style="font-size:11px">UNKNOWN</div><b style="font-size:18px">${n2(s.unknown)}</b></div>
      <div><div class="muted" style="font-size:11px">PENDING</div><b style="font-size:18px">${n2(s.pending)}</b></div>
      <div><div class="muted" style="font-size:11px">TOTAL</div><b style="font-size:18px">${n2(s.total)}</b></div>
      <div class="muted" style="font-size:11px;flex:1;min-width:200px;text-align:right">DLR reflects each provider's own response. QuickConnect confirms <b>acceptance</b>, not handset delivery — it has no post-send receipt API.</div>
    </div>`;
  };
  const run=async()=>{$('#lt').innerHTML='<div class="panel">'+logsTable(await api('/logs?'+qs()))+'</div>';sumBar().catch(()=>{});};
  $('#f_go').onclick=run;$('#f_csv').onclick=()=>location.href='/api/logs.csv?'+qs();run();
};

VIEWS.webhooks=async v=>{
  const list=await api('/webhooks');
  v.innerHTML=`<h2 class="title">Webhook deliveries</h2><p class="muted">DLR/event pushes to clients' webhook URLs. Failed ones can be retried.</p>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>When</th><th>User</th><th>URL</th><th>Result</th><th>Detail</th><th></th></tr></thead><tbody>${list.map(w=>`<tr><td>${fdate(w.createdAt)}</td><td>${esc(w.username)}</td><td class="wrap mono" style="max-width:240px">${esc(w.url)}</td><td>${w.ok?`<span class="badge green">${w.status_code||'ok'}</span>`:`<span class="badge red">${w.status_code||'err'}</span>`}</td><td class="wrap muted" style="font-size:12px">${esc(w.error||JSON.stringify(w.payload||{}).slice(0,70))}</td><td><button class="sm" data-r="${w._id}">Retry</button></td></tr>`).join('')||'<tr><td colspan="6" class="muted">No webhook deliveries yet. Clients set a webhook URL in their portal Settings.</td></tr>'}</tbody></table></div></div>`;
  v.querySelectorAll('[data-r]').forEach(b=>b.onclick=async()=>{const r=await api('/webhooks/'+b.dataset.r+'/retry',{method:'POST'});toast(r.ok?('Retry OK ('+r.status+')'):('Retry failed ('+(r.status||'err')+')'),!r.ok);go('webhooks');});
};
VIEWS.analytics=async v=>{
  const users=await api('/users');
  v.innerHTML=`<h2 class="title">Analytics</h2><div class="toolbar"><div class="field" style="flex:0 0 200px"><label>User</label><select id="a_u"><option value="">All</option>${users.map(u=>`<option>${esc(u.username)}</option>`).join('')}</select></div><div class="field" style="flex:0 0 110px"><label>Days</label><input id="a_d" type="number" value="30"/></div><button class="primary" id="a_go">Run</button></div><div id="at"></div>`;
  const run=async()=>{const p=new URLSearchParams({days:$('#a_d').value||'30'});if($('#a_u').value)p.set('username',$('#a_u').value);const rows=await api('/analytics/daily?'+p);const tot=rows.reduce((a,r)=>({c:a.c+r.count,p:a.p+r.parts,cr:a.cr+r.credits}),{c:0,p:0,cr:0});$('#at').innerHTML=`<div class="panel"><div class="table-wrap"><table><thead><tr><th>Day</th><th>Messages</th><th>Segments</th><th>Credits</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.day)}</td><td>${n2(r.count)}</td><td>${n2(r.parts)}</td><td>${eur(r.credits)}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">No data</td></tr>'}<tr style="font-weight:700;border-top:2px solid var(--border)"><td>Total</td><td>${n2(tot.c)}</td><td>${n2(tot.p)}</td><td>${eur(tot.cr)}</td></tr></tbody></table></div></div>`;};
  $('#a_go').onclick=run;run();
};

VIEWS.connections=async v=>{
  const c=await api('/connections');
  v.innerHTML=`<h2 class="title">Active connections</h2><div class="panel"><div class="table-wrap"><table><thead><tr><th>User</th><th>IP</th><th>Bind</th><th>Since</th></tr></thead><tbody>${c.map(x=>`<tr><td><b>${esc(x.username)}</b></td><td class="mono">${esc(x.ip)}</td><td><span class="badge blue">${esc(x.bind_type)}</span></td><td>${fdate(x.bound_at)}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">No bound sessions</td></tr>'}</tbody></table></div></div>`;
};

function simpleList(title,desc,items,cols,onAdd,addFields,delPath){return {title,desc};}
VIEWS.blacklist=async v=>{
  const list=await api('/blacklist');
  v.innerHTML=`<h2 class="title">Blacklist</h2><div class="section-actions"><button class="primary" id="add">+ Block destination</button></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Destination</th><th>Scope</th><th>Reason</th><th>Added</th><th></th></tr></thead><tbody>${list.map(b=>`<tr><td class="mono">${esc(b.destination)}</td><td>${b.username?esc(b.username):'<span class="badge purple">global</span>'}</td><td>${esc(b.reason||'')}</td><td>${fdate(b.createdAt)}</td><td><button class="sm danger" data-d="${b._id}">Del</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">Empty</td></tr>'}</tbody></table></div></div>`;
  $('#add').onclick=()=>modal('Block destination',`<div class="field"><label>Destination number</label><input id="bd"/></div><div class="field"><label>Username (blank=global)</label><input id="bu"/></div><div class="field"><label>Reason</label><input id="br"/></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="bs">Block</button></div>`,(b,c)=>{b.querySelector('[data-x]').onclick=c;$('#bs',b).onclick=async()=>{await api('/blacklist',{method:'POST',body:{destination:$('#bd',b).value,username:$('#bu',b).value||null,reason:$('#br',b).value}});c();go('blacklist');};});
  v.querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{await api('/blacklist/'+b.dataset.d,{method:'DELETE'});go('blacklist');});
};
VIEWS.words=async v=>{
  const list=await api('/words');
  v.innerHTML=`<h2 class="title">Blocked words</h2><div class="section-actions"><button class="primary" id="add">+ Block word</button></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Word</th><th>Scope</th><th></th></tr></thead><tbody>${list.map(w=>`<tr><td>${esc(w.word)}</td><td>${w.username?esc(w.username):'<span class="badge purple">global</span>'}</td><td><button class="sm danger" data-d="${w._id}">Del</button></td></tr>`).join('')||'<tr><td colspan="3" class="muted">Empty</td></tr>'}</tbody></table></div></div>`;
  $('#add').onclick=()=>prompt2('Block word','Word to block','',async w=>{await api('/words',{method:'POST',body:{word:w}});go('words');});
  v.querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{await api('/words/'+b.dataset.d,{method:'DELETE'});go('words');});
};
VIEWS.templates=async v=>{
  const list=await api('/templates');
  v.innerHTML=`<h2 class="title">Approved templates</h2><p class="muted">Used by whitelist-mode users. Placeholders: {{code}}, XXXX or digit runs match anything.</p><div class="section-actions"><button class="primary" id="add">+ New template</button></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Scope</th><th>Body</th><th></th></tr></thead><tbody>${list.map(t=>`<tr><td>${esc(t.name||'—')}</td><td>${t.username?esc(t.username):'<span class="badge purple">global</span>'}</td><td class="wrap">${esc(t.body)}</td><td><button class="sm danger" data-d="${t._id}">Del</button></td></tr>`).join('')||'<tr><td colspan="4" class="muted">Empty</td></tr>'}</tbody></table></div></div>`;
  $('#add').onclick=()=>modal('New template',`<div class="field"><label>Name</label><input id="tn"/></div><div class="field"><label>Username (blank=global)</label><input id="tu"/></div><div class="field"><label>Body</label><textarea id="tb" rows="3" placeholder="Your OTP is {{code}}. Do not share."></textarea></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="ts">Save</button></div>`,(b,c)=>{b.querySelector('[data-x]').onclick=c;$('#ts',b).onclick=async()=>{await api('/templates',{method:'POST',body:{name:$('#tn',b).value,username:$('#tu',b).value||null,body:$('#tb',b).value}});c();go('templates');};});
  v.querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{await api('/templates/'+b.dataset.d,{method:'DELETE'});go('templates');});
};

VIEWS.resellers=async v=>{
  const list=await api('/resellers');
  v.innerHTML=`<h2 class="title">Resellers</h2><div class="panel"><div class="table-wrap"><table><thead><tr><th>Reseller</th><th>Credits</th><th>Clients</th></tr></thead><tbody>${list.map(r=>`<tr><td><b>${esc(r.username)}</b></td><td>${n2(r.credits)}</td><td>${r.clients}</td></tr>`).join('')||'<tr><td colspan="3" class="muted">No resellers. Create a user with role=reseller.</td></tr>'}</tbody></table></div></div>`;
};
const invStatusBadge=s=>{const m={paid:'green',partial:'yellow',unpaid:'gray',void:'red'};return `<span class="badge ${m[s]||'gray'}">${esc(s)}</span>`;};
function invoiceHtml(inv){
  return `<div class="row" style="margin-bottom:12px"><div class="card"><div class="k">Client</div><div class="v sm">${esc(inv.client_username)}</div></div>
    <div class="card"><div class="k">Status</div><div class="v sm">${invStatusBadge(inv.status)}</div></div>
    <div class="card"><div class="k">Total</div><div class="v sm">${inv.total} ${esc(inv.currency)}</div></div>
    <div class="card"><div class="k">Paid</div><div class="v sm">${inv.paid||0}</div></div></div>
  <p class="muted" style="font-size:12px">Issued ${fdate(inv.issued_date)}${inv.due_date?' · due '+fdate(inv.due_date):''}${inv.credits_on_pay?' · adds '+inv.credits_on_pay+' credits on payment':''}${inv.note?' · '+esc(inv.note):''}</p>
  <div class="table-wrap"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th style="text-align:right">Amount</th></tr></thead><tbody>${(inv.items||[]).map(it=>`<tr><td class="wrap">${esc(it.description)}</td><td>${it.qty}</td><td>${it.unit_price}</td><td style="text-align:right">${it.amount}</td></tr>`).join('')}
    <tr><td colspan="3" style="text-align:right" class="muted">Subtotal</td><td style="text-align:right">${inv.subtotal}</td></tr>
    ${inv.tax?`<tr><td colspan="3" style="text-align:right" class="muted">Tax</td><td style="text-align:right">${inv.tax}</td></tr>`:''}
    <tr style="font-weight:700"><td colspan="3" style="text-align:right">Total</td><td style="text-align:right">${inv.total} ${esc(inv.currency)}</td></tr></tbody></table></div>
  ${(inv.payments&&inv.payments.length)?`<h3 style="margin:16px 0 8px;font-size:14px">Payments</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Amount</th><th>Method</th><th>Ref</th></tr></thead><tbody>${inv.payments.map(p=>`<tr><td>${fdate(p.createdAt)}</td><td>${p.amount}</td><td>${esc(p.method)}</td><td>${esc(p.reference||'')}</td></tr>`).join('')}</tbody></table></div>`:''}`;
}
VIEWS.invoices=async v=>{
  const [invoices,users]=await Promise.all([api('/invoices'),api('/users')]);
  v.innerHTML=`<h2 class="title">Invoices</h2><div class="section-actions"><button class="primary" id="ni">+ New invoice</button></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Number</th><th>Client</th><th>Issued</th><th>Due</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>${invoices.map(i=>`<tr>
    <td class="mono">${esc(i.number)}</td><td>${esc(i.client_username)}</td><td>${fdate(i.issued_date)}</td><td>${i.due_date?fdate(i.due_date):'—'}</td>
    <td>${i.total} ${esc(i.currency)}</td><td>${i.paid||0}</td><td>${invStatusBadge(i.status)}</td>
    <td><button class="sm" data-v="${i._id}">View</button></td></tr>`).join('')||'<tr><td colspan="8" class="muted">No invoices yet</td></tr>'}</tbody></table></div></div>`;
  $('#ni').onclick=()=>invoiceModal(users);
  v.querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>invoiceDetail(b.dataset.v));
};
function invoiceModal(users){
  const clients=users.filter(u=>u.role!=='admin');
  const rowHtml=()=>`<div class="row item-row" style="gap:6px;margin-bottom:6px"><input class="it-desc" placeholder="Description" style="flex:3"/><input class="it-qty" type="number" value="1" style="flex:1"/><input class="it-price" type="number" step="0.001" value="0" placeholder="Unit price €" style="flex:1"/></div>`;
  modal('New invoice',`
    <div class="field"><label>Client</label><select id="iv_client">${clients.map(c=>`<option value="${c.id}">${esc(c.username)} (bal ${n2(c.credits)})</option>`).join('')||'<option value="">no clients</option>'}</select></div>
    <label>Line items</label><div id="items">${rowHtml()}</div>
    <button class="sm" id="addrow" type="button">+ Add line</button>
    <div class="row" style="margin-top:12px"><div class="field"><label>Tax</label><input id="iv_tax" type="number" step="0.01" value="0"/></div><div class="field"><label>Currency</label><input id="iv_cur" value="EUR"/></div><div class="field"><label>Due date</label><input id="iv_due" type="date"/></div></div>
    <div class="field"><label>💳 Credits to add to client when fully paid (0 = none)</label><input id="iv_credits" type="number" value="0"/></div>
    <div class="field"><label>Note</label><input id="iv_note"/></div>
    <div class="panel" style="margin:0;background:var(--bg2)">Total: <b id="iv_total">0.00</b></div>
    <div class="err" id="iv_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="iv_save">Create invoice</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    const recompute=()=>{let t=0;b.querySelectorAll('.item-row').forEach(r=>{t+=(Number(r.querySelector('.it-qty').value)||0)*(Number(r.querySelector('.it-price').value)||0);});t+=Number($('#iv_tax',b).value)||0;$('#iv_total',b).textContent=t.toFixed(3);};
    b.addEventListener('input',recompute);
    $('#addrow',b).onclick=()=>{$('#items',b).insertAdjacentHTML('beforeend',rowHtml());};
    $('#iv_save',b).onclick=async()=>{try{const items=[...b.querySelectorAll('.item-row')].map(r=>({description:r.querySelector('.it-desc').value,qty:r.querySelector('.it-qty').value,unit_price:r.querySelector('.it-price').value})).filter(i=>i.description||Number(i.unit_price));if(!items.length)throw new Error('add at least one line item');await api('/invoices',{method:'POST',body:{client_id:$('#iv_client',b).value,items,tax:$('#iv_tax',b).value,currency:$('#iv_cur',b).value,due_date:$('#iv_due',b).value||null,credits_on_pay:$('#iv_credits',b).value,note:$('#iv_note',b).value}});c();toast('Invoice created');go('invoices');}catch(e){$('#iv_err',b).textContent=e.message;}};
    recompute();});
}
async function invoiceDetail(id){
  const inv=await api('/invoices/'+id);
  modal('Invoice '+inv.number,invoiceHtml(inv)+`<div class="actions">${inv.status!=='paid'&&inv.status!=='void'?'<button class="primary" id="pay">Record payment</button>':''}${inv.status!=='void'?'<button class="danger" id="void">Void</button>':''}<button id="closebtn">Close</button></div>`,
  (b,c)=>{$('#closebtn',b).onclick=c;
    if($('#pay',b))$('#pay',b).onclick=()=>prompt2('Record payment','Amount received',(inv.total-(inv.paid||0)).toFixed(2),async val=>{const r=await api('/invoices/'+id+'/pay',{method:'POST',body:{amount:Number(val)}});toast('Payment recorded · '+r.status);c();invoiceDetail(id);});
    if($('#void',b))$('#void',b).onclick=async()=>{if(confirm('Void this invoice?')){await api('/invoices/'+id+'/void',{method:'POST'});toast('Voided');c();go('invoices');}};
  });
}
VIEWS.bills=async v=>{
  const list=await api('/bills');
  v.innerHTML=`<h2 class="title">Reseller bills</h2><div class="panel"><div class="table-wrap"><table><thead><tr><th>When</th><th>Client</th><th>Credits</th><th>Rate</th><th>Total</th><th>Paid</th><th>Status</th></tr></thead><tbody>${list.map(b=>`<tr><td>${fdate(b.createdAt)}</td><td>${esc(b.client_username||'')}</td><td>${n2(b.credits)}</td><td>${b.rate}</td><td>${b.total}</td><td>${b.paid}</td><td><span class="badge ${b.status==='paid'?'green':b.status==='partial'?'yellow':'gray'}">${b.status}</span></td></tr>`).join('')||'<tr><td colspan="7" class="muted">No bills</td></tr>'}</tbody></table></div></div>`;
};

VIEWS.status=async v=>{
  const gauge=(label,pct,sub)=>`<div class="card"><div class="k">${label}</div><div class="v sm">${pct}%</div><div class="bar-track"><div class="bar-fill ${pct>=90?'crit':pct>=70?'warn':''}" style="width:${pct}%"></div></div><div class="muted" style="font-size:11px;margin-top:7px">${sub||''}</div></div>`;
  const svc=(name,st)=>`<div class="svc"><span class="dot ${st==='active'?'on':'off'}"></span><span class="name">${name}</span><span class="badge ${st==='active'?'green':'red'}">${esc(st)}</span></div>`;
  const render=s=>{v.innerHTML=`<h2 class="title">System status <span class="muted" style="font-size:13px;font-weight:400">· ${esc(s.host.hostname)} · up ${fmtUptime(s.host.uptime)}</span></h2>
    <div class="cards">
      ${gauge('CPU',s.cpu.percent,s.cpu.cores+' cores · load '+s.cpu.load.join(' / '))}
      ${gauge('RAM',s.mem.percent,fmtBytes(s.mem.used)+' / '+fmtBytes(s.mem.total))}
      ${gauge('Disk (ROM)',s.disk.percent,fmtBytes(s.disk.used)+' / '+fmtBytes(s.disk.total))}
      <div class="card"><div class="k">Database</div><div class="v sm">${s.db.connected?'<span style="color:var(--green)">●</span> up':'<span style="color:var(--red)">●</span> down'}</div><div class="muted" style="font-size:11px;margin-top:7px">${esc(s.db.name)}</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>🔧 Services</h3>
        ${svc('SMPP bridge (engine :'+CONFIG.smppPort+')',s.services.bridge)}
        ${svc('Admin panel',s.services.admin)}
        ${svc('Client portal + HTTP API',s.services.portal)}
        ${svc('MongoDB',s.services.mongod)}
      </div>
      <div class="panel"><h3>📡 Traffic</h3>
        <div class="cards" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
          <div class="card"><div class="k">⬇ Inbound</div><div class="v sm">${fmtBytes(s.net.rxRate)}/s</div><div class="muted" style="font-size:11px;margin-top:6px">total ${fmtBytes(s.net.rxTotal)}</div></div>
          <div class="card"><div class="k">⬆ Outbound</div><div class="v sm">${fmtBytes(s.net.txRate)}/s</div><div class="muted" style="font-size:11px;margin-top:6px">total ${fmtBytes(s.net.txTotal)}</div></div>
        </div>
        <div class="table-wrap"><table><tbody>
          <tr><td>Messages total</td><td style="text-align:right"><b>${n2(s.traffic.messagesTotal)}</b></td></tr>
          <tr><td>Today</td><td style="text-align:right">${n2(s.traffic.today)}</td></tr>
          <tr><td>Sent (outbound)</td><td style="text-align:right;color:var(--green)">${n2(s.traffic.sent)}</td></tr>
          <tr><td>Delivered</td><td style="text-align:right;color:var(--green)">${n2(s.traffic.delivered)}</td></tr>
          <tr><td>Failed</td><td style="text-align:right;color:var(--red)">${n2(s.traffic.failed)}</td></tr>
          <tr><td>Receipts in (DLR)</td><td style="text-align:right">${n2(s.traffic.inbound)}</td></tr>
        </tbody></table></div>
      </div>
    </div>
    <p class="muted" style="font-size:12px">↻ auto-refreshing every 4s</p>`;};
  render(await api('/system'));
  _statusTimer=setInterval(async()=>{try{render(await api('/system'));}catch(_){}},4000);
};

VIEWS.settings=async v=>{
  const s=await api('/settings');const tg=s.telegram||{};const al=Object.assign({enabled:true,cpu:85,ram:90,disk:90,lowBalance:50},s.alerts||{});
  const gen=s.general||{};const ptz=gen.timezone||'Asia/Kathmandu';
  v.innerHTML=`<h2 class="title">Settings</h2>
  <div class="panel"><h3>🕑 Panel default timezone</h3>
    <div class="row" style="align-items:flex-end"><div class="field" style="max-width:320px"><label>Default timezone for reports &amp; dates</label><select id="g_tz">${TZ_LIST.map(([tz,label])=>`<option value="${esc(tz)}" ${tz===ptz?'selected':''}>${esc(label)}</option>`).join('')}</select></div><button class="primary" id="g_save">Save</button> <span class="ok" id="g_ok"></span></div>
    <p class="muted" style="font-size:12px;margin-top:8px">Sets the fallback timezone for the Usage report and date display. Each viewer can still override it from the 🌐 picker in the top bar (saved in their browser).</p></div>
  <div class="grid2">
    <div class="panel"><h3>📣 System Telegram bot</h3>
      <div class="field"><label>Bot token</label><input id="tg_t" value="${esc(tg.bot_token||'')}"/></div>
      <div class="field"><label>Chat ID</label><input id="tg_c" value="${esc(tg.chat_id||'')}"/></div>
      <button class="primary" id="tg_save">Save</button> <button id="tg_test">Send test</button> <span class="ok" id="tg_ok"></span>
      <p class="muted" style="font-size:12px;margin-top:8px">Operator alerts (failures, failover, thresholds) go to this chat.</p>
    </div>
    <div class="panel"><h3>🚨 Alert thresholds</h3>
      <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="al_en" ${al.enabled!==false?'checked':''}/> Enabled</label>
      <div class="row"><div class="field"><label>CPU % ≥</label><input id="al_cpu" type="number" value="${al.cpu}"/></div>
      <div class="field"><label>RAM % ≥</label><input id="al_ram" type="number" value="${al.ram}"/></div>
      <div class="field"><label>Disk % ≥</label><input id="al_disk" type="number" value="${al.disk}"/></div></div>
      <div class="field"><label>Global low-balance alert when balance ≤ (€)</label><input id="al_bal" type="number" step="0.001" value="${al.lowBalance}"/></div>
      <button class="primary" id="al_save">Save</button> <button id="al_test">🔔 Test alert</button> <span class="ok" id="al_ok"></span>
      <p class="muted" style="font-size:12px;margin-top:8px">Checked every minute, 30-min cooldown per alert. Also alerts on route circuit-open. Needs the Telegram bot above. <b>Test alert</b> fires a critical alert to your CYD hub (LED + buzzer + banner within ~20s) and the Telegram bot.</p>
    </div>
  </div>`;
  $('#tg_save').onclick=async()=>{await api('/settings',{method:'POST',body:{telegram:{bot_token:$('#tg_t').value,chat_id:$('#tg_c').value}}});$('#tg_ok').textContent='Saved.';};
  $('#tg_test').onclick=async()=>{$('#tg_ok').textContent='';try{const r=await api('/settings/test-telegram',{method:'POST'});$('#tg_ok').textContent=r.sent?'Test sent ✓':'Not configured';}catch(e){$('#tg_ok').textContent=e.message;}};
  $('#al_save').onclick=async()=>{await api('/settings',{method:'POST',body:{alerts:{enabled:$('#al_en').checked,cpu:Number($('#al_cpu').value),ram:Number($('#al_ram').value),disk:Number($('#al_disk').value),lowBalance:Number($('#al_bal').value)}}});$('#al_ok').textContent='Saved.';};
  $('#al_test').onclick=async()=>{$('#al_ok').textContent='';try{await api('/test-alert',{method:'POST'});$('#al_ok').textContent='🔔 Test alert sent — CYD will buzz within ~20s';toast('Test alert fired');}catch(e){$('#al_ok').textContent=e.message;}};
  $('#g_save').onclick=async()=>{await api('/settings',{method:'POST',body:{general:{timezone:$('#g_tz').value}}});$('#g_ok').textContent='Saved.';if(!localStorage.getItem('viewtz')){VIEW_TZ=$('#g_tz').value;const ts=$('#tzSel');if(ts)ts.value=VIEW_TZ;}};
};

boot();
