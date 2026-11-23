// Labels: exact term text on chips in two margin columns, elbow leaders that never cross,
// eased positions and fades; numbered pins in quiz mode.
import * as THREE from 'three';

const _w = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Vector3();
const SLOT = 26;          // comfortable line pitch in a column, px

// do segments p1-p2 and p3-p4 properly intersect?
function crosses(a, b) {
  const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const seg = (x1, y1, x2, y2, x3, y3, x4, y4) => { const d1 = d(x3, y3, x4, y4, x1, y1), d2 = d(x3, y3, x4, y4, x2, y2), d3 = d(x1, y1, x2, y2, x3, y3), d4 = d(x1, y1, x2, y2, x4, y4); return d1 * d2 < 0 && d3 * d4 < 0; };
  // each leader is stub (ex,ey)-(kx,ey) then (kx,ey)-(px,py)
  const A = [[a.ex, a.ey, a.kx, a.ey], [a.kx, a.ey, a.x, a.y]], B = [[b.ex, b.ey, b.kx, b.ey], [b.kx, b.ey, b.x, b.y]];
  for (const p of A) for (const q of B) if (seg(...p, ...q)) return true;
  return false;
}

export class Labels {
  // app: { anchorFor, ownParts, candidates() -> [{term, pri}], isQuiz, quizPins, selected, density(), medialOnly(a, term) , onPick, onPin, onHover, onCount }
  constructor(stage, host, canvas, app) {
    this.stage = stage; this.host = host; this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.app = app;
    this.st = new Map(); this.pins = new Map(); this.size = new Map(); this.occ = new Map(); this.frame = 0; this.hot = null;
    this.global = 1; this.globalT = 1; this.lastMove = 0;
    stage.onFrame(moved => this.update(moved));
  }
  state(term) {
    let s = this.st.get(term.id);
    if (!s) {
      const e = document.createElement('div'); e.className = 'lbl'; e.textContent = term.term; e.style.opacity = 0;
      e.addEventListener('click', () => this.app.onPick(term.id));
      e.addEventListener('pointerenter', () => { this.hot = term.id; this.app.onHover(term.id); this.kick(); });
      e.addEventListener('pointerleave', () => { if (this.hot === term.id) { this.hot = null; this.app.onHover(null); this.kick(); } });
      this.host.appendChild(e);
      s = { id: term.id, e, x: 0, y: 0, a: 0, ta: 0, tx: 0, ty: 0, px: 0, py: 0, side: 'l', w: 0, h: 0 };
      this.st.set(term.id, s);
    }
    return s;
  }
  measure(term, s) {
    const key = term.id + '|' + this.maxW; let z = this.size.get(key);
    if (!z) { z = { w: s.e.offsetWidth, h: s.e.offsetHeight }; if (z.w) this.size.set(key, z); }
    return z;
  }
  pin(id) {
    let e = this.pins.get(id);
    if (!e) { e = document.createElement('button'); e.className = 'pin'; e.type = 'button'; e.addEventListener('click', ev => { ev.stopPropagation(); this.app.onPin(id); }); this.host.appendChild(e); this.pins.set(id, e); }
    return e;
  }
  invalidate() { this.occ.clear(); this.stage.invalidate(); this.stage.moved = false; this.force = true; }

  world(a, out) {
    const side = a.side === 'right' ? 'right' : 'left';
    if (!this.stage.halfShown(side)) return null;
    return out.copy(a.pos).applyMatrix4(this.stage.halfMatrix(side));
  }

  update(moved) {
    const st = this.stage, W = st.width, H = st.height, now = performance.now();
    this.frame++;
    const quiz = this.app.isQuiz();
    if (moved) { this.lastMove = now; clearTimeout(this._idle); this._idle = setTimeout(() => { this.occ.clear(); this.settled = true; this.update(false); }, 160); }
    const refreshOcc = !moved || this.frame % 6 === 0;
    // which side of the cut the camera is on, for the labelled (left) half
    const split = st.splitT > 0; let camMedial = false;
    if (split) { _c.copy(st.camera.position).applyMatrix4(_m.copy(st.gL.matrixWorld).invert()); camMedial = _c.z > 0; }
    const list = quiz ? this.app.quizPins() : this.app.candidates();
    const vis = []; let drift = 0, nd = 0;
    for (const it of list) {
      const a = this.app.anchorFor(it.id); if (!a) continue;
      const isSel = this.app.selected === it.id;
      if (split && !quiz && !isSel && this.app.medial(a, it.id) !== camMedial) continue;
      const w = this.world(a, _w); if (!w) continue;
      st.project(w, _s);
      if (_s.z > 1 || _s.z < -1 || _s.x < 4 || _s.x > W - 4 || _s.y < 4 || _s.y > H - 4) continue;
      let o = this.occ.get(it.id);
      if (o === undefined || refreshOcc) { const own = this.app.ownParts(it.id); o = st.occluded(w, own.size ? p => own.has(p) : null); this.occ.set(it.id, o); }
      if (o && !isSel) continue;
      const s = this.st.get(it.id); if (s && s.a > 0.05) { drift += Math.hypot(_s.x - s.px, _s.y - s.py); nd++; }
      vis.push({ ...it, x: _s.x, y: _s.y, z: _s.z });
    }
    // hide while the view is swinging fast, come back when it settles
    const speed = nd ? drift / nd : 0;
    if (moved && speed > 9) this.globalT = 0; else if (!moved || speed < 3) this.globalT = 1;
    if (st.instant) this.globalT = 1;

    for (const e of this.pins.values()) e._on = false;
    for (const s of this.st.values()) s.ta = 0;
    if (quiz) {
      for (const v of vis) { const e = this.pin(v.id); e._on = true; e.hidden = false; e.textContent = v.n; e.className = 'pin' + (v.cur ? ' cur' : '') + (v.state ? ' ' + v.state : ''); e.style.transform = `translate(${v.x.toFixed(1)}px,${v.y.toFixed(1)}px)`; }
    } else this.layout(vis, W, H);
    for (const e of this.pins.values()) if (!e._on && !e.hidden) e.hidden = true;
    this.force = false;
    this.kick();
  }

  layout(vis, W, H) {
    const st = this.stage, narrow = W < 560, pad = narrow ? 8 : 14, top = 56, bottom = narrow ? 14 : 60;
    this.maxW = narrow ? 118 : W < 760 ? 140 : 216;
    const sel = this.app.selected, focus = this.app.density() === 'focus';
    // the specimen's centre on screen splits the pins into a left and a right column
    _c.copy(st.center); if (st.splitT > 0) _c.applyMatrix4(st.halfMatrix('left')); st.project(_c, _s);
    const cx = Math.min(W * 0.7, Math.max(W * 0.3, _s.x));
    let pool = vis.map(v => ({ ...v, pri: v.id === sel ? 1e9 : v.pri }));
    this.total = pool.length;
    if (focus) { const n = narrow ? 6 : 11; pool.sort((a, b) => b.pri - a.pri); pool = pool.slice(0, n); }
    const cols = { l: [], r: [] };
    for (const v of pool) { v.s = this.state(v.term); v.size = this.measure(v.term, v.s); v.side = v.x < cx ? 'l' : 'r'; cols[v.side].push(v); }
    const avail = H - top - bottom, cap = Math.max(3, Math.floor(avail / SLOT) - (narrow ? 6 : 0)), reach = Math.max(110, H * 0.24);
    let shown = 0;
    for (const side of ['l', 'r']) {
      let col = cols[side]; const k = side === 'l' ? 1 : -1;
      if (col.length > cap) { col.sort((a, b) => b.pri - a.pri); col.length = cap; }
      for (let guard = 0; guard < 300; guard++) {
        col.sort((a, b) => a.y - b.y || a.x * k - b.x * k);
        let y = top;
        for (const v of col) { v.slot = Math.max(SLOT, v.size.h + 5); v.ly = Math.max(y, v.y - v.size.h / 2); y = v.ly + v.slot; }
        let lim = H - bottom;
        for (let i = col.length - 1; i >= 0; i--) { const v = col[i]; v.ly = Math.min(v.ly, lim - v.size.h); lim = v.ly - (v.slot - v.size.h); }
        for (const v of col) { v.lx = side === 'l' ? pad : W - pad - v.size.w; v.ex = side === 'l' ? v.lx + v.size.w + 3 : v.lx - 3; v.ey = v.ly + Math.min(v.size.h / 2, 11); v.kx = v.ex + 12 * k; }
        // anything pushed far from its pin, off the top, or crossing a neighbour gives way (lowest priority first)
        let drop = null;
        const worse = v => { if (v.id !== sel && (!drop || v.pri < drop.pri)) drop = v; };
        for (const v of col) if (Math.abs(v.ey - v.y) > reach || v.ly < top - 1 || (v.x - v.kx) * k < 6) worse(v);
        if (!drop) for (let i = 0; i < col.length; i++) for (let j = i + 1; j < col.length; j++) if (crosses(col[i], col[j])) { worse(col[i].pri < col[j].pri ? col[i] : col[j]); }
        if (!drop) break;
        col.splice(col.indexOf(drop), 1);
      }
      shown += col.length;
      for (const v of col) {
        const s = v.s; s.ta = 1; s.side = side; s.w = v.size.w; s.h = v.size.h; s.px = v.x; s.py = v.y;
        if (s.a < 0.02) { s.x = v.lx; s.y = v.ly; }            // new labels fade in where they belong
        s.tx = v.lx; s.ty = v.ly;
      }
    }
    if (this.app.onCount) this.app.onCount(shown, this.total);
  }

  kick() { if (!this._raf) { this._t = performance.now(); this._raf = requestAnimationFrame(() => this.anim()); } }
  anim() {
    this._raf = 0;
    const now = performance.now(), dt = Math.min(64, now - this._t); this._t = now;
    const instant = this.stage.instant, kPos = instant ? 1 : 1 - Math.exp(-dt / 55), kA = instant ? 1 : 1 - Math.exp(-dt / 70);
    this.global += (this.globalT - this.global) * (instant ? 1 : 1 - Math.exp(-dt / (this.globalT ? 110 : 45)));
    let busy = Math.abs(this.globalT - this.global) > 0.01;
    const sel = this.app.selected;
    for (const s of this.st.values()) {
      if (s.ta === 0 && s.a === 0) continue;
      s.a += (s.ta - s.a) * kA; s.x += (s.tx - s.x) * kPos; s.y += (s.ty - s.y) * kPos;
      if (Math.abs(s.ta - s.a) < 0.01) s.a = s.ta; else busy = true;
      if (Math.abs(s.tx - s.x) + Math.abs(s.ty - s.y) < 0.3) { s.x = s.tx; s.y = s.ty; } else busy = true;
      const e = s.e, op = s.a * this.global;
      e.style.opacity = op.toFixed(3); e.style.pointerEvents = op > 0.5 ? 'auto' : 'none';
      e.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px)`;
      const cls = 'lbl' + (s.side === 'r' ? ' r' : '') + (s.id === sel ? ' sel' : '') + (s.id === this.hot ? ' hot' : '');
      if (e.className !== cls) e.className = cls;
    }
    this.draw();
    if (busy) this.kick();
  }

  draw() {
    const c = this.canvas, st = this.stage, dpr = Math.min(window.devicePixelRatio || 1, 2), g = this.ctx;
    if (c.width !== Math.round(st.width * dpr) || c.height !== Math.round(st.height * dpr)) { c.width = Math.round(st.width * dpr); c.height = Math.round(st.height * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, st.width, st.height);
    if (this.app.isQuiz()) return;
    const cs = getComputedStyle(this.host), fg = cs.getPropertyValue('--fg').trim() || '#000', accent = cs.getPropertyValue('--accent').trim() || '#06c', panel = cs.getPropertyValue('--panel').trim() || '#fff';
    const sel = this.app.selected;
    for (const pass of [0, 1]) for (const s of this.st.values()) {
      const op = s.a * this.global; if (op < 0.02) continue;
      const hi = s.id === sel || s.id === this.hot; if ((pass === 1) !== hi) continue;
      const k = s.side === 'l' ? 1 : -1, ex = s.side === 'l' ? s.x + s.w + 3 : s.x - 3, ey = s.y + Math.min(s.h / 2, 11);
      g.globalAlpha = op * (hi ? 0.95 : 0.55);
      g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex + 12 * k, ey); g.lineTo(s.px, s.py);
      g.strokeStyle = hi ? accent : fg; g.lineWidth = hi ? 1.6 : 1; g.lineJoin = 'round'; g.stroke();
      g.globalAlpha = op;
      g.beginPath(); g.arc(s.px, s.py, hi ? 3.4 : 2.5, 0, 7); g.fillStyle = hi ? accent : fg; g.fill(); g.lineWidth = 1.5; g.strokeStyle = panel; g.stroke();
    }
    g.globalAlpha = 1;
  }
}
const _m = new THREE.Matrix4();
