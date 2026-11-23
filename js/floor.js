// Study floor: a clean, smoothed model of the cranial floor (assets/floor.json) shown in the Floor
// view in place of the rough CT floor. Three fossa regions with soft tints and crease lines,
// bevelled openings with dark throats, and the cribriform plate as a field of small pits.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TINT = [[1.0, 0.86, 0.68], [0.96, 0.95, 0.9], [0.72, 0.85, 1.0]];   // rostral warm, middle neutral, caudal cool
const FOSSA = ['rostral-cranial-fossa', 'middle-cranial-fossa', 'caudal-cranial-fossa'];

// returns [{ geometry, kind, termId, name, opts }]
export function buildStudyFloor(data, termIdByText) {
  const P = new Float32Array(data.positions), I = Array.from(data.indices), R = data.region, n = P.length / 3, out = [];

  // neighbours, for smoothing region weights and for a cheap concavity term
  const nb = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < I.length; i += 3) { const a = I[i], b = I[i + 1], c = I[i + 2]; nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b); }
  const relax = (f, iters) => { for (let it = 0; it < iters; it++) { const g = new Float32Array(n); for (let v = 0; v < n; v++) { let s = f[v], k = 1; for (const o of nb[v]) { s += f[o]; k++; } g[v] = s / k; } f = g; } return f; };
  const W = [0, 1, 2].map(r => relax(Float32Array.from(R, x => x === r ? 1 : 0), 5));
  const y = Float32Array.from({ length: n }, (_, v) => P[v * 3 + 1]), ySmall = relax(y, 4), yWide = relax(y, 24);

  // how deep each vertex sits within its own fossa, 0 at the rim to 1 at the deepest point
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let v = 0; v < n; v++) { const r = R[v]; if (ySmall[v] < lo[r]) lo[r] = ySmall[v]; if (ySmall[v] > hi[r]) hi[r] = ySmall[v]; }
  const col = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const w = [W[0][v], W[1][v], W[2][v]], sum = w[0] + w[1] + w[2] || 1, top = Math.max(...w) / sum;
    // occlusion: how far the vertex sits below its surroundings, at two scales
    const ao = 1 - Math.min(0.42, Math.max(0, (yWide[v] - y[v]) * 9) + Math.max(0, (ySmall[v] - y[v]) * 30));
    // crease: a faint line where two fossae meet (presphenoid crest, petrous ridge and dorsum sellae)
    const crease = 1 - 0.38 * Math.max(0, 1 - Math.abs(top - 0.5) / 0.12);
    const r = R[v], deep = Math.min(1, Math.max(0, (hi[r] - ySmall[v]) / Math.max(1e-4, hi[r] - lo[r]))), basin = 1 - 0.3 * Math.pow(deep, 1.3);
    for (let k = 0; k < 3; k++) col[v * 3 + k] = (w[0] * TINT[0][k] + w[1] * TINT[1][k] + w[2] * TINT[2][k]) / sum * ao * crease * basin;
  }

  // one smooth normal field for the whole surface, facing up into the vault
  const whole = new THREE.BufferGeometry(); whole.setAttribute('position', new THREE.BufferAttribute(P, 3)); whole.setIndex(I); whole.computeVertexNormals();
  const N = whole.attributes.normal; let up = 0; for (let v = 0; v < n; v++) up += N.getY(v);
  if (up < 0) { for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } for (let v = 0; v < n; v++) N.setXYZ(v, -N.getX(v), -N.getY(v), -N.getZ(v)); }
  const uv = new Float32Array(n * 2);
  for (let r = 0; r < 3; r++) {
    const idx = []; for (let i = 0; i < I.length; i += 3) { const a = I[i], b = I[i + 1], c = I[i + 2]; const m = R[a] === R[b] || R[a] === R[c] ? R[a] : R[b]; if (m === r) idx.push(a, b, c); }
    if (!idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N.array, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    // bounds from the triangles this region actually uses
    const box = new THREE.Box3(), q = new THREE.Vector3(); for (const v of idx) box.expandByPoint(q.fromArray(P, v * 3)); g.boundingBox = box;
    out.push({ geometry: g, kind: 'floor', termId: FOSSA[r], name: 'floor:' + FOSSA[r], opts: { pull: 1, doubleSide: true } });
  }

  // surface normal near a point (nearest vertex is plenty at this resolution)
  const normalAt = (x, yy, z) => { let best = 0, bd = 1e9; for (let v = 0; v < n; v++) { const d = (P[v * 3] - x) ** 2 + (P[v * 3 + 2] - z) ** 2 + (P[v * 3 + 1] - yy) ** 2 * 0.25; if (d < bd) { bd = d; best = v; } } return new THREE.Vector3(N.getX(best), N.getY(best), N.getZ(best)).normalize(); };
  const paint = (g, fn) => { const p = g.attributes.position, c = new Float32Array(p.count * 3); for (let i = 0; i < p.count; i++) { const k = fn(p.getX(i), p.getY(i), p.getZ(i)); c[i * 3] = k[0]; c[i * 3 + 1] = k[1]; c[i * 3 + 2] = k[2]; } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(a)) g.deleteAttribute(a); return g.index ? g.toNonIndexed() : g; };
  const Z = new THREE.Vector3(0, 0, 1), byTerm = new Map(), masks = [];
  for (const o of data.openings || []) {
    const id = termIdByText(o.term); const key = (o.pit ? 'pit:' : 'hole:') + (id || o.term);
    if (!byTerm.has(key)) byTerm.set(key, { id, pit: !!o.pit, lip: [], throat: [] });
    const nrm = normalAt(o.x, o.y, o.z), q = new THREE.Quaternion().setFromUnitVectors(Z, nrm), c = new THREE.Vector3(o.x, o.y, o.z), e = byTerm.get(key);
    const place = (g, dz) => { g.applyQuaternion(q); g.translate(c.x + nrm.x * dz, c.y + nrm.y * dz, c.z + nrm.z * dz); return g; };
    if (o.pit) {
      // a dimple: dark centre fading to the plate colour at its edge
      const d = new THREE.CircleGeometry(o.r, 14); e.lip.push(place(paint(d, (x, yy) => { const k = Math.min(1, Math.hypot(x, yy) / o.r); const s = 0.1 + 0.55 * k * k; return [s, s * 0.9, s * 0.8]; }), 0.0012));
    } else {
      const r = o.r, depth = o.depth || 0.05;
      // bevelled lip, lit like bone
      const lip = new THREE.TorusGeometry(r * 1.07, r * 0.17, 10, 40); e.lip.push(place(paint(lip, (x, yy, zz) => { const s = 0.8 + 0.2 * Math.min(1, Math.max(0, zz / (r * 0.17) * 0.5 + 0.5)); return [s, s * 0.97, s * 0.92]; }), 0.0004));
      // throat, drawn only through the hole (see the stencil mask): black floor first, then the wall darkening with depth
      const pit = new THREE.CircleGeometry(r * 0.8, 28); e.throat.push(place(paint(pit, () => [0.012, 0.01, 0.01]), -depth));
      const wall = new THREE.CylinderGeometry(r, r * 0.8, depth, 32, 6, true); wall.rotateX(Math.PI / 2); wall.translate(0, 0, -depth / 2);
      // seen from inside only: reverse the winding and the normals
      { const ix = wall.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } const nn = wall.attributes.normal.array; for (let i = 0; i < nn.length; i++) nn[i] = -nn[i]; }
      e.throat.push(place(paint(wall, (x, yy, zz) => { const k = Math.min(1, -zz / depth); const s = 0.42 * Math.pow(1 - k, 1.5) + 0.015; return [s, s * 0.8, s * 0.7]; }), 0));
      masks.push(place(paint(new THREE.CircleGeometry(r * 0.99, 32), () => [1, 1, 1]), 0.0002));
    }
  }
  if (masks.length) { const g = mergeGeometries(masks, false); g.computeBoundingBox(); out.push({ geometry: g, kind: 'floorhole', termId: null, name: 'floor:mask', role: 'mask', noPick: true, opts: { pull: 1 } }); }
  for (const [key, e] of byTerm) {
    if (e.throat.length) { const g = mergeGeometries(e.throat, false); g.computeBoundingBox(); out.push({ geometry: g, kind: 'floorhole', termId: e.id, name: 'floor:' + key + ':throat', role: 'throat', opts: {} }); }
    if (e.lip.length) { const g = mergeGeometries(e.lip, false); g.computeBoundingBox(); out.push({ geometry: g, kind: 'floorhole', termId: e.id, name: 'floor:' + key, opts: { pull: 1 } }); }
  }
  return out;
}
