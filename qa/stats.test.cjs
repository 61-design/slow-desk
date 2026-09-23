const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
test('dashboard loads without login or a browser-stored credential',async()=>{
 const elements=new Map(),calls=[];const element=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',children:[],listeners:{},addEventListener(k,f){this.listeners[k]=f},append(x){this.children.push(x)},replaceChildren(){this.children=[]}});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};get('days').value='7';
 const data={summary:{opens:1,visitors:1,plays:0,listens:0},daily:[],tracks:[],sources:[],recent:[],test:false,generated_at:Date.now()};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../stats.js'),'utf8'),{document:{getElementById:get,createElement:element},Date,console,
 fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,status:200,json:async()=>data}}});
 await new Promise(setImmediate);
 assert.equal(get('opens').textContent,'1');assert.equal(get('status').textContent.startsWith('更新于 '),true);
 assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/api/stats?days=7&test=0'));
 assert.equal(calls[0].opts.headers,undefined);
 get('refresh').listeners.click();await new Promise(setImmediate);assert.equal(calls.length,2);
});
