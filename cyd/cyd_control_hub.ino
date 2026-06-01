/*
 * CYD Control Hub v7 — "fintech dark" touchscreen ops console for the SMPP Bridge.
 *
 * What v7 changes vs v6 (the "looks like a kids toy" complaint):
 *  - Real typography: FreeSans / FreeSansBold (GFXFF) instead of the blocky built-in
 *    bitmap fonts. Big sans-serif numbers + tiny uppercase labels = dashboard look.
 *  - Pro fintech-dark design system: deep charcoal bg, one indigo accent, airy spacing,
 *    thin dividers, drawn vector icons in the bottom nav, real NTP clock in the header.
 *  - Auto-lock + screen sleep (PWM backlight dim->off, wake on touch, PIN re-lock).
 *  - Client search + sort (name / balance asc / balance desc).
 *  - Quick top-up presets (+10 / +50 / +100) on the client screen.
 *  - Per-client 7-day sends sparkline (from the /client/:id `daily` array — no server change).
 *
 * HARD RULE (learned in v4): TFT_eSPI fonts cannot render € or emoji — device strings are
 * ASCII only. Money is "EUR 1,284.50"; the bar graph / sparkline are drawn from rects.
 *
 * Libs: TFT_eSPI (CYD User_Setup, LOAD_GFXFF on) · XPT2046_Touchscreen · ArduinoJson v7 · WiFiManager.
 * NOTE: WiFiManager/WebServer MUST be included BEFORE TFT_eSPI (TFT_eSPI defines
 * FS_NO_GLOBALS which would break WebServer.h). Board: ESP32 Dev Module · Partition: Huge App.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <FS.h>
#include <WebServer.h>
#include <WiFiManager.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>
#include <Preferences.h>
#include <time.h>
// GFXFF free fonts (FreeSans*) are compiled in by TFT_eSPI when LOAD_GFXFF is set —
// the font structs below are already declared globally, so we must NOT re-include them.

// ---------------- CONFIG ----------------
const char* BASE_URL    = "http://161.97.175.110:4000";
const char* DEVICE_KEY  = "sk_843787b0ae62946900d643fc16a5a483062b912a598bf776";
const char* PIN_CODE    = "1234";
const char* AP_NAME     = "CYD-Setup";
const char* AP_PASS     = "12345678";
const char* TEST_MSG    = "Test from CYD control hub";
const long  GMT_OFFSET  = 20700;   // header clock offset, sec. Nepal +5:45 = 20700. (US ET = -18000, etc.)
// auto-lock timings (ms)
const uint32_t DIM_MS   = 45000;   // dim backlight after idle
const uint32_t OFF_MS   = 90000;   // sleep (backlight off) after idle
const uint32_t LOCK_MS  = 300000;  // require PIN again after idle
// ----------------------------------------

// CYD peripherals
#define LED_R 4
#define LED_G 16
#define LED_B 17
#define SPK   26
#define BL_PIN 21          // TFT backlight (PWM for dim/sleep)
#define BL_FULL 255
#define BL_DIM  40

// ---- fintech-dark palette (RGB565) ----
#define C565(r,g,b) ((((r)&0xF8)<<8)|(((g)&0xFC)<<3)|((b)>>3))
const uint16_t
  BG    = C565(10,13,20),    // app background
  CARD  = C565(22,27,38),    // card surface
  CARD2 = C565(30,37,52),    // elevated / pressed
  HEAD  = C565(14,18,28),    // header bar
  LINE  = C565(38,46,64),    // hairline divider
  ACC   = C565(91,140,255),  // indigo accent (the one accent)
  GREEN = C565(40,199,111),
  RED   = C565(234,84,85),
  AMBER = C565(255,159,67),
  MUT   = C565(122,134,154), // muted label text
  TXT   = C565(232,236,244); // primary text

TFT_eSPI tft = TFT_eSPI();
#define T_IRQ 36
#define T_CLK 25
#define T_MOSI 32
#define T_MISO 39
#define T_CS 33
SPIClass tsSPI(VSPI);
XPT2046_Touchscreen ts(T_CS, T_IRQ);
WiFiManager wm;
Preferences prefs;

bool invertColors = false, soundOn = true, autoLock = true;

enum Screen { SC_PIN, SC_PORTAL, SC_DASH, SC_CLIENTS, SC_CLIENT, SC_KEYPAD, SC_ALERTS, SC_SETTINGS, SC_KEYBOARD };
Screen screen = SC_PIN;

// ---- buttons ----
struct Btn { int x, y, w, h; int id; };
Btn btns[40]; int nbtns = 0;
void clearBtns() { nbtns = 0; }
int hitBtn(int px, int py) { for (int i = 0; i < nbtns; i++) { Btn& b = btns[i]; if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.id; } return -1; }

// ---- font + text helpers ----
const GFXfont *FS9 = &FreeSans9pt7b, *FSB9 = &FreeSansBold9pt7b, *FSB12 = &FreeSansBold12pt7b, *FSB18 = &FreeSansBold18pt7b;
void vtext(String s, int x, int y, const GFXfont* f, uint16_t fg, uint16_t bg, uint8_t datum) {
  tft.setFreeFont(f); tft.setTextColor(fg, bg); tft.setTextDatum(datum); tft.drawString(s, x, y);
}
// tiny uppercase label (built-in font 1 — deliberately small under the big sans numbers)
void ltext(String s, int x, int y, uint16_t fg, uint16_t bg, uint8_t datum = TL_DATUM) {
  tft.setTextFont(1); tft.setTextColor(fg, bg); tft.setTextDatum(datum); tft.drawString(s, x, y);
}
void button(int x, int y, int w, int h, String label, int id, uint16_t bg, uint16_t fg = TXT, const GFXfont* f = 0) {
  btns[nbtns++] = {x, y, w, h, id};
  tft.fillRoundRect(x, y, w, h, 8, bg);
  if (f) vtext(label, x + w / 2, y + h / 2, f, fg, bg, MC_DATUM);
  else   { tft.setTextFont(2); tft.setTextColor(fg, bg); tft.setTextDatum(MC_DATUM); tft.drawString(label, x + w / 2, y + h / 2); }
}

const int T_MINX = 200, T_MAXX = 3700, T_MINY = 240, T_MAXY = 3800;
bool getTouch(int& x, int& y) {
  if (!ts.touched()) return false;
  TS_Point p = ts.getPoint();
  x = constrain(map(p.x, T_MINX, T_MAXX, 0, tft.width()), 0, tft.width() - 1);
  y = constrain(map(p.y, T_MINY, T_MAXY, 0, tft.height()), 0, tft.height() - 1);
  return true;
}

String httpReq(const char* method, String path, String body = "") {
  if (WiFi.status() != WL_CONNECTED) return "{\"error\":\"no wifi\"}";
  HTTPClient http; http.begin(String(BASE_URL) + path);
  http.addHeader("X-API-Key", DEVICE_KEY);
  if (body.length()) http.addHeader("Content-Type", "application/json");
  int code = (strcmp(method, "POST") == 0) ? http.POST(body) : http.GET();
  String r = (code > 0) ? http.getString() : String("{\"error\":\"net ") + code + "\"}";
  http.end(); return r;
}

// ---- money: "1,284.50" (ASCII, no euro glyph) ----
String money(float v) {
  bool neg = v < 0; if (neg) v = -v;
  long cents = (long)(v * 100 + 0.5); long ip = cents / 100; int fp = cents % 100;
  String s = String(ip), out = ""; int c = 0;
  for (int i = s.length() - 1; i >= 0; i--) { out = String(s[i]) + out; if (++c % 3 == 0 && i > 0) out = "," + out; }
  char buf[8]; sprintf(buf, ".%02d", fp);
  return (neg ? "-" : "") + out + String(buf);
}

struct CliRec { String id, username; float credits; bool suspended; };
CliRec clients[60]; int nclients = 0, selClient = -1, clientPage = 0;
int view[60], nview = 0, sortMode = 0; // 0 name, 1 bal asc, 2 bal desc
String cliFilter = "";
float dailyVals[7]; int ndaily = 0; // per-client sparkline source

String keypadBuf, keypadTitle; int keypadAction = 0; // 1 bal 2 price 3 thresh 4 test-number 10 new-price 11 new-bal
String kbBuf, kbTitle, newUser, newPrice, sendTo; int kbAction = 0, kbMode = 0; // 1 new-user, 2 send-msg, 3 client filter

// alerts
int alertCount = 0, criticalCount = 0, lastCritical = 0;
String alertLines[10]; int alertLevel[10]; int nalerts = 0;

// auto-lock / sleep state
uint32_t lastActivity = 0;
bool dimmed = false, asleep = false, locked = false;

void led(bool r, bool g, bool b) { digitalWrite(LED_R, r ? LOW : HIGH); digitalWrite(LED_G, g ? LOW : HIGH); digitalWrite(LED_B, b ? LOW : HIGH); }
void beep(int f, int ms) { if (soundOn) tone(SPK, f, ms); }
void setBL(int duty) { ledcWrite(BL_PIN, duty); }

String clockStr() {
  struct tm t; if (!getLocalTime(&t, 5)) return "--:--";
  char b[6]; sprintf(b, "%02d:%02d", t.tm_hour, t.tm_min); return String(b);
}

void render();

// ---- nav icons (drawn vector glyphs, ~18px) ----
void icon(int cx, int cy, int type, uint16_t col) {
  switch (type) {
    case 0: // home
      tft.fillTriangle(cx, cy - 8, cx - 9, cy, cx + 9, cy, col);
      tft.fillRect(cx - 6, cy, 12, 7, col); break;
    case 1: // clients (two heads)
      tft.fillCircle(cx - 5, cy - 4, 3, col); tft.fillCircle(cx + 5, cy - 4, 3, col);
      tft.fillRoundRect(cx - 9, cy, 8, 6, 2, col); tft.fillRoundRect(cx + 1, cy, 8, 6, 2, col); break;
    case 2: // bell
      tft.fillRoundRect(cx - 6, cy - 7, 12, 11, 5, col); tft.fillRect(cx - 8, cy + 3, 16, 2, col);
      tft.fillCircle(cx, cy + 7, 2, col); break;
    case 3: // gear
      tft.fillCircle(cx, cy, 7, col); tft.fillCircle(cx, cy, 3, BG);
      for (int a = 0; a < 360; a += 90) { float r = a * 0.0174533; tft.fillRect(cx + cos(r) * 7 - 1, cy + sin(r) * 7 - 1, 3, 3, col); } break;
  }
}
void navbar(int active) {
  tft.fillRect(0, 207, 320, 33, HEAD); tft.drawFastHLine(0, 207, 320, LINE);
  const char* n[] = {"Home", "Clients", "Alerts", "Setup"}; int id[] = {70, 71, 72, 73};
  for (int i = 0; i < 4; i++) {
    int x = i * 80, cx = x + 40; bool on = (i == active);
    if (on) tft.fillRoundRect(x + 10, 210, 60, 27, 7, CARD2);
    icon(cx, 219, i, on ? ACC : MUT);
    ltext(n[i], cx, 230, on ? TXT : MUT, on ? CARD2 : HEAD, MC_DATUM);
  }
}

// Repaint only the header's right cluster (clock + alert badge + wifi dot) in place.
// Same-color (HEAD) refill -> no black flash, so it's safe to call on a background refresh.
void paintClockBadge() {
  tft.fillRect(176, 0, 144, 34, HEAD);   // clears right cluster only; leaves title + hairline (y=34)
  int rx = 308;
  bool on = WiFi.status() == WL_CONNECTED;
  tft.fillCircle(rx, 17, 4, on ? GREEN : RED); rx -= 14;
  ltext(clockStr(), rx, 17, MUT, HEAD, MR_DATUM); rx -= 38;
  if (criticalCount > 0) { tft.fillRoundRect(rx - 26, 7, 30, 20, 6, RED); vtext("!" + String(criticalCount), rx - 11, 17, FSB9, TXT, RED, MC_DATUM); }
  else if (alertCount > 0) { tft.fillRoundRect(rx - 26, 7, 30, 20, 6, AMBER); vtext(String(alertCount), rx - 11, 17, FSB9, BG, AMBER, MC_DATUM); }
}
void header(String t) {
  tft.fillScreen(BG);
  tft.fillRect(0, 0, 320, 34, HEAD); tft.drawFastHLine(0, 34, 320, LINE);
  vtext(t, 12, 17, FSB12, TXT, HEAD, ML_DATUM);
  paintClockBadge();
}

void toast(String s, uint16_t col = GREEN) {
  tft.fillRoundRect(30, 96, 260, 52, 12, col);
  vtext(s, 160, 122, FSB12, BG, col, MC_DATUM); delay(1300);
}
void banner(String s) {
  tft.fillRoundRect(20, 80, 280, 80, 14, RED);
  vtext("CRITICAL ALERT", 160, 106, FSB12, TXT, RED, MC_DATUM);
  vtext(s, 160, 136, FS9, TXT, RED, MC_DATUM);
  beep(1200, 180); delay(220); beep(1200, 180); delay(1800);
}

// ---- data ----
void pollAlerts() {
  JsonDocument d; if (deserializeJson(d, httpReq("GET", "/api/device/alerts"))) return;
  alertCount = (int)d["count"]; criticalCount = (int)d["critical"]; nalerts = 0;
  for (JsonObject a : d["alerts"].as<JsonArray>()) { if (nalerts >= 10) break; alertLines[nalerts] = String((const char*)a["msg"]); alertLevel[nalerts] = (String((const char*)a["level"]) == "critical") ? 1 : 0; nalerts++; }
  if (criticalCount > lastCritical) { led(1, 0, 0); banner(nalerts ? alertLines[0] : "Critical condition"); render(); }
  lastCritical = criticalCount;
}

// ---- screens ----
void drawPin() {
  tft.fillScreen(BG);
  vtext("Control Hub", 160, 36, FSB18, TXT, BG, MC_DATUM);
  vtext(locked ? "Locked - enter PIN" : "Enter PIN", 160, 60, FS9, MUT, BG, MC_DATUM);
  clearBtns();
  // dots
  int n = keypadBuf.length();
  for (int i = 0; i < 4; i++) { int cx = 124 + i * 24; if (i < n) tft.fillCircle(cx, 84, 5, ACC); else tft.drawCircle(cx, 84, 5, MUT); }
  const char* k[] = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "OK"};
  for (int i = 0; i < 12; i++) { int r = i / 3, c = i % 3; button(82 + c * 54, 100 + r * 30, 48, 26, k[i], 100 + i, i == 11 ? GREEN : CARD, i == 11 ? BG : TXT, FSB9); }
  button(8, 210, 150, 26, "Reset WiFi", 90, CARD, MUT, FSB9);
}

// KPI cell: tiny label + big sans value
void kpi(int x, int y, int w, int h, const char* label, String value, uint16_t vc) {
  tft.fillRoundRect(x, y, w, h, 9, CARD);
  ltext(label, x + 12, y + 11, MUT, CARD);
  vtext(value, x + 12, y + h - 12, FSB18, vc, CARD, BL_DATUM);
}

// In-place dashboard data paint — NO fillScreen, so it's used for the background refresh
// (every 8s) without the screen blinking. Each region is repainted over its own surface
// colour (CARD / BG / HEAD), and a failed fetch leaves the last good values on screen.
void dashData() {
  JsonDocument s;
  if (deserializeJson(s, httpReq("GET", "/api/device/summary"))) { paintClockBadge(); return; } // keep last data; just update wifi dot
  int del = s["dlr"]["delivered"], acc = s["dlr"]["accepted"], fail = s["dlr"]["failed"];
  int tot = del + acc + fail; float rate = tot ? (100.0 * (del + acc) / tot) : 100.0;
  uint16_t rc = rate >= 90 ? GREEN : (rate >= 60 ? AMBER : RED);
  // KPI cells (same-colour card refill -> no black flash)
  kpi(8, 42, 150, 50, "REVENUE (EUR)", money((float)s["revenue"]), GREEN);
  kpi(162, 42, 150, 50, "TODAY", String((int)s["today"]["msgs"]) + " sms", TXT);
  // delivery rate + bar (sits on BG)
  tft.fillRect(8, 96, 304, 27, BG);
  ltext("DELIVERY RATE", 12, 102, MUT, BG);
  vtext(String(rate, 1) + "%", 308, 100, FSB9, rc, BG, TR_DATUM);
  tft.fillRoundRect(12, 116, 296, 6, 3, CARD2);
  int fw = (int)(296 * rate / 100.0); if (fw < 4 && rate > 0) fw = 4;
  tft.fillRoundRect(12, 116, fw, 6, 3, rc);
  // 12h graph card
  int gx = 8, gy = 130, gw = 304, gh = 73;
  tft.fillRoundRect(gx, gy, gw, gh, 9, CARD);
  ltext("SENDS - LAST 12H", gx + 12, gy + 9, MUT, CARD);
  vtext("D" + String(del) + "  A" + String(acc) + "  F" + String(fail), gx + gw - 10, gy + 12, FSB9, MUT, CARD, TR_DATUM);
  JsonDocument g;
  if (!deserializeJson(g, httpReq("GET", "/api/device/graph"))) {
    int nb = 12, amax = g["max"] | 1, bw = (gw - 24) / nb, base = gy + gh - 9, top = gy + 26;
    for (int i = 0; i < nb; i++) {
      int total = g["bars"][i]["total"], failed = g["bars"][i]["failed"];
      int bx = gx + 12 + i * bw;
      if (total <= 0) { tft.fillRoundRect(bx, base - 2, bw - 3, 2, 1, CARD2); continue; }
      int hh = (int)((float)total / amax * (base - top)); if (hh < 3) hh = 3;
      int fh = (int)((float)failed / total * hh);
      tft.fillRoundRect(bx, base - (hh - fh), bw - 3, hh - fh, 1, GREEN);
      if (fh > 0) tft.fillRoundRect(bx, base - hh, bw - 3, fh, 1, RED);
    }
  }
  paintClockBadge();
}
// Full draw (on navigation): clear once, lay the static chrome, then fill data in place.
void drawDash() {
  header("Control Hub");
  clearBtns();
  navbar(0);
  dashData();
}

void loadClients() {
  JsonDocument d; deserializeJson(d, httpReq("GET", "/api/device/clients"));
  nclients = 0;
  for (JsonObject c : d.as<JsonArray>()) { if (nclients >= 60) break; clients[nclients++] = { String((const char*)c["id"]), String((const char*)c["username"]), (float)c["credits"], (bool)c["suspended"] }; }
}
void buildView() {
  nview = 0;
  for (int i = 0; i < nclients; i++) { if (cliFilter.length() && clients[i].username.indexOf(cliFilter) < 0) continue; view[nview++] = i; }
  // simple insertion sort on the view index
  for (int a = 1; a < nview; a++) {
    int v = view[a], b = a - 1;
    while (b >= 0) {
      bool sw;
      if (sortMode == 0) sw = clients[view[b]].username > clients[v].username;
      else if (sortMode == 1) sw = clients[view[b]].credits > clients[v].credits;
      else sw = clients[view[b]].credits < clients[v].credits;
      if (!sw) break; view[b + 1] = view[b]; b--;
    }
    view[b + 1] = v;
  }
}
void drawClients() {
  header("Clients");
  clearBtns();
  loadClients(); buildView();
  // search + sort row
  button(8, 40, 232, 26, cliFilter.length() ? ("Search: " + cliFilter) : "Search clients...", 34, CARD, cliFilter.length() ? TXT : MUT, FSB9);
  const char* sm[] = {"A-Z", "Low EUR", "High EUR"};
  button(246, 40, 66, 26, sm[sortMode], 35, CARD2, ACC, FSB9);
  const int PER = 3;
  int pages = (nview + PER - 1) / PER; if (pages < 1) pages = 1;
  if (clientPage >= pages) clientPage = 0;
  int start = clientPage * PER, y = 72;
  for (int k = start; k < nview && k < start + PER; k++) {
    int i = view[k];
    tft.fillRoundRect(8, y, 304, 36, 8, CARD);
    if (clients[i].suspended) { tft.fillRoundRect(8, y, 4, 36, 2, RED); }
    vtext(clients[i].username, 18, y + 18, FSB12, clients[i].suspended ? MUT : TXT, CARD, ML_DATUM);
    uint16_t bc = clients[i].credits <= 0 ? RED : (clients[i].credits <= 5 ? AMBER : GREEN);
    vtext("EUR " + money(clients[i].credits), 304, y + 18, FSB9, bc, CARD, MR_DATUM);
    btns[nbtns++] = {8, y, 304, 36, 200 + i}; y += 41;
  }
  if (!nview) vtext(cliFilter.length() ? "No matches" : "No clients", 160, 120, FSB12, MUT, BG, MC_DATUM);
  // footer: new / prev / page / next
  button(8, 178, 70, 26, "+ New", 31, GREEN, BG, FSB9);
  button(150, 178, 50, 26, "Prev", 32, CARD, MUT, FSB9);
  button(204, 178, 50, 26, "Next", 33, CARD, MUT, FSB9);
  ltext(String(clientPage + 1) + "/" + String(pages), 130, 191, MUT, BG, MC_DATUM);
  navbar(1);
}

void drawSpark(int x, int y, int w, int h) {
  tft.drawFastHLine(x, y + h, w, LINE);
  if (ndaily < 1) { ltext("no recent activity", x, y + 2, MUT, CARD); return; }
  float mx = 1; for (int i = 0; i < ndaily; i++) if (dailyVals[i] > mx) mx = dailyVals[i];
  int bw = ndaily > 1 ? w / ndaily : w;
  for (int i = 0; i < ndaily; i++) {
    int bh = (int)(dailyVals[i] / mx * h); if (bh < 2 && dailyVals[i] > 0) bh = 2;
    tft.fillRoundRect(x + i * bw + 1, y + h - bh, bw - 3, bh, 1, ACC);
  }
}
void drawClient() {
  CliRec& cr = clients[selClient];
  header(cr.username);
  clearBtns();
  JsonDocument d; deserializeJson(d, httpReq("GET", "/api/device/client/" + cr.id));
  float bal = (float)d["credits"];
  // balance card with sparkline
  tft.fillRoundRect(8, 40, 304, 60, 9, CARD);
  ltext("BALANCE (EUR)", 16, 48, MUT, CARD);
  vtext(money(bal), 16, 90, FSB18, bal <= 0 ? RED : GREEN, CARD, BL_DATUM);
  ltext(String((int)d["sms_left"]) + " SMS LEFT", 16, 94, MUT, CARD);
  // sparkline (7d, daily is desc -> reverse to chronological)
  ndaily = 0; JsonArray da = d["daily"].as<JsonArray>();
  int cnt = da.size(); for (int i = cnt - 1; i >= 0 && ndaily < 7; i--) dailyVals[ndaily++] = (float)da[i]["msgs"];
  ltext("7-DAY SENDS", 196, 48, MUT, CARD, TL_DATUM);
  drawSpark(196, 54, 104, 30);
  // meta line
  vtext("Price EUR " + money((float)d["price"]) + " / SMS", 12, 112, FS9, MUT, BG, ML_DATUM);
  vtext(cr.suspended ? "SUSPENDED" : "Active", 308, 112, FSB9, cr.suspended ? RED : GREEN, BG, MR_DATUM);
  // quick top-up presets
  ltext("QUICK TOP-UP", 12, 126, MUT, BG);
  button(8, 136, 98, 30, "+10", 60, CARD2, GREEN, FSB9);
  button(111, 136, 98, 30, "+50", 61, CARD2, GREEN, FSB9);
  button(214, 136, 98, 30, "+100", 62, CARD2, GREEN, FSB9);
  // actions
  button(8, 170, 98, 30, "Balance", 41, ACC, BG, FSB9);
  button(111, 170, 98, 30, "Price", 42, CARD, TXT, FSB9);
  button(214, 170, 98, 30, "Threshold", 43, CARD, TXT, FSB9);
  button(8, 206, 70, 30, "Back", 40, CARD, MUT, FSB9);
  button(84, 206, 74, 30, cr.suspended ? "Resume" : "Suspend", 44, cr.suspended ? GREEN : RED, BG, FSB9);
  button(164, 206, 70, 30, "Reset PW", 45, CARD, TXT, FSB9);
  button(240, 206, 72, 30, "Test SMS", 46, AMBER, BG, FSB9);
}

void drawKeypad() {
  header(keypadTitle);
  clearBtns();
  tft.fillRoundRect(8, 42, 304, 38, 9, CARD);
  vtext(keypadBuf.length() ? keypadBuf : "0", 160, 61, FSB18, ACC, CARD, MC_DATUM);
  const char* k[] = {"1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "<"};
  for (int i = 0; i < 12; i++) { int r = i / 3, c = i % 3; button(82 + c * 54, 90 + r * 28, 48, 24, k[i], 100 + i, CARD, TXT, FSB9); }
  button(8, 208, 150, 28, "Cancel", 50, RED, BG, FSB9);
  button(162, 208, 150, 28, "Confirm", 51, GREEN, BG, FSB9);
}

void drawAlerts() {
  header("Alerts");
  clearBtns();
  if (!nalerts) { icon(160, 96, 2, GREEN); vtext("All clear", 160, 130, FSB12, GREEN, BG, MC_DATUM); navbar(2); return; }
  int y = 42;
  for (int i = 0; i < nalerts && i < 5; i++) {
    uint16_t c = alertLevel[i] ? RED : AMBER;
    tft.fillRoundRect(8, y, 304, 28, 7, CARD); tft.fillRoundRect(8, y, 5, 28, 2, c);
    vtext(alertLines[i], 20, y + 14, FS9, TXT, CARD, ML_DATUM);
    y += 32;
  }
  navbar(2);
}

void drawPortal() {
  tft.fillScreen(BG); tft.fillRect(0, 0, 320, 34, HEAD);
  vtext("WiFi Setup", 12, 17, FSB12, TXT, HEAD, ML_DATUM);
  vtext("On your phone, join WiFi:", 160, 72, FS9, MUT, BG, MC_DATUM);
  vtext(String(AP_NAME), 160, 104, FSB18, ACC, BG, MC_DATUM);
  vtext("password: " + String(AP_PASS), 160, 134, FS9, MUT, BG, MC_DATUM);
  vtext("then pick your network & save", 160, 162, FS9, TXT, BG, MC_DATUM);
}

void toggleRow(int y, const char* label, bool on, int id) {
  tft.fillRoundRect(8, y, 304, 30, 8, CARD);
  vtext(label, 16, y + 15, FS9, TXT, CARD, ML_DATUM);
  uint16_t c = on ? GREEN : CARD2;
  btns[nbtns++] = {238, y + 4, 66, 22, id};
  tft.fillRoundRect(238, y + 4, 66, 22, 11, c);
  tft.fillCircle(on ? 293 : 249, y + 15, 8, TXT);
  ltext(on ? "ON" : "OFF", on ? 250 : 280, y + 15, BG, c, ML_DATUM);
}
void drawSettings() {
  header("Setup");
  clearBtns();
  // wifi info card
  tft.fillRoundRect(8, 40, 304, 48, 9, CARD);
  ltext("NETWORK", 16, 47, MUT, CARD);
  bool on = WiFi.status() == WL_CONNECTED;
  vtext(on ? WiFi.SSID() : "not connected", 16, 78, FSB12, on ? TXT : RED, CARD, BL_DATUM);
  ltext(on ? (WiFi.localIP().toString() + "  " + String(WiFi.RSSI()) + "dBm") : "-", 304, 47, MUT, CARD, TR_DATUM);
  toggleRow(94, "Auto-lock & screen sleep", autoLock, 83);
  toggleRow(128, "Sound", soundOn, 84);
  toggleRow(162, "Invert colors (fix washed look)", invertColors, 82);
  button(8, 196, 98, 28, "Lock now", 85, CARD2, ACC, FSB9);
  button(111, 196, 98, 28, "Change WiFi", 80, CARD, TXT, FSB9);
  button(214, 196, 98, 28, "Forget WiFi", 81, CARD, RED, FSB9);
  navbar(3);
}

void drawKeyboard() {
  header(kbTitle);
  clearBtns();
  tft.fillRoundRect(8, 40, 304, 32, 8, CARD);
  String shown = kbBuf.length() > 24 ? kbBuf.substring(kbBuf.length() - 24) : kbBuf;
  vtext(shown + "_", 16, 56, FSB12, ACC, CARD, ML_DATUM);
  const char* rows[3];
  if (kbMode == 2) { rows[0] = "1234567890"; rows[1] = "-_.@/:+#"; rows[2] = "!?,()&%"; }
  else if (kbMode == 1) { rows[0] = "QWERTYUIOP"; rows[1] = "ASDFGHJKL"; rows[2] = "ZXCVBNM"; }
  else { rows[0] = "qwertyuiop"; rows[1] = "asdfghjkl"; rows[2] = "zxcvbnm"; }
  int kw = 30, kh = 28, gap = 2;
  for (int r = 0; r < 3; r++) {
    int n = strlen(rows[r]), x0 = (320 - n * (kw + gap)) / 2;
    for (int i = 0; i < n; i++) { char c = rows[r][i]; button(x0 + i * (kw + gap), 78 + r * 32, kw, kh, String(c), 1000 + (int)c, CARD, TXT, FSB9); }
  }
  button(6, 174, 58, 28, kbMode == 2 ? "ABC" : "123", 900, ACC, BG, FSB9);
  button(68, 174, 120, 28, "space", 902, CARD, TXT, FSB9);
  button(192, 174, 58, 28, "DEL", 901, CARD, TXT, FSB9);
  button(254, 174, 58, 28, "Shift", 905, kbMode == 1 ? ACC : CARD, kbMode == 1 ? BG : MUT, FSB9);
  button(6, 206, 150, 28, "Cancel", 904, RED, BG, FSB9);
  button(162, 206, 150, 28, "OK", 903, GREEN, BG, FSB9);
}

void render() {
  switch (screen) {
    case SC_KEYBOARD: drawKeyboard(); break;
    case SC_PIN: drawPin(); break;
    case SC_DASH: drawDash(); break;
    case SC_CLIENTS: drawClients(); break;
    case SC_CLIENT: drawClient(); break;
    case SC_KEYPAD: drawKeypad(); break;
    case SC_ALERTS: drawAlerts(); break;
    case SC_SETTINGS: drawSettings(); break;
    case SC_PORTAL: drawPortal(); break;
  }
}

void topup(float amt) {
  JsonDocument d; deserializeJson(d, httpReq("POST", "/api/device/client/" + clients[selClient].id + "/balance", "{\"amount\":" + String(amt, 0) + "}"));
  if (d["balance"].is<float>()) { clients[selClient].credits = (float)d["balance"]; toast("Balance EUR " + money((float)d["balance"])); }
  else toast("Failed", RED);
}

void doConfirm() {
  int act = keypadAction; String v = keypadBuf.length() ? keypadBuf : "0";
  if (act == 4) { sendTo = v; kbAction = 2; kbBuf = ""; kbTitle = "Message text"; kbMode = 0; keypadBuf = ""; screen = SC_KEYBOARD; return; }
  if (act == 10) { newPrice = v; keypadAction = 11; keypadBuf = ""; keypadTitle = "Start balance EUR"; screen = SC_KEYPAD; return; }
  String path, body;
  if (act == 1) { path = "/api/device/client/" + clients[selClient].id + "/balance"; body = "{\"amount\":" + v + "}"; }
  else if (act == 2) { path = "/api/device/client/" + clients[selClient].id + "/price"; body = "{\"price\":" + v + "}"; }
  else if (act == 3) { path = "/api/device/client/" + clients[selClient].id + "/threshold"; body = "{\"threshold\":" + v + "}"; }
  else if (act == 11) { path = "/api/device/client"; body = "{\"username\":\"" + newUser + "\",\"price\":" + newPrice + ",\"balance\":" + v + "}"; }
  JsonDocument d; deserializeJson(d, httpReq("POST", path, body));
  if (act == 11) { if (d["ok"] == true) toast("Created  PW " + String((const char*)(d["password"] | "?"))); else toast("Failed (name?)", RED); keypadBuf = ""; screen = SC_CLIENTS; return; }
  if (act == 1 && d["balance"].is<float>()) { clients[selClient].credits = (float)d["balance"]; toast("Balance EUR " + money((float)d["balance"])); }
  else if (d["ok"] == true) toast("Saved");
  else toast("Failed", RED);
  keypadBuf = ""; screen = SC_CLIENT;
}

void onKey(int id) {
  if (screen == SC_PIN) {
    if (id >= 100 && id <= 108) { if (keypadBuf.length() < 4) keypadBuf += String(id - 100 + 1); }
    else if (id == 110) { if (keypadBuf.length() < 4) keypadBuf += "0"; }
    else if (id == 109) keypadBuf = "";
    else if (id == 90) { wm.resetSettings(); toast("WiFi cleared - reboot", RED); ESP.restart(); }
    else if (id == 111) { if (keypadBuf == PIN_CODE) { keypadBuf = ""; locked = false; screen = SC_DASH; } else { keypadBuf = ""; toast("Wrong PIN", RED); } }
    render(); return;
  }
  if (screen == SC_KEYPAD) {
    if (id >= 100 && id <= 108) keypadBuf += String(id - 100 + 1);
    else if (id == 109) { if (keypadAction != 4 && keypadBuf.indexOf('.') < 0) keypadBuf += "."; }
    else if (id == 110) keypadBuf += "0";
    else if (id == 111) keypadBuf = keypadBuf.substring(0, keypadBuf.length() ? keypadBuf.length() - 1 : 0);
    else if (id == 50) { keypadBuf = ""; screen = SC_CLIENT; }
    else if (id == 51) doConfirm();
    render(); return;
  }
  if (screen == SC_KEYBOARD) {
    if (id >= 1000) { if (kbBuf.length() < 100) kbBuf += (char)(id - 1000); if (kbMode == 1) kbMode = 0; }
    else if (id == 900) kbMode = (kbMode == 2) ? 0 : 2;
    else if (id == 905) kbMode = (kbMode == 1) ? 0 : 1;
    else if (id == 902) kbBuf += " ";
    else if (id == 901) kbBuf = kbBuf.substring(0, kbBuf.length() ? kbBuf.length() - 1 : 0);
    else if (id == 904) { kbBuf = ""; screen = (kbAction == 3) ? SC_CLIENTS : (kbAction == 1 ? SC_CLIENTS : SC_CLIENT); }
    else if (id == 903) {
      if (kbAction == 3) { cliFilter = kbBuf; kbBuf = ""; clientPage = 0; screen = SC_CLIENTS; }
      else if (kbAction == 1) { newUser = kbBuf; keypadAction = 10; keypadBuf = ""; keypadTitle = "Price/SMS EUR"; kbBuf = ""; screen = SC_KEYPAD; }
      else if (kbAction == 2) {
        String esc = kbBuf; esc.replace("\\", "\\\\"); esc.replace("\"", "\\\"");
        JsonDocument d; deserializeJson(d, httpReq("POST", "/api/device/client/" + clients[selClient].id + "/test", "{\"to\":\"" + sendTo + "\",\"text\":\"" + esc + "\"}"));
        toast(d["ok"] == true ? "Sent: " + String((const char*)(d["dlr"] | "ok")) : "Fail", d["ok"] == true ? GREEN : RED);
        kbBuf = ""; screen = SC_CLIENT;
      }
    }
    render(); return;
  }
  // bottom nav
  if (id == 70) { screen = SC_DASH; render(); return; }
  if (id == 71) { clientPage = 0; screen = SC_CLIENTS; render(); return; }
  if (id == 72) { screen = SC_ALERTS; render(); return; }
  if (id == 73) { screen = SC_SETTINGS; render(); return; }
  if (screen == SC_CLIENTS) {
    if (id == 34) { kbAction = 3; kbBuf = cliFilter; kbTitle = "Search clients"; kbMode = 0; screen = SC_KEYBOARD; render(); return; }
    if (id == 35) { sortMode = (sortMode + 1) % 3; clientPage = 0; render(); return; }
    if (id == 31) { kbAction = 1; kbBuf = ""; kbTitle = "New client username"; kbMode = 0; screen = SC_KEYBOARD; render(); return; }
    if (id == 32) { if (clientPage > 0) clientPage--; render(); return; }
    if (id == 33) { clientPage++; render(); return; }
    if (id >= 200 && id < 260) { selClient = id - 200; screen = SC_CLIENT; render(); return; }
  }
  if (screen == SC_SETTINGS) {
    if (id == 80) { screen = SC_PORTAL; drawPortal(); wm.startConfigPortal(AP_NAME, AP_PASS); screen = SC_SETTINGS; render(); return; }
    if (id == 81) { wm.resetSettings(); toast("WiFi forgotten - reboot", RED); ESP.restart(); }
    if (id == 82) { invertColors = !invertColors; tft.invertDisplay(invertColors); prefs.putBool("inv", invertColors); render(); return; }
    if (id == 83) { autoLock = !autoLock; prefs.putBool("lock", autoLock); render(); return; }
    if (id == 84) { soundOn = !soundOn; prefs.putBool("snd", soundOn); if (soundOn) beep(900, 80); render(); return; }
    if (id == 85) { locked = true; asleep = true; setBL(0); screen = SC_PIN; keypadBuf = ""; return; }
  }
  if (screen == SC_CLIENT) {
    if (id == 40) screen = SC_CLIENTS;
    else if (id == 60) { topup(10); }
    else if (id == 61) { topup(50); }
    else if (id == 62) { topup(100); }
    else if (id == 41) { keypadAction = 1; keypadBuf = ""; keypadTitle = "Add EUR"; screen = SC_KEYPAD; }
    else if (id == 42) { keypadAction = 2; keypadBuf = ""; keypadTitle = "Price/SMS EUR"; screen = SC_KEYPAD; }
    else if (id == 43) { keypadAction = 3; keypadBuf = ""; keypadTitle = "Threshold EUR (0=global)"; screen = SC_KEYPAD; }
    else if (id == 44) { bool ns = !clients[selClient].suspended; httpReq("POST", "/api/device/client/" + clients[selClient].id + "/suspend", String("{\"suspend\":") + (ns ? "true" : "false") + "}"); clients[selClient].suspended = ns; toast(ns ? "Suspended" : "Resumed", ns ? RED : GREEN); }
    else if (id == 45) { JsonDocument d; deserializeJson(d, httpReq("POST", "/api/device/client/" + clients[selClient].id + "/password", "{}")); toast("PW: " + String((const char*)(d["password"] | "?"))); }
    else if (id == 46) { keypadAction = 4; keypadBuf = ""; keypadTitle = "Send test to (number)"; screen = SC_KEYPAD; }
    render(); return;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_R, OUTPUT); pinMode(LED_G, OUTPUT); pinMode(LED_B, OUTPUT); led(0, 0, 0);
  ledcAttach(BL_PIN, 5000, 8); setBL(BL_FULL);
  prefs.begin("cyd", false);
  invertColors = prefs.getBool("inv", false);
  soundOn = prefs.getBool("snd", true);
  autoLock = prefs.getBool("lock", true);
  tft.init(); tft.setRotation(1); tft.invertDisplay(invertColors); tft.fillScreen(BG);
  tsSPI.begin(T_CLK, T_MISO, T_MOSI, T_CS); ts.begin(tsSPI); ts.setRotation(1);
  // boot splash
  vtext("SMPP", 160, 104, FSB18, ACC, BG, MC_DATUM);
  vtext("CONTROL HUB", 160, 134, FS9, MUT, BG, MC_DATUM);
  wm.setConfigPortalTimeout(300);
  wm.setAPCallback([](WiFiManager*) { screen = SC_PORTAL; drawPortal(); });
  if (!wm.autoConnect(AP_NAME, AP_PASS)) { tft.fillScreen(BG); vtext("WiFi timeout", 160, 110, FSB12, RED, BG, MC_DATUM); delay(1500); ESP.restart(); }
  configTime(GMT_OFFSET, 0, "pool.ntp.org", "time.google.com");
  led(0, 1, 0); delay(300); led(0, 0, 0);
  lastActivity = millis();
  screen = SC_PIN; render();
}

uint32_t lastTouch = 0, lastDash = 0, lastAlert = 0, lastBlink = 0; bool blinkOn = false;
void loop() {
  int x, y; bool t = getTouch(x, y);
  uint32_t now = millis(), idle = now - lastActivity;
  if (t) {
    bool wasOff = asleep || dimmed;
    bool needLock = autoLock && idle > LOCK_MS && screen >= SC_DASH;
    lastActivity = now;
    if (wasOff) { asleep = false; dimmed = false; setBL(BL_FULL); if (needLock) { locked = true; keypadBuf = ""; screen = SC_PIN; } render(); }
    else if (now - lastTouch > 250) { lastTouch = now; int id = hitBtn(x, y); if (id >= 0) onKey(id); }
  } else if (autoLock && screen >= SC_DASH) {
    if (!asleep && idle > OFF_MS) { asleep = true; dimmed = false; setBL(0); }
    else if (!asleep && !dimmed && idle > DIM_MS) { dimmed = true; setBL(BL_DIM); }
  }
  if (!asleep) {
    if (screen >= SC_DASH && now - lastAlert > 20000) {
      lastAlert = now;
      int pc = criticalCount, pa = alertCount; pollAlerts();
      // only repaint if the alert state actually changed (avoids needless redraws/blink)
      if (criticalCount != pc || alertCount != pa) {
        if (screen == SC_ALERTS) render();        // alerts list must rebuild
        else if (screen == SC_DASH) dashData();   // dash just refreshes the badge/numbers in place
      } else if (screen == SC_DASH) paintClockBadge();
    }
    if (screen == SC_DASH && now - lastDash > 8000) { lastDash = now; dashData(); } // background refresh, no blink
  }
  if (criticalCount > 0 && now - lastBlink > 600) { lastBlink = now; blinkOn = !blinkOn; led(blinkOn, 0, 0); }
  delay(20);
}
