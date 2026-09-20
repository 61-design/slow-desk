const endpoint='https://nrapatuhzaxgaqnkqclk.supabase.co/functions/v1/slow-desk-stats';
const sessionKey='slow-desk-admin-session';let sessionToken='';try{sessionToken=sessionStorage.getItem(sessionKey)||''}catch{};
function apiFetch(path,options={}){return fetch(endpoint+path,{...options,headers:{...options.headers,...(sessionToken?{Authorization:'Bearer '+sessionToken}:{})},credentials:'omit',referrerPolicy:'no-referrer'});}

const $=id=>document.getElementById(id);
const names={page_view:'打开网页',play_start:'开始播放',listen_30s:'听满 30 秒',direct:'直接访问',share:'分享链接',wechat:'微信标记链接',friend:'朋友标记链接'};
let loading=false;
function row(id,values){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td)}$(id).append(tr)}
function empty(id,n){if(!$(id).children.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=n;td.textContent='这个时间段暂无记录';tr.append(td);$(id).append(tr)}}
function showLogin(){ sessionToken='';try{sessionStorage.removeItem(sessionKey)}catch{}; $('login').hidden=false;$('dashboard').hidden=true;$('logout').hidden=true;for(const id of ['daily','tracks','sources','recent'])$(id).replaceChildren();for(const id of ['opens','visitors','plays','listens'])$(id).textContent='—';}
async function load(){if(loading)return;loading=true;$('refresh').disabled=true;$('days').disabled=true;$('test').disabled=true;try{
const r=await apiFetch('/api/stats?days='+$('days').value+'&test='+($('test').checked?'1':'0'),{cache:'no-store'});
if(r.status===401){showLogin();return}if(!r.ok)throw Error('暂时无法读取统计，请稍后刷新。');const d=await r.json();
$('login').hidden=true;$('dashboard').hidden=false;$('logout').hidden=false;$('mode').textContent=d.test?'测试数据 · 不计入真实统计':'真实数据';
for(const id of ['opens','visitors','plays','listens'])$(id).textContent=(d.summary[id]||0).toLocaleString();
for(const id of ['daily','tracks','sources','recent'])$(id).replaceChildren();
for(const x of d.daily)row('daily',[x.day,x.opens,x.visitors,x.plays,x.listens]);
for(const x of d.tracks)row('tracks',[x.track_title,x.plays,x.listens]);
for(const x of d.sources)row('sources',[names[x.source]||x.source,x.opens]);
for(const x of d.recent)row('recent',[new Date(x.occurred_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),names[x.event],x.track_title||'—',x.visitor_id.slice(0,8)]);
empty('daily',5);empty('tracks',3);empty('sources',2);empty('recent',4);$('status').textContent='更新于 '+new Date(d.generated_at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' · 北京时间';
}catch(e){$('status').textContent=e.message;$('login-status').textContent=e.message;}finally{loading=false;$('refresh').disabled=false;$('days').disabled=false;$('test').disabled=false;}}
$('login').addEventListener('submit',async e=>{e.preventDefault();$('enter').disabled=true;$('login-status').textContent='正在登录…';try{const r=await apiFetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('key').value})});$('key').value='';if(!r.ok)throw Error(r.status===401?'密钥不正确，请重试。':'登录暂时不可用，请稍后重试。');sessionToken=(await r.json()).token;try{sessionStorage.setItem(sessionKey,sessionToken)}catch{};$('login-status').textContent='';await load();}catch(e){$('login-status').textContent=e.message}finally{$('enter').disabled=false}});
$('logout').addEventListener('click',async()=>{try{const r=await apiFetch('/api/logout',{method:'POST'});if(!r.ok)throw Error();showLogin()}catch{$('status').textContent='退出失败，请检查网络后重试。'}});
for(const id of ['days','test'])$(id).addEventListener('change',load);$('refresh').addEventListener('click',load);load();
