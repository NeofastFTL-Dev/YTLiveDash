/**
 * The away timer.
 *
 * Two ways to say "gone, back at X":
 *   - a one-shot timer set by hand ("outside", 2 hours), and
 *   - a weekly schedule of shifts ("Mon–Fri 09:00–17:00 at work"), which sets
 *     itself every morning without anyone touching the phone.
 *
 * The phone remote sets both, /api/state carries the result, and the BRB
 * overlay counts down to it. A manual timer wins while it is running; the
 * schedule takes over again once it expires. Nothing is shown when neither is
 * active, and a shift is over at its end time, not a minute later.
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "away.json");
const MAX_REASON = 60;
const MAX_MINUTES = 24 * 60;
const MAX_SHIFTS = 20;
const PRESETS = ["at work", "outside", "sleeping", "busy"];

function createAway(log = () => {}) {
  let data = load();

  function cleanReason(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
  }

  /** "09:00" → minutes past midnight, or -1 when it is not a time. */
  function minutesOf(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!m) return -1;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return -1;
    return h * 60 + min;
  }

  function clockText(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  function newId() {
    return Math.random().toString(36).slice(2, 8);
  }

  /** One schedule row, or null when it could not be understood. */
  function cleanShift(raw) {
    const days = Array.isArray(raw && raw.days)
      ? raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    const unique = [...new Set(days)].sort();
    const start = minutesOf(raw && raw.start);
    const end = minutesOf(raw && raw.end);
    if (unique.length === 0 || start < 0 || end < 0 || start === end) return null;
    const id = String((raw && raw.id) || "").replace(/[^a-z0-9]/gi, "").slice(0, 12);
    return {
      id: id || newId(),
      days: unique,
      start: clockText(start),
      end: clockText(end),
      reason: cleanReason(raw && raw.reason) || "at work",
    };
  }

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      const until = Number(j.until);
      const schedule = Array.isArray(j.schedule) ? j.schedule.map(cleanShift).filter(Boolean) : [];
      return {
        reason: cleanReason(j.reason),
        until: Number.isFinite(until) && until > 0 ? until : 0,
        schedule,
      };
    } catch {
      return { reason: "", until: 0, schedule: [] };
    }
  }

  function save() {
    try {
      fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      log(`[away] could not write away.json: ${e.message}`);
    }
  }

  /**
   * The shift covering `now`, if any. A block is [start, end): at 17:00 sharp
   * the timer is off again. A block may cross midnight (22:00–06:00), which is
   * why yesterday's rows are checked as well.
   */
  function activeShift(now) {
    const d = new Date(now);
    const today = d.getDay();
    const minutes = d.getHours() * 60 + d.getMinutes();
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    for (const shift of data.schedule) {
      const start = minutesOf(shift.start);
      const end = minutesOf(shift.end);
      if (start < 0 || end < 0) continue;
      if (end > start) {
        if (shift.days.includes(today) && minutes >= start && minutes < end) {
          return { shift, until: midnight + end * 60000 };
        }
      } else {
        // starts today, runs into tomorrow
        if (shift.days.includes(today) && minutes >= start) {
          return { shift, until: midnight + end * 60000 + 24 * 60 * 60000 };
        }
        // started yesterday, ends later today
        if (shift.days.includes((today + 6) % 7) && minutes < end) {
          return { shift, until: midnight + end * 60000 };
        }
      }
    }
    return null;
  }

  /** What the remote and the overlay see. An expired timer is simply off. */
  function summary() {
    const now = Date.now();
    const manual = data.until > now;
    const shift = manual ? null : activeShift(now);
    const until = manual ? data.until : shift ? shift.until : 0;
    return {
      active: manual || !!shift,
      reason: manual ? data.reason : shift ? shift.shift.reason : "",
      until: until || 0,
      remainingMs: until ? Math.max(0, until - now) : 0,
      // "manual" is a timer set by hand, "schedule" a shift that is on now.
      source: manual ? "manual" : shift ? "schedule" : "",
      shiftId: shift ? shift.shift.id : "",
      schedule: data.schedule.slice(),
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
      data = { ...data, reason: cleanReason(reason) || "away", until: endAt };
      save();
      log(`[away] ${data.reason} until ${new Date(endAt).toLocaleString()}`);
      return { ok: true, away: summary() };
    },

    clear() {
      data = { ...data, reason: "", until: 0 };
      save();
      log("[away] cleared");
      return { ok: true, away: summary() };
    },

    /** Add one weekly shift: days are JS weekdays (0 = Sunday). */
    addShift(raw) {
      const shift = cleanShift(raw);
      if (!shift) return { ok: false, error: "pick at least one day, plus a start and an end time" };
      if (data.schedule.length >= MAX_SHIFTS) return { ok: false, error: `at most ${MAX_SHIFTS} shifts` };
      data.schedule.push(shift);
      save();
      log(`[away] shift ${shift.days.join(",")} ${shift.start}-${shift.end} ${shift.reason}`);
      return { ok: true, shift, schedule: data.schedule.slice(), away: summary() };
    },

    removeShift(id) {
      const before = data.schedule.length;
      data.schedule = data.schedule.filter((s) => s.id !== String(id || ""));
      if (data.schedule.length === before) return { ok: false, error: "no such shift" };
      save();
      log(`[away] shift ${id} removed`);
      return { ok: true, schedule: data.schedule.slice(), away: summary() };
    },
  };
}

module.exports = { createAway, PRESETS };
