const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const code = fs.readFileSync(require('node:path').join(__dirname,'../analytics.js'),'utf8');
function setup({endpoint='https://collector.example/events', saved, dnt, protocol='https:'}={}) {
  const requests=[], writes=[], window={location:{protocol,search:'?from=share&thought=private-secret&search=private-secret'}};
  let time=0;
  const store=new Map(saved ? [['slow-desk-analytics-v1',JSON.stringify(saved)]] : []);
  vm.runInNewContext(code,{window,URLSearchParams,crypto:{randomUUID},Date,performance:{now:()=>time},navigator:{doNotTrack:dnt},
    localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>{writes.push(v);store.set(k,v);}},
    fetch:(url,options)=>{requests.push({url,...options,body:JSON.parse(options.body)});return Promise.resolve({ok:true});}});
  const tracker=new window.SlowDeskAnalytics({endpoint});
  const events=new Map();
  const media={currentTime:0,paused:false,seeking:false,ended:false,volume:.4,readyState:4,playbackRate:1,
    addEventListener:(k,f)=>events.set(k,[...(events.get(k)||[]),f]),
    removeEventListener:(k,f)=>events.set(k,(events.get(k)||[]).filter(x=>x!==f)),
    emit:(k)=>[...(events.get(k)||[])].forEach(f=>f())};
  const track={id:'echo-public-night',title:'不问来处',series:'midnight'};
  tracker.bind(media,track,()=>true);
  return {tracker,media,track,requests,writes,window,advance:(seconds=1)=>{time+=seconds*1000;media.currentTime+=seconds;media.emit('timeupdate');}};
}
test('disabled configuration and offline copies create no identifiers and send nothing',()=>{
  for (const options of [{endpoint:''},{protocol:'file:'}]) {
    const e=setup(options);e.tracker.visit();e.media.emit('playing');e.advance(40);
    assert.equal(e.requests.length,0);assert.equal(e.writes.length,0);
  }
});
test('one page view, whitelist payload and no notes/search/full URL/credentials',()=>{
  const e=setup();e.tracker.visit();e.tracker.visit();
  assert.equal(e.requests.length,1);assert.equal(e.requests[0].body.source,'share');
  assert.equal(e.requests[0].credentials,'omit');assert.equal(e.requests[0].referrerPolicy,'no-referrer');
  assert.doesNotMatch(JSON.stringify(e.requests),/private-secret|thought|search=/);
  assert.equal(e.requests[0].body.track_id,'');
});
test('selection alone never means play; successful media progress emits start and 30 seconds once',()=>{
  const e=setup();assert.equal(e.requests.length,0);e.media.emit('playing');
  for(let i=0;i<45;i++) e.advance();
  assert.deepEqual(e.requests.map(x=>x.body.event),['play_start','listen_30s']);
  e.tracker.bind(e.media,e.track,()=>true);e.media.emit('playing');e.advance();
  assert.equal(e.requests.length,2);
});
test('pause, seeking, buffering and long suspended gaps never manufacture 30 seconds',()=>{
  const e=setup();e.media.emit('playing');
  for(let i=0;i<10;i++) e.advance();
  e.media.paused=true;e.media.emit('pause');e.advance(100);e.media.paused=false;e.media.emit('playing');
  e.media.seeking=true;e.media.emit('seeking');e.advance(60);e.media.seeking=false;e.media.emit('seeked');e.media.emit('playing');
  e.media.readyState=2;e.media.emit('waiting');e.advance(100);e.media.readyState=4;e.media.emit('playing');
  e.advance(100); // even if the browser missed events during suspension, reject a long gap
  assert.equal(e.requests.length,1);
  for(let i=0;i<19;i++) e.advance();assert.equal(e.requests.length,1);
  e.advance();assert.equal(e.requests[1].body.event,'listen_30s');
});
test('muting and opt-out stop collection; opting out removes persistent identifier',()=>{
  const e=setup();e.media.volume=0;e.media.emit('playing');for(let i=0;i<35;i++)e.advance();
  assert.equal(e.requests.length,0);e.media.volume=.4;e.media.emit('playing');e.tracker.setEnabled(false);
  const count=e.requests.length;for(let i=0;i<40;i++)e.advance();e.tracker.visit();assert.equal(e.requests.length,count);
  assert.deepEqual(JSON.parse(e.writes.at(-1)),{enabled:false});
});
test('saved opt-out and do-not-track suppress requests',()=>{
  for(const options of [{saved:{enabled:false}},{dnt:'1'}]) {
    const e=setup(options);e.tracker.visit();e.media.emit('playing');for(let i=0;i<40;i++)e.advance();
    assert.equal(e.requests.length,0);assert.equal(e.writes.length,0);
  }
});
test('switching track resets counters and listeners, and does not misattribute progress',()=>{
  const e=setup();e.media.emit('playing');for(let i=0;i<20;i++)e.advance();
  const next={id:'echo-public-dawn',title:'睡到自然醒',series:'midnight'};
  e.tracker.bind(e.media,next,()=>true);e.media.currentTime=0;e.media.emit('playing');
  for(let i=0;i<30;i++)e.advance();
  assert.deepEqual(e.requests.map(x=>[x.body.event,x.body.track_id]),[['play_start','echo-public-night'],['play_start','echo-public-dawn'],['listen_30s','echo-public-dawn']]);
});
