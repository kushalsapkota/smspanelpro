<?php
/**
 * nea-relay.php — thin, secret-gated forward proxy.
 *
 * Deploy this on a cPanel host that sits on a Nepal IP (one that CAN reach
 * smsportal.nea.org.np). Our bridge server in Germany is firewall-blocked from
 * the NEA portal at the TCP layer, so it can't call the portal directly. This
 * relay lets the bridge reach the portal "through" the Nepal IP:
 *
 *   bridge  --(https, X-Relay-Secret)-->  this relay  --(curl)-->  smsportal.nea.org.np
 *
 * It is intentionally GENERIC: the bridge sends {url, method, headers, body} and
 * gets back {status, headers, body}. All NEA login / two-step send logic lives in
 * the Node adapter on the bridge — this file only forwards bytes.
 *
 * Hardening: requires the shared secret, only forwards to ALLOW_HOSTS (so it is
 * NOT an open proxy), https-only targets, 1 MB body cap.
 *
 * Usage:
 *   GET  ?action=diag                 -> reports this host's egress IP + portal reachability
 *   POST {url,method,headers,body}    -> forwards and returns the raw response
 */

declare(strict_types=1);
header('Content-Type: application/json');

// ---------- config ----------
const RELAY_SECRET = '99edf439756480b115b61d2cfb45d964f63d1f1225f6355c'; // must match the bridge route config
const ALLOW_HOSTS  = ['smsportal.nea.org.np'];   // ONLY these hosts may be relayed
const MAX_BODY     = 1048576;                     // 1 MB

function out(int $code, array $data): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}
function fail(int $code, string $msg, array $extra = []): void {
    out($code, array_merge(['ok' => false, 'error' => $msg], $extra));
}

// ---------- auth ----------
$secret = $_SERVER['HTTP_X_RELAY_SECRET'] ?? ($_GET['secret'] ?? '');
if (!is_string($secret) || !hash_equals(RELAY_SECRET, $secret)) {
    fail(401, 'bad or missing relay secret');
}

// ---------- diagnostic: prove this host can reach the portal ----------
if (($_GET['action'] ?? '') === 'diag') {
    $egress = @file_get_contents('https://api.ipify.org');
    $host   = ALLOW_HOSTS[0];
    $t0     = microtime(true);
    $ch     = curl_init("https://$host/");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_NOBODY         => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (relay diag)',
    ]);
    curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);
    out(200, [
        'ok'               => true,
        'egress_ip'        => $egress ?: 'unknown',
        'target'           => $host,
        'target_reachable' => $code > 0,
        'target_http_code' => $code,
        'curl_error'       => $err,
        'ms'               => (int) round((microtime(true) - $t0) * 1000),
        'php_version'      => PHP_VERSION,
    ]);
}

// ---------- forward mode ----------
$raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
if ($raw !== false && strlen($raw) > MAX_BODY) fail(413, 'request body too large');

$req = json_decode((string) $raw, true);
if (!is_array($req) || empty($req['url'])) {
    fail(400, 'expected JSON body {url, method?, headers?, body?, timeout?}');
}

$url   = (string) $req['url'];
$parts = parse_url($url);
if (!$parts || (($parts['scheme'] ?? '') !== 'https')) fail(400, 'target must be an https url');
if (!in_array(strtolower($parts['host'] ?? ''), ALLOW_HOSTS, true)) {
    fail(403, 'target host not allowed', ['host' => $parts['host'] ?? null]);
}

$method  = strtoupper((string) ($req['method'] ?? 'GET'));
$headers = [];
foreach ((array) ($req['headers'] ?? []) as $k => $v) {
    $headers[] = $k . ': ' . $v;
}
$body    = $req['body'] ?? null;            // raw string (JSON or form-encoded)
$timeout = (int) ($req['timeout'] ?? 40);

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER         => true,
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_TIMEOUT        => $timeout > 0 && $timeout <= 120 ? $timeout : 40,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_ENCODING       => '',           // transparently handle gzip/deflate
]);
if ($body !== null && $method !== 'GET') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, (string) $body);
}

$resp = curl_exec($ch);
if ($resp === false) {
    $err = curl_error($ch);
    curl_close($ch);
    fail(502, 'relay upstream error: ' . $err);
}
$info  = curl_getinfo($ch);
$hsize = (int) $info['header_size'];
curl_close($ch);

$rawHeaders = substr($resp, 0, $hsize);
$respBody   = substr($resp, $hsize);

// Parse response headers; collapse repeats (e.g. multiple Set-Cookie) into arrays.
$respHeaders = [];
foreach (explode("\r\n", trim((string) $rawHeaders)) as $line) {
    if (strpos($line, ':') === false) continue;       // skip the "HTTP/1.1 200" status line
    [$k, $v] = explode(':', $line, 2);
    $k = trim($k);
    $v = trim($v);
    if (isset($respHeaders[$k])) {
        if (!is_array($respHeaders[$k])) $respHeaders[$k] = [$respHeaders[$k]];
        $respHeaders[$k][] = $v;
    } else {
        $respHeaders[$k] = $v;
    }
}

out(200, [
    'ok'      => true,
    'status'  => (int) $info['http_code'],
    'headers' => $respHeaders,
    'body'    => $respBody,
]);
