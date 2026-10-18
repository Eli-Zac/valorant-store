// Draws one skin icon centred on a square transparent tile. Discord crops every image in a gallery to
// a fixed shape, and the skin icons are wide, so each one is padded to a square first and nothing is cut.
// Workers have no canvas, so this decodes the PNG, scales it, and encodes the result with only the
// built-in streams.

const SIZE = 512;
const PAD = 24;

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

// Non-interlaced, 8-bit PNG of any colour type -> { w, h, px } with px as RGBA.
async function decodePng(buf) {
  const b = new Uint8Array(buf);
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  for (let o = 8; o + 8 <= b.length; ) {
    const len = be32(b, o);
    const name = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const data = b.subarray(o + 8, o + 8 + len);
    if (name === "IHDR") [w, h, depth, type, interlace] = [be32(data, 0), be32(data, 4), data[8], data[9], data[12]];
    else if (name === "PLTE") palette = data;
    else if (name === "tRNS") trns = data;
    else if (name === "IDAT") idat.push(data);
    else if (name === "IEND") break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace || !w || !h || w * h > 16e6) throw new Error("unsupported PNG");
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!ch) throw new Error("unsupported PNG");
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  idat.reduce((n, d) => (joined.set(d, n), n + d.length), 0);
  const raw = await pipe(joined, new DecompressionStream("deflate"));

  const stride = w * ch;
  const cur = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[o + x - ch] : 0;
      const up = y ? cur[o - stride + x] : 0;
      const c = x >= ch && y ? cur[o - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[o + x] = v & 255;
    }
  }
  if (type === 6) return { w, h, px: cur };
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r, g, bl, a = 255;
    if (type === 2) [r, g, bl] = [cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]];
    else if (type === 0) r = g = bl = cur[i];
    else if (type === 4) (r = g = bl = cur[i * 2]), (a = cur[i * 2 + 1]);
    else {
      const k = cur[i];
      [r, g, bl] = [palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2]];
      if (trns && k < trns.length) a = trns[k];
    }
    px.set([r, g, bl, a], i * 4);
  }
  return { w, h, px };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const x of bytes) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function encodePng(px, w, h) {
  const rows = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) rows.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const z = await pipe(rows, new CompressionStream("deflate"));
  const chunk = (name, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((n, p) => (out.set(p, n), n + p.length), 0);
  return out;
}

// Box-filter the icon down to fit the tile (never enlarged past 1.5x), centred, keeping its alpha.
function drawFit(px, img) {
  const scale = Math.min((SIZE - PAD * 2) / img.w, (SIZE - PAD * 2) / img.h, 1.5);
  const dw = Math.max(1, Math.round(img.w * scale));
  const dh = Math.max(1, Math.round(img.h * scale));
  const ox = Math.round((SIZE - dw) / 2);
  const oy = Math.round((SIZE - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * img.h) / dh), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.h) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * img.w) / dw), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.w) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.w + sx) * 4;
          const al = img.px[i + 3];
          r += img.px[i] * al; g += img.px[i + 1] * al; b += img.px[i + 2] * al; a += al; n++;
        }
      }
      if (!a) continue;
      px.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n)], ((oy + y) * SIZE + ox + x) * 4);
    }
  }
}

// iconUrl: an https URL of a PNG skin icon.
export async function skinTile(iconUrl, fetchImage = (u) => fetch(u)) {
  const r = await fetchImage(iconUrl);
  if (!r.ok) throw new Error(`icon fetch failed ${r.status}`);
  const px = new Uint8Array(SIZE * SIZE * 4);
  drawFit(px, await decodePng(await r.arrayBuffer()));
  return encodePng(px, SIZE, SIZE);
}
