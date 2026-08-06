// Densifies a baked point cloud that has no source mesh available.
// New points are interpolated between an existing point and one of its near
// neighbours, so they land ON the surface the cloud already describes.
// This raises stipple density and smooths the dot distribution; it cannot
// invent surface detail the original bake did not capture.
'use strict';
const fs = require('fs');

function decode(entry) {
  const nl = entry.data.indexOf('|');
  const meta = JSON.parse(entry.data.slice(0, nl));
  const bin = Buffer.from(entry.data.slice(nl + 1), 'base64');
  const K = meta.count;
  const [x0, x1, y0, y1, z0, z1] = meta.bounds;
  const P = new Float64Array(K * 3), N = new Float64Array(K * 3), AO = new Float64Array(K);
  const nOff = K * 6, aOff = K * 9;
  for (let i = 0; i < K; i++) {
    P[i*3]   = x0 + bin.readUInt16LE(i*6)     / 65535 * (x1 - x0);
    P[i*3+1] = y0 + bin.readUInt16LE(i*6 + 2) / 65535 * (y1 - y0);
    P[i*3+2] = z0 + bin.readUInt16LE(i*6 + 4) / 65535 * (z1 - z0);
    N[i*3]   = bin[nOff + i*3]     / 255 * 2 - 1;
    N[i*3+1] = bin[nOff + i*3 + 1] / 255 * 2 - 1;
    N[i*3+2] = bin[nOff + i*3 + 2] / 255 * 2 - 1;
    AO[i] = bin[aOff + i] / 255;
  }
  return { K, P, N, AO, bounds: meta.bounds };
}

function pack(P, N, AO, K, bounds) {
  const [x0, x1, y0, y1, z0, z1] = bounds;
  const posBuf = Buffer.alloc(K * 6), normBuf = Buffer.alloc(K * 3), aoBuf = Buffer.alloc(K);
  const q = (v, lo, hi) => Math.max(0, Math.min(65535, Math.round((v - lo) / (hi - lo) * 65535)));
  const b = (v) => Math.max(0, Math.min(255, Math.round((v + 1) / 2 * 255)));
  for (let i = 0; i < K; i++) {
    posBuf.writeUInt16LE(q(P[i*3], x0, x1), i*6);
    posBuf.writeUInt16LE(q(P[i*3+1], y0, y1), i*6 + 2);
    posBuf.writeUInt16LE(q(P[i*3+2], z0, z1), i*6 + 4);
    normBuf[i*3] = b(N[i*3]); normBuf[i*3+1] = b(N[i*3+1]); normBuf[i*3+2] = b(N[i*3+2]);
    aoBuf[i] = Math.max(0, Math.min(255, Math.round(AO[i] * 255)));
  }
  const bin = Buffer.concat([posBuf, normBuf, aoBuf]);
  return JSON.stringify({ count: K, bounds }) + '|' + bin.toString('base64');
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function densify(entry, addCount, seed) {
  const m = decode(entry);
  const { K, P, N, AO, bounds } = m;
  const rng = mulberry32(seed || 5);
  // Uniform grid for neighbour lookup, sized so a cell holds a handful of
  // points — small enough that a neighbour is genuinely nearby, big enough
  // that most cells are populated.
  const ext = Math.max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]);
  const cell = ext / 48;
  const grid = new Map();
  const key = (a, b2, c) => a + ',' + b2 + ',' + c;
  const gi = new Int32Array(K * 3);
  for (let i = 0; i < K; i++) {
    const a = Math.floor(P[i*3] / cell), b2 = Math.floor(P[i*3+1] / cell), c = Math.floor(P[i*3+2] / cell);
    gi[i*3] = a; gi[i*3+1] = b2; gi[i*3+2] = c;
    const k = key(a, b2, c);
    let bucket = grid.get(k);
    if (!bucket) { bucket = []; grid.set(k, bucket); }
    bucket.push(i);
  }
  const total = K + addCount;
  const P2 = new Float64Array(total * 3), N2 = new Float64Array(total * 3), AO2 = new Float64Array(total);
  P2.set(P); N2.set(N); AO2.set(AO);
  let made = 0, guard = 0;
  while (made < addCount && guard < addCount * 40) {
    guard++;
    const i = (rng() * K) | 0;
    // Gather candidate neighbours from the 27 cells around this point.
    const cand = [];
    for (let dx = -1; dx <= 1 && cand.length < 40; dx++)
      for (let dy = -1; dy <= 1 && cand.length < 40; dy++)
        for (let dz = -1; dz <= 1 && cand.length < 40; dz++) {
          const bucket = grid.get(key(gi[i*3] + dx, gi[i*3+1] + dy, gi[i*3+2] + dz));
          if (bucket) for (let n = 0; n < bucket.length && cand.length < 40; n++) if (bucket[n] !== i) cand.push(bucket[n]);
        }
    if (!cand.length) continue;
    const j = cand[(rng() * cand.length) | 0];
    // Interpolating between two surface points can cut a corner across a
    // crease, so only accept pairs whose normals broadly agree — otherwise
    // the new point floats off the surface.
    const dot = N[i*3]*N[j*3] + N[i*3+1]*N[j*3+1] + N[i*3+2]*N[j*3+2];
    if (dot < 0.55) continue;
    const t = 0.25 + rng() * 0.5;   // keep away from the endpoints, which already exist
    const o = K + made;
    for (let k = 0; k < 3; k++) {
      P2[o*3+k] = P[i*3+k] + (P[j*3+k] - P[i*3+k]) * t;
      N2[o*3+k] = N[i*3+k] + (N[j*3+k] - N[i*3+k]) * t;
    }
    const len = Math.hypot(N2[o*3], N2[o*3+1], N2[o*3+2]) || 1;
    N2[o*3] /= len; N2[o*3+1] /= len; N2[o*3+2] /= len;
    AO2[o] = AO[i] + (AO[j] - AO[i]) * t;
    made++;
  }
  return { data: pack(P2, N2, AO2, K + made, bounds), added: made, from: K };
}

module.exports = { densify, decode, pack };

if (require.main === module) {
  const [,, holoPath, modelKey, addStr, seedStr] = process.argv;
  const sb = {};
  new Function('window', fs.readFileSync(holoPath, 'utf8'))(sb);
  const models = sb.HOLO_MODELS;
  const r = densify(models[modelKey], parseInt(addStr, 10), parseInt(seedStr, 10) || 5);
  models[modelKey] = { label: models[modelKey].label, data: r.data };
  fs.writeFileSync(holoPath, 'window.HOLO_MODELS = ' + JSON.stringify(models) + ';', 'utf8');
  console.error(modelKey + ': ' + r.from + ' -> ' + (r.from + r.added) + ' (+' + r.added + ')');
}
