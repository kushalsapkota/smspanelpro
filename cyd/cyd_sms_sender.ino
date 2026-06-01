/*
 * CYD (Cheap Yellow Display, ESP32-2432S028R) -> SMPP Bridge SMS sender.
 * Tap the touchscreen to send a pre-set SMS through the panel's HTTP API.
 *
 * Libraries (Arduino IDE -> Library Manager):
 *   - TFT_eSPI  (Bodmer)   -- configure User_Setup.h for the CYD (see cyd/README.md)
 *   - XPT2046_Touchscreen  (Paul Stoffregen)
 * Board: "ESP32 Dev Module"
 *
 * WARNING: each tap sends a REAL SMS and costs credit. Set SMS_TO to a number you own.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>

// ---------- EDIT THESE ----------
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char* API_URL = "http://161.97.175.110:4000/api/v1/sms/send";
const char* API_KEY = "sk_41f1ace812f22d64aaee82d67a24b7c0ef31631ecbd79407";

const char* SMS_TO   = "9779812345678";        // <-- a number YOU own
const char* SMS_TEXT = "Hello from my CYD!";
// --------------------------------

TFT_eSPI tft = TFT_eSPI();

// CYD resistive touch (XPT2046) is on its own SPI bus:
#define XPT2046_IRQ  36
#define XPT2046_MOSI 32
#define XPT2046_MISO 39
#define XPT2046_CLK  25
#define XPT2046_CS   33
SPIClass touchSPI(VSPI);
XPT2046_Touchscreen touch(XPT2046_CS, XPT2046_IRQ);

void banner(const char* s, uint16_t color = TFT_WHITE) {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(color, TFT_BLACK);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(s, tft.width() / 2, tft.height() / 2, 4);
}

int sendSMS(const char* to, const char* text) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  String body = String("{\"to\":\"") + to + "\",\"text\":\"" + text + "\"}";
  int code = http.POST(body);
  Serial.printf("HTTP %d -> %s\n", code, http.getString().c_str());
  http.end();
  return code;             // 202 = queued OK; 401 bad key; 402 no credit; 400/403 bad request
}

void setup() {
  Serial.begin(115200);
  tft.init();
  tft.setRotation(1);
  touchSPI.begin(XPT2046_CLK, XPT2046_MISO, XPT2046_MOSI, XPT2046_CS);
  touch.begin(touchSPI);
  touch.setRotation(1);

  banner("WiFi...", TFT_CYAN);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(300); Serial.print("."); }
  if (WiFi.status() != WL_CONNECTED) { banner("WiFi FAILED", TFT_RED); return; }
  banner("TAP TO SEND", TFT_GREEN);
}

void loop() {
  if (touch.tirqTouched() && touch.touched()) {
    banner("Sending...", TFT_YELLOW);
    int code = sendSMS(SMS_TO, SMS_TEXT);
    if (code == 202) banner("SENT \xE2\x9C\x93", TFT_GREEN);
    else { char b[24]; snprintf(b, sizeof(b), "ERR %d", code); banner(b, TFT_RED); }
    delay(1800);
    banner("TAP TO SEND", TFT_GREEN);
    while (touch.touched()) delay(20);   // wait for finger lift (debounce)
  }
  delay(40);
}
