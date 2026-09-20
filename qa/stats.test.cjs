const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
test('dashboard requires login, sends token to API, never persists key, and clears state on logout',async()=>{
 const elements=new Map(),store=new Map(),calls=[];const element=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',children:[],listeners:{},addEventListener(k,f){this.listeners[k]=f},append(x){this.children.push(x)},replaceChildren(){this.children=[]}});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};get('days').value='7';
 const data={summary:{opens:1,visitors:1,plays:0,listens:0},daily:[],tracks:[],sources:[],recent:[],test:false,generated_at:Date.now()};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../stats.js'),'utf8'),{document:{getElementById:get,createElement:element},sessionStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},Date,console,
 fetch:async(url,opts)=>{calls.push({url,opts});if(url.endsWith('/api/login'))return {ok:true,status:200,json:async()=>({token:'signed-session'})};if(url.endsWith('/api/logout'))return {ok:true,status:204};return opts.headers.Authorization?{ok:true,status:200,json:async()=>data}:{ok:false,status:401}}});
 await new Promise(setImmediate);assert.equal(get('dashboard').hidden,true);
 get('key').value='private-administrator-key';await get('login').listeners.submit({preventDefault(){}});
 assert.equal(get('dashboard').hidden,false);assert.equal(get('key').value,'');assert.deepEqual([...store.values()],['signed-session']);
 assert.ok(calls.some(x=>x.opts.headers.Authorization==='Bearer signed-session'));assert.equal(get('opens').textContent,'1');
 await get('logout').listeners.click();assert.equal(store.size,0);assert.equal(get('dashboard').hidden,true);assert.equal(get('opens').textContent,'—');assert.equal(get('recent').children.length,0);
});
