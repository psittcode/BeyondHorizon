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
import { AU_KM } from '../core/scale.js';

const SKYBOX_RADIUS = 20000;
const KEPLER_B_ORBIT_R = 8;          // 0.849 AU — Kepler-22b's real semi-major axis
// Kepler-22b is enlarged for visibility (true radius would be a sub-pixel dot at
// this orbit scale), but kept clearly smaller than its host star.
const KEPLER_B_RADIUS  = 0.28;
const KEPLER_B_SPEED   = 0.00009;
const KEPLER_INTRO_FROM = new THREE.Vector3(0, 5, 90); // far: star is a tiny point
const KEPLER_INTRO_TO   = new THREE.Vector3(0, 6, 18); // settled system view

// Star glow — mirrors the Sun's glow logic in world.js. A filled additive bloom
// that holds a fixed on-screen size when zoomed out and scales with the disc when
// zoomed in, parked just in front of the star (along the camera ray) so the star's
// own face never occludes it while a transiting planet still does.
// Star rendered well below true scale (~0.043 units would be a sub-pixel dot) but
// small enough that Kepler-22b's real 0.849 AU orbit reads as properly far out:
// orbit/star ≈ 13 star-radii (true is ~186, which isn't viewable with a visible star).
const STAR_RADIUS      = 0.6;  // matches the star SphereGeometry radius below
const KEP_GLOW_FAR_PX  = 34;   // fixed glow-ball radius (px) when zoomed out
const KEP_GLOW_RIM_MUL = 2.0;  // glow radius as a multiple of the disc when zoomed in
const KEP_GLOW_NEAR    = 2.5;   // distance (units) at/under which the glow is fully bright
const KEP_GLOW_FAR     = 200;   // distance (units) at which the glow reaches its faint floor
const KEP_GLOW_MAX     = 1.0;   // opacity near the star
const KEP_GLOW_MIN     = 0.22;  // opacity far away

const _ray = new THREE.Raycaster();
const _mouse = new THREE.Vector2();

const room = {
  scene: null, camera: null, controls: null,
  // Map-scale anchor: Kepler-22b orbits at KEPLER_B_ORBIT_R units ≈ 0.849 AU.
  kmPerUnit: (0.849 * AU_KM) / KEPLER_B_ORBIT_R,
  bPivot: null, b: null, bClouds: null, star: null, starGlow: null, orbit: null,
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
      new THREE.SphereGeometry(STAR_RADIUS, 64, 64),
      new THREE.MeshBasicMaterial({ map: ctx.sunTexture, color: 0xfff0d8 })
    );
    this.star.userData = {
      name: "Kepler-22", size: STAR_RADIUS,
      info: `<b>Kepler-22</b><br><br>The Sun-like G-type host star of this system, about 644 light-years away in the constellation Cygnus. It is roughly 3% less massive than the Sun with a surface temperature of 5,518 K. Its one confirmed planet, Kepler-22b, orbits within the habitable zone — click it to learn more.`
    };
    scene.add(this.star);
    // Star glow — same filled-bloom sprite as the Sun; sized/positioned per frame
    // by updateStarGlow().
    {
      const _gc = document.createElement('canvas'); _gc.width = _gc.height = 256;
      const _gx = _gc.getContext('2d');
      // Filled bloom (NASA-Eyes style): brightest at centre, alpha decreasing
      // monotonically to transparent — a solid point of light, never a hollow
      // ring; broad enough to cover the disc and surround it when zoomed in.
      const _gd = _gx.createRadialGradient(128, 128, 0, 128, 128, 128);
      _gd.addColorStop(0.00, 'rgba(255, 250, 238, 0.50)');
      _gd.addColorStop(0.16, 'rgba(255, 244, 212, 0.42)');
      _gd.addColorStop(0.32, 'rgba(255, 228, 170, 0.30)');
      _gd.addColorStop(0.48, 'rgba(255, 198, 122, 0.185)');
      _gd.addColorStop(0.64, 'rgba(252, 158,  85, 0.090)');
      _gd.addColorStop(0.80, 'rgba(225, 115,  55, 0.033)');
      _gd.addColorStop(1.00, 'rgba(185,  88,  42, 0.000)');
      _gx.fillStyle = _gd; _gx.fillRect(0, 0, 256, 256);
      this.starGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(_gc), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false
        // depthTest stays ON so a transiting planet occludes the glow; the star's
        // own face is handled by parking the sprite in front of it each frame.
      }));
      this.starGlow.scale.set(6, 6, 1);
      scene.add(this.starGlow);
    }

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

  // Size, position and fade the star glow for the current zoom — the Sun's logic
  // (world.js updateSunGlow), adapted to this fixed-size star at the scene origin.
  updateStarGlow() {
    if (!this.starGlow) return;
    const cam = this.camera;
    const dStar = cam.position.length(); // star sits at the origin
    if (dStar <= 0) return;
    const tanHalf = Math.tan((cam.fov * Math.PI / 180) / 2);
    const worldPerPx = (2 * dStar * tanHalf) / window.innerHeight;
    const starPx = STAR_RADIUS / worldPerPx; // on-screen disc radius (px)
    // Park the glow just in front of the star's near surface along the camera ray
    // so the star's own face never occludes it, while a planet passing in front
    // still does (depthTest is on). A billboard's whole quad lies at one depth.
    const offset = Math.min(STAR_RADIUS, dStar * 0.9);
    this.starGlow.position.copy(cam.position).setLength(offset);
    // Fixed-pixel ball when zoomed out; scales with the disc when zoomed in.
    // Convert to world size at the sprite's own (closer) depth so the offset
    // doesn't change its apparent on-screen size.
    const spriteWorldPerPx = (2 * (dStar - offset) * tanHalf) / window.innerHeight;
    const glowPx = Math.max(KEP_GLOW_FAR_PX, KEP_GLOW_RIM_MUL * starPx);
    this.starGlow.scale.setScalar(glowPx * spriteWorldPerPx * 2);
    // Brightest near the star, fading on a log scale to a faint floor far away.
    const t = Math.min(1, Math.max(0,
      (Math.log(dStar) - Math.log(KEP_GLOW_NEAR)) / (Math.log(KEP_GLOW_FAR) - Math.log(KEP_GLOW_NEAR))));
    this.starGlow.material.opacity = KEP_GLOW_MAX - (KEP_GLOW_MAX - KEP_GLOW_MIN) * t;
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
    this.updateStarGlow();
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
