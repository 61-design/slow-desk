const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const directory = path.join(__dirname, '..');
const files = Object.fromEntries(['index.html', 'tracks.js', 'audio.js', 'analytics-config.js', 'analytics.js', 'app.js'].map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));
const preferenceKey = 'slow-desk-library-v1';
const passed = [], failed = [];

// This is a deliberately small DOM simulation, populated from the actual HTML.
// It supplies the browser APIs used by the shipped scripts; it contains no app
// event behavior, persistence decisions, track selection, or player logic.
function eventTarget() {
  return {
    listeners: {},
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== listener); },
    dispatch(type, event = {}) {
      event.type = type;
      event.target ||= this;
      event.preventDefault ||= function () { this.defaultPrevented = true; };
      for (const listener of [...this.listeners[type] || []]) listener(event);
      return event;
    }
  };
}

function documentFromHTML(html) {
  let document;
  class Element {
    constructor(tagName) {
      Object.assign(this, eventTarget());
      this.tagName = tagName.toUpperCase(); this.children = []; this.parentElement = null;
      this.attributes = new Map(); this.dataset = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.hidden = false;
      this.checked = false; this.disabled = false; this.value = ''; this.ownText = '';
      this.classList = {
        contains: value => this.className.split(/\s+/).includes(value),
        toggle: (value, force) => {
          const values = new Set(this.className.split(/\s+/).filter(Boolean));
          const add = force === undefined ? !values.has(value) : force;
          if (add) values.add(value); else values.delete(value);
          this.className = [...values].join(' '); return add;
        }
      };
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'hidden' || name === 'checked' || name === 'disabled') this[name] = true;
      if (name === 'value') this.value = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null; this.removed = true;
    }
    matches(selector) {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector === '[contenteditable="true"]') return this.getAttribute('contenteditable') === 'true';
      return this.tagName === selector.toUpperCase();
    }
    closest(selector) {
      const selectors = selector.split(',').map(value => value.trim());
      for (let element = this; element; element = element.parentElement) {
        if (selectors.some(value => element.matches(value))) return element;
      }
      return null;
    }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) {
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const root = new Element('document'), stack = [root];
  const voidTags = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'source']);
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/([\w:-]+)\s*>|<([\w:-]+)([^>]*?)>|([^<]+)/g)) {
    if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (match[2]) {
      const element = new Element(match[2]);
      for (const attribute of match[3].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        element.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      }
      stack.at(-1).appendChild(element);
      if (!voidTags.has(match[2].toLowerCase()) && !/\/\s*$/.test(match[3])) stack.push(element);
    } else if (match[4]) stack.at(-1).ownText += match[4];
  }
  document = Object.assign(eventTarget(), {
    hidden: false, body: root.querySelector('body'), activeElement: null,
    createElement: tagName => new Element(tagName),
    getElementById: id => root.querySelector(`#${id}`),
    querySelectorAll: selector => root.querySelectorAll(selector)
  });
  assert.ok(document.body, 'Actual HTML fixture must contain a body');
  return { document, Element };
}

function environment({ stored = null, rainAvailable = true, storageBlocked = false, search = '', mobile = false, legacyMediaQuery = false } = {}) {
  const { document, Element } = documentFromHTML(files['index.html']);
  let now = 0, timerId = 0;
  const timers = new Map(), audios = [], writes = [], contexts = [];
  const store = new Map(stored === null ? [] : [[preferenceKey, stored]]);
  class FakeAudio extends Element {
    constructor(src) {
      super('audio'); Object.assign(this, { src, paused: true, volume: 1, duration: 156, currentTime: 0, ended: false, playCalls: 0 }); audios.push(this);
    }
    play() { this.playCalls++; this.ended = false; this.paused = false; return Promise.resolve(); }
    load() { this.currentTime = 0; this.ended = false; this.error = null; this.paused = true; this.currentSrc = this.src; }
    pause() { this.paused = true; this.dispatch('pause'); }
  }
  const parameter = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; }, setValueAtTime(value) { this.value = value; } });
  const node = () => ({ connect(target) { return target; }, disconnect() {} });
  class FakeContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 1000; this.destination = node(); this.gains = []; this.sources = []; contexts.push(this); }
    async resume() { this.state = 'running'; }
    createGain() { const gain = Object.assign(node(), { gain: parameter() }); this.gains.push(gain); return gain; }
    async decodeAudioData() { const buffer = this.createBuffer(1, this.sampleRate); buffer.getChannelData(0).fill(.07); return buffer; }
    createBiquadFilter() { return Object.assign(node(), { frequency: parameter() }); }
    createBuffer(channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createBufferSource() { const source = Object.assign(node(), { started:false, stopped:false, start() { this.started=true; }, stop() { this.stopped=true; } }); this.sources.push(source); return source; }
  }
  const epoch = Date.UTC(2026, 7, 31, 5, 0);
  class FakeDate extends Date { constructor(value) { super(value === undefined ? epoch + now : value); } static now() { return epoch + now; } }
  const window = eventTarget();
  window.location = {search};
  window.matchMedia = () => legacyMediaQuery ? {matches:mobile, addListener(listener) { this.listener = listener; }} : Object.assign(eventTarget(), {matches:mobile});
  if (rainAvailable) window.AudioContext = FakeContext;
  const sandbox = vm.createContext({
    document, window, fetch:async () => ({ok:true,arrayBuffer:async () => new ArrayBuffer(4)}), URL, URLSearchParams, navigator:{}, Audio: FakeAudio, Date: FakeDate, performance: { now: () => now },
    localStorage: {
      getItem(key) { if (storageBlocked) throw new Error('Storage denied'); return store.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error('Storage denied'); writes.push({ key, value }); store.set(key, value); }
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const startupErrors = [];
  for (const name of ['tracks.js', 'audio.js', 'analytics-config.js', 'analytics.js', 'app.js']) {
    try { vm.runInContext(files[name], sandbox, { filename: name }); }
    catch (error) { if (!legacyMediaQuery) throw error; startupErrors.push(error.message); }
  }
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const element = id => {
    const result = document.getElementById(id); assert.ok(result, `Actual HTML element #${id} is required`); return result;
  };
  return { document, window, audios, writes, contexts, store, element, flush, startupErrors,
    tracks: window.CALM_TRACKS,
    async event(id, type, values = {}) { const result = element(id).dispatch(type, values); await flush(); return result; },
    async clickTrack(index) { element('track-list').children[index].dispatch('click'); await flush(); },
    async key(values) { const result = document.dispatch('keydown', { target: document.body, ...values }); await flush(); return result; },
    preference() { return JSON.parse(store.get(preferenceKey)); },
    selected() { return element('track-list').querySelectorAll('.track').filter(button => button.getAttribute('aria-pressed') === 'true'); },
    advance(duration) {
      const end = now + duration;
      for (;;) {
        const next = [...timers].filter(([, task]) => task.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due; timers.delete(next[0]); next[1].callback();
      }
      now = end;
    }
  };
}

function assertPlayer(env, playing) {
  for (const id of ['play', 'mini-play']) {
    assert.equal(env.element(id).getAttribute('aria-label'), playing ? '暂停背景声音' : '播放背景声音');
    assert.equal(env.element(id).querySelector('use').getAttribute('href'), playing ? '#i-pause' : '#i-play');
  }
  assert.match(env.element('play').querySelector('span').textContent, playing ? /^暂停/ : /^(播放|挑选)/);
}

const array = values => Array.from(values);
const selectedId = env => env.selected()[0]?.dataset.track;
const visibleIds = env => env.element('track-list').children.filter(row => !row.hidden).map(row => row.querySelector('.track').dataset.track);
const seriesIds = (env, series) => array(env.tracks.filter(track => track.series === series).map(track => track.id));
const trackButton = (env, id) => env.element('track-list').querySelectorAll('.track').find(button => button.dataset.track === id);
const currentMedia = env => env.audios.findLast(audio => !audio.removed && audio.id === 'background-music');
async function choose(env, id, value, type = 'change') {
  env.element(id).value = value;
  return env.event(id, type);
}
async function toggle(env, id, value) {
  env.element(id).checked = value;
  return env.event(id, 'change');
}
async function star(env, id) {
  trackButton(env, id).parentElement.querySelector('.favorite-button').dispatch('click'); await env.flush();
}
async function dislike(env, id) {
  trackButton(env, id).parentElement.querySelector('.dislike-button').dispatch('click'); await env.flush();
}
async function selectTrack(env, id) {
  const button = trackButton(env, id);
  assert.ok(button && !button.parentElement.hidden, `${id} must be visible before choosing it`);
  button.dispatch('click'); await env.flush();
}
async function selectSeries(env, id) {
  env.element('series-list').children.find(button => button.dataset.series === id).dispatch('click'); await env.flush();
}
async function test(name, run) {
  try { await run(); passed.push(name); }
  catch (error) { failed.push({ name, error: error.stack || String(error) }); }
}

(async () => {
  await test('旧版媒体查询接口下，首屏播放暂停与自然声独听都直接生效', async () => {
    const env = environment({legacyMediaQuery:true,mobile:true});
    await env.event('play','click'); env.advance(1000);
    assert.equal(currentMedia(env).paused,false, '首屏播放必须直接启动歌曲，无需点歌曲标题');
    assert.ok(currentMedia(env).volume > 0);
    await env.event('play','click'); env.advance(300);
    assert.equal(currentMedia(env).paused,true);
    await env.event('nature-tab','click');
    assert.equal(env.element('nature-pane').hidden,false);
    await toggle(env,'ocean-toggle',true);
    assert.equal(currentMedia(env).paused,true, '自然声独听不得依赖音乐');
    assert.ok(env.contexts[0].sources.some(source => source.started && !source.stopped));
    assert.equal(env.element('current-title').textContent,'海浪');
    assert.deepEqual(env.startupErrors,[]);
  });
  await test('自然声独听和混合播放时，主/迷你播放器准确显示声音并提供适用操作', async () => {
    const env = environment();
    assert.equal(env.element('current-series').textContent, '为你选好');
    assert.equal(env.element('play').querySelector('span').textContent, '播放《不问来处》');
    await toggle(env, 'ocean-toggle', true);
    assert.equal(env.element('current-title').textContent, '海浪');
    assert.equal(env.element('mini-title').textContent, '海浪');
    for (const id of ['previous','next','mini-next','mini-mode','share-track','music-play-options']) assert.equal(env.element(id).hidden, true, id);
    assert.equal(env.element('ocean-mix').hidden, false);
    await selectTrack(env, 'echo-public-night');
    assert.equal(env.element('current-title').textContent, '不问来处 ＋ 海浪');
    assert.equal(env.element('mini-title').textContent, '不问来处 ＋ 海浪');
    assert.equal(env.element('share-track').hidden, false);
    await toggle(env, 'music-toggle', false); assert.equal(env.element('current-title').textContent, '海浪');
    await env.event('remove-ocean','click'); assertPlayer(env, false); assert.equal(env.element('current-title').textContent, '此刻，安静');
  });
  await test('分享歌曲在之前只听自然声的偏好下仍明确选中音乐，且不自动发声', async () => {
    const env = environment({stored:JSON.stringify({trackId:'echo-public-dawn',music:false,ocean:true}),search:'?track=echo-public-night'});
    assert.match(env.element('current-title').textContent,/不问来处/);
    assert.equal(env.element('current-series').textContent,'朋友分享给你');
    assert.equal(env.element('music-pane').hidden,false);
    assert.equal(currentMedia(env).playCalls,0); assert.equal(env.contexts.length,0);
  });
  await test('音乐被浏览器拒绝而自然声成功时，标题只报告实际在播的声音', async () => {
    const env = environment();
    currentMedia(env).play = () => Promise.reject(new Error('blocked'));
    await toggle(env, 'ocean-toggle', true); await toggle(env, 'music-toggle', true);
    assert.equal(env.element('current-title').textContent, '海浪');
    assert.equal(env.element('mini-title').textContent, '海浪');
    assert.equal(env.element('share-track').hidden,true);
    assert.match(env.element('play-status').textContent,/音乐暂时未能播放/);
  });
  await test('音乐/自然声入口只切换浏览，键盘切换与当前声音保持独立', async () => {
    const env = environment(); await selectTrack(env, 'echo-public-night');
    const media = currentMedia(env), calls = media.playCalls, saved = env.store.get(preferenceKey);
    await env.event('nature-tab','click');
    assert.equal(env.element('music-pane').hidden, true); assert.equal(env.element('nature-pane').hidden, false);
    assert.equal(env.element('nature-tab').getAttribute('aria-selected'), 'true');
    assert.equal(currentMedia(env),media); assert.equal(media.playCalls,calls); assert.equal(env.store.get(preferenceKey),saved);
    await env.event('nature-tab','keydown',{key:'ArrowLeft'});
    assert.equal(env.element('music-pane').hidden, false); assert.equal(env.document.activeElement,env.element('music-tab'));
    assert.equal(media.paused,false);
  });
  await test('暂停时点歌曲立即播放，环境声独听时选曲也会开启音乐', async () => {
    const env = environment();
    await selectTrack(env, 'echo-public-night'); assertPlayer(env, true);
    assert.equal(currentMedia(env).playCalls, 1);
    await env.event('play', 'click'); assertPlayer(env, false);
    await toggle(env, 'rain-toggle', true); assert.equal(currentMedia(env).paused, true);
    await selectTrack(env, 'echo-public-dawn'); assertPlayer(env, true);
    assert.equal(currentMedia(env).paused, false); assert.equal(env.element('music-toggle').checked, true);
    assert.equal(env.element('rain-toggle').checked, true);
  });
  await test('四种环境声各自能独听，音量独立，全部关闭后暂停', async () => {
    for (const kind of ['rain','fire','ocean','stream']) {
      const env = environment(); await toggle(env, `${kind}-toggle`, true);
      assertPlayer(env, true); assert.equal(currentMedia(env).playCalls, 0);
      assert.equal(env.element('music-toggle').checked, false);
      assert.equal(env.contexts[0].sources.filter(source => source.started && !source.stopped).length, 1);
      await choose(env, `${kind}-volume`, '41', 'input'); assert.equal(env.preference()[`${kind}Volume`], .41);
      const restored = environment({stored:JSON.stringify(env.preference())});
      assert.equal(restored.element(`${kind}-toggle`).checked, true); assert.equal(Number(restored.element(`${kind}-volume`).value), 41);
      assertPlayer(restored, false); assert.equal(restored.contexts.length, 0);
      await toggle(env, `${kind}-toggle`, false); assertPlayer(env, false);
    }
  });
  await test('主动打开环境声立即发声，关闭音乐可独立听雨，恢复偏好不自动播放', async () => {
    const env = environment();
    await toggle(env, 'rain-toggle', true); assertPlayer(env, true);
    assert.equal(env.contexts.length, 1); assert.equal(env.contexts[0].state, 'running');
    assert.equal(env.contexts[0].sources.filter(source => source.started && !source.stopped).length, 1);
    assert.equal(currentMedia(env).paused, true); assert.equal(currentMedia(env).playCalls, 0);
    await toggle(env, 'fire-toggle', true);
    assert.equal(env.contexts[0].sources.filter(source => source.started && !source.stopped).length, 2);
    await toggle(env, 'rain-toggle', false); await toggle(env, 'fire-toggle', false); assertPlayer(env, false);
    await toggle(env, 'rain-toggle', true); assertPlayer(env, true);
    const restored = environment({stored:JSON.stringify(env.preference())});
    assert.equal(restored.element('rain-toggle').checked, true); assertPlayer(restored, false);
    assert.equal(restored.contexts.length, 0);
  });
  await test('播放中浏览其他系列不换曲、不重启媒体、不更改队列与偏好', async () => {
    const env = environment(); await env.event('play', 'click'); env.advance(1000);
    const media = currentMedia(env), count = media.playCalls, saved = env.store.get(preferenceKey);
    for (const id of ['jazz', 'calm', 'lofi']) {
      await selectSeries(env, id); assert.equal(currentMedia(env), media); assert.equal(media.playCalls, count);
      assert.equal(selectedId(env), 'echo-public-night'); assert.deepEqual(visibleIds(env), seriesIds(env, id));
      assert.equal(env.store.get(preferenceKey), saved); assertPlayer(env, true);
    }
    await env.event('next','click'); assert.equal(selectedId(env), 'echo-public-dawn');
    assert.deepEqual(visibleIds(env), seriesIds(env, 'lofi'));
    await selectTrack(env, seriesIds(env, 'lofi')[0]); assert.equal(selectedId(env), seriesIds(env, 'lofi')[0]);
    await env.event('next','click'); assert.equal(selectedId(env), seriesIds(env, 'lofi')[1]);
  });
  await test('暂停浏览系列不改歌曲，鼓励句可切换且不写入存储，沉浸时也可用', async () => {
    const env = environment(), before = env.writes.length;
    await selectSeries(env, 'acoustic'); assert.equal(selectedId(env), 'echo-public-night');
    assert.equal(env.writes.length, before); assert.equal(env.audios.every(audio => !audio.playCalls), true);
    assert.equal(env.document.getElementById('thought'), null);
    let text = env.element('encouragement').textContent;
    for (let i = 0; i < 20; i++) {
      await env.event('next-encouragement','click'); assert.notEqual(env.element('encouragement').textContent, text);
      text = env.element('encouragement').textContent;
    }
    await env.event('immersion','click'); await env.event('next-encouragement','click');
    assert.notEqual(env.element('encouragement').textContent, text); assert.equal(env.writes.length, before);
  });
  await test('手机底部播放条常驻，播放暂停和退出安静模式后仍可用', async () => {
    const env=environment({mobile:true});
    assert.equal(env.element('mini-player').hidden,false);
    await env.event('mini-play','click'); env.advance(1000); assertPlayer(env,true);
    assert.equal(currentMedia(env).paused,false);
    await env.event('mini-play','click'); env.advance(300); assertPlayer(env,false);
    assert.equal(currentMedia(env).paused,true);
    assert.equal(env.element('mini-player').hidden,false);
    await env.event('immersion','click'); assert.equal(env.element('mini-player').hidden,false);
    await env.event('immersion','click'); assert.equal(env.element('mini-player').hidden,false);
  });

  await test('不支持可见性观察时手机保留播放条；桌面只在沉浸时显示', async () => {
    for (const mobile of [true, false]) {
      const env = environment({mobile});
      assert.equal(env.element('mini-player').hidden, !mobile);
      await env.event('immersion', 'click'); assert.equal(env.element('mini-player').hidden, false);
      await env.event('immersion', 'click'); assert.equal(env.element('mini-player').hidden, !mobile);
    }
  });
  await test('分享歌曲优先于历史歌曲和收藏范围，不自动播放；不喜欢仍需恢复', async () => {
    const stored = JSON.stringify({trackId:'echo-public-night',scope:'favorites',favorites:['echo-public-night']});
    const env = environment({stored,search:'?track=echo-public-dawn&from=share'});
    assert.equal(selectedId(env),'echo-public-dawn'); assert.equal(env.element('play-scope').value,'series');
    assert.equal(env.audios.every(audio => audio.playCalls === 0),true);
    const skipped = environment({stored:JSON.stringify({trackId:'echo-public-night',disliked:['echo-public-dawn']}),search:'?track=echo-public-dawn'});
    assert.equal(selectedId(skipped),'echo-public-night'); assert.match(skipped.element('play-status').textContent,/恢复/);
    const invalid = environment({stored,search:'?track=invalid'});
    assert.equal(selectedId(invalid),'echo-public-night');
  });

  await test('实际曲库数量与系列/曲目界面一致，默认午夜来信与列表循环且不自动发声', async () => {
    const env = environment();
    assert.ok(env.tracks.length > 0); assert.equal(new Set(env.tracks.map(track => track.id)).size, env.tracks.length);
    assert.equal(env.element('series-list').children.length, env.window.MUSIC_SERIES.length);
    assert.equal(env.element('track-list').children.length, env.tracks.length);
    assert.equal(env.element('library-total').textContent, `${env.window.MUSIC_SERIES.length} 个系列 · ${env.tracks.length} 首`);
    assert.equal(env.element('play-mode').value, 'list'); assert.equal(env.element('play-scope').value, 'series');
    assert.deepEqual(visibleIds(env), seriesIds(env, 'midnight'));
    assert.equal(selectedId(env), 'echo-public-night'); assert.equal(env.audios.every(audio => audio.playCalls === 0), true);
    assert.equal(env.contexts.length, 0); assertPlayer(env, false);
  });
  await test('暂停切换全部系列，清单与系列说明一致且不启动媒体', async () => {
    const env = environment();
    for (const series of env.window.MUSIC_SERIES) {
      await selectSeries(env, series.id);
      assert.equal(env.document.body.dataset.series, series.id);
      assert.equal(env.element('library-title').textContent, series.title);
      assert.equal(env.element('series-description').textContent, series.description);
      assert.deepEqual(visibleIds(env), seriesIds(env, series.id));
      assert.equal(env.element('track-count').textContent, `${seriesIds(env, series.id).length} 首 · 列表循环`);
      assert.equal(env.audios.every(audio => audio.playCalls === 0), true);
    }
  });
  await test('搜索全库而非当前系列，输入搜索不改变当前曲目或播放', async () => {
    const env = environment(); await env.event('play', 'click'); env.advance(1000);
    const current = selectedId(env), media = currentMedia(env), writes = env.writes.length;
    const target = env.tracks.find(track => track.series === 'chill');
    await choose(env, 'search', target.title.toUpperCase(), 'input');
    assert.ok(visibleIds(env).includes(target.id)); assert.equal(env.element('library-title').textContent, '搜索结果');
    assert.equal(selectedId(env), current); assert.equal(currentMedia(env), media); assert.equal(media.paused, false);
    assert.equal(env.writes.length, writes); assert.equal(env.element('clear-search').hidden, false);
  });
  await test('点击跨系列搜索结果清空搜索并进入该系列，继续新曲播放', async () => {
    const env = environment(); await env.event('play', 'click'); env.advance(1000);
    const target = env.tracks.find(track => track.series === 'chill');
    await choose(env, 'search', target.title, 'input'); await selectTrack(env, target.id); env.advance(1300);
    assert.equal(selectedId(env), target.id); assert.equal(env.element('search').value, '');
    assert.equal(env.element('play-scope').value, 'series'); assert.deepEqual(visibleIds(env), seriesIds(env, target.series));
    assert.equal(env.audios.filter(audio => !audio.paused).length, 1); assertPlayer(env, true);
    assert.equal(env.element('mini-title').textContent, target.title);
  });
  await test('无结果搜索有空态，清除后还原播放范围而不换曲', async () => {
    const env = environment(); const selected = selectedId(env);
    await choose(env, 'search', 'unlikely-music-needle-987654321', 'input');
    assert.deepEqual(visibleIds(env), []); assert.equal(env.element('empty-library').hidden, false);
    assert.match(env.element('empty-library').textContent, /搜索不会打断/);
    await env.event('clear-search', 'click');
    assert.equal(selectedId(env), selected); assert.equal(env.element('search').value, '');
    assert.equal(env.element('empty-library').hidden, true); assert.deepEqual(visibleIds(env), seriesIds(env, 'midnight'));
    assert.equal(env.document.activeElement, env.element('search'));
  });
  await test('收藏星标可增删，更新无障碍名称与存储，不改变曲目', async () => {
    const env = environment(), target = env.tracks[1], selected = selectedId(env);
    await star(env, target.id);
    const button = trackButton(env, target.id).parentElement.querySelector('.favorite-button');
    assert.equal(button.textContent, '★'); assert.equal(button.getAttribute('aria-label'), `取消收藏 ${target.title}`);
    assert.deepEqual(env.preference().favorites, [target.id]); assert.equal(selectedId(env), selected);
    await star(env, target.id); assert.equal(button.textContent, '☆');
    assert.equal(button.getAttribute('aria-pressed'), 'false'); assert.deepEqual(env.preference().favorites, []);
  });
  await test('空收藏范围显示空态，播放不会偷偷启动其他音乐', async () => {
    const env = environment(); await choose(env, 'play-scope', 'favorites');
    assert.deepEqual(visibleIds(env), []); assert.equal(env.element('library-title').textContent, '我的收藏');
    assert.equal(env.element('empty-library').hidden, false); await env.event('play', 'click');
    assert.equal(env.audios.every(audio => audio.paused && audio.playCalls === 0), true);
    assert.match(env.element('play-status').textContent, /收藏夹还是空的/); assertPlayer(env, false);
  });
  await test('收藏范围只显示所选曲目并按列表循环，删空会停止音乐', async () => {
    const env = environment(), ids = [env.tracks[1].id, env.tracks.find(track => track.series === 'calm').id];
    for (const id of ids) await star(env, id);
    await choose(env, 'play-scope', 'favorites'); assert.deepEqual(visibleIds(env), ids);
    await env.event('play', 'click'); env.advance(1000); assert.equal(selectedId(env), ids[0]);
    await env.event('next', 'click'); env.advance(1300); assert.equal(selectedId(env), ids[1]);
    await env.event('mini-next', 'click'); env.advance(1300); assert.equal(selectedId(env), ids[0]);
    await star(env, ids[0]); await star(env, ids[1]); env.advance(500);
    assert.deepEqual(visibleIds(env), []); assert.equal(env.audios.every(audio => audio.paused), true);
    assert.match(env.element('play-status').textContent, /收藏夹还是空的/);
  });
  await test('主播放器三种方式和迷你方式同步，只有单曲方式启用原生loop', async () => {
    const env = environment();
    for (const [mode, label] of [['shuffle','随机'], ['single','单曲'], ['list','列表']]) {
      await choose(env, 'play-mode', mode);
      assert.equal(env.preference().mode, mode); assert.equal(env.element('mini-mode').textContent, label);
      assert.equal(currentMedia(env).loop, mode === 'single');
      assert.match(env.element('track-count').textContent, new RegExp(label));
    }
    for (const mode of ['shuffle','single','list']) {
      await env.event('mini-mode', 'click');
      assert.equal(env.element('play-mode').value, mode); assert.equal(env.preference().mode, mode);
    }
  });
  await test('当前系列与全部范围的首尾循环边界正确', async () => {
    const env = environment(); await selectSeries(env, 'jazz'); const jazz = seriesIds(env, 'jazz'); await selectTrack(env, jazz[0]);
    await env.event('previous', 'click'); assert.equal(selectedId(env), jazz.at(-1));
    await env.event('next', 'click'); assert.equal(selectedId(env), jazz[0]);
    await choose(env, 'play-scope', 'all'); assert.equal(visibleIds(env).length, env.tracks.length);
    await env.event('previous', 'click'); assert.equal(selectedId(env), env.tracks.at(-1).id);
    await env.event('next', 'click'); assert.equal(selectedId(env), env.tracks[0].id);
    await choose(env, 'play-scope', 'series'); assert.deepEqual(visibleIds(env), jazz);
  });
  await test('随机播放在本轮内不重复并可返回真正上一首', async () => {
    const env = environment(); await selectSeries(env, 'jazz'); await selectTrack(env, seriesIds(env, 'jazz')[0]); await choose(env, 'play-mode', 'shuffle');
    const seen = [selectedId(env)], count = seriesIds(env, 'jazz').length;
    for (let i=1; i<count; i++) { await env.event('next', 'click'); seen.push(selectedId(env)); }
    assert.equal(new Set(seen).size, count);
    await env.event('previous', 'click'); assert.equal(selectedId(env), seen.at(-2));
    await env.event('next', 'click'); assert.equal(selectedId(env), seen.at(-1));
    await env.event('next', 'click'); assert.notEqual(selectedId(env), seen.at(-1));
  });
  await test('音乐零音量不影响雨火，三者独立开关音量并可仅听环境声', async () => {
    const env = environment(); await toggle(env, 'rain-toggle', true); await toggle(env, 'fire-toggle', true);
    assert.equal(env.contexts.length, 1, 'Direct ambient switches start the selected mix');
    env.advance(1000);
    const context = env.contexts[0];
    assert.equal(context.sources.filter(source => source.started && !source.stopped).length, 2);
    const ambientGains = context.gains.map(node => node.gain.value);
    assert.equal(ambientGains.every(value => value > 0), true, 'The actual ambient gain graph must be audible');
    await choose(env, 'volume', '0', 'input'); env.advance(300); assert.equal(currentMedia(env).volume, 0);
    assert.equal(context.sources.filter(source => source.started && !source.stopped).length, 2);
    assert.deepEqual(context.gains.map(node => node.gain.value), ambientGains, 'Music volume must not lower any ambient gain');
    assert.doesNotMatch(env.element('play-status').textContent, /音量为零/);
    await choose(env, 'rain-volume', '44', 'input'); await choose(env, 'fire-volume', '19', 'input');
    assert.equal(env.preference().rainVolume, .44); assert.equal(env.preference().fireVolume, .19);
    assert.equal(context.gains[0].gain.value, 1); assert.equal(context.gains[1].gain.value, .44); assert.equal(context.gains[2].gain.value, .19);
    await toggle(env, 'rain-toggle', false); assert.equal(context.sources.filter(source => source.started && !source.stopped).length, 1);
    assert.equal(env.element('fire-toggle').checked, true); await toggle(env, 'music-toggle', false);
    assert.equal(currentMedia(env).paused, true); assertPlayer(env, true); assert.equal(env.element('mini-title').textContent, '篝火');
    await toggle(env, 'fire-toggle', false); assertPlayer(env, false);
    assert.equal(context.sources.filter(source => source.started && !source.stopped).length, 0);
  });
  await test('定时选择显示截止时间，取消清空，期限到后播放与选择均复位', async () => {
    const env = environment(); await choose(env, 'sleep-timer', '30');
    assert.equal(String(env.element('sleep-timer').value), '30'); assert.match(env.element('sleep-status').textContent, /将于 .* 关闭/);
    await choose(env, 'sleep-timer', '0'); assert.equal(env.element('sleep-status').textContent, '不定时关闭');
    await env.event('play', 'click'); await choose(env, 'sleep-timer', '15'); env.advance(15*60000 + 500); await env.flush();
    assertPlayer(env, false); assert.equal(currentMedia(env).paused, true);
    assert.equal(String(env.element('sleep-timer').value), '0'); assert.match(env.element('play-status').textContent, /定时已结束/);
  });
  await test('只保存15项白名单偏好，鼓励句、搜索及定时信息不进入localStorage', async () => {
    const env = environment();
    assert.equal(env.document.getElementById('thought'), null); await choose(env, 'search', 'private-search-987654', 'input');
    await choose(env, 'sleep-timer', '60'); await star(env, env.tracks[1].id);
    assert.deepEqual(Object.keys(env.preference()).sort(), ['trackId','volume','music','rain','fire','rainVolume','fireVolume','ocean','stream','oceanVolume','streamVolume','mode','scope','favorites','disliked'].sort());
    assert.equal(env.writes.every(write => write.key === preferenceKey && !write.value.includes('private-')), true);
    env.window.dispatch('pagehide'); await env.flush();
    assert.equal(env.document.getElementById('thought'), null); assert.equal(env.element('search').value, '');
  });
  await test('刷新恢复曲目、收藏、播放方式及音量但不恢复定时或自动响', async () => {
    const first = environment(); const target = first.tracks.find(track => track.series === 'calm');
    await star(first, target.id); await selectSeries(first, 'calm'); await selectTrack(first, target.id);
    await choose(first, 'play-mode', 'shuffle'); await choose(first, 'play-scope', 'favorites');
    await toggle(first, 'rain-toggle', true); await toggle(first, 'fire-toggle', true); await choose(first, 'volume', '26', 'input');
    await choose(first, 'sleep-timer', '30'); await first.event('play', 'click');
    const env = environment({stored:JSON.stringify(first.preference())});
    assert.equal(selectedId(env), target.id); assert.deepEqual(env.preference().favorites, [target.id]);
    assert.equal(env.element('play-mode').value, 'shuffle'); assert.equal(env.element('play-scope').value, 'favorites');
    assert.equal(Number(env.element('volume').value), 26); assert.equal(env.element('rain-toggle').checked, true); assert.equal(env.element('fire-toggle').checked, true);
    assert.equal(String(env.element('sleep-timer').value), '0'); assert.equal(env.audios.every(audio => audio.playCalls === 0), true);
    assert.equal(env.contexts.length, 0); assertPlayer(env, false);
  });
  await test('许可弹窗按实际曲库完整生成作者署名与原页/许可链接，重复打开不复制', async () => {
    const env = environment(); await env.event('open-credits', 'click');
    assert.equal(env.element('credits-dialog').open, true);
    const licensed = array(env.tracks.filter(track => track.sourceUrl)), items = env.element('credits-list').children;
    assert.equal(items.length, licensed.length); assert.ok(licensed.length > 0);
    for (let i=0; i<items.length; i++) {
      const track = licensed[i], links = items[i].querySelectorAll('a');
      assert.equal(items[i].querySelector('h3').textContent, `${track.title} — ${track.artist}`);
      assert.equal(items[i].querySelector('p').textContent, track.attribution);
      assert.equal(links.length, track.licenseUrl ? 2 : 1); assert.equal(links[0].href, track.sourceUrl);
      if (track.licenseUrl) {
        assert.equal(links[1].href, track.licenseUrl);
        assert.match(track.licenseUrl, /^https:\/\/creativecommons\.org\/(?:licenses\/by\/4\.0|publicdomain\/zero\/1\.0)\//);
      }
      for (const link of links) assert.equal(link.rel, 'noopener noreferrer');
    }
    await env.event('close-credits', 'click'); assert.equal(env.element('credits-dialog').open, false);
    await env.event('open-credits', 'click'); assert.equal(env.element('credits-list').children.length, licensed.length);
  });
  await test('自然播放结束复用媒体进入下一首，主/迷你标题与选中行同步更新', async () => {
    const env = environment(); await selectSeries(env, 'jazz'); await selectTrack(env, seriesIds(env, 'jazz')[0]); env.advance(1000);
    const media = currentMedia(env), target = env.tracks[1];
    media.currentTime=media.duration; media.ended=true; media.paused=true; media.dispatch('pause'); media.dispatch('ended');
    await env.flush(); env.advance(1200);
    assert.equal(currentMedia(env), media); assert.equal(media.src, target.src); assert.equal(media.paused, false);
    assert.equal(selectedId(env), target.id); assert.equal(env.element('mini-title').textContent, target.title);
    assert.equal(env.element('now-track').textContent, `当前选择 · ${target.title}`); assert.equal(env.selected().length, 1); assertPlayer(env, true);
  });
  await test('输入框、下拉框、按钮、summary及许可弹窗不会被全局空格劫持', async () => {
    const env = environment();
    for (const id of ['next-encouragement','search','volume','play-mode','play-scope','sleep-timer','mini-mode']) {
      const event = await env.key({key:' ',code:'Space',target:env.element(id)});
      assert.notEqual(event.defaultPrevented, true); assertPlayer(env, false);
    }
    let event = await env.key({key:' ',code:'Space',target:env.document.querySelectorAll('summary')[0]});
    assert.notEqual(event.defaultPrevented, true);
    await env.event('open-credits', 'click'); event = await env.key({key:' ',code:'Space'});
    assert.notEqual(event.defaultPrevented, true); assertPlayer(env, false);
    await env.event('close-credits', 'click'); event = await env.key({key:' ',code:'Space'});
    assert.equal(event.defaultPrevented, true); assertPlayer(env, true);
    await env.event('immersion', 'click'); assert.equal(env.element('mini-player').hidden, false);
    await env.key({key:'Escape',code:'Escape'}); assert.equal(env.element('mini-player').hidden, true);
  });
  await test('不可用存储或无WebAudio时仍能选择音乐播放，环境声明确禁用', async () => {
    const env = environment({storageBlocked:true,rainAvailable:false});
    assert.equal(env.element('rain-toggle').disabled, true); assert.equal(env.element('fire-toggle').disabled, true);
    assert.equal(env.element('rain-volume').disabled, true); assert.equal(env.element('fire-volume').disabled, true);
    await selectSeries(env, 'acoustic'); await env.event('play', 'click'); env.advance(1000);
    assertPlayer(env, true); assert.equal(currentMedia(env).paused, false); assert.equal(env.contexts.length, 0);
  });
  await test('切到后台保持音乐与环境声，离开页面停止声音', async () => {
    const env = environment(); await env.event('play', 'click'); await toggle(env, 'fire-toggle', true); env.advance(1000);
    env.document.hidden=true; env.document.dispatch('visibilitychange'); await env.flush();
    assert.equal(currentMedia(env).paused, false); assertPlayer(env, true);
    env.window.dispatch('pagehide'); await env.flush();
    assert.equal(currentMedia(env).paused, true); assertPlayer(env, false);
    assert.equal(env.contexts[0].sources.every(source => source.stopped), true);
  });

  await test('不喜欢按钮带明确文字和可访问名称，标记后保留曲目行并可键盘恢复', async () => {
    const env = environment(), track = env.tracks[1]; await selectSeries(env, 'jazz'); const row = trackButton(env, track.id).parentElement;
    const button = row.querySelector('.dislike-button'); assert.equal(button.tagName, 'BUTTON'); assert.equal(button.textContent, '不喜欢');
    assert.equal(button.getAttribute('aria-label'), `不喜欢 ${track.title}`); await dislike(env, track.id);
    assert.equal(row.hidden, false); assert.equal(row.dataset.disliked, 'true'); assert.equal(button.textContent, '恢复');
    assert.equal(button.getAttribute('aria-label'), `恢复播放 ${track.title}`); assert.equal(button.disabled, false);
    assert.equal(row.querySelector('.track-skipped').textContent, '已跳过'); assert.equal(row.querySelector('.track-skipped').hidden, false);
    assert.equal(trackButton(env, track.id).getAttribute('aria-disabled'), 'true'); button.focus(); assert.equal(env.document.activeElement, button);
    await dislike(env, track.id); assert.equal(row.dataset.disliked, 'false'); assert.equal(row.querySelector('.track-skipped').hidden, true);
    assert.equal(trackButton(env, track.id).getAttribute('aria-disabled'), 'false'); assert.deepEqual(env.preference().disliked, []);
  });
  await test('当前B歌标记后立即到原列表C歌，上一首跳过B，收藏与音频文件列表不被删除', async () => {
    const env = environment(), jazz = seriesIds(env, 'jazz'); await selectSeries(env, 'jazz'); await selectTrack(env, jazz[1]); await star(env, jazz[1]);
    env.advance(1000); const old = currentMedia(env); await dislike(env, jazz[1]);
    assert.equal(selectedId(env), jazz[2]); assert.equal(old.paused, true); assertPlayer(env, true);
    assert.deepEqual(env.preference().favorites, [jazz[1]]); assert.deepEqual(env.preference().disliked, [jazz[1]]);
    assert.equal(env.element('track-list').children.length, env.tracks.length); await env.event('previous', 'click'); assert.equal(selectedId(env), jazz[0]);
  });
  await test('搜索中点已跳过曲目明确提示先恢复，不改变搜索/范围/当前音乐', async () => {
    const env = environment(), target = env.tracks.find(track => track.series === 'chill'); await dislike(env, target.id);
    await env.event('play','click'); const current = selectedId(env), media = currentMedia(env); await choose(env, 'search', target.title, 'input');
    await selectTrack(env, target.id); assert.equal(selectedId(env), current); assert.equal(currentMedia(env), media);
    assert.equal(env.element('search').value, target.title); assert.match(env.element('play-status').textContent, /恢复.*再播放/);
    await dislike(env, target.id); await selectTrack(env, target.id); assert.equal(selectedId(env), target.id); assert.equal(env.element('search').value, '');
  });
  await test('全部爵士被跳过仍可从其他系列打开爵士并看到恢复按钮，恢复不会在暂停时突然出声', async () => {
    const env = environment(), jazz = seriesIds(env, 'jazz'); await selectSeries(env, 'jazz'); await selectTrack(env, jazz[0]); for (const id of jazz) await dislike(env, id);
    assertPlayer(env, false); assert.equal(env.audios.every(audio => audio.paused), true); assert.match(env.element('play-status').textContent, /都已跳过/);
    await selectSeries(env, 'calm'); await selectSeries(env, 'jazz'); assert.deepEqual(visibleIds(env), jazz);
    assert.match(env.element('play-status').textContent, /都已跳过/); await env.event('play','click'); assertPlayer(env, false);
    await env.event('play','click'); assertPlayer(env, false); await selectSeries(env,'calm'); await selectSeries(env,'jazz');
    // Explicitly keep a paused session before restoring; clicking Restore alone must not play.
    env.window.dispatch('pagehide'); await env.flush(); await dislike(env,jazz[1]); assertPlayer(env,false);
    assert.equal(env.audios.every(audio => audio.paused), true); await env.event('play','click'); assert.equal(selectedId(env),jazz[1]); assertPlayer(env,true);
  });
  await test('收藏歌被跳过仍显示在收藏中且不误播，恢复后重新进入队列', async () => {
    const env = environment(), target = env.tracks[1]; await star(env,target.id); await dislike(env,target.id); await choose(env,'play-scope','favorites');
    assert.deepEqual(visibleIds(env),[target.id]); assert.deepEqual(env.preference().favorites,[target.id]); await env.event('play','click'); assertPlayer(env,false);
    assert.match(env.element('play-status').textContent,/都已跳过/); await dislike(env,target.id); await env.event('play','click');
    assert.equal(selectedId(env),target.id); assertPlayer(env,true);
  });
  await test('刷新记住不喜欢与收藏，未知/重复/非字符串ID被过滤且不自动播放', async () => {
    const first = environment(), target = first.tracks[1]; await dislike(first,target.id); await star(first,target.id);
    const saved=first.preference(); saved.disliked.push('unknown-id',null,{},target.id); saved.untrusted='not-a-setting';
    const env=environment({stored:JSON.stringify(saved)}); assert.deepEqual(env.preference().disliked,[target.id]); assert.deepEqual(env.preference().favorites,[target.id]);
    assert.equal('untrusted' in env.preference(),false); assert.equal(env.audios.every(audio=>!audio.playCalls),true); assertPlayer(env,false);
    const row=trackButton(env,target.id).parentElement; assert.equal(row.querySelector('.dislike-button').textContent,'恢复');
    const invalid=environment({stored:JSON.stringify({disliked:'invalid'})}); assert.deepEqual(invalid.preference().disliked,[]);
  });
  await test('自然timeupdate不重绘不写偏好，避免大曲库周期性无效更新', async () => {
    const env=environment(); await env.event('play','click'); const count=env.writes.length; const media=currentMedia(env);
    for(let i=0;i<20;i++) media.dispatch('timeupdate'); await env.flush(); assert.equal(env.writes.length,count);
  });
  await test('午夜来信三首可循环、收藏和跳过，平台推荐不进入音频队列', async () => {
    const env = environment(); await selectSeries(env, 'midnight');
    const ids = ['echo-public-night', 'echo-public-dawn', 'echo-public-glow'];
    assert.deepEqual(visibleIds(env), ids);
    assert.equal(env.element('related-music').hidden, false);
    assert.equal(env.element('related-list').children.length, 3);
    await env.event('play', 'click');
    for (const id of [...ids.slice(1), ids[0]]) {
      await env.event('next', 'click'); assert.equal(selectedId(env), id);
      assert.match(currentMedia(env).src, /^assets\/echo-public-.*\.mp3$/);
    }
    await star(env, ids[0]); await dislike(env, ids[0]);
    assert.equal(selectedId(env), ids[1]); assert.ok(env.preference().favorites.includes(ids[0]));
    await env.event('next', 'click'); assert.equal(selectedId(env), ids[2]);
    await env.event('next', 'click'); assert.equal(selectedId(env), ids[1]);
    await dislike(env, ids[0]); await selectTrack(env, ids[0]); assertPlayer(env, true);
  });
  await test('平台推荐随系列和搜索显示；搜索结果不换曲且可直接打开平台', async () => {
    const env = environment(); await selectSeries(env, 'jazz'); assert.equal(env.element('related-music').hidden, true);
    await choose(env, 'search', 'Nujabes', 'input');
    assert.equal(env.element('related-music').hidden, false); assert.equal(env.element('related-music').open, true);
    assert.equal(env.element('empty-library').hidden, true); assert.deepEqual(visibleIds(env), []);
    const shown = env.element('related-list').children.filter(link => !link.hidden);
    assert.equal(shown.length, 1); assert.equal(shown[0].href, 'https://music.apple.com/us/song/1721843001');
    assert.equal(shown[0].target, '_blank'); assert.equal(shown[0].rel, 'noopener noreferrer');
    assert.equal(selectedId(env), 'echo-public-night'); assert.equal(env.audios.every(audio => audio.playCalls === 0), true);
    await env.event('clear-search', 'click'); assert.equal(env.element('related-music').hidden, true);
    await selectSeries(env, 'midnight'); await choose(env, 'play-scope', 'favorites');
    assert.equal(env.element('related-music').hidden, true);
  });
  await test('前往音乐平台时暂停书桌音乐与环境声，避免声音叠加', async () => {
    const env = environment(); await selectSeries(env, 'midnight');
    await toggle(env, 'rain-toggle', true); assertPlayer(env, true);
    env.element('related-list').children[0].dispatch('click'); await env.flush(); env.advance(500);
    assertPlayer(env, false); assert.equal(currentMedia(env).paused, true);
    assert.ok(env.contexts[0].sources.every(source => source.stopped));
  });
  const report = {
    status:failed.length?'FAIL':'PASS',total:passed.length+failed.length,passed:passed.length,failed:failed.length,
    checks:passed,failures:failed,
    inputs:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,{bytes:Buffer.byteLength(content),sha256:crypto.createHash('sha256').update(content).digest('hex')}])),
    limitations:[
      'Runs the actual current index.html, tracks.js, audio.js and app.js in Node VM with minimal DOM/media/Web Audio/timer/storage simulations.',
      'Does not verify real browser CSS, layout, focus trapping, native control behavior, accessibility tree, audio decoding, audible quality, or operating-system background policy.',
      'No browser automation was used. This is not a workaround for unavailable browser security verification.'
    ]
  };
  fs.writeFileSync(path.join(__dirname,'library-ui-results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2)); if(failed.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
