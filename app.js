/* Emilli FTL — 24h timer dashboard.
   The server owns the clock now: every action is a POST, every update arrives
   over SSE, so the dashboard, a second window and the OBS overlay never drift. */

const BOOSTS = {
  sub: { label: "SUB", ms: 5 * 60 * 1000, cls: "sub" },
  kofi: { label: "KO-FI DONO", ms: 30 * 60 * 1000, cls: "kofi" },
  like: { label: "VIDEO LIKE", ms: 30 * 1000, cls: "like" },
};

const $ = (id) => document.getElementById(id);
let state = null;
let offset = 0;                 // server clock − local clock
let sound = localStorage.getItem("emilli.sound") !== "off";

/* ---------------- formatting ---------------- */
function clockText(ms) {
  const t = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${ms < 0 ? "-" : ""}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function shortDur(ms) {
  const t = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.round((t % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return `${t}s`;
}
function boostText(ms) {
  const t = Math.round(ms / 1000);
  if (t >= 3600) return `+${Math.floor(t / 3600)}h`;
  if (t >= 60) return `+${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  return `+0:${String(t).padStart(2, "0")}`;
}
function hhmm(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function dayLabel(d) {
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "";
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return "tomorrow ";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " ";
}
// 66 644 → "66.6k", 3 432 768 → "3.4M": the health line has to stay one line.
function compactNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e4) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/* ---------------- api ---------------- */
async function api(path, body) {
  let r;
  try {
    r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: "server unreachable" };
  }
  const data = (await r.json().catch(() => ({}))) || {};
  if (data.state) {
    state = data.state;
    offset = state.serverNow - Date.now();
    render();
  }
  return data;
}

const boost = (type, test = false) => api("/api/boost", { type, test });

/* ---------------- audio ---------------- */
let actx = null;
function blip(big) {
  if (!sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const now = actx.currentTime;
    [big ? 660 : 880, big ? 990 : 1320].forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.07 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.18);
      o.connect(g).connect(actx.destination);
      o.start(now + i * 0.07);
      o.stop(now + i * 0.07 + 0.2);
    });
  } catch { /* no audio device */ }
}

/* ---------------- flash ---------------- */
let flashTimer = null;
function flash(cls, text) {
  const el = $("flash");
  el.textContent = text;
  el.style.color = cls === "kofi" ? "#5cc8f2" : cls === "like" ? "#ffa76b" : "#ff6b85";
  el.classList.remove("go");
  void el.offsetWidth;
  el.classList.add("go");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove("go"), 1300);
}
let bumpTimer = null;
function bump() {
  const el = $("clock");
  el.classList.add("bump");
  clearTimeout(bumpTimer);
  bumpTimer = setTimeout(() => el.classList.remove("bump"), 130);
}

/* ---------------- render ---------------- */
function render() {
  if (!state) return;
  const now = Date.now() + offset;
  const bank = state.baseMs + state.addedMs;
  const clock = $("clock");
  const label = $("stageLabel");
  const sub = $("stageSub");
  const chip = $("statusChip");

  if (!state.startedAt) {
    const start = new Date(state.startAt);
    const untilStart = start.getTime() - now;
    const runway = untilStart + bank;
    const projectedEnd = new Date(start.getTime() + bank);
    clock.textContent = clockText(runway);
    clock.className = "clock" + (runway <= 0 ? " dead" : "");
    label.textContent = untilStart > 0 ? "STREAM ENDS IN" : "STREAM IS DUE — PRESS START";
    sub.innerHTML =
      `goes live <b>${dayLabel(start)}${hhmm(start)}</b> in <b>${clockText(Math.max(0, untilStart))}</b>` +
      ` · ends <b>${dayLabel(projectedEnd)}${hhmm(projectedEnd)}</b>` +
      ` · ${shortDur(bank)} bank${
        state.addedMs > 0 ? ` <span style="color:#37e39b">(+${shortDur(state.addedMs)})</span>` : ""
      }`;
    chip.textContent = "PRE-STREAM";
    chip.className = "chip";
  } else {
    const left = bank - (now - state.startedAt);
    const end = new Date(state.startedAt + bank);
    clock.textContent = clockText(left);
    clock.className = "clock" + (left <= 0 ? " dead" : left < 3600000 ? " urgent" : "");
    label.textContent = left <= 0 ? "TIME'S UP" : "TIME LEFT ON STREAM";
    sub.innerHTML =
      left <= 0
        ? `the clock hit zero at <b>${hhmm(end)}</b> — a new boost puts you back on air`
        : `ends <b>${dayLabel(end)}${hhmm(end)}</b> · ${shortDur(bank)} bank${
            state.addedMs > 0 ? ` <span style="color:#37e39b">(+${shortDur(state.addedMs)} added)</span>` : ""
          }`;
    chip.textContent = left <= 0 ? "OFF AIR" : "LIVE";
    chip.className = "chip " + (left <= 0 ? "over" : "live");
  }

  $("statSub").textContent = state.counts.sub || 0;
  $("statKofi").textContent = state.counts.kofi || 0;
  $("statLike").textContent = state.counts.like || 0;
  $("statAdded").textContent = state.addedMs ? "+" + shortDur(state.addedMs) : "0m";

  $("undoBtn").disabled = !state.log.length;
  $("startNow").disabled = !!state.startedAt;

  const field = $("startAt");
  if (document.activeElement !== field) field.value = state.startAt;

  renderFeed();
  renderIntegrations(now);
  renderAway(now);
}

// The away timer the BRB overlay shows, plus the next shift: one line that
// proves the weekly schedule is set without waiting for 09:00 to watch it fire.
function renderAway(now) {
  const el = $("stageAway");
  if (!el) return;
  const aw = (state.integrations || {}).away || {};
  const next = aw.next || null;
  const nextAt = next ? new Date(next.at) : null;
  const nextText = next ? `next: ${weekdayShort(nextAt)} ${hhmm(nextAt)} ${next.reason}` : "";
  if (aw.active && aw.until > now) {
    const end = new Date(aw.until);
    const shift = aw.source === "schedule" ? " · shift" : "";
    el.hidden = false;
    el.textContent = `away now: ${aw.reason} · back ${hhmm(end)}${shift}${nextText ? " · " + nextText : ""}`;
  } else if (nextText) {
    el.hidden = false;
    el.textContent = nextText;
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

function weekdayShort(d) {
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

function renderFeed() {
  const ul = $("feed");
  ul.innerHTML = "";
  const items = [...state.log].reverse().slice(0, 14);
  $("feedEmpty").style.display = items.length ? "none" : "inline";
  for (const e of items) {
    const b = BOOSTS[e.type];
    if (!b) continue;
    const li = document.createElement("li");
    const when = e.test ? "TEST" : hhmm(new Date(e.at));
    // Built with textContent, not innerHTML: donor names/messages come from
    // Ko-fi and must never be able to inject markup into this page.
    const name = document.createElement("span");
    name.className = "f-name";
    name.textContent = b.label + (e.name ? " · " + e.name : "");
    const amt = document.createElement("span");
    amt.className = "f-amt " + b.cls;
    amt.textContent = (e.amountText ? e.amountText + " " : "") + boostText(e.amountMs);
    const time = document.createElement("span");
    time.className = "f-time";
    time.textContent = when;
    li.append(name, amt, time);
    ul.appendChild(li);
  }
}

function renderIntegrations(now) {
  const yt = state.integrations.youtube;
  const kf = state.integrations.kofi;

  const dotYt = $("ytDot");
  const infoYt = $("ytInfo");
  let ytState = "off";
  // A failing subscriber feed is a YouTube fault too, even when the channel
  // statistics call is fine: the light must not stay green while subs break.
  if (yt.configured && (yt.error || yt.subsError)) ytState = "err";
  else if (yt.configured && yt.lastCheck) ytState = "ok";
  dotYt.className = "int-dot " + ytState;

  if (!yt.configured) {
    infoYt.textContent = "add youtube.apiKey to config.json";
  } else if (yt.error) {
    infoYt.textContent = yt.error;
  } else {
    const bits = [];
    bits.push(yt.subs == null ? "subs ?" : `${yt.subs} subs${yt.hiddenSubs ? " (hidden)" : ""}`);
    if (yt.videoId) bits.push(yt.likes == null ? "likes ?" : `${yt.likes} likes`);
    else bits.push("waiting for live video");
    bits.push(`checked ${ago(yt.lastCheck)}`);
    infoYt.textContent = bits.join(" · ");
  }

  // Subscriber tracking. A 403, a revoked token or a stalled poll all mean subs
  // are being credited by nobody, so the state has to be visible, not silent.
  const subsEl = $("ytSubs");
  const polled = yt.subsLastPoll ? ago(yt.subsLastPoll) : null;
  const stale = yt.subsLastPoll ? now - yt.subsLastPoll > 5 * 60 * 1000 : true;
  let subsCls = "yt-subs";
  let subsTxt;
  if (yt.subsError) {
    subsCls += " bad";
    subsTxt = `subs error: ${yt.subsError}`;
  } else if (!yt.oauthConfigured) {
    subsTxt = "subs: count mode (rounded total) · no oauth client";
  } else if (!yt.oauthConnected) {
    subsCls += " warn";
    subsTxt = "subs: count mode · authorize at /oauth/start";
  } else if (!yt.subsLastPoll) {
    subsCls += " warn";
    subsTxt = "subs: oauth · no poll yet";
  } else if (stale) {
    subsCls += " bad";
    subsTxt = `subs: oauth · last poll ${polled} (stalled)`;
  } else {
    subsCls += " good";
    subsTxt = `subs: oauth · ${yt.subsTracked} tracked · polled ${polled}`;
  }
  subsEl.className = subsCls;
  subsEl.textContent = subsTxt;
  subsEl.title = yt.subsError || subsTxt;

  // socialcounts.org watchdog: its live estimate next to YouTube's own number,
  // with the same rule that a dead watchdog must be visible, not silent.
  const scEl = $("ytSc");
  const sc = yt.socialcounts || {};
  const num = (v) => (v == null ? "?" : v);
  // Every subscriber-count source, so a dead one is visible before a sub goes
  // missing. All of them feed the same high-water mark.
  const subSrc = Object.entries(yt.subSources || {});
  const srcTxt = subSrc.length
    ? " · " + subSrc.map(([id, s]) => `${id}${s.ok ? " " + num(s.count) : " down"}`).join(" · ")
    : "";
  let scCls = "yt-subs sc";
  let scTxt;
  if (!sc.enabled) {
    scTxt = "socialcounts: disabled";
  } else if (sc.error) {
    scCls += " bad";
    scTxt = `socialcounts error: ${sc.error}`;
  } else if (!sc.at) {
    scCls += " warn";
    scTxt = "socialcounts: waiting for first poll";
  } else {
    const scStale = now - sc.at > 3 * 60 * 1000;
    scCls += scStale ? " bad" : " good";
    scTxt = `socialcounts: ${num(sc.estimation)} est / ${num(sc.api)} yt · ${ago(sc.at)}`;
    if (scStale) scTxt += " (stalled)";
  }
  scEl.className = scCls;
  scEl.textContent = scTxt + srcTxt;
  scEl.title = sc.error || scTxt + srcTxt;

  // Broadcast latency class. YouTube decides it per broadcast, so the useful
  // thing to show is whether THIS broadcast came up Ultra-low — green only
  // for Ultra-low, amber for anything else, red when the read keeps failing.
  const latEl = $("ytLat");
  const lat = yt.latency || {};
  const latName = { ULTRA_LOW: "Ultra-low", LOW: "Low", NORMAL: "Normal" }[lat.class] || lat.class;
  let latCls = "yt-subs lat";
  let latTxt;
  if (lat.class) {
    const ultra = lat.class === "ULTRA_LOW";
    latCls += ultra ? " good" : " warn";
    latTxt =
      `latency: ${latName}` +
      (ultra ? " ✓" : " — not ultra-low") +
      (lat.at ? ` · read ${ago(lat.at)}` : "");
  } else if (lat.error && !lat.startedAt) {
    latCls += " bad";
    latTxt = `latency: ${lat.error}`;
  } else if (lat.startedAt) {
    latCls += lat.error ? " bad" : " warn";
    latTxt = lat.error
      ? `latency: ${lat.error} · retrying`
      : "latency: reading after stream start…";
  } else {
    latCls += " warn";
    latTxt = "latency: not read yet — reads after every stream start";
  }
  latEl.className = latCls;
  latEl.textContent = latTxt;
  latEl.title = lat.error || (lat.videoId ? `video ${lat.videoId}` : latTxt);

  // A latency switch runs in the background on the server (end → create →
  // bind → go live, ~30 s), so the card shows the step instead of freezing the
  // button. A failure stays visible for ten minutes, then the class line wins.
  const sw = yt.switch || {};
  const switching = !!sw.step && !sw.done;
  if (sw.step && sw.ok === false && now - sw.at < 10 * 60 * 1000) {
    latEl.className = "yt-subs lat bad";
    latEl.textContent = `switch failed: ${sw.error || "unknown"}`;
    latEl.title = sw.error || "";
  } else if (switching) {
    latEl.className = "yt-subs lat warn";
    latEl.textContent = `switching to ultra-low · ${sw.step}…`;
    latEl.title = "ending the current broadcast and starting a new one";
  }
  const ultraBtn = $("ytUltra");
  if (ultraBtn) {
    ultraBtn.disabled = switching;
    ultraBtn.title = yt.oauthConnected
      ? "end this broadcast and start a new one with Ultra-low latency (~2–5 s)"
      : "authorize youtube first — open /oauth/start";
  }

  // Is anything actually on air? OBS can encode happily while YouTube has no
  // broadcast bound to the stream key — the channel then shows no live video
  // and nothing is recorded. Say that in words instead of looking healthy.
  const airEl = $("ytOnAir");
  const obsNow = state.integrations.obs || {};
  const air = yt.onAir || {};
  if (airEl) {
    let airCls = "yt-subs air";
    let airTxt;
    if (air.live) {
      airCls += " good";
      airTxt = `ON AIR: ${air.id}${air.at ? ` · checked ${ago(air.at)}` : ""}`;
    } else if (obsNow.streaming) {
      airCls += " bad";
      airTxt = air.status === "upcoming" || air.status === "ready"
        ? `NOT LIVE YET — broadcast ${air.id || "?"} is waiting for the encoder`
        : "NOTHING ON AIR — OBS is streaming, YouTube has no live broadcast · press GO LIVE";
    } else if (air.status === "created" || air.status === "ready" || air.status === "upcoming") {
      airCls += " warn";
      airTxt = `broadcast ${air.id || "?"} is ready — goes live when OBS starts`;
    } else {
      airCls += " warn";
      airTxt = "nothing on air";
    }
    airEl.className = airCls;
    airEl.textContent = airTxt;
    airEl.title = "read from the YouTube Live API — costs no search quota";
  }
  const goBtn = $("obsStart");
  if (goBtn) {
    const missing = !!(obsNow.streaming && !air.live);
    goBtn.textContent = missing ? "GO LIVE \u26A0 NOTHING ON AIR" : "GO LIVE";
    goBtn.className = missing ? "mini danger" : "mini";
  }

  // The auto-fix: after every GO LIVE the class is read anyway, so when it is
  // not Ultra-low the timer can redo the switch itself. "GAVE UP" means it
  // tried every allowed attempt and the broadcast still came up wrong.
  const auBtn = $("autoUltra");
  if (auBtn) {
    const au = yt.autoUltra || {};
    auBtn.textContent = au.gaveUp
      ? "AUTO ULTRA: GAVE UP"
      : au.enabled
        ? "AUTO ULTRA: ON"
        : "AUTO ULTRA: OFF";
    auBtn.disabled = !yt.oauthConnected;
    auBtn.title = yt.oauthConnected
      ? au.gaveUp
        ? "gave up after the allowed attempts — check Studio → Stream settings → Stream latency"
        : "after every GO LIVE, switch again if the broadcast is not Ultra-low"
      : "authorize youtube first — open /oauth/start";
  }

  // Pinned chat note: the API cannot pin, so the card keeps the text, posts it
  // for you and points at the Studio tab where the Pin button actually lives.
  const pin = yt.pin || {};
  const pinInput = $("pinText");
  if (pinInput && document.activeElement !== pinInput && pinInput.value !== (pin.text || "")) {
    pinInput.value = pin.text || "";
  }
  const pinStateEl = $("pinState");
  if (pinStateEl) {
    pinStateEl.textContent = pin.lastSentAt
      ? `posted ${ago(pin.lastSentAt)}`
      : pin.text
        ? "saved · not posted yet"
        : "no note yet";
    pinStateEl.className = "mix-val" + (pin.lastSentAt ? "" : " muted");
  }
  const pinAutoBtn = $("pinAuto");
  if (pinAutoBtn) {
    pinAutoBtn.textContent = pin.auto ? "AUTO ON GO-LIVE: ON" : "AUTO ON GO-LIVE: OFF";
    pinAutoBtn.disabled = !yt.oauthConnected;
    pinAutoBtn.title = yt.oauthConnected
      ? "post the note in chat automatically every time the stream starts"
      : "authorize youtube first — open /oauth/start";
  }
  const pinStudioLink = $("pinStudio");
  if (pinStudioLink) {
    const pinVid = (yt.latency || {}).videoId || yt.videoId;
    pinStudioLink.href = pinVid
      ? `https://studio.youtube.com/video/${pinVid}/livestreaming`
      : "https://studio.youtube.com";
  }

  const apk = yt.apk || {};
  const apkStateEl = $("apkState");
  if (apkStateEl) {
    const kb = apk.bytes ? `${Math.round(apk.bytes / 1024)} KB` : "";
    const ver = apk.version ? `v${apk.version.name}` : "";
    apkStateEl.textContent = [ver, kb, apk.at ? ago(apk.at) : ""].filter(Boolean).join(" · ") || "no build";
  }

  const dotKf = $("kofiDot");
  const infoKf = $("kofiInfo");
  dotKf.className = "int-dot " + (kf.lastHitAt ? "ok" : kf.enabled ? "wait" : "off");
  infoKf.textContent = kf.hits
    ? `${kf.hits} webhook${kf.hits === 1 ? "" : "s"} · last ${ago(kf.lastHitAt)}`
    : kf.enabled
      ? "webhook token set · waiting for Ko-fi"
      : "disabled · set kofi.verificationToken";

  const ob = state.integrations.obs || {};
  const dotObs = $("obsDot");
  const infoObs = $("obsInfo");
  if (!ob.enabled) {
    dotObs.className = "int-dot off";
    infoObs.textContent = "off · set obs.enabled in config.json";
  } else if (!ob.connected) {
    dotObs.className = "int-dot err";
    infoObs.textContent = ob.error || "not connected";
  } else if (ob.streaming) {
    dotObs.className = "int-dot ok";
    infoObs.textContent = "LIVE" + (ob.autoStop ? " · auto-stops at zero" : "");
  } else if (ob.held) {
    dotObs.className = "int-dot err";
    infoObs.textContent = "held after manual END · press GO LIVE";
  } else {
    dotObs.className = "int-dot wait";
    infoObs.textContent = "connected" + (ob.autoStart ? " · auto-starts at go-live" : " · manual");
  }

  // Stream health straight from GetStreamStatus: skipped frames, the bitrate
  // derived from OBS's byte counter, and reconnects this session. Green only
  // when the link looks able to carry ultra-low — ultra-low gives YouTube no
  // buffer to hide an unstable encoder feed.
  const hEl = $("obsHealth");
  if (hEl) {
    const h = ob.health;
    if (!ob.enabled || !ob.connected) {
      hEl.className = "yt-subs lat";
      hEl.textContent = "stream: —";
      hEl.title = "needs an OBS connection";
    } else if (!ob.streaming) {
      hEl.className = "yt-subs lat";
      hEl.textContent = "stream: — · not streaming";
      hEl.title = "reads while OBS is streaming";
    } else if (!h || !h.ok) {
      hEl.className = "yt-subs lat warn";
      hEl.textContent = "stream: reading OBS…";
      hEl.title = (h && h.error) || "";
    } else {
      const pct = Number(h.skippedPct || 0);
      const re = Number(h.reconnects || 0);
      const cong = Number(h.congestion || 0);
      // OBS's skipped frames are encoder/render skips; reconnects and the
      // congestion figure are the network side of the same question.
      const cls =
        h.reconnecting || re >= 2 || pct >= 5 || cong > 0.05
          ? "bad"
          : re === 1 || pct >= 1 || cong > 0.02
            ? "warn"
            : "good";
      hEl.className = `yt-subs lat ${cls}`;
      hEl.textContent =
        `stream: ${h.bitrateKbps == null ? "—" : h.bitrateKbps + " kbps"}` +
        ` · skipped ${pct.toFixed(2)}% (${compactNum(h.skipped)}/${compactNum(h.total)})` +
        ` · ${re} reconnect${re === 1 ? "" : "s"}`;
      hEl.title =
        "OBS GetStreamStatus · skipped frames are encoder/render skips (under 1% is what ultra-low wants to see), " +
        "reconnects and congestion are the network ones" +
        (h.reconnecting ? " · RECONNECTING NOW" : "");
    }
  }

  // Permanent live alias: always opens whatever the channel is live with, so
  // it survives a broadcast restart. Follows youtube.handle from the server
  // rather than a hard-coded URL.
  const perm = $("permLink");
  if (yt.handle && perm.dataset.handle !== yt.handle) {
    perm.dataset.handle = yt.handle;
    perm.href = `https://www.youtube.com/@${yt.handle}/live`;
    perm.textContent = `@${yt.handle}/live ↗`;
  }

  $("ytCheck").disabled = !yt.configured;
}

/* ---------------- YTPMV music fader ---------------- */
// OBS owns the actual value (input volume of the "Emilli YTPMVs" source), so
// every change is a POST and the answer is what gets drawn — never a guess.
let mix = { ready: false, muted: false, db: 0 };

function mixDbText() {
  if (!mix.ready) return "OBS off";
  if (mix.muted) return "MUTED";
  if (mix.db <= -59.5) return "−∞ dB";
  return `${mix.db > 0 ? "+" : ""}${Math.round(mix.db)} dB`;
}

function renderMix() {
  const val = $("mixVal");
  val.textContent = mixDbText();
  val.classList.toggle("muted", mix.muted || !mix.ready);

  const slider = $("mixSlider");
  slider.disabled = !mix.ready;
  // Do not fight the thumb while it is being dragged.
  if (document.activeElement !== slider) {
    slider.value = String(Math.max(-60, Math.min(0, Math.round(mix.db))));
  }

  const btn = $("mixMute");
  btn.textContent = mix.muted ? "UNMUTE" : "MUTE";
  btn.classList.toggle("muted", mix.muted);
  btn.disabled = !mix.ready;
}

async function loadMix() {
  const r = await api("/api/ytpmvs/audio");
  if (r.ok) mix = { ready: true, muted: !!r.muted, db: Number(r.volumeDb ?? 0) };
  else mix.ready = false;
  renderMix();
}

let mixQueue = null;
let mixTimer = null;
function sendMix(patch) {
  mixQueue = { ...(mixQueue || {}), ...patch };
  clearTimeout(mixTimer);
  mixTimer = setTimeout(async () => {
    const body = mixQueue;
    mixQueue = null;
    const r = await api("/api/ytpmvs/audio", body);
    if (r.ok) {
      mix = { ready: true, muted: !!r.muted, db: Number(r.volumeDb ?? mix.db) };
      renderMix();
    } else {
      flash("like", "MUSIC: " + (r.error || "failed"));
      loadMix();
    }
  }, 120);
}

$("mixSlider").addEventListener("input", (e) => {
  const db = Number(e.target.value);
  mix.db = db;
  mix.ready = true;
  renderMix();
  sendMix({ volumeMul: Math.pow(10, db / 20) });
});

$("mixMute").addEventListener("click", () => {
  mix.muted = !mix.muted;
  renderMix();
  sendMix({ muted: mix.muted });
});

// OBS can also be changed from OBS itself; pick that up when you come back and
// periodically while this tab is visible.
window.addEventListener("focus", loadMix);
setInterval(() => {
  if (document.hidden || document.activeElement === $("mixSlider")) return;
  loadMix();
}, 20000);

/* ---------------- wiring ---------------- */
document.querySelectorAll("[data-boost]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const type = btn.dataset.boost;
    await boost(type);
    const b = BOOSTS[type];
    flash(b.cls, boostText(b.ms));
    bump();
    blip(b.ms >= 30000);
  });
});

$("undoBtn").addEventListener("click", async () => {
  const r = await api("/api/undo", {});
  if (r.ok) { flash("sub", "UNDO"); blip(false); }
});
$("startNow").addEventListener("click", () => api("/api/start", {}));
$("resetBtn").addEventListener("click", async () => {
  if (!confirm("Reset to a fresh 24h? This clears all boosts and activity.")) return;
  await api("/api/reset", {});
});

$("startAt").addEventListener("change", async (e) => {
  if (!e.target.value) return;
  const r = await api("/api/settings", { startAt: e.target.value });
  if (r && r.ok === false) flash("like", "START: " + (r.error || "rejected"));
});

$("soundBtn").addEventListener("click", () => {
  sound = !sound;
  localStorage.setItem("emilli.sound", sound ? "on" : "off");
  $("soundBtn").textContent = `SOUND: ${sound ? "ON" : "OFF"}`;
  $("soundBtn").setAttribute("aria-pressed", String(sound));
  if (sound) blip(false);
});

function openOverlay() {
  window.open("/overlay.html", "emilliOverlay", "width=1280,height=720,menubar=no,toolbar=no");
}
$("overlayBtn").addEventListener("click", openOverlay);

$("obsStart").addEventListener("click", async () => {
  const r = await api("/api/obs/start", {});
  flash(r.ok ? "sub" : "like", r.ok ? "OBS: GO LIVE" : "OBS: " + (r.error || "failed"));
});
$("obsStop").addEventListener("click", async () => {
  const r = await api("/api/obs/stop", {});
  flash(r.ok ? "kofi" : "like", r.ok ? "OBS: STREAM ENDED" : "OBS: " + (r.error || "failed"));
});

$("ytCheck").addEventListener("click", async () => {
  $("ytCheck").disabled = true;
  const r = await api("/api/youtube/check", {});
  if (!r.ok) flash("like", "YT: " + (r.error || r.skipped || "failed"));
  else flash("sub", "YT SYNC OK");
  $("ytCheck").disabled = false;
});

$("ytUltra").addEventListener("click", async () => {
  const ok = confirm(
    "End this broadcast and start a new one with Ultra-low latency?\n\n" +
      "The current live link becomes the replay — the new stream gets a new link. " +
      "@EmilliFTL/live always follows whatever is live."
  );
  if (!ok) return;
  const r = await api("/api/youtube/restart", { latency: "ultraLow" });
  if (!r.ok) flash("like", "SWITCH: " + (r.error || "failed"));
  else flash("kofi", "SWITCHING TO ULTRA-LOW…");
});

$("autoUltra").addEventListener("click", async () => {
  const on = !((state.integrations.youtube || {}).autoUltra || {}).enabled;
  const r = await api("/api/youtube/auto-ultra", { enabled: on });
  if (!r.ok) flash("like", "AUTO ULTRA: " + (r.error || "failed"));
  else flash(on ? "kofi" : "sub", on ? "AUTO ULTRA-LOW ON" : "AUTO ULTRA-LOW OFF");
});

$("pinSend").addEventListener("click", async () => {
  const text = $("pinText").value.trim();
  if (!text) return flash("like", "PIN: type the message first");
  $("pinSend").disabled = true;
  const r = await api("/api/youtube/chat", { text, save: true });
  $("pinSend").disabled = false;
  if (!r.ok) flash("like", "PIN: " + (r.error || "failed"));
  else flash("kofi", "NOTE POSTED — PIN IT IN STUDIO");
});

$("pinAuto").addEventListener("click", async () => {
  const on = !((state.integrations.youtube || {}).pin || {}).auto;
  const r = await api("/api/youtube/pin", { auto: on });
  if (!r.ok) flash("like", "AUTO PIN: " + (r.error || "failed"));
  else flash(on ? "kofi" : "sub", on ? "AUTO PIN NOTE ON" : "AUTO PIN NOTE OFF");
});

$("apkCopy").addEventListener("click", async () => {
  const apk = (state.integrations.youtube || {}).apk || {};
  const url = apk.page || "https://emilli-remote-apk-rc7iae.freebuff.site/";
  try {
    await navigator.clipboard.writeText(url);
    flash("sub", "APK LINK COPIED");
  } catch {
    flash("like", url);
  }
});

$("copyLink").addEventListener("click", async () => {  const link = $("permLink").href;
  try {
    await navigator.clipboard.writeText(link);
    flash("sub", "LIVE LINK COPIED");
  } catch {
    // The clipboard API needs https or localhost; over the tunnel address the
    // old execCommand path is the only thing that still works.
    const ta = document.createElement("textarea");
    ta.value = link;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    flash("sub", ok ? "LIVE LINK COPIED" : "copy blocked — select the link");
  }
});

$("testSub").addEventListener("click", () => boost("sub", true));
$("testKofi").addEventListener("click", () => boost("kofi", true));
$("testLike").addEventListener("click", () => boost("like", true));

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  const k = e.key.toLowerCase();
  if (k === "s") document.querySelector('[data-boost="sub"]').click();
  else if (k === "d") document.querySelector('[data-boost="kofi"]').click();
  else if (k === "l") document.querySelector('[data-boost="like"]').click();
  else if (k === "z") $("undoBtn").click();
  else if (k === "o") openOverlay();
});

/* ---------------- live stream ---------------- */
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    state = JSON.parse(e.data);
    offset = state.serverNow - Date.now();
    render();
  });
  es.addEventListener("message", (e) => {
    const n = JSON.parse(e.data);
    if (n.state) {
      state = n.state;
      offset = state.serverNow - Date.now();
      render();
    }
    if (n.kind === "boost" && n.source !== "manual") {
      // boost came from Ko-fi or YouTube: surface it here too
      const b = BOOSTS[n.type];
      if (b) {
        flash(b.cls, `${n.type === "kofi" ? n.amountText || "DONO" : b.label} ${boostText(n.amountMs)}`);
        bump();
        blip(b.ms >= 30000);
      }
    }
  });
  es.onerror = () => {
    $("statusChip").textContent = "RECONNECTING";
    $("statusChip").className = "chip over";
  };
}

$("soundBtn").textContent = `SOUND: ${sound ? "ON" : "OFF"}`;
$("soundBtn").setAttribute("aria-pressed", String(sound));

api("/api/state").then(() => { connect(); loadMix(); });
setInterval(render, 200);
