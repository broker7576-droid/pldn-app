// VERSION: search-v3 (token, javobsiz savollar, /teach + shifrlangan tarix, xotira, eslatmalar)
process.umask(0o077);
const express=require('express');
const fs=require('fs');
const crypto=require('crypto');
const Database=require('better-sqlite3');
const {initializeApp,cert}=require('firebase-admin/app');
const {getFirestore,FieldValue}=require('firebase-admin/firestore');
const {getAuth}=require('firebase-admin/auth');
const {getMessaging}=require('firebase-admin/messaging');
initializeApp({credential:cert(require('./serviceAccount.json'))});
const db=getFirestore();
process.on('unhandledRejection',e=>console.error('unhandled',e&&e.message));

// ---------- matnni tozalash ----------
const CY={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'j',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'x',ц:'s',ч:'ch',ш:'sh',щ:'sh',ъ:'',ы:'i',ь:'',э:'e',ю:'yu',я:'ya',ў:'o',қ:'q',ғ:'g',ҳ:'h'};
const STOP=new Set(['va','bu','iltimos','menga','ayt','ayting','aytib','ber','bering','mi','ku']);
function norm(s){
s=String(s||'').toLowerCase().replace(/[\u02bb\u02bc\u2018\u2019\u0060\u0027]/g,'');
s=s.replace(/[^\x00-\x7f]/g,c=>CY[c]!==undefined?CY[c]:' ');
return s.replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
}
function keyOf(s){return norm(s).replace(/ /g,'_').slice(0,200);}
function toks(s){return norm(s).split(' ').filter(w=>w&&!STOP.has(w)).map(w=>w.slice(0,5));}
function tri(s){s='  '+norm(s)+' ';const m=new Map();for(let i=0;i<s.length-2;i++){const g=s.substr(i,3);m.set(g,(m.get(g)||0)+1);}return m;}
function dice(a,b){let i=0,sa=0,sb=0;for(const v of a.values())sa+=v;for(const v of b.values())sb+=v;for(const [g,v] of a){const w=b.get(g);if(w)i+=Math.min(v,w);}return sa+sb?2*i/(sa+sb):0;}
function lev(a,b){if(Math.abs(a.length-b.length)>1)return 9;const d=[];for(let i=0;i<=a.length;i++)d[i]=[i];for(let j=1;j<=b.length;j++)d[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[a.length][b.length];}
function clean(s,n){return String(s||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,n);}

// ---------- bilimlar bazasi (botKB) xotirada ----------
let KB=[],DF=new Map();
function idf(w){return Math.log(1+(KB.length+1)/((DF.get(w)||0)+0.5));}
function vec(t){const m=new Map();for(const w of t)m.set(w,(m.get(w)||0)+idf(w));return m;}
function cos(a,b){let d=0,x=0,y=0;for(const v of a.values())x+=v*v;for(const v of b.values())y+=v*v;for(const [k,v] of a){const w=b.get(k);if(w)d+=v*w;}return x&&y?d/Math.sqrt(x*y):0;}
function fix(w){if(DF.has(w)||w.length<4)return w;for(const v of DF.keys())if(lev(w,v)<=1)return v;return w;}
function build(snap){
const list=[];
snap.forEach(doc=>{const d=doc.data();const ans=(d.answers||[]).filter(a=>a&&a.status==='approved'&&a.t);if(!d.q||!ans.length)return;list.push({key:d.key||doc.id,q:d.q,ans,tk:toks(d.q),tg:tri(d.q)});});
DF=new Map();
for(const e of list)for(const w of new Set(e.tk))DF.set(w,(DF.get(w)||0)+1);
KB=list;
for(const e of KB)e.v=vec(e.tk);
console.log('KB yangilandi:',KB.length);
}
db.collection('botKB').onSnapshot(build,e=>console.error('KB xato',e.message));
function search(q){
const t=toks(q).map(fix);
if(!t.length||!KB.length)return {status:'none',score:0,answers:[]};
const qv=vec(t),qg=tri(q);
let best=null,bs=0,second=0;
for(const e of KB){const s=0.65*cos(qv,e.v)+0.35*dice(qg,e.tg);if(s>bs){second=bs;bs=s;best=e;}else if(s>second)second=s;}
const status=bs>=0.62?'answer':bs>=0.4?'suggest':'none';
return {status,score:+bs.toFixed(3),second:+second.toFixed(3),key:best?best.key:null,q:best?best.q:null,answers:status==='none'?[]:best.ans.map(a=>({t:a.t,lang:a.lang}))};
}

// ---------- maxfiy ma'lumotlar: SQLite + AES-256-GCM (har foydalanuvchiga alohida kalit) ----------
const PUSH_SHOW_TEXT=false; // true bo'lsa bildirishnomada eslatma matni ko'rinadi
const MASTER=Buffer.from(fs.readFileSync(__dirname+'/data/bot.key','utf8').trim(),'hex');
if(MASTER.length!==32)throw new Error('data/bot.key noto‘g‘ri (64 ta hex belgi kerak)');
const sdb=new Database(__dirname+'/data/bot.db');
sdb.pragma('journal_mode=WAL');
sdb.exec(`
CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT,uid TEXT NOT NULL,ts INTEGER NOT NULL,who TEXT NOT NULL,enc BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS msgs_u ON msgs(uid,id);
CREATE TABLE IF NOT EXISTS mem(id INTEGER PRIMARY KEY AUTOINCREMENT,uid TEXT NOT NULL,ts INTEGER NOT NULL,k BLOB NOT NULL,v BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS mem_u ON mem(uid,id);
CREATE TABLE IF NOT EXISTS rem(id INTEGER PRIMARY KEY AUTOINCREMENT,uid TEXT NOT NULL,due INTEGER NOT NULL,created INTEGER NOT NULL,t BLOB NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS rem_due ON rem(sent,due);
CREATE INDEX IF NOT EXISTS rem_u ON rem(uid,sent,due);
`);
const ukeys=new Map();
function ukey(uid){let k=ukeys.get(uid);if(!k){k=Buffer.from(crypto.hkdfSync('sha256',MASTER,Buffer.alloc(0),'pldn-bot:'+uid,32));if(ukeys.size>500)ukeys.clear();ukeys.set(uid,k);}return k;}
function enc(uid,s){const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',ukey(uid),iv);c.setAAD(Buffer.from(uid));const ct=Buffer.concat([c.update(String(s),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),ct]);}
function dec(uid,b){try{const iv=b.subarray(0,12),tag=b.subarray(12,28),ct=b.subarray(28);const d=crypto.createDecipheriv('aes-256-gcm',ukey(uid),iv);d.setAAD(Buffer.from(uid));d.setAuthTag(tag);return Buffer.concat([d.update(ct),d.final()]).toString('utf8');}catch(e){return null;}}

// --- suhbat tarixi ---
const HIST_MAX=1000;
function addMsg(uid,who,t){
t=String(t||'').slice(0,2000);if(!t)return;
sdb.prepare('INSERT INTO msgs(uid,ts,who,enc) VALUES(?,?,?,?)').run(uid,Date.now(),who==='b'?'b':'u',enc(uid,t));
const n=sdb.prepare('SELECT COUNT(*) c FROM msgs WHERE uid=?').get(uid).c;
if(n>HIST_MAX)sdb.prepare('DELETE FROM msgs WHERE id IN (SELECT id FROM msgs WHERE uid=? ORDER BY id ASC LIMIT ?)').run(uid,n-HIST_MAX);
}
function getMsgs(uid,before,limit){
const rows=before?sdb.prepare('SELECT id,ts,who,enc FROM msgs WHERE uid=? AND id<? ORDER BY id DESC LIMIT ?').all(uid,before,limit):sdb.prepare('SELECT id,ts,who,enc FROM msgs WHERE uid=? ORDER BY id DESC LIMIT ?').all(uid,limit);
return rows.reverse().map(r=>({id:r.id,ts:r.ts,who:r.who,t:dec(uid,r.enc)||''}));
}

// --- shaxsiy xotira ---
const MEM_MAX=200;
function memAll(uid){return sdb.prepare('SELECT id,k,v FROM mem WHERE uid=? ORDER BY id ASC').all(uid).map(r=>({id:r.id,k:dec(uid,r.k)||'',v:dec(uid,r.v)||''}));}
const MSTOP=new Set(['menin','manin','meni','nima','qaysi','qanda','bu','shu']);
function mtoks(s){return toks(s).filter(w=>!MSTOP.has(w));}
function recall(uid,q){
const items=memAll(uid);if(!items.length)return null;
const t=mtoks(q);if(!t.length)return null;
const qv=vec(t),qg=tri(q);
let best=null,bs=0;
for(const m of items){const mt=mtoks(m.k);if(!mt.length)continue;const s=0.65*cos(qv,vec(mt))+0.35*dice(qg,tri(m.k));if(s>bs){bs=s;best=m;}}
return best&&bs>=0.62?{item:best,score:bs}:null;
}

// --- eslatmalar ---
function remList(uid){return sdb.prepare('SELECT id,due,t FROM rem WHERE uid=? AND sent=0 ORDER BY due ASC,id ASC').all(uid).map(r=>({id:r.id,due:r.due,t:dec(uid,r.t)||''}));}
function pad(n){return (n<10?'0':'')+n;}
function fmt(due,tz){const d=new Date(due+tz*60000);return pad(d.getUTCDate())+'.'+pad(d.getUTCMonth()+1)+' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes());}
function parseWhen(args,tz,now){
let m;
if((m=args.match(/^(\d{1,3})\s*(daqiqa|daq|min|soat|kun)\w*\s+([\s\S]+)$/i))){
const u=m[2].toLowerCase();
const ms=u==='soat'?3600000:u==='kun'?86400000:60000;
return {due:now+(+m[1])*ms,rest:m[3]};
}
const ld=new Date(now+tz*60000);
if((m=args.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2})[:.](\d{2})\s+([\s\S]+)$/))){
const dd=+m[1],mo=+m[2],hh=+m[4],mi=+m[5];
const yy=m[3]?+m[3]:ld.getUTCFullYear();
if(mo<1||mo>12||dd<1||dd>31||hh>23||mi>59)return null;
let due=Date.UTC(yy,mo-1,dd,hh,mi)-tz*60000;
if(!m[3]&&due<=now)due=Date.UTC(yy+1,mo-1,dd,hh,mi)-tz*60000;
if(new Date(due+tz*60000).getUTCDate()!==dd)return null;
return {due,rest:m[6]};
}
if((m=args.match(/^(\d{1,2})[:.](\d{2})\s+([\s\S]+)$/))){
const hh=+m[1],mi=+m[2];
if(hh>23||mi>59)return null;
let due=Date.UTC(ld.getUTCFullYear(),ld.getUTCMonth(),ld.getUTCDate(),hh,mi)-tz*60000;
if(due<=now)due+=86400000;
return {due,rest:m[3]};
}
return null;
}

const HELP_UZ='Buyruqlar:\n/esla kalit = qiymat — eslab qolaman\n/xotira — saqlanganlar ro‘yxati\n/unut 2 yoki /unut hammasi\n/eslat 21:30 matn\n/eslat 25.10 09:00 matn\n/eslat 2 soat matn (yoki daqiqa, kun)\n/royxat — eslatmalar ro‘yxati\n/ochir 2 — eslatmani bekor qilish\n/tozala — suhbat tarixini o‘chirish\n/oyrat javob — bot bilmagan savolga javob o‘rgatish';
const HELP_RU='Команды:\n/esla ключ = значение — запомню\n/xotira — список сохранённого\n/unut 2 или /unut hammasi\n/eslat 21:30 текст\n/eslat 25.10 09:00 текст\n/eslat 2 soat текст (или daqiqa, kun)\n/royxat — список напоминаний\n/ochir 2 — отменить напоминание\n/tozala — очистить историю чата\n/oyrat ответ — научить бота ответу на неизвестный вопрос';
function runCmd(uid,text,lang,tz){
const T=(u,r)=>lang==='ru'?r:u;
const m=text.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
if(!m)return {reply:T('Buyruq noto‘g‘ri. /yordam','Неверная команда. /yordam')};
const name=m[1].toLowerCase(),arg=m[2].trim(),now=Date.now();
if(name==='yordam'||name==='help'||name==='start')return {reply:T(HELP_UZ,HELP_RU)};
if(name==='esla'){
const i=arg.indexOf('=');
const k=clean(i<0?'':arg.slice(0,i),100),v=clean(i<0?'':arg.slice(i+1),500);
if(!k||!v||keyOf(k).length<2)return {reply:T('Shunday yozing: /esla mening mashinam = Nexia 3','Пишите так: /esla моя машина = Nexia 3')};
const items=memAll(uid);
const same=items.find(x=>keyOf(x.k)===keyOf(k));
if(same){sdb.prepare('UPDATE mem SET v=?,ts=? WHERE id=? AND uid=?').run(enc(uid,v),now,same.id,uid);return {reply:T('Yangiladim ✓','Обновил ✓')};}
if(items.length>=MEM_MAX)return {reply:T('Xotira to‘ldi (200 ta). Ba’zilarini /unut bilan o‘chiring.','Память заполнена (200). Удалите часть через /unut.')};
sdb.prepare('INSERT INTO mem(uid,ts,k,v) VALUES(?,?,?,?)').run(uid,now,enc(uid,k),enc(uid,v));
return {reply:T('Eslab qoldim ✓','Запомнил ✓')};
}
if(name==='xotira'){
const items=memAll(uid);
if(!items.length)return {reply:T('Xotira bo‘sh. /esla kalit = qiymat','Память пуста. /esla ключ = значение')};
return {reply:items.map((x,i)=>(i+1)+'. '+x.k+' = '+x.v).join('\n')};
}
if(name==='unut'){
if(/^(hammasi|все|всё)$/i.test(arg)){sdb.prepare('DELETE FROM mem WHERE uid=?').run(uid);return {reply:T('Xotira tozalandi ✓','Память очищена ✓')};}
const n=parseInt(arg,10),items=memAll(uid);
if(!n||n<1||n>items.length)return {reply:T('Raqamni yozing: /unut 2 (ro‘yxat: /xotira)','Укажите номер: /unut 2 (список: /xotira)')};
sdb.prepare('DELETE FROM mem WHERE id=? AND uid=?').run(items[n-1].id,uid);
return {reply:T('O‘chirildi ✓','Удалено ✓')};
}
if(name==='eslat'){
const w=parseWhen(arg,tz,now);
if(!w)return {reply:T('Shunday yozing:\n/eslat 21:30 dori ichish\n/eslat 25.10 09:00 matn\n/eslat 2 soat matn','Пишите так:\n/eslat 21:30 принять лекарство\n/eslat 25.10 09:00 текст\n/eslat 2 soat текст')};
const txt=clean(w.rest,300);
if(!txt||w.due<=now||w.due>now+366*86400000)return {reply:T('Vaqt o‘tib ketgan yoki juda uzoq (1 yilgacha bo‘lsin).','Время уже прошло или слишком далеко (максимум год).')};
if(sdb.prepare('SELECT COUNT(*) c FROM rem WHERE uid=? AND sent=0').get(uid).c>=50)return {reply:T('Kutilayotgan eslatmalar 50 tadan oshmasin.','Ожидающих напоминаний не больше 50.')};
sdb.prepare('INSERT INTO rem(uid,due,created,t) VALUES(?,?,?,?)').run(uid,w.due,now,enc(uid,txt));
return {reply:T('Eslatma qo‘yildi ✓ ','Напоминание поставлено ✓ ')+fmt(w.due,tz)+' — '+txt};
}
if(name==='royxat'){
const l=remList(uid);
if(!l.length)return {reply:T('Kutilayotgan eslatma yo‘q.','Ожидающих напоминаний нет.')};
return {reply:l.map((x,i)=>(i+1)+'. '+fmt(x.due,tz)+' — '+x.t).join('\n')};
}
if(name==='ochir'){
const n=parseInt(arg,10),l=remList(uid);
if(!n||n<1||n>l.length)return {reply:T('Raqamni yozing: /ochir 2 (ro‘yxat: /royxat)','Укажите номер: /ochir 2 (список: /royxat)')};
sdb.prepare('DELETE FROM rem WHERE id=? AND uid=?').run(l[n-1].id,uid);
return {reply:T('Eslatma bekor qilindi ✓','Напоминание отменено ✓')};
}
if(name==='tozala'){
sdb.prepare('DELETE FROM msgs WHERE uid=?').run(uid);
return {reply:T('Suhbat tarixi o‘chirildi ✓','История чата очищена ✓'),clear:true};
}
return {reply:T('Noma‘lum buyruq. /yordam','Неизвестная команда. /yordam')};
}

// --- eslatma yuboruvchi (har 20 soniyada) va zaxira nusxa ---
async function pushTo(uid,body){
const toks=await db.collection('users').doc(uid).collection('tokens').get();
for(const t of toks.docs){
const token=t.data().token||t.id;
try{await getMessaging().send({token,notification:{title:'PLDN Bot',body},data:{kind:'bot'},android:{notification:{tag:'bot-reminder'}}});}
catch(e){if(String(e.code).includes('registration-token'))await t.ref.delete().catch(()=>{});else console.log('FCM xato:',e.message);}
}
}
function tick(){
const rows=sdb.prepare('SELECT id,uid,t FROM rem WHERE sent=0 AND due<=? ORDER BY due ASC LIMIT 50').all(Date.now());
for(const r of rows){
sdb.prepare('UPDATE rem SET sent=1 WHERE id=?').run(r.id);
const txt=dec(r.uid,r.t)||'';
try{addMsg(r.uid,'b','⏰ '+txt);}catch(e){console.error('eslatma xabari',e.message);}
pushTo(r.uid,PUSH_SHOW_TEXT?'⏰ '+txt:'⏰ Eslatmangiz bor').catch(e=>console.log('push xato:',e.message));
}
}
setInterval(()=>{try{tick();}catch(e){console.error('tick',e.message);}},20000);
const BK=__dirname+'/backup';
fs.mkdirSync(BK,{recursive:true});
async function backup(){
try{
const d=new Date().toISOString().slice(0,10);
await sdb.backup(BK+'/bot-'+d+'.db');
const old='bot-'+new Date(Date.now()-7*86400000).toISOString().slice(0,10)+'.db';
for(const f of fs.readdirSync(BK))if(/^bot-\d{4}-\d\d-\d\d\.db$/.test(f)&&f<old)fs.unlinkSync(BK+'/'+f);
sdb.prepare('DELETE FROM rem WHERE sent=1 AND due<?').run(Date.now()-7*86400000);
console.log('zaxira nusxa:',d);
}catch(e){console.error('zaxira xato',e.message);}
}
setTimeout(backup,15000);
setInterval(backup,86400000);

// ---------- himoya: token va tezlik chegarasi ----------
const hits=new Map();
function limited(uid,kind,max,ms){
const k=kind+':'+uid,now=Date.now();
const a=(hits.get(k)||[]).filter(t=>now-t<ms);
if(a.length>=max){hits.set(k,a);return true;}
a.push(now);hits.set(k,a);return false;
}
setInterval(()=>{const now=Date.now();for(const [k,a] of hits){const f=a.filter(t=>now-t<3600000);if(f.length)hits.set(k,f);else hits.delete(k);}},600000).unref();
async function auth(req,res,next){
const m=(req.get('Authorization')||'').match(/^Bearer (.+)$/);
if(!m)return res.status(401).json({error:'Kirish kerak'});
try{req.uid=(await getAuth().verifyIdToken(m[1])).uid;next();}
catch(e){res.status(401).json({error:'Kirish tasdiqlanmadi'});}
}

// ---------- HTTP ----------
const app=express();
app.use(express.json({limit:'16kb'}));
app.use((req,res,next)=>{res.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'POST,GET,OPTIONS'});if(req.method==='OPTIONS')return res.sendStatus(204);next();});
app.get('/',(q,r)=>r.send('PLDN qidiruv ishlayapti: '+KB.length));

app.get('/search',auth,(req,res)=>{
if(limited(req.uid,'s',30,60000))return res.status(429).json({error:'Juda tez-tez so‘rayapsiz. Biroz kuting.'});
const q=clean(req.query.q,300);
try{
const mem=recall(req.uid,q);
if(mem)return res.json({status:'answer',score:+mem.score.toFixed(3),second:0,key:'mem',q:mem.item.k,mem:true,answers:[{t:mem.item.v,lang:null}]});
}catch(e){console.error('recall',e.message);}
const r=search(q);
if(r.status==='none'&&q.length>=3){
const key=keyOf(q);
if(key.length>=3)db.collection('botUnanswered').doc(key).set({q,key,count:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true}).catch(e=>console.error('unans',e.message));
}
res.json(r);
});

app.post('/teach',auth,async(req,res)=>{
if(limited(req.uid,'t',5,3600000))return res.status(429).json({error:'Soatiga 5 tagacha javob yuborish mumkin. Keyinroq urinib ko‘ring.'});
const b=req.body||{};
const q=clean(b.q,300);
const t=String(b.t||'').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g,' ').trim().slice(0,1500);
const lang=b.lang==='ru'?'ru':'uz';
if(keyOf(q).length<3||!t)return res.status(400).json({error:'Savol yoki javob noto‘g‘ri'});
try{
await db.collection('botPending').add({q,key:keyOf(q),t,lang,by:req.uid,at:Date.now()});
res.json({ok:true});
}catch(e){console.error('teach',e.message);res.status(500).json({error:'Server xatosi'});}
});

app.post('/cmd',auth,(req,res)=>{
if(limited(req.uid,'c',30,60000))return res.status(429).json({error:'Juda tez-tez yozayapsiz. Biroz kuting.'});
const b=req.body||{};
let tz=Math.round(+b.tz);
if(!isFinite(tz)||Math.abs(tz)>840)tz=300;
try{res.json(runCmd(req.uid,String(b.text||'').slice(0,2000),b.lang==='ru'?'ru':'uz',tz));}
catch(e){console.error('cmd',e.message);res.status(500).json({error:'Server xatosi'});}
});

app.get('/hist',auth,(req,res)=>{
const limit=Math.min(Math.max(parseInt(req.query.limit,10)||40,1),100);
const before=parseInt(req.query.before,10)||0;
try{res.json({msgs:getMsgs(req.uid,before,limit)});}
catch(e){console.error('hist',e.message);res.status(500).json({error:'Server xatosi'});}
});

app.post('/hist',auth,(req,res)=>{
if(limited(req.uid,'h',60,60000))return res.status(429).json({error:'Juda tez-tez'});
const items=Array.isArray(req.body&&req.body.items)?req.body.items.slice(0,4):[];
try{for(const it of items)addMsg(req.uid,it&&it.who,it&&it.t);res.json({ok:true});}
catch(e){console.error('hist yozish',e.message);res.status(500).json({error:'Server xatosi'});}
});

app.listen(3001,'127.0.0.1',()=>console.log('3001-portda qidiruv (v3)'));
// END
                                                                                                                  
