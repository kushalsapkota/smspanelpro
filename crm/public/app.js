'use strict';
const $=(s,r=document)=>r.querySelector(s);
const h=html=>{const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstChild;};
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const VIEW_TZ='Asia/Kathmandu';
const fdate=d=>{if(!d)return '—';try{return new Date(d).toLocaleString([],{timeZone:VIEW_TZ,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch(_){return new Date(d).toLocaleString();}};
const fday=d=>{if(!d)return '—';try{return new Date(d).toLocaleDateString([],{timeZone:VIEW_TZ,year:'numeric',month:'short',day:'numeric'});}catch(_){return String(d).slice(0,10);}};
const n2=n=>Number(n||0).toLocaleString();
const eur=n=>'€'+Number(n||0).toFixed(2);
const eur3=n=>'€'+Number(n||0).toFixed(3);
async function api(p,o={}){const r=await fetch('/api'+p,{method:o.method||'GET',headers:{'Content-Type':'application/json'},body:o.body?JSON.stringify(o.body):undefined});let d=null;try{d=await r.json();}catch(_){}if(!r.ok)throw new Error(d&&d.error||('HTTP '+r.status));return d;}
function toast(m,e){const t=h(`<div class="toast ${e?'err':''}">${esc(m)}</div>`);document.body.appendChild(t);setTimeout(()=>t.remove(),2600);}
function copyTxt(t){navigator.clipboard.writeText(t);toast('Copied');}
window.__c=copyTxt;
const copy=t=>`<span class="copy mono" onclick="window.__c('${esc(t)}')">${esc(t)}</span>`;
function modal(title,body,onMount){const root=$('#modalRoot');const bg=h(`<div class="modal-bg"><div class="modal"><h3>${esc(title)}</h3><div class="mbody">${body}</div></div></div>`);bg.addEventListener('mousedown',e=>{if(e.target===bg)close();});root.appendChild(bg);function close(){bg.remove();}if(onMount)onMount($('.mbody',bg),close);return{close};}
function pass8(){const c='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';let p='';for(let i=0;i<8;i++)p+=c[Math.floor(Math.random()*c.length)];return p;}
const dl=u=>window.open(u,'_blank');

const invBadge=s=>({paid:'green',partial:'yellow',unpaid:'blue',void:'gray'})[s]||'gray';
const payBadge=s=>({confirmed:'green',pending:'yellow',failed:'red'})[s]||'gray';
const intBadge=s=>({paid:'green',pending:'yellow',expired:'gray',cancelled:'gray'})[s]||'gray';
const STAGES=[['new','🆕 New'],['contacted','📞 Contacted'],['negotiating','🤝 Negotiating'],['won','🏆 Won'],['lost','❌ Lost']];
const stageBadge=s=>({new:'blue',contacted:'purple',negotiating:'yellow',won:'green',lost:'red'})[s]||'gray';
const KINDS=['note','call','meeting','email','task'];
const METHODS=['bank','cash','crypto','usdt-trc20','other','manual'];
const kindIc={note:'📝',call:'📞',meeting:'👥',email:'✉️',task:'✅',system:'⚙️'};

const NAV=[
  ['MAIN',[['dashboard','📊 Dashboard'],['clients','👥 Clients'],['status','🟢 Online status'],['mail','✉️ Mail'],['tickets','🎫 Tickets'],['traffic','📡 Traffic & DLR'],['leads','🎯 Leads'],['tasks','✅ Tasks']]],
  ['MONEY',[['payments','💶 Payments'],['postpaid','📆 Postpaid'],['crypto','₮ Crypto top-ups'],['invoices','🧾 Invoices'],['statements','📅 Statements']]],
  ['SYSTEM',[['routes','📡 Routes'],['vendors','🏷️ Vendors'],['routestock','📦 Route stock'],['outboundips','🌐 Outbound IPs'],['templates','🔤 Auto-templates'],['domains','🌐 Domains'],['settings','⚙️ Settings']]],
];
const routeOpts=(routes,sel)=>`<option value="">— no route (can't send) —</option>`+routes.map(r=>`<option value="${r.id}" ${String(sel)===r.id?'selected':''}>${esc(r.name)} (${esc(r.type)})${r.is_active?'':' [inactive]'}</option>`).join('');

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#lerr').textContent='';try{await api('/login',{method:'POST',body:{username:$('#lu').value,password:$('#lp').value}});boot();}catch(err){$('#lerr').textContent=err.message;}});
$('#logout').onclick=async()=>{await api('/logout',{method:'POST'}).catch(()=>{});location.reload();};

async function boot(){
  let me;try{me=await api('/me');}catch(_){$('#login').style.display='grid';$('#app').style.display='none';return;}
  $('#login').style.display='none';$('#app').style.display='block';
  $('#who').innerHTML=`<b>${esc(me.username)}</b> · operator`;
  $('#nav').innerHTML=NAV.map(([g,items])=>`<div class="nav-group">${g}</div>`+items.map(([k,l])=>`<div class="nav-item" data-nav="${k}"><span class="ic">${l.split(' ')[0]}</span>${l.split(' ').slice(1).join(' ')}</div>`).join('')).join('');
  $('#nav').querySelectorAll('.nav-item').forEach(n=>n.onclick=()=>go(n.dataset.nav));
  go('dashboard');
}
function setActive(k){$('#nav').querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.nav===k));const t={dashboard:'Dashboard',clients:'Clients',status:'Online status',mail:'Mail',tickets:'Support tickets',traffic:'Traffic & DLR',leads:'Leads pipeline',tasks:'Tasks & follow-ups',payments:'Payments',postpaid:'Postpaid clients',crypto:'Crypto top-ups',invoices:'Invoices',statements:'Monthly statements',routes:'SMS Routes',vendors:'Vendors',routestock:'Route stock',outboundips:'Outbound IPs',templates:'Auto-templates',domains:'Domains',settings:'Settings',client:'Client'};$('#pageTitle').textContent=t[k]||k;}
let CUR='dashboard',CUR_ARG=null;
async function go(k,arg){CUR=k;CUR_ARG=arg;setActive(k);const v=$('#view');v.innerHTML='<p class="muted">Loading…</p>';try{await VIEWS[k](v,arg);}catch(e){v.innerHTML=`<p class="err">${esc(e.message)}</p>`;}}
window.__go=go;
const VIEWS={};

// ============================ DASHBOARD ============================
VIEWS.dashboard=async v=>{
  const d=await api('/dashboard');
  const stages=d.leadStages||{};
  const openLeads=['new','contacted','negotiating'].reduce((a,s)=>a+((stages[s]||{}).n||0),0);
  const pipeValue=['new','contacted','negotiating'].reduce((a,s)=>a+((stages[s]||{}).value||0),0);
  const months=d.revenue.monthly||[];const max=Math.max(1,...months.map(m=>m.s));
  v.innerHTML=`<h2 class="title">Dashboard</h2>
  <div class="cards">
    <div class="card"><div class="ic">💶</div><div class="k">Revenue this month</div><div class="v">${eur(d.revenue.month)}</div></div>
    <div class="card"><div class="ic">📆</div><div class="k">Last month</div><div class="v sm">${eur(d.revenue.lastMonth)}</div></div>
    <div class="card"><div class="ic">🏦</div><div class="k">All-time revenue</div><div class="v sm">${eur(d.revenue.total)}</div></div>
    <div class="card"><div class="ic">👥</div><div class="k">Clients</div><div class="v">${n2(d.clients)}</div></div>
    <div class="card"><div class="ic">🧾</div><div class="k">Outstanding invoices</div><div class="v sm">${eur(d.unpaidInvoices.due)}<span class="muted" style="font-size:12px"> · ${d.unpaidInvoices.count}</span></div></div>
    <div class="card"><div class="ic">🎯</div><div class="k">Open leads</div><div class="v sm">${openLeads}<span class="muted" style="font-size:12px"> · est ${eur(pipeValue)}/mo</span></div></div>
  </div>
  <div class="grid2">
    <div class="panel"><h3>💶 Revenue — last 12 months</h3>
      <div class="chart">${months.map(m=>`<div class="bar" style="height:${Math.round(m.s/max*120)+3}px"><span>${eur(m.s)}</span></div>`).join('')||'<p class="muted">No payments yet</p>'}</div>
      <div class="chart-x">${months.map(m=>`<div>${esc(m._id.slice(2))}</div>`).join('')}</div>
    </div>
    <div class="panel"><h3>⏰ Upcoming follow-ups <a class="right" onclick="window.__go('tasks')">all →</a></h3>
      ${(d.tasks||[]).map(t=>`<div class="kv"><span>${fdate(t.due_at)}</span><span>${kindIc[t.kind]||'📝'} <b>${esc(t.ref_name||t.ref_id)}</b> — ${esc(t.body.slice(0,60))}</span></div>`).join('')||'<p class="muted">Nothing due. Add follow-ups from a client or lead.</p>'}
    </div>
  </div>
  <div class="panel"><h3>💳 Recent payments <a class="right" onclick="window.__go('payments')">all →</a></h3>
    ${payTable(d.recentPayments)}
  </div>`;
};

function payTable(list){if(!list||!list.length)return '<p class="muted">No payments yet.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Client</th><th>Amount</th><th>Method</th><th>Status</th><th>Receipt</th><th>Reference</th></tr></thead><tbody>${list.map(p=>`<tr>
  <td>${fdate(p.createdAt)}</td><td><a onclick="window.__go('client','${esc(p.client_username)}')"><b>${esc(p.client_username)}</b></a></td>
  <td><b>${eur(p.amount)}</b></td><td><span class="badge ${p.method==='usdt-trc20'?'purple':'blue'}">${esc(p.method)}</span></td>
  <td><span class="badge ${payBadge(p.status)}">${esc(p.status||'confirmed')}</span></td>
  <td>${p.invoice_number?`<a onclick="window.__pdf('${p.invoice_id}')">${esc(p.invoice_number)}</a>`:'—'}</td>
  <td class="mono" style="font-size:11px">${esc((p.reference||'').slice(0,18))}${(p.reference||'').length>18?'…':''}</td></tr>`).join('')}</tbody></table></div>`;}
window.__pdf=id=>dl('/api/invoices/'+id+'/pdf');

// ============================ CLIENTS ============================
async function newClientModal(reload){
  const routes=await api('/routes').catch(()=>[]);
  modal('New client',`
  <p class="muted" style="font-size:12px">Creates a real account (SMPP bind + portal login + billing) with a CRM profile.</p>
  <div class="row"><div class="field"><label>Username *</label><input id="nc_u"/></div>
  <div class="field"><label>Password * (exactly 8 chars)</label><input id="nc_p" maxlength="8" value="${pass8()}"/></div></div>
  <div class="row"><div class="field"><label>Price per SMS (€)</label><input id="nc_c" type="number" step="0.001" value="0.018"/></div>
  <div class="field"><label>Initial credit (€)</label><input id="nc_cr" type="number" step="0.001" value="0"/></div></div>
  <div class="field"><label>📡 Route (where their SMS go)</label><select id="nc_r">${routeOpts(routes)}</select></div>
  <div class="row"><div class="field"><label>Company</label><input id="nc_co"/></div><div class="field"><label>Contact person</label><input id="nc_cn"/></div></div>
  <div class="row"><div class="field"><label>Email</label><input id="nc_em"/></div><div class="field"><label>Telegram</label><input id="nc_tg" placeholder="@handle"/></div></div>
  <div class="row"><div class="field"><label>Country</label><input id="nc_ct"/></div><div class="field"><label>Source</label><input id="nc_src" placeholder="referral / telegram / ads…"/></div></div>
  <div class="err" id="nc_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="nc_go">Create</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;$('#nc_u',b).focus();
    $('#nc_go',b).onclick=async()=>{try{
      const r=await api('/clients',{method:'POST',body:{username:$('#nc_u',b).value,password:$('#nc_p',b).value,cost_per_sms:Number($('#nc_c',b).value),credits:Number($('#nc_cr',b).value)||0,route_id:$('#nc_r',b).value||null,company:$('#nc_co',b).value,contact_name:$('#nc_cn',b).value,email:$('#nc_em',b).value,telegram:$('#nc_tg',b).value,country:$('#nc_ct',b).value,source:$('#nc_src',b).value}});
      navigator.clipboard.writeText(`username: ${r.username}\npassword: ${$('#nc_p',b).value}`).catch(()=>{});
      c();toast('Client created (credentials copied)');go('client',r.username);
    }catch(e){$('#nc_err',b).textContent=e.message;}};});
}
VIEWS.clients=async v=>{
  const clients=await api('/clients');
  v.innerHTML=`<h2 class="title">Clients</h2>
  <div class="toolbar"><button class="primary" id="c_new" style="align-self:flex-end">+ New client</button>
  <div class="field" style="flex:0 0 260px"><label>Search</label><input id="c_q" placeholder="username, company, country, tag…"/></div>
  <span class="muted" style="font-size:12px">${clients.length} client(s) · creates a real SMPP/portal account — assign its route in the admin panel</span></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Client</th><th>Company</th><th>Country</th><th>Tags</th><th>Balance</th><th>€/SMS</th><th>Revenue</th><th>Last payment</th><th>Status</th><th></th></tr></thead><tbody id="c_rows"></tbody></table></div></div>`;
  const render=q=>{q=(q||'').toLowerCase();
    $('#c_rows').innerHTML=clients.filter(c=>{const p=c.profile||{};const hay=[c.username,p.company,p.country,p.contact_name,(p.tags||[]).join(' ')].join(' ').toLowerCase();return !q||hay.includes(q);})
    .map(c=>{const p=c.profile||{};return `<tr>
      <td><a onclick="window.__go('client','${esc(c.username)}')"><b>${esc(c.username)}</b></a></td>
      <td>${esc(p.company||'—')}</td><td>${esc(p.country||'—')}</td>
      <td>${(p.tags||[]).map(t=>`<span class="tagchip">${esc(t)}</span>`).join('')||'—'}</td>
      <td style="${c.credits<0?'color:#dc2626':''}">${c.credits<0?'-'+eur3(-c.credits):eur3(c.credits)}${c.billing_mode==='postpaid'?' <span class="badge purple" style="font-size:9px">postpaid</span>':''}</td><td>${eur3(c.cost_per_sms)}</td>
      <td><b>${eur(c.revenue)}</b><span class="muted" style="font-size:11px"> · ${c.payments}×</span></td>
      <td>${c.last_payment?fday(c.last_payment):'never'}</td>
      <td><span class="dot ${c.online?'on':'off'}" title="${c.online?'online — SMPP bound now':'offline'}"></span>${c.is_suspended?'<span class="badge red">suspended</span>':'<span class="badge green">active</span>'}</td>
      <td><button class="sm" onclick="window.__go('client','${esc(c.username)}')">Open</button></td></tr>`;}).join('')||'<tr><td colspan="10" class="muted">No matches.</td></tr>';};
  $('#c_new').onclick=()=>newClientModal(()=>go('clients'));
  $('#c_q').addEventListener('input',e=>render(e.target.value));
  render('');
};

// ============================ ONLINE STATUS ============================
const ago=d=>{if(!d)return 'never';const s=Math.max(0,(Date.now()-new Date(d).getTime())/1000);if(s<60)return Math.round(s)+'s ago';if(s<3600)return Math.round(s/60)+'m ago';if(s<86400)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago';};
VIEWS.status=async v=>{
  v.innerHTML=`<h2 class="title">Online status</h2><div id="st_box"><p class="muted">Loading…</p></div>`;
  const draw=d=>{if(CUR!=='status')return;
    const rows=[...d.clients].sort((a,b)=>(b.online-a.online)||(b.api_active-a.api_active)||a.username.localeCompare(b.username));
    $('#st_box').innerHTML=`
    ${d.bridge_up
      ?`<div class="panel" style="padding:10px 16px;margin-bottom:14px"><span class="dot on"></span><b>SMPP engine running</b><span class="muted" style="font-size:12px"> · heartbeat ${ago(d.heartbeat_at)} · auto-refreshes every 10s</span></div>`
      :`<div class="panel" style="padding:10px 16px;margin-bottom:14px;border:1px solid var(--red)"><span class="dot off"></span><b style="color:var(--red)">SMPP engine not responding</b><span class="muted" style="font-size:12px"> · last heartbeat ${ago(d.heartbeat_at)} — connection status unknown, all clients shown offline</span></div>`}
    <div class="cards">
      <div class="card"><div class="k">🟢 Online (SMPP bound)</div><div class="v">${d.online}</div></div>
      <div class="card"><div class="k">🔵 Active via API (10 min)</div><div class="v">${d.api_active}</div></div>
      <div class="card"><div class="k">⚪ Offline</div><div class="v">${d.offline}</div></div>
      <div class="card"><div class="k">👥 Total clients</div><div class="v">${d.total}</div></div>
    </div>
    <div class="panel"><div class="table-wrap"><table><thead><tr><th></th><th>Client</th><th>Status</th><th>IP</th><th>Bind</th><th>Online since</th><th>Last SMPP bind</th><th>Last send</th></tr></thead><tbody>
    ${rows.map(r=>`<tr>
      <td><span class="dot ${r.online?'on':'off'}"></span></td>
      <td><a onclick="window.__go('client','${esc(r.username)}')"><b>${esc(r.username)}</b></a></td>
      <td>${r.online?'<span class="badge green">online</span>':r.api_active?'<span class="badge blue">API active</span>':'<span class="badge gray">offline</span>'}${r.is_suspended?' <span class="badge red">suspended</span>':''}</td>
      <td class="mono" style="font-size:12px">${esc(r.ip||'—')}</td>
      <td>${esc(r.bind_type||'—')}</td>
      <td>${r.online&&r.bound_at?`${fdate(r.bound_at)} <span class="muted" style="font-size:11px">(${esc(ago(r.bound_at).replace(' ago',''))})</span>`:'—'}</td>
      <td>${r.last_bound_at?fdate(r.last_bound_at):'never'}</td>
      <td>${r.last_send?`${fdate(r.last_send)} <span class="muted" style="font-size:11px">${ago(r.last_send)}</span>`:'never'}</td>
    </tr>`).join('')||'<tr><td colspan="8" class="muted">No clients yet.</td></tr>'}
    </tbody></table></div></div>`;
  };
  draw(await api('/status/online'));
  const t=setInterval(async()=>{if(CUR!=='status'){clearInterval(t);return;}try{draw(await api('/status/online'));}catch(_){}},10000);
};

// ---- client detail ----
VIEWS.client=async(v,username)=>{
  const [d,routes,tf]=await Promise.all([api('/clients/'+encodeURIComponent(username)),api('/routes').catch(()=>[]),api('/traffic/summary?days=7&username='+encodeURIComponent(username)).catch(()=>null)]);
  const p=d.profile||{};const u=d.user;
  const rname=id=>{const r=routes.find(x=>x.id===String(id));return r?r.name:null;};
  v.innerHTML=`<span class="back" onclick="window.__go('clients')">← All clients</span>
  <h2 class="title">${esc(p.company||username)} <span class="muted" style="font-size:14px;font-weight:400">· ${esc(username)}</span> ${u.online?'<span class="badge green">🟢 online</span>':`<span class="badge gray" title="last SMPP bind: ${u.last_bound_at?esc(fdate(u.last_bound_at)):'never'}">offline</span>`} ${u.billing_mode==='postpaid'?'<span class="badge purple">📆 postpaid</span>':''} ${u.is_suspended?'<span class="badge red">suspended</span>':''}</h2>
  <div class="cards">
    <div class="card"><div class="k">${u.billing_mode==='postpaid'&&u.credits<0?'Owes (postpaid)':'Balance'}</div><div class="v sm" style="${u.credits<0?'color:#dc2626':''}">${u.billing_mode==='postpaid'&&u.credits<0?eur3(-u.credits):eur3(u.credits)}</div>${u.billing_mode==='postpaid'?`<div class="muted" style="font-size:11px">pay day: ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][u.pay_day!=null?u.pay_day:1]}${u.credit_limit!=null?` · soft limit €${u.credit_limit}`:''}</div>`:''}</div>
    <div class="card"><div class="k">Price / SMS</div><div class="v sm">${eur3(u.cost_per_sms)}</div></div>
    <div class="card"><div class="k">Lifetime revenue</div><div class="v sm">${eur(d.revenue)}</div></div>
    <div class="card"><div class="k">SMS last 30d</div><div class="v sm">${n2(d.usage30.parts)}<span class="muted" style="font-size:12px"> seg · ${eur3(d.usage30.credits)}</span></div></div>
    <div class="card"><div class="k">📡 Route</div><div class="v sm" style="font-size:15px">${rname(u.route_id)?esc(rname(u.route_id)):'<span class="badge red">none — can\'t send</span>'}</div></div>
    <div class="card"><div class="k">🔤 Content</div><div class="v sm" style="font-size:15px">${u.bypass_template?'<span class="badge gray">passthrough</span>':'<span class="badge green">auto-template</span>'}${u.allowed_ips&&u.allowed_ips.length?` <span class="badge blue" title="${esc(u.allowed_ips.join(', '))}">🛡️ ${u.allowed_ips.length} IP</span>`:''}</div></div>
  </div>
  <div class="section-actions">
    <button class="primary" id="cd_pay">💶 Record payment</button>
    <button id="cd_adj">💰 Adjust balance</button>
    <button id="cd_acct">📡 Account / route</button>
    <button id="cd_pw">🔑 Change password</button>
    <button id="cd_ip">🛡️ IP whitelist</button>
    <button id="cd_ct">🔤 Content mode</button>
    <button id="cd_crypto">₮ Crypto top-up</button>
    <button id="cd_inv">🧾 New invoice</button>
    <button id="cd_stmt">📅 Statement</button>
    <button id="cd_note">📝 Add note / follow-up</button>
    <button id="cd_email">✉️ Email client</button>
    <button id="cd_edit">✏️ Edit profile</button>
  </div>
  <div class="grid2">
    <div>
      <div class="panel"><h3>👤 Profile</h3>
        ${[['Company',p.company],['Contact',p.contact_name],['Email',p.email],['Phone',p.phone],['Telegram',p.telegram],['WhatsApp',p.whatsapp],['Country',p.country],['Address',p.address],['VAT',p.vat_id],['Source',p.source]].filter(x=>x[1]).map(([k,val])=>`<div class="kv"><span>${k}</span><span>${esc(val)}</span></div>`).join('')||'<p class="muted">Empty — click "Edit profile" to fill company & contact details (used on invoices).</p>'}
        ${(p.tags||[]).length?`<div style="margin-top:10px">${p.tags.map(t=>`<span class="tagchip">${esc(t)}</span>`).join('')}</div>`:''}
      </div>
      ${tf?`<div class="panel"><h3>📡 Delivery <span class="right muted" style="font-size:11px">7d · ${tf.deliveredPct}% delivered</span></h3>
        <div class="cards" style="grid-template-columns:repeat(3,1fr)">
          <div class="card"><div class="k">Today</div><div class="v sm">${n2(tf.sending.today.messages)}<span class="muted" style="font-size:11px"> msg</span></div></div>
          <div class="card"><div class="k">This month</div><div class="v sm">${n2(tf.sending.month.parts)}<span class="muted" style="font-size:11px"> seg</span></div></div>
          <div class="card"><div class="k">All-time</div><div class="v sm">${n2(tf.sending.all.parts)}<span class="muted" style="font-size:11px"> seg</span></div></div>
        </div>
        ${tf.dlrTotal?`<div style="margin-top:10px">${Object.entries(tf.dlr).filter(([k,n])=>n>0).map(([k,n])=>`<span class="badge ${dlrColor[k]||'gray'}" style="margin:0 4px 4px 0">${k}: ${n2(n)}</span>`).join('')}</div>`:'<p class="muted" style="font-size:12px">No messages in the last 7 days.</p>'}
      </div>`:''}
      <div class="panel"><h3>📊 Usage & delivery <span class="right" id="ud_rng"></span></h3><div id="ud_box"><p class="muted">Loading…</p></div></div>
      <div class="panel"><h3>💳 Payments</h3>${payTable(d.payments)}</div>
      <div class="panel"><h3>🧾 Invoices & receipts</h3>${invTable(d.invoices)}</div>
      ${d.intents.length?`<div class="panel"><h3>₮ Crypto intents</h3>${intentTable(d.intents)}</div>`:''}
    </div>
    <div>
      <div class="panel"><h3>🕑 Timeline <span class="right muted" style="font-size:11px">notes · calls · tasks</span></h3>
        <div class="timeline">${d.activities.map(a=>`<div class="tl-item ${a.kind==='task'||a.due_at?'task':''} ${a.kind==='system'?'system':''}">
          <div class="when">${fdate(a.createdAt)} · ${kindIc[a.kind]||'📝'} ${esc(a.kind)}${a.due_at?` · due ${fdate(a.due_at)} ${a.done?'<span class="badge green">done</span>':'<span class="badge yellow">open</span>'}`:''} <a style="float:right;font-size:11px" data-da="${a._id}">✕</a>${a.due_at&&!a.done?` <a style="float:right;font-size:11px;margin-right:8px" data-dn="${a._id}">mark done</a>`:''}</div>
          <div class="body">${esc(a.body)}</div></div>`).join('')||'<p class="muted">No activity yet.</p>'}
        </div>
      </div>
      <div class="panel"><h3>✉️ Emails <span class="right muted" style="font-size:11px">inbox + sent</span></h3><div id="cl_emails"><p class="muted">Loading…</p></div></div>
      <div class="panel"><h3>🔁 Recent balance movements</h3>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Balance</th></tr></thead><tbody>
        ${d.transactions.map(t=>`<tr><td>${fdate(t.createdAt)}</td><td><span class="badge ${t.type==='topup'?'green':t.type==='deduction'?'gray':'yellow'}">${esc(t.type)}</span></td><td>${eur3(t.amount)}</td><td>${eur3(t.balance_after)}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">none</td></tr>'}
        </tbody></table></div>
      </div>
    </div>
  </div>`;
  const reload=()=>go('client',username);
  // ---- usage & delivery graph (permanent dlrlog archive, per-day stacked bars) ----
  const tzday=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:VIEW_TZ}).format(new Date(ms));
  let udN=14;
  const udLoad=async()=>{
    $('#ud_rng').innerHTML=[7,14,30,90].map(n=>`<button class="sm ${n===udN?'primary':''}" data-n="${n}" style="margin-left:4px">${n}d</button>`).join('');
    $('#ud_rng').querySelectorAll('button').forEach(b=>b.onclick=()=>{udN=Number(b.dataset.n);udLoad();});
    try{
      const dh=await api(`/traffic/dlr-history?username=${encodeURIComponent(username)}&from=${tzday(Date.now()-(udN-1)*864e5)}&to=${tzday(Date.now())}`);
      const map={};(dh.days||[]).forEach(r=>map[r.day]=r);
      const days=[];for(let i=udN-1;i>=0;i--){const k=tzday(Date.now()-i*864e5);days.push(map[k]||{day:k,messages:0,parts:0,delivered:0,failed:0,und:0,oth:0});}
      const tot=days.reduce((a,r)=>({d:a.d+r.delivered,u:a.u+(r.und||0),f:a.f+r.failed,o:a.o+(r.oth||0),m:a.m+r.messages,p:a.p+r.parts}),{d:0,u:0,f:0,o:0,m:0,p:0});
      const max=Math.max(1,...days.map(r=>r.messages));
      const seg=(n,cls)=>n?`<i class="${cls}" style="height:${Math.max(2,Math.round(n/max*120))}px"></i>`:'';
      const lblEvery=days.length>20?Math.ceil(days.length/15):1;
      $('#ud_box').innerHTML=`
        <div style="margin-bottom:8px">
          <span class="badge green">delivered: ${n2(tot.d)}</span>
          <span class="badge yellow">undelivered: ${n2(tot.u)}</span>
          <span class="badge red">failed: ${n2(tot.f)}</span>
          ${tot.o?`<span class="badge gray">pending/unknown: ${n2(tot.o)}</span>`:''}
          <span class="muted" style="font-size:11px"> · ${n2(tot.m)} msg · ${n2(tot.p)} seg · ${tot.m?Math.round(tot.d/tot.m*100):0}% delivered</span>
        </div>
        ${tot.m?`<div class="chart">${days.map(r=>`<div class="bar sbar"><span>${esc(r.day.slice(5))} · D ${n2(r.delivered)} · U ${n2(r.und||0)} · F ${n2(r.failed)}${r.oth?` · ? ${n2(r.oth)}`:''}</span>${seg(r.delivered,'sg-d')}${seg(r.und||0,'sg-u')}${seg(r.failed,'sg-f')}${seg(r.oth||0,'sg-o')}</div>`).join('')}</div>
        <div class="chart-x">${days.map((r,i)=>`<div>${i%lblEvery?'':esc(r.day.slice(5))}</div>`).join('')}</div>`
        :`<p class="muted">No messages in the last ${udN} days.</p>`}`;
    }catch(e){$('#ud_box').innerHTML=`<p class="err">${esc(e.message)}</p>`;}
  };
  udLoad();
  $('#cd_adj').onclick=()=>modal('Adjust balance — '+username,`
    <p class="muted" style="font-size:12px">Directly add or remove credit (bonus, correction, opening balance). Current balance <b>${eur3(u.credits)}</b>. This is <b>not</b> a payment — use "Record payment" for actual money received (it also makes a receipt).</p>
    <div class="row"><div class="field"><label>Amount (€) — negative to deduct</label><input id="aj_v" type="number" step="0.001" placeholder="e.g. 18 or -5"/></div>
    <div class="field"><label>New balance</label><input id="aj_nb" disabled value="${eur3(u.credits)}"/></div></div>
    <div class="field"><label>Note</label><input id="aj_n" placeholder="bonus / correction / initial credit"/></div>
    <div class="err" id="aj_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="aj_go">Apply</button></div>`,
    (b,c)=>{b.querySelector('[data-x]').onclick=c;const cur=Number(u.credits)||0;
      $('#aj_v',b).addEventListener('input',()=>{$('#aj_nb',b).value='€'+(cur+(Number($('#aj_v',b).value)||0)).toFixed(3);});
      $('#aj_v',b).focus();
      $('#aj_go',b).onclick=async()=>{try{const amt=Number($('#aj_v',b).value);if(!amt)return $('#aj_err',b).textContent='Enter a non-zero amount';const r=await api('/clients/'+encodeURIComponent(username)+'/topup',{method:'POST',body:{amount:amt,note:$('#aj_n',b).value}});c();toast('Balance: '+eur3(r.balance));reload();}catch(e){$('#aj_err',b).textContent=e.message;}};});
  $('#cd_acct').onclick=()=>modal('Account — '+username,`
    <div class="field"><label>📡 Primary route</label><select id="ac_r">${routeOpts(routes,u.route_id)}</select></div>
    <div class="field"><label>Backup route (failover)</label><select id="ac_br">${routeOpts(routes,u.backup_route_id)}</select></div>
    <div class="row"><div class="field"><label>Price per SMS (€)</label><input id="ac_c" type="number" step="0.001" value="${u.cost_per_sms}"/></div>
    <div class="field"><label>Low-balance alert at (€, blank = global)</label><input id="ac_t" type="number" step="0.001" value="${u.low_balance_threshold!=null?u.low_balance_threshold:''}"/></div></div>
    <div class="row"><div class="field"><label>💳 Billing mode</label><select id="ac_bm"><option value="prepaid" ${u.billing_mode!=='postpaid'?'selected':''}>Prepaid — blocks at €0</option><option value="postpaid" ${u.billing_mode==='postpaid'?'selected':''}>Postpaid — sends on credit, settles on pay day</option></select></div>
    <div class="field"><label>Pay day</label><select id="ac_pd">${DAY_OPTS.map(([n,l])=>`<option value="${n}" ${(u.pay_day!=null?u.pay_day:1)===n?'selected':''}>${l}</option>`).join('')}</select></div></div>
    <div class="field"><label>Soft credit limit (€, blank = no limit alert) — postpaid only; never blocks, alerts on Telegram</label><input id="ac_cl" type="number" step="0.01" min="0" value="${u.credit_limit!=null?u.credit_limit:''}"/></div>
    <label class="switch"><input type="checkbox" id="ac_s" ${u.is_suspended?'checked':''}/> Suspended (blocks all sending)</label>
    <div class="err" id="ac_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="ac_go">Save</button></div>`,
    (b,c)=>{b.querySelector('[data-x]').onclick=c;
      $('#ac_go',b).onclick=async()=>{try{
        await api('/clients/'+encodeURIComponent(username)+'/account',{method:'PATCH',body:{route_id:$('#ac_r',b).value||null,backup_route_id:$('#ac_br',b).value||null,cost_per_sms:Number($('#ac_c',b).value),low_balance_threshold:$('#ac_t',b).value===''?null:Number($('#ac_t',b).value),billing_mode:$('#ac_bm',b).value,pay_day:Number($('#ac_pd',b).value),credit_limit:$('#ac_cl',b).value===''?null:Number($('#ac_cl',b).value),is_suspended:$('#ac_s',b).checked}});
        c();toast('Account saved');reload();
      }catch(e){$('#ac_err',b).textContent=e.message;}};});
  $('#cd_pw').onclick=()=>modal('Change password — '+username,`
    <p class="muted" style="font-size:12px">Sets the SMPP bind + portal login password (min 6 chars). The client must update their connection settings.</p>
    <div class="field"><label>New password</label><input id="pw_v" value="${pass8()}"/></div>
    <div class="err" id="pw_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="pw_go">Set & copy</button></div>`,
    (b,c)=>{b.querySelector('[data-x]').onclick=c;$('#pw_v',b).focus();$('#pw_v',b).select();
      $('#pw_go',b).onclick=async()=>{try{const v=$('#pw_v',b).value;await api('/clients/'+encodeURIComponent(username)+'/password',{method:'POST',body:{password:v}});navigator.clipboard.writeText(v).catch(()=>{});c();toast('Password set & copied');}catch(e){$('#pw_err',b).textContent=e.message;}};});
  $('#cd_ip').onclick=()=>modal('IP whitelist — '+username,`
    <p class="muted" style="font-size:12px">Client can bind/send <b>only</b> from these IPv4 addresses. Leave empty to allow any IP. One per line or comma-separated.</p>
    <div class="field"><label>Allowed IPs</label><textarea id="ip_v" rows="4" placeholder="203.0.113.7&#10;198.51.100.4">${esc((u.allowed_ips||[]).join('\n'))}</textarea></div>
    <div class="err" id="ip_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="ip_go">Save</button></div>`,
    (b,c)=>{b.querySelector('[data-x]').onclick=c;
      $('#ip_go',b).onclick=async()=>{try{await api('/clients/'+encodeURIComponent(username)+'/ips',{method:'PUT',body:{allowed_ips:$('#ip_v',b).value}});c();toast('IP whitelist saved');reload();}catch(e){$('#ip_err',b).textContent=e.message;}};});
  $('#cd_ct').onclick=()=>modal('Content mode — '+username,`
    <p class="muted" style="font-size:12px">Auto-template = client sends only a <b>numeric code</b> (rejected otherwise); the gateway wraps it in a random template. This is the default for everyone.${u.has_own_templates?' This client has their <b>own</b> template set.':' Uses the shared <a onclick="window.__go(\'templates\')">global template pool</a>.'}</p>
    <div class="field"><label>Mode</label>
      <label class="rdo" style="display:flex;margin:6px 0"><input type="radio" name="cm" value="auto" ${u.bypass_template?'':'checked'}/> &nbsp;Auto-template (numbers only) — recommended</label>
      <label class="rdo" style="display:flex"><input type="radio" name="cm" value="pass" ${u.bypass_template?'checked':''}/> &nbsp;Passthrough (send text as-is)</label>
    </div>
    <p class="muted" style="font-size:12px">⚠️ If "force auto-template for all" is on in Auto-templates settings, that overrides passthrough for everyone.</p>
    <div class="actions"><button data-x>Cancel</button><button class="primary" id="cm_go">Save</button></div>`,
    (b,c)=>{b.querySelector('[data-x]').onclick=c;
      $('#cm_go',b).onclick=async()=>{const mode=b.querySelector('input[name=cm]:checked').value;await api('/clients/'+encodeURIComponent(username)+'/account',{method:'PATCH',body:{bypass_template:mode==='pass'}});c();toast('Content mode saved');reload();};});
  $('#cd_pay').onclick=()=>payModal(username,reload);
  $('#cd_crypto').onclick=()=>cryptoModal(username,reload);
  $('#cd_inv').onclick=()=>invoiceModal(username,reload);
  $('#cd_stmt').onclick=()=>stmtModal(username);
  $('#cd_note').onclick=()=>noteModal('client',username,username,reload);
  $('#cd_email').onclick=()=>{const to=(p&&p.email)||'';if(!to)return toast('No email on this client — add one via Edit profile first',true);composeMail({to,subject:'',log_to:username});};
  (async()=>{const box=$('#cl_emails');if(!box)return;
    if(!(p&&p.email)){box.innerHTML='<p class="muted">No email on this client — add one via Edit profile to see their mail here.</p>';return;}
    try{const r=await api('/clients/'+encodeURIComponent(username)+'/emails');
      box.innerHTML=r.messages.length?`<div class="table-wrap"><table><tbody>${r.messages.map(m=>`<tr data-mf="${esc(m.folder)}" data-mu="${m.uid}" style="cursor:pointer"><td style="width:24px">${m.dir==='out'?'📤':'📥'}</td><td>${esc(m.subject)} ${m.hasAttachment?'📎':''}</td><td style="text-align:right;white-space:nowrap;color:#6b7280">${fdate(m.date)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No emails with this address yet.</p>';
      box.querySelectorAll('[data-mu]').forEach(row=>row.onclick=()=>openMsg(row.dataset.mf,row.dataset.mu));
    }catch(e){box.innerHTML=`<p class="muted">Couldn't load mail: ${esc(e.message)}</p>`;}
  })();
  $('#cd_edit').onclick=()=>profileModal(username,p,reload);
  v.querySelectorAll('[data-dn]').forEach(b=>b.onclick=async()=>{await api('/activities/'+b.dataset.dn,{method:'PATCH',body:{done:true}});toast('Done');reload();});
  v.querySelectorAll('[data-da]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this entry?')){await api('/activities/'+b.dataset.da,{method:'DELETE'});reload();}});
  wireInvTable(v,reload);      // Pay / Void / Delete buttons in the invoices panel
  wireIntentTable(v,reload);   // Show / Cancel buttons in the crypto intents panel
};

function profileModal(username,p,reload){
  const f=(id,label,val,ph)=>`<div class="field"><label>${label}</label><input id="${id}" value="${esc(val||'')}" placeholder="${ph||''}"/></div>`;
  modal('Profile — '+username,`
  <div class="row">${f('p_co','Company',p.company)}${f('p_cn','Contact person',p.contact_name)}</div>
  <div class="row">${f('p_em','Email',p.email)}${f('p_ph','Phone',p.phone)}</div>
  <div class="row">${f('p_tg','Telegram',p.telegram,'@handle')}${f('p_wa','WhatsApp',p.whatsapp)}</div>
  <div class="row">${f('p_ct','Country',p.country)}${f('p_vat','VAT ID',p.vat_id)}</div>
  ${f('p_ad','Address (appears on invoices)',p.address)}
  <div class="row">${f('p_src','Source',p.source,'referral / telegram / ads…')}${f('p_tags','Tags (comma-separated)',(p.tags||[]).join(', '),'vip, otp, bulk')}</div>
  <div class="err" id="p_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="p_save">Save</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    $('#p_save',b).onclick=async()=>{try{await api('/clients/'+encodeURIComponent(username)+'/profile',{method:'PUT',body:{company:$('#p_co',b).value,contact_name:$('#p_cn',b).value,email:$('#p_em',b).value,phone:$('#p_ph',b).value,telegram:$('#p_tg',b).value,whatsapp:$('#p_wa',b).value,country:$('#p_ct',b).value,vat_id:$('#p_vat',b).value,address:$('#p_ad',b).value,source:$('#p_src',b).value,tags:$('#p_tags',b).value}});c();toast('Profile saved');reload();}catch(e){$('#p_err',b).textContent=e.message;}};});
}

function noteModal(refType,refId,refName,reload){
  modal('Add to timeline — '+refName,`
  <div class="row"><div class="field"><label>Type</label><select id="n_kind">${KINDS.map(k=>`<option>${k}</option>`).join('')}</select></div>
  <div class="field"><label>Follow-up due (optional → becomes a task + Telegram reminder)</label><input id="n_due" type="datetime-local"/></div></div>
  <div class="field"><label>Text</label><textarea id="n_body" rows="4" placeholder="What happened / what to do…"></textarea></div>
  <div class="err" id="n_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="n_save">Add</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;$('#n_body',b).focus();
    $('#n_save',b).onclick=async()=>{try{await api('/activities',{method:'POST',body:{ref_type:refType,ref_id:refId,ref_name:refName,kind:$('#n_kind',b).value,body:$('#n_body',b).value,due_at:$('#n_due',b).value?new Date($('#n_due',b).value).toISOString():null}});c();toast('Added');reload();}catch(e){$('#n_err',b).textContent=e.message;}};});
}

// ============================ PAYMENTS ============================
function payModal(username,reload,preset){
  modal('Record payment'+(username?' — '+username:''),`
  ${username?'':'<div class="field"><label>Client username</label><input id="m_user"/></div>'}
  <div class="row"><div class="field"><label>Amount (€)</label><input id="m_amt" type="number" step="0.01" min="0" value="${preset?Number(preset):''}"/></div>
  <div class="field"><label>Method</label><select id="m_meth">${METHODS.filter(m=>m!=='usdt-trc20').map(m=>`<option>${m}</option>`).join('')}</select></div></div>
  <div class="field"><label>Reference (bank ref / txid / receipt #)</label><input id="m_ref"/></div>
  <div class="field"><label>Note</label><input id="m_note"/></div>
  <label class="switch"><input type="checkbox" id="m_credit" checked/> Add to client balance — tops up prepaid / settles postpaid debt <span class="muted" style="font-size:11px">(always applied for postpaid)</span></label><br/>
  <label class="switch" style="margin-top:8px"><input type="checkbox" id="m_rcpt" checked/> Generate numbered receipt (PDF)</label>
  <div class="err" id="m_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="m_save">Record</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    $('#m_save',b).onclick=async()=>{try{
      const user=username||$('#m_user',b).value;
      const r=await api('/payments',{method:'POST',body:{username:user,amount:Number($('#m_amt',b).value),method:$('#m_meth',b).value,reference:$('#m_ref',b).value,note:$('#m_note',b).value,credit:$('#m_credit',b).checked,receipt:$('#m_rcpt',b).checked}});
      c();toast('Payment recorded'+(r.invoice?' · '+r.invoice.number:''));
      if(r.invoice)dl('/api/invoices/'+r.invoice.id+'/pdf');
      if(reload)reload();
    }catch(e){$('#m_err',b).textContent=e.message;}};});
}

VIEWS.payments=async v=>{
  const list=await api('/payments');
  v.innerHTML=`<h2 class="title">Payments</h2>
  <div class="section-actions"><button class="primary" id="p_new">+ Record payment</button>
  <span class="muted" style="font-size:12px;align-self:center">Recording a payment can auto-credit the client's balance and issue a numbered receipt PDF. USDT top-ups confirm automatically on-chain.</span></div>
  <div class="panel">${payTable(list)}</div>`;
  $('#p_new').onclick=()=>payModal(null,()=>go('payments'));
};

// ============================ POSTPAID ============================
const DAY_OPTS=[[1,'Monday'],[2,'Tuesday'],[3,'Wednesday'],[4,'Thursday'],[5,'Friday'],[6,'Saturday'],[0,'Sunday']];
VIEWS.postpaid=async v=>{
  const d=await api('/postpaid');
  v.innerHTML=`<h2 class="title">Postpaid clients</h2>
  <div class="cards" style="grid-template-columns:repeat(3,1fr)">
    <div class="card"><div class="k">Total outstanding</div><div class="v sm" style="color:${d.totals.outstanding>0?'#dc2626':'inherit'}">${eur(d.totals.outstanding)}</div></div>
    <div class="card"><div class="k">Postpaid clients</div><div class="v sm">${d.totals.count}</div></div>
    <div class="card"><div class="k">How it works</div><div class="muted" style="font-size:12px;line-height:1.5">Postpaid clients send on credit — the balance goes negative. On their pay day you get a Telegram digest; record the payment here to settle.</div></div>
  </div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Client</th><th>Pay day</th><th>Outstanding</th><th>Owing for</th><th>Soft limit</th><th>Sent 7d</th><th>Last payment</th><th>Status</th><th></th></tr></thead><tbody>
  ${d.clients.map(c=>{
    const age=c.debt_days;
    const ageBadge=age==null?'—':age>=30?`<span class="badge red">${age}d</span>`:age>=14?`<span class="badge yellow" style="background:#ffedd5;color:#9a3412">${age}d</span>`:age>=7?`<span class="badge yellow">${age}d</span>`:`<span class="badge green">${age}d</span>`;
    return `<tr>
    <td><a onclick="window.__go('client','${esc(c.username)}')"><b>${esc(c.username)}</b></a></td>
    <td>📆 ${esc(c.pay_day_name)}</td>
    <td style="color:${c.outstanding>0?'#dc2626':'inherit'}"><b>${c.outstanding>0?eur(c.outstanding):'—'}</b>${c.balance>0?`<span class="muted" style="font-size:11px"> (in credit ${eur(c.balance)})</span>`:''}</td>
    <td>${ageBadge}</td>
    <td>${c.credit_limit!=null?eur(c.credit_limit)+(c.over_limit?' <span class="badge red">over</span>':''):'<span class="muted">none</span>'}</td>
    <td>${n2(c.week.parts)}<span class="muted" style="font-size:11px"> seg · ${eur(c.week.credits)}</span></td>
    <td>${c.last_payment?fday(c.last_payment):'never'}</td>
    <td>${c.is_suspended?'<span class="badge red">suspended</span>':'<span class="badge green">active</span>'}</td>
    <td style="white-space:nowrap">${c.outstanding>0?`<button class="sm primary" data-settle="${esc(c.username)}" data-amt="${c.outstanding}">💶 Settle</button> `:''}<button class="sm" data-stmt="${esc(c.username)}">📄 Statement</button></td>
  </tr>`;}).join('')||'<tr><td colspan="9" class="muted">No postpaid clients yet — open a client → 📡 Account / route → billing mode: postpaid.</td></tr>'}
  </tbody></table></div></div>
  <p class="muted" style="font-size:12px">📄 Statement = last 7 days of usage + amount due as a PDF (with the USDT auto-pay box). One is also generated automatically on each client's pay day — sent to your Telegram and emailed to the client if they have an email on file.</p>`;
  v.querySelectorAll('[data-settle]').forEach(b=>b.onclick=()=>payModal(b.dataset.settle,()=>go('postpaid'),Number(b.dataset.amt)));
  v.querySelectorAll('[data-stmt]').forEach(b=>b.onclick=()=>dl('/api/postpaid/'+encodeURIComponent(b.dataset.stmt)+'/settlement.pdf?days=7'));
};

// ============================ ROUTE STOCK ============================
VIEWS.routes=async v=>{
  const routes=await api('/routes');
  v.innerHTML=`<h2 class="title">SMS Routes <button id="nr" class="primary" style="float:right">+ New route</button></h2>
  <p class="muted" style="font-size:12px">Provider connections that actually send the SMS. Assign one to a client in their 📡 Account / route panel.</p>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Endpoint</th><th>€/SMS</th><th>DLR</th><th>Clients</th><th>Status</th><th></th></tr></thead><tbody>
  ${routes.map(r=>`<tr>
    <td><b>${esc(r.name)}</b></td><td><span class="badge blue">${esc(r.type)}</span></td>
    <td class="mono" style="font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.api_url||(r.smpp_host?r.smpp_host+':'+r.smpp_port:'—'))}</td>
    <td>${eur3(r.cost_per_sms||0)}</td>
    <td>${r.provides_dlr?'<span class="badge green">real</span>':'<span class="badge">accepted</span>'}</td>
    <td>${r.clients||0}</td>
    <td>${r.is_active?'<span class="badge green">active</span>':'<span class="badge red">off</span>'}</td>
    <td style="white-space:nowrap">${['insoft','insoftsms','insoft2','insoftsms2','insoftpanel','insoftweb'].includes(r.type)?`<button data-keys="${r.id}" data-n="${esc(r.name)}">🔑 Keys</button> `:''}<button data-test="${r.id}">🔌 Test</button> <button data-edit="${r.id}">✏️</button> <button data-del="${r.id}" data-n="${esc(r.name)}" data-c="${r.clients||0}">🗑</button></td>
  </tr>`).join('')||'<tr><td colspan="8" class="muted">No routes yet — click “+ New route”.</td></tr>'}
  </tbody></table></div>`;
  $('#nr',v).onclick=()=>routeModal();
  v.querySelectorAll('[data-keys]').forEach(b=>b.onclick=()=>keysModal(b.dataset.keys,b.dataset.n));
  v.querySelectorAll('[data-edit]').forEach(b=>b.onclick=async()=>{try{routeModal(await api('/routes/'+b.dataset.edit));}catch(e){toast(e.message,true);}});
  v.querySelectorAll('[data-test]').forEach(b=>b.onclick=async()=>{b.disabled=true;const o=b.textContent;b.textContent='…';try{const r=await api('/routes/'+b.dataset.test+'/test',{method:'POST'});toast((r.ok?'✓ ':'✗ ')+r.message,!r.ok);}catch(e){toast('✗ '+e.message,true);}b.disabled=false;b.textContent=o;});
  v.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(Number(b.dataset.c)>0){toast('Assigned to '+b.dataset.c+' client(s) — reassign first',true);return;}if(!confirm('Delete route “'+b.dataset.n+'”?'))return;try{await api('/routes/'+b.dataset.del,{method:'DELETE'});toast('Deleted');go('routes');}catch(e){toast(e.message,true);}});
};

// ---------------- Vendors (external suppliers + their self-registered endpoints) ----------------
function vendorCredModal(vid,pass,isReset){
  modal((isReset?'Password reset':'Vendor created')+' — '+vid,
   `<p class="muted">Give these to your vendor. They log in at the <b>Vendor Portal (port 6699)</b>. The password is shown <b>once</b>.</p>
    <div class="field"><label>Vendor ID</label><input id="vc_id" value="${esc(vid)}" readonly/></div>
    <div class="field"><label>Password</label><input id="vc_pw" value="${esc(pass)}" readonly/></div>
    <button class="primary" id="vc_copy">📋 Copy login</button>`,
   (b,close)=>{$('#vc_copy',b).onclick=()=>{copyTxt(`Vendor Portal\nID: ${vid}\nPassword: ${pass}`);};});
}
function newVendorModal(){
  modal('New vendor',
   `<div class="field"><label>Name / company</label><input id="nv_name" placeholder="Acme SMS Pvt Ltd"/></div>
    <div class="field"><label>Vendor ID <span class="muted">(login — blank = from name)</span></label><input id="nv_id" placeholder="acme-sms"/></div>
    <div class="field"><label>Email <span class="muted">(optional)</span></label><input id="nv_email"/></div>
    <div class="field"><label>Password <span class="muted">(blank = auto-generate)</span></label><input id="nv_pw"/></div>
    <div class="field"><label>Notes <span class="muted">(operator-only)</span></label><input id="nv_notes"/></div>
    <p id="nv_err" class="err"></p>
    <button class="primary" id="nv_go">Create vendor</button>`,
   (b,close)=>{$('#nv_go',b).onclick=async()=>{$('#nv_err',b).textContent='';try{
     const r=await api('/vendors',{method:'POST',body:{name:$('#nv_name',b).value,vendor_id:$('#nv_id',b).value,email:$('#nv_email',b).value,password:$('#nv_pw',b).value,notes:$('#nv_notes',b).value}});
     close();vendorCredModal(r.vendor_id,r.password,false);go('vendors');
   }catch(e){$('#nv_err',b).textContent=e.message;}};});
}
async function vendorEndpointsModal(vid,name){
  const eps=await api('/vendors/'+encodeURIComponent(vid)+'/endpoints');
  modal('Endpoints — '+(name||vid),
   `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Used</th><th>Balance</th><th></th></tr></thead><tbody>
    ${eps.map(e=>`<tr>
      <td><b>${esc(e.name)}</b><div class="mono muted" style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.api_url||'—')}</div></td>
      <td><span class="badge blue">${esc(e.type)}</span></td>
      <td>${e.vendor_status==='approved'?'<span class="badge green">approved</span>':e.vendor_status==='rejected'?'<span class="badge red">rejected</span>':'<span class="badge">pending</span>'}</td>
      <td>${(e.used||0).toLocaleString()}</td><td>${(e.balance||0).toLocaleString()}</td>
      <td style="white-space:nowrap">${e.vendor_status!=='approved'?`<button class="primary" data-ap="${e.id}">✓ Approve</button> `:''}${e.vendor_status!=='rejected'?`<button data-rj="${e.id}">✕ Reject</button>`:''}</td>
    </tr>`).join('')||'<tr><td colspan="6" class="muted">This vendor hasn’t added any endpoints yet.</td></tr>'}
    </tbody></table></div>
    <p class="muted" style="font-size:11px">Approving makes the endpoint active &amp; assignable — set it on a client in their 📡 Account / route panel (it appears in the Routes list too).</p>`,
   (b,close)=>{
     b.querySelectorAll('[data-ap]').forEach(x=>x.onclick=async()=>{try{await api('/vendor-routes/'+x.dataset.ap+'/approve',{method:'POST'});toast('Approved');close();vendorEndpointsModal(vid,name);}catch(e){toast(e.message,true);}});
     b.querySelectorAll('[data-rj]').forEach(x=>x.onclick=async()=>{if(!confirm('Reject this endpoint?'))return;try{await api('/vendor-routes/'+x.dataset.rj+'/reject',{method:'POST'});toast('Rejected');close();vendorEndpointsModal(vid,name);}catch(e){toast(e.message,true);}});
   });
}
VIEWS.vendors=async v=>{
  const [vendors,pending]=await Promise.all([api('/vendors'),api('/vendor-routes/pending').catch(()=>[])]);
  v.innerHTML=`<h2 class="title">Vendors <button id="nv" class="primary" style="float:right">+ New vendor</button></h2>
  <p class="muted" style="font-size:12px">External SMS suppliers. Create a vendor → give them the ID &amp; password → they add their endpoint APIs &amp; balance in the <b>Vendor Portal (:6699)</b>. New endpoints arrive here as <b>pending</b> for you to approve, then assign to clients.</p>
  ${pending.length?`<div class="panel" style="border-color:#caa700"><h3>⏳ ${pending.length} endpoint(s) awaiting approval</h3>
    <div class="table-wrap"><table><thead><tr><th>Vendor</th><th>Endpoint</th><th>Type</th><th>Balance</th><th></th></tr></thead><tbody>
    ${pending.map(p=>`<tr><td>${esc(p.vendor_id)}</td><td><b>${esc(p.name)}</b></td><td><span class="badge blue">${esc(p.type)}</span></td><td>${(p.balance||0).toLocaleString()}</td>
      <td style="white-space:nowrap"><button class="primary" data-pap="${p.id}">✓ Approve</button> <button data-prj="${p.id}">✕ Reject</button></td></tr>`).join('')}
    </tbody></table></div></div>`:''}
  <div class="table-wrap"><table><thead><tr><th>Vendor</th><th>Contact</th><th>Endpoints</th><th>Balance</th><th>SMS used</th><th>Status</th><th></th></tr></thead><tbody>
  ${vendors.map(x=>`<tr>
    <td><b>${esc(x.name||x.vendor_id)}</b><div class="mono muted" style="font-size:11px">${esc(x.vendor_id)}</div></td>
    <td style="font-size:12px">${esc(x.email||'—')}</td>
    <td>${x.endpoints||0}${x.pending?` <span class="badge">${x.pending} pending</span>`:''}</td>
    <td>${(x.balance||0).toLocaleString()}</td>
    <td>${(x.used||0).toLocaleString()}</td>
    <td>${x.is_active?'<span class="badge green">active</span>':'<span class="badge red">disabled</span>'}</td>
    <td style="white-space:nowrap">
      <button data-eps="${esc(x.vendor_id)}" data-n="${esc(x.name||x.vendor_id)}">📡 Endpoints</button>
      <button data-pw="${esc(x.vendor_id)}">🔑</button>
      <button data-tog="${esc(x.vendor_id)}" data-a="${x.is_active?1:0}">${x.is_active?'⏸':'▶'}</button>
      <button data-del="${esc(x.vendor_id)}" data-c="${x.endpoints||0}">🗑</button>
    </td>
  </tr>`).join('')||'<tr><td colspan="7" class="muted">No vendors yet — click “+ New vendor”.</td></tr>'}
  </tbody></table></div>`;
  $('#nv',v).onclick=newVendorModal;
  v.querySelectorAll('[data-pap]').forEach(b=>b.onclick=async()=>{try{await api('/vendor-routes/'+b.dataset.pap+'/approve',{method:'POST'});toast('Approved');go('vendors');}catch(e){toast(e.message,true);}});
  v.querySelectorAll('[data-prj]').forEach(b=>b.onclick=async()=>{if(!confirm('Reject this endpoint?'))return;try{await api('/vendor-routes/'+b.dataset.prj+'/reject',{method:'POST'});toast('Rejected');go('vendors');}catch(e){toast(e.message,true);}});
  v.querySelectorAll('[data-eps]').forEach(b=>b.onclick=()=>vendorEndpointsModal(b.dataset.eps,b.dataset.n));
  v.querySelectorAll('[data-pw]').forEach(b=>b.onclick=async()=>{if(!confirm('Reset password for '+b.dataset.pw+'?'))return;try{const r=await api('/vendors/'+encodeURIComponent(b.dataset.pw)+'/password',{method:'POST',body:{}});vendorCredModal(b.dataset.pw,r.password,true);}catch(e){toast(e.message,true);}});
  v.querySelectorAll('[data-tog]').forEach(b=>b.onclick=async()=>{try{await api('/vendors/'+encodeURIComponent(b.dataset.tog),{method:'PATCH',body:{is_active:b.dataset.a!=='1'}});toast('Updated');go('vendors');}catch(e){toast(e.message,true);}});
  v.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(Number(b.dataset.c)>0){toast('Vendor owns '+b.dataset.c+' endpoint(s) — delete those routes first',true);return;}if(!confirm('Delete vendor '+b.dataset.del+'?'))return;try{await api('/vendors/'+encodeURIComponent(b.dataset.del),{method:'DELETE'});toast('Deleted');go('vendors');}catch(e){toast(e.message,true);}});
};

// Provider-type-aware credential fields (prefilled from the route on edit).
function routeCredFields(type,r){r=r||{};let creds={};try{if(r.auth_token)creds=JSON.parse(r.auth_token);}catch(_){}
  if(type==='sparrow')return `<div class="field"><label>Sparrow API token</label><input id="r_tok" value="${esc(r.auth_token||'')}" placeholder="v2_..."/></div>
    <p class="muted" style="font-size:11px">Set the <b>Sender ID</b> below to your approved identity (e.g. Ultranet). ⚠️ Sparrow IP-whitelists the token — this server's public IP must be allow-listed on the Sparrow account, or every send is “Invalid IP”.</p>`;
  if(type==='insoft'||type==='insoftsms')return `<div class="field"><label>INSOFT API key (token)</label><input id="r_tok" value="${esc(r.auth_token||'')}" placeholder="EB069C1D-CF99-4B0D-8A25-0A2E3274CBC6"/></div>
    <div class="row"><div class="field"><label>Base URL <span class="muted">(your-initial.insoftsms.com)</span></label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="https://sms.insoftsms.com"/></div>
    <div class="field"><label>HTTP method</label><select id="r_method"><option ${r.http_method!=='GET'?'selected':''}>POST</option><option ${r.http_method==='GET'?'selected':''}>GET</option></select></div></div>
    <p class="muted" style="font-size:11px">Set the <b>Sender ID</b> below to your approved INSOFT identity (e.g. <b>insoft</b>). Add multiple accounts via <b>🔑 Keys</b> on the routes list. No DLR API → sends show <b>accepted</b> (flip “real DLRs” ON for optimistic delivered).</p>`;
  if(type==='insoft2'||type==='insoftsms2')return `<div class="field"><label>API token</label><input id="r_tok" value="${esc(r.auth_token||'')}" placeholder="token from the panel → API & Docs"/></div>
    <div class="row"><div class="field"><label>Panel base URL <span class="muted">(the real host you log into)</span></label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="https://your-panel-host"/></div>
    <div class="field"><label>HTTP method</label><select id="r_method"><option ${r.http_method!=='POST'?'selected':''}>GET</option><option ${r.http_method==='POST'?'selected':''}>POST</option></select></div></div>
    <p class="muted" style="font-size:11px">Insoft “web SMS Server” variant (fields <b>to</b>/<b>sender</b>, path <b>/api/sendsms</b>, has a real <b>/credit/</b> balance check). Set the <b>Sender ID</b> below. Add multiple accounts via <b>🔑 Keys</b>. The doc host <i>sms.inschoolerp.com</i> is only a sample — use your account's real host.</p>`;
  if(type==='insoftpanel'||type==='insoftweb')return `<div class="row"><div class="field"><label>Panel username</label><input id="r_user" value="${esc(creds.username||'')}"/></div>
    <div class="field"><label>Panel password</label><input id="r_pass" type="password" value="${esc(creds.password||'')}"/></div></div>
    <div class="field"><label>Panel base URL</label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="https://insoftsms.com"/></div>
    <p class="muted" style="font-size:11px">Insoft <b>web panel</b> (cookie login → /BulkSms/Save) — for accounts WITHOUT an API token. Set the <b>Sender ID</b> below (e.g. puspanjali). Logs in & sends as the browser does.</p>`;
  if(type==='spellcpaas'||type==='routegod'||type==='spell'){const sc=(r.config||{});return `<div class="field"><label>Spell CPaaS API key</label><input id="r_tok" value="${esc(r.auth_token||'')}" placeholder="e.g. F72D390350C4179B855E6B197FC124C1"/></div>
    <div class="row"><div class="field"><label>Campaign ID <span class="muted">(optional)</span></label><input id="r_campaign" value="${esc(sc.campaign||'')}"/></div>
    <div class="field"><label>Route ID <span class="muted">(optional)</span></label><input id="r_routeid" value="${esc(sc.routeid||'')}"/></div></div>
    <div class="field"><label>Base URL <span class="muted">(blank = default)</span></label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="https://spellcpaas.com"/></div>
    <p class="muted" style="font-size:11px">Spell CPaaS HTTP API (<b>spellcpaas.com</b>). Key goes in the API key field; campaign &amp; route id are account-specific. This provider HAS a real <b>getDLR</b> endpoint → you can turn ON delivery receipts below. Use <b>Test</b> to verify the key.</p>`;}
  if(type==='xoro')return `<div class="field"><label>Xoro API token <span class="muted">(x-api-token)</span></label><input id="r_tok" value="${esc(r.auth_token||'')}" placeholder="1f88a9c8-…"/></div>
    <div class="field"><label>Invoke URL <span class="muted">(blank = default)</span></label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="https://xoro.leosainamaina.org/api/v1/invoke"/></div>
    <p class="muted" style="font-size:11px">Xoro direct API (body <b>msg</b>/<b>num</b>, 10-digit numbers). Returns a synchronous <b>status:success</b> verdict → turn <b>real DLRs</b> ON for exact delivered/failed (no fake delivered). Use <b>Test</b> to verify the token.</p>`;
  if(type==='webzonesms')return `<div class="field"><label>Webzone API token</label><input id="r_tok" value="${esc(r.auth_token||'')}" placeholder="token from sms.webzonesms.com → Developers"/></div>
    <div class="field"><label>Send URL <span class="muted">(blank = default)</span></label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="http://sms.webzonesms.com/api/v3/sms"/></div>
    <p class="muted" style="font-size:11px">“Ultimate SMS” panel. Token goes in the <b>token</b> field (not Bearer). Set the <b>Sender ID</b> below to your approved identity. No DLR API → sends show <b>accepted</b>. Use <b>Test</b> to verify the account isn't expired / out of credit.</p>`;
  if(type==='hms')return `<div class="row"><div class="field"><label>Panel username</label><input id="r_user" value="${esc(creds.username||'')}"/></div>
    <div class="field"><label>Panel password</label><input id="r_pass" type="password" value="${esc(creds.password||'')}"/></div></div>
    <div class="field"><label>Send URL <span class="muted">(blank = default)</span></label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="…/operation.php?module=sms&page=individual_sms_operation"/></div>`;
  if(type==='quickconnect')return `<div class="row"><div class="field"><label>API token</label><input id="qc_api" value="${esc(creds.apiToken||'')}"/></div>
    <div class="field"><label>Login mobile / email</label><input id="qc_id" value="${esc(creds.mobile||creds.email||'')}"/></div></div>
    <div class="row"><div class="field"><label>Login password</label><input id="qc_pass" type="password" value="${esc(creds.password||'')}"/></div>
    <div class="field"><label>Messaging URL <span class="muted">(blank=default)</span></label><input id="r_url" value="${esc(r.api_url||'')}"/></div></div>`;
  if(type==='smpp')return `<div class="row"><div class="field"><label>SMPP host</label><input id="sm_h" value="${esc(r.smpp_host||'')}"/></div><div class="field"><label>Port</label><input id="sm_p" type="number" value="${r.smpp_port||2775}"/></div></div>
    <div class="row"><div class="field"><label>System ID</label><input id="sm_s" value="${esc(r.smpp_system_id||'')}"/></div><div class="field"><label>Password</label><input id="sm_pw" type="password" value="${esc(r.smpp_password||'')}"/></div></div>`;
  return `<div class="field"><label>API URL</label><input id="r_url" value="${esc(r.api_url||'')}" placeholder="https://api.provider.com/send"/></div>
    <div class="row"><div class="field"><label>Auth token / API key</label><textarea id="r_tok" rows="2">${esc(r.auth_token||'')}</textarea></div>
    <div class="field"><label>HTTP method</label><select id="r_method"><option ${r.http_method!=='GET'?'selected':''}>POST</option><option ${r.http_method==='GET'?'selected':''}>GET</option></select></div></div>`;}

function routeModal(r){r=r||{};const types=['xoro','sparrow','hms','insoft','insoft2','insoftpanel','quickconnect','sociair','aakash','webzonesms','spellcpaas','routegod','spell','smpp','custom','globalzms','nestsms','nestpanel','nepal2rs','insoftsms','insoftsms2','insoftweb','arcbridge'];
  modal((r.id?'Edit':'New')+' route',`
  <div class="row"><div class="field"><label>Name</label><input id="r_name" value="${esc(r.name||'')}"/></div>
  <div class="field"><label>Provider type</label><select id="r_type">${types.map(t=>`<option ${r.type===t?'selected':''}>${t}</option>`).join('')}</select></div></div>
  <div id="r_creds"></div>
  <div class="row"><div class="field"><label>Sender ID <span class="muted">(if supported)</span></label><input id="r_sender" value="${esc(r.sender_id||'')}"/></div>
  <div class="field"><label>Cost €/SMS</label><input id="r_cost" type="number" step="0.001" value="${r.cost_per_sms!=null?r.cost_per_sms:0}"/></div></div>
  <label class="switch"><input type="checkbox" id="r_dlr" ${r.provides_dlr?'checked':''}/> Provider returns REAL delivery receipts (DLRs)</label>
  <p class="muted" style="font-size:11px">Leave OFF for accept-only providers — they show <b>accepted</b>, never a fake <b>delivered</b>.</p>
  <label class="switch" style="margin-top:6px"><input type="checkbox" id="r_active" ${r.is_active!==false?'checked':''}/> Active</label>
  <div class="field" style="margin-top:8px"><label>Source IPs <span class="muted">(comma-separated; blank = use the global pool / server default)</span></label>
    <input id="r_sips" value="${esc((r.config&&Array.isArray(r.config.source_ips))?r.config.source_ips.join(', '):'')}" placeholder="e.g. 161.97.175.111  — pin a whitelisted provider (Sparrow) to its IP"/></div>
  <details style="margin-top:8px"><summary class="muted" style="font-size:12px;cursor:pointer">Advanced config (JSON)</summary>
    <textarea id="r_cfg" rows="3" placeholder='{ "key": "value" }'>${r.config&&Object.keys(r.config).length?esc(JSON.stringify(r.config,null,1)):''}</textarea></details>
  <div class="err" id="r_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="r_save">Save</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    const tsel=$('#r_type',b);const paint=()=>{$('#r_creds',b).innerHTML=routeCredFields(tsel.value,r);};tsel.onchange=paint;paint();
    $('#r_save',b).onclick=async()=>{try{
      const type=tsel.value;const body={name:$('#r_name',b).value,type,sender_id:$('#r_sender',b).value,cost_per_sms:Number($('#r_cost',b).value)||0,provides_dlr:$('#r_dlr',b).checked,is_active:$('#r_active',b).checked};
      const cfgRaw=$('#r_cfg',b).value.trim();if(cfgRaw)body.config=JSON.parse(cfgRaw);
      const sipEl=$('#r_sips',b);if(sipEl){const arr=sipEl.value.split(/[,\s]+/).map(s=>s.trim()).filter(Boolean);body.config=Object.assign({},body.config);if(arr.length)body.config.source_ips=arr;else delete body.config.source_ips;}
      const urlEl=$('#r_url',b);if(urlEl)body.api_url=urlEl.value;
      if(type==='hms'||type==='insoftpanel'||type==='insoftweb'){const u=$('#r_user',b).value;if(!u)throw new Error('username required');body.auth_token=JSON.stringify({username:u,password:$('#r_pass',b).value});}
      else if(type==='quickconnect'){const id=$('#qc_id',b).value,a={apiToken:$('#qc_api',b).value,password:$('#qc_pass',b).value};if(/@/.test(id))a.email=id;else a.mobile=id;body.auth_token=JSON.stringify(a);}
      else if(type==='smpp'){body.smpp_host=$('#sm_h',b).value;body.smpp_port=Number($('#sm_p',b).value)||2775;body.smpp_system_id=$('#sm_s',b).value;const pw=$('#sm_pw',b).value;if(pw)body.smpp_password=pw;}
      else{const tok=$('#r_tok',b);if(tok)body.auth_token=tok.value;const m=$('#r_method',b);if(m)body.http_method=m.value;}
      if(type==='spellcpaas'||type==='routegod'||type==='spell'){body.config=Object.assign({},body.config);const ca=$('#r_campaign',b),ro=$('#r_routeid',b);if(ca&&ca.value.trim())body.config.campaign=ca.value.trim();else delete body.config.campaign;if(ro&&ro.value.trim())body.config.routeid=ro.value.trim();else delete body.config.routeid;}
      if(r.id)await api('/routes/'+r.id,{method:'PATCH',body});else await api('/routes',{method:'POST',body});
      c();toast('Route saved');go('routes');
    }catch(e){$('#r_err',b).textContent=e.message;}};});}

// INSOFT key-pool manager: many accounts, round-robin load-spread + auto-failover. For web-panel
// routes (insoftpanel) a "key" is a login account (username+password), not an API token.
function keysModal(routeId,routeName){
  const cr=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:3});
  const sbadge=s=>s==='active'?'<span class="badge green">active</span>':s==='exhausted'?'<span class="badge red">exhausted</span>':'<span class="badge gray">disabled</span>';
  modal('🔑 Key pool — '+routeName,`<div id="kp">Loading…</div>`,(b,close)=>{
    const root=$('#kp',b); let panel=false;
    async function load(){try{const d=await api('/routes/'+routeId+'/keys');panel=['insoftpanel','insoftweb'].includes((d.route&&d.route.type)||'');render(d);}catch(e){root.innerHTML='<p class="err">'+esc(e.message)+'</p>';}}
    function render(d){
      const s=d;
      root.innerHTML=`
      <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:10px">
        <div class="card"><div class="k">Keys</div><div style="font-size:20px;font-weight:700">${s.total}</div><div class="muted" style="font-size:11px">${s.active} active · ${s.exhausted} dry · ${s.disabled} off</div></div>
        <div class="card"><div class="k">Credit left</div><div style="font-size:20px;font-weight:700">${cr(s.credit_remaining)}</div><div class="muted" style="font-size:11px">of ${cr(s.credit_initial)} seeded</div></div>
        <div class="card"><div class="k">SMS sent</div><div style="font-size:20px;font-weight:700">${n2(s.sms_sent)}</div></div>
        <div class="card"><div class="k">Next key</div><div style="font-size:13px;font-weight:700">${s.next_key?esc(s.next_key.label):'<span class="muted">none</span>'}</div><div class="muted" style="font-size:11px">${s.next_key?cr(s.next_key.credit_remaining)+' left':'pool empty/dry'}</div></div>
      </div>
      <details style="margin-bottom:10px"><summary class="muted" style="cursor:pointer;font-size:12px">⬆️ Bulk import — paste one ${panel?'account':'key'} per line</summary>
        <p class="muted" style="font-size:11px;margin:6px 0">Format: <b>${panel?'username,password,senderid,host':'token,credit,senderid,host'}</b> — ${panel?'senderid/host':'credit/senderid/host'} optional (blank ⇒ route default). Separators: comma, tab or pipe.</p>
        <textarea id="kp_imp" rows="5" placeholder="${panel?'puspanjali,public117,puspanjali,insoftsms.com&#10;acct2,pass2,sender2,insoftsms.com':'EB069C1D-...,50000,insoft,sms.insoftsms.com&#10;AB12...,1000,myinitial,myinitial.insoftsms.com'}"></textarea>
        <button class="primary" id="kp_impb" style="margin-top:6px">Import ${panel?'accounts':'keys'}</button></details>
      <details style="margin-bottom:10px"><summary class="muted" style="cursor:pointer;font-size:12px">➕ Add one ${panel?'account':'key'}</summary>
        <div class="row" style="margin-top:6px"><div class="field"><label>${panel?'Username':'Token'}</label><input id="ka_tok"/></div><div class="field"><label>${panel?'Password':'Credit'}</label><input id="ka_cr" type="${panel?'text':'number'}" step="0.001"/></div></div>
        <div class="row"><div class="field"><label>Sender ID <span class="muted">(blank=route)</span></label><input id="ka_snd"/></div><div class="field"><label>Host <span class="muted">(blank=route)</span></label><input id="ka_host" placeholder="sms.insoftsms.com"/></div></div>
        <button class="primary" id="ka_add">Add ${panel?'account':'key'}</button></details>
      <div class="table-wrap"><table><thead><tr><th>Key</th><th>Sender</th><th>Host</th><th>Remaining</th><th>Sent</th><th>Status</th><th></th></tr></thead><tbody>
      ${s.keys.map(k=>{const pct=k.credit_initial>0?Math.max(0,Math.min(100,k.credit_remaining/k.credit_initial*100)):(k.credit_remaining>0?100:0);
        const col=pct<=10?'#dc2626':pct<=30?'#d97706':'#16a34a';
        return `<tr>
        <td><b>${esc(k.label||k.token_mask)}</b><div class="mono muted" style="font-size:10px">${esc(k.token_mask)}</div>${k.last_error?`<div class="muted" style="font-size:10px;color:#dc2626">${esc(k.last_error).slice(0,40)}</div>`:''}</td>
        <td>${esc(k.sender_id||'—')}</td>
        <td class="mono" style="font-size:10px">${esc(k.host||'—')}</td>
        <td style="min-width:110px"><div style="background:#e5e7eb;border-radius:5px;height:7px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${col}"></div></div>
          <div style="font-size:11px;margin-top:2px"><b>${cr(k.credit_remaining)}</b> <span class="muted">/ ${cr(k.credit_initial)}</span></div></td>
        <td>${n2(k.sms_sent)}</td>
        <td>${sbadge(k.status)}</td>
        <td style="white-space:nowrap">
          <button class="sm" data-tu="${k.id}" title="Top up">💰</button>
          <button class="sm" data-ed="${k.id}" data-cr="${k.credit_remaining}" title="Set credit">✏️</button>
          <button class="sm" data-tg="${k.id}" data-st="${k.status}" title="${k.status==='disabled'?'Enable':'Disable'}">${k.status==='disabled'?'▶️':'⏸'}</button>
          <button class="sm" data-rm="${k.id}" title="Delete">🗑</button>
        </td></tr>`;}).join('')||'<tr><td colspan="7" class="muted">No keys yet — bulk-import your INSOFT accounts above.</td></tr>'}
      </tbody></table></div>`;
      // wire
      $('#kp_impb',root).onclick=async e=>{const t=$('#kp_imp',root).value.trim();if(!t)return;e.target.disabled=true;try{const r=await api('/routes/'+routeId+'/keys/import',{method:'POST',body:{text:t}});toast(`Imported ${r.added}${r.duplicates?', '+r.duplicates+' dup skipped':''}${r.errors.length?', '+r.errors.length+' errors':''}`,r.errors.length>0);render(r.summary);}catch(err){toast(err.message,true);e.target.disabled=false;}};
      $('#ka_add',root).onclick=async()=>{const tok=$('#ka_tok',root).value.trim();if(!tok){toast(panel?'username required':'token required',true);return;}const body={token:tok,sender_id:$('#ka_snd',root).value.trim(),host:$('#ka_host',root).value.trim()};if(panel){const pw=$('#ka_cr',root).value;if(!pw){toast('password required',true);return;}body.password=pw;}else{body.credit=Number($('#ka_cr',root).value)||0;}try{const r=await api('/routes/'+routeId+'/keys',{method:'POST',body});toast(panel?'Account added':'Key added');render(r.summary);}catch(err){toast(err.message,true);}};
      root.querySelectorAll('[data-tu]').forEach(x=>x.onclick=async()=>{const a=prompt('Top-up amount to add to this key (provider credit):');if(a==null)return;const amt=Number(a);if(!amt){toast('bad amount',true);return;}try{const r=await api('/keys/'+x.dataset.tu+'/topup',{method:'POST',body:{amount:amt}});toast('Topped up → '+cr(r.credit_remaining));render(r.summary);}catch(err){toast(err.message,true);}});
      root.querySelectorAll('[data-ed]').forEach(x=>x.onclick=async()=>{const a=prompt('Set REMAINING credit for this key:',x.dataset.cr);if(a==null)return;const v=Number(a);if(!isFinite(v)){toast('bad number',true);return;}try{const r=await api('/keys/'+x.dataset.ed,{method:'PATCH',body:{credit_remaining:v}});render(r.summary);toast('Updated');}catch(err){toast(err.message,true);}});
      root.querySelectorAll('[data-tg]').forEach(x=>x.onclick=async()=>{const ns=x.dataset.st==='disabled'?'active':'disabled';try{const r=await api('/keys/'+x.dataset.tg,{method:'PATCH',body:{status:ns}});render(r.summary);toast(ns==='active'?'Enabled':'Disabled');}catch(err){toast(err.message,true);}});
      root.querySelectorAll('[data-rm]').forEach(x=>x.onclick=async()=>{if(!confirm('Delete this key from the pool?'))return;try{const r=await api('/keys/'+x.dataset.rm,{method:'DELETE'});render(r.summary);toast('Deleted');}catch(err){toast(err.message,true);}});
    }
    load();
  });
}

// Outbound source-IP pool: send SMS from many VPS IPs; blocked IPs auto-skip, others keep sending.
VIEWS.outboundips=async v=>{
  const d=await api('/outbound-ips');
  let ips=d.ips.map(x=>({ip:x.ip,label:x.label||'',disabled:!!x.disabled}));
  let mode=d.mode||'rotate';
  const onBox=new Set(d.server_ips.map(s=>s.ip));
  const health={}; d.ips.forEach(x=>health[x.ip]={suspended:x.suspended,sent:x.sent,lastError:x.lastError,on_box:x.on_box});
  const dur=ms=>!ms?'':Math.ceil(ms/60000)+'m';
  function render(){
    v.innerHTML=`<h2 class="title">Outbound IPs <button id="save" class="primary" style="float:right">💾 Save pool</button></h2>
    <p class="muted" style="font-size:12px;margin-top:-6px">Every SMS goes out bound to one of these source IPs. If a provider blocks an IP, the others keep sending — a blocked IP (403/refused/"invalid IP") auto-pauses for 5 min, then retries. Add the IPs to your VPS network interface first, then list them here and <b>Test</b> each.</p>
    <div class="panel"><h3>Rotation</h3>
      <label class="switch"><input type="radio" name="mode" value="rotate" ${mode!=='sticky'?'checked':''}/> Spread (round-robin every send — balances load, hardest to block)</label><br/>
      <label class="switch"><input type="radio" name="mode" value="sticky" ${mode==='sticky'?'checked':''}/> Sticky (use one IP until it gets blocked, then move to the next)</label>
    </div>
    ${d.server_ips.length?`<p class="muted" style="font-size:12px">Detected on this VPS: ${d.server_ips.map(s=>`<button class="sm" data-add="${s.ip}">+ ${esc(s.ip)}</button>`).join(' ')}</p>`:''}
    <div class="table-wrap"><table><thead><tr><th>Source IP</th><th>Label</th><th>On box</th><th>State</th><th>Sent</th><th>Enabled</th><th></th></tr></thead><tbody id="iptb">
    ${ips.map((x,i)=>{const hh=health[x.ip]||{};return `<tr>
      <td class="mono"><b>${esc(x.ip)}</b>${hh.lastError?`<div class="muted" style="font-size:10px;color:#dc2626">${esc(hh.lastError).slice(0,38)}</div>`:''}</td>
      <td><input data-lab="${i}" value="${esc(x.label)}" placeholder="e.g. extra-1" style="width:120px"/></td>
      <td>${onBox.has(x.ip)?'<span class="badge green">yes</span>':'<span class="badge red">missing</span>'}</td>
      <td>${x.disabled?'<span class="badge gray">off</span>':hh.suspended?'<span class="badge red">blocked</span>':'<span class="badge green">ready</span>'}</td>
      <td>${n2(hh.sent||0)}</td>
      <td style="text-align:center"><input type="checkbox" data-en="${i}" ${x.disabled?'':'checked'}/></td>
      <td style="white-space:nowrap"><button class="sm" data-test="${x.ip}" title="Egress test">🛰️ Test</button> <button class="sm" data-rm="${i}" title="Remove">🗑</button></td>
    </tr>`;}).join('')||'<tr><td colspan="7" class="muted">No IPs yet — add the VPS IPs you want to send from.</td></tr>'}
    </tbody></table></div>
    <div class="row" style="margin-top:8px;align-items:flex-end">
      <div class="field"><label>Add IP</label><input id="newip" placeholder="161.97.175.111"/></div>
      <div class="field"><label>Label</label><input id="newlab" placeholder="optional"/></div>
      <button id="addip">+ Add</button>
    </div>
    <p class="muted" style="font-size:11px">Pin a route to specific IPs (e.g. Sparrow's whitelisted IP) via the route's <b>Source IPs</b> field. Empty pool = send from the server's default IP (unchanged).</p>`;
    // wire
    v.querySelectorAll('[name=mode]').forEach(r=>r.onchange=()=>{mode=v.querySelector('[name=mode]:checked').value;});
    v.querySelectorAll('[data-lab]').forEach(inp=>inp.oninput=()=>{ips[+inp.dataset.lab].label=inp.value;});
    v.querySelectorAll('[data-en]').forEach(c=>c.onchange=()=>{ips[+c.dataset.en].disabled=!c.checked;});
    v.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{ips.splice(+b.dataset.rm,1);render();});
    v.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{if(!ips.find(z=>z.ip===b.dataset.add)){ips.push({ip:b.dataset.add,label:'',disabled:false});render();}});
    $('#addip',v).onclick=()=>{const ip=$('#newip',v).value.trim();if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)){toast('enter a valid IPv4',true);return;}if(ips.find(z=>z.ip===ip)){toast('already listed',true);return;}ips.push({ip,label:$('#newlab',v).value.trim(),disabled:false});render();};
    v.querySelectorAll('[data-test]').forEach(b=>b.onclick=async()=>{const o=b.textContent;b.disabled=true;b.textContent='…';try{const r=await api('/outbound-ips/test',{method:'POST',body:{ip:b.dataset.test}});if(r.ok)toast(r.match?`✓ ${b.dataset.test} → egress ${r.egress} (match)`:`⚠️ ${b.dataset.test} → egress ${r.egress} (NAT/shared)`,!r.match);else toast('✗ '+r.error,true);}catch(e){toast(e.message,true);}b.disabled=false;b.textContent=o;});
    $('#save',v).onclick=async()=>{try{await api('/outbound-ips',{method:'POST',body:{ips,mode}});toast('Saved — '+ips.length+' IP(s), '+mode);go('outboundips');}catch(e){toast(e.message,true);}};
  }
  render();
};

VIEWS.routestock=async v=>{
  const d=await api('/route-inventory');
  const bar=r=>{if(r.pct==null)return '<span class="muted" style="font-size:12px">no stock tracking — record a top-up to start</span>';
    const col=r.pct<=r.alert_pct?'#dc2626':r.pct<=r.alert_pct*1.5?'#d97706':'#16a34a';
    return `<div style="background:#e5e7eb;border-radius:6px;height:10px;overflow:hidden"><div style="width:${Math.min(100,r.pct)}%;height:100%;background:${col}"></div></div>
    <div style="font-size:12px;margin-top:4px"><b style="color:${col}">${r.pct}%</b> · ${n2(r.remaining)} of ${n2(r.total)} SMS left${r.used!=null?` · ${n2(r.used)} used`:''}</div>`;};
  v.innerHTML=`<h2 class="title">Route stock — provider SMS inventory</h2>
  <p class="muted" style="font-size:12px;margin-top:-6px">Record every top-up you buy from a provider. Stock counts down automatically per segment sent; a Telegram alert fires once when a route drops to its alert level.</p>
  <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(290px,1fr))">
  ${d.routes.map(r=>`<div class="card">
    <div class="k">${esc(r.name)} <span class="muted">· ${esc(r.type)}</span> ${r.is_active?'':'<span class="badge gray">inactive</span>'} ${r.alerted?'<span class="badge red">low-stock alerted</span>':''}</div>
    <div style="margin:10px 0">${bar(r)}</div>
    <div style="font-size:11px" class="muted">Alert at ${r.alert_pct}% remaining</div>
    <div style="margin-top:10px;display:flex;gap:6px">
      <button class="sm primary" data-tu="${r.id}" data-n="${esc(r.name)}">+ Record top-up</button>
      <button class="sm" data-cfg="${r.id}" data-n="${esc(r.name)}" data-pct="${r.alert_pct}" data-rem="${r.remaining!=null?r.remaining:''}">⚙️ Adjust</button>
    </div>
  </div>`).join('')||'<p class="muted">No routes configured.</p>'}
  </div>
  <div class="panel"><h3>🧾 Top-up history</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Route</th><th>SMS</th><th>Cost (€)</th><th>€/SMS</th><th>Note</th><th>By</th></tr></thead><tbody>
  ${d.topups.map(t=>`<tr><td>${fdate(t.at)}</td><td><b>${esc(t.route_name)}</b></td><td>${t.sms>0?'+':''}${n2(t.sms)}</td><td>${t.cost?eur(t.cost):'—'}</td><td>${t.cost&&t.sms>0?'€'+(t.cost/t.sms).toFixed(4):'—'}</td><td>${esc(t.note||'—')}</td><td>${esc(t.by)}</td></tr>`).join('')||'<tr><td colspan="7" class="muted">No top-ups recorded yet.</td></tr>'}
  </tbody></table></div></div>`;
  const reload=()=>go('routestock');
  v.querySelectorAll('[data-tu]').forEach(b=>b.onclick=()=>modal('Record top-up — '+b.dataset.n,`
    <p class="muted" style="font-size:12px">You bought SMS from the provider — record it so stock tracking & the low-stock alert stay accurate. Negative = correction.</p>
    <div class="row"><div class="field"><label>SMS purchased</label><input id="t_sms" type="number" step="1" placeholder="20000"/></div>
    <div class="field"><label>Cost paid (€, optional)</label><input id="t_cost" type="number" step="0.01" min="0"/></div></div>
    <div class="field"><label>Note</label><input id="t_note" placeholder="invoice ref / package name…"/></div>
    <div class="err" id="t_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="t_go">Record</button></div>`,
    (bd,c)=>{bd.querySelector('[data-x]').onclick=c;$('#t_sms',bd).focus();
      $('#t_go',bd).onclick=async()=>{try{
        const r=await api('/routes/'+b.dataset.tu+'/topup',{method:'POST',body:{sms:Number($('#t_sms',bd).value),cost:Number($('#t_cost',bd).value)||0,note:$('#t_note',bd).value}});
        c();toast(`Stock: ${n2(r.remaining)} of ${n2(r.total)} SMS`);reload();
      }catch(e){$('#t_err',bd).textContent=e.message;}};}));
  v.querySelectorAll('[data-cfg]').forEach(b=>b.onclick=()=>modal('Stock settings — '+b.dataset.n,`
    <div class="row"><div class="field"><label>Alert when remaining ≤ (%)</label><input id="s_pct" type="number" min="1" max="99" value="${b.dataset.pct}"/></div>
    <div class="field"><label>Correct remaining (SMS, blank = keep)</label><input id="s_rem" type="number" step="1" value="${b.dataset.rem}" placeholder="match provider dashboard"/></div></div>
    <p class="muted" style="font-size:12px">Use "correct remaining" if the provider's dashboard disagrees (e.g. they count differently). Re-arms the alert.</p>
    <div class="err" id="s_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="s_go">Save</button></div>`,
    (bd,c)=>{bd.querySelector('[data-x]').onclick=c;
      $('#s_go',bd).onclick=async()=>{try{
        const body={alert_pct:Number($('#s_pct',bd).value)};
        if($('#s_rem',bd).value!=='')body.remaining=Number($('#s_rem',bd).value);
        await api('/routes/'+b.dataset.cfg+'/inventory',{method:'PATCH',body});
        c();toast('Saved');reload();
      }catch(e){$('#s_err',bd).textContent=e.message;}};}));
};

// ============================ CRYPTO ============================
function cryptoModal(username,reload){
  modal('USDT (TRC-20) top-up'+(username?' — '+username:''),`
  ${username?'':'<div class="field"><label>Client username</label><input id="x_user"/></div>'}
  <div class="field"><label>Amount the client is buying (€)</label><input id="x_eur" type="number" step="0.01" min="0"/></div>
  <p class="muted" style="font-size:12px">A <b>unique</b> USDT amount is generated. The client sends exactly that amount to your TRC-20 wallet; the watcher auto-confirms on-chain (every 30s), credits the balance and issues the receipt. No gateway, no commission.</p>
  <div class="err" id="x_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="x_save">Create</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    $('#x_save',b).onclick=async()=>{try{
      const i=await api('/crypto/intents',{method:'POST',body:{username:username||$('#x_user',b).value,eur:Number($('#x_eur',b).value)}});
      c();intentDetail(i);if(reload)reload();
    }catch(e){$('#x_err',b).textContent=e.message;}};});
}
function intentDetail(i){
  modal('Payment instructions — '+i.username,`
  <div style="text-align:center">
    <div class="qr"><img src="/api/crypto/intents/${i._id}/qr" width="180" height="180" alt="wallet QR"/></div>
    <p style="margin:14px 0 4px" class="muted">Send <b>exactly</b> this amount of USDT (TRC-20):</p>
    <div class="amount-big">${esc(Number(i.usdt).toFixed(6))} USDT</div>
    <p class="muted" style="font-size:12px">= ${eur(i.eur)} @ ${Number(i.rate).toFixed(4)} €/USDT</p>
    <p style="margin:10px 0 4px" class="muted">To wallet:</p>
    <p>${copy(i.wallet)}</p>
    <p class="muted" style="font-size:12px">⚠️ TRC-20 network only · the amount must match to the last digit — that's how it's recognized.<br/>Expires ${fdate(i.expires_at)} · auto-checks every 30 s.</p>
    <button class="sm" onclick="window.__c('Send exactly ${Number(i.usdt).toFixed(6)} USDT (TRC-20) to ${esc(i.wallet)} — amount must match exactly. Valid until ${fdate(i.expires_at)}.')">📋 Copy instructions for client</button>
  </div>
  <div class="actions"><button data-x class="primary">Close</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;});
}
function intentTable(list){return `<div class="table-wrap"><table><thead><tr><th>Created</th><th>Client</th><th>EUR</th><th>USDT (exact)</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>
  ${list.map(i=>`<tr><td>${fdate(i.createdAt)}</td><td><b>${esc(i.username)}</b>${i.target_invoice_number?`<div class="muted" style="font-size:10px">for ${esc(i.target_invoice_number)}</div>`:''}</td><td>${eur(i.eur)}</td><td class="mono">${Number(i.usdt).toFixed(6)}</td>
  <td><span class="badge ${intBadge(i.status)}">${esc(i.status)}</span>${i.txid?` <a href="https://tronscan.org/#/transaction/${esc(i.txid)}" target="_blank" style="font-size:11px">tx↗</a>`:''}${i.status==='pending'&&i.suspect_txid?`<div style="margin-top:3px"><span class="badge yellow">⚠ got ${Number(i.suspect_usdt).toFixed(6)}</span></div>`:''}</td>
  <td>${i.status==='pending'?fdate(i.expires_at):'—'}</td>
  <td>${i.status==='pending'?`${i.suspect_txid?`<button class="sm primary" data-acc="${i._id}" data-got="${Number(i.suspect_usdt).toFixed(6)}" data-exp="${esc(i.usdt_str)}">Accept tx</button> `:''}<button class="sm" data-show='${esc(JSON.stringify({_id:i._id,username:i.username,usdt:i.usdt,eur:i.eur,rate:i.rate,wallet:i.wallet,expires_at:i.expires_at}))}'>Show</button> <button class="sm danger" data-cx="${i._id}">Cancel</button>`:(i.invoice_number||'')}</td></tr>`).join('')||'<tr><td colspan="7" class="muted">none</td></tr>'}</tbody></table></div>`;}
function wireIntentTable(v,reload){
  v.querySelectorAll('[data-show]').forEach(b=>b.onclick=()=>intentDetail(JSON.parse(b.dataset.show)));
  v.querySelectorAll('[data-cx]').forEach(b=>b.onclick=async()=>{if(confirm('Cancel this intent?')){await api('/crypto/intents/'+b.dataset.cx+'/cancel',{method:'POST'});toast('Cancelled');reload();}});
  v.querySelectorAll('[data-acc]').forEach(b=>b.onclick=async()=>{
    if(!confirm(`Client sent ${b.dataset.got} USDT instead of ${b.dataset.exp}. Accept and record the ACTUAL received value?`))return;
    try{const r=await api('/crypto/intents/'+b.dataset.acc+'/accept',{method:'POST',body:{}});toast(`Accepted: ${r.usdt_received} USDT → ${eur(r.eur_recorded)} recorded`);reload();}catch(e){toast(e.message,true);}
  });
}
VIEWS.crypto=async v=>{
  const [intents,settings]=await Promise.all([api('/crypto/intents'),api('/crm-settings')]);
  let rate=null;try{rate=await api('/crypto/rate');}catch(_){}
  const wallet=(settings.crypto||{}).wallet;
  v.innerHTML=`<h2 class="title">₮ Crypto top-ups — USDT TRC-20, direct to your wallet</h2>
  ${wallet?'':'<div class="panel" style="border-color:var(--yellow)"><b>⚠️ No wallet configured.</b> Set your TRC-20 (Tron) USDT address in <a onclick="window.__go(\'settings\')">Settings</a> first.</div>'}
  <div class="cards">
    <div class="card"><div class="k">Your wallet</div><div class="v sm mono" style="font-size:13px">${wallet?copy(wallet):'—'}</div></div>
    <div class="card"><div class="k">Rate (EUR per USDT)</div><div class="v sm">${rate?Number(rate.rate).toFixed(4):'—'}<span class="muted" style="font-size:11px"> ${rate?esc(rate.source):''}</span></div></div>
    <div class="card"><div class="k">Pending intents</div><div class="v sm">${intents.filter(i=>i.status==='pending').length}</div></div>
  </div>
  <div class="section-actions">
    <button class="primary" id="x_new" ${wallet?'':'disabled'}>+ New top-up request</button>
    <button id="x_check">🔍 Check chain now</button>
  </div>
  <div class="panel">${intentTable(intents)}</div>
  <p class="muted" style="font-size:12px">How it works: each request gets a unique USDT amount (dust digits). When that exact amount arrives at your wallet (watched via the free TronGrid API), it auto-confirms → balance credited → receipt issued → Telegram alert. Sender pays the network fee; you pay nothing.</p>`;
  $('#x_new').onclick=()=>cryptoModal(null,()=>go('crypto'));
  $('#x_check').onclick=async()=>{const r=await api('/crypto/check',{method:'POST'});toast(`Checked ${r.checked} pending — ${r.paid} paid, ${r.expired} expired`);if(r.paid)go('crypto');};
  wireIntentTable(v,()=>go('crypto'));
};

// ============================ INVOICES ============================
function invTable(list){if(!list||!list.length)return '<p class="muted">No invoices yet.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Number</th><th>Type</th><th>Client</th><th>Issued</th><th>Due</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>
  ${list.map(i=>{const overdue=i.status!=='paid'&&i.status!=='void'&&i.due_date&&new Date(i.due_date)<new Date();return `<tr>
  <td class="mono"><b>${esc(i.number)}</b></td><td><span class="badge ${i.type==='receipt'?'green':'blue'}">${esc(i.type||'manual')}</span></td>
  <td><a onclick="window.__go('client','${esc(i.client_username)}')">${esc(i.client_username)}</a></td>
  <td>${fday(i.issued_date||i.createdAt)}</td><td>${overdue?`<span class="badge red">${fday(i.due_date)}</span>`:i.due_date?fday(i.due_date):'—'}</td>
  <td><b>${eur(i.total)}</b></td><td>${eur(i.paid)}</td>
  <td><span class="badge ${invBadge(i.status)}">${esc(i.status)}</span></td>
  <td><button class="sm" onclick="window.__pdf('${i._id}')">PDF</button> <button class="sm" data-emailinv="${i._id}" title="Email this PDF to the client">✉️</button>${i.type==='manual'&&i.status!=='paid'&&i.status!=='void'?` <button class="sm" data-payinv="${i._id}" data-due="${(i.total-(i.paid||0)).toFixed(2)}">Pay</button> <button class="sm danger" data-void="${i._id}">Void</button>`:''}${!(i.paid>0)?` <button class="sm danger" data-delinv="${i._id}" title="Delete (only while nothing is paid)">🗑</button>`:''}</td></tr>`;}).join('')}</tbody></table></div>`;}
function wireInvTable(v,reload){
  v.querySelectorAll('[data-payinv]').forEach(b=>b.onclick=()=>modal('Record invoice payment',`
    <div class="row"><div class="field"><label>Amount (€) — due ${esc(b.dataset.due)}</label><input id="ip_amt" type="number" step="0.01" value="${esc(b.dataset.due)}"/></div>
    <div class="field"><label>Method</label><select id="ip_meth">${METHODS.filter(m=>m!=='usdt-trc20').map(m=>`<option>${m}</option>`).join('')}</select></div></div>
    <div class="field"><label>Reference</label><input id="ip_ref"/></div>
    <div class="err" id="ip_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="ip_go">Record</button></div>`,
    (bb,cc)=>{bb.querySelector('[data-x]').onclick=cc;$('#ip_go',bb).onclick=async()=>{try{const r=await api('/invoices/'+b.dataset.payinv+'/pay',{method:'POST',body:{amount:Number($('#ip_amt',bb).value),method:$('#ip_meth',bb).value,reference:$('#ip_ref',bb).value}});cc();toast('Recorded → '+r.status);reload();}catch(e){$('#ip_err',bb).textContent=e.message;}};}));
  v.querySelectorAll('[data-void]').forEach(b=>b.onclick=async()=>{if(confirm('Void this invoice?')){await api('/invoices/'+b.dataset.void+'/void',{method:'POST'});toast('Voided');reload();}});
  v.querySelectorAll('[data-delinv]').forEach(b=>b.onclick=async()=>{if(confirm('Permanently delete this invoice? (only possible while nothing is paid against it)')){try{await api('/invoices/'+b.dataset.delinv,{method:'DELETE'});toast('Deleted');reload();}catch(e){toast(e.message,true);}}});
  v.querySelectorAll('[data-emailinv]').forEach(b=>b.onclick=async()=>{const to=prompt('Email this invoice/receipt PDF to (blank = client\'s profile email):');if(to===null)return;b.disabled=true;b.textContent='…';try{const r=await api('/invoices/'+b.dataset.emailinv+'/email',{method:'POST',body:{to:to.trim()}});toast('Emailed to '+r.to);}catch(e){toast(e.message,true);}b.disabled=false;b.textContent='✉️';});
}
function invoiceModal(username,reload){
  let items=[{description:'',qty:1,unit_price:0}];
  const m=modal('New invoice'+(username?' — '+username:''),`
  ${username?'':'<div class="field"><label>Client username</label><input id="i_user"/></div>'}
  <div id="i_items"></div>
  <button class="sm" id="i_add">+ Line</button>
  <div class="row" style="margin-top:12px">
    <div class="field"><label>Tax (€, flat)</label><input id="i_tax" type="number" step="0.01" value="0"/></div>
    <div class="field"><label>Due date</label><input id="i_due" type="date"/></div>
    <div class="field"><label>Credit balance on full payment (€, 0 = none)</label><input id="i_cred" type="number" step="0.001" value="0"/></div>
  </div>
  <div class="field"><label>Note (shown on PDF)</label><input id="i_note"/></div>
  <div class="kv"><span>Total</span><b id="i_total">€0.00</b></div>
  <div class="err" id="i_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="i_save">Create</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    const draw=()=>{$('#i_items',b).innerHTML=items.map((it,ix)=>`<div class="row" style="margin-bottom:6px">
      <div class="field" style="flex:3;margin:0"><input data-f="description" data-i="${ix}" placeholder="Description (e.g. dedicated route setup)" value="${esc(it.description)}"/></div>
      <div class="field" style="flex:0 0 70px;margin:0"><input data-f="qty" data-i="${ix}" type="number" step="1" value="${it.qty}" title="Qty"/></div>
      <div class="field" style="flex:0 0 110px;margin:0"><input data-f="unit_price" data-i="${ix}" type="number" step="0.001" value="${it.unit_price}" title="Unit €"/></div>
      <button class="sm danger" data-rm="${ix}" style="flex:0 0 auto">✕</button></div>`).join('');
      b.querySelectorAll('[data-f]').forEach(inp=>inp.oninput=()=>{items[Number(inp.dataset.i)][inp.dataset.f]=inp.dataset.f==='description'?inp.value:Number(inp.value);tot();});
      b.querySelectorAll('[data-rm]').forEach(x=>x.onclick=()=>{items.splice(Number(x.dataset.rm),1);if(!items.length)items.push({description:'',qty:1,unit_price:0});draw();});
      tot();};
    const tot=()=>{const s=items.reduce((a,i)=>a+(Number(i.qty)||1)*(Number(i.unit_price)||0),0)+(Number($('#i_tax',b).value)||0);$('#i_total',b).textContent=eur(s);};
    $('#i_tax',b).oninput=tot;$('#i_add',b).onclick=()=>{items.push({description:'',qty:1,unit_price:0});draw();};draw();
    $('#i_save',b).onclick=async()=>{try{
      const r=await api('/invoices',{method:'POST',body:{username:username||$('#i_user',b).value,items,tax:Number($('#i_tax',b).value)||0,due_date:$('#i_due',b).value||null,credits_on_pay:Number($('#i_cred',b).value)||0,note:$('#i_note',b).value}});
      c();toast('Invoice '+r.number+' created');dl('/api/invoices/'+r.id+'/pdf');if(reload)reload();
    }catch(e){$('#i_err',b).textContent=e.message;}};});
}
VIEWS.invoices=async v=>{
  const list=await api('/invoices');
  const tabs=[['','All'],['manual','Invoices'],['receipt','Receipts'],['unpaid','Unpaid']];
  let cur='';
  v.innerHTML=`<h2 class="title">Invoices & receipts</h2>
  <div class="section-actions"><button class="primary" id="i_new">+ New invoice</button></div>
  <div class="tabbtns" id="i_tabs">${tabs.map(([k,l])=>`<button data-t="${k}" class="${k===''?'on':''}">${l}</button>`).join('')}</div>
  <div class="panel" id="i_out"></div>`;
  const render=()=>{let l=list;if(cur==='unpaid')l=list.filter(i=>i.type==='manual'&&['unpaid','partial'].includes(i.status));else if(cur)l=list.filter(i=>(i.type||'manual')===cur);
    $('#i_out').innerHTML=invTable(l);wireInvTable($('#i_out'),()=>go('invoices'));};
  $('#i_tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{cur=b.dataset.t;$('#i_tabs').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));render();});
  $('#i_new').onclick=()=>invoiceModal(null,()=>go('invoices'));
  render();
};

// ============================ STATEMENTS ============================
function stmtModal(username){
  const ym=new Date().toISOString().slice(0,7);
  modal('Monthly statement — '+username,`
  <div class="field"><label>Month</label><input id="s_ym" type="month" value="${ym}"/></div>
  <div class="actions"><button data-x>Cancel</button><button class="primary" id="s_go">Open PDF</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;$('#s_go',b).onclick=()=>{dl('/api/statements/'+encodeURIComponent(username)+'/'+$('#s_ym',b).value+'/pdf');c();};});
}
VIEWS.statements=async v=>{
  const clients=await api('/clients');
  const ym=new Date().toISOString().slice(0,7);
  v.innerHTML=`<h2 class="title">Monthly statements</h2>
  <p class="muted">Opening balance → top-ups → SMS usage → closing balance for any client & month (dates bucketed in Asia/Kathmandu). Generated live from payment + usage history.</p>
  <div class="toolbar">
    <div class="field" style="flex:0 0 220px"><label>Client</label><select id="s_u">${clients.map(c=>`<option>${esc(c.username)}</option>`).join('')}</select></div>
    <div class="field" style="flex:0 0 170px"><label>Month</label><input id="s_m" type="month" value="${ym}"/></div>
    <button class="primary" id="s_view">Preview</button>
    <button id="s_pdf">⬇ PDF</button>
    <button id="s_email">✉️ Email to client</button>
  </div>
  <div id="s_out"></div>`;
  const run=async()=>{
    const d=await api('/statements/'+encodeURIComponent($('#s_u').value)+'/'+$('#s_m').value);
    $('#s_out').innerHTML=`<div class="cards">
      <div class="card"><div class="k">Opening</div><div class="v sm">${eur3(d.opening)}</div></div>
      <div class="card"><div class="k">Top-ups</div><div class="v sm">${eur(d.topupTotal)}</div></div>
      <div class="card"><div class="k">Usage</div><div class="v sm">-${eur3(d.usageTotal.credits)}<span class="muted" style="font-size:11px"> · ${n2(d.usageTotal.parts)} seg</span></div></div>
      <div class="card"><div class="k">Closing</div><div class="v sm">${eur3(d.closing)}</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Top-ups</h3>${payTable(d.payments)}</div>
      <div class="panel"><h3>Usage by day</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Msgs</th><th>Segments</th><th>Charged</th></tr></thead><tbody>
      ${d.usage.map(u=>`<tr><td class="mono">${u.day}</td><td>${n2(u.count)}</td><td>${n2(u.parts)}</td><td>${eur3(u.credits)}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">No sends.</td></tr>'}</tbody></table></div></div>
    </div>`;
  };
  $('#s_view').onclick=run;
  $('#s_pdf').onclick=()=>dl('/api/statements/'+encodeURIComponent($('#s_u').value)+'/'+$('#s_m').value+'/pdf');
  $('#s_email').onclick=async()=>{const u=$('#s_u').value,m=$('#s_m').value;const to=prompt('Email the '+m+' statement to (blank = client\'s profile email):');if(to===null)return;try{const r=await api('/statements/'+encodeURIComponent(u)+'/'+m+'/email',{method:'POST',body:{to:to.trim()}});toast('Emailed to '+r.to);}catch(e){toast(e.message,true);}};
  if(clients.length)run();
};

// ============================ LEADS ============================
function leadModal(lead,reload){
  lead=lead||{};
  const f=(id,label,val,type)=>`<div class="field"><label>${label}</label><input id="${id}" type="${type||'text'}" value="${esc(val==null?'':val)}"/></div>`;
  modal(lead._id?'Edit lead':'New lead',`
  <div class="row">${f('l_name','Name *',lead.name)}${f('l_co','Company',lead.company)}</div>
  <div class="row">${f('l_em','Email',lead.email)}${f('l_ph','Phone',lead.phone)}</div>
  <div class="row">${f('l_tg','Telegram',lead.telegram)}${f('l_ct','Country',lead.country)}</div>
  <div class="row">${f('l_src','Source',lead.source)}
    <div class="field"><label>Stage</label><select id="l_st">${STAGES.map(([k,l])=>`<option value="${k}" ${lead.stage===k?'selected':''}>${l}</option>`).join('')}</select></div></div>
  <div class="row">${f('l_val','Est. value €/month',lead.est_value||0,'number')}${f('l_vol','Est. SMS/month',lead.est_volume||0,'number')}</div>
  ${f('l_fu','Next follow-up (Telegram reminder)',lead.next_follow_up?new Date(lead.next_follow_up).toISOString().slice(0,16):'','datetime-local')}
  <div class="field"><label>Notes</label><textarea id="l_no" rows="3">${esc(lead.notes||'')}</textarea></div>
  <div class="err" id="l_err"></div><div class="actions">
    ${lead._id?'<button class="danger" id="l_del">Delete</button>':''}
    ${lead._id&&!lead.converted_username?'<button id="l_conv">🏆 Convert to client</button>':''}
    <span class="right"></span><button data-x>Cancel</button><button class="primary" id="l_save">Save</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    $('#l_save',b).onclick=async()=>{try{
      const body={name:$('#l_name',b).value,company:$('#l_co',b).value,email:$('#l_em',b).value,phone:$('#l_ph',b).value,telegram:$('#l_tg',b).value,country:$('#l_ct',b).value,source:$('#l_src',b).value,stage:$('#l_st',b).value,est_value:Number($('#l_val',b).value)||0,est_volume:Number($('#l_vol',b).value)||0,next_follow_up:$('#l_fu',b).value?new Date($('#l_fu',b).value).toISOString():null,notes:$('#l_no',b).value};
      if(lead._id)await api('/leads/'+lead._id,{method:'PATCH',body});else await api('/leads',{method:'POST',body});
      c();toast('Saved');reload();
    }catch(e){$('#l_err',b).textContent=e.message;}};
    if($('#l_del',b))$('#l_del',b).onclick=async()=>{if(confirm('Delete lead?')){await api('/leads/'+lead._id,{method:'DELETE'});c();toast('Deleted');reload();}};
    if($('#l_conv',b))$('#l_conv',b).onclick=()=>{c();convertModal(lead,reload);};
  });
}
async function convertModal(lead,reload){
  const routes=await api('/routes').catch(()=>[]);
  const uname=(lead.company||lead.name||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,12);
  modal('Convert lead → client: '+lead.name,`
  <p class="muted" style="font-size:12px">Creates a real SMPP/portal user.</p>
  <div class="row"><div class="field"><label>Username *</label><input id="cv_u" value="${esc(uname)}"/></div>
  <div class="field"><label>Password * (exactly 8 chars)</label><input id="cv_p" maxlength="8" value="${pass8()}"/></div></div>
  <div class="row"><div class="field"><label>Price per SMS (€)</label><input id="cv_c" type="number" step="0.001" value="0.018"/></div>
  <div class="field"><label>📡 Route</label><select id="cv_r">${routeOpts(routes)}</select></div></div>
  <div class="err" id="cv_err"></div><div class="actions"><button data-x>Cancel</button><button class="primary" id="cv_go">Create client</button></div>`,
  (b,c)=>{b.querySelector('[data-x]').onclick=c;
    $('#cv_go',b).onclick=async()=>{try{
      const r=await api('/leads/'+lead._id+'/convert',{method:'POST',body:{username:$('#cv_u',b).value,password:$('#cv_p',b).value,cost_per_sms:Number($('#cv_c',b).value),route_id:$('#cv_r',b).value||null}});
      navigator.clipboard.writeText(`username: ${r.username}\npassword: ${$('#cv_p',b).value}`).catch(()=>{});
      c();toast('Client created (credentials copied)');go('client',r.username);
    }catch(e){$('#cv_err',b).textContent=e.message;}};});
}
VIEWS.leads=async v=>{
  const leads=await api('/leads');
  v.innerHTML=`<h2 class="title">Leads pipeline</h2>
  <div class="section-actions"><button class="primary" id="l_new">+ New lead</button>
  <span class="muted" style="font-size:12px;align-self:center">Click a card to edit · use stage buttons to move it along · "Won" leads can be converted into real clients.</span></div>
  <div class="kanban">${STAGES.map(([k,label])=>{
    const ls=leads.filter(l=>l.stage===k);
    return `<div class="kcol"><h4>${label}<span>${ls.length}</span></h4>
    ${ls.map(l=>`<div class="kcard" data-l="${l._id}">
      <div class="nm">${esc(l.name)}${l.converted_username?' <span class="badge green">client</span>':''}</div>
      <div class="meta">${esc(l.company||'')}${l.company?'<br/>':''}${l.est_value?'est '+eur(l.est_value)+'/mo':''}${l.next_follow_up?'<br/>⏰ '+fdate(l.next_follow_up):''}</div>
      <div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">${STAGES.filter(([s])=>s!==k&&!(l.converted_username&&(s==='won'))).slice(0,5).map(([s,sl])=>`<button class="sm ghost" data-mv="${l._id}" data-st="${s}" title="move to ${s}" style="padding:2px 7px;font-size:10px">${sl.split(' ')[0]}</button>`).join('')}</div>
    </div>`).join('')||'<p class="muted" style="font-size:11px;text-align:center">empty</p>'}</div>`;}).join('')}</div>`;
  $('#l_new').onclick=()=>leadModal(null,()=>go('leads'));
  v.querySelectorAll('.kcard').forEach(c=>c.onclick=e=>{if(e.target.dataset.mv)return;leadModal(leads.find(l=>l._id===c.dataset.l),()=>go('leads'));});
  v.querySelectorAll('[data-mv]').forEach(b=>b.onclick=async e=>{e.stopPropagation();await api('/leads/'+b.dataset.mv,{method:'PATCH',body:{stage:b.dataset.st}});go('leads');});
};

// ============================ TASKS ============================
VIEWS.tasks=async v=>{
  const [open,done]=await Promise.all([api('/activities?tasks=1&done=0'),api('/activities?tasks=1&done=1')]);
  const table=(list,isOpen)=>`<div class="table-wrap"><table><thead><tr><th>Due</th><th>Who</th><th>Type</th><th>Task</th><th></th></tr></thead><tbody>
  ${list.map(t=>{const late=isOpen&&new Date(t.due_at)<new Date();return `<tr>
    <td>${late?`<span class="badge red">${fdate(t.due_at)}</span>`:fdate(t.due_at)}</td>
    <td>${t.ref_type==='client'?`<a onclick="window.__go('client','${esc(t.ref_id)}')"><b>${esc(t.ref_name||t.ref_id)}</b></a>`:`🎯 ${esc(t.ref_name||'lead')}`}</td>
    <td>${kindIc[t.kind]||'📝'} ${esc(t.kind)}</td><td class="wrap">${esc(t.body)}</td>
    <td>${isOpen?`<button class="sm" data-done="${t._id}">✓ Done</button>`:''} <button class="sm danger" data-del="${t._id}">✕</button></td></tr>`;}).join('')||`<tr><td colspan="5" class="muted">${isOpen?'No open tasks — add follow-ups from a client or lead.':'none'}</td></tr>`}</tbody></table></div>`;
  v.innerHTML=`<h2 class="title">Tasks & follow-ups</h2>
  <p class="muted" style="font-size:12px">Due tasks fire a Telegram reminder (operator bot) within a minute of their due time.</p>
  <div class="panel"><h3>⏳ Open</h3>${table(open,true)}</div>
  <div class="panel"><h3>✅ Done (recent)</h3>${table(done.slice(0,20),false)}</div>`;
  v.querySelectorAll('[data-done]').forEach(b=>b.onclick=async()=>{await api('/activities/'+b.dataset.done,{method:'PATCH',body:{done:true}});toast('Done');go('tasks');});
  v.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(confirm('Delete task?')){await api('/activities/'+b.dataset.del,{method:'DELETE'});go('tasks');}});
};

// ============================ TRAFFIC & DLR ============================
const dlrColor={delivered:'green',accepted:'blue',undelivered:'red',rejected:'red',expired:'yellow',unknown:'gray',pending:'gray'};
VIEWS.traffic=async v=>{
  const ymd=(d)=>{try{return new Intl.DateTimeFormat('en-CA',{timeZone:VIEW_TZ}).format(d);}catch(_){return new Date(d).toISOString().slice(0,10);}};
  const to=ymd(new Date()), from=ymd(new Date(Date.now()-29*864e5));
  v.innerHTML=`<h2 class="title">📡 Traffic & DLR</h2>
  <p class="muted">Sending totals come from the permanent usage log (kept forever). The DLR breakdown is from message logs, which keep a rolling <b>7-day</b> window.</p>
  <div id="tf_cards"><p class="muted">Loading…</p></div>
  <div class="grid2">
    <div class="panel"><h3>📬 Delivery breakdown <span class="right muted" style="font-size:12px">last 7 days</span></h3><div id="tf_dlr"></div></div>
    <div class="panel"><h3>🏆 Top senders <span class="right muted" style="font-size:12px">last 30 days</span></h3><div id="tf_top" class="table-wrap" style="max-height:300px;overflow:auto"></div></div>
  </div>
  <div class="panel"><h3>🗄️ Permanent DLR history <span class="right muted" style="font-size:12px">from the file archive — survives forever</span></h3>
    <div class="toolbar">
      <div class="field" style="flex:0 0 200px"><label>Client</label><select id="dh_u"><option value="">All clients</option></select></div>
      <div class="field" style="flex:0 0 150px"><label>From</label><input id="dh_from" type="date" value="${from}"/></div>
      <div class="field" style="flex:0 0 150px"><label>To</label><input id="dh_to" type="date" value="${to}"/></div>
      <button class="primary" id="dh_run">Run</button>
    </div>
    <div id="dh_out"><p class="muted">Pick a range and Run — this reads the permanent DLR archive (any month, not just the last 7 days).</p></div>
  </div>
  <div class="panel"><h3>📅 Sending by day</h3>
    <div class="toolbar">
      <div class="field" style="flex:0 0 200px"><label>Client</label><select id="tf_u"><option value="">All clients</option></select></div>
      <div class="field" style="flex:0 0 150px"><label>From</label><input id="tf_from" type="date" value="${from}"/></div>
      <div class="field" style="flex:0 0 150px"><label>To</label><input id="tf_to" type="date" value="${to}"/></div>
      <button class="primary" id="tf_run">Run</button>
      <button id="tf_csv">⬇ CSV</button>
    </div>
    <div id="tf_chart"></div>
    <div id="tf_table"></div>
  </div>`;

  const [sum,top,clients]=await Promise.all([api('/traffic/summary?days=7'),api('/traffic/clients?days=30'),api('/clients').catch(()=>[])]);
  $('#tf_u').innerHTML='<option value="">All clients</option>'+clients.map(c=>`<option>${esc(c.username)}</option>`).join('');
  const s=sum.sending;
  $('#tf_cards').innerHTML=`<div class="cards">
    <div class="card"><div class="ic">📤</div><div class="k">Sent today</div><div class="v">${n2(s.today.messages)}<span class="muted" style="font-size:12px"> · ${n2(s.today.parts)} seg</span></div></div>
    <div class="card"><div class="ic">📆</div><div class="k">This month</div><div class="v sm">${n2(s.month.messages)}<span class="muted" style="font-size:12px"> · ${n2(s.month.parts)} seg</span></div></div>
    <div class="card"><div class="ic">∑</div><div class="k">All-time messages</div><div class="v sm">${n2(s.all.messages)}</div></div>
    <div class="card"><div class="ic">🧩</div><div class="k">All-time segments</div><div class="v sm">${n2(s.all.parts)}</div></div>
    <div class="card"><div class="ic">✅</div><div class="k">Delivered % (7d)</div><div class="v">${sum.deliveredPct}%</div></div>
    <div class="card"><div class="ic">❌</div><div class="k">Failed (all-time)</div><div class="v sm">${n2(s.all.failed)}</div></div>
  </div>`;
  // DLR bars
  const tot=sum.dlrTotal||0;
  $('#tf_dlr').innerHTML=tot?Object.entries(sum.dlr).filter(([k,n])=>n>0).map(([k,n])=>`
    <div class="kv"><span><span class="badge ${dlrColor[k]||'gray'}">${k}</span></span>
    <span style="flex:1"><div class="bar-track"><div class="bar-fill" style="width:${Math.round(n/tot*100)}%"></div></div></span>
    <b style="flex:0 0 90px;text-align:right">${n2(n)} · ${Math.round(n/tot*100)}%</b></div>`).join('')
    +`<p class="muted" style="font-size:12px;margin-top:10px">${n2(tot)} messages in the last 7 days · <b>${sum.status.failed||0}</b> failed at send</p>`
    :'<p class="muted">No messages in the last 7 days.</p>';
  // Top senders
  $('#tf_top').innerHTML=`<table><thead><tr><th>Client</th><th>Msgs</th><th>Seg</th><th>Credits</th><th>Deliv(7d)</th></tr></thead><tbody>${top.rows.map(r=>`<tr><td><a onclick="window.__go('client','${esc(r.username)}')"><b>${esc(r.username)}</b></a></td><td>${n2(r.messages)}</td><td>${n2(r.parts)}</td><td>${eur3(r.credits)}</td><td>${r.failed?`<span class="badge red">${n2(r.failed)} fail</span> `:''}${n2(r.delivered7)}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No sends in 30 days.</td></tr>'}</tbody></table>`;
  // daily
  const params=()=>{const p=new URLSearchParams({from:$('#tf_from').value,to:$('#tf_to').value,tz:VIEW_TZ});if($('#tf_u').value)p.set('username',$('#tf_u').value);return p;};
  const runDaily=async()=>{
    const d=await api('/traffic/daily?'+params());const rows=d.rows||[];
    const max=Math.max(1,...rows.map(r=>r.parts));
    $('#tf_chart').innerHTML=rows.length?`<div class="chart">${rows.map(r=>`<div class="bar" style="height:${Math.round(r.parts/max*120)+3}px"><span>${n2(r.parts)} seg</span></div>`).join('')}</div><div class="chart-x">${rows.map(r=>`<div>${esc(r.day.slice(5))}</div>`).join('')}</div>`:'<p class="muted">No sends in this range.</p>';
    const t=rows.reduce((a,r)=>({m:a.m+r.messages,s:a.s+r.sent,f:a.f+r.failed,p:a.p+r.parts,c:a.c+r.credits}),{m:0,s:0,f:0,p:0,c:0});
    $('#tf_table').innerHTML=`<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Date</th><th>Messages</th><th>Sent</th><th>Failed</th><th>Segments</th><th>Credits</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="mono">${esc(r.day)}</td><td>${n2(r.messages)}</td><td><span class="badge green">${n2(r.sent)}</span></td><td>${r.failed?`<span class="badge red">${n2(r.failed)}</span>`:'0'}</td><td>${n2(r.parts)}</td><td>${eur3(r.credits)}</td></tr>`).join('')}<tr style="font-weight:700;border-top:2px solid var(--border)"><td>Total</td><td>${n2(t.m)}</td><td>${n2(t.s)}</td><td>${n2(t.f)}</td><td>${n2(t.p)}</td><td>${eur3(t.c)}</td></tr></tbody></table></div>`;
  };
  // permanent DLR history (file archive)
  $('#dh_u').innerHTML='<option value="">All clients</option>'+clients.map(c=>`<option>${esc(c.username)}</option>`).join('');
  const dhParams=()=>{const p=new URLSearchParams({from:$('#dh_from').value,to:$('#dh_to').value,tz:VIEW_TZ});if($('#dh_u').value)p.set('username',$('#dh_u').value);return p;};
  $('#dh_run').onclick=async()=>{
    $('#dh_out').innerHTML='<p class="muted">Reading archive…</p>';
    const d=await api('/traffic/dlr-history?'+dhParams());
    const tot=d.total||0;
    $('#dh_out').innerHTML=`<div class="cards" style="grid-template-columns:repeat(4,1fr)">
      <div class="card"><div class="k">Messages</div><div class="v sm">${n2(tot)}</div></div>
      <div class="card"><div class="k">Segments</div><div class="v sm">${n2(d.parts)}</div></div>
      <div class="card"><div class="k">Delivered %</div><div class="v sm">${d.deliveredPct}%</div></div>
      <div class="card"><div class="k">Failed</div><div class="v sm">${n2(d.failed)}</div></div>
    </div>
    ${tot?`<div style="margin-top:6px">${Object.entries(d.dlr).filter(([k,n])=>n>0).map(([k,n])=>`<div class="kv"><span><span class="badge ${dlrColor[k]||'gray'}">${k}</span></span><span style="flex:1"><div class="bar-track"><div class="bar-fill" style="width:${Math.round(n/tot*100)}%"></div></div></span><b style="flex:0 0 90px;text-align:right">${n2(n)} · ${Math.round(n/tot*100)}%</b></div>`).join('')}</div>
    <p class="muted" style="font-size:12px;margin-top:8px">Archived months: ${(d.months||[]).join(', ')||'none yet'}</p>`:'<p class="muted">No archived messages in this range.</p>'}`;
  };
  $('#tf_run').onclick=runDaily;
  $('#tf_csv').onclick=()=>{const rows=[['date','messages','sent','failed','segments','credits']];api('/traffic/daily?'+params()).then(d=>{(d.rows||[]).forEach(r=>rows.push([r.day,r.messages,r.sent,r.failed,r.parts,r.credits]));const csv=rows.map(r=>r.join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='sending.csv';a.click();});};
  runDaily();
};

// ============================ AUTO-TEMPLATES ============================
VIEWS.templates=async v=>{
  const d=await api('/templates');
  const p=d.policy||{};
  v.innerHTML=`<h2 class="title">🔤 Auto-templates</h2>
  <p class="muted">Clients send <b>only a numeric code</b> (e.g. <span class="mono">847291</span>). The gateway picks a <b>random</b> template from this shared pool and wraps the code into it — so traffic is properly templated. Non-numeric messages are rejected.</p>
  <div class="grid2">
    <div class="panel"><h3>⚙️ Policy</h3>
      <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="pl_force" ${p.force_auto_template?'checked':''}/> &nbsp;<b>Force auto-template for ALL users</b> (overrides any client's passthrough)</label><br/>
      <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="pl_num" ${p.numeric_only!==false?'checked':''}/> &nbsp;Numbers only (reject anything that isn't a bare code)</label>
      <div class="row"><div class="field"><label>Min digits</label><input id="pl_min" type="number" min="1" max="20" value="${p.min_len||4}"/></div>
      <div class="field"><label>Max digits</label><input id="pl_max" type="number" min="1" max="20" value="${p.max_len||10}"/></div></div>
      <button class="primary" id="pl_save">Save policy</button> <span class="ok" id="pl_ok"></span>
      <hr style="border:none;border-top:1px solid var(--border);margin:16px 0"/>
      <p class="muted" style="font-size:12px">Make every existing client numbers-only in one click:</p>
      <button id="pl_all">🔁 Apply auto-template to all clients</button>
    </div>
    <div class="panel"><h3>🧪 Live preview</h3>
      <div class="field"><label>Try a code</label><input id="pl_try" value="847291"/></div>
      <button class="sm" id="pl_roll">🎲 Roll 5 random templates</button>
      <div id="pl_prev" class="mono" style="font-size:12px;line-height:1.9;margin-top:12px"></div>
    </div>
  </div>
  <div class="panel"><h3>📚 Template pool <span class="right muted" style="font-size:12px">${d.count} templates</span></h3>
    <div class="toolbar">
      <div class="field" style="flex:2"><label>Add a template (use XXXXXX where the code goes)</label><input id="tp_new" placeholder="Mybiz: XXXXXX is your verification code."/></div>
      <button class="primary" id="tp_add">Add</button>
      ${d.count<200?'<button id="tp_seed">⬇ Load 596-template library</button>':'<button id="tp_seed">↻ Re-merge library</button>'}
      <div class="field" style="flex:0 0 200px"><label>Filter</label><input id="tp_q" placeholder="search…"/></div>
    </div>
    <div class="table-wrap" style="max-height:460px;overflow:auto"><table><thead><tr><th>#</th><th>Template</th><th></th></tr></thead><tbody id="tp_rows"></tbody></table></div>
  </div>`;
  const inject=(tpl,code)=>String(tpl).replace(/\{\{?\s*(code|otp|pin)\s*\}?\}/gi,code).replace(/X{3,}/gi,code).replace(/#{3,}/g,code);
  const roll=()=>{const code=($('#pl_try').value||'847291').trim();const picks=[];for(let i=0;i<5;i++)picks.push(d.templates[Math.floor(Math.random()*d.templates.length)]);$('#pl_prev').innerHTML=picks.map(t=>`<div>• ${esc(inject(t,code))}</div>`).join('')||'<span class="muted">pool empty</span>';};
  const renderRows=q=>{q=(q||'').toLowerCase();const list=d.templates.map((t,i)=>[t,i]).filter(([t])=>!q||t.toLowerCase().includes(q));
    $('#tp_rows').innerHTML=list.map(([t,i])=>`<tr><td class="muted">${i+1}</td><td class="wrap">${esc(t)}</td><td><button class="sm danger" data-del='${esc(JSON.stringify(t))}'>✕</button></td></tr>`).join('')||'<tr><td colspan="3" class="muted">no matches</td></tr>';
    $('#tp_rows').querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{await api('/templates',{method:'POST',body:{remove:JSON.parse(b.dataset.del)}});toast('Removed');go('templates');});};
  $('#pl_save').onclick=async()=>{await api('/policy',{method:'POST',body:{force_auto_template:$('#pl_force').checked,numeric_only:$('#pl_num').checked,min_len:Number($('#pl_min').value),max_len:Number($('#pl_max').value)}});$('#pl_ok').textContent='Saved.';toast('Policy saved');};
  $('#pl_all').onclick=async()=>{if(confirm('Set every client to auto-template (numbers-only) now?')){const r=await api('/templates/apply-all',{method:'POST'});toast(`Applied to ${r.updated} client(s)`);}};
  $('#pl_roll').onclick=roll;$('#pl_try').addEventListener('input',roll);
  $('#tp_add').onclick=async()=>{const val=$('#tp_new').value.trim();if(!val)return toast('Enter a template',true);if(!/X{3,}|\{\{?\s*(code|otp|pin)/i.test(val))return toast('Include XXXXXX (or {{code}}) where the code goes',true);await api('/templates',{method:'POST',body:{add:val}});toast('Added');go('templates');};
  $('#tp_seed').onclick=async()=>{const r=await api('/templates/seed',{method:'POST'});toast(`Library loaded — ${r.count} total (+${r.added})`);go('templates');};
  $('#tp_q').addEventListener('input',e=>renderRows(e.target.value));
  renderRows('');roll();
};

// ============================ DOMAINS ============================
const SVC_NAMES={2775:'SMPP bind',3000:'Admin panel',4000:'Client portal',5000:'CRM (this panel)',8800:'Site',8801:'Proxy admin',9999:'CYD flasher'};
VIEWS.domains=async v=>{
  let d;
  try{d=await api('/domains');}catch(e){v.innerHTML=`<h2 class="title">🌐 Domains</h2><div class="panel" style="border-color:var(--red)"><b>Reverse proxy unreachable:</b> ${esc(e.message)}</div>`;return;}
  const hosts=Object.entries(d.routes||{}).sort((a,b)=>a[0].localeCompare(b[0]));
  v.innerHTML=`<h2 class="title">🌐 Domains</h2>
  <div class="panel">
    <h3>How it works <span class="badge green">🔒 auto-HTTPS</span></h3>
    <div class="kv"><span>1. DNS</span><span>At your domain registrar, create an <b>A record</b> → <b>${copy(d.ip)}</b> (or a wildcard <span class="mono">*.bhairavsms.org</span> to cover every subdomain at once)</span></div>
    <div class="kv"><span>2. Map it</span><span>Add the domain below and pick which service it opens — applied <b>instantly</b>, no restarts</span></div>
    <div class="kv"><span>3. HTTPS</span><span>Caddy fetches a free <b>Let's Encrypt</b> certificate automatically on the first visit (and auto-renews). No setup — just open <span class="mono">https://</span> once DNS resolves.</span></div>
    <div class="kv"><span>4. Check</span><span>Use <b>DNS?</b> to confirm the record reached the internet (can take a few minutes after creating it)</span></div>
  </div>
  <div class="panel"><h3>➕ Add domain</h3>
    <div class="toolbar">
      <div class="field" style="flex:2"><label>Domain (no http://)</label><input id="dm_host" placeholder="crm.yourdomain.com"/></div>
      <div class="field" style="flex:0 0 230px"><label>Points to</label><select id="dm_svc">
        <option value="5000">CRM (this panel) — :5000</option>
        <option value="3000">Admin panel — :3000</option>
        <option value="4000">Client portal — :4000</option>
        <option value="custom">Custom port…</option>
      </select></div>
      <div class="field hidden" id="dm_pwrap" style="flex:0 0 110px"><label>Port</label><input id="dm_port" type="number" min="1" max="65535"/></div>
      <button class="primary" id="dm_add">Add</button>
    </div>
    <div class="err" id="dm_err"></div>
  </div>
  <div class="panel"><h3>Mapped domains ${d.health?`<span class="right muted" style="font-size:11px">proxy :${d.health.proxyPort} · ${d.health.routes} route(s)</span>`:''}</h3>
    <div class="table-wrap"><table><thead><tr><th>Domain</th><th>→ Service</th><th>Enabled</th><th>DNS</th><th></th></tr></thead><tbody>
    ${hosts.map(([h,r])=>`<tr>
      <td><a href="https://${esc(h)}" target="_blank">🔒 <b>${esc(h)}</b></a></td>
      <td class="mono">:${r.target_port} <span class="muted">${esc(SVC_NAMES[r.target_port]||'')}</span></td>
      <td><label class="switch"><input type="checkbox" data-en="${esc(h)}" ${r.enabled?'checked':''}/></label></td>
      <td><span id="dns-${esc(h).replace(/[^a-z0-9]/g,'_')}"><button class="sm" data-dns="${esc(h)}">DNS?</button></span></td>
      <td><button class="sm danger" data-rm="${esc(h)}">Remove</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">No domains mapped yet.</td></tr>'}
    </tbody></table></div>
    <p class="muted" style="font-size:12px">Wildcards work too: <span class="mono">*.yourdomain.com</span> catches every subdomain. Removing a mapping only stops the proxy — your DNS record stays untouched.</p>
  </div>`;
  const svcSel=$('#dm_svc');svcSel.onchange=()=>{$('#dm_pwrap').classList.toggle('hidden',svcSel.value!=='custom');};
  $('#dm_add').onclick=async()=>{
    $('#dm_err').textContent='';
    const port=svcSel.value==='custom'?$('#dm_port').value:svcSel.value;
    try{await api('/domains',{method:'POST',body:{host:$('#dm_host').value,port}});toast('Domain mapped — live now');go('domains');}
    catch(e){$('#dm_err').textContent=e.message;}
  };
  v.querySelectorAll('[data-rm]').forEach(b=>b.onclick=async()=>{if(confirm(`Remove ${b.dataset.rm}? The domain will stop working immediately.`)){await api('/domains/'+encodeURIComponent(b.dataset.rm),{method:'DELETE'});toast('Removed');go('domains');}});
  v.querySelectorAll('[data-en]').forEach(b=>b.onchange=async()=>{await api('/domains/'+encodeURIComponent(b.dataset.en),{method:'PATCH',body:{enabled:b.checked}});toast(b.checked?'Enabled':'Disabled');});
  v.querySelectorAll('[data-dns]').forEach(b=>b.onclick=async()=>{
    const h=b.dataset.dns;const slot=$('#dns-'+h.replace(/[^a-z0-9]/g,'_'));
    slot.innerHTML='<span class="muted">checking…</span>';
    try{const r=await api('/domains/'+encodeURIComponent(h)+'/dnscheck');
      slot.innerHTML=r.ok?'<span class="badge green">✓ points here</span>':r.ips.length?`<span class="badge red" title="resolves to ${esc(r.ips.join(', '))}">✗ wrong IP</span>`:`<span class="badge yellow">${esc(r.error||'no record')}</span>`;
    }catch(e){slot.innerHTML='<span class="badge gray">check failed</span>';}
  });
};

// ============================ SETTINGS ============================
VIEWS.settings=async v=>{
  const s=await api('/crm-settings');
  const co=s.company||{},cr=s.crypto||{},rm=s.reminders||{},sm=s.smtp||{},ma=s.mail||{};
  v.innerHTML=`<h2 class="title">Settings</h2>
  <div class="grid2">
    <div class="panel"><h3>🏢 Company (appears on invoices & receipts)</h3>
      <div class="field"><label>Company name</label><input id="co_name" value="${esc(co.name||'')}" placeholder="Your SMS Company"/></div>
      <div class="field"><label>Address</label><input id="co_addr" value="${esc(co.address||'')}"/></div>
      <div class="row">
        <div class="field"><label>Email</label><input id="co_email" value="${esc(co.email||'')}"/></div>
        <div class="field"><label>Phone</label><input id="co_phone" value="${esc(co.phone||'')}"/></div>
      </div>
      <div class="field"><label>VAT / registration #</label><input id="co_vat" value="${esc(co.vat||'')}"/></div>
      <div class="field"><label>Invoice footer line</label><input id="co_foot" value="${esc(co.footer||'')}" placeholder="Thank you for your business."/></div>
      <div class="field"><label>Logo (PNG/JPEG ≤ 2 MB — shown on invoice, receipt & statement PDFs)</label>
        <div class="row" style="align-items:center">
          <div id="logo_prev" style="flex:0 0 auto">${s.has_logo?`<img src="/api/crm-settings/logo?ts=${Date.now()}" style="max-height:48px;max-width:170px;background:#fff;border-radius:6px;padding:4px"/>`:'<span class="muted" style="font-size:12px">no logo yet</span>'}</div>
          <input type="file" id="logo_file" accept="image/png,image/jpeg" style="flex:1"/>
          <button class="sm" id="logo_up" style="flex:0 0 auto">Upload</button>
          ${s.has_logo?'<button class="sm danger" id="logo_rm" style="flex:0 0 auto">Remove</button>':''}
        </div>
      </div>
    </div>
    <div class="panel"><h3>₮ Crypto auto top-ups (USDT TRC-20)</h3>
      <div class="field"><label>Your TRC-20 wallet address (starts with T…)</label><input id="cr_wallet" class="mono" value="${esc(cr.wallet||'')}" placeholder="TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"/></div>
      <div class="row">
        <div class="field"><label>Rate mode</label><select id="cr_mode"><option value="auto" ${cr.rate_mode!=='fixed'?'selected':''}>Auto (CoinGecko, free)</option><option value="fixed" ${cr.rate_mode==='fixed'?'selected':''}>Fixed</option></select></div>
        <div class="field"><label>Fixed rate (EUR per USDT)</label><input id="cr_rate" type="number" step="0.0001" value="${cr.fixed_rate||''}"/></div>
      </div>
      <div class="row">
        <div class="field"><label>Margin % added to USDT amount</label><input id="cr_margin" type="number" step="0.1" value="${cr.margin_pct||0}"/></div>
        <div class="field"><label>Intent validity (minutes)</label><input id="cr_ttl" type="number" value="${cr.intent_ttl_min||120}"/></div>
        <div class="field"><label>Minimum payment (USDT) — exchange deposit limit</label><input id="cr_min" type="number" step="0.5" value="${cr.min_usdt==null?5:cr.min_usdt}"/></div>
      </div>
      <p class="muted" style="font-size:12px">⚠️ Binance swallows TRC-20 deposits under <b>5 USDT</b> — they show on-chain but are never credited. Requests below this minimum are refused (record small payments manually instead). Set 0 only if you receive into a self-custody wallet like TronLink.</p>
      <p class="muted" style="font-size:12px">Watcher polls the free TronGrid API every 30s for confirmed transfers to this wallet. Keep the wallet in your own custody (e.g. TronLink / hardware) — the CRM only ever <b>reads</b> the chain; no keys are stored.</p>
    </div>
  </div>
  <div class="panel"><h3>🛡️ Money safety — books & backups</h3>
    <div id="safety_box"><p class="muted">Loading…</p></div>
    <div class="actions" style="justify-content:flex-start"><button class="sm" id="ledger_now">🔍 Verify books now</button></div>
    <p class="muted" style="font-size:12px">Every night: the ledger check re-computes each account's balance from its full transaction history (any mismatch = 🚨 Telegram alert), and a restore-tested MongoDB + config backup is taken at 03:00 (kept 14 days in /root/backups). You get one 🛡️ summary on Telegram daily.</p>
  </div>
  <div class="panel"><h3>📧 Email (SMTP) — send invoices, receipts & statements</h3>
    <div class="row">
      <div class="field" style="flex:2"><label>SMTP host</label><input id="sm_host" value="${esc(sm.host||'')}" placeholder="smtp.hostinger.com"/></div>
      <div class="field" style="flex:0 0 110px"><label>Port</label><input id="sm_port" type="number" value="${sm.port||465}"/></div>
      <div class="field" style="flex:0 0 130px"><label>TLS</label><select id="sm_secure"><option value="1" ${sm.secure!==false?'selected':''}>SSL (465)</option><option value="0" ${sm.secure===false?'selected':''}>STARTTLS (587)</option></select></div>
    </div>
    <div class="row">
      <div class="field"><label>Username (full mailbox address)</label><input id="sm_user" value="${esc(sm.user||'')}" placeholder="billing@yourdomain.com"/></div>
      <div class="field"><label>Password</label><input id="sm_pass" type="password" placeholder="${sm.has_pass?'•••••• (saved — leave blank to keep)':'mailbox password'}"/></div>
    </div>
    <div class="row">
      <div class="field"><label>From address (optional)</label><input id="sm_from" value="${esc(sm.from||'')}" placeholder="defaults to username"/></div>
      <div class="field"><label>From name (optional)</label><input id="sm_fromname" value="${esc(sm.from_name||'')}" placeholder="${esc(co.name||'Your Company')}"/></div>
    </div>
    <p class="muted" style="font-size:12px">Hostinger: host <b>smtp.hostinger.com</b>, port <b>465</b> (SSL), username = full mailbox address. Save first, then test.</p>
    <div class="row" style="align-items:center">
      <input id="sm_testto" placeholder="send a test email to… (optional)" style="flex:1"/>
      <button class="sm" id="sm_test" style="flex:0 0 auto">✉️ Test connection</button>
      <span id="sm_tres" style="flex:0 0 auto"></span>
    </div>
  </div>
  <div class="panel"><h3>⏰ Reminders</h3>
    <label class="switch"><input type="checkbox" id="rm_on" ${rm.enabled!==false?'checked':''}/> Send Telegram reminders for due follow-ups (uses the System Telegram bot from the admin panel)</label>
    <label class="switch"><input type="checkbox" id="rm_ovd" ${rm.email_overdue?'checked':''}/> Also email clients automatically when a manual invoice goes overdue (needs SMTP above)</label>
  </div>
  <div class="panel"><h3>📨 Mail — alerts, signature & templates</h3>
    <div class="field"><label>New-mail Telegram alerts</label><select id="ml_notify">
      <option value="clients" ${(ma.notify||'clients')==='clients'?'selected':''}>Only when a known client emails (recommended)</option>
      <option value="all" ${ma.notify==='all'?'selected':''}>Every new email</option>
      <option value="off" ${ma.notify==='off'?'selected':''}>Off</option>
    </select><p class="muted" style="font-size:12px">Incoming client mail is always auto-logged to that client's timeline regardless of this setting.</p></div>
    <div class="field"><label>Email signature (auto-appended to messages you compose)</label><textarea id="ml_sig" rows="4" placeholder="Bhairav SMS&#10;sales@bhairavsms.org&#10;+977…">${esc(ma.signature||'')}</textarea></div>
    <div class="field"><label>Reply templates</label><div id="ml_tpls"></div><button class="sm" id="ml_addtpl" type="button">+ Add template</button></div>
  </div>
  <button class="primary" id="st_save">Save settings</button> <span class="ok" id="st_ok"></span>`;
  const tplRow=(t)=>{const row=h(`<div class="row tplrow" style="align-items:flex-start;gap:6px;margin-bottom:6px">
    <input class="tpl_name" placeholder="name" value="${esc((t&&t.name)||'')}" style="flex:0 0 160px"/>
    <textarea class="tpl_body" rows="2" placeholder="template text" style="flex:1">${esc((t&&t.body)||'')}</textarea>
    <button class="sm danger tpl_del" type="button" style="flex:0 0 auto">✕</button></div>`);
    row.querySelector('.tpl_del').onclick=()=>row.remove();return row;};
  (ma.templates||[]).forEach(t=>$('#ml_tpls').appendChild(tplRow(t)));
  $('#ml_addtpl').onclick=()=>$('#ml_tpls').appendChild(tplRow());
  $('#st_save').onclick=async()=>{
    await api('/crm-settings',{method:'POST',body:{
      company:{name:$('#co_name').value,address:$('#co_addr').value,email:$('#co_email').value,phone:$('#co_phone').value,vat:$('#co_vat').value,footer:$('#co_foot').value},
      crypto:{wallet:$('#cr_wallet').value.trim(),rate_mode:$('#cr_mode').value,fixed_rate:Number($('#cr_rate').value)||0,margin_pct:Number($('#cr_margin').value)||0,intent_ttl_min:Number($('#cr_ttl').value)||120,min_usdt:Number($('#cr_min').value)||0},
      reminders:{enabled:$('#rm_on').checked,email_overdue:$('#rm_ovd').checked},
      smtp:{host:$('#sm_host').value.trim(),port:Number($('#sm_port').value)||465,secure:$('#sm_secure').value==='1',user:$('#sm_user').value.trim(),pass:$('#sm_pass').value,from:$('#sm_from').value.trim(),from_name:$('#sm_fromname').value.trim()},
      mail:{notify:$('#ml_notify').value,signature:$('#ml_sig').value,templates:[...document.querySelectorAll('#ml_tpls .tplrow')].map(r=>({name:r.querySelector('.tpl_name').value.trim(),body:r.querySelector('.tpl_body').value})).filter(t=>t.name&&t.body)},
    }});
    window.__mailcfgClear&&window.__mailcfgClear();
    $('#st_ok').textContent='Saved.';toast('Settings saved');
  };
  $('#sm_test').onclick=async()=>{
    const res=$('#sm_tres');res.innerHTML='<span class="muted">testing…</span>';
    try{const r=await api('/email/test',{method:'POST',body:{to:$('#sm_testto').value.trim()}});
      res.innerHTML=`<span class="badge green">✓ ${r.sent?'sent test email':'login OK'}</span>`;
    }catch(e){res.innerHTML=`<span class="badge red">✗ ${esc(e.message)}</span>`;}
  };
  $('#logo_up').onclick=async()=>{
    const f=$('#logo_file').files[0];
    if(!f)return toast('Choose a PNG or JPEG file first',true);
    const fd=new FormData();fd.append('logo',f);
    const r=await fetch('/api/crm-settings/logo',{method:'POST',body:fd});
    if(!r.ok){const d=await r.json().catch(()=>({}));return toast(d.error||'Upload failed',true);}
    toast('Logo uploaded');go('settings');
  };
  if($('#logo_rm'))$('#logo_rm').onclick=async()=>{if(confirm('Remove the logo?')){await api('/crm-settings/logo',{method:'DELETE'});toast('Removed');go('settings');}};
  const renderSafety=d=>{const L=d.ledger,B=d.backup;
    const lg=L?(L.issues&&L.issues.length
      ?`<span class="badge red">🚨 ${L.issues.length} mismatch</span> ${L.issues.map(i=>`<b>${esc(i.username)}</b> Δ€${Number(i.delta).toFixed(3)}`).join(', ')}`
      :`<span class="badge green">✓ books match</span> ${L.verified} account(s) verified${L.anchored?`, ${L.anchored} baselined`:''} · ${fdate(L.at)}`)
      :'<span class="badge gray">not run yet</span> first check runs tonight';
    const bk=B?(B.ok
      ?`<span class="badge green">✓ ${esc(B.size_h||'')}</span>${B.verified?' restore-tested':''} · ${fdate(B.at)}`
      :`<span class="badge red">✘ failed</span> ${esc(B.error||'')} · ${fdate(B.at)}`)
      :'<span class="badge gray">none yet</span> first backup tonight 03:00';
    $('#safety_box').innerHTML=`<div class="kv"><span>Ledger (books vs transactions)</span><span>${lg}</span></div><div class="kv"><span>Last backup</span><span>${bk}</span></div>`;};
  api('/ledger/status').then(renderSafety).catch(()=>{$('#safety_box').innerHTML='<p class="muted">Couldn\'t load status.</p>';});
  $('#ledger_now').onclick=async()=>{const b=$('#ledger_now');b.disabled=true;b.textContent='Checking…';
    try{const r=await api('/ledger/check',{method:'POST'});toast(r.issues.length?`🚨 ${r.issues.length} mismatch(es)!`:`✓ ${r.verified} account(s) verified`,r.issues.length>0);renderSafety({ledger:r,backup:null});api('/ledger/status').then(renderSafety).catch(()=>{});}
    catch(e){toast(e.message,true);}b.disabled=false;b.textContent='🔍 Verify books now';};
};

// ============================ MAIL (IMAP worksuite) ============================
const MAIL={folder:'INBOX',role:'inbox',page:1,search:'',folders:[]};
const folderIc={inbox:'📥',sent:'📤',drafts:'📝',junk:'⚠️',trash:'🗑',archive:'🗄',folder:'📁'};
const mailAddr=a=>a?`${a.name?esc(a.name)+' ':''}<${esc(a.address||'')}>`:'';
const clientBadge=c=>c?` <a class="badge green" onclick="event.stopPropagation();window.__go('client','${esc(c.username)}')" title="Linked CRM client">👤 ${esc(c.username)}</a>`:'';

VIEWS.mail=async v=>{
  try{ if(!MAIL.folders.length) MAIL.folders=await api('/mail/folders'); }
  catch(e){ v.innerHTML=`<h2 class="title">Mail</h2><div class="panel"><p class="err">${esc(e.message)}</p><p class="muted">Configure your mailbox in <a onclick="window.__go('settings')">Settings → Email</a> first (the same SMTP credentials are used for IMAP).</p></div>`; return; }
  v.innerHTML=`<h2 class="title">Mail ✉️</h2>
  <div class="mailwrap" style="display:grid;grid-template-columns:180px 1fr;gap:14px;align-items:start">
    <div class="panel" style="padding:10px">
      <button class="primary" id="m_compose" style="width:100%;margin-bottom:8px">✏️ Compose</button>
      <div id="m_folders"></div>
    </div>
    <div class="panel" style="padding:0;overflow:hidden">
      <div class="toolbar" style="padding:10px;border-bottom:1px solid var(--line,#e5e7eb);margin:0">
        <input id="m_search" placeholder="🔍 search mail…" value="${esc(MAIL.search)}" style="flex:1"/>
        <button class="sm" id="m_go">Search</button>
        <button class="sm" id="m_refresh" title="Refresh">↻</button>
      </div>
      <div id="m_list" style="min-height:300px"><p class="muted" style="padding:16px">Loading…</p></div>
      <div class="toolbar" id="m_pager" style="padding:10px;justify-content:space-between"></div>
    </div>
  </div>`;
  const renderFolders=()=>{ $('#m_folders').innerHTML=MAIL.folders.map(f=>`<div class="nav-item ${f.path===MAIL.folder?'active':''}" data-f="${esc(f.path)}" data-role="${f.role}" style="border-radius:8px;margin:2px 0"><span class="ic">${folderIc[f.role]||'📁'}</span>${esc(f.name==='INBOX'?'Inbox':f.name)}</div>`).join(''); $('#m_folders').querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{MAIL.folder=b.dataset.f;MAIL.role=b.dataset.role;MAIL.page=1;loadList();renderFolders();}); };
  const loadList=async()=>{
    const box=$('#m_list');box.innerHTML='<p class="muted" style="padding:16px">Loading…</p>';
    let r;try{r=await api(`/mail/list?folder=${encodeURIComponent(MAIL.folder)}&page=${MAIL.page}&search=${encodeURIComponent(MAIL.search)}`);}catch(e){box.innerHTML=`<p class="err" style="padding:16px">${esc(e.message)}</p>`;return;}
    const outbound=MAIL.role==='sent'||MAIL.role==='drafts';
    box.innerHTML=r.messages.length?`<table class="mailtable" style="width:100%;border-collapse:collapse">${r.messages.map(m=>{
      const who=outbound?(m.to[0]?mailAddr(m.to[0]):'(no recipient)'):mailAddr(m.from);
      return `<tr data-uid="${m.uid}" style="cursor:pointer;border-bottom:1px solid var(--line,#eee);${m.seen?'':'font-weight:600'}">
        <td style="padding:9px 10px;width:30px">${m.seen?'':'<span style="color:#2563eb">●</span>'}</td>
        <td style="padding:9px 6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${who}${clientBadge(m.client)}</td>
        <td style="padding:9px 6px">${esc(m.subject)} ${m.hasAttachment?'📎':''}</td>
        <td style="padding:9px 10px;text-align:right;white-space:nowrap;color:#6b7280;font-weight:400">${fdate(m.date)}</td>
      </tr>`;}).join('')}</table>`:'<p class="muted" style="padding:16px">No messages.</p>';
    box.querySelectorAll('[data-uid]').forEach(row=>row.onclick=()=>openMsg(MAIL.folder,row.dataset.uid));
    const pages=Math.max(1,Math.ceil(r.total/r.limit));
    $('#m_pager').innerHTML=`<span class="muted">${r.total} message(s) · page ${r.page}/${pages}</span><span>
      <button class="sm" ${MAIL.page<=1?'disabled':''} id="m_prev">← Newer</button>
      <button class="sm" ${MAIL.page>=pages?'disabled':''} id="m_next">Older →</button></span>`;
    if($('#m_prev'))$('#m_prev').onclick=()=>{MAIL.page--;loadList();};
    if($('#m_next'))$('#m_next').onclick=()=>{MAIL.page++;loadList();};
  };
  renderFolders();loadList();
  $('#m_go').onclick=()=>{MAIL.search=$('#m_search').value.trim();MAIL.page=1;loadList();};
  $('#m_search').onkeydown=e=>{if(e.key==='Enter'){MAIL.search=e.target.value.trim();MAIL.page=1;loadList();}};
  $('#m_refresh').onclick=()=>loadList();
  $('#m_compose').onclick=()=>composeMail({});
};

async function openMsg(folder,uid){
  const {close}=modal('Loading…','<p class="muted">Fetching message…</p>');
  let m;try{m=await api(`/mail/msg?folder=${encodeURIComponent(folder)}&uid=${uid}`);}catch(e){close();return toast(e.message,true);}
  close();
  const att=m.attachments.filter(a=>!a.inline);
  const bodyHtml=m.html
    ? `<iframe sandbox style="width:100%;height:46vh;border:1px solid var(--line,#e5e7eb);border-radius:8px;background:#fff"></iframe>`
    : `<pre class="mini" style="white-space:pre-wrap;max-height:46vh;overflow:auto">${esc(m.text||'(empty)')}</pre>`;
  modal(m.subject||'(no subject)',`
    <div class="kv"><span>From</span><span>${mailAddr(m.from)}${clientBadge(m.client)}</span></div>
    <div class="kv"><span>To</span><span>${(m.to||[]).map(mailAddr).join(', ')||'—'}</span></div>
    ${m.cc&&m.cc.length?`<div class="kv"><span>Cc</span><span>${m.cc.map(mailAddr).join(', ')}</span></div>`:''}
    <div class="kv"><span>Date</span><span>${fdate(m.date)}</span></div>
    ${att.length?`<div class="kv"><span>Attachments</span><span>${att.map(a=>`<a class="badge gray" href="/api/mail/attachment?folder=${encodeURIComponent(folder)}&uid=${uid}&index=${a.index}&dl=1" target="_blank">📎 ${esc(a.filename)} (${Math.round((a.size||0)/1024)}KB)</a>`).join(' ')}</span></div>`:''}
    <div style="margin:10px 0">${bodyHtml}</div>
    <div class="toolbar" style="margin:0">
      <button class="primary" id="mv_reply">↩ Reply</button>
      <button class="sm" id="mv_fwd">➡ Forward</button>
      <button class="sm" id="mv_ticket">🎫 Create ticket</button>
      ${m.client?'':`<button class="sm" id="mv_log">➕ Log to client…</button>`}
      <button class="sm danger" id="mv_del" style="margin-left:auto">🗑 Delete</button>
    </div>`,(b,close3)=>{
      $('#mv_ticket',b).onclick=async()=>{try{const t=await api('/mail/to-ticket',{method:'POST',body:{folder,uid:Number(uid)}});toast('Ticket '+t.number+' created');close3();openTicket(t._id);}catch(e){toast(e.message,true);}};
      if(m.html){const f=b.querySelector('iframe');f.srcdoc=m.html;}
      $('#mv_reply',b).onclick=()=>{close3();composeMail({to:m.from.address,subject:/^re:/i.test(m.subject)?m.subject:'Re: '+m.subject,inReplyTo:m.messageId,references:((m.references||'')+' '+m.messageId).trim(),log_to:m.client&&m.client.username,quote:`\n\n----- On ${fdate(m.date)}, ${mailAddr(m.from)} wrote -----\n${(m.text||'').split('\n').map(l=>'> '+l).join('\n')}`});};
      $('#mv_fwd',b).onclick=()=>{close3();composeMail({subject:/^fwd:/i.test(m.subject)?m.subject:'Fwd: '+m.subject,quote:`\n\n----- Forwarded message -----\nFrom: ${mailAddr(m.from)}\nDate: ${fdate(m.date)}\nSubject: ${m.subject}\n\n${m.text||''}`});};
      if($('#mv_log',b))$('#mv_log',b).onclick=async()=>{const u=prompt('Log this email on which client username?');if(!u)return;try{await api('/activities',{method:'POST',body:{ref_type:'client',ref_id:u.trim().toLowerCase(),kind:'email',body:`✉️ Received from ${m.from.address}: ${m.subject}\n\n${(m.text||'').slice(0,500)}`}});toast('Logged to '+u);}catch(e){toast(e.message,true);}};
      $('#mv_del',b).onclick=async()=>{if(!confirm('Move this message to Trash?'))return;try{await api('/mail/delete',{method:'POST',body:{folder,uid:Number(uid)}});toast('Moved to Trash');close3();if(CUR==='mail')go('mail');}catch(e){toast(e.message,true);}};
    });
  if(CUR==='mail')setTimeout(()=>{const row=document.querySelector(`[data-uid="${uid}"]`);if(row){row.style.fontWeight='400';const dot=row.querySelector('td span');if(dot)dot.remove();}},200);
}

let MAILCFG=null;
async function mailCfg(force){ if(force)MAILCFG=null; if(!MAILCFG){try{MAILCFG=(await api('/crm-settings')).mail||{};}catch(_){MAILCFG={};}} return MAILCFG; }
window.__mailcfgClear=()=>{MAILCFG=null;};

async function composeMail(pre){
  pre=pre||{};
  const cfg=await mailCfg();
  const sig=cfg.signature?`\n\n-- \n${cfg.signature}`:'';
  const tpls=cfg.templates||[];
  if(pre.quote==null)pre.quote=sig; else pre.quote=pre.quote+sig;   // signature after any reply/forward quote
  modal(pre.inReplyTo?'Reply':(pre.subject&&/^fwd:/i.test(pre.subject)?'Forward':'Compose email'),`
    <div class="field"><label>To</label><input id="cm_to" value="${esc(pre.to||'')}" placeholder="someone@example.com"/></div>
    <div class="field"><label>Cc (optional)</label><input id="cm_cc" value="${esc(pre.cc||'')}"/></div>
    <div class="field"><label>Subject</label><input id="cm_sub" value="${esc(pre.subject||'')}"/></div>
    ${tpls.length?`<div class="field"><label>Insert template</label><select id="cm_tpl"><option value="">— choose a saved template —</option>${tpls.map((t,i)=>`<option value="${i}">${esc(t.name)}</option>`).join('')}</select></div>`:''}
    <div class="field"><label>Message</label><textarea id="cm_body" rows="10" style="font-family:inherit">${esc(pre.quote||'')}</textarea></div>
    <div class="field"><label>📎 Attachments (up to 15 files, ≤ 20 MB each)</label><input type="file" id="cm_files" multiple/><div id="cm_flist" class="muted" style="font-size:12px;margin-top:4px"></div></div>
    ${pre.log_to?`<label class="switch"><input type="checkbox" id="cm_log" checked/> Log to ${esc(pre.log_to)}'s timeline</label>`:''}
    <div class="toolbar" style="margin-top:8px"><button class="primary" id="cm_send">Send</button><span id="cm_err" class="err"></span></div>
  `,(b,close)=>{
    $('#cm_files',b).onchange=()=>{const fs=[...$('#cm_files',b).files];$('#cm_flist',b).innerHTML=fs.length?fs.map(f=>`📎 ${esc(f.name)} (${Math.round(f.size/1024)}KB)`).join(' · '):'';};
    if($('#cm_tpl',b))$('#cm_tpl',b).onchange=e=>{const t=tpls[e.target.value];if(!t)return;const ta=$('#cm_body',b);ta.value=t.body+(ta.value?'\n\n'+ta.value:'');e.target.value='';ta.focus();};
    $('#cm_send',b).onclick=async()=>{
      const to=$('#cm_to',b).value.trim();if(!to){$('#cm_err',b).textContent='Recipient required';return;}
      const btn=$('#cm_send',b);btn.disabled=true;btn.textContent='Sending…';$('#cm_err',b).textContent='';
      const fd=new FormData();
      fd.append('to',to);fd.append('cc',$('#cm_cc',b).value.trim());fd.append('subject',$('#cm_sub',b).value);fd.append('text',$('#cm_body',b).value);
      if(pre.inReplyTo)fd.append('inReplyTo',pre.inReplyTo);if(pre.references)fd.append('references',pre.references);
      if(pre.log_to&&(!$('#cm_log',b)||$('#cm_log',b).checked))fd.append('log_to',pre.log_to);
      for(const f of $('#cm_files',b).files)fd.append('files',f);
      try{const r=await fetch('/api/mail/send',{method:'POST',body:fd});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
        toast('Sent ✓');close();if(CUR==='mail'&&MAIL.role==='sent')go('mail');
      }catch(e){$('#cm_err',b).textContent=e.message;btn.disabled=false;btn.textContent='Send';}
    };
  });
}
window.__compose=composeMail;

// ============================ SUPPORT TICKETS ============================
const TK={status:'open'};
const tkStatusBadge=s=>({open:'green',pending:'yellow',closed:'gray'})[s]||'gray';
const tkPrioBadge=p=>({high:'red',normal:'blue',low:'gray'})[p]||'gray';

VIEWS.tickets=async v=>{
  const r=await api('/tickets?status='+TK.status);
  const c=r.counts||{};
  const tab=(k,l)=>`<button class="sm ${TK.status===k?'primary':''}" data-st="${k}">${l}${c[k]!=null&&k!=='all'?` (${c[k]})`:''}</button>`;
  v.innerHTML=`<h2 class="title">Support tickets 🎫</h2>
  <div class="toolbar">
    ${tab('open','Open')}${tab('pending','Pending')}${tab('closed','Closed')}${tab('all','All')}
    <button class="primary" id="tk_new" style="margin-left:auto">+ New ticket</button>
  </div>
  <div class="panel" style="padding:0">${r.tickets.length?`<div class="table-wrap"><table><thead><tr><th>#</th><th>Subject</th><th>Client / contact</th><th>Status</th><th>Priority</th><th>Updated</th></tr></thead><tbody>
    ${r.tickets.map(t=>`<tr data-t="${t._id}" style="cursor:pointer">
      <td class="mono">${esc(t.number)}</td>
      <td>${esc(t.subject)} <span class="muted" style="font-size:11px">· ${t.msgCount} msg</span></td>
      <td>${t.client_username?`<a onclick="event.stopPropagation();window.__go('client','${esc(t.client_username)}')">👤 ${esc(t.client_username)}</a>`:esc(t.contact_email||'—')}</td>
      <td><span class="badge ${tkStatusBadge(t.status)}">${t.status}</span></td>
      <td><span class="badge ${tkPrioBadge(t.priority)}">${t.priority}</span></td>
      <td style="white-space:nowrap;color:#6b7280">${fdate(t.last_at)}</td></tr>`).join('')}
  </tbody></table></div>`:'<p class="muted" style="padding:16px">No tickets in this view.</p>'}</div>`;
  v.querySelectorAll('[data-st]').forEach(b=>b.onclick=()=>{TK.status=b.dataset.st;go('tickets');});
  v.querySelectorAll('[data-t]').forEach(row=>row.onclick=()=>openTicket(row.dataset.t));
  $('#tk_new').onclick=()=>newTicketModal();
};

function newTicketModal(){
  modal('New ticket',`
    <div class="field"><label>Subject</label><input id="nt_sub"/></div>
    <div class="row"><div class="field"><label>Contact email</label><input id="nt_em" placeholder="client@example.com"/></div>
    <div class="field"><label>Priority</label><select id="nt_pr"><option>normal</option><option>high</option><option>low</option></select></div></div>
    <div class="field"><label>Opening note (optional, internal)</label><textarea id="nt_body" rows="4"></textarea></div>
    <div class="toolbar" style="margin-top:8px"><button class="primary" id="nt_go">Create</button><span class="err" id="nt_err"></span></div>
  `,(b,close)=>{$('#nt_go',b).onclick=async()=>{try{const t=await api('/tickets',{method:'POST',body:{subject:$('#nt_sub',b).value,contact_email:$('#nt_em',b).value,priority:$('#nt_pr',b).value,body:$('#nt_body',b).value}});close();toast('Ticket '+t.number+' created');openTicket(t._id);}catch(e){$('#nt_err',b).textContent=e.message;}};});
}

async function openTicket(id){
  let t;try{t=await api('/tickets/'+id);}catch(e){return toast(e.message,true);}
  const bubble=m=>{const side=m.dir==='out'?'right':'left';const bg=m.dir==='out'?'#1e3a5f':(m.dir==='note'?'#3a3320':'#262b36');
    return `<div style="text-align:${side==='right'?'right':'left'};margin:6px 0"><div style="display:inline-block;max-width:80%;text-align:left;background:${bg};padding:8px 11px;border-radius:10px">
      <div class="muted" style="font-size:11px;margin-bottom:3px">${m.dir==='in'?'📥 '+esc(m.from||''):m.dir==='out'?'📤 '+esc(m.by||'you'):'📝 note · '+esc(m.by||'')} · ${fdate(m.at)}</div>
      <div style="white-space:pre-wrap">${esc(m.body||'')}</div></div></div>`;};
  modal(t.number+' · '+t.subject,`
    <div class="toolbar" style="margin:0 0 8px">
      <span class="badge ${tkStatusBadge(t.status)}">${t.status}</span>
      <span class="badge ${tkPrioBadge(t.priority)}">${t.priority}</span>
      ${t.client_username?`<a class="badge green" onclick="window.__go('client','${esc(t.client_username)}')">👤 ${esc(t.client_username)}</a>`:''}
      ${t.contact_email?`<span class="muted">${esc(t.contact_email)}</span>`:''}
      <span style="margin-left:auto"></span>
      <select id="tk_status"><option ${t.status==='open'?'selected':''}>open</option><option ${t.status==='pending'?'selected':''}>pending</option><option ${t.status==='closed'?'selected':''}>closed</option></select>
      <select id="tk_prio"><option ${t.priority==='low'?'selected':''}>low</option><option ${t.priority==='normal'?'selected':''}>normal</option><option ${t.priority==='high'?'selected':''}>high</option></select>
    </div>
    <div id="tk_thread" style="max-height:38vh;overflow:auto;padding:4px;background:var(--bg,#0e1117);border-radius:8px">${(t.messages||[]).map(bubble).join('')||'<p class="muted">No messages.</p>'}</div>
    <div class="field" style="margin-top:8px"><textarea id="tk_body" rows="4" placeholder="Type a reply (emailed to the contact) or an internal note…"></textarea></div>
    <div class="toolbar" style="margin:0">
      ${t.contact_email?`<button class="primary" id="tk_reply">↩ Reply by email</button><button class="sm" id="tk_replyclose">Reply & close</button>`:'<span class="muted">No contact email — notes only</span>'}
      <button class="sm" id="tk_note">📝 Add internal note</button>
      <span class="err" id="tk_err" style="margin-left:auto"></span>
    </div>
  `,(b,close)=>{
    const reload=()=>{close();openTicket(id);};
    $('#tk_status',b).onchange=async e=>{await api('/tickets/'+id,{method:'PATCH',body:{status:e.target.value}});toast('Status → '+e.target.value);};
    $('#tk_prio',b).onchange=async e=>{await api('/tickets/'+id,{method:'PATCH',body:{priority:e.target.value}});toast('Priority → '+e.target.value);};
    const send=async(close_after)=>{const body=$('#tk_body',b).value;if(!body.trim()){$('#tk_err',b).textContent='Write something first';return;}try{await api('/tickets/'+id+'/reply',{method:'POST',body:{body,close:close_after}});toast('Reply sent');reload();}catch(e){$('#tk_err',b).textContent=e.message;}};
    if($('#tk_reply',b))$('#tk_reply',b).onclick=()=>send(false);
    if($('#tk_replyclose',b))$('#tk_replyclose',b).onclick=()=>send(true);
    $('#tk_note',b).onclick=async()=>{const body=$('#tk_body',b).value;if(!body.trim()){$('#tk_err',b).textContent='Write something first';return;}try{await api('/tickets/'+id+'/note',{method:'POST',body:{body}});toast('Note added');reload();}catch(e){$('#tk_err',b).textContent=e.message;}};
  });
}
window.__ticket=openTicket;

boot();
