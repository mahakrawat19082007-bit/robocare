// Vitalis server: SQLite store + sensor ingestion API + live stream + static dashboard.
// Zero dependencies (Node >= 22.5, uses the built-in node:sqlite).
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';          // set HOST=0.0.0.0 so hardware on your LAN can reach it
const KEY = process.env.DEVICE_KEY || 'dev-device-key'; // shared secret sent by devices in x-api-key

fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || path.join(dir, 'data', 'clinic.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS patients(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, sex TEXT, cond TEXT, blood TEXT,
  wt REAL, ht REAL, adh INTEGER, allergies TEXT DEFAULT '[]', sleep TEXT DEFAULT '[]', steps REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), kind TEXT NOT NULL,
  battery INTEGER, last_seen INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS readings(
  id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL, device_id TEXT NOT NULL, ts INTEGER NOT NULL,
  hr REAL, spo2 REAL, sys REAL, dia REAL, temp REAL, rr REAL, glu REAL);
CREATE INDEX IF NOT EXISTS readings_pt ON readings(patient_id, ts);
CREATE TABLE IF NOT EXISTS prescriptions(
  id TEXT PRIMARY KEY, patient_id INTEGER NOT NULL, name TEXT, dose TEXT, unit TEXT, form TEXT,
  slots TEXT, meal TEXT, days INTEGER, start TEXT, notes TEXT, status TEXT, updated_at INTEGER);
`);

const METRICS = ['hr', 'spo2', 'sys', 'dia', 'temp', 'rr', 'glu'];
// physically plausible bounds; anything outside is a sensor glitch and is dropped, not stored
const RANGE = { hr: [20, 250], spo2: [50, 100], sys: [50, 260], dia: [30, 160], temp: [30, 43], rr: [4, 60], glu: [20, 600] };
const rnd = (a, b) => a + Math.random() * (b - a);

/* ---------------- seed (first run only) ---------------- */
function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM patients').get().n) return;
  const P = [
    ['Rajesh Sharma', 54, 'M', 'Hypertension', 'B+', 82, 174, 88, ['Penicillin'], { hr: 78, spo2: 97, sys: 144, dia: 93, temp: 36.8, rr: 16, glu: 112 }, [6.2, 7, 5.8, 6.5, 7.2, 6.1, 6.4], 4820],
    ['Priya Nair', 34, 'F', 'Annual checkup', 'O+', 61, 168, 96, [], { hr: 70, spo2: 98, sys: 116, dia: 74, temp: 36.6, rr: 14, glu: 92 }, [7.5, 8, 7.2, 8.1, 7.8, 8.4, 7.9], 9140],
    ['Vikram Singh', 68, 'M', 'Heart failure', 'A−', 76, 170, 81, ['Aspirin'], { hr: 114, spo2: 90, sys: 102, dia: 64, temp: 37.2, rr: 24, glu: 128 }, [4.8, 5.2, 4.4, 5.5, 4.9, 5.1, 5], 1260],
    ['Anita Desai', 61, 'F', 'COPD', 'AB+', 58, 158, 90, ['Sulfa drugs'], { hr: 92, spo2: 93, sys: 128, dia: 80, temp: 36.9, rr: 21, glu: 105 }, [6, 6.4, 5.9, 6.8, 6.2, 6.6, 6.3], 2980],
    ['Arjun Reddy', 47, 'M', 'Type 2 diabetes', 'O+', 96, 180, 85, ['Penicillin'], { hr: 84, spo2: 96, sys: 132, dia: 84, temp: 36.8, rr: 17, glu: 176 }, [6.8, 7.1, 6.2, 7.4, 6.6, 6.9, 7], 5410],
  ];
  const AMP = { hr: 7, spo2: 1, sys: 7, dia: 4, temp: .25, rr: 1.5, glu: 14 };
  const insP = db.prepare('INSERT INTO patients(name,age,sex,cond,blood,wt,ht,adh,allergies,sleep,steps) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const insD = db.prepare('INSERT INTO devices(id,patient_id,kind,battery,last_seen) VALUES(?,?,?,?,0)');
  const insR = db.prepare('INSERT INTO readings(patient_id,device_id,ts,hr,spo2,sys,dia,temp,rr,glu) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const now = Date.now();
  db.exec('BEGIN');
  P.forEach(([name, age, sex, cond, blood, wt, ht, adh, al, base, sleep, steps], i) => {
    const { lastInsertRowid: id } = insP.run(name, age, sex, cond, blood, wt, ht, adh, JSON.stringify(al), JSON.stringify(sleep), steps);
    insD.run(`VT-W${id}`, id, 'Wrist wearable', Math.round(rnd(55, 95)));
    insD.run(`VT-C${id}`, id, 'BP cuff', Math.round(rnd(60, 100)));
    insD.run(`VT-G${id}`, id, 'Glucometer', Math.round(rnd(60, 100)));
    for (let t = now - 864e5; t < now; t += 5 * 60e3) {            // 24h of history, one row / 5 min
      const ph = (t / 864e5) * Math.PI * 2 + i, v = {};
      for (const m of METRICS) v[m] = +(base[m] + Math.sin(ph + METRICS.indexOf(m)) * AMP[m] * .6 + rnd(-AMP[m], AMP[m]) * .5).toFixed(m === 'temp' ? 1 : 0);
      v.spo2 = Math.min(100, v.spo2);
      insR.run(id, `VT-W${id}`, t, v.hr, v.spo2, v.sys, v.dia, v.temp, v.rr, v.glu);
    }
  });
  const insX = db.prepare('INSERT INTO prescriptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const start = new Date(now - 864e5 * 5).toISOString().slice(0, 10);
  [
    [1, 'Amlodipine', 5, 'mg', 'Tablet', ['08:00'], 'After food', 0, 'Monitor ankle swelling.'],
    [1, 'Losartan', 50, 'mg', 'Tablet', ['08:00', '20:00'], 'Any time', 0, ''],
    [2, 'Vitamin D3', 60000, 'IU', 'Capsule', ['09:00'], 'After food', 56, 'Once weekly.'],
    [3, 'Furosemide', 40, 'mg', 'Tablet', ['07:00', '14:00'], 'Before food', 0, 'Weigh daily; report gain > 1 kg.'],
    [3, 'Metoprolol', 25, 'mg', 'Tablet', ['08:00', '20:00'], 'After food', 0, ''],
    [4, 'Tiotropium', 18, 'mcg', 'Inhaler', ['08:00'], 'Any time', 0, '1 capsule inhaled.'],
    [4, 'Salbutamol', 2, 'puff(s)', 'Inhaler', [], 'Any time', 0, 'As needed for breathlessness.'],
    [5, 'Metformin', 500, 'mg', 'Tablet', ['08:00', '14:00', '21:00'], 'With food', 0, ''],
    [5, 'Atorvastatin', 20, 'mg', 'Tablet', ['21:00'], 'After food', 0, ''],
  ].forEach(([pid, n, dose, unit, form, slots, meal, days, notes], k) =>
    insX.run('seed' + k, pid, n, String(dose), unit, form, JSON.stringify(slots), meal, days, start, notes, 'active', now));
  db.exec('COMMIT');
  console.log('Seeded 5 patients, 15 devices, 24h of readings.');
}
seed();

/* ---------------- queries ---------------- */
const lastVal = Object.fromEntries(METRICS.map(m => [m, db.prepare(`SELECT ${m} v FROM readings WHERE patient_id=? AND ${m} IS NOT NULL ORDER BY ts DESC LIMIT 1`)]));
const bucketQ = Object.fromEntries(METRICS.map(m => [m, db.prepare(`SELECT CAST((ts-?)/3600000 AS INTEGER) b, AVG(${m}) v FROM readings WHERE patient_id=? AND ts>=? AND ${m} IS NOT NULL GROUP BY b`)]));
const lastTs = db.prepare('SELECT MAX(ts) t FROM readings WHERE patient_id=?');

function listPatients() {
  const start = Date.now() - 864e5;
  return db.prepare('SELECT * FROM patients ORDER BY id').all().map(p => {
    const cur = {}, hist = {};
    for (const m of METRICS) {
      cur[m] = lastVal[m].get(p.id)?.v ?? null;
      const a = Array(24).fill(null);
      for (const { b, v } of bucketQ[m].all(start, p.id, start)) if (b >= 0 && b < 24) a[b] = v;
      let prev = a.find(x => x != null) ?? cur[m];                  // forward-fill gaps so charts stay continuous
      hist[m] = a.map(x => (x != null ? (prev = x) : prev));
    }
    return { ...p, allergies: JSON.parse(p.allergies), sleep: JSON.parse(p.sleep), cur, hist, lastTs: lastTs.get(p.id).t || 0 };
  });
}
const listDevices = () => db.prepare('SELECT d.*, p.name patient_name FROM devices d JOIN patients p ON p.id=d.patient_id ORDER BY d.patient_id, d.id').all();
const rxRow = r => ({ id: r.id, pid: r.patient_id, name: r.name, dose: r.dose, unit: r.unit, form: r.form, slots: JSON.parse(r.slots || '[]'), meal: r.meal, days: r.days, start: r.start, notes: r.notes, status: r.status });
const listRx = () => db.prepare('SELECT * FROM prescriptions ORDER BY updated_at DESC').all().map(rxRow);
const upsertRx = db.prepare(`INSERT INTO prescriptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,dose=excluded.dose,unit=excluded.unit,form=excluded.form,slots=excluded.slots,meal=excluded.meal,days=excluded.days,start=excluded.start,notes=excluded.notes,status=excluded.status,updated_at=excluded.updated_at`);

/* ---------------- ingestion ---------------- */
const getDevice = db.prepare('SELECT * FROM devices WHERE id=?');
const insReading = db.prepare('INSERT INTO readings(patient_id,device_id,ts,hr,spo2,sys,dia,temp,rr,glu) VALUES(?,?,?,?,?,?,?,?,?,?)');
const touchDev = db.prepare('UPDATE devices SET last_seen=MAX(last_seen,?), battery=COALESCE(?,battery) WHERE id=?');
const setSteps = db.prepare('UPDATE patients SET steps=? WHERE id=?');
const clients = new Set();
const fail = (status, msg) => Object.assign(new Error(msg), { status });

function ingest(r) {
  if (!r || typeof r !== 'object') throw fail(400, 'reading must be a JSON object');
  const dev = getDevice.get(String(r.device_id ?? ''));
  if (!dev) throw fail(404, `unknown device_id "${r.device_id}" — pair it first (POST /api/devices)`);
  let ts = Number(r.ts); if (!Number.isFinite(ts) || ts <= 0) ts = Date.now();
  if (ts < 1e11) ts *= 1000;                                         // accept unix seconds as well as ms
  ts = Math.min(ts, Date.now() + 60e3);                              // devices with bad clocks can't write the future
  const values = {}, rejected = [];
  for (const m of METRICS) {
    if (r[m] == null) continue;
    const n = Number(r[m]);
    if (!Number.isFinite(n) || n < RANGE[m][0] || n > RANGE[m][1]) rejected.push(m); else values[m] = n;
  }
  const steps = r.steps != null && Number.isFinite(+r.steps) ? +r.steps : null;
  const battery = r.battery != null && Number.isFinite(+r.battery) ? Math.round(clampN(+r.battery, 0, 100)) : null;
  if (!Object.keys(values).length && steps == null) throw fail(422, 'no valid metrics in reading' + (rejected.length ? ` (out of range: ${rejected})` : ''));
  insReading.run(dev.patient_id, dev.id, ts, ...METRICS.map(m => values[m] ?? null));
  touchDev.run(ts, battery, dev.id);
  if (steps != null) setSteps.run(steps, dev.patient_id);
  const ev = { patient_id: dev.patient_id, device_id: dev.id, ts, values, steps, battery };
  for (const c of clients) c.write(`event: reading\ndata: ${JSON.stringify(ev)}\n\n`);
  return { rejected };
}
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------- http ---------------- */
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const hasKey = req => req.headers['x-api-key'] === KEY;
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((ok, no) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) { no(fail(413, 'body too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(fail(400, 'invalid JSON')); } });
});
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, time: Date.now() });
  if (m === 'GET' && p === '/api/patients') return send(res, 200, listPatients());
  if (m === 'GET' && p === '/api/devices') return send(res, 200, listDevices());
  if (m === 'GET' && p === '/api/prescriptions') return send(res, 200, listRx());
  if (m === 'GET' && p === '/api/config') {
    if (!isLocal(req) && !hasKey(req)) throw fail(403, 'local only');
    return send(res, 200, { key: KEY });
  }
  if (m === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (m === 'POST' && p === '/api/readings') {                       // <- what real hardware calls
    if (!hasKey(req)) throw fail(401, 'missing or wrong x-api-key');
    const body = await readBody(req), list = Array.isArray(body) ? body : [body];   // arrays = buffered/offline batch
    if (list.length > 500) throw fail(413, 'max 500 readings per request');
    let accepted = 0; const rejected = [];
    for (const r of list) { try { const x = ingest(r); accepted++; if (x.rejected.length) rejected.push(...x.rejected); } catch (e) { if (list.length === 1) throw e; rejected.push(e.message); } }
    return send(res, 201, { accepted, rejected });
  }
  if (m === 'POST' && p === '/api/devices') {                        // pair a device with a patient
    if (!isLocal(req) && !hasKey(req)) throw fail(403, 'local only');
    const b = await readBody(req);
    if (!b.id || !b.kind || !db.prepare('SELECT 1 FROM patients WHERE id=?').get(+b.patient_id)) throw fail(400, 'need id, kind and a valid patient_id');
    db.prepare('INSERT INTO devices(id,patient_id,kind,battery,last_seen) VALUES(?,?,?,NULL,0) ON CONFLICT(id) DO UPDATE SET patient_id=excluded.patient_id, kind=excluded.kind')
      .run(String(b.id).slice(0, 40), +b.patient_id, String(b.kind).slice(0, 40));
    return send(res, 201, { ok: true });
  }
  if ((m === 'POST' && p === '/api/prescriptions') || (m === 'PUT' && p.startsWith('/api/prescriptions/'))) {
    const b = await readBody(req), id = m === 'PUT' ? decodeURIComponent(p.split('/').pop()) : String(b.id || 'r' + Date.now());
    if (!b.name || !db.prepare('SELECT 1 FROM patients WHERE id=?').get(+b.pid)) throw fail(400, 'need name and a valid pid');
    upsertRx.run(id, +b.pid, String(b.name), String(b.dose ?? ''), String(b.unit ?? ''), String(b.form ?? ''), JSON.stringify(b.slots || []),
      String(b.meal ?? ''), +b.days || 0, String(b.start ?? ''), String(b.notes ?? ''), b.status === 'stopped' ? 'stopped' : 'active', Date.now());
    return send(res, 200, { ok: true, id });
  }
  throw fail(404, 'not found');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = path.normalize(path.join(dir, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(path.join(dir, 'public'))) throw fail(403, 'forbidden');
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) throw fail(404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    if (!e.status) console.error(e);
  }
}).listen(PORT, HOST, () => {
  console.log(`Vitalis running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Devices POST readings to /api/readings with header x-api-key: ${KEY}`);
  console.log('No sensors yet? Run:  npm run sensors');
});
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000);
