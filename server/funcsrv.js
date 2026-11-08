// PLDN-FAYL: funcsrv.js | versiya: funcs-1.0 | satr: 350 | 8-noy-2026
// PLDN×RSLT — foydalanuvchi funksiyalari xizmati (port 3011, pm2 nomi: funcs)
// Foydalanuvchi kodi serverda HECH QACHON bajarilmaydi: faqat saqlanadi, tahlil qilinadi va telefonga beriladi.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const admin = require('firebase-admin');

const PORT = Number(process.env.FUNCS_PORT || 3011);
const DATA = path.join(__dirname, 'data');
const MAX_CODE = 20 * 1024 * 1024;          // kod uchun amaliy chegara: 20 MB
const MAX_DESC = 20000;
const ABC = 'abcdefghijkl';                 // 12 shakl: a=○ b=□ c=△ d=◇ e=☆ f=♡ g=⬡ h=⬭ i=⏢ j=✦ k=⬟ l=⬖

fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const fsdb = admin.firestore();

const db = new Database(path.join(DATA, 'funcs.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS teams(team_lc TEXT PRIMARY KEY, team TEXT NOT NULL, owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS funcs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_lc TEXT NOT NULL, team TEXT NOT NULL, name TEXT NOT NULL, name_lc TEXT NOT NULL,
  owner TEXT NOT NULL, author TEXT, icon TEXT DEFAULT '🧩',
  vis TEXT DEFAULT 'private', place TEXT DEFAULT 'funcs',
  code30 TEXT UNIQUE, removed INTEGER DEFAULT 0, created INTEGER, updated INTEGER,
  UNIQUE(team_lc, name_lc));
CREATE TABLE IF NOT EXISTS versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fid INTEGER NOT NULL REFERENCES funcs(id) ON DELETE CASCADE,
  ver TEXT NOT NULL, descr TEXT, code TEXT NOT NULL, sha TEXT, size INTEGER, lines INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', reason TEXT, scan TEXT, test TEXT,
  submitted INTEGER, decided INTEGER, decided_by TEXT,
  UNIQUE(fid, ver));
CREATE TABLE IF NOT EXISTS installs(uid TEXT NOT NULL, fid INTEGER NOT NULL, ver TEXT, at INTEGER, PRIMARY KEY(uid, fid));
CREATE TABLE IF NOT EXISTS submits(uid TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ver_status ON versions(status);
`);

// ---------------------------------------------------------------- yordamchilar
const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const RE_TEAM = /^[A-Za-z0-9_-]{5,21}$/;
const RE_VER = /^[A-Za-z0-9]{1,12}$/;
const RE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ]{1,39}$/u;
const bad = (res, code, error, extra) => res.status(code).json(Object.assign({ error }, extra || {}));

function genCode() { let s = ''; const b = crypto.randomBytes(30); for (let i = 0; i < 30; i++) s += ABC[b[i] % 12]; return s; }
async function uniqueCode() {
  for (let i = 0; i < 30; i++) {
    const c = genCode();
    if (db.prepare('SELECT 1 FROM funcs WHERE code30=?').get(c)) continue;
    try { if ((await fsdb.doc('codeFns/' + c).get()).exists) continue; } catch (_) {}
    return c;
  }
  throw new Error('code_gen_failed');
}

// ---------------------------------------------------------------- avtomatik tekshiruv (skaner)
// MUHIM: bu faqat birinchi filtr. Asosiy himoya — telefondagi sandbox (iframe sandbox + CSP) va admin ko'rigi.
function scan(code) {
  const findings = []; const perms = new Set();
  const lineOf = (i) => { let n = 1; for (let k = 0; k < i; k++) if (code.charCodeAt(k) === 10) n++; return n; };
  const rules = [
    ['eval', true, /(?<![\w$])eval\s*\(/g, 'eval() taqiqlangan'],
    ['newfunc', true, /new\s+Function\s*\(|(?<![\w$.])Function\s*\(/g, 'Function() orqali kod yaratish taqiqlangan'],
    ['import', true, /(?<![\w$.])import\s*\(|importScripts\s*\(/g, 'Tashqaridan kod yuklash taqiqlangan'],
    ['parent', true, /(?:window|self|globalThis)\s*\.\s*(?:parent|top)\b|(?<![\w$.])(?:parent|top)\s*\.\s*(?:postMessage|document|window|location|frames|eval|localStorage)\b|frameElement/g, 'Asosiy ilovaga (parent/top) murojaat taqiqlangan'],
    ['net', true, /(?<![\w$.])fetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource\s*\(|sendBeacon/g, 'Tarmoqqa chiqish taqiqlangan'],
    ['embed', true, /<\s*(?:iframe|object|embed|frame)\b/gi, 'iframe/object/embed taqiqlangan'],
    ['extres', true, /<script[^>]*\ssrc\s*=|<link[^>]*\shref\s*=\s*["']?(?:https?:)?\/\/|@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//gi, 'Tashqi skript/uslub yuklash taqiqlangan'],
    ['dynscript', false, /createElement\(\s*["']script["']\s*\)/g, 'Dinamik <script> yaratilmoqda'],
    ['docwrite', false, /document\s*\.\s*write\s*\(/g, 'document.write ishlatilgan'],
    ['nav', false, /window\s*\.\s*open\s*\(|(?<![\w$.])location\s*(?:\.|=)/g, 'Sahifani almashtirishga urinish (sandbox bloklaydi)'],
    ['obf', false, /(?<![\w$.])atob\s*\(|fromCharCode/g, 'Shifrlangan/yashirilgan matn bo\'lishi mumkin'],
    ['extimg', false, /url\(\s*["']?https?:|<img[^>]*\ssrc\s*=\s*["']https?:/gi, 'Tashqi rasm/resurs (CSP bloklaydi)'],
    ['fastint', false, /setInterval\([^;]{0,200},\s*(?:[0-9]|[1-9][0-9])\s*\)/g, 'Juda tez takrorlanuvchi taymer (<100ms)']
  ];
  for (const [id, hard, re, msg] of rules) {
    let m, n = 0; re.lastIndex = 0;
    while ((m = re.exec(code)) && n < 5) { findings.push({ id, hard, line: lineOf(m.index), msg }); n++; if (m[0].length === 0) re.lastIndex++; }
  }
  // cheksiz sikllar
  const loop = /while\s*\(\s*(?:true|1|!0|!!1)\s*\)|for\s*\(\s*;\s*;\s*\)/g; let lm, ln = 0;
  while ((lm = loop.exec(code)) && ln < 5) {
    const tail = code.slice(lm.index, lm.index + 800);
    const exits = /\b(?:break|return|throw)\b|await\b/.test(tail);
    findings.push({ id: 'loop', hard: !exits, line: lineOf(lm.index), msg: exits ? 'Cheksiz sikl (chiqish bor, tekshiring)' : 'Cheksiz sikl: chiqish (break/return) topilmadi' });
    ln++;
  }
  if (/getUserMedia|mediaDevices/.test(code)) perms.add('camera_mic');
  if (/geolocation/.test(code)) perms.add('location');
  if (/\bNotification\b/.test(code)) perms.add('notifications');
  if (/navigator\s*\.\s*clipboard/.test(code)) perms.add('clipboard');
  if (/localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie/.test(code)) perms.add('storage');
  return { block: findings.some(f => f.hard), findings: findings.slice(0, 40), perms: [...perms] };
}

// ---------------------------------------------------------------- ilova
const app = express();
if (process.env.CORS !== '0') {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}
app.use(express.json({ limit: '30mb' }));
const r = express.Router();
app.use(['/funcs', '/'], r);

const adminCache = new Map();
async function isAdmin(uid) {
  const c = adminCache.get(uid);
  if (c && c.t > now()) return c.v;
  let v = false;
  try { v = (await fsdb.doc('botAdmins/' + uid).get()).exists; } catch (_) {}
  adminCache.set(uid, { v, t: now() + 60000 });
  return v;
}
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return bad(res, 401, 'auth');
    const d = await admin.auth().verifyIdToken(h.slice(7));
    req.uid = d.uid; req.tok = d;
    next();
  } catch (_) { bad(res, 401, 'auth'); }
}
const adminOnly = async (req, res, next) => { (await isAdmin(req.uid)) ? next() : bad(res, 403, 'forbidden'); };
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('ERR', req.path, e && e.message); if (!res.headersSent) bad(res, 500, 'server'); });

async function authorInfo(uid, tok) {
  try {
    const d = (await fsdb.doc('users/' + uid).get()).data() || {};
    const un = typeof d.username === 'string' ? d.username : '';
    return { username: un, name: String(d.firstName || d.name || tok.name || un || 'PLDN').slice(0, 60) };
  } catch (_) { return { username: '', name: String(tok.name || 'PLDN').slice(0, 60) }; }
}
const latestApproved = (fid) => db.prepare("SELECT * FROM versions WHERE fid=? AND status='approved' ORDER BY decided DESC, id DESC LIMIT 1").get(fid);
const pub = (f, v) => ({ id: f.id, team: f.team, name: f.name, icon: f.icon, author: f.author, vis: f.vis, place: f.place, code30: f.code30, ver: v ? v.ver : null });

r.get('/me', auth, wrap(async (req, res) => res.json({ uid: req.uid, admin: await isAdmin(req.uid) })));

// --- yuborish (yangi funksiya yoki yangi versiya)
r.post('/submit', auth, wrap(async (req, res) => {
  const b = req.body || {}; const uid = req.uid;
  const ver = String(b.ver || ''); const descr = String(b.desc || ''); const code = typeof b.code === 'string' ? b.code : '';
  if (!RE_VER.test(ver)) return bad(res, 400, 'bad_ver');
  if (descr.trim().length < 1 || descr.length > MAX_DESC) return bad(res, 400, 'bad_desc');
  if (!code.trim()) return bad(res, 400, 'no_code');
  const size = Buffer.byteLength(code, 'utf8');
  if (size > MAX_CODE) return bad(res, 413, 'too_large');
  if (db.prepare('SELECT COUNT(*) c FROM submits WHERE uid=? AND at>?').get(uid, now() - 86400000).c >= 40) return bad(res, 429, 'rate_limit');
  if (db.prepare("SELECT COUNT(*) c FROM versions v JOIN funcs f ON f.id=v.fid WHERE f.owner=? AND v.status='pending'").get(uid).c >= 25) return bad(res, 429, 'too_many_pending');
  const sc = scan(code);
  if (sc.block) return bad(res, 422, 'scan_block', { findings: sc.findings.filter(f => f.hard).slice(0, 10) });
  const sha = sha256(code);
  const t = b.test || {};
  if (!(t.ok === true && t.hash === sha && Number(t.ms) >= 2000)) return bad(res, 422, 'test_required');
  const test = { ok: true, ms: Math.round(Number(t.ms)), errors: Number(t.errors) || 0, at: now() };
  const icon = (String(b.icon || '').trim() || '🧩').slice(0, 8);
  const vis = b.vis === 'public' ? 'public' : 'private';
  const place = b.place === 'settings' ? 'settings' : 'funcs';
  const lines = code.split('\n').length;
  const au = await authorInfo(uid, req.tok);
  const author = au.username ? 'PLDN/-' + au.username : au.name;

  let f;
  if (b.fid) {
    f = db.prepare('SELECT * FROM funcs WHERE id=?').get(Number(b.fid));
    if (!f || f.owner !== uid || f.removed) return bad(res, 404, 'not_found');
  } else {
    const team = String(b.team || ''); const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    if (!RE_TEAM.test(team)) return bad(res, 400, 'bad_team');
    if (!RE_NAME.test(name)) return bad(res, 400, 'bad_name');
    const tm = db.prepare('SELECT * FROM teams WHERE team_lc=?').get(team.toLowerCase());
    if (tm && tm.owner !== uid) return bad(res, 409, 'team_taken');
    if (db.prepare('SELECT 1 FROM funcs WHERE team_lc=? AND name_lc=? AND removed=0').get(team.toLowerCase(), name.toLowerCase())) return bad(res, 409, 'name_taken');
  }
  const tx = db.transaction(() => {
    if (!f) {
      db.prepare('INSERT OR IGNORE INTO teams(team_lc,team,owner) VALUES(?,?,?)').run(String(b.team).toLowerCase(), String(b.team), uid);
      const name = String(b.name).replace(/\s+/g, ' ').trim();
      const info = db.prepare('INSERT INTO funcs(team_lc,team,name,name_lc,owner,author,icon,vis,place,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(String(b.team).toLowerCase(), String(b.team), name, name.toLowerCase(), uid, author, icon, vis, place, now(), now());
      f = db.prepare('SELECT * FROM funcs WHERE id=?').get(info.lastInsertRowid);
    } else {
      db.prepare('UPDATE funcs SET icon=?, vis=?, place=?, author=?, updated=? WHERE id=?').run(icon, vis, place, author, now(), f.id);
    }
    const ex = db.prepare('SELECT * FROM versions WHERE fid=? AND ver=?').get(f.id, ver);
    if (ex && !['returned', 'rejected'].includes(ex.status)) throw Object.assign(new Error('ver_exists'), { code: ex.status === 'pending' ? 'ver_pending' : 'ver_exists' });
    if (ex) db.prepare('DELETE FROM versions WHERE id=?').run(ex.id);
    db.prepare('INSERT INTO versions(fid,ver,descr,code,sha,size,lines,status,scan,test,submitted) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(f.id, ver, descr, code, sha, size, lines, 'pending', JSON.stringify(sc), JSON.stringify(test), now());
    db.prepare('INSERT INTO submits(uid,at) VALUES(?,?)').run(uid, now());
  });
  try { tx(); } catch (e) { if (e.code) return bad(res, 409, e.code); throw e; }
  res.json({ ok: true, id: f.id, ver, status: 'pending', warn: sc.findings.filter(x => !x.hard).length });
}));

// --- mening funksiyalarim (yaratgan)
r.get('/mine', auth, wrap((req, res) => {
  const fs_ = db.prepare('SELECT * FROM funcs WHERE owner=? AND removed=0 ORDER BY updated DESC').all(req.uid);
  const out = fs_.map(f => ({
    ...pub(f, null),
    versions: db.prepare('SELECT ver,status,reason,submitted,decided,size,lines,test FROM versions WHERE fid=? ORDER BY id DESC').all(f.id)
      .map(v => ({ ver: v.ver, status: v.status, reason: v.reason, submitted: v.submitted, decided: v.decided, size: v.size, lines: v.lines }))
  }));
  res.json({ funcs: out });
}));
r.post('/withdraw', auth, wrap((req, res) => {
  const f = db.prepare('SELECT * FROM funcs WHERE id=?').get(Number((req.body || {}).fid));
  if (!f || f.owner !== req.uid) return bad(res, 404, 'not_found');
  const v = db.prepare('SELECT * FROM versions WHERE fid=? AND ver=?').get(f.id, String((req.body || {}).ver));
  if (!v || !['pending', 'returned', 'rejected'].includes(v.status)) return bad(res, 400, 'cannot');
  db.prepare('DELETE FROM versions WHERE id=?').run(v.id);
  if (!db.prepare('SELECT 1 FROM versions WHERE fid=?').get(f.id)) db.prepare('DELETE FROM funcs WHERE id=?').run(f.id);
  res.json({ ok: true });
}));
r.post('/remove', auth, wrap((req, res) => {
  const f = db.prepare('SELECT * FROM funcs WHERE id=?').get(Number((req.body || {}).fid));
  if (!f || f.owner !== req.uid) return bad(res, 404, 'not_found');
  db.prepare('UPDATE funcs SET removed=1, updated=? WHERE id=?').run(now(), f.id);
  res.json({ ok: true });
}));

// --- kutubxona
r.get('/lib', auth, wrap((req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const rows = db.prepare("SELECT * FROM funcs WHERE removed=0 AND vis='public' AND code30 IS NOT NULL ORDER BY updated DESC LIMIT 300").all();
  const out = [];
  for (const f of rows) {
    if (q && !(f.name_lc.includes(q) || f.team_lc.includes(q))) continue;
    const v = latestApproved(f.id); if (!v) continue;
    out.push({ ...pub(f, v), desc: String(v.descr || '').slice(0, 240) });
    if (out.length >= 100) break;
  }
  res.json({ funcs: out });
}));
async function canSee(f, uid) { return f && !f.removed && (f.owner === uid || (await isAdmin(uid)) || f.vis === 'public'); }
r.get('/fn/:id', auth, wrap(async (req, res) => {
  const f = db.prepare('SELECT * FROM funcs WHERE id=?').get(Number(req.params.id));
  if (!(await canSee(f, req.uid))) return bad(res, 404, 'not_found');
  const priv = f.owner === req.uid || (await isAdmin(req.uid));
  const v = latestApproved(f.id);
  if (!v && !priv) return bad(res, 404, 'not_found');
  const vers = db.prepare(priv ? 'SELECT ver,status,decided,descr FROM versions WHERE fid=? ORDER BY id DESC' : "SELECT ver,status,decided,descr FROM versions WHERE fid=? AND status='approved' ORDER BY id DESC").all(f.id);
  const sc = v ? JSON.parse(v.scan || '{}') : {};
  res.json({ ...pub(f, v), desc: v ? v.descr : '', perms: sc.perms || [], size: v ? v.size : 0, versions: vers.map(x => ({ ver: x.ver, status: x.status, decided: x.decided, desc: priv ? String(x.descr || '') : String(x.descr || '').slice(0, 2000) })), mine: f.owner === req.uid });
}));
r.get('/fn/:id/code', auth, wrap(async (req, res) => {
  const f = db.prepare('SELECT * FROM funcs WHERE id=?').get(Number(req.params.id));
  if (!(await canSee(f, req.uid))) return bad(res, 404, 'not_found');
  const priv = f.owner === req.uid || (await isAdmin(req.uid));
  let v;
  if (req.query.ver) { v = db.prepare('SELECT * FROM versions WHERE fid=? AND ver=?').get(f.id, String(req.query.ver)); if (v && v.status !== 'approved' && !priv) v = null; }
  else v = latestApproved(f.id);
  if (!v) return bad(res, 404, 'not_found');
  res.json({ ver: v.ver, sha: v.sha, code: v.code });
}));
r.get('/bycode/:code', auth, wrap(async (req, res) => {
  const c = String(req.params.code || '');
  if (!/^[a-l]{30}$/.test(c)) return bad(res, 404, 'not_found');
  const f = db.prepare('SELECT * FROM funcs WHERE code30=?').get(c);
  if (!f || f.removed || !(f.vis === 'public' || f.owner === req.uid)) return bad(res, 404, 'not_found');
  const v = latestApproved(f.id); if (!v) return bad(res, 404, 'not_found');
  res.json(pub(f, v));
}));

// --- o'rnatish / yangilash / o'chirish
r.post('/install', auth, wrap(async (req, res) => {
  const f = db.prepare('SELECT * FROM funcs WHERE id=?').get(Number((req.body || {}).id));
  if (!f || f.removed || !(f.vis === 'public' || f.owner === req.uid)) return bad(res, 404, 'not_found');
  const v = latestApproved(f.id); if (!v) return bad(res, 404, 'not_found');
  db.prepare('INSERT INTO installs(uid,fid,ver,at) VALUES(?,?,?,?) ON CONFLICT(uid,fid) DO UPDATE SET ver=excluded.ver, at=excluded.at').run(req.uid, f.id, v.ver, now());
  res.json({ ...pub(f, v), sha: v.sha });
}));
r.post('/uninstall', auth, wrap((req, res) => {
  db.prepare('DELETE FROM installs WHERE uid=? AND fid=?').run(req.uid, Number((req.body || {}).id));
  res.json({ ok: true });
}));
r.get('/installed', auth, wrap((req, res) => {
  const rows = db.prepare('SELECT i.fid, i.ver iver, f.* FROM installs i JOIN funcs f ON f.id=i.fid WHERE i.uid=?').all(req.uid);
  const out = rows.map(f => {
    const gone = !!f.removed || !(f.vis === 'public' || f.owner === req.uid);
    const v = gone ? null : latestApproved(f.id);
    return { ...pub(f, null), ver: f.iver, latest: v ? v.ver : null, update: !!(v && v.ver !== f.iver), changes: v && v.ver !== f.iver ? v.descr : '', gone };
  });
  res.json({ funcs: out });
}));

// --- administrator
r.get('/admin/pending', auth, adminOnly, wrap((req, res) => {
  const rows = db.prepare("SELECT v.id vid, v.ver, v.descr, v.size, v.lines, v.scan, v.test, v.submitted, f.* FROM versions v JOIN funcs f ON f.id=v.fid WHERE v.status='pending' AND f.removed=0 ORDER BY v.submitted ASC LIMIT 200").all();
  res.json({ items: rows.map(x => ({ ...pub(x, { ver: x.ver }), desc: x.descr, size: x.size, lines: x.lines, scan: JSON.parse(x.scan || '{}'), test: JSON.parse(x.test || '{}'), submitted: x.submitted, owner: x.owner })) });
}));
r.get('/admin/code', auth, adminOnly, wrap((req, res) => {
  const v = db.prepare('SELECT code FROM versions WHERE fid=? AND ver=?').get(Number(req.query.fid), String(req.query.ver || ''));
  if (!v) return bad(res, 404, 'not_found');
  const from = Math.max(0, Number(req.query.from) || 0); const len = 60000;
  res.json({ code: v.code.slice(from, from + len), total: v.code.length, from });
}));
r.post('/admin/decide', auth, adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const f = db.prepare('SELECT * FROM funcs WHERE id=?').get(Number(b.fid));
  const v = f && db.prepare('SELECT * FROM versions WHERE fid=? AND ver=?').get(f.id, String(b.ver || ''));
  if (!v || v.status !== 'pending') return bad(res, 404, 'not_found');
  const reason = String(b.reason || '').trim().slice(0, 500);
  if (b.decision === 'approve') {
    let code30 = f.code30; if (!code30) code30 = await uniqueCode();
    const vis = b.vis === 'private' ? 'private' : (b.vis === 'public' ? 'public' : f.vis);
    db.transaction(() => {
      db.prepare("UPDATE versions SET status='approved', reason=NULL, decided=?, decided_by=? WHERE id=?").run(now(), req.uid, v.id);
      db.prepare('UPDATE funcs SET code30=?, vis=?, updated=? WHERE id=?').run(code30, vis, now(), f.id);
    })();
    return res.json({ ok: true, code30 });
  }
  if (b.decision === 'reject' || b.decision === 'return') {
    if (reason.length < 3) return bad(res, 400, 'reason');
    db.prepare('UPDATE versions SET status=?, reason=?, decided=?, decided_by=? WHERE id=?').run(b.decision === 'reject' ? 'rejected' : 'returned', reason, now(), req.uid, v.id);
    return res.json({ ok: true });
  }
  bad(res, 400, 'bad_decision');
}));

app.use((err, req, res, next) => { if (err && err.type === 'entity.too.large') return bad(res, 413, 'too_large'); console.error('ERR', err && err.message); bad(res, 400, 'bad_request'); });

// ---------------------------------------------------------------- kunlik zaxira (7 ta saqlanadi)
async function backup() {
  try {
    const d = new Date().toISOString().slice(0, 10);
    const f = path.join(DATA, 'backups', 'funcs-' + d + '.db');
    if (!fs.existsSync(f)) await db.backup(f);
    const all = fs.readdirSync(path.join(DATA, 'backups')).filter(x => x.startsWith('funcs-')).sort();
    while (all.length > 7) fs.unlinkSync(path.join(DATA, 'backups', all.shift()));
  } catch (e) { console.error('backup', e.message); }
}
setTimeout(backup, 60000); setInterval(backup, 6 * 3600 * 1000);
setInterval(() => db.prepare('DELETE FROM submits WHERE at<?').run(now() - 2 * 86400000), 3600 * 1000);

app.listen(PORT, '127.0.0.1', () => console.log('funcs ishlayapti: ' + PORT));
