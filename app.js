/* Playback preferences stay local. Optional analytics never receives notes or search text. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const tracks = window.CALM_TRACKS;
  const series = window.MUSIC_SERIES;
  const recommendations = series.flatMap(collection => (collection.recommendations || []).map(track => ({...track, series:collection.id})));
  const preferenceKey = 'slow-desk-library-v1';
  const ambientKinds = ['rain','fire','ocean','stream'];
  const ambientNames = {rain:'轻雨',fire:'篝火',ocean:'海浪',stream:'流水'};
  const modes = {list:'列表循环',shuffle:'随机播放',single:'单曲循环'};
  let browsedSeries = null, browsedScope = null;
  const rows = new Map();
  const relatedRows = new Map();
  let ready = false, immersed = false, hasPlayed = false, audio, state, saved = {};
  const params = new URLSearchParams(window.location.search);
  const sharedTrack = tracks.find(track => track.id === params.get('track'));
  const analytics = window.SlowDeskAnalytics ? new window.SlowDeskAnalytics(window.SLOW_DESK_ANALYTICS || {}) : null;
  try { saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}') || {}; } catch (_) {}
  if (typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const duration = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  $('library-total').textContent = `${series.length} 个系列 · ${tracks.length} 首`;

  series.forEach(collection => {
    const button = document.createElement('button');
    button.className = 'series-button'; button.type = 'button';
    button.dataset.series = collection.id; button.textContent = collection.label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      $('search').value = '';
      browsedSeries = collection.id; browsedScope = 'series';
      renderLibrary();
    });
    $('series-list').appendChild(button);
  });

  tracks.forEach(track => {
    const row = document.createElement('div'); row.className = 'track-row';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'track'; button.dataset.track = track.id;
    button.setAttribute('aria-pressed', 'false');
    const content = document.createElement('span'); content.className = 'track-content';
    const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
    const description = document.createElement('span'); description.className = 'track-description'; description.textContent = track.series === 'midnight' ? 'AI 配乐 · 轻松陪伴' : track.subtitle;
    button.title = `${track.title} — ${track.artist || '慢慢书桌原创'} · ${track.subtitle}`;
    const heading = document.createElement('span'); heading.className = 'track-heading';
    const skipped = document.createElement('span'); skipped.className = 'track-skipped'; skipped.textContent = '已跳过'; skipped.hidden = true;
    heading.append(title, skipped); content.append(heading, description);
    const time = document.createElement('span'); time.className = 'track-time'; time.textContent = duration(track.duration);
    button.append(content, time);
    button.addEventListener('click', () => {
      if (state.disliked.includes(track.id)) { audio.selectTrack(track.id); return; }
      if ($('search').value.trim()) { $('search').value = ''; browsedScope = 'series'; }
      browsedSeries = track.series;
      audio.selectTrack(track.id, browsedScope || state.scope, true);
    });
    const star = document.createElement('button'); star.type = 'button'; star.className = 'favorite-button'; star.textContent = '☆';
    star.addEventListener('click', () => {
      const ids = new Set(state.favorites);
      if (ids.has(track.id)) ids.delete(track.id); else ids.add(track.id);
      audio.setFavorites([...ids]);
    });
    const dislike = document.createElement('button'); dislike.type = 'button'; dislike.className = 'dislike-button';
    dislike.addEventListener('click', () => {
      const ids = new Set(state.disliked);
      if (ids.has(track.id)) ids.delete(track.id); else ids.add(track.id);
      audio.setDisliked([...ids]);
    });
    row.append(button, star, dislike); $('track-list').appendChild(row);
    rows.set(track.id, {row, button, star, dislike, skipped, description});
  });

  recommendations.forEach(track => {
    const link = document.createElement('a'); link.className = 'related-track';
    link.href = track.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${track.title} — ${track.artist}，前往 ${track.platform}，在新标签页打开`);
    const content = document.createElement('span'); content.className = 'track-content';
    const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
    const artist = document.createElement('span'); artist.className = 'track-description'; artist.textContent = `${track.artist} · ${track.platform}`;
    const action = document.createElement('span'); action.className = 'related-action'; action.textContent = '去平台听 ↗';
    content.append(title, artist); link.append(content, action);
    link.addEventListener('click', () => audio.pause());
    $('related-list').appendChild(link); relatedRows.set(track.id, link);
  });

  function renderLibrary() {
    const selected = tracks.find(track => track.id === state.trackId);
    const collection = series.find(item => item.id === (browsedSeries || selected.series));
    const viewScope = browsedScope || state.scope;
    const favorites = new Set(state.favorites);
    const disliked = new Set(state.disliked);
    const query = $('search').value.trim().toLocaleLowerCase();
    const inScope = track => viewScope === 'all' || (viewScope === 'favorites' ? favorites.has(track.id) : track.series === collection.id);
    const matching = track => `${track.title} ${track.artist || ''} ${track.subtitle || ''}`.toLocaleLowerCase().includes(query);
    const visible = tracks.filter(track => query ? matching(track) : inScope(track));
    const related = recommendations.filter(track => query ? matching(track) : viewScope === 'all' || (viewScope === 'series' && track.series === collection.id));
    const relatedIds = new Set(related.map(track => track.id));
    for (const [id, row] of relatedRows) row.hidden = !relatedIds.has(id);
    $('related-music').hidden = related.length === 0;
    $('related-count').textContent = `${related.length} 首 · 去平台听`;
    if (query && related.length) $('related-music').open = true;
    const shown = new Set(visible.map(track => track.id));
    document.body.dataset.series = collection.id;
    document.querySelectorAll('.series-button').forEach(button => button.setAttribute('aria-pressed', String(!query && viewScope === 'series' && button.dataset.series === collection.id)));
    $('series-description').textContent = query ? '搜索全曲库；点选结果后进入它所在的系列。' : collection.description;
    $('library-title').textContent = query ? '搜索结果' : viewScope === 'favorites' ? '我的收藏' : viewScope === 'all' ? '全部音乐' : collection.title;
    const skippedCount = visible.filter(track => disliked.has(track.id)).length;
    $('track-count').textContent = `${visible.length} 首${skippedCount ? ' · 跳过 ' + skippedCount : ''}${query ? '' : ' · ' + modes[state.mode]}`;
    $('clear-search').hidden = !query;
    for (const track of tracks) {
      const {row, button, star, dislike, skipped, description} = rows.get(track.id);
      const subtitle = track.series === 'midnight' ? 'AI 配乐 · 轻松陪伴' : track.subtitle;
      description.textContent = `${track.id === state.trackId && state.musicPlaying ? '正在播放 · ' : ''}${subtitle}`;
      row.hidden = !shown.has(track.id);
      button.setAttribute('aria-pressed', String(track.id === state.trackId));
      const favorite = favorites.has(track.id);
      star.textContent = favorite ? '★' : '☆';
      star.setAttribute('aria-pressed', String(favorite));
      star.setAttribute('aria-label', `${favorite ? '取消收藏' : '收藏'} ${track.title}`);
      const isDisliked = disliked.has(track.id);
      row.dataset.disliked = String(isDisliked); skipped.hidden = !isDisliked;
      button.setAttribute('aria-disabled', String(isDisliked));
      dislike.textContent = isDisliked ? '恢复' : '不喜欢';
      dislike.setAttribute('aria-pressed', String(isDisliked));
      dislike.setAttribute('aria-label', `${isDisliked ? '恢复播放' : '不喜欢'} ${track.title}`);
      dislike.title = isDisliked ? '重新加入播放队列' : '跳过这首歌曲，可随时恢复';
    }
    $('empty-library').hidden = visible.length > 0 || related.length > 0;
    $('empty-library').textContent = query ? '没有找到，试试曲名、作者或乐器。搜索不会打断正在播放的音乐。' : '还没有收藏。点歌曲右侧的 ☆，把喜欢的留下。';
  }

  function slider(id, value) {
    const percent = Math.round(value * 100);
    $(id).value = percent; $(id).style.setProperty('--volume', `${percent}%`); $(`${id}-value`).textContent = `${percent}%`;
  }
  function persist() {
    if (!ready) return;
    const preferences = {trackId:state.trackId,volume:state.volume,music:state.music,rain:state.rain,fire:state.fire,rainVolume:state.rainVolume,fireVolume:state.fireVolume,ocean:state.ocean,stream:state.stream,oceanVolume:state.oceanVolume,streamVolume:state.streamVolume,mode:state.mode,scope:state.scope,favorites:state.favorites,disliked:state.disliked};
    try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch (_) {}
  }
  function render(next) {
    state = next;
    const track = tracks.find(item => item.id === state.trackId);
    const collection = series.find(item => item.id === track.series);
    renderLibrary();
    const active = state.playing || state.status === 'loading';
    ['play','mini-play'].forEach(id => {
      $(id).setAttribute('aria-label', active ? '暂停背景声音' : '播放背景声音');
      $(id).querySelector('use').setAttribute('href', active ? '#i-pause' : '#i-play');
    });
    if (state.playing) hasPlayed = true;
    const musicShown = state.playing ? state.musicPlaying : state.music;
    const shownEffects = state.playing ? state.playingEffects : ambientKinds.filter(kind => state[kind]);
    const soundNames = [...(musicShown ? [track.title] : []), ...shownEffects.map(kind => ambientNames[kind])];
    const soundTitle = soundNames.join(' ＋ ') || '此刻，安静';
    const playLabel = !soundNames.length ? '挑选声音' : musicShown && !shownEffects.length ? `播放《${track.title}》` : `播放${shownEffects.length === 1 && !musicShown ? ambientNames[shownEffects[0]] : '这组声音'}`;
    $('play').querySelector('span').textContent = active ? (state.status === 'loading' ? '加载中 · 可暂停' : soundNames.length > 1 ? '暂停全部' : '暂停播放') : (state.status === 'error' ? '重试播放' : playLabel);
    $('play').setAttribute('aria-busy', String(state.status === 'loading'));
    $('current-series').textContent = state.playing ? '正在播放' : state.status === 'loading' ? '正在准备声音' : state.status === 'error' ? '播放未成功' : hasPlayed ? '已暂停' : !soundNames.length ? '留一点安静' : sharedTrack ? '朋友分享给你' : saved.trackId ? '上次听到' : musicShown ? '为你选好' : '待播放';
    $('current-title').textContent = soundTitle;
    $('current-context').textContent = musicShown ? `来自「${collection.title}」${shownEffects.length ? ' · 叠加自然声' : ''}` : shownEffects.length ? '自然声 · 可以单独听' : '选一首音乐，或听一点自然声';
    for (const id of ['previous','next','mini-next','mini-mode','share-track','music-play-options']) $(id).hidden = !musicShown;
    $('music-mix').hidden = !state.music;
    for (const kind of ambientKinds) $(`${kind}-mix`).hidden = !state[kind];
    $('current-mix').hidden = !state.music && !ambientKinds.some(kind => state[kind]);
    if (ready && analytics) analytics.bind(audio.audio, track, () => audio.active && audio.music && audio.volume > 0);
    slider('volume',state.volume);
    $('music-toggle').checked = state.music;
    for (const kind of ambientKinds) {
      slider(`${kind}-volume`,state[`${kind}Volume`]);
      $(`${kind}-toggle`).checked = state[kind];
      $(`${kind}-toggle`).disabled = $(`${kind}-volume`).disabled = !state[`${kind}Available`];
      $(`${kind}-toggle`).closest('label').title = state[`${kind}Available`] ? '' : '此浏览器不支持环境声，音乐仍可使用';
    }
    const ambience = ambientKinds.filter(kind => state[kind]).map(kind => ambientNames[kind]).join(' + ');
    $('ambient-summary').textContent = ambience ? `${ambience}已选${active ? '' : ' · 暂停中'}` : '轻雨 / 篝火 / 海浪 / 流水';
    $('play-mode').value = state.mode; $('play-scope').value = state.scope;
    $('mini-title').textContent = soundTitle;
    $('mini-title').title = soundTitle;
    $('mini-status').textContent = `${state.playing ? '正在播放' : state.status === 'loading' ? '声音准备中' : '已暂停'}${musicShown ? ' · ' + modes[state.mode] : ' · 自然声'}`;
    $('mini-mode').textContent = {list:'列表',single:'单曲',shuffle:'随机'}[state.mode];
    $('mini-mode').setAttribute('aria-label', `切换播放方式，当前${modes[state.mode]}`);
    const allMuted = (!state.music || state.volume === 0) && ambientKinds.every(kind => !state[kind] || state[`${kind}Volume`] === 0);
    $('play-status').textContent = state.playing && allMuted ? '当前声音音量为零，调高一点就能听见' : state.status === 'off' ? '点一下，就让声音陪着你' : state.message;
    $('play-status').dataset.error = String(state.status === 'error');
    $('now-track').textContent = `当前选择 · ${track.title}`;
    $('track-credit').textContent = `${track.artist || '慢慢书桌原创配乐'}${track.license ? ' · ' + track.license : ''}`;
    $('track-credit').hidden = !track.sourceUrl;
    if (track.sourceUrl) $('track-credit').href = track.sourceUrl;
    $('sleep-timer').value = String(state.sleepMinutes || 0);
    const end = state.sleepEndsAt ? new Date(state.sleepEndsAt) : null;
    $('sleep-status').textContent = end ? `将于 ${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')} 关闭` : '不定时关闭';
    persist();
  }

  audio = new window.CalmAudio({onState:render});
  if (Array.isArray(saved.favorites)) audio.setFavorites(saved.favorites);
  audio.selectTrack(tracks.some(track => track.id === saved.trackId) ? saved.trackId : 'echo-public-night');
  if (Array.isArray(saved.disliked)) audio.setDisliked(saved.disliked);
  if (['single','list','shuffle'].includes(saved.mode)) audio.setMode(saved.mode);
  if (['series','all','favorites'].includes(saved.scope)) audio.setScope(saved.scope);
  if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) audio.setVolume(saved.volume);
  if (typeof saved.music === 'boolean') audio.setMusic(saved.music);
  for (const kind of ambientKinds) {
    if (typeof saved[`${kind}Volume`] === 'number') audio.setEffectVolume(kind, saved[`${kind}Volume`]);
    if (saved[kind] === true && audio.getState()[`${kind}Available`]) audio.setEffect(kind, true);
  }
  if (sharedTrack) {
    audio.setMusic(true);
    audio.setScope('series');
    audio.selectTrack(sharedTrack.id);
  }
  ready = true; render(audio.getState());
  if (analytics && analytics.configured) {
    $('analytics-settings').hidden = false;
    $('analytics-toggle').checked = analytics.enabled;
    $('analytics-toggle').addEventListener('change', event => analytics.setEnabled(event.target.checked));
    analytics.visit();
  }
  const mobile = window.matchMedia('(max-width: 850px)');
  let primaryVisible = 'IntersectionObserver' in window;
  const updateMini = () => { $('mini-player').hidden = !(immersed || (mobile.matches && !primaryVisible)); };
  if ('IntersectionObserver' in window) {
    const observer = new window.IntersectionObserver(entries => {
      primaryVisible = entries[0].isIntersecting;
      updateMini();
    });
    observer.observe($('play'));
  }
  // Older embedded WebKit exposes only addListener; a layout enhancement must
  // never prevent the playback controls below from being wired up.
  if (typeof mobile.addEventListener === 'function') mobile.addEventListener('change', updateMini);
  else if (typeof mobile.addListener === 'function') mobile.addListener(updateMini);
  updateMini();

  function setSoundTab(kind, focus = false) {
    for (const name of ['music','nature']) {
      const selected = name === kind;
      $(`${name}-tab`).setAttribute('aria-selected', String(selected));
      $(`${name}-tab`).setAttribute('tabindex', selected ? '0' : '-1');
      $(`${name}-pane`).hidden = !selected;
    }
    if (focus) $(`${kind}-tab`).focus();
  }
  for (const kind of ['music','nature']) {
    $(`${kind}-tab`).addEventListener('click', () => setSoundTab(kind));
    $(`${kind}-tab`).addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      setSoundTab(event.key === 'Home' ? 'music' : event.key === 'End' ? 'nature' : kind === 'music' ? 'nature' : 'music', true);
    });
  }
  setSoundTab(state.music ? 'music' : 'nature');
  function togglePlayback() {
    if (state.playing || state.status === 'loading') audio.pause();
    else if (!state.music && !ambientKinds.some(kind => state[kind])) setSoundTab('nature', true);
    else audio.start();
  }
  function setImmersed(value) {
    immersed = value; document.body.classList.toggle('is-immersed',value); updateMini();
    $('immersion').setAttribute('aria-pressed',String(value)); $('immersion').querySelector('span').textContent = value ? '返回选声' : '安静模式';
    $('immersion').querySelector('use').setAttribute('href',value ? '#i-close' : '#i-expand'); $('immersion').focus();
  }
  ['play','mini-play'].forEach(id => $(id).addEventListener('click',togglePlayback));
  $('previous').addEventListener('click',() => audio.previousTrack());
  ['next','mini-next'].forEach(id => $(id).addEventListener('click',() => audio.nextTrack()));
  $('play-mode').addEventListener('change',event => audio.setMode(event.target.value));
  $('mini-mode').addEventListener('click',() => { const order=['list','shuffle','single']; audio.setMode(order[(order.indexOf(state.mode)+1)%order.length]); });
  $('play-scope').addEventListener('change',event => { $('search').value=''; browsedScope=event.target.value; browsedSeries=null; audio.setScope(event.target.value); });
  $('volume').addEventListener('input',event => audio.setVolume(Number(event.target.value)/100));
  $('music-toggle').addEventListener('change', event => {
    audio.setMusic(event.target.checked);
    if (event.target.checked && !audio.active) audio.start();
  });
  for (const kind of ambientKinds) {
    $(`remove-${kind}`).addEventListener('click', () => audio.setEffect(kind, false));
    $(`${kind}-volume`).addEventListener('input', event => audio.setEffectVolume(kind, Number(event.target.value)/100));
    $(`${kind}-toggle`).addEventListener('change', event => {
      const enabled = event.target.checked;
      // Starting an ambience from silence never starts an unrequested song.
      if (enabled && !audio.active) audio.setMusic(false);
      audio.setEffect(kind, enabled);
      if (enabled && !audio.active) audio.start();
    });
  }
  $('sleep-timer').addEventListener('change',event => audio.setSleepTimer(Number(event.target.value)));
  $('search').addEventListener('input',renderLibrary);
  $('clear-search').addEventListener('click',() => { $('search').value=''; renderLibrary(); $('search').focus(); });
  $('immersion').addEventListener('click',() => setImmersed(!immersed));
  const encouragements = [
    '把心放在眼前这一件小事上。', '不必一下做完，先走好这一小步。',
    '今天的进度，可以按自己的节奏来。', '留一点耐心，给正在努力的自己。',
    '让音乐陪着你，慢慢来。', '专注一会儿，也记得歇一会儿。',
    '一页书，一段音乐，都算好时光。', '此刻只做一件事，就很好。',
    '暂时没有答案也没关系，先从能做的开始。', '小小的进展，也值得被看见。',
    '给自己一点空间，思路会慢慢清晰。', '休息不用理由，放松也是今天的一部分。',
    '不用赶上谁，照着自己的步子走。', '窗外有风，手边有事，慢慢就好。',
    '把难题拆小一点，把呼吸放慢一点。', '愿这首歌，陪你度过舒服的一段时间。'
  ];
  let quoteIndex = -1;
  function nextEncouragement() {
    const step = 1 + Math.floor(Math.random() * (encouragements.length - 1));
    quoteIndex = (quoteIndex + step) % encouragements.length;
    $('encouragement').textContent = encouragements[quoteIndex];
  }
  nextEncouragement();
  $('next-encouragement').addEventListener('click', nextEncouragement);
  window.addEventListener('pagehide',() => { $('search').value=''; });
  document.addEventListener('keydown',event => {
    if (event.key === 'Escape' && immersed) setImmersed(false);
    if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || event.repeat || $('credits-dialog').open || $('share-dialog').open) return;
    if (event.target.closest('input,textarea,select,button,a,summary,[contenteditable="true"]')) return;
    event.preventDefault(); togglePlayback();
  });
  $('share-track').addEventListener('click', () => {
    const track = tracks.find(item => item.id === state.trackId);
    const collection = series.find(item => item.id === track.series);
    window.SlowDeskShare.open(track, collection);
  });
  let creditsBuilt=false;
  $('open-credits').addEventListener('click',() => {
    if (!creditsBuilt) {
      tracks.filter(track => track.sourceUrl).forEach(track => {
        const item=document.createElement('article');
        const title=document.createElement('h3'); title.textContent=`${track.title} — ${track.artist}`;
        const text=document.createElement('p'); text.textContent=track.attribution;
        const source=document.createElement('a'); source.href=track.sourceUrl; source.textContent='曲目来源页面'; source.target='_blank'; source.rel='noopener noreferrer';
        item.append(title,text,source);
        if (track.licenseUrl) {
          const license=document.createElement('a'); license.href=track.licenseUrl; license.textContent=track.license; license.target='_blank'; license.rel='noopener noreferrer';
          item.appendChild(license);
        }
        $('credits-list').appendChild(item);
      });
      creditsBuilt=true;
    }
    $('credits-dialog').showModal();
  });
  $('close-credits').addEventListener('click',() => $('credits-dialog').close());
})();
