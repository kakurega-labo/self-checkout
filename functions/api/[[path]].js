// Cloudflare Pages Functions: /api/start, /api/rank, /api/score
// Needs: KV binding named RANK, and (recommended) a secret named SECRET.
const BAD=['しね','死ね','ころす','殺す','ばか','あほ','ちんこ','ちんぽ','まんこ','おっぱい','うんこ','くそ','自殺','きちがい','せっくす','ふぁっく','れいぷ','fuck','shit','sex','nazi','porn','rape','nigger'];
const enc=new TextEncoder();
const norm=s=>s.normalize('NFKC').toLowerCase().replace(/[\s_\-.*・]+/g,'').replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96));
const isBad=s=>{const n=norm(s);return BAD.some(w=>n.includes(w))};
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const sha=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
async function sign(secret,msg){const k=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,enc.encode(msg))).slice(0,32)}
const day=()=>new Date(Date.now()+324e5).toISOString().slice(0,10).replace(/-/g,''); // JST date
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});

// One entry per player per scope. Key order = rank order (smaller key = better).
async function upsert(kv,scope,h,e,ttl){
 const inv=String(9999-Math.round(e.sc*2)).padStart(4,'0')+String(999-e.pf).padStart(3,'0'),pk='p:'+scope+':'+h,old=await kv.get(pk,'json');
 if(old&&old.inv<=inv)return old;
 const k=scope+':'+inv+':'+h,o=ttl?{expirationTtl:ttl}:{};
 if(old&&old.k)await kv.delete(old.k);
 await kv.put(k,'',{metadata:{n:e.n,sc:e.sc,pf:e.pf,mc:e.mc,h},...o});
 await kv.put(pk,JSON.stringify({k,inv}),o);
 return{k,inv}}
async function rankOf(kv,scope,k,h){
 const keys=(await kv.list({prefix:scope+':',limit:100})).keys;
 const better=keys.filter(x=>x.name<k&&!x.name.endsWith(':'+h)).length;
 return better>=100?0:better+1}

export async function onRequest({request,env}){
 const u=new URL(request.url),p=u.pathname.replace(/^\/api\//,''),kv=env.RANK;
 if(!kv)return J({error:'no-kv'},503);
 if(p==='start'&&request.method==='GET'){const ts=Date.now();return J({t:ts+'.'+await sign(env.SECRET||'dev',String(ts))})}
 if(p==='rank'&&request.method==='GET'){
  const sc=u.searchParams.get('scope')==='all'?'all':'day',ck=new Request(u.origin+'/api/rank?scope='+sc+'&d='+day()),hit=u.searchParams.get('fresh')?null:await caches.default.match(ck);
  if(hit)return hit;
  const keys=(await kv.list({prefix:sc==='all'?'a:':'d'+day()+':',limit:50})).keys;
  const res=new Response(JSON.stringify({items:keys.map((k,i)=>({r:i+1,n:k.metadata.n,sc:k.metadata.sc,pf:k.metadata.pf,h:k.metadata.h}))}),{headers:{'content-type':'application/json','cache-control':'public, max-age=10'}});
  await caches.default.put(ck,res.clone());return res}
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
   if(await kv.get('u:'+sig))return J({error:'used'},400);
   await kv.put('u:'+sig,'1',{expirationTtl:3600})}
  const h=(await sha(b.pid)).slice(0,16),e={n:name,sc:c+pf*.5,pf,mc,h},out={};
  for(const[scope,ttl,key]of[['a',0,'all'],['d'+day(),172800,'day']]){const r=await upsert(kv,scope,h,e,ttl);out[key]=await rankOf(kv,scope,r.k,h)}
  return J(out)}
 return J({error:'not-found'},404)}
