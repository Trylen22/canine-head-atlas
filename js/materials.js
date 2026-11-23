// Lab-realistic materials. One factory, keyed by tissue kind. Every part gets its own instance so
// it can be highlighted and faded on its own.
import * as THREE from 'three';

const tex = {};
function canvasTex(key, size, draw, repeat = 1) {
  if (tex[key]) return tex[key];
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return (tex[key] = t);
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Streaks running along U: muscle fibres. Used as colour modulation and as a bump map.
function fiberTex() {
  return canvasTex('fiber', 256, (g, n) => {
    const r = rng(7); g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 520; i++) {
      const y = r() * n, w = 0.6 + r() * 2.2, v = 150 + Math.floor(r() * 105);
      g.strokeStyle = `rgba(${v},${v},${v},${0.25 + r() * 0.5})`; g.lineWidth = w;
      g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(n / 3, y + (r() - .5) * 3, 2 * n / 3, y + (r() - .5) * 3, n, y); g.stroke();
    }
  });
}
function speckleTex(key, base, dots, seed, count, rad) {
  return canvasTex(key, 256, (g, n) => {
    const r = rng(seed); g.fillStyle = base; g.fillRect(0, 0, n, n);
    for (let i = 0; i < count; i++) {
      const x = r() * n, y = r() * n, a = rad * (0.4 + r());
      g.fillStyle = dots[Math.floor(r() * dots.length)];
      for (const [dx, dy] of [[0, 0], [n, 0], [-n, 0], [0, n], [0, -n]]) { g.beginPath(); g.ellipse(x + dx, y + dy, a, a * (0.6 + r() * 0.6), r() * 3, 0, 7); g.fill(); }
    }
  });
}
const cutBoneTex = () => speckleTex('cutbone', '#efe6d2', ['rgba(150,110,80,.20)', 'rgba(120,80,60,.14)', 'rgba(255,250,235,.5)'], 11, 900, 2.4);
const pebbleTex = () => speckleTex('pebble', '#8a8a8a', ['rgba(255,255,255,.35)', 'rgba(0,0,0,.35)'], 5, 700, 5);
const cutMeatTex = () => speckleTex('cutmeat', '#e9e9e9', ['rgba(120,120,120,.18)', 'rgba(255,255,255,.3)'], 23, 500, 3.2);

// kind -> { color, roughness, ... , cap: cut-surface colour, capRank: which cap wins where solids overlap }
export const KINDS = {
  bone:      { color: 0xe8d4ae, roughness: 0.64, sheenBone: true, grain: true, cap: 0xf1e8d4, capTex: 'bone', capRank: 9 },
  tooth:     { color: 0xf1ece0, roughness: 0.3, cap: 0xf4efe2, capRank: 9 },
  cartilage: { color: 0xd9e5ec, roughness: 0.42, clearcoat: 0.35, cap: 0xe6eff4, capRank: 8 },
  ligament:  { color: 0xe6dfcb, roughness: 0.55, cap: 0xe9e2d0, capRank: 7 },
  tendon:    { color: 0xe2d9c4, roughness: 0.45, cap: 0xe6dfcd, capRank: 7 },
  artery:    { color: 0xb0261f, roughness: 0.3, clearcoat: 0.45, cap: 0x8e1c18, capRank: 6 },
  vein:      { color: 0x35548f, roughness: 0.32, clearcoat: 0.4, cap: 0x293f6d, capRank: 6 },
  nerve:     { color: 0xeadf9f, roughness: 0.46, satin: true, cap: 0xf0e8bd, capRank: 6 },
  ganglion:  { color: 0xdcc86f, roughness: 0.55, cap: 0xe5d58d, capRank: 6 },
  duct:      { color: 0xcdb48c, roughness: 0.5, cap: 0xb99e78, capRank: 5 },
  lymph:     { color: 0x9a8468, roughness: 0.6, cap: 0x85705a, capRank: 5 },
  node:      { color: 0x9a8468, roughness: 0.6, cap: 0x85705a, capRank: 5 },
  gland:     { color: 0xc79d72, roughness: 0.7, cap: 0xb98a62, capRank: 4 },
  thyroid:   { color: 0x8a4a3c, roughness: 0.55, cap: 0x7a3d32, capRank: 4 },
  tonsil:    { color: 0xb5625f, roughness: 0.6, cap: 0xa55552, capRank: 4 },
  fat:       { color: 0xe6d49a, roughness: 0.7, cap: 0xe0cd90, capRank: 2 },
  muscle:    { color: 0x8f3c33, roughness: 0.38, clearcoat: 0.26, fiber: true, sheen: true, cap: 0x9a4a40, capTex: 'meat', capRank: 3 },
  mucosa:    { color: 0xd38d88, roughness: 0.4, clearcoat: 0.25, cap: 0xc27a76, capTex: 'meat', capRank: 2 },
  tongue:    { color: 0xcf8482, roughness: 0.55, cap: 0xb0605c, capTex: 'meat', capRank: 2 },
  skin:      { color: 0xd3a88f, roughness: 0.8, cap: 0xd6b6a0, capRank: 1 },
  pigment:   { color: 0x2a2523, roughness: 0.55, pebble: true, cap: 0x8a5e58, capRank: 1 },
  sclera:    { color: 0xf0ece4, roughness: 0.35, clearcoat: 0.5, cap: 0xf3efe8, capRank: 5 },
  cornea:    { color: 0xdfeaf0, roughness: 0.05, opacity: 0.16, clearcoat: 1, cap: 0xdfeaf0, capRank: 5 },
  iris:      { color: 0x6a4424, roughness: 0.5, cap: 0x5a3a20, capRank: 5 },
  black:     { color: 0x0b0b0c, roughness: 0.25, cap: 0x0b0b0c, capRank: 5 },
  choroid:   { color: 0x3a2622, roughness: 0.6, cap: 0x3a2622, capRank: 5 },
  tapetum:   { color: 0x6fc7a6, roughness: 0.22, metalness: 0.55, emissive: 0x1c4a40, cap: 0x6fc7a6, capRank: 5 },
  retina:    { color: 0xe9d9c4, roughness: 0.6, opacity: 0.42, cap: 0xe9d9c4, capRank: 5 },
  ciliary:   { color: 0x4a2f2a, roughness: 0.6, cap: 0x4a2f2a, capRank: 5 },
  lens:      { color: 0xf1ead2, roughness: 0.12, opacity: 0.82, clearcoat: 0.8, cap: 0xf1ead2, capRank: 5 },
  vitreous:  { color: 0xcfe0e6, roughness: 0.1, opacity: 0.14, cap: 0xcfe0e6, capRank: 5 },
  aqueous:   { color: 0xcfe3ee, roughness: 0.1, opacity: 0.12, cap: 0xcfe3ee, capRank: 5 },
  limbus:    { color: 0x6b5a4e, roughness: 0.4, cap: 0x6b5a4e, capRank: 5 },
  esophagus: { color: 0xb9695d, roughness: 0.5, fiber: true, cap: 0xa85a50, capTex: 'meat', capRank: 3 },
  fascia:    { color: 0xe4dccb, roughness: 0.5, opacity: 0.9, cap: 0xe4dccb, capRank: 2 },
  floor:     { color: 0xd8cdb6, roughness: 0.9, cap: 0xf1e8d4, capRank: 9 },
  floorhole: { color: 0xd8cdb6, roughness: 0.85, cap: 0x0b0b0c, capRank: 9 },
  lumen:     { color: 0x5a2f2f, roughness: 0.7, cap: 0x5a2f2f, capRank: 1 },
};
// tube / blob "kind" words used in the data files -> material kind
const ALIAS = { papilla: 'mucosa', sinus: 'artery', trachea: 'mucosa', a: 'artery', v: 'vein', n: 'nerve', ln: 'node', 'lymph-node': 'node', lymphnode: 'node', salivary: 'gland', esophagus: 'mucosa', trachea: 'mucosa' };
export function kindOf(k, fallback = 'mucosa') { k = (k || '').toLowerCase(); k = ALIAS[k] || k; return KINDS[k] ? k : fallback; }

// Fine 3D noise in object space: bone has no UVs, so its micro-roughness and faint mottling come from here.
function grain(sh) {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vOP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvOP = position;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vOP;
float h31(vec3 p){ p = fract(p * .1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float vn3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
float bn = vn3(vOP * 60.) * .55 + vn3(vOP * 190.) * .45;
roughnessFactor = clamp(roughnessFactor * (.8 + .4 * bn), 0., 1.);
diffuseColor.rgb *= .955 + .08 * bn;`);
}

// Draw a surface a little nearer than it is (along the view ray, so it does not move on screen).
// The study floor uses it to cover the rough CT floor it lies on.
export function pull(sh) {
  sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
mvPosition.xyz *= 1.0 - 0.004 / max( length( mvPosition.xyz ), 0.05 );
gl_Position = projectionMatrix * mvPosition;`);
}

export function makeMaterial(kind, o = {}) {
  const K = KINDS[kind] || KINDS.mucosa;
  const physical = K.clearcoat || K.sheen || K.sheenBone || K.satin;
  const m = physical ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
  m.color.set(o.color ?? K.color);
  m.roughness = K.roughness; m.metalness = K.metalness || 0;
  if (K.clearcoat) { m.clearcoat = K.clearcoat; m.clearcoatRoughness = 0.35; }
  if (K.sheen) { m.sheen = 0.55; m.sheenRoughness = 0.45; m.sheenColor.set(0xffc9b0); }
  if (K.sheenBone) { m.sheen = 0.3; m.sheenRoughness = 0.7; m.sheenColor.set(0xffd2a6); m.specularIntensity = 0.45; }
  if (K.satin) { m.sheen = 0.35; m.sheenRoughness = 0.5; m.sheenColor.set(0xfff6d8); }
  if (K.grain) m.onBeforeCompile = grain;
  if (o.pull) m.onBeforeCompile = pull;
  if (K.emissive) m.emissive.set(K.emissive);
  if (K.fiber) { m.map = fiberTex(); m.bumpMap = fiberTex(); m.bumpScale = 0.6; }
  if (K.pebble) { m.bumpMap = pebbleTex(); m.bumpScale = 1.2; }
  m.envMapIntensity = 0.6;
  m.side = o.doubleSide ? THREE.DoubleSide : THREE.FrontSide;
  m.userData.baseOpacity = o.opacity ?? K.opacity ?? 1;
  m.userData.baseEmissive = m.emissive.clone();
  return m;
}

export function makeCapMaterial(kind) {
  const K = KINDS[kind] || KINDS.mucosa;
  const m = new THREE.MeshStandardMaterial({ color: K.cap ?? K.color, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  if (K.capTex === 'bone') m.map = cutBoneTex();
  if (K.capTex === 'meat') m.map = cutMeatTex();
  m.envMapIntensity = 0.2;
  return m;
}
export const capRank = kind => (KINDS[kind] || KINDS.mucosa).capRank || 1;

// Dots for the layers panel and index, taken from the tissue colours above.
export const LAYER_SWATCH = { bone: '#d9cdb0', nv_sup: '#3f62a3', nv_deep: '#b0261f', ms_sup: '#a2493e', ms_deep: '#7a2f28' };
