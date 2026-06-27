# NEA portal relay

Our bridge server (`161.97.175.110`, Germany) is firewall-blocked from
`smsportal.nea.org.np` at the TCP layer. This relay runs on a **Nepal-IP cPanel**
host that *can* reach the portal, and forwards requests for us.

```
bridge  --https + X-Relay-Secret-->  nea-relay.php (Nepal IP)  --curl-->  smsportal.nea.org.np
```

The relay is generic (forwards {url, method, headers, body} → {status, headers, body}).
All NEA login / two-step send logic lives in the Node adapter on the bridge.

## Deploy
1. Upload `nea-relay.php` to the cPanel's web root (e.g. `public_html/nea-relay.php`),
   so it is reachable at something like `https://yourdomain.com.np/nea-relay.php`.
2. Confirm the shared secret in the file matches the one stored in the bridge route config:
   `99edf439756480b115b61d2cfb45d964f63d1f1225f6355c`
3. (Recommended) put it in a hard-to-guess path/subfolder; the secret already gates it,
   and it only forwards to `smsportal.nea.org.np`, so it is not an open proxy.

## Step 1 — prove the cPanel can reach the portal
Open in a browser (or curl):

```
https://yourdomain.com.np/nea-relay.php?action=diag&secret=99edf439756480b115b61d2cfb45d964f63d1f1225f6355c
```

Expected (good):
```json
{"ok":true,"egress_ip":"<a Nepal IP>","target":"smsportal.nea.org.np",
 "target_reachable":true,"target_http_code":200,"ms":...}
```

- `target_reachable: true` → 🎉 the relay can reach the portal; we build the Node adapter next.
- `target_reachable: false` / curl_error set → this cPanel IP is *also* blocked; we'd need a
  different Nepal host.

## Requirements on the cPanel
- PHP 7.2+ with the cURL extension (standard on cPanel).
- `allow_url_fopen` on (for the diag IP check only; forwarding uses cURL regardless).
