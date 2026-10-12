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

// One row per player per scope ('all' or the JST date). Rank = higher score, then more perfects, then earlier.
const AFTER='(excluded.sc>sc OR (excluded.sc=sc AND excluded.pf>pf))';
const UPSERT=`INSERT INTO scores(scope,h,name,sc,pf,mc,cnt,at) VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(scope,h) DO UPDATE SET name=excluded.name,
  sc=CASE WHEN ${AFTER} THEN excluded.sc ELSE sc END, pf=CASE WHEN ${AFTER} THEN excluded.pf ELSE pf END,
  mc=CASE WHEN ${AFTER} THEN excluded.mc ELSE mc END, cnt=CASE WHEN ${AFTER} THEN excluded.cnt ELSE cnt END,
  at=CASE WHEN ${AFTER} THEN excluded.at ELSE at END`;
async function rankOf(db,scope,h){
 const me=await db.prepare('SELECT sc,pf,at FROM scores WHERE scope=? AND h=?').bind(scope,h).first();if(!me)return 0;
 const r=await db.prepare('SELECT COUNT(*) AS n FROM scores WHERE scope=? AND (sc>? OR (sc=? AND pf>?) OR (sc=? AND pf=? AND at<?))').bind(scope,me.sc,me.sc,me.pf,me.sc,me.pf,me.at).first();
 return r.n+1}

export async function onRequest({request,env}){
 const u=new URL(request.url),p=u.pathname.replace(/^\/api\//,''),db=env.DB;
 if(!db)return J({error:'no-db'},503);
 if(p==='start'&&request.method==='GET'){const ts=Date.now();return J({t:ts+'.'+await sign(env.SECRET||'dev',String(ts))})}
 if(p==='rank'&&request.method==='GET'){
  const sc=u.searchParams.get('scope')==='all'?'all':'day',ck=new Request(u.origin+'/api/rank?scope='+sc+'&d='+day()),hit=u.searchParams.get('fresh')?null:await caches.default.match(ck);
  if(hit)return hit;
  const{results}=await db.prepare('SELECT name AS n,sc,pf,mc,h FROM scores WHERE scope=? ORDER BY sc DESC,pf DESC,at ASC LIMIT 100').bind(sc==='all'?'all':day()).all();
  const res=new Response(JSON.stringify({items:results.map((x,i)=>({r:i+1,...x}))}),{headers:{'content-type':'application/json','cache-control':'public, max-age=10'}});
  await caches.default.put(ck,res.clone());return res}
 if(p==='me'&&request.method==='GET'){ // my own rank (not cached), for the "you are #n" card
  const scope=u.searchParams.get('scope')==='all'?'all':day(),h=String(u.searchParams.get('h')||'');
  if(!/^[0-9a-f]{16}$/.test(h))return J({error:'h'},400);
  const row=await db.prepare('SELECT name AS n,sc,pf,mc FROM scores WHERE scope=? AND h=?').bind(scope,h).first();
  return J(row?{registered:true,r:await rankOf(db,scope,h),...row}:{registered:false})}
 if(p==='score'&&request.method==='POST'){
  const b=await request.json().catch(()=>null);if(!b)return J({error:'bad'},400);
  const name=Array.from(String(b.name||'').replace(/[\u0000-\u001f<>&"'`]/g,'').trim()).slice(0,10).join('');
  if(!name)return J({error:'name'},400);if(isBad(name))return J({error:'ng'},400);
  if(!/^[a-z0-9]{8,32}$/.test(String(b.pid||'')))return J({error:'pid'},400);
  const c=+b.count,pf=+b.perf,mc=+b.maxC;
  if(![c,pf,mc].every(Number.isInteger)||c<0||c>45||pf<0||pf>c||mc<0||mc>c)return J({error:'range'},400);
  if(env.SECRET){ // token from /api/start: must be 55s..30min old, single use
   const[ts,sig]=String(b.t||'').split('.'),age=Date.now()-(+ts);
   if(!ts||!sig||!(age>55e3&&age<18e5)||sig!==await sign(env.SECRET,ts))return J({error:'token'},400);
   const r=await db.prepare('INSERT OR IGNORE INTO used_tokens(sig,at) VALUES(?,?)').bind(sig,Date.now()).run();
   if(!r.meta.changes)return J({error:'used'},400)}
  const h=(await sha(b.pid)).slice(0,16),sc=c*1000+pf*500+mc*200,now=Date.now(),d=day(),up=db.prepare(UPSERT);
  await db.batch([up.bind('all',h,name,sc,pf,mc,c,now),up.bind(d,h,name,sc,pf,mc,c,now),
   db.prepare("DELETE FROM scores WHERE scope<>'all' AND scope<?").bind(jst(7)),db.prepare('DELETE FROM used_tokens WHERE at<?').bind(now-36e5)]);
  return J({all:await rankOf(db,'all',h),day:await rankOf(db,d,h)})}
 return J({error:'not-found'},404)}
