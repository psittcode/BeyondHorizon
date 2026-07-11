// Room: True Size Comparison.
//
// Every body in the program — the Sun, the 8 planets, the 5 dwarf planets, all
// 28 moons, plus the Kepler-22 star and its exoplanet — lined up side by side at
// TRUE relative scale (the same 1 unit = 14.96M km anchor the solar view uses),
// sorted smallest → largest like the classic "star size comparison" image. The
// bodies rest on a common baseline (y = 0) so the size differences read at a
// glance, in front of the same 8k Milky Way skybox the solar system uses.
//
// Navigation: ◀ / ▶ steps through the line-up one body at a time (the camera
// flies to frame each one), a "full line-up" button zooms out to the overview,
// clicking a body selects it, and ← / → arrow keys work too. The line-up loops:
// stepping past the largest body returns to the overview.
//
// Lazy room (see viewManager.js): this module and its assets cost nothing until
// the "True Size" button on the main menu is clicked. Bodies reuse the exact
// radii from src/data/planets.js and the exact real shape models / procedural
// shapes the solar view builds (imported from world.js — safe: world.js has
// long finished evaluating by the time this room is lazily imported).

import { loadTexture } from '../core/assets.js';
import { data } from '../data/planets.js';
import {
  makeGriddedMoonGeometry, makeMoonShapeGeometry, makeAsteroidGeometry,
  REAL_MOON_SHAPES,
} from '../world.js';

const KM_PER_UNIT  = 14959787.07;   // same anchor as the solar view (1 AU = 10 units)
const R_EARTH_KM   = 6371;
const SKYBOX_RADIUS = 3000;
const FLY_MS = 900;

// Visual info the data module doesn't carry for the major planets (their meshes
// are built in world.js): texture file + axial tilt (deg) + ring flag.
const PLANET_EXTRAS = {
  Mercury: { tex: '2k_mercury.jpg',        tilt: 0.03 },
  Venus:   { tex: '4k_venus_atmosphere.jpg', tilt: 177.4 },
  Earth:   { tex: '2k_earth_daymap.jpg',   tilt: 23.4 },
  Mars:    { tex: '2k_mars.jpg',           tilt: 25.2 },
  Jupiter: { tex: 'jupiter.jpg',           tilt: 3.1 },
  Saturn:  { tex: '2k_saturn.jpg',         tilt: 26.7, ring: { inner: 1.5, outer: 2.5, opacity: 1.0 } },
  Uranus:  { tex: '2k_uranus.jpg',         tilt: 97.8, ring: { inner: 1.65, outer: 2.05, opacity: 0.30 } },
  Neptune: { tex: '2k_neptune.jpg',        tilt: 28.3 },
};

// Bodies that live outside the data array (built directly in world.js / kepler.js),
// with the same true radii those files use.
const EXTRA_BODIES = [
  { name: 'Sun',      r: 696340 / KM_PER_UNIT, tex: '2k_sun.jpg', selfLit: true,
    type: 'Star · G-type', glow: 0xffcc66 },
  { name: 'Moon',     r: 1737.4 / KM_PER_UNIT, tex: '2k_earth_moon.jpg', type: 'Moon of Earth' },
  { name: 'Io',       r: 0.0001217, tex: 'Io.png',       type: 'Moon of Jupiter' },
  { name: 'Europa',   r: 0.0001044, tex: 'Europa.png',   type: 'Moon of Jupiter' },
  { name: 'Ganymede', r: 0.0001759, tex: 'Ganymede.png', type: 'Moon of Jupiter' },
  { name: 'Callisto', r: 0.0001611, tex: 'Callisto.png', type: 'Moon of Jupiter' },
  { name: 'Kepler-22',  r: (0.979 * 696340) / KM_PER_UNIT, tex: '2k_sun.jpg', selfLit: true,
    tint: 0xffd9a6, type: 'Star · Kepler-22 system, 644 ly away', glow: 0xffbb77 },
  { name: 'Kepler-22b', r: (2.4 * R_EARTH_KM) / KM_PER_UNIT, tex: 'Kepler 22b_0.jpeg',
    type: 'Exoplanet · orbits Kepler-22' },
];

// Same geometry decisions the solar view makes for each moon: real measured
// shape model if one exists, else the data-declared procedural shape, else the
// seeded generic asteroid (identical seed formula → identical potato), else a sphere.
function moonGeometry(mn, idx) {
  const real = REAL_MOON_SHAPES[mn.name];
  if (real) return makeGriddedMoonGeometry(real, mn.size);
  if (mn.shape) return makeMoonShapeGeometry(mn.size, mn.shape);
  if (mn.irregular) return makeAsteroidGeometry(mn.size, 1013 * (idx + 1) + 7);
  return new THREE.SphereGeometry(mn.size, 48, 48);
}

// Ring mesh with RADIAL UVs (u = inner→outer fraction) so the 1D ring strip
// texture maps as concentric bands, like the solar view's ring shader samples it.
function makeRing(bodyR, spec) {
  const inner = bodyR * spec.inner, outer = bodyR * spec.outer;
  const geo = new THREE.RingGeometry(inner, outer, 128, 1);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const t = (Math.hypot(pos.getX(i), pos.getY(i)) - inner) / (outer - inner);
    uv.setXY(i, t, 0.5);
  }
  const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: loadTexture('8k_saturn_ring_alpha.png'), transparent: true,
    opacity: spec.opacity, side: THREE.DoubleSide, depthWrite: false,
  }));
  ring.rotation.x = -Math.PI / 2;
  return ring;
}

// Soft radial-gradient glow sprite for the two stars.
function makeGlowSprite(color, radius) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const col = new THREE.Color(color);
  const rgb = `${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0}`;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, `rgba(${rgb},0.85)`);
  g.addColorStop(0.35, `rgba(${rgb},0.28)`);
  g.addColorStop(1.0, `rgba(${rgb},0)`);
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  sp.scale.set(radius * 4.6, radius * 4.6, 1);
  return sp;
}

function fmtKm(km) {
  if (km < 100) return km.toFixed(1);   // tiny moons: keep a decimal (e.g. 6.3 km)
  return Math.round(km).toLocaleString('en-US');
}
function fmtVsEarth(km) {
  const x = km / R_EARTH_KM;
  if (x >= 10)   return x.toFixed(1);
  if (x >= 0.01) return x.toFixed(2);
  return x.toPrecision(2);
}

// Build the full catalog: every planet/dwarf/moon in the data array + the extras.
function buildCatalog() {
  const cat = [];
  data.forEach(p => {
    const ex = PLANET_EXTRAS[p.name] || {};
    cat.push({
      name: p.name, r: p.size,
      tex: p.texture || ex.tex, color: p.color,
      tilt: (p.tilt != null ? p.tilt : ex.tilt) || 0,
      ellipsoid: p.ellipsoid, ring: ex.ring,
      type: p.kind === 'dwarf' ? 'Dwarf planet' : 'Planet',
    });
    (p.moons || []).forEach((mn, idx) => {
      cat.push({
        name: mn.name, r: mn.size, tex: mn.texture, color: mn.color,
        type: `Moon of ${p.name}`, mn, mnIdx: idx,
      });
    });
  });
  EXTRA_BODIES.forEach(b => cat.push(Object.assign({}, b)));
  cat.sort((a, b) => a.r - b.r);   // smallest → largest, like the classic image
  return cat;
}

const room = {
  scene: null, camera: null, controls: null,
  bodies: [],           // catalog entries, each with .group/.mesh/.x/.span added
  selected: -1,         // -1 = overview, else index into bodies
  kmPerUnit: KM_PER_UNIT,
  _skybox: null, _keyLight: null, _spinMeshes: [],
  _lastT: 0, _fly: null, _active: false,
  _raycaster: null, _downXY: null,

  async init(ctx) {
    const scene = new THREE.Scene();
    this.scene = scene;

    // The exact 8k Milky Way skybox the solar system uses (texture already on
    // the GPU — world.js shares it through ctx). Follows the camera each frame.
    const skyTex = ctx.milkyWayTexture || loadTexture('8k_stars_milky_way.jpg');
    this._skybox = new THREE.Mesh(
      new THREE.SphereGeometry(SKYBOX_RADIUS, 60, 40),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide })
    );
    scene.add(this._skybox);

    scene.add(new THREE.AmbientLight(0xffffff, 0.38));
    this._keyLight = new THREE.DirectionalLight(0xffffff, 1.05);
    scene.add(this._keyLight);
    scene.add(this._keyLight.target);

    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1e-7, SKYBOX_RADIUS * 10);
    this.controls = new THREE.OrbitControls(this.camera, ctx.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 0.5;
    this.controls.enabled = false;

    // ── Build + lay out the line-up ─────────────────────────────────────────
    this.bodies = buildCatalog();

    // span = half-width the body occupies in the row (rings stick out past the surface)
    this.bodies.forEach(b => { b.span = b.ring ? b.r * (b.ring.outer + 0.15) : b.r; });

    // Side-by-side along +x, resting on the y=0 baseline, gap ∝ neighbour size.
    let edge = 0, prevSpan = 0;
    this.bodies.forEach((b, i) => {
      const gap = i === 0 ? 0 : Math.max(prevSpan, b.span) * 0.45;
      b.x = edge + gap + b.span;
      edge = b.x + b.span;
      prevSpan = b.span;
    });
    const totalW = edge;
    this.bodies.forEach(b => { b.x -= totalW / 2; });   // centre the row on the origin

    for (const b of this.bodies) {
      const geo = b.mn ? moonGeometry(b.mn, b.mnIdx) : new THREE.SphereGeometry(b.r, 64, 64);
      const matOpts = {};
      if (b.tex) matOpts.map = loadTexture(b.tex); else matOpts.color = b.color || 0xaaaaaa;
      if (b.tint) matOpts.color = b.tint;
      const mesh = new THREE.Mesh(geo, b.selfLit
        ? new THREE.MeshBasicMaterial(matOpts)
        : new THREE.MeshStandardMaterial(matOpts));
      if (b.ellipsoid) mesh.scale.set(b.ellipsoid[0], b.ellipsoid[1], b.ellipsoid[2]);
      mesh.userData.bodyIndex = this.bodies.indexOf(b);

      const group = new THREE.Group();          // tilt container
      group.add(mesh);
      if (b.ring) group.add(makeRing(b.r, b.ring));
      if (b.glow) group.add(makeGlowSprite(b.glow, b.r));
      group.rotation.z = -(b.tilt || 0) * Math.PI / 180;
      group.position.set(b.x, b.r, 0);          // centre at y = r → rests on the baseline

      b.group = group; b.mesh = mesh;
      this._spinMeshes.push(mesh);
      scene.add(group);
    }

    // ── Input: click to select a body, arrow keys to step ───────────────────
    this._raycaster = new THREE.Raycaster();
    ctx.domElement.addEventListener('pointerdown', e => {
      if (this._active) this._downXY = { x: e.clientX, y: e.clientY };
    });
    ctx.domElement.addEventListener('pointerup', e => {
      if (!this._active || !this._downXY) return;
      const moved = Math.hypot(e.clientX - this._downXY.x, e.clientY - this._downXY.y);
      this._downXY = null;
      if (moved > 5) return;                    // it was a drag, not a click
      const ndc = new THREE.Vector2(
        (e.clientX / innerWidth) * 2 - 1,
        -(e.clientY / innerHeight) * 2 + 1
      );
      this._raycaster.setFromCamera(ndc, this.camera);
      const hits = this._raycaster.intersectObjects(this.bodies.map(b => b.mesh));
      if (hits.length) this.select(hits[0].object.userData.bodyIndex);
    });
    window.addEventListener('keydown', e => {
      if (!this._active) return;
      if (e.key === 'ArrowRight') { this.step(1);  e.preventDefault(); }
      if (e.key === 'ArrowLeft')  { this.step(-1); e.preventDefault(); }
    });
    document.getElementById('sizePrev').onclick = () => this.step(-1);
    document.getElementById('sizeNext').onclick = () => this.step(1);
    document.getElementById('sizeOverview').onclick = () => this.select(-1);
  },

  // ── Camera framing ─────────────────────────────────────────────────────────
  _frameFor(i) {
    if (i < 0) {   // overview: fit the whole row
      const first = this.bodies[0], last = this.bodies[this.bodies.length - 1];
      const maxR = last.r;
      const halfW = (last.x + last.span - (first.x - first.span)) / 2 * 1.22;
      const midX  = (first.x - first.span + last.x + last.span) / 2;
      const tanH  = Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect;
      const dist  = Math.max(halfW / tanH, maxR * 2.6);
      const target = new THREE.Vector3(midX, maxR * 0.5, 0);
      const pos = target.clone().add(new THREE.Vector3(0, dist * 0.10, dist));
      return { target, pos };
    }
    const b = this.bodies[i];
    const dist = b.r * (b.ring ? 6.2 : 3.6);
    const target = new THREE.Vector3(b.x, b.r, 0);
    const pos = target.clone().add(new THREE.Vector3(dist * 0.18, dist * 0.16, dist));
    return { target, pos };
  },

  select(i, instant) {
    this.selected = i;
    const f = this._frameFor(i);
    if (instant) {
      this.controls.target.copy(f.target);
      this.camera.position.copy(f.pos);
      this.camera.up.set(0, 1, 0);
      this._fly = null;
      this._applyLimits();
    } else {
      this._fly = {
        t: 0,
        fromT: this.controls.target.clone(), toT: f.target,
        fromP: this.camera.position.clone(), toP: f.pos,
      };
      this.controls.enabled = false;
    }
    this._updateCaption();
  },

  // Cyclic: overview → smallest → … → largest → overview → …
  step(dir) {
    const n = this.bodies.length;
    let i = this.selected + dir;
    if (i >= n) i = -1;
    if (i < -1) i = n - 1;
    this.select(i);
  },

  _applyLimits() {
    const b = this.selected >= 0 ? this.bodies[this.selected] : null;
    this.controls.minDistance = b ? b.r * 1.25 : 0.002;
    this.controls.maxDistance = SKYBOX_RADIUS * 0.9;
  },

  _updateCaption() {
    const nameEl = document.getElementById('sizeName');
    const subEl  = document.getElementById('sizeSub');
    const statEl = document.getElementById('sizeStats');
    const cntEl  = document.getElementById('sizeCount');
    if (this.selected < 0) {
      nameEl.textContent = 'The Solar System & Kepler-22';
      subEl.textContent  = `${this.bodies.length} bodies · true relative scale`;
      statEl.textContent = 'Step through with ◀ ▶ or click a body';
      cntEl.textContent  = 'Overview';
    } else {
      const b = this.bodies[this.selected];
      const km = b.r * KM_PER_UNIT;
      nameEl.textContent = b.name;
      subEl.textContent  = b.type;
      statEl.textContent = `Mean radius ${fmtKm(km)} km · ${fmtVsEarth(km)} × Earth`;
      cntEl.textContent  = `${this.selected + 1} / ${this.bodies.length}`;
    }
  },

  // ── Room contract ──────────────────────────────────────────────────────────
  enter(ctx) {
    ctx.controls.enabled = false;               // main-view controls off
    document.getElementById('speedPanel').style.display = 'none';
    document.getElementById('panel').style.display = 'none';
    document.getElementById('sizeUI').style.display = 'block';
    this._active = true;
    this._lastT = performance.now();
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.select(-1, true);                      // start at the full line-up
    this.controls.enabled = true;
  },

  update(ctx) {
    const now = performance.now();
    const dScale = Math.min(now - this._lastT, 100) / (1000 / 60);
    this._lastT = now;

    // Gentle self-rotation so the textures read as globes, not stickers.
    for (const m of this._spinMeshes) m.rotation.y += 0.0028 * dScale;

    // Camera fly: target lerps linearly, camera distance interpolates in LOG
    // space so hops between a 6 km moon and a 700,000 km star stay smooth.
    if (this._fly) {
      const f = this._fly;
      f.t = Math.min(1, f.t + (now - (f._last || now - 16)) / FLY_MS);
      f._last = now;
      const e = f.t < 0.5 ? 4 * f.t * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 3) / 2; // easeInOutCubic
      const target = f.fromT.clone().lerp(f.toT, e);
      const d0 = f.fromP.distanceTo(f.fromT), d1 = f.toP.distanceTo(f.toT);
      const dir0 = f.fromP.clone().sub(f.fromT).normalize();
      const dir1 = f.toP.clone().sub(f.toT).normalize();
      const dir = dir0.lerp(dir1, e).normalize();
      const d = Math.exp((1 - e) * Math.log(Math.max(d0, 1e-9)) + e * Math.log(d1));
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir, d);
      this.camera.up.set(0, 1, 0);
      if (f.t >= 1) { this._fly = null; this._applyLimits(); this.controls.enabled = true; }
    }

    // Key light rides the camera (up-left of the view direction) so whatever
    // body you're inspecting is always lit; magnitude is irrelevant to a
    // DirectionalLight, only the position→target direction matters.
    const ldir = this.camera.position.clone().sub(this.controls.target).normalize();
    ldir.x += 0.35; ldir.y += 0.45; ldir.normalize();
    this._keyLight.position.copy(this.controls.target).add(ldir);
    this._keyLight.target.position.copy(this.controls.target);

    this._skybox.position.copy(this.camera.position);   // sky can never be exited
    this.controls.update();
    ctx.renderer.render(this.scene, this.camera);
  },

  exit(ctx) {
    this._active = false;
    this.controls.enabled = false;
    document.getElementById('sizeUI').style.display = 'none';
    document.getElementById('speedPanel').style.display = '';
    ctx.controls.enabled = true;
  },
};

export default room;
