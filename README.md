# SMPP → HTTP Bridge

A multi-tenant **SMPP server** that accepts SMS over SMPP and relays it to **HTTP/SMPP
providers**, with billing, routing/LCR + failover, content policy, DLR tracking, an admin
panel, a client portal + public HTTP API, a reseller layer, and Telegram alerts.

```
SMPP client ──SMPP :2775──▶  bridge (index.js)  ──HTTP/SMPP──▶  provider (QuickConnect, …)
                              auth · policy · bill · route · log
   MongoDB ◀── shared ──▶  admin :3000   ·   portal + HTTP API :4000
```

## Processes (PM2 `ecosystem.config.json`, or systemd units in this repo)
| App | Entry | Port | Purpose |
|-----|-------|------|---------|
| smpp-bridge | `index.js` | 2775 | SMPP server (the engine) |
| smpp-admin  | `admin/server.js` | 3000 | operator panel |
| smpp-portal | `portal/server.js` | 4000 | customer portal + `POST /api/v1/sms/send` |

All three share one MongoDB. The bridge posts live events to the admin panel
(`/api/internal/event`, guarded by `INTERNAL_KEY`).

## Run
```bash
npm install
cp .env .env.local   # then edit secrets
node seed.js                         # admin + demo client (demo/demo123) + QuickConnect route
pm2 start ecosystem.config.json      # or: node index.js / node admin/server.js / node portal/server.js
# UI only (no SMPP), optionally with no DB:
MOCK_DB=true node run_ui_only.js
```
**On this box** the three are installed as systemd services (`smpp-bridge`, `smpp-admin`,
`smpp-portal`) — `systemctl status smpp-bridge`. MongoDB runs as `mongod`.

- Admin: http://localhost:3000  ·  `admin` / `admin123` (set `ADMIN_PASSWORD`)
- Portal: http://localhost:4000  ·  `demo` / `demo123`

## How a message flows (`shared/engine.js`)
`accept()` runs synchronously so the SMPP client gets **ESME_ROK immediately**:
dedup (3s) → blacklist → blocked words → MPS rate-limit → **template policy** → **multipart
billing** (`deductCredit`, GSM-7/UCS-2 segment math) → route selection → `MessageLog`.
Then `fireDispatch()` sends to the provider with **failover** (LCR rule → primary → backup →
any-active for `gold`); on total failure it **refunds** the credits. DLRs go back to bound
SMPP clients as `deliver_sm` and to HTTP tenants via webhook. Poll-based providers
(QuickConnect) are reconciled by polling `/messaging/status/{batch_id}`.

## Content policy (per user)
- **Bypass** (`bypass_template=true`) — passthrough.
- **Whitelist** — text must match an approved Template (Admin → Templates).
- **Injection** — user has `templates[]`; client sends only an OTP code, gateway injects it
  round-robin into a branded template (`{{code}}` / `XXXX`).

## Providers (`providers/`)
`quickconnect` (real — Bearer token, batch_id, status polling), `custom` (generic Bearer
JSON), `smpp` (onward SMPP-to-SMPP), `aakash`, `sociair`, and `globalzms/nestsms/nepal2rs/
hms/insoftsms/arcbridge` via the generic adapter. Add one = drop a module exporting
`send(route,dest,msg,source)` + a line in `providers/index.js`. An in-memory **circuit
breaker** suspends a route after 5 consecutive failures for 60s.

## Public HTTP SMS API
```bash
curl -X POST http://localhost:4000/api/v1/sms/send \
  -H 'x-api-user: demo' -H 'x-api-pass: demo123' \
  -H 'Content-Type: application/json' \
  -d '{"to":"9779800000000","text":"Hello"}'
# 202 queued · 402 no credits · 403 template mismatch
```

## QuickConnect (live vendor)
Seeded as a route. Its token is read from `QC_API_TOKEN` in `.env`. Point a client's route at
it in Admin → Users. Sending costs real QuickConnect credits. (Auth is
`Authorization: Bearer <token>`; DLRs are polled, since QuickConnect has no callback.)

## Tests
- `node scripts/test-bind.js` — bind as demo, submit, receive DLR (needs a working route).
- `node scripts/echo-provider.js` — local provider on :9099 for offline success-path testing.
