import {origin,validate,readBody} from './validation.mjs';
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
const hash=async value=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const signingKey=secret=>crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
async function authorize(request,secret,getHash){
 const token=request.headers.get('Authorization')?.replace(/^Bearer /,'');
 if(!token || !/^\d{13}\.[a-f0-9]{64}$/.test(token))return false;
 const [expires,signature]=token.split('.');if(+expires<=Date.now() || +expires>Date.now()+28800000)return false;
 const digest=await getHash();if(!/^[a-f0-9]{64}$/.test(digest||''))return false;
 return crypto.subtle.verify('HMAC',await signingKey(secret+':'+digest),Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)),encoder.encode('slow-desk:'+expires));
}
export async function handle(request,env){
 const path=new URL(request.url).pathname.replace(/^\/functions\/v1\/slow-desk-stats/,'').replace(/^\/slow-desk-stats/,'');
 const allowed=request.headers.get('Origin')===origin;
 const headers={'Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 if(allowed)Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'600'});
 const reply=(status,data=null)=>data===null?new Response(null,{status,headers}):Response.json(data,{status,headers});
 if(path==='/health' && request.method==='GET')return reply(200,{message:'慢慢书桌统计服务：连接正常'});
 if(!allowed)return reply(403);
 if(request.method==='OPTIONS')return reply(204);
 async function rpc(name,body){
  const r=await fetch(env.url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:env.key,Authorization:'Bearer '+env.key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('database request failed');return r.json();
 }
 try{
  if(path==='/collect' && request.method==='POST'){
   if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')return reply(415);
   let body;try{body=validate(await readBody(request),Date.now());}catch{return reply(400)}
   if(!body)return reply(400);
   const status=await rpc('slow_desk_ingest',{payload:body});
   return reply([201,409,429,503].includes(status)?status:503);
  }
  if(path==='/api/login' && request.method==='POST'){
   let body;try{body=await readBody(request);}catch{return reply(400)}
   if(typeof body?.key!=='string' || body.key.length<32 || body.key.length>256)return reply(401);
   const config=await rpc('slow_desk_admin_config',{});
   if(!/^[a-f0-9]{64}$/.test(config?.admin_key_hash||''))return reply(503);
   const digest=await hash(body.key);let diff=0;
   for(let i=0;i<64;i++)diff|=digest.charCodeAt(i)^config.admin_key_hash.charCodeAt(i);
   if(diff!==0)return reply(401);
   const expires=String(Date.now()+28800000);
   const signature=hex(await crypto.subtle.sign('HMAC',await signingKey(env.key+':'+config.admin_key_hash),encoder.encode('slow-desk:'+expires)));
   return reply(200,{token:expires+'.'+signature});
  }
  if(path==='/api/stats' && request.method==='GET'){
   if(!await authorize(request,env.key,async()=>(await rpc('slow_desk_admin_config',{})).admin_key_hash))return reply(401);
   const params=new URL(request.url).searchParams;
   const days=Number(params.get('days')||7);if(![7,30].includes(days))return reply(400);
   return reply(200,await rpc('slow_desk_stats',{p_days:days,p_test:params.get('test')==='1'}));
  }
  if(path==='/api/logout' && request.method==='POST')return reply(204);
  return reply(404);
 }catch{return reply(503,{error:'统计服务暂时不可用'});}
}
