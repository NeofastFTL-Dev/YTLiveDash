'use strict';
/**
 * Emilli Stream Deck — full control profile for the long stream.
 *
 *   node deck.js              drive the Stream Deck MK.2
 *   node deck.js --preview    render every page to deck/_preview-*.png
 *
 * Talks to the timer server on loopback (no token needed there). Override with
 * DECK_URL=http://host:port and it will sign in with the PIN from config.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const D = require('./draw');

const SERVERS = (() => {
  if (process.env.DECK_URL) return process.env.DECK_URL.replace(/\/$/, '');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return `http://127.0.0.1:${Number(cfg.port) || 8123}`;
  } catch {
    return 'http://127.0.0.1:8123';
  }
})();

const PIN = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).remote?.pin || '';
  } catch {
    return '';
  }
})();

const BRIGHTNESS = Number(process.env.DECK_BRIGHTNESS || 70);
const PREVIEW = process.argv.includes('--preview');

/* ---------------------------------------------------------------- colours */

const C = {
  bg: [11, 11, 17],
  card: [17, 17, 25],
  edge: [42, 42, 54],
  txt: [244, 244, 247],
  dim: [141, 141, 155],
  faint: [90, 90, 102],
  yt: [255, 45, 85],
  kofi: [41, 171, 224],
  like: [255, 138, 61],
  ok: [55, 227, 155],
  scene: [58, 18, 32],
  sceneEdge: [255, 45, 85],
};

const TONE = {
  go: { bg: [18, 38, 32], edge: [46, 122, 92], txt: [200, 255, 230] },
  stop: { bg: [30, 12, 19], edge: [122, 35, 51], txt: [255, 208, 216] },
  sub: { bg: [17, 17, 25], edge: [92, 32, 46], txt: [255, 107, 133] },
  kofi: { bg: [17, 17, 25], edge: [30, 80, 105], txt: [92, 200, 242] },
  like: { bg: [17, 17, 25], edge: [92, 56, 32], txt: [255, 167, 107] },
  accent: { bg: [58, 18, 32], edge: [255, 45, 85], txt: [255, 255, 255] },
  dim: { bg: [11, 11, 17], edge: [42, 42, 54], txt: [141, 141, 155] },
};

/* ------------------------------------------------------------------ state */

let state = null;
let offset = 0;
let scenes = [];
let currentScene = '';
let audio = { ready: false, muted: false, db: 0 };
let page = 0;
let cookie = null;
let deck = null;

const frames = new Map(); // key index → checksum of what is already on the glass
const flash = new Map(); // key index → { ok, until }

/* -------------------------------------------------------------------- api */

async function login() {
  if (!PIN) return false;
  const res = await fetch(`${SERVERS}/remote/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: PIN }),
  });
  const raw = res.headers.get('set-cookie') || '';
  const first = raw.split(';')[0];
  if (!first.startsWith('emilli_remote=')) return false;
  cookie = first.slice('emilli_remote='.length);
  return true;
}

async function api(pathname, body, retry = true) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = `emilli_remote=${cookie}`;
  let res;
  try {
    res = await fetch(SERVERS + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return { ok: false, error: 'offline' };
  }
  if (res.status === 401 && retry && PIN) {
    if (await login()) return api(pathname, body, false);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `HTTP ${res.status}` };
  }
}

/* ----------------------------------------------------------------- render */

function pad(n) {
  return String(n).padStart(2, '0');
}

function clockParts(now) {
  const bank = (state.baseMs || 0) + (state.addedMs || 0);
  const startedAt = state.startedAt || 0;
  const left = startedAt ? bank - (now - startedAt) : new Date(state.startAt).getTime() + bank - now;
  const secs = Math.floor(Math.abs(left) / 1000);
  return {
    left,
    hours: Math.floor(secs / 3600),
    mins: Math.floor((secs % 3600) / 60),
    secs: secs % 60,
    live: startedAt > 0 && left > 0,
    over: left <= 0,
    started: startedAt > 0,
  };
}

function baseCard(key) {
  const tone = TONE[key.tone] || TONE.dim;
  const c = D.canvas(72, 72);
  D.roundRect(c, 0, 0, 72, 72, 10, tone.bg);
  D.stroke(c, 0, 0, 72, 72, 10, 1, tone.edge);
  return { c, tone };
}

function drawTimer(c) {
  D.roundRect(c, 0, 0, 72, 72, 10, [8, 8, 13]);
  D.stroke(c, 0, 0, 72, 72, 10, 1, C.edge);
  if (!state) {
    D.textCenter(c, 'NO LINK', 30, 2, C.faint);
    return;
  }
  const t = clockParts(Date.now() + offset);
  const colour = t.over ? C.like : C.txt;
  D.textCenter(c, t.over ? 'OVER' : t.started ? 'LEFT' : 'TO GO', 4, 1, C.dim);

  const digits = String(t.hours);
  const segW = 13;
  const segH = 24;
  const gap = 3;
  const total = digits.length * segW + (digits.length - 1) * gap;
  let x = Math.round((72 - total) / 2);
  for (const ch of digits) {
    D.digit(c, x, 13, segW, segH, 3, Number(ch), colour);
    x += segW + gap;
  }

  D.textCenter(c, `${pad(t.mins)}:${pad(t.secs)}`, 44, 2, colour);
  D.rect(c, 6, 63, 60, 3, t.over ? C.like : t.live ? C.yt : C.faint);
}

function drawStats(c) {
  const { c: card, tone } = baseCard({ tone: 'dim' });
  D.fill(c, tone.bg);
  if (!state) {
    D.textCenter(c, 'NO LINK', 30, 2, C.faint);
    return;
  }
  const counts = state.counts || {};
  const rows = [
    ['S', counts.sub || 0, C.yt],
    ['K', counts.kofi || 0, C.kofi],
    ['L', counts.like || 0, C.like],
  ];
  rows.forEach(([tag, value, colour], i) => {
    const y = 6 + i * 21;
    D.text(c, tag, 10, y + 3, 2, colour);
    D.text(c, String(value), 26, y, 3, C.txt);
  });
}

function drawMute(c) {
  const tone = audio.muted ? TONE.stop : TONE.go;
  D.fill(c, tone.bg);
  D.stroke(c, 0, 0, 72, 72, 10, 1, tone.edge);
  D.textCenter(c, 'MUSIC', 8, 2, C.dim);
  D.textCenter(c, audio.muted ? 'MUTED' : audio.ready ? `${Math.round(audio.db)}DB` : 'OBS OFF', 32, 2, tone.txt);
  D.rect(c, 6, 63, 60, 3, audio.muted ? C.yt : audio.ready ? C.ok : C.faint);
}

function drawScene(c, key) {
  const on = key.name === currentScene;
  D.fill(c, on ? C.scene : TONE.dim.bg);
  D.stroke(c, 0, 0, 72, 72, 10, on ? 2 : 1, on ? C.sceneEdge : C.edge);
  const lines = D.wrap(key.name, 8, 2);
  const startY = lines.length === 1 ? 30 : 22;
  lines.forEach((lineText, i) => {
    D.textCenter(c, lineText, startY + i * 14, 2, on ? [255, 255, 255] : C.dim);
  });
  if (on) D.rect(c, 6, 63, 60, 3, C.sceneEdge);
}

function drawTextKey(c, key) {
  const { tone } = baseCard(key);
  D.fill(c, tone.bg);
  D.stroke(c, 0, 0, 72, 72, 10, 1, tone.edge);
  if (!key.title) return;
  const lines = D.wrap(key.title, 8, 2);
  const startY = key.sub ? (lines.length === 1 ? 18 : 12) : lines.length === 1 ? 30 : 22;
  lines.forEach((lineText, i) => D.textCenter(c, lineText, startY + i * 14, 2, tone.txt));
  if (key.sub) D.textCenter(c, key.sub, 50, 2, C.dim);
}

function drawFlash(c, entry) {
  D.rect(c, 6, 63, 60, 3, entry.ok ? C.ok : C.yt);
  if (!entry.ok) D.textCenter(c, 'FAIL', 8, 1, C.yt);
}

/* ------------------------------------------------------------------ pages */

function sceneKeys() {
  return scenes.slice(0, 10).map((name) => ({ kind: 'scene', name, action: () => setScene(name) }));
}

function pageKeys(index) {
  const main = [
    { kind: 'timer' },
    { title: 'GO LIVE', sub: 'OBS', tone: 'go', action: () => act('/api/obs/start') },
    { title: 'END', sub: 'STREAM', tone: 'stop', action: () => act('/api/obs/stop') },
    { title: 'UNDO', sub: 'LAST', action: () => act('/api/undo') },
    { title: 'SYNC', sub: 'YOUTUBE', action: () => act('/api/youtube/check') },
    { title: 'SUB', sub: '+5:00', tone: 'sub', action: () => act('/api/boost', { type: 'sub' }) },
    { title: 'KO-FI', sub: '+30:00', tone: 'kofi', action: () => act('/api/boost', { type: 'kofi' }) },
    { title: 'LIKE', sub: '+0:30', tone: 'like', action: () => act('/api/boost', { type: 'like' }) },
    { title: 'START', sub: 'NOW', action: () => act('/api/start') },
    { kind: 'mute', action: toggleMute },
    { kind: 'stats' },
    {},
    {},
    { title: '< MIX', tone: 'dim', action: () => setPage(2) },
    { title: 'SCENES >', tone: 'dim', action: () => setPage(1) },
  ];

  const scenesPage = [
    ...sceneKeys(),
    ...Array.from({ length: 10 - Math.min(scenes.length, 10) }, () => ({})),
    {},
    {},
    {},
    { title: '< MAIN', tone: 'dim', action: () => setPage(0) },
    { title: 'MIX >', tone: 'dim', action: () => setPage(2) },
  ];

  const mixPage = [
    { title: 'VOL', sub: '-3 DB', action: () => nudgeVolume(-3) },
    { title: 'VOL', sub: '+3 DB', action: () => nudgeVolume(3) },
    { kind: 'mute', action: toggleMute },
    { title: '0 DB', sub: 'NORMAL', action: () => setVolume(0) },
    { title: '-INF', sub: 'SILENT', action: () => setVolume(-60) },
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    { title: '< SCENES', tone: 'dim', action: () => setPage(1) },
    { title: 'MAIN >', tone: 'dim', action: () => setPage(0) },
  ];

  return [main, scenesPage, mixPage][index];
}

function buildKey(index) {
  const key = pageKeys(page)[index] || {};
  const c = D.canvas(72, 72);
  D.fill(c, C.bg);

  if (key.kind === 'timer') drawTimer(c);
  else if (key.kind === 'stats') drawStats(c);
  else if (key.kind === 'mute') drawMute(c);
  else if (key.kind === 'scene') drawScene(c, key);
  else drawTextKey(c, key);

  const entry = flash.get(index);
  if (entry) drawFlash(c, entry);
  return c;
}

function checksum(c) {
  let sum = 0;
  for (let i = 0; i < c.data.length; i += 97) sum = (sum * 31 + c.data[i]) % 1000000007;
  return sum;
}

async function pushKey(index) {
  const c = buildKey(index);
  const sum = checksum(c);
  if (frames.get(index) === sum) return;
  frames.set(index, sum);
  if (!deck) return;
  await deck.fillKeyBuffer(index, c.data, { format: 'rgba' });
}

async function renderAll(force = false) {
  if (force) frames.clear();
  for (let i = 0; i < 15; i++) {
    try {
      await pushKey(i);
    } catch (e) {
      console.error('[deck] key write failed:', e.message);
    }
  }
}

async function setPage(next) {
  page = next;
  frames.clear();
  await renderAll(true);
  console.log(`[deck] page: ${['MAIN', 'SCENES', 'MIX'][page]}`);
}

/* ---------------------------------------------------------------- actions */

let lastError = '';

async function act(pathname, body, label) {
  const res = await api(pathname, body);
  const ok = res.ok !== false;
  if (!ok) {
    lastError = res.error || 'failed';
    console.error(`[deck] ${pathname} failed: ${lastError}`);
  } else if (label) {
    console.log(`[deck] ${label}`);
  }
  if (res.state) applyState(res.state);
  else await refreshState();
  return ok;
}

async function toggleMute() {
  const res = await api('/api/ytpmvs/audio', { muted: !audio.muted });
  if (res.ok) {
    audio = { ready: true, muted: !!res.muted, db: Number(res.volumeDb ?? audio.db) };
  }
  return res.ok;
}

function sendVolume(mul) {
  return api('/api/ytpmvs/audio', { volumeMul: mul }).then((res) => {
    if (res.ok) audio = { ready: true, muted: !!res.muted, db: Number(res.volumeDb ?? audio.db) };
    return res.ok;
  });
}

function setVolume(db) {
  return sendVolume(db <= -60 ? 0.001 : Math.pow(10, db / 20));
}

function nudgeVolume(delta) {
  const db = Math.max(-60, Math.min(0, Math.round(audio.db + delta)));
  return setVolume(db);
}

async function setScene(name) {
  const res = await api('/api/obs/scene', { sceneName: name });
  if (res.ok) currentScene = name;
  await refreshScenes();
  return res.ok;
}

/* ------------------------------------------------------------------- data */

function applyState(next) {
  state = next;
  offset = (next.serverNow || Date.now()) - Date.now();
}

async function refreshState() {
  const res = await api('/api/state');
  if (res && res.serverNow) applyState(res);
  else if (state === null) state = null;
}

async function refreshScenes() {
  const res = await api('/api/obs/scenes');
  if (res.ok) {
    scenes = res.scenes || [];
    currentScene = res.current || '';
  }
}

async function refreshAudio() {
  const res = await api('/api/ytpmvs/audio');
  if (res.ok) audio = { ready: true, muted: !!res.muted, db: Number(res.volumeDb ?? 0) };
  else audio = { ready: false, muted: false, db: 0 };
}

/* --------------------------------------------------------------- handlers */

async function onDown(index) {
  const key = pageKeys(page)[index];
  if (!key || !key.action) return;
  const label = key.title ? `${key.title} ${key.sub || ''}`.trim() : key.kind || key.name;
  const ok = await key.action();
  flash.set(index, { ok: ok !== false, until: Date.now() + 700 });
  await pushKey(index);
  setTimeout(() => {
    flash.delete(index);
    pushKey(index).catch(() => {});
  }, 700);
  if (ok === false) console.error(`[deck] ${label}: ${lastError || 'failed'}`);
}

/* ---------------------------------------------------------------- connect */

let reportedMissing = false;

async function connect() {
  const { listStreamDecks } = require('@elgato-stream-deck/node');
  const devices = await listStreamDecks();
  if (!devices.length) throw new Error('no Stream Deck on USB');
  const device = devices.find((d) => d.model === 'original-mk2') || devices[0];
  deck = await require('@elgato-stream-deck/node').openStreamDeck(device.path);
  deck.on('down', (control) => {
    // v7 hands over the control definition, older builds the bare index.
    const index = typeof control === 'number' ? control : control.index;
    onDown(index).catch((e) => console.error('[deck] press failed:', e.message));
  });
  deck.on('error', (e) => {
    console.error('[deck] device error:', e.message);
    process.exit(1);
  });
  await deck.setBrightness(BRIGHTNESS);
  frames.clear();
  await renderAll(true);
  reportedMissing = false;
  console.log(`[deck] connected: ${device.model} at ${device.path} (${device.serialNumber || 'no serial'})`);
}

async function main() {
  console.log(`[deck] server: ${SERVERS}`);
  await refreshState();
  await refreshScenes();
  await refreshAudio();

  if (PREVIEW) {
    const names = ['main', 'scenes', 'mix'];
    for (let p = 0; p < 3; p++) {
      page = p;
      const sheet = D.canvas(5 * 72 + 6 * 8, 3 * 72 + 4 * 8);
      D.fill(sheet, [4, 4, 6]);
      for (let i = 0; i < 15; i++) {
        const key = buildKey(i);
        const col = i % 5;
        const row = Math.floor(i / 5);
        const ox = 8 + col * (72 + 8);
        const oy = 8 + row * (72 + 8);
        for (let y = 0; y < 72; y++) {
          for (let x = 0; x < 72; x++) {
            const si = (y * 72 + x) * 4;
            const di = ((oy + y) * sheet.w + ox + x) * 4;
            sheet.data[di] = key.data[si];
            sheet.data[di + 1] = key.data[si + 1];
            sheet.data[di + 2] = key.data[si + 2];
            sheet.data[di + 3] = 255;
          }
        }
      }
      const file = path.join(__dirname, `_preview-${names[p]}.png`);
      fs.writeFileSync(file, D.toPNG(sheet));
      console.log(`[deck] wrote ${file}`);
    }
    return;
  }

  for (;;) {
    try {
      await connect();
      break;
    } catch (e) {
      if (!reportedMissing) console.error('[deck] waiting for a Stream Deck:', e.message);
      reportedMissing = true;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Clock and status: the timer key ticks once a second, everything else only
  // when the server says something actually changed.
  setInterval(() => {
    pushKey(0).catch(() => {});
    for (const [index, entry] of flash) if (Date.now() > entry.until) flash.delete(index);
  }, 1000);

  setInterval(async () => {
    await refreshState();
    if (page === 0) {
      await pushKey(1);
      await pushKey(2);
      await pushKey(10);
      await pushKey(3);
    }
  }, 2500);

  setInterval(async () => {
    await refreshScenes();
    if (page === 1) await renderAll(true);
    else if (page === 0) await pushKey(14);
  }, 15000);

  setInterval(async () => {
    await refreshAudio();
    if (page === 0) await pushKey(9);
    else if (page === 2) await pushKey(2);
  }, 10000);
}

process.on('unhandledRejection', (e) => console.error('[deck] unhandled:', e && e.message));
main().catch((e) => {
  console.error('[deck] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
