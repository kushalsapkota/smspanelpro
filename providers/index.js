/**
 * Provider router + in-memory route-health circuit breaker.
 *
 * dispatch(route, dest, msg, source) -> { success, messageId, rawData, error, latencyMs }
 * Adapters implement send(route, dest, msg, source) -> { success, messageId, rawData, error, pending? }
 * Some adapters also implement pollStatus(route, providerId) -> 'delivered'|'undelivered'|null.
 */
const adapters = {
  quickconnect: require('./quickconnect'),
  custom: require('./custom'),
  smpp: require('./smpp'),
  aakash: require('./aakash'),
  sociair: require('./sociair'),
  hms: require('./hms'),
  sparrow: require('./sparrow'),
  insoft: require('./insoft'),
  insoft2: require('./insoft2'),
  insoftpanel: require('./insoftpanel'),
  webzonesms: require('./webzonesms'),
  nestsms: require('./nestsms'),
  nestpanel: require('./nestpanel'),
  spellcpaas: require('./spellcpaas'),
};
adapters.routegod = adapters.spellcpaas; // alias (operator's name for the Spell CPaaS route)
adapters.spell = adapters.spellcpaas;    // alias
adapters.webzone = adapters.webzonesms; // alias
adapters.insoftsms = adapters.insoft;    // alias
adapters.insoftsms2 = adapters.insoft2;  // alias (Insoft "web SMS Server" token API)
adapters.insoftweb = adapters.insoftpanel; // alias (insoftsms.com cookie-session web panel)

// Providers listed in the spec that we serve via the generic custom adapter until a
// dedicated module is added. (Drop a file in providers/ + a require above to specialize.)
const CUSTOM_ALIASES = ['globalzms', 'nepal2rs', 'arcbridge'];
for (const a of CUSTOM_ALIASES) adapters[a] = adapters.custom;

function adapterFor(type) { return adapters[(type || 'custom').toLowerCase()] || adapters.custom; }

// ---- route health store ----
const health = new Map(); // routeId -> { fails, latency:[], suspendedUntil, lastError }
const SUSPEND_AFTER = 3;       // consecutive failures -> open circuit, fail over to the backup route
const SUSPEND_MS = 45 * 1000;  // circuit-breaker open duration (then retests the route)

function h(routeId) {
  const k = String(routeId);
  if (!health.has(k)) health.set(k, { fails: 0, latency: [], suspendedUntil: 0, lastError: '' });
  return health.get(k);
}
function isHealthy(routeId) { return h(routeId).suspendedUntil < Date.now(); }
function recordSuccess(routeId, latencyMs) {
  const s = h(routeId); s.fails = 0; s.suspendedUntil = 0; s.lastError = '';
  s.latency.push(latencyMs); if (s.latency.length > 20) s.latency.shift();
}
function recordFailure(routeId, error) {
  const s = h(routeId); s.fails++; s.lastError = error || '';
  if (s.fails >= SUSPEND_AFTER) { s.suspendedUntil = Date.now() + SUSPEND_MS; s.fails = 0; }
}
function healthSnapshot() {
  const out = {};
  for (const [k, s] of health) {
    const avg = s.latency.length ? Math.round(s.latency.reduce((a, b) => a + b, 0) / s.latency.length) : null;
    out[k] = { avgLatencyMs: avg, consecutiveFails: s.fails, suspended: s.suspendedUntil > Date.now(), suspendedFor: Math.max(0, s.suspendedUntil - Date.now()), lastError: s.lastError };
  }
  return out;
}

const outbound = require('../shared/outbound');

// A failure that is the MESSAGE's fault (bad/invalid recipient, content rejected), not the route's.
// The route answered fine — so this must NOT count toward the circuit breaker, or a run of bad
// numbers in a client's list would trip the breaker and kill good traffic ("route suspended").
function isMessageFault(err) {
  const t = String(err || '').toLowerCase();
  if (/timeout|econn|esocket|socket hang|network|enotfound|ehostunreach|enetunreach|\b50[234]\b|bad gateway|gateway timeout|service unavailable|circuit/.test(t)) return false; // transport = route fault
  return /invalid\s+(number|recipient|receiver|mobile|destination|msisdn|in list)|number\s+is\s+invalid|no\s+valid\s+receiver|bad\s+number|rinvdstadr|not\s+a\s+valid|blacklist|do not disturb|\bdnd\b/.test(t);
}

async function dispatch(route, dest, msg, source) {
  const adapter = adapterFor(route.type);
  // Plain copy so we can stash transient per-send fields (bound source-IP agents) without touching
  // the caller's Mongoose doc. Then bind this send to a source IP from the pool / route override.
  const r0 = route.toObject ? route.toObject() : Object.assign({}, route);
  let srcIp = null;
  try { srcIp = await outbound.attach(r0); } catch (_) {}
  const t0 = Date.now();
  let r;
  try { r = await adapter.send(r0, dest, msg, source); }
  catch (e) { r = { success: false, error: e.message }; }
  const latencyMs = Date.now() - t0;
  if (r.success) { recordSuccess(route._id, latencyMs); outbound.recordSuccess(srcIp); }
  else if (isMessageFault(r.error)) { recordSuccess(route._id, latencyMs); /* route is healthy; only the recipient was bad — don't trip the breaker */ }
  else { recordFailure(route._id, r.error); outbound.recordFailure(srcIp, r.error); }
  if (srcIp) r.rawData = Object.assign({ source_ip: srcIp }, r.rawData || {});
  return { ...r, latencyMs, sourceIp: srcIp };
}

function pollStatus(route, providerId) {
  const adapter = adapterFor(route.type);
  return adapter.pollStatus ? adapter.pollStatus(route, providerId) : Promise.resolve(null);
}

module.exports = { dispatch, pollStatus, isHealthy, healthSnapshot, adapterFor, recordSuccess, recordFailure };
