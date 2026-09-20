import catalogue from '../catalogue.mjs';
export const origin = 'https://61-design.github.io';
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

export async function readBody(request) {
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
