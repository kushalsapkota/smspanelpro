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
};

// Providers listed in the spec that we serve via the generic custom adapter until a
// dedicated module is added. (Drop a file in providers/ + a require above to specialize.)
const CUSTOM_ALIASES = ['globalzms', 'nestsms', 'nepal2rs', 'hms', 'insoftsms', 'arcbridge'];
for (const a of CUSTOM_ALIASES) adapters[a] = adapters.custom;

function adapterFor(type) { return adapters[(type || 'custom').toLowerCase()] || adapters.custom; }

// ---- route health store ----
const health = new Map(); // routeId -> { fails, latency:[], suspendedUntil, lastError }
const SUSPEND_AFTER = 5;       // consecutive failures
const SUSPEND_MS = 60 * 1000;  // circuit-breaker open duration

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

async function dispatch(route, dest, msg, source) {
  const adapter = adapterFor(route.type);
  const t0 = Date.now();
  let r;
  try { r = await adapter.send(route, dest, msg, source); }
  catch (e) { r = { success: false, error: e.message }; }
  const latencyMs = Date.now() - t0;
  if (r.success) recordSuccess(route._id, latencyMs); else recordFailure(route._id, r.error);
  return { ...r, latencyMs };
}

function pollStatus(route, providerId) {
  const adapter = adapterFor(route.type);
  return adapter.pollStatus ? adapter.pollStatus(route, providerId) : Promise.resolve(null);
}

module.exports = { dispatch, pollStatus, isHealthy, healthSnapshot, adapterFor, recordSuccess, recordFailure };
