/**
 * Outbound source-IP pool + binding for provider HTTP calls.
 *
 * The VPS can hold several public IPs. We bind each outbound SMS request to a chosen source IP
 * (Node's `localAddress` on the http/https Agent) and rotate across the pool — so if a provider
 * rate-limits or blocks one IP, the others keep sending. An IP that returns block-like errors
 * (403/forbidden/conn-refused/"invalid IP"…) is auto-suspended for a cooldown; operators can also
 * disable/enable IPs manually.
 *
 * Selection per send (providers/index.js dispatch() calls attach(route)):
 *   - route.config.source_ips = ["1.2.3.4", …]  → use ONLY these (e.g. Sparrow's whitelisted IP)
 *   - else the global enabled pool (Setting `outbound_ips` = { ips:[{ip,label,disabled}], mode })
 *   - else null → OS default route (unchanged behaviour, pool empty)
 *   mode 'rotate' (default, round-robin, spreads load) | 'sticky' (first healthy IP until it drops)
 *
 * Adapters opt in by wrapping their axios config in cfg(route, {...}) — that injects the bound
 * agents picked for this send. With no pool/route override, cfg is a no-op and the OS default is used.
 */
const http = require('http');
const https = require('https');
const os = require('os');
let db = null; try { db = require('../db'); } catch (_) {}

// ---- pool cache (Setting `outbound_ips`) ----
const POOL_TTL = 30000;
let _pool = { ips: [], mode: 'rotate' };
let _poolAt = 0;
async function refresh(force) {
  if (!db) return _pool;
  if (!force && Date.now() - _poolAt < POOL_TTL) return _pool;
  try {
    const s = await db.Setting.findOne({ key: 'outbound_ips' }).lean();
    const v = (s && s.value) || {};
    _pool = { ips: Array.isArray(v.ips) ? v.ips.filter(x => x && x.ip) : [], mode: v.mode === 'sticky' ? 'sticky' : 'rotate' };
  } catch (_) {}
  _poolAt = Date.now();
  return _pool;
}

// ---- per-IP bound agents (keep-alive, cached) ----
const agentCache = new Map();
// Default keep-alive agents (no source-IP binding) — used when there's no IP pool. Connection
// reuse is the main cure for provider timeouts under volume: without it every send did a fresh
// TLS handshake to the same host (e.g. all INSOFT keys hit sms.insoftsms.com), which piled up
// and tripped the 20s timeout. keepAlive pools sockets so repeat sends are fast.
let DEFAULT_AGENTS = null;
function defaultAgents() {
  if (!DEFAULT_AGENTS) DEFAULT_AGENTS = {
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 }),
  };
  return DEFAULT_AGENTS;
}

function agentsFor(ip) {
  if (!ip) return defaultAgents();
  let a = agentCache.get(ip);
  if (!a) {
    a = {
      httpAgent: new http.Agent({ localAddress: ip, keepAlive: true, maxSockets: 64 }),
      httpsAgent: new https.Agent({ localAddress: ip, keepAlive: true, maxSockets: 64 }),
    };
    agentCache.set(ip, a);
  }
  return a;
}

// ---- per-IP health (block-aware circuit breaker) ----
const SUSPEND_AFTER = 3;
const SUSPEND_MS = 5 * 60 * 1000;
const hmap = new Map();
function H(ip) { if (!hmap.has(ip)) hmap.set(ip, { fails: 0, suspendedUntil: 0, lastError: '', lastUsed: 0, sent: 0 }); return hmap.get(ip); }
function looksBlocked(err) {
  const t = String(err || '').toLowerCase();
  // Only IP-level signals trip suspension — NOT generic timeouts or bad-number errors (those would
  // false-positive a healthy IP). 403/forbidden/refused/reset/unreachable/"invalid ip"/whitelist.
  return /\b403\b|forbidden|blocked|denied|not allowed|invalid ip|whitelist|banned|blacklist|econnrefused|econnreset|ehostunreach|enetunreach|eaddrnotavail/.test(t);
}
function recordSuccess(ip) { if (!ip) return; const h = H(ip); h.fails = 0; h.suspendedUntil = 0; h.lastError = ''; h.lastUsed = Date.now(); h.sent++; }
function recordFailure(ip, err) {
  if (!ip) return; const h = H(ip); h.lastUsed = Date.now();
  if (looksBlocked(err)) { h.fails++; h.lastError = String(err || '').slice(0, 200); if (h.fails >= SUSPEND_AFTER) { h.suspendedUntil = Date.now() + SUSPEND_MS; h.fails = 0; } }
}
function suspended(ip) { return H(ip).suspendedUntil > Date.now(); }

// ---- selection ----
function candidates(route) {
  const cfg = (route && route.config) || {};
  if (Array.isArray(cfg.source_ips) && cfg.source_ips.length) return cfg.source_ips.map(String);
  return _pool.ips.filter(x => !x.disabled).map(x => x.ip);
}
let rr = 0;
function chooseIp(route) {
  const list = candidates(route);
  if (!list.length) return null;
  const healthy = list.filter(ip => !suspended(ip));
  const use = healthy.length ? healthy : list; // all suspended → still try (better than failing)
  const mode = (route && route.config && route.config.ip_mode) || _pool.mode;
  if (mode === 'sticky') return use[0];
  return use[rr++ % use.length];
}

// Pick a source IP for this send and stash bound agents on the route (dispatch calls this).
async function attach(route) {
  await refresh();
  const ip = chooseIp(route);
  const a = agentsFor(ip);
  if (route) route.__src = { ip, httpAgent: a.httpAgent, httpsAgent: a.httpsAgent };
  return ip;
}

// axios-config helper for adapters: injects the bound agents for this send. Uses route.__src when
// dispatch pre-picked; otherwise binds to the route's own source_ips[0] (so a pinned route's
// testConnection also goes out the right IP). No pool/override → returns extra unchanged (OS default).
function cfg(route, extra) {
  const out = Object.assign({}, extra || {});
  let src = route && route.__src;
  if (!src) { const list = candidates(route); if (list.length) src = Object.assign({ ip: list[0] }, agentsFor(list[0])); }
  if (src && src.ip) { out.httpAgent = src.httpAgent; out.httpsAgent = src.httpsAgent; }
  else { const d = defaultAgents(); out.httpAgent = d.httpAgent; out.httpsAgent = d.httpsAgent; } // keep-alive even with no IP pool
  return out;
}

function serverIps() {
  const n = os.networkInterfaces(); const out = [];
  for (const [k, arr] of Object.entries(n)) (arr || []).forEach(x => { if (x.family === 'IPv4' && !x.internal) out.push({ iface: k, ip: x.address, cidr: x.cidr }); });
  return out;
}

// Bind to `ip` and ask an echo service what public IP the world sees — verifies the IP is really
// on the box AND how it egresses (1:1 NAT vs shared). Throws EADDRNOTAVAIL if the IP isn't configured.
async function egressCheck(ip, url) {
  const axios = require('axios');
  const a = agentsFor(ip);
  const u = url || 'https://api.ipify.org?format=json';
  const res = await axios.get(u, { httpsAgent: a.httpsAgent, httpAgent: a.httpAgent, timeout: 12000, validateStatus: () => true });
  let seen = res.data; if (seen && typeof seen === 'object') seen = seen.ip;
  return { bound: ip, egress: seen, status: res.status, match: String(seen).trim() === String(ip).trim() };
}

function snapshot() {
  const out = {};
  for (const [ip, h] of hmap) out[ip] = { suspended: h.suspendedUntil > Date.now(), suspendedFor: Math.max(0, h.suspendedUntil - Date.now()), fails: h.fails, lastError: h.lastError, lastUsed: h.lastUsed || null, sent: h.sent };
  return out;
}

module.exports = {
  refresh, attach, cfg, chooseIp, agentsFor, candidates,
  recordSuccess, recordFailure, suspended, serverIps, egressCheck, snapshot,
  pool: () => _pool,
};
