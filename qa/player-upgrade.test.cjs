const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'audio.js'), 'utf8');
const passed = [];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function environment({ rainAvailable = true, resume = null, sampleRate = 1000 } = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map();
  const audios = [], contexts = [], states = [], dom = [];
  const events = () => ({
    listeners: {},
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); },
    removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== callback); },
    dispatch(name) { for (const callback of this.listeners[name] || []) callback(); }
  });
  class FakeAudio {
    constructor(src) {
      Object.assign(this, events(), { src, paused: true, volume: 1, duration: 180, currentTime: 0, ended: false, playCalls: 0 });
      audios.push(this);
    }
    play() {
      this.playCalls++; this.ended = false;
      if (this.playError) return Promise.reject(this.playError);
      if (this.playWait) return this.playWait.promise.then(() => { this.paused = false; });
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; this.dispatch('pause'); }
    load() { this.currentSrc = this.src; this.currentTime = 0; this.ended = false; this.paused = true; this.loadCalls = (this.loadCalls || 0) + 1; }
    finish() { this.currentTime = this.duration; this.ended = true; this.paused = true; this.dispatch('pause'); this.dispatch('ended'); }
    remove() { this.removed = true; const i = dom.indexOf(this); if (i !== -1) dom.splice(i, 1); }
    removeAttribute(name) { delete this[name]; }
  }
  const parameter = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; } });
  const node = () => ({ connect(target) { return target; }, disconnect() { this.disconnected = true; } });
  class FakeContext {
    constructor() {
      this.state = 'suspended'; this.sampleRate = sampleRate; this.currentTime = 0; this.destination = node(); this.sources = [];
      contexts.push(this);
    }
    async resume() { if (resume) await resume.promise; this.state = 'running'; }
    createGain() { return Object.assign(node(), { gain: parameter() }); }
    createBiquadFilter() { return Object.assign(node(), { frequency: parameter() }); }
    createBuffer(channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createBufferSource() {
      const result = Object.assign(node(), { start() { this.started = true; }, stop(time) { this.stopTime = time; this.stopped = true; } });
      this.sources.push(result); return result;
    }
  }
  const document = Object.assign(events(), { hidden: false, body: { appendChild(audio) { dom.push(audio); } } });
  const window = Object.assign(events(), { CALM_TRACKS: [
    { id: 'a', title: '声音一', src: 'a.m4a', series: 'jazz' },
    { id: 'b', title: '声音二', src: 'b.mp3', series: 'jazz', gain: 0.5 },
    { id: 'c', title: '声音三', src: 'c.m4a', series: 'jazz' },
    { id: 'd', title: '声音四', src: 'd.mp3', series: 'calm' },
    { id: 'e', title: '声音五', src: 'e.m4a', series: 'calm' }
  ] });
  if (rainAvailable) window.AudioContext = FakeContext;
  vm.runInNewContext(source, {
    window, document, Audio: FakeAudio, Date: { now: () => 1788170400000 + now }, performance: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const engine = new window.CalmAudio({ onState: state => states.push(state) });
  return { engine, document, window, audios, contexts, states, dom, timers,
    hidden(value) { document.hidden = value; document.dispatch('visibilitychange'); },
    jump(duration) { now += duration; },
    advance(duration) {
      const end = now + duration;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due; timers.delete(next[0]); next[1].callback();
      }
      now = end;
    }
  };
}

async function test(name, run) { await run(); passed.push(name); }

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function ended(env) { env.engine.audio.finish(); await flush(); }

(async () => {
  await test('环境声默认输出有可用电平，音量滑块不再被隐藏倍率再次衰减', async () => {
    const env = environment({sampleRate:48000}); env.engine.setMusic(false); env.engine.setRain(true); env.engine.setFire(true);
    await env.engine.start();
    for (const kind of ['rain','fire']) {
      const data = env.engine[`${kind}Source`].buffer.getChannelData(0);
      let energy = 0; for (const value of data) energy += value * value;
      const output = Math.sqrt(energy/data.length) * env.engine[`${kind}Gain`].gain.value;
      assert.ok(output > .012 && output < .04, `${kind} default RMS ${output} should be audible but remain background level`);
      env.engine.setEffectVolume(kind, 0); assert.equal(env.engine[`${kind}Gain`].gain.value, 0);
    }
  });
  await test('手机音频上下文中断后，下一次播放会重新恢复环境声', async () => {
    const env = environment(); env.engine.setMusic(false); env.engine.setRain(true); await env.engine.start();
    env.engine.context.state = 'interrupted'; env.engine.pause(true);
    assert.equal(await env.engine.start(), true); assert.equal(env.engine.context.state, 'running');
    assert.equal(env.engine.rainSource.started, true);
  });
  await test('首次进入不播放；默认列表循环、当前系列、独立音量且不申请环境音权限', async () => {
    const env = environment(), state = env.engine.getState();
    assert.equal(state.status, 'off'); assert.equal(state.playing, false); assert.equal(state.mode, 'list'); assert.equal(state.scope, 'series');
    assert.equal(state.volume, .38); assert.equal(state.rainVolume, .25); assert.equal(state.fireVolume, .28);
    assert.equal(state.rain, false); assert.equal(state.fire, false); assert.equal(env.contexts.length, 0);
    assert.equal(env.engine.audio.loop, false); assert.equal(env.engine.audio.playCalls, 0);
    assert.equal(state.queueLength, 3); assert.equal(state.queueIndex, 0);
  });
  await test('暂停切曲/模式/收藏/音量不会自动播放；无效参数不破坏状态', async () => {
    const env = environment(); env.engine.selectTrack('b'); env.engine.setMode('shuffle'); env.engine.setScope('all');
    env.engine.setFavorites(['b', 'missing', 'b']); env.engine.setFire(true); env.engine.setRain(true);
    env.engine.setVolume(.52); env.engine.setFireVolume(.42); env.engine.setRainVolume(.18);
    assert.equal(env.engine.selectTrack('missing'), false); assert.equal(env.engine.setMode('missing'), false);
    assert.equal(env.engine.setScope('missing'), false); assert.equal(env.engine.setFavorites(null), false);
    assert.equal(env.audios.every(audio => !audio.playCalls), true); assert.equal(env.contexts.length, 0);
    assert.deepEqual([...env.engine.getState().favorites], ['b']);
  });
  await test('音乐无需 Web Audio；淡入到音量乘曲目gain，切曲遵循mp3/m4a本地src', async () => {
    const env = environment({ rainAvailable: false }); env.engine.selectTrack('b');
    assert.equal(await env.engine.start(), true); assert.equal(env.engine.audio.volume, 0); assert.equal(env.engine.audio.src, 'b.mp3');
    env.advance(440); assert.ok(env.engine.audio.volume > 0 && env.engine.audio.volume < .19);
    env.advance(440); assert.equal(env.engine.audio.volume, .19); assert.equal(env.contexts.length, 0);
  });
  await test('列表自然结束切到下一首，当前系列末尾回到第一首；ended不误报pause错误', async () => {
    const env = environment(); await env.engine.start(); const sameElement = env.engine.audio; await ended(env);
    assert.equal(env.engine.audio, sameElement); assert.equal(env.audios.length, 1); assert.equal(sameElement.loadCalls, 1);
    assert.equal(env.engine.trackId, 'b'); assert.equal(env.engine.musicError, null); assert.equal(env.engine.playing, true);
    await ended(env); assert.equal(env.engine.trackId, 'c'); await ended(env); assert.equal(env.engine.trackId, 'a');
    assert.equal(env.states.some(state => state.status === 'error'), false);
  });
  await test('全部范围按总曲库循环；上一首首尾相接', async () => {
    const env = environment(); env.engine.setScope('all'); env.engine.selectTrack('c'); await env.engine.start();
    await ended(env); assert.equal(env.engine.trackId, 'd'); await ended(env); assert.equal(env.engine.trackId, 'e');
    await ended(env); assert.equal(env.engine.trackId, 'a'); await env.engine.previousTrack(); assert.equal(env.engine.trackId, 'e');
  });
  await test('单曲循环设置native loop；模拟ended重播同首；手动下一首仍可换曲', async () => {
    const env = environment(); env.engine.setMode('single'); assert.equal(env.engine.audio.loop, true);
    await env.engine.start(); await ended(env); assert.equal(env.engine.trackId, 'a'); assert.equal(env.engine.audio.currentTime, 0);
    assert.equal(env.engine.audio.playCalls, 2); await env.engine.nextTrack(); assert.equal(env.engine.trackId, 'b');
    assert.equal(env.engine.audio.loop, true); env.engine.setMode('list'); assert.equal(env.engine.audio.loop, false);
  });
  await test('随机模式无放回，每轮完整、不相邻重复', async () => {
    const env = environment(); env.engine.setScope('all'); env.engine.setMode('shuffle'); await env.engine.start();
    const seen = [env.engine.trackId];
    for (let i = 0; i < 24; i++) { await ended(env); seen.push(env.engine.trackId); }
    for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
    for (let i = 0; i < 25; i += 5) assert.equal(new Set(seen.slice(i, i + 5)).size, 5);
  });
  await test('随机上一首回真实历史，再下一首前进历史且不扰乱随机袋', async () => {
    const env = environment(); env.engine.setMode('shuffle'); await env.engine.start();
    const first = env.engine.trackId; await env.engine.nextTrack(); const second = env.engine.trackId;
    await env.engine.nextTrack(); const third = env.engine.trackId; const bag = [...env.engine.shuffleBag];
    await env.engine.previousTrack(); assert.equal(env.engine.trackId, second);
    await env.engine.previousTrack(); assert.equal(env.engine.trackId, first);
    await env.engine.nextTrack(); assert.equal(env.engine.trackId, second); await env.engine.nextTrack(); assert.equal(env.engine.trackId, third);
    assert.deepEqual([...env.engine.shuffleBag], bag);
  });
  await test('更换系列重置随机袋/历史，只在新系列内播放', async () => {
    const env = environment(); env.engine.setMode('shuffle'); await env.engine.start(); await env.engine.nextTrack();
    await env.engine.selectTrack('d'); assert.equal(env.engine.history.length, 1); await ended(env);
    assert.equal(env.engine.trackId, 'e'); await ended(env); assert.equal(env.engine.trackId, 'd');
  });
  await test('收藏范围只播合法收藏；收藏中删掉当前曲目切到剩余第一首', async () => {
    const env = environment(); env.engine.setFavorites(['b', 'd', 'b', 'invalid']); env.engine.setScope('favorites');
    await env.engine.start(); assert.equal(env.engine.trackId, 'b'); assert.equal(env.engine.getState().queueLength, 2);
    await ended(env); assert.equal(env.engine.trackId, 'd'); await env.engine.setFavorites(['b']); assert.equal(env.engine.trackId, 'b');
    await ended(env); assert.equal(env.engine.trackId, 'b'); assert.equal(env.engine.playing, true);
  });
  await test('空收藏不假报音乐播放；有环境音则保留并明确提示空收藏', async () => {
    const env = environment(); env.engine.setScope('favorites');
    assert.equal(await env.engine.start(), false); assert.equal(env.engine.audio.playCalls, 0); assert.match(env.engine.message, /收藏夹还是空/);
    env.engine.setRain(true); assert.equal(env.engine.playing, false); await env.engine.start();
    assert.equal(env.engine.playing, true); assert.equal(env.engine.audio.paused, true);
    assert.match(env.engine.message, /轻雨/); assert.match(env.engine.message, /收藏夹还是空/);
    await env.engine.setFavorites(['b']); assert.equal(env.engine.trackId, 'b'); assert.equal(env.engine.musicRunning, true);
    await env.engine.setFavorites([]); assert.equal(env.engine.musicRunning, false); assert.equal(env.engine.playing, true);
  });
  await test('收藏范围中显式选择非收藏歌曲，回到该歌曲的系列', async () => {
    const env = environment(); env.engine.setFavorites(['a']); env.engine.setScope('favorites'); await env.engine.start();
    await env.engine.selectTrack('d'); assert.equal(env.engine.trackId, 'd'); assert.equal(env.engine.scope, 'series');
    assert.equal(env.engine.getState().queueLength, 2);
  });
  await test('播放中切后台继续且完成音量渐变，返回不自动暂停', async () => {
    const env = environment(); await env.engine.start(); env.advance(160); env.hidden(true);
    assert.equal(env.engine.audio.paused, false); assert.equal(env.engine.audio.volume, .38);
    assert.equal(env.engine.playing, true); assert.equal(env.timers.size, 0); env.hidden(false); assert.equal(env.engine.audio.paused, false);
  });
  await test('后台自然结束继续队列；后台音量/暂停立即生效', async () => {
    const env = environment(); env.hidden(true); await env.engine.start(); await ended(env);
    assert.equal(env.engine.trackId, 'b'); assert.equal(env.engine.audio.volume, .19);
    env.engine.setVolume(.2); assert.equal(env.engine.audio.volume, .1); env.engine.pause();
    assert.equal(env.engine.audio.volume, 0); assert.equal(env.engine.audio.paused, true);
  });
  await test('切曲旧曲先淡出，新曲保持静音再淡入，无可听叠播', async () => {
    const env = environment(); await env.engine.start(); env.advance(1000); const old = env.engine.audio;
    await env.engine.selectTrack('b'); env.advance(120); assert.ok(old.volume > 0 && old.volume < .38); assert.equal(env.engine.audio.volume, 0);
    env.advance(80); assert.equal(old.paused, true); assert.equal(old.removed, true); assert.equal(env.engine.audio.volume, 0);
    env.advance(900); assert.equal(env.engine.audio.volume, .19); assert.equal(env.dom.length, 1);
  });
  await test('快速连切只留下最后选择，旧曲迟到error/pause不影响新曲', async () => {
    const env = environment(); await env.engine.start(); env.advance(1000); const old = env.engine.audio;
    const one = env.engine.selectTrack('b'), two = env.engine.selectTrack('c'); await Promise.all([one, two]);
    old.dispatch('error'); old.dispatch('pause'); old.dispatch('ended'); env.advance(1300);
    assert.equal(env.engine.trackId, 'c'); assert.equal(env.audios.filter(audio => !audio.paused).length, 1);
    assert.equal(env.audios.slice(0, -1).every(audio => audio.removed && audio.volume === 0), true);
    assert.equal(env.engine.musicError, null);
  });
  await test('换曲后的迟到播放回执不能复活旧曲', async () => {
    const env = environment(), wait = deferred(), old = env.engine.audio; old.playWait = wait;
    const first = env.engine.start(); await env.engine.selectTrack('b'); wait.resolve(); await first;
    assert.equal(old.paused, true); assert.equal(old.removed, true); assert.equal(old.volume, 0); assert.equal(env.engine.playing, true);
  });
  await test('暂停后的迟到回执不能重响，暂停淡出中再播放不会被旧timer打断', async () => {
    const env = environment(), wait = deferred(); env.engine.audio.playWait = wait;
    const first = env.engine.start(); env.engine.pause(); wait.resolve(); assert.equal(await first, false);
    assert.equal(env.engine.audio.paused, true); assert.equal(env.engine.audio.volume, 0);
    delete env.engine.audio.playWait; await env.engine.start(); env.advance(1000); env.engine.pause(); env.advance(80);
    await env.engine.start(); env.advance(1000); assert.equal(env.engine.audio.paused, false); assert.equal(env.engine.audio.volume, .38);
  });
  await test('仅篝火/仅雨/雨火混合均可播，关音乐不误停环境声', async () => {
    const env = environment(); env.engine.setMusic(false); env.engine.setFire(true); await env.engine.start();
    assert.equal(env.engine.audio.playCalls, 0); assert.equal(env.engine.fireSource.started, true); assert.equal(env.engine.rainSource, null);
    assert.match(env.engine.message, /篝火/); await env.engine.setRain(true); assert.equal(env.engine.rainSource.started, true);
    const rain = env.engine.rainSource, fire = env.engine.fireSource;
    await env.engine.selectTrack('d'); assert.equal(env.engine.rainSource, rain); assert.equal(env.engine.fireSource, fire);
    await env.engine.setFire(false); assert.equal(env.engine.fireSource, null); assert.equal(env.engine.playing, true);
    env.engine.setRain(false); assert.equal(env.engine.playing, false); assert.equal(await env.engine.start(), false);
  });
  await test('音乐音量0不影响雨火；各环境音滑块互不影响', async () => {
    const env = environment(); env.engine.setRain(true); env.engine.setFire(true); await env.engine.start(); env.advance(1000);
    const rain = env.engine.rainGain.gain.value, fire = env.engine.fireGain.gain.value;
    env.engine.setVolume(0); env.advance(200); assert.equal(env.engine.audio.volume, 0);
    assert.equal(env.engine.rainGain.gain.value, rain); assert.equal(env.engine.fireGain.gain.value, fire);
    env.engine.setFireVolume(.6); assert.equal(env.engine.fireGain.gain.value, .6); assert.equal(env.engine.rainGain.gain.value, rain);
    env.engine.setRainVolume(.5); assert.equal(env.engine.rainGain.gain.value, .5); assert.equal(env.engine.fireGain.gain.value, .6);
  });
  await test('雨火 buffer 缓存，关闭会淡出并定时停止，重开不重复持有旧活动源', async () => {
    const env = environment(); env.engine.setMusic(false); env.engine.setFire(true); await env.engine.start();
    const source = env.engine.fireSource, buffer = source.buffer; await env.engine.setFire(false);
    assert.equal(source.stopped, true); assert.equal(source.stopTime, .28); assert.equal(env.engine.fireSource, null);
    env.engine.setFire(true); await env.engine.start(); assert.notEqual(env.engine.fireSource, source); assert.equal(env.engine.fireSource.buffer, buffer);
  });
  await test('pagehide立即停音乐、雨、火、旧淡出源、所有渐变和定时器', async () => {
    const env = environment(); env.engine.setRain(true); env.engine.setFire(true); env.engine.setSleepTimer(30); await env.engine.start();
    const rain = env.engine.rainSource, fire = env.engine.fireSource; await env.engine.setRain(false); env.window.dispatch('pagehide');
    assert.equal(env.engine.audio.paused, true); assert.equal(env.engine.audio.volume, 0); assert.equal(rain.stopTime, 0); assert.equal(fire.stopTime, 0);
    assert.equal(env.engine.effects.gain.value, 0); assert.equal(env.engine.playing, false); assert.equal(env.timers.size, 0);
    assert.equal(env.engine.sleepEndsAt, 0);
  });
  await test('pagehide后迟到的AudioContext恢复不生成雨火', async () => {
    const wait = deferred(), env = environment({ resume: wait }); env.engine.setMusic(false); env.engine.setRain(true); env.engine.setFire(true);
    const pending = env.engine.start(); env.window.dispatch('pagehide'); wait.resolve(); assert.equal(await pending, false);
    assert.equal(env.contexts[0].sources.length, 0); assert.equal(env.engine.playing, false);
  });
  await test('音乐被浏览器拒绝时可重试，音乐失败但雨火成功准确显示部分成功', async () => {
    const env = environment(), error = new Error('Blocked'); error.name = 'NotAllowedError'; env.engine.audio.playError = error;
    assert.equal(await env.engine.start(), false); assert.equal(env.engine.status, 'error'); assert.match(env.engine.message, /允许播放/);
    await env.engine.setRain(true); await env.engine.setFire(true); assert.equal(env.engine.playing, true); assert.match(env.engine.message, /音乐暂时未能播放/);
    assert.match(env.engine.message, /轻雨与篝火/); delete env.engine.audio.playError; await env.engine.start(); assert.equal(env.engine.musicRunning, true);
  });
  await test('环境音能力缺失不影响音乐，分别说明雨火不可播放', async () => {
    const env = environment({ rainAvailable: false }); env.engine.setRain(true); env.engine.setFire(true);
    assert.equal(await env.engine.start(), true); assert.match(env.engine.message, /轻雨、篝火暂时未能播放/);
    assert.equal(env.engine.getState().rainAvailable, false); assert.equal(env.engine.getState().fireAvailable, false);
  });
  await test('音乐被外部暂停如实更新，雨火仍可独立继续', async () => {
    const env = environment(); env.engine.setFire(true); await env.engine.start(); env.engine.audio.pause();
    assert.equal(env.engine.musicRunning, false); assert.equal(env.engine.playing, true); assert.match(env.engine.message, /音乐暂时未能播放/);
  });
  await test('定时采用单个截止timer，到点全部淡出暂停并清除截止，手动重启可继续', async () => {
    const env = environment(); env.engine.setRain(true); env.engine.setFire(true); await env.engine.start(); env.advance(1000);
    env.engine.setSleepTimer(15); assert.equal(env.timers.size, 1); const count = env.states.length;
    env.advance(899000); assert.equal(env.states.length, count); assert.equal(env.engine.playing, true);
    env.advance(1000); assert.equal(env.engine.playing, false); assert.equal(env.engine.sleepEndsAt, 0); assert.equal(env.engine.sleepMinutes, 0);
    assert.match(env.engine.message, /定时已结束/); env.advance(280); assert.equal(env.engine.audio.paused, true); assert.equal(env.engine.rainSource, null);
    assert.equal(env.engine.fireSource, null); assert.equal(await env.engine.start(), true);
  });
  await test('手动暂停保留原定时截止，不因为重播延长；取消定时无残留', async () => {
    const env = environment(); env.engine.setSleepTimer(30); const deadline = env.engine.sleepEndsAt;
    await env.engine.start(); env.advance(1000); env.engine.pause(); assert.equal(env.engine.sleepEndsAt, deadline);
    env.advance(10000); await env.engine.start(); assert.equal(env.engine.sleepEndsAt, deadline);
    env.engine.setSleepTimer(0); assert.equal(env.engine.sleepEndsAt, 0); env.advance(1900000); assert.equal(env.engine.playing, true);
  });
  await test('后台timer被节流时，恢复页面按真实截止时间立即静音', async () => {
    const env = environment(); env.engine.setSleepTimer(15); await env.engine.start(); env.hidden(true); env.jump(901000);
    env.hidden(false); assert.equal(env.engine.playing, false); assert.match(env.engine.message, /定时已结束/);
    env.advance(300); assert.equal(env.engine.audio.paused, true); assert.equal(env.engine.sleepEndsAt, 0);
  });
  await test('到期后收到自然ended不续播，迟到的play promise不能恢复声音', async () => {
    const env = environment(), wait = deferred(); env.engine.setSleepTimer(15); env.engine.audio.playWait = wait;
    const pending = env.engine.start(); env.jump(901000); env.engine.audio.finish(); await flush();
    wait.resolve(); assert.equal(await pending, false); assert.equal(env.engine.audio.paused, true); assert.equal(env.engine.audio.volume, 0);
    assert.equal(env.engine.trackId, 'a');
  });
  await test('自然续播复用元素后的旧监听、旧currentSrc和无MediaError的事件不会打断新曲', async () => {
    const env = environment(); await env.engine.start(); const audio = env.engine.audio; const oldError = audio.listeners.error[0];
    await ended(env); oldError(); assert.equal(env.engine.musicError, null);
    const currentSrc = audio.currentSrc; audio.currentSrc = 'old-resource.mp3'; audio.dispatch('error');
    assert.equal(env.engine.musicError, null); audio.currentSrc = currentSrc; audio.error = null; audio.dispatch('error');
    assert.equal(env.engine.musicError, null); assert.equal(env.engine.playing, true);
    audio.error = { code: 3 }; audio.dispatch('error'); assert.equal(env.engine.musicRunning, false); assert.equal(env.engine.status, 'error');
  });
  await test('所有滑块范围约束，异常值不改值，gain最多1防意外放大', async () => {
    const env = environment(); env.engine.setVolume(2); assert.equal(env.engine.volume, 1); env.engine.setVolume(-1); assert.equal(env.engine.volume, 0);
    env.engine.setVolume('invalid'); assert.equal(env.engine.volume, 0); env.engine.setFireVolume(4); assert.equal(env.engine.fireVolume, 1);
    env.engine.setRainVolume(-4); assert.equal(env.engine.rainVolume, 0); env.engine.tracks[0].gain = 7; env.engine.setVolume(.4);
    env.hidden(true); await env.engine.start(); assert.equal(env.engine.audio.volume, .4);
    assert.equal(env.engine.setSleepTimer(-1), false); assert.equal(env.engine.setSleepTimer('bad'), false);
  });
  await test('真实48k采样生成18秒篝火、9秒雨声，有限值/保守峰值/接缝连续', async () => {
    const env = environment({ sampleRate: 48000 }); env.engine.setMusic(false); env.engine.setRain(true); env.engine.setFire(true); await env.engine.start();
    for (const [kind, seconds] of [['fire', 18], ['rain', 9]]) {
      const source = env.engine[`${kind}Source`]; const samples = source.buffer.getChannelData(0);
      assert.equal(samples.length, seconds * 48000); let peak = 0, power = 0;
      for (const value of samples) { assert.ok(Number.isFinite(value)); peak = Math.max(peak, Math.abs(value)); power += value * value; }
      assert.ok(peak < .601); assert.ok(Math.sqrt(power / samples.length) > .01);
      assert.ok(Math.abs(samples[0] - samples[samples.length - 1]) < 1e-7); assert.equal(source.loop, true);
    }
  });
  await test('不喜欢列表默认空，白名单去重且状态副本不会污染引擎', async () => {
    const env = environment(); assert.deepEqual([...env.engine.getState().disliked], []);
    assert.equal(env.engine.setDisliked(null), false); env.engine.setDisliked(['b', 'missing', null, 3, {}, 'b']);
    assert.deepEqual([...env.engine.getState().disliked], ['b']); const copy = env.engine.getState().disliked; copy.push('a');
    assert.deepEqual([...env.engine.getState().disliked], ['b']); assert.equal(env.engine.queue().length, 2);
  });
  await test('正在播放B时标记不喜欢立即停止B并按原顺序到C，上一首跳过B回A', async () => {
    const env = environment(); env.engine.selectTrack('b'); await env.engine.start(); env.advance(1000); const old = env.engine.audio;
    await env.engine.setDisliked(['b']); assert.equal(old.paused, true); assert.equal(old.volume, 0);
    assert.equal(env.engine.trackId, 'c'); assert.equal(env.engine.playing, true); await env.engine.previousTrack(); assert.equal(env.engine.trackId, 'a');
    await ended(env); assert.equal(env.engine.trackId, 'c'); await ended(env); assert.equal(env.engine.trackId, 'a');
  });
  await test('暂停标记当前歌曲只选择下一首不出声；单曲循环中的标记也立即下一首', async () => {
    const env = environment(); env.engine.selectTrack('b'); env.engine.setDisliked(['b']); assert.equal(env.engine.trackId, 'c');
    assert.equal(env.audios.every(audio => !audio.playCalls), true); env.engine.setMode('single'); await env.engine.start();
    await env.engine.setDisliked(['b', 'c']); assert.equal(env.engine.trackId, 'a'); assert.equal(env.engine.playing, true);
    assert.equal(env.engine.audio.loop, true); await ended(env); assert.equal(env.engine.trackId, 'a');
  });
  await test('随机袋与历史更新后不含已跳过歌曲，上一首不会回到它', async () => {
    const env = environment(); env.engine.setScope('all'); env.engine.setMode('shuffle'); await env.engine.start();
    const seen = [env.engine.trackId]; await env.engine.nextTrack(); seen.push(env.engine.trackId); await env.engine.nextTrack();
    await env.engine.setDisliked(seen); assert.equal(env.engine.history.every(id => !seen.includes(id)), true);
    await env.engine.previousTrack(); assert.equal(seen.includes(env.engine.trackId), false);
    for (let i = 0; i < 18; i++) { await ended(env); assert.equal(seen.includes(env.engine.trackId), false); }
  });
  await test('手动点已跳过歌曲不换源不启动，说明先恢复；恢复后可再次点播', async () => {
    const env = environment(); env.engine.setDisliked(['b']); const audio = env.engine.audio;
    assert.equal(env.engine.selectTrack('b'), false); assert.equal(env.engine.audio, audio); assert.equal(audio.playCalls, 0);
    assert.match(env.engine.message, /恢复.*再播放/); env.engine.setDisliked([]); assert.equal(env.engine.selectTrack('b'), true);
    assert.equal(await env.engine.start(), true); assert.equal(env.engine.trackId, 'b');
  });
  await test('整组不喜欢会停止音乐并明确全跳过；该系列仍可打开恢复而不是误播另一系列', async () => {
    const env = environment(); await env.engine.start(); await env.engine.setDisliked(['a','b','c']);
    assert.equal(env.engine.playing, false); assert.equal(env.engine.audio.paused, true); assert.match(env.engine.message, /都已跳过/);
    assert.equal(await env.engine.start(), false); assert.equal(env.engine.playing, false);
    env.engine.pause(true); env.engine.selectSeries('calm'); assert.equal(env.engine.trackId, 'd');
    env.engine.selectSeries('jazz'); assert.equal(env.engine.currentTrack().series, 'jazz'); assert.equal(env.engine.queue().length, 0);
    assert.equal(env.engine.audio.paused, true); assert.match(env.engine.message, /都已跳过/);
    env.engine.setDisliked(['a','c']); assert.equal(env.engine.trackId, 'b'); assert.equal(env.engine.playing, false);
    await env.engine.start(); assert.equal(env.engine.trackId, 'b'); assert.equal(env.engine.playing, true);
  });
  await test('收藏全被跳过时收藏仍保留且不假报音乐播放，雨火继续并可恢复音乐', async () => {
    const env = environment(); env.engine.setFavorites(['a','b']); env.engine.setScope('favorites'); env.engine.setRain(true); env.engine.setFire(true);
    await env.engine.start(); const rain = env.engine.rainSource, fire = env.engine.fireSource; await env.engine.setDisliked(['a','b']);
    assert.deepEqual([...env.engine.favorites], ['a','b']); assert.equal(env.engine.musicRunning, false); assert.equal(env.engine.playing, true);
    assert.equal(env.engine.rainSource, rain); assert.equal(env.engine.fireSource, fire); assert.match(env.engine.message, /都已跳过/);
    await env.engine.setDisliked(['a']); assert.equal(env.engine.trackId, 'b'); assert.equal(env.engine.musicRunning, true);
    assert.equal(env.engine.rainSource, rain); assert.equal(env.engine.fireSource, fire);
  });
  await test('标记后迟到的播放回执不能复活已跳过的旧歌，全跳过也没有残留', async () => {
    for (const ids of [['a'], ['a','b','c']]) {
      const env = environment(), wait = deferred(), old = env.engine.audio; old.playWait = wait;
      const pending = env.engine.start(); await env.engine.setDisliked(ids); wait.resolve(); await pending;
      assert.equal(old.paused, true); assert.equal(old.volume, 0); assert.equal(env.engine.musicRunning, ids.length === 1);
      assert.equal(env.engine.disliked.includes(env.engine.trackId) && env.engine.musicRunning, false);
    }
  });
  await test('不同范围全部歌曲都被跳过时next/previous安全返回，无循环死锁', async () => {
    const env = environment(); env.engine.setFavorites(['a','d']); env.engine.setDisliked(['a','b','c','d','e']);
    for (const scope of ['series','all','favorites']) for (const mode of ['list','shuffle','single']) {
      env.engine.setScope(scope); env.engine.setMode(mode); assert.equal(env.engine.nextTrack(), false); assert.equal(env.engine.previousTrack(), false);
      assert.equal(await env.engine.start(), false); assert.equal(env.engine.playing, false); assert.match(env.engine.message, /都已跳过/);
    }
  });
  await test('雨或火仍在等待AudioContext恢复时全组跳过不丢失环境声播放意图', async () => {
    for (const kind of ['Rain', 'Fire']) {
      const resume = deferred(), env = environment({ resume }); env.engine[`set${kind}`](true);
      const original = env.engine.start(); const update = env.engine.setDisliked(['a','b','c']);
      resume.resolve(); await Promise.all([original, update]);
      assert.equal(env.engine.musicRunning, false); assert.equal(env.engine.audio.paused, true); assert.equal(env.engine.playing, true);
      assert.equal(env.engine[`${kind.toLowerCase()}Source`].started, true); assert.match(env.engine.message, /都已跳过/);
    }
  });
  await test('仅环境声恢复仍pending时跳过当前曲目，保留雨火启动而不是卡在loading', async () => {
    for (const kind of ['Rain', 'Fire']) {
      const resume = deferred(), env = environment({ resume }); env.engine.setMusic(false); env.engine[`set${kind}`](true);
      const original = env.engine.start(); const update = env.engine.setDisliked(['a']); resume.resolve(); await Promise.all([original, update]);
      assert.equal(env.engine.trackId,'b'); assert.equal(env.engine.musicRunning,false); assert.equal(env.engine.audio.playCalls,0);
      assert.equal(env.engine[`${kind.toLowerCase()}Source`].started,true); assert.equal(env.engine.playing,true); assert.equal(env.engine.status,'playing');
    }
  });
  await test('队列空且无环境声时内部保持暂停，恢复歌曲或改变偏好不自动响', async () => {
    const env=environment(); env.engine.setDisliked(['a','b','c']); assert.equal(await env.engine.start(),false);
    assert.equal(env.engine.active,false); env.engine.setDisliked(['a','c']); assert.equal(env.engine.trackId,'b');
    assert.equal(env.engine.active,false); assert.equal(env.engine.audio.playCalls,0); env.engine.setRain(true);
    assert.equal(env.contexts.length,0); assert.equal(env.engine.playing,false);
  });
  await test('timeupdate不会触发状态重绘，保留仅元数据/真实状态更新', async () => {
    const env = environment(); await env.engine.start(); const count = env.states.length;
    env.engine.audio.dispatch('timeupdate'); env.engine.audio.dispatch('timeupdate'); assert.equal(env.states.length, count);
    env.engine.audio.dispatch('loadedmetadata'); assert.equal(env.states.length, count + 1);
  });
  console.log(JSON.stringify({ status: 'PASS', total: passed.length, checks: passed,
    limitation: 'Real engine evaluated in a Node VM with simulated media/context events. Verifies control flow, queues and generated buffer numerics, not real-browser playback permissions, subjective sound quality or operating-system background behavior.' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
