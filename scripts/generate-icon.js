// Generates a 128x128 PNG icon (extension/icon.png): a minimal finite-state-
// machine motif (two states + a transition arrow and a self-loop) on a modern
// blue->indigo gradient with rounded corners. Rendered at 4x and box-downsampled
// for anti-aliasing, then PNG-encoded via zlib (no external image libraries).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 128;
const S = 4;
const BIG = SIZE * S; // 512
const buf = new Float64Array(BIG * BIG * 4); // straight-alpha RGBA, 0..255

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function comp(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= BIG || y >= BIG || a <= 0) return;
  const i = (y * BIG + x) * 4;
  const ia = 1 - a;
  buf[i] = r * a + buf[i] * ia;
  buf[i + 1] = g * a + buf[i + 1] * ia;
  buf[i + 2] = b * a + buf[i + 2] * ia;
  buf[i + 3] = clamp(a * 255 + buf[i + 3] * ia, 0, 255);
}

// Signed distance helpers
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function fillBackground() {
  const rad = BIG * 0.17; // corner radius
  for (let y = 0; y < BIG; y++) {
    for (let x = 0; x < BIG; x++) {
      // rounded-rect coverage
      const rx = Math.max(rad - x, x - (BIG - 1 - rad), 0);
      const ry = Math.max(rad - y, y - (BIG - 1 - rad), 0);
      if (Math.hypot(rx, ry) > rad) continue;
      const t = y / BIG;
      const r = lerp(88, 58, t);
      const g = lerp(133, 66, t);
      const b = lerp(246, 178, t);
      comp(x, y, r, g, b, 1);
    }
  }
}

// White ring (state node)
function ring(cx, cy, radius, half) {
  const x0 = Math.floor(cx - radius - half), x1 = Math.ceil(cx + radius + half);
  const y0 = Math.floor(cy - radius - half), y1 = Math.ceil(cy + radius + half);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - radius);
      if (d <= half) comp(x, y, 255, 255, 255, 1);
    }
}

function thickSeg(ax, ay, bx, by, half) {
  const x0 = Math.floor(Math.min(ax, bx) - half), x1 = Math.ceil(Math.max(ax, bx) + half);
  const y0 = Math.floor(Math.min(ay, by) - half), y1 = Math.ceil(Math.max(ay, by) + half);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (distSeg(x, y, ax, ay, bx, by) <= half) comp(x, y, 255, 255, 255, 1);
}

function arrowHead(tipx, tipy, angle, size) {
  const a1 = angle + Math.PI * 0.82;
  const a2 = angle - Math.PI * 0.82;
  const p1 = [tipx + size * Math.cos(a1), tipy + size * Math.sin(a1)];
  const p2 = [tipx + size * Math.cos(a2), tipy + size * Math.sin(a2)];
  // filled triangle via barycentric coverage
  const minx = Math.floor(Math.min(tipx, p1[0], p2[0])), maxx = Math.ceil(Math.max(tipx, p1[0], p2[0]));
  const miny = Math.floor(Math.min(tipy, p1[1], p2[1])), maxy = Math.ceil(Math.max(tipy, p1[1], p2[1]));
  const area = (p1[0] - tipx) * (p2[1] - tipy) - (p2[0] - tipx) * (p1[1] - tipy);
  for (let y = miny; y <= maxy; y++)
    for (let x = minx; x <= maxx; x++) {
      const w0 = ((p1[0] - tipx) * (y - tipy) - (x - tipx) * (p1[1] - tipy)) / area;
      const w1 = ((x - tipx) * (p2[1] - tipy) - (p2[0] - tipx) * (y - tipy)) / area;
      if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) comp(x, y, 255, 255, 255, 1);
    }
}

// --- compose the icon ---
fillBackground();

const stroke = BIG * 0.028;
// State A (upper-left), State B (lower-right)
const A = { x: BIG * 0.34, y: BIG * 0.36, r: BIG * 0.135 };
const B = { x: BIG * 0.66, y: BIG * 0.66, r: BIG * 0.135 };
ring(A.x, A.y, A.r, stroke);
ring(B.x, B.y, B.r, stroke);

// Transition arrow A -> B (from edge to edge)
const ang = Math.atan2(B.y - A.y, B.x - A.x);
const sx = A.x + Math.cos(ang) * A.r, sy = A.y + Math.sin(ang) * A.r;
const ex = B.x - Math.cos(ang) * (B.r + stroke * 1.5), ey = B.y - Math.sin(ang) * (B.r + stroke * 1.5);
thickSeg(sx, sy, ex, ey, stroke * 0.9);
arrowHead(ex + Math.cos(ang) * stroke, ey + Math.sin(ang) * stroke, ang, BIG * 0.06);

// Self-loop on state A (a small arc above it, drawn as a partial ring)
(function selfLoop() {
  const lc = { x: A.x, y: A.y - A.r - BIG * 0.06, r: BIG * 0.06 };
  const half = stroke * 0.9;
  for (let y = Math.floor(lc.y - lc.r - half); y <= Math.ceil(lc.y + lc.r + half); y++)
    for (let x = Math.floor(lc.x - lc.r - half); x <= Math.ceil(lc.x + lc.r + half); x++) {
      const d = Math.abs(Math.hypot(x - lc.x, y - lc.y) - lc.r);
      const a = Math.atan2(y - lc.y, x - lc.x);
      if (d <= half && a > -Math.PI * 0.95 && a < Math.PI * 0.55) comp(x, y, 255, 255, 255, 1);
    }
  arrowHead(lc.x + lc.r * Math.cos(Math.PI * 0.55), lc.y + lc.r * Math.sin(Math.PI * 0.55), Math.PI * 1.05, BIG * 0.045);
})();

// --- downsample BIG -> SIZE (box filter) ---
const out = Buffer.alloc(SIZE * (1 + SIZE * 4));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  out[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const i = ((y * S + dy) * BIG + (x * S + dx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
      }
    const n = S * S;
    out[p++] = Math.round(r / n);
    out[p++] = Math.round(g / n);
    out[p++] = Math.round(b / n);
    out[p++] = Math.round(a / n);
  }
}

// --- PNG encode ---
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const dest = path.join(__dirname, '..', 'icon.png');
fs.writeFileSync(dest, png);
console.log(`wrote ${dest} (${png.length} bytes, ${SIZE}x${SIZE})`);
