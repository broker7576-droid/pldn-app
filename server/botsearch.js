// VERSION: search-v6.2 (javob uzunligi cheklovi olib tashlandi: 600 belgi va 250 token; javob uzilsa ham server oxirigacha yozib tarixga saqlaydi; chegaraga yetsa 'davom et' belgisi) (v5 + shaxsiy xotira sozlamalari /mem /prefs, avtomatik fakt ajratish, ertangi kuzatuv /followup, chuqur rejim, tarix o'chmaydi, /oyrat /xotira /unut /tozala olib tashlandi) | satr: 534
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
CREATE TABLE IF NOT EXISTS prefs(uid TEXT NOT NULL,k TEXT NOT NULL,v TEXT NOT NULL,PRIMARY KEY(uid,k));
CREATE TABLE IF NOT EXISTS fol(id INTEGER PRIMARY KEY AUTOINCREMENT,uid TEXT NOT NULL,ts INTEGER NOT NULL,kind TEXT NOT NULL,state INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS fol_u ON fol(uid,state,ts);
`);
const ukeys=new Map();
function ukey(uid){let k=ukeys.get(uid);if(!k){k=Buffer.from(crypto.hkdfSync('sha256',MASTER,Buffer.alloc(0),'pldn-bot:'+uid,32));if(ukeys.size>500)ukeys.clear();ukeys.set(uid,k);}return k;}
function enc(uid,s){const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',ukey(uid),iv);c.setAAD(Buffer.from(uid));const ct=Buffer.concat([c.update(String(s),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),ct]);}
function dec(uid,b){try{const iv=b.subarray(0,12),tag=b.subarray(12,28),ct=b.subarray(28);const d=crypto.createDecipheriv('aes-256-gcm',ukey(uid),iv);d.setAAD(Buffer.from(uid));d.setAuthTag(tag);return Buffer.concat([d.update(ct),d.final()]).toString('utf8');}catch(e){return null;}}

// --- suhbat tarixi ---
// tarix hech qachon o'zi o'chmaydi (v6)
function addMsg(uid,who,t){
t=String(t||'').slice(0,2000);if(!t)return;
sdb.prepare('INSERT INTO msgs(uid,ts,who,enc) VALUES(?,?,?,?)').run(uid,Date.now(),who==='b'?'b':'u',enc(uid,t));
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

const HELP_UZ='Buyruqlar:\n/esla kalit = qiymat — eslab qolaman\n/eslat 21:30 matn\n/eslat 25.10 09:00 matn\n/eslat 2 soat matn (yoki daqiqa, kun)\n/royxat — eslatmalar ro‘yxati\n/ochir 2 — eslatmani bekor qilish\n/ai savol — robot bilan erkin suhbat\n\nXotirani ko‘rish va o‘chirish: robot menyusi → Sozlamalar.';
const HELP_RU='Команды:\n/esla ключ = значение — запомню\n/eslat 21:30 текст\n/eslat 25.10 09:00 текст\n/eslat 2 soat текст (или daqiqa, kun)\n/royxat — список напоминаний\n/ochir 2 — отменить напоминание\n/ai вопрос — свободный разговор с роботом\n\nПросмотр и удаление памяти: меню робота → Настройки.';
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
if(items.length>=MEM_MAX)return {reply:T('Xotira to‘ldi (200 ta). Ba’zilarini robot sozlamalarida o‘chiring.','Память заполнена (200). Удалите часть в настройках робота.')};
sdb.prepare('INSERT INTO mem(uid,ts,k,v) VALUES(?,?,?,?)').run(uid,now,enc(uid,k),enc(uid,v));
return {reply:T('Eslab qoldim ✓','Запомнил ✓')};
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
return {reply:T('Noma‘lum buyruq. /yordam','Неизвестная команда. /yordam')};
}


// ---------- v6: sozlamalar, avtomatik fakt ajratish, ertangi kuzatuv ----------
function prefGet(uid,k,d){const r=sdb.prepare('SELECT v FROM prefs WHERE uid=? AND k=?').get(uid,k);return r?r.v:d;}
function prefSet(uid,k,v){sdb.prepare('INSERT INTO prefs(uid,k,v) VALUES(?,?,?) ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v').run(uid,k,String(v));}
function memRows(uid){return sdb.prepare('SELECT id,ts,k,v FROM mem WHERE uid=? ORDER BY id DESC').all(uid).map(r=>({id:r.id,ts:r.ts,k:dec(uid,r.k)||'',v:dec(uid,r.v)||''}));}
function memPut(uid,k,v){
k=clean(k,100);v=clean(v,500);
if(!k||!v||keyOf(k).length<2)return false;
const items=memAll(uid);
const same=items.find(x=>keyOf(x.k)===keyOf(k));
const now=Date.now();
if(same){if(same.v===v)return true;sdb.prepare('UPDATE mem SET v=?,ts=? WHERE id=? AND uid=?').run(enc(uid,v),now,same.id,uid);return true;}
if(items.length>=MEM_MAX)return false;
sdb.prepare('INSERT INTO mem(uid,ts,k,v) VALUES(?,?,?,?)').run(uid,now,enc(uid,k),enc(uid,v));
return true;
}
// foydalanuvchi o'zi aytgan faktlarni qoidalar bilan ajratish (LLM ishlatilmaydi: CPU tejash uchun)
const LEARN=[
[/(?:mening\s+)?ismim\s+([\p{L}]{2,20})/u,m=>['mening ismim',m[1]]],
[/меня зовут\s+([\p{L}]{2,20})/u,m=>['меня зовут',m[1]]],
[/(?:mening\s+)?yoshim\s+(\d{1,2})(?!\d)/u,m=>['mening yoshim',m[1]+' yosh']],
[/мне\s+(\d{1,2})\s+(?:лет|года|год)/u,m=>['мой возраст',m[1]]],
[/men\s+([\p{L} ]{2,25}?)\s*(?:da|dan|shahrida|viloyatida)\s+yashayman/u,m=>['men yashaydigan joy',m[1]]],
[/я живу в\s+([\p{L} -]{2,25})/u,m=>['я живу',m[1]]],
[/men\s+([\p{L} ]{2,30}?)\s*(?:da|dagi|ida)\s+ishlayman/u,m=>['men ishlaydigan joy',m[1]]],
[/(?:men\s+)?([\p{L} ]{2,30}?)ni\s+yoqtiraman/u,m=>['men yoqtiraman: '+m[1],m[1]]],
[/(?:men\s+)?([\p{L} ]{2,30}?)ni\s+yoqtirmayman/u,m=>['men yoqtirmayman: '+m[1],m[1]]],
[/я люблю\s+([\p{L} ]{2,30})/u,m=>['я люблю: '+m[1],m[1]]]
];
const MOOD_BAD=[/kayfiyat(?:im)?\s+(?:juda\s+|ancha\s+)?(?:yomon|past|yoq|buzuq)/u,/настроени[еяю]\s+(?:у меня\s+)?(?:плох|паршив|ужасн|никак)/u,/плохо[ей]\s+настроени/u,/мне\s+грустно|я\s+расстроен/u];
const CAPK=new Set(['mening ismim','меня зовут','men yashaydigan joy','я живу','men ishlaydigan joy']);
function cap(v){return String(v).replace(/(^|\s)(\p{L})/gu,(m,a,b)=>a+b.toUpperCase());}
function lcText(t){return String(t||'').toLowerCase().replace(/[\u02bb\u02bc\u2018\u2019\u0060\u00b4']/g,'').replace(/\s+/g,' ').trim();}
function learn(uid,text){
try{
const lc=lcText(text);
if(!lc||lc[0]==='/')return;
if(prefGet(uid,'auto','1')==='1'){
for(const [re,fn] of LEARN){const m=lc.match(re);if(m){const kv=fn(m);if(kv)memPut(uid,kv[0],CAPK.has(kv[0])?cap(kv[1]):kv[1]);}}
}
if(prefGet(uid,'fol','1')==='1'&&MOOD_BAD.some(re=>re.test(lc))){
const recent=sdb.prepare("SELECT id FROM fol WHERE uid=? AND kind='mood_bad' AND state=0 AND ts>?").get(uid,Date.now()-20*3600000);
if(!recent)sdb.prepare('INSERT INTO fol(uid,ts,kind) VALUES(?,?,?)').run(uid,Date.now(),'mood_bad');
}
}catch(e){console.error('learn',e.message);}
}
function localMidnight(now,tz){const d=new Date(now+tz*60000);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-tz*60000;}

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

// ---------- LLM (llama.cpp) — faqat shu serverning ichida, tashqariga ochilmaydi ----------
const LLM_URL=process.env.LLM_URL||'http://127.0.0.1:8080';
const MAXTOK=parseInt(process.env.LLM_MAXTOK,10)||1500; // amalda cheklov yo'q: javob uzunligini llama-server kontekst oynasi (-c) belgilaydi
const DEEP_ON=process.env.DEEP_THINK!=='0';                 // chuqur rejim: xuddi shu savol 2-marta berilganda o'ylash yoqiladi
const DEEP_MAXTOK=parseInt(process.env.DEEP_MAXTOK,10)||1500; // chuqur rejimda o'ylash + javob uchun umumiy token chegarasi
const SYS_UZ="Sen PLDN robotisan. Do'stona va samimiy gapir. Odatda qisqa (1-2 gap) javob ber, lekin foydalanuvchi batafsil so'rasa, to'liq tushuntir. Faqat oddiy o'zbek tilida javob ber, murakkab so'z ishlatma. Ba'zan yengil hazil qil. Bilmasang, o'ylab topma: \"Bilmayman\" de.";
const FEW=[
{role:'user',content:'Salom'},{role:'assistant',content:'Salom! Qalaysan, bugun nima yangilik?'},
{role:'user',content:"Kayfiyatim yo'q"},{role:'assistant',content:"Voy, nima bo'ldi? Xohlasang gaplashib ber, yoki yoqimli narsa haqida gaplashamiz."},
{role:'user',content:'Ob-havo yomon'},{role:'assistant',content:'Ha, bunday kunda uyda issiq choy ichib, film ko\'rish yaxshi. Sen nima qilmoqchisan?'}
];
const nameCache=new Map();
async function userName(uid){
const c=nameCache.get(uid);
if(c&&Date.now()-c.t<600000)return c.n;
let n='';
try{const d=await db.collection('users').doc(uid).get();n=d.exists?clean(d.data().firstName,30):'';}catch(e){}
if(nameCache.size>500)nameCache.clear();
nameCache.set(uid,{t:Date.now(),n});
return n;
}
function histForLLM(uid,n){
const h=getMsgs(uid,0,12).filter(m=>m.t&&m.t[0]!=='/'&&m.t.indexOf('✓')<0&&m.t.indexOf('⏰')<0&&!/o‘rganilmagan|не выучен|Shuni nazarda tutdingizmi/.test(m.t));
return h.slice(-(n||4)).map(m=>({role:m.who==='u'?'user':'assistant',content:String(m.t).slice(0,220)}));
}
// savolga eng mos 3-5 ta fakt (hammasi emas: prompt qisqa bo'lsin, CPU'da tez ishlasin)
function factsFor(uid,text,n){
const items=memAll(uid);if(!items.length)return [];
const t=mtoks(text);const qv=t.length?vec(t):null;
const sc=items.map((m,i)=>{let s=0;const mt=mtoks(m.k+' '+m.v);if(qv&&mt.length)s=cos(qv,vec(mt));if(/ism|имя|зовут/i.test(m.k))s+=0.15;return {m,s,i};});
sc.sort((a,b)=>b.s-a.s||b.i-a.i);
return sc.filter(x=>x.s>0).slice(0,n).map(x=>x.m);
}
// o'zgarmas boshlanish (SYS+FEW) keshda qoladi; fakt/kontekst oxirgi xabar oldiga qo'yiladi
async function buildMessages(uid,text,o){
o=o||{};
let pre='';
try{
const nm=await userName(uid);
const fs=factsFor(uid,text,o.deep?8:4).map(x=>clean(x.k,40)+': '+clean(x.v,80));
if(nm)pre+='Foydalanuvchi ismi: '+nm+'. ';
if(fs.length)pre+='U haqida bilganlaring: '+fs.join('; ')+'. ';
}catch(e){console.error('prompt',e.message);}
if(o.ctx&&o.ctx.length)pre+='Bilimlar bazasidan ma’lumot: '+o.ctx.join(' | ')+' — shunga tayanib, o‘zingcha tabiiy javob ber. ';
if(o.deep)pre+='Foydalanuvchi bu savolni qayta berdi: oldingi javob yetarli bo‘lmagan. Chuqurroq o‘ylab, aniq va to‘liq javob ber. ';
const content=pre?('['+pre.trim()+']\n'+text):text;
return [{role:'system',content:SYS_UZ}].concat(FEW,histForLLM(uid,o.deep?8:4),[{role:'user',content}]);
}
function tidy(s,fin){
s=String(s||'').replace(/<think>[\s\S]*?<\/think>/g,'').replace(/^\s*(Robot|PLDN)\s*:\s*/i,'').trim();
if(fin==='length'){const i=Math.max(s.lastIndexOf('.'),s.lastIndexOf('!'),s.lastIndexOf('?'));if(i>=15)s=s.slice(0,i+1);}
return s.slice(0,20000);
}
async function callLLM(messages){
const ctl=new AbortController();
const tm=setTimeout(()=>ctl.abort(),150000);
try{
const r=await fetch(LLM_URL+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctl.signal,body:JSON.stringify({messages,max_tokens:MAXTOK,temperature:0.5,top_p:0.9,repeat_penalty:1.1,cache_prompt:true,chat_template_kwargs:{enable_thinking:false}})});
if(!r.ok)throw new Error('llm http '+r.status);
const j=await r.json();
const c=j.choices&&j.choices[0];
return tidy(c&&c.message&&c.message.content,c&&c.finish_reason);
}finally{clearTimeout(tm);}
}
// protsessor kam: so'rovlar navbat bilan bajariladi, 3 tadan ortig'i "band" deb qaytariladi
let llmChain=Promise.resolve(),llmWait=0;
function llmQueue(fn){
if(llmWait>=3){const e=new Error('band');e.busy=true;return Promise.reject(e);}
llmWait++;
const p=llmChain.then(fn).finally(()=>{llmWait--;});
llmChain=p.catch(()=>{});
return p;
}
function askLLM(messages){return llmQueue(()=>callLLM(messages));}
// oqim: llama.cpp'dan kelgan har bir bo'lakni onDelta ga beradi, tugagach finish_reason qaytaradi
async function streamLLM(messages,onDelta,signal,o){
o=o||{};
const r=await fetch(LLM_URL+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({messages,max_tokens:o.maxtok||MAXTOK,temperature:o.think?0.6:0.5,top_p:0.9,repeat_penalty:1.1,stream:true,cache_prompt:true,chat_template_kwargs:{enable_thinking:!!o.think}})});
if(!r.ok)throw new Error('llm http '+r.status);
const dec=new TextDecoder();
let buf='',fin='';
for await(const chunk of r.body){
buf+=dec.decode(chunk,{stream:true});
let i;
while((i=buf.indexOf('\n'))>=0){
const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
if(line.indexOf('data:')!==0)continue;
const d=line.slice(5).trim();
if(d==='[DONE]')return fin;
try{const j=JSON.parse(d);const c=j.choices&&j.choices[0];
if(c&&c.delta){if(c.delta.reasoning_content&&o.onThink)o.onThink();if(c.delta.content)onDelta(c.delta.content);}
if(c&&c.finish_reason)fin=c.finish_reason;}catch(e){}
}
}
return fin;
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

app.post('/cmd',auth,(req,res)=>{
if(limited(req.uid,'c',30,60000))return res.status(429).json({error:'Juda tez-tez yozayapsiz. Biroz kuting.'});
const b=req.body||{};
let tz=Math.round(+b.tz);
if(!isFinite(tz)||Math.abs(tz)>840)tz=300;
try{res.json(runCmd(req.uid,String(b.text||'').slice(0,2000),b.lang==='ru'?'ru':'uz',tz));}
catch(e){console.error('cmd',e.message);res.status(500).json({error:'Server xatosi'});}
});

app.post('/chat',auth,async(req,res)=>{
if(limited(req.uid,'ai',20,600000))return res.status(429).json({error:'Robot bilan juda tez-tez gaplashyapsiz. Biroz kuting.'});
const text=clean((req.body||{}).text,500);
if(!text)return res.status(400).json({error:'Matn bo‘sh'});
try{
const reply=await askLLM(await buildMessages(req.uid,text));
if(!reply)throw new Error('bo‘sh javob');
res.json({reply});
}catch(e){
console.error('chat',e.message);
if(e.busy)return res.status(503).json({error:'Robot hozir band, biroz keyin yozing.'});
res.status(503).json({error:'Robot hozir javob bera olmadi. Keyinroq urinib ko‘ring.'});
}
});

app.post('/chat/stream',auth,async(req,res)=>{
if(limited(req.uid,'ai',20,600000))return res.status(429).json({error:'Robot bilan juda tez-tez gaplashyapsiz. Biroz kuting.'});
const b=req.body||{};
const text=clean(b.text,500);
if(!text)return res.status(400).json({error:'Matn bo‘sh'});
const deep=b.deep===true&&DEEP_ON;
const ctx=Array.isArray(b.ctx)?b.ctx.slice(0,2).map(x=>clean(x,300)).filter(Boolean):[];
if(llmWait>=3)return res.status(503).json({error:'Robot hozir band, biroz keyin yozing.'});
res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
const send=o=>{try{res.write('data: '+JSON.stringify(o)+'\n\n');}catch(e){}};
const ctl=new AbortController();
// mijoz (ilova) uzilsa ham javob oxirigacha yoziladi va tarixga saqlanadi
let closed=false;
res.on('close',()=>{closed=true;});
const tmo=setTimeout(()=>ctl.abort(),1800000);
const lang=b.lang==='ru'?'ru':'uz';
const CUT=lang==='ru'?'… (достигнут предел длины ответа. Напишите «продолжи», чтобы продолжить.)':'… (javob uzunligi chegarasiga yetdi. Davomi uchun «davom et» deb yozing.)';
let full='',raw='',fin='',thinkSent=0;
// <think>...</think> bloklari foydalanuvchiga ko'rsatilmaydi
const emit=d=>{
raw+=d;
const t=raw.replace(/^\s+/,'');
if(t.length<7&&'<think>'.indexOf(t)===0)return;
if(t.indexOf('<think>')===0){
const i=t.indexOf('</think>');
if(i<0){if(!thinkSent){thinkSent=1;send({think:1});}return;}
const after=t.slice(i+8).replace(/^\s+/,'');
if(after.length>full.length){send({d:after.slice(full.length)});full=after;}
return;
}
full+=d;send({d});
};
const run=async(think,maxtok,messages)=>{
full='';raw='';thinkSent=0;
fin=await streamLLM(messages,emit,ctl.signal,{think,maxtok,onThink:()=>{if(!thinkSent){thinkSent=1;send({think:1});}}});
};
try{
const messages=await buildMessages(req.uid,text,{deep,ctx});
await llmQueue(async()=>{
if(ctl.signal.aborted)return;
await run(deep,deep?DEEP_MAXTOK:MAXTOK,messages);
if(!full.trim()&&deep&&!ctl.signal.aborted){send({think:0});await run(false,MAXTOK,messages);}
});
const finalText=tidy(full,fin),cut=fin==='length';
const lost=closed;
if(full)send({done:true,text:finalText,cut});
else send({error:'Robot hozir javob bera olmadi. Keyinroq urinib ko‘ring.'});
if(lost&&finalText){addMsg(req.uid,'u',text);addMsg(req.uid,'b',finalText+(cut?'\n\n'+CUT:''));learn(req.uid,text);}
}catch(e){
console.error('chat/stream',e.message);
if(full){const ft=tidy(full,'length');const lost2=closed;send({done:true,text:ft,cut:true});if(lost2&&ft){addMsg(req.uid,'u',text);addMsg(req.uid,'b',ft+'\n\n'+CUT);learn(req.uid,text);}}
else send({error:e.busy?'Robot hozir band, biroz keyin yozing.':'Robot hozir javob bera olmadi. Keyinroq urinib ko‘ring.'});
}finally{clearTimeout(tmo);try{res.end();}catch(e){}}
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
try{for(const it of items){addMsg(req.uid,it&&it.who,it&&it.t);if(it&&it.who==='u')learn(req.uid,it.t);}res.json({ok:true});}
catch(e){console.error('hist yozish',e.message);res.status(500).json({error:'Server xatosi'});}
});


// ---------- v6: robot sozlamalari (xotira, sozlamalar, kuzatuv) ----------
app.get('/mem',auth,(req,res)=>{
try{res.json({items:memRows(req.uid)});}
catch(e){console.error('mem',e.message);res.status(500).json({error:'Server xatosi'});}
});
app.post('/mem',auth,(req,res)=>{
if(limited(req.uid,'m',30,60000))return res.status(429).json({error:'Juda tez-tez'});
const b=req.body||{};
try{
if(b.clear===true){sdb.prepare('DELETE FROM mem WHERE uid=?').run(req.uid);return res.json({ok:true});}
const id=parseInt(b.del,10);
if(id){sdb.prepare('DELETE FROM mem WHERE id=? AND uid=?').run(id,req.uid);return res.json({ok:true});}
if(!memPut(req.uid,b.k,b.v))return res.status(400).json({error:'Nom/qiymat noto‘g‘ri yoki xotira to‘lgan'});
res.json({ok:true});
}catch(e){console.error('mem',e.message);res.status(500).json({error:'Server xatosi'});}
});
app.get('/prefs',auth,(req,res)=>{
try{res.json({auto:prefGet(req.uid,'auto','1')==='1',fol:prefGet(req.uid,'fol','1')==='1'});}
catch(e){res.status(500).json({error:'Server xatosi'});}
});
app.post('/prefs',auth,(req,res)=>{
const b=req.body||{};
try{
if(typeof b.auto==='boolean')prefSet(req.uid,'auto',b.auto?'1':'0');
if(typeof b.fol==='boolean')prefSet(req.uid,'fol',b.fol?'1':'0');
res.json({auto:prefGet(req.uid,'auto','1')==='1',fol:prefGet(req.uid,'fol','1')==='1'});
}catch(e){res.status(500).json({error:'Server xatosi'});}
});
app.get('/followup',auth,(req,res)=>{
let tz=Math.round(+req.query.tz);if(!isFinite(tz)||Math.abs(tz)>840)tz=300;
try{
if(prefGet(req.uid,'fol','1')!=='1')return res.json({});
const mid=localMidnight(Date.now(),tz);
const r=sdb.prepare('SELECT id,ts,kind FROM fol WHERE uid=? AND state=0 AND ts<? AND ts>? ORDER BY ts DESC LIMIT 1').get(req.uid,mid,mid-3*86400000);
if(!r)return res.json({});
const days=Math.max(1,Math.round((mid-localMidnight(r.ts,tz))/86400000));
res.json({item:{id:r.id,kind:r.kind,days}});
}catch(e){console.error('followup',e.message);res.status(500).json({error:'Server xatosi'});}
});
app.post('/followup',auth,(req,res)=>{
const id=parseInt((req.body||{}).id,10);
try{if(id)sdb.prepare('UPDATE fol SET state=1 WHERE id=? AND uid=?').run(id,req.uid);res.json({ok:true});}
catch(e){res.status(500).json({error:'Server xatosi'});}
});

app.listen(3001,'127.0.0.1',()=>console.log('3001-portda qidiruv (v6, LLM: '+LLM_URL+')'));
// END
                                                                                                                  
