// GLB -> HOLO_MODELS point-cloud converter.
// Matches the exact binary layout decodeModel() in the wallpaper HTML expects:
//   JSON meta {count, bounds:[x0,x1,y0,y1,z0,z1]} + '|' + base64(
//     K * [uint16 x, uint16 y, uint16 z]  (positions, little-endian, quantised per-axis 0..65535)
//     K * [uint8 nx, uint8 ny, uint8 nz]  (normals, 0..255 -> -1..1)
//     K * [uint8 ao]                       (ambient occlusion, 0..255 -> 0..1)
//   )
'use strict';
const fs = require('fs');

function parseGLB(path) {
  const buf = fs.readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a glb: ' + path);
  let offset = 12, json = null, bin = null;
  while (offset < buf.length) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.toString('ascii', offset + 4, offset + 8);
    const chunkData = buf.slice(offset + 8, offset + 8 + chunkLen);
    if (chunkType === 'JSON') json = JSON.parse(chunkData.toString('utf8'));
    else if (chunkType.indexOf('BIN') === 0) bin = chunkData;
    offset += 8 + chunkLen;
  }
  return { json, bin };
}

const COMP_SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(json, bin, accIdx) {
  const acc = json.accessors[accIdx];
  const bv = json.bufferViews[acc.bufferView];
  const compSize = COMP_SIZES[acc.componentType];
  const numComp = TYPE_COMPS[acc.type];
  const stride = bv.byteStride || compSize * numComp;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Float64Array(acc.count * numComp);
  for (let i = 0; i < acc.count; i++) {
    const rowOff = base + i * stride;
    for (let c = 0; c < numComp; c++) {
      const o = rowOff + c * compSize;
      let v;
      switch (acc.componentType) {
        case 5126: v = bin.readFloatLE(o); break;
        case 5125: v = bin.readUInt32LE(o); break;
        case 5123: v = bin.readUInt16LE(o); break;
        case 5122: v = bin.readInt16LE(o); break;
        case 5121: v = bin.readUInt8(o); break;
        case 5120: v = bin.readInt8(o); break;
        default: throw new Error('unhandled componentType ' + acc.componentType);
      }
      out[i * numComp + c] = v;
    }
  }
  return out;
}

function mat4Identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function mat4Mul(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rIdx = 0; rIdx < 4; rIdx++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k*4+rIdx] * b[c*4+k];
    r[c*4+rIdx] = s;
  }
  return r;
}
function mat4FromTRS(t, r, s) {
  t = t || [0,0,0]; r = r || [0,0,0,1]; s = s || [1,1,1];
  const [x,y,z,w] = r;
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, xy=x*y2, xz=x*z2, yy=y*y2, yz=y*z2, zz=z*z2, wx=w*x2, wy=w*y2, wz=w*z2;
  const m = [
    (1-(yy+zz))*s[0], (xy+wz)*s[0], (xz-wy)*s[0], 0,
    (xy-wz)*s[1], (1-(xx+zz))*s[1], (yz+wx)*s[1], 0,
    (xz+wy)*s[2], (yz-wx)*s[2], (1-(xx+yy))*s[2], 0,
    t[0], t[1], t[2], 1,
  ];
  return m;
}
function mat4TransformPoint(m, x, y, z) {
  return [
    m[0]*x + m[4]*y + m[8]*z + m[12],
    m[1]*x + m[5]*y + m[9]*z + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
  ];
}
// Normals need the inverse-transpose; for the rotation/uniform-scale
// matrices these scene graphs use, transforming with the 3x3 part and
// renormalising is equivalent and much less code.
function mat4TransformDir(m, x, y, z) {
  const v = [m[0]*x + m[4]*y + m[8]*z, m[1]*x + m[5]*y + m[9]*z, m[2]*x + m[6]*y + m[10]*z];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/len, v[1]/len, v[2]/len];
}

// Walks the scene graph, returns a flat list of { positions, normals, indices } already in world space.
function extractMeshes(json, bin) {
  const results = [];
  function visit(nodeIdx, parentMat) {
    const node = json.nodes[nodeIdx];
    const local = node.matrix ? node.matrix : mat4FromTRS(node.translation, node.rotation, node.scale);
    const world = mat4Mul(parentMat, local);
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      mesh.primitives.forEach((prim) => {
        if (prim.mode !== undefined && prim.mode !== 4) return; // triangles only
        const posAcc = prim.attributes.POSITION;
        const normAcc = prim.attributes.NORMAL;
        const rawPos = readAccessor(json, bin, posAcc);
        const rawNorm = normAcc !== undefined ? readAccessor(json, bin, normAcc) : null;
        const count = rawPos.length / 3;
        const positions = new Float64Array(count * 3);
        const normals = new Float64Array(count * 3);
        for (let i = 0; i < count; i++) {
          const p = mat4TransformPoint(world, rawPos[i*3], rawPos[i*3+1], rawPos[i*3+2]);
          positions[i*3] = p[0]; positions[i*3+1] = p[1]; positions[i*3+2] = p[2];
          if (rawNorm) {
            const n = mat4TransformDir(world, rawNorm[i*3], rawNorm[i*3+1], rawNorm[i*3+2]);
            normals[i*3] = n[0]; normals[i*3+1] = n[1]; normals[i*3+2] = n[2];
          }
        }
        let indices;
        if (prim.indices !== undefined) {
          indices = readAccessor(json, bin, prim.indices);
        } else {
          indices = new Float64Array(count);
          for (let i = 0; i < count; i++) indices[i] = i;
        }
        results.push({ positions, normals: rawNorm ? normals : null, indices, count });
      });
    }
    (node.children || []).forEach((c) => visit(c, world));
  }
  const scene = json.scenes[json.scene || 0];
  scene.nodes.forEach((n) => visit(n, mat4Identity()));
  return results;
}

// Merges the per-mesh arrays into one big triangle soup: flat position/normal
// arrays plus a triangle index list (three vertex indices per face).
function mergeMeshes(meshes) {
  let totalVerts = 0, totalTris = 0;
  meshes.forEach((m) => { totalVerts += m.count; totalTris += m.indices.length / 3; });
  const P = new Float64Array(totalVerts * 3);
  const N = new Float64Array(totalVerts * 3);
  const hasNormal = new Uint8Array(totalVerts);
  const tris = new Uint32Array(totalTris * 3);
  let vOff = 0, tOff = 0;
  meshes.forEach((m) => {
    P.set(m.positions, vOff * 3);
    if (m.normals) { N.set(m.normals, vOff * 3); hasNormal.fill(1, vOff, vOff + m.count); }
    for (let i = 0; i < m.indices.length; i++) tris[tOff * 3 + i] = m.indices[i] + vOff;
    tOff += m.indices.length / 3;
    vOff += m.count;
  });
  // Fill in face normals for any vertex that arrived without one.
  for (let f = 0; f < totalTris; f++) {
    const a = tris[f*3], b = tris[f*3+1], c = tris[f*3+2];
    if (hasNormal[a] && hasNormal[b] && hasNormal[c]) continue;
    const ax=P[a*3],ay=P[a*3+1],az=P[a*3+2];
    const bx=P[b*3],by=P[b*3+1],bz=P[b*3+2];
    const cx=P[c*3],cy=P[c*3+1],cz=P[c*3+2];
    const ux=bx-ax, uy=by-ay, uz=bz-az;
    const vx=cx-ax, vy=cy-ay, vz=cz-az;
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const len = Math.hypot(nx,ny,nz) || 1;
    nx/=len; ny/=len; nz/=len;
    [a,b,c].forEach((idx) => { if (!hasNormal[idx]) { N[idx*3]=nx; N[idx*3+1]=ny; N[idx*3+2]=nz; hasNormal[idx]=1; } });
  }
  return { P, N, tris, totalVerts, totalTris };
}

// Keeps only the triangles whose centroid falls inside a Y slab, expressed
// as fractions measured DOWN FROM THE TOP of the model's bounding box
// (top=0, bottom=1). A full standing figure becomes a bust with
// crop(mesh, 0, 0.20). Sampling and normalisation then see only the
// retained geometry, so the whole point budget goes to the part kept.
function cropMesh(mesh, topFrac, botFrac) {
  const { P, N, tris, totalVerts, totalTris } = mesh;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < totalVerts; i++) {
    const y = P[i*3+1];
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const H = maxY - minY;
  const yHi = maxY - topFrac * H;
  const yLo = maxY - botFrac * H;
  const keep = [];
  for (let f = 0; f < totalTris; f++) {
    const a = tris[f*3], b = tris[f*3+1], c = tris[f*3+2];
    const cy = (P[a*3+1] + P[b*3+1] + P[c*3+1]) / 3;
    if (cy >= yLo && cy <= yHi) keep.push(f);
  }
  if (!keep.length) throw new Error('crop removed all geometry');
  // Re-index so only referenced vertices survive.
  const remap = new Map();
  const newTris = new Uint32Array(keep.length * 3);
  let next = 0;
  keep.forEach((f, k) => {
    for (let j = 0; j < 3; j++) {
      const old = tris[f*3+j];
      let ni = remap.get(old);
      if (ni === undefined) { ni = next++; remap.set(old, ni); }
      newTris[k*3+j] = ni;
    }
  });
  const newP = new Float64Array(next * 3), newN = new Float64Array(next * 3);
  remap.forEach((ni, old) => {
    for (let j = 0; j < 3; j++) { newP[ni*3+j] = P[old*3+j]; newN[ni*3+j] = N[old*3+j]; }
  });
  return { P: newP, N: newN, tris: newTris, totalVerts: next, totalTris: keep.length };
}

// Spins the mesh about the vertical axis. Needed when a model's face looks
// down an axis other than +Z, since every landmark probe and the renderer
// itself assume the subject faces the camera at yaw 0.
function yawMesh(mesh, deg) {
  if (!deg) return mesh;
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const { P, N, totalVerts } = mesh;
  for (let i = 0; i < totalVerts; i++) {
    const x = P[i*3], z = P[i*3+2];
    P[i*3] = x * c + z * s; P[i*3+2] = -x * s + z * c;
    const nx = N[i*3], nz = N[i*3+2];
    N[i*3] = nx * c + nz * s; N[i*3+2] = -nx * s + nz * c;
  }
  return mesh;
}

// Area-weighted random sampling across all triangles, with barycentric
// normal interpolation, so point density reflects surface area rather than
// original vertex density (a few huge quads shouldn't starve small detail).
function samplePoints(mesh, K, rng) {
  const { P, N, tris, totalTris } = mesh;
  const areas = new Float64Array(totalTris);
  let totalArea = 0;
  for (let f = 0; f < totalTris; f++) {
    const a = tris[f*3], b = tris[f*3+1], c = tris[f*3+2];
    const ux=P[b*3]-P[a*3], uy=P[b*3+1]-P[a*3+1], uz=P[b*3+2]-P[a*3+2];
    const vx=P[c*3]-P[a*3], vy=P[c*3+1]-P[a*3+1], vz=P[c*3+2]-P[a*3+2];
    const cx=uy*vz-uz*vy, cy=uz*vx-ux*vz, cz=ux*vy-uy*vx;
    const area = 0.5 * Math.hypot(cx,cy,cz);
    areas[f] = area; totalArea += area;
  }
  const cum = new Float64Array(totalTris);
  let acc = 0;
  for (let f = 0; f < totalTris; f++) { acc += areas[f]; cum[f] = acc; }
  function pickTri() {
    const r = rng() * totalArea;
    let lo = 0, hi = totalTris - 1;
    while (lo < hi) { const mid = (lo+hi)>>1; if (cum[mid] < r) lo = mid+1; else hi = mid; }
    return lo;
  }
  const outP = new Float64Array(K*3), outN = new Float64Array(K*3);
  for (let i = 0; i < K; i++) {
    const f = pickTri();
    const a = tris[f*3], b = tris[f*3+1], c = tris[f*3+2];
    let r1 = rng(), r2 = rng();
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    const w0 = 1 - r1 - r2, w1 = r1, w2 = r2;
    for (let k = 0; k < 3; k++) outP[i*3+k] = w0*P[a*3+k] + w1*P[b*3+k] + w2*P[c*3+k];
    let nx = w0*N[a*3]+w1*N[b*3]+w2*N[c*3];
    let ny = w0*N[a*3+1]+w1*N[b*3+1]+w2*N[c*3+1];
    let nz = w0*N[a*3+2]+w1*N[b*3+2]+w2*N[c*3+2];
    const len = Math.hypot(nx,ny,nz) || 1;
    outN[i*3]=nx/len; outN[i*3+1]=ny/len; outN[i*3+2]=nz/len;
  }
  return { P: outP, N: outN, K };
}

// Cheap point-cloud AO approximation: for each point, look at nearby points
// (via a uniform grid) and accumulate how much they sit in the hemisphere
// behind its normal, weighted by proximity. Cavities have lots of "behind
// the normal" neighbours (high occlusion); convex/exposed areas have few.
// Not a real GI bake, but it produces the same kind of shading variance
// that made the human model read as detailed, on any mesh.
function computeAO(P, N, K, opts) {
  opts = opts || {};
  const radius = opts.radius;
  const cell = radius;
  const grid = new Map();
  function key(gx,gy,gz) { return gx+','+gy+','+gz; }
  const gx = new Int32Array(K), gy = new Int32Array(K), gz = new Int32Array(K);
  for (let i = 0; i < K; i++) {
    gx[i] = Math.floor(P[i*3]/cell); gy[i] = Math.floor(P[i*3+1]/cell); gz[i] = Math.floor(P[i*3+2]/cell);
    const k = key(gx[i],gy[i],gz[i]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  // Two radii from one pass. A single radius has to choose between reading
  // fine crevices and reading overall form, and gets neither cleanly: small
  // and the eye sockets stop looking deep, large and the sutures and teeth
  // wash out. The small neighbourhood is a subset of the large one, so both
  // are accumulated in the same loop for free.
  // Weights chosen by sweeping against the previous single-radius bake and
  // holding the MEAN fixed while maximising variance. Mean matters because
  // density is gated on tone^2.3 and tone falls with AO — raising the average
  // occlusion thins the whole cloud, which costs more than the extra contrast
  // buys. These land at mean 0.1895 (baseline 0.1940) with variance 0.0456
  // against 0.0360: 27% more shading contrast and very slightly denser.
  const rBig = radius;
  const rSmall = radius * 0.34;
  const AO = new Float64Array(K);
  const r2 = rBig*rBig, rs2 = rSmall*rSmall;
  for (let i = 0; i < K; i++) {
    const px=P[i*3], py=P[i*3+1], pz=P[i*3+2];
    const nx=N[i*3], ny=N[i*3+1], nz=N[i*3+2];
    let occB = 0, wB = 0, occS = 0, wS = 0;
    for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++) for (let dz=-1; dz<=1; dz++) {
      const bucket = grid.get(key(gx[i]+dx, gy[i]+dy, gz[i]+dz));
      if (!bucket) continue;
      for (let bi = 0; bi < bucket.length; bi++) {
        const j = bucket[bi];
        if (j === i) continue;
        const ox=P[j*3]-px, oy=P[j*3+1]-py, oz=P[j*3+2]-pz;
        const d2 = ox*ox+oy*oy+oz*oz;
        if (d2 > r2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const dirDot = (ox*nx+oy*ny+oz*nz)/d; // >0 = in front, <0 = behind (occluding)
        const w = 1 - d/rBig;
        if (dirDot < 0) occB += (-dirDot) * w;
        wB += w;
        if (d2 <= rs2) {
          const ws = 1 - d/rSmall;
          if (dirDot < 0) occS += (-dirDot) * ws;
          wS += ws;
        }
      }
    }
    const aoB = wB > 0 ? occB / wB : 0;   // broad form: sockets, temples, under the arch
    const aoS = wS > 0 ? occS / wS : 0;   // crevices: sutures, teeth, nasal aperture
    // Detail weighted above form, because the fine term is what survives
    // being stippled — broad shading alone reads as a soft blob.
    AO[i] = Math.max(0, Math.min(1, aoB * 0.75 + aoS * 1.85));
  }
  return AO;
}

function normalizeAndPack(P, N, AO, K) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (let i=0;i<K;i++){
    const x=P[i*3],y=P[i*3+1],z=P[i*3+2];
    if (x<minX)minX=x; if (x>maxX)maxX=x;
    if (y<minY)minY=y; if (y>maxY)maxY=y;
    if (z<minZ)minZ=z; if (z>maxZ)maxZ=z;
  }
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2, cz=(minZ+maxZ)/2;
  const height = maxY-minY || 1;
  const scale = 1.75/height; // matches the existing models' Y span convention
  const bounds = [
    (minX-cx)*scale, (maxX-cx)*scale,
    -0.875, 0.875,
    (minZ-cz)*scale, (maxZ-cz)*scale,
  ];
  const [x0,x1,y0,y1,z0,z1] = bounds;
  const posBuf = Buffer.alloc(K*6);
  const normBuf = Buffer.alloc(K*3);
  const aoBuf = Buffer.alloc(K);
  for (let i=0;i<K;i++){
    const x=(P[i*3]-cx)*scale, y=(P[i*3+1]-cy)*scale, z=(P[i*3+2]-cz)*scale;
    const qx = Math.max(0,Math.min(65535, Math.round((x-x0)/(x1-x0)*65535)));
    const qy = Math.max(0,Math.min(65535, Math.round((y-y0)/(y1-y0)*65535)));
    const qz = Math.max(0,Math.min(65535, Math.round((z-z0)/(z1-z0)*65535)));
    posBuf.writeUInt16LE(qx, i*6); posBuf.writeUInt16LE(qy, i*6+2); posBuf.writeUInt16LE(qz, i*6+4);
    normBuf[i*3] = Math.max(0,Math.min(255, Math.round((N[i*3]+1)/2*255)));
    normBuf[i*3+1] = Math.max(0,Math.min(255, Math.round((N[i*3+1]+1)/2*255)));
    normBuf[i*3+2] = Math.max(0,Math.min(255, Math.round((N[i*3+2]+1)/2*255)));
    aoBuf[i] = Math.max(0,Math.min(255, Math.round(AO[i]*255)));
  }
  const bin = Buffer.concat([posBuf, normBuf, aoBuf]);
  const meta = JSON.stringify({ count: K, bounds });
  const data = meta + '|' + bin.toString('base64');
  return { data, bounds };
}

// Deterministic PRNG so re-runs are reproducible.
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function convert(path, K, seed, opts) {
  opts = opts || {};
  const { json, bin } = parseGLB(path);
  const meshes = extractMeshes(json, bin);
  let merged = mergeMeshes(meshes);
  if (opts.yaw) merged = yawMesh(merged, opts.yaw);
  if (opts.crop) merged = cropMesh(merged, opts.crop[0], opts.crop[1]);
  const rng = mulberry32(seed || 1);
  const sampled = samplePoints(merged, K, rng);
  // AO radius scaled relative to the model's own extent, estimated cheaply
  // from a quick pre-pass bounding box of the sampled points.
  let minY=Infinity,maxY=-Infinity;
  for (let i=0;i<K;i++){ const y=sampled.P[i*3+1]; if(y<minY)minY=y; if(y>maxY)maxY=y; }
  const radius = (maxY-minY) * 0.035;
  const AO = computeAO(sampled.P, sampled.N, K, { radius });
  const packed = normalizeAndPack(sampled.P, sampled.N, AO, K);
  return { ...packed, vertCount: merged.totalVerts, triCount: merged.totalTris, meshCount: meshes.length };
}

module.exports = { parseGLB, extractMeshes, mergeMeshes, cropMesh, yawMesh, samplePoints, computeAO, normalizeAndPack, convert };

if (require.main === module) {
  // glb2holo.js <file> <points> <label> <seed> [--crop=top,bot] [--yaw=deg]
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const flag = (name) => {
    const hit = args.find((a) => a.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const [path, kStr, label, seedStr] = pos;
  const K = parseInt(kStr, 10) || 30000;
  const cropRaw = flag('crop');
  const opts = {
    crop: cropRaw ? cropRaw.split(',').map(Number) : null,
    yaw: parseFloat(flag('yaw')) || 0,
  };
  const result = convert(path, K, parseInt(seedStr,10) || 1, opts);
  console.error('verts(src):', result.vertCount, 'tris(src):', result.triCount,
    'meshes:', result.meshCount, opts.crop ? ('crop:' + opts.crop.join('..')) : '', opts.yaw ? ('yaw:' + opts.yaw) : '');
  process.stdout.write(JSON.stringify({ label: label || 'MODEL', data: result.data }));
}
