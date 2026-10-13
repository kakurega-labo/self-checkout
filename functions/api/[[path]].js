// Cloudflare Pages Functions: /api/start, /api/rank, /api/score  (D1 version)
// Needs: D1 binding named DB (tables: see schema.sql), and (recommended) a secret named SECRET.
const BAD=['しね','死ね','ころす','殺す','ばか','あほ','ちんこ','ちんぽ','まんこ','おっぱい','うんこ','くそ','自殺','きちがい','せっくす','ふぁっく','れいぷ','fuck','shit','sex','nazi','porn','rape','nigger'];
const enc=new TextEncoder();
const norm=s=>s.normalize('NFKC').toLowerCase().replace(/[\s_\-.*・]+/g,'').replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96));
const isBad=s=>{const n=norm(s);return BAD.some(w=>n.includes(w))};
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const sha=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
async function sign(secret,msg){const k=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,enc.encode(msg))).slice(0,32)}
const jst=n=>new Date(Date.now()+324e5-n*864e5).toISOString().slice(0,10).replace(/-/g,''); // JST date, n days ago
const day=()=>jst(0);
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});

// Difficulty d = 1..4 (初級/中級/上級/超上級). Scope key: 中級(2) keeps the ORIGINAL keys ('all' / 'YYYYMMDD') so existing records need no migration; others are 'all:d' / 'YYYYMMDD:d'.
const SKEY=(b,d)=>d===2?b:b+':'+d;
const DOK=v=>[1,2,3,4].includes(+v)?+v:2,OPEN=[0,1,1,1,1],MAXP=[0,0,3980,7000,400000],YD=[0,0,4,4,50]; // MAXP: highest single price per shop (yen sanity check). YD: yen per point
const MISP=1000,calc=(d,c,pf,mc,y,x)=>Math.max(0,c*1000+pf*500+mc*200+(d>=3?Math.floor(y/YD[d]):0)-(d===4?x*MISP:0)); // 超上級は誤スキャン1回につき-1000
// One row per player per scope ('all:d' or 'JSTdate:d'). Rank = higher score, then more perfects, then earlier.
const AFTER='(excluded.sc>sc OR (excluded.sc=sc AND excluded.pf>pf))';
const UPSERT=`INSERT INTO scores(scope,h,name,sc,pf,mc,cnt,at) VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(scope,h) DO UPDATE SET name=excluded.name,
  sc=CASE WHEN ${AFTER} THEN excluded.sc ELSE sc END, pf=CASE WHEN ${AFTER} THEN excluded.pf ELSE pf END,
  mc=CASE WHEN ${AFTER} THEN excluded.mc ELSE mc END, cnt=CASE WHEN ${AFTER} THEN excluded.cnt ELSE cnt END,
  at=CASE WHEN ${AFTER} THEN excluded.at ELSE at END`;
// 卒業: 中級・上級でレジ名人(25000点)、超上級で55000点に届いた人は、初級に登録できない（既存の初級の記録は消さない）
const isGrad=async(db,h)=>!!await db.prepare("SELECT 1 AS x FROM scores WHERE scope IN ('all','all:3','all:4') AND h=? AND sc>=CASE scope WHEN 'all:4' THEN 55000 ELSE 25000 END LIMIT 1").bind(h).first();
// 初級のランキング(全期間)を、日本時間 2026-10-14 0:00 に一度だけ空にする。0時を過ぎて最初の初級の閲覧・登録のときに、それ以前の初級の記録を消す（0時以降の記録は残る）。数日後に、この3行と呼び出しは外してよい
const PURGE1=Date.UTC(2026,9,13,15,0,0);
const purge1=async db=>{if(Date.now()>=PURGE1)await db.prepare("DELETE FROM scores WHERE scope='all:1' AND at<?").bind(PURGE1).run()};
async function rankOf(db,scope,h){
 const me=await db.prepare('SELECT sc,pf,at FROM scores WHERE scope=? AND h=?').bind(scope,h).first();if(!me)return 0;
 const r=await db.prepare('SELECT COUNT(*) AS n FROM scores WHERE scope=? AND (sc>? OR (sc=? AND pf>?) OR (sc=? AND pf=? AND at<?))').bind(scope,me.sc,me.sc,me.pf,me.sc,me.pf,me.at).first();
 return r.n+1}

export async function onRequest({request,env}){
 const u=new URL(request.url),p=u.pathname.replace(/^\/api\//,''),db=env.DB;
 if(!db)return J({error:'no-db'},503);
 if(p==='start'&&request.method==='GET'){const ts=Date.now(),ok=await db.prepare('SELECT 1 AS x FROM scores LIMIT 1').first().then(()=>1,()=>0); // db:0 = データベースにつながらない（無料枠の超過など）。クライアントは登録欄を出さない
  return J({v:4,db:ok,t:ts+'.'+await sign(env.SECRET||'dev',String(ts))})}
 if(p==='rank'&&request.method==='GET'){
  const sc=u.searchParams.get('scope')==='all'?'all':'day',d=DOK(u.searchParams.get('d'));if(d===1)await purge1(db);const ck=new Request(u.origin+'/api/rank?scope='+sc+'&lv='+d+'&d='+day()),hit=u.searchParams.get('fresh')?null:await caches.default.match(ck);
  if(hit)return hit;
  const{results}=await db.prepare('SELECT name AS n,sc,pf,mc,h FROM scores WHERE scope=? ORDER BY sc DESC,pf DESC,at ASC LIMIT 100').bind(SKEY(sc==='all'?'all':day(),d)).all();
  const res=new Response(JSON.stringify({items:results.map((x,i)=>({r:i+1,...x}))}),{headers:{'content-type':'application/json','cache-control':'public, max-age=30'}});
  await caches.default.put(ck,res.clone());return res}
 if(p==='grad'&&request.method==='GET'){const h=String(u.searchParams.get('h')||'');if(!/^[0-9a-f]{16}$/.test(h))return J({error:'h'},400);return J({g:await isGrad(db,h)?1:0})}
 if(p==='me'&&request.method==='GET'){if(DOK(u.searchParams.get('d'))===1)await purge1(db); // my own rank (not cached), for the "you are #n" card
  const scope=SKEY(u.searchParams.get('scope')==='all'?'all':day(),DOK(u.searchParams.get('d'))),h=String(u.searchParams.get('h')||'');
  if(!/^[0-9a-f]{16}$/.test(h))return J({error:'h'},400);
  const row=await db.prepare('SELECT name AS n,sc,pf,mc FROM scores WHERE scope=? AND h=?').bind(scope,h).first();
  return J(row?{registered:true,r:await rankOf(db,scope,h),...row}:{registered:false})}
 if(p==='score'&&request.method==='POST'){
  const b=await request.json().catch(()=>null);if(!b)return J({error:'bad'},400);
  const name=Array.from(String(b.name||'').replace(/[\u0000-\u001f<>&"'`]/g,'').trim()).slice(0,10).join('');
  if(!name)return J({error:'name'},400);if(isBad(name))return J({error:'ng'},400);
  if(!/^[a-z0-9]{8,32}$/.test(String(b.pid||'')))return J({error:'pid'},400);
  const c=+b.count,pf=+b.perf,mc=+b.maxC,d=b.d===undefined?2:+b.d; // old clients send no d: treat as 中級
  if(![1,2,3,4].includes(d))return J({error:'diff'},400);
  if(!OPEN[d])return J({error:'locked'},403);
  if(d===1)await purge1(db);
  const x=d===4?(b.mx===undefined?0:+b.mx):0; // 誤スキャン回数（超上級のみ）
  const y=d>=3?(b.y===undefined?0:+b.y):0; // total yen (上級・超上級のみ得点に入る。中級は従来の式のまま)
  if(![c,pf,mc,y,x].every(Number.isInteger)||x<0||x>200||c<0||c>70||pf<0||pf>c||mc<0||mc>c||y<0||y>c*MAXP[d])return J({error:'range'},400);
  const h=(await sha(b.pid)).slice(0,16);
  if(d===1&&await isGrad(db,h))return J({error:'grad'},403);
  if(d===1&&Date.now()>=PURGE1&&calc(1,c,pf,mc,0,0)>=32000)return J({error:'cap'},403); // 初級はレジ名人(32000)未満のみ登録可
  if(env.SECRET){ // token from /api/start: must be 55s..30min old, single use
   const[ts,sig]=String(b.t||'').split('.'),age=Date.now()-(+ts);
   if(!ts||!sig||!(age>55e3&&age<18e5)||sig!==await sign(env.SECRET,ts))return J({error:'token'},400);
   const r=await db.prepare('INSERT OR IGNORE INTO used_tokens(sig,at) VALUES(?,?)').bind(sig,Date.now()).run();
   if(!r.meta.changes)return J({error:'used'},400)}
  const sc=calc(d,c,pf,mc,y,x),now=Date.now(),dy=day(),up=db.prepare(UPSERT),ka=SKEY('all',d),kd=SKEY(dy,d);
  // rows of earlier days in the 'today' scope are not kept (deleted below); 'all:d' rows stay
  await db.batch([up.bind(ka,h,name,sc,pf,mc,c,now),up.bind(kd,h,name,sc,pf,mc,c,now),
   db.prepare("DELETE FROM scores WHERE scope<?").bind(dy),db.prepare('DELETE FROM used_tokens WHERE at<?').bind(now-36e5)]);
  return J({all:await rankOf(db,ka,h),day:await rankOf(db,kd,h)})}
 return J({error:'not-found'},404)}
