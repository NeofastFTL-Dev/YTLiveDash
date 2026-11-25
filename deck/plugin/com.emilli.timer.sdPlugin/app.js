/* Emilli Timer — Stream Deck plugin runtime.
 *
 * Runs as an HTML plugin inside the deck app's embedded Chromium: the app calls
 * connectElgatoStreamDeckSocket() with the websocket port, and everything else
 * is plain JS. Keys talk to the timer server on loopback (the server allows
 * Origin: null for exactly this page) and draw themselves on a canvas.
 */
'use strict';

const BASE = 'http://127.0.0.1:8123';

const C = {
  bg: '#08080b',
  card: '#111119',
  edge: '#2a2a36',
  txt: '#f4f4f7',
  dim: '#8d8d9b',
  faint: '#5a5a66',
  yt: '#ff2d55',
  kofi: '#29abe0',
  like: '#ff8a3d',
  ok: '#37e39b',
};

const TONES = {
  go: { bg: '#122620', edge: '#2e7a5c', txt: '#c8ffe6' },
  stop: { bg: '#1e0c13', edge: '#7a2333', txt: '#ffd0d8' },
  sub: { bg: '#111119', edge: '#5c202e', txt: '#ff6b85' },
  kofi: { bg: '#111119', edge: '#1e5069', txt: '#5cc8f2' },
  like: { bg: '#111119', edge: '#5c3820', txt: '#ffa76b' },
  dim: { bg: '#08080b', edge: '#2a2a36', txt: '#8d8d9b' },
};

const KINDS = {
  timer: { label: 'Timer', sub: 'countdown', live: true },
  go: { label: 'GO LIVE', sub: 'OBS', tone: 'go' },
  stop: { label: 'END', sub: 'STREAM', tone: 'stop' },
  undo: { label: 'UNDO', sub: 'LAST' },
  sync: { label: 'SYNC', sub: 'YOUTUBE' },
  start: { label: 'START', sub: 'NOW' },
  sub: { label: 'SUB', sub: '+5:00', tone: 'sub' },
  kofi: { label: 'KO-FI', sub: '+30:00', tone: 'kofi' },
  like: { label: 'LIKE', sub: '+0:30', tone: 'like' },
  mute: { label: 'MUSIC', sub: 'mute', live: true },
  volup: { label: 'VOL', sub: '+3 DB' },
  voldown: { label: 'VOL', sub: '-3 DB' },
  scene: { label: 'SCENE', sub: 'next', live: true },
  sceneprev: { label: 'SCENE', sub: 'prev', live: true },
  stats: { label: 'STATS', sub: 'live', live: true },
};

let ws = null;
const keys = new Map(); // context → { kind, settings, lastImage }
let state = null;
let offset = 0;
let scenes = [];
let currentScene = '';
let audio = { ready: false, muted: false, db: 0 };

/* ------------------------------------------------------------------ server */

async function api(pathname, body) {
  try {
    const res = await fetch(BASE + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: res.ok };
    }
  } catch (e) {
    return { ok: false, error: 'offline' };
  }
}

async function refreshState() {
  const s = await api('/api/state');
  if (s && s.serverNow) {
    state = s;
    offset = s.serverNow - Date.now();
  }
  const sc = await api('/api/obs/scenes');
  if (sc && sc.ok) {
    scenes = sc.scenes || [];
    currentScene = sc.current || '';
  }
  const a = await api('/api/ytpmvs/audio');
  if (a && a.ok) audio = { ready: true, muted: !!a.muted, db: Number(a.volumeDb || 0) };
  else audio = { ready: false, muted: false, db: 0 };
  renderAll();
}

/* ---------------------------------------------------------------- drawing */

function fmtClock(ms) {
  const t = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return { h, tail: `${pad(m)}:${pad(s)}` };
}

function keyState() {
  if (!state) return null;
  const now = Date.now() + offset;
  const bank = (state.baseMs || 0) + (state.addedMs || 0);
  const startedAt = state.startedAt || 0;
  const left = startedAt ? bank - (now - startedAt) : new Date(state.startAt).getTime() + bank - now;
  return { left, started: startedAt > 0, live: startedAt > 0 && left > 0, over: left <= 0 };
}

function line(ctx, text, y, size, colour, weight) {
  ctx.fillStyle = colour;
  ctx.font = `${weight || 600} ${size}px "DejaVu Sans Mono", "Liberation Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 72, y);
}

function canvasFor(kind, settings) {
  const canvas = document.createElement('canvas');
  canvas.width = 144;
  canvas.height = 144;
  const ctx = canvas.getContext('2d');

  const tone = TONES[(KINDS[kind] || {}).tone] || TONES.dim;
  ctx.fillStyle = tone.bg;
  ctx.fillRect(0, 0, 144, 144);
  ctx.strokeStyle = tone.edge;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 140, 140);

  if (kind === 'timer') return drawTimer(ctx);
  if (kind === 'stats') return drawStats(ctx);
  if (kind === 'mute') return drawMute(ctx);
  if (kind === 'scene' || kind === 'sceneprev') return drawScene(ctx, kind);
  return drawText(ctx, kind, tone);
}

function drawTimer(ctx) {
  const s = keyState();
  if (!s) {
    line(ctx, 'NO LINK', 72, 24, C.faint);
    return;
  }
  const { h, tail } = fmtClock(s.left);
  line(ctx, s.over ? 'OVER' : s.started ? 'LEFT' : 'TO GO', 30, 18, C.dim);
  const colour = s.over ? C.like : C.txt;
  const hours = String(h);
  line(ctx, hours, 78, hours.length > 3 ? 46 : 54, colour, 700);
  line(ctx, tail, 118, 30, colour, 600);
  ctx.fillStyle = s.over ? C.like : s.live ? C.yt : C.faint;
  ctx.fillRect(14, 128, 116, 6);
}

function drawStats(ctx) {
  if (!state) {
    line(ctx, 'NO LINK', 72, 24, C.faint);
    return;
  }
  const counts = state.counts || {};
  const rows = [
    ['S', counts.sub || 0, C.yt],
    ['K', counts.kofi || 0, C.kofi],
    ['L', counts.like || 0, C.like],
  ];
  rows.forEach(([tag, value, colour], i) => {
    const y = 36 + i * 34;
    ctx.textAlign = 'left';
    ctx.fillStyle = colour;
    ctx.font = '600 22px "DejaVu Sans Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, 22, y);
    ctx.fillStyle = C.txt;
    ctx.font = '700 28px "DejaVu Sans Mono", monospace';
    ctx.fillText(String(value), 52, y);
  });
}

function drawMute(ctx) {
  ctx.strokeStyle = audio.muted ? '#7a2333' : '#2e7a5c';
  line(ctx, 'MUSIC', 34, 20, C.dim);
  line(ctx, audio.muted ? 'MUTED' : audio.ready ? `${Math.round(audio.db)}DB` : 'OBS OFF', 78, 30, audio.muted ? '#ffd0d8' : '#c8ffe6', 700);
  ctx.fillStyle = audio.muted ? C.yt : audio.ready ? C.ok : C.faint;
  ctx.fillRect(14, 128, 116, 6);
}

function drawScene(ctx, kind) {
  ctx.strokeStyle = '#ff2d55';
  line(ctx, kind === 'sceneprev' ? 'PREV' : 'SCENE', 30, 18, C.dim);
  const name = (currentScene || 'no scene').toUpperCase();
  const words = name.split(/[\s_]+/);
  const lines = [];
  let acc = '';
  for (const w of words) {
    if ((acc ? acc + ' ' + w : w).length <= 9) acc = acc ? acc + ' ' + w : w;
    else {
      if (acc) lines.push(acc);
      acc = w;
    }
  }
  if (acc) lines.push(acc);
  const shown = lines.slice(0, 2);
  shown.forEach((t, i) => line(ctx, t, 78 + i * 26, t.length > 8 ? 20 : 24, C.txt, 700));
  ctx.fillStyle = C.yt;
  ctx.fillRect(14, 128, 116, 6);
}

function drawText(ctx, kind, tone) {
  const def = KINDS[kind] || {};
  if (def.label) line(ctx, def.label, def.sub ? 56 : 72, 26, tone.txt, 700);
  if (def.sub) line(ctx, def.sub, 90, 18, C.dim);
}

function paint(context) {
  const entry = keys.get(context);
  if (!entry) return;
  const canvas = canvasFor(entry.kind, entry.settings);
  const image = canvas.toDataURL('image/png');
  if (entry.lastImage === image) return;
  entry.lastImage = image;
  send('setImage', context, { image, target: 0 });
}

function renderAll() {
  for (const context of keys.keys()) paint(context);
}

/* ---------------------------------------------------------------- actions */

async function runAction(kind) {
  switch (kind) {
    case 'go':
      return api('/api/obs/start', {});
    case 'stop':
      return api('/api/obs/stop', {});
    case 'undo':
      return api('/api/undo', {});
    case 'sync':
      return api('/api/youtube/check', {});
    case 'start':
      return api('/api/start', {});
    case 'sub':
      return api('/api/boost', { type: 'sub' });
    case 'kofi':
      return api('/api/boost', { type: 'kofi' });
    case 'like':
      return api('/api/boost', { type: 'like' });
    case 'mute':
      return api('/api/ytpmvs/audio', { muted: !audio.muted });
    case 'volup':
      return setVolume(audio.db + 3);
    case 'voldown':
      return setVolume(audio.db - 3);
    case 'scene': {
      if (!scenes.length) return { ok: false };
      const i = scenes.indexOf(currentScene);
      const next = scenes[(i + 1) % scenes.length];
      return api('/api/obs/scene', { sceneName: next });
    }
    case 'sceneprev': {
      if (!scenes.length) return { ok: false };
      const i = scenes.indexOf(currentScene);
      const prev = scenes[(i - 1 + scenes.length) % scenes.length];
      return api('/api/obs/scene', { sceneName: prev });
    }
    default:
      return { ok: true };
  }
}

function setVolume(db) {
  const clamped = Math.max(-60, Math.min(0, Math.round(db)));
  const mul = clamped <= -60 ? 0.001 : Math.pow(10, clamped / 20);
  return api('/api/ytpmvs/audio', { volumeMul: mul });
}

function flash(context, ok) {
  const entry = keys.get(context);
  if (!entry) return;
  const mark = ok === false ? 'FAIL' : 'OK';
  send('setTitle', context, {
    title: mark,
    target: 0,
    state: 0,
  });
  setTimeout(() => send('setTitle', context, { title: '', target: 0, state: 0 }), 900);
}

/* ------------------------------------------------------------------- wire */

function send(event, context, payload) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ event, context, action: 'com.emilli.timer.key', payload: payload || {} }));
}

let registerEventName = 'registerPlugin';

function connectElgatoStreamDeckSocket(port, uuid, registerEvent, info) {
  registerEventName = registerEvent || 'registerPlugin';
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ event: registerEventName, uuid }));
    // Shows up in the timer's log as a 404 for this path — the cheapest proof
    // that the deck app really is running this page.
    fetch(`${BASE}/api/deck-connected`).catch(() => {});
    refreshState();
  };

  ws.onclose = () => {
    setTimeout(() => connectElgatoStreamDeckSocket(port, uuid, registerEvent, info), 2000);
  };

  ws.onmessage = (message) => {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    const context = data.context;
    switch (data.event) {
      case 'willAppear': {
        const settings = (data.payload && data.payload.settings) || {};
        keys.set(context, { kind: settings.kind || 'timer', settings, lastImage: null });
        paint(context);
        refreshState();
        break;
      }
      case 'willDisappear':
        keys.delete(context);
        break;
      case 'didReceiveSettings': {
        const settings = (data.payload && data.payload.settings) || {};
        const entry = keys.get(context);
        if (entry) {
          entry.kind = settings.kind || 'timer';
          entry.settings = settings;
          entry.lastImage = null;
        }
        paint(context);
        break;
      }
      case 'keyDown': {
        const entry = keys.get(context);
        if (!entry) break;
        runAction(entry.kind).then((res) => {
          flash(context, res && res.ok !== false);
          refreshState();
        });
        break;
      }
      default:
        break;
    }
  };
}

// Keep the clock and the OBS/audio state honest.
setInterval(() => {
  for (const [context, entry] of keys) {
    if (entry.kind === 'timer') paint(context);
  }
}, 1000);

setInterval(refreshState, 4000);
