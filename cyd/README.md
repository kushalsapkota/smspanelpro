# CYD → SMPP Bridge (tap-to-send SMS)

Turn a **Cheap Yellow Display** (ESP32-2432S028R) into a physical SMS button that sends
through your panel's HTTP API over WiFi.

## How it talks to the panel
The bridge portal exposes a public API:

```
POST http://161.97.175.110:4000/api/v1/sms/send
Headers: X-API-Key: <key>   Content-Type: application/json
Body:    {"to":"9779812345678","text":"Hello"}
Reply:   202 {"status":"queued","message_id":"..."}   (401 bad key · 402 no credit)
```

The ESP32 just makes that HTTPS/HTTP call — no SMPP, no special protocol.

## Flash steps (Arduino IDE)
1. **Boards:** install "esp32 by Espressif" (Boards Manager). Select **ESP32 Dev Module**.
2. **Libraries** (Library Manager): `TFT_eSPI` (Bodmer) and `XPT2046_Touchscreen` (Stoffregen).
3. **Configure TFT_eSPI for the CYD** — edit `Arduino/libraries/TFT_eSPI/User_Setup.h` (or use a
   `User_Setup_Select.h` entry) with the CYD's pins:
   ```c
   #define ILI9341_2_DRIVER
   #define TFT_MISO 12
   #define TFT_MOSI 13
   #define TFT_SCLK 14
   #define TFT_CS   15
   #define TFT_DC    2
   #define TFT_RST  -1
   #define TFT_BL   21
   #define TFT_BACKLIGHT_ON HIGH
   #define SPI_FREQUENCY  55000000
   ```
   (Touch pins are set in the sketch, on a separate SPI bus.)
4. Open `cyd_sms_sender.ino`, fill in **WiFi SSID/password**, set **SMS_TO** to a number you own.
5. Upload. Watch the Serial Monitor (115200) for the HTTP response.

## Notes / safety
- **Each tap sends a REAL SMS and costs credit.** The included key is on the low-balance
  `test` client — keep device keys on a limited client, never the admin.
- The API key is baked into firmware; anyone with the device can read it. Rotate/revoke it in
  the panel (Portal → API, or Admin → user → API keys) if a device is lost.
- For HTTPS put the panel behind the reverse proxy with TLS; ESP32 can do `WiFiClientSecure`.

## CYD as a CONTROL HUB (`cyd_control_hub.ino`)
Turns the CYD into a touchscreen "control office" — same powers as the Telegram hub:
PIN unlock → **Dashboard** (revenue, clients, today, delivered/accepted/failed, low-balance)
→ **Clients** list → **Client** (balance/price/status) → **+ Balance** (on-screen keypad) /
**Suspend / Resume**.

It calls the panel's **Device API** (admin-scoped key) on port 4000:

| Method | Path | Body |
|--------|------|------|
| GET  | `/api/device/summary` | — (dashboard data) |
| GET  | `/api/device/clients` | — |
| GET  | `/api/device/client/:id` | — |
| POST | `/api/device/client/:id/balance` | `{ "amount": 10 }` (− deducts) |
| POST | `/api/device/client/:id/suspend` | `{ "suspend": true }` |
| POST | `/api/device/client/:id/price` | `{ "price": 0.018 }` |
| POST | `/api/device/client/:id/threshold` | `{ "threshold": 1000 }` |
| POST | `/api/device/client/:id/password` | — (returns new pw) |
| POST | `/api/device/client` | `{ "username","price","balance" }` |
| POST | `/api/device/client/:id/test` | `{ "to","text" }` (REAL send) |

Auth: header `X-API-Key: <admin-scoped key>`. Mint one in Mongo:
`db.apikeys.insertOne({key:'sk_…', username:'admin', scope:'admin', is_active:true, calls:0})`
or ask me. **Revoke**: set `is_active:false`. This key moves money — keep it on the device only,
behind the boot PIN, and revoke if the CYD is lost.

Extra lib for the control hub: **ArduinoJson** (Library Manager).

⚠️ Touch calibration: the `T_MINX..T_MAXY` constants in the sketch may need tuning per unit if
taps land off-target.

## Next ideas (ask and I'll build)
- On-screen **keypad** to type number + message (send screen), preset-message buttons.
- **Set price / threshold / create client / reset password / send-test** screens (API is ready).
- RGB LED turns red when any client is below low-balance; LDR dims the screen at night.
