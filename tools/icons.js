'use strict';
// The app icon: what an iPhone's Home Screen, an iPad's, or a Mac's Dock shows for the floor once it is
// added there (Share → Add to Home Screen in Safari; File → Add to Dock on a Mac). The page's own mark
// (public/desk.html), white on graphite with its core in the gain's green, drawn full bleed: the system
// rounds the corners itself. The colours are tokens.css's --icon-*, read from the file.
//
//   node tools/icons.js     writes public/apple-touch-icon.png (180), icon-192.png and icon-512.png
//
// No package draws it: each pixel is sixteen samples of the shapes, and the PNG is written with Node's
// own zlib. tools/tokens-test.js draws them again and checks the files on disk are these pixels.
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SIZES = { 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };

function colours(css = fs.readFileSync(path.join(ROOT, 'public/tokens.css'), 'utf8')) {
  const get = (k) => {
    const m = css.match(new RegExp(`--icon-${k}:\\s*#([0-9a-f]{6})\\s*;`, 'i'));
    if (!m) throw new Error(`tokens.css has no six-digit --icon-${k}`);
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  };
  return { top: get('top'), bottom: get('bottom'), glyph: get('glyph'), core: get('core') };
}

// the mark, desk.html's own points in its 40-unit box: two hexagons drawn as lines, and the core filled
const pts = (s) => s.split(' ').map((p) => p.split(',').map(Number));
const OUTER = { pts: pts('20,3 35,11.5 35,28.5 20,37 5,28.5 5,11.5'), width: 2.2, alpha: 1 };
const MIDDLE = { pts: pts('20,10 29,15 29,25 20,30 11,25 11,15'), width: 1.7, alpha: 0.7 };
const CORE = pts('20,15.5 24.5,18 24.5,22 20,24.5 15.5,22 15.5,18');

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const onLine = (x, y, { pts, width }) => pts.some((p, i) => segDist(x, y, p, pts[(i + 1) % pts.length]) <= width / 2);
function inside(x, y, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// RGB bytes, row by row. The mark takes 64% of the icon, inside the circle a masked icon keeps.
function draw(size, C = colours()) {
  const px = Buffer.alloc(size * size * 3), N = 4, box = size * 0.64, off = (size - box) / 2;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  for (let y = 0; y < size; y++) {
    const bg = mix(C.top, C.bottom, (y + 0.5) / size);
    for (let x = 0; x < size; x++) {
      let outer = 0, middle = 0, core = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const u = ((x + (sx + 0.5) / N - off) / box) * 40, v = ((y + (sy + 0.5) / N - off) / box) * 40;
        if (onLine(u, v, OUTER)) outer++;
        if (onLine(u, v, MIDDLE)) middle++;
        if (inside(u, v, CORE)) core++;
      }
      let c = bg;
      c = mix(c, C.glyph, (outer / (N * N)) * OUTER.alpha);
      c = mix(c, C.glyph, (middle / (N * N)) * MIDDLE.alpha);
      c = mix(c, C.core, core / (N * N));
      const k = (y * size + x) * 3;
      for (let i = 0; i < 3; i++) px[k + i] = Math.round(c[i]);
    }
  }
  return px;
}

// a PNG of RGB rows, every row unfiltered
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// the pixels back out of a PNG png() wrote: its size, and its RGB rows
function unpng(buf) {
  const size = buf.readUInt32BE(16), parts = [];
  for (let i = 8; i < buf.length;) { const n = buf.readUInt32BE(i), type = buf.toString('ascii', i + 4, i + 8); if (type === 'IDAT') parts.push(buf.subarray(i + 8, i + 8 + n)); i += 12 + n; }
  const rows = zlib.inflateSync(Buffer.concat(parts)), rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) rows.copy(rgb, y * size * 3, y * (size * 3 + 1) + 1, (y + 1) * (size * 3 + 1));
  return { size, colorType: buf[25], rgb };
}

if (require.main === module) {
  const C = colours();
  for (const [file, size] of Object.entries(SIZES)) {
    fs.writeFileSync(path.join(ROOT, 'public', file), png(size, draw(size, C)));
    console.log(`public/${file}  ${size}x${size}`);
  }
}
module.exports = { SIZES, colours, draw, png, unpng };
