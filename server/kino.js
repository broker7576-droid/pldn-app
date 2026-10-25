// PLDN-FAYL: kino.js | versiya: kino-srv-1.0 | satr: 410 | 25-okt-2026
// Kinozona serveri (pm2: kino, 3002-port, Caddy: /kino*). Faqat saqlaydi va uzatadi — videoni qayta kodlamaydi.
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');

admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const adb = admin.firestore();

const PORT = 3002;
const DIR = path.join(__dirname, 'data', 'kino');
const MAX_BYTES = 12 * 1024 * 1024 * 1024;   // bitta kino uchun chegara
const MIN_FREE = 1024 * 1024 * 1024;         // diskda doim 1 GB zaxira
const CHUNK = 4 * 1024 * 1024;               // mijoz yuboradigan bo'lak
const MAX_BODY = 8 * 1024 * 1024;
const LOCK_STALE_MS = 90 * 1000;             // yuklovchi shuncha vaqt jim bo'lsa, boshqasi yuklay oladi
const PART_TTL_MS = 10 * 60 * 1000;          // tugallanmagan fayl shuncha turadi
const TICKET_MS = 12 * 3600 * 1000;
const ROOM_RE = /^[A-Za-z0-9]{10,40}$/;

fs.mkdirSync(DIR, { recursive: true });
let SECRET;
const secretFile = path.join(DIR, 'secret.key');
try { SECRET = fs.readFileSync(secretFile); } catch (_) { SECRET = crypto.randomBytes(32); fs.writeFileSync(secretFile, SECRET, { mode: 0o600 }); }

const rooms = new Map();     // roomId -> R
const uploads = new Map();   // uploadId -> up
const memCache = new Map();  // roomId -> { at, exists, members:Set, names }

function log() { console.log.apply(console, [new Date().toISOString()].concat([].slice.call(arguments))); }
function hexId(n) { return crypto.randomBytes(n).toString('hex'); }
function httpErr(status, code, extra) { const e = new Error(code); e.status = status; e.code = code; e.extra = extra || null; return e; }
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function sendJson(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > (limit || 65536)) { reject(httpErr(413, 'too-large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (_) { reject(httpErr(400, 'bad-json')); } });
    req.on('error', () => reject(httpErr(400, 'aborted')));
  });
}

// ---------- tasdiqlash ----------
async function authBearer(req) {
  const h = req.headers.authorization || '';
  if (h.indexOf('Bearer ') !== 0) throw httpErr(401, 'auth');
  try { return (await admin.auth().verifyIdToken(h.slice(7))).uid; } catch (_) { throw httpErr(401, 'auth'); }
}
function signTicket(uid, room) {
  const body = Buffer.from(JSON.stringify({ u: uid, r: room, e: Date.now() + TICKET_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function checkTicket(t, room) {
  if (!t || typeof t !== 'string') throw httpErr(401, 'ticket');
  const i = t.indexOf('.'); if (i < 1) throw httpErr(401, 'ticket');
  const body = t.slice(0, i), mac = t.slice(i + 1);
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpErr(401, 'ticket');
  let d; try { d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { throw httpErr(401, 'ticket'); }
  if (!d || d.r !== room || !(d.e > Date.now())) throw httpErr(401, 'ticket');
  return d.u;
}
async function roomInfo(room) {
  const c = memCache.get(room);
  if (c && Date.now() - c.at < 20000) return c;
  let d;
  try { d = await adb.collection('kinoRooms').doc(room).get(); } catch (e) { throw httpErr(503, 'db'); }
  const v = { at: Date.now(), exists: d.exists, members: new Set(d.exists ? (d.data().members || []) : []), names: d.exists ? (d.data().names || {}) : {} };
  memCache.set(room, v);
  if (!v.exists) purgeRoom(room);
  return v;
}
async function requireMember(room, uid) {
  if (!ROOM_RE.test(room || '')) throw httpErr(400, 'bad-room');
  const info = await roomInfo(room);
  if (!info.exists) throw httpErr(404, 'no-room');
  if (!info.members.has(uid)) throw httpErr(403, 'no-member');
  return info;
}

// ---------- xona holati ----------
function roomDir(id) { return path.join(DIR, id); }
function moviePath(id, movieId) { return path.join(roomDir(id), 'movie-' + movieId + '.bin'); }
function getRoom(id) {
  let R = rooms.get(id);
  if (R) return R;
  R = { id, st: null, up: null, clients: new Set(), saveT: null };
  try {
    const s = JSON.parse(fs.readFileSync(path.join(roomDir(id), 'state.json'), 'utf8'));
    if (s && s.movieId && fs.existsSync(moviePath(id, s.movieId))) { s.playing = false; R.st = s; }
  } catch (_) {}
  rooms.set(id, R);
  return R;
}
function curPos(R, now) { const s = R.st; return s.playing ? s.pos + (now - s.at) / 1000 : s.pos; }
function pubState(R) {
  const s = R.st;
  if (!s) return { movieId: '', playing: false, pos: 0, at: Date.now(), ver: 0 };
  return { movieId: s.movieId, name: s.name, size: s.size, mime: s.mime, playing: s.playing, pos: s.pos, at: s.at, ver: s.ver, by: s.by };
}
async function saveState(R) {
  if (!R.st) return;
  await fsp.mkdir(roomDir(R.id), { recursive: true });
  const f = path.join(roomDir(R.id), 'state.json'), tmp = f + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(R.st));
  await fsp.rename(tmp, f);
}
function saveSoon(R) { if (R.saveT) return; R.saveT = setTimeout(() => { R.saveT = null; saveState(R).catch(() => {}); }, 500); }
function broadcast(R, obj) {
  const m = JSON.stringify(obj);
  R.clients.forEach((ws) => { if (ws.readyState === 1) { try { ws.send(m); } catch (_) {} } });
}
function presence(R) {
  const set = new Set(); R.clients.forEach((ws) => set.add(ws.uid));
  broadcast(R, { type: 'presence', online: Array.from(set) });
}
async function purgeRoom(id) {
  const R = rooms.get(id);
  if (R) { R.clients.forEach((ws) => { try { ws.close(4004, 'no-room'); } catch (_) {} }); if (R.up) uploads.delete(R.up.id); rooms.delete(id); }
  memCache.delete(id);
  try { await fsp.rm(roomDir(id), { recursive: true, force: true }); log('xona tozalandi', id); } catch (_) {}
}

// ---------- fayl turini tekshirish (nomiga ishonmaymiz) ----------
function sniff(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return buf.toString('latin1', 0, Math.min(buf.length, 64)).indexOf('webm') >= 0 ? 'video/webm' : 'video/x-matroska';
  }
  return null;
}
async function freeBytes() { const s = await fsp.statfs(DIR); return Number(s.bavail) * Number(s.bsize); }

// ---------- yuklash ----------
function upBroadcast(R, state, force) {
  const u = R.up; if (!u) return;
  const now = Date.now();
  if (!force && now - u.lastBc < 1000) return;
  u.lastBc = now;
  broadcast(R, { type: 'upload', state, by: u.uid, byName: u.byName, name: u.name, pct: u.size ? Math.floor(u.off * 100 / u.size) : 0 });
}
async function abortUpload(R, state) {
  const u = R.up; if (!u) return;
  R.up = null; uploads.delete(u.id);
  broadcast(R, { type: 'upload', state: state || 'cancelled', by: u.uid, byName: u.byName, name: u.name, pct: 0 });
  try { await fsp.unlink(u.part); } catch (_) {}
}
async function uploadInit(req, res) {
  const uid = await authBearer(req);
  const b = await readJson(req);
  const room = String(b.room || ''), name = String(b.name || 'kino').slice(0, 200), size = Number(b.size);
  const info = await requireMember(room, uid);
  if (!Number.isInteger(size) || size < 1024) throw httpErr(400, 'bad-size');
  if (size > MAX_BYTES) throw httpErr(413, 'too-big', { max: MAX_BYTES });
  const R = getRoom(room);
  const now = Date.now();
  if (R.up && R.up.uid === uid && R.up.name === name && R.up.size === size) {
    R.up.last = now;
    let off = 0; try { off = (await fsp.stat(R.up.part)).size; } catch (_) {}
    R.up.off = off;
    return sendJson(res, 200, { id: R.up.id, offset: off, chunk: CHUNK, resumed: true });
  }
  if (R.up && R.up.uid !== uid && now - R.up.last < LOCK_STALE_MS) throw httpErr(409, 'busy', { by: R.up.byName });
  const free = await freeBytes();
  if (size + MIN_FREE > free) throw httpErr(507, 'disk-full', { free });
  if (R.up) await abortUpload(R, 'cancelled');
  await fsp.mkdir(roomDir(room), { recursive: true });
  const id = hexId(12), part = path.join(roomDir(room), 'up-' + id + '.part');
  await fsp.writeFile(part, '');
  R.up = { id, room, uid, byName: (info.names && info.names[uid]) || 'PLDN', name, size, off: 0, last: now, lastBc: 0, part, busy: false };
  uploads.set(id, R.up);
  upBroadcast(R, 'start', true);
  sendJson(res, 200, { id, offset: 0, chunk: CHUNK });
}
async function getUp(req, id) {
  const uid = await authBearer(req);
  const up = uploads.get(id);
  if (!up) throw httpErr(404, 'no-upload');
  if (up.uid !== uid) throw httpErr(403, 'not-yours');
  const R = rooms.get(up.room);
  if (!R || R.up !== up) throw httpErr(410, 'replaced');
  return { up, R };
}
function uploadChunk(req, res, id, offset) {
  return new Promise(async (resolve) => {
    let ctx;
    try { ctx = await getUp(req, id); } catch (e) { return resolve(replyErr(res, e)); }
    const { up, R } = ctx;
    const len = parseInt(req.headers['content-length'], 10);
    if (up.busy || offset !== up.off) { sendJson(res, 409, { error: 'offset', offset: up.off }); req.resume(); return resolve(); }
    if (!(len > 0) || len > MAX_BODY || up.off + len > up.size) { sendJson(res, 400, { error: 'bad-chunk' }); req.resume(); return resolve(); }
    up.busy = true; up.last = Date.now();
    const parts = []; let n = 0, dead = false;
    req.on('data', (c) => { n += c.length; if (n > len) { dead = true; req.destroy(); } else parts.push(c); });
    req.on('aborted', () => { dead = true; up.busy = false; resolve(); });
    req.on('error', () => { dead = true; up.busy = false; resolve(); });
    req.on('end', async () => {
      if (dead) { up.busy = false; return resolve(); }
      try {
        if (n !== len) throw httpErr(400, 'bad-chunk');
        const buf = Buffer.concat(parts);
        if (offset === 0 && !sniff(buf)) {
          await abortUpload(R, 'failed');
          throw httpErr(415, 'bad-type');
        }
        const fh = await fsp.open(up.part, 'r+');
        try { await fh.write(buf, 0, len, offset); } finally { await fh.close(); }
        up.off += len; up.last = Date.now();
        upBroadcast(R, 'progress', false);
        sendJson(res, 200, { offset: up.off });
      } catch (e) {
        if (e && e.code === 'ENOSPC') { await abortUpload(R, 'failed'); e = httpErr(507, 'disk-full'); }
        replyErr(res, e);
      } finally { up.busy = false; resolve(); }
    });
  });
}
async function uploadFinish(req, res, id) {
  const { up, R } = await getUp(req, id);
  if (up.busy) throw httpErr(409, 'busy-chunk');
  const st = await fsp.stat(up.part);
  if (st.size !== up.size || up.off !== up.size) throw httpErr(409, 'incomplete', { offset: st.size });
  const fh = await fsp.open(up.part, 'r'); const head = Buffer.alloc(64);
  try { await fh.read(head, 0, 64, 0); } finally { await fh.close(); }
  const mime = sniff(head);
  if (!mime) { await abortUpload(R, 'failed'); throw httpErr(415, 'bad-type'); }
  const movieId = hexId(8), final = moviePath(R.id, movieId), old = R.st && R.st.movieId;
  await fsp.rename(up.part, final);                       // avval yangi fayl to'liq joyiga tushadi
  R.st = { movieId, name: up.name, size: up.size, mime, playing: false, pos: 0, at: Date.now(), ver: (R.st ? R.st.ver : 0) + 1, by: up.uid };
  await saveState(R);                                      // keyin holat atomik yoziladi
  if (old) { try { await fsp.unlink(moviePath(R.id, old)); } catch (_) {} }   // oxirida eskisi o'chadi
  const fin = R.up; R.up = null; uploads.delete(id);
  broadcast(R, { type: 'upload', state: 'done', by: fin.uid, byName: fin.byName, name: fin.name, pct: 100 });
  broadcast(R, { type: 'state', state: pubState(R) });
  log('yangi kino', R.id, up.name, up.size);
  sendJson(res, 200, { ok: true, movieId });
}

// ---------- uzatish (HTTP Range) ----------
async function stream(req, res, room, q) {
  const uid = checkTicket(q.get('t'), room);
  await requireMember(room, uid);
  const R = getRoom(room);
  if (!R.st || !R.st.movieId) throw httpErr(404, 'no-movie');
  const v = q.get('v'); if (v && v !== R.st.movieId) throw httpErr(410, 'moved');
  const file = moviePath(room, R.st.movieId);
  let stt; try { stt = await fsp.stat(file); } catch (_) { throw httpErr(404, 'no-movie'); }
  const size = stt.size; let start = 0, end = size - 1, code = 200;
  const rg = req.headers.range;
  if (rg) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rg.trim());
    if (!m || (m[1] === '' && m[2] === '')) { cors(res); res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    if (m[1] === '') { const sfx = parseInt(m[2], 10); start = Math.max(0, size - sfx); }
    else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1); }
    if (start >= size || start > end) { cors(res); res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    code = 206;
  }
  cors(res);
  const h = { 'Content-Type': R.st.mime || 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, no-transform' };
  if (code === 206) h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
  rs.on('error', () => { try { res.destroy(); } catch (_) {} });
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

// ---------- HTTP ----------
function replyErr(res, e) {
  if (res.headersSent) { try { res.destroy(); } catch (_) {} return; }
  if (e && e.status) return sendJson(res, e.status, Object.assign({ error: e.code }, e.extra || {}));
  console.error('xato', e && e.stack || e);
  sendJson(res, 500, { error: 'server' });
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    const u = new URL(req.url, 'http://x'); const p = u.pathname; let m;
    if (p === '/kino/health') return sendJson(res, 200, { ok: true, free: await freeBytes(), rooms: rooms.size });
    if (p === '/kino/ticket' && req.method === 'POST') {
      const uid = await authBearer(req); const b = await readJson(req);
      await requireMember(String(b.room || ''), uid);
      const R = getRoom(String(b.room));
      return sendJson(res, 200, { ticket: signTicket(uid, String(b.room)), state: pubState(R), now: Date.now() });
    }
    if (p === '/kino/upload/init' && req.method === 'POST') return await uploadInit(req, res);
    if ((m = /^\/kino\/upload\/([0-9a-f]{24})$/.exec(p))) {
      if (req.method === 'PUT') return await uploadChunk(req, res, m[1], parseInt(u.searchParams.get('offset'), 10));
      if (req.method === 'GET') { const { up } = await getUp(req, m[1]); up.last = Date.now(); return sendJson(res, 200, { offset: up.off }); }
    }
    if ((m = /^\/kino\/upload\/([0-9a-f]{24})\/(finish|cancel)$/.exec(p)) && req.method === 'POST') {
      if (m[2] === 'finish') return await uploadFinish(req, res, m[1]);
      const { R } = await getUp(req, m[1]); await abortUpload(R, 'cancelled'); return sendJson(res, 200, { ok: true });
    }
    if ((m = /^\/kino\/stream\/([A-Za-z0-9]+)$/.exec(p)) && (req.method === 'GET' || req.method === 'HEAD')) return await stream(req, res, m[1], u.searchParams);
    sendJson(res, 404, { error: 'not-found' });
  } catch (e) { replyErr(res, e); }
});
server.requestTimeout = 120000;
server.headersTimeout = 30000;

// ---------- WebSocket: sinxron holat ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', async (req, socket, head) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/kino/ws') throw httpErr(404, 'x');
    const room = u.searchParams.get('room') || '';
    const uid = checkTicket(u.searchParams.get('t'), room);
    await requireMember(room, uid);
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, room, uid));
  } catch (_) { try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch (__) {} socket.destroy(); }
});
function onConnect(ws, room, uid) {
  const R = getRoom(room);
  ws.uid = uid; ws.room = room; ws.alive = true; ws.msgs = 0;
  R.clients.add(ws);
  ws.on('pong', () => { ws.alive = true; });
  ws.send(JSON.stringify({ type: 'state', state: pubState(R), now: Date.now() }));
  if (R.up) ws.send(JSON.stringify({ type: 'upload', state: 'progress', by: R.up.uid, byName: R.up.byName, name: R.up.name, pct: R.up.size ? Math.floor(R.up.off * 100 / R.up.size) : 0 }));
  presence(R);
  ws.on('message', async (data) => {
    if (++ws.msgs > 20) return;                       // sekundiga 20 tadan ortiq xabar e'tiborsiz
    let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t, s: Date.now() }));
    if (m.type === 'ctl') {
      try { await requireMember(room, uid); } catch (_) { return ws.close(4003, 'no-member'); }
      applyCtl(R, uid, m);
    }
  });
  ws.on('close', () => { R.clients.delete(ws); presence(R); });
  ws.on('error', () => {});
}
function applyCtl(R, uid, m) {
  const s = R.st; if (!s || !s.movieId) return;
  const now = Date.now(), c = curPos(R, now);
  const num = (x) => (typeof x === 'number' && isFinite(x)) ? Math.max(0, x) : null;
  switch (m.op) {
    case 'play': s.pos = num(m.pos) != null ? num(m.pos) : c; s.playing = true; break;
    case 'pause': s.pos = num(m.pos) != null ? num(m.pos) : c; s.playing = false; break;
    case 'seek': { const p = num(m.pos); if (p == null) return; s.pos = p; break; }
    case 'restart': s.pos = 0; s.playing = true; break;
    default: return;
  }
  s.at = now; s.ver++; s.by = uid;
  saveSoon(R);
  broadcast(R, { type: 'state', state: pubState(R), now });
}

// ---------- tozalash va monitoring ----------
setInterval(() => { wss.clients.forEach((ws) => { ws.msgs = 0; }); }, 1000);
setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.alive) return ws.terminate(); ws.alive = false; try { ws.ping(); } catch (_) {} });
}, 25000);
setInterval(() => {                                       // ijro paytida joy har 30 soniyada saqlanadi
  rooms.forEach((R) => { if (R.st && R.st.playing) { const now = Date.now(); R.st.pos = curPos(R, now); R.st.at = now; saveSoon(R); } });
}, 30000);
async function sweep() {
  const now = Date.now();
  for (const R of rooms.values()) { if (R.up && now - R.up.last > PART_TTL_MS) await abortUpload(R, 'failed'); }
  let names = []; try { names = await fsp.readdir(DIR); } catch (_) {}
  for (const id of names) {
    if (!ROOM_RE.test(id)) continue;
    const dir = roomDir(id), R = rooms.get(id);
    let files = []; try { files = await fsp.readdir(dir); } catch (_) { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      if (f.endsWith('.tmp')) { try { const s = await fsp.stat(full); if (now - s.mtimeMs > 60000) await fsp.unlink(full); } catch (_) {} }
      if (/^up-[0-9a-f]+\.part$/.test(f)) {
        if (R && R.up && R.up.part === full) continue;
        try { const s = await fsp.stat(full); if (now - s.mtimeMs > PART_TTL_MS) await fsp.unlink(full); } catch (_) {}
      }
      const mm = /^movie-([0-9a-f]+)\.bin$/.exec(f);
      if (mm) {
        const keep = (R && R.st && R.st.movieId === mm[1]) || (!R && (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).movieId === mm[1]; } catch (_) { return false; } })());
        if (!keep) { try { await fsp.unlink(full); } catch (_) {} }
      }
    }
    try { await roomInfo(id); } catch (_) {}              // xona Firestore'da yo'q bo'lsa, o'zi tozalanadi
  }
}
setInterval(() => { sweep().catch((e) => console.error('sweep', e)); }, 10 * 60 * 1000);
setTimeout(() => { sweep().catch(() => {}); }, 5000);

server.listen(PORT, '127.0.0.1', () => log('kino server', PORT));
process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled', e));
