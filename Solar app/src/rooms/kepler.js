// Room: the Kepler-22 system (host star + Kepler-22b orbiting it).
//
// A standalone scene like Andromeda. The zoom-IN entry (flyToKeplerDot) and
// zoom-OUT escape (escapeKeplerToGalaxy) drive the MAIN camera through the Milky
// Way view and stay in legacy.js; they just call viewManager.enter('kepler') /
// exitActive(). This room owns the system scene, the fly-in intro, the bodies
// list, the in-scene click, and the orbit/list toggles (delegated from legacy's
// shared buttons via viewManager.activeName === 'kepler').

import { loadTexture } from '../core/assets.js';
import { KEPLER_22B_INFO } from '../data/info.js';

const SKYBOX_RADIUS = 20000;
const KEPLER_B_ORBIT_R = 8;
const KEPLER_B_RADIUS  = 0.55 * 2.1;
const KEPLER_B_SPEED   = 0.00009;
const KEPLER_INTRO_FROM = new THREE.Vector3(0, 5, 90); // far: star is a tiny point
const KEPLER_INTRO_TO   = new THREE.Vector3(0, 6, 18); // settled system view

const _ray = new THREE.Raycaster();
const _mouse = new THREE.Vector2();

const room = {
  scene: null, camera: null, controls: null,
  bPivot: null, b: null, bClouds: null, star: null, orbit: null,
  lockedObject: null, flying: false,
  listVisible: false, orbitsVisible: true,
  introActive: false, introT: 0,
  _lastT: 0, _isActive: false,

  async init(ctx) {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(SKYBOX_RADIUS, 64, 64),
      new THREE.MeshBasicMaterial({ map: ctx.milkyWayTexture, side: THREE.BackSide })
    ));
    // Match the Solar System's lighting (ambient 0.15 + point 1.5) so the
    // star-facing side of Kepler-22b isn't blown out — the same brightness the
    // Sun gives Earth and its neighbours, rather than the previous over-bright 2.5.
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const kLight = new THREE.PointLight(0xfff5e0, 1.5, 0, 1.2);
    kLight.position.set(0, 0, 0);
    scene.add(kLight);

    this.star = new THREE.Mesh(
      new THREE.SphereGeometry(2, 64, 64),
      new THREE.MeshBasicMaterial({ map: ctx.sunTexture, color: 0xfff0d8 })
    );
    this.star.userData = {
      name: "Kepler-22", size: 2,
      info: `<b>Kepler-22</b><br><br>The Sun-like G-type host star of this system, about 644 light-years away in the constellation Cygnus. It is roughly 3% less massive than the Sun with a surface temperature of 5,518 K. Its one confirmed planet, Kepler-22b, orbits within the habitable zone — click it to learn more.`
    };
    scene.add(this.star);
    // Soft star glow
    (function() {
      const _gc = document.createElement('canvas'); _gc.width = _gc.height = 256;
      const _gx = _gc.getContext('2d');
      const _gd = _gx.createRadialGradient(128, 128, 0, 128, 128, 128);
      _gd.addColorStop(0.00, 'rgba(255, 244, 200, 1.00)');
      _gd.addColorStop(0.20, 'rgba(255, 222, 140, 0.95)');
      _gd.addColorStop(0.45, 'rgba(255, 185,  80, 0.70)');
      _gd.addColorStop(0.75, 'rgba(235, 130,  30, 0.35)');
      _gd.addColorStop(1.00, 'rgba(180,  80,   0, 0.00)');
      _gx.fillStyle = _gd; _gx.fillRect(0, 0, 256, 256);
      const _sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(_gc), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      _sprite.scale.set(6, 6, 1);
      scene.add(_sprite);
    })();

    const kTex = loadTexture("Kepler 22b_0.jpeg");
    this.bPivot = new THREE.Group();
    scene.add(this.bPivot);
    this.b = new THREE.Mesh(
      new THREE.SphereGeometry(KEPLER_B_RADIUS, 64, 64),
      new THREE.MeshStandardMaterial({ map: kTex })
    );
    this.b.position.set(KEPLER_B_ORBIT_R, 0, 0);
    this.b.userData = { name: "Kepler-22b", size: KEPLER_B_RADIUS, info: KEPLER_22B_INFO };
    this.bPivot.add(this.b);

    // Cloud layer — a slightly larger sphere (~3.6% over the surface, matching
    // Earth's 0.57/0.55 shell) parented to the planet so it inherits the orbit,
    // then spun independently in update(). Unlike Earth's additive clouds, this
    // uses NORMAL blending on an unlit MeshBasicMaterial: the clouds render as a
    // constant semi-opaque white overlay that stays visible on the bright,
    // star-facing day side (additive blending washed out there) and is unaffected
    // by the scene's lighting.
    const cloudTex = loadTexture("clouds.png");
    this.bClouds = new THREE.Mesh(
      new THREE.SphereGeometry(KEPLER_B_RADIUS * (0.57 / 0.55), 64, 64),
      new THREE.MeshBasicMaterial({
        map: cloudTex,
        transparent: true,
        opacity: 0.75,
        blending: THREE.NormalBlending,
        depthWrite: false
      })
    );
    this.b.add(this.bClouds);
    this.orbit = new THREE.Mesh(
      new THREE.RingGeometry(KEPLER_B_ORBIT_R - 0.03, KEPLER_B_ORBIT_R + 0.03, 128),
      new THREE.MeshBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    );
    this.orbit.rotation.x = -Math.PI / 2;
    this.orbit.visible = this.orbitsVisible;
    scene.add(this.orbit);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, SKYBOX_RADIUS * 2);
    this.camera.position.set(0, 6, 18);
    this.controls = new THREE.OrbitControls(this.camera, ctx.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance   = 1.8;
    this.controls.maxDistance   = 200;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.scene = scene;
    this._ctx = ctx;

    // In-scene click (active only while this room is showing)
    const self = this;
    window.addEventListener("click", function(e) {
      if (!self._isActive) return;
      if (e.target !== ctx.renderer.domElement) return;
      _mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      _ray.setFromCamera(_mouse, self.camera);
      const hits = _ray.intersectObjects(self.scene.children, true);
      for (const h of hits) {
        let o = h.object;
        while (o && !(o.userData && o.userData.name) && o.parent) o = o.parent;
        if (o && o.userData && o.userData.name) { self.flyToObject(o); return; }
      }
    });
  },

  // Fly the scene camera to a clicked body and lock onto it.
  flyToObject(obj) {
    if (!obj || !obj.userData) return;
    document.getElementById('panel').style.display = 'block';
    document.getElementById('panelContent').innerHTML = obj.userData.info || '';
    document.getElementById('backToList').style.display = 'inline-block';
    this.lockedObject = obj;
    this.flying = true;
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const endTarget = obj.getWorldPosition(new THREE.Vector3());
    const size = obj.userData.size || 0.5;
    const endPos = endTarget.clone().add(new THREE.Vector3(0, size * 2, size * 8));
    const self = this;
    let t = 0;
    (function flyTo() {
      if (!self._isActive) { self.flying = false; return; }
      t += 0.03; if (t > 1) t = 1;
      const e = t * t * (3 - 2 * t);
      self.camera.position.lerpVectors(startPos, endPos, e);
      self.controls.target.lerpVectors(startTarget, endTarget, e);
      self.controls.update();
      if (t < 1) requestAnimationFrame(flyTo); else self.flying = false;
    })();
  },

  // Bodies list — same panel template as the Solar System list.
  showList() {
    document.getElementById("panel").style.display = "block";
    document.getElementById("backToList").style.display = "none";
    const items = [
      { label: "• Kepler-22",  obj: this.star },
      { label: "• Kepler-22b", obj: this.b },
    ];
    let html = "<b>The Kepler-22 System</b><br><br>";
    items.forEach(item => {
      html += `<div class="bodyItem" style="
      padding: 5px 8px; margin-bottom: 4px; cursor: pointer; border-radius: 4px;
      font-size: 13px; background: rgba(255,255,255,0.05); transition: background 0.2s;
    " onmouseover="this.style.background='rgba(255,255,255,0.15)'"
       onmouseout="this.style.background='rgba(255,255,255,0.05)'"
       data-label="${item.label}">
      ${item.label}
    </div>`;
    });
    document.getElementById("panelContent").innerHTML = html;
    const self = this;
    document.querySelectorAll(".bodyItem").forEach((el, i) => {
      el.addEventListener("click", () => { self.flyToObject(items[i].obj); });
    });
  },

  // Delegated from legacy's shared "Hide Orbits" button.
  toggleOrbits() {
    this.orbitsVisible = !this.orbitsVisible;
    if (this.orbit) this.orbit.visible = this.orbitsVisible;
    document.getElementById("toggleOrbits").textContent = this.orbitsVisible ? "Hide Orbits" : "Show Orbits";
  },

  // Delegated from legacy's shared "Show/Hide Bodies" button.
  toggleList() {
    this.listVisible = !this.listVisible;
    if (this.listVisible) {
      this.showList();
      document.getElementById("toggleList").textContent = "Hide Bodies";
    } else {
      document.getElementById("panel").style.display = "none";
      document.getElementById("toggleList").textContent = "Show Bodies";
    }
  },

  enter(ctx) {
    ctx.controls.enabled = false; // stop the main OrbitControls
    document.getElementById('speedPanel').style.display = 'block';
    document.getElementById('otherGalaxiesBtn').style.display = 'none';
    this.listVisible = true;
    this.showList();
    document.getElementById('toggleList').textContent = 'Hide Bodies';
    if (this.orbit) this.orbit.visible = this.orbitsVisible;
    document.getElementById('toggleOrbits').textContent = this.orbitsVisible ? 'Hide Orbits' : 'Show Orbits';
    // Begin the fly-in (star starts as a far point, continuing the galaxy dive).
    this.lockedObject = null;
    this.flying = false;
    this.introActive = true;
    this.introT = 0;
    this.camera.position.copy(KEPLER_INTRO_FROM);
    this.controls.target.set(0, 0, 0);
    this.camera.lookAt(0, 0, 0);
    this._lastT = performance.now();
    this._isActive = true;
  },

  update(ctx) {
    const now = performance.now();
    const kScale = Math.min(now - this._lastT, 100) / (1000 / 60);
    this._lastT = now;
    this.bPivot.rotation.y += KEPLER_B_SPEED * ctx.speed * kScale;
    this.b.rotation.y      += 0.01 * ctx.speed * kScale;
    // Clouds drift slightly faster than the surface — Earth's cloud logic.
    if (this.bClouds) this.bClouds.rotation.y += 0.0101 * ctx.speed * kScale;

    if (this.introActive) {
      // ease-OUT zoom-in, continuing the galaxy dive
      this.introT += 0.02 * kScale;
      if (this.introT >= 1) this.introT = 1;
      const e = this.introT * (2 - this.introT);
      this.camera.position.lerpVectors(KEPLER_INTRO_FROM, KEPLER_INTRO_TO, e);
      this.controls.target.set(0, 0, 0);
      this.camera.lookAt(0, 0, 0);
      if (this.introT >= 1) { this.introActive = false; this.controls.update(); }
    } else {
      if (this.lockedObject && !this.flying) {
        const tp = this.lockedObject.getWorldPosition(new THREE.Vector3());
        const delta = tp.clone().sub(this.controls.target);
        this.controls.target.copy(tp);
        this.camera.position.add(delta);
      }
      this.controls.update();
      // Zoomed all the way out → hand back to the galaxy (legacy keeps the dot centred).
      if (!this.flying &&
          this.camera.position.distanceTo(this.controls.target) >= this.controls.maxDistance - 2) {
        if (ctx.keplerEscapeToGalaxy) ctx.keplerEscapeToGalaxy();
        return;
      }
    }
    ctx.renderer.render(this.scene, this.camera);
  },

  exit(ctx) {
    this._isActive = false;
    this.lockedObject = null;
    ctx.controls.enabled = true;
    document.getElementById('otherGalaxiesBtn').style.display = 'block';
    // Restore the shared orbit/list button labels to the Solar System's state.
    document.getElementById('toggleOrbits').textContent = ctx.orbitsVisible ? 'Hide Orbits' : 'Show Orbits';
    document.getElementById('toggleList').textContent = ctx.listVisible ? 'Hide Bodies' : 'Show Bodies';
  },
};

export default room;
