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
const KM_PER_UNIT = (0.849 * AU_KM) / KEPLER_B_ORBIT_R; // true scale: km per scene unit

// TRUE SCALE (like the Solar System view). Real radii (NASA): Kepler-22 ≈ 0.979
// R_sun, Kepler-22b ≈ 2.4 R_earth. At this scale both are sub-pixel, so the
// min-dot scaler (updateScales) draws them at a floor size when far and grows
// them to real size as you approach — exactly as the Solar view does. The orbit
// stays at the real 0.849 AU (8 units), so orbit/star ≈ 186 — the true ratio —
// and Kepler-22b sits as far from its star, proportionally, as Earth from the Sun.
const R_SUN_KM   = 696340;
const R_EARTH_KM = 6371;
const STAR_RADIUS     = (0.979 * R_SUN_KM)   / KM_PER_UNIT; // ≈ 0.0429 units
const KEPLER_B_RADIUS = (2.4   * R_EARTH_KM) / KM_PER_UNIT; // ≈ 0.00096 units
const KEPLER_B_SPEED   = 0.00009;
const KEPLER_INTRO_FROM = new THREE.Vector3(0, 5, 90); // far: star is a tiny point
const KEPLER_INTRO_TO   = new THREE.Vector3(0, 6, 18); // settled system view

// Min-dot floors (px) — smallest on-screen radius a body is drawn at when true
// scale would make it sub-pixel. Same values as the Solar view.
const MIN_DOT_PX       = 2.6;   // the planet
const STAR_CORE_MIN_PX = 1.3;   // the star core (smaller so the glow dominates far away)
const ORBIT_HIDE_ABOVE_PX = 22; // hide the orbit line once the planet's on-screen radius exceeds this (Solar-view value)

// Star glow — mirrors the Sun's glow logic AND constants in world.js (the star is
// now the Sun's true size, so the same numbers apply). A filled additive bloom
// that holds a fixed on-screen size when zoomed out and scales with the disc when
// zoomed in, parked just in front of the star so its own face never occludes it.
const KEP_GLOW_FAR_PX  = 34;   // fixed glow-ball radius (px) when zoomed out
const KEP_GLOW_RIM_MUL = 2.0;  // glow radius as a multiple of the disc when zoomed in
const KEP_GLOW_NEAR    = 0.06;  // distance (units) at/under which the glow is fully bright
const KEP_GLOW_FAR     = 300;   // distance (units) at which the glow reaches its faint floor
const KEP_GLOW_MAX     = 1.0;   // opacity near the star
const KEP_GLOW_MIN     = 0.22;  // opacity far away

const _ray = new THREE.Raycaster();
const _mouse = new THREE.Vector2();

const room = {
  scene: null, camera: null, controls: null,
  // Map-scale anchor: Kepler-22b orbits at KEPLER_B_ORBIT_R units ≈ 0.849 AU.
  kmPerUnit: KM_PER_UNIT,
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

    // 🌟 3D starfield — same logic as the main Solar view (uniform-density volume,
    // per-point distance fade + size attenuation), scaled to this room (system ~8
    // units, camera maxDistance 200): dots grow as you approach and shrink/fade as
    // you pull away, giving depth and parallax. Self-updating in the shader.
    {
      const COUNT = 45000, R_MIN = 40, R_MAX = 4000, FADE_NEAR = 80, FADE_FAR = 2500; // match the Solar view's count
      const rMin3 = R_MIN ** 3, rMax3 = R_MAX ** 3;
      const pos = new Float32Array(COUNT * 3);
      for (let i = 0; i < COUNT; i++) {
        const u = Math.random() * 2 - 1, phi = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        const r = Math.cbrt(rMin3 + (rMax3 - rMin3) * Math.random());
        pos[i*3] = r*s*Math.cos(phi); pos[i*3+1] = r*u; pos[i*3+2] = r*s*Math.sin(phi);
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(geom, new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xdde1e8) }, uOpacity: { value: 0.8 },
          uSizeScale: { value: 350 }, uSizeMax: { value: 2.6 },
          uNear: { value: FADE_NEAR }, uFar: { value: FADE_FAR }
        },
        transparent: true, depthWrite: false,
        vertexShader: `
          uniform float uSizeScale; uniform float uSizeMax; uniform float uNear; uniform float uFar;
          varying float vFade;
          #include <common>
          #include <logdepthbuf_pars_vertex>
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            float d = length(mv.xyz);
            vFade = 1.0 - smoothstep(uNear, uFar, d);
            gl_PointSize = min(uSizeMax, uSizeScale / d);
            gl_Position = projectionMatrix * mv;
            #include <logdepthbuf_vertex>
          }
        `,
        fragmentShader: `
          uniform vec3 uColor; uniform float uOpacity;
          varying float vFade;
          #include <logdepthbuf_pars_fragment>
          void main() {
            #include <logdepthbuf_fragment>
            if (vFade <= 0.001) discard;
            gl_FragColor = vec4(uColor, uOpacity * vFade);
          }
        `
      }));
      stars.frustumCulled = false;
      scene.add(stars);
    }
    // Lighting: ambient 0.15 fill + a point light from the star. The point light is
    // dialled down to 1.1 (below the Solar System's 1.5) so the star-facing day side
    // of Kepler-22b isn't blown out and the white clouds read with good contrast
    // against the bright teal surface.
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const kLight = new THREE.PointLight(0xfff5e0, 1.1, 0, 1.2);
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
    // by updateScales().
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

    // Cloud layer — sized to the planet's surface radius and lifted to a fixed 0.5%
    // altitude via local scale. Parented to the planet so it inherits the orbit, then
    // spun independently in update(). Same sun-lit shader as Earth's clouds (NORMAL
    // alpha blending, not additive): dense cloud reads as a solid white mass on the
    // star-facing day side, dims toward a 0.1 floor across a soft terminator, and stays
    // faintly visible (not cut off) on the night side. clouds.png carries coverage in
    // its ALPHA channel (Earth's grayscale map used .r). sunDirection (planet→star) is
    // updated each frame in update(). No white glow ring (unlike Earth).
    const cloudTex = loadTexture("clouds.png");
    this.bClouds = new THREE.Mesh(
      new THREE.SphereGeometry(KEPLER_B_RADIUS, 64, 64),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          cloudTexture: { value: cloudTex },
          sunDirection: { value: new THREE.Vector3(1, 0, 0) }
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vNormal;
          #include <common>
          #include <logdepthbuf_pars_vertex>
          void main() {
            vUv = uv;
            vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            #include <logdepthbuf_vertex>
          }
        `,
        fragmentShader: `
          uniform sampler2D cloudTexture;
          uniform vec3 sunDirection;
          varying vec2 vUv;
          varying vec3 vNormal;
          #include <logdepthbuf_pars_fragment>
          void main() {
            #include <logdepthbuf_fragment>
            float cloud = clamp(texture2D(cloudTexture, vUv).a * 1.6, 0.0, 1.0); // accent coverage so clouds read over the bright surface
            float intensity = dot(normalize(vNormal), sunDirection);
            float lit = smoothstep(-0.2, 0.3, intensity);    // wide, soft day↔night transition
            float brightness = mix(0.3, 1.0, lit);           // raised night floor so dark-side clouds stay visible
            gl_FragColor = vec4(vec3(brightness), cloud);    // clouds stay everywhere, just darker at night
          }
        `
      })
    );
    this.bClouds.scale.setScalar(1.005);   // 0.5% above the surface
    this.b.add(this.bClouds);
    // Orbit line — a 1px-wide THREE.Line circle (constant on-screen width at any
    // zoom), exactly like the Solar view, instead of a flat RingGeometry whose
    // fixed 0.06-unit world thickness became enormous at true-scale close-ups.
    // Segment count from the Solar view's sagitta rule so the polygon hugs the
    // true circle (the tiny planet sits right on it). Hidden up close in updateScales.
    const orbitSegs = Math.min(4096, Math.max(256,
      Math.ceil(Math.PI * Math.sqrt(KEPLER_B_ORBIT_R / (2 * (KEPLER_B_RADIUS * 0.1))))));
    const orbitPts = [];
    for (let i = 0; i <= orbitSegs; i++) {
      const a = (i / orbitSegs) * Math.PI * 2;
      orbitPts.push(new THREE.Vector3(Math.cos(a) * KEPLER_B_ORBIT_R, 0, Math.sin(a) * KEPLER_B_ORBIT_R));
    }
    this.orbit = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(orbitPts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15 })
    );
    this.orbit.visible = this.orbitsVisible;
    scene.add(this.orbit);

    // True-scale near plane (matches the Solar view) so you can approach the now
    // sub-pixel-true bodies without clipping into them.
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.0004, SKYBOX_RADIUS * 2);
    this.camera.position.set(0, 6, 18);
    this.controls = new THREE.OrbitControls(this.camera, ctx.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 0.2;   // much gentler zoom, matching the main view
    // True scale: let the camera approach Kepler-22b (true radius ≈ 0.00096) to
    // just outside its surface for a real-size close-up. 0.0015 stays clear of the
    // planet and the near plane; the star (≈ 0.0429) can be entered, as the Sun can.
    this.controls.minDistance   = 0.0015;
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
  flyToObject(obj, fromList = false) {
    if (!obj || !obj.userData) return;
    // Ignore a canvas re-click on the body we're already focused on (e.g. an accidental
    // click while dragging to orbit it) — re-flying would zoom back out to the framing
    // distance. The bodies panel passes fromList=true to force a (re-)frame.
    if (!fromList && obj === this.lockedObject) return;
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
    const FLY_MS = 3000; let flyLast = performance.now(); // time-based, display-independent
    let t = 0;
    (function flyTo() {
      if (!self._isActive) { self.flying = false; return; }
      const now = performance.now(); t += (now - flyLast) / FLY_MS; flyLast = now;
      if (t > 1) t = 1;
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
      el.addEventListener("click", () => { self.flyToObject(items[i].obj, true); });
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

  // Per-frame true-scale sizing — mirrors the Solar view (world.js applyMinDots +
  // updateSunGlow). Keeps the star core and planet at a min-dot floor when they'd
  // be sub-pixel and grows them to real size up close, then sizes/positions/fades
  // the star glow exactly as the Sun's.
  updateScales() {
    const cam = this.camera;
    const tanHalf = Math.tan((cam.fov * Math.PI / 180) / 2);
    const H = window.innerHeight;

    // ── Star core (at the origin) + its glow ──
    const dStar = cam.position.length();
    if (dStar > 0 && this.star) {
      const wpp = (2 * dStar * tanHalf) / H;
      const starPx = STAR_RADIUS / wpp; // true on-screen disc radius (px)
      // Min-dot the core so the star never vanishes when far (the glow dominates).
      this.star.scale.setScalar(Math.max(1, (STAR_CORE_MIN_PX * wpp) / STAR_RADIUS));
      if (this.starGlow) {
        // Park the glow strictly IN FRONT of the whole star sphere (10% nearer than
        // its closest point) using the RENDERED radius — not tangent to the near
        // pole, which makes the additive glow z-fight the surface under the log
        // depth buffer and drop out in a circular "bite". dStar*0.9 caps it in
        // front of the camera for extreme close-ups.
        const renderedR = STAR_RADIUS * this.star.scale.x;
        const offset = Math.min(dStar - (dStar - renderedR) * 0.9, dStar * 0.9);
        this.starGlow.position.copy(cam.position).setLength(offset);
        const spriteWpp = (2 * (dStar - offset) * tanHalf) / H;
        const glowPx = Math.max(KEP_GLOW_FAR_PX, KEP_GLOW_RIM_MUL * starPx);
        this.starGlow.scale.setScalar(glowPx * spriteWpp * 2);
        const t = Math.min(1, Math.max(0,
          (Math.log(dStar) - Math.log(KEP_GLOW_NEAR)) / (Math.log(KEP_GLOW_FAR) - Math.log(KEP_GLOW_NEAR))));
        this.starGlow.material.opacity = KEP_GLOW_MAX - (KEP_GLOW_MAX - KEP_GLOW_MIN) * t;
      }
    }

    // ── Planet min-dot (its cloud shell is a child and inherits the scale) ──
    if (this.b) {
      const pPos = this.b.getWorldPosition(new THREE.Vector3());
      const dP = cam.position.distanceTo(pPos);
      if (dP > 0) {
        const wppP = (2 * dP * tanHalf) / H;
        const planetPx = KEPLER_B_RADIUS / wppP; // true on-screen radius (px)
        this.b.scale.setScalar(Math.max(1, MIN_DOT_PX / planetPx));
        // Hide the orbit line once the planet is large on screen — same as the
        // Solar view (a thin ring through a big planet looks wrong; the planet
        // also sits exactly on the line at true scale).
        if (this.orbit) this.orbit.visible = this.orbitsVisible && planetPx < ORBIT_HIDE_ABOVE_PX;
      }
    }
  },

  update(ctx) {
    const now = performance.now();
    const kScale = Math.min(now - this._lastT, 100) / (1000 / 60);
    this._lastT = now;
    this.bPivot.rotation.y += KEPLER_B_SPEED * ctx.speed * kScale;
    this.b.rotation.y      += 0.01 * ctx.speed * kScale;
    // Clouds drift slightly faster than the surface — Earth's cloud logic.
    if (this.bClouds) {
      this.bClouds.rotation.y += 0.0101 * ctx.speed * kScale;
      // Light the clouds by the star (at the origin): direction is planet → star.
      const pPos = this.b.getWorldPosition(new THREE.Vector3());
      this.bClouds.material.uniforms.sunDirection.value.copy(pPos.negate().normalize());
    }

    if (this.introActive) {
      // ease-OUT zoom-in, continuing the galaxy dive (slow)
      this.introT += 0.006 * kScale;
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
    this.updateScales();
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
