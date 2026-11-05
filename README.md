# Vitalis

Doctor dashboard with a local SQLite store, a sensor ingestion API and a live stream to the UI.
Zero dependencies. Needs Node 22.5 or newer.

```bash
npm start            # dashboard + API on http://localhost:3000
npm run sensors      # in a second terminal: simulated hardware posting readings
npm run reset        # wipe data/clinic.db (re-seeds on next start)
HOST=0.0.0.0 DEVICE_KEY=change-me npm start    # let hardware on your LAN connect
node simulator.js --deteriorate 3              # demo: patient 3 slowly gets worse and alerts fire
```

## How data flows

```
 sensor / wearable / BP cuff / glucometer
        │  HTTP POST /api/readings   (x-api-key, JSON; single reading or a batch array)
        ▼
 server.js ── validates ranges ──► SQLite (readings table)
        │
        └─ Server-Sent Events /api/stream ──► dashboard updates instantly
```

The dashboard has no patient data in its source. Everything comes from `data/clinic.db`.
`simulator.js` is a stand-in for hardware: it speaks the same API a real device would, so
replacing it with real sensors needs no change on the dashboard side.

## Device API

`POST /api/readings`, header `x-api-key: <DEVICE_KEY>`. Send any subset of:

| field | unit | accepted range |
|---|---|---|
| `hr` | bpm | 20–250 |
| `spo2` | % | 50–100 |
| `sys`, `dia` | mmHg | 50–260, 30–160 |
| `temp` | °C | 30–43 |
| `rr` | breaths/min | 4–60 |
| `glu` | mg/dL (random sample) | 20–600 |
| `steps`, `battery` | count, % | optional |
| `ts` | unix ms or seconds | optional, defaults to now |

```bash
curl -X POST http://localhost:3000/api/readings \
  -H "x-api-key: dev-device-key" -H "content-type: application/json" \
  -d '{"device_id":"VT-W1","hr":78,"spo2":97,"battery":86}'
```

- Values outside the range are dropped as sensor glitches and reported back in `rejected`; the rest of the reading is kept.
- Send an array to upload readings buffered while a device was offline.
- A device must be paired to a patient first: Devices screen in the dashboard, or `POST /api/devices {id, kind, patient_id}` (local only).

Other endpoints: `GET /api/patients` (latest values + 24h hourly history), `POST /api/patients`
(create a patient), `GET /api/devices`, `GET /api/prescriptions`, `POST|PUT /api/prescriptions[/:id]`,
`GET /api/stream` (SSE), `GET /api/health`.

## Wearable mockup and new patients

- **Wearable** view (watch icon in the sidebar): a smartwatch mockup draws a synthetic PPG trace,
  extracts heart rate, SpO₂, respiratory rate and skin temperature, and POSTs them to
  `/api/readings` every 2.5 s as the selected patient's paired wrist wearable. Use
  *Start extraction* / *Stop extraction* to toggle it.
- **Chancy device** panel on the same view renders the 320×240 firmware screen (mascot plus today's
  medicines) from the selected patient's prescriptions.
- **+ New** in the Patients panel, or *Create Ritu & flash device*, calls `POST /api/patients` with
  the patient, a wrist wearable, baseline vitals and an optional `rx` array. The server pairs the
  device, seeds 24 h of history, stores the prescriptions and emits a `patient` SSE event; the
  dashboard switches to the Wearable view and flashes the new name on the Chancy screen.
- Ritu's schedule mirrors the Chancy preview: Metformin 500 mg at 8:00 AM, Amlodipine 5 mg at
  9:00 AM, Vitamin D3 1000 IU at 3:00 PM, Paracetamol 500 mg at 6:00 PM and Atorvastatin 10 mg at
  9:00 PM. It lives in the `RITU_RX` list in `public/index.html`.

## ESP32 example (MAX30102 pulse oximeter)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
// ...init MAX30102, read hr and spo2 into `hr` and `spo2`...
void sendReading(float hr, float spo2) {
  HTTPClient http;
  http.begin("http://192.168.1.20:3000/api/readings");   // the machine running npm start
  http.addHeader("content-type", "application/json");
  http.addHeader("x-api-key", "change-me");
  String body = String("{\"device_id\":\"ESP-0042\",\"hr\":") + hr + ",\"spo2\":" + spo2 + "}";
  http.POST(body);
  http.end();
}
```

For BLE devices, run a small gateway (phone or Raspberry Pi) that reads the BLE characteristics and forwards them to the same endpoint.

## Schema

`patients`, `devices` (each paired to one patient), `readings` (one row per report, nullable metric columns, indexed by patient and time), `prescriptions`.

## Roadmap for real deployment

- Per-device keys with rotation, TLS, and doctor login with roles. Today there is one shared key and no user auth.
- MQTT broker in front of the API for low-power devices; keep HTTP as a fallback.
- Server-side alert rules (thresholds per patient, trend-based, flatline/sensor-off detection) with SMS or push notifications instead of client-side thresholds.
- Calibration and artifact filtering per device type; track device firmware version.
- Move to Postgres/TimescaleDB for many patients; keep downsampled history.
- Export to HL7 FHIR (Observation, MedicationRequest) for hospital systems; audit log of prescriptions.
- This is a prototype, not a certified medical device. Clinical use needs regulatory review, validated sensors and security hardening.
