/**
 * BRB overlay texts.
 *
 * The overlay (brb.html) used to have a single hard-coded sentence. The texts
 * now live in brb.json so the phone app can edit them and add new ones, each
 * with one of the animation presets the overlay knows how to draw.
 *
 * Order matters: the overlay shows one text at a time and cycles through them.
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "brb.json");
const MAX_LEN = 120;
const PRESETS = ["rainbow-wiggle", "trans-gradient", "shaky", "glow", "pulse", "plain"];
const DEFAULT = {
  seconds: 8,
  items: [{ id: "brb-default", text: "im at work brb later!", preset: "rainbow-wiggle" }],
};

function createBrb(log = () => {}) {
  let data = load();

  function cleanText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  }

  function cleanPreset(value) {
    const p = String(value || "");
    return PRESETS.includes(p) ? p : "rainbow-wiggle";
  }

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      const items = (j.items || [])
        .map((it) => ({ id: String(it.id || ""), text: cleanText(it.text), preset: cleanPreset(it.preset) }))
        .filter((it) => it.id && it.text);
      return {
        seconds: Math.max(3, Math.min(60, Number(j.seconds) || DEFAULT.seconds)),
        items: items.length ? items : DEFAULT.items.slice(),
      };
    } catch {
      return { seconds: DEFAULT.seconds, items: DEFAULT.items.slice() };
    }
  }

  function save() {
    try {
      fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      log(`[brb] could not write brb.json: ${e.message}`);
    }
  }

  function newId() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  }

  return {
    presets: PRESETS,

    data() {
      return { seconds: data.seconds, presets: PRESETS, items: data.items.map((it) => ({ ...it })) };
    },

    summary() {
      return {
        seconds: data.seconds,
        items: data.items.map((it) => ({ id: it.id, text: it.text, preset: it.preset })),
      };
    },

    add(text, preset) {
      const t = cleanText(text);
      if (!t) return { ok: false, error: "the text is empty" };
      const item = { id: newId(), text: t, preset: cleanPreset(preset) };
      data.items.push(item);
      save();
      return { ok: true, item, brb: this.summary() };
    },

    update(id, text, preset) {
      const item = data.items.find((it) => it.id === id);
      if (!item) return { ok: false, error: "that text is gone — reload the tab" };
      const t = cleanText(text);
      if (!t) return { ok: false, error: "the text is empty" };
      item.text = t;
      if (preset) item.preset = cleanPreset(preset);
      save();
      return { ok: true, item: { ...item }, brb: this.summary() };
    },

    remove(id) {
      const before = data.items.length;
      data.items = data.items.filter((it) => it.id !== id);
      if (data.items.length === before) return { ok: false, error: "that text is already gone" };
      save();
      return { ok: true, brb: this.summary() };
    },

    move(id, delta) {
      const from = data.items.findIndex((it) => it.id === id);
      if (from < 0) return { ok: false, error: "that text is gone" };
      const to = Math.max(0, Math.min(data.items.length - 1, from + (Number(delta) || 0)));
      if (to === from) return { ok: true, brb: this.summary() };
      const [item] = data.items.splice(from, 1);
      data.items.splice(to, 0, item);
      save();
      return { ok: true, brb: this.summary() };
    },
  };
}

module.exports = { createBrb, PRESETS };
