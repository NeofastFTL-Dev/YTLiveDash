'use strict';
/**
 * Tiny software renderer for Stream Deck keys (72x72 RGBA).
 * No image libraries: pixels are written straight into a buffer, and PNG
 * output for the preview contact sheets is encoded by hand with zlib.
 */
const zlib = require('node:zlib');

const FONT = {
  A: ['010', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'],
  H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
  J: ['001', '001', '001', '101', '010'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['110', '101', '101', '101', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  Q: ['010', '101', '101', '110', '011'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'],
  V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  Z: ['111', '001', '010', '100', '111'],
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '011', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  ' ': ['000', '000', '000', '000', '000'],
  ':': ['000', '010', '000', '010', '000'],
  '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000'],
  '+': ['000', '010', '111', '010', '000'],
  '/': ['001', '001', '010', '100', '100'],
  '<': ['001', '010', '100', '010', '001'],
  '>': ['100', '010', '001', '010', '100'],
  '!': ['010', '010', '010', '000', '010'],
  '#': ['101', '111', '101', '111', '101'],
};

function canvas(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

function fill(c, col) {
  const [r, g, b, a = 255] = col;
  for (let i = 0; i < c.data.length; i += 4) {
    c.data[i] = r;
    c.data[i + 1] = g;
    c.data[i + 2] = b;
    c.data[i + 3] = a;
  }
}

function rect(c, x, y, w, h, col) {
  const [r, g, b, a = 255] = col;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(c.w, Math.round(x + w));
  const y1 = Math.min(c.h, Math.round(y + h));
  for (let py = y0; py < y1; py++) {
    let i = (py * c.w + x0) * 4;
    for (let px = x0; px < x1; px++) {
      c.data[i] = r;
      c.data[i + 1] = g;
      c.data[i + 2] = b;
      c.data[i + 3] = a;
      i += 4;
    }
  }
}

/** Filled rectangle with rounded corners. */
function roundRect(c, x, y, w, h, radius, col) {
  rect(c, x + radius, y, w - radius * 2, h, col);
  rect(c, x, y + radius, radius, h - radius * 2, col);
  rect(c, x + w - radius, y + radius, radius, h - radius * 2, col);
  for (let dy = 0; dy < radius; dy++) {
    for (let dx = 0; dx < radius; dx++) {
      const inside = (radius - 0.5 - dx) ** 2 + (radius - 0.5 - dy) ** 2 <= radius * radius;
      if (!inside) continue;
      rect(c, x + radius - dx, y + radius - dy, 1, 1, col);
      rect(c, x + w - radius + dx - 1, y + radius - dy, 1, 1, col);
      rect(c, x + radius - dx, y + h - radius + dy - 1, 1, 1, col);
      rect(c, x + w - radius + dx - 1, y + h - radius + dy - 1, 1, 1, col);
    }
  }
}

/** Outline only, rounded. */
function stroke(c, x, y, w, h, radius, thickness, col) {
  const inner = canvas(w, h);
  roundRect(inner, 0, 0, w, h, radius, col);
  const hole = canvas(w, h);
  roundRect(hole, thickness, thickness, w - thickness * 2, h - thickness * 2, Math.max(0, radius - thickness), col);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      if (inner.data[i + 3] && !hole.data[i + 3]) {
        const tx = Math.round(x) + px;
        const ty = Math.round(y) + py;
        if (tx >= 0 && ty >= 0 && tx < c.w && ty < c.h) {
          const j = (ty * c.w + tx) * 4;
          c.data[j] = col[0];
          c.data[j + 1] = col[1];
          c.data[j + 2] = col[2];
          c.data[j + 3] = col[3] === undefined ? 255 : col[3];
        }
      }
    }
  }
}

function textWidth(str, scale) {
  return str.length * 4 * scale - scale;
}

/** 3x5 bitmap text, `scale` pixels per font pixel. */
function text(c, str, x, y, scale, col) {
  let cx = Math.round(x);
  const s = String(str).toUpperCase();
  for (const ch of s) {
    const glyph = FONT[ch] || FONT[' '];
    for (let row = 0; row < 5; row++) {
      for (let colIdx = 0; colIdx < 3; colIdx++) {
        if (glyph[row][colIdx] === '1') rect(c, cx + colIdx * scale, y + row * scale, scale, scale, col);
      }
    }
    cx += 4 * scale;
  }
}

function textCenter(c, str, y, scale, col) {
  text(c, str, (c.w - textWidth(str, scale)) / 2, y, scale, col);
}

/** Splits a label into at most `maxLines` lines that fit `maxChars`. */
function wrap(str, maxChars, maxLines) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? line + ' ' + w : w;
    if (candidate.length <= maxChars) line = candidate;
    else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = kept[maxLines - 1].slice(0, maxChars);
  return kept;
}

const SEGMENTS = {
  0: 'abcdef',
  1: 'bc',
  2: 'abged',
  3: 'abgcd',
  4: 'fgbc',
  5: 'afgcd',
  6: 'afgedc',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcdfg',
};

/** One seven-segment digit. */
function digit(c, x, y, w, h, t, value, col) {
  const on = SEGMENTS[value] || '';
  const midY = y + (h - t) / 2;
  const half = (h - 3 * t) / 2;
  const segs = {
    a: [x + t, y, w - 2 * t, t],
    b: [x + w - t, y + t, t, half],
    c: [x + w - t, midY + t, t, half],
    d: [x + t, y + h - t, w - 2 * t, t],
    e: [x, midY + t, t, half],
    f: [x, y + t, t, half],
    g: [x + t, midY, w - 2 * t, t],
  };
  for (const key of Object.keys(segs)) {
    if (on.includes(key)) rect(c, segs[key][0], segs[key][1], segs[key][2], segs[key][3], col);
  }
}

function line(c, x0, y0, x1, y1, col) {
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    rect(c, x, y, 1, 1, col);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/* ------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function toPNG(c) {
  const stride = c.w * 4;
  const raw = Buffer.alloc((stride + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(c.data.buffer, c.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  canvas,
  fill,
  rect,
  roundRect,
  stroke,
  text,
  textCenter,
  textWidth,
  wrap,
  digit,
  line,
  toPNG,
};
