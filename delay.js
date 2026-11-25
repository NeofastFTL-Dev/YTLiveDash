#!/usr/bin/env node
/**
 * Real end-to-end stream delay, in one command.
 *
 * The latency clock (latency-clock.html) is burned into the stream by OBS, so
 * every frame a viewer sees carries its own timestamp. This screenshots the
 * screen that is playing the stream, OCRs that burned-in clock, and subtracts
 * it from the local clock at the moment of capture. The result includes
 * encoder, YouTube's processing and player buffering — which is what "the
 * delay" actually means.
 *
 *   node delay.js                          full screen
 *   node delay.js --region 0,880,760,320   crop that rectangle out of it
 *   node delay.js --image shot.png         OCR a screenshot you already took
 *   node delay.js --keep                   keep delay-shot.png next to this file
 *
 * Needs tesseract (OCR) and one screenshot tool: spectacle (KDE), grim
 * (wlroots), gnome-screenshot or scrot. Only the burned-in clock is trusted —
 * a player UI shows a position, and a taskbar clock is not the stream.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = __dirname;
const CLOCK_SECONDS = 1; // the overlay renders whole seconds → ±1 s quantization
// A viewer's picture can never be ahead of the streamer, YouTube cannot deliver
// in under a second (that reading is OBS's own preview, which is not delayed),
// and nothing sane is minutes behind. Anything outside this is another clock.
const PLAUSIBLE = { min: 1.5, max: 600 };

/* ------------------------------------------------------------------- args */

const opts = { region: null, image: null, keep: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--region") {
    const parts = String(argv[++i] || "").split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
      console.error("--region wants x,y,width,height (all positive)");
      process.exit(2);
    }
    opts.region = parts;
  } else if (a === "--image") {
    opts.image = path.resolve(argv[++i] || "");
  } else if (a === "--keep") {
    opts.keep = true;
  } else if (a === "-h" || a === "--help") {
    console.log("usage: node delay.js [--region x,y,w,h] [--image shot.png] [--keep]");
    process.exit(0);
  } else {
    console.error(`unknown option: ${a}`);
    process.exit(2);
  }
}

/* ---------------------------------------------------------------- capture */

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function has(bin) {
  try {
    return spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// Ordered by how likely each one is to work unprivileged on a Wayland desktop.
const SHOT_TOOLS = [
  { bin: "spectacle", args: (out) => ["-b", "-n", "-f", "-o", out] },
  { bin: "grim", args: (out) => [out] },
  { bin: "gnome-screenshot", args: (out) => ["-f", out] },
  { bin: "scrot", args: (out) => ["-o", out] },
];

/**
 * Grab the screen. The frame is frozen somewhere between the spawn and the
 * first byte of the PNG, so that interval — not the whole write — brackets the
 * capture. t0..tFirst is what the timestamp is taken from.
 */
function capture(out) {
  const tool = SHOT_TOOLS.find((t) => has(t.bin));
  if (!tool) {
    throw new Error(
      "no screenshot tool found — install spectacle (KDE), grim, gnome-screenshot or scrot"
    );
  }
  fs.rmSync(out, { force: true });
  const t0 = Date.now();
  const r = spawnSync(tool.bin, tool.args(out), { timeout: 25000, encoding: "utf8" });
  if (r.error) throw new Error(`${tool.bin}: ${r.error.message}`);

  const giveUp = Date.now() + 20000;
  while (Date.now() < giveUp) {
    let size = 0;
    try {
      size = fs.statSync(out).size;
    } catch {
      size = 0;
    }
    if (size > 0) {
      const tFirst = Date.now();
      // Let the encoder finish so tesseract gets a complete PNG.
      let last = size;
      const done = Date.now() + 15000;
      while (Date.now() < done) {
        sleep(120);
        let next = 0;
        try {
          next = fs.statSync(out).size;
        } catch {
          next = 0;
        }
        if (next > 0 && next === last) break;
        last = next;
      }
      return { t0, tFirst, tool: tool.bin };
    }
    sleep(60);
  }
  throw new Error(`${tool.bin} did not write a screenshot${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
}

/** Crop with ffmpeg (keeps the dependency list at two tools). */
function crop(file, [x, y, w, h]) {
  const out = file.replace(/\.png$/i, "-crop.png");
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", `crop=${w}:${h}:${x}:${y}`, out],
    { encoding: "utf8" }
  );
  if (r.error || r.status !== 0) {
    throw new Error(`ffmpeg crop failed${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
  }
  return out;
}

/** PNG header only — the size decides what counts as a big clock. */
function imageSize(file) {
  try {
    const b = fs.readFileSync(file).subarray(0, 24);
    if (b.slice(1, 4).toString("latin1") !== "PNG") return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- ocr */

function ocr(file) {
  const r = spawnSync("tesseract", ["-l", "eng", file, "stdout", "--psm", "11", "tsv"], {
    encoding: "utf8",
    timeout: 90000,
  });
  if (r.error) throw new Error("tesseract not found — install tesseract-ocr");
  if (r.status !== 0) throw new Error(`tesseract failed: ${(r.stderr || "").trim()}`);
  return r.stdout || "";
}

// Monospace digits survive OCR, but O/l/I creep in and nothing else in the
// clock card can be mistaken for them.
const fixDigits = (s) => String(s).replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");

/**
 * Pull the epoch line and the HH:MM:SS clock out of the TSV.
 *
 * Words are grouped back into their text line first: OCR splits "12:44: 39"
 * into two words, and neither half is a time on its own. The burned-in clock is
 * also the tallest clock-shaped line on screen, so a minimum height (relative
 * to the screenshot) keeps taskbar and OBS-stats clocks out of the answer.
 */
function findClock(tsv, minClockHeight) {
  const linesById = new Map();
  const words = [];
  for (const line of tsv.split("\n").slice(1)) {
    const c = line.split("\t");
    const text = (c[11] || "").trim();
    if (!text) continue;
    const id = `${c[2]}:${c[3]}:${c[4]}`;
    const h = Number(c[9]) || 0;
    const entry = linesById.get(id) || { text: "", h: 0 };
    entry.text += text;
    entry.h = Math.max(entry.h, h);
    linesById.set(id, entry);
    words.push({ text, h, left: Number(c[6]) || 0, top: Number(c[7]) || 0 });
  }

  let epoch = null;
  let clock = null;
  for (const { text, h } of linesById.values()) {
    const t = fixDigits(text).replace(/\s+/g, "");
    const e = /(\d{10})/.exec(t);
    if (e && Number(e[1]) > 1500000000 && (!epoch || h > epoch.h)) {
      epoch = { value: Number(e[1]), h };
    }
    const m = /^(\d{2})[:.](\d{2})[:.](\d{2})$/.exec(t);
    if (m && h >= minClockHeight) {
      const hms = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (hms[0] < 24 && hms[1] < 60 && hms[2] < 60 && (!clock || h > clock.h)) {
        clock = { h, hms };
      }
    }
  }
  return { epoch, clock, words };
}

/* ------------------------------------------------------------------ delay */

const hmsText = (hms) => hms.map((n) => String(n).padStart(2, "0")).join(":");

function delayFrom(found, captureMs) {
  const out = {};
  if (found.epoch) {
    out.epochDelay = captureMs / 1000 - found.epoch.value;
    out.epochValue = found.epoch.value;
  }
  if (found.clock) {
    const shown = new Date(captureMs);
    shown.setHours(found.clock.hms[0], found.clock.hms[1], found.clock.hms[2], 0);
    let delay = (captureMs - shown.getTime()) / 1000;
    // The clock carries no date: a delay past half a day means it rolled over
    // at midnight, not that the stream is 24 hours behind.
    if (delay > 43200) delay -= 86400;
    if (delay < -43200) delay += 86400;
    out.clockDelay = delay;
    out.clockHms = found.clock.hms;
  }
  // The epoch line is exact, so it wins — but only if it reads sensibly. One
  // misread digit moves it by years, and a good clock reading must survive that.
  const sane = (v) => v != null && v >= PLAUSIBLE.min && v <= PLAUSIBLE.max;
  if (sane(out.epochDelay)) {
    out.delay = out.epochDelay;
    out.source = `epoch ${out.epochValue}`;
  } else if (sane(out.clockDelay)) {
    out.delay = out.clockDelay;
    out.source = `clock ${hmsText(out.clockHms)}`;
    if (out.epochDelay != null) out.epochIgnored = true;
  } else if (out.epochDelay != null) {
    // Both readings exist but neither is believable: keep them so main can say
    // why it is refusing instead of claiming no clock was found.
    out.delay = out.epochDelay;
    out.source = `epoch ${out.epochValue}`;
  } else if (out.clockDelay != null) {
    out.delay = out.clockDelay;
    out.source = `clock ${hmsText(out.clockHms)}`;
  }
  return out.delay == null ? null : out;
}

/* ------------------------------------------------------------------- main */

function main() {
  const out = opts.keep
    ? path.join(ROOT, "delay-shot.png")
    : path.join(os.tmpdir(), `emilli-delay-${process.pid}.png`);

  let file;
  let t0;
  let tFirst;
  let tool;
  if (opts.image) {
    if (!fs.existsSync(opts.image)) throw new Error(`no such file: ${opts.image}`);
    file = opts.image;
    // A screenshot taken by hand carries its capture time in the mtime.
    t0 = tFirst = fs.statSync(file).mtimeMs;
    tool = "existing";
  } else {
    ({ t0, tFirst, tool } = capture(out));
    file = out;
    if (opts.region) file = crop(out, opts.region);
  }

  const size = imageSize(file);
  const minClockHeight = size ? Math.max(24, Math.round(size.h * 0.015)) : 24;
  const found = findClock(ocr(file), minClockHeight);
  const captureMs = (t0 + tFirst) / 2;
  const result = delayFrom(found, captureMs);

  const cleanup = () => {
    if (!opts.keep && !opts.image) {
      fs.rmSync(file, { force: true });
      if (file !== out) fs.rmSync(out, { force: true });
    }
  };

  if (!result) {
    const seen = found.words.map((w) => w.text).join(" ").slice(0, 160);
    console.error("no latency clock in that screenshot.");
    console.error(`  the digits have to be at least ${minClockHeight}px tall on screen;`);
    console.error("  is the clock on the stream?   node latency.js on");
    console.error("  is the player actually visible when the screenshot is taken?");
    if (seen) console.error(`  OCR saw: ${seen}`);
    cleanup();
    process.exit(1);
  }

  if (result.delay < PLAUSIBLE.min || result.delay > PLAUSIBLE.max) {
    console.error(`implausible reading: ${result.delay.toFixed(1)} s from ${result.source}.`);
    if (result.delay < PLAUSIBLE.min) {
      console.error("  that is faster than YouTube can deliver (ultra-low bottoms out near 2 s) —");
      console.error("  OBS's own preview window (not delayed), or another clock on screen.");
    } else {
      console.error("  that is some other clock on screen (taskbar, OBS stats dock, a terminal),");
      console.error("  or a stale --image.");
    }
    console.error("  frame the player with --region and try again.");
    cleanup();
    process.exit(1);
  }

  const window = Math.round(tFirst - t0);
  const taken = new Date(captureMs);
  // When the epoch decides it, show what the clock digits independently said:
  // agreement within a second is the proof the read is right.
  const both =
    result.source.startsWith("epoch") && result.clockDelay != null
      ? ` (clock said ${hmsText(result.clockHms)}, ${result.clockDelay.toFixed(1)} s)`
      : "";
  console.log(`stream delay: ${result.delay.toFixed(1)} s  (±${CLOCK_SECONDS} s, clock resolution)`);
  console.log(
    `  ${result.source}${both} · captured ${taken.toLocaleTimeString()} via ${tool}` +
      (window ? `, capture window ${window} ms` : "")
  );
  if (result.epochIgnored) console.log("  (the epoch line read implausibly, so the clock was used)");
  if (opts.keep) console.log(`  screenshot kept at ${path.relative(ROOT, file)}`);
  cleanup();
}

try {
  main();
} catch (e) {
  console.error(`delay: ${e.message}`);
  process.exit(1);
}
