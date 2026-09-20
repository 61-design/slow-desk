import adminPage from './admin.mjs';
import catalogue from './catalogue.mjs';

const origin = 'https://61-design.github.io';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keys = ['version', 'event_id', 'event', 'occurred_at', 'visitor_id', 'session_id', 'source', 'track_id', 'track_title', 'series_id'];

export function validate(event, now) {
  if (!event || Array.isArray(event) || typeof event !== 'object') return null;
  if (Object.keys(event).length !== keys.length || keys.some(key => !Object.hasOwn(event, key))) return null;
  if (event.version !== 1 || keys.slice(1).some(key => typeof event[key] !== 'string')) return null;
  if (![event.event_id, event.visitor_id, event.session_id].every(value => uuid.test(value))) return null;
  if (!['page_view', 'play_start', 'listen_30s'].includes(event.event)) return null;
  if (!['direct', 'share', 'wechat', 'friend'].includes(event.source)) return null;
  const time = Date.parse(event.occurred_at);
  if (!Number.isFinite(time) || Math.abs(time - now) > 86400000) return null;
  if (event.event === 'page_view') {
    if (event.track_id || event.track_title || event.series_id) return null;
  } else {
    const track = catalogue[event.track_id];
    if (!track || track.title !== event.track_title || track.series !== event.series_id) return null;
  }
  return {...event, occurred_at: new Date(time).toISOString()};
}

async function readBody(request) {
  if (!request.body) throw new Error('empty');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new Error('large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
}

// Quotas and deduplication are checked in the same atomic insert.
export const insertSql = `INSERT OR IGNORE INTO events
 (event_id,event,occurred_at,received_at,visitor_id,session_id,source,track_id,track_title,series_id,test_data)
 SELECT ?,?,?,?,?,?,?,?,?,?,?
 WHERE (SELECT COUNT(*) FROM events WHERE received_at >= ?) < ?
 AND (SELECT COUNT(*) FROM events WHERE received_at > ?) < 5
 AND (SELECT COUNT(*) FROM events WHERE received_at > ?) < 30`;
const cookieName = '__Host-desk_session';
const encode = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2,'0')).join('');
async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encode.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
}
async function authenticated(request, env) {
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32) return false;
  const token = request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if (!token || !/^\d{13}\.[a-f0-9]{64}$/.test(token)) return false;
  const [expires, signature] = token.split('.');
  if (+expires <= Date.now() || +expires > Date.now()+28800000) return false;
  const bytes = Uint8Array.from(signature.match(/../g), x=>parseInt(x,16));
  return crypto.subtle.verify('HMAC', await signingKey(env.ADMIN_KEY), bytes, encode.encode(expires));
}
async function matchesKey(input, secret) {
  const [a,b] = await Promise.all([input,secret].map(x=>crypto.subtle.digest('SHA-256',encode.encode(x))));
  const aa=new Uint8Array(a),bb=new Uint8Array(b); let diff=0;
  for(let i=0;i<aa.length;i++) diff |= aa[i]^bb[i];
  return diff===0;
}
const dayStart = now => Math.floor((now+28800000)/86400000)*86400000-28800000;
const common = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
async function admin(request, env, url) {
  const reply = (status, data={}) => Response.json(data,{status,headers:common});
  if (url.pathname === '/admin' && request.method === 'GET') {
    const nonce=crypto.randomUUID();
    return new Response(adminPage.replaceAll('__NONCE__',nonce),{headers:{...common,'Content-Type':'text/html; charset=utf-8',
      'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`}});
  }
  if (url.pathname === '/api/login' && request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return reply(403);
    if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32) return reply(503);
    let body; try {body=await readBody(request);} catch {return reply(400);}
    if (typeof body?.key!=='string' || body.key.length>256 || !await matchesKey(body.key,env.ADMIN_KEY)) return reply(401);
    const expires=String(Date.now()+28800000);
    const signature=hex(await crypto.subtle.sign('HMAC',await signingKey(env.ADMIN_KEY),encode.encode(expires)));
    return new Response(null,{status:204,headers:{...common,'Set-Cookie':`${cookieName}=${expires}.${signature}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`}});
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return reply(403);
    return new Response(null,{status:204,headers:{...common,'Set-Cookie':`${cookieName}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`}});
  }
  if (url.pathname !== '/api/stats' || request.method !== 'GET') return reply(404);
  if (!await authenticated(request,env)) return reply(401);
  const days=Number(url.searchParams.get('days') || 7);
  if (![7,30].includes(days)) return reply(400);
  const test=+(url.searchParams.get('test')==='1');
  const end=Date.now(),start=dayStart(end)-(days-1)*86400000;
  const where='test_data=? AND occurred_at>=? AND occurred_at<=?';
  const query=sql=>env.DB.prepare(sql).bind(test,start,end);
  const results=await env.DB.batch([
    query(`SELECT SUM(event='page_view') AS opens, COUNT(DISTINCT CASE WHEN event='page_view' THEN visitor_id END) AS visitors,
      SUM(event='play_start') AS plays, SUM(event='listen_30s') AS listens FROM events WHERE ${where}`),
    query(`SELECT date(occurred_at/1000,'unixepoch','+8 hours') AS day, SUM(event='page_view') AS opens,
      COUNT(DISTINCT CASE WHEN event='page_view' THEN visitor_id END) AS visitors, SUM(event='play_start') AS plays,
      SUM(event='listen_30s') AS listens FROM events WHERE ${where} GROUP BY day ORDER BY day`),
    query(`SELECT track_id,track_title,SUM(event='play_start') AS plays,SUM(event='listen_30s') AS listens
      FROM events WHERE ${where} AND event!='page_view' GROUP BY track_id,track_title ORDER BY plays DESC,listens DESC LIMIT 20`),
    query(`SELECT source,COUNT(*) AS opens FROM events WHERE ${where} AND event='page_view' GROUP BY source ORDER BY opens DESC`),
    query(`SELECT event,occurred_at,visitor_id,source,track_title FROM events WHERE ${where} ORDER BY occurred_at DESC LIMIT 50`)
  ]);
  return reply(200,{days,test:!!test,generated_at:end,summary:results[0].results[0],daily:results[1].results,
    tracks:results[2].results,sources:results[3].results,recent:results[4].results});
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if (url.pathname==='/admin' || url.pathname.startsWith('/api/')) {
      try {return await admin(request,env,url);} catch {return Response.json({error:'暂时无法读取统计'}, {status:503,headers:common});}
    }
    if (url.pathname==='/health' && request.method==='GET') return new Response('慢慢书桌统计服务：连接正常',{headers:{...common,'Content-Type':'text/plain; charset=utf-8'}});
    const allowed=request.headers.get('Origin')===origin;
    const headers={...common,'Vary':'Origin'};
    if(allowed) Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});
    const reply=status=>new Response(null,{status,headers});
    if(url.pathname!=='/collect') return reply(404);
    if(!allowed) return reply(403);
    if(request.method==='OPTIONS') return reply(204);
    if(request.method!=='POST') return reply(405);
    if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json') return reply(415);
    const cap=Number(env.DAILY_EVENT_CAP);
    if(!env.DB || !Number.isInteger(cap) || cap<1 || cap>1000) return reply(503);
    const now=Date.now();let event;
    try {event=validate(await readBody(request),now);} catch {return reply(400);}
    if(!event) return reply(400);
    try {
      const result=await env.DB.prepare(insertSql).bind(event.event_id,event.event,Date.parse(event.occurred_at),now,
        event.visitor_id,event.session_id,event.source,event.track_id,event.track_title,event.series_id,+(env.TEST_DATA!=='false'),
        dayStart(now),cap,now-1000,now-60000).run();
      if(result.meta.changes) return reply(201);
      const duplicate=await env.DB.prepare('SELECT event_id FROM events WHERE event_id=?').bind(event.event_id).first();
      return reply(duplicate?409:429);
    } catch {return reply(503);}
  },
  async scheduled(_event,env) {
    await env.DB.prepare('DELETE FROM events WHERE received_at < ?').bind(Date.now()-62*86400000).run();
  }
};
