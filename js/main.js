// Canine Head Atlas: data loading, structure building, and all the interface wiring.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Stage, LAYERS } from './scene.js';
import { Labels } from './labels.js';
import { kindOf, LAYER_SWATCH } from './materials.js';
import { V, buildTube, buildMuscle, buildSheet, buildBlob } from './builders.js';
import { buildModel, tracheaParts } from './models.js';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fatal = msg => { const f = $('#fatal'); f.hidden = false; f.textContent += (f.textContent ? '\n' : '') + msg; console.error(msg); };
window.addEventListener('error', e => fatal(e.message + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '')));
window.addEventListener('unhandledrejection', e => fatal('' + (e.reason && e.reason.stack || e.reason)));
const store = { get(k) { try { return localStorage.getItem('cha:' + k); } catch { return null; } }, set(k, v) { try { localStorage.setItem('cha:' + k, v); } catch { /* private window */ } } };
const Q = new URLSearchParams(location.search);     // test hooks only: ?v=left&split=apart&layers=bone&sel=<id>&quiz=1

const LAYER_NAME = { bone: '1. Bone', nv_sup: '2a. Nerves & blood vessels, superficial', nv_deep: '2b. Nerves & blood vessels, deep', ms_sup: '3a. Muscles & other structures, superficial', ms_deep: '3b. Muscles & other structures, deep' };
const MIRROR = new THREE.Matrix4().makeScale(1, 1, -1);

async function getJSON(url, fallback) {
  for (const u of [url, fallback]) {
    if (!u) continue;
    try { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) continue; return await r.json(); } catch { /* try the fallback */ }
  }
  return null;
}

const app = {
  terms: [], byId: new Map(), anchors: new Map(), meshOf: new Map(), named: new Map(),
  selected: null, group: null, density: 'focus', quiz: null, eyecut: false,
};
let stage, labels;

// ============================================================================ boot
async function boot() {
  stage = new Stage($('#gl'));
  window.__atlas = { app, stage };
  if (Q.get('instant')) stage.instant = true;
  const [terms, anchorsRaw, structsRaw] = await Promise.all([
    getJSON('data/terms.json'), getJSON('data/anchors.json', 'data/sample/anchors.json'), getJSON('data/structures.json', 'data/sample/structures.json'),
  ]);
  if (!terms) { fatal('Could not load data/terms.json'); return; }
  app.terms = terms; for (const t of terms) app.byId.set(t.id, t);
  buildIndex(); buildLayers(); wire();

  labels = new Labels(stage, $('#labels'), $('#leaders'), {
    anchorFor, ownParts, candidates, medial, density: () => app.density, isQuiz: () => !!app.quiz, quizPins, onPick: id => select(id, { fly: false }), onPin: quizPick, onCount,
    onHover: id => stage.setHover(id && !app.quiz ? [...ownParts(id)] : []), get selected() { return app.selected; },
  });

  try { await loadSkull(); } catch (e) { fatal('Could not load assets/skull.glb: ' + e.message); }
  const structs = Array.isArray(structsRaw) ? structsRaw : (structsRaw && structsRaw.structures) || [];
  let bad = 0;
  // membranes and skin go last so they can be laid over everything beneath them
  const late = r => r && (r.type === 'sheet' || (r.type === 'model' && r.kind === 'lips'));
  for (const rec of [...structs.filter(r => !late(r)), ...structs.filter(late)]) { try { buildStructure(rec); } catch (e) { bad++; console.warn('structure', rec && rec.id, e); } }
  if (bad) console.warn(bad + ' structure records could not be built');
  for (const p of stage.parts) { if (!app.named.has(p.name)) app.named.set(p.name, []); app.named.get(p.name).push(p); }
  loadAnchors(anchorsRaw || {});
  markPlaced();
  stage.setTagHidden('eye:cut', true);
  if (!Q.get('layers')) setLayers(['bone', 'nv_sup', 'ms_sup']);
  stage.finishBone(); stage.addShadow();
  $('#status').hidden = true;
  applyParams();
  labels.invalidate();
}

// ============================================================================ skull
async function loadSkull() {
  // The skull ships as base64 inside JSON (assets/skull.glb.json) because the claude.ai artifact host
  // does not serve .glb; any static host serves .json. Falls back to the raw .glb if the JSON is missing.
  let gltf;
  try {
    const pack = await (await fetch('assets/skull.glb.json')).json();
    const bin = Uint8Array.from(atob(pack.data), c => c.charCodeAt(0));
    gltf = await new GLTFLoader().parseAsync(bin.buffer, '');
  } catch (e) {
    gltf = await new GLTFLoader().loadAsync('assets/skull.glb');
  }
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    const name = (o.userData && o.userData.name) || o.name || 'bone';
    let g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    g.computeVertexNormals();
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    g.computeBoundingBox(); box.union(g.boundingBox);
    let termId = null; const m = /^bone:?(.+)$/.exec(name);
    if (m && app.byId.has(m[1])) termId = m[1]; else if (name === 'mandible') termId = 'mandibles'; else if (app.byId.has(name)) termId = name;
    stage.addPart({ geometry: g, kind: 'bone', layer: 'bone', termId, name: m ? 'bone:' + m[1] : name, tag: 'skull' });
  });
  if (!box.isEmpty()) { box.getCenter(stage.center); stage.center.z = 0; stage.size = box.getSize(new THREE.Vector3()); stage.radius = stage.size.length() * 0.5 * 0.86; }
  stage.preset(Q.get('v') || 'reset', 1);
}

// ============================================================================ structures
const boneRay = new THREE.Ray(), _dr = new THREE.Ray();
const ctx = {
  // Lift a point that would sit under the bone surface back on top of it (looking along -n).
  // `pull` > 0 also draws a point floating above the bone down onto it (shrink-wrap for membranes).
  drape(p, n, lift = 0.004, reach = 0.09, pull = 0) {
    boneRay.origin.copy(p).addScaledVector(n, reach); boneRay.direction.copy(n).negate();
    let best = reach + pull;
    for (const b of stage.parts) { if (!(b.tag === 'skull' || (ctx.over && ctx.over(b))) || b.side === 'R' || !boneRay.intersectsSphere(b.sphere)) continue;
      _dr.copy(boneRay).applyMatrix4(b.inv); const h = b.geometry.boundsTree.raycastFirst(_dr, THREE.DoubleSide); if (h) { const d = h.point.applyMatrix4(b.matrix).distanceTo(boneRay.origin); if (d < best) best = d; } }
    return best < reach + pull ? p.clone().addScaledVector(n, reach - best + lift) : p;
  },
  sheet: rec => buildSheet(rec, ctx),
};
function termOf(rec) {
  for (const c of [rec.term, rec.id]) { if (c && app.byId.has(c)) return c; }
  if (rec.term) { const t = app.terms.find(t => t.term.toLowerCase() === String(rec.term).toLowerCase()); if (t) return t.id; }
  return null;
}
function addBoth(spec, mirror) {
  const a = stage.addPart(spec);
  if (mirror) stage.addPart({ ...spec, matrix: MIRROR.clone().multiply(spec.matrix || new THREE.Matrix4()), anchor: null, mirrorOf: a });
  return a;
}
function buildStructure(rec) {
  if (!rec || !rec.type && !rec.kind) return;
  const type = rec.type || (rec.points ? 'tube' : rec.path ? 'muscle' : rec.outline || rec.grid ? 'sheet' : rec.center ? 'blob' : rec.parts ? 'model' : null);
  const termId = termOf(rec), term = termId && app.byId.get(termId), layer = rec.layer || (term && term.layer) || 'ms_deep';
  const opts = rec.color ? { color: rec.color } : undefined;
  const base = { termId, layer, name: rec.id, opts };
  if (type === 'tube') {
    if (rec.kind === 'trachea') {
      const t = tracheaParts(rec.points, rec.r ?? 0.085, rec.rings || {});
      const n = V(0, 0, -1);
      addBoth({ ...base, geometry: t.wall, kind: 'mucosa', opts: { color: rec.color || 0xd8cbc4 }, anchor: { pos: t.mid.clone().add(V(0, 0, -t.r)), normal: n } }, false);
      addBoth({ ...base, name: rec.id + ':trachealis', geometry: t.trachealis, kind: 'esophagus', opts: { color: 0xc59286 } }, false);
      const rt = rec.rings && rec.rings.term && app.byId.has(rec.rings.term) ? rec.rings.term : null;
      addBoth({ ...base, termId: rt, name: rec.id + ':rings', geometry: t.rings, kind: 'cartilage', opts: { color: 0xd3dcdf }, anchor: { pos: t.mid.clone().add(V(0.04, -t.r * 0.8, -t.r * 0.7)), normal: n } }, false);
      return;
    }
    const b = buildTube(rec);
    addBoth({ ...base, geometry: b.geometry, kind: kindOf(rec.kind, 'duct'), anchor: b.anchor }, rec.mirror);
  } else if (type === 'muscle') {
    ctx.lift = layer === 'ms_sup'; const b = buildMuscle(rec, ctx);
    addBoth({ ...base, geometry: b.geometry, kind: kindOf(rec.kind, 'muscle'), anchor: b.anchor }, rec.mirror);
  } else if (type === 'sheet') {
    const sup = layer === 'ms_sup' || layer === 'nv_sup';
    ctx.over = sup ? (p => (p.kind === 'muscle' || p.kind === 'gland') && !p.isSheet && p.layer !== 'bone') : null;
    const b = buildSheet({ wrap: sup ? 0.3 : 0.1, ...rec }, ctx); ctx.over = null;
    const isMuscle = term ? /\bm{1,2}\.(\s|$)/.test(term.term) : true;
    const kind = rec.kind ? kindOf(rec.kind, 'muscle') : isMuscle ? 'muscle' : /palate/.test(termId || '') ? 'mucosa' : 'fascia';
    const sp = addBoth({ ...base, geometry: b.geometry, kind, anchor: b.anchor }, rec.mirror); sp.isSheet = true;
  } else if (type === 'blob') {
    const b = buildBlob(rec);
    addBoth({ ...base, geometry: b.geometry, kind: kindOf(rec.kind, 'gland'), anchor: b.anchor }, rec.mirror);
  } else if (type === 'model') {
    const m = buildModel(rec, ctx); if (!m) { console.warn('unknown model kind', rec.kind); return; }
    const map = rec.parts || {}, I = new THREE.Matrix4();
    const tid = key => { const v = map[key]; return v && app.byId.has(v) ? v : null; };
    for (const p of m.parts) {
      const key = p.termKey || p.key; if (map[key] === null || map[key] === false) continue;
      const t = tid(key), M = p.world ? I : m.matrix;
      const spec = { geometry: p.geometry, kind: p.kind, opts: p.opts, tag: p.tag, noCap: p.noCap, noPick: p.noPick, termId: t, layer: (t && rec.layer == null ? app.byId.get(t).layer : rec.layer) || 'ms_deep', name: rec.id + ':' + p.key, matrix: M };
      stage.addPart(spec);
      if (p.mirrorLocal) stage.addPart({ ...spec, matrix: M.clone().multiply(MIRROR) });
      if (rec.mirror) { stage.addPart({ ...spec, matrix: MIRROR.clone().multiply(M) }); if (p.mirrorLocal) stage.addPart({ ...spec, matrix: MIRROR.clone().multiply(M).multiply(MIRROR) }); }
    }
    for (const [key, list] of Object.entries(m.anchors || {})) {
      const t = tid(key); if (!t) continue;
      const nm = new THREE.Matrix3().getNormalMatrix(m.matrix);
      app.modelAnchors = app.modelAnchors || new Map();
      app.modelAnchors.set(t, list.map(a => ({ pos: a.world ? a.pos.clone() : a.pos.clone().applyMatrix4(m.matrix), normal: a.world ? a.normal.clone().normalize() : a.normal.clone().applyMatrix3(nm).normalize(), tag: a.tag || null, model: rec.id })));
    }
  }
}

// ============================================================================ anchors
// app.anchors: term id -> [{ pos, normal, side, views:Set, tag?, mesh? }]; the first whose tag is active wins.
function radial(pos) { const n = new THREE.Vector3(0, pos.y - stage.center.y, pos.z); if (n.lengthSq() < 1e-4) n.set(0, 1, 0); n.normalize(); if (pos.x > stage.center.x + stage.radius * 0.62) n.x += 0.8; return n.normalize(); }
function loadAnchors(raw) {
  const MA = app.modelAnchors || new Map();
  for (const t of app.terms) {
    const r = raw[t.id], list = [];
    const views = new Set(r && Array.isArray(r.views) && r.views.length ? r.views : [t.view]);
    const side = (r && r.side) || 'left';
    if (r && r.mesh) app.meshOf.set(t.id, r.mesh);
    if (MA.has(t.id)) for (const a of MA.get(t.id)) list.push({ ...a, side: Math.abs(a.pos.z) < 0.004 ? 'median' : a.pos.z > 0 ? 'right' : 'left', views });
    if (r && Array.isArray(r.pos)) { const pos = V(r.pos); list.push({ pos, normal: r.normal ? V(r.normal).normalize() : radial(pos), hasNormal: !!r.normal, ring: typeof r.ring === 'number' ? r.ring : null, best: VIEW_NAME[r.best] ? r.best : null, side, views, given: true }); if (views.has('calvaria')) app.hasCalvaria = true; }
    if (!list.length) { const ps = (stage.byTerm.get(t.id) || []).filter(p => p.anchor); if (ps.length) list.push({ pos: ps[0].anchor.pos.clone(), normal: ps[0].anchor.normal.clone(), side: 'left', views }); }
    if (list.length) app.anchors.set(t.id, list);
  }
  // a repeated term borrows the placement of its twin
  for (const t of app.terms) if (!app.anchors.has(t.id) && t.sameAs) for (const o of t.sameAs) if (app.anchors.has(o)) { app.anchors.set(t.id, app.anchors.get(o)); break; }
}
const tagOn = tag => !tag || (tag === 'eye:cut' ? app.eyecut : tag === 'eye:whole' ? !app.eyecut : true);
function anchorFor(id) {
  const l = app.anchors.get(id); if (!l) return null;
  // a part that only exists in one state of the eye is not labelled from a stand-in pin in the other
  const tagged = l.some(a => a.tag);
  for (const a of l) if (tagOn(a.tag) && (a.tag || !tagged)) return a;
  return null;
}
const ownCache = new Map();
function ownParts(id) {
  let s = ownCache.get(id);
  if (!s) {
    s = new Set(stage.byTerm.get(id) || []);
    const t = app.byId.get(id); if (t && t.sameAs) for (const o of t.sameAs) for (const p of stage.byTerm.get(o) || []) s.add(p);
    const mesh = app.meshOf.get(id);
    if (mesh) { for (const p of app.named.get(mesh) || []) s.add(p); for (const p of stage.parts) if (p.name === mesh || p.name.startsWith(mesh + ':')) s.add(p); }
    ownCache.set(id, s);
  }
  return s;
}
const mode = () => stage.floor ? 'calvaria' : stage.split === 'whole' ? 'surface' : 'bisected';
// Is this pin meant for the current view? Until anchors carry "calvaria", the Floor view falls back
// to the cranial cavity and cranial nerve sections.
function viewOK(a, t, m) {
  if (m !== 'calvaria') return a.views.has(m);
  return a.views.has('calvaria') || (!app.hasCalvaria && (t.section === 'Cavities of the skull' || t.section.startsWith('Cranial nerves')));
}
const VIEW_NAME = { surface: 'Whole head, from the outside', bisected: 'Bisected, on the median section', calvaria: 'Floor, calvaria removed' };
function goView(v) { if (v === 'bisected') setSplit('apart', { halves: 'left' }); else if (v === 'calvaria') setSplit('floor'); else setSplit('whole'); }
// Importance of a term for the current layers: the top visible layer first, bigger structures first.
const DEPTH = ['ms_sup', 'nv_sup', 'ms_deep', 'nv_deep', 'bone'];
const sizeCache = new Map();
function sizeOf(id) {
  let r = sizeCache.get(id);
  if (r === undefined) { r = 0; for (const p of ownParts(id)) r = Math.max(r, p.sphere.radius); const t = app.byId.get(id); if (t.heading) r *= 0.5; sizeCache.set(id, r = Math.min(1, r)); }
  return r;
}
function candidates() {
  if (app.density === 'none' && !app.selected) return [];
  const m = mode(), out = [], seen = new Set();
  const visible = DEPTH.filter(k => stage.layers[k].visible), top = visible[0];
  for (const t of app.terms) {
    const isSel = t.id === app.selected;
    if (!isSel) { if (app.density === 'none') continue; if (app.density === 'group' && t.section !== app.group) continue; }
    if (!stage.layers[t.layer].visible) continue;
    const a = anchorFor(t.id); if (!a || !viewOK(a, t, m)) continue;
    const key = t.term + '|' + a.pos.x.toFixed(3) + a.pos.y.toFixed(3);
    if (seen.has(key) && !isSel) continue; seen.add(key);
    const rank = visible.length - visible.indexOf(t.layer);
    out.push({ id: t.id, term: t, pri: (t.layer === top ? 20 : rank) + sizeOf(t.id) * 6 + (t.section === app.group ? 3 : 0) });
  }
  return out;
}
// in the bisected views: does this pin belong to the cut (medial) face rather than the outside?
function medial(a, id) { const t = app.byId.get(id); return a.side === 'median' || t.view === 'bisected' || Math.abs(a.pos.z) < 0.05; }
function markPlaced() {
  for (const b of $$('#index .term')) {
    const placed = app.anchors.has(b.dataset.id) || ownParts(b.dataset.id).size > 0;
    b.classList.toggle('unplaced', !placed);
    let np = b.querySelector('.np'); if (!placed && !np) { np = el('span', 'np', 'not placed yet'); b.querySelector('.txt').appendChild(np); } else if (placed && np) np.remove();
  }
}

// ============================================================================ index
function buildIndex() {
  const host = $('#index'), secs = new Map();
  for (const t of app.terms) { if (!secs.has(t.section)) secs.set(t.section, []); secs.get(t.section).push(t); }
  for (const [name, list] of secs) {
    const s = el('section', 'sec closed'); s.dataset.section = name;   // sections start collapsed; search and selection open them
    const h = el('button'); h.type = 'button'; h.append(el('span', 'chev'), el('span', 'name', name), el('span', 'n', String(list.length)));
    h.addEventListener('click', () => s.classList.toggle('closed'));
    const ul = el('ul');
    for (const t of list) {
      const li = el('li'), b = el('button', 'term' + (t.heading ? ' heading' : '')); b.type = 'button'; b.dataset.id = t.id; b.style.setProperty('--lc', LAYER_SWATCH[t.layer]);
      b.title = LAYER_NAME[t.layer];
      b.append(el('span', 'dot'), el('span', 'txt', t.term));
      b.addEventListener('click', () => { select(t.id, { fly: true, reveal: true }); if (matchMedia('(max-width: 1100px)').matches) sheet(''); });
      li.append(b); ul.append(li);
    }
    s.append(h, ul); host.append(s);
  }
  const empty = el('p', 'empty', 'No term matches.'); empty.hidden = true; empty.id = 'index-empty'; host.append(empty);
  $('#search').addEventListener('input', e => filterIndex(e.target.value));
  $('#search-count').textContent = '';
}
function filterIndex(q) {
  q = q.trim().toLowerCase(); let n = 0;
  for (const s of $$('#index .sec')) {
    let any = false;
    for (const b of s.querySelectorAll('.term')) {
      const t = app.byId.get(b.dataset.id), hit = !q || t.term.toLowerCase().includes(q);
      b.parentElement.hidden = !hit; any = any || hit; if (hit) n++;
      const txt = b.querySelector('.txt'), np = txt.querySelector('.np');
      txt.textContent = '';
      if (q && hit) { const i = t.term.toLowerCase().indexOf(q); txt.append(t.term.slice(0, i), el('mark', '', t.term.slice(i, i + q.length)), t.term.slice(i + q.length)); } else txt.textContent = t.term;
      if (np) txt.appendChild(np);
    }
    s.hidden = !any; if (q && any) s.classList.remove('closed');
  }
  $('#index-empty').hidden = n > 0;
  $('#search-count').textContent = q ? n + ' found' : '';
}

// ============================================================================ layers
const LAYER_ROWS = [
  { head: '1. Bone', keys: ['bone'] },
  { head: '2. Nerves & blood vessels', keys: ['nv_sup', 'nv_deep'], subs: [['nv_sup', 'a. Superficial'], ['nv_deep', 'b. Deep']] },
  { head: '3. Muscles & other structures', keys: ['ms_sup', 'ms_deep'], subs: [['ms_sup', 'a. Superficial'], ['ms_deep', 'b. Deep']] },
];
function buildLayers() {
  const host = $('#layers');
  const row = (cls, name, keys, swatch) => {
    const r = el('div', 'layer ' + cls), id = 'ly-' + keys.join('-');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.id = id; cb.dataset.keys = keys.join(',');
    const lab = el('label', 'lname'); lab.htmlFor = id; if (swatch) { const i = el('i'); i.style.setProperty('--lc', swatch); lab.append(i); } lab.append(name);
    const sl = el('input'); sl.type = 'range'; sl.min = 10; sl.max = 100; sl.value = 100; sl.id = id + '-op'; sl.dataset.keys = keys.join(','); sl.setAttribute('aria-label', name + ' opacity');
    cb.addEventListener('change', () => { for (const k of keys) stage.setLayer(k, { visible: cb.checked }); syncLayers(); });
    sl.addEventListener('input', () => { for (const k of keys) stage.setLayer(k, { opacity: sl.value / 100 }); syncLayers(true); });
    r.append(cb, lab, sl); host.append(r);
  };
  for (const g of LAYER_ROWS) { row('head', g.head, g.keys, g.subs ? null : LAYER_SWATCH[g.keys[0]]); for (const [k, n] of g.subs || []) row('sub', n, [k], LAYER_SWATCH[k]); }
}
function syncLayers(sliding) {
  for (const cb of $$('#layers input[type="checkbox"]')) {
    const keys = cb.dataset.keys.split(','), on = keys.filter(k => stage.layers[k].visible).length;
    cb.checked = on === keys.length; cb.indeterminate = on > 0 && on < keys.length; cb.closest('.layer').classList.toggle('off', on === 0);
    const sl = cb.closest('.layer').querySelector('input[type="range"]');
    if (!sliding || keys.length === 1) sl.value = Math.round(Math.max(...keys.map(k => stage.layers[k].opacity)) * 100);
  }
  for (const b of $$('#full-layers button')) b.setAttribute('aria-pressed', stage.layers[b.dataset.layer].visible);
  if (app.quiz) quizRebuild(true);
  if (labels) labels.invalidate();
}
function setLayers(keys) { for (const k of LAYERS) stage.setLayer(k, { visible: keys.includes(k) }); syncLayers(); }

// ============================================================================ view state
function setSplit(m, { instant, halves } = {}) {
  if (m === 'floor') {
    if (stage.split !== 'whole') { stage.setSplit('whole', true); stage.setHalves('both'); }
    if (!stage.floor) {
      // the soft tissue over the vault only hides the cranial floor; the deep nerves stay
      app.layersBefore = LAYERS.filter(k => stage.layers[k].visible);
      setLayers([...new Set([...app.layersBefore.filter(k => k !== 'ms_sup' && k !== 'ms_deep'), 'bone', 'nv_deep'])]);
    }
    stage.setFloor(true, instant);
  } else {
    if (stage.floor) { stage.setFloor(false, instant || m !== 'whole'); if (app.layersBefore) { setLayers(app.layersBefore); app.layersBefore = null; } }
    stage.setSplit(m, instant);
    if (halves) stage.setHalves(halves); else if (m === 'whole' || m === 'tray') stage.setHalves('both');
  }
  for (const b of $$('#seg-split button')) b.setAttribute('aria-pressed', b.dataset.split === m);
  for (const b of $$('#seg-halves button')) b.setAttribute('aria-pressed', b.dataset.halves === stage.halves);
  $('#seg-halves').hidden = m !== 'apart'; $('#floor-h-wrap').hidden = m !== 'floor';
  if (labels) labels.invalidate();
}
function setEyecut(on) { app.eyecut = on; $('#eyecut').checked = on; stage.setTagHidden('eye:cut', !on); stage.setTagHidden('eye:whole', on); if (labels) labels.invalidate(); }
let countKey = '';
const HINT = { focus: 'The main structures in view, plus whatever you select.', all: 'Every visible pin that fits without crowding.', group: '', none: 'Only the selected term is labelled.' };
function onCount(shown, total) {
  const k = shown + '/' + total + app.density + app.group; if (k === countKey) return; countKey = k;
  const base = app.density === 'group' ? (app.group || 'Pick a term to choose its section.') : HINT[app.density];
  $('#density-hint').textContent = app.density !== 'none' && shown < total ? `${base} ${shown} of ${total} shown; zoom in for more.` : base;
}
function setDensity(d) {
  countKey = '';
  app.density = d;
  for (const b of $$('#seg-density button')) b.setAttribute('aria-pressed', b.dataset.density === d);
  $('#density-hint').textContent = d === 'group' ? (app.group ? app.group : 'Pick a term to choose its section.') : HINT[d];
  if (labels) labels.invalidate();
}
function setTheme(t) { document.documentElement.dataset.theme = t; store.set('theme', t); if (labels) setTimeout(() => labels.draw(), 30); }
// In-page fullscreen: the panels slide away and the specimen takes the page. The browser's own
// fullscreen is asked for as well, but the frame or a phone may refuse it, and that is fine.
let fsAsked = false;
function setFull(on) {
  $('#app').classList.toggle('full', on); $('#btn-full').setAttribute('aria-pressed', on);
  $('#btn-full').title = on ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)';
  if (on) sheet('');
  const root = document.documentElement;
  try {
    if (on && root.requestFullscreen && !document.fullscreenElement) { fsAsked = true; const p = root.requestFullscreen(); if (p && p.catch) p.catch(() => { fsAsked = false; }); }
    else if (!on && document.fullscreenElement && document.exitFullscreen) { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); }
  } catch { fsAsked = false; }
}
function sheet(name) { $('#app').dataset.sheet = name; for (const b of $$('#tabbar button')) b.classList.toggle('on', !!name && b.dataset.sheet === name); }

// ============================================================================ selection
function select(id, { fly = false, reveal = false } = {}) {
  if (app.quiz) return;
  app.selected = id;
  for (const b of $$('#index .term.sel')) b.classList.remove('sel');
  const host = $('#selection'); host.textContent = '';
  if (!id) { host.append(el('p', 'muted', 'Hover a structure to see its term. Click to select it.')); stage.setSelected([]); stage.setMarker(null); labels.invalidate(); return; }
  const t = app.byId.get(id), btn = document.querySelector(`#index .term[data-id="${CSS.escape(id)}"]`);
  if (btn) { btn.classList.add('sel'); btn.closest('.sec').classList.remove('closed'); const ix = $('#index'), r = btn.getBoundingClientRect(), ir = ix.getBoundingClientRect();
    // scroll the list itself; scrollIntoView would also drag the page when the list sits in a closed sheet
    if (r.top < ir.top + 8 || r.bottom > ir.bottom - 8) ix.scrollTop += r.top - ir.top - ix.clientHeight / 2 + r.height / 2; }
  app.group = t.section; setDensity(app.density);
  if (reveal) {
    if (!stage.layers[t.layer].visible) { stage.setLayer(t.layer, { visible: true }); syncLayers(); }
    const list = app.anchors.get(id) || [];
    if (list.length && list[0].tag && !tagOn(list[0].tag)) setEyecut(list[0].tag === 'eye:cut');
    const a = anchorFor(id);
    if (a) {
      const cur = mode();
      const target = a.best || (viewOK(a, t, cur) ? (t.view === 'bisected' && cur === 'surface' && a.views.has('bisected') ? 'bisected' : cur) : a.views.has('bisected') ? 'bisected' : a.views.has('calvaria') ? 'calvaria' : 'surface');
      if (target !== cur) goView(target);
    }
  }
  const parts = [...ownParts(id)]; stage.setSelected(parts);
  const a = anchorFor(id);
  // openings and other point terms get a ring on the spot; regions get the fill and outline
  stage.setMarker(a && (a.ring || !parts.length) ? { pos: a.pos, normal: a.normal, r: a.ring || 0.02, side: a.side } : null);
  host.append(el('p', 't', t.term));
  const dl = el('dl'); const add = (k, v) => { dl.append(el('dt', '', k), el('dd', '', v)); };
  add('Section', t.section); add('Layer', LAYER_NAME[t.layer]);
  host.append(dl);
  if (a) { const best = a.best || (a.views.has('calvaria') && t.section === 'Cavities of the skull' ? 'calvaria' : t.view === 'bisected' ? 'bisected' : 'surface');
    const f = el('p', 'find'); f.append('Find it from: ', el('b', '', VIEW_NAME[best])); host.append(f);
    if (best !== mode()) { const go = el('button', 'btn plain', 'Switch to that view'); go.type = 'button'; go.addEventListener('click', () => { goView(best); flyTo(id, true); }); app._goBtn = go; } else app._goBtn = null; }
  if (!a && !parts.length) host.append(el('p', 'np', 'Not placed yet. This term has no pin or structure in the model so far.'));
  else { const row = el('div', 'row'), b = el('button', 'btn plain', 'Fly to it'); b.type = 'button'; b.addEventListener('click', () => flyTo(id)); row.append(b); if (app._goBtn) row.append(app._goBtn); host.append(row); }
  if (fly) flyTo(id, reveal);
  labels.invalidate();
}
function flyTo(id, afterSplit) {
  const a = anchorFor(id); if (!a) return;
  const go = () => {
    const side = a.side === 'right' ? 'right' : 'left', w = a.pos.clone().applyMatrix4(stage.halfMatrix(side));
    const t = app.byId.get(id), medial = stage.split !== 'whole' && (a.side === 'median' || t.view === 'bisected') && !a.tag;
    const n = medial ? new THREE.Vector3(0.05, 0.1, 1) : stage.floor && !a.hasNormal ? new THREE.Vector3(-0.3, 1, 0) : a.normal.clone();
    if (stage.floor && n.y < 0.25) { n.y = 0.6; n.normalize(); }          // into the open vault, never from under the cut
    n.transformDirection(stage.halfMatrix(side));
    let r = 0; for (const p of ownParts(id)) r = Math.max(r, p.sphere.radius * (p.matrix.elements[0] ? 1 : 1));
    // point terms keep at least about 0.9 units of view height (1.1 looking into the open vault)
    const dist = a.tag || a.model && r < 0.06 ? 0.62 : Math.min(2.2, Math.max(0.9, r ? r * 3.4 : stage.floor ? 2.1 : 1.75));
    stage.focus(w, n, dist, medial ? 0 : 0.18);
  };
  if (afterSplit && (stage._splitAnim || stage._floorAnim)) { const prev = stage.onSplitDone; stage.onSplitDone = () => { stage.onSplitDone = prev; go(); }; } else go();
}

// ============================================================================ quiz
function quizPool() {
  const q = app.quiz, seen = new Set(), out = [];
  for (const t of app.terms) {
    if (q.layer !== 'all' && t.layer !== q.layer) continue;
    if (q.section !== 'all' && t.section !== q.section) continue;
    const a = (app.anchors.get(t.id) || [])[0]; if (!a) continue;
    const key = t.term + '|' + a.pos.x.toFixed(3) + a.pos.y.toFixed(3); if (seen.has(key)) continue; seen.add(key);
    out.push(t.id);
  }
  return out;
}
function quizStart() {
  select(null);
  app.quiz = { layer: 'all', section: 'all', num: new Map(), state: new Map(), cur: null, result: null, hint: store.get('quizHint') !== '0' };
  quizRebuild(); $('#card-quiz').hidden = false; $('#card-selection').hidden = true; $('#card-labels').hidden = true;
  $('#btn-quiz').setAttribute('aria-pressed', 'true'); $('#tip').classList.remove('on'); stage.setHover([]);
}
function quizStop() { app.quiz = null; stage.setHint(null); $('#quiz-float').hidden = true; $('#card-quiz').hidden = true; $('#card-selection').hidden = false; $('#card-labels').hidden = false; $('#btn-quiz').setAttribute('aria-pressed', 'false'); labels.invalidate(); }
function quizRebuild(keep) {
  const q = app.quiz, pool = quizPool();
  if (!keep) { q.state.clear(); q.cur = null; q.result = null; }
  const ids = pool.slice(); let s = 20261122; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  q.num = new Map(ids.map((id, i) => [id, i + 1])); q.pool = pool;
  if (q.cur && !q.num.has(q.cur)) { q.cur = null; q.result = null; }
  quizHint(); quizRender(); if (labels) labels.invalidate();
}
function quizPins() {
  const q = app.quiz, m = mode(), out = [];
  for (const id of q.pool) { const t = app.byId.get(id); if (!stage.layers[t.layer].visible) continue; const a = anchorFor(id); if (!a || !viewOK(a, t, m)) continue; out.push({ id, n: q.num.get(id), state: q.state.get(id) || '', cur: q.cur === id }); }
  return out;
}
// Shade the structure the current pin sits on (or the disc of an opening), without naming it.
function quizHint() {
  const q = app.quiz; if (!q || !q.hint || !q.cur) { stage.setHint(null); return; }
  const a = anchorFor(q.cur), parts = [...ownParts(q.cur)];
  stage.setHint({ parts, disc: a && a.ring ? { pos: a.pos, normal: a.normal, r: a.ring, side: a.side } : null });
}
function quizPick(id) { const q = app.quiz; if (!q) return; q.cur = id; q.result = q.state.has(id) ? { kind: q.state.get(id) === 'ok' ? 'ok' : 'no', typed: '' } : null; quizHint(); quizRender(true); labels.invalidate(); }
function quizNext() {
  const q = app.quiz, left = q.pool.filter(id => !q.state.has(id)); if (!left.length) { q.cur = null; q.result = null; quizHint(); quizRender(); labels.invalidate(); return; }
  const m = mode(), here = left.filter(id => { const a = anchorFor(id), t = app.byId.get(id); return a && viewOK(a, t, m) && stage.layers[t.layer].visible; });
  const pick = (here.length ? here : left).sort((a, b) => q.num.get(a) - q.num.get(b))[0];
  const t = app.byId.get(pick); if (!stage.layers[t.layer].visible) { stage.setLayer(t.layer, { visible: true }); syncLayers(); }
  const list = app.anchors.get(pick) || []; if (list.length && list[0].tag && !tagOn(list[0].tag)) setEyecut(list[0].tag === 'eye:cut');
  const a = anchorFor(pick); if (a && !viewOK(a, t, mode())) goView(a.best || (a.views.has('bisected') ? 'bisected' : a.views.has('calvaria') ? 'calvaria' : 'surface'));
  q.cur = pick; q.result = null; quizHint(); quizRender(true); flyTo(pick, true); labels.invalidate();
}

// ---- grading: forgiving about case, punctuation, the list's notes in parentheses and the usual abbreviations
const ABBR = { m: 'muscle', mm: 'muscles', muscle: 'muscle', muscles: 'muscles', n: 'nerve', nn: 'nerves', a: 'artery', aa: 'arteries', v: 'vein', vv: 'veins', ln: 'lymph node', lnn: 'lymph nodes' };
function norm(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(w => ABBR[w] || w).join(' ');
}
function variants(term) {
  const out = new Set(), raw = term.split(/\s[–—-]\s/)[0];           // drop "– not described in your book…"
  out.add(norm(raw));                                                         // notes kept, brackets ignored
  const core = raw.replace(/\([^)]*(\)|$)/g, ' '); out.add(norm(core));       // notes dropped
  const m = /^(.*?)(\S+)\s*\(([^()\s]+)\)\s*(\S.*)$/.exec(raw);               // "Superior (upper) lip" -> "upper lip"
  if (m) out.add(norm(m[1] + ' ' + m[3] + ' ' + m[4]));
  out.delete(''); return out;
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
let variantCache = null;
function grade(id, typed) {
  if (!variantCache) { variantCache = new Map(); for (const t of app.terms) variantCache.set(t.id, variants(t.term)); }
  const t = app.byId.get(id), mine = new Set([id, ...(t.sameAs || [])]);
  for (const o of app.terms) if (o.term === t.term) mine.add(o.id);
  const ans = norm(typed); if (!ans) return 'no';
  const accept = new Set(); for (const k of mine) for (const v of variantCache.get(k) || []) accept.add(v);
  if (accept.has(ans)) return 'ok';
  // a typo is only forgiven when the answer is not exactly some other term on the list
  for (const [k, vs] of variantCache) if (!mine.has(k) && vs.has(ans)) return 'no';
  for (const v of accept) { const tol = v.length >= 8 ? 2 : v.length >= 5 ? 1 : 0; if (tol && lev(ans, v) <= tol) return 'close'; }
  return 'no';
}
function quizSubmit(typed) {
  const q = app.quiz; if (!q || !q.cur || q.result) return;
  const kind = typed == null ? 'shown' : grade(q.cur, typed);
  q.result = { kind, typed: typed || '' }; q.state.set(q.cur, kind === 'ok' || kind === 'close' ? 'ok' : 'no');
  quizRender(true); labels.invalidate();
}
function quizAnswerUI() {
  const q = app.quiz, t = app.byId.get(q.cur), box = el('div');
  box.append(el('div', 'pn', 'Pin ' + q.num.get(q.cur)));
  if (!q.result) {
    const form = el('form', 'answer'), inp = el('input'); inp.type = 'text'; inp.id = 'quiz-answer'; inp.placeholder = 'Type the structure…'; inp.autocomplete = 'off'; inp.autocapitalize = 'off'; inp.spellcheck = false; inp.setAttribute('aria-label', 'Your answer'); inp.enterKeyHint = 'done';
    const go = el('button', 'btn primary', 'Check'); go.type = 'submit';
    form.append(inp, go); form.addEventListener('submit', e => { e.preventDefault(); if (inp.value.trim()) quizSubmit(inp.value); });
    const row = el('div', 'row'), show = el('button', 'btn plain', 'Show answer'), skip = el('button', 'btn plain', 'Skip'); show.type = skip.type = 'button';
    show.addEventListener('click', () => quizSubmit(null)); skip.addEventListener('click', quizNext); row.append(show, skip);
    box.append(form, row);
  } else {
    const k = q.result.kind, fb = el('div', 'fb ' + (k === 'ok' ? 'ok' : k === 'close' ? 'close' : 'no'));
    fb.append(k === 'ok' ? 'Correct' : k === 'close' ? 'Close! Counted as correct. The exact spelling:' : k === 'shown' ? 'Counted as missed. Answer:' : 'Not quite. Answer:', el('b', '', t.term), el('small', '', t.section));
    const row = el('div', 'row'), n = el('button', 'btn primary', 'Next pin'); n.type = 'button'; n.id = 'quiz-next'; n.addEventListener('click', quizNext); row.append(n);
    box.append(fb, row);
  }
  return box;
}
function quizRender(focus) {
  const q = app.quiz, host = $('#quiz'), fl = $('#quiz-float'); host.textContent = ''; fl.textContent = '';
  const narrow = matchMedia('(max-width: 1100px)').matches;
  const ok = [...q.state.values()].filter(v => v === 'ok').length, done = q.state.size, total = q.pool.length;
  const sc = el('div', 'score'); sc.append(el('b', '', ok + ' / ' + done), el('span', '', `correct · ${total - done} of ${total} pins left`));
  const bar = el('div', 'bar'), g = el('i', 'g'), b = el('i', 'b'); g.style.width = (total ? ok / total * 100 : 0) + '%'; b.style.width = (total ? (done - ok) / total * 100 : 0) + '%'; bar.append(g, b);
  host.append(sc, bar);
  const sel = (label, id, opts, val, on) => { const l = el('label', 'f', label), s = el('select'); s.id = id; for (const [v, n] of opts) { const o = el('option', '', n); o.value = v; s.append(o); } s.value = val; s.addEventListener('change', () => on(s.value)); l.append(s); return l; };
  host.append(sel('Layer', 'quiz-layer', [['all', 'All layers'], ...LAYERS.map(k => [k, LAYER_NAME[k]])], q.layer, v => { q.layer = v; quizRebuild(); }));
  host.append(sel('Section', 'quiz-section', [['all', 'All sections'], ...[...new Set(app.terms.map(t => t.section))].map(s => [s, s])], q.section, v => { q.section = v; quizRebuild(); }));
  const hr = el('label', 'hintrow'), hc = el('input'); hc.type = 'checkbox'; hc.id = 'quiz-hint'; hc.checked = q.hint; hr.append(hc, 'Hint: shade the structure the pin is on');
  hc.addEventListener('change', () => { q.hint = hc.checked; store.set('quizHint', q.hint ? '1' : '0'); quizHint(); });
  host.append(hr);
  const card = el('div', 'q'); let floated = false;
  if (!total) card.append(el('div', 'sec2', 'No placed terms match this filter.'));
  else if (!q.cur) {
    card.append(el('div', 'sec2', done >= total ? 'All pins answered.' : 'Click a numbered pin, or let the atlas pick one.'));
    const row = el('div', 'row'), n = el('button', 'btn primary', done >= total ? 'Start again' : 'Next pin'); n.type = 'button'; n.addEventListener('click', () => done >= total ? quizRebuild() : quizNext()); row.append(n); card.append(row);
  } else if (narrow) { fl.append(quizAnswerUI()); floated = true; card.append(el('div', 'sec2', 'Answer in the box above the specimen.')); }
  else card.append(quizAnswerUI());
  fl.hidden = !floated;
  if (narrow && !q.cur && total) { const row = el('div', 'row'), n = el('button', 'btn primary', done >= total ? 'Start again' : 'Next pin'); n.type = 'button'; n.addEventListener('click', () => done >= total ? quizRebuild() : quizNext()); row.append(el('div', 'pn', `${ok} / ${done} correct`), n); fl.append(row); fl.hidden = false; }
  host.append(card);
  const row = el('div', 'row'), rs = el('button', 'btn plain', 'Reset score'), ex = el('button', 'btn plain', 'Leave quiz'); rs.type = ex.type = 'button';
  rs.addEventListener('click', () => quizRebuild()); ex.addEventListener('click', quizStop); row.append(rs, ex); host.append(row);
  if (focus) { const f = document.getElementById(q.result ? 'quiz-next' : 'quiz-answer'); if (f) f.focus({ preventScroll: true }); }
}

// ============================================================================ wiring
function wire() {
  for (const b of $$('#seg-split button')) b.addEventListener('click', () => { setSplit(b.dataset.split); stage.preset(b.dataset.split === 'tray' ? 'medial' : b.dataset.split === 'floor' ? 'floor' : lastView === 'floor' ? 'reset' : lastView); if (b.dataset.split === 'floor') lastView = 'floor'; else if (lastView === 'floor') lastView = 'reset'; });
  $('#floor-h').addEventListener('input', e => { stage.setFloorHeight(e.target.value / 100); labels.invalidate(); });
  for (const b of $$('#seg-halves button')) b.addEventListener('click', () => { stage.setHalves(b.dataset.halves); for (const x of $$('#seg-halves button')) x.setAttribute('aria-pressed', x === b); labels.invalidate(); });
  for (const b of $$('#seg-density button')) b.addEventListener('click', () => setDensity(b.dataset.density));
  for (const b of $$('#viewbar button')) b.addEventListener('click', () => view(b.dataset.view));
  $('#eyecut').addEventListener('change', e => setEyecut(e.target.checked));
  $('#btn-quiz').addEventListener('click', () => app.quiz ? quizStop() : quizStart());
  $('#btn-full').addEventListener('click', () => setFull(!$('#app').classList.contains('full')));
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && fsAsked) { fsAsked = false; setFull(false); } });
  for (const b of $$('#full-layers button')) b.addEventListener('click', () => { stage.setLayer(b.dataset.layer, { visible: !stage.layers[b.dataset.layer].visible }); syncLayers(); });
  $('#btn-studio').addEventListener('click', () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); setTheme(cur === 'dark' ? 'light' : 'dark'); });
  for (const b of $$('#tabbar button')) b.addEventListener('click', () => sheet($('#app').dataset.sheet === b.dataset.sheet ? '' : b.dataset.sheet));
  const saved = store.get('theme'); document.documentElement.dataset.theme = (saved === 'dark' || saved === 'light') ? saved : 'dark';   // pitch-black studio by default
  setDensity('focus');
  for (const b of $$('#layer-quick button')) b.addEventListener('click', () => setLayers(b.dataset.set.split(',')));
  $('#compass').textContent = 'Drag to rotate · scroll or pinch to zoom · right-drag to pan';

  // hover and click on the specimen
  const cv = stage.renderer.domElement, tip = $('#tip'); let down = null, raf = 0, last = null;
  const hover = () => {
    raf = 0; if (!last || app.quiz || down) return;
    const h = stage.pick(last.x, last.y), id = h && h.part.termId, t = id && app.byId.get(id);
    stage.setHover(h && t ? [...ownParts(id)].filter(p => p.termId === id) : []);
    if (!t) { tip.classList.remove('on'); cv.style.cursor = ''; return; }
    tip.textContent = t.term; tip.classList.add('on'); cv.style.cursor = 'pointer';
    const r = $('#stage').getBoundingClientRect(); let x = last.x - r.left + 14, y = last.y - r.top + 16;
    if (x + tip.offsetWidth > r.width - 8) x = last.x - r.left - tip.offsetWidth - 10; if (y + tip.offsetHeight > r.height - 8) y = last.y - r.top - tip.offsetHeight - 10;
    tip.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  };
  cv.addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; last = { x: e.clientX, y: e.clientY }; if (!raf) raf = requestAnimationFrame(hover); });
  cv.addEventListener('pointerleave', () => { last = null; tip.classList.remove('on'); stage.setHover([]); });
  cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; tip.classList.remove('on'); });
  cv.addEventListener('pointerup', e => {
    const d = down; down = null; if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 600 || app.quiz) return;
    const h = stage.pick(e.clientX, e.clientY), id = h && h.part.termId;
    select(id && app.byId.has(id) ? id : null, { fly: false });
  });
  window.addEventListener('keydown', e => { const typing = /INPUT|SELECT|TEXTAREA/.test((document.activeElement || {}).tagName || '');
    if ((e.key === 'f' || e.key === 'F') && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setFull(!$('#app').classList.contains('full')); }
    if (e.key === 'Escape') { if ($('#app').classList.contains('full')) setFull(false); else if ($('#app').dataset.sheet) sheet(''); else if (!app.quiz) select(null); } if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); } });
}
let lastView = 'reset';
function view(name) {
  for (const b of $$('#viewbar button')) b.classList.toggle('on', b.dataset.view === name && name !== 'reset');
  if (name === 'medial') { if (stage.split !== 'apart' || stage.halves !== 'left') setSplit('apart', { halves: 'left' }); }
  else if (name === 'reset') { if (stage.split !== 'whole' || stage.floor) setSplit('whole'); }
  else if (stage.split === 'apart' && stage.halves === 'left' && lastView === 'medial') stage.setHalves('both'), setSplit('apart');
  lastView = name; stage.preset(name);
}

function applyParams() {
  if (Q.get('theme')) document.documentElement.dataset.theme = Q.get('theme');
  if (Q.get('layers')) setLayers(Q.get('layers').split(','));
  if (Q.get('split')) setSplit(Q.get('split'), { instant: true, halves: Q.get('halves') || undefined });
  if (Q.get('split') === 'floor' && !Q.get('v')) { lastView = 'floor'; stage.preset('floor', 1); }
  if (Q.get('fh')) { $('#floor-h').value = Q.get('fh'); stage.setFloorHeight(Q.get('fh') / 100); }
  if (Q.get('v')) { lastView = Q.get('v'); if (Q.get('v') === 'medial' && !Q.get('split')) setSplit('apart', { instant: true, halves: 'left' }); stage.preset(Q.get('v'), 1); }
  if (Q.get('density')) setDensity(Q.get('density'));
  if (Q.get('eyecut')) setEyecut(Q.get('eyecut') === '1');
  if (Q.get('sel')) select(Q.get('sel'), { fly: Q.get('fly') !== '0', reveal: true });
  if (Q.get('quiz')) { quizStart(); if (Q.get('qpin')) { quizPick(Q.get('qpin')); flyTo(Q.get('qpin'), true); } else if (Q.get('quiz') === 'next') quizNext(); if (Q.get('ans') != null) quizSubmit(Q.get('ans')); }
  if (Q.get('sheet')) sheet(Q.get('sheet'));
  if (Q.get('full')) { $('#app').style.transition = 'none'; $('#app').classList.add('full'); $('#btn-full').setAttribute('aria-pressed', 'true'); }
  if (Q.get('q')) { $('#search').value = Q.get('q'); filterIndex(Q.get('q')); }
  if (Q.get('only')) { for (const p of stage.parts) if (!p.name.startsWith(Q.get('only'))) p.hidden = true; stage.refresh(); }
  if (Q.get('dbg')) setTimeout(() => { const a = anchorFor(app.selected) || {}; $('#compass').textContent = 'DBG ' + JSON.stringify({ cam: stage.camera.position.toArray(), tgt: stage.controls.target.toArray(), pos: a.pos && a.pos.toArray(), n: a.normal && a.normal.toArray(), tag: a.tag, pick: (() => { const r = stage.renderer.domElement.getBoundingClientRect(); const h = stage.pick(r.left + r.width * (+Q.get('px') || 0.5), r.top + r.height * (+Q.get('py') || 0.5)); return h && [h.part.name, h.part.termId, h.dist.toFixed(2)]; })(), w: stage.width, h: stage.height, asp: stage.camera.aspect, iw: innerWidth, pre: stage._preset, parts: stage.parts.length, calls: stage.renderer.info.render.calls, tris: stage.renderer.info.render.triangles }); }, 800);
  if (Q.get('cam')) { const c = Q.get('cam').split(',').map(Number); stage.flyTo(new THREE.Vector3(c[0], c[1], c[2]), new THREE.Vector3(c[3] || 0, c[4] || 0, c[5] || 0), 1); }
}

boot().catch(e => fatal('' + (e.stack || e)));
