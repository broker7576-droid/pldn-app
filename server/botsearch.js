// VERSION: search-v2 (token tekshiruvi, javobsiz savollar, /teach)
const express=require('express');
const {initializeApp,cert}=require('firebase-admin/app');
const {getFirestore,FieldValue}=require('firebase-admin/firestore');
const {getAuth}=require('firebase-admin/auth');
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
app.use(express.json({limit:'8kb'}));
app.use((req,res,next)=>{res.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'POST,GET,OPTIONS'});if(req.method==='OPTIONS')return res.sendStatus(204);next();});
app.get('/',(q,r)=>r.send('PLDN qidiruv ishlayapti: '+KB.length));

app.get('/search',auth,(req,res)=>{
if(limited(req.uid,'s',30,60000))return res.status(429).json({error:'Juda tez-tez so‘rayapsiz. Biroz kuting.'});
const q=clean(req.query.q,300);
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

app.listen(3001,'127.0.0.1',()=>console.log('3001-portda qidiruv (v2)'));
               
