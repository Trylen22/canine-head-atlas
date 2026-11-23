// The stage: renderer, camera, the two halves of the head, stencil-capped median cut, picking.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshBVH } from 'three-mesh-bvh';
import { makeMaterial, makeCapMaterial, capRank } from './materials.js';

export const LAYERS = ['bone', 'nv_sup', 'nv_deep', 'ms_sup', 'ms_deep'];
const EPS_SIDE = 0.004;          // 0.4 mm over the median plane still counts as one-sided
const HINT = new THREE.Color(0x9fc6ea), AMBER = new THREE.Color(0xff9d2e), FILL = new THREE.Color(0xff7a00), _grey = new THREE.Color(), _v3 = new THREE.Vector3(), ZAXIS = new THREE.Vector3(0, 0, 1), YAXIS = new THREE.Vector3(0, 1, 0);
const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _box = new THREE.Box3();
const _ray = new THREE.Ray(), _gray = { L: new THREE.Ray(), R: new THREE.Ray(), W: new THREE.Ray() };
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export class Stage {
  constructor(host) {
    this.host = host;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.localClippingEnabled = true;
    r.setClearColor(0x000000, 0);
    host.appendChild(r.domElement);
    r.domElement.tabIndex = 0;

    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.08, 60);
    this.camera.position.set(0.1, 0.25, -5);
    this.scene.add(this.camera);
    // Studio rig. The key is fixed above the bench (upper front-left of the dog) and is the only
    // shadow caster; a weaker twin keeps the right side readable. A cool fill and a warm rim travel
    // with the camera so the specimen is never unlit and its outline lifts off the backdrop.
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.98;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.add(new THREE.HemisphereLight(0xfff8ee, 0x8f8272, 0.5));
    const key = this.key = new THREE.DirectionalLight(0xfff3e2, 2.75); this.keyDir = new THREE.Vector3(0.42, 1, -0.62).normalize();
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.014; key.shadow.radius = 5;
    const sc = key.shadow.camera; sc.left = -2.3; sc.right = 2.0; sc.top = 1.5; sc.bottom = -1.5; sc.near = 1; sc.far = 12; sc.updateProjectionMatrix();
    const key2 = this.key2 = new THREE.DirectionalLight(0xfff3e2, 1.15);
    this.scene.add(key, key.target, key2, key2.target);
    const fill = new THREE.DirectionalLight(0xe6edff, 1.35); fill.position.set(0.8, 0.2, 2);   // strong enough that the ventral and medial views are never murky
    const rim = new THREE.DirectionalLight(0xffdcb8, 1.5); rim.position.set(-1.4, 2.4, -7);
    for (const l of [fill, rim]) { this.camera.add(l); this.camera.add(l.target); l.target.position.set(0, 0, -4); }
    this._aimKey();

    const c = this.controls = new OrbitControls(this.camera, r.domElement);
    c.enableDamping = true; c.dampingFactor = 0.12; c.rotateSpeed = 0.8; c.zoomSpeed = 0.9;
    c.minDistance = 0.25; c.maxDistance = 14; c.zoomToCursor = true;
    c.addEventListener('change', () => { this.dirty = true; this.moved = true; });
    c.addEventListener('start', () => { this._tween = null; this._preset = null; });

    this.gL = new THREE.Group(); this.gR = new THREE.Group(); this.gW = new THREE.Group();
    this.scene.add(this.gL, this.gR, this.gW);
    this.planeL = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.planeR = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.stencil = {};
    for (const h of ['L', 'R']) {
      const base = { colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, transparent: true, clippingPlanes: [h === 'L' ? this.planeL : this.planeR] };
      this.stencil[h] = {
        back: new THREE.MeshBasicMaterial({ ...base, side: THREE.BackSide, stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp }),
        front: new THREE.MeshBasicMaterial({ ...base, side: THREE.FrontSide, stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp }),
      };
    }
    this.capGeo = new THREE.PlaneGeometry(8, 8);
    { const uv = this.capGeo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 44, uv.getY(i) * 44); }

    this.parts = []; this.byTerm = new Map(); this.caps = new Map();
    this.layers = {}; for (const k of LAYERS) this.layers[k] = { visible: true, opacity: 1 };
    this.split = 'whole'; this.splitT = 0; this.pose = 'apart'; this.halves = 'both';
    // (normal as validated against the anchors: three Plane((-0.12, -1, 0), 0.146) before normalising)
    // Floor view: a near-horizontal cut that takes the calvaria off. Everything is clipped by
    // floorPlane; the bone above it is drawn once more as a lid that lifts away and fades.
    this.floorN = new THREE.Vector3(-0.12, -1, 0).normalize(); this.floorP0 = new THREE.Vector3(-0.45, 0.20, 0); this.floorOff = 0;
    this.floorPlane = new THREE.Plane(); this.lidPlane = new THREE.Plane(); this.floorPlanes = [this.floorPlane];
    this.gF = new THREE.Group(); this.gLid = new THREE.Group(); this.scene.add(this.gF, this.gLid);
    this.floor = false; this.floorT = 0; this.pulse = 1; this.outlines = []; this.marker = null; this.hintParts = new Set(); this.hintObjs = [];
    { const base = { colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, transparent: true, clippingPlanes: this.floorPlanes };
      this.stencil.F = {
        back: new THREE.MeshBasicMaterial({ ...base, side: THREE.BackSide, stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp }),
        front: new THREE.MeshBasicMaterial({ ...base, side: THREE.FrontSide, stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp }),
      }; }
    this._setFloorPlane();
    this.selParts = new Set(); this.hovParts = new Set();
    this.center = new THREE.Vector3(0.14, 0, 0); this.radius = 1.25;
    this.frameCbs = []; this.dirty = true; this.moved = true;

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    r.setAnimationLoop(t => this._tick(t));
  }

  _aimKey() {
    const c = this.center || new THREE.Vector3(0.14, 0, 0);
    this.key.position.copy(c).addScaledVector(this.keyDir, 6); this.key.target.position.copy(c);
    this.key2.position.copy(c).add(new THREE.Vector3(this.keyDir.x, this.keyDir.y * 0.8, -this.keyDir.z).multiplyScalar(6)); this.key2.target.position.copy(c);
    this.dirty = true;
  }
  // step the shadow map down (2048 -> 1024 -> 512 -> off) if frames run slow
  _shadowStep() {
    const sh = this.key.shadow, n = sh.mapSize.x;
    if (n > 512) { sh.mapSize.set(n / 2, n / 2); if (sh.map) { sh.map.dispose(); sh.map = null; } }
    else { this.key.castShadow = false; if (this.shadow) this.shadow.visible = false; this.noShadow = true; }
    this.dirty = true;
  }
  resize() {
    const w = Math.max(2, this.host.clientWidth), h = Math.max(2, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.width = w; this.height = h; this.dirty = this.moved = true;
    if (this._preset && this.parts && this.parts.length) this.preset(this._preset, 1);     // keep the framing until the viewer takes over
  }
  onFrame(cb) { this.frameCbs.push(cb); }
  invalidate() { this.dirty = true; }

  // ------------------------------------------------------------------ parts
  // spec: { geometry, kind, termId, layer, matrix?, name?, capKind?, noCap?, noPick?, opts?, anchor?, tag? }
  addPart(spec) {
    const g = spec.geometry;
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundsTree) g.boundsTree = new MeshBVH(g, { maxLeafTris: 8 });
    const matrix = spec.matrix ? spec.matrix.clone() : new THREE.Matrix4();
    _box.copy(g.boundingBox).applyMatrix4(matrix);
    const side = _box.max.z <= EPS_SIDE ? 'L' : _box.min.z >= -EPS_SIDE ? 'R' : 'X';
    const layer = LAYERS.includes(spec.layer) ? spec.layer : 'ms_deep';
    const mat = makeMaterial(spec.kind, spec.opts);
    mat.vertexColors = !!g.attributes.color;
    const part = {
      id: this.parts.length, name: spec.name || spec.termId || spec.kind, termId: spec.termId || null, layer, kind: spec.kind,
      geometry: g, matrix, inv: matrix.clone().invert(), side, mats: [mat], meshes: {}, stencils: [], noPick: !!spec.noPick,
      sphere: _box.getBoundingSphere(new THREE.Sphere()), anchor: spec.anchor || null, tag: spec.tag || null, hidden: false,
      baseOpacity: mat.userData.baseOpacity,
    };
    const solid = mat.userData.baseOpacity > 0.5;
    const mk = (m, group, stencil) => { const mesh = new THREE.Mesh(g, m); mesh.matrixAutoUpdate = false; mesh.matrix.copy(matrix); mesh.userData.part = part; mesh.castShadow = solid && !stencil; mesh.receiveShadow = solid && !stencil; group.add(mesh); return mesh; };
    if (side !== 'X') part.meshes[side] = mk(mat, side === 'L' ? this.gL : this.gR);
    else {
      part.meshes.W = mk(mat, this.gW);
      for (const h of ['L', 'R']) {
        const mc = mat.clone(); mc.userData = mat.userData; mc.onBeforeCompile = mat.onBeforeCompile; mc.clippingPlanes = [h === 'L' ? this.planeL : this.planeR]; mc.clipShadows = true;
        part.mats.push(mc); part.meshes[h] = mk(mc, h === 'L' ? this.gL : this.gR);
        if (!spec.noCap) {
          const cap = this._capGroup(layer, spec.capKind || spec.kind, h);
          for (const s of ['back', 'front']) { const sm = mk(this.stencil[h][s], cap.group, true); sm.renderOrder = cap.order; sm.userData.part = part; part.stencils.push(sm); }
        }
      }
    }
    mat.userData.baseColor = mat.color.clone(); mat.clipShadows = true;
    part.stencilsF = [];
    if (!spec.noCap && solid) {
      const cap = this._capGroup(layer, spec.capKind || spec.kind, 'F');
      for (const st of ['back', 'front']) { const sm = mk(this.stencil.F[st], cap.group, true); sm.renderOrder = cap.order; part.stencilsF.push(sm); }
    }
    if (spec.tag === 'skull') {
      const lm = mat.clone(); lm.userData = mat.userData; lm.onBeforeCompile = mat.onBeforeCompile; lm.clippingPlanes = [this.lidPlane]; lm.transparent = true;
      part.lidMat = lm; part.lid = mk(lm, this.gLid); part.lid.castShadow = false; part.lid.visible = false;
    }
    this.parts.push(part);
    if (part.termId) { if (!this.byTerm.has(part.termId)) this.byTerm.set(part.termId, []); this.byTerm.get(part.termId).push(part); }
    this._applyPart(part); this.dirty = true;
    return part;
  }

  _capGroup(layer, kind, h) {
    const key = layer + '|' + kind + '|' + h;
    let c = this.caps.get(key);
    if (c) return c;
    const order = 100 + this.caps.size * 2;
    const group = new THREE.Group(); (h === 'L' ? this.gL : h === 'R' ? this.gR : this.gF).add(group);
    const mat = makeCapMaterial(kind);
    Object.assign(mat, { transparent: true, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp });
    const quad = new THREE.Mesh(this.capGeo, mat);
    // higher rank sits a hair proud of the plane, so bone wins over muscle where solids overlap
    if (h !== 'F') quad.position.z = (h === 'L' ? 1 : -1) * 0.0004 * capRank(kind);
    quad.renderOrder = order + 1; quad.receiveShadow = true;
    quad.onAfterRender = renderer => renderer.clearStencil();
    group.add(quad);
    c = { key, layer, kind, h, group, quad, mat, order, base: mat.color.clone() };
    this.caps.set(key, c);
    if (h === 'F') this._setFloorPlane();
    return c;
  }

  removeParts(pred) {
    const keep = [];
    for (const p of this.parts) {
      if (!pred(p)) { keep.push(p); continue; }
      for (const m of Object.values(p.meshes)) m.parent && m.parent.remove(m);
      for (const s of p.stencils) s.parent && s.parent.remove(s);
      for (const m of p.mats) m.dispose();
      if (p.termId) { const a = this.byTerm.get(p.termId); if (a) { const i = a.indexOf(p); if (i >= 0) a.splice(i, 1); if (!a.length) this.byTerm.delete(p.termId); } }
    }
    this.parts = keep; this.dirty = true;
  }

  _visible(p) { return this.layers[p.layer].visible && !p.hidden; }
  _applyPart(p) {
    const L = this.layers[p.layer], vis = this._visible(p), split = this.splitT > 0, floorOn = this.floor || this.floorT > 0;
    const op = L.opacity * p.baseOpacity;
    const sel = this.selParts.has(p), hov = this.hovParts.has(p), dim = !sel && this.selParts.size > 0;
    for (const m of p.mats) {
      m.opacity = op; m.transparent = op < 0.999; m.depthWrite = p.baseOpacity > 0.6;
      const base = m.userData.baseColor || m.color;
      m.emissiveIntensity = 1;
      if (sel) { m.color.copy(base).lerp(FILL, 0.85); m.emissive.copy(FILL).multiplyScalar(0.1 + 0.2 * this.pulse); }
      else if (dim) { const l = base.r * 0.3 + base.g * 0.59 + base.b * 0.11; m.color.copy(base).lerp(_grey.setRGB(l, l, l), 0.25).multiplyScalar(0.55); m.emissive.copy(m.userData.baseEmissive).multiplyScalar(0.55); if (hov) m.emissive.lerp(AMBER, 0.2); }
      else if (this.hintParts.has(p)) { m.color.copy(base).lerp(HINT, 0.3); m.emissive.copy(HINT).multiplyScalar(0.07); }
      else { m.color.copy(base); m.emissive.copy(m.userData.baseEmissive); if (hov) m.emissive.lerp(AMBER, 0.24); }
    }
    // the unsplit mesh is the one the floor plane cuts
    const m0 = p.mats[0], want = floorOn ? this.floorPlanes : null;
    if (m0.clippingPlanes !== want) { m0.clippingPlanes = want; m0.needsUpdate = true; }
    if (p.side !== 'X') p.meshes[p.side].visible = vis;
    else { p.meshes.W.visible = vis && !split; p.meshes.L.visible = p.meshes.R.visible = vis && split; }
    for (const st of p.stencils) st.visible = vis && split;
    for (const st of p.stencilsF) st.visible = vis && floorOn && !split;
    if (p.lid) { const k = 1 - ease(this.floorT); p.lid.visible = vis && floorOn && k > 0.004; p.lidMat.opacity = L.opacity * k; p.lidMat.depthWrite = k > 0.6; p.lidMat.color.copy(m0.color); p.lidMat.emissive.copy(m0.emissive); }
  }
  refresh() {
    for (const p of this.parts) this._applyPart(p);
    const floorOn = this.floor || this.floorT > 0, dim = this.selParts.size > 0;
    for (const c of this.caps.values()) {
      const L = this.layers[c.layer];
      c.group.visible = L.visible && (c.h === 'F' ? floorOn && this.splitT === 0 : this.splitT > 0);
      c.mat.opacity = L.opacity; c.mat.color.copy(c.base).multiplyScalar(dim ? 0.6 : 1);
    }
    for (const o of [...this.outlines, ...this.hintObjs]) { const src = o.userData.src; if (!src) continue; o.visible = src.visible; const cp = src.material.clippingPlanes || null; if (o.material.clippingPlanes !== cp) { o.material.clippingPlanes = cp; o.material.needsUpdate = true; } }
    if (this.shadow) this.shadow.visible = !this.noShadow && !floorOn && !(this.splitT > 0 && this.pose === 'tray');
    this.gL.visible = this.halves !== 'right' || this.splitT === 0;
    this.gR.visible = this.halves !== 'left' || this.splitT === 0;
    this.dirty = this.moved = true;
  }
  setLayer(key, st) { Object.assign(this.layers[key], st); this.refresh(); }
  setSelected(parts) {
    this.selParts = new Set(parts || []);
    for (const o of this.outlines) { o.parent && o.parent.remove(o); o.material.dispose(); }
    this.outlines = [];
    // inverted hull: the same mesh pushed out along its normals, back faces only, in flat amber
    for (const p of this.selParts) {
      if (p.baseOpacity < 0.5) continue;
      const sc = Math.cbrt(Math.abs(p.matrix.determinant())) || 1, th = 0.006 / sc;
      for (const src of Object.values(p.meshes)) {
        const m = new THREE.MeshBasicMaterial({ color: 0xff8f1f, side: THREE.BackSide, toneMapped: false });
        m.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = position + normalize( normal ) * ${th.toFixed(6)};`); };
        m.customProgramCacheKey = () => 'hull' + th.toFixed(6);
        const o = new THREE.Mesh(p.geometry, m); o.matrixAutoUpdate = false; o.matrix.copy(p.matrix); o.userData.src = src; src.parent.add(o); this.outlines.push(o);
      }
    }
    this.refresh();
  }
  // Quiz hint: a faint cool tint and a thin outline on the structure a pin belongs to, or a soft
  // disc over an opening. Deliberately much quieter than the selection highlight.
  setHint(spec) {
    for (const o of this.hintObjs) { o.parent && o.parent.remove(o); o.material.dispose(); if (o.userData.own) o.geometry.dispose(); }
    this.hintObjs = []; this.hintParts = new Set((spec && spec.parts) || []);
    for (const p of this.hintParts) {
      if (p.baseOpacity < 0.5) continue;
      const sc = Math.cbrt(Math.abs(p.matrix.determinant())) || 1, th = 0.0028 / sc;
      for (const src of Object.values(p.meshes)) {
        const m = new THREE.MeshBasicMaterial({ color: 0x8fb8de, side: THREE.BackSide, toneMapped: false, transparent: true, opacity: 0.55 });
        m.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = position + normalize( normal ) * ${th.toFixed(6)};`); };
        m.customProgramCacheKey = () => 'hint' + th.toFixed(6);
        const o = new THREE.Mesh(p.geometry, m); o.matrixAutoUpdate = false; o.matrix.copy(p.matrix); o.userData.src = src; src.parent.add(o); this.hintObjs.push(o);
      }
    }
    if (spec && spec.disc) {
      const d = spec.disc, n = d.normal.clone().normalize(), q = new THREE.Quaternion().setFromUnitVectors(ZAXIS, n), R = d.r * 1.7;
      const mk = (geo, opacity) => { const o = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x9fc6ea, toneMapped: false, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })); o.quaternion.copy(q); o.position.copy(d.pos).addScaledVector(n, 0.004); o.userData.own = true; o.renderOrder = 900; (d.side === 'right' ? this.gR : this.gL).add(o); this.hintObjs.push(o); };
      mk(new THREE.CircleGeometry(R, 40), 0.28); mk(new THREE.RingGeometry(R * 0.96, R, 48), 0.6);
    }
    this.refresh();
  }
  // Ring marker for point terms (foramina, canals, fossae): seated on the opening, a cone pointing
  // in along -normal, a pulse, and a dim copy drawn through whatever is in front.
  setMarker(spec) {
    if (this.marker) { this.marker.parent && this.marker.parent.remove(this.marker); this.marker.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); this.marker = null; }
    if (!spec) { this.dirty = true; return; }
    const r = spec.r || 0.02, n = spec.normal.clone().normalize(), g = new THREE.Group();
    const solid = () => new THREE.MeshBasicMaterial({ color: 0xff9d2e, toneMapped: false });
    const ghost = () => new THREE.MeshBasicMaterial({ color: 0xffb964, toneMapped: false, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false });
    const tube = Math.max(0.0022, r * 0.1), ring = new THREE.TorusGeometry(r, tube, 10, 48);
    const q = new THREE.Quaternion().setFromUnitVectors(ZAXIS, n);
    const add = (geo, mat, order) => { const m = new THREE.Mesh(geo, mat); m.quaternion.copy(q); m.renderOrder = order; g.add(m); return m; };
    add(ring, ghost(), 1000); add(ring, solid(), 1001);
    g.userData.pulse = add(new THREE.TorusGeometry(r, tube * 0.7, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffc27a, toneMapped: false, transparent: true, opacity: 0.8, depthWrite: false }), 1002);
    const len = Math.max(0.03, r * 1.9), cone = new THREE.ConeGeometry(Math.max(0.008, r * 0.42), len, 16); cone.rotateX(-Math.PI / 2); cone.translate(0, 0, len / 2 + Math.max(0.006, r * 0.35));
    g.userData.cones = [add(cone, ghost(), 1000), add(cone, solid(), 1001)];
    // seen down the axis the cone is only a blob, so four inward ticks stand in for it
    const ticks = []; for (let k = 0; k < 4; k++) { const t = new THREE.BoxGeometry(r * 0.42, tube * 1.5, tube * 1.5); t.translate(r * 0.58, 0, 0); t.rotateZ(k * Math.PI / 2 + Math.PI / 4); ticks.push(t); }
    g.userData.ticks = ticks.flatMap(t => [add(t, ghost(), 1000), add(t, solid(), 1001)]);
    for (const t of g.userData.ticks) t.visible = false;
    g.userData.n = n;
    g.position.copy(spec.pos).addScaledVector(n, 0.002);
    (spec.side === 'right' ? this.gR : this.gL).add(g); this.marker = g; this.dirty = true;
  }
  // ------------------------------------------------------------------ floor (calvaria removed)
  _setFloorPlane() {
    const p = _v3.copy(this.floorP0); p.y += this.floorOff;
    this.floorPlane.setFromNormalAndCoplanarPoint(this.floorN, p);
    const lift = 0.55 * ease(this.floorT);
    this.gLid.position.set(0, lift, 0);
    this.lidPlane.setFromNormalAndCoplanarPoint(_v2.copy(this.floorN).negate(), _v.copy(p).add(new THREE.Vector3(0, lift, 0)));
    if (this.caps) for (const c of this.caps.values()) if (c.h === 'F') { c.quad.quaternion.setFromUnitVectors(ZAXIS, _v2.copy(this.floorN).negate()); c.quad.position.copy(p).addScaledVector(this.floorN, -0.0004 * capRank(c.kind)); }
    this.dirty = true;
  }
  setFloor(on, instant) {
    if (on) this.floor = true;
    this._floorAnim = { from: this.floorT, to: on ? 1 : 0, t0: performance.now(), dur: instant || this.instant || reduceMotion() ? 1 : 1100 };
    this.dirty = true;
  }
  setFloorHeight(dy) { this.floorOff = dy; this._setFloorPlane(); this.moved = true; }
  setHover(parts) { parts = parts || []; if (parts.length === this.hovParts.size && parts.every(p => this.hovParts.has(p))) return; this.hovParts = new Set(parts); for (const p of this.parts) this._applyPart(p); this.dirty = true; }
  setTagHidden(tag, hidden) { for (const p of this.parts) if (p.tag === tag) p.hidden = hidden; this.refresh(); }

  // ------------------------------------------------------------------ bisect
  setSplit(mode, instant) {
    this.split = mode;
    if (mode !== 'whole') this.pose = mode;
    this._splitAnim = { from: this.splitT, to: mode === 'whole' ? 0 : 1, t0: performance.now(), dur: instant || this.instant || reduceMotion() ? 1 : 900, poseFrom: this._poseT ?? (this.pose === 'tray' ? 1 : 0), poseTo: this.pose === 'tray' ? 1 : 0 };
    this.dirty = true;
  }
  setHalves(h) { this.halves = h; this.refresh(); }
  _poseHalves() {
    const t = ease(this.splitT), k = this._poseT ?? 0, sep = 0.42;
    // apart: slide along Z. tray: left half up, right half turned over about the long axis, cut faces toward +Z.
    this.gL.position.set(0, 0.60 * k * t, -sep * t * (1 - k));
    this.gR.position.set(0, -0.60 * k * t, sep * t * (1 - k) + Math.sin(Math.PI * t) * 0.5 * k);
    this.gR.rotation.set(Math.PI * k * t, 0, 0);
    this.gL.updateMatrixWorld(true); this.gR.updateMatrixWorld(true);
    this.planeL.set(_v.set(0, 0, -1), 0).applyMatrix4(this.gL.matrixWorld);
    this.planeR.set(_v.set(0, 0, 1), 0).applyMatrix4(this.gR.matrixWorld);
  }
  halfMatrix(side) { return (side === 'right' ? this.gR : this.gL).matrixWorld; }
  halfShown(side) { return this.splitT === 0 || this.halves === 'both' || this.halves === (side === 'right' ? 'right' : 'left'); }

  // ------------------------------------------------------------------ camera
  flyTo(pos, target, dur = 750) {
    if (reduceMotion() || this.instant) dur = 1;
    this._tween = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos.clone(), t1: target.clone(), start: performance.now(), dur };
    this.dirty = true;
  }
  preset(name, dur) {
    const c = this.center.clone(), tan = Math.tan(this.camera.fov * Math.PI / 360), sz = this.size || new THREE.Vector3(2.1, 1.1, 1.25);
    // half extents on screen (horizontal, vertical) for each view
    const L = sz.x / 2, Hh = sz.y / 2, Wd = sz.z / 2;
    let [hw, hh] = { left: [L, Hh], right: [L, Hh], medial: [L, Hh], dorsal: [Wd, L], ventral: [Wd, L], rostral: [Wd, Hh], caudal: [Wd, Hh], reset: [L * 0.95, Hh * 1.15], floor: [Wd * 1.05, L * 0.92] }[name] || [L, Hh];
    const split = this.split !== 'whole';
    if (split && this.pose === 'tray') { hh = Hh * 2 + 0.2; hw = L; }
    else if (split && this.halves === 'both') { if (hw === Wd) hw += 0.42; if (name === 'dorsal' || name === 'ventral') hw = Wd + 0.42; if (name === 'reset') hw += 0.3; }
    const side = this.width > 700 ? 0.66 : 0.8;
    if (hw === L) { hw += 0.1; c.x += 0.1; }
    if (name === 'floor') { c.x -= 0.12; c.y -= 0.1; }                      // room for the nose in front of the skull                   // leave the margins to the label columns
    const fit = Math.max(hh / tan / 0.8, hw / (tan * this.camera.aspect * side));
    const D = { left: [0.02, 0.12, -1], right: [-0.02, 0.12, 1], dorsal: [-0.015, 1, 0], ventral: [-0.015, -1, 0], rostral: [1, 0.1, 0.0], caudal: [-1, 0.1, 0.0], medial: [0.02, 0.08, 1], reset: [0.45, 0.3, -1], floor: [-0.36, 0.93, 0] }[name] || [0, 0, -1];
    const d = new THREE.Vector3(...D).normalize();
    if (split && this.pose === 'tray') d.set(0.01, 0.05, 1).normalize();
    this.flyTo(c.clone().addScaledVector(d, fit), c, dur);
    this._preset = name;
  }
  // Fly to look at a world point from the direction of its normal.
  focus(world, normal, dist = 1.5, blend = 0.18) {
    this._preset = null;
    const n = normal.clone().normalize();
    if (Math.abs(n.y) > 0.92) n.x += 0.12;                      // keep off the orbit pole
    const cur = this.camera.position.clone().sub(this.controls.target).normalize();
    const dir = n.lengthSq() > 0.1 ? n.lerp(cur, blend).normalize() : cur;
    this.flyTo(world.clone().addScaledVector(dir, dist), world);
  }

  _tick() {
    const now = performance.now();
    const a = this._splitAnim;
    if (a) {
      const u = Math.min(1, Math.max(0, (now - a.t0) / a.dur));
      this.splitT = a.from + (a.to - a.from) * u;
      this._poseT = a.poseFrom + (a.poseTo - a.poseFrom) * ease(u);
      this._poseHalves(); this.refresh();
      if (u >= 1) { this._splitAnim = null; if (this.onSplitDone) this.onSplitDone(); }
    }
    const fa = this._floorAnim;
    if (fa) {
      const u = Math.min(1, Math.max(0, (now - fa.t0) / fa.dur));
      this.floorT = fa.from + (fa.to - fa.from) * u;
      if (u >= 1) { this._floorAnim = null; if (fa.to === 0) this.floor = false; }
      this._setFloorPlane(); this.refresh();
      if (u >= 1 && this.onSplitDone) this.onSplitDone();
    }
    // breathing highlight: 1.5 s cycle, redrawn without re-laying labels or re-rendering shadows
    let pulseOnly = false;
    if (this.selParts.size || this.marker) {
      const ph = this.instant ? 0.35 : (now % 1500) / 1500;
      this.pulse = this.instant ? 1 : 0.5 + 0.5 * Math.sin(ph * Math.PI * 2);
      for (const p of this.selParts) for (const m of p.mats) m.emissive.copy(FILL).multiplyScalar(0.1 + 0.2 * this.pulse);
      if (this.marker) {
        const mk = this.marker, pr = mk.userData.pulse; pr.scale.setScalar(1 + 0.25 * ph); pr.material.opacity = 0.85 * (1 - ph);
        mk.updateWorldMatrix(true, false);
        const wn = _v.copy(mk.userData.n).transformDirection(mk.parent.matrixWorld), to = _v2.setFromMatrixPosition(mk.matrixWorld).sub(this.camera.position).normalize();
        const axial = Math.abs(wn.dot(to)) > 0.82;                                   // within about 35 degrees of the hole's axis
        if (mk.userData.axial !== axial) { mk.userData.axial = axial; for (const c of mk.userData.cones) c.visible = !axial; for (const t of mk.userData.ticks) t.visible = axial; this.dirty = true; }
      }
      if (!this.dirty && !this.instant) { pulseOnly = true; this.dirty = true; }
    }
    const tw = this._tween;
    if (tw) {
      const u = Math.min(1, Math.max(0, (now - tw.start) / tw.dur)), e = ease(u);
      // swing around the target rather than cutting straight through the specimen
      const o0 = _v.copy(tw.p0).sub(tw.t0), o1 = _v2.copy(tw.p1).sub(tw.t1);
      const r = o0.length() + (o1.length() - o0.length()) * e;
      const dir = o0.normalize().lerp(o1.normalize(), e);
      if (dir.lengthSq() < 1e-4) dir.set(0.3, 0.3, 1);
      dir.normalize();
      this.controls.target.lerpVectors(tw.t0, tw.t1, e);
      this.camera.position.copy(this.controls.target).addScaledVector(dir, r);
      if (u >= 1) this._tween = null;
      this.dirty = this.moved = true;
    }
    this.controls.update();
    if (!this.dirty) { this._lastT = 0; return; }
    if (tw || fa || a) pulseOnly = false;
    if (this._lastT && !this.instant) { const dt = now - this._lastT; if (dt < 250) { this._slow = (this._slow || 0) * 0.9 + (dt > 26 ? 1 : 0); if (this._slow > 7 && !this.noShadow) { this._slow = 0; this._shadowStep(); } } }
    this._lastT = now;
    this.dirty = false;
    this.scene.updateMatrixWorld();
    this.key.shadow.autoUpdate = false; this.key.shadow.needsUpdate = !pulseOnly || this.moved;
    this.renderer.render(this.scene, this.camera);
    if (pulseOnly && !this.moved) return;
    const moved = this.moved; this.moved = false;
    for (const cb of this.frameCbs) cb(moved);
  }

  // ------------------------------------------------------------------ picking
  _entries(p) {
    if (this.floor || this.floorT > 0) return [[p.side === 'X' ? 'W' : p.side, 'F']];
    if (p.side !== 'X') return [[p.side, false]];
    return this.splitT > 0 ? [['L', 'H'], ['R', 'H']] : [['W', false]];
  }
  // Nearest visible surface (or cut face) along a world ray.
  cast(ray, skip) {
    const split = this.splitT > 0;
    const inv = {};
    for (const k of ['L', 'R', 'W']) { const g = k === 'L' ? this.gL : k === 'R' ? this.gR : this.gW; inv[k] = _m.copy(g.matrixWorld).invert().clone(); _gray[k].copy(ray).applyMatrix4(inv[k]); }
    let best = null;
    for (const p of this.parts) {
      if (p.noPick || !this._visible(p) || (skip && skip(p))) continue;
      for (const [k, clipped] of this._entries(p)) {
        if (split && k !== 'W' && !this.halfShown(k === 'R' ? 'right' : 'left')) continue;
        const gr = _gray[k];
        if (!gr.intersectsSphere(p.sphere)) continue;
        _ray.copy(gr).applyMatrix4(p.inv);
        const bvh = p.geometry.boundsTree;
        let pt = null;
        if (!clipped) { const h = bvh.raycastFirst(_ray, THREE.FrontSide); if (h) pt = _v.copy(h.point).applyMatrix4(p.matrix); }
        else {
          let bd = Infinity, bh = null;
          for (const h of bvh.raycast(_ray, THREE.DoubleSide)) {
            const q = _v2.copy(h.point).applyMatrix4(p.matrix);                 // half-local
            if (clipped === 'F' ? this.floorPlane.distanceToPoint(q) < 0 : (k === 'L' ? q.z > 0 : q.z < 0)) continue;
            const d = q.distanceToSquared(gr.origin);
            if (d < bd) { bd = d; bh = h; pt = _v.copy(q); }
          }
          if (bh && bh.face.normal.dot(_ray.direction) > 0) {                   // came in through the cut face
            if (clipped === 'F') pt = gr.intersectPlane(this.floorPlane, _v) ? _v : null;
            else if (Math.abs(gr.direction.z) < 1e-6) pt = null;
            else { const t = -gr.origin.z / gr.direction.z; pt = t > 0 ? _v.copy(gr.direction).multiplyScalar(t).add(gr.origin) : null; }
          }
        }
        if (!pt) continue;
        const g = k === 'L' ? this.gL : k === 'R' ? this.gR : this.gW;
        const w = pt.clone().applyMatrix4(g.matrixWorld), dist = w.distanceTo(ray.origin);
        if (!best || dist < best.dist) best = { dist, point: w, part: p };
      }
    }
    return best;
  }
  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const rc = this._rc || (this._rc = new THREE.Raycaster());
    rc.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.cast(rc.ray);
  }
  occluded(world, own, tol = 0.025) {
    const o = this.camera.position, d = _v.copy(world).sub(o), len = d.length();
    const ray = new THREE.Ray(o.clone(), d.clone().normalize());
    const h = this.cast(ray, p => p.baseOpacity * this.layers[p.layer].opacity < 0.5 || (own && own(p)));
    return !!h && h.dist < len - tol;
  }
  project(world, out) {
    out.copy(world).project(this.camera);
    const z = out.z;
    out.x = (out.x * 0.5 + 0.5) * this.width; out.y = (-out.y * 0.5 + 0.5) * this.height; out.z = z;
    return out;
  }

  // Shadow catcher: an unseen bench under the head that only shows the key light's cast shadow.
  addShadow() {
    const sz = this.size || new THREE.Vector3(2.1, 1.1, 1.25);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.ShadowMaterial({ opacity: 0.26, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(this.center.x, this.center.y - sz.y / 2 - 0.1, 0); m.receiveShadow = true; m.renderOrder = -1;
    this.scene.add(m); this.shadow = m; this._aimKey();
  }

  // ------------------------------------------------------------------ bone finish
  // Smooth normals across the seams between bone regions, then bake soft ambient occlusion into
  // vertex colours a slice at a time so the page stays responsive.
  finishBone() {
    const bones = this.parts.filter(p => p.kind === 'bone' && p.tag === 'skull');
    const acc = new Map(), key = (x, y, z) => Math.round(x * 2e4) + '_' + Math.round(y * 2e4) + '_' + Math.round(z * 2e4);
    for (const p of bones) { const P = p.geometry.attributes.position, N = p.geometry.attributes.normal;
      for (let i = 0; i < P.count; i++) { const k = key(P.getX(i), P.getY(i), P.getZ(i)); let a = acc.get(k); if (!a) acc.set(k, a = [0, 0, 0]); a[0] += N.getX(i); a[1] += N.getY(i); a[2] += N.getZ(i); } }
    for (const p of bones) { const P = p.geometry.attributes.position, N = p.geometry.attributes.normal;
      for (let i = 0; i < P.count; i++) { const a = acc.get(key(P.getX(i), P.getY(i), P.getZ(i))); const l = Math.hypot(a[0], a[1], a[2]) || 1; N.setXYZ(i, a[0] / l, a[1] / l, a[2] / l); }
      N.needsUpdate = true; }
    this.dirty = true;

    const dirs = []; { let s = 3; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (let i = 0; i < 10; i++) { const u = rnd(), v = rnd() * 6.2832, r = Math.sqrt(u); dirs.push([r * Math.cos(v), r * Math.sin(v), Math.sqrt(1 - u)]); } }
    const MAXD = 0.22, ray = new THREE.Ray(), n = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3(), pos = new THREE.Vector3();
    const jobs = bones.map(p => ({ p, i: 0, col: p.geometry.attributes.color }));
    const step = () => {
      const t0 = performance.now();
      while (jobs.length && performance.now() - t0 < 12) {
        const j = jobs[0], P = j.p.geometry.attributes.position, N = j.p.geometry.attributes.normal;
        const end = Math.min(P.count, j.i + 400);
        for (; j.i < end; j.i++) {
          pos.fromBufferAttribute(P, j.i); n.fromBufferAttribute(N, j.i);
          t.set(n.y, -n.x, 0); if (t.lengthSq() < 1e-4) t.set(0, n.z, -n.y); t.normalize(); b.crossVectors(n, t);
          let occ = 0;
          for (const d of dirs) {
            ray.direction.set(0, 0, 0).addScaledVector(t, d[0]).addScaledVector(b, d[1]).addScaledVector(n, d[2]).normalize();
            ray.origin.copy(pos).addScaledVector(n, 0.004);
            let near = MAXD;
            for (const q of bones) { if (!ray.intersectsSphere(q.sphere)) continue; const h = q.geometry.boundsTree.raycastFirst(ray, THREE.DoubleSide); if (h) { const dd = h.point.distanceTo(ray.origin); if (dd < near) near = dd; } }
            occ += 1 - near / MAXD;
          }
          const ao = 1 - 0.95 * occ / dirs.length, k = Math.pow(Math.max(0, ao), 1.5);
          // crevices go warm and dark, as on a cleaned skull
          j.col.setXYZ(j.i, 0.30 + 0.70 * k, 0.22 + 0.78 * k, 0.15 + 0.85 * k);
        }
        if (j.i >= P.count) { j.col.needsUpdate = true; jobs.shift(); this.dirty = true; }
      }
      if (jobs.length) setTimeout(step, 0);
    };
    setTimeout(step, 30);
  }
}
