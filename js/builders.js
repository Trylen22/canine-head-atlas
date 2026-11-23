// Geometry builders for the data-driven structure types (tube, muscle, sheet, blob) and the
// shared solid-making helpers the parametric models use. Everything here returns closed,
// outward-facing solids so the median cut can be capped.
import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const V = (a, b, c) => Array.isArray(a) ? new THREE.Vector3(a[0], a[1], a[2]) : new THREE.Vector3(a, b, c);
const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// value of a scalar-or-array profile at t in 0..1
export function prof(p, t, dflt) {
  if (p == null) return dflt;
  if (typeof p === 'number') return p;
  if (!p.length) return dflt;
  if (p.length === 1) return p[0];
  const x = Math.min(1, Math.max(0, t)) * (p.length - 1), i = Math.min(p.length - 2, Math.floor(x));
  return lerp(p[i], p[i + 1], x - i);
}

export class GB {
  constructor() { this.p = []; this.uv = []; this.col = null; this.idx = []; }
  v(x, y, z, u = 0, w = 0, c) { this.p.push(x, y, z); this.uv.push(u, w); if (c) { (this.col || (this.col = new Array((this.p.length / 3 - 1) * 3).fill(1))).push(c[0], c[1], c[2]); } else if (this.col) this.col.push(1, 1, 1); return this.p.length / 3 - 1; }
  vv(q, u, w, c) { return this.v(q.x, q.y, q.z, u, w, c); }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  build({ outward = true, weld = true } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    if (outward) ensureOutward(g);
    g.computeVertexNormals();
    if (weld) weldNormals(g);
    return g;
  }
}

export function signedVolume(g) {
  const P = g.attributes.position.array, I = g.index.array; let vol = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return vol / 6;
}
export function flip(g) { const I = g.index.array; for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } g.index.needsUpdate = true; return g; }
export function ensureOutward(g) {
  // measure about the centroid so far-from-origin solids are not swamped by rounding
  const P = g.attributes.position; let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < P.count; i++) { cx += P.getX(i); cy += P.getY(i); cz += P.getZ(i); }
  cx /= P.count; cy /= P.count; cz /= P.count;
  g.translate(-cx, -cy, -cz); const vol = signedVolume(g); g.translate(cx, cy, cz);
  if (vol < 0) flip(g);
  return g;
}
// Average normals of vertices that share a position (UV seams, mirrored joins).
export function weldNormals(g) {
  const P = g.attributes.position, N = g.attributes.normal, acc = new Map();
  const key = i => Math.round(P.getX(i) * 1e5) + '_' + Math.round(P.getY(i) * 1e5) + '_' + Math.round(P.getZ(i) * 1e5);
  for (let i = 0; i < P.count; i++) { const k = key(i); let a = acc.get(k); if (!a) acc.set(k, a = [0, 0, 0]); a[0] += N.getX(i); a[1] += N.getY(i); a[2] += N.getZ(i); }
  for (let i = 0; i < P.count; i++) { const a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]) || 1; N.setXYZ(i, a[0] / l, a[1] / l, a[2] / l); }
  return g;
}
export function merge(list) { const l = list.filter(Boolean).map(g => { const c = g.index ? g : g; for (const k of Object.keys(c.attributes)) if (!['position', 'normal', 'uv'].includes(k)) c.deleteAttribute(k); if (!c.attributes.uv) c.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(c.attributes.position.count * 2), 2)); if (!c.attributes.normal) c.computeVertexNormals(); return c; }); return l.length === 1 ? l[0] : mergeGeometries(l, false); }

export function curveOf(points, closed = false) {
  const pts = points.map(p => p.isVector3 ? p : V(p));
  if (pts.length === 2) pts.splice(1, 0, pts[0].clone().lerp(pts[1], 0.5));
  return new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
}

// Sweep a cross-section along a curve.
//   size(t) -> [halfWidth (along B), halfThick (along N)]
//   up: preferred thickness direction (N); without it N is parallel-transported
//   power: 1 = ellipse, <1 = squarer band
export function sweep(curve, { n = 40, m = 12, size, up = null, n0 = null, power = 1, round = false, uv = [3, 2], color = null, cap = true, post = null, shift = null } = {}) {
  const b = new GB(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), P = new THREE.Vector3(), q = new THREE.Vector3();
  const len = curve.getLength(), upv = up ? V(up).normalize() : null;
  if (n0) N.copy(n0);
  const rings = [];
  const addRing = (P0, s, t, alongT) => {
    const [a, c] = size(t), col = color ? color(t) : null, row = [];
    for (let j = 0; j <= m; j++) {
      const ang = (j % m) / m * Math.PI * 2, cx = Math.cos(ang), cy = Math.sin(ang);
      const ex = Math.sign(cx) * Math.pow(Math.abs(cx), power) * a * s, ey = Math.sign(cy) * Math.pow(Math.abs(cy), power) * c * s;
      q.copy(P0).addScaledVector(B, ex).addScaledVector(N, ey).addScaledVector(T, alongT);
      if (post) q.copy(post(q, N));
      row.push(b.vv(q, t * len * uv[0], j / m * uv[1], col));
    }
    rings.push(row);
  };
  const frame = t => {
    curve.getPointAt(t, P); curve.getTangentAt(t, T).normalize();
    if (upv && Math.abs(upv.dot(T)) < 0.97) N.copy(upv);
    else if (N.lengthSq() < 0.5) { N.set(0, 1, 0); if (Math.abs(T.y) > 0.9) N.set(0, 0, 1); }
    N.addScaledVector(T, -N.dot(T)).normalize(); B.crossVectors(T, N).normalize();
  };
  const K = round ? 4 : 0;
  frame(0); const s0 = size(0), r0 = Math.min(s0[0], s0[1]);
  for (let k = 1; k < K; k++) { const th = k / K * Math.PI / 2; addRing(P, Math.sin(th), 0, -r0 * Math.cos(th)); }
  // optional per-ring offsets (e.g. lifting a muscle off the bone), smoothed along the length
  let sh = null;
  if (shift) { sh = []; for (let i = 0; i <= n; i++) { frame(i / n); sh.push(shift(P, N, B, i / n)); }
    for (let it = 0; it < 3; it++) sh = sh.map((v, i) => Math.max(v * 0.5, (sh[Math.max(0, i - 1)] + v + sh[Math.min(n, i + 1)]) / 3)); }
  for (let i = 0; i <= n; i++) { frame(i / n); if (sh) P.addScaledVector(N, sh[i]); addRing(P, 1, i / n, 0); }
  const s1 = size(1), r1 = Math.min(s1[0], s1[1]);
  for (let k = K - 1; k >= 1; k--) { const th = k / K * Math.PI / 2; addRing(P, Math.sin(th), 1, r1 * Math.cos(th)); }
  for (let i = 0; i + 1 < rings.length; i++) for (let j = 0; j < m; j++) b.quad(rings[i][j], rings[i + 1][j], rings[i + 1][j + 1], rings[i][j + 1]);
  if (cap) {
    frame(0); const c0 = b.vv(q.copy(P).addScaledVector(T, round ? -r0 : 0), 0, 0.5, color ? color(0) : null);
    for (let j = 0; j < m; j++) b.tri(c0, rings[0][j + 1], rings[0][j]);
    frame(1); const c1 = b.vv(q.copy(P).addScaledVector(T, round ? r1 : 0), len * uv[0], 0.5, color ? color(1) : null), last = rings[rings.length - 1];
    for (let j = 0; j < m; j++) b.tri(c1, last[j], last[j + 1]);
  }
  return b.build();
}

// A tube with a lumen: outer and inner walls joined by annular ends.
export function hollowTube(curve, ro, ri, { n = 40, m = 20, squash = 1, up = null } = {}) {
  const b = new GB(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), P = new THREE.Vector3(), q = new THREE.Vector3();
  const upv = up ? V(up).normalize() : null, out = [], inn = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n; curve.getPointAt(t, P); curve.getTangentAt(t, T).normalize();
    if (upv && Math.abs(upv.dot(T)) < 0.97) N.copy(upv); else if (N.lengthSq() < 0.5) N.set(0, 1, 0);
    N.addScaledVector(T, -N.dot(T)).normalize(); B.crossVectors(T, N).normalize();
    const ro_ = prof(ro, t, 0.1), ri_ = prof(ri, t, 0.08), a = [], c = [];
    for (let j = 0; j <= m; j++) {
      const ang = (j % m) / m * Math.PI * 2, cx = Math.cos(ang), cy = Math.sin(ang) * squash;
      a.push(b.vv(q.copy(P).addScaledVector(B, cx * ro_).addScaledVector(N, cy * ro_), t * 4, j / m));
      c.push(b.vv(q.copy(P).addScaledVector(B, cx * ri_).addScaledVector(N, cy * ri_), t * 4, j / m));
    }
    out.push(a); inn.push(c);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { b.quad(out[i][j], out[i + 1][j], out[i + 1][j + 1], out[i][j + 1]); b.quad(inn[i][j], inn[i][j + 1], inn[i + 1][j + 1], inn[i + 1][j]); }
  for (let j = 0; j < m; j++) { b.quad(out[0][j], out[0][j + 1], inn[0][j + 1], inn[0][j]); b.quad(out[n][j], inn[n][j], inn[n][j + 1], out[n][j + 1]); }
  return b.build();
}

// Thick plate over a parametric mid-surface fn(u,v) -> Vector3, u,v in 0..1.
export function plate(fn, { nu = 24, nv = 16, thick = 0.02, wrapU = false, rim = 0.45, uv = [2, 2], color = null, uvFn = null } = {}) {
  const b = new GB(), du = new THREE.Vector3(), dv = new THREE.Vector3(), nn = new THREE.Vector3();
  const top = [], bot = [], G = [];
  const th = (u, v) => { const base = typeof thick === 'function' ? thick(u, v) : thick; const eu = wrapU ? 1 : smooth(0, 0.12, Math.min(u, 1 - u)), ev = smooth(0, 0.12, Math.min(v, 1 - v)); return base * lerp(rim, 1, Math.min(eu, ev)); };
  for (let i = 0; i <= nu; i++) { const row = []; for (let j = 0; j <= nv; j++) row.push(fn(wrapU && i === nu ? 0 : i / nu, j / nv).clone()); G.push(row); }
  const at = (i, j) => G[wrapU ? (i + nu) % nu : Math.min(nu, Math.max(0, i))][Math.min(nv, Math.max(0, j))];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu, r1 = [], r2 = [];
    for (let j = 0; j <= nv; j++) {
      const v = j / nv, p = G[i][j];
      du.subVectors(at(i + 1, j), at(i - 1, j)); dv.subVectors(at(i, j + 1), at(i, j - 1));
      nn.crossVectors(du, dv); if (nn.lengthSq() < 1e-16) nn.set(0, 0, 1); nn.normalize();
      const h = th(u, v) / 2, t2 = uvFn ? uvFn(p, u, v) : [u * uv[0], v * uv[1]];
      // color(u, v, side, normal): side +1 is the face the surface normal points to
      r1.push(b.v(p.x + nn.x * h, p.y + nn.y * h, p.z + nn.z * h, t2[0], t2[1], color ? color(u, v, 1, nn) : null));
      r2.push(b.v(p.x - nn.x * h, p.y - nn.y * h, p.z - nn.z * h, t2[0], t2[1], color ? color(u, v, -1, nn) : null));
    }
    top.push(r1); bot.push(r2);
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { b.quad(top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]); b.quad(bot[i][j], bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j]); }
  for (let i = 0; i < nu; i++) { b.quad(top[i][0], bot[i][0], bot[i + 1][0], top[i + 1][0]); b.quad(top[i][nv], top[i + 1][nv], bot[i + 1][nv], bot[i][nv]); }
  if (!wrapU) for (let j = 0; j < nv; j++) { b.quad(top[0][j], top[0][j + 1], bot[0][j + 1], bot[0][j]); b.quad(top[nu][j], bot[nu][j], bot[nu][j + 1], top[nu][j + 1]); }
  return b.build();
}

// Solid of revolution about the X axis from a closed polygon in the (x, r>=0) half plane.
// phi0..phi1 (radians, measured from +Y toward +Z) less than a full turn adds flat cut faces.
export function revolve(poly, { seg = 40, phi0 = 0, phi1 = Math.PI * 2 } = {}) {
  let area = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], c = poly[(i + 1) % poly.length]; area += a[0] * c[1] - c[0] * a[1]; }
  if (area < 0) poly = poly.slice().reverse();
  const full = Math.abs(phi1 - phi0 - Math.PI * 2) < 1e-6, b = new GB(), rows = [], n = poly.length;
  for (let s = 0; s <= seg; s++) { const ph = lerp(phi0, phi1, s / seg), cs = Math.cos(ph), sn = Math.sin(ph); rows.push(poly.map((q, k) => b.v(q[0], q[1] * cs, q[1] * sn, k / n * 2, s / seg * 2))); }
  for (let s = 0; s < seg; s++) for (let k = 0; k < n; k++) { const k1 = (k + 1) % n; if (poly[k][1] < 1e-7 && poly[k1][1] < 1e-7) continue; b.quad(rows[s][k], rows[s][k1], rows[s + 1][k1], rows[s + 1][k]); }
  const side = b.build({ outward: false, weld: full });
  // the winding rule is the same for any sweep angle, so test it once on a coarse full turn
  { const t = new GB(), rr = []; for (let q = 0; q < 8; q++) { const ph = q / 8 * Math.PI * 2; rr.push(poly.map(p => t.v(p[0], p[1] * Math.cos(ph), p[1] * Math.sin(ph)))); }
    for (let q = 0; q < 8; q++) for (let k = 0; k < n; k++) { const k1 = (k + 1) % n, q1 = (q + 1) % 8; t.quad(rr[q][k], rr[q][k1], rr[q1][k1], rr[q1][k]); }
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(t.p, 3)); tg.setIndex(t.idx);
    if (signedVolume(tg) < 0) { flip(side); side.computeVertexNormals(); if (full) weldNormals(side); } }
  if (full) return side;
  const caps = [], contour = poly.map(q => new THREE.Vector2(q[0], q[1])), tris = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const [ph, sign] of [[phi0, -1], [phi1, 1]]) {
    const cs = Math.cos(ph), sn = Math.sin(ph), cb = new GB();
    for (const q of poly) cb.v(q[0], q[1] * cs, q[1] * sn, q[0] * 6, q[1] * 6);
    // desired normal: +/- d/dphi = (0, -sin, cos)
    for (const t of tris) { if (sign > 0) cb.tri(t[0], t[1], t[2]); else cb.tri(t[0], t[2], t[1]); }
    const cg = cb.build({ outward: false, weld: false });
    const N = cg.attributes.normal; let d = 0; for (let i = 0; i < N.count; i++) d += (N.getY(i) * -sn + N.getZ(i) * cs) * sign;
    if (d < 0) { flip(cg); cg.computeVertexNormals(); }
    caps.push(cg);
  }
  return merge([side, ...caps]);
}

// ---------------------------------------------------------------- noise
function h3(x, y, z) { let n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return n - Math.floor(n); }
export function worley(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z); let f1 = 9, f2 = 9;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const cx = ix + a, cy = iy + b, cz = iz + c;
    const dx = cx + h3(cx, cy, cz) - x, dy = cy + h3(cy, cz, cx + 9.1) - y, dz = cz + h3(cz, cx, cy + 4.7) - z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return [f1, f2];
}
export function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const s = t => t * t * (3 - 2 * t), ux = s(fx), uy = s(fy), uz = s(fz);
  const L = (a, b, t) => a + (b - a) * t;
  return L(L(L(h3(ix, iy, iz), h3(ix + 1, iy, iz), ux), L(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), ux), uy), L(L(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), ux), L(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), ux), uy), uz);
}

export function ellipsoid(radii, { detail = 5, lobulated = false, lobes = 5.5, seed = 0, bump = 0.1 } = {}) {
  let g = new THREE.IcosahedronGeometry(1, detail); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = mergeVertices(g, 1e-5);
  const P = g.attributes.position, col = new Float32Array(P.count * 3), uv = new Float32Array(P.count * 2);
  for (let i = 0; i < P.count; i++) {
    let x = P.getX(i), y = P.getY(i), z = P.getZ(i), k = 1, shade = 1;
    if (lobulated) { const [f1, f2] = worley(x * lobes + seed, y * lobes + seed * 1.7, z * lobes - seed); const crease = smooth(0.0, 0.32, f2 - f1); k = 1 - bump + bump * crease; shade = 0.62 + 0.38 * crease; }
    else if (bump) { k = 1 + (vnoise(x * 2.3 + seed, y * 2.3, z * 2.3) - 0.5) * bump; }
    P.setXYZ(i, x * k * radii[0], y * k * radii[1], z * k * radii[2]);
    col[i * 3] = shade; col[i * 3 + 1] = shade * (lobulated ? 0.96 + 0.04 * shade : 1); col[i * 3 + 2] = shade;
    uv[i * 2] = Math.atan2(z, x) / 6.2832 + 0.5; uv[i * 2 + 1] = y * 0.5 + 0.5;
  }
  if (lobulated) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- data-driven records
const lateral = (pos, bias = 0.25) => new THREE.Vector3(0, bias, pos.z > 0.002 ? 1 : -1).normalize();

export function buildTube(rec) {
  let pts = rec.points.map(p => V(p));
  const closed = !!rec.closed;
  if (closed && pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-4) pts = pts.slice(0, -1);
  const curve = curveOf(pts, closed), np = pts.length;
  const r0 = rec.r ?? 0.012, r1 = rec.r1 ?? r0;
  const rad = t => rec.radii ? prof(rec.radii, t, r0) : lerp(r0, r1, t);
  const mid = curve.getPointAt(closed ? 0.25 : 0.5), n = lateral(mid);
  const flat = rec.kind === 'muscle' ? (closed ? 0.14 : 0.36) : 1;          // sphincters are bands, not ropes
  const wide = rec.kind === 'muscle' && closed ? 1.5 : 1;
  let ringUp = null;
  if (closed && flat < 1) { ringUp = new THREE.Vector3(); for (let k = 0; k < pts.length; k++) { const a = pts[k], c = pts[(k + 1) % pts.length]; ringUp.x += (a.y - c.y) * (a.z + c.z); ringUp.y += (a.z - c.z) * (a.x + c.x); ringUp.z += (a.x - c.x) * (a.y + c.y); } ringUp.normalize(); }
  const geometry = sweep(curve, { n: Math.min(160, Math.max(10, np * 7)), m: flat < 1 ? 14 : 10, up: flat < 1 ? (rec.up || ringUp || [0, 0.15, -1]) : null, power: flat < 1 ? 0.8 : 1,
    size: t => { const r = rad(t); return [r * wide, r * flat]; }, round: !closed && flat === 1, cap: !closed, uv: flat < 1 ? [3, 1] : [6, 1] });
  return { geometry, anchor: { pos: mid.clone().addScaledVector(n, rad(0.5) * flat), normal: n } };
}

const TENDON = [1.55, 2.2, 2.35];   // multiplies the muscle base colour up to tendon white
export function buildMuscle(rec, ctx = {}) {
  const curve = curveOf(rec.path), np = rec.path.length;
  const tn = rec.tendon ?? [0.07, 0.07];
  const color = t => { const k = Math.max(1 - smooth(0, tn[0] || 1e-6, t), smooth(1 - (tn[1] || 1e-6), 1, t)); return [lerp(1, TENDON[0], k), lerp(1, TENDON[1], k), lerp(1, TENDON[2], k)]; };
  const mid = curve.getPointAt(0.5);
  // thickness runs outward from the long axis of the head unless the record says otherwise
  const out = V(0, mid.y + 0.08, mid.z); if (out.lengthSq() < 1e-4) out.set(0, -1, 0); out.normalize();
  const up = rec.up ? V(rec.up).normalize() : out;
  const geometry = sweep(curve, {
    n: Math.min(120, Math.max(14, np * 8)), m: 18, power: 0.9, up, uv: [3, 2], color,
    size: t => [Math.max(0.002, prof(rec.width, t, 0.1) / 2), Math.max(0.002, prof(rec.thick, t, 0.03) / 2)],
    // superficial muscles ride on the bone: lift each ring until its deep face clears the surface
    shift: ctx.drape && rec.drape !== false && !rec.up && ctx.lift ? (P, N, B, t) => {
      const w = prof(rec.width, t, 0.1) / 2, h = prof(rec.thick, t, 0.03) / 2; let best = 0;
      for (const k of [-0.6, 0, 0.6]) { const q = P.clone().addScaledVector(B, w * k).addScaledVector(N, -h * (1 - 0.5 * Math.abs(k))); const d = ctx.drape(q, N, 0.002, 0.07).sub(q).dot(N); if (d > best) best = d; }
      return best;
    } : null,
  });
  const n = lateral(mid);
  return { geometry, anchor: { pos: mid.clone().addScaledVector(up, prof(rec.thick, 0.5, 0.03) / 2), normal: n } };
}

export function buildSheet(rec, ctx = {}) {
  const th = rec.thick ?? 0.012;
  let mid, nu, nv, wrap = false;
  if (rec.grid) {
    // rows of points on the bone: a belly that swells off that surface and thins to its margins
    const rows = rec.grid.map(r => curveOf(r)), R = rows.length;
    const fn = (u, v) => { const pts = rows.map(c => c.getPoint(v)); return pts.length > 2 ? new THREE.CatmullRomCurve3(pts, false, 'centripetal').getPoint(u) : pts[0].clone().lerp(pts[1], u); };
    const f = rec.fiber ? V(rec.fiber).normalize() : V(1, 0, 0), c0 = fn(0.5, 0.5), g2 = new THREE.Vector3().crossVectors(f, lateral(c0)).normalize();
    const belly = (u, v) => th * 2 * (0.12 + 0.88 * Math.pow(Math.sin(Math.PI * u) * Math.sin(Math.PI * v), 0.42));
    const geometry = plate(fn, { nu: Math.max(16, R * 5), nv: Math.max(16, rec.grid[0].length * 5), thick: belly, rim: 1, uvFn: q => [q.dot(f) * 4, q.dot(g2) * 4] });
    const n = lateral(c0);
    return { geometry, anchor: { pos: c0.addScaledVector(n, th), normal: n } };
  }
  const O = rec.outline.map(p => V(p)), n = O.length;
  const M = O.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / n);
  // outward normal of the polygon (Newell), pointed away from the long axis of the head
  const nO = new THREE.Vector3(); for (let k = 0; k < n; k++) { const a = O[k], c = O[(k + 1) % n]; nO.x += (a.y - c.y) * (a.z + c.z); nO.y += (a.z - c.z) * (a.x + c.x); nO.z += (a.x - c.x) * (a.y + c.y); }
  if (nO.lengthSq() < 1e-12) nO.copy(lateral(M)); nO.normalize();
  if (nO.dot(V(0, M.y + 0.08, M.z)) < 0) nO.negate();
  let rad = 0; for (const p of O) rad += p.distanceTo(M) / n;
  const bulge = rec.bulge ?? Math.min(0.05, rad * 0.14);
  const C = rec.center ? V(rec.center) : M.clone().addScaledVector(nO, bulge), D = C.clone().sub(M);
  // mid-surface: rings shrinking from the outline to the centre, domed, then draped over bone
  const dense = []; for (let k = 0; k < n; k++) { const a = O[k], c = O[(k + 1) % n]; const sub = Math.max(2, Math.min(10, Math.round(a.distanceTo(c) / 0.04))); for (let s = 0; s < sub; s++) dense.push(a.clone().lerp(c, s / sub)); }
  const S = [1, 0.86, 0.72, 0.58, 0.44, 0.3, 0.16], gm = new GB(), ringIdx = [];
  const f = rec.fiber ? V(rec.fiber).normalize() : V(1, 0, 0), g2 = new THREE.Vector3().crossVectors(f, nO).normalize();
  const place = q => ctx.drape && rec.drape !== false ? ctx.drape(q, nO, th / 2 + 0.003, 0.08, rec.wrap ?? 0.1) : q;
  const m = dense.length;
  let R = S.map(s => dense.map(p => place(M.clone().addScaledVector(p.clone().sub(M), s).addScaledVector(D, 1 - s * s))));
  let Cq = place(C.clone());
  // relax the wrapped surface so it reads as a membrane, then make sure nothing sank back into bone
  if (ctx.drape && rec.drape !== false) {
    for (let it = 0; it < 6; it++) {
      const Rn = R.map((ring, r) => ring.map((q, k) => {
        const a = ring[(k + 1) % m], b2 = ring[(k + m - 1) % m], inn = r + 1 < R.length ? R[r + 1][k] : Cq, out = r > 0 ? R[r - 1][k] : null;
        const avg = a.clone().add(b2).add(inn); let cnt = 3; if (out) { avg.add(out); cnt++; }
        avg.multiplyScalar(1 / cnt);
        // move only along the sheet normal, so the outline keeps its shape
        return q.clone().addScaledVector(nO, avg.sub(q).dot(nO) * 0.6);
      }));
      R = Rn;
    }
    R = R.map(ring => ring.map(q => ctx.drape(q, nO, th / 2 + 0.003, 0.08, 0)));
  }
  for (const ring of R) ringIdx.push(ring.map(q => gm.vv(q, q.dot(f) * 4, q.dot(g2) * 4)));
  const ci = gm.vv(Cq, C.dot(f) * 4, C.dot(g2) * 4);
  for (let r = 0; r + 1 < S.length; r++) for (let k = 0; k < m; k++) gm.quad(ringIdx[r][k], ringIdx[r][(k + 1) % m], ringIdx[r + 1][(k + 1) % m], ringIdx[r + 1][k]);
  for (let k = 0; k < m; k++) gm.tri(ringIdx[S.length - 1][k], ringIdx[S.length - 1][(k + 1) % m], ci);
  const midG = gm.build({ outward: false, weld: false });
  // thicken along the mid-surface normals
  const P = midG.attributes.position, N = midG.attributes.normal, U = midG.attributes.uv, I = midG.index.array, b = new GB(), cnt = P.count;
  for (const sgn of [1, -1]) for (let i = 0; i < cnt; i++) { const edge = i < m ? 0.5 : 1; b.v(P.getX(i) + N.getX(i) * th / 2 * sgn * edge, P.getY(i) + N.getY(i) * th / 2 * sgn * edge, P.getZ(i) + N.getZ(i) * th / 2 * sgn * edge, U.getX(i), U.getY(i)); }
  for (let i = 0; i < I.length; i += 3) { b.tri(I[i], I[i + 1], I[i + 2]); b.tri(I[i] + cnt, I[i + 2] + cnt, I[i + 1] + cnt); }
  for (let k = 0; k < m; k++) { const a = ringIdx[0][k], c = ringIdx[0][(k + 1) % m]; b.quad(a, a + cnt, c + cnt, c); }
  const geometry = b.build();
  return { geometry, anchor: { pos: Cq.clone().addScaledVector(nO, th / 2), normal: nO.clone() } };
}

export function buildBlob(rec) {
  const radii = rec.radii || [0.05, 0.05, 0.05];
  const seed = (rec.id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 97;
  const geometry = ellipsoid(radii, { lobulated: !!rec.lobulated, seed, bump: rec.lobulated ? 0.11 : 0.05, lobes: rec.lobes ?? Math.max(3.5, Math.min(9, 0.5 / Math.cbrt(radii[0] * radii[1] * radii[2]) * 0.9)) });
  const rot = rec.rot || [0, 0, 0];
  const m = new THREE.Matrix4().compose(V(rec.center), new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])), new THREE.Vector3(1, 1, 1));
  geometry.applyMatrix4(m);
  const c = V(rec.center), n = lateral(c);
  // surface point of the ellipsoid toward the lateral side
  const loc = n.clone().applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])).invert());
  const k = 1 / Math.sqrt((loc.x / radii[0]) ** 2 + (loc.y / radii[1]) ** 2 + (loc.z / radii[2]) ** 2);
  return { geometry, anchor: { pos: c.clone().addScaledVector(n, k), normal: n } };
}
