// Onward-SMPP adapter — forward a message to ANOTHER SMPP gateway (SMPP-to-SMPP bridging).
// route fields: smpp_host, smpp_port, smpp_system_id, smpp_password, sender_id.
// Keeps a bound client session per route, reconnecting as needed.
const smpp = require('smpp');

const sessions = new Map(); // routeId -> { session, bound }

function ensureSession(route) {
  const key = String(route._id);
  let ctx = sessions.get(key);
  if (ctx && ctx.bound) return Promise.resolve(ctx);
  return new Promise((resolve, reject) => {
    const session = smpp.connect({ url: `smpp://${route.smpp_host}:${route.smpp_port || 2775}`, auto_enquire_link_period: 20000 });
    ctx = { session, bound: false };
    sessions.set(key, ctx);
    const fail = (e) => { try { session.close(); } catch (_) {} sessions.delete(key); reject(e instanceof Error ? e : new Error(String(e))); };
    session.on('connect', () => {
      session.bind_transceiver({ system_id: route.smpp_system_id, password: route.smpp_password }, (pdu) => {
        if (pdu.command_status === 0) { ctx.bound = true; resolve(ctx); }
        else fail(new Error('onward bind failed: ' + (smpp.errors[pdu.command_status] || pdu.command_status)));
      });
    });
    session.on('close', () => { ctx.bound = false; sessions.delete(key); });
    session.on('error', (e) => fail(e));
    setTimeout(() => { if (!ctx.bound) fail(new Error('onward connect timeout')); }, 15000);
  });
}

async function send(route, dest, msg, source) {
  try {
    const ctx = await ensureSession(route);
    const ucs2 = /[^\x00-\x7F]/.test(msg);
    const short_message = ucs2 ? Buffer.from(msg, 'utf16le').swap16() : msg;
    return await new Promise((resolve) => {
      ctx.session.submit_sm({
        source_addr: source || route.sender_id || '', destination_addr: dest,
        short_message, data_coding: ucs2 ? 8 : 0, registered_delivery: 1,
      }, (pdu) => {
        if (pdu.command_status === 0) resolve({ success: true, messageId: String(pdu.message_id), rawData: { command_status: 0 } });
        else resolve({ success: false, error: 'onward submit failed: ' + (smpp.errors[pdu.command_status] || pdu.command_status) });
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { send };
