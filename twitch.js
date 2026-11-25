/**
 * Twitch streamer queue for the "asleep" scene.
 *
 * The scene shows a browser source that plays whatever the local relay
 * (apk-work/studio/server.mjs on 127.0.0.1:8099) is relaying. This module owns
 * the ordered list of streamers and decides who should be on:
 *
 *   - switching a streamer = POST /channel on the relay + reload that browser
 *     source, so the picture comes back on the new channel straight away
 *   - liveness comes from the relay's /live (one batched GQL query)
 *   - automatic rotation only runs while the configured scene is the program
 *     scene, so it never surprises you on another scene; when the current
 *     streamer goes offline it moves to the next online one in queue order and
 *     wraps around at the end
 *
 * The queue lives in twitch.json (next to this file), so the app can change it
 * without touching config.json.
 */
const fs = require("node:fs");
const path = require("node:path");

const LOGIN_RE = /^[a-z0-9_]{2,25}$/i;
const FILE = path.join(__dirname, "twitch.json");
const MIN_AUTO_GAP_MS = 60 * 1000;

/** Accepts "name", "@name", "https://twitch.tv/name", "twitch.tv/name/". */
function parseLogin(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return null;
  const m = raw.match(/twitch\.tv\/([^/?#\s]+)/i);
  const name = (m ? m[1] : raw).replace(/^@/, "").trim().toLowerCase();
  return LOGIN_RE.test(name) ? name : null;
}

/**
 * Next streamer that is known to be live, walking the queue from the one after
 * `current` and wrapping. Pure, so the failover order can be checked without
 * touching the stream.
 */
function pickNextOnline(streamers, current, liveMap) {
  const logins = (streamers || []).map((s) => (typeof s === "string" ? s : s.login)).filter(Boolean);
  if (!logins.length) return null;
  const start = logins.indexOf(current);
  for (let step = 1; step <= logins.length; step++) {
    const login = logins[(start + step + logins.length) % logins.length];
    if (login === current) continue;
    const live = liveMap && liveMap[login];
    if (live && live.live) return login;
  }
  return null;
}

function createTwitch(cfg, deps) {
  const obs = deps.obs;
  const log = deps.log || (() => {});
  const relay = String(cfg.relay || "http://127.0.0.1:8099").replace(/\/+$/, "");
  const sceneName = cfg.scene || "nighty_stream_when_asleep";
  const sourceName = cfg.source || "Ray stream";
  const enabled = cfg.enabled !== false;

  const seed = (cfg.streamers || [])
    .map((s) => (typeof s === "string" ? { login: parseLogin(s) } : { login: parseLogin(s.login), label: s.label }))
    .filter((s) => s.login);

  let data = load();
  let live = {};
  let liveAt = 0;
  let error = null;
  let lastSwitchAt = 0;
  let switching = false;
  let tick = null;

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      return {
        streamers: (j.streamers || []).filter((s) => s && parseLogin(s.login)).map((s) => ({ login: parseLogin(s.login), label: s.label || "" })),
        autoRotate: j.autoRotate !== false,
        current: parseLogin(j.current),
      };
    } catch {
      return { streamers: seed.map((s) => ({ login: s.login, label: s.label || "" })), autoRotate: true, current: seed[0] ? seed[0].login : null };
    }
  }

  function save() {
    try {
      fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      log(`[twitch] could not write twitch.json: ${e.message}`);
    }
  }

  async function relayJson(pathname, init) {
    const res = await fetch(`${relay}${pathname}`, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${pathname}: ${res.status} ${text.slice(0, 120)}`);
    }
    if (!res.ok || body.ok === false) throw new Error(body.error || `${pathname}: ${res.status}`);
    return body;
  }

  async function refreshLive() {
    if (!data.streamers.length) return;
    try {
      const logins = data.streamers.map((s) => s.login).join(",");
      const r = await relayJson(`/live?logins=${encodeURIComponent(logins)}`);
      live = r.channels || {};
      liveAt = Date.now();
      error = null;
    } catch (e) {
      error = `liveness: ${e.message}`;
    }
  }

  /** Adopt whatever the relay is actually relaying (it persists its own channel). */
  async function adoptRelayChannel() {
    try {
      const r = await relayJson("/channel");
      const login = parseLogin(r.channel);
      if (login && login !== data.current) {
        data.current = login;
        save();
      }
    } catch (e) {
      error = `relay: ${e.message}`;
    }
  }

  async function reloadSource() {
    if (!obs.authenticated) return false;
    try {
      await obs.request("PressInputPropertiesButton", { inputName: sourceName, propertyName: "refreshnocache" });
      return true;
    } catch (e) {
      log(`[twitch] source reload failed: ${e.message}`);
      return false;
    }
  }

  async function switchTo(login, reason) {
    const target = parseLogin(login);
    if (!target) return { ok: false, error: "not a twitch channel name or link" };
    if (switching) return { ok: false, error: "a switch is already running" };
    switching = true;
    try {
      await relayJson("/channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: target }),
      });
      data.current = target;
      lastSwitchAt = Date.now();
      save();
      const reloaded = await reloadSource();
      log(`[twitch] now showing ${target}${reason ? ` (${reason})` : ""}${reloaded ? "" : " — source not reloaded"}`);
      // the new channel's liveness is only known after the next poll
      setTimeout(() => refreshLive().catch(() => {}), 4000);
      error = null;
      return { ok: true, current: target };
    } catch (e) {
      error = e.message;
      return { ok: false, error: e.message };
    } finally {
      switching = false;
    }
  }

  function inScene() {
    const scene = obs.authenticated ? obs.scene : null;
    return !!scene && String(scene).toLowerCase() === sceneName.toLowerCase();
  }

  function currentLive() {
    const hit = live[data.current];
    return !!(hit && hit.live);
  }

  /** Failover: only when the queue is in charge and the person on is offline. */
  async function rotate() {
    if (!enabled || !data.autoRotate) return null;
    if (!obs.authenticated || !inScene()) return null;
    if (!data.streamers.length) return null;
    if (Date.now() - lastSwitchAt < MIN_AUTO_GAP_MS) return null;
    if (Date.now() - liveAt > 90 * 1000) await refreshLive();
    if (!data.current) {
      const first = pickNextOnline(data.streamers, null, live);
      if (first) return switchTo(first, "nothing on yet");
      return null;
    }
    if (currentLive()) return null;
    const next = pickNextOnline(data.streamers, data.current, live);
    if (!next) return null;
    return switchTo(next, `${data.current} is offline`);
  }

  async function status() {
    if (Date.now() - liveAt > 15000) await refreshLive();
    return {
      ok: true,
      enabled,
      relay,
      scene: sceneName,
      inScene: inScene(),
      autoRotate: !!data.autoRotate,
      current: data.current,
      currentLive: currentLive(),
      lastSwitchAt: lastSwitchAt || null,
      liveAt: liveAt || null,
      error,
      streamers: data.streamers.map((s) => {
        const hit = live[s.login];
        return {
          login: s.login,
          label: s.label || (hit && hit.displayName) || s.login,
          live: !!(hit && hit.live),
          viewers: (hit && hit.viewers) || 0,
          title: (hit && hit.title) || "",
          current: s.login === data.current,
        };
      }),
    };
  }

  /** Compact copy for /api/state, so the phone's 2 s poll keeps the tab fresh. */
  function summary() {
    return {
      enabled,
      scene: sceneName,
      inScene: inScene(),
      autoRotate: !!data.autoRotate,
      current: data.current,
      currentLive: currentLive(),
      error,
      streamers: data.streamers.map((s) => {
        const hit = live[s.login];
        return {
          login: s.login,
          label: s.label || (hit && hit.displayName) || s.login,
          live: !!(hit && hit.live),
          viewers: (hit && hit.viewers) || 0,
          current: s.login === data.current,
        };
      }),
    };
  }

  return {
    start() {
      if (!enabled) return;
      adoptRelayChannel();
      refreshLive();
      tick = setInterval(async () => {
        try {
          if (Date.now() - liveAt > 15000) await refreshLive();
          await rotate();
        } catch (e) {
          error = e.message;
        }
      }, 20000);
      // every few minutes, pick up a channel changed straight on the relay
      setInterval(() => adoptRelayChannel().catch(() => {}), 180000);
      log(`[twitch] queue ready (scene "${sceneName}", source "${sourceName}", ${data.streamers.length} streamer(s))`);
    },
    stop() {
      if (tick) clearInterval(tick);
    },
    status,
    summary,
    switchTo,
    refreshLive,
    inScene,

    async add(input) {
      const login = parseLogin(input);
      if (!login) return { ok: false, error: "not a twitch channel name or link" };
      if (data.streamers.some((s) => s.login === login)) return { ok: false, error: `${login} is already in the queue` };
      data.streamers.push({ login, label: "" });
      save();
      refreshLive().catch(() => {});
      return { ok: true, added: login };
    },

    remove(input) {
      const login = parseLogin(input);
      const before = data.streamers.length;
      data.streamers = data.streamers.filter((s) => s.login !== login);
      if (data.streamers.length === before) return { ok: false, error: `${login} is not in the queue` };
      save();
      return { ok: true, removed: login };
    },

    move(input, delta) {
      const login = parseLogin(input);
      const from = data.streamers.findIndex((s) => s.login === login);
      if (from < 0) return { ok: false, error: `${login} is not in the queue` };
      const to = Math.max(0, Math.min(data.streamers.length - 1, from + (Number(delta) || 0)));
      if (to === from) return { ok: true, moved: false };
      const [item] = data.streamers.splice(from, 1);
      data.streamers.splice(to, 0, item);
      save();
      return { ok: true, moved: true, index: to };
    },

    setAuto(on) {
      data.autoRotate = !!on;
      save();
      return { ok: true, autoRotate: data.autoRotate };
    },

    async next() {
      const list = data.streamers;
      if (!list.length) return { ok: false, error: "the queue is empty" };
      if (Date.now() - liveAt > 15000) await refreshLive();
      const target = pickNextOnline(list, data.current, live);
      if (!target) return { ok: false, error: "nobody in the queue is live right now" };
      return switchTo(target, "skipped by hand");
    },
  };
}

module.exports = { createTwitch, pickNextOnline, parseLogin };
