/* Local music queues, independent ambient sounds and an optional sleep timer. */
(function () {
  'use strict';

  const unit = value => Math.max(0, Math.min(1, Number(value)));

  const effectKinds = ['rain', 'fire', 'ocean', 'stream'];
  const effectLabels = {rain:'轻雨', fire:'篝火', ocean:'海浪', stream:'流水'};

  class CalmAudio {
    constructor({ onState = () => {} } = {}) {
      this.onState = onState;
      this.volume = 0.38;
      this.music = true;
      this.rain = false;
      this.fire = false;
      this.ocean = false;
      this.stream = false;
      this.rainVolume = 0.25;
      this.fireVolume = 0.28;
      this.oceanVolume = 0.3;
      this.streamVolume = 0.3;
      this.mode = 'list';
      this.scope = 'series';
      this.favorites = [];
      this.disliked = [];
      this.shuffleBag = null;
      this.history = [];
      this.historyIndex = -1;
      this.sleepMinutes = 0;
      this.sleepEndsAt = 0;
      this.sleepTimer = null;
      this.playing = false;
      this.active = false;
      this.musicRunning = false;
      this.musicError = null;
      this.effectsError = null;
      this.queueMessage = '';
      this.status = 'off';
      this.message = '声音未开启';
      this.intent = 0;
      this.startTimer = null;
      this.fades = new Map();
      this.retiring = new Set();
      this.effectRetiring = new Set();
      this.musicStartsAt = 0;
      this.context = null;
      this.effects = null;
      this.rainSource = null;
      this.rainGain = null;
      this.fireSource = null;
      this.fireGain = null;
      this.tracks = window.CALM_TRACKS;
      if (!Array.isArray(this.tracks) || !this.tracks.length) throw new Error('请先载入音乐列表');
      this.trackId = this.tracks[0].id;
      this.audio = this.createMusic(this.tracks[0].src);
      this.resetQueue();
      document.addEventListener('visibilitychange', () => {
        // Browser timers may be throttled while working elsewhere. Timestamp
        // checks catch an expired timer on return; hiding never pauses by itself.
        if (this.checkSleepTimer()) return;
        if (document.hidden) for (const fade of [...this.fades.values()]) fade.finish();
      });
      window.addEventListener('pagehide', () => {
        this.setSleepTimer(0);
        this.pause(true);
      });
    }

    createMusic(src) {
      const audio = new Audio(src);
      audio.id = 'background-music';
      audio.hidden = true;
      audio.loop = this.mode === 'single';
      audio.preload = 'metadata';
      audio.volume = 0;
      document.body.appendChild(audio);
      this.listenToMusic(audio);
      return audio;
    }

    listenToMusic(audio) {
      for (const [event, handler] of audio.calmListeners || []) audio.removeEventListener(event, handler);
      audio.calmListeners = [];
      const version = audio.calmVersion = (audio.calmVersion || 0) + 1;
      const current = () => audio === this.audio && version === audio.calmVersion
        && (!audio.currentSrc || audio.currentSrc === audio.src);
      const listen = (event, handler) => {
        audio.addEventListener(event, handler);
        audio.calmListeners.push([event, handler]);
      };
      listen('loadedmetadata', () => {
        if (current()) this.emit();
      });
      listen('pause', () => {
        if (!current() || !this.active || !this.music || !this.musicRunning || !audio.paused) return;
        // Native media fires pause when it reaches the end. That is a queue
        // transition, not a playback failure, even if pause precedes ended.
        if (audio.ended || (Number.isFinite(audio.duration) && audio.duration > 0 && audio.currentTime >= audio.duration - 0.04)) return;
        this.musicRunning = false;
        this.musicError = new Error('Music interrupted');
        this.refreshState();
      });
      listen('ended', () => {
        if (!current() || !audio.ended || !this.active || !this.music || this.checkSleepTimer()) return;
        this.musicRunning = false;
        if (this.mode === 'single') {
          audio.currentTime = 0;
          this.start();
        } else this.nextTrack(true);
      });
      listen('error', () => {
        if (!current() || !this.active || !this.music) return;
        // load() clears a previous resource's MediaError. Ignore a stale queued
        // event whose old resource is no longer the selected source.
        if ('error' in audio && !audio.error) return;
        this.musicError = new Error('Music unavailable');
        this.stopMusic();
        this.refreshState();
      });
    }

    currentTrack() { return this.tracks.find(track => track.id === this.trackId); }

    scopedTracks() {
      if (this.scope === 'favorites') return this.tracks.filter(track => this.favorites.includes(track.id));
      if (this.scope === 'all') return this.tracks;
      const series = this.currentTrack().series;
      return this.tracks.filter(track => track.series === series);
    }

    queue() { return this.scopedTracks().filter(track => !this.disliked.includes(track.id)); }

    emptyQueueMessage() {
      return this.scopedTracks().length
        ? '这个播放范围里的歌曲都已跳过，点“恢复”或换一个系列再听'
        : '收藏夹还是空的，先收藏几首或换一个播放范围';
    }

    queueNeighbor(queue, direction) {
      const scoped = this.scopedTracks();
      const at = scoped.findIndex(track => track.id === this.trackId);
      if (at < 0) return direction > 0 ? queue[0] : queue[queue.length - 1];
      const playable = new Set(queue.map(track => track.id));
      for (let offset = 1; offset <= scoped.length; offset++) {
        const track = scoped[(at + direction * offset + scoped.length) % scoped.length];
        if (playable.has(track.id)) return track;
      }
    }

    resetQueue() {
      this.shuffleBag = null;
      this.history = this.queue().some(track => track.id === this.trackId) ? [this.trackId] : [];
      this.historyIndex = this.history.length - 1;
    }

    getState() {
      const queue = this.queue();
      return {
        playing: this.playing, volume: this.volume, music: this.music,
        musicPlaying: Boolean(this.active && this.music && this.musicRunning && !this.audio.paused),
        playingEffects: effectKinds.filter(kind => this.active && this[kind] && this[`${kind}Source`] && this.context?.state === 'running'),
        trackId: this.trackId, trackTitle: this.currentTrack().title,
        rain: this.rain, fire: this.fire, ocean: this.ocean, stream: this.stream,
        rainVolume: this.rainVolume, fireVolume: this.fireVolume, oceanVolume: this.oceanVolume, streamVolume: this.streamVolume,
        mode: this.mode, scope: this.scope, favorites: [...this.favorites], disliked: [...this.disliked],
        queueLength: queue.length, queueIndex: queue.findIndex(track => track.id === this.trackId),
        sleepMinutes: this.sleepMinutes, sleepEndsAt: this.sleepEndsAt,
        status: this.status, message: this.message,
        duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0,
        currentTime: this.audio.currentTime || 0,
        rainAvailable: Boolean(window.AudioContext || window.webkitAudioContext),
        fireAvailable: Boolean(window.AudioContext || window.webkitAudioContext),
        oceanAvailable: Boolean(window.AudioContext || window.webkitAudioContext),
        streamAvailable: Boolean(window.AudioContext || window.webkitAudioContext)
      };
    }

    emit() { this.onState(this.getState()); }

    refreshState(pending = false) {
      const musicPlaying = this.active && this.music && this.musicRunning && !this.audio.paused;
      const effectsReady = this.context && this.context.state === 'running';
      const playingEffects = effectKinds.filter(kind => this.active && this[kind] && this[`${kind}Source`] && effectsReady);
      this.playing = Boolean(musicPlaying || playingEffects.length);
      const audible = musicPlaying ? ['音乐'] : [];
      audible.push(...playingEffects.map(kind => effectLabels[kind]));
      const missing = this.musicError ? ['音乐'] : [];
      if (this.effectsError) missing.push(...effectKinds.filter(kind => this[kind] && !playingEffects.includes(kind)).map(kind => effectLabels[kind]));
      if (this.playing) {
        this.status = 'playing';
        this.message = `${audible.join('与')}正在陪着你`;
        if (missing.length) this.message += `；${missing.join('、')}暂时未能播放`;
        if (this.queueMessage) this.message += `；${this.queueMessage}`;
      } else if (pending) {
        this.status = 'loading';
        this.message = '让声音慢慢进来';
      } else if (this.queueMessage) {
        this.status = 'paused';
        this.message = this.queueMessage;
      } else if (!this.active) {
        this.status = 'paused';
        this.message = '声音已暂停';
      } else {
        this.status = 'error';
        this.message = (this.musicError || this.effectsError)?.name === 'NotAllowedError'
          ? '浏览器还没有允许播放，请再轻点一下播放按钮'
          : this.music ? '音乐暂时未能载入，请检查网络后重试播放' : '自然声暂时未能载入，请检查网络后重试播放';
      }
      this.emit();
    }

    musicVolume() {
      const gain = Number(this.currentTrack().gain ?? 1);
      return this.volume * (Number.isFinite(gain) ? unit(gain) : 1);
    }

    cancelFade(media) {
      const fade = this.fades.get(media);
      if (fade) clearTimeout(fade.timer);
      this.fades.delete(media);
    }

    fadeMusic(target, milliseconds, finished, media = this.audio) {
      this.cancelFade(media);
      const from = media.volume;
      const start = Math.max(performance.now(), media === this.audio && target > 0 ? this.musicStartsAt : 0);
      const fade = {
        timer: null,
        finish: () => {
          if (this.fades.get(media) !== fade) return;
          this.cancelFade(media);
          media.volume = unit(target);
          if (finished) finished();
        }
      };
      const tick = () => {
        if (this.fades.get(media) !== fade) return;
        const progress = Math.max(0, Math.min(1, (performance.now() - start) / milliseconds));
        const smooth = progress * progress * (3 - 2 * progress);
        media.volume = unit(from + (target - from) * smooth);
        if (progress < 1) fade.timer = setTimeout(tick, 40);
        else fade.finish();
      };
      this.fades.set(media, fade);
      if (document.hidden || milliseconds <= 0) fade.finish();
      else fade.timer = setTimeout(tick, 40);
    }

    disposeMusic(media) {
      this.cancelFade(media);
      media.volume = 0;
      media.pause();
      media.remove();
      this.retiring.delete(media);
    }

    stopMusic() {
      this.musicRunning = false;
      this.cancelFade(this.audio);
      this.audio.volume = 0;
      this.audio.pause();
      for (const media of [...this.retiring]) this.disposeMusic(media);
    }

    async prepareEffects() {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('Web Audio unavailable');
      if (!this.context) {
        this.context = new AudioContext();
        this.effects = this.context.createGain();
        this.effects.gain.value = 0;
        this.effects.connect(this.context.destination);
      }
      if (this.context.state === 'suspended' || this.context.state === 'interrupted') await this.context.resume();
      if (this.context.state !== 'running') throw new Error('Web Audio unavailable');
    }

    async start() {
      if (this.checkSleepTimer()) return false;
      if (!this.music && !this.hasEffects()) {
        this.pause();
        this.message = '选一种声音，或继续安静地工作';
        this.emit();
        return false;
      }
      const queue = this.queue();
      this.queueMessage = this.music && !queue.length ? this.emptyQueueMessage() : '';
      if (this.music && queue.length && !queue.some(track => track.id === this.trackId)) {
        this.replaceTrack(this.queueNeighbor(queue, 1), false);
        this.resetQueue();
      }
      const request = ++this.intent;
      const media = this.audio;
      const wantsMusic = this.music && queue.length > 0;
      const wantsEffects = this.hasEffects();
      if (wantsMusic) this.cancelFade(media);
      else this.stopMusic();
      if (!wantsMusic && !wantsEffects) {
        this.active = false;
        this.musicError = null;
        this.effectsError = null;
        this.refreshState();
        return false;
      }
      this.active = true;
      this.musicError = null;
      this.effectsError = null;
      this.refreshState(true);
      clearTimeout(this.startTimer);
      this.startTimer = setTimeout(() => {
        if (request !== this.intent || !this.active || this.playing) return;
        this.pause(true);
        this.status = 'error';
        this.message = '声音启动超时，请检查网络后点“重试播放”';
        this.emit();
      }, 15000);
      // Start every source inside the original gesture, before awaiting. Merely
      // selecting preferences while paused never calls play or creates buffers.
      const effectsReady = wantsEffects ? this.prepareEffects() : Promise.resolve();
      let musicReady;
      if (wantsMusic) {
        try { musicReady = this.musicRunning && !media.paused ? Promise.resolve() : media.play(); }
        catch (error) { musicReady = Promise.reject(error); }
      }
      let pending = Number(wantsEffects) + Number(wantsMusic);
      const current = () => request === this.intent && this.active && media === this.audio;
      const settle = () => { if (current()) this.refreshState(--pending > 0); };
      const effectsTask = wantsEffects ? (async () => {
        try {
          await effectsReady;
          if (!current()) return;
          this.effects.gain.cancelScheduledValues(this.context.currentTime);
          this.effects.gain.setTargetAtTime(1, this.context.currentTime, 0.08);
          await Promise.all(effectKinds.filter(kind => this[kind]).map(async kind => {
            try {
              await this.loadEffect(kind);
              if (current() && this[kind]) this.startEffect(kind);
            } catch (error) { if (current()) this.effectsError = error; }
          }));
        } catch (error) {
          if (current()) this.effectsError = error;
        } finally { settle(); }
      })() : Promise.resolve();
      const musicTask = wantsMusic ? (async () => {
        try {
          await musicReady;
          if (!current()) {
            if (media !== this.audio) this.disposeMusic(media);
            else if (!this.active || !this.music || this.disliked.includes(this.trackId) || !this.queue().length) this.stopMusic();
            return;
          }
          this.musicRunning = true;
          this.fadeMusic(this.musicVolume(), 850);
        } catch (error) {
          if (current()) { this.musicError = error; this.stopMusic(); }
        } finally { settle(); }
      })() : Promise.resolve();
      await Promise.all([effectsTask, musicTask]);
      if (current()) { clearTimeout(this.startTimer); this.startTimer = null; }
      if (!pending && current()) this.refreshState();
      return current() && this.playing;
    }

    pause(immediate = false) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
      const request = ++this.intent;
      const media = this.audio;
      this.active = false;
      this.musicRunning = false;
      this.playing = false;
      this.status = 'paused';
      this.message = '声音已暂停';
      for (const kind of effectKinds) this.stopEffect(kind, immediate || document.hidden);
      if (this.effects) {
        this.effects.gain.cancelScheduledValues(this.context.currentTime);
        if (immediate || document.hidden) this.effects.gain.setValueAtTime(0, this.context.currentTime);
        else this.effects.gain.setTargetAtTime(0, this.context.currentTime, 0.045);
      }
      if (immediate || document.hidden) for (const old of this.effectRetiring) {
        old.gain.gain.cancelScheduledValues(this.context.currentTime);
        old.gain.gain.setValueAtTime(0, this.context.currentTime);
        old.source.stop(this.context.currentTime);
      }
      for (const oldMedia of [...this.retiring]) this.disposeMusic(oldMedia);
      this.musicStartsAt = 0;
      if (immediate || document.hidden || media.paused) this.stopMusic();
      else this.fadeMusic(0, 260, () => { if (request === this.intent) media.pause(); });
      // A manually paused session keeps its chosen real-world sleep deadline.
      this.emit();
    }

    setVolume(value) {
      if (!Number.isFinite(Number(value))) return;
      this.volume = unit(value);
      if (this.active && this.music && this.musicRunning) this.fadeMusic(this.musicVolume(), 180);
      this.emit();
    }

    hasEffects() { return effectKinds.some(kind => this[kind]); }

    setRainVolume(value) { this.setEffectVolume('rain', value); }
    setFireVolume(value) { this.setEffectVolume('fire', value); }
    setEffectVolume(kind, value) {
      if (!Number.isFinite(Number(value))) return;
      this[`${kind}Volume`] = unit(value);
      const gain = this[`${kind}Gain`];
      if (gain && this.context) {
        gain.gain.cancelScheduledValues(this.context.currentTime);
        gain.gain.setTargetAtTime(this.effectVolume(kind), this.context.currentTime, 0.06);
      }
      this.emit();
    }

    setRain(enabled) { return this.setEffect('rain', enabled); }
    setFire(enabled) { return this.setEffect('fire', enabled); }
    setEffect(kind, enabled) {
      const active = this.active;
      this[kind] = Boolean(enabled);
      if (!this[kind]) this.stopEffect(kind, document.hidden);
      if (!this.music && !this.hasEffects()) { this.pause(); return; }
      if (active) return this.start();
      this.emit();
    }

    setMusic(enabled) {
      const active = this.active;
      this.music = Boolean(enabled);
      if (!this.music) this.stopMusic();
      if (!this.music && !this.hasEffects()) { this.pause(); return; }
      if (active) return this.start();
      this.emit();
    }

    setMode(mode) {
      if (!['single', 'list', 'shuffle'].includes(mode)) return false;
      this.mode = mode;
      this.audio.loop = mode === 'single';
      this.resetQueue();
      this.emit();
      return true;
    }

    setScope(scope) {
      if (!['series', 'all', 'favorites'].includes(scope)) return false;
      this.scope = scope;
      this.queueMessage = '';
      this.resetQueue();
      if (this.active && this.music) return this.start();
      this.emit();
      return true;
    }

    setFavorites(ids) {
      if (!Array.isArray(ids)) return false;
      const valid = new Set(this.tracks.map(track => track.id));
      this.favorites = [...new Set(ids.filter(id => valid.has(id)))];
      if (this.scope === 'favorites') {
        this.resetQueue();
        if (this.active && this.music) return this.start();
      }
      this.emit();
      return true;
    }

    setDisliked(ids) {
      if (!Array.isArray(ids)) return false;
      const valid = new Set(this.tracks.map(track => track.id));
      this.disliked = [...new Set(ids.filter(id => valid.has(id)))];
      this.resetQueue();
      const queue = this.queue();
      this.queueMessage = this.music && !queue.length ? this.emptyQueueMessage() : '';
      if (this.disliked.includes(this.trackId)) {
        // Invalidate any pending play before stopping or replacing the source.
        ++this.intent;
        this.stopMusic();
        if (queue.length) {
          this.replaceTrack(this.queueNeighbor(queue, 1), false);
          this.resetQueue();
          if (this.active) return this.start();
          this.message = `已跳过不喜欢的歌曲，已选「${this.currentTrack().title}」`;
          this.emit();
          return true;
        }
        // A requested ambient source may still be waiting for context.resume().
        // Keep that original play intent even before its source node exists.
        if (this.active && this.hasEffects()) return this.start();
        this.active = false;
        this.refreshState();
        return true;
      }
      if (this.active && this.music && !this.musicRunning && queue.length) return this.start();
      if (this.playing) this.refreshState();
      else {
        this.message = this.queueMessage || '播放列表已更新，想听的时候再播放';
        this.emit();
      }
      return true;
    }

    selectSeries(series, preferredId) {
      const tracks = this.tracks.filter(track => track.series === series);
      if (!tracks.length) return false;
      const playable = tracks.filter(track => !this.disliked.includes(track.id));
      const track = playable.find(track => track.id === preferredId) || playable[0] || tracks[0];
      this.scope = 'series';
      if (track.id !== this.trackId) this.replaceTrack(track, false);
      this.resetQueue();
      this.queueMessage = playable.length ? '' : this.emptyQueueMessage();
      if (!playable.length && !this.active) this.status = 'paused';
      if (this.active) return this.start();
      this.message = this.queueMessage || `已选「${track.title}」，想听的时候再播放`;
      this.emit();
      return true;
    }

    replaceTrack(track, remember = true, reuse = false) {
      const previous = this.audio;
      const audible = this.active && this.music && this.musicRunning && !previous.paused && previous.volume > 0;
      ++this.intent;
      for (const old of [...this.retiring]) this.disposeMusic(old);
      this.musicRunning = false;
      this.trackId = track.id;
      this.musicError = null;
      this.queueMessage = '';
      if (reuse) {
        // Safari may grant playback to an element rather than the whole page.
        // Natural queue progression keeps that authorized element alive.
        this.cancelFade(previous);
        previous.volume = 0;
        previous.pause();
        previous.src = track.src;
        previous.loop = this.mode === 'single';
        this.listenToMusic(previous);
        previous.load();
        this.musicStartsAt = 0;
      } else {
        this.audio = this.createMusic(track.src);
        this.musicStartsAt = audible && !document.hidden ? performance.now() + 200 : 0;
        if (audible && !document.hidden) {
          previous.removeAttribute('id');
          this.retiring.add(previous);
          this.fadeMusic(0, 200, () => this.disposeMusic(previous), previous);
        } else this.disposeMusic(previous);
      }
      if (remember) {
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(track.id);
        if (this.history.length > 500) this.history.shift();
        this.historyIndex = this.history.length - 1;
      }
    }

    selectTrack(id, scope, autoplay = false) {
      const track = this.tracks.find(item => item.id === id);
      if (!track) return false;
      if (this.disliked.includes(id)) {
        if (this.status === 'off') this.status = 'paused';
        this.message = '这首歌已标为不喜欢，点右侧“恢复”后再播放';
        this.emit();
        return false;
      }
      if (autoplay) this.music = true;
      if (['series', 'all', 'favorites'].includes(scope)) this.scope = scope;
      // An explicit track choice takes precedence over a favorites-only queue.
      if (this.scope === 'favorites' && !this.favorites.includes(id)) this.scope = 'series';
      if (track.id !== this.trackId) this.replaceTrack(track, false);
      this.resetQueue();
      if (autoplay || this.active) return this.start();
      this.message = `已选「${track.title}」，想听的时候再播放`;
      this.emit();
      return true;
    }

    shuffled(ids) {
      const result = [...ids];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    }

    nextTrack(natural = false) {
      if (this.checkSleepTimer()) return false;
      const queue = this.queue();
      if (!queue.length) {
        this.stopMusic();
        this.queueMessage = this.emptyQueueMessage();
        this.refreshState();
        return false;
      }
      let id;
      let remember = true;
      if (this.mode === 'shuffle') {
        if (this.historyIndex < this.history.length - 1) {
          id = this.history[++this.historyIndex];
          remember = false;
        } else {
          if (this.shuffleBag === null) this.shuffleBag = this.shuffled(queue.map(track => track.id).filter(item => item !== this.trackId));
          if (!this.shuffleBag.length) {
            this.shuffleBag = this.shuffled(queue.map(track => track.id));
            if (this.shuffleBag.length > 1 && this.shuffleBag[this.shuffleBag.length - 1] === this.trackId) {
              [this.shuffleBag[0], this.shuffleBag[this.shuffleBag.length - 1]] = [this.shuffleBag[this.shuffleBag.length - 1], this.shuffleBag[0]];
            }
          }
          id = this.shuffleBag.pop();
        }
      } else {
        id = this.queueNeighbor(queue, 1).id;
      }
      const track = this.tracks.find(item => item.id === id);
      if (id !== this.trackId) this.replaceTrack(track, remember, natural);
      else if (natural) this.audio.currentTime = 0;
      if (this.active) return this.start();
      this.message = `已选「${track.title}」，想听的时候再播放`;
      this.emit();
      return true;
    }

    previousTrack() {
      if (this.checkSleepTimer()) return false;
      const queue = this.queue();
      if (!queue.length) return this.nextTrack();
      let id;
      if (this.mode === 'shuffle') {
        if (this.historyIndex <= 0) {
          if (!queue.some(track => track.id === this.trackId)) return this.nextTrack();
          this.audio.currentTime = 0;
          this.emit();
          return true;
        }
        id = this.history[--this.historyIndex];
      } else {
        id = this.queueNeighbor(queue, -1).id;
      }
      if (id !== this.trackId) this.replaceTrack(this.tracks.find(track => track.id === id), this.mode !== 'shuffle');
      else this.audio.currentTime = 0;
      if (this.active) return this.start();
      this.message = `已选「${this.currentTrack().title}」，想听的时候再播放`;
      this.emit();
      return true;
    }

    setSleepTimer(minutes) {
      const value = Number(minutes);
      if (!Number.isFinite(value) || value < 0 || value > 1440) return false;
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
      this.sleepMinutes = value;
      this.sleepEndsAt = value ? Date.now() + value * 60000 : 0;
      if (value) this.scheduleSleepCheck();
      this.emit();
      return true;
    }

    scheduleSleepCheck() {
      clearTimeout(this.sleepTimer);
      if (!this.sleepEndsAt) return;
      this.sleepTimer = setTimeout(() => {
        if (!this.checkSleepTimer()) this.scheduleSleepCheck();
      }, Math.max(1, this.sleepEndsAt - Date.now()));
    }

    checkSleepTimer() {
      if (!this.sleepEndsAt || Date.now() < this.sleepEndsAt) return false;
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
      this.sleepMinutes = 0;
      this.sleepEndsAt = 0;
      this.pause(document.hidden);
      this.message = '定时已结束，声音已暂停';
      this.emit();
      return true;
    }

    // The buffers are already quiet; a second attenuation made phone playback barely audible.
    effectVolume(kind) { return this[`${kind}Volume`]; }

    async loadEffect(kind) {
      if (this[`${kind}Buffer`]) return;
      if (kind === 'rain') { this.effectBuffer(kind); return; }
      const key = `${kind}Loading`;
      if (!this[key]) this[key] = (async () => {
        const response = await fetch(`assets/ambient/${kind}.m4a`);
        if (!response.ok) throw new Error('环境声载入失败');
        this[`${kind}Buffer`] = await this.context.decodeAudioData(await response.arrayBuffer());
      })().finally(() => { this[key] = null; });
      await this[key];
    }

    effectBuffer(kind) {
      if (this[`${kind}Buffer`]) return this[`${kind}Buffer`];
      const context = this.context;
      const length = Math.floor(context.sampleRate * 9);
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < length; i++) {
        brown = (brown + (Math.random() * 2 - 1) * 0.028) / 1.025;
        data[i] = brown;
      }
      const seam = Math.floor(context.sampleRate * 0.05);
      for (let i = 0; i < seam; i++) {
        const ratio = i / (seam - 1);
        data[length - seam + i] = data[length - seam + i] * (1 - ratio) + data[0] * ratio;
      }
      this[`${kind}Buffer`] = buffer;
      return buffer;
    }

    startEffect(kind) {
      if (!this.context || this.context.state !== 'running' || this[`${kind}Source`]) return;
      const context = this.context;
      const source = context.createBufferSource();
      source.buffer = this.effectBuffer(kind);
      source.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = kind === 'rain' ? 1600 : 19000;
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(this.effects);
      gain.gain.setTargetAtTime(this.effectVolume(kind), context.currentTime, 0.3);
      source.start();
      this[`${kind}Source`] = source;
      this[`${kind}Gain`] = gain;
      const retired = { source, gain };
      source.onended = () => {
        source.disconnect(); filter.disconnect(); gain.disconnect();
        this.effectRetiring.delete(retired);
      };
      source.retirement = retired;
    }

    stopEffect(kind, immediate = false) {
      const source = this[`${kind}Source`];
      if (!source) return;
      const gain = this[`${kind}Gain`];
      const time = this.context.currentTime;
      gain.gain.cancelScheduledValues(time);
      if (immediate) gain.gain.setValueAtTime(0, time);
      else gain.gain.setTargetAtTime(0, time, 0.045);
      this.effectRetiring.add(source.retirement);
      source.stop(immediate ? time : time + 0.28);
      this[`${kind}Source`] = null;
      this[`${kind}Gain`] = null;
    }

    startRain() { this.startEffect('rain'); }
    stopRain(immediate = false) { this.stopEffect('rain', immediate); }
  }

  window.CalmAudio = CalmAudio;
})();
