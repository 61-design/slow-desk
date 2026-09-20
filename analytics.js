/* Small, optional event collector. Never reads notes, search text or full URLs. */
(function () {
  'use strict';
  const key = 'slow-desk-analytics-v1';
  class SlowDeskAnalytics {
    constructor({endpoint = ''} = {}) {
      this.endpoint = endpoint;
      this.configured = /^https:\/\//.test(endpoint) && window.location.protocol === 'https:';
      this.enabled = false;
      this.visitor = null;
      this.session = null;
      this.listeners = [];
      this.visited = false;
      // No identifiers, storage writes or requests before a receiver is configured.
      if (!this.configured) return;
      try {
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        this.enabled = saved.enabled !== false && navigator.globalPrivacyControl !== true && navigator.doNotTrack !== '1';
        this.visitor = typeof saved.visitor === 'string' && /^[\w-]{1,64}$/.test(saved.visitor) ? saved.visitor : null;
      } catch (_) { this.enabled = navigator.globalPrivacyControl !== true && navigator.doNotTrack !== '1'; }
    }

    setEnabled(value) {
      this.enabled = Boolean(value) && this.configured;
      this.visitor = null; this.session = null;
      this.visited = false;
      this.started = false; this.reached = false; this.seconds = 0; this.baseline = null;
      try { localStorage.setItem(key, JSON.stringify({enabled:this.enabled})); } catch (_) {}
      if (this.enabled) this.visit();
    }

    send(event, track = null) {
      if (!this.configured || !this.enabled) return;
      if (!this.visitor) {
        this.visitor = crypto.randomUUID();
        try { localStorage.setItem(key, JSON.stringify({enabled:true, visitor:this.visitor})); } catch (_) {}
      }
      if (!this.session) this.session = crypto.randomUUID();
      const source = new URLSearchParams(window.location.search).get('from');
      const body = JSON.stringify({
        version:1, event_id:crypto.randomUUID(), event, occurred_at:new Date().toISOString(),
        visitor_id:this.visitor, session_id:this.session,
        source:['share','wechat','friend'].includes(source) ? source : 'direct',
        track_id:track ? track.id : '', track_title:track ? track.title : '',
        series_id:track ? track.series : ''
      });
      // Delivery is best effort: no replay queue, no notes, no credentials.
      // The receiver must validate, deduplicate by event_id and rate-limit writes.
      try {
        fetch(this.endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body,
          credentials:'omit', referrerPolicy:'no-referrer', keepalive:true}).catch(() => {});
      } catch (_) {}
    }

    visit() {
      if (!this.configured || !this.enabled || this.visited) return;
      this.visited = true; this.send('page_view');
    }

    bind(media, track, eligible) {
      if (!this.configured || (this.media === media && this.trackId === track.id)) return;
      for (const [event, callback] of this.listeners) this.media.removeEventListener(event, callback);
      this.listeners = []; this.media = media; this.trackId = track.id;
      this.started = false; this.reached = false; this.seconds = 0; this.baseline = null;
      const listen = (event, callback) => { media.addEventListener(event, callback); this.listeners.push([event, callback]); };
      const reset = () => { this.baseline = null; };
      const tick = () => {
        if (!this.enabled || !eligible() || media.paused || media.ended || media.seeking || media.muted || media.volume <= 0 || media.readyState < 3) { reset(); return; }
        const now = performance.now();
        if (!this.started) { this.started = true; this.send('play_start', track); }
        if (this.baseline) {
          const elapsed = (now - this.baseline.time) / 1000;
          const advance = media.currentTime - this.baseline.position;
          // Compare media progress with wall time to reject seeking and long suspended gaps.
          if (advance > 0 && advance <= elapsed * (media.playbackRate || 1) + 0.5 && elapsed <= 5) {
            this.seconds += Math.min(advance, elapsed);
          }
        }
        this.baseline = {time:now, position:media.currentTime};
        if (!this.reached && this.seconds >= 30) { this.reached = true; this.send('listen_30s', track); }
      };
      listen('playing', tick); listen('timeupdate', tick);
      for (const event of ['pause','waiting','seeking','seeked','ended','emptied','error','volumechange']) listen(event, reset);
    }
  }
  window.SlowDeskAnalytics = SlowDeskAnalytics;
})();
