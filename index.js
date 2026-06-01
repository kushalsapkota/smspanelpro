/**
 * index.js — the SMPP server (the core engine).
 * SMPP in  ->  auth + policy + billing + routing (shared/engine.js)  ->  HTTP/SMPP out.
 */
require('dotenv').config();
const smpp = require('smpp');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const db = require('./db');
const engine = require('./shared/engine');

const SMPP_PORT = Number(process.env.SMPP_PORT || 2775);
const SMPP_HOST = process.env.SMPP_HOST || '0.0.0.0';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'internal-key';
const ADMIN_EVENT_URL = process.env.ADMIN_EVENT_URL || 'http://127.0.0.1:3000/api/internal/event';

// username -> { user, session, bindType }
const bound = new Map();

function emitEvent(type, data) {
  axios.post(ADMIN_EVENT_URL, { type, data, ts: Date.now() }, { headers: { 'x-internal-key': INTERNAL_KEY }, timeout: 3000 })
    .catch(() => { /* admin panel may be down; ignore */ });
}

function remoteIp(session) {
  const a = session.remoteAddress || (session.socket && session.socket.remoteAddress) || '';
  return String(a).replace(/^::ffff:/, '');
}

function decodeMessage(pdu) {
  const sm = pdu.short_message;
  let buf = sm && sm.message != null ? sm.message : sm;
  if (buf == null) return '';
  if (typeof buf === 'string') return buf;
  if (!Buffer.isBuffer(buf)) return String(buf);
  if (pdu.data_coding === 8) return Buffer.from(buf).swap16().toString('utf16le');
  return buf.toString('utf8');
}

async function authenticate(systemId, password, ip) {
  const user = await db.User.findOne({ username: String(systemId).toLowerCase() });
  if (!user) return { error: smpp.ESME_RINVSYSID };
  const ok = await bcrypt.compare(password || '', user.password).catch(() => false);
  if (!ok) return { error: smpp.ESME_RINVPASWD };
  if (!user.is_active || user.is_suspended) return { error: smpp.ESME_RBINDFAIL };
  if (user.allowed_ips && user.allowed_ips.length && !user.allowed_ips.includes(ip)) return { error: smpp.ESME_RBINDFAIL };
  return { user };
}

function handleSession(session) {
  const ip = remoteIp(session);
  let ctx = { user: null, bindType: null };

  async function onBind(pdu, bindType) {
    const r = await authenticate(pdu.system_id, pdu.password, ip).catch(() => ({ error: smpp.ESME_RBINDFAIL }));
    if (r.error != null) { session.send(pdu.response({ command_status: r.error })); try { session.close(); } catch (_) {} return; }
    ctx.user = r.user; ctx.bindType = bindType;
    bound.set(r.user.username, { user: r.user, session, bindType });
    await db.User.findByIdAndUpdate(r.user._id, { $set: { is_connected: true, last_bound_at: new Date(), last_bound_ip: ip } });
    await db.ActiveConnection.create({ username: r.user.username, ip, bind_type: bindType, is_connected: true });
    console.log(`[smpp] BOUND ${r.user.username} (${bindType}) ip=${ip}`);
    emitEvent('bind', { username: r.user.username, ip, bindType });
    session.send(pdu.response({ system_id: 'smpp-bridge' }));
  }

  session.on('bind_transceiver', (p) => onBind(p, 'transceiver'));
  session.on('bind_transmitter', (p) => onBind(p, 'transmitter'));
  session.on('bind_receiver', (p) => onBind(p, 'receiver'));
  session.on('enquire_link', (p) => session.send(p.response()));
  session.on('unbind', (p) => { session.send(p.response()); try { session.close(); } catch (_) {} });

  session.on('submit_sm', (pdu) => { handleSubmit(ctx, session, pdu).catch((e) => {
    console.error('[smpp] submit error', e); try { session.send(pdu.response({ command_status: smpp.ESME_RSYSERR })); } catch (_) {}
  }); });

  // accept provider-pushed DLRs onto a receiver bind (rare; most providers use HTTP)
  session.on('deliver_sm', (p) => session.send(p.response()));

  const cleanup = async () => {
    if (ctx.user) {
      bound.delete(ctx.user.username);
      await db.User.findByIdAndUpdate(ctx.user._id, { $set: { is_connected: false } }).catch(() => {});
      await db.ActiveConnection.updateMany({ username: ctx.user.username }, { $set: { is_connected: false } }).catch(() => {});
      emitEvent('unbind', { username: ctx.user.username });
      console.log(`[smpp] UNBOUND ${ctx.user.username}`);
    }
  };
  session.on('close', cleanup);
  session.on('error', () => {});
}

async function handleSubmit(ctx, session, pdu) {
  if (!ctx.user || ctx.bindType === 'receiver') return session.send(pdu.response({ command_status: smpp.ESME_RINVBNDSTS }));
  // reload user for fresh credits/policy
  const user = await db.User.findById(ctx.user._id);
  const dest = pdu.destination_addr || '';
  const source = pdu.source_addr || '';
  const text = decodeMessage(pdu);

  const decision = await engine.accept(user, dest, text, source, 'smpp');
  // Reply ESME_ROK (or error) IMMEDIATELY so slow downstreams don't time the client out.
  session.send(pdu.response({ command_status: decision.smppStatus, message_id: decision.ok ? decision.messageId : undefined }));
  if (decision.ok) {
    emitEvent('submit', { username: user.username, dest, parts: decision.prepared.parts });
    engine.fireDispatch(decision.prepared).catch((e) => console.error('[smpp] dispatch error', e));
  }
}

// Deliver a DLR back to a bound client as deliver_sm (registered by the engine).
engine.setDlrDeliver((username, dlr) => {
  const b = bound.get(username);
  if (!b || b.bindType === 'transmitter') return;
  const stat = dlr.status === 'delivered' ? 'DELIVRD' : (dlr.status === 'undelivered' ? 'UNDELIV' : 'UNKNOWN');
  const code = dlr.status === 'delivered' ? 2 : 5;
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(); const ts = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes());
  const receipt = `id:${dlr.messageId} sub:001 dlvrd:${dlr.status === 'delivered' ? '001' : '000'} submit date:${ts} done date:${ts} stat:${stat} err:000 text:${(dlr.text || '').slice(0, 20)}`;
  try {
    b.session.deliver_sm({ source_addr: dlr.destination, destination_addr: dlr.source, esm_class: 0x04, short_message: receipt, receipted_message_id: dlr.messageId, message_state: code }, () => {});
  } catch (_) {}
});

// Poll DropCommand collection so admins can force-drop a bound session.
setInterval(async () => {
  try {
    const cmds = await db.DropCommand.find({});
    for (const c of cmds || []) {
      const b = bound.get(c.username);
      if (b) { try { b.session.close(); } catch (_) {} }
      await db.DropCommand.deleteOne({ _id: c._id }).catch(() => {});
    }
  } catch (_) {}
}, 5000);

async function main() {
  await db.connect();
  const server = smpp.createServer({ debug: false }, handleSession);
  server.on('error', (e) => console.error('[smpp] server error', e.message));
  server.listen(SMPP_PORT, SMPP_HOST, () => console.log(`[smpp] SMSC listening on ${SMPP_HOST}:${SMPP_PORT}`));
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });

module.exports = { bound };
