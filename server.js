/**
 * Emilli FTL — 24h stream timer server.
 *
 * One process owns the clock (state.json), pushes every change to the browser
 * dashboard and the OBS overlay over SSE, receives Ko-fi webhooks and polls the
 * YouTube Data API for new subs / likes.
 *
 * Zero dependencies. Run: node server.js
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const ROOT = __dirname;
const BASE_MS = 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------- modpacks */

// Stream Deck keys launch these through Prism's `-w`, which drops straight into
// the singleplayer world instead of stopping at the title screen.
const PRISM = "prismlauncher";
const MODPACKS = {
  po3: { label: "PO3", instance: "Project Ozone 3 A New Way Forward", world: "2nd time mythicc" },
  atm9: { label: "ATM9 EXPERT", instance: "All the Mods 9 Expert", world: "New World (1)" },
  mystic: {
    label: "MYSTIC 119.1.0",
    instance: "Mystic's Monstrosity - Greedy Edition 119.1.0",
    world: "NewYearsStream",
  },
};

/* ------------------------------------------------------------------ config */

const CONFIG_FILE = path.join(ROOT, "config.json");
const CONFIG_DEFAULTS = {
  port: 8123,
  // Bind address. "127.0.0.1" keeps everything local; "0.0.0.0" also lets a
  // phone on the same Wi-Fi open the remote at http://<pc-ip>:8123/mobile.html.
  // Only loopback and private LAN hosts are ever accepted — the public tunnel
  // stays limited to POST /kofi (see isPublicRequest).
  host: "127.0.0.1",
  youtube: {
    apiKey: "",
    handle: "EmilliFTL",
    videoId: "",            // optional: paste the live video id to skip auto-detect
    autoDetectLive: true,
    pollSeconds: 30,
    // OAuth client (Google Cloud → Credentials → OAuth client ID, type
    // "Desktop app"). Authorize once at http://localhost:8123/oauth/start and
    // the timer can then read individual subscribers by name.
    oauth: { clientId: "", clientSecret: "" },
    // The live stream (stream key) a new broadcast is bound to. Empty =
    // auto-detect: the channel's first stream key, or the one whose title
    // contains streamName when there are several.
    streamId: "",
    streamName: "",
    subsPollSeconds: 120,   // subscriptions.list is 1 quota unit per call
    // Live chat (liveChatMessages.list), rebroadcast as SSE "chat" events for
    // overlays and the Minecraft relay. Uses the OAuth token when there is one,
    // the API key otherwise.
    chat: { enabled: true, pollSeconds: 5 },
    // socialcounts.org publishes YouTube's rounded total next to its own live
    // estimate, which moves before the 10-sub rounding step does. Used as a
    // watchdog and as the finer display value.
    socialcounts: {
      enabled: true,
      channelId: "UCYLki_57xkd9KoKygzB0q3A",
      baseUrl: "https://api.socialcounts.org/youtube-live-subscriber-count",
      pollSeconds: 30,
    },
    // Extra subscriber-count sources next to the Data API and socialcounts:
    // youtube.com's own channel page needs no key and no quota, so counting
    // keeps working when the API key is missing, revoked or rate limited.
    // Every source feeds one shared high-water mark (see creditSubs).
    subCount: {
      innertube: true,
      rejectJump: 500,   // a bigger "gain" is a bad reading from a mirror, not subs
    },
    // Videos to keep out of the camera2 YTPMV rotation: full ids, or plain
    // case-insensitive substrings of the title ("Q&A", "tilliewood", …).
    // audioInput is the OBS input whose fader the dashboard's music slider
    // drives (the browser source runs with "Control audio via OBS").
    ytpmvs: { excludeIds: [], excludeTitles: [], audioInput: "Emilli YTPMVs" },
  },
  kofi: {
    verificationToken: "",  // from ko-fi.com/manage/webhooks → Advanced
    pageUrl: "https://ko-fi.com/emilliftl",
  },
  // Control from outside the LAN (mobile data). enabled + a token opens the
  // public tunnel for real, but only for someone who has the token URL
  // (<tunnel>/mobile.html?t=<token>); the first visit stores a cookie.
  // Without this block the public tunnel still serves nothing but POST /kofi.
  remote: { enabled: false, token: "" },
  obs: {
    enabled: false,
    url: "ws://127.0.0.1:4455",
    password: "",             // OBS → Tools → WebSocket Server Settings
    autoStart: true,          // goes live when the clock starts at 21:30
    autoStop: true,           // ends the stream when the clock hits zero
  },
  vlc: {
    enabled: true,
    url: "http://127.0.0.1:8080",  // VLC's HTTP interface (--extraintf=http)
    password: "",                  // --http-password
  },
};

function loadConfig() {
  let cfg = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG_DEFAULTS, null, 2));
      console.log("[config] created config.json — add your YouTube API key to it");
    }
    const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    cfg = {
      ...cfg,
      ...disk,
      youtube: { ...cfg.youtube, ...(disk.youtube || {}) },
      kofi: { ...cfg.kofi, ...(disk.kofi || {}) },
      obs: { ...cfg.obs, ...(disk.obs || {}) },
      vlc: { ...cfg.vlc, ...(disk.vlc || {}) },
    };
  } catch (e) {
    console.error("[config] could not read config.json:", e.message);
  }
  if (process.env.YOUTUBE_API_KEY) cfg.youtube.apiKey = process.env.YOUTUBE_API_KEY;
  if (process.env.KOFI_VERIFICATION_TOKEN) cfg.kofi.verificationToken = process.env.KOFI_VERIFICATION_TOKEN;
  if (process.env.OBS_PASSWORD) cfg.obs.password = process.env.OBS_PASSWORD;
  if (process.env.OBS_URL) cfg.obs.url = process.env.OBS_URL;
  return cfg;
}
const config = loadConfig();
const obs = require("./obs")(config.obs, (m) => console.log(m));
const { createTwitch } = require("./twitch");
const twitch = createTwitch(config.twitch || {}, { obs, log: (m) => console.log(m) });
const { createBrb } = require("./brb");
const brb = createBrb((m) => console.log(m));
const { createAway } = require("./away");
const away = createAway((m) => console.log(m));

// Some launchers export PORT=0/empty; only trust a usable value, then config.json.
const PORT = (() => {
  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  const cfgPort = Number(config.port);
  if (Number.isInteger(cfgPort) && cfgPort > 0) return cfgPort;
  return 8123;
})();

const HOST = String(config.host || "127.0.0.1");
const LAN_OPEN = HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1";

// Reads the channel's recent subscribers (needs the owner's OAuth token).
const ytOAuth = require("./yt-oauth")({
  clientId: config.youtube.oauth.clientId,
  clientSecret: config.youtube.oauth.clientSecret,
  redirectUri: `http://127.0.0.1:${PORT}/oauth2callback`,
  tokenFile: path.join(ROOT, "yt-token.json"),
});

// Broadcast control: end the running broadcast, create a new one with a chosen
// latency class, bind it to the same stream key and let it go live. Same token
// as the subscriber feed, which is why the scope is youtube.force-ssl.
const ytLive = require("./yt-live")({
  oauth: ytOAuth,
  streamIdHint: config.youtube.streamId,
  streamName: config.youtube.streamName,
  log: (m) => console.log(m),
});

// The after-GO-LIVE rule: this broadcast is not Ultra-low → switch it again.
const { decide: decideAutoUltra, MAX_ATTEMPTS: AUTO_ULTRA_MAX } = require("./auto-ultra");

/* ------------------------------------------------------------------- state */

const STATE_FILE = path.join(ROOT, "state.json");

function freshState() {
  return {
    startAt: "2026-11-23T21:30",
    startedAt: null,
    addedMs: 0,
    counts: { sub: 0, kofi: 0, like: 0 },
    log: [],
    seenKofi: [],
    yt: {
      channelId: null,
      videoId: null,
      lastSubs: null,
      lastLikes: null,
      subPeak: null,      // highest subscriber count we have ever paid out for
      likePeak: null,     // highest like count we have ever paid out for
      lastCheck: null,
      lastError: null,
      hiddenSubs: false,
      nextVideoLookup: 0,
      lookupsToday: 0,
      lookupDay: null,
      // OAuth subscriber tracking: ids already paid for (or the baseline),
      // newest last. "count" = we only have YouTube's rounded total.
      seenSubs: [],
      subsMode: "count",
      lastSubsPoll: null,
      subsError: null,
      // socialcounts.org watchdog: last reading + last failure
      scLast: null,
      scError: null,
      scPolls: 0,
      scFails: 0,
      // Subscriber ledger. subSources is per-source health
      // ({ ok, count, error, at, exact, polls, fails }). nameCredits counts the
      // subscribers OAuth paid for by name since the last count reading, so a
      // count rise only pays for the ones the feed has not credited yet.
      subSources: {},
      nameCredits: 0,
      nameMark: 0,
      // Latency class YouTube reports for THIS broadcast, read from the
      // channel's live page after every start; null until the first read.
      latency: {
        class: null,      // ULTRA_LOW | LOW | NORMAL
        videoId: null,    // the broadcast the class belongs to
        at: null,         // when the page was read
        startedAt: null,  // when this broadcast went live in OBS
        error: null,      // last failed read, cleared by a successful one
      },
      // Background latency switch (end → create with the class → bind → go
      // live): { at, requested, step, done, ok, error, videoId, latency }.
      switch: null,
      // The one-tap auto-fix: when on, a broadcast that comes up anything but
      // Ultra-low is switched again after the class is read.
      // { enabled, attempts, gaveUp, lastAt, lastClass }
      autoUltra: { enabled: false, attempts: 0, gaveUp: false, lastAt: null, lastClass: null },
      // What YouTube says is on air: { id, live, status, at }. null until the
      // first read. This is what catches OBS encoding while YouTube has no
      // broadcast bound to the stream key — the case that used to look healthy.
      onAir: null,
    },
    chat: {
      videoId: null,      // the broadcast the liveChatId belongs to
      liveChatId: null,
      pageToken: null,    // makes polling lossless: the next call returns what came since
      lookupAt: 0,        // last attempt to resolve liveChatId for this video
      lastAt: null,
      error: null,
      messages: 0,
    },
    kofi: { lastEvent: null, lastHitAt: null, hits: 0 },
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    const base = freshState();
    return {
      ...base,
      ...s,
      counts: { ...base.counts, ...(s.counts || {}) },
      yt: { ...base.yt, ...(s.yt || {}) },
      chat: { ...base.chat, ...(s.chat || {}) },
      kofi: { ...base.kofi, ...(s.kofi || {}) },
      log: Array.isArray(s.log) ? s.log : [],
      seenKofi: Array.isArray(s.seenKofi) ? s.seenKofi : [],
    };
  } catch {
    return freshState();
  }
}

let state = loadState();
let obsHoldAt = 0;          // 0 = no hold; set only by a confirmed manual END
let obsHealth = null;       // last GetStreamStatus snapshot (see pollObsHealth)
let obsHealthSig = "";      // what the last broadcast of state contained
let obsActionError = null;  // last failed start/stop, surfaced on the dashboard
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("[state] write failed:", e.message);
    }
  }, 40);
}

/* ------------------------------------------------------------------- boost */

const BOOSTS = {
  sub: { ms: 5 * 60 * 1000, label: "NEW SUB", icon: "sub" },
  kofi: { ms: 30 * 60 * 1000, label: "KO-FI DONO", icon: "kofi" },
  like: { ms: 30 * 1000, label: "VIDEO LIKE", icon: "like" },
};

function bankMs() {
  return BASE_MS + state.addedMs;
}

function remainingMs(now = Date.now()) {
  const bank = bankMs();
  if (!state.startedAt) return null;
  return bank - (now - state.startedAt);
}

/* -------------------------------------------------- pinned chat + apk info */

// YouTube has no pin method: liveChat/messages is insert-only, and
// liveChat/messages/transition can only close a poll. Pinning lives in Studio
// alone, so the timer does the half that is automated — keep the note, post it
// as the channel (on demand, or on every go-live) — and hands over the one
// Studio link that takes the single click.
const APK_LOCAL = "/emilli-remote.apk";
const APK_PUBLIC_PAGE = "https://emilli-remote-apk-rc7iae.freebuff.site/";
const APK_PUBLIC_FILE = "https://emilli-remote-apk-rc7iae.freebuff.site/emilli-remote.apk";
const REPO_URL = "https://github.com/NeofastFTL-Dev/YTLiveDash";

function savePin(patch) {
  state.yt.pin = { ...(state.yt.pin || {}), ...patch, at: Date.now() };
  save();
  broadcast("state", publicState());
  return state.yt.pin;
}

function apkInfo() {
  const info = {
    local: APK_LOCAL,
    page: APK_PUBLIC_PAGE,
    file: APK_PUBLIC_FILE,
    repo: REPO_URL,
    releases: REPO_URL + "/releases/latest",
    bytes: null,
    at: null,
    version: null,
  };
  try {
    const st = fs.statSync(path.join(ROOT, "emilli-remote.apk"));
    info.bytes = st.size;
    info.at = st.mtimeMs;
  } catch {}
  try {
    const man = fs.readFileSync(path.join(ROOT, "android", "AndroidManifest.xml"), "utf8");
    const name = /android:versionName="([^"]+)"/.exec(man);
    const code = /android:versionCode="(\d+)"/.exec(man);
    if (name) info.version = { name: name[1], code: code ? Number(code[1]) : null };
  } catch {}
  return info;
}

/** Post the saved note as the channel; returns the Studio link for the pin. */
async function postPinMessage(text) {
  const live = await ytLive.activeBroadcast();
  if (!live) return { ok: false, error: "nothing is live — there is no chat to post in" };
  const msg = await ytLive.sendChat(live.id, text);
  savePin({ lastSentAt: Date.now(), lastId: (msg && msg.id) || null });
  return {
    ok: true,
    id: (msg && msg.id) || null,
    videoId: live.id,
    studio: `https://studio.youtube.com/video/${live.id}/livestreaming`,
    pinned: false,
    note: "posted as the channel — the API cannot pin, open Studio and press Pin",
  };
}

function publicState() {
  const bank = bankMs();
  return {
    serverNow: Date.now(),
    startAt: state.startAt,
    startedAt: state.startedAt,
    baseMs: BASE_MS,
    addedMs: state.addedMs,
    bankMs: bank,
    remainingMs: remainingMs(),
    counts: state.counts,
    log: state.log.slice(-40),
    integrations: {
      youtube: {
        configured: !!config.youtube.apiKey,
        handle: config.youtube.handle,
        channelId: state.yt.channelId,
        videoId: state.yt.videoId,
        // { id, live, status, at } read from YouTube itself, so the dashboard
        // can say "nothing is on air" while OBS is still streaming.
        onAir: state.yt.onAir || null,
        subs: state.yt.lastSubs,
        likes: state.yt.lastLikes,
        chat: {
          enabled: !!config.youtube.chat?.enabled,
          liveChatId: state.chat.liveChatId,
          messages: state.chat.messages || 0,
          lastAt: state.chat.lastAt,
          error: state.chat.error,
        },
        hiddenSubs: !!state.yt.hiddenSubs,
        lastCheck: state.yt.lastCheck,
        error: state.yt.lastError,
        pollSeconds: config.youtube.pollSeconds,
        // "oauth" = each subscriber is seen by name; "count" = rounded total
        subsMode: ytOAuth.hasToken() ? "oauth" : "count",
        subsTracked: (state.yt.seenSubs || []).length,
        subsLastPoll: state.yt.lastSubsPoll,
        subsError: state.yt.subsError,
        oauthConfigured: ytOAuth.configured(),
        oauthConnected: ytOAuth.hasToken(),
        pin: state.yt.pin || null,
        apk: apkInfo(),
        socialcounts: {
          enabled: !!config.youtube.socialcounts.enabled,
          estimation: state.yt.scLast ? state.yt.scLast.estimation : null,
          api: state.yt.scLast ? state.yt.scLast.api : null,
          at: state.yt.scLast ? state.yt.scLast.at : null,
          error: state.yt.scError,
          polls: state.yt.scPolls || 0,
          fails: state.yt.scFails || 0,
        },
        // Every subscriber-count source and its health; all of them feed the
        // one high-water mark (subsPeak) so a sub is counted once, and is
        // still counted when a source is down.
        subSources: state.yt.subSources || {},
        subsPeak: state.yt.subPeak,
        subCredits: state.yt.nameCredits || 0,
        // Whether the current broadcast actually came up Ultra-low, as read
        // from youtube.com after the stream started.
        latency: state.yt.latency || null,
        // Progress of a latency switch started from a remote; null when none
        // has ever run.
        switch: state.yt.switch || null,
        // After-GO-LIVE auto-fix and how far its current chain has got.
        autoUltra: state.yt.autoUltra || null,
        // Title/description the operator set from the app. They are pushed to
        // the live broadcast immediately and reused on the next one.
        meta: state.yt.meta || null,
      },
      kofi: {
        enabled: !!config.kofi.verificationToken,
        lastEvent: state.kofi.lastEvent,
        lastHitAt: state.kofi.lastHitAt,
        hits: state.kofi.hits,
        pageUrl: config.kofi.pageUrl,
        endpoint: "/kofi",
      },
      twitch: twitch.summary(),
      brb: brb.summary(),
      // "at work / sleeping / busy until HH:MM" — set from the phone remote,
      // counted down on the BRB overlay.
      away: away.summary(),
      obs: {
        enabled: !!config.obs.enabled,
        url: config.obs.url,
        connected: obs.authenticated,
        streaming: obs.streaming,
        // Cached from OBS's CurrentProgramSceneChanged event, so the 2 s state
        // poll can re-highlight the scene chips without a second request.
        scene: obs.authenticated ? obs.scene : null,
        held: obsHoldActive(),
        error: obs.lastError || obsActionError,
        autoStart: !!config.obs.autoStart,
        autoStop: !!config.obs.autoStop,
        // Stream health from obs-websocket's GetStreamStatus: skipped frames,
        // a bitrate derived from the byte counter, and reconnects this session.
        // This is the evidence for whether the link can hold ultra-low latency.
        health: obsHealth,
      },
    },
  };
}

/**
 * The single place time is ever added. Every source (manual button, Ko-fi
 * webhook, YouTube poll) goes through here so counts, log and notifications
 * can never drift apart.
 */
function applyBoost(type, meta = {}) {
  const b = BOOSTS[type];
  if (!b) return { ok: false, error: `unknown boost: ${type}` };

  state.addedMs += b.ms;
  state.counts[type] = (state.counts[type] || 0) + 1;
  const entry = {
    type,
    at: Date.now(),
    amountMs: b.ms,
    source: meta.source || "manual",
    name: meta.name || "",
    message: meta.message || "",
    amountText: meta.amountText || "",
    test: !!meta.test,
  };
  state.log.push(entry);
  if (state.log.length > 300) state.log = state.log.slice(-300);
  save();

  const notification = {
    kind: "boost",
    type,
    label: b.label,
    amountMs: b.ms,
    name: entry.name,
    message: entry.message,
    amountText: entry.amountText,
    source: entry.source,
    test: entry.test,
    at: entry.at,
    state: publicState(),
  };
  broadcast("message", notification);
  broadcast("state", publicState());
  console.log(
    `[boost] ${type} +${Math.round(b.ms / 1000)}s from ${entry.source}` +
      (entry.name ? ` (${entry.name})` : "") +
      (entry.test ? " [TEST]" : "")
  );
  return { ok: true, state: publicState() };
}

/*
 * Replay an alert on the OBS notification overlay, for testing the look and
 * sound. Deliberately touches nothing: no time, no counts, no log entry — the
 * real /api/boost with test:true is for exercising the accounting, this is for
 * "does the sub alert look right on stream?".
 */
const REPLAY_SAMPLES = {
  sub: { name: "test_viewer", message: "", amountText: "" },
  kofi: { name: "test_supporter", message: "for the 24h run!", amountText: "€5" },
  like: { name: "test_viewer", message: "", amountText: "" },
};

const REPLAY_TEXT_MAX = 120;

function replayAlert(type, extra = {}) {
  const b = BOOSTS[type];
  if (!b) return { ok: false, error: `unknown alert: ${type}` };
  const base = REPLAY_SAMPLES[type] || { name: "test_viewer", message: "", amountText: "" };
  // The app can type its own name/message/amount so the card can be checked
  // with real-looking text; anything not sent keeps the sample wording.
  const pick = (v, fallback) => {
    if (typeof v !== "string") return fallback;
    const t = v.replace(/\s+/g, " ").trim().slice(0, REPLAY_TEXT_MAX);
    return t || fallback;
  };
  const s = {
    name: pick(extra.name, base.name),
    message: pick(extra.message, base.message),
    amountText: pick(extra.amountText, base.amountText),
  };
  const alert = {
    kind: "boost",
    type,
    label: b.label,
    amountMs: b.ms,
    name: s.name,
    message: s.message,
    amountText: s.amountText,
    source: "replay",
    test: true,
    at: Date.now(),
  };
  broadcast("message", { ...alert, state: publicState() });
  console.log(`[alert] replayed ${type} (nothing counted)`);
  return { ok: true, replayed: type, alert, state: publicState() };
}

function undoBoost() {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i];
    if (!BOOSTS[e.type]) continue;
    state.log.splice(i, 1);
    state.addedMs = Math.max(0, state.addedMs - e.amountMs);
    state.counts[e.type] = Math.max(0, (state.counts[e.type] || 0) - 1);
    save();
    broadcast("state", publicState());
    return { ok: true, undone: e, state: publicState() };
  }
  return { ok: false, error: "nothing to undo" };
}

function startNow() {
  if (state.startedAt) return { ok: true, state: publicState() };
  beginRun(Date.now());
  return { ok: true, state: publicState() };
}

/**
 * The one place a run begins. Every caller (scheduler, START NOW button,
 * RESET, start-time edit) goes through here, so a hold left over from testing
 * can never survive into the real go-live.
 */
function beginRun(atMs) {
  if (state.startedAt) return false;
  state.startedAt = atMs;
  // No need to clear obsHoldAt: a hold older than this run's start is inert.
  save();
  broadcast("state", publicState());
  return true;
}

function autoStartIfDue() {
  if (state.startedAt) return;
  const due = new Date(state.startAt).getTime();
  if (!isNaN(due) && Date.now() >= due) beginRun(due);
}

/* ------------------------------------------------------------ obs control */

let lastObsAttempt = 0;

/**
 * A hold means "the operator ended this run on purpose, don't auto-restart it".
 * It is scoped to the run it was set in: a hold taken before go-live (testing
 * END) is ignored the moment a run begins, and a restart of the server drops it
 * because it only lives in memory.
 */
function obsHoldActive() {
  return !!state.startedAt && obsHoldAt > state.startedAt;
}

async function manualObs(action) {
  if (!config.obs.enabled) return { ok: false, error: "obs.enabled is false in config.json" };
  if (!obs.authenticated) return { ok: false, error: obs.lastError || "OBS not connected" };
  try {
    if (action === "start") {
      obsHoldAt = 0;              // an explicit start always releases the hold
      // A human GO LIVE starts a new chain: the auto-fix may try again.
      if ((state.yt.autoUltra || {}).enabled) saveAutoUltra({ attempts: 0, gaveUp: false });

      // A broadcast has to exist and be bound before OBS pushes: "going live"
      // by starting the encoder alone is how the stream ended up sending video
      // to nothing while the dashboard said it was fine.
      let g = { ok: true };
      if (ytOAuth.configured() && ytOAuth.hasToken()) {
        g = await ensureBroadcast().catch((e) => ({ ok: false, error: e.message }));
      }
      if (g.creating) {
        // A switch is creating + binding the broadcast and bounces OBS itself.
        obsActionError = null;
        broadcast("state", publicState());
        return { ok: true, creating: true, state: publicState() };
      }
      if (!g.ok) {
        // No OAuth means no broadcast control; OBS still starts and the on-air
        // line in the UI shows that nothing is bound.
        console.warn("[obs] starting without a broadcast:", g.error);
      }
      await obs.startStream();
      if (g.id && (g.status === "created" || g.status === "ready")) nudgeWhenStreaming(g.id, 3);
      noteStreamStart();          // this is a new broadcast → new latency read
    } else {
      await obs.stopStream();
      obsHoldAt = Date.now();     // only hold once OBS has confirmed the stop
    }
    obsActionError = null;
    broadcast("state", publicState());
    return { ok: true, state: publicState() };
  } catch (e) {
    obsActionError = e.message;
    broadcast("state", publicState());
    return { ok: false, error: e.message, state: publicState() };
  }
}

/**
 * Make sure a broadcast exists and is bound to the stream key before OBS is
 * told to push.
 *
 * This is the failure the timer kept hitting: the encoder sent video to the
 * stream key while YouTube had no broadcast bound to it, so the channel showed
 * no live video and nothing was recorded. Going live is now: reuse the
 * broadcast this app created (already on air, or created/ready and waiting for
 * the encoder), bind it again if the bind was lost, and only create a new one
 * when the Live API genuinely has nothing. No search call anywhere in here.
 */
let ensuring = null;

async function ensureBroadcast() {
  if (!ytOAuth.hasToken()) {
    return { ok: false, error: "youtube is not authorized — open /oauth/start" };
  }
  if (ensuring) return ensuring;

  ensuring = (async () => {
    const b = await ytLive.resolveBroadcast();
    const st = String((b && b.status && b.status.lifeCycleStatus) || "");

    if (b && b.id) {
      adoptVideo(b.id);
      const streamId = await ytLive.streamId().catch(() => null);
      let bound = !!(b.contentDetails && b.contentDetails.boundStreamId);
      if (!bound && streamId) {
        // A created broadcast with no stream bound never goes live, however
        // healthy the encoder looks. Bind it to the key OBS already uses.
        await ytLive.bind(b.id, streamId);
        bound = true;
        console.log(`[yt-live] bound ${b.id} to stream ${streamId}`);
      }
      noteOnAir(b.id, st === "live" || st === "liveStarting", st || "unknown");
      save();
      broadcast("state", publicState());
      if (st === "created" || st === "ready") nudgeWhenStreaming(b.id);
      return { ok: true, id: b.id, reused: true, bound, status: st };
    }

    // Nothing usable: create this run's broadcast, bind it, and let the switch
    // own OBS from here (it stops and restarts the encoder against the new
    // broadcast).
    const r = startSwitch("ultraLow");
    if (!r.ok) return r;
    return { ok: true, creating: true, id: null, reused: false };
  })().finally(() => {
    ensuring = null;
  });

  return ensuring;
}

/**
 * enableAutoStart fires when the ingest session becomes active. A broadcast
 * bound after OBS was already pushing never gets that event, so the transition
 * is nudged a few times in the background — the same fix waitForLive uses.
 */
function nudgeWhenStreaming(id, tries = 6) {
  (async () => {
    for (let i = 0; i < tries; i++) {
      await pause(5000);
      try {
        if (!obs.streaming) return;
        if ((await ytLive.streamStatus()) !== "active") continue;
        await ytLive.goLive(id);
        const b = await ytLive.broadcast(id);
        const s = b && b.status ? b.status.lifeCycleStatus : null;
        console.log(`[yt-live] nudge ${id} → ${s || "?"}`);
        if (s === "live" || s === "liveStarting") {
          noteOnAir(id, true, "live");
          broadcast("state", publicState());
          return;
        }
      } catch (e) {
        console.log(`[yt-live] nudge ${id}: ${e.message}`);
      }
    }
  })();
}

/**
 * The actual "start at 21:30, stop when the clock is up" logic.
 *   - clock running and time left  → stream on
 *   - clock at/below zero          → stream off
 *   - a late boost back above zero → stream on again (same rule, no special case)
 */
async function streamTick() {
  if (!config.obs.enabled || !obs.authenticated) return;
  if (Date.now() - lastObsAttempt < 15000) return;

  const started = !!state.startedAt;
  const rem = remainingMs();

  try {
    if (started && rem > 0 && !obs.streaming && !obsHoldActive() && config.obs.autoStart) {
      lastObsAttempt = Date.now();
      // The scheduled start follows the same rule as GO LIVE: bind a broadcast
      // first, or the encoder pushes into nothing.
      const g = ytOAuth.hasToken()
        ? await ensureBroadcast().catch((e) => ({ ok: false, error: e.message }))
        : { ok: false, error: "youtube is not authorized" };
      if (g.creating) {
        obsActionError = null;
        broadcast("state", publicState());
        return;
      }
      await obs.startStream();
      if (g.id && (g.status === "created" || g.status === "ready")) nudgeWhenStreaming(g.id, 3);
      obsActionError = null;
      noteStreamStart();
      broadcast("state", publicState());
    } else if (started && rem <= 0 && obs.streaming && config.obs.autoStop) {
      lastObsAttempt = Date.now();
      await obs.stopStream();
      obsActionError = null;
      broadcast("state", publicState());
    }
  } catch (e) {
    lastObsAttempt = Date.now();
    obsActionError = e.message;
    broadcast("state", publicState());
    console.warn("[obs] stream tick failed:", e.message);
  }
}

/* ------------------------------------------------------------ stream health */

/**
 * One GetStreamStatus poll every 3 s while OBS is connected. Skipped frames and
 * reconnects are what decide whether ultra-low latency will hold up on this
 * link: ultra-low leaves YouTube no buffer to hide an unstable encoder feed.
 *
 * The numbers are pushed to the browsers only when they visibly change, so a
 * steady stream does not re-send the whole state four times a minute.
 */
async function pollObsHealth() {
  if (!config.obs.enabled || !obs.authenticated) {
    if (obsHealth) {
      obsHealth = null;
      obsHealthSig = "";
      broadcast("state", publicState());
    }
    return;
  }
  const h = await obs.statusHealth();
  if (!h) return;
  obsHealth = {
    at: h.at,
    ok: !!h.ok,
    bitrateKbps: h.bitrateKbps,
    skipped: h.skipped,
    total: h.total,
    skippedPct: Math.round(h.skippedPct * 100) / 100,
    congestion: h.congestion,
    reconnecting: !!h.reconnecting,
    reconnects: h.reconnects,
    durationMs: h.durationMs,
    error: h.error || null,
  };
  const sig = [
    obsHealth.ok ? 1 : 0,
    obsHealth.bitrateKbps == null ? "-" : Math.round(obsHealth.bitrateKbps / 10),
    obsHealth.skipped,
    obsHealth.reconnects,
    obsHealth.reconnecting ? 1 : 0,
    obsHealth.error || "",
  ].join("|");
  if (sig !== obsHealthSig) {
    obsHealthSig = sig;
    broadcast("state", publicState());
  }
}

function resetAll() {
  const keepStart = state.startAt;
  // Ko-fi retries until it gets a 200, so a retried delivery must not be
  // applied a second time just because the clock was reset in between.
  const seenKofi = state.seenKofi.slice(-200);
  state = freshState();
  state.startAt = keepStart;
  state.seenKofi = seenKofi;
  const due = new Date(keepStart).getTime();
  state.startedAt = Date.now() >= due ? Date.now() : null;
  obsActionError = null;
  save();
  broadcast("state", publicState());
  return { ok: true, state: publicState() };
}

function setStartAt(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(String(value || ""))) {
    return { ok: false, error: "expected YYYY-MM-DDTHH:MM" };
  }
  state.startAt = value;
  if (!state.startedAt) autoStartIfDue();
  save();
  broadcast("state", publicState());
  return { ok: true, state: publicState() };
}

/* --------------------------------------------------------------------- SSE */

const clients = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

function sse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);

  const beat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(beat);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(beat);
    clients.delete(res);
  });
}

/* ---------------------------------------------------------- ko-fi webhook */

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function kofiWebhook(req, res) {
  let payload;
  try {
    const body = await readBody(req);
    // Ko-fi posts application/x-www-form-urlencoded with a single "data" field
    // holding a JSON string.
    const params = new URLSearchParams(body);
    const raw = params.get("data");
    if (!raw) throw new Error("missing data field");
    payload = JSON.parse(raw);
  } catch (e) {
    console.warn("[kofi] bad webhook:", e.message);
    return json(res, { ok: false, error: "bad payload" }, 400);
  }

  const expected = config.kofi.verificationToken;
  if (!expected) {
    // Fail closed: without the shared secret anyone who learns the tunnel URL
    // could post fake tips and inflate the clock. Refuse before touching state.
    console.warn(
      "[kofi] REFUSED: kofi.verificationToken is not set in config.json — paste the Verification Token from " +
        "ko-fi.com/manage/webhooks → Advanced, then restart the server"
    );
    return json(
      res,
      {
        ok: false,
        error: "webhook disabled: kofi.verificationToken is not configured on this server",
      },
      401
    );
  }
  if (String(payload.verification_token || "") !== expected) {
    console.warn("[kofi] rejected: verification token mismatch");
    return json(res, { ok: false, error: "bad token" }, 401);
  }

  const id = String(payload.message_id || payload.kofi_transaction_id || "");
  if (id && state.seenKofi.includes(id)) {
    console.log(`[kofi] duplicate ${id} ignored`);
    return json(res, { ok: true, duplicate: true });
  }
  if (id) {
    state.seenKofi.push(id);
    if (state.seenKofi.length > 500) state.seenKofi = state.seenKofi.slice(-500);
  }

  const kofiType = String(payload.type || "Donation");
  // Private tips must not leak onto the stream: Ko-fi sends is_public:false
  // when the supporter chose not to show their support publicly.
  const isPublic = payload.is_public !== false;
  const name = isPublic ? String(payload.from_name || "Anonymous") : "Anonymous";
  const amount = payload.amount;
  const currency = String(payload.currency || "");
  const amountText = amount ? `${amount} ${currency}`.trim() : "";

  state.kofi.hits = (state.kofi.hits || 0) + 1;
  state.kofi.lastHitAt = Date.now();
  state.kofi.lastEvent = { type: kofiType, name, amountText, at: Date.now() };

  // Donations and new memberships buy time; shop orders / commissions are
  // logged but do not extend the clock.
  const paysTime = kofiType === "Donation" || kofiType === "Subscription";
  if (paysTime) {
    applyBoost("kofi", {
      source: "kofi",
      name,
      message: isPublic ? String(payload.message || "").slice(0, 240) : "",
      amountText,
    });
  } else {
    save();
    broadcast("state", publicState());
    console.log(`[kofi] ${kofiType} from ${name} logged (no time added)`);
  }

  return json(res, { ok: true });
}

/* ------------------------------------------------------- youtube polling */

const YT = process.env.YT_BASE_URL || "https://www.googleapis.com/youtube/v3/";
let ytPolling = false; // the interval and SYNC YT NOW must never overlap

async function ytGet(pathAndQuery) {
  const url = YT + pathAndQuery + (pathAndQuery.includes("?") ? "&" : "?") + "key=" + config.youtube.apiKey;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = body?.error?.message || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function resolveChannel() {
  if (state.yt.channelId) return state.yt.channelId;
  const data = await ytGet(
    `channels?part=statistics,snippet&forHandle=${encodeURIComponent(config.youtube.handle)}`
  );
  const ch = data.items && data.items[0];
  if (!ch) throw new Error(`channel @${config.youtube.handle} not found`);
  state.yt.channelId = ch.id;
  save();
  console.log(`[yt] channel resolved: ${ch.snippet?.title} (${ch.id})`);
  return ch.id;
}

async function findLiveVideo(channelId) {
  // search.list lives in its own 100 calls/day bucket; we cap ourselves well
  // under it because a missing live video is the normal pre-stream state.
  const day = todayKey();
  if (state.yt.lookupDay !== day) {
    state.yt.lookupDay = day;
    state.yt.lookupsToday = 0;
  }
  if (state.yt.lookupsToday >= 60) {
    // The search bucket is spent for today. This is no longer a failure: the
    // Live API path (resolveLiveVideo) covers every broadcast this app creates,
    // so the timer keeps following the stream with no search at all. Search is
    // only ever the last resort for a stream started somewhere else.
    console.warn("[yt] search auto-detect paused for today (quota) — Live API only");
    return null;
  }
  if (Date.now() < (state.yt.nextVideoLookup || 0)) return null;
  state.yt.nextVideoLookup = Date.now() + 60000;
  state.yt.lookupsToday += 1;

  const data = await ytGet(
    `search?part=id&type=video&eventType=live&maxResults=1&channelId=${encodeURIComponent(channelId)}`
  );
  const item = data.items && data.items[0];
  if (!item) return null;
  state.yt.videoId = item.id.videoId;
  state.yt.lastLikes = null; // new video → new like baseline
  state.yt.likePeak = null;
  save();
  console.log(`[yt] live video found: ${state.yt.videoId}`);
  return state.yt.videoId;
}

/* --------------------------------------------- subscriber count ledger */

/** Records one source's health for /api/state and the dashboard. */
function noteSubSource(id, patch = {}) {
  const prev = (state.yt.subSources && state.yt.subSources[id]) || {};
  state.yt.subSources = {
    ...(state.yt.subSources || {}),
    [id]: {
      ok: !!patch.ok,
      count: patch.count !== undefined && patch.count !== null ? patch.count : prev.count ?? null,
      error: patch.ok ? null : patch.error || "failed",
      exact: !!patch.exact,
      at: Date.now(),
      polls: (prev.polls || 0) + 1,
      fails: patch.ok ? 0 : (prev.fails || 0) + 1,
    },
  };
}

/**
 * One shared high-water mark for every subscriber source.
 *
 * YouTube only publishes a rounded total (three significant figures), so one
 * subscriber often does not move it at all. socialcounts.org and YouTube's own
 * channel page are polled as well, and the earliest of them to see the number
 * move pays for it; the others then find nothing left to pay — one subscriber,
 * one bonus, no matter how many sources are watching.
 *
 * OAuth credits each subscriber by name, so by the time a count moves those
 * people are usually already paid for. Those name credits are subtracted here:
 * nothing is paid twice, and if the by-name feed missed somebody (a burst
 * bigger than the 50 YouTube lists) the difference still pays, so no sub is
 * ever silently lost.
 */
function creditSubs(count, label = "count") {
  const best = Number(count);
  if (!Number.isFinite(best) || best <= 0) return 0;
  if (state.yt.subPeak == null) {
    state.yt.subPeak = best; // first reading = baseline, pays nothing
    return 0;
  }
  if (best <= state.yt.subPeak) return 0;

  const rejectJump = Number((config.youtube.subCount && config.youtube.subCount.rejectJump) || 500);
  if (best - state.yt.subPeak > rejectJump) {
    console.warn(`[yt-subs] ignoring ${label} reading ${best}: ${best - state.yt.subPeak} above the peak looks wrong`);
    return 0;
  }

  const expected = Math.min(best - state.yt.subPeak, 100);
  state.yt.subPeak = best;

  // Names credited since the previous reading are already paid for and are the
  // part of this rise the count sources must not pay again. Advancing the mark
  // covers every name seen so far: the next rise subtracts only the newer ones,
  // so a sub is paid once whether the count or the feed saw it first.
  const paidByName = Math.max(0, (state.yt.nameCredits || 0) - (state.yt.nameMark || 0));
  state.yt.nameMark = state.yt.nameCredits || 0;
  const owed = Math.max(0, expected - paidByName);
  if (owed > 0) {
    for (let i = 0; i < owed; i++) {
      applyBoost("sub", {
        source: "youtube",
        name: `${owed > 1 ? `${owed} new subs` : "New subscriber"} · ${label}`,
      });
    }
    console.log(`[yt-subs] ${owed} credited from the ${label} count (peak ${state.yt.subPeak}, ${paidByName} already paid by name)`);
  }
  return owed;
}

/** "1.17K" + "K" → 1170; "1,170" → 1170. */
function parseCompactCount(digits, suffix) {
  const n = Number(String(digits).replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[String(suffix || "").toUpperCase()] || 1;
  return Math.round(n * mult);
}

/* ------------------------------ youtube's own channel page (no API key) */

let pagePolling = false;
// Overridable so the fallback can be exercised against a local stub.
const YT_PAGE_URL =
  process.env.YT_PAGE_URL ||
  "https://www.youtube.com/youtubei/v1/browse?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

/**
 * The same endpoint youtube.com itself calls, so no key, no OAuth and no quota:
 * the fallback that keeps the count moving when the Data API key is missing,
 * revoked or out of quota. The figure is rounded exactly like the Data API's,
 * which is why it feeds the same peak as everything else.
 */
async function pollYouTubePage(reason = "interval") {
  if (pagePolling) return { ok: false, skipped: "busy" };
  if (config.youtube.subCount && config.youtube.subCount.innertube === false) {
    return { ok: false, skipped: "disabled in config.json" };
  }
  const channelId = (config.youtube.socialcounts && config.youtube.socialcounts.channelId) || state.yt.channelId;
  if (!channelId) return { ok: false, skipped: "no channel id yet" };
  pagePolling = true;

  try {
    const r = await fetch(YT_PAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
        "Accept-Language": "en",
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "en" } },
        browseId: channelId,
        params: "EgVhYm91dPIGBAoCEgA%3D",
      }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`youtube page returned ${r.status}`);
    // Matches "1.17K subscribers" anywhere in the payload; the string arrives
    // JSON-escaped, so nothing may be anchored on the surrounding quotes.
    const m = /([0-9][0-9.,]*)\s*([KMB]?)\s+subscribers?/i.exec(text);
    if (!m) throw new Error("no subscriber count on YouTube's page");
    const count = parseCompactCount(m[1], m[2]);
    if (!Number.isFinite(count) || count <= 0) throw new Error("could not read YouTube's subscriber count");

    noteSubSource("youtube-page", { ok: true, count });
    if (count > (state.yt.lastSubs || 0)) state.yt.lastSubs = count;
    const owed = creditSubs(count, "youtube page");
    save();
    if (reason !== "interval" || owed) broadcast("state", publicState());
    return { ok: true, count, credited: owed };
  } catch (e) {
    noteSubSource("youtube-page", { ok: false, error: e.message });
    save();
    throw e;
  } finally {
    pagePolling = false;
  }
}

/**
 * Remembers which video the timer is following.
 *
 * The broadcast id the app creates lives here and in state.json, so a restart,
 * a failed search or an exhausted search quota cannot lose it. No search call
 * is involved in following it.
 */
function adoptVideo(id) {
  if (!id || state.yt.videoId === id) return id;
  state.yt.videoId = id;
  state.yt.lastLikes = null;   // new video → new like baseline
  state.yt.likePeak = null;
  save();
  console.log(`[yt] following broadcast ${id}`);
  return id;
}

/** Records what YouTube says is on air; the dashboard renders it verbatim. */
function noteOnAir(id, live, status) {
  state.yt.onAir = {
    id: id || null,
    live: !!live,
    status: status || (live ? "live" : "none"),
    at: Date.now(),
  };
}

/**
 * The video id, without leaning on search.
 *
 * The Live API lists the broadcast this app made (one cheap call, none of the
 * search bucket) and state keeps its id across restarts, so that is always
 * asked first. search.list stays only for a stream this app did not start; when
 * its 100-a-day bucket is spent the poll carries on instead of going red.
 */
async function resolveLiveVideo(channelId) {
  let b = null;
  try {
    b = await ytLive.resolveBroadcast();
  } catch (e) {
    console.warn("[yt] live api broadcast lookup failed:", e.message);
  }
  if (b && b.id) {
    adoptVideo(b.id);
    return b.id;
  }
  if (!config.youtube.autoDetectLive) return null;
  return findLiveVideo(channelId);
}

async function pollYouTube(reason = "timer") {
  const yt = config.youtube;
  if (!yt.apiKey) return { ok: false, skipped: "youtube not configured" };
  if (yt.apiKey.length < 20) return { ok: false, skipped: "youtube api key looks wrong" };
  if (ytPolling) return { ok: false, skipped: "a poll is already running" };
  ytPolling = true;

  try {
    const channelId = await resolveChannel();

    // 1. subscriber count (rounded to 3 significant figures by YouTube)
    const ch = await ytGet(`channels?part=statistics&id=${encodeURIComponent(channelId)}`);
    const stats = ch.items && ch.items[0] && ch.items[0].statistics;
    if (!stats) throw new Error("no statistics in channel response");

    state.yt.hiddenSubs = !!stats.hiddenSubscriberCount;
    if (!state.yt.hiddenSubs && stats.subscriberCount != null) {
      const subs = Number(stats.subscriberCount);
      state.yt.lastSubs = subs; // display value, may go down
      state.yt.subsMode = ytOAuth.hasToken() ? "oauth" : "count";
      noteSubSource("youtube-api", { ok: true, count: subs });
      // Rounded to three significant figures, so this source sees a sub only
      // when the rounding step lands; socialcounts and the page poll cover in
      // between. One shared peak, so the same sub is paid exactly once.
      creditSubs(subs, "youtube api");
    } else if (state.yt.hiddenSubs) {
      noteSubSource("youtube-api", { ok: true, count: state.yt.lastSubs, exact: false });
    }

    // 2. likes on the live video
    let videoId = yt.videoId || state.yt.videoId;
    if (!videoId && yt.autoDetectLive) {
      try {
        videoId = await resolveLiveVideo(channelId);
      } catch (e) {
        // Subscribers are already credited above: a missing live video must not
        // turn the whole poll red, and the on-air line below still reports it.
        console.warn("[yt] no live video to follow:", e.message);
      }
    }
    if (videoId) {
      const v = await ytGet(
        `videos?part=snippet,statistics,liveStreamingDetails&id=${encodeURIComponent(videoId)}`
      );
      const item = v.items && v.items[0];
      if (item) {
        if (state.yt.videoId !== videoId) {
          state.yt.videoId = videoId;
          state.yt.lastLikes = null;
          state.yt.likePeak = null;
        }
        const likes = Number(item.statistics?.likeCount ?? NaN);
        if (!isNaN(likes)) {
          // Same high-water rule as subs: unliking lowers the displayed count
          // but never the peak, so unlike → re-like can not mint time twice.
          if (state.yt.lastLikes == null || state.yt.likePeak == null) {
            state.yt.lastLikes = likes;
            state.yt.likePeak = likes;
          } else {
            state.yt.lastLikes = likes;
            if (likes > state.yt.likePeak) {
              const gained = Math.min(likes - state.yt.likePeak, 300);
              state.yt.likePeak = likes;
              for (let i = 0; i < gained; i++) {
                applyBoost("like", { source: "youtube", name: `${gained > 1 ? `${gained} new likes` : "New like"}` });
              }
            }
          }
        }
        // "live" comes from YouTube itself, so a broadcast that is only
        // scheduled, or bound but waiting for the encoder, is never mistaken
        // for a running stream.
        const airNow = item.snippet ? item.snippet.liveBroadcastContent : null;
        noteOnAir(videoId, airNow === "live", airNow || "unknown");

        const lsd = item.liveStreamingDetails;
        if (lsd && lsd.actualEndTime) {
          console.log("[yt] stream ended — clearing video id");
          state.yt.videoId = null;
          state.yt.lastLikes = null;
          state.yt.likePeak = null;
          noteOnAir(videoId, false, "none");
        }
      } else if (state.yt.videoId) {
        console.warn("[yt] video not found — clearing cached id");
        state.yt.videoId = null;
        state.yt.lastLikes = null;
        state.yt.likePeak = null;
        noteOnAir(null, false, "none");
      }
    } else {
      // Nothing to follow and nothing found. This is exactly the state where
      // OBS pushes video while youtube.com shows no live broadcast at all.
      noteOnAir(null, false, "none");
    }

    state.yt.lastError = null;
    state.yt.lastCheck = Date.now();
    save();
    broadcast("state", publicState());
    return { ok: true, state: publicState() };
  } catch (e) {
    state.yt.lastError = e.message;
    state.yt.lastCheck = Date.now();
    noteSubSource("youtube-api", { ok: false, error: e.message });
    save();
    broadcast("state", publicState());
    console.warn(`[yt] poll failed (${reason}):`, e.message);
    return { ok: false, error: e.message };
  } finally {
    ytPolling = false;
  }
}

/* --------------------------------------------------------------- live chat */

let chatPolling = false; // a slow chat poll must never overlap the next one

/**
 * Reads liveChatMessages.list and rebroadcasts every message as a "chat" SSE
 * event ({ kind, author, text, owner, member, at }). The page token makes this
 * lossless: the next call returns everything posted since the last one, so a
 * slow poll only adds latency instead of dropping messages.
 */
async function pollLiveChat(reason = "interval") {
  if (!config.youtube.chat?.enabled) return { ok: false, skipped: "chat disabled" };
  if (chatPolling) return { ok: false, skipped: "a chat poll is already running" };

  const videoId = state.yt.videoId;
  if (!videoId) {
    state.chat.videoId = null;
    state.chat.liveChatId = null;
    state.chat.pageToken = null;
    return { ok: false, skipped: "not live" };
  }

  chatPolling = true;

  try {
    const now = Date.now();
    const stale = state.chat.videoId !== videoId || !state.chat.liveChatId;
    // One lookup per video, retried at most once a minute while the chat does
    // not exist yet (the chat id only shows up once the broadcast is live).
    if (stale && (state.chat.videoId !== videoId || now - (state.chat.lookupAt || 0) > 60000)) {
      const v = await ytGet(`videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}`);
      const lsd = v.items?.[0]?.liveStreamingDetails;
      state.chat.videoId = videoId;
      state.chat.liveChatId = lsd?.activeLiveChatId || null;
      state.chat.pageToken = null;
      state.chat.lookupAt = now;
      state.chat.messages = 0;
      if (!state.chat.liveChatId) {
        state.chat.error = "no active live chat on this video";
        return { ok: false, error: state.chat.error };
      }
    }

    if (!state.chat.liveChatId) {
      return { ok: false, skipped: "no active live chat" };
    }

    const token = ytOAuth.hasToken() ? await ytOAuth.getAccessToken() : null;
    let url =
      `${YT}liveChatMessages?liveChatId=${encodeURIComponent(state.chat.liveChatId)}` +
      `&part=snippet,authorDetails&maxResults=200&hl=en`;
    if (state.chat.pageToken) url += `&pageToken=${encodeURIComponent(state.chat.pageToken)}`;
    if (!token) url += `&key=${config.youtube.apiKey}`;

    const r = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `liveChatMessages returned ${r.status}`);

    let sent = 0;
    for (const item of data.items || []) {
      const snippet = item.snippet || {};
      // Deleted/removed messages and the non-message live chat events carry no text.
      const text = String(snippet.displayMessage || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      broadcast("chat", {
        kind: "chat",
        author: item.authorDetails?.displayName || "viewer",
        text: text.slice(0, 300),
        owner: !!item.authorDetails?.isChatOwner,
        member: !!item.authorDetails?.isChatSponsor,
        at: Date.now(),
      });
      sent++;
    }

    state.chat.pageToken = data.nextPageToken || state.chat.pageToken;
    state.chat.lastAt = Date.now();
    state.chat.messages = (state.chat.messages || 0) + sent;
    state.chat.error = null;
    return { ok: true, messages: sent };
  } catch (e) {
    state.chat.error = e.message;
    // A closed chat (stream ended) must be looked up again, a transient error only retried.
    if (/ended|closed|forbidden|not found/i.test(e.message)) {
      state.chat.liveChatId = null;
      state.chat.lookupAt = 0;
    }
    state.chat.pageToken = null;
    console.warn(`[yt-chat] poll failed (${reason}):`, e.message);
    return { ok: false, error: e.message };
  } finally {
    chatPolling = false;
  }
}

/* ------------------------------------------ broadcast latency (youtube) */

/**
 * YouTube fixes a broadcast's latency class (Normal / Low / Ultra-low) when the
 * broadcast starts, and nothing in OBS can change it afterwards. The only
 * honest confirmation is what youtube.com says about the live video, so every
 * stream start reads the channel's live page and stores the class — the
 * dashboard then shows whether THIS broadcast came up Ultra-low.
 *
 * One read chain per broadcast: starting bumps `latencyToken`, which cancels
 * the pending timer and makes any read still in flight from the previous
 * broadcast a no-op, so a fast stop→start can never record the old class.
 */
const YT_LIVE_PAGE = `https://www.youtube.com/@${encodeURIComponent(config.youtube.handle)}/live`;

/** The broadcast that is live right now, for the /live alias and the dashboard. */
function currentLiveUrl() {
  const yt = state.yt || {};
  const id = yt.videoId || (yt.latency && yt.latency.videoId) || "";
  return id ? `https://www.youtube.com/live/${id}` : YT_LIVE_PAGE;
}
const LATENCY_FIRST_MS = 10000;
const LATENCY_WATCHDOG_MS = 10 * 60 * 1000;

let latencyToken = 0;            // bumped per start/stop; older reads are dropped
let latencyTimer = null;         // pending read for the current broadcast
let latencySeenStreaming = null; // null until the first watch tick

/** One live-page read → the latency class and the broadcast it belongs to. */
async function fetchLatencyClass() {
  const r = await fetch(YT_LIVE_PAGE, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept-Language": "en",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`youtube live page returned ${r.status}`);
  const html = await r.text();
  const cls = /"latencyClass":"MDE_STREAM_OPTIMIZATIONS_RENDERER_LATENCY_(ULTRA_LOW|LOW|NORMAL)"/.exec(html);
  if (!cls) throw new Error("no latency class on the live page (not live yet?)");
  // A page that is no longer live is the previous broadcast (or none at all),
  // never this one, so its class must not be recorded.
  const live = /"isLiveNow":(true|false)/.exec(html);
  if (live && live[1] === "false") throw new Error("youtube is not live yet");
  const vid = /"videoDetails":\{"videoId":"([A-Za-z0-9_-]{11})"/.exec(html);
  return { class: cls[1], videoId: vid ? vid[1] : null };
}

function recordLatency(patch) {
  // These five fields are the whole record: a failed read keeps the class and
  // only sets `error`, and the next start clears both.
  const cur = state.yt.latency || {};
  state.yt.latency = {
    class: cur.class,
    videoId: cur.videoId,
    at: cur.at,
    startedAt: cur.startedAt,
    error: null,
    ...patch,
  };
  save();
  broadcast("state", publicState());
}

function cancelLatencyRead() {
  latencyToken += 1;
  clearTimeout(latencyTimer);
  latencyTimer = null;
}

/** (Re)start the read chain; the token keeps it tied to the current broadcast. */
function scheduleLatencyRead(ms) {
  cancelLatencyRead();
  const token = latencyToken;
  latencyTimer = setTimeout(() => readLatency(token, 0), ms);
}

/** Read the live page for the broadcast that started under `token`. */
async function readLatency(token, failures = 0) {
  let found = null;
  let error = null;
  try {
    found = await fetchLatencyClass();
  } catch (e) {
    error = e.message;
  }
  if (token !== latencyToken) return; // a newer start owns the record now
  if (found) {
    recordLatency({ ...found, at: Date.now(), error: null });
    console.log(`[latency] youtube reports ${found.class} for ${found.videoId || "the live video"}`);
    autoAfterRead();
    return; // the class is fixed for this broadcast — no more reads
  }
  recordLatency({ error });
  // 20s, 40s, 80s, 160s, 320s, then a 10-minute watchdog while still live.
  const failed = failures + 1;
  const wait = failed < 6 ? LATENCY_FIRST_MS * 2 ** failed : LATENCY_WATCHDOG_MS;
  latencyTimer = setTimeout(() => readLatency(token, failed), wait);
  console.warn(`[latency] read failed: ${error} (retry in ${Math.round(wait / 1000)}s)`);
}

/**
 * A new broadcast: forget the previous class and schedule the first read.
 * Called from the start request itself and from OBS's false→true edge, so a
 * restart shorter than one watch tick is still caught.
 */
function noteStreamStart() {
  state.yt.latency = { class: null, videoId: null, at: null, startedAt: Date.now(), error: null };
  latencySeenStreaming = true;
  // New broadcast, new session: skipped-frame and reconnect counters start over
  // so the health line always describes the stream that is on air.
  obs.resetHealth();
  obsHealthSig = "";
  save();
  broadcast("state", publicState());
  scheduleLatencyRead(LATENCY_FIRST_MS);
  console.log("[latency] stream started — reading YouTube's latency class");
  // Re-post the pinned note in the fresh chat, so it is there from the first
  // seconds. The pin itself is Studio-only; the chat needs a moment to exist.
  const pin = state.yt.pin || {};
  if (pin.auto && pin.text) {
    setTimeout(() => {
      postPinMessage(pin.text)
        .then((r) => console.log("[yt-live] auto pin note:", r.ok ? "posted " + (r.id || "") : r.error))
        .catch((e) => console.warn("[yt-live] auto pin note failed:", e.message));
    }, 10000);
  }
}

/**
 * OBS's stream state is the start signal the timer does not issue itself (the
 * stream was started by hand in OBS). Stopping cancels a pending read; nothing
 * here ever touches the stream.
 */
function watchLatency() {
  const streaming = !!obs.streaming;
  if (latencySeenStreaming === null) {
    latencySeenStreaming = streaming;
    // The server came up mid-broadcast: read once unless a fresh class exists.
    const cur = state.yt.latency || {};
    if (streaming && (!cur.at || Date.now() - cur.at > 5 * 60 * 1000)) scheduleLatencyRead(5000);
    return;
  }
  if (streaming === latencySeenStreaming) return;
  latencySeenStreaming = streaming;
  if (streaming) noteStreamStart();
  else cancelLatencyRead();
}

/* ----------------------------------- latency switch (end + recreate) */

/**
 * Move the channel onto a different latency class without touching Studio.
 *
 * YouTube fixes a broadcast's class when it is created and refuses to change
 * it while live, so a switch is always the same four steps: end the running
 * broadcast, insert a new one with the class we want, bind it to the same
 * stream key (OBS keeps its key), and let it go live. That is ~30 s of work,
 * so it runs in the background and publishes its step in state.yt.switch —
 * both remotes render it on the latency card.
 */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let switchRunning = false;

function setSwitch(patch) {
  state.yt.switch = { at: Date.now(), ...(state.yt.switch || {}), ...patch };
  save();
  broadcast("state", publicState());
}

async function runSwitch(pref, opts = {}) {
  setSwitch({ step: "ending", error: null, ok: null, done: false });
  const old = await ytLive.activeBroadcast();
  if (old) {
    await ytLive.endBroadcast(old.id);
    if (!(await ytLive.waitGone(old.id))) {
      throw new Error("the running broadcast did not end — nothing new was created");
    }
  }

  setSwitch({ step: "creating", oldVideoId: old ? old.id : null });
  const meta = state.yt.meta || {};
  const made = await ytLive.createBroadcast({
    latency: pref,
    // An explicit title wins, then the title saved from the app: the "old"
    // broadcast can be a leftover YouTube auto-created one whose title has
    // nothing to do with this run.
    title: opts.title || meta.title || (old && old.snippet ? old.snippet.title : undefined),
    description: meta.description != null ? meta.description : (old && old.snippet ? old.snippet.description : undefined),
    privacyStatus: (old && old.status && old.status.privacyStatus) || "public",
    categoryId: old && old.snippet ? old.snippet.categoryId : undefined,
  });
  if (!made || !made.id) throw new Error("youtube returned no broadcast id");
  state.yt.videoId = made.id;

  setSwitch({ step: "binding", videoId: made.id });
  const streamId = await ytLive.streamId();
  await ytLive.bind(made.id, streamId);

  // enableAutoStart fires when the encoder's stream goes active, so give it a
  // fresh session: OBS's own reconnect can take a while, and a broadcast bound
  // to an already-active stream may never auto-start.
  setSwitch({ step: "going-live", videoId: made.id });
  // The broadcast is already made and bound at this point, so a sick encoder
  // must not abort the switch: log the bounce failure and let the stream tick
  // (or the operator) bring OBS back on the new broadcast.
  try {
    if (config.obs.enabled && obs.authenticated && obs.streaming) {
      await obs.stopStream();
      const stopBy = Date.now() + 15000;
      while (obs.streaming && Date.now() < stopBy) await pause(500);
    }
    if (config.obs.enabled && obs.authenticated && !obs.streaming) {
      await obs.startStream();
    }
  } catch (e) {
    console.warn("[yt-live] OBS bounce failed (broadcast is still bound):", e.message);
  }
  obsHoldAt = 0;              // a switch never leaves the run held
  noteStreamStart();          // new broadcast → read its class from youtube
  recordLatency({ videoId: made.id });

  const live = await ytLive.waitForLive(made.id);
  const applied =
    (live && live.contentDetails && live.contentDetails.latencyPreference) || pref;
  setSwitch({ step: "done", done: true, ok: true, videoId: made.id, latency: applied });
  console.log(`[yt-live] ${made.id} is live with ${applied}`);
}

function startSwitch(latency, opts = {}) {
  const wanted = String(latency || "");
  const pref = ["ultraLow", "low", "normal"].includes(wanted) ? wanted : "ultraLow";
  if (!ytOAuth.configured()) {
    return {
      ok: false,
      error: "no oauth client — add youtube.oauth.clientId and clientSecret to config.json",
    };
  }
  if (!ytOAuth.hasToken()) return { ok: false, error: "youtube is not authorized — open /oauth/start" };
  if (switchRunning) return { ok: false, error: "a latency switch is already running" };

  switchRunning = true;
  state.yt.switch = {
    at: Date.now(),
    requested: pref,
    step: "starting",
    done: false,
    ok: null,
    error: null,
    videoId: null,
    auto: !!opts.auto,
  };
  save();
  broadcast("state", publicState());
  console.log(`[yt-live] switching the broadcast to ${pref}`);

  runSwitch(pref, opts)
    .catch((e) => {
      setSwitch({ step: "failed", done: true, ok: false, error: e.message });
      console.warn("[yt-live] switch failed:", e.message);
    })
    .finally(() => {
      switchRunning = false;
    });

  return { ok: true, started: true, latency: pref, state: publicState() };
}

/* ---------------------------------------------------------- auto ultra-low */

/**
 * After every GO LIVE the class is read anyway; this turns that reading into
 * an action. Enabled with one tap, it ends a broadcast that came up Normal (or
 * Low) and starts a new one with Ultra-low, up to AUTO_ULTRA_MAX times per
 * chain — see auto-ultra.js for why the cap exists.
 */
function saveAutoUltra(patch) {
  const cur = state.yt.autoUltra || {};
  state.yt.autoUltra = {
    enabled: false,
    attempts: 0,
    gaveUp: false,
    lastAt: null,
    lastClass: null,
    ...cur,
    ...patch,
  };
  save();
  broadcast("state", publicState());
}

function setAutoUltra(enabled) {
  const on = !!enabled;
  if (on && !ytOAuth.configured()) {
    return { ok: false, error: "no oauth client — add youtube.oauth to config.json first" };
  }
  if (on && !ytOAuth.hasToken()) {
    return { ok: false, error: "youtube is not authorized — open /oauth/start" };
  }
  saveAutoUltra({ enabled: on, attempts: 0, gaveUp: false, lastAt: Date.now() });
  console.log(`[auto-ultra] ${on ? "on" : "off"}`);
  return { ok: true, autoUltra: state.yt.autoUltra, state: publicState() };
}

function autoAfterRead() {
  const au = state.yt.autoUltra || {};
  const cls = (state.yt.latency || {}).class;
  const verdict = decideAutoUltra({
    enabled: !!au.enabled,
    cls,
    attempts: au.attempts || 0,
    gaveUp: !!au.gaveUp,
    switching: switchRunning,
  });
  switch (verdict.action) {
    case "switch":
      saveAutoUltra({ attempts: verdict.attempts, lastClass: cls, lastAt: Date.now() });
      console.log(
        `[auto-ultra] came up ${cls} — switching (attempt ${verdict.attempts}/${AUTO_ULTRA_MAX})`
      );
      startSwitch("ultraLow", { auto: true });
      break;
    case "giveup":
      saveAutoUltra({ gaveUp: true, lastClass: cls, lastAt: Date.now() });
      console.warn(
        `[auto-ultra] gave up after ${au.attempts} switch(es) — youtube keeps returning ${cls}; check Studio → Stream settings → Stream latency`
      );
      break;
    case "reset":
      saveAutoUltra({ attempts: 0, gaveUp: false, lastClass: cls, lastAt: Date.now() });
      break;
    case "gaveup-stop":
      saveAutoUltra({ lastClass: cls, lastAt: Date.now() });
      break;
    default:
      break;
  }
}

/* ------------------------------------------------- oauth subscriber feed */

let subsPolling = false;
// Overridable so the subscriber feed can be exercised against a local stub
// without the channel owner's Google credentials.
const YT_SUBS_URL =
  process.env.YT_SUBS_URL ||
  "https://www.googleapis.com/youtube/v3/subscriptions?part=subscriberSnippet&myRecentSubscribers=true&maxResults=50";

/**
 * Reads subscriptions.list?myRecentSubscribers=true (newest first) and credits
 * every subscriber channel id we have not seen before. The first call is a
 * baseline only: the ~50 people YouTube lists as "recent" subscribed before we
 * could see them, and paying them would invent hours out of nowhere.
 */
async function pollRecentSubs(reason = "interval") {
  if (!ytOAuth.configured()) return { ok: false, skipped: "no oauth client in config.json" };
  if (!ytOAuth.hasToken()) return { ok: false, skipped: "not authorized — open /oauth/start" };
  if (subsPolling) return { ok: false, skipped: "a subscriber poll is already running" };
  subsPolling = true;

  try {
    const token = await ytOAuth.getAccessToken();
    const r = await fetch(YT_SUBS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `subscriptions.list returned ${r.status}`);

    const items = Array.isArray(data.items) ? data.items : [];
    const seen = new Set(state.yt.seenSubs || []);
    const firstRun = seen.size === 0;
    let credited = 0;

    // Newest-first from the API; credit oldest-first so the alerts and the log
    // read in the order the subscriptions actually happened.
    for (const item of items.slice().reverse()) {
      const snip = item.subscriberSnippet || {};
      const id = snip.channelId || item.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (firstRun) continue; // baseline pass
      applyBoost("sub", { source: "youtube", name: snip.title || "New subscriber" });
      credited += 1;
    }

    const recovered = Boolean(state.yt.subsError);
    // Name credits are part of the ledger: the count sources subtract them so
    // the same subscriber is never paid a second time when the number moves.
    if (credited) state.yt.nameCredits = (state.yt.nameCredits || 0) + credited;
    state.yt.seenSubs = Array.from(seen).slice(-1000);
    state.yt.subsMode = "oauth";
    state.yt.lastSubsPoll = Date.now();
    state.yt.subsError = null;
    save();
    if (recovered) {
      // Same reasoning as the failure path: don't leave a red dashboard showing
      // for up to 15 s after the feed starts working again.
      console.log("[yt-subs] feed recovered");
      broadcast("state", publicState());
    }

    if (firstRun) {
      console.log(`[yt-subs] baseline recorded: ${state.yt.seenSubs.length} existing subscribers, nothing paid`);
    } else if (credited) {
      console.log(`[yt-subs] ${credited} new subscriber(s) credited (${reason})`);
      broadcast("state", publicState());
    }
    return { ok: true, newSubs: credited, seen: state.yt.seenSubs.length, firstRun };
  } catch (e) {
    state.yt.subsError = e.message;
    save();
    // Push the failure now: a 403 or a revoked token means subs are being
    // credited by nobody, and the dashboard must say so immediately instead of
    // waiting for the 15 s heartbeat.
    broadcast("state", publicState());
    throw e;
  } finally {
    subsPolling = false;
  }
}

/* ------------------------------------------ socialcounts live watchdog */

let scPolling = false;

/**
 * socialcounts.org answers with { counters: { estimation, api } }: YouTube's
 * own rounded total next to their live estimate, which moves before the 10-sub
 * rounding step does. Both numbers feed the SAME subPeak as the channels.list
 * poll, so whichever source sees a subscriber first pays for them and the
 * other then finds nothing left to pay — no path can credit one sub twice.
 */
async function pollSocialCounts(reason = "interval") {
  const sc = config.youtube.socialcounts;
  if (!sc.enabled || scPolling) return { ok: false, skipped: "disabled or busy" };
  const channelId = sc.channelId || state.yt.channelId;
  if (!channelId) return { ok: false, skipped: "no channel id yet" };
  scPolling = true;

  const url = `${process.env.YT_SC_URL || sc.baseUrl}/${encodeURIComponent(channelId)}`;
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`socialcounts returned ${r.status}`);

    const counters = data.counters || {};
    const est = Number(counters.estimation && counters.estimation.subscriberCount);
    const apiCount = Number(counters.api && counters.api.subscriberCount);
    if (!Number.isFinite(est) && !Number.isFinite(apiCount)) {
      throw new Error("socialcounts response carried no subscriber count");
    }

    const wasError = state.yt.scError;
    // The watchdog's first reading only lifts the peak to whatever it sees:
    // its live estimate can sit a whole rounding step above YouTube's stale
    // number, and paying that difference on install would hand out ~50 phantom
    // minutes. After this seed, every further rise in the estimate pays.
    const firstWatchdogReading = !state.yt.scLast;
    state.yt.scPolls = (state.yt.scPolls || 0) + 1;
    state.yt.scError = null;
    state.yt.scLast = {
      estimation: Number.isFinite(est) ? est : null,
      api: Number.isFinite(apiCount) ? apiCount : null,
      at: Date.now(),
    };

    // The finer number, but never below YouTube's own rounded floor.
    const best = Math.max(
      Number.isFinite(est) ? est : 0,
      Number.isFinite(apiCount) ? apiCount : 0
    );
    if (firstWatchdogReading || state.yt.subPeak == null) {
      state.yt.subPeak = Math.max(state.yt.subPeak || 0, best);
    } else {
      creditSubs(best, "socialcounts");
    }
    if (best > (state.yt.lastSubs || 0)) state.yt.lastSubs = best;
    noteSubSource("socialcounts", { ok: true, count: best, exact: true });
    save();

    if (wasError) {
      console.log("[sc] watchdog recovered");
      broadcast("state", publicState());
    } else if (best > 0 && reason === "startup") {
      console.log(`[sc] watchdog online · estimate ${state.yt.scLast.estimation} / api ${state.yt.scLast.api}`);
    }
    return { ok: true, estimation: state.yt.scLast.estimation, api: state.yt.scLast.api };
  } catch (e) {
    state.yt.scFails = (state.yt.scFails || 0) + 1;
    state.yt.scError = e.message;
    noteSubSource("socialcounts", { ok: false, error: e.message });
    save();
    // Same rule as the subscriber feed: show a dead watchdog immediately.
    broadcast("state", publicState());
    throw e;
  } finally {
    scPolling = false;
  }
}

/** Tiny standalone page for the OAuth redirect (never served from disk). */
function htmlPage(res, title, message) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    `<!DOCTYPE html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:15px/1.65 ui-monospace,SFMono-Regular,monospace;background:#0b0b10;color:#eee;padding:48px;max-width:660px;margin:auto">` +
      `<h1 style="font-size:19px;color:#ff2d55;margin-bottom:14px">${title}</h1>` +
      `<p style="color:#d8d8e0">${safe}</p>` +
      `<p style="color:#7a7a88;margin-top:26px">Emilli 24h timer</p></body>`
  );
}

/* ---------------------------------------------------- youtube uploads list */

// The channel's uploads playlist (UU… = UC… with the first two letters
// swapped) holds every public video they posted. playlistItems.list costs one
// quota unit per 50 videos, so the list is cached and only refetched when it is
// stale or a caller asks for ?refresh=1.
const YTPMVS_CACHE_MS = 15 * 60 * 1000;
const ytpmvs = { at: 0, channelId: null, videoIds: [], titles: [], error: null };
let ytpmvsBusy = false;

async function fetchUploads(force = false) {
  const channelId = state.yt.channelId || config.youtube.socialcounts.channelId;
  if (!channelId) throw new Error("channel not resolved yet");
  const fresh =
    ytpmvs.at && ytpmvs.channelId === channelId && Date.now() - ytpmvs.at < YTPMVS_CACHE_MS && ytpmvs.videoIds.length;
  if (!force && fresh) return ytpmvs;
  if (ytpmvsBusy) return ytpmvs;
  ytpmvsBusy = true;
  try {
    const playlistId = "UU" + String(channelId).slice(2);
    const videoIds = [];
    const titles = [];
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const data = await ytGet(
        `playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
      );
      for (const item of data.items || []) {
        const snip = item.snippet || {};
        const id = (item.contentDetails && item.contentDetails.videoId) || (snip.resourceId && snip.resourceId.videoId);
        if (!id) continue;
        const title = String(snip.title || "");
        if (/^(Deleted|Private) video$/.test(title)) continue;
        videoIds.push(id);
        titles.push(title);
      }
      pageToken = data.nextPageToken || "";
      if (!pageToken) break;
    }
    if (!videoIds.length) throw new Error("uploads playlist came back empty");

    // The uploads playlist also holds past livestreams and scheduled premieres.
    // A 12-hour VOD is not background music, and replaying the stream that is on
    // air right now would feed the stream into itself — so keep only uploads
    // that never went live and actually have a duration.
    const keep = new Set();
    for (let i = 0; i < videoIds.length; i += 50) {
      const data = await ytGet(
        `videos?part=contentDetails,liveStreamingDetails&id=${videoIds.slice(i, i + 50).join(",")}`
      );
      for (const v of data.items || []) {
        const dur = String((v.contentDetails || {}).duration || "");
        if (v.liveStreamingDetails) continue;   // was (or is) a livestream
        if (!dur || dur === "P0D") continue;   // upcoming / no duration yet
        keep.add(v.id);
      }
    }
    const skipIds = new Set(((config.youtube.ytpmvs && config.youtube.ytpmvs.excludeIds) || []).map(String));
    const skipTitles = ((config.youtube.ytpmvs && config.youtube.ytpmvs.excludeTitles) || [])
      .map((t) => String(t).toLowerCase().trim())
      .filter(Boolean);
    const allow = (id, i) =>
      keep.has(id) &&
      !skipIds.has(id) &&
      !skipTitles.some((t) => String(titles[i] || "").toLowerCase().includes(t));

    const finalIds = videoIds.filter((id, i) => allow(id, i));
    const finalTitles = titles.filter((_, i) => allow(videoIds[i], i));
    if (!finalIds.length) throw new Error("no non-live videos in the uploads list");

    ytpmvs.at = Date.now();
    ytpmvs.channelId = channelId;
    ytpmvs.videoIds = finalIds;
    ytpmvs.titles = finalTitles;
    ytpmvs.error = null;
    console.log(
      `[ytpmvs] ${finalIds.length} videos in the rotation (from ${videoIds.length} uploads, ${videoIds.length - keep.size} live/upcoming and ${keep.size - finalIds.length} excluded)`
    );
    return ytpmvs;
  } catch (e) {
    ytpmvs.error = e.message;
    // A stale list keeps the overlay playing instead of showing a black screen.
    if (!ytpmvs.videoIds.length) throw e;
    return ytpmvs;
  } finally {
    ytpmvsBusy = false;
  }
}

/* ------------------------------------------------------------ http server */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".apk": "application/vnd.android.package-archive",
  ".mp3": "audio/mpeg",
};

/* --------------------------------------------------------------- now playing */

// VLC's HTTP interface is polled once a second; the overlay smooths between
// polls. Nothing here is allowed to throw into the request path or the timers.
const vlcNow = { ok: false, state: "stopped", title: "", artist: "", album: "", positionMs: 0, lengthMs: 0, at: 0, error: null, source: null };
let vlcPolling = false;

// VLC can be asked what it plays in two ways:
//   1. its HTTP interface (--extraintf=http). Only there when VLC happened to
//      be started with that flag — opening a playlist from the file manager
//      starts it without one, and the interface silently disappears.
//   2. MPRIS over D-Bus, which VLC always exposes while running, no matter how
//      it was launched.
// HTTP is tried first (richer metadata), MPRIS is the fallback, so the overlay
// survives VLC being restarted any which way.

function cleanTrackName(fileName) {
  return String(fileName || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/^\s*\d{1,3}[\s._-]+/, "")   // "001 - Title Screen" → "Title Screen"
    .replace(/_/g, " ")
    .trim();
}

// Untagged files are named "Track - Artists.mp3": show the track big and the
// artist list small instead of one truncated line.
function splitUntaggedTitle() {
  if (!vlcNow.artist && vlcNow.title.includes(" - ")) {
    const cut = vlcNow.title.indexOf(" - ");
    vlcNow.artist = vlcNow.title.slice(cut + 3).trim();
    vlcNow.title = vlcNow.title.slice(0, cut).trim();
  }
}

async function pollVlcHttp() {
  const auth = "Basic " + Buffer.from(":" + String(config.vlc.password || "")).toString("base64");
  const r = await fetch(`${config.vlc.url}/requests/status.json`, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(1500),
  });
  if (!r.ok) throw new Error(`VLC HTTP ${r.status}`);
  const j = await r.json();
  const meta = (j.information && j.information.category && j.information.category.meta) || {};
  vlcNow.state = j.state || "stopped";
  vlcNow.title = meta.title || meta.now_playing || cleanTrackName(meta.filename) || "";
  vlcNow.artist = meta.artist || meta.album_artist || "";
  vlcNow.album = meta.album || "";
  vlcNow.positionMs = Math.round((Number(j.time) || 0) * 1000);
  vlcNow.lengthMs = Math.round((Number(j.length) || 0) * 1000);
  splitUntaggedTitle();
  vlcNow.source = "http";
}

/** One `dbus-send` call returns status, position and metadata together. */
function vlcMprisDump() {
  return new Promise((resolve, reject) => {
    execFile(
      "dbus-send",
      [
        "--session", "--print-reply",
        "--dest=org.mpris.MediaPlayer2.vlc",
        "/org/mpris/MediaPlayer2",
        "org.freedesktop.DBus.Properties.GetAll",
        "string:org.mpris.MediaPlayer2.Player",
      ],
      { timeout: 1500, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          const msg = String(err.message || err).split("\n")[0];
          reject(new Error(`VLC MPRIS: ${msg}`));
        } else {
          resolve(String(stdout));
        }
      }
    );
  });
}

/**
 * dbus-send prints one key per `string "<key>"` line followed by its
 * `variant <type> <value>` line. Nested maps (Metadata) and string arrays
 * (xesam:artist) are handled; everything else is ignored.
 */
function parseMprisDump(text) {
  const out = {};
  let key = null;
  let listKey = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "array [" || line.startsWith("dict entry(") || line === "]") {
      if (line.startsWith("dict entry(") || line === "]") listKey = null;
      continue;
    }
    const str = /^string "([\s\S]*)"$/.exec(line);
    if (str) {
      const val = str[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      if (listKey) {
        if (!Array.isArray(out[listKey])) out[listKey] = [];
        out[listKey].push(val);
      } else {
        key = val;
      }
      continue;
    }
    const v = /^variant\s+(\S+)\s*([\s\S]*)$/.exec(line);
    if (!v) continue;
    const type = v[1];
    const rest = v[2].trim();
    if (type === "array" || rest.startsWith("[")) {
      listKey = key;
      if (key && !Array.isArray(out[key])) out[key] = [];
    } else if (type === "string") {
      const quoted = /^"([\s\S]*)"$/.exec(rest);
      if (key) out[key] = quoted ? quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : rest;
    } else if (/^u?int(8|16|32|64)$/.test(type) || type === "double") {
      if (key) out[key] = Number(rest);
    } else if (type === "boolean") {
      if (key) out[key] = rest === "true";
    } else if (key) {
      out[key] = rest;
    }
    key = null;
  }
  return out;
}

async function pollVlcMpris() {
  const p = parseMprisDump(await vlcMprisDump());
  const status = String(p.PlaybackStatus || "Stopped").toLowerCase();
  vlcNow.state = status === "playing" ? "playing" : status === "paused" ? "paused" : "stopped";
  const url = String(p["xesam:url"] || "");
  const fromUrl = url ? cleanTrackName(decodeURIComponent(url.split("/").pop() || "")) : "";
  vlcNow.title = String(p["xesam:title"] || fromUrl || "");
  const artist = p["xesam:artist"];
  vlcNow.artist = Array.isArray(artist) ? artist.join(", ") : String(p["xesam:albumartist"] || artist || "");
  vlcNow.album = String(p["xesam:album"] || "");
  const pos = Number(p.Position);
  const len = Number(p["mpris:length"]);
  vlcNow.positionMs = Number.isFinite(pos) && pos > 0 ? Math.round(pos / 1000) : Math.round((Number(p["vlc:time"]) || 0) * 1000);
  vlcNow.lengthMs = Number.isFinite(len) && len > 0 ? Math.round(len / 1000) : 0;
  splitUntaggedTitle();
  vlcNow.source = "mpris";
}

async function pollVlc() {
  if (!config.vlc.enabled || vlcPolling) return;
  vlcPolling = true;
  try {
    try {
      await pollVlcHttp();
    } catch (httpErr) {
      try {
        await pollVlcMpris();
      } catch (mprisErr) {
        throw new Error(`${httpErr.message}; ${mprisErr.message}`);
      }
    }
    vlcNow.at = Date.now();
    vlcNow.ok = true;
    vlcNow.error = null;
  } catch (e) {
    vlcNow.ok = false;
    vlcNow.error = e.message;
    vlcNow.state = "stopped";
    vlcNow.at = Date.now();
  } finally {
    vlcPolling = false;
  }
}

function nowPlaying() {
  const playing = vlcNow.ok && vlcNow.state === "playing";
  return {
    ok: vlcNow.ok,
    state: vlcNow.state,
    playing,
    title: vlcNow.title,
    artist: vlcNow.artist,
    album: vlcNow.album,
    positionMs: vlcNow.positionMs,
    lengthMs: vlcNow.lengthMs,
    at: vlcNow.at,
    ageMs: vlcNow.at ? Date.now() - vlcNow.at : 0,
    serverNow: Date.now(),
    source: vlcNow.source,
    error: vlcNow.error,
  };
}

/* ------------------------------------------------------- ytpmv music fader */

/**
 * The camera2 YTPMV browser source lives in OBS with "Control audio via OBS"
 * (reroute_audio), so its sound is an input-level track. That means OBS's own
 * fader and mute apply to it and obs-websocket can drive them by input name —
 * no extra audio routing, no scene-item ids.
 */
function ytpmvInputName() {
  return (config.youtube.ytpmvs && config.youtube.ytpmvs.audioInput) || "Emilli YTPMVs";
}

async function ytpmvAudioState() {
  if (!obs.authenticated) return { ok: false, error: "OBS not connected", input: ytpmvInputName() };
  const name = ytpmvInputName();
  try {
    const [vol, mute] = await Promise.all([
      obs.request("GetInputVolume", { inputName: name }),
      obs.request("GetInputMute", { inputName: name }),
    ]);
    return {
      ok: true,
      input: name,
      muted: !!mute.inputMuted,
      volumeMul: vol.inputVolumeMul,
      volumeDb: vol.inputVolumeDb,
      at: Date.now(),
    };
  } catch (e) {
    return { ok: false, error: e.message, input: name };
  }
}

async function setYtpmvAudio(body) {
  if (!obs.authenticated) return { ok: false, error: "OBS not connected" };
  const name = ytpmvInputName();
  try {
    if (typeof body.muted === "boolean") {
      await obs.request("SetInputMute", { inputName: name, inputMuted: body.muted });
    }
    if (typeof body.volumeMul === "number" && Number.isFinite(body.volumeMul)) {
      // The slider never goes above unity: louder than 0 dB would clip the mix.
      const mul = Math.min(1, Math.max(0, body.volumeMul));
      await obs.request("SetInputVolume", { inputName: name, inputVolumeMul: mul });
    }
  } catch (e) {
    return { ok: false, error: e.message, input: name };
  }
  return ytpmvAudioState();
}

/** True while a Prism-launched client is already on screen: one game at a time. */
function minecraftRunning() {
  return new Promise((resolve) => {
    execFile(
      "pgrep",
      ["-f", "org.prismlauncher.EntryPoint"],
      { timeout: 1500 },
      (err, stdout) => resolve(!err && String(stdout).trim().length > 0)
    );
  });
}

function json(res, body, status = 200) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function readJson(req) {
  const body = await readBody(req, 256 * 1024);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

// Only these browser files are reachable. config.json (API key, Ko-fi token),
// state.json and the server modules must never be downloadable.
const PUBLIC_FILES = new Set([
  "index.html", "overlay.html", "countdown.html", "nowplaying.html", "notifications.html", "ytpmvs.html", "brb.html", "away.html", "app.js", "style.css",
  "mobile.html", "manifest.webmanifest", "emilli-remote.apk", "latency-clock.html",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "sounds/course-clear.mp3",
]);

function serveStatic(pathname, res) {
  const file = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!PUBLIC_FILES.has(file)) return json(res, { error: "not found" }, 404);
  const abs = path.join(ROOT, file);
  if (!abs.startsWith(ROOT + path.sep)) return json(res, { error: "forbidden" }, 403);
  fs.readFile(abs, (err, data) => {
    if (err) return json(res, { error: "not found" }, 404);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

/* ------------------------------------------------------- remote access gate */

const nodeCrypto = require("node:crypto");
const REMOTE_COOKIE = "emilli_remote";
const REMOTE = {
  enabled: !!(config.remote && config.remote.enabled && config.remote.token),
  token: String((config.remote && config.remote.token) || ""),
  // Optional short alternative for typing on a phone; brute force is held off by
  // the attempt lock-out below, and an empty value disables it.
  pin: String((config.remote && config.remote.pin) || ""),
};

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (!ab.length || ab.length !== bb.length) return false;
  return nodeCrypto.timingSafeEqual(ab, bb);
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return part.slice(i + 1).trim();
    }
  }
  return "";
}

/** A public request may present exactly one thing: the session cookie the
 *  one-time ?t=<token> visit handed out (browsers send it automatically, and
 *  it is what makes EventSource and fetch work without the token in the URL). */
function remoteCookieOk(req) {
  const cookie = cookieValue(req, REMOTE_COOKIE);
  return !!cookie && safeEqual(cookie, REMOTE.token);
}

const REMOTE_COOKIE_ATTRS = "Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax";

/** The public front door: one field, the token, a cookie for a year. Typing a
 *  long tokenised URL on a phone is exactly what made mobile data "not work". */
function remoteLoginPage(res, error = "", status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    `<html><head><meta charset="utf-8"/>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>` +
      `<meta name="theme-color" content="#08080b"/><title>Emilli Remote</title></head>` +
      `<body style="margin:0;background:#08080b;color:#f4f4f7;font:14px ui-monospace,SFMono-Regular,monospace;padding:40px 20px;line-height:1.6">` +
      `<div style="max-width:390px;margin:0 auto">` +
      `<h1 style="font-size:13px;letter-spacing:.24em;font-weight:600;margin:0 0 10px">EMILLI REMOTE</h1>` +
      `<p style="color:#8d8d9b;font-size:12px;margin:0 0 20px">Enter your PIN, or paste the access token — both are on the streaming PC ` +
      `(<b style="color:#c9c9d4">./remote-url.sh</b>, or <b style="color:#c9c9d4">config.json</b> → remote).</p>` +
      (error ? `<p style="color:#ff8597;font-size:12px;margin:0 0 14px">${error}</p>` : "") +
      `<form method="POST" action="/remote/login">` +
      `<input name="token" type="password" autocomplete="current-password" placeholder="access token" ` +
      `style="width:100%;box-sizing:border-box;background:#12121a;border:1px solid #2a2a36;color:#f4f4f7;border-radius:10px;padding:15px;font:inherit;margin-bottom:12px"/>` +
      `<button type="submit" style="width:100%;border:0;border-radius:10px;padding:15px;background:#ff2d55;color:#fff;font:600 12px ui-monospace,monospace;letter-spacing:.14em">UNLOCK</button>` +
      `</form>` +
      `<p style="color:#4d4d58;font-size:10px;margin-top:20px">Stays signed in for a year on this device.</p>` +
      `</div></body></html>`
  );
}

function remoteDenied(res, p, message) {
  if (p.startsWith("/api/")) return json(res, { ok: false, error: "remote access denied", hint: message }, 401);
  return remoteLoginPage(res, message, 401);
}

// Guessing the token from the open internet is slow already (48 hex chars), but
// a few failures in a row still earn a time-out so nothing can hammer the form.
const loginFails = new Map(); // ip → { n, until }
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (e.until && Date.now() < e.until) return true;
  if (e.until) loginFails.delete(ip);
  return false;
}
function loginFailed(ip) {
  const e = loginFails.get(ip) || { n: 0, until: 0 };
  e.n += 1;
  if (e.n >= 8) {
    e.until = Date.now() + 5 * 60 * 1000;
    e.n = 0;
  }
  loginFails.set(ip, e);
}

async function remoteLogin(req, res) {
  const ip = String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "?");
  if (loginBlocked(ip)) return remoteLoginPage(res, "too many attempts — wait five minutes.", 429);

  const raw = await readBody(req, 4096);
  let token = "";
  if (String(req.headers["content-type"] || "").includes("application/json")) {
    try {
      token = String(JSON.parse(raw || "{}").token || "");
    } catch {
      token = "";
    }
  } else {
    token = new URLSearchParams(raw).get("token") || "";
  }

  const entered = token.trim();
  const ok = safeEqual(entered, REMOTE.token) || (!!REMOTE.pin && safeEqual(entered, REMOTE.pin));
  if (!ok) {
    loginFailed(ip);
    console.log(`[remote] login failed from ${ip}`);
    return remoteLoginPage(res, "that token is not right.", 401);
  }

  loginFails.delete(ip);
  console.log(`[remote] login ok from ${ip}`);
  res.writeHead(303, {
    Location: "/mobile.html",
    "Set-Cookie": `${REMOTE_COOKIE}=${encodeURIComponent(REMOTE.token)}; ${REMOTE_COOKIE_ATTRS}`,
    "Cache-Control": "no-store",
  });
  return res.end();
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PRIVATE_HOST_RE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/** The socket peer, which a client cannot fake (unlike the Host header). */
function peerIsLocal(req) {
  const addr = String(req.socket.remoteAddress || "");
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return true;
  return PRIVATE_HOST_RE.test(addr.startsWith("::ffff:") ? addr.slice(7) : addr);
}

/**
 * True only for the local dashboard: this PC (loopback) or this LAN, and the
 * connection has to actually come from there. Both halves matter — the Host
 * header is client input, so trusting it alone would let anyone who can reach
 * the port (a router port-forward, say) send "Host: localhost" and walk past
 * the token. The tunnel connects from loopback but carries the public
 * *.trycloudflare.com Host, so it is still classified public, as intended.
 */
function isLocalRequest(req) {
  const host = String(req.headers.host || "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  const hostLocal =
    LOOPBACK_HOSTS.has(host) ||
    (LAN_OPEN && (PRIVATE_HOST_RE.test(host) || host.endsWith(".local")));
  return hostLocal && peerIsLocal(req);
}

/* ------------------------------------- scenes: text, png and gif sources */

// Pictures uploaded from the phone land here and are served back to OBS from
// /media/<file>. PNG/JPG go to an OBS image source (native size, alpha kept);
// GIF/WebP get a tiny HTML wrapper inside a browser source, because only the
// browser keeps the animation running and the transparency intact.
const MEDIA_DIR = path.join(ROOT, "media");
const MEDIA_MAX = 12 * 1024 * 1024; // ~8 MB of picture once base64 is undone
const MEDIA_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
};

const TEXT_KINDS = ["text_gdiplus_v3", "text_gdiplus_v2", "text_gdiplus", "text_ftl_v3", "text_ftl_v2"];

function isTextKind(kind) {
  return String(kind || "").startsWith("text_");
}

// Width/height straight from the file header, so a new source starts at the
// picture's own size instead of OBS's 600×400 default.
function pictureSize(buf, ext) {
  try {
    if (ext === "png" && buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (ext === "gif" && buf.length >= 10) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if ((ext === "jpg" || ext === "jpeg") && buf.length > 4) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* unreadable header — the caller falls back to OBS's default size */
  }
  return { w: 0, h: 0 };
}

function extensionFor(fileName, mime) {
  const found = /\.([a-z0-9]+)$/i.exec(String(fileName || ""));
  const ext = found ? found[1].toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return ext;
  const type = String(mime || "").toLowerCase();
  if (type === "image/png") return "png";
  if (type === "image/jpeg") return "jpg";
  if (type === "image/gif") return "gif";
  if (type === "image/webp") return "webp";
  return "";
}

function slugName(value) {
  return (
    String(value || "")
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "picture"
  );
}

function gifWrapper(src) {
  return (
    '<!doctype html><meta charset="utf-8"><style>' +
    "html,body{margin:0;padding:0;background:transparent;overflow:hidden}" +
    "img{display:block;width:100%;height:100%;object-fit:contain}" +
    `</style><img src="${src}" alt="">`
  );
}

async function uniqueInputName(wanted) {
  const base = String(wanted || "Source").trim() || "Source";
  let taken = new Set();
  try {
    const d = await obs.request("GetInputList");
    taken = new Set((d.inputs || []).map((i) => i.inputName));
  } catch {
    /* OBS will reject a duplicate name; that error is good enough */
  }
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  return `${base} ${Date.now().toString(36)}`;
}

// Which text plugin this OBS actually has (GDI+ on Windows-only builds, FreeType
// elsewhere). Asking beats hard-coding a kind that may not exist.
async function pickTextKind() {
  try {
    const d = await obs.request("GetInputKindList");
    const kinds = new Set(d.inputKinds || []);
    for (const kind of TEXT_KINDS) if (kinds.has(kind)) return kind;
    const any = [...kinds].find((k) => String(k).startsWith("text_"));
    if (any) return any;
  } catch {
    /* fall back to the most common kind */
  }
  return "text_gdiplus_v3";
}

// White 64 px text: readable on a 1080p canvas and easy to restyle in OBS.
// FreeType takes `style`, GDI+ takes `flags`; the other key is ignored.
function textSettings(value) {
  return {
    text: value,
    font: { face: "Arial", style: "Regular", size: 64, flags: 0 },
    color1: 0xffffffff,
    color2: 0xffffffff,
    outline_size: 0,
    outline_color: 0xff000000,
  };
}

async function centerItem(sceneName, sceneItemId, w, h) {
  if (!w || !h || !sceneItemId) return;
  try {
    const v = await obs.request("GetVideoSettings");
    const cw = v.baseWidth || v.outputWidth || 1920;
    const ch = v.baseHeight || v.outputHeight || 1080;
    await obs.request("SetSceneItemTransform", {
      sceneName,
      sceneItemId,
      sceneItemTransform: {
        alignment: 0,
        positionX: Math.round((cw - w) / 2),
        positionY: Math.round((ch - h) / 2),
      },
    });
  } catch {
    /* OBS's own placement is fine if the transform call is refused */
  }
}

/* --------------------------------------------------- away timer on every scene */

/**
 * "Back at X" is only useful if it is over whatever is on air, and an OBS
 * browser source lives in a single scene. So one source ("Away Timer" →
 * /away.html) is kept in every scene, stacked on top, and enabled only while
 * the timer runs. The BRB scene is skipped: its own line already carries the
 * countdown under the text.
 */
const AWAY_OVERLAY = "Away Timer";
let awayOverlayChain = Promise.resolve();

function syncAwayOverlay() {
  // A tap on the phone and the 30 s sweep can land together; run them in turn.
  awayOverlayChain = awayOverlayChain.then(syncAwayOverlayNow, syncAwayOverlayNow);
  return awayOverlayChain;
}

async function syncAwayOverlayNow() {
  if (!config.obs.enabled || !obs.authenticated) {
    return { ok: false, error: obs.lastError || "OBS not connected" };
  }
  const active = away.summary().active;
  let canvasW = 1920;
  let canvasH = 1080;
  try {
    const v = await obs.request("GetVideoSettings");
    canvasW = v.baseWidth || v.outputWidth || 1920;
    canvasH = v.baseHeight || v.outputHeight || 1080;
  } catch {
    /* assume 1080p */
  }

  const { scenes = [] } = await obs.request("GetSceneList");
  const names = scenes.map((s) => s.sceneName).filter(Boolean);
  const items = new Map();
  for (const name of names) {
    try {
      items.set(name, (await obs.request("GetSceneItemList", { sceneName: name })).sceneItems || []);
    } catch {
      /* a scene that will not list is left alone */
    }
  }

  const holder = names.find((n) => (items.get(n) || []).some((i) => i.sourceName === AWAY_OVERLAY));
  if (!holder && !active) return { ok: true, active, scenes: names.length, changed: [] };

  // Scenes already showing the countdown under the BRB line are left alone.
  const skip = new Set();
  try {
    const kinds = new Map();
    const list = await obs.request("GetInputList");
    for (const i of list.inputs || []) kinds.set(i.inputName, i.inputKind);
    const urls = new Map();
    for (const name of names) {
      for (const it of items.get(name) || []) {
        const src = it.sourceName;
        if (!src || src === AWAY_OVERLAY || kinds.get(src) !== "browser_source") continue;
        if (!urls.has(src)) {
          let url = "";
          try {
            url = String(((await obs.request("GetInputSettings", { inputName: src })).inputSettings || {}).url || "");
          } catch {
            /* unknown url: treat it as not the BRB page */
          }
          urls.set(src, url);
        }
        if (/\/brb\.html/i.test(urls.get(src))) {
          skip.add(name);
          break;
        }
      }
    }
  } catch {
    /* no input list: add the overlay everywhere */
  }

  // One browser source, shared by every scene, so a style change made in OBS
  // carries over to all scenes at once.
  const settings = {
    url: `http://127.0.0.1:${PORT}/away.html`,
    width: canvasW,
    height: canvasH,
    fps_custom: false,
    fps: 30,
    shutdown: false,
    restart_when_active: false,
    css: "body { background-color: rgba(0, 0, 0, 0); margin: 0; overflow: hidden; }",
  };

  const changed = [];
  let source = holder;
  if (source) {
    try {
      await obs.request("SetInputSettings", { inputName: AWAY_OVERLAY, inputSettings: settings, overlay: true });
    } catch (e) {
      console.log(`[away] could not update the overlay source: ${e.message}`);
    }
  }

  for (const name of names) {
    let item = (items.get(name) || []).find((i) => i.sourceName === AWAY_OVERLAY) || null;
    if (!item) {
      // Only while the timer runs: a disabled copy in every scene would just be
      // one more layer to click past in OBS for the rest of the week.
      if (!active || skip.has(name)) continue;
      try {
        if (!source) {
          const created = await obs.request("CreateInput", {
            sceneName: name,
            inputName: AWAY_OVERLAY,
            inputKind: "browser_source",
            inputSettings: settings,
            sceneItemEnabled: true,
          });
          item = { sceneItemId: created.sceneItemId, sceneItemEnabled: true };
          source = name;
        } else {
          const created = await obs.request("CreateSceneItem", {
            sceneName: name,
            sourceName: AWAY_OVERLAY,
            sceneItemEnabled: true,
          });
          item = { sceneItemId: created.sceneItemId, sceneItemEnabled: true };
        }
        changed.push(`+${name}`);
      } catch (e) {
        console.log(`[away] could not add the overlay to "${name}": ${e.message}`);
        continue;
      }
    }
    const sceneItemId = Number(item.sceneItemId);
    if (!Number.isFinite(sceneItemId)) continue;
    // Topmost, pinned to the canvas origin and never scaled, so the pill lands
    // in the same spot in every scene.
    try {
      await obs.request("SetSceneItemIndex", { sceneName: name, sceneItemId, sceneItemIndex: 0 });
      await obs.request("SetSceneItemTransform", {
        sceneName: name,
        sceneItemId,
        sceneItemTransform: {
          alignment: 5, // top-left: positionX/Y are the canvas origin
          positionX: 0,
          positionY: 0,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          boundsType: "OBS_BOUNDS_NONE",
        },
      });
    } catch (e) {
      console.log(`[away] could not lift the overlay in "${name}": ${e.message}`);
    }
    if (!!item.sceneItemEnabled !== active) {
      try {
        await obs.request("SetSceneItemEnabled", { sceneName: name, sceneItemId, sceneItemEnabled: active });
        changed.push(`${active ? "on" : "off"}:${name}`);
      } catch (e) {
        console.log(`[away] could not toggle the overlay in "${name}": ${e.message}`);
      }
    }
  }

  if (changed.length) console.log(`[away] overlay ${changed.join(" ")}`);
  return { ok: true, active, scenes: names, changed };
}

// Every source in one scene, with just enough detail for the phone to edit the
// text sources and show which pictures are already there.
async function sceneSources(sceneName) {
  const scene =
    String(sceneName || "").trim() ||
    (await obs.request("GetCurrentProgramScene")).currentProgramSceneName ||
    "";
  if (!scene) throw new Error("scene required");
  const d = await obs.request("GetSceneItemList", { sceneName: scene });
  const all = d.sceneItems || [];
  const items = [];
  // The phone shows "y 512 / 1080" while nudging a source up and down.
  let canvasW = 1920;
  let canvasH = 1080;
  try {
    const v = await obs.request("GetVideoSettings");
    canvasW = Number(v.baseWidth) || canvasW;
    canvasH = Number(v.baseHeight) || canvasH;
  } catch {
    /* default canvas size is good enough for the readout */
  }
  for (const it of all) {
    const kind = String(it.inputKind || "");
    let text = "";
    let file = "";
    let url = "";
    if (isTextKind(kind) || kind === "image_source" || kind === "browser_source") {
      try {
        const s = (await obs.request("GetInputSettings", { inputName: it.sourceName })).inputSettings || {};
        text = s.text || "";
        file = s.file || "";
        url = s.url || "";
      } catch {
        /* a source OBS will not describe is still listed */
      }
    }
    // Only our own uploaded pictures count, not the Twitch/overlay browser
    // sources that also live in the scene. Animated files are served through
    // <file>.gif.html, which is how they are recognised on the way back.
    const picture = kind === "browser_source" && /\/media\/[^/]+\.html$/i.test(url);
    const animated = /\.(gif|webp)\.html$/i.test(url);
    const type = isTextKind(kind) ? "text" : picture ? (animated ? "gif" : "image") : kind === "image_source" ? "image" : "other";
    const tr = it.sceneItemTransform || {};
    const align = Number(tr.alignment) || 0;
    const boxW = Number(tr.width) || 0;
    const boxH = Number(tr.height) || 0;
    // OBS keeps position at the alignment anchor, but the phone drags the
    // visible box, so send its top-left corner as well.
    const boxLeft = (Number(tr.positionX) || 0) - (align & 1 ? 0 : align & 2 ? boxW : boxW / 2);
    const boxTop = (Number(tr.positionY) || 0) - (align & 4 ? 0 : align & 8 ? boxH : boxH / 2);
    items.push({
      id: it.sceneItemId,
      name: it.sourceName,
      type,
      inputKind: kind,
      text,
      file,
      url,
      // Visibility, so the phone can show/hide this source.
      enabled: it.sceneItemEnabled !== false,
      // Layer order: OBS numbers scene items from the back (0) to the front,
      // so the phone can draw the list front-first and move rows around.
      index: Number(it.sceneItemIndex) || 0,
      count: all.length,
      // Where the source sits on the canvas, for the position nudge.
      x: Number((it.sceneItemTransform || {}).positionX) || 0,
      y: Number((it.sceneItemTransform || {}).positionY) || 0,
      width: boxW,
      height: boxH,
      // The visible box on the canvas, for the layout tab's drag surface.
      left: Math.round(boxLeft),
      top: Math.round(boxTop),
    });
  }
  return { scene, items, canvas: { width: canvasW, height: canvasH } };
}

/* ------------------------------------------------------------ audio mixer */

// Every OBS input that has a volume: desktop audio, the mic, per-app captures
// and browser sources with sound. Video-only sources reject the mute request,
// which is the cheapest way to tell the two apart.
async function audioInputs() {
  const list = await obs.request("GetInputList");
  const inputs = [];
  for (const input of list.inputs || []) {
    const name = input.inputName;
    if (!name) continue;
    try {
      const mute = await obs.request("GetInputMute", { inputName: name });
      const vol = await obs.request("GetInputVolume", { inputName: name });
      const mul = Number(vol.inputVolumeMul);
      const db = Number(vol.inputVolumeDb);
      inputs.push({
        name,
        kind: input.inputKind || "",
        muted: !!mute.inputMuted,
        volumeMul: Number.isFinite(mul) ? Math.round(mul * 1000) / 1000 : 0,
        // OBS reports -inf dB for a closed fader and JSON cannot carry that;
        // +6 dB is as far as the phone fader goes.
        volumeDb: Number.isFinite(db) ? Math.max(-60, Math.min(6, Math.round(db))) : -60,
      });
    } catch {
      /* not an audio source (camera, text, image…) */
    }
  }
  return inputs;
}

function serveMedia(pathname, res) {
  const name = path.basename(decodeURIComponent(pathname));
  const abs = path.join(MEDIA_DIR, name);
  if (!name || !abs.startsWith(MEDIA_DIR + path.sep)) return json(res, { error: "forbidden" }, 403);
  fs.readFile(abs, (err, data) => {
    if (err) return json(res, { error: "not found" }, 404);
    res.writeHead(200, {
      "Content-Type": MEDIA_MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

/* ------------------------------------------------------- phone camera relay */
// The phone camera app uploads one MPEG-TS stream (POST /api/cam/upload, using
// the remote token) and OBS pulls it back from this machine (GET /cam.ts). The
// phone's only connection is its own outbound one, so this works on mobile data
// from anywhere — no LAN address, no port forwarding, nothing to configure in
// OBS after the first time.
const CAM = {
  at: 0, // last chunk time; 0 when the phone is not uploading
  bytes: 0,
  clients: new Set(), // the responses OBS and the dashboard read from
  buffer: [], // recent TS, replayed on connect so a player starts instantly
  bufferBytes: 0,
};
const CAM_BUFFER_BYTES = 4 * 1024 * 1024;
// A batch arrives every ~300 ms; a gap this long means the phone stopped.
const CAM_STALE_MS = 3500;

function camStatus() {
  return {
    live: CAM.at > 0 && Date.now() - CAM.at < CAM_STALE_MS,
    bytes: CAM.bytes,
    viewers: CAM.clients.size,
    bufferedBytes: CAM.bufferBytes,
  };
}

function camBroadcast(chunk) {
  CAM.buffer.push(chunk);
  CAM.bufferBytes += chunk.length;
  while (CAM.bufferBytes > CAM_BUFFER_BYTES && CAM.buffer.length > 1) {
    CAM.bufferBytes -= CAM.buffer.shift().length;
  }
  for (const c of CAM.clients) {
    try {
      c.write(chunk);
    } catch {
      CAM.clients.delete(c);
    }
  }
}

function camUpload(req, res) {
  // The phone sends the stream as short batches (a tunnel will not pass one
  // endless request body), so this route is called a few times a second and the
  // bytes are simply appended. A pause longer than CAM_STALE_MS starts a new
  // broadcast instead of splicing the old one in.
  const fresh = CAM.at === 0 || Date.now() - CAM.at > CAM_STALE_MS;
  if (fresh) {
    CAM.buffer = [];
    CAM.bufferBytes = 0;
    CAM.bytes = 0;
    console.log("[cam] phone camera upload started");
  }
  CAM.at = Date.now();

  req.on("data", (chunk) => {
    CAM.at = Date.now();
    CAM.bytes += chunk.length;
    camBroadcast(chunk);
  });
  req.on("error", () => {
    CAM.at = 0;
  });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(camStatus()));
  });
}

/**
 * Where the replay may start inside the oldest buffered chunk. Chunks are the
 * fragments Node hands over from a POST body, so the ring buffer can lose its
 * head a few bytes into a 188-byte TS packet; a player then complains about a
 * missing PPS until the next keyframe. Slide forward to a real sync byte that
 * repeats on the packet grid.
 */
function camReplayOffset(chunks) {
  const WINDOW = 188 * 3;
  const head = chunks[0];
  if (!head || head.length < WINDOW) return 0;
  for (let o = 0; o < 188; o++) {
    if (head[o] === 0x47 && head[o + 188] === 0x47 && head[o + 376] === 0x47) return o;
  }
  return 0;
}

function camWatch(req, res) {
  res.writeHead(200, {
    "Content-Type": "video/mp2t",
    "Cache-Control": "no-store",
    Connection: "close",
    "Access-Control-Allow-Origin": "*",
  });
  if (CAM.buffer.length > 0) {
    const skip = camReplayOffset(CAM.buffer);
    res.write(skip > 0 ? CAM.buffer[0].subarray(skip) : CAM.buffer[0]);
    for (let i = 1; i < CAM.buffer.length; i++) res.write(CAM.buffer[i]);
  }
  CAM.clients.add(res);
  const drop = () => CAM.clients.delete(res);
  req.on("close", drop);
  res.on("error", drop);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // A finished video id cannot be redirected on YouTube's side, so the timer
  // serves its own alias instead: /live/<anything> — including an old id like
  // /live/vQCpZ_q39VQ — bounces to whatever broadcast is live now. Public on
  // purpose (no data, just a 302): the point is to paste it wherever the dead
  // link was, and it keeps working after the next restart.
  if (req.method === "GET" && /^\/live(\/|$)/.test(p)) {
    res.writeHead(302, { Location: currentLiveUrl(), "Cache-Control": "no-store" });
    return res.end();
  }

  // Everything that is not the local dashboard and not the Ko-fi webhook has to
  // come through the remote token. See isLocalRequest for how a request is
  // classified, and remoteCookieOk for what a public request may present.
  const isKofi = req.method === "POST" && p === "/kofi";
  if (!isLocalRequest(req) && !isKofi) {
    if (!REMOTE.enabled) {
      return json(
        res,
        {
          error: "not publicly exposed",
          hint: `only POST /kofi is published — enable config.remote to use the phone remote over mobile data`,
        },
        403
      );
    }

    // The login screen is the public front door — open the bare host name on
    // the phone and this is what you get. Already signed in? Straight to the
    // remote.
    if (req.method === "GET" && (p === "/" || p === "/remote")) {
      if (remoteCookieOk(req)) {
        res.writeHead(302, { Location: "/mobile.html", "Cache-Control": "no-store" });
        return res.end();
      }
      return remoteLoginPage(res);
    }
    if (req.method === "POST" && p === "/remote/login") return remoteLogin(req, res);

    // First visit from the phone: ?t=<token> → store the cookie, then bounce to
    // the clean URL so the token never sits in the phone's history. The APK
    // pre-fills this form of the address.
    const typed = url.searchParams.get("t");
    if (typed) {
      if (!safeEqual(typed, REMOTE.token)) {
        console.log(`[remote] token rejected for ${p}`);
        return remoteDenied(res, p, "that token is not right.");
      }
      const clean = new URL(url.href);
      clean.searchParams.delete("t");
      // "//host" as a Location would be read as another site; never echo it.
      const target = clean.pathname.startsWith("//") ? "/" : clean.pathname;
      res.writeHead(302, {
        Location: target + (clean.search || ""),
        "Set-Cookie": `${REMOTE_COOKIE}=${encodeURIComponent(REMOTE.token)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
        "Cache-Control": "no-store",
      });
      return res.end();
    }

    if (!remoteCookieOk(req)) {
      console.log(`[remote] denied ${req.headers["cf-connecting-ip"] || "?"} ${p}`);
      return remoteDenied(res, p, "sign in first.");
    }
  }

  try {
    // The Stream Deck plugin runs as a file:// page inside the deck app, which
    // means its requests arrive with "Origin: null". That one origin (and only
    // that one) may read the local API; nothing else gains a CORS allowance.
    if (req.headers.origin === "null") {
      res.setHeader("Access-Control-Allow-Origin", "null");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
    }

    if (isKofi) return await kofiWebhook(req, res);

    if (p === "/api/state" && req.method === "GET") return json(res, publicState());

    if (p === "/api/cam/status" && req.method === "GET") return json(res, camStatus());
    if (p === "/api/cam/upload" && req.method === "POST") return camUpload(req, res);

    // The camera picture for OBS: "Media Source" with this local address.
    if (p === "/cam.ts" && req.method === "GET") return camWatch(req, res);

    if (p === "/api/events") return sse(req, res);

    if (req.method === "POST" && p === "/api/boost") {
      const body = await readJson(req);
      if (!BOOSTS[body.type]) return json(res, { ok: false, error: "unknown boost" }, 400);
      return json(res, applyBoost(body.type, { source: body.source || "manual", test: !!body.test }));
    }

    // Fire one of the three alerts on the notifications overlay without
    // counting anything, so the alerts can be checked on stream safely.
    if (req.method === "POST" && p === "/api/replay") {
      const body = await readJson(req);
      const r = replayAlert(String(body.type || ""), {
        name: body.name,
        message: body.message,
        amountText: body.amountText,
      });
      return json(res, r, r.ok ? 200 : 400);
    }

    if (req.method === "POST" && p === "/api/undo") return json(res, undoBoost());
    if (req.method === "POST" && p === "/api/start") return json(res, startNow());
    if (req.method === "POST" && p === "/api/reset") return json(res, resetAll());
    if (req.method === "POST" && p === "/api/settings") {
      const body = await readJson(req);
      if (body.startAt !== undefined) return json(res, setStartAt(body.startAt));
      return json(res, { ok: false, error: "nothing to set" }, 400);
    }
    if (req.method === "POST" && p === "/api/youtube/check") {
      const r = await pollYouTube("manual");
      // One press of SYNC YT NOW also refreshes the fallbacks, so a sub only
      // socialcounts or YouTube's page has seen yet still counts right away.
      await pollSocialCounts("manual").catch(() => {});
      await pollYouTubePage("manual").catch(() => {});
      return json(res, { ...r, state: publicState() });
    }

    // End the running broadcast and start a new one with a chosen latency
    // class — the only way YouTube allows the class to change at all.
    if (req.method === "POST" && p === "/api/youtube/restart") {
      const body = await readJson(req);
      return json(res, startSwitch(body.latency, { title: body.title }));
    }

    // Title + description of the running broadcast, and the saved pair the next
    // broadcast will start with.
    if (p === "/api/youtube/meta" && req.method === "GET") {
      let live = null;
      try {
        live = await ytLive.activeBroadcast();
      } catch (e) {
        return json(res, { ok: false, error: e.message, meta: state.yt.meta || null });
      }
      const sn = (live && live.snippet) || {};
      return json(res, {
        ok: true,
        videoId: live ? live.id : null,
        title: sn.title || (state.yt.meta || {}).title || "",
        description: sn.description != null ? sn.description : (state.yt.meta || {}).description || "",
        meta: state.yt.meta || null,
      });
    }

    if (p === "/api/youtube/meta" && req.method === "POST") {
      const body = await readJson(req);
      const title = typeof body.title === "string" ? body.title.trim() : null;
      const description = typeof body.description === "string" ? body.description : null;
      if (title !== null && (!title || title.length > 100)) {
        return json(res, { ok: false, error: "the title has to be 1–100 characters" }, 400);
      }
      if (description !== null && description.length > 5000) {
        return json(res, { ok: false, error: "the description has to be under 5000 characters" }, 400);
      }
      // Saved even with nothing live, so the next broadcast starts with it.
      state.yt.meta = {
        ...(state.yt.meta || {}),
        ...(title !== null ? { title } : {}),
        ...(description !== null ? { description } : {}),
        at: Date.now(),
      };
      save();
      broadcast("state", publicState());
      try {
        const live = await ytLive.activeBroadcast();
        if (!live) {
          return json(res, { ok: true, applied: false, videoId: null, meta: state.yt.meta, note: "saved — nothing is live, the next broadcast starts with it" });
        }
        const updated = await ytLive.updateBroadcast(live.id, { title, description });
        const sn = (updated && updated.snippet) || {};
        return json(res, {
          ok: true,
          applied: true,
          videoId: live.id,
          title: sn.title || state.yt.meta.title || "",
          description: sn.description != null ? sn.description : state.yt.meta.description || "",
          meta: state.yt.meta,
        });
      } catch (e) {
        console.log("[yt-live] title/description update failed:", e.message);
        return json(res, { ok: false, error: e.message, meta: state.yt.meta });
      }
    }

    // Post into the live chat as the channel. YouTube's API has no pin call, so
    // the answer says so rather than pretending the message is pinned.
    if (p === "/api/youtube/chat" && req.method === "POST") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json(res, { ok: false, error: "the message is empty" }, 400);
      if (body.save) savePin({ text });
      try {
        return json(res, await postPinMessage(text));
      } catch (e) {
        console.log("[yt-live] chat post failed:", e.message);
        return json(res, { ok: false, error: e.message });
      }
    }

    // The pinned note: stored text plus the "post it on every go-live" switch.
    if (p === "/api/youtube/pin" && req.method === "POST") {
      const body = await readJson(req);
      const patch = {};
      if (typeof body.text === "string") patch.text = body.text.trim();
      if (typeof body.auto === "boolean") patch.auto = body.auto;
      const pin = savePin(patch);
      if (!body.post) return json(res, { ok: true, pin });
      if (!pin.text) return json(res, { ok: false, error: "the pinned note is empty", pin }, 400);
      try {
        return json(res, { ...(await postPinMessage(pin.text)), pin: state.yt.pin });
      } catch (e) {
        console.log("[yt-live] pin post failed:", e.message);
        return json(res, { ok: false, error: e.message, pin });
      }
    }

    // The one-tap auto-fix: check after every GO LIVE, switch again if the
    // broadcast did not come up Ultra-low.
    if (req.method === "POST" && p === "/api/youtube/auto-ultra") {
      const body = await readJson(req);
      return json(res, setAutoUltra(body.enabled));
    }

    // One-time YouTube authorization: /oauth/start → Google → /oauth2callback.
    if (p === "/oauth/start" && req.method === "GET") {
      if (!ytOAuth.configured()) {
        return htmlPage(
          res,
          "OAuth client missing",
          "Add youtube.oauth.clientId and youtube.oauth.clientSecret to config.json first (Google Cloud → Credentials → OAuth client ID → Desktop app)."
        );
      }
      res.writeHead(302, { Location: ytOAuth.authUrl() });
      return res.end();
    }

    if (p === "/oauth2callback" && req.method === "GET") {
      const denied = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (denied) return htmlPage(res, "Authorization cancelled", `Google said: ${denied}`);
      if (!code) return htmlPage(res, "No authorization code", "Google did not send a code back.");
      try {
        await ytOAuth.exchange(code);
        const res2 = await pollRecentSubs("oauth");
        const body = res2.firstRun
          ? `Connected. ${res2.seen} existing subscribers recorded as the baseline; every new subscriber from now on adds 5 minutes by name.`
          : `Connected. ${res2.newSubs} new subscriber(s) credited right away.`;
        broadcast("state", publicState());
        return htmlPage(res, "YouTube connected", body);
      } catch (e) {
        console.error("[yt-oauth]", e.message);
        return htmlPage(res, "Authorization failed", e.message);
      }
    }

    if (req.method === "POST" && p === "/api/obs/start") return json(res, await manualObs("start"));
    if (req.method === "POST" && p === "/api/obs/stop") return json(res, await manualObs("stop"));

    // OBS scene switching for the phone remote.
    if (p === "/api/obs/scenes" && req.method === "GET") {
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      try {
        const d = await obs.request("GetSceneList");
        const current = d.currentProgramSceneName || null;
        // OBS returns scenes newest-first; creation order reads better.
        const scenes = (d.scenes || []).map((s) => s.sceneName).filter(Boolean).reverse();
        // GetSceneList only lists top-level scenes, so the program scene can be one
        // that is missing from it (scene created or renamed between two calls, or a
        // scene nested inside a group). The UI highlights by name, so keep the
        // invariant that the current scene always has a chip:
        if (current && !scenes.includes(current)) scenes.unshift(current);
        return json(res, { ok: true, current, scenes });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    // BRB overlay texts (edited from the phone app).
    if (p === "/api/brb" && req.method === "GET") return json(res, { ok: true, ...brb.data() });
    if (req.method === "POST" && p === "/api/brb") {
      const body = await readJson(req);
      const action = String(body.action || "add");
      let r;
      if (action === "add") r = brb.add(body.text, body.preset);
      else if (action === "update") r = brb.update(String(body.id || ""), body.text, body.preset);
      else if (action === "remove") r = brb.remove(String(body.id || ""));
      else if (action === "move") r = brb.move(String(body.id || ""), body.delta);
      else r = { ok: false, error: `unknown action ${action}` };
      return json(res, { ...r, state: publicState() }, r.ok ? 200 : 400);
    }

    // Away timer: "at work / sleeping / busy, back at HH:MM". `until` is an
    // absolute end time from the phone's time picker, `minutes` a countdown.
    // The weekly shifts ride on the same endpoint: schedule-add / schedule-remove.
    if (p === "/api/away" && req.method === "GET") return json(res, { ok: true, ...away.data() });
    if (req.method === "POST" && p === "/api/away") {
      const body = await readJson(req);
      const action = String(body.action || "set");
      let r;
      if (action === "clear") r = away.clear();
      else if (action === "schedule-add") r = away.addShift(body);
      else if (action === "schedule-remove") r = away.removeShift(body.id);
      else r = away.set(body.reason, body.minutes, body.until);
      // The countdown has to reach every scene, not only the BRB one; an OBS
      // failure must not make the timer itself look broken.
      const overlay = await syncAwayOverlay().catch((e) => ({ ok: false, error: e.message }));
      if (r.ok) broadcast("state", publicState());
      return json(res, { ...r, overlay, state: publicState() }, r.ok ? 200 : 400);
    }

    // Twitch queue for the asleep scene (relay on 127.0.0.1:8099).
    if (p === "/api/twitch" && req.method === "GET") {
      return json(res, await twitch.status());
    }
    if (req.method === "POST" && p === "/api/twitch/streamers") {
      const body = await readJson(req);
      const action = String(body.action || "add");
      let r;
      if (action === "add") r = await twitch.add(body.url || body.login);
      else if (action === "remove") r = twitch.remove(body.login || body.url);
      else if (action === "move") r = twitch.move(body.login || body.url, body.delta);
      else r = { ok: false, error: `unknown action ${action}` };
      return json(res, { ...r, state: publicState() }, r.ok ? 200 : 400);
    }
    if (req.method === "POST" && p === "/api/twitch/switch") {
      const body = await readJson(req);
      const r = await twitch.switchTo(body.login || body.url, "picked on the phone");
      return json(res, { ...r, state: publicState() }, r.ok ? 200 : 400);
    }
    if (req.method === "POST" && p === "/api/twitch/next") {
      const r = await twitch.next();
      return json(res, { ...r, state: publicState() }, r.ok ? 200 : 400);
    }
    if (req.method === "POST" && p === "/api/twitch/auto") {
      const body = await readJson(req);
      const r = twitch.setAuto(body.enabled !== false);
      return json(res, { ...r, state: publicState() }, 200);
    }

    if (p === "/api/obs/scene" && req.method === "POST") {
      const body = await readJson(req);
      const name = String(body.sceneName || "");
      if (!name) return json(res, { ok: false, error: "sceneName required" }, 400);
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      try {
        await obs.request("SetCurrentProgramScene", { sceneName: name });
        console.log(`[obs] program scene → ${name}`);
        return json(res, { ok: true, current: name });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }
    // The scene exactly as OBS renders it, for the layout tab. Bytes rather
    // than JSON so the phone hands it straight to BitmapFactory; the source
    // boxes come from /api/obs/sources and are drawn on top.
    if (p === "/api/obs/scene/screenshot" && req.method === "GET") {
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" }, 503);
      try {
        const scene =
          String(url.searchParams.get("scene") || "").trim() ||
          (await obs.request("GetCurrentProgramScene")).currentProgramSceneName;
        if (!scene) return json(res, { ok: false, error: "scene required" }, 400);
        const width = Math.max(320, Math.min(1920, Math.round(Number(url.searchParams.get("width")) || 960)));
        const quality = Math.max(10, Math.min(100, Math.round(Number(url.searchParams.get("q")) || 70)));
        const shot = await obs.request("GetSourceScreenshot", {
          sourceName: scene,
          imageFormat: "jpg",
          imageWidth: width,
          imageCompressionQuality: quality,
        });
        const m = /^data:image\/[a-z]+;base64,(.+)$/s.exec(String(shot.imageData || ""));
        if (!m) return json(res, { ok: false, error: "OBS sent no picture" }, 502);
        const buf = Buffer.from(m[1], "base64");
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": buf.length,
          "Cache-Control": "no-store",
        });
        return res.end(buf);
      } catch (e) {
        console.log("[obs] scene screenshot failed:", e.message);
        return json(res, { ok: false, error: e.message }, 502);
      }
    }

    // Show/hide one source inside a scene (the ON/OFF switches in the app).
    if (p === "/api/obs/source/visible" && req.method === "POST") {
      const body = await readJson(req);
      const scene = String(body.scene || "").trim();
      const sceneItemId = Number(body.sceneItemId);
      const visible = body.visible !== false;
      if (!scene || !Number.isFinite(sceneItemId)) {
        return json(res, { ok: false, error: "scene and sceneItemId required" }, 400);
      }
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      try {
        await obs.request("SetSceneItemEnabled", {
          sceneName: scene,
          sceneItemId,
          sceneItemEnabled: visible,
        });
        console.log(`[obs] "${scene}" item ${sceneItemId} → ${visible ? "visible" : "hidden"}`);
        return json(res, { ok: true, scene, sceneItemId, visible });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    // Layer order inside a scene: the phone's ▲/▼ arrows. OBS counts scene
    // items from the back (index 0) to the front, so "top" is the last index.
    // `delta` steps one place, `to:"top"|"bottom"` jumps all the way.
    if (p === "/api/obs/source/order" && req.method === "POST") {
      const body = await readJson(req);
      const scene = String(body.scene || "").trim();
      const sceneItemId = Number(body.sceneItemId);
      if (!scene || !Number.isFinite(sceneItemId)) {
        return json(res, { ok: false, error: "scene and sceneItemId required" }, 400);
      }
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      try {
        const list = await obs.request("GetSceneItemList", { sceneName: scene });
        const items = list.sceneItems || [];
        const item = items.find((i) => Number(i.sceneItemId) === sceneItemId);
        if (!item) return json(res, { ok: false, error: "source is not in this scene" }, 404);
        const count = items.length;
        const current = Number(item.sceneItemIndex) || 0;
        let target;
        if (body.to === "top") target = count - 1;
        else if (body.to === "bottom") target = 0;
        else if (Number.isFinite(Number(body.index))) target = Math.round(Number(body.index));
        else target = current + Math.round(Number(body.delta) || 0);
        target = Math.max(0, Math.min(count - 1, target));
        if (target !== current) {
          await obs.request("SetSceneItemIndex", {
            sceneName: scene,
            sceneItemId,
            sceneItemIndex: target,
          });
          console.log(`[obs] "${scene}" ${item.sourceName}: layer ${current} → ${target} of ${count}`);
        }
        return json(res, { ok: true, scene, sceneItemId, index: target, count });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    // Where a source sits on the picture: the phone's position nudge. OBS
    // measures positionY from the source's alignment anchor (top edge, centre
    // or bottom edge), so top/middle/bottom of the canvas are computed from
    // that anchor plus the source's own height. `steps` nudges by 5% of the
    // canvas per press, `deltaY` moves by exact pixels.
    if (p === "/api/obs/source/position" && req.method === "POST") {
      const body = await readJson(req);
      const scene = String(body.scene || "").trim();
      const sceneItemId = Number(body.sceneItemId);
      if (!scene || !Number.isFinite(sceneItemId)) {
        return json(res, { ok: false, error: "scene and sceneItemId required" }, 400);
      }
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      try {
        const list = await obs.request("GetSceneItemList", { sceneName: scene });
        const item = (list.sceneItems || []).find((i) => Number(i.sceneItemId) === sceneItemId);
        if (!item) return json(res, { ok: false, error: "source is not in this scene" }, 404);
        let canvasW = 1920;
        let canvasH = 1080;
        try {
          const v = await obs.request("GetVideoSettings");
          canvasW = Number(v.baseWidth) || canvasW;
          canvasH = Number(v.baseHeight) || canvasH;
        } catch {
          /* fall back to 1080p */
        }
        const t = item.sceneItemTransform || {};
        const align = Number(t.alignment) || 0;
        // With bounds on, the box OBS draws is the bounds box, not the raw
        // source size (a 1920x1080 "fit to screen" source reports height 240).
        const bounds = String(t.boundsType || "OBS_BOUNDS_NONE") !== "OBS_BOUNDS_NONE";
        const h = bounds && Number(t.boundsHeight) > 0
          ? Number(t.boundsHeight)
          : Number(t.height) || Number(t.sourceHeight) || 0;
        const w = bounds && Number(t.boundsWidth) > 0
          ? Number(t.boundsWidth)
          : Number(t.width) || Number(t.sourceWidth) || 0;
        // Distance from the source's top edge down to its alignment anchor.
        const anchor = align & 4 ? 0 : align & 8 ? h : h / 2;
        const anchorX = align & 1 ? 0 : align & 2 ? w : w / 2;
        const step = Math.max(1, Math.round(Number(body.step) || canvasH * 0.05));
        let x = Number(t.positionX) || 0;
        let y = Number(t.positionY) || 0;
        if (body.to === "top") y = anchor;
        else if (body.to === "bottom") y = canvasH - h + anchor;
        else if (body.to === "middle") y = (canvasH - h) / 2 + anchor;
        else if (Number.isFinite(Number(body.deltaY))) y += Number(body.deltaY);
        else if (!Number.isFinite(Number(body.left)) && !Number.isFinite(Number(body.top)))
          y += (Number(body.steps) || 0) * step;
        // A drag from the layout tab sends the visible box's corner; OBS wants
        // the anchor, and the box must stay on the canvas.
        if (Number.isFinite(Number(body.left)) || Number.isFinite(Number(body.top))) {
          if (Number.isFinite(Number(body.left))) x = Number(body.left) + anchorX;
          if (Number.isFinite(Number(body.top))) y = Number(body.top) + anchor;
          x = Math.max(0, Math.min(canvasW - w, x - anchorX)) + anchorX;
          y = Math.max(0, Math.min(canvasH - h, y - anchor)) + anchor;
        }
        x = Math.round(x);
        y = Math.round(y);
        await obs.request("SetSceneItemTransform", {
          sceneName: scene,
          sceneItemId,
          sceneItemTransform: {
            positionX: x,
            positionY: y,
          },
        });
        console.log(`[obs] "${scene}" ${item.sourceName}: ${Math.round(Number(t.positionX) || 0)},${Math.round(Number(t.positionY) || 0)} → ${x},${y} of ${canvasW}x${canvasH}`);
        return json(res, {
          ok: true,
          scene,
          sceneItemId,
          x,
          y,
          left: Math.round(x - anchorX),
          top: Math.round(y - anchor),
          canvasW,
          canvasH,
          step,
        });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    // Text and pictures inside one scene (edited from the phone app).
    if (p === "/api/obs/sources" && req.method === "GET") {
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      try {
        return json(res, { ok: true, ...(await sceneSources(url.searchParams.get("scene") || "")) });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    if (p === "/api/obs/text" && req.method === "POST") {
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      const body = await readJson(req);
      const scene = String(body.scene || "").trim();
      if (!scene) return json(res, { ok: false, error: "scene required" }, 400);
      const text = String(body.text == null ? "" : body.text);
      try {
        const input = String(body.input || "").trim();
        if (input) {
          await obs.request("SetInputSettings", { inputName: input, inputSettings: { text }, overlay: true });
          console.log(`[obs] text in ${scene}: ${input} → ${JSON.stringify(text.slice(0, 60))}`);
          return json(res, { ok: true, scene, input, text });
        }
        const kind = await pickTextKind();
        const name = await uniqueInputName(body.name || "Text");
        await obs.request("CreateInput", {
          sceneName: scene,
          inputName: name,
          inputKind: kind,
          inputSettings: textSettings(text),
          sceneItemEnabled: true,
        });
        console.log(`[obs] new text source ${name} (${kind}) in ${scene}`);
        return json(res, { ok: true, scene, input: name, text });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    if (p === "/api/obs/media" && req.method === "POST") {
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      let body;
      try {
        body = JSON.parse((await readBody(req, MEDIA_MAX)) || "{}");
      } catch (e) {
        return json(
          res,
          { ok: false, error: e.message === "body too large" ? "picture too big (max 8 MB)" : "bad picture payload" },
          400
        );
      }
      const scene = String(body.scene || "").trim();
      if (!scene) return json(res, { ok: false, error: "scene required" }, 400);
      const raw = String(body.data || "")
        .replace(/^data:[^,]*,/, "")
        .replace(/\s+/g, "");
      if (!raw) return json(res, { ok: false, error: "no picture data" }, 400);
      const bytes = Buffer.from(raw, "base64");
      if (!bytes.length) return json(res, { ok: false, error: "picture did not decode" }, 400);
      const ext = extensionFor(body.file, body.mime);
      if (!ext) return json(res, { ok: false, error: "png, jpg or gif only" }, 400);

      const stem = slugName(body.name || body.file);
      const file = `${stem}-${Date.now().toString(36)}.${ext}`;
      const size = pictureSize(bytes, ext);
      try {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        fs.writeFileSync(path.join(MEDIA_DIR, file), bytes);

        const animated = ext === "gif" || ext === "webp";
        let settings;
        let kind;
        let urlPath = `/media/${file}`;
        if (animated) {
          // Browser source + wrapper page: the animation loops and the page's
          // transparent background keeps the stream behind it visible.
          const page = `${file}.html`;
          fs.writeFileSync(path.join(MEDIA_DIR, page), gifWrapper(urlPath));
          urlPath = `/media/${page}`;
          kind = "browser_source";
          settings = {
            url: `http://127.0.0.1:${PORT}${urlPath}`,
            width: size.w || 480,
            height: size.h || 480,
            shutdown: false,
            restart_when_active: false,
            css: "body { margin: 0; background: transparent; }",
          };
        } else {
          kind = "image_source";
          settings = { file: path.join(MEDIA_DIR, file) };
        }

        const name = await uniqueInputName(body.name || stem || "picture");
        const created = await obs.request("CreateInput", {
          sceneName: scene,
          inputName: name,
          inputKind: kind,
          inputSettings: settings,
          sceneItemEnabled: true,
        });
        await centerItem(scene, created.sceneItemId, size.w, size.h);
        console.log(`[obs] ${ext} ${file} → ${name} (${kind}) in ${scene}`);
        return json(res, { ok: true, scene, input: name, kind: ext, url: urlPath, width: size.w, height: size.h });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    // Audio mixer for the phone: one fader and one mute per audio input.
    if (p === "/api/obs/audio" && req.method === "GET") {
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      try {
        return json(res, { ok: true, inputs: await audioInputs() });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    if (p === "/api/obs/volume" && req.method === "POST") {
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      const body = await readJson(req);
      const input = String(body.input || "").trim();
      if (!input) return json(res, { ok: false, error: "input required" }, 400);
      let mul;
      if (body.volumeMul !== undefined) mul = Number(body.volumeMul);
      else if (body.volumeDb !== undefined) mul = Math.pow(10, Number(body.volumeDb) / 20);
      if (!Number.isFinite(mul)) return json(res, { ok: false, error: "volumeMul or volumeDb required" }, 400);
      // -60 dB … +6 dB: silent to a little headroom, never a surprise jump.
      mul = Math.min(2, Math.max(0, mul));
      try {
        await obs.request("SetInputVolume", { inputName: input, inputVolumeMul: mul });
        const v = await obs.request("GetInputVolume", { inputName: input });
        const db = Number(v.inputVolumeDb);
        return json(res, {
          ok: true,
          input,
          volumeMul: Math.round(Number(v.inputVolumeMul) * 1000) / 1000,
          volumeDb: Number.isFinite(db) ? Math.max(-60, Math.min(6, Math.round(db))) : -60,
        });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    if (p === "/api/obs/mute" && req.method === "POST") {
      if (!obs.authenticated) return json(res, { ok: false, error: "OBS not connected" });
      const body = await readJson(req);
      const input = String(body.input || "").trim();
      if (!input) return json(res, { ok: false, error: "input required" }, 400);
      try {
        if (body.muted === undefined) {
          const d = await obs.request("ToggleInputMute", { inputName: input });
          return json(res, { ok: true, input, muted: !!d.inputMuted });
        }
        await obs.request("SetInputMute", { inputName: input, inputMuted: !!body.muted });
        const d = await obs.request("GetInputMute", { inputName: input });
        return json(res, { ok: true, input, muted: !!d.inputMuted });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    if (p === "/api/obs/status") return json(res, { ok: true, status: await obs.status() });
    if (p === "/api/nowplaying") return json(res, nowPlaying());

    // Music fader + mute for the YTPMV browser source (OBS input audio).
    if (p === "/api/ytpmvs/audio") {
      if (req.method === "GET") return json(res, await ytpmvAudioState());
      if (req.method === "POST") return json(res, await setYtpmvAudio(await readJson(req)));
      return json(res, { ok: false, error: "method not allowed" }, 405);
    }

    // Video list for the YTPMV overlay (camera2 background).
    if (p === "/api/ytpmvs") {
      try {
        const l = await fetchUploads(url.searchParams.get("refresh") === "1");
        return json(res, {
          ok: true,
          count: l.videoIds.length,
          videoIds: l.videoIds,
          titles: l.titles,
          fetchedAt: l.at,
          error: l.error,
        });
      } catch (e) {
        return json(res, { ok: false, error: e.message, videoIds: [] });
      }
    }

    // Modpack launcher behind the Stream Deck's Modpacks page.
    if (p === "/api/modpacks" && req.method === "GET") {
      return json(res, {
        ok: true,
        modpacks: Object.entries(MODPACKS).map(([key, pack]) => ({ key, ...pack })),
      });
    }
    if (p === "/api/modpack/launch" && req.method === "POST") {
      const body = await readJson(req);
      const pack = MODPACKS[body.key];
      if (!pack) return json(res, { ok: false, error: "unknown modpack" }, 400);
      if (await minecraftRunning()) {
        return json(res, { ok: false, error: "a Minecraft instance is already running" }, 409);
      }
      const args = ["-l", pack.instance];
      if (pack.world) args.push("-w", pack.world);
      try {
        const child = spawn(PRISM, args, { detached: true, stdio: "ignore" });
        child.on("error", (e) => console.log(`[modpack] spawn failed: ${e.message}`));
        child.unref();
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
      console.log(`[modpack] ${pack.label} -> ${pack.world || "title screen"}`);
      return json(res, { ok: true, instance: pack.instance, world: pack.world || "" });
    }

    if (p === "/api/health") {
      return json(res, {
        ok: true,
        uptime: process.uptime(),
        sseClients: clients.size,
        remoteEnabled: REMOTE.enabled,
        youtubeConfigured: !!config.youtube.apiKey,
        youtubeSubsMode: ytOAuth.hasToken() ? "oauth" : "count",
        youtubeSubsTracked: (state.yt.seenSubs || []).length,
        kofiConfigured: !!config.kofi.verificationToken,
        obsEnabled: !!config.obs.enabled,
        obsConnected: obs.authenticated,
        obsStreaming: obs.streaming,
        vlcEnabled: !!config.vlc.enabled,
        vlcState: vlcNow.state,
        vlcTrack: vlcNow.title,
      });
    }

    if (p.startsWith("/api/")) {
      console.log(`[api] 404 ${p}`);
      return json(res, { error: "not found" }, 404);
    }
    if (p.startsWith("/media/")) return serveMedia(p, res);
    return serveStatic(p, res);
  } catch (e) {
    console.error("[http]", req.method, p, e.message);
    return json(res, { error: e.message }, 500);
  }
});

// The camera upload is one request that lasts as long as the stream; without
// this Node closes it after five minutes.
server.requestTimeout = 0;
server.listen(PORT, HOST, () => {
  try {
    fs.writeFileSync(path.join(ROOT, "server.pid"), String(process.pid));
  } catch { /* non-fatal */ }
  console.log(`\n  Emilli 24h timer → http://localhost:${PORT}`);
  console.log(`  Phone remote     → http://<this-pc-ip>:${PORT}/mobile.html${LAN_OPEN ? "  (LAN open)" : "  (loopback only — set config.host to 0.0.0.0)"}`);
  console.log(`  OBS overlay      → http://localhost:${PORT}/overlay.html`);
  console.log(`  OBS countdown    → http://localhost:${PORT}/countdown.html`);
  console.log(`  OBS now playing  → http://localhost:${PORT}/nowplaying.html`);
  console.log(`  OBS alerts       → http://localhost:${PORT}/notifications.html`);
  console.log(`  OBS YTPMVs       → http://localhost:${PORT}/ytpmvs.html`);
  console.log(`  Ko-fi webhook    → POST /kofi  (needs a public https URL)`);
  console.log(
    `  YouTube          → ${config.youtube.apiKey ? "polling" : "not configured (add youtube.apiKey to config.json)"}`
  );
  console.log(
    `  OBS control      → ${config.obs.enabled ? `auto start/stop via ${config.obs.url}` : "off (set obs.enabled in config.json)"}\n`
  );
});

function flushState() {
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

function shutdown() {
  flushState();
  try {
    fs.unlinkSync(path.join(ROOT, "server.pid"));
  } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

autoStartIfDue();
obs.start();
twitch.start();
setInterval(autoStartIfDue, 1000);
setInterval(streamTick, 1000);
setInterval(watchLatency, 1000);
setInterval(pollObsHealth, 3000);
// New scenes, a restarted OBS and a shift ending without anyone touching the
// phone all need the overlay moved along; 30 s is well under "noticeable".
setInterval(() => {
  if (obs.authenticated) syncAwayOverlay().catch(() => {});
}, 30000);
setInterval(() => pollYouTube("interval"), Math.max(15, config.youtube.pollSeconds) * 1000);
setInterval(() => {
  pollRecentSubs("interval").catch((e) => console.error("[yt-subs]", e.message));
}, Math.max(60, config.youtube.subsPollSeconds || 120) * 1000);
if (ytOAuth.hasToken()) setTimeout(() => pollRecentSubs("startup").catch(() => {}), 6000);
setInterval(() => {
  pollSocialCounts("interval").catch((e) => console.error("[sc]", e.message));
}, Math.max(15, config.youtube.socialcounts.pollSeconds || 30) * 1000);
setTimeout(() => pollSocialCounts("startup").catch(() => {}), 4000);
setInterval(() => {
  pollYouTubePage("interval").catch((e) => console.warn("[yt-page]", e.message));
}, Math.max(15, config.youtube.pollSeconds) * 1000);
setTimeout(() => pollYouTubePage("startup").catch(() => {}), 5000);
pollVlc();
setInterval(pollVlc, 1000);
setTimeout(() => pollYouTube("startup"), 2500);
setInterval(() => {
  pollLiveChat("interval").catch((e) => console.warn("[yt-chat]", e.message));
}, Math.max(3, config.youtube.chat?.pollSeconds || 5) * 1000);
setInterval(() => broadcast("state", publicState()), 15000); // slow heartbeat for late tabs
