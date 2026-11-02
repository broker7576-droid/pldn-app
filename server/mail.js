// mail.js | VERSION: mail-srv-v1 | LINES: 152
// PLDN Mail serveri: Mail hisoblari, PLDN'ga ulash, kirish kodlari (6-14 raqam), 4 xato = 12 soat blok (faqat Mail kodi yo'li)
process.umask(0o077);
const express=require('express');
const fs=require('fs');
const crypto=require('crypto');
const Database=require('better-sqlite3');
const {initializeApp,cert}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getMessaging}=require('firebase-admin/messaging');
initializeApp({credential:cert(require('./serviceAccount.json'))});
process.on('unhandledRejection',e=>console.error('xato:',e));

const PORT=3020,EMAIL_DOMAIN='@pldn.app';
const CODE_TTL=5*60e3,LINK_TTL=5*60e3,RESEND_MS=60e3,MAX_FAILS=4,BLOCK_MS=12*3600e3;
const MASTER=Buffer.from(fs.readFileSync(__dirname+'/data/mail.key','utf8').trim(),'hex');
if(MASTER.length!==32)throw new Error('data/mail.key noto‘g‘ri (64 ta hex belgi kerak)');
const db=new Database(__dirname+'/data/mail.db');
db.pragma('journal_mode=WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS acc(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,pw BLOB NOT NULL,uid TEXT UNIQUE,fcm TEXT,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ses(h TEXT PRIMARY KEY,acc INTEGER NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ses_a ON ses(acc,created);
CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,acc INTEGER NOT NULL,ts INTEGER NOT NULL,enc BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_a ON inbox(acc,id);
CREATE TABLE IF NOT EXISTS lcode(acc INTEGER PRIMARY KEY,h TEXT NOT NULL,exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ocode(uid TEXT PRIMARY KEY,h TEXT NOT NULL,exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blk(uid TEXT PRIMARY KEY,fails INTEGER NOT NULL DEFAULT 0,until INTEGER NOT NULL DEFAULT 0);
`);

// ---------- yordamchilar ----------
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const hmac=s=>crypto.createHmac('sha256',MASTER).update(s).digest('hex');
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const mask=n=>n.charAt(0)+'.......'+n.slice(-2); // a.......20 (nuqtalar doim 7 ta)
function akey(id){return Buffer.from(crypto.hkdfSync('sha256',MASTER,Buffer.alloc(0),'pldn-mail:'+id,32));}
function enc(id,o){const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',akey(id),iv);c.setAAD(Buffer.from(String(id)));const ct=Buffer.concat([c.update(JSON.stringify(o),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),ct]);}
function dec(id,b){try{const d=crypto.createDecipheriv('aes-256-gcm',akey(id),b.subarray(0,12));d.setAAD(Buffer.from(String(id)));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'));}catch(e){return null;}}
function hashPw(pw){const s=crypto.randomBytes(16);return Buffer.concat([s,crypto.scryptSync(pw,s,32)]);}
function checkPw(pw,b){return crypto.timingSafeEqual(crypto.scryptSync(pw,b.subarray(0,16),32),b.subarray(16));}
const hits=new Map();
function limited(k,max,ms){const n=Date.now(),a=(hits.get(k)||[]).filter(t=>n-t<ms);if(a.length>=max){hits.set(k,a);return true;}a.push(n);hits.set(k,a);return false;}
setInterval(()=>{const n=Date.now();for(const [k,a] of hits)if(!a.some(t=>n-t<3600e3))hits.delete(k);
db.prepare('DELETE FROM lcode WHERE exp<?').run(n);db.prepare('DELETE FROM ocode WHERE exp<?').run(n);db.prepare('DELETE FROM blk WHERE until>0 AND until<?').run(n);},600e3).unref();

function newSession(a){const t=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO ses VALUES(?,?,?)').run(sha(t),a,Date.now());
db.prepare('DELETE FROM ses WHERE acc=? AND h NOT IN(SELECT h FROM ses WHERE acc=? ORDER BY created DESC LIMIT 5)').run(a,a);return t;}
async function push(a){const r=db.prepare('SELECT fcm FROM acc WHERE id=?').get(a);if(!r||!r.fcm)return;
try{await getMessaging().send({token:r.fcm,notification:{title:'PLDN Mail',body:'Yangi xabar'},data:{kind:'mail'},android:{priority:'high',notification:{tag:'mail'}}});}
catch(e){if(/not-registered|invalid-argument|invalid-registration/.test(String(e.code||e.message)))db.prepare('UPDATE acc SET fcm=NULL WHERE id=?').run(a);}}
function deliver(a,o){db.prepare('INSERT INTO inbox(acc,ts,enc) VALUES(?,?,?)').run(a,Date.now(),enc(a,o));
db.prepare('DELETE FROM inbox WHERE acc=? AND id NOT IN(SELECT id FROM inbox WHERE acc=? ORDER BY id DESC LIMIT 100)').run(a,a);push(a);}
function blockOf(uid){let b=db.prepare('SELECT fails,until FROM blk WHERE uid=?').get(uid)||{fails:0,until:0};
if(b.until&&b.until<=Date.now()){db.prepare('DELETE FROM blk WHERE uid=?').run(uid);b={fails:0,until:0};}return b;}
async function uidOf(username){if(!/^[a-z0-9]{4,12}$/.test(username))return null;
try{return (await getAuth().getUserByEmail(username+EMAIL_DOMAIN)).uid;}catch(e){return null;}}
function mailAuth(q,r,next){const m=(q.get('Authorization')||'').match(/^Bearer (.+)$/);if(!m)return r.status(401).json({error:'Kirish kerak'});
const h=sha(m[1]),s=db.prepare('SELECT acc FROM ses WHERE h=?').get(h);if(!s)return r.status(401).json({error:'Seans tugagan'});q.acc=s.acc;q.sh=h;next();}
async function pldnAuth(q,r,next){const m=(q.get('Authorization')||'').match(/^Bearer (.+)$/);if(!m)return r.status(401).json({error:'Kirish kerak'});
try{q.uid=(await getAuth().verifyIdToken(m[1])).uid;}catch(e){return r.status(401).json({error:'Kirish tasdiqlanmadi'});}next();}

// ---------- HTTP ----------
const app=express();
app.set('trust proxy','loopback');
app.use(express.json({limit:'4kb'}));
app.use((q,r,next)=>{r.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'POST,GET,OPTIONS'});if(q.method==='OPTIONS')return r.sendStatus(204);next();});
app.get('/',(q,r)=>r.send('PLDN Mail ishlayapti (mail-srv-v1)'));

// --- Mail ilovasi ---
app.post('/register',(q,r)=>{
const name=String(q.body.name||'').toLowerCase(),pw=String(q.body.password||'');
if(limited('reg:'+q.ip,5,3600e3))return r.status(429).json({error:'Juda ko‘p urinish. Keyinroq qayta urining.'});
if(!/^[a-z0-9]{4,20}$/.test(name))return r.status(400).json({error:'Mail nomi: 4–20 ta, faqat a–z va 0–9'});
if(pw.length<6||pw.length>64)return r.status(400).json({error:'Parol 6–64 belgi bo‘lsin'});
try{const id=db.prepare('INSERT INTO acc(name,pw,created) VALUES(?,?,?)').run(name,hashPw(pw),Date.now()).lastInsertRowid;r.json({token:newSession(Number(id)),name});}
catch(e){r.status(409).json({error:'Bu nom band'});}});
app.post('/login',(q,r)=>{
const name=String(q.body.name||'').toLowerCase().slice(0,40),pw=String(q.body.password||'').slice(0,64);
if(limited('ml:'+q.ip+name,8,600e3))return r.status(429).json({error:'Juda ko‘p urinish. Keyinroq qayta urining.'});
const a=db.prepare('SELECT id,pw FROM acc WHERE name=?').get(name);
if(!a||!checkPw(pw,a.pw))return r.status(401).json({error:'Nom yoki parol noto‘g‘ri'});
r.json({token:newSession(a.id),name});});
app.post('/logout',mailAuth,(q,r)=>{db.prepare('DELETE FROM ses WHERE h=?').run(q.sh);r.json({ok:true});});
app.get('/me',mailAuth,(q,r)=>{const a=db.prepare('SELECT name,uid FROM acc WHERE id=?').get(q.acc);r.json({name:a.name,linked:!!a.uid});});
app.post('/fcm',mailAuth,(q,r)=>{const t=String(q.body.token||'');if(t.length<20||t.length>400)return r.status(400).json({error:'Token noto‘g‘ri'});
db.prepare('UPDATE acc SET fcm=NULL WHERE fcm=? AND id<>?').run(t,q.acc);db.prepare('UPDATE acc SET fcm=? WHERE id=?').run(t,q.acc);r.json({ok:true});});
app.get('/inbox',mailAuth,(q,r)=>{const rows=db.prepare('SELECT id,ts,enc FROM inbox WHERE acc=? ORDER BY id DESC LIMIT 100').all(q.acc);
r.json({items:rows.map(x=>({id:x.id,ts:x.ts,...(dec(q.acc,x.enc)||{})}))});});
app.post('/link/new',mailAuth,(q,r)=>{
if(db.prepare('SELECT uid FROM acc WHERE id=?').get(q.acc).uid)return r.status(409).json({error:'Allaqachon PLDN hisobiga ulangan'});
const code=String(crypto.randomInt(0,1e10)).padStart(10,'0');
db.prepare('INSERT OR REPLACE INTO lcode VALUES(?,?,?)').run(q.acc,hmac('L'+code),Date.now()+LINK_TTL);r.json({code,ttl:LINK_TTL/1000});});
app.post('/unlink',mailAuth,(q,r)=>{const a=db.prepare('SELECT uid FROM acc WHERE id=?').get(q.acc);
if(a.uid){db.prepare('DELETE FROM ocode WHERE uid=?').run(a.uid);db.prepare('DELETE FROM blk WHERE uid=?').run(a.uid);}
db.prepare('UPDATE acc SET uid=NULL WHERE id=?').run(q.acc);r.json({ok:true});});

// --- PLDN ilovasi (Firebase ID token bilan) ---
app.post('/pldn/link',pldnAuth,(q,r)=>{
const code=String(q.body.code||'').replace(/\D/g,'').slice(0,10);
if(limited('pl:'+q.uid,5,600e3)||limited('pli:'+q.ip,20,600e3))return r.status(429).json({error:'Juda ko‘p urinish. Keyinroq qayta urining.'});
if(db.prepare('SELECT 1 FROM acc WHERE uid=?').get(q.uid))return r.status(409).json({error:'Sizda Mail allaqachon ulangan'});
const row=db.prepare('SELECT acc FROM lcode WHERE h=? AND exp>?').get(hmac('L'+code),Date.now());
if(!row)return r.status(400).json({error:'Kod noto‘g‘ri yoki muddati o‘tgan'});
if(!db.prepare('UPDATE acc SET uid=? WHERE id=? AND uid IS NULL').run(q.uid,row.acc).changes)return r.status(409).json({error:'Bu Mail allaqachon ulangan'});
db.prepare('DELETE FROM lcode WHERE acc=?').run(row.acc);
deliver(row.acc,{title:'PLDN hisobi ulandi',text:'PLDN hisobingiz shu Mailga ulandi. Endi kirish kodlari shu yerga keladi.'});
r.json({ok:true,mask:mask(db.prepare('SELECT name FROM acc WHERE id=?').get(row.acc).name)});});
app.get('/pldn/status',pldnAuth,(q,r)=>{const a=db.prepare('SELECT name FROM acc WHERE uid=?').get(q.uid);r.json(a?{linked:true,mask:mask(a.name)}:{linked:false});});
app.post('/pldn/unlink',pldnAuth,(q,r)=>{const a=db.prepare('SELECT id FROM acc WHERE uid=?').get(q.uid);
if(a){db.prepare('UPDATE acc SET uid=NULL WHERE id=?').run(a.id);db.prepare('DELETE FROM ocode WHERE uid=?').run(q.uid);db.prepare('DELETE FROM blk WHERE uid=?').run(q.uid);
deliver(a.id,{title:'PLDN hisobi uzildi',text:'PLDN hisobi bu Mail‘dan uzildi.'});}r.json({ok:true});});

// --- Kirish ekrani (parolsiz; username bo'yicha) ---
app.post('/login/info',async(q,r)=>{
if(limited('li:'+q.ip,30,600e3))return r.status(429).json({error:'Juda ko‘p urinish. Keyinroq qayta urining.'});
const uid=await uidOf(String(q.body.username||'').toLowerCase());
const a=uid&&db.prepare('SELECT name FROM acc WHERE uid=?').get(uid);
r.json(a?{linked:true,mask:mask(a.name)}:{linked:false});});
app.post('/login/request',async(q,r)=>{
if(limited('lr:'+q.ip,30,600e3))return r.status(429).json({error:'Juda ko‘p urinish. Keyinroq qayta urining.'});
const uid=await uidOf(String(q.body.username||'').toLowerCase());
const a=uid&&db.prepare('SELECT id,name FROM acc WHERE uid=?').get(uid);
if(!a)return r.status(404).json({error:'Bu hisobga Mail ulanmagan'});
const b=blockOf(uid);
if(b.until>Date.now())return r.status(429).json({error:'Mail kodi bilan kirish vaqtincha yopiq. Parol bilan kiring.',blockedUntil:b.until});
if(limited('lq:'+uid,1,RESEND_MS))return r.status(429).json({error:'Kod yaqinda yuborilgan. Biroz kuting.',wait:RESEND_MS/1000});
const len=crypto.randomInt(6,15);let code='';for(let i=0;i<len;i++)code+=crypto.randomInt(0,10);
db.prepare('INSERT OR REPLACE INTO ocode VALUES(?,?,?)').run(uid,hmac('O'+uid+':'+code),Date.now()+CODE_TTL);
deliver(a.id,{title:'PLDN kirish kodi',code,text:'PLDN hisobiga kirish kodi. Uni hech kimga bermang.'});
r.json({ok:true,mask:mask(a.name)});}); // kod uzunligi javobda yo'q
app.post('/login/verify',async(q,r)=>{
if(limited('lv:'+q.ip,60,600e3))return r.status(429).json({error:'Juda ko‘p urinish. Keyinroq qayta urining.'});
const code=String(q.body.code||'').replace(/\D/g,'').slice(0,14);
if(!code)return r.status(400).json({error:'Kodni kiriting'});
const uid=await uidOf(String(q.body.username||'').toLowerCase());
const a=uid&&db.prepare('SELECT id FROM acc WHERE uid=?').get(uid);
if(!a)return r.status(404).json({error:'Bu hisobga Mail ulanmagan'});
const b=blockOf(uid);
if(b.until>Date.now())return r.status(429).json({error:'Mail kodi bilan kirish vaqtincha yopiq. Parol bilan kiring.',blockedUntil:b.until});
const o=db.prepare('SELECT h,exp FROM ocode WHERE uid=?').get(uid);
if(!o||o.exp<Date.now())return r.status(400).json({error:'Kod yo‘q yoki muddati o‘tgan. Yangi kod so‘rang.'});
if(same(o.h,hmac('O'+uid+':'+code))){
db.prepare('DELETE FROM ocode WHERE uid=?').run(uid);db.prepare('DELETE FROM blk WHERE uid=?').run(uid);
try{return r.json({token:await getAuth().createCustomToken(uid)});}catch(e){console.error(e);return r.status(500).json({error:'Server xatosi'});}}
const f=b.fails+1,until=f>=MAX_FAILS?Date.now()+BLOCK_MS:0;
db.prepare('INSERT OR REPLACE INTO blk VALUES(?,?,?)').run(uid,until?0:f,until);
if(until){db.prepare('DELETE FROM ocode WHERE uid=?').run(uid);
deliver(a.id,{title:'Mail kodi bloklandi',text:'Kod 4 marta noto‘g‘ri kiritildi. Mail kodi bilan kirish 12 soatga yopildi. Parol bilan kirish ochiq.'});
return r.status(429).json({error:'4 marta xato. Mail kodi bilan kirish 12 soatga yopildi.',blockedUntil:until});}
r.status(400).json({error:'Kod noto‘g‘ri',left:MAX_FAILS-f});});
app.use((e,q,r,n)=>r.status(400).json({error:'So‘rov noto‘g‘ri'}));
app.listen(PORT,'127.0.0.1',()=>console.log(PORT+'-portda PLDN Mail (mail-srv-v1)'));
