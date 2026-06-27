/* Vendor portal SPA — login + endpoint management scoped to the logged-in vendor. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString();
let TYPES = ['custom'];
let ME = null;

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opt);
  let data = null; try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

// ---------------- login ----------------
function loginView(msg) {
  $('app').innerHTML = `
  <div class="login"><div class="card">
    <div class="brand">Vendor <span class="dot">Portal</span></div>
    <p class="muted" style="margin:0 0 18px">Sign in with the ID & password your provider gave you.</p>
    <div id="loginErr"></div>
    <div class="field"><label>Vendor ID</label><input id="vid" autocomplete="username" placeholder="e.g. acme-sms"/></div>
    <div class="field"><label>Password</label><input id="pw" type="password" autocomplete="current-password"/></div>
    <button class="btn" style="width:100%" id="loginBtn">Sign in</button>
  </div></div>`;
  if (msg) $('loginErr').innerHTML = `<div class="err">${esc(msg)}</div>`;
  const go = async () => {
    try {
      await api('POST', '/login', { vendor_id: $('vid').value, password: $('pw').value });
      boot();
    } catch (e) { loginView(e.message); }
  };
  $('loginBtn').onclick = go;
  $('pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('vid').focus();
}

// ---------------- dashboard ----------------
async function dashboard() {
  const [sum, eps] = await Promise.all([api('GET', '/summary'), api('GET', '/endpoints')]);
  $('app').innerHTML = `
  <div class="topbar">
    <div class="brand">Vendor <span class="dot">Portal</span></div>
    <div><span class="muted" style="margin-right:14px">${esc(ME.name || ME.vendor_id)}</span><button class="btn sec sm" id="logoutBtn">Log out</button></div>
  </div>
  <div class="wrap">
    <div class="cards">
      <div class="kpi"><div class="v">${nf(sum.endpoints)}</div><div class="l">Endpoints</div></div>
      <div class="kpi"><div class="v">${nf(sum.balance)}</div><div class="l">Balance (SMS left)</div></div>
      <div class="kpi"><div class="v">${nf(sum.used)}</div><div class="l">SMS used</div></div>
      <div class="kpi"><div class="v">${nf(sum.pending)}</div><div class="l">Pending approval</div></div>
    </div>
    <div class="card">
      <div class="sect"><h2>My endpoints</h2><button class="btn sm" id="addBtn">+ Add endpoint</button></div>
      <div id="epList"></div>
    </div>
    <p class="hint" style="margin-top:14px">New endpoints stay <b>pending</b> until your provider reviews & activates them. You only see SMS sent through your own endpoints — nothing else.</p>
  </div>`;
  $('logoutBtn').onclick = async () => { await api('POST', '/logout'); ME = null; loginView(); };
  $('addBtn').onclick = () => endpointModal();
  renderEndpoints(eps);
}

function renderEndpoints(eps) {
  if (!eps.length) { $('epList').innerHTML = `<div class="empty">No endpoints yet. Click “+ Add endpoint” to register your API.</div>`; return; }
  $('epList').innerHTML = `
  <table><thead><tr>
    <th>Name</th><th>Type</th><th>Status</th><th>Used</th><th>Balance</th><th></th>
  </tr></thead><tbody>
  ${eps.map((e) => `<tr>
    <td><b>${esc(e.name)}</b><div class="hint mono">${esc(e.api_url || '—')}</div></td>
    <td>${esc(e.type)}</td>
    <td><span class="badge ${esc(e.status)}">${esc(e.status)}</span></td>
    <td>${nf(e.used)}</td>
    <td>${nf(e.balance)}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn sec sm" data-top="${e.id}">Top up</button>
      <button class="btn sec sm" data-edit="${e.id}">Edit</button>
    </td>
  </tr>`).join('')}
  </tbody></table>`;
  document.querySelectorAll('[data-top]').forEach((b) => b.onclick = () => topupModal(eps.find((e) => e.id === b.dataset.top)));
  document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => endpointModal(eps.find((e) => e.id === b.dataset.edit)));
}

function closeModal() { const m = $('modal'); if (m) m.remove(); }
function showModal(html) {
  closeModal();
  const d = document.createElement('div');
  d.id = 'modal'; d.className = 'modal-bg';
  d.innerHTML = `<div class="modal">${html}</div>`;
  d.onclick = (e) => { if (e.target === d) closeModal(); };
  document.body.appendChild(d);
}

function endpointModal(ep) {
  const isNew = !ep; ep = ep || {};
  const locked = !isNew && ep.status !== 'pending';
  const opts = TYPES.map((t) => `<option ${ep.type === t ? 'selected' : ''}>${t}</option>`).join('');
  showModal(`
    <h3>${isNew ? 'Add endpoint' : 'Edit endpoint'}</h3>
    <div id="mErr"></div>
    <div class="field"><label>Name</label><input id="m_name" value="${esc(ep.name || '')}" placeholder="My SMS gateway"/></div>
    <div class="row">
      <div class="field"><label>Type</label><select id="m_type" ${locked ? 'disabled' : ''}>${opts}</select></div>
      <div class="field"><label>HTTP method</label><select id="m_method" ${locked ? 'disabled' : ''}>
        <option ${ep.http_method === 'POST' ? 'selected' : ''}>POST</option>
        <option ${ep.http_method === 'GET' ? 'selected' : ''}>GET</option></select></div>
    </div>
    <div class="field"><label>API URL</label><input id="m_url" value="${esc(ep.api_url || '')}" placeholder="https://your-gateway.com/api/send" ${locked ? 'disabled' : ''}/></div>
    <div class="field"><label>API key / token ${ep.has_token ? '<span class="muted">(leave blank to keep)</span>' : ''}</label><input id="m_token" placeholder="${ep.has_token ? '•••••• stored' : 'paste your API key'}" ${locked ? 'disabled' : ''}/></div>
    <div class="row">
      <div class="field"><label>Sender ID <span class="muted">(optional)</span></label><input id="m_sender" value="${esc(ep.sender_id || '')}" ${locked ? 'disabled' : ''}/></div>
      <div class="field"><label>Price per SMS <span class="muted">(your rate)</span></label><input id="m_cost" type="number" step="0.001" value="${ep.cost_per_sms != null ? ep.cost_per_sms : ''}" ${locked ? 'disabled' : ''}/></div>
    </div>
    ${isNew ? `<div class="field"><label>Starting balance (SMS available)</label><input id="m_bal" type="number" min="0" value="0"/></div>` : ''}
    ${locked ? `<p class="hint">This endpoint is live — API details are locked. Use “Top up” to add balance, or ask your provider to change the configuration.</p>` : ''}
    <div class="actions"><button class="btn sec" id="mCancel">Cancel</button><button class="btn" id="mSave">${isNew ? 'Add' : 'Save'}</button></div>
  `);
  $('mCancel').onclick = closeModal;
  $('mSave').onclick = async () => {
    try {
      const body = { name: $('m_name').value };
      if (!locked) {
        body.type = $('m_type').value; body.http_method = $('m_method').value;
        body.api_url = $('m_url').value; body.sender_id = $('m_sender').value;
        body.cost_per_sms = $('m_cost').value;
        if ($('m_token').value.trim()) body.auth_token = $('m_token').value.trim();
      }
      if (isNew) { body.balance = $('m_bal').value; await api('POST', '/endpoints', body); }
      else { await api('PATCH', '/endpoints/' + ep.id, body); }
      closeModal(); boot();
    } catch (e) { $('mErr').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

function topupModal(ep) {
  showModal(`
    <h3>Top up — ${esc(ep.name)}</h3>
    <div id="mErr"></div>
    <p class="muted">Current balance: <b>${nf(ep.balance)}</b> SMS · Used: ${nf(ep.used)}</p>
    <div class="field"><label>Add SMS</label><input id="m_sms" type="number" min="1" placeholder="e.g. 10000"/></div>
    <div class="actions"><button class="btn sec" id="mCancel">Cancel</button><button class="btn" id="mSave">Add balance</button></div>
  `);
  $('mCancel').onclick = closeModal;
  $('mSave').onclick = async () => {
    try { await api('POST', '/endpoints/' + ep.id + '/topup', { sms: $('m_sms').value }); closeModal(); boot(); }
    catch (e) { $('mErr').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

// ---------------- boot ----------------
async function boot() {
  try {
    ME = await api('GET', '/me');
    try { TYPES = await api('GET', '/types'); } catch (_) {}
    await dashboard();
  } catch (e) { loginView(); }
}
boot();
