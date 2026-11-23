// Parametric models. Each builder returns sub-parts in the model's local frame (or world, when the
// record gives world polylines) plus a local anchor per named sub-part. Placement always comes
// from the record: position, rotation (Euler XYZ, radians), scale.
//
//   { parts:   [{ key, geometry, kind, opts?, tag?, noCap?, noPick?, mirrorLocal?, world? }],
//     anchors: { key: [{ pos:Vector3, normal:Vector3, tag?, world? }] } }
//
// `key` is the sub-part name used in the record's `parts` map (key -> term id).
import * as THREE from 'three';
import { V, GB, sweep, hollowTube, plate, revolve, ellipsoid, curveOf, merge, smooth, prof, vnoise } from './builders.js';

const lerp = (a, b, t) => a + (b - a) * t;
const arc = (R, a0, a1, n, cx = 0) => { const o = []; for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n); o.push([cx + R * Math.cos(a), Math.max(0, R * Math.sin(a))]); } return o; };
const A = (pos, normal, tag) => ({ pos, normal, tag });
const moved = (g, m) => { g.applyMatrix4(m); return g; };
const at = (g, x, y, z) => { g.translate(x, y, z); return g; };

// =============================================================================== eye
// Record frame (parent): globe radius = 1, +Z toward the cornea, +Y dorsal, -X nasal.
// Built here in millimetres with +X anterior, then mapped. The section removes the temporal half,
// so the cut face looks laterally; parts tagged eye:whole / eye:cut are swapped by the toggle.
function eye() {
  const R = 10.8, tL = Math.asin(8 / R);                 // limbus where the corneal radius is 8 mm
  const cxo = R * Math.cos(tL) - Math.sqrt(8.8 * 8.8 - 64);
  const toRec = new THREE.Matrix4().makeBasis(V(0, 0, 1), V(0, 1, 0), V(-1, 0, 0)).multiply(new THREE.Matrix4().makeScale(1 / R, 1 / R, 1 / R));
  const P = { // closed regions in the meridional (x, r) plane
    sclera: [...arc(R, tL, Math.PI, 40), ...arc(10.0, Math.PI, tL + 0.03, 40)],
    cornea: [...arc(8.8, 0, Math.asin(8 / 8.8), 16, cxo), ...arc(8.05, 1.17, 0, 16, cxo)],
    choroid: [...arc(10.0, 1.15, Math.PI, 32), ...arc(9.62, Math.PI, 1.15, 32)],
    retina: [...arc(9.62, 1.2, Math.PI, 32), ...arc(9.3, Math.PI, 1.2, 32)],
    ciliaryBody: [[6.22, 7.83], [5.2, 8.54], [4.08, 9.13], [4.2, 8.5], [4.7, 7.4], [5.2, 6.3], [5.8, 6.25], [6.1, 7.0]],
    iris: [[6.55, 7.4], [7.1, 5.2], [7.25, 3.3], [7.1, 3.0], [6.9, 3.2], [6.7, 5.2], [6.1, 7.2]],
    lens: arc(1, 0, Math.PI, 28).map(([c, s]) => [3.9 + 3.6 * c, 5.2 * s]),
    vitreousBody: [...arc(9.3, Math.PI, 1.2, 30), [4.6, 6.6], ...arc(1, Math.PI / 2, Math.PI, 14).map(([c, s]) => [3.9 + 3.6 * c - 0.12, 5.2 * s])],
    aqueous: [...arc(8.05, 0, 1.1, 14, cxo), [6.6, 7.3], [7.15, 5.2], [7.32, 3.3], [7.5, 2.4], [7.6, 0]],
    limbus: arc(0.34, 0, Math.PI * 2, 10).slice(0, 10).map(([x], i) => { const a = i / 10 * Math.PI * 2; return [7.15 + 0.34 * Math.cos(a), 7.98 + 0.34 * Math.sin(a)]; }),
    pupil: [[6.86, 0], [6.86, 3.25], [6.96, 3.25], [6.96, 0]],
  };
  const kind = { sclera: 'sclera', cornea: 'cornea', choroid: 'choroid', retina: 'retina', ciliaryBody: 'ciliary', iris: 'iris', lens: 'lens', vitreousBody: 'vitreous', aqueous: 'aqueous', limbus: 'limbus', pupil: 'black' };
  const parts = [];
  // The hemisected globe is turned a quarter turn about its vertical axis, cut face outward, the way
  // a removed and bisected eye is laid out in lab; in place the cut would face the orbital wall.
  const turn = new THREE.Matrix4().makeRotationY(-Math.PI / 2), toCut = toRec.clone().multiply(turn);
  const add = (key, g, k, tag, extra = {}) => parts.push({ key, geometry: moved(g, tag === 'eye:cut' ? toCut : toRec), kind: k, tag, noCap: true, ...extra });
  const ghost = { vitreousBody: 1, aqueous: 1 };
  for (const key of Object.keys(P)) {
    const inner = ['choroid', 'retina', 'ciliaryBody', 'lens', 'vitreousBody'].includes(key);
    if (!inner && key !== 'pupil' && key !== 'aqueous') add(key, revolve(P[key], { seg: 48 }), kind[key], 'eye:whole');
    if (key === 'pupil') { add(key, revolve(P[key], { seg: 32 }), kind[key], 'eye:whole'); continue; }
    add(key, revolve(P[key], { seg: 28, phi0: 0, phi1: Math.PI }), kind[key], 'eye:cut', { noPick: !!ghost[key] });
  }
  // fundus furniture, on the kept (nasal) half only: tapetum lucidum dorsally, optic disc ventronasal
  const dir = (psi, beta) => V(-Math.cos(psi), Math.sin(psi) * Math.cos(beta), Math.sin(psi) * Math.sin(beta));
  const tap = (b0, b1) => plate((u, v) => { const beta = lerp(b0, b1, u), w = 1 - Math.abs(beta) / 1.45; return dir(lerp(0.10, 0.10 + 0.95 * Math.pow(Math.max(0.05, w), 0.6), v), beta).multiplyScalar(9.58); }, { nu: 18, nv: 12, thick: 0.1, rim: 1 });
  add('tapetum', tap(0.02, 1.35), 'tapetum', 'eye:cut');
  const dd = dir(0.24, Math.PI - 0.75);
  const disc = ellipsoid([0.95, 0.95, 0.16], { detail: 3 }); disc.lookAt(V(0, 0, 0).sub(dd)); disc.translate(dd.x * 9.28, dd.y * 9.28, dd.z * 9.28);
  add('opticDisc', disc, 'nerve', 'eye:cut');

  const cut = (x, r, z = -0.05) => A(V(x, r, z).applyMatrix4(toCut), V(0, 0, -1).transformDirection(toCut), 'eye:cut');
  const pol = (Rr, th, sgn = 1) => cut(Rr * Math.cos(th), sgn * Rr * Math.sin(th));
  const out = (p, n) => A(V(p).applyMatrix4(toRec), V(n).transformDirection(toRec), 'eye:whole');
  const tp = dir(0.62, 0.35).multiplyScalar(9.45), dp = dd.clone().multiplyScalar(9.1);
  const anchors = {
    cornea: [cut(cxo + 8.42 * Math.cos(0.5), 8.42 * Math.sin(0.5)), out([cxo + 8.8 * Math.cos(0.35), 2.4, -1.8], [1, 0.3, -0.3])],
    sclera: [pol(10.4, 2.0), out([R * Math.cos(1.25), R * Math.sin(1.25) * 0.55, -R * Math.sin(1.25) * 0.83], [0.3, 0.5, -0.8])],
    limbus: [cut(7.2, 8.0), out([7.3, 5.2, -6.2], [0.7, 0.45, -0.55])],
    iris: [cut(7.0, -5.0), out([7.3, -2.2, -4.2], [1, -0.2, -0.3])],
    pupil: [cut(7.15, 0), out([7.0, 0, -0.6], [1, 0, -0.1])],
    choroid: [pol(9.81, 2.2, -1)], fundus: [pol(9.3, 2.85)], ciliaryBody: [cut(5.2, 7.45)], lens: [cut(3.9, 0)],
    tapetum: [A(tp.applyMatrix4(toCut), V(0.4, -0.4, -0.8).transformDirection(toCut), 'eye:cut')],
    vitreousBody: [cut(-3.2, -2.2)], vitreousChamber: [cut(-4.2, 3.2)], aqueous: [cut(9.6, 0.6)], anteriorChamber: [cut(9.2, -2.2)], posteriorChamber: [cut(6.25, -6.35)],
    retina: [pol(9.46, 2.6, -1)], parsOptica: [pol(9.46, 1.9, -1)], nervousTunic: [pol(9.46, 1.6)],
    opticDisc: [A(dp.applyMatrix4(toCut), V(0.6, 0.2, -0.75).transformDirection(toCut), 'eye:cut')],
    fibrousTunic: [pol(10.4, 1.4, -1), out([R * Math.cos(1.6), -3, -R * 0.93], [0, -0.2, -1])], vascularTunic: [pol(9.81, 2.5)],
  };
  return { parts, anchors };
}

// =============================================================================== eyelids
// Record frame: globe radius = 1, origin at the corneal vertex, +Z outward, -X nasal (medial commissure).
function eyelids() {
  const z = (x, y) => 0.13 - 0.36 * (x * x + y * y);
  const W = 1.05, fis = (x, h) => Math.abs(x) >= W ? 0 : h * Math.pow(1 - (x / W) ** 2, 0.8);
  const outer = (x, h) => h * Math.sqrt(Math.max(0, 1 - (x / 1.5) ** 2));
  const dark = (u, v) => { const k = smooth(0, 0.16, v); return [lerp(0.2, 1, k), lerp(0.17, 1, k), lerp(0.16, 1, k)]; };
  const lid = (hf, ho, s) => plate((u, v) => { const x = lerp(-1.48, 1.48, u), y = s * lerp(fis(x, hf), outer(x, ho) + 0.02, v); return V(x, y, z(x, y)); }, { nu: 40, nv: 12, thick: 0.1, rim: 0.7, color: dark });
  const third = plate((u, v) => { const y = lerp(-0.34, 0.34, u), x = lerp(-1.02, -0.52 + 0.32 * (y * y) / 0.115, v); return V(x, y, z(x, y) - 0.09); }, { nu: 14, nv: 8, thick: 0.05, rim: 0.6, color: (u, v) => { const k = 1 - smooth(0.8, 1, v); return [lerp(0.3, 1, k), lerp(0.24, 1, k), lerp(0.24, 1, k)]; } });
  const n = V(0, 0, 1), a = (x, y, dz = 0.06) => [A(V(x, y, z(x, y) + dz), n)];
  return {
    parts: [{ key: 'superior', geometry: lid(0.42, 1.12, 1), kind: 'skin', tag: 'eye:whole' }, { key: 'inferior', geometry: lid(0.3, 0.9, -1), kind: 'skin', tag: 'eye:whole' }, { key: 'thirdEyelid', geometry: third, kind: 'mucosa', tag: 'eye:whole' }],
    anchors: { superior: a(0.05, 0.78), inferior: a(0.05, -0.62), upper: a(0.75, 0.62), fissure: a(0.3, 0.02, -0.02), medialCommissure: a(-W, 0), lateralCommissure: a(W, 0), thirdEyelid: a(-0.8, 0, -0.04) },
  };
}

// =============================================================================== auricle
// Record frame: head axes, origin at the opening of the ear canal, lateral = -Z. A Labrador drop
// ear: the conchal funnel rises from the canal, the leaf folds over and hangs. `canalTo` (world)
// is where the canal should end (external acoustic meatus).
function auricle(rec, M) {
  const L = rec.length ?? 0.92, fold = rec.fold ?? 0.9, N = 80, K = L / 0.92, cl = [V(0, 0, 0)], dirs = [];
  for (let i = 0; i < N; i++) {
    const u = i / N, phi = Math.PI * fold * smooth(0.04, 0.34, u) - 0.25;
    const d = V(0.16 * smooth(0.2, 1, u), Math.cos(phi), -Math.sin(phi) * (1 - 0.35 * smooth(0.4, 1, u))).normalize();
    dirs.push(d); cl.push(cl[i].clone().addScaledVector(d, L / N));
  }
  dirs.push(dirs[N - 1]);
  const at_ = u => { const x = Math.min(0.9999, Math.max(0, u)) * N, i = Math.floor(x); return { p: cl[i].clone().lerp(cl[i + 1], x - i), d: dirs[i] }; };
  const ax = V(1, 0, 0);
  const hw = u => K * lerp(0.075, 0.2, smooth(0, 0.42, u)) * (u > 0.42 ? Math.pow(Math.max(0.0, 1 - Math.pow((u - 0.42) / 0.58, 2.4)), 0.6) + 0.02 : 1);
  const leaf = (u, v) => {
    const { p, d } = at_(u), n = new THREE.Vector3().crossVectors(d, ax).normalize(), a = new THREE.Vector3().crossVectors(n, d).normalize();
    const rho = lerp(2.5, 0.42, smooth(0, 0.42, u)), w = hw(u), Rr = w / rho, sv = 2 * v - 1, s = sv * rho;
    // rolled at the base, a shallow cup along the leaf, the caudal margin curled over, a soft wave to the tip
    const curl = 0.035 * K * Math.pow(Math.abs(sv), 3) * (sv < 0 ? 1.6 : 0.7) * smooth(0.25, 0.6, u), wave = 0.005 * K * Math.sin(u * 7 + sv * 1.5) * smooth(0.3, 0.8, u);
    return p.addScaledVector(a, Rr * Math.sin(s)).addScaledVector(n, Rr * (1 - Math.cos(s)) + curl + wave);
  };
  const nrm = (u, v) => { const e = 0.01, a = leaf(u + e, v).sub(leaf(u - e, v)), b = leaf(u, v + e).sub(leaf(u, v - e)); return a.cross(b).normalize(); };
  const HAIR = [0.33, 0.28, 0.24], INNER = [0.88, 0.72, 0.68], EDGE = [0.86, 0.9, 0.93];
  // haired skin outside, pale skin inside, cartilage showing at the cut base
  const earCol = (u, v, side) => { const base = side < 0 ? HAIR : INNER, k = smooth(0.0, 0.05, u); const sh = 0.9 + 0.1 * Math.sin(u * 40 + v * 9); return [lerp(EDGE[0], base[0] * sh, k), lerp(EDGE[1], base[1] * sh, k), lerp(EDGE[2], base[2] * sh, k)]; };
  const parts = [{ key: 'cartilage', geometry: plate(leaf, { nu: 64, nv: 26, thick: 0.011, rim: 0.5, uv: [4, 2], color: earCol }), kind: 'skin', opts: { color: 0xffffff, opacity: 0.86 } }];
  // anthelix: transverse ridge on the concave wall near the canal entrance
  const ridge = []; for (let i = 0; i <= 8; i++) { const v = lerp(0.3, 0.7, i / 8); ridge.push(leaf(0.17, v).addScaledVector(nrm(0.17, v), 0.004)); }
  parts.push({ key: 'anthelix', geometry: sweep(curveOf(ridge), { n: 20, m: 8, size: t => { const r = 0.014 * Math.sin(Math.PI * (0.12 + 0.76 * t)); return [r, r]; }, round: true }), kind: 'skin', opts: { color: 0xd9b3a8 } });
  // tragus (rostral) and antitragus (caudal) guard the opening; the notch between them is the intertragic incisure
  const flap = (c, r, ry) => { const g = ellipsoid(r, { detail: 3, bump: 0.08 }); g.rotateY(ry); g.translate(c[0], c[1], c[2]); return g; };
  parts.push({ key: 'tragus', geometry: flap([0.075, 0.035, -0.075], [0.04, 0.05, 0.014], -0.5), kind: 'skin', opts: { color: 0x8f8073 } });
  parts.push({ key: 'antitragus', geometry: flap([-0.07, 0.03, -0.07], [0.036, 0.042, 0.013], 0.5), kind: 'skin', opts: { color: 0x8f8073 } });
  // marginal cutaneous sac: a small pouch of skin on the caudal margin of the pinna
  const sac = plate((u, v) => { const uu = lerp(0.3, 0.42, u), vv = lerp(0.0, 0.2, v); return leaf(uu, vv).addScaledVector(nrm(uu, vv), -0.012 - 0.012 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)); }, { nu: 10, nv: 8, thick: 0.008 });
  parts.push({ key: 'cutaneousSac', geometry: sac, kind: 'skin', opts: { color: 0x85776b } });
  // ear canal: vertical then horizontal part, to the meatus
  if (rec.canalTo) {
    const c = V(rec.canalTo).applyMatrix4(M.clone().invert());
    const pts = [V(0, 0.03, 0), V(c.x * 0.15, c.y * 0.45, c.z * 0.08), V(c.x * 0.6, c.y * 0.9, c.z * 0.45), c];
    parts.push({ key: 'canal', termKey: 'cartilage', geometry: hollowTube(curveOf(pts), [0.062, 0.045, 0.036], [0.046, 0.032, 0.025], { n: 30, m: 16 }), kind: 'cartilage' });
  }
  const o = (u, v, k = -1) => { const n = nrm(u, v).multiplyScalar(k); return A(leaf(u, v).addScaledVector(n, 0.01), n); };
  return { parts, anchors: { cartilage: [o(0.6, 0.5)], group: [o(0.42, 0.7)], anthelix: [o(0.17, 0.5, 1)], tragus: [A(V(0.08, 0.04, -0.092), V(0.2, 0, -1))], intertragic: [A(V(0.0, 0.0, -0.085), V(0, -0.2, -1))], cutaneousSac: [o(0.36, 0.08)] } };
}

// =============================================================================== nasal planum
// Record frame: head axes, origin at the centre of the planum, +X rostral, world units (10 cm).
function nasalPlanum() {
  let g = new THREE.IcosahedronGeometry(1, 14); g.deleteAttribute('uv'); g.deleteAttribute('normal');
  const b = new GB(), P = g.attributes.position, map = new Map();
  const rx = 0.12, ry = 0.135, rz = 0.185, col = [];
  const f = (x, y, z) => {
    let px = x * rx * (x > 0 ? 0.82 + 0.18 * (1 - x) : 1.25), py = y * ry * (1 - 0.12 * y), pz = z * rz * (1 - 0.16 * Math.max(0, -y));
    let shade = 1;
    if (x > 0) {
      // nares: comma-shaped, opening rostrally and curling laterally
      const cz = 0.082, ay = (py - 0.004), az = Math.abs(pz) - cz;
      const comma = Math.exp(0 - ((az - 0.02 * Math.sin(ay * 30)) / 0.03) ** 2 - (ay / 0.036) ** 2) + 0.7 * Math.exp(0 - ((az - 0.05) / 0.03) ** 2 - ((ay + 0.035) / 0.016) ** 2);
      const k = Math.min(1, comma);
      px -= 0.05 * k * x; shade *= 1 - 0.85 * smooth(0.25, 0.8, k);
      // philtrum: median groove running ventrally
      const ph = Math.exp(0 - ((pz) / 0.009) ** 2) * smooth(0.02, -0.03, py);
      px -= 0.012 * ph; shade *= 1 - 0.45 * ph;
    }
    return [px, py, pz, shade];
  };
  for (let i = 0; i < P.count; i++) {
    const key = Math.round(P.getX(i) * 1e4) + '_' + Math.round(P.getY(i) * 1e4) + '_' + Math.round(P.getZ(i) * 1e4);
    let id = map.get(key);
    if (id === undefined) { const [x, y, z, s] = f(P.getX(i), P.getY(i), P.getZ(i)); id = b.v(x, y, z, z * 22, y * 22, [s, s, s]); map.set(key, id); }
    col.push(id);
  }
  for (let i = 0; i < col.length; i += 3) b.tri(col[i], col[i + 1], col[i + 2]);
  const nose = b.build();
  const well = () => at(ellipsoid([0.035, 0.03, 0.028], { detail: 3 }), 0.035, 0.0, -0.08);
  return {
    parts: [{ key: 'nose', geometry: nose, kind: 'pigment' }, { key: 'vestibule', geometry: well(), kind: 'lumen', mirrorLocal: true, noCap: true }],
    anchors: { nose: [A(V(0.06, 0.11, -0.05), V(0.5, 0.8, -0.2))], naris: [A(V(0.075, 0.0, -0.088), V(1, 0, -0.35))], philtrum: [A(V(0.086, -0.075, -0.004), V(1, -0.3, -0.2))], vestibule: [A(V(0.04, -0.01, -0.105), V(0.8, 0, -0.6))] },
  };
}

// =============================================================================== lips
// The record gives world polylines for the left side: upperLip and lowerLip (lip margins from the
// front of the mouth to the commissure) and a cheek outline. position/rotation are not applied.
function lips(rec, M, ctx) {
  const parts = [], anchors = {};
  const SKIN = [0.66, 0.56, 0.54], MUC = [0.86, 0.5, 0.5], DARK = [0.12, 0.1, 0.1];
  const mix = (a, c, k) => [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k];
  // a thin curtain from the lip margin (v = 0) to its attachment (v = 1), tapering to the commissure (u = 1)
  const flap = (key, pts, h, dy) => {
    const c = curveOf(pts);
    const outAt = u => { const t = c.getTangent(u), o = V(t.z, 0, -t.x); if (o.z > 0) o.negate(); return o.normalize(); };
    const fn = (u, v) => {
      const p = c.getPoint(u), out = outAt(u), hh = h * (1 - 0.72 * smooth(0.5, 1, u)) * (0.8 + 0.2 * smooth(0, 0.12, u));
      const q = p.add(V(0, dy * v * hh, 0)).addScaledVector(out, 0.004 + 0.006 * Math.sin(Math.PI * v));
      return ctx.drape ? ctx.drape(q, out, 0.005, 0.07) : q;
    };
    const color = (u, v, side, n) => { const outer = n.dot(outAt(u)) * side > 0; return mix(DARK, outer ? SKIN : MUC, smooth(0.04, outer ? 0.3 : 0.18, v)); };
    parts.push({ key, geometry: plate(fn, { nu: 44, nv: 10, thick: 0.009, rim: 0.8, color, uv: [5, 1] }), kind: 'skin', opts: { color: 0xffffff }, world: true });
    const p = fn(0.42, 0.6); anchors[key] = [{ pos: p, normal: V(0, 0.15 * dy, -1), world: true }];
  };
  if (rec.upperLip) flap('upper', rec.upperLip, rec.upperHeight ?? 0.075, 1);
  if (rec.lowerLip) flap('lower', rec.lowerLip.slice().reverse(), rec.lowerHeight ?? 0.045, -1);
  // cheek: a soft membrane from lip to lip back toward the masseter, thin enough to show the buccinator
  if (rec.cheek) { const sh = ctx.sheet({ id: rec.id + '-cheek', outline: rec.cheek, thick: 0.006, bulge: 0.028, wrap: 0.04 }); parts.push({ key: 'cheek', geometry: sh.geometry, kind: 'skin', opts: { color: 0xc9a39a, opacity: 0.46 }, world: true }); anchors.cheek = [{ ...sh.anchor, world: true }]; }
  return { parts, anchors };
}

// =============================================================================== tongue
// World points apex and root (median), halfWidth and thickness; position/rotation are not applied.
function tongue(rec) {
  const apex = V(rec.apex || [1, -0.33, 0]), root = V(rec.root || [-0.45, -0.42, 0]), hw = rec.halfWidth ?? 0.15, th = rec.thickness ?? 0.16;
  const len = apex.distanceTo(root), mid = root.clone().lerp(apex, 0.45).add(V(0, 0.018, 0));
  const c = curveOf([root.clone().add(V(-0.02, -0.03, 0)), root.clone().lerp(mid, 0.5).add(V(0, 0.012, 0)), mid, mid.clone().lerp(apex, 0.6), apex]);
  const tip = t => t > 0.84 ? Math.sqrt(Math.max(0.03, 1 - ((t - 0.84) / 0.16) ** 2)) : 1;
  const W = t => hw * (0.72 + 0.28 * smooth(0, 0.35, t)) * (0.2 + 0.8 * tip(t)) * (1 + 0.06 * smooth(0.6, 0.85, t));
  const T = t => th / 2 * (1 - 0.6 * smooth(0.35, 1, t)) * (0.35 + 0.65 * tip(t)) * (0.8 + 0.2 * smooth(0, 0.15, t));
  const body = sweep(c, { n: 70, m: 24, power: 0.82, up: [0, 1, 0], size: t => [W(t), T(t)], uv: [6, 4] });
  const top = (t, s) => { const p = c.getPointAt(t), tg = c.getTangentAt(t), n = V(0, 1, 0).addScaledVector(tg, -tg.y).normalize(); const k = Math.pow(Math.max(0, 1 - Math.abs(s) ** (2 / 0.82)), 0.82 / 2); return { p: p.addScaledVector(n, T(t) * k).add(V(0, 0, s * W(t))), n, tg }; };
  // papillae: conical and long on the root, pointing caudally; fine filiform stubble on the body
  const cones = []; let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 620; i++) {
    const t = 0.03 + 0.9 * Math.pow(rnd(), 1.5), s = (rnd() * 2 - 1) * 0.86, rootish = 1 - smooth(0.12, 0.3, t), { p, n, tg } = top(t, s);
    const h = lerp(0.006, 0.022, rootish) * (0.7 + 0.6 * rnd()), g = new THREE.ConeGeometry(lerp(0.0032, 0.007, rootish), h, 5, 1);
    g.translate(0, h / 2 - 0.001, 0);
    const lean = n.clone().addScaledVector(tg, -0.9 * (0.4 + rootish)).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), lean)); g.translate(p.x, p.y, p.z);
    cones.push(g.toNonIndexed());
  }
  const pap = merge(cones); pap.setIndex([...Array(pap.attributes.position.count).keys()]);
  // vallate papillae: two each side in a V at the body / root junction
  const val = []; for (const [t, s] of [[0.27, 0.22], [0.235, 0.42]]) for (const sg of [-1, 1]) { const { p } = top(t, s * sg); val.push(at(ellipsoid([0.013, 0.006, 0.013], { detail: 2 }), p.x, p.y + 0.002, p.z)); }
  const vallate = merge(val.map(g => { g.deleteAttribute('color'); return g; }));
  // frenulum: median fold from the underside of the body to the floor of the mouth
  const fr0 = 0.5, fr1 = 0.68, under = t => c.getPointAt(t).add(V(0, -T(t) * 0.95, 0));
  const fren = plate((u, v) => { const t = lerp(fr0, fr1, u), a = under(t), drop = (rec.frenulumDrop ?? 0.07) * Math.sin(Math.PI * (0.12 + 0.6 * u)); return a.add(V(0, -drop * v, 0)); }, { nu: 12, nv: 6, thick: 0.01, rim: 0.8 });
  // lyssa: median fibrous rod in the ventral part of the apex
  const ly = []; for (let i = 0; i <= 6; i++) { const t = lerp(0.8, 0.975, i / 6); ly.push(c.getPointAt(t).add(V(0, -T(t) * 0.45, 0))); }
  const lyssa = sweep(curveOf(ly), { n: 16, m: 8, size: t => { const r = 0.009 * (0.5 + 0.5 * Math.sin(Math.PI * (0.1 + 0.8 * t))); return [r, r]; }, round: true });
  const up = V(0, 1, 0.0), W_ = (p, n) => [{ pos: p, normal: n, world: true }];
  return {
    parts: [{ key: 'tongue', geometry: body, kind: 'tongue', world: true }, { key: 'filiform', geometry: pap, kind: 'tongue', opts: { color: 0xdc9c98 }, world: true, noCap: true }, { key: 'vallate', geometry: vallate, kind: 'tongue', opts: { color: 0xb96d6c }, world: true, noCap: true }, { key: 'frenulum', geometry: fren, kind: 'mucosa', world: true }, { key: 'lyssa', geometry: lyssa, kind: 'ligament', world: true }],
    anchors: { tongue: W_(c.getPointAt(0.55), up), filiform: W_(top(0.62, -0.5).p, up), vallate: W_(top(0.27, -0.22).p.add(V(0, 0.007, 0)), up), frenulum: W_(under(0.6).add(V(0, -0.035, 0)), V(0, 0, 1)), lyssa: W_(ly[3], V(0, 0, 1)) },
  };
}

// =============================================================================== larynx
// Record frame: +X rostral, +Y dorsal, median at Z = 0, length 1 = tip of the epiglottis to the
// caudal border of the cricoid, origin mid-length on the airway axis. Built in centimetres.
function larynx() {
  const S = 1 / 6.8, X0 = 0.2, toRec = new THREE.Matrix4().makeScale(S, S, S).multiply(new THREE.Matrix4().makeTranslation(-X0, 0, 0));
  const parts = [], anchors = {};
  const add = (key, g, kind, extra = {}) => parts.push({ key, geometry: moved(g, toRec), kind, ...extra });
  const an = (key, p, n = [0, 0, 1]) => { (anchors[key] || (anchors[key] = [])).push(A(V(p).applyMatrix4(toRec), V(n).normalize())); };
  const tube = (pts, r, o = {}) => sweep(curveOf(pts.map(p => V(p))), { n: 18, m: 10, size: t => { const x = prof(r, t, 0.1); return [x, x]; }, round: true, ...o });
  const band = (pts, w, th, up, o = {}) => sweep(curveOf(pts.map(p => V(p))), { n: 24, m: 14, power: 1, up, size: t => { const e = 0.35 + 0.65 * Math.pow(Math.sin(Math.PI * (0.04 + 0.92 * t)), 0.5); return [prof(w, t, 0.3) / 2 * e, prof(th, t, 0.2) / 2 * e]; }, ...o });
  const TAU = Math.PI * 2;

  // cricoid: signet ring, tall lamina dorsally, narrow arch ventrally
  const dorsal = a => smooth(0.25, 0.9, (1 - Math.cos(a)) / 2);
  add('cricoid', plate((u, v) => { const a = u * TAU, xr = lerp(-2.55, -1.25, dorsal(a)); return V(lerp(-3.2, xr, v), -1.28 * Math.cos(a), 1.28 * Math.sin(a)); }, { nu: 48, nv: 8, thick: 0.24, wrapU: true, rim: 0.8 }), 'cartilage');
  an('cricoid', [-2.8, -0.5, -1.3], [0, -0.3, -1]);
  // thyroid: two laminae fused ventrally, open dorsally, with rostral and caudal cornua
  const TA = 0.76 * Math.PI;
  add('thyroid', plate((u, v) => { const a = lerp(-TA, TA, u), k = Math.abs(a) / TA, xr = 1.05 + 0.85 * smooth(0.72, 1, k) - 0.25 * smooth(0, 0.3, 1 - k) * 0, xc = -1.45 - 1.15 * smooth(0.66, 1, k) + 0.35 * Math.exp(0 - ((k - 0.35) / 0.2) ** 2); const R = 1.66 - 0.1 * Math.cos(a); return V(lerp(xc, xr, v), -R * Math.cos(a) * 1.04, R * Math.sin(a)); }, { nu: 56, nv: 14, thick: 0.17, rim: 0.75 }), 'cartilage');
  an('thyroid', [0.1, -0.35, -1.72], [0, -0.2, -1]);
  // epiglottic cartilage: leaf on a stalk, concave toward the airway
  const ep = t => { const a = V(1.0, -1.25, 0), b = V(2.95, -0.95, 0), c = V(3.6, 0.95, 0), s = 1 - t; return a.multiplyScalar(s * s).addScaledVector(b, 2 * s * t).addScaledVector(c, t * t); };
  const epW = t => 0.22 + 1.2 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 0.75) * (1 - 0.32 * t);
  const epi = (u, v) => { const p = ep(u), d = ep(Math.min(1, u + 0.01)).sub(ep(Math.max(0, u - 0.01))).normalize(), n = V(-d.y, d.x, 0), s = 2 * v - 1; return p.addScaledVector(n, 0.42 * s * s * epW(u)).add(V(0, 0, s * epW(u))); };
  add('epiglottic', plate(epi, { nu: 30, nv: 20, thick: 0.14, rim: 0.6 }), 'cartilage', { opts: { color: 0xe3e2cf } });
  an('epiglottic', [2.7, -0.55, 0.0]);
  // arytenoid cartilage (paired) with its three processes
  const ary = ellipsoid([0.46, 0.4, 0.27], { detail: 3, bump: 0.12 }); ary.rotateZ(0.3); ary.translate(-1.05, 0.72, -0.56);
  const pair = { mirrorLocal: true };
  add('arytenoid', ary, 'cartilage', pair); an('arytenoid', [-1.05, 0.78, -0.27]);
  add('vocalProcess', tube([[-0.98, 0.52, -0.5], [-0.86, 0.26, -0.4], [-0.78, 0.04, -0.32]], [0.15, 0.11, 0.07]), 'cartilage', pair); an('vocalProcess', [-0.8, 0.14, -0.26]);
  add('corniculate', tube([[-0.92, 0.98, -0.5], [-0.66, 1.42, -0.46], [-0.5, 1.72, -0.32], [-0.44, 1.84, -0.16]], [0.17, 0.14, 0.11, 0.07]), 'cartilage', pair); an('corniculate', [-0.5, 1.72, -0.2]);
  add('cuneiform', tube([[-0.66, 0.86, -0.62], [-0.1, 1.02, -0.72], [0.3, 0.7, -0.68], [0.36, 0.1, -0.56], [0.28, -0.28, -0.46]], [0.13, 0.17, 0.14, 0.1, 0.07]), 'cartilage', pair); an('cuneiform', [0.05, 0.98, -0.57]);
  // lining of the lateral wall, the backdrop the folds stand out from
  add('group', plate((u, v) => { const x = lerp(-3.15, 1.25, u), a = lerp(0.07, 0.93, v) * Math.PI, R = 1.0 - 0.3 * Math.exp(0 - ((x + 0.9) / 0.7) ** 2) + 0.12 * smooth(-0.2, 1.2, x); return V(x, -R * Math.cos(a) * (x > -1.2 ? 1.18 : 1.02), -R * Math.sin(a) * 0.82); }, { nu: 30, nv: 16, thick: 0.07, rim: 0.9 }), 'mucosa', pair);
  an('group', [-2.2, 0.1, -0.8]);
  // folds: vestibular (rostral), ventricle between, vocal (caudal)
  const vf = [[-0.78, 0.04, -0.3], [-0.92, -0.55, -0.24], [-1.06, -1.2, -0.14]];
  add('vocalFold', band(vf, [0.5, 0.56, 0.4], [0.24, 0.26, 0.16], [0, 0, 1]), 'mucosa', { ...pair, opts: { color: 0xe9c9c0 } }); an('vocalFold', [-0.95, -0.62, -0.1]);
  add('vocalLigament', tube(vf.map(p => [p[0] + 0.24, p[1], p[2] + 0.1]), [0.055, 0.06, 0.05]), 'ligament', pair); an('vocalLigament', [-0.66, -0.4, -0.08]);
  add('vocalis', band(vf.map(p => [p[0] - 0.38, p[1] + 0.02, p[2] - 0.22]), [0.5, 0.55, 0.4], [0.2, 0.22, 0.16], [0, 0, 1]), 'muscle', pair); an('vocalis', [-1.42, -0.5, -0.36]);
  add('vestibularFold', band([[0.28, -0.22, -0.44], [0.02, -0.72, -0.34], [-0.2, -1.22, -0.18]], [0.3, 0.34, 0.26], [0.18, 0.2, 0.14], [0, 0, 1]), 'mucosa', pair); an('vestibularFold', [0.03, -0.72, -0.22]);
  const vent = ellipsoid([0.2, 0.62, 0.07], { detail: 3 }); vent.rotateZ(-0.33); vent.translate(-0.43, -0.6, -0.5);
  add('ventricle', vent, 'lumen', pair); an('ventricle', [-0.43, -0.62, -0.42]);
  an('rimaGlottidis', [-0.9, -0.3, 0]); an('glottis', [-0.86, 0.3, -0.24]);
  // aryepiglottic fold: from the edge of the epiglottis to the cuneiform and corniculate processes
  add('aryepiglotticFold', plate((u, v) => { const a = V(2.25, -0.2, -1.05).lerp(V(-0.35, 1.5, -0.6), u), sag = 0.28 * Math.sin(Math.PI * u); return a.add(V(0, -sag - v * lerp(0.55, 0.75, u), 0.12 * v)); }, { nu: 16, nv: 6, thick: 0.07 }), 'mucosa', pair);
  an('aryepiglotticFold', [1.0, 0.45, -0.72]);
  // intrinsic muscles on the outside of the cartilages
  add('cricothyroid', band([[-2.85, -1.05, -0.78], [-2.3, -0.85, -1.3], [-1.85, -0.45, -1.62]], [0.7, 0.85, 0.75], [0.22, 0.3, 0.22], [0, -0.5, -1]), 'muscle', pair); an('cricothyroid', [-2.3, -0.9, -1.48], [0, -0.4, -1]);
  add('cad', band([[-3.0, 1.38, -0.22], [-2.2, 1.42, -0.5], [-1.45, 1.12, -0.88]], [0.8, 0.75, 0.42], [0.2, 0.26, 0.2], [0, 1, -0.35]), 'muscle', pair); an('cad', [-2.2, 1.58, -0.52], [0, 1, -0.5]);
  return { parts, anchors };
}

// =============================================================================== simple extras
// Kept for records that ask for them; the current data uses tube/blob records for these.
function hyoid(rec) {
  // local head axes, origin at the middle of the basihyoid; joints are left-side points in order:
  // basihyoid end, ceratohyoid end, epihyoid end, stylohyoid end, tympanohyoid end, thyrohyoid end
  const J = (rec.joints || [[0, 0, -0.09], [0.11, 0.09, -0.16], [0.1, 0.36, -0.2], [-0.1, 0.62, -0.24], [-0.14, 0.66, -0.25], [-0.17, 0.07, -0.13]]).map(p => V(p));
  const rod = (a, b, r) => sweep(curveOf([a, b]), { n: 8, m: 10, size: t => { const k = r * (1 + 0.35 * Math.pow(Math.abs(2 * t - 1), 3)); return [k, k]; }, round: true });
  const side = { mirrorLocal: true };
  return { parts: [
    { key: 'basihyoid', geometry: rod(J[0], J[0].clone().setZ(-J[0].z), 0.014), kind: 'bone' },
    { key: 'ceratohyoid', geometry: rod(J[0], J[1], 0.011), kind: 'bone', ...side }, { key: 'epihyoid', geometry: rod(J[1], J[2], 0.011), kind: 'bone', ...side },
    { key: 'stylohyoid', geometry: rod(J[2], J[3], 0.011), kind: 'bone', ...side }, { key: 'tympanohyoid', geometry: rod(J[3], J[4], 0.009), kind: 'cartilage', ...side },
    { key: 'thyrohyoid', geometry: rod(J[0], J[5], 0.011), kind: 'bone', ...side },
  ], anchors: { basihyoid: [A(V(0, -0.014, 0), V(0, -1, 0))], apparatus: [A(J[1].clone().lerp(J[2], 0.5), V(0, 0, -1))] } };
}
export function tracheaParts(points, r, rings = {}, closedUp = [0, 1, 0]) {
  const c = curveOf(points), len = c.getLength(), nseg = Math.max(20, Math.round(len / 0.03));
  // the wall between and under the rings stands for the annular ligaments
  const wall = hollowTube(c, r, r * 0.86, { n: nseg, m: 28, up: closedUp });
  const sp = rings.spacing || r * 0.55, n = Math.max(1, Math.floor(len / sp)), list = [];
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), gap = rings.open === 'none' ? 0 : 0.5;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, P = c.getPointAt(t); c.getTangentAt(t, T).normalize(); N.set(...closedUp).addScaledVector(T, -N.dot(T)).normalize(); B.crossVectors(T, N);
    const pts = []; for (let k = 0; k <= 14; k++) { const a = lerp(-Math.PI + gap, Math.PI - gap, k / 14); pts.push(P.clone().addScaledVector(N, -Math.cos(a) * r * 0.985).addScaledVector(B, Math.sin(a) * r * 0.985)); }
    // slim hoops, mostly bedded in the wall, tapering to their free dorsal ends
    list.push(sweep(curveOf(pts), { n: 30, m: 8, power: 0.8, n0: N.clone().negate(), size: q => { const e = 0.55 + 0.45 * Math.pow(Math.sin(Math.PI * q), 0.4); return [sp * 0.3 * e, r * 0.045 * e]; }, uv: [1, 1] }));
  }
  // trachealis: the muscular membrane closing the rings dorsally
  const dors = []; for (let i = 0; i <= 12; i++) { const t = i / 12, P = c.getPointAt(t); c.getTangentAt(t, T).normalize(); N.set(...closedUp).addScaledVector(T, -N.dot(T)).normalize(); dors.push(P.addScaledVector(N, r * 0.955)); }
  const trachealis = sweep(curveOf(dors), { n: nseg, m: 12, power: 0.9, up: closedUp, size: () => [r * Math.sin(gap) * 1.08, r * 0.05], uv: [4, 1] });
  return { wall, rings: merge(list), trachealis, mid: c.getPointAt(0.5), r };
}
function esophagusTrachea(rec) {
  const L = rec.length ?? 0.6, r = rec.r ?? 0.085;
  const t = tracheaParts(rec.path || [[0, 0, 0], [-L / 2, 0, 0], [-L, 0, 0]], r, { spacing: rec.spacing });
  const ePath = (rec.esophagusPath || [[0, r * 1.5, -r * 0.3], [-L / 2, r * 1.5, -r * 0.5], [-L, r * 1.5, -r * 0.6]]).map(p => V(p));
  const eso = sweep(curveOf(ePath), { n: 30, m: 14, up: [0, 1, 0], size: () => [r * 0.62, r * 0.36], uv: [3, 2] });
  return { parts: [{ key: 'trachea', geometry: t.wall, kind: 'mucosa', opts: { color: 0xd8cbc4 } }, { key: 'trachealis', termKey: 'trachea', geometry: t.trachealis, kind: 'esophagus', opts: { color: 0xc59286 } }, { key: 'cartilages', geometry: t.rings, kind: 'cartilage', opts: { color: 0xd3dcdf } }, { key: 'esophagus', geometry: eso, kind: 'muscle', opts: { color: 0xb86a5e } }],
    anchors: { trachea: [A(t.mid.clone().add(V(0, 0, -r)), V(0, 0, -1))], cartilages: [A(t.mid.clone().add(V(0.1, -r, -r * 0.4)), V(0, -0.6, -1))], esophagus: [A(ePath[1].clone().add(V(0, r * 0.36, 0)), V(0, 1, -0.4))] } };
}
function thyroid(rec) {
  const r = rec.r ?? 0.085, lobe = at(ellipsoid([0.13, 0.045, 0.022], { detail: 3, bump: 0.08 }), 0, 0, -(r + 0.024));
  const para = at(ellipsoid([0.016, 0.012, 0.01], { detail: 2 }), 0.1, 0.02, -(r + 0.046));
  return { parts: [{ key: 'thyroid', geometry: lobe, kind: 'thyroid', mirrorLocal: true }, { key: 'parathyroid', geometry: para, kind: 'gland', opts: { color: 0xd9c19a }, mirrorLocal: true }],
    anchors: { thyroid: [A(V(0, 0, -(r + 0.047)), V(0, 0, -1))], parathyroid: [A(V(0.1, 0.02, -(r + 0.057)), V(0, 0, -1))] } };
}

const MODELS = { eye, eyelids, auricle, 'nasal-planum': nasalPlanum, lips, tongue, larynx, hyoid, 'esophagus-trachea': esophagusTrachea, thyroid };

export function modelMatrix(rec) {
  const p = rec.position || [0, 0, 0], r = rec.rotation || [0, 0, 0], s = rec.scale ?? 1, sc = Array.isArray(s) ? s : [s, s, s];
  return new THREE.Matrix4().compose(V(p), new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], 'XYZ')), V(sc));
}
export function buildModel(rec, ctx) {
  const fn = MODELS[rec.kind]; if (!fn) return null;
  const M = modelMatrix(rec), out = fn(rec, M, ctx);
  out.matrix = M;
  return out;
}
