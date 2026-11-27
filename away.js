/**
 * The away timer.
 *
 * "at work", "sleeping", "busy" — one reason and the time it ends, so viewers
 * know when to come back. The phone remote sets it, /api/state carries it, and
 * the BRB overlay counts down to it.
 *
 * It is a one-shot timer, not a schedule: it expires by itself, and nothing is
 * shown while it is off (or once its end time has passed).
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "away.json");
const MAX_REASON = 60;
const MAX_MINUTES = 24 * 60;
const PRESETS = ["at work", "sleeping", "busy"];

function createAway(log = () => {}) {
  let data = load();

  function cleanReason(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
  }

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      const until = Number(j.until);
      return {
        reason: cleanReason(j.reason),
        until: Number.isFinite(until) && until > 0 ? until : 0,
      };
    } catch {
      return { reason: "", until: 0 };
    }
  }

  function save() {
    try {
      fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      log(`[away] could not write away.json: ${e.message}`);
    }
  }

  /** What the remote and the overlay see. An expired timer is simply off. */
  function summary() {
    const now = Date.now();
    const active = data.until > now;
    return {
      active,
      reason: active ? data.reason : "",
      until: active ? data.until : 0,
      remainingMs: active ? data.until - now : 0,
    };
  }

  return {
    presets: PRESETS,

    data() {
      return { ...summary(), presets: PRESETS };
    },

    summary,

    /**
     * `until` (an absolute end time, from the phone's time picker) wins when it
     * is in the future; otherwise `minutes` counts from now. Both are clamped so
     * a typo cannot hide the stream for a week.
     */
    set(reason, minutes, until) {
      const now = Date.now();
      const end = Number(until);
      let endAt = 0;
      if (Number.isFinite(end) && end > now) {
        endAt = Math.min(end, now + MAX_MINUTES * 60 * 1000);
      } else {
        const mins = Number(minutes);
        const m = Number.isFinite(mins) && mins > 0 ? Math.min(mins, MAX_MINUTES) : 60;
        endAt = now + Math.round(m * 60 * 1000);
      }
      data = { reason: cleanReason(reason) || "away", until: endAt };
      save();
      log(`[away] ${data.reason} until ${new Date(endAt).toLocaleString()}`);
      return { ok: true, away: summary() };
    },

    clear() {
      data = { reason: "", until: 0 };
      save();
      log("[away] cleared");
      return { ok: true, away: summary() };
    },
  };
}

module.exports = { createAway, PRESETS };
