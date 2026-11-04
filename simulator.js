// Stand-in for real hardware. It talks to the server exactly the way an ESP32 / BLE gateway would:
// one HTTP POST per reading, identified only by device_id. Replace this process with real sensors.
//   node simulator.js [--url http://localhost:3000] [--key dev-device-key] [--deteriorate <patientId>]
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:3000'), KEY = arg('--key', process.env.DEVICE_KEY || 'dev-device-key');
const BAD = arg('--deteriorate', null);
const rnd = (a, b) => a + Math.random() * (b - a);
const SPREAD = { hr: 2.2, spo2: .35, sys: 2, dia: 1.3, temp: .04, rr: .5, glu: 2.5 };
// which metrics each kind of device can measure, and how often it reports
const KINDS = {
  'Wrist wearable': { metrics: ['hr', 'spo2', 'rr', 'temp'], every: 2000, steps: true },
  'BP cuff': { metrics: ['sys', 'dia'], every: 8000 },
  'Glucometer': { metrics: ['glu'], every: 15000 },
};
const patients = await (await fetch(URL_ + '/api/patients')).json().catch(() => { console.error('Server not reachable at ' + URL_); process.exit(1); });
const devices = await (await fetch(URL_ + '/api/devices')).json();
const st = Object.fromEntries(patients.map(p => [p.id, { base: { ...p.cur }, cur: { ...p.cur }, steps: p.steps, t0: Date.now() }]));
const start = Date.now();

for (const d of devices) {
  const k = KINDS[d.kind]; if (!k) continue;
  let battery = d.battery ?? 80;
  setInterval(async () => {
    const s = st[d.patient_id]; if (!s) return;
    if (BAD && +BAD === d.patient_id) {                              // demo: patient slowly deteriorates after ~10s
      const f = Math.min(1, Math.max(0, (Date.now() - start - 10000) / 40000));
      s.base.spo2 = s.base.spo2 + (88 - s.base.spo2) * f * .05; s.base.hr += (130 - s.base.hr) * f * .05; s.base.rr += (28 - s.base.rr) * f * .05;
    }
    const body = { device_id: d.id, ts: Date.now() };
    for (const m of k.metrics) {
      s.cur[m] += (s.base[m] - s.cur[m]) * .15 + rnd(-SPREAD[m], SPREAD[m]);
      if (m === 'spo2') s.cur[m] = Math.min(100, s.cur[m]);
      body[m] = +s.cur[m].toFixed(m === 'temp' ? 1 : 0);
    }
    if (k.steps) { s.steps += rnd(0, 6); body.steps = Math.round(s.steps); }
    battery = Math.max(5, battery - rnd(0, .02)); body.battery = Math.round(battery);
    try {
      const r = await fetch(URL_ + '/api/readings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body) });
      if (!r.ok) console.error(d.id, r.status, await r.text());
    } catch (e) { console.error(d.id, 'send failed:', e.message); }
  }, k.every + Math.random() * 400);
}
console.log(`Simulating ${devices.length} devices for ${patients.length} patients → ${URL_}${BAD ? ` (patient ${BAD} will deteriorate)` : ''}`);
