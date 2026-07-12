import { ctx } from './core/engine.js';
import { viewManager } from './viewManager.js';
import { loadGLB } from './core/assets.js';
import { data } from './data/planets.js';
import { deimosShape } from './data/deimosShape.js';
import { phobosShape } from './data/phobosShape.js';
import { nixShape } from './data/nixShape.js';
import { hydraShape } from './data/hydraShape.js';
import { MILKY_WAY_INFO, SGR_A_INFO, marsTransformedInfo, SUN_INFO, MOON_INFO } from './data/info.js';
import { scaleRatioN, formatRatio, realPerCm, AU_KM, LY_KM } from './core/scale.js';

// Rooms (lazy-loaded). register() only stores a factory; the module is import()-ed
// on first entry, so its code + assets don't load until you visit it.
viewManager.register('andromeda', () => import('./rooms/andromeda.js'));
viewManager.register('kepler',    () => import('./rooms/kepler.js'));
viewManager.register('sizes',     () => import('./rooms/sizes.js'));
import('./rooms/kepler.js'); // preload so entry stays instant (continuous zoom-in)

const scene = new THREE.Scene();

// True-scale model: bodies are real radii at real distances, spanning ~9 orders
// of magnitude (a moon ~1e-4 units vs the galaxy skybox ~2e4 units). A tiny near
// plane lets you approach a planet until it fills the screen at true size; the
// logarithmic depth buffer (set on the renderer below) keeps that range usable.
const camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.0004, 1000000);
// The near plane is adjusted dynamically each frame (see animate) so you can zoom
// into bodies of ANY size — down to Pluto's tiny moons — without them clipping,
// while keeping depth precision when zoomed out.
camera.position.set(0, 22, 110);

// Tilt the camera's "up" vector by 23.4° so the ecliptic plane appears inclined
// relative to Earth's equatorial reference frame — matching NASA Eyes' orientation
const ECLIPTIC_TILT = 23.4 * Math.PI / 180;
camera.up.set(Math.sin(ECLIPTIC_TILT), Math.cos(ECLIPTIC_TILT), 0);

const renderer = new THREE.WebGLRenderer({ antialias:true, logarithmicDepthBuffer:true });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;

document.body.appendChild(renderer.domElement);

// Controls
const controls = new THREE.OrbitControls(camera, renderer.domElement);

// Publish the core handles to the shared engine context so room modules
// (rooms/*.js) can render with them. `speed` is exposed as a live getter so
// rooms always read the current slider value.
Object.assign(ctx, { THREE, scene, camera, renderer, controls, domElement: renderer.domElement });
Object.defineProperty(ctx, 'speed', { configurable: true, get: () => speed });
Object.defineProperty(ctx, 'orbitsVisible', { get: () => orbitsVisible });
Object.defineProperty(ctx, 'listVisible',   { get: () => listVisible });
ctx.keplerEscapeToGalaxy = () => escapeKeplerToGalaxy();

// ── Power / heat management ──────────────────────────────────────────────────
// Instead of pinning the GPU at the display's full refresh rate forever (120fps on
// a ProMotion Mac), the render loop is paced: full rate while anything is moving
// (camera, a fly-to, or the sim running above real-time), a gentle idle heartbeat
// when the scene is effectively static, and nothing at all while the tab/window is
// hidden. The loop never stops, so the view can't freeze — it just idles down,
// which is what lets the laptop fan settle when you leave it running.
const FPS_ACTIVE = 60;    // cap during interaction / visible motion
const FPS_IDLE   = 10;    // ~static scene; 10fps keeps the sim clock accurate against the 100ms delta cap
let _lastDrawMs    = 0;   // timestamp of the last frame we actually rendered
let _camDirtyUntil = 0;   // stay at full rate until this time — refreshed on every camera change
// How long to hold full 60fps after the last interaction before idling down. Generous
// (2s) so brief pauses while zooming/looking around a body don't snap to the 10fps idle
// floor (which read as "low fps when zoomed into Pluto"); it still settles when you walk
// away. Marked dirty both by OrbitControls' 'change' AND directly by raw wheel/pointer
// input — relying on 'change' alone could miss frames and leave a zoom rendering at 10fps.
const CAM_DIRTY_MS = 2000;
const markCameraActive = () => { _camDirtyUntil = performance.now() + CAM_DIRTY_MS; };
controls.addEventListener('change', markCameraActive);
renderer.domElement.addEventListener('wheel',       markCameraActive, { passive: true });
renderer.domElement.addEventListener('pointerdown', markCameraActive);
renderer.domElement.addEventListener('pointermove', e => { if (e.buttons) markCameraActive(); });
// Rooms share the same canvas, so raw input above already covers them; this
// lets a room ALSO extend the full-rate window itself (e.g. while its own
// OrbitControls damping is still settling after the pointer is released).
ctx.markCameraActive = markCameraActive;

// Diagnostic FPS meter (press F to toggle). Reports the ACTUAL rendered framerate over a
// rolling 0.5s window plus the worst frame time in that window (so spikes show). NB: by
// design the loop idles to ~10fps when the scene is static and ramps to 60 while you
// interact — so the number to watch is what it reads WHILE you zoom/drag.
let _fpsMeterOn = true;
let _fpsFrames = 0, _fpsWinStart = performance.now(), _fpsWorstMs = 0;
function fpsMeterTick(now, dtMs) {
  if (!_fpsMeterOn) return;
  _fpsFrames++;
  if (dtMs > _fpsWorstMs) _fpsWorstMs = dtMs;
  if (now - _fpsWinStart >= 500) {
    const fps = _fpsFrames * 1000 / (now - _fpsWinStart);
    const el = document.getElementById('fpsMeter');
    if (el) el.textContent = `${fps.toFixed(0)} fps · ${_fpsWorstMs.toFixed(0)} ms peak`;
    _fpsFrames = 0; _fpsWinStart = now; _fpsWorstMs = 0;
  }
}

// Per-frame orbital step for a moon. `rate` is the angular speed (rad per 1/60 s); the
// returned step is rate × deltaScale, i.e. proportional to REAL elapsed time, so the
// motion stays SMOOTH at any (even uneven) frame rate. The rate is capped two ways before
// scaling, so it never aliases or sweeps the screen:
//  1. an absolute cap (rate ≤ 0.05/frame), and
//  2. a ZOOM-AWARE cap: limit on-screen travel to a few px at the current zoom — at
//     extreme time-warp a tiny moon's orbit would otherwise sweep thousands of px/frame
//     when zoomed in, dragging the (following) camera and shaking its ring + neighbours.
// Capping the resulting STEP to a constant (the old approach) decoupled it from real time,
// which is what produced the visible stutter/jitter — so we cap the RATE, then scale.
// Largest per-frame orbital step (radians, at the simulation's reference frame rate). This
// is a fixed, zoom-INDEPENDENT anti-aliasing limit: at extreme time-warp a moon could try to
// jump most of the way round its orbit in one frame, which would strobe or visually reverse,
// so the step is clamped here. It is NOT tied to camera distance — a moon orbits at the same
// rate whether you view it from afar or up close.
const MAX_MOON_ORBIT_STEP = 0.05;
function moonOrbitStep(rate, orbitRadius, deltaScale) {
  // orbitRadius is no longer used (the cap is fixed/zoom-independent); kept for call-site
  // compatibility and readability at the call sites.
  const r = Math.abs(rate) > MAX_MOON_ORBIT_STEP ? Math.sign(rate) * MAX_MOON_ORBIT_STEP : rate;
  return r * deltaScale;
}

controls.enablePan = false;
controls.maxDistance = 1000000;
controls.minDistance = 0.0008;   // true-scale: allow approaching a focused body to ~just outside the near plane
controls.zoomSpeed = 0.2;        // much gentler mouse-wheel zoom — a slow glide, not a warp

// Lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.18);
scene.add(ambientLight);

// Sun intensity kept at ~1.0: with no tone mapping, a higher value drove the diffuse
// term past 1.0 on the sub-solar side of bright planets, clipping it to pure white
// (the "over-exposed" look). At ~1.0 the lit side tops out near the texture's own
// colour instead of blowing out. A touch more ambient softens the terminator.
const sunLight = new THREE.PointLight(0xffffff, 1.0);
sunLight.position.set(0, 0, 0);
scene.add(sunLight);

// Warm ambient light added only during the black hole view — not in scene by default

const textureLoader = new THREE.TextureLoader();
const jupiterTexture = textureLoader.load("jupiter.jpg");
const saturnTexture = textureLoader.load("2k_saturn.jpg");
const uranusTexture = textureLoader.load("2k_uranus.jpg");
const neptuneTexture = textureLoader.load("2k_neptune.jpg");
const marsTexture = textureLoader.load("2k_mars.jpg");
const mercuryTexture = textureLoader.load("2k_mercury.jpg");
const venusTexture = textureLoader.load("4k_venus_atmosphere.jpg");        // default: cloud-deck view
const venusSurfaceTexture = textureLoader.load("8k_venus_surface.jpg");    // shown when atmosphere is hidden
const moonTexture = textureLoader.load("2k_earth_moon.jpg");
const sunTexture = textureLoader.load("2k_sun.jpg");
const earthTexture = textureLoader.load("2k_earth_daymap.jpg");
const earthNightTexture = textureLoader.load("2k_earth_nightmap.jpg");
const ringTexture = textureLoader.load("8k_saturn_ring_alpha.png");
const milkyWayTexture = textureLoader.load("8k_stars_milky_way.jpg");
const starsTexture = textureLoader.load("8k_stars.jpg");   // plain star field — galaxy-scale + galactic-view backdrop
Object.assign(ctx, { sunTexture, milkyWayTexture, starsTexture }); // shared by the Kepler / True-Size rooms
const callistoTexture = textureLoader.load("Callisto.png");
const europaTexture = textureLoader.load("Europa.png");
const ganymedeTexture = textureLoader.load("Ganymede.png");
const ioTexture = textureLoader.load("Io.png");
const titanTexture = textureLoader.load("Titan.png");
const tritonTexture = textureLoader.load("Triton1.png");

// 🌌 MILKY WAY SKYBOX
// Threshold where the view hands off to the galaxy. Pushed near the galaxy disc's
// nearest edge to the Sun (~60.6k) so you get the maximum solar-system zoom-out
// before the galaxy takes over. (Going further would put the camera outside the
// disc; for that we'd need to scale the galaxy model up.)
const SKYBOX_RADIUS = 60000;
const skyGeometry = new THREE.SphereGeometry(SKYBOX_RADIUS, 64, 64);
const skyMaterial = new THREE.MeshBasicMaterial({
  map: milkyWayTexture,
  side: THREE.BackSide // render on the inside of the sphere
});
const skybox = new THREE.Mesh(skyGeometry, skyMaterial);
scene.add(skybox);

// ── Galaxy-view skybox ────────────────────────────────────────────────────────
// The plain 8k_stars.jpg star field (NOT the Milky Way panorama — at galaxy
// scale the Milky Way is the model in front of you, so the backdrop must not
// also contain it) on a large BackSide sphere. Position is updated every frame
// to follow the camera so it can never be escaped regardless of zoom level.
// Also used as the backdrop of the galactic schematic view (see animate()).
const galaxySkybox = new THREE.Mesh(
  new THREE.SphereGeometry(800000, 32, 32),
  new THREE.MeshBasicMaterial({
    map: starsTexture,
    side: THREE.BackSide,
    depthWrite: false
  })
);
galaxySkybox.visible = false;
scene.add(galaxySkybox);

// ── Black-hole backdrop skybox ───────────────────────────────────────────────
// The same 8K Milky Way panorama used by the solar-system skybox, on a
// camera-following BackSide sphere. Cross-fades in over the plain-stars
// galaxy backdrop as either BH zoom-in (galactic view or Milky Way view)
// takes over.
const bhSkybox = new THREE.Mesh(
  new THREE.SphereGeometry(750000, 32, 32),
  new THREE.MeshBasicMaterial({
    map: milkyWayTexture,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0,
    depthWrite: false
  })
);
bhSkybox.visible = false;
bhSkybox.renderOrder = 1; // draw over the plain-stars galaxySkybox
scene.add(bhSkybox);

// 🌟 3D BACKGROUND STARFIELD — white points scattered through a large volume around
// the solar system (NASA-Eyes style). They sit at finite distances, so moving/zooming
// shifts them relative to each other (parallax). A per-point DISTANCE FADE (custom
// shader) makes each dot fade out as you pull away from it, so distant dots don't pile
// up into a white blob — you only ever see the stars near you. Hidden at galaxy scale.
const STARFIELD_COUNT = 45000;
const STARFIELD_R_MIN  = 450;     // just beyond Neptune's orbit (~300) so it doesn't clutter the planets
const STARFIELD_R_MAX  = 55000;   // fills the (now larger) skybox
const STARFIELD_FADE_NEAR = 3000;  // fully visible within this distance of the camera
const STARFIELD_FADE_FAR   = 32000; // gone beyond this — wide range so the fade is gradual
const _rMin3 = STARFIELD_R_MIN ** 3, _rMax3 = STARFIELD_R_MAX ** 3;
const _starPos = new Float32Array(STARFIELD_COUNT * 3);
for (let i = 0; i < STARFIELD_COUNT; i++) {
  const u = Math.random() * 2 - 1;            // uniform cos(latitude)
  const phi = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  // UNIFORM density throughout the volume (cube-root of a uniform sample), so dots
  // exist at every distance and the on-screen density is the SAME at any zoom — not
  // dense near the Sun and empty far out. With the gradual fade, dots then wink out
  // layer by layer as you pull away, rather than the whole near-cluster at once.
  const r = Math.cbrt(_rMin3 + (_rMax3 - _rMin3) * Math.random());
  _starPos[i*3]     = r * s * Math.cos(phi);
  _starPos[i*3 + 1] = r * u;
  _starPos[i*3 + 2] = r * s * Math.sin(phi);
}
const starfieldGeom = new THREE.BufferGeometry();
starfieldGeom.setAttribute('position', new THREE.BufferAttribute(_starPos, 3));
const starfield = new THREE.Points(starfieldGeom, new THREE.ShaderMaterial({
  uniforms: {
    uColor:     { value: new THREE.Color(0xdde1e8) },
    uOpacity:   { value: 0.8 },
    uSizeScale: { value: 9000 }, // pixel size = this / distance (perspective shrink)
    uSizeMax:   { value: 2.8 },  // cap so very near dots aren't huge
    uNear:      { value: STARFIELD_FADE_NEAR },
    uFar:       { value: STARFIELD_FADE_FAR }
  },
  transparent: true,
  depthWrite: false,
  vertexShader: `
    uniform float uSizeScale; uniform float uSizeMax; uniform float uNear; uniform float uFar;
    varying float vFade;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float d = length(mv.xyz);                  // distance from the camera
      vFade = 1.0 - smoothstep(uNear, uFar, d);  // 1 near → 0 far (fade as you pull away)
      gl_PointSize = min(uSizeMax, uSizeScale / d);  // dots shrink with distance, capped when near
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
starfield.frustumCulled = false;
scene.add(starfield);

// --- Milky Way GLB Model + Solar System Marker ---
let milkyWayModel = null;
let beauGaDisc = null;   // BeauGa.png flat disc galaxy
let galacticCorePos = null;   // world-space position of the galactic centre (set on GLB load)
let galaxyVisualRadius = 0;   // half the galaxy's XZ extent in scene units

// Black hole galactic-core transition
let blackHoleModel      = null;
// The procedural BH + lensing composer are the heaviest GPU work at startup
// (shader compilation + render targets). They are built lazily on the first
// galaxy-scale frame instead of at boot — see ensureBH().
let bhBuilder           = null;  // assigned in the GLB callback; invoked by ensureBH()
let bhBuilt             = false;
let bhTransitionT       = 0;     // 0 = normal galaxy view, 1 = full black hole environment
let BH_CLOSE_DIST       = 0;     // camera-to-core distance at which transition reaches 100%
let BH_FAR_DIST         = 0;     // camera-to-core distance at which transition begins
let bhRendererSettings    = false;
let bhOrigToneMapping     = null;
let bhOrigExposure        = null;
let bhOrigOutputEncoding  = null;
let bhOrigClearColor      = null;
let bhPointLight          = null;
let bhPointLight2         = null;
let bhPointLight3         = null;
let bloomComposer         = null;
let finalComposer         = null;
let bhLensingUniforms     = null;
let bhEHRadius            = 0;   // event horizon sphere world-space radius (for dynamic lensing)
let sgrPanelShown         = false; // Sgr A* info panel currently replacing the Milky Way one
// The galactic view renders the BH at 2 schematic units in a 400-unit galaxy
// (0.5% of the galaxy radius). The model's intrinsic radius is 0.04·R, so the
// Milky Way view scales it by (2/400)/0.04 = 0.125 to get the same proportion.
const BH_MW_SCALE         = (2 / 400) / 0.04;
let bhDiskMaterials       = null; // materials of each stacked disk layer, for uTime animation
let galacticGlowSprite    = null; // bright white glow at the galactic core, visible at far zoom before BH detail kicks in
let mwStarMaterials       = null; // milkyWayModel's own (cloned) point materials + authored opacity/size, for the BH-zoom star fade
let galaxyPivot           = null; // pivot Group at galacticCorePos so milkyWayModel rotates wobble-free
const _galaxyAxis         = new THREE.Vector3(0, 1, 0); // reused Y-axis vector for galaxy spin rotateOnWorldAxis
const _bhScreenPos        = new THREE.Vector3();
let _bhSavedVisibility    = null;

// Solar System marker lives in world space at origin (the Sun's actual scene position)
const solarSystemMarker = new THREE.Group();
solarSystemMarker.visible = false;
scene.add(solarSystemMarker);

const ssDot = new THREE.Mesh(
  new THREE.SphereGeometry(800, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffff00 })
);
solarSystemMarker.add(ssDot);

(function() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = '#ffff00';
  ctx.font = 'bold 56px Arial';
  ctx.fillText('Solar System', 10, 85);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c),
    depthTest: false
  }));
  sp.scale.set(12000, 3000, 1);
  sp.position.set(0, 1500, 0);
  solarSystemMarker.add(sp);
})();

// Kepler-22 System marker — a Sun-like neighbour ~644 ly away in Cygnus. On the
// galaxy's scale that is right next to the Sun (only ~2.5% of the Sun→core
// distance), so this sits a short, scientifically-directed hop from the Solar
// System marker (distance exaggerated for visibility). Positioned under
// galaxyPivot once the GLB loads (see below).
const keplerSystemMarker = new THREE.Group();
keplerSystemMarker.visible = false;
keplerSystemMarker.userData = { name: "Kepler-22 System" };
scene.add(keplerSystemMarker);

const kepDot = new THREE.Mesh(
  new THREE.SphereGeometry(600, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff9d5c })
);
kepDot.userData = { name: "Kepler-22 System" };
keplerSystemMarker.add(kepDot);

(function() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 640, 128);
  ctx.fillStyle = '#ff9d5c';
  ctx.font = 'bold 52px Arial';
  ctx.fillText('Kepler-22 System', 10, 82);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c),
    depthTest: false
  }));
  sp.scale.set(15000, 3000, 1);
  sp.position.set(0, 1300, 0);
  keplerSystemMarker.add(sp);
})();

loadGLB('need_some_space.glb').then(function(gltf) {
  milkyWayModel = gltf.scene.clone();
  milkyWayModel.scale.set(50000, 50000, 50000);
  milkyWayModel.rotation.set(0, 0, 0);
  milkyWayModel.renderOrder = 1;
  scene.add(milkyWayModel);

  // The clone shares its materials with the cached GLB (the Andromeda room uses
  // the same asset), so give this instance its own copies before the BH zoom
  // starts fading them. Remember each material's authored opacity/point size so
  // the fade can restore them exactly on zoom-out.
  mwStarMaterials = [];
  milkyWayModel.traverse(function(o) {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const clones = mats.map(function(m) {
      const c = m.clone();
      c.transparent = true;
      mwStarMaterials.push({ mat: c, baseOpacity: c.opacity, baseSize: c.size });
      return c;
    });
    o.material = Array.isArray(o.material) ? clones : clones[0];
  });

  // Compute the actual bounding box of the loaded geometry and shift the model
  // so its visual centre sits exactly at world origin (0,0,0). This ensures:
  //   • the solar system (also at origin) is embedded inside the galaxy
  //   • OrbitControls orbiting around origin always rotates around the galaxy centre
  //   • the galaxy never appears offset or top-left on screen
  const box = new THREE.Box3().setFromObject(milkyWayModel);
  const center = box.getCenter(new THREE.Vector3());
  milkyWayModel.position.sub(center);

  // Place the solar system at 52% of the galaxy's visual radius from the galactic centre,
  // matching the Sun's real position in the Orion Arm (~26 000 ly from centre, ~52% outward).
  const size = box.getSize(new THREE.Vector3());
  const galaxyRadius = Math.max(size.x, size.z) / 2;
  milkyWayModel.position.x -= galaxyRadius * 0.52;
  // Sun sits ~50–80 ly above the galactic midplane — negligible at galaxy scale (~0.1%)
  milkyWayModel.position.y -= galaxyRadius * 0.001;

  // Store galactic centre world position and radius for the fly-to-galaxy button
  galacticCorePos = new THREE.Vector3(
    -(galaxyRadius * 0.52),
    -(galaxyRadius * 0.001),
    0
  );
  galaxyVisualRadius = galaxyRadius;

  // === Pivot Group at galacticCorePos so the GLB rotates wobble-free ===
  // The model's local origin sits at the bbox-centre offset (milkyWayModel.position
  // = -center) which means a direct milkyWayModel.rotation.y would orbit the
  // bbox centre AROUND the local origin. Wrapping in a Group whose origin IS
  // at galacticCorePos lets the rotation happen around the actual galaxy
  // centre instead.
  galaxyPivot = new THREE.Group();
  galaxyPivot.position.copy(galacticCorePos);
  scene.add(galaxyPivot);
  const _prevModelWorldPos = milkyWayModel.position.clone();
  scene.remove(milkyWayModel);
  galaxyPivot.add(milkyWayModel);
  milkyWayModel.position.copy(_prevModelWorldPos).sub(galacticCorePos);

  // Also parent the solar-system marker under galaxyPivot so its world
  // position orbits the galactic centre along with the disc spin —
  // the solar system visibly travels around the galaxy at Uranus's rate.
  // Marker was at world (0,0,0); make its pivot-relative position so that
  // its world position remains (0,0,0) initially, then it orbits as pivot rotates.
  const _ssWorldPos = new THREE.Vector3();
  solarSystemMarker.getWorldPosition(_ssWorldPos);
  if (solarSystemMarker.parent) solarSystemMarker.parent.remove(solarSystemMarker);
  galaxyPivot.add(solarSystemMarker);
  solarSystemMarker.position.copy(_ssWorldPos).sub(galacticCorePos);

  // Kepler-22 System sits next to the Sun in its true galactic direction
  // (longitude 79.09°, latitude +15.79° — toward Cygnus, near the direction of
  // galactic rotation and slightly above the disc). In this frame the galactic
  // centre lies along −X from the Sun and the rotation direction along −Z, so
  // dir = (−cos b·cos l, sin b, −cos b·sin l). True separation is ~1.3% of the
  // galaxy radius; exaggerated here to ~8% so the labelled dot is distinguishable.
  if (solarSystemMarker.parent) solarSystemMarker.parent.add(keplerSystemMarker);
  const _kl = 79.09 * Math.PI / 180, _kb = 15.79 * Math.PI / 180;
  const _kepDir = new THREE.Vector3(
    -Math.cos(_kb) * Math.cos(_kl),
     Math.sin(_kb),
    -Math.cos(_kb) * Math.sin(_kl)
  ).multiplyScalar(galaxyRadius * 0.08);
  keplerSystemMarker.position.copy(solarSystemMarker.position).add(_kepDir);

  // === Galactic-core white glow sprite ===
  // A bright luminous spot at the galactic centre, visible from far zoom
  // in the Milky Way view. As the camera approaches and the detailed BH
  // model fades in, this glow fades out so the BH render takes over.
  (function() {
    const _gc = document.createElement('canvas');
    _gc.width = _gc.height = 256;
    const _gx = _gc.getContext('2d');
    const _gd = _gx.createRadialGradient(128, 128, 0, 128, 128, 128);
    _gd.addColorStop(0.00, 'rgba(255, 252, 240, 1.00)');
    _gd.addColorStop(0.20, 'rgba(255, 240, 210, 0.95)');
    _gd.addColorStop(0.45, 'rgba(255, 210, 160, 0.75)');
    _gd.addColorStop(0.75, 'rgba(230, 160, 100, 0.40)');
    _gd.addColorStop(1.00, 'rgba(180, 90, 40, 0.00)');
    _gx.fillStyle = _gd;
    _gx.fillRect(0, 0, 256, 256);
    galacticGlowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(_gc),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false
    }));
    const _glowSize = galaxyRadius * 0.18;
    galacticGlowSprite.scale.set(_glowSize, _glowSize, 1);
    galacticGlowSprite.position.copy(galacticCorePos);
    galacticGlowSprite.renderOrder = 4; // above galaxy disc and model
    galacticGlowSprite.visible = false;
    scene.add(galacticGlowSprite);
  })();

  // Reveal the Milky Way navigation buttons now that the model is ready
  const mwBtn = document.getElementById('milkyWayBtn');
  if (mwBtn) mwBtn.style.display = 'block';
  const ogBtn = document.getElementById('otherGalaxiesBtn');
  if (ogBtn) ogBtn.style.display = 'block';
  const andBtn = document.getElementById('andromedaBtn');
  if (andBtn) andBtn.style.display = 'block';

  // --- galaxyDiamond1 fix1.png flat galaxy disc (4096×4096 square, no UV correction needed) ---
  const beauGaTex = new THREE.TextureLoader().load('galaxyDiamond1 fix1.png');
  const beauGaMat = new THREE.MeshBasicMaterial({
    map: beauGaTex,
    transparent: true,
    alphaTest: 0,
    blending: THREE.AdditiveBlending,
    // Dimmed (was 0xffffff) so the BH plasma ring at the centre punches
    // through the galaxy texture more clearly.
    color: 0x999999,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide
  });
  beauGaDisc = new THREE.Mesh(
    new THREE.CircleGeometry(galaxyRadius, 128),
    beauGaMat
  );
  beauGaDisc.rotation.x = -Math.PI / 2;
  beauGaDisc.position.copy(galacticCorePos);
  beauGaDisc.renderOrder = 0;
  scene.add(beauGaDisc);

  milkyWayModel.visible = false;
  beauGaDisc.visible = false;

  // Set black hole thresholds to the same proportions as the galactic view
  // (GAL_BH_FAR = 50, GAL_BH_CLOSE = 6 against its schematic galaxy radius of
  // 400): the reveal starts at 12.5% of the galaxy radius and completes at
  // 1.5% — deep inside the core, so the surrounding dust is far away and the
  // view matches the galactic-view BH zoom-in exactly.
  BH_CLOSE_DIST = galaxyVisualRadius * (GAL_BH_CLOSE / 400);
  BH_FAR_DIST   = galaxyVisualRadius * (GAL_BH_FAR / 400);

  // Procedural black hole — flat RingGeometry layers + Fresnel event horizon.
  // Deferred: defined here but built lazily on the first galaxy-scale frame
  // (ensureBH), keeping its shader compilation + EffectComposer off the boot path.
  bhBuilder = function buildProceduralBH() {
    var bhR = galaxyVisualRadius * 0.04;

    // DISK — filamentary cloud shader (see BH_DISK_FRAG): banding emerges from
    // anisotropic noise streaks rather than discrete fract() ring combs, so the
    // disk reads as turbulent flow instead of concentric rubber bands.

    var diskVert = BH_DISK_VERT;

    var diskFrag = BH_DISK_FRAG;

    var bhSpin = new THREE.Group();
    bhSpin.position.copy(galacticCorePos);
    bhSpin.visible = false;

    // === Stacked thin disks form 3D thickness ===
    // 7 RingGeometry layers at slight world-Y offsets. Edge-on viewing (camera
    // at or near the galactic plane) no longer collapses the disk to a single
    // line — the stack shows a Gaussian-profile thickness from any angle.
    // Each layer has its own ShaderMaterial sharing diskGeo (cheap), with a
    // uAlphaMul that dims outer layers so the cross-section looks volumetric.
    // Inner radius 0.05 bhR — the disk runs essentially to the centre, all
    // of it hidden under the drawn shadow (1.171 bhR). The hidden inner disk
    // is what the lensing warp SAMPLES for pixels around the sphere; its
    // displaced sample radius sweeps through ~0 near the shadow edge, so any
    // central hole paints a dark annulus around the sphere. uInnerR stays
    // 0.92 so the visible coloring is unchanged. Geometry outer is 14 bhR —
    // headroom for the tuner's discOuter slider; the VISIBLE outer edge is
    // the uOuterR uniform (default 10 bhR = 205M km).
    var diskGeo = new THREE.RingGeometry(bhR * 0.05, bhR * 14.0, 512, 1);
    bhDiskMaterials = [];
    var diskLayerCount   = 7;
    var diskLayerSpacing = bhR * 0.045;  // vertical gap between adjacent layers
    for (var di = 0; di < diskLayerCount; di++) {
      var slot = di - (diskLayerCount - 1) * 0.5;   // -3 .. 3
      var yOff = slot * diskLayerSpacing;
      var alphaMul = Math.exp(-Math.pow(slot / 2.2, 2.0)) * 0.42;
      var layerMat = new THREE.ShaderMaterial({
        uniforms: Object.assign({
          uInnerR:   { value: bhR * BH_TUNE.discInner },
          uOuterR:   { value: bhR * BH_TUNE.discOuter },
          uTime:     { value: 0.0 },
          uAlphaMul: { value: alphaMul },
          uLayerY:   { value: slot },
          uZoomOut:  { value: 0.0 }
        }, bhTuneDiskUniforms()),
        vertexShader:   diskVert,
        fragmentShader: diskFrag,
        transparent: true,
        depthWrite:  false,
        depthTest:   false,
        blending:    THREE.AdditiveBlending,
        side: THREE.DoubleSide
      });
      var layerMesh = new THREE.Mesh(diskGeo, layerMat);
      layerMesh.rotation.x = -Math.PI / 2;   // flat in world XZ plane
      layerMesh.position.y = yOff;
      layerMesh.renderOrder = 25;
      layerMesh.layers.set(0);
      bhSpin.add(layerMesh);
      bhDiskMaterials.push(layerMat);
    }
    bhTuneRegister('disks', { mats: bhDiskMaterials, bhR: bhR });

    // Soft orange glow — camera-facing sprite with radial gradient (sphere would be invisible
    // because the camera is always inside the glow radius in BH mode, culling all front faces)
    (function() {
      var _gc = document.createElement('canvas');
      _gc.width = _gc.height = 256;
      var _gx = _gc.getContext('2d');
      var _gr = _gx.createRadialGradient(128,128,0,128,128,128);
      _gr.addColorStop(0,    'rgba(255,120,10,0.25)');
      _gr.addColorStop(0.40, 'rgba(220,60,2,0.10)');
      _gr.addColorStop(0.70, 'rgba(160,25,0,0.03)');
      _gr.addColorStop(1.0,  'rgba(100,8,0,0)');
      _gx.fillStyle = _gr;
      _gx.fillRect(0, 0, 256, 256);
      var _gSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(_gc),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: false
      }));
      _gSprite.scale.set(bhR * BH_TUNE.glowSize, bhR * BH_TUNE.glowSize, 1);
      _gSprite.renderOrder = 15;
      bhSpin.add(_gSprite);
      bhTuneRegister('glows', { sprite: _gSprite, bhR: bhR });
    })();

    // Warm ambient light for the BH environment — parented to bhSpin so it
    // only illuminates while the BH is visible. Intensity is the tuner's
    // warmAmbient (default 0 = off).
    var _bhWarm = new THREE.AmbientLight(0xffb37a, BH_TUNE.warmAmbient);
    bhSpin.add(_bhWarm);
    bhTuneRegister('lights', _bhWarm);

    // Event horizon radius used for dynamic shadow calculation.
    // No sphere mesh: the lensing shader shadow mask IS the event horizon — eliminates
    // any frame-to-frame desync between a mesh position and the screen-space mask.
    // The lens shader draws black out to exactly this radius, so it is set
    // to Sgr A*'s true horizon proportion: (24 / 205) of the 10-bhR disc
    // = 1.171 bhR. A ruler on the screen matches the quoted numbers.
    bhEHRadius = bhR * 1.171;


    // finalComposer: full scene render + gravitational lensing only.
    // Bloom/UnrealBloomPass completely removed — it produced cross-spike artifacts
    // on compact annular sources (photon ring) regardless of strength setting.
    finalComposer = new THREE.EffectComposer(renderer);
    finalComposer.addPass(new THREE.RenderPass(scene, camera));

    // Gravitational lensing pass — uShadowR updated dynamically every frame
    var _lensUniforms = Object.assign({
      tDiffuse:  { value: null },
      uCenter:   { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: BH_TUNE.warpStrength },
      uInnerR:   { value: 0.03 },
      uOuterR:   { value: 0.12 },
      uShadowR:  { value: 0.06 },
      uAspect:   { value: window.innerWidth / window.innerHeight }
    }, bhTuneLensUniforms());
    bhLensingUniforms = _lensUniforms;
    bhTuneRegister('lenses', _lensUniforms);
    finalComposer.addPass(new THREE.ShaderPass(new THREE.ShaderMaterial({
      uniforms: _lensUniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: BH_LENS_FRAG
    })));

    scene.add(bhSpin);
    blackHoleModel = bhSpin;
  };

  console.log('Milky Way GLB loaded successfully');
}).catch(function(error) {
  console.error('GLB load error:', error);
});

// ── Black-hole tuner ────────────────────────────────────────────────────────
// Every visual constant of the black hole — size, photon ring, halo, warp,
// disc shading, lighting — lives in this one table so the on-screen
// "BH Tuner" panel can adjust it live with visible numbers. One table drives
// EVERY black hole in the app (galaxy view + True-Size room): each view
// registers its materials here and applyBHTune() pushes the values out.
// Radius-like values are stored in bhR units (1 bhR ≈ 20.5M km — the disc is
// 10 bhR = 205M km wide) because each view uses a different world scale.
// Values persist in localStorage under 'bhTune'.
export const BH_TUNE_DEFAULTS = {
  sphereScale:   1.00, // × true event-horizon radius (1.0 = exact 24M km)
  discOuter:     10.0, // visible disc outer radius, bhR units (10 = 205M km)
  discInner:     0.92, // disc inner colour anchor, bhR units
  glowSize:      7.0,  // orange glow sprite width, bhR units
  ringWidth:     0.04, // photon ring gaussian width, × shadow radius
  ringIntensity: 4.5,  // photon ring brightness
  haloWidth:     0.19, // warm halo gaussian width, × shadow radius
  haloIntensity: 1.26, // warm halo brightness
  warpStrength:  1.80, // gravitational background warp
  brightExp:     0.32, // disc alpha radial falloff exponent (lower = wider visible disc)
  brightPeak:    3.8,  // disc alpha peak at the inner edge
  heatExp:       1.15, // disc colour cooling exponent (lower = hotter outer disc)
  wispStart:     0.70, // where the ragged rim dissolve begins (fraction of disc)
  colorBoost:    2.5,  // disc emissive colour multiplier
  spinSpeed:     1.0,  // disc flow speed ×
  glowOpacity:   1.0,  // glow sprite opacity
  warmAmbient:   0.0,  // warm ambient light intensity in the BH environment
};
export const BH_TUNE = Object.assign({}, BH_TUNE_DEFAULTS, (function() {
  try { return JSON.parse(localStorage.getItem('bhTune') || '{}'); }
  catch (e) { return {}; }
})());

const bhTuneReg = { disks: [], lenses: [], glows: [], lights: [] };
export function bhTuneRegister(kind, item) {
  bhTuneReg[kind].push(item);
  applyBHTune();
}
export function applyBHTune() {
  const T = BH_TUNE;
  bhTuneReg.disks.forEach(d => d.mats.forEach(m => {
    const u = m.uniforms;
    u.uInnerR.value     = d.bhR * T.discInner;
    u.uOuterR.value     = d.bhR * T.discOuter;
    u.uBrightExp.value  = T.brightExp;
    u.uBrightPeak.value = T.brightPeak;
    u.uHeatExp.value    = T.heatExp;
    u.uWispStart.value  = T.wispStart;
    u.uColorBoost.value = T.colorBoost;
  }));
  bhTuneReg.lenses.forEach(u => {
    u.uStrength.value = T.warpStrength;
    u.uPRW.value      = T.ringWidth;
    u.uPRI.value      = T.ringIntensity;
    u.uHaloW.value    = T.haloWidth;
    u.uHaloI.value    = T.haloIntensity;
  });
  bhTuneReg.glows.forEach(g => {
    g.sprite.scale.set(g.bhR * T.glowSize, g.bhR * T.glowSize, 1);
    g.sprite.material.opacity = T.glowOpacity;
  });
  bhTuneReg.lights.forEach(l => { l.intensity = T.warmAmbient; });
}
// Fresh tuner-driven uniform entries for a new disc / lens material.
export function bhTuneDiskUniforms() {
  return {
    uBrightExp:  { value: BH_TUNE.brightExp },
    uBrightPeak: { value: BH_TUNE.brightPeak },
    uHeatExp:    { value: BH_TUNE.heatExp },
    uWispStart:  { value: BH_TUNE.wispStart },
    uColorBoost: { value: BH_TUNE.colorBoost },
  };
}
export function bhTuneLensUniforms() {
  return {
    uPRW:   { value: BH_TUNE.ringWidth },
    uPRI:   { value: BH_TUNE.ringIntensity },
    uHaloW: { value: BH_TUNE.haloWidth },
    uHaloI: { value: BH_TUNE.haloIntensity },
  };
}
// The tuner button only shows while a black hole is actually on screen.
// Two independent callers (world.js loop, True-Size room) OR their flags.
const _bhTunerAvail = { world: false, room: false };
export function setBHTunerAvailable(source, on) {
  if (_bhTunerAvail[source] === !!on) return;
  _bhTunerAvail[source] = !!on;
  const any = _bhTunerAvail.world || _bhTunerAvail.room;
  const btn = document.getElementById('bhTunerBtn');
  if (btn) btn.style.display = any ? 'block' : 'none';
  if (!any) {
    const panel = document.getElementById('bhTunerPanel');
    if (panel) panel.style.display = 'none';
  }
}

// Gravitational-lensing screen-space shader (shadow void + photon ring + warp)
// — exported for the True-Size room's Sagittarius A* composer.
export const BH_LENS_FRAG = [
  'uniform sampler2D tDiffuse;',
  'uniform vec2 uCenter;',
  'uniform float uStrength,uInnerR,uOuterR,uShadowR,uAspect,uPRW,uPRI,uHaloW,uHaloI;',
  'varying vec2 vUv;',
  'void main(){',
  '  vec2 d=(vUv-uCenter)*vec2(uAspect,1.0);',
  '  float dist=length(d);',
  // The black void is drawn at exactly uShadowR — callers pass the TRUE
  // event-horizon screen radius, so a screenshot ruler-check matches the
  // quoted numbers (Sgr A*: 24M-km horizon vs 205M-km disc ≈ 1:8.5).
  // (The old ×1.18 inflation made every BH sphere read ~20% too wide.)
  '  float shadowR = uShadowR;',
  '  if(dist < shadowR){ gl_FragColor=vec4(0.0,0.0,0.0,1.0); return; }',
  // Gravitational warp — smooth Gaussian, no hard threshold (eliminates
  // seam-line artifacts). The displaced samples land deep inside the disk's
  // centre, so the disk geometry extends well under the shadow (inner radius
  // 0.45 bhR) — otherwise the warp painted a thick dark annulus around the
  // sphere that read as a much bigger black ball than the quoted horizon.
  '  vec2 uv=vUv;',
  '  float warpMag=uStrength*uShadowR*exp(-pow((dist/uShadowR-1.0)*1.1,2.0));',
  '  vec2 dir=d/max(dist,0.001); dir.x/=uAspect;',
  '  uv-=dir*warpMag; uv=clamp(uv,0.001,0.999);',
  '  vec4 col=texture2D(tDiffuse,uv);',
  // Photon ring + warm halo at the shadow edge — widths and brightness are
  // tuner uniforms (BH_TUNE: ringWidth/ringIntensity/haloWidth/haloIntensity).
  '  float prD=(dist-shadowR)/(uShadowR*uPRW);',
  '  float prRing=exp(-prD*prD);',
  '  float haloD=(dist-shadowR)/(uShadowR*uHaloW);',
  '  float halo=exp(-haloD*haloD);',
  '  col.rgb+=vec3(1.0,0.78,0.35)*(prRing*uPRI+halo*uHaloI);',
  '  gl_FragColor=col;',
  '}'
].join('\n');

// Black-hole accretion-disk shaders — module scope + exported so the True-Size
// room's Sagittarius A* uses the exact same material as the galaxy-view BH.
export const BH_DISK_VERT = [
  // Pass raw disk-local position; radius/angle are computed per-fragment so
  // there is no atan() interpolation seam at the ±π triangle column.
  'varying vec2 vPos;',
  'void main(){',
  '  vPos = position.xy;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

export const BH_DISK_FRAG = [
  'uniform float uInnerR, uOuterR, uTime, uAlphaMul, uLayerY, uZoomOut;',
  'uniform float uBrightExp, uBrightPeak, uHeatExp, uWispStart, uColorBoost;',
  'varying vec2 vPos;',
  'float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
  // Value noise periodic in x (the lattice wraps every `per` cells). The x
  // coordinate is derived from the disk angle, so the pattern tiles
  // seamlessly around the full circle with no seam at the wrap angle.
  'float vnp(vec2 p, float per){',
  '  vec2 i = floor(p);',
  '  vec2 f = fract(p);',
  '  vec2 u = f*f*(3.0 - 2.0*f);',
  '  float x0 = mod(i.x, per), x1 = mod(i.x + 1.0, per);',
  '  return mix(mix(hash21(vec2(x0, i.y)),     hash21(vec2(x1, i.y)),     u.x),',
  '             mix(hash21(vec2(x0, i.y+1.0)), hash21(vec2(x1, i.y+1.0)), u.x), u.y);',
  '}',
  'void main(){',
  '  float r    = length(vPos);',
  '  float ang  = atan(vPos.y, vPos.x);',
  '  float t    = clamp((r - uInnerR) / (uOuterR - uInnerR), 0.0, 1.0);',
  '  float logR = log(max(r / max(uInnerR, 0.001), 1.001));',
  // === Filamentary streak field (replaces the old fract() ring combs) ===
  // The old approach built the disk from ~80 mathematically perfect
  // concentric hoops (fract(logR/spacing) combs) and sprinkled isotropic
  // grain on top — the hoops always read as rubber bands. Here the
  // banding EMERGES from anisotropic value noise instead: each octave is
  // sampled with a fine radial frequency but a coarse angular frequency,
  // so features are long thin arcs — turbulent filaments, not circles.
  //
  // Slow rigid rotation + a static spiral winding so the filaments trail
  // like sheared orbital flow. Adding logR*k only offsets the angular
  // lattice per radius, so the seamless wrap is preserved.
  '  float aSp = ang - uTime * 0.12 + logR * 1.8;',
  '  float xa  = aSp * 0.954929659;',   // aSp / 2π × 6 → 6 angular lattice cells
  // Low-frequency domain warp of the radial coordinate: bands wobble,
  // merge and split instead of being perfect circles.
  '  float warp = vnp(vec2(xa + 13.7, logR * 3.0), 6.0) - 0.5;',
  '  float wr   = logR + warp * 0.16;',
  // Four anisotropic octaves. Radial frequency grows ~2.7x per octave but
  // angular only 2x, so finer detail is progressively more streak-like.
  // At zoom-out the two finest octaves fade toward their mean (0.5) —
  // they would just shimmer at far distance; the disk smooths into cloud.
  '  float fineMul = 1.0 - 0.65 * uZoomOut;',
  '  float s1 = vnp(vec2(xa,       wr *   9.0       ),  6.0);',
  '  float s2 = vnp(vec2(xa * 2.0, wr *  26.0 +  7.0), 12.0);',
  '  float s3 = vnp(vec2(xa * 4.0, wr *  72.0 +  3.0), 24.0);',
  '  float s4 = vnp(vec2(xa * 8.0, wr * 190.0 + 11.0), 48.0);',
  '  float streak = 0.34*s1 + 0.26*s2 + 0.23*mix(0.5, s3, fineMul) + 0.17*mix(0.5, s4, fineMul);',
  // Large soft cloud patches — low-frequency brightness variation along
  // the flow, like the bright/dim regions of the reference disk.
  '  float c1    = vnp(vec2(xa * 0.5 + 5.2, logR * 1.6), 3.0);',
  '  float cloud = 0.45 + 1.10 * c1;',
  // Shape the streak field into a CONTINUOUS cloud with organic dark
  // lanes — a density floor keeps the disk filled (no black gaps between
  // discrete rings), while the smoothstep gives the lanes contrast.
  '  float lay     = smoothstep(0.20, 0.86, streak);',
  '  float density = 0.24 + 0.76 * lay;',
  // Outer edge dissolves into wisps: progressively only the bright
  // filaments survive, so the rim is ragged rather than a hard circle.
  // Start point is the tuner's wispStart (default 0.70).
  '  float wispZone = smoothstep(uWispStart, 1.00, t);',
  '  density = mix(density, density * lay, wispZone * 0.65);',
  // Zoom-out: lift the floor so the far-away disk reads as smooth glow.
  '  density = mix(density, max(density, 0.35), uZoomOut * 0.6);',
  '  float effMask = density * cloud;',
  // === Blackbody colour — driven by HEAT, not radius zones ===
  // The old piecewise-by-radius gradient (red inner -> rose -> lavender
  // outer) read as concentric flag stripes. Real accretion-disk renders
  // colour by temperature: white-yellow only at the hottest inner rim and
  // the brightest filaments, through orange and saturated red, down to
  // deep ember red in the outer disk and the dark lanes. No purple.
  // heat = radial cooling x filament brightness (+ white-hot inner rim),
  // so colour tracks the SAME turbulence that drives opacity — bright
  // streaks glow hotter, dark lanes cool to ember, at every radius.
  '  float innerDist = max(0.0, r - uInnerR);',
  '  float sigma     = uInnerR * 0.14;',
  '  float pr        = exp(-(innerDist*innerDist) / (2.0*sigma*sigma));',
  // Radial cooling exponent from the tuner (default 1.15 — lower keeps the
  // outer disc a readable red-orange, higher cools it to ember sooner).
  '  float heat = pow(max(1.0 - t, 0.0), uHeatExp);',
  '  heat *= 0.30 + 0.85 * lay;',
  '  heat *= 0.78 + 0.34 * c1;',
  '  heat += 0.45 * pr;',
  '  heat = clamp(heat, 0.0, 1.0);',
  // Ember-red -> red-orange -> orange -> yellow -> cream-white ramp.
  // Yellow starts mid-ramp so the inner half of the disk and the bright
  // filaments show clear yellow-cream swaths (TON 618-style renders), but
  // the stops stay red-leaning: the 5 additive layers clip the red channel
  // first, which would drift a greener yellow toward acid tones.
  // Transition bands overlap so no hue boundary is crisp: the yellow zone
  // feathers into orange along the streaks instead of forming a hard ring.
  '  vec3 col = mix(vec3(0.35,0.03,0.00), vec3(0.90,0.12,0.01), smoothstep(0.00, 0.42, heat));',
  '  col = mix(col, vec3(1.00,0.38,0.04), smoothstep(0.42, 0.75, heat));',
  '  col = mix(col, vec3(1.00,0.70,0.20), smoothstep(0.70, 0.92, heat));',
  '  col = mix(col, vec3(1.00,0.93,0.75), smoothstep(0.90, 1.00, heat));',
  // Strong over-brightness boost so the additive disk contribution
  // dominates the galaxy texture behind it. With colour > 1.0 each
  // disk pixel writes more luminance than the BeauGa galaxy can.
  // Tuner: colorBoost (default 2.5).
  '  col *= uColorBoost;',
  // === Alpha — radial falloff x density mask ===
  // The continuous cloud has a much higher mean coverage than the old
  // sparse ring combs, so a 0.30 scale keeps the 5 additively stacked
  // layers from clipping into a flat orange mass (tuned via screenshots).
  // Radial alpha falloff from the tuner (defaults 0.32 / 3.8): the low
  // exponent keeps alpha strong almost to the geometric rim so the disc's
  // VISIBLE edge is its true 205M-km width (~8.5x the event horizon).
  // The wisp zone above supplies the ragged dissolve right at the rim.
  '  float bright = pow(max(1.0-t, 0.0), uBrightExp) * uBrightPeak;',
  '  float alpha  = clamp(effMask * bright * 0.36, 0.0, 1.0);',
  '  alpha = min(alpha, 0.95);',
  '  alpha *= uAlphaMul;',
  '  gl_FragColor = vec4(col, alpha);',
  '}'
].join('\n');

// Build the procedural black hole + lensing composer the first time we reach
// galaxy scale (deferred from boot to cut startup GPU/shader-compile cost).
// Idempotent; a no-op until the GLB callback has assigned bhBuilder.
function ensureBH() {
  if (bhBuilt || !bhBuilder) return;
  bhBuilt = true;
  console.log('ensureBH: building black hole + lensing composer (deferred from boot)');
  bhBuilder();
}

// SUN CORE — true radius 696,340 km = 0.04655 units (keep emissive low so shading is visible)
const SUN_TRUE_RADIUS = 696340 / 14959787.07;
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(SUN_TRUE_RADIUS, 64, 64),
  new THREE.MeshBasicMaterial({
    map: sunTexture
  })
);
scene.add(sun);

// 👇 ADD THIS BLOCK HERE
sun.userData = {
  name: "Sun",
  info: SUN_INFO,
  trueRadius: SUN_TRUE_RADIUS
};

// 👇 ADD THIS LINE HERE
sun.castShadow = true;

// ── TEMP: size-comparison Earth beside the Sun (user-requested, remove later) ──
// A true-size Earth (daymap only, no clouds) parked just off the Sun's limb so the
// ~109x radius ratio is visible by eye. Unlit MeshBasicMaterial so the texture
// always shows, and deliberately NOT added to the min-dot scaler so it stays at
// true scale (zoom in to the Sun to see how tiny Earth is next to it).
const TEMP_EARTH_TRUE_RADIUS = 6371 / 14959787.07;
const tempCompareEarth = new THREE.Mesh(
  new THREE.SphereGeometry(TEMP_EARTH_TRUE_RADIUS, 48, 48),
  new THREE.MeshBasicMaterial({ map: earthTexture })
);
tempCompareEarth.position.set(SUN_TRUE_RADIUS * 1.05, 0, 0);
tempCompareEarth.visible = false; // off by default; toggled from the Sun's info panel
scene.add(tempCompareEarth);

// Same idea for Jupiter — the largest planet (~10x Earth radius, but still ~1/10
// the Sun's radius). Parked just off the Sun's limb at true scale so the size gap
// reads by eye; toggled from the Sun's info panel, off by default.
const TEMP_JUPITER_TRUE_RADIUS = 69911 / 14959787.07;
const tempCompareJupiter = new THREE.Mesh(
  new THREE.SphereGeometry(TEMP_JUPITER_TRUE_RADIUS, 48, 48),
  new THREE.MeshBasicMaterial({ map: jupiterTexture })
);
// Offset slightly in z from the comparison Earth so, if both are toggled on, the
// tiny Earth sits beside Jupiter rather than buried inside it.
tempCompareJupiter.position.set(SUN_TRUE_RADIUS * 1.05, 0, TEMP_JUPITER_TRUE_RADIUS * 2.5);
tempCompareJupiter.visible = false;
scene.add(tempCompareJupiter);


// SUN GLOW — light-orb sprite (matches the galactic-core glow style)
// Camera-facing canvas sprite with a soft radial gradient, so the Sun reads
// as a luminous orb at every viewing angle/zoom instead of a flat shaded sphere.
const glowMesh = (function() {
  const _gc = document.createElement('canvas');
  _gc.width = _gc.height = 256;
  const _gx = _gc.getContext('2d');
  // Filled bloom (NASA-Eyes style): brightest at the centre, alpha decreasing
  // monotonically to fully transparent at the rim — a solid glowing point of
  // light, never a hollow ring. The falloff is broad (still bright across the
  // inner half) so when zoomed in it covers the whole disc and its halo extends
  // past the edge to surround the Sun, rather than collapsing to a centre dot.
  const _gd = _gx.createRadialGradient(128, 128, 0, 128, 128, 128);
  _gd.addColorStop(0.00, 'rgba(255, 250, 238, 0.50)');
  _gd.addColorStop(0.16, 'rgba(255, 244, 212, 0.42)');
  _gd.addColorStop(0.32, 'rgba(255, 228, 170, 0.30)');
  _gd.addColorStop(0.48, 'rgba(255, 198, 122, 0.185)');
  _gd.addColorStop(0.64, 'rgba(252, 158,  85, 0.090)');
  _gd.addColorStop(0.80, 'rgba(225, 115,  55, 0.033)');
  _gd.addColorStop(1.00, 'rgba(185,  88,  42, 0.000)');
  _gx.fillStyle = _gd;
  _gx.fillRect(0, 0, 256, 256);
  const _sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(_gc),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
    // depthTest stays ON so objects between the camera and the Sun (e.g. a
    // planet transiting in front) correctly occlude the glow. The Sun's own
    // front face would otherwise hide it too — updateSunGlow() avoids that by
    // parking this sprite just in front of the Sun's near surface each frame.
  }));
  // Sun core diameter is 4 (radius 2); glow sits as a thin halo at 1.5× → 6.
  _sprite.scale.set(6, 6, 1);
  _sprite.renderOrder = 4;
  scene.add(_sprite);
  return _sprite;
})();

// 🪐 PLANET DATA (FULL + RICH INFO)


const meshes = [];
let saturnRingShadow = null;   // ring-shadow uniforms, populated when Saturn's material is built

data.forEach(p=>{
  
  let material;

  if (p.name === "Jupiter") {
    // Tinted below white so the bright sun-facing side doesn't clip to white under
    // the 1.5-intensity sunlight — keeps the band detail visible on the lit hemisphere.
    material = new THREE.MeshStandardMaterial({
      map: jupiterTexture,
      color: 0xb0b0b0
    });
  } else if (p.name === "Saturn") {
    material = new THREE.MeshStandardMaterial({
      map: saturnTexture,
      color: 0xb0b0b0
    });
    // 🪐 Ring shadow on the planet. The rings are a solid sheet, so on Saturn's lit side
    // they cast a real, TEXTURED shadow: for each surface fragment we trace the ray toward
    // the Sun, and if it pierces the ring plane within the ring's radial span we darken the
    // fragment by the ring's OPACITY at that radius — sampled from the very same alpha strip
    // the rings are drawn with. So the shadow carries the real banding (the Cassini Division
    // shows up as a bright gap in the shadow), not a flat grey blob. Wired via onBeforeCompile
    // so we keep MeshStandardMaterial's lighting; uniforms are refreshed each frame in animate.
    // Values below were dialed in with the live editor: a 25° ring-plane tilt, a band from
    // 0.98R to 1.94R (centre 1.46R, width 0.96R), darkening direct light by 0.80.
    saturnRingShadow = {
      uRingMap:        { value: ringTexture },
      uSaturnCenter:   { value: new THREE.Vector3() },
      uRingNormal:     { value: new THREE.Vector3(Math.sin(25 * Math.PI / 180),
                                                  -Math.cos(25 * Math.PI / 180), 0) },
      uSaturnRadius:   { value: 1 },
      uShadowStrength: { value: 0.80 },   // fraction of DIRECT sunlight the dense rings block
      uShadowInner:    { value: 0.98 },   // band inner edge (Saturn radii)
      uShadowOuter:    { value: 1.94 }    // band outer edge (Saturn radii)
    };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, saturnRingShadow);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
                 '#include <common>\nvarying vec3 vRingShadowWorld;')
        .replace('#include <project_vertex>',
                 '#include <project_vertex>\n  vRingShadowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\n' +
          'varying vec3 vRingShadowWorld;\n' +
          'uniform sampler2D uRingMap;\n' +
          'uniform vec3 uSaturnCenter;\n' +
          'uniform vec3 uRingNormal;\n' +
          'uniform float uSaturnRadius;\n' +
          'uniform float uShadowStrength;\n' +
          'uniform float uShadowInner;\n' +
          'uniform float uShadowOuter;')
        // Compute the ring occlusion for this fragment (0 = open sky, 1 = behind a dense ring).
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n' +
          'float gRingShadow = 0.0;\n' +
          '{\n' +
          '  vec3 toSun = normalize(-vRingShadowWorld);          // Sun sits at the world origin\n' +
          '  vec3 p = vRingShadowWorld - uSaturnCenter;          // fragment, Saturn-centred\n' +
          '  vec3 n = normalize(uRingNormal);\n' +
          '  float denom = dot(toSun, n);\n' +
          '  if (abs(denom) > 1e-5) {\n' +
          '    float a = -dot(p, n) / denom;                     // distance to the ring plane along the Sun ray\n' +
          '    if (a > 0.0) {                                    // ring lies between this fragment and the Sun\n' +
          '      vec3 q = p + a * toSun;                         // pierce point, in the ring plane\n' +
          '      float rr = length(q) / uSaturnRadius;           // radius in Saturn-radii\n' +
          '      float t = (rr - uShadowInner) / max(1e-3, uShadowOuter - uShadowInner);  // band inner→outer = 0→1\n' +
          '      if (t >= 0.0 && t <= 1.0) {\n' +
          '        // Contrast curve: concentrate the shadow on the DENSE rings (the bright B\n' +
          '        // ring dominates the real ring shadow), so the band stays narrow; the faint\n' +
          '        // C ring and the Cassini Division read as clean bright breaks.\n' +
          '        gRingShadow = smoothstep(0.30, 0.92, texture2D(uRingMap, vec2(t, 0.5)).a);\n' +
          '      }\n' +
          '    }\n' +
          '  }\n' +
          '}')
        // Apply it to DIRECT sunlight only. The surface keeps its ambient/indirect light, so a
        // fully shadowed point drops to the night-side level — never darker than the dark side —
        // and it fades out smoothly through the terminator, where direct light already vanishes.
        .replace('#include <lights_fragment_end>',
          '#include <lights_fragment_end>\n' +
          'float ringShade = 1.0 - gRingShadow * uShadowStrength;\n' +
          'reflectedLight.directDiffuse  *= ringShade;\n' +
          'reflectedLight.directSpecular *= ringShade;');
    };
  } else if (p.name === "Uranus") {
    material = new THREE.MeshStandardMaterial({
      map: uranusTexture
    });
  } else if (p.name === "Neptune") {
    material = new THREE.MeshStandardMaterial({
      map: neptuneTexture
    });
  } else if (p.name === "Mars") {
    material = new THREE.MeshStandardMaterial({
      map: marsTexture
    });
  } else if (p.name === "Mercury") {
    material = new THREE.MeshStandardMaterial({
      map: mercuryTexture
    });
  } else if (p.name === "Venus") {
    material = new THREE.MeshStandardMaterial({
      map: venusTexture
    });
  } else if (p.name === "Earth") {
    material = new THREE.ShaderMaterial({
      uniforms: {
        dayTexture: { value: earthTexture },
        nightTexture: { value: earthNightTexture },
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
        uniform sampler2D dayTexture;
        uniform sampler2D nightTexture;
        uniform vec3 sunDirection;
        varying vec2 vUv;
        varying vec3 vNormal;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          float intensity = dot(vNormal, sunDirection);
          float blend = smoothstep(-0.1, 0.1, intensity);
          vec4 day = texture2D(dayTexture, vUv);
          vec4 night = texture2D(nightTexture, vUv);
          gl_FragColor = mix(night, day, blend);
        }
      `
    });
  } else if (p.kind === "dwarf" && p.texture) {
    material = new THREE.MeshStandardMaterial({ map: textureLoader.load(p.texture) });
  } else {
    material = new THREE.MeshStandardMaterial({
      color: p.color
    });
  }

  const geo = new THREE.SphereGeometry(p.size,32,32);
  // Non-spherical dwarfs (Haumea triaxial, Ceres oblate): bake the shape into the
  // geometry, NOT mesh.scale — the min-dot scaler calls mesh.scale.setScalar() every
  // frame and would otherwise wipe a non-uniform scale.
  if (p.ellipsoid) geo.scale(p.ellipsoid[0], p.ellipsoid[1], p.ellipsoid[2]);
  const m = new THREE.Mesh(geo, material);

  // userData.angle is the MEAN anomaly (Keplerian motion); random start as before.
  m.userData = {...p, angle:Math.random()*Math.PI*2};
  scene.add(m);
  meshes.push(m);
});

const earth = meshes.find(m => m.userData.name === "Earth");
const jupiter = meshes.find(m => m.userData.name === "Jupiter");

const marsMesh = meshes.find(m => m.userData.name === "Mars");
const marsOriginalMaterial = marsMesh.material;
const marsOriginalInfo = marsMesh.userData.info;

let marsTransformed = false;
let terraformedMarsModel = null;
let marsCloudMesh = null;
let terraformedMarsMaterial = null;

// Cloud layer — sized to Earth's true surface radius (it's a child of earth, so it
// inherits earth's min-dot scale and stays the same shell thickness at any zoom).
// The geometry sits at the surface; cloudMesh.scale lifts it to a fixed 0.5% altitude.
//
// The clouds are a sun-lit shader with NORMAL alpha blending (not additive): on the day
// side dense cloud reads as a solid white mass, thin cloud as soft white, clear sky shows
// the surface; across the terminator the clouds darken and fade so the night side is clear
// (matching NASA's Eyes). The grayscale cloud texture's value drives both colour and alpha.
// sunDirection is the world Earth→Sun vector, updated each frame next to the Earth shader.
const cloudTexture = textureLoader.load("2k_earth_clouds.jpg");
const cloudMesh = new THREE.Mesh(
  new THREE.SphereGeometry(earth.userData.size, 32, 32),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      cloudTexture: { value: cloudTexture },
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
        float cloud = texture2D(cloudTexture, vUv).r;        // grayscale cloud amount
        float intensity = dot(normalize(vNormal), sunDirection);
        float lit = smoothstep(-0.2, 0.3, intensity);        // wide, soft day↔night transition
        float brightness = mix(0.25, 1.0, lit);              // raised night floor so dark-side clouds stay visible
        gl_FragColor = vec4(vec3(brightness), cloud);        // clouds stay everywhere, just darker at night
      }
    `
  })
);
cloudMesh.scale.setScalar(1.005);   // 0.5% above the surface
earth.add(cloudMesh);

// Earth atmosphere (cloud layer) and glow ring on/off — each driven by its own button in
// Earth's info panel, controlled independently (clouds vs. the white fresnel limb glow).
function syncEarthAtmoBtn() {
  const btn = document.getElementById("earthAtmoToggleBtn");
  if (btn) btn.textContent = cloudMesh.visible ? "Hide Atmosphere" : "Show Atmosphere";
}
function toggleEarthAtmosphere() {
  cloudMesh.visible = !cloudMesh.visible;
  syncEarthAtmoBtn();
}
window.toggleEarthAtmosphere = toggleEarthAtmosphere;

function syncEarthGlowBtn() {
  const btn = document.getElementById("earthGlowToggleBtn");
  if (btn) btn.textContent = (earthAtmoShell && earthAtmoShell.visible) ? "Hide Glow" : "Show Glow";
}
function toggleEarthGlow() {
  if (earthAtmoShell) earthAtmoShell.visible = !earthAtmoShell.visible;
  syncEarthGlowBtn();
}
window.toggleEarthGlow = toggleEarthGlow;

// Moon orbit group
const moonGroup = new THREE.Object3D();
moonGroup.rotation.x = 5.1 * (Math.PI / 180);
scene.add(moonGroup);

// Moon mesh — true radius 1,737 km; orbits Earth at 384,400 km (0.0257 units)
const MOON_TRUE_RADIUS = 1737 / 14959787.07;
const MOON_ORBIT_DIST  = 384400 / 14959787.07;
const moon = new THREE.Mesh(
  new THREE.SphereGeometry(MOON_TRUE_RADIUS, 32, 32),
  new THREE.MeshStandardMaterial({ map: moonTexture })
);
moon.position.set(MOON_ORBIT_DIST, 0, 0);
moon.userData.trueRadius = MOON_TRUE_RADIUS;
moonGroup.add(moon);

// ── Mercury's relativistic perihelion precession (Einstein) ──────────────────
// Mercury orbits on its real ellipse (e=0.2056, Sun at the focus); the long axis
// slowly rotates — 43″ per century in reality, the famous general-relativity test.
// A button in Mercury's panel swaps its orbit ring for an accumulating trail so
// the precession "rosette" stacks up over time; a demo-speed factor exaggerates
// the (otherwise invisibly slow) rate while still based on the real 43″/century.
const MERCURY_ECC = 0.2056;        // Mercury's true eccentricity (used everywhere)
const MERCURY_PRECESS_ARCSEC_PER_CENTURY = 43;
const MERC_ARCSEC_TO_RAD = Math.PI / (180 * 3600);
const MERC_CENTURY_MS = 100 * 365.25 * 86400 * 1000;
const MERC_PERIOD_YEARS = 0.2408; // Mercury's orbital period
// Real precession per orbit (radians) at the true 43″/century rate.
const MERC_PRECESS_PER_ORBIT_RAD =
  MERCURY_PRECESS_ARCSEC_PER_CENTURY * MERC_ARCSEC_TO_RAD * (MERC_PERIOD_YEARS / 100);
// Real years one radian of precession represents — for the honest elapsed-time
// readout (one full rosette ≈ 3 million years, exactly as in reality).
const MERC_YEARS_PER_RAD = 100 / (MERCURY_PRECESS_ARCSEC_PER_CENTURY * MERC_ARCSEC_TO_RAD);
// While the trail demo is on, Mercury orbits at this fixed gentle rate, INDEPENDENT
// of the simulation clock — so the demo runs without touching the normal sim time.
// (~0.29 orbits/sec — a calm pace, not the blur it was at before.)
const MERC_DEMO_ORBIT_SPEED = 0.03;
let mercuryPerihelion = 0;   // accumulated argument of perihelion (radians)
let mercuryDOmega     = 0;   // precession added this frame (for smooth trail sampling)
let mercuryTrailMode  = false;
let mercuryTrailPaused = false; // freeze Mercury's orbit, precession and elapsed time
let mercuryPrevM     = 0;
// Precession fast-forward: 1× = the real 43″/century (an imperceptible drift),
// higher exaggerates it so the rosette is visible. The sim clock is unaffected.
let mercuryDemoMult   = 1;

// ── Orbital mechanics: elements → position (Sun at the focus) ──────────────────
// Convention: ecliptic plane = XZ, ecliptic north = +Y. i/Om/w come from the data in
// DEGREES; nu (true anomaly) in radians. Degenerates to the old flat circle when
// e=i=Om=0. `a` is the semi-major axis in scene units (the body's `dist`).
const _DEG = Math.PI / 180;
export function orbitalToXYZ(a, e, iDeg, OmDeg, wDeg, nu, out) {
  const i = iDeg * _DEG, Om = OmDeg * _DEG, w = wDeg * _DEG;
  const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
  const u = w + nu;                       // argument of latitude
  const cu = Math.cos(u), su = Math.sin(u);
  const cO = Math.cos(Om), sO = Math.sin(Om), ci = Math.cos(i), si = Math.sin(i);
  out.x = r * (cO * cu - sO * su * ci);
  out.z = r * (sO * cu + cO * su * ci);
  out.y = r * (su * si);
  return out;
}
// Mean anomaly → true anomaly (Kepler's equation, Newton's method). This gives the
// real variable speed: fast at perihelion, slow at aphelion.
function nuFromMean(M, e) {
  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = M;
  for (let k = 0; k < 5; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2),
                        Math.sqrt(1 - e) * Math.cos(E / 2));
}

// Points tracing a body's orbit ring from its elements (inclined ellipse, Sun at the
// focus). Mercury additionally folds in its precessing perihelion so the ring rotates
// with the demo. Reused both at build time and when rebuilding Mercury's ring.
function buildOrbitPoints(m, segs) {
  const dist = m.userData.dist, el = m.userData;
  const isMercury = m.userData.name === "Mercury";
  const pts = [];
  for (let k = 0; k <= segs; k++) {
    const nu = (k / segs) * Math.PI * 2;
    const p = new THREE.Vector3();
    if (el.e !== undefined) {
      const wEff = isMercury ? (el.w + mercuryPerihelion / _DEG) : el.w;
      orbitalToXYZ(dist, el.e, el.i, el.Om, wEff, nu, p);
    } else {
      p.set(Math.cos(nu) * dist, 0, Math.sin(nu) * dist);
    }
    pts.push(p);
  }
  return pts;
}

// 🪐 ORBIT LINES
// Per-planet orbit-ring tints — each orbit coloured to match that body's real
// appearance (Mars reddish, Neptune deep blue, Saturn pale gold, etc.). Anything
// not listed falls back to white. Edit a value here to recolour that orbit.
export const ORBIT_COLORS = {
  Mercury:  0xa9a29b,  // grey
  Venus:    0xe6c98f,  // warm cream-yellow
  Earth:    0x4a90d9,  // blue
  Mars:     0xd95b3a,  // rusty red-orange
  Ceres:    0x9a9088,  // dark asteroid grey
  Jupiter:  0xd9a878,  // banded tan-orange
  Saturn:   0xe6d6a0,  // pale gold
  Uranus:   0x9fe3e8,  // pale cyan
  Neptune:  0x4c63d4,  // deep blue
  Pluto:    0xc9b49a,  // tan-grey
  Haumea:   0xdcdce4,  // icy off-white
  Makemake: 0xc88f6a,  // reddish-brown
  Eris:     0xcfd2d6,  // bright icy grey
};

const orbitLines = [];
const dwarfOrbitLines = [];   // far dwarf orbits — re-expressed camera-relative each frame (see animate)
meshes.forEach(m => {
  // Segment count is chosen per orbit so the polygon's chord stays within ~0.1×
  // the planet's (true-scale, tiny) radius of the real circle — otherwise the
  // chord-vs-arc gap (which grows with orbit radius) leaves big outer planets
  // visibly floating off their ring. sagitta ≈ dist·π²/(2N²) ≤ 0.1·radius.
  // The cap is high (32768) because the tiny, far dwarf planets (Pluto…Eris) need
  // ~15k–23k segments to keep that gap below their minuscule radius.
  const dist = m.userData.dist;
  const targetSagitta = (m.userData.size || 0.001) * 0.1;
  const segs = Math.min(32768, Math.max(256,
    Math.ceil(Math.PI * Math.sqrt(dist / (2 * targetSagitta)))));
  // Every body's ring is now its real inclined ellipse (Sun at the focus) from its
  // orbital elements; Mercury's also carries its precessing perihelion.
  m.userData._segs = segs;
  const points = buildOrbitPoints(m, segs);
  const orbit = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: ORBIT_COLORS[m.userData.name] || 0xffffff,
      transparent: true, opacity: 0.3
    })
  );
  orbit.userData.ownerMesh = m;   // hide this ring when zoomed in close to its planet
  scene.add(orbit);
  orbitLines.push(orbit);

  // Dwarf orbits sit 28–680 units from the origin, where float32 vertex precision
  // (~3–6e-5) is comparable to these tiny bodies' radii — so the static world-space
  // line jitters against the float64-positioned planet as the camera moves (the
  // "shake on zoom"). Keep the exact double-precision world points; animate() then
  // re-expresses the line in camera-relative coordinates each frame (small numbers
  // near the camera → crisp), which is exactly why the moon orbits stay stable.
  if (m.userData.kind === "dwarf") {
    const wp = new Float64Array(points.length * 3);
    for (let k = 0; k < points.length; k++) {
      wp[k * 3] = points[k].x; wp[k * 3 + 1] = points[k].y; wp[k * 3 + 2] = points[k].z;
    }
    orbit.userData._dwarfWorld = wp;
    orbit.frustumCulled = false;  // local verts become camera-relative; stale bounds would mis-cull
    dwarfOrbitLines.push(orbit);
  }
});

// Mercury precession trail — an accumulating polyline of Mercury's actual path,
// hidden until toggled on from its info panel. Sampled sub-frame so it stays
// smooth at any speed; it never fades, so the precession rosette builds up.
const mercuryMesh = meshes.find(m => m.userData.name === "Mercury");
let mercuryOrbitLine = orbitLines.find(o => o.userData.ownerMesh === mercuryMesh) || null;
const MERCURY_TRAIL_MAX = 200000;
const mercuryTrailPositions = new Float32Array(MERCURY_TRAIL_MAX * 3);
let mercuryTrailCount = 0;
const mercuryTrailGeom = new THREE.BufferGeometry();
mercuryTrailGeom.setAttribute('position', new THREE.BufferAttribute(mercuryTrailPositions, 3));
mercuryTrailGeom.setDrawRange(0, 0);
const mercuryTrail = new THREE.Line(
  mercuryTrailGeom,
  new THREE.LineBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0.6 })
);
mercuryTrail.frustumCulled = false; // grows unbounded; never cull it
mercuryTrail.visible = false;
scene.add(mercuryTrail);

// Append Mercury's path from the previous MEAN anomaly to the current one,
// interpolating both the anomaly and the precession so the line is smooth even when
// many degrees pass per frame. Mean anomaly is monotonic (no 2π wrap), and each
// sub-step solves Kepler + the full inclined transform → a real 3D inclined rosette.
function appendMercuryTrail(curM) {
  const el = mercuryMesh.userData, e = MERCURY_ECC, a = el.dist;
  const dM = curM - mercuryPrevM;
  const omegaStart = mercuryPerihelion - mercuryDOmega;
  const steps = Math.min(1000, Math.max(1, Math.ceil(Math.abs(dM) / 0.1)));
  const _tp = new THREE.Vector3();
  for (let s = 1; s <= steps && mercuryTrailCount < MERCURY_TRAIL_MAX; s++) {
    const f = s / steps;
    const M = mercuryPrevM + dM * f;
    const nu = nuFromMean(M, e);
    const om = omegaStart + mercuryDOmega * f;        // precession (radians) at this sub-step
    orbitalToXYZ(a, e, el.i, el.Om, el.w + om / _DEG, nu, _tp);
    const i3 = mercuryTrailCount * 3;
    mercuryTrailPositions[i3]     = _tp.x;
    mercuryTrailPositions[i3 + 1] = _tp.y;
    mercuryTrailPositions[i3 + 2] = _tp.z;
    mercuryTrailCount++;
  }
  mercuryTrailGeom.setDrawRange(0, mercuryTrailCount);
  mercuryTrailGeom.attributes.position.needsUpdate = true;
}

// 🌕 Moon orbit line
const moonOrbitPoints = [];
for (let i = 0; i <= 128; i++) {
  const angle = (i / 128) * Math.PI * 2;
  moonOrbitPoints.push(new THREE.Vector3(Math.cos(angle) * MOON_ORBIT_DIST, 0, Math.sin(angle) * MOON_ORBIT_DIST));
}
const moonOrbitLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(moonOrbitPoints),
  new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Earth, transparent: true, opacity: 0.3 })
);
moonOrbitLine.userData.ownerMesh = earth;   // hide the Moon's ring when zoomed in close to Earth
moonOrbitLine.userData.moonMesh = moon;     // ...or when zoomed in close to the Moon itself
moonGroup.add(moonOrbitLine);
orbitLines.push(moonOrbitLine);

// 🪐 Jupiter moon orbit lines
const jupiterMoonOrbitLines = [];
[0.028189, 0.044856, 0.071553, 0.125851].forEach(dist => {
  const pts = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * dist, 0, Math.sin(a) * dist));
  }
  const orbitLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Jupiter, transparent: true, opacity: 0.3 })
  );
  orbitLine.userData.ownerMesh = jupiter;   // hide these rings when zoomed in close to Jupiter
  scene.add(orbitLine);
  orbitLines.push(orbitLine);
  jupiterMoonOrbitLines.push(orbitLine);
});

let orbitsVisible = true;
document.getElementById("toggleOrbits").addEventListener("click", () => {
  // In the Kepler-22 system view this button toggles that system's orbit ring
  if (viewManager.activeName === 'kepler') { viewManager.active.toggleOrbits(); return; }
  orbitsVisible = !orbitsVisible;
  if (!spaceshipViewActive && !galacticViewActive) {
    orbitLines.forEach(o => o.visible = orbitsVisible);
  }
  document.getElementById("toggleOrbits").textContent = orbitsVisible ? "Hide Orbits" : "Show Orbits";
});



// Procedural "generic asteroid" geometry — a bumpy, irregular, elongated potato, like
// the generic model NASA's Eyes uses for Pluto's tiny moons (Styx/Nix/Kerberos/Hydra:
// each panel there literally says "represented by a generic model"). Displaces an
// icosphere by a sum of random plane-waves (multi-scale lumps) and elongates it. The
// shape is baked into the geometry so the min-dot scaler (uniform scale) still works;
// each moon gets its own seed for variety.
function _mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function _randUnit(rand){ let x, y, z, l; do { x = rand()*2-1; y = rand()*2-1; z = rand()*2-1; l = x*x+y*y+z*z; } while (l > 1 || l < 1e-4); l = Math.sqrt(l); return new THREE.Vector3(x/l, y/l, z/l); }
export function makeAsteroidGeometry(radius, seed) {
  // Indexed sphere (shared vertices) so computeVertexNormals() averages them into
  // SMOOTH normals. An icosphere is non-indexed → faceted/blocky shading.
  const geo = new THREE.SphereGeometry(radius, 128, 96);
  const rand = _mulberry32((seed >>> 0) || 1);
  const ey = 0.70 + rand() * 0.16, ez = 0.62 + rand() * 0.16;   // elongation (x stays 1 → chunky potato)
  const waves = [];
  for (let k = 0; k < 7; k++) {
    const f = 0.6 + rand() * 1.5;                                // only LOW frequencies → big soft lumps, no spikes
    waves.push({ dir: _randUnit(rand), f, amp: 0.10 / (1 + f * 0.4), ph: rand() * Math.PI * 2 });
  }
  const pos = geo.attributes.position, n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    let d = 1.0;
    for (const w of waves) d += w.amp * Math.sin(n.dot(w.dir) * w.f * Math.PI * 2.0 + w.ph);
    d = Math.max(0.78, d);
    pos.setXYZ(i, n.x * radius * d, n.y * radius * d * ey, n.z * radius * d * ez);
  }
  // The asymmetric lumps shift the shape's centre of MASS off the origin, which makes
  // the moon sit off its orbit line and swing (jitter) as it tumbles — min-dot scaling
  // amplifies it. Bounding-box centring (geo.center) isn't enough for an asymmetric
  // potato, so recentre on the true VOLUME centroid via signed tetrahedra.
  {
    const idx = geo.index, p = geo.attributes.position;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), cr = new THREE.Vector3();
    let vol = 0, cx = 0, cy = 0, cz = 0;
    for (let t = 0; t < idx.count; t += 3) {
      va.fromBufferAttribute(p, idx.getX(t));
      vb.fromBufferAttribute(p, idx.getX(t + 1));
      vc.fromBufferAttribute(p, idx.getX(t + 2));
      cr.crossVectors(vb, vc);
      const v = va.dot(cr);                      // 6× signed volume of tetra (origin,a,b,c)
      vol += v;
      cx += (va.x + vb.x + vc.x) * v;
      cy += (va.y + vb.y + vc.y) * v;
      cz += (va.z + vb.z + vc.z) * v;
    }
    if (Math.abs(vol) > 1e-30) {
      cx /= 4 * vol; cy /= 4 * vol; cz /= 4 * vol;
      for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) - cx, p.getY(i) - cy, p.getZ(i) - cz);
      p.needsUpdate = true;
    }
  }
  geo.computeVertexNormals();
  return geo;
}

// Build an irregular moon from REAL observed proportions. Unlike makeAsteroidGeometry
// (a random potato for Pluto's unobserved small moons), every number here comes from
// spacecraft observation: a sphere is scaled to the body's measured triaxial axes,
// given gentle low-frequency lumps, then has named impact craters carved as smooth
// bowls (e.g. Phobos's giant Stickney). Recentred on its volume centroid so it rides
// its orbit cleanly. `meanRadius` is the body's mean radius (units); opts:
//   axes:[a,b,c]  measured diameters' ratios (auto-normalised to preserve volume)
//   lumpiness     amplitude of the soft surface undulation (Phobos rough, Deimos smooth)
//   lumpSeed      deterministic seed so the shape is stable across reloads
//   craters:[{ dir:[x,y,z], angRadius (rad), depth, rim }]  carved depressions
export function makeMoonShapeGeometry(meanRadius, opts) {
  const { axes = [1, 1, 1], lumpiness = 0.05, lumpSeed = 1, craters = [] } = opts || {};
  const geo = new THREE.SphereGeometry(meanRadius, 160, 120);   // hi-res so big craters read cleanly
  const rand = _mulberry32((lumpSeed >>> 0) || 1);
  // Normalise the triaxial axes to a geometric mean of 1, so the body keeps the volume
  // of a meanRadius sphere while taking on the real elongation (Phobos ≈ 27×22×18 km).
  const gm = Math.cbrt(axes[0] * axes[1] * axes[2]);
  const ax = axes[0] / gm, ay = axes[1] / gm, az = axes[2] / gm;
  const waves = [];
  for (let k = 0; k < 6; k++) {
    const f = 0.8 + rand() * 1.8;                                // low frequencies → soft lumps, no spikes
    waves.push({ dir: _randUnit(rand), f, amp: lumpiness / (1 + f * 0.4), ph: rand() * Math.PI * 2 });
  }
  const cr = craters.map(c => ({
    dir: new THREE.Vector3(c.dir[0], c.dir[1], c.dir[2]).normalize(),
    ang: c.angRadius, depth: c.depth, rim: c.rim || 0
  }));
  const pos = geo.attributes.position, n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    let d = 1.0;
    for (const w of waves) d += w.amp * Math.sin(n.dot(w.dir) * w.f * Math.PI * 2.0 + w.ph);
    // Craters: within the crater's angular radius, sink the surface into a parabolic
    // bowl (deepest at centre) and raise a slight rim just inside the edge.
    for (const c of cr) {
      const a = Math.acos(Math.min(1, Math.max(-1, n.dot(c.dir))));
      if (a < c.ang) {
        const t = a / c.ang;                                     // 0 centre → 1 rim
        d += -c.depth * (1 - t * t) + c.rim * Math.exp(-Math.pow((t - 0.93) / 0.10, 2));
      }
    }
    d = Math.max(0.5, d);
    pos.setXYZ(i, n.x * meanRadius * d * ax, n.y * meanRadius * d * ay, n.z * meanRadius * d * az);
  }
  // Recentre on the true VOLUME centroid (signed tetrahedra) so the asymmetric shape
  // doesn't sit off its orbit line and swing as it rides round — same as makeAsteroidGeometry.
  {
    const idx = geo.index, p = geo.attributes.position;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), crs = new THREE.Vector3();
    let vol = 0, cx = 0, cy = 0, cz = 0;
    for (let t = 0; t < idx.count; t += 3) {
      va.fromBufferAttribute(p, idx.getX(t));
      vb.fromBufferAttribute(p, idx.getX(t + 1));
      vc.fromBufferAttribute(p, idx.getX(t + 2));
      crs.crossVectors(vb, vc);
      const v = va.dot(crs);
      vol += v;
      cx += (va.x + vb.x + vc.x) * v;
      cy += (va.y + vb.y + vc.y) * v;
      cz += (va.z + vb.z + vc.z) * v;
    }
    if (Math.abs(vol) > 1e-30) {
      cx /= 4 * vol; cy /= 4 * vol; cz /= 4 * vol;
      for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) - cx, p.getY(i) - cy, p.getZ(i) - cz);
      p.needsUpdate = true;
    }
  }
  geo.computeVertexNormals();
  return geo;
}

// Build a moon from its REAL measured figure (a NASA PDS gridded shape model) instead of a
// procedural potato. `shape` is {nLat,nLon,latStep,lonStep,radii}: a radius (km) field on a
// lat/lon grid (see deimosShape.js / phobosShape.js). We lay a UV sphere over that radius
// field, recentre on the volume centroid (the grid is referenced to the centre of figure,
// slightly off the long axis), and normalise so the volume-equivalent mean radius maps to
// `meanRadius` app units — keeping the true triaxial proportions and every real lump/crater.
// Longitude 0 / latitude 0 (the IAU sub-planet point of a tidally locked moon) lands on
// local +x, matching the radial tidal-lock orientation the other moons use. A duplicate
// seam column (lon 360 == lon 0) and equirectangular UVs (u = lon/360, v = (lat+90)/180)
// let the body's existing equirectangular texture map cleanly with no seam smear.
export function makeGriddedMoonGeometry(shape, meanRadius) {
  const { nLat, nLon, latStep, lonStep, radii } = shape;
  const D2R = Math.PI / 180;
  const cols = nLon + 1;                          // +1: duplicate the lon seam so UVs wrap 0→1
  const verts = [], uvs = [];
  for (let i = 0; i < nLat; i++) {
    const lat = (-90 + i * latStep) * D2R, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let j = 0; j < cols; j++) {
      const lon = (j * lonStep) * D2R;
      const r = radii[i * nLon + (j % nLon)];     // j == nLon reuses column 0's radius
      verts.push(r * cl * Math.cos(lon), r * sl, r * cl * Math.sin(lon));
      uvs.push(j / nLon, i / (nLat - 1));
    }
  }
  const idx = [];                                 // standard grid quads; pole rows are constant-
  for (let i = 0; i < nLat - 1; i++) {            // radius so their cap triangles are zero-area
    for (let j = 0; j < cols - 1; j++) {          // (harmless) and need no special welding.
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);

  // Recentre on the true VOLUME centroid (signed tetrahedra), then scale so the volume-
  // equivalent mean radius == meanRadius — same normalisation the procedural moons use.
  const p = geo.attributes.position;
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), crs = new THREE.Vector3();
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < idx.length; t += 3) {
    va.fromBufferAttribute(p, idx[t]); vb.fromBufferAttribute(p, idx[t + 1]); vc.fromBufferAttribute(p, idx[t + 2]);
    crs.crossVectors(vb, vc); const v = va.dot(crs);
    vol += v; cx += (va.x + vb.x + vc.x) * v; cy += (va.y + vb.y + vc.y) * v; cz += (va.z + vb.z + vc.z) * v;
  }
  vol /= 6; cx /= 24 * vol; cy /= 24 * vol; cz /= 24 * vol;
  const meanR = Math.cbrt(3 * Math.abs(vol) / (4 * Math.PI));   // radius of the volume-equal sphere (km)
  const s = meanRadius / meanR;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, (p.getX(i) - cx) * s, (p.getY(i) - cy) * s, (p.getZ(i) - cz) * s);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// Moon name → its real measured gridded shape model. Phobos & Deimos are NASA PDS Thomas
// models; Nix & Hydra are the New Horizons SPC models (resampled to the same grid format).
export const REAL_MOON_SHAPES = { Phobos: phobosShape, Deimos: deimosShape, Nix: nixShape, Hydra: hydraShape };

// helper function to create a moon
function createMoon(size, distance, speed, color, infoText, texture, startAngle) {
  const group = new THREE.Object3D();
  group.rotation.y = startAngle || Math.random() * Math.PI * 2;
  scene.add(group); // attach to SCENE not Jupiter

  const material = texture
    ? new THREE.MeshStandardMaterial({ map: texture })
    : new THREE.MeshStandardMaterial({ color });

  const moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(size, 32, 32),
    material
  );

  moonMesh.position.set(distance, 0, 0);
  moonMesh.userData = { info: infoText, trueRadius: size };
  group.userData = { info: infoText };
  group.add(moonMesh);

  return { group, speed, mesh: moonMesh, distance };
}

const io = createMoon(
  0.0001217,   // true radius 1,821 km
  0.028189,    // true orbit 421,700 km
  0.006852,  // Io: 1.769 day orbit
  0xffcc66,
  `<b>Io</b><br><br>
- Most volcanically active body in the Solar System<br>
- Extreme tidal heating from Jupiter<br>
- Constant surface renewal from lava activity`,
  ioTexture,
  0

);

const europa = createMoon(
  0.0001044,   // true radius 1,561 km
  0.044856,    // true orbit 671,034 km
  0.003413,  // Europa: 3.551 day orbit
  0xaad4ff,
  `<b>Europa</b><br><br>
- Ice-covered surface<br>
- Subsurface ocean beneath ice crust<br>
- Strong candidate for extraterrestrial life`,
  europaTexture,
  Math.PI * 0.5  // 90 degrees offset

);

const ganymede = createMoon(
  0.0001759,   // true radius 2,631 km
  0.071553,    // true orbit 1,070,412 km
  0.001695,  // Ganymede: 7.155 day orbit
  0x999999,
  `<b>Ganymede</b><br><br>
- Largest moon in the Solar System<br>
- Larger than Mercury<br>
- Has its own magnetic field`,
  ganymedeTexture,
  Math.PI * 1.1  // ~200 degrees offset
);

const callisto = createMoon(
  0.0001611,   // true radius 2,410 km
  0.125851,    // true orbit 1,882,709 km
  0.000726,  // Callisto: 16.689 day orbit
  0x666666,
  `<b>Callisto</b><br><br>
- Most heavily cratered surface<br>
- Geologically inactive<br>
- Ancient surface preserved for billions of years`,
  callistoTexture,
  Math.PI * 1.7  // ~300 degrees offset

);

// store for animation
const jupiterMoons = [io, europa, ganymede, callisto];

// The Galilean moons orbit in Jupiter's EQUATORIAL plane (Jupiter's obliquity is only
// ~3.1°), not the ecliptic. Ride them — and their orbit rings — on a shared tilt group
// (same idea as saturnMoonGroup) so their orbits carry that slight common tilt. The group
// is positioned onto Jupiter each frame in animate(); the moons keep orbiting via group.rotation.y.
const jupiterMoonGroup = new THREE.Object3D();
jupiterMoonGroup.rotation.z = 3.1 * (Math.PI / 180);
scene.add(jupiterMoonGroup);
jupiterMoons.forEach(m => { scene.remove(m.group); m.group.position.set(0, 0, 0); jupiterMoonGroup.add(m.group); });
jupiterMoonOrbitLines.forEach((line, i) => {
  scene.remove(line); line.position.set(0, 0, 0); jupiterMoonGroup.add(line);
  // The ring loop's distances are in Galilean order (Io, Europa, Ganymede, Callisto),
  // matching jupiterMoons — tag each ring with its moon so flying straight to a moon
  // hides its ring (not just zooming into Jupiter).
  if (jupiterMoons[i]) line.userData.moonMesh = jupiterMoons[i].mesh;
});

// 🔴 Mars's moons — Phobos and Deimos. They orbit in Mars's equatorial plane, so
// marsMoonGroup carries the same fixed 25.2° tilt as Mars's spin axis; each moon also
// gets its small real inclination via a tilt sub-container. Unlike the round Galilean
// moons (and unlike Pluto's RANDOM-potato small moons), these two have been imaged by
// spacecraft, so their meshes are built from real measured triaxial shapes + craters via
// makeMoonShapeGeometry. They are tidally locked: each is a static child of its rotating
// orbit group, so its long axis stays pointed at Mars (no free tumble). The group is NOT
// min-dot scaled, so the moons keep their true orbital distances; only each mesh is.
const marsMoonGroup = new THREE.Object3D();
marsMoonGroup.rotation.z = 25.2 * (Math.PI / 180);     // Mars's equatorial plane (= its axial tilt)
scene.add(marsMoonGroup);
const marsMoons = [];
const marsMoonOrbitLines = [];
if (marsMesh && marsMesh.userData.moons) {
  marsMesh.userData.moons.forEach(mn => {
    const mo = createMoon(mn.size, mn.dist, mn.speed, mn.color, mn.info,
                          mn.texture ? textureLoader.load(mn.texture) : null,
                          Math.random() * Math.PI * 2);
    mo.mesh.userData.name = mn.name;
    // Swap the default sphere for the real observed shape. Phobos and Deimos both use their
    // actual NASA PDS measured figures (makeGriddedMoonGeometry); any other shaped moon falls
    // back to the procedural triaxial+craters model. Either way the long axis ends up along
    // local +x — radial — so leaving the mesh un-rotated keeps it tidally locked, like the real moons.
    const realShape = REAL_MOON_SHAPES[mn.name];
    if (realShape) {
      mo.mesh.geometry.dispose();
      mo.mesh.geometry = makeGriddedMoonGeometry(realShape, mn.size);
    } else if (mn.shape) {
      mo.mesh.geometry.dispose();
      mo.mesh.geometry = makeMoonShapeGeometry(mn.size, mn.shape);
    }
    scene.remove(mo.group);            // createMoon parented it to the scene — move into the equatorial plane

    let parent = marsMoonGroup;
    if (mn.incl) {
      const tilt = new THREE.Object3D();
      tilt.rotation.y = (mn.node || 0) * (Math.PI / 180);   // node: tilt direction (deg, optional)
      tilt.rotation.z = mn.incl * (Math.PI / 180);          // inclination to Mars's equator (deg)
      marsMoonGroup.add(tilt);
      parent = tilt;
    }
    parent.add(mo.group);
    marsMoons.push(mo);

    // Orbit ring at the true semi-major axis. These moons are minuscule, so a fixed
    // 128-gon's chord gap would exceed their radius and they'd appear to vibrate off the
    // line — use a sagitta-based segment count (chord gap < 0.1× radius), like Pluto's.
    const segs = Math.min(2048, Math.max(128,
      Math.ceil(Math.PI * Math.sqrt(mn.dist / (2 * 0.1 * mn.size)))));
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * mn.dist, 0, Math.sin(a) * mn.dist));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Mars, transparent: true, opacity: 0.3 })
    );
    line.userData.ownerMesh = marsMesh;
    line.userData.moonMesh = mo.mesh;  // also hide when zoomed in close to the moon itself
    parent.add(line);                  // orbit ring rides the same (possibly inclined) plane as the moon
    orbitLines.push(line);
    marsMoonOrbitLines.push(line);
  });
}

// 🌑 Pluto's moons — Charon + the four small ones (Styx, Nix, Kerberos, Hydra),
// built from the Pluto data entry. They all orbit in Pluto's EQUATORIAL plane, which
// is tilted ~122.5° (Pluto's obliquity), so they ride a shared tilt container parked
// on Pluto each frame. Pluto and Charon are MUTUALLY tidally locked: Charon keeps one
// face toward Pluto for free (its mesh is parented to its orbit pivot), and Pluto is
// spun in lock-step with Charon's orbital angle about this plane's normal (see animate).
const plutoMesh = meshes.find(m => m.userData.name === "Pluto");
const plutoTiltGroup = new THREE.Object3D();   // Pluto's equatorial plane (not min-dot scaled)
plutoTiltGroup.rotation.x = 112.5 * (Math.PI / 180);
plutoTiltGroup.rotation.z = 22.25 * (Math.PI / 180);
scene.add(plutoTiltGroup);
// Reusable handles for Pluto's locked spin (set each frame in animate).
const _plutoSpinAxis = new THREE.Vector3(0, 1, 0);
const _plutoSpinQ = new THREE.Quaternion();
const plutoMoons = [];
const plutoMoonOrbitLines = [];
if (plutoMesh && plutoMesh.userData.moons) {
  plutoMesh.userData.moons.forEach((mn, idx) => {
    const mo = createMoon(mn.size, mn.dist, mn.speed, mn.color, mn.info,
                          mn.texture ? textureLoader.load(mn.texture) : null,
                          0);  // real phase is seeded from MOON_EPHEMERIS in resetSimulation()
    mo.mesh.userData.name = mn.name;
    // The tiny moons are irregular, bumpy asteroids — swap the sphere for their shape
    // (Charon stays round). Nix & Hydra were resolved by New Horizons, so they use their
    // REAL measured figure (makeGriddedMoonGeometry); Styx & Kerberos, never resolved, keep
    // the procedural lumpy stand-in. All four still tumble chaotically (not tidally locked).
    if (mn.irregular) {
      const realShape = REAL_MOON_SHAPES[mn.name];
      mo.mesh.geometry.dispose();
      mo.mesh.geometry = realShape
        ? makeGriddedMoonGeometry(realShape, mn.size)
        : makeAsteroidGeometry(mn.size, 1013 * (idx + 1) + 7);
      mo.irregular = true;
      mo.spin = mn.spin || 0.004;   // real self-rotation rate (rad/frame at 1×); see planets.js
      mo.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    }
    scene.remove(mo.group);          // reparent into Pluto's tilted equatorial plane
    plutoTiltGroup.add(mo.group);
    plutoMoons.push(mo);

    // Orbit ring at the moon's true semi-major axis, riding the same tilted plane;
    // hidden (via ownerMesh) when zoomed into Pluto itself, shown at system-framing zoom.
    // Segment count is sagitta-based (chord gap < 0.1× the moon's radius): these moons
    // are SO tiny that a fixed 128-segment ring's chord gap exceeds their radius, leaving
    // them visibly off the polyline (and appearing to vibrate against it as they orbit).
    const segs = Math.min(2048, Math.max(128,
      Math.ceil(Math.PI * Math.sqrt(mn.dist / (2 * 0.1 * mn.size)))));
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * mn.dist, 0, Math.sin(a) * mn.dist));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Pluto, transparent: true, opacity: 0.3 })
    );
    line.userData.ownerMesh = plutoMesh;
    line.userData.moonMesh = mo.mesh;   // also hide when zoomed in close to the moon itself
    plutoTiltGroup.add(line);
    orbitLines.push(line);
    plutoMoonOrbitLines.push(line);
  });
}
const plutoCharon = plutoMoons.find(p => p.mesh.userData.name === "Charon") || null;

// ✨ Haumea's moons — Hiʻiaka (outer, larger) and Namaka (inner, smaller). Both are icy
// collision shards; NEITHER is tidally locked, so each gets its own free spin on top of
// its orbital motion (Hiʻiaka's real ~9.8-h rotation is ~5× per orbit). They ride a
// shared tilt container parked on Haumea each frame (Haumea's equatorial plane); Namaka
// carries an extra inclination. Same lumpy-shape builder the Mars moons use (generic
// proportions — no resolved imaging exists) with the Pluto-moon asteroid texture.
const haumeaMesh = meshes.find(m => m.userData.name === "Haumea");
const haumeaMoonGroup = new THREE.Object3D();   // Haumea's equatorial plane (not min-dot scaled)
haumeaMoonGroup.rotation.x = 52 * (Math.PI / 180);
haumeaMoonGroup.rotation.z = 18 * (Math.PI / 180);
scene.add(haumeaMoonGroup);
const haumeaMoons = [];
const haumeaMoonOrbitLines = [];
if (haumeaMesh && haumeaMesh.userData.moons) {
  haumeaMesh.userData.moons.forEach((mn, idx) => {
    const mo = createMoon(mn.size, mn.dist, mn.speed, mn.color, mn.info,
                          mn.texture ? textureLoader.load(mn.texture) : null,
                          idx * 2.1);   // distinct start phases
    mo.mesh.userData.name = mn.name;
    if (mn.shape) {
      mo.mesh.geometry.dispose();
      mo.mesh.geometry = makeMoonShapeGeometry(mn.size, mn.shape);
    }
    // Free (non-synchronous) self-rotation — these moons are NOT tidally locked.
    mo.spin = mn.spin || 0;
    mo.mesh.rotation.set(0.6 * (idx + 1), 1.3 * (idx + 1), 0.4 * (idx + 1));

    scene.remove(mo.group);   // reparent into Haumea's (possibly inclined) plane
    let parent = haumeaMoonGroup;
    if (mn.incl) {
      const tilt = new THREE.Object3D();
      tilt.rotation.y = (mn.node || 0) * (Math.PI / 180);   // node: tilt direction (deg, optional)
      tilt.rotation.z = mn.incl * (Math.PI / 180);          // inclination to Hiʻiaka's plane (deg)
      haumeaMoonGroup.add(tilt);
      parent = tilt;
    }
    parent.add(mo.group);
    haumeaMoons.push(mo);

    // Orbit ring — sagitta-based segment count so the moon sits exactly on the line
    // (chord gap < 0.1× the moon's radius), like Pluto's/Iapetus's rings.
    const segs = Math.min(2048, Math.max(128,
      Math.ceil(Math.PI * Math.sqrt(mn.dist / (2 * 0.1 * mn.size)))));
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * mn.dist, 0, Math.sin(a) * mn.dist));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Haumea, transparent: true, opacity: 0.3 })
    );
    line.userData.ownerMesh = haumeaMesh;
    line.userData.moonMesh = mo.mesh;
    parent.add(line);   // ring rides the same (possibly inclined) plane as the moon
    orbitLines.push(line);
    haumeaMoonOrbitLines.push(line);
  });
}

// ✨ Eris's moon — Dysnomia. Unlike Haumea's moons, Dysnomia IS tidally locked to Eris:
// it is a static child of its orbit group (no own spin), so the group's orbital rotation
// alone keeps one face toward Eris — exactly like the major moons. Generic cratered shape
// (no resolved imaging) with the Pluto-moon asteroid texture; rides a tilt container
// parked on Eris each frame.
const erisMesh = meshes.find(m => m.userData.name === "Eris");
const erisMoonGroup = new THREE.Object3D();   // Eris's equatorial/orbit plane (not min-dot scaled)
erisMoonGroup.rotation.x = 44 * (Math.PI / 180);
erisMoonGroup.rotation.z = 22 * (Math.PI / 180);
scene.add(erisMoonGroup);
const erisMoons = [];
const erisMoonOrbitLines = [];
if (erisMesh && erisMesh.userData.moons) {
  erisMesh.userData.moons.forEach(mn => {
    const mo = createMoon(mn.size, mn.dist, mn.speed, mn.color, mn.info,
                          mn.texture ? textureLoader.load(mn.texture) : null,
                          1.2);
    mo.mesh.userData.name = mn.name;
    if (mn.shape) {
      mo.mesh.geometry.dispose();
      mo.mesh.geometry = makeMoonShapeGeometry(mn.size, mn.shape);
    }
    // No `spin` and no per-frame mesh rotation → tidally locked (the orbit group's
    // rotation keeps the moon's −X face, and its long axis, toward Eris).
    scene.remove(mo.group);
    erisMoonGroup.add(mo.group);
    erisMoons.push(mo);

    const segs = Math.min(2048, Math.max(128,
      Math.ceil(Math.PI * Math.sqrt(mn.dist / (2 * 0.1 * mn.size)))));
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * mn.dist, 0, Math.sin(a) * mn.dist));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Eris, transparent: true, opacity: 0.3 })
    );
    line.userData.ownerMesh = erisMesh;
    line.userData.moonMesh = mo.mesh;
    erisMoonGroup.add(line);
    orbitLines.push(line);
    erisMoonOrbitLines.push(line);
  });
}

// 🔵 Neptune's moon — Triton (retrograde). Same scene-parented pattern as the Pluto
// moons: a sphere via createMoon + an orbit ring repositioned onto Neptune each frame.
// Untextured for now (a flat colour); a real texture can be dropped in later via the
// moon's `texture` field. Negative speed in the data gives the true retrograde orbit.
const neptuneMesh = meshes.find(m => m.userData.name === "Neptune");
const neptuneMoons = [];
const neptuneMoonTilts = [];   // per-moon orbit-plane tilt containers, parked on Neptune each frame
if (neptuneMesh && neptuneMesh.userData.moons) {
  neptuneMesh.userData.moons.forEach(mn => {
    const mo = createMoon(mn.size, mn.dist, mn.speed, mn.color, mn.info,
                          mn.texture ? textureLoader.load(mn.texture) : null,
                          Math.random() * Math.PI * 2);
    mo.mesh.userData.name = mn.name;

    // Triton is RETROGRADE and steeply inclined — ~157° to Neptune's equator, ~130° to the
    // ecliptic (strong evidence it's a captured Kuiper-belt object). The retrograde motion comes
    // from the negative `speed` in the data; the orbitTilt angles set the orbit PLANE's tilt to
    // ~50° from the ecliptic, which together with the reversed motion gives the true ~130°
    // ecliptic inclination. orbitTiltX/Z together fix the plane's tilt magnitude (~50°) and its
    // line of nodes. Put the spinning orbit group AND its ring inside this tilt container; the
    // container (not the group) is the thing parked on Neptune each frame.
    const tilt = new THREE.Object3D();
    tilt.rotation.x = (mn.orbitTiltX || 0) * (Math.PI / 180);
    tilt.rotation.z = (mn.orbitTiltZ || 0) * (Math.PI / 180);
    scene.add(tilt);
    scene.remove(mo.group);        // createMoon parented it to the scene — reparent under the tilt
    tilt.add(mo.group);
    mo.tilt = tilt;
    neptuneMoons.push(mo);
    neptuneMoonTilts.push(tilt);

    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * mn.dist, 0, Math.sin(a) * mn.dist));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Neptune, transparent: true, opacity: 0.3 })
    );
    line.userData.ownerMesh = neptuneMesh;
    line.userData.moonMesh = mo.mesh;   // also hide when zoomed in close to the moon itself
    tilt.add(line);                // ring rides the same tilt; its world position follows the container
    orbitLines.push(line);
  });
}


moon.userData = {
  name: "Moon",
  info: MOON_INFO,
  trueRadius: MOON_TRUE_RADIUS   // needed by the min-dot scaler and fly-to framing
};

const saturn = meshes.find(m => m.userData.name === "Saturn");
saturn.rotation.order = 'ZYX';

// Rings live in the scene directly so they stay still while Saturn's body spins
const saturnTiltGroup = new THREE.Object3D();
saturnTiltGroup.rotation.z = 26.7 * (Math.PI / 180);
scene.add(saturnTiltGroup);

const ringUniforms = {
  map:           { value: ringTexture },
  saturnPos:     { value: new THREE.Vector3() },
  saturnRadius:  { value: saturn.userData.size },  // updated each frame to Saturn's apparent radius
  // Ring-plane normal (constant: rings tilted 26.7° about Z). Used to cast the planet
  // shadow along the Sun direction projected into the ring plane — a long shadow.
  ringNormal:    { value: new THREE.Vector3(Math.sin(26.7 * Math.PI / 180),
                                            -Math.cos(26.7 * Math.PI / 180), 0) }
};

// Ring span keeps the old 1.5×–2.5× body-radius proportions (matches the texture),
// now relative to Saturn's true radius. saturnTiltGroup is scaled to Saturn's
// min-dot factor each frame so the rings track the body's on-screen size.
const ringGeometry = new THREE.RingGeometry(saturn.userData.size * 1.5, saturn.userData.size * 2.5, 64);
const ringMaterial = new THREE.ShaderMaterial({
  uniforms: ringUniforms,
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vWorldPos;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = uv;
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: `
    uniform sampler2D map;
    uniform vec3 saturnPos;
    uniform float saturnRadius;
    uniform vec3 ringNormal;
    varying vec2 vUv;
    varying vec3 vWorldPos;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      // Sample the ring profile RADIALLY. The texture is a 1D inner→outer strip, so
      // map each fragment's distance from Saturn's centre to U (V held constant). This
      // reproduces the real C / B / Cassini-division / A banding, instead of smearing
      // the strip flat the way RingGeometry's default square UVs did.
      float rr = length(vUv - 0.5) * 2.0;            // radius / outerRadius, in [0.6, 1.0]
      float t  = clamp((rr - 0.6) / 0.4, 0.0, 1.0);  // 0 = inner edge, 1 = outer edge
      vec4 texColor = texture2D(map, vec2(t, 0.5));
      if (texColor.a < 0.01) discard;

      vec3 toSun = normalize(-saturnPos);
      vec3 ringPoint = vWorldPos - saturnPos;

      // Cast the shadow along the Sun direction PROJECTED into the ring plane, so it
      // stretches as a long band across the night side of the rings — Saturn is near
      // its equinox season (sun grazing the rings), the iconic long ring shadow in
      // NASA's Eyes — instead of a short stub near the planet.
      vec3 nrm = normalize(ringNormal);
      vec3 sunFlat = toSun - dot(toSun, nrm) * nrm;
      float sfl = length(sunFlat);
      vec3 shadowDir = sfl > 0.001 ? sunFlat / sfl : toSun;

      float proj = dot(ringPoint, shadowDir);
      float shadowFactor = 1.0;
      if (proj < 0.0) {
        // Inside Saturn's shadow band (perpendicular distance to the shadow axis is
        // within Saturn's radius), on the side away from the (in-plane) Sun direction.
        float perpDist = length(ringPoint - proj * shadowDir);
        float edge = saturnRadius * 0.10;
        float shadow = 1.0 - smoothstep(saturnRadius - edge, saturnRadius + edge, perpDist);
        shadowFactor = 1.0 - shadow * 0.7;
      }

      gl_FragColor = vec4(texColor.rgb * shadowFactor, texColor.a);
    }
  `,
  side: THREE.DoubleSide,
  transparent: true,
  depthWrite: false
});
const ring = new THREE.Mesh(ringGeometry, ringMaterial);
ring.rotation.x = Math.PI / 2;
saturnTiltGroup.add(ring);

// 🔵 Neptune's rings — faint, fragmented dust rings in reality. We reuse Saturn's
// ring strip texture but render it VERY pale and VERY transparent so it reads as the
// barely-there haze NASA's Eyes shows, not a bright Saturn-style band. Lives in the
// scene (like Saturn's) so it stays put while Neptune's body spins; tracked onto
// Neptune and min-dot-scaled each frame.
const neptuneTiltGroup = new THREE.Object3D();
// Ring orientation (hand-tuned). rotation.x is the left/right roll (positive = right
// side higher), rotation.z is the axial tilt. Neptune's spin axis (below) is derived
// from this plane's normal, so the ring always stays Neptune's equatorial plane.
neptuneTiltGroup.rotation.x = 38 * (Math.PI / 180);
neptuneTiltGroup.rotation.z = -28 * (Math.PI / 180);
scene.add(neptuneTiltGroup);

// Ring-plane normal in world space (the container only ever rotates, never re-tilts at
// runtime, so this is constant). Used to project the Sun direction into the ring plane
// for the cast shadow, exactly like Saturn's rings.
const _neptuneRingNormal = new THREE.Vector3(0, 1, 0).applyEuler(neptuneTiltGroup.rotation).normalize();

// Neptune's spin: rotate about a FIXED axis equal to the ring-plane normal, so the ring
// is Neptune's equatorial plane and the pole stays put (no wobble). We can't get this
// from Euler angles — incrementing rotation.y while a tilt is on rotation.x/z makes the
// pole trace a cone (the up/down "bobbing"). Instead we set the quaternion each frame as
// (fixed tilt that maps local +Y onto the ring normal) × (spin about local +Y).
const _neptuneSpinTilt = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 1, 0), _neptuneRingNormal);
const _neptuneSpinAxis = new THREE.Vector3(0, 1, 0);
const _neptuneSpinQ = new THREE.Quaternion();
let neptuneSpinAngle = 0;

const neptuneRingUniforms = {
  map:           { value: ringTexture },
  neptunePos:    { value: new THREE.Vector3() },
  neptuneRadius: { value: neptuneMesh.userData.size }, // updated each frame to the apparent radius
  ringNormal:    { value: _neptuneRingNormal }
};
// Ring span 1.7×–2.6× the body radius (Neptune's real rings sit ~41,900–62,930 km
// out, vs its 24,622 km radius), relative to Neptune's true size.
const neptuneRingGeometry = new THREE.RingGeometry(
  neptuneMesh.userData.size * 1.7, neptuneMesh.userData.size * 2.6, 64);
const neptuneRingMaterial = new THREE.ShaderMaterial({
  uniforms: neptuneRingUniforms,
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vWorldPos;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = uv;
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: `
    uniform sampler2D map;
    uniform vec3 neptunePos;
    uniform float neptuneRadius;
    uniform vec3 ringNormal;
    varying vec2 vUv;
    varying vec3 vWorldPos;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      // Radial sample of the 1D inner→outer strip (same mapping as Saturn's rings).
      float rr = length(vUv - 0.5) * 2.0;
      float t  = clamp((rr - 0.6) / 0.4, 0.0, 1.0);
      vec4 texColor = texture2D(map, vec2(t, 0.5));
      if (texColor.a < 0.01) discard;
      // Wash the banding out toward a cool pale grey-blue, then knock the alpha
      // right down so the whole ring is a barely-there ghostly haze (NASA's Eyes
      // shows Neptune's rings as almost invisible wisps).
      vec3 pale = mix(texColor.rgb, vec3(0.72, 0.78, 0.88), 0.85);

      // Cast Neptune's shadow across the ring's far (night) side — the Sun direction
      // projected into the ring plane, same construction as Saturn's ring shadow.
      vec3 toSun = normalize(-neptunePos);
      vec3 ringPoint = vWorldPos - neptunePos;
      vec3 nrm = normalize(ringNormal);
      vec3 sunFlat = toSun - dot(toSun, nrm) * nrm;
      float sfl = length(sunFlat);
      vec3 shadowDir = sfl > 0.001 ? sunFlat / sfl : toSun;
      float proj = dot(ringPoint, shadowDir);
      float shadowFactor = 1.0;
      if (proj < 0.0) {
        float perpDist = length(ringPoint - proj * shadowDir);
        float edge = neptuneRadius * 0.10;
        float shadow = 1.0 - smoothstep(neptuneRadius - edge, neptuneRadius + edge, perpDist);
        shadowFactor = 1.0 - shadow * 0.7;
      }

      gl_FragColor = vec4(pale * shadowFactor, texColor.a * 0.05);
    }
  `,
  side: THREE.DoubleSide,
  transparent: true,
  depthWrite: false
});
const neptuneRing = new THREE.Mesh(neptuneRingGeometry, neptuneRingMaterial);
neptuneRing.rotation.x = Math.PI / 2;
neptuneTiltGroup.add(neptuneRing);

// 🪐 Jupiter's ring — a faint, dark ring of dust kicked off the inner moons (the main ring
// sits ~1.7–1.8 Jupiter radii out). Far fainter than Saturn's; we render a thin, dim reddish
// band in Jupiter's equatorial plane (3.1° tilt). Same scene-parented + per-frame tracked
// pattern as Saturn/Neptune (reuses the 1-D ring strip, washed dark; planet shadow on the
// night side). Lives in its own tilt group so it stays put while Jupiter's body spins.
const jupiterTiltGroup = new THREE.Object3D();
jupiterTiltGroup.rotation.z = 3.1 * (Math.PI / 180);   // Jupiter's equatorial plane
scene.add(jupiterTiltGroup);
const _jupiterRingNormal = new THREE.Vector3(0, 1, 0).applyEuler(jupiterTiltGroup.rotation).normalize();
const jupiterRingUniforms = {
  map:           { value: ringTexture },
  jupiterPos:    { value: new THREE.Vector3() },
  jupiterRadius: { value: jupiter.userData.size },
  ringNormal:    { value: _jupiterRingNormal }
};
const jupiterRingGeometry = new THREE.RingGeometry(
  jupiter.userData.size * 1.4, jupiter.userData.size * 1.81, 96);
const jupiterRingMaterial = new THREE.ShaderMaterial({
  uniforms: jupiterRingUniforms,
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vWorldPos;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = uv;
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: `
    uniform sampler2D map;
    uniform vec3 jupiterPos;
    uniform float jupiterRadius;
    uniform vec3 ringNormal;
    varying vec2 vUv;
    varying vec3 vWorldPos;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      float rr = length(vUv - 0.5) * 2.0;
      float t  = clamp((rr - 0.6) / 0.4, 0.0, 1.0);
      vec4 texColor = texture2D(map, vec2(t, 0.5));
      if (texColor.a < 0.01) discard;
      // Wash the Saturn banding out to a dim reddish dust tone (Jupiter's ring is dark).
      vec3 dust = mix(texColor.rgb, vec3(0.42, 0.30, 0.22), 0.85);
      // Planet shadow across the night side, same construction as Saturn/Neptune.
      vec3 toSun = normalize(-jupiterPos);
      vec3 ringPoint = vWorldPos - jupiterPos;
      vec3 nrm = normalize(ringNormal);
      vec3 sunFlat = toSun - dot(toSun, nrm) * nrm;
      float sfl = length(sunFlat);
      vec3 shadowDir = sfl > 0.001 ? sunFlat / sfl : toSun;
      float proj = dot(ringPoint, shadowDir);
      float shadowFactor = 1.0;
      if (proj < 0.0) {
        float perpDist = length(ringPoint - proj * shadowDir);
        float edge = jupiterRadius * 0.10;
        float shadow = 1.0 - smoothstep(jupiterRadius - edge, jupiterRadius + edge, perpDist);
        shadowFactor = 1.0 - shadow * 0.7;
      }
      gl_FragColor = vec4(dust * shadowFactor, texColor.a * 0.06);
    }
  `,
  side: THREE.DoubleSide,
  transparent: true,
  depthWrite: false
});
const jupiterRing = new THREE.Mesh(jupiterRingGeometry, jupiterRingMaterial);
jupiterRing.rotation.x = Math.PI / 2;
jupiterTiltGroup.add(jupiterRing);

// 🪐 Uranus's rings — 13 known rings, but unlike Saturn's bright bands they are
// extremely DARK (reflect ~2% of sunlight), narrow and faint. Rendered procedurally:
// a cluster of thin dark "main" rings (6,5,4,α,β,η,γ,δ,λ), the brighter Epsilon ring
// as the prominent outer band, and the two faint dusty outer rings (Nu = red rocky,
// Mu = blue ice). Uranus orbits on its side (~98° tilt), so the rings sit nearly
// perpendicular to the ecliptic; the tilt below is hand-set to present them as the
// open ellipse NASA's Eyes shows. Same scene-parented + per-frame tracked pattern as
// Saturn/Neptune (position follows Uranus, min-dot-scaled, planet shadow on the night side).
const uranusMesh = meshes.find(m => m.userData.name === "Uranus");
// The ring plane is oriented in resetSimulation() so its normal points along the
// Uranus→Sun radial — a face-on "shield" toward the Sun, near-vertical from the side.
// The Uranian moons (added later) parent to THIS group so they share the ring plane.
const uranusTiltGroup = new THREE.Object3D();
scene.add(uranusTiltGroup);

// Uranus spins about its ring-plane normal (its rotation axis = the ring plane's axis,
// so the rings are Uranus's equatorial plane). Like Neptune, we can't get this from Euler
// angles without the pole "bobbing", so each frame we set the quaternion as
// (fixed tilt onto the ring normal) × (spin about local +Y). _uranusSpinTilt is copied
// from uranusTiltGroup.quaternion in resetSimulation(), once the ring plane is oriented.
const _uranusSpinTilt = new THREE.Quaternion();
const _uranusSpinAxis = new THREE.Vector3(0, 1, 0);
const _uranusSpinQ = new THREE.Quaternion();
let uranusSpinAngle = 0;

// Uranus's spin axis is FIXED in space (~97.77° obliquity — it lies almost in its orbital
// plane), pointing at a fixed sky direction; it does NOT track the Sun. Orient the ring /
// equatorial plane to that fixed normal ONCE here. As Uranus moves along its 84-yr orbit the
// rings therefore appear open or edge-on to us depending on the geometry — exactly like the
// real planet — instead of always presenting face-on. URANUS_NODE_LON is the ecliptic
// longitude the north pole leans toward (tuned to match NASA's Eyes at the current date).
const URANUS_OBLIQUITY = 97.77 * Math.PI / 180;
const URANUS_NODE_LON  = 167 * Math.PI / 180;
const uranusFixedNormal = new THREE.Vector3(0, 1, 0).applyAxisAngle(
  new THREE.Vector3(Math.cos(URANUS_NODE_LON), 0, Math.sin(URANUS_NODE_LON)), URANUS_OBLIQUITY).normalize();
uranusTiltGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), uranusFixedNormal);
_uranusSpinTilt.copy(uranusTiltGroup.quaternion);   // Uranus spins about this same fixed ring-plane axis

const URANUS_RING_OUTER = 4.0;   // geometry outer edge, in Uranus radii (reaches the Mu ring)
const uranusRingUniforms = { outerMul: { value: URANUS_RING_OUTER } };
const uranusRingGeometry = new THREE.RingGeometry(
  uranusMesh.userData.size * 1.12, uranusMesh.userData.size * URANUS_RING_OUTER, 160);
const uranusRingMaterial = new THREE.ShaderMaterial({
  uniforms: uranusRingUniforms,
  vertexShader: `
    varying vec2 vUv;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: `
    uniform float outerMul;
    varying vec2 vUv;
    #include <logdepthbuf_pars_fragment>
    float band(float r, float c, float w){ float x = (r - c) / w; return exp(-x * x); }
    // Flat-topped "ribbon" band (a defined width with soft edges) — used for the dusty
    // outer Nu/Mu rings so they read as broad ribbons rather than diffuse gaussian smears.
    float ribbon(float r, float c, float halfW, float edge){
      return smoothstep(c - halfW - edge, c - halfW, r)
           * (1.0 - smoothstep(c + halfW, c + halfW + edge, r));
    }
    void main() {
      #include <logdepthbuf_fragment>
      // Physical radius in Uranus-radii (rr = 1.0 at the geometry's outer edge).
      float rr = length(vUv - 0.5) * 2.0;
      float physR = rr * outerMul;

      // Diffuse inner sheet — the faint dusty material (Zeta ring etc.) that reaches in
      // from the main rings toward the planet, giving the inner rings a continuous,
      // Saturn-like fill rather than stopping in empty space. Fades in just above the
      // surface (~1.12 R) and fades out at Epsilon.
      float inner = smoothstep(1.12, 1.34, physR) * (1.0 - smoothstep(1.90, 2.04, physR));
      vec3  innerCol = vec3(0.42, 0.40, 0.38);

      // Cluster of thin dark main rings (6,5,4,α,β,η,γ,δ,λ).
      float mains =
          band(physR,1.637,0.006) + band(physR,1.665,0.006)
        + band(physR,1.749,0.007) + band(physR,1.786,0.007)
        + band(physR,1.846,0.006) + band(physR,1.863,0.006)
        + band(physR,1.890,0.007) + band(physR,1.957,0.008);
      vec3  mainsCol = vec3(0.46, 0.44, 0.42);    // dark neutral grey

      // Epsilon — the prominent outermost main ring.
      float eps    = band(physR, 2.00, 0.012);
      vec3  epsCol = vec3(0.62, 0.60, 0.57);

      // Faint dusty outer rings as defined ribbons: Nu (deep red, rocky) thicker,
      // Mu (deep blue, ice) thickest. Kept very dark/dim.
      float nu    = ribbon(physR, 2.63, 0.10, 0.05);
      vec3  nuCol = vec3(0.22, 0.04, 0.03);   // deep, dark red
      float mu    = ribbon(physR, 3.50, 0.22, 0.07);
      vec3  muCol = vec3(0.04, 0.07, 0.20);   // deep, dark blue

      vec3  col = innerCol * inner + mainsCol * mains + epsCol * eps + nuCol * nu + muCol * mu;
      // Much dimmer overall — Uranus's rings reflect only ~2% of sunlight, so everything
      // is kept very faint; the whites no longer dominate and the red/blue stay subtle.
      float a   = inner * 0.10 + mains * 0.04 + eps * 0.15 + nu * 0.15 + mu * 0.15;
      if (a < 0.003) discard;

      gl_FragColor = vec4(col, a);
    }
  `,
  side: THREE.DoubleSide,
  transparent: true,
  depthWrite: false
});
const uranusRing = new THREE.Mesh(uranusRingGeometry, uranusRingMaterial);
uranusRing.rotation.x = Math.PI / 2;
uranusTiltGroup.add(uranusRing);

// 🌙 Uranus's 5 major moons — Miranda, Ariel, Umbriel, Titania, Oberon — at their true
// semi-major axes (true scale). They orbit in Uranus's equatorial plane = the ring
// plane, so they ride uranusMoonGroup, which shares the ring-plane orientation (set in
// resetSimulation). That group is NOT min-dot scaled (unlike the ring), so the moons
// stay at their real orbital distances; only each moon mesh is min-dot-scaled for
// visibility. Each moon is textured via the `texture` field in its data entry.
const uranusMoonGroup = new THREE.Object3D();
scene.add(uranusMoonGroup);
const uranusMoons = [];
const uranusMoonOrbitLines = [];
if (uranusMesh && uranusMesh.userData.moons) {
  uranusMesh.userData.moons.forEach(mn => {
    const mo = createMoon(mn.size, mn.dist, mn.speed, mn.color, mn.info,
                          mn.texture ? textureLoader.load(mn.texture) : null,
                          Math.random() * Math.PI * 2);
    mo.mesh.userData.name = mn.name;
    scene.remove(mo.group);        // createMoon parented it to the scene — move it into the ring plane

    // Most moons sit in the ring plane (parent = uranusMoonGroup). Miranda is the only
    // one with a real orbital inclination, so it gets a small tilt sub-container so its
    // orbit (and ring) sits at an angle to the others.
    let parent = uranusMoonGroup;
    if (mn.incl) {
      // Miranda is the only Uranus moon with a real inclination (≈4.34° to Uranus's
      // equator). `node` (optional) rotates which way that tilt points — an arbitrary
      // reference-frame choice that doesn't change the inclination, default 0.
      const tilt = new THREE.Object3D();
      tilt.rotation.y = (mn.node || 0) * (Math.PI / 180);   // node: tilt direction (deg, optional)
      tilt.rotation.z = mn.incl * (Math.PI / 180);          // inclination to Uranus's equator (deg)
      uranusMoonGroup.add(tilt);
      parent = tilt;
    }
    parent.add(mo.group);
    uranusMoons.push(mo);

    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * mn.dist, 0, Math.sin(a) * mn.dist));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Uranus, transparent: true, opacity: 0.3 })
    );
    line.userData.ownerMesh = uranusMesh;
    line.userData.moonMesh = mo.mesh;   // also hide when zoomed in close to the moon itself
    parent.add(line);              // orbit ring rides the same (possibly inclined) plane as the moon
    orbitLines.push(line);
    uranusMoonOrbitLines.push(line);
  });
}

// 🌙 Saturn's 7 major moons — Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus — at
// their true semi-major axes (true scale). They orbit in Saturn's equatorial plane = the
// ring plane, so saturnMoonGroup carries the same fixed 26.7° tilt as saturnTiltGroup
// (Saturn's axial tilt). That group is NOT min-dot scaled (unlike the ring), so the moons
// stay at their real orbital distances; only each moon mesh is min-dot-scaled for
// visibility. Iapetus alone has a strongly inclined orbit (~15.5°), so like Miranda at
// Uranus it gets a small tilt sub-container. Each moon is textured via its data `texture`.
const saturnMoonGroup = new THREE.Object3D();
saturnMoonGroup.rotation.z = 26.7 * (Math.PI / 180);   // share Saturn's equatorial/ring plane
scene.add(saturnMoonGroup);
const saturnMoons = [];
const saturnMoonOrbitLines = [];
if (saturn && saturn.userData.moons) {
  saturn.userData.moons.forEach(mn => {
    const mo = createMoon(mn.size, mn.dist, mn.speed, mn.color, mn.info,
                          mn.texture ? textureLoader.load(mn.texture) : null,
                          Math.random() * Math.PI * 2);
    mo.mesh.userData.name = mn.name;
    // Some Saturn moons are markedly non-spherical (e.g. Mimas, flattened by its spin and
    // scarred by the giant Herschel crater). When a moon carries a `shape`, swap the sphere
    // for its real observed triaxial geometry (+ craters); the texture keeps its sphere UVs.
    if (mn.shape) {
      mo.mesh.geometry.dispose();
      mo.mesh.geometry = makeMoonShapeGeometry(mn.size, mn.shape);
    }
    scene.remove(mo.group);        // createMoon parented it to the scene — move it into the ring plane

    // Inner six moons sit in the ring plane (parent = saturnMoonGroup). A moon with a real
    // inclination (Iapetus, and minor tilts for Mimas/Tethys) gets a tilt sub-container so
    // its orbit (and the orbit ring) sits at an angle to the equatorial plane.
    let parent = saturnMoonGroup;
    if (mn.incl) {
      const tilt = new THREE.Object3D();
      tilt.rotation.y = (mn.node || 0) * (Math.PI / 180);   // node: tilt direction (deg, optional)
      tilt.rotation.z = mn.incl * (Math.PI / 180);          // inclination to Saturn's equator (deg)
      saturnMoonGroup.add(tilt);
      parent = tilt;
    }
    parent.add(mo.group);
    saturnMoons.push(mo);

    // Sagitta-based segment count (chord gap < 0.1× the moon's radius), like Mars's and
    // Pluto's rings. A fixed 128-gon is fine for the inner moons, but Iapetus orbits so far
    // out (~3.56M km) that a 128-gon's chord bows inward by MORE than Iapetus's own radius —
    // so when you zoom in, the moon (on the true circle) sits visibly off the faceted line.
    const segs = Math.min(2048, Math.max(128,
      Math.ceil(Math.PI * Math.sqrt(mn.dist / (2 * 0.1 * mn.size)))));
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * mn.dist, 0, Math.sin(a) * mn.dist));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: ORBIT_COLORS.Saturn, transparent: true, opacity: 0.3 })
    );
    line.userData.ownerMesh = saturn;
    line.userData.moonMesh = mo.mesh;   // also hide when zoomed in close to the moon itself (e.g. far-orbiting Iapetus)
    parent.add(line);              // orbit ring rides the same (possibly inclined) plane as the moon
    orbitLines.push(line);
    saturnMoonOrbitLines.push(line);
  });
}

// 💨 Enceladus's south-polar cryovolcanic plumes. Water vapour + ice jets erupt from the
// "tiger stripe" fissures at the south pole. The vent positions below were traced on the
// surface by hand (unit directions in Enceladus's LOCAL frame, so they stay pinned to the
// south pole as the moon rotates and orbits). A GPU particle system emits soft jets from
// each vent, radially outward with a cone spread. Each particle's distance along its jet is
// `fract(phase0 + uFlow)`; uFlow advances ONLY as the simulation runs faster than 1× (the
// Math.max(0, speed − SPEED_REALLIFE) idiom used elsewhere), so the plume is frozen at 1×
// (LIVE) and visibly blows outward as you speed up time. Parented to the Enceladus mesh so
// it rides the moon and shares its min-dot scale.
// The vent positions below were placed with the live editor (then baked in): the
// south-polar "tiger stripe" cluster, as unit directions in Enceladus's LOCAL frame, so
// they stay pinned to the south pole as the moon rotates and orbits.
const ENCELADUS_VENTS = [
  [0.0782,-0.9878,-0.1350], [-0.0259,-0.9980,-0.0584], [-0.1305,-0.9909,0.0338],
  [0.1903,-0.9817,-0.0067], [0.0647,-0.9947,0.0796],   [-0.0588,-0.9879,0.1432],
  [0.2368,-0.9626,0.1316],  [0.1066,-0.9789,0.1744],   [-0.1999,-0.9721,-0.1226],
  [0.0864,-0.9958,-0.0309], [-0.0923,-0.9761,-0.1969], [-0.2557,-0.9667,-0.0121]
];
// Vapour look settings, tuned with the live editor then baked in: a faint, wispy,
// fairly short plume (very low opacity, normal/non-glowing blending).
const VAPOR = { opacity: 0.03, size: 0.87, length: 1.15, spread: 0.31, flow: 0.12, brightness: 0.51, glow: false };
let enceladusPlume = null;
(function buildEnceladusPlume() {
  const enc = saturnMoons.find(m => m.mesh.userData.name === "Enceladus");
  if (!enc) return;
  const encMesh = enc.mesh;
  const R = encMesh.userData.trueRadius;
  const PER_VENT = 130;
  const N = ENCELADUS_VENTS.length * PER_VENT;
  const position = new Float32Array(N * 3);   // jet base = vent point on the surface (local)
  const aDir     = new Float32Array(N * 3);   // outward jet direction (cone around the normal)
  const aPhase0  = new Float32Array(N);       // start offset along the jet (steady-state spread)
  const aSize    = new Float32Array(N);       // per-particle world size
  const up = new THREE.Vector3();
  let i = 0;
  ENCELADUS_VENTS.forEach(v => {
    const n = new THREE.Vector3(v[0], v[1], v[2]).normalize();   // surface normal at the vent
    up.set(0, 1, 0); if (Math.abs(n.dot(up)) > 0.9) up.set(1, 0, 0);
    const t1 = new THREE.Vector3().crossVectors(n, up).normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
    const base = n.clone().multiplyScalar(R);
    for (let k = 0; k < PER_VENT; k++) {
      position[i * 3] = base.x; position[i * 3 + 1] = base.y; position[i * 3 + 2] = base.z;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.pow(Math.random(), 0.7) * VAPOR.spread;  // cone half-spread
      const d = n.clone().addScaledVector(t1, Math.cos(ang) * rad)
                         .addScaledVector(t2, Math.sin(ang) * rad).normalize();
      aDir[i * 3] = d.x; aDir[i * 3 + 1] = d.y; aDir[i * 3 + 2] = d.z;
      aPhase0[i] = Math.random();
      aSize[i] = R * (0.20 + Math.random() * 0.20);
      i++;
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aDir', new THREE.BufferAttribute(aDir, 3));
  geo.setAttribute('aPhase0', new THREE.BufferAttribute(aPhase0, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R * 8);
  const uniforms = {
    uFlow:        { value: 0 },
    uPlumeLength: { value: R * VAPOR.length },
    uMoonScale:   { value: 1 },                 // refreshed each frame (min-dot scale)
    uSizeK:       { value: 600 },               // pixels per world-unit at unit depth
    uSizeMul:     { value: VAPOR.size },
    uOpacity:     { value: VAPOR.opacity },
    uBrightness:  { value: VAPOR.brightness }
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    // Normal alpha blending → scattering vapour (NOT additive/glowing).
    blending: VAPOR.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: `
      attribute vec3 aDir;
      attribute float aPhase0;
      attribute float aSize;
      uniform float uFlow, uPlumeLength, uMoonScale, uSizeK, uSizeMul;
      varying float vAlpha;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        float phase = fract(aPhase0 + uFlow);                 // 0 at the vent → 1 at the jet tip
        vec3 pos = position + aDir * (phase * uPlumeLength);
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        float worldR = aSize * uSizeMul * uMoonScale * (0.45 + phase * 1.7);   // jets widen as they rise
        gl_PointSize = clamp(worldR * uSizeK / max(1e-4, -mv.z), 1.0, 400.0);
        vAlpha = pow(1.0 - phase, 1.3) * smoothstep(0.0, 0.06, phase);  // fade in at base, out at tip
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      uniform float uOpacity, uBrightness;
      varying float vAlpha;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float d = length(gl_PointCoord - vec2(0.5)) * 2.0;    // 0 at centre → 1 at sprite edge
        float a = exp(-d * d * 2.8) * vAlpha * uOpacity;      // soft gaussian puff
        if (a < 0.002) discard;
        gl_FragColor = vec4(vec3(0.86, 0.91, 1.0) * uBrightness, a);
      }
    `
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  encMesh.add(pts);
  enceladusPlume = { points: pts, uniforms, encMesh, flow: 0, flowRate: VAPOR.flow };
})();

// 🟡 Titan's atmosphere. Titan is the only moon with a thick atmosphere — a nitrogen haze
// with orange photochemical smog. We add just a faint OUTWARD rim highlight: a thin BackSide
// shell ~9% larger than the moon. The planet occludes the shell over its disc (depth test),
// so only the annulus outside the limb shows — and the glow is brightest right at the limb,
// fading outward into space (the `uCoef − dot` term), never washing over the surface.
// Parented to the Titan mesh so it rides the orbit and shares the moon's min-dot scale.
// The rim is also masked by the Sun direction so only the SUNLIT limb glows — the night
// side shows no halo. Values below were dialed in with the live editor, then baked in.
(function buildTitanAtmosphere() {
  const titan = saturnMoons.find(m => m.mesh.userData.name === "Titan");
  if (!titan) return;
  const tMesh = titan.mesh;
  const R = tMesh.userData.trueRadius;
  const geo = new THREE.SphereGeometry(R * 1.09, 64, 48);   // thin shell → narrow rim
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor:    { value: new THREE.Color('#e7be62') },   // muted yellow-orange smog
      uCoef:     { value: 0.56 },                          // rim offset
      uPower:    { value: 14.0 },                          // falloff sharpness (tight rim)
      uStrength: { value: 1.67 }                           // overall brightness
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uCoef;
      uniform float uPower;
      uniform float uStrength;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        // On the (visible) annulus outside the limb the shell faces away from the camera, so
        // dot < 0; uCoef − dot is largest right at the planet's edge and shrinks outward →
        // a rim that hugs the limb and fades into space.
        float rim = pow(max(0.0, uCoef - dot(vNormal, vView)), uPower);
        // Sun mask — only the sunlit limb glows. We render the FAR side of the shell (BackSide),
        // whose normal points away from the camera; reflect it across the screen plane to the
        // NEAR-hemisphere normal at this same screen position, then test against the Sun (which
        // sits at the world origin). This makes the glow follow the lit side as seen by the
        // viewer: a full ring when looking at the day side, none on the night side.
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 nearN = normalize(N - 2.0 * dot(N, V) * V);
        float sunMask = smoothstep(0.0, 0.40, dot(nearN, normalize(-vWorldPos)));
        gl_FragColor = vec4(uColor, rim * uStrength * sunMask);
      }
    `
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.frustumCulled = false;
  shell.renderOrder = 3;
  tMesh.add(shell);
})();

// 🟡 Venus's atmosphere. Venus is wrapped in a thick, opaque, highly reflective sulphuric-acid
// cloud deck — from space it's a featureless pale-yellow ball with a bright hazy limb. Same
// fresnel rim shell as Titan, but pale cream-yellow and a touch broader/softer (Venus's
// atmosphere is much deeper and brighter), sun-masked to the lit limb only.
let venusAtmoShell = null;
(function buildVenusAtmosphere() {
  const venusMesh = meshes.find(m => m.userData.name === "Venus");
  if (!venusMesh) return;
  const R = venusMesh.userData.size;
  const geo = new THREE.SphereGeometry(R * 1.09, 64, 48);   // same thin rim as Titan
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor:    { value: new THREE.Color('#d8954a') },   // warm orange-tan, matching Venus's cloud colour
      uCoef:     { value: 0.56 },                          // same rim numbers as Titan (subtler)
      uPower:    { value: 14.0 },
      uStrength: { value: 1.67 }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uCoef;
      uniform float uPower;
      uniform float uStrength;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float rim = pow(max(0.0, uCoef - dot(vNormal, vView)), uPower);
        // Reflect the BackSide (far) normal to the near hemisphere, then mask by the Sun (at
        // the world origin) so only the sunlit limb glows — see the Titan atmosphere for why.
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 nearN = normalize(N - 2.0 * dot(N, V) * V);
        float sunMask = smoothstep(0.0, 0.40, dot(nearN, normalize(-vWorldPos)));
        gl_FragColor = vec4(uColor, rim * uStrength * sunMask);
      }
    `
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.frustumCulled = false;
  shell.renderOrder = 3;
  venusMesh.add(shell);
  venusAtmoShell = shell;
})();

// Venus atmosphere on/off — driven by a button in Venus's info panel. Hiding the atmosphere
// swaps the cloud-deck map for the 8k radar surface map AND hides the hazy fresnel rim shell;
// showing it restores both.
let venusAtmoVisible = true;
function syncVenusAtmoBtn() {
  const btn = document.getElementById("venusAtmoToggleBtn");
  if (btn) btn.textContent = venusAtmoVisible ? "Hide Atmosphere" : "Show Atmosphere";
}
function toggleVenusAtmosphere() {
  venusAtmoVisible = !venusAtmoVisible;
  const venusMesh = meshes.find(m => m.userData.name === "Venus");
  if (venusMesh) {
    venusMesh.material.map = venusAtmoVisible ? venusTexture : venusSurfaceTexture;
    venusMesh.material.needsUpdate = true;
  }
  if (venusAtmoShell) venusAtmoShell.visible = venusAtmoVisible;
  syncVenusAtmoBtn();
}
window.toggleVenusAtmosphere = toggleVenusAtmosphere;

// 🌍 Earth's atmosphere glow. Same sun-masked fresnel rim shell as Venus/Titan, but white
// (Earth's air scatters to a bright limb). The shell uses the SAME R*1.09 radius as Venus:
// the rim shader is actually brightest toward the shell's interior, and it only reads as a
// clean edge because the opaque planet occludes that interior. A tighter shell (e.g. R*1.04)
// sits too close to the surface for the log-depth buffer to resolve, so the planet stops
// occluding it and the whole body glows. Hidden/shown by the same Earth atmosphere button as
// the cloud layer (see toggleEarthAtmosphere).
let earthAtmoShell = null;
(function buildEarthAtmosphere() {
  const earthMesh = meshes.find(m => m.userData.name === "Earth");
  if (!earthMesh) return;
  const R = earthMesh.userData.size;
  const geo = new THREE.SphereGeometry(R * 1.09, 64, 48);   // same rim gap as Venus (avoids body glow)
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor:    { value: new THREE.Color('#ffffff') },   // white limb glow
      uCoef:     { value: 0.56 },                          // same rim numbers as Venus/Titan
      uPower:    { value: 14.0 },
      uStrength: { value: 1.67 }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uCoef;
      uniform float uPower;
      uniform float uStrength;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float rim = pow(max(0.0, uCoef - dot(vNormal, vView)), uPower);
        // Reflect the BackSide (far) normal to the near hemisphere, then mask by the Sun (at
        // the world origin) so only the sunlit limb glows — see the Titan atmosphere for why.
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 nearN = normalize(N - 2.0 * dot(N, V) * V);
        float sunMask = smoothstep(0.0, 0.40, dot(nearN, normalize(-vWorldPos)));
        gl_FragColor = vec4(uColor, rim * uStrength * sunMask);
      }
    `
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.frustumCulled = false;
  shell.renderOrder = 3;
  earthMesh.add(shell);
  earthAtmoShell = shell;
})();

// ☄️ Asteroid belt + Kuiper belt — sparse, faint particle bands in the ecliptic (XZ). In
// reality the belt is mostly empty space (asteroids are ~1M km apart) and invisible from afar,
// so we use the SAME logic as the background stars (see starfield): each point shrinks with
// distance (gl_PointSize = sizeScale/d) AND fades out beyond a fade range. So far out the belt
// vanishes instead of piling into a bright band, and only resolves into sparse dots when you
// fly in close. Distributed in an annulus with a triangular vertical falloff for the real
// inclination spread. Steady backdrop — per-particle Keplerian orbiting is not modelled.
function makeBelt(count, rInner, rOuter, vHalfFrac, color, opacity, sizeScale, sizeMax, fadeNear, fadeFar) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = rInner + Math.random() * (rOuter - rInner);
    const a = Math.random() * Math.PI * 2;
    const y = (Math.random() + Math.random() - 1) * r * vHalfFrac;   // triangular: most near the plane
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), rOuter * 1.2);
  const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: {
      uColor:     { value: new THREE.Color(color) },
      uOpacity:   { value: opacity },
      uSizeScale: { value: sizeScale },
      uSizeMax:   { value: sizeMax },
      uNear:      { value: fadeNear },
      uFar:       { value: fadeFar }
    },
    transparent: true, depthWrite: false,
    vertexShader: `
      uniform float uSizeScale, uSizeMax, uNear, uFar;
      varying float vFade;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = length(mv.xyz);                  // distance from camera
        vFade = 1.0 - smoothstep(uNear, uFar, d);  // fade out as you pull away → belt vanishes from afar
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
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
}
// 1 AU = 10 units. Asteroid belt ≈ 2.1–3.3 AU (Ceres sits at 27.7); Kuiper belt ≈ 30–50 AU.
// Fewer, fainter points than a dense field; fade ranges are tuned per belt's scale so each
// only shows when the camera is reasonably close to it.
const asteroidBelt = makeBelt(4000, 21, 33, 0.06, 0x9a8a76, 0.5,  34,  2.2,  22,  85);
const kuiperBelt   = makeBelt(4500, 300, 500, 0.09, 0x9aa7b0, 0.4, 360, 2.0, 260, 1000);

// 👇 ADD IT HERE (outside the loop)
meshes.forEach(m => {
  m.castShadow = true;
  m.receiveShadow = true;
});

// ── Min-dot visibility (NASA Eyes) ──────────────────────────────────────────
// Every body is built at its TRUE radius, so at solar-system zoom each one is far
// smaller than a pixel. Each frame we scale a body up so its on-screen radius is
// at least MIN_DOT_PX, then relax back toward scale 1 (true size) as you approach
// — a dot from afar, a real sphere up close. Children (e.g. Earth's clouds) ride
// the parent's scale; the Moon, Jupiter's moons and Saturn's rings are scaled
// against their own true size so they keep correct proportions to their planet.
const MIN_DOT_PX = 2.6;
const _mdPos = new THREE.Vector3();
function minDotScale(obj, trueRadius) {
  obj.getWorldPosition(_mdPos);
  const d = camera.position.distanceTo(_mdPos);
  const worldPerPx = (2 * d * Math.tan((camera.fov * Math.PI / 180) / 2)) / window.innerHeight;
  const s = Math.max(1, (worldPerPx * MIN_DOT_PX) / trueRadius);
  obj.scale.setScalar(s);
  return s;
}
// Sun glow — the Sun is a light source. SIZE: a fixed on-screen ball that keeps
// the same size as you zoom out (it does NOT shrink), and a filled bloom that
// scales with the disc when you zoom in — surrounding it, never a centre dot or
// a hollow ring (the gradient is a solid point of light, brightest at centre).
// BRIGHTNESS
// carries the effect: highest right at the Sun (a blinding orange bloom) and
// fading gradually (log-smooth, starting the moment you pull back) to a
// still-bright floor far away.
const SUN_GLOW_FAR_PX  = 34;   // fixed glow-ball radius (px) when zoomed out — stays this size
const SUN_GLOW_RIM_MUL = 2.0;  // glow radius as a multiple of the disc when zoomed in: disc edge lands at gradient fraction 0.5, so the bloom covers the disc and a full disc-radius of halo surrounds the Sun
const SUN_GLOW_NEAR = 0.06;    // distance (units) at/under which the glow is fully bright (≈ Sun filling the screen); fades the moment you pull back
const SUN_GLOW_FAR  = 300;     // distance (units) at which the glow reaches its faint floor
const SUN_GLOW_MAX  = 1.0;     // opacity right at the Sun
const SUN_GLOW_MIN  = 0.22;    // opacity far away — faded, just a faint ember
const SUN_CORE_MIN_PX = 1.3;   // Sun core min-dot (smaller than planets' 2.6) so the soft glow, not a hard disc, dominates far away
function updateSunGlow() {
  const tanHalf = Math.tan((camera.fov * Math.PI / 180) / 2);
  const dSun = camera.position.length();           // Sun sits at the origin
  const worldPerPx = (2 * dSun * tanHalf) / window.innerHeight;
  const sunPx = sun.userData.trueRadius / worldPerPx; // true on-screen disc radius
  // Sun core: a small min-dot so when far the Sun is a tiny hot point inside the
  // soft bloom (reads as a light source) rather than a hard 2.6px orange disc.
  sun.scale.setScalar(Math.max(1, (SUN_CORE_MIN_PX * worldPerPx) / sun.userData.trueRadius));
  // Park the glow just in front of the Sun's near surface, along the camera ray.
  // With depthTest on, this stops the Sun's own front face from occluding the
  // glow (the sprite sits ahead of it) while any object passing between the
  // camera and the Sun still does. A billboard's whole quad lies at one depth,
  // so occlusion by a transiting planet is clean and per-pixel.
  const renderedR = sun.userData.trueRadius * sun.scale.x;
  // Sit the glow strictly IN FRONT of the whole Sun sphere (10% nearer than its
  // closest point), not tangent to its near pole. At offset = renderedR the flat
  // billboard just touches the pole and the additive glow z-fights the surface
  // under the log depth buffer, dropping out in a circular patch (a dark "bite").
  // dSun*0.9 caps it in front of the camera for the extreme true-scale close-ups.
  const offset = Math.min(dSun - (dSun - renderedR) * 0.9, dSun * 0.9);
  glowMesh.position.copy(camera.position).setLength(offset);
  // Fixed-pixel ball when zoomed out; scales with the disc when zoomed in.
  // Convert to world size at the sprite's own (closer) depth so the offset
  // doesn't change its apparent on-screen size.
  const spriteWorldPerPx = (2 * (dSun - offset) * tanHalf) / window.innerHeight;
  const glowPx = Math.max(SUN_GLOW_FAR_PX, SUN_GLOW_RIM_MUL * sunPx);
  glowMesh.scale.setScalar(glowPx * spriteWorldPerPx * 2);
  // Brightest at the Sun, fading slowly across the whole zoom range (log scale so
  // it eases off immediately as you pull back, not all at once far out).
  const t = Math.min(1, Math.max(0,
    (Math.log(dSun) - Math.log(SUN_GLOW_NEAR)) / (Math.log(SUN_GLOW_FAR) - Math.log(SUN_GLOW_NEAR))));
  glowMesh.material.opacity = SUN_GLOW_MAX - (SUN_GLOW_MAX - SUN_GLOW_MIN) * t;
}
function applyMinDots() {
  updateSunGlow(); // scales the Sun core (smaller min-dot) + its glow

  meshes.forEach(m => minDotScale(m, m.userData.size));
  // Transformed Mars replaces the (hidden) Mars mesh, so min-dot it the same way
  // or it would vanish at distance while every other planet stays a visible dot.
  if (marsTransformed && terraformedMarsModel) minDotScale(terraformedMarsModel, marsMesh.userData.size);
  if (moon) minDotScale(moon, moon.userData.trueRadius);
  jupiterMoons.forEach(jm => minDotScale(jm.mesh, jm.mesh.userData.trueRadius));
  plutoMoons.forEach(pm => minDotScale(pm.mesh, pm.mesh.userData.trueRadius));
  neptuneMoons.forEach(nm => minDotScale(nm.mesh, nm.mesh.userData.trueRadius));
  uranusMoons.forEach(um => minDotScale(um.mesh, um.mesh.userData.trueRadius));
  saturnMoons.forEach(sm => minDotScale(sm.mesh, sm.mesh.userData.trueRadius));
  marsMoons.forEach(mm => minDotScale(mm.mesh, mm.mesh.userData.trueRadius));
  haumeaMoons.forEach(hm => minDotScale(hm.mesh, hm.mesh.userData.trueRadius));
  erisMoons.forEach(em => minDotScale(em.mesh, em.mesh.userData.trueRadius));
  // Saturn's rings: match the body's apparent size and keep the shadow term correct.
  const saturnS = saturn.scale.x; // set by the meshes loop above
  saturnTiltGroup.scale.setScalar(saturnS);
  ringUniforms.saturnRadius.value = saturn.userData.size * saturnS;
  // The body's ring-shadow uses the same rendered radius, so its ring-radii mapping matches.
  if (saturnRingShadow) saturnRingShadow.uSaturnRadius.value = saturn.userData.size * saturnS;
  // Neptune's rings track the body's apparent size the same way.
  neptuneTiltGroup.scale.setScalar(neptuneMesh.scale.x);
  neptuneRingUniforms.neptuneRadius.value = neptuneMesh.userData.size * neptuneMesh.scale.x;
  uranusTiltGroup.scale.setScalar(uranusMesh.scale.x);
  // Jupiter's faint ring tracks the body's apparent size the same way.
  jupiterTiltGroup.scale.setScalar(jupiter.scale.x);
  jupiterRingUniforms.jupiterRadius.value = jupiter.userData.size * jupiter.scale.x;
}

// Hide a body's orbit ring once you've zoomed in close enough that the body is
// large on screen (NASA Eyes behaviour) — a thin ring cutting through a big
// planet looks wrong, and at true scale the planet sits exactly on the line so
// it reads as "floating off" the ring. The ring returns as you zoom out. Respects
// the global orbitsVisible toggle; callers run it only in the heliocentric view.
const ORBIT_HIDE_ABOVE_PX = 22;     // hide a ring when its body's on-screen radius exceeds this
const _orbPos = new THREE.Vector3();
// On-screen radius (in px) of a body's true disc at the current camera distance.
function bodyApparentPx(mesh, tanHalf) {
  mesh.getWorldPosition(_orbPos);
  const d = camera.position.distanceTo(_orbPos);
  const worldPerPx = (2 * d * tanHalf) / window.innerHeight;
  return (mesh.userData.size || mesh.userData.trueRadius || 0) / worldPerPx;
}

function updateOrbitRingProximity() {
  const tanHalf = Math.tan((camera.fov * Math.PI / 180) / 2);
  for (const line of orbitLines) {
    const owner = line.userData.ownerMesh;
    if (!owner) continue;
    // Mercury's ring stays hidden while its precession trail is showing.
    if (line === mercuryOrbitLine && mercuryTrailMode) { line.visible = false; continue; }
    // A ring hides once the body you'd be zooming toward fills enough of the screen.
    // For a moon ring that's EITHER the parent planet (zoom into the planet) OR the moon
    // itself — without the latter, flying straight to a far moon (e.g. Iapetus, which
    // orbits Saturn at ~3.56M km) leaves the planet too small to ever trip the threshold,
    // so the ring would never disappear.
    let apparentPx = bodyApparentPx(owner, tanHalf);
    if (line.userData.moonMesh) {
      apparentPx = Math.max(apparentPx, bodyApparentPx(line.userData.moonMesh, tanHalf));
    }
    line.visible = orbitsVisible && apparentPx < ORBIT_HIDE_ABOVE_PX;
  }
}

// Explicit list of every heliocentric object that should be hidden in alternate views.
// Using an explicit array (not scene.children sweep) so lights are never accidentally touched
// and nothing is missed when new objects are added.
const helioObjects = [
  sun,
  glowMesh,
  moonGroup,
  saturnTiltGroup,
  neptuneTiltGroup,
  uranusTiltGroup,
  ...meshes,
  ...orbitLines,
  ...jupiterMoons.map(jm => jm.group),
  plutoTiltGroup,
  ...neptuneMoonTilts,
  uranusMoonGroup,
  jupiterTiltGroup,
  asteroidBelt,
  kuiperBelt,
];

// Click interaction
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// TEMP (size-comparison Earth): Sun panel with a button to toggle the true-size
// Earth parked beside the Sun. Mirrors the Mars terraform-toggle pattern. Remove
// alongside the tempCompareEarth block.
function refreshSunPanel() {
  const pc = document.getElementById("panelContent");
  const btnStyle = "background:rgba(255,255,255,0.15);color:white;border:1px solid rgba(255,255,255,0.4);padding:6px 12px;cursor:pointer;border-radius:4px;font-size:13px;margin-bottom:10px;width:100%;display:block";
  const earthLabel = tempCompareEarth.visible ? "Hide Earth (size comparison)" : "Show Earth (size comparison)";
  const jupiterLabel = tempCompareJupiter.visible ? "Hide Jupiter (size comparison)" : "Show Jupiter (size comparison)";
  const btnHtml =
    `<button id="sunCompareEarthBtn" style="${btnStyle}">${earthLabel}</button>` +
    `<button id="sunCompareJupiterBtn" style="${btnStyle}">${jupiterLabel}</button>`;
  const splitAt = SUN_INFO.indexOf('<br><br>') + '<br><br>'.length;
  pc.innerHTML = SUN_INFO.substring(0, splitAt) + btnHtml + SUN_INFO.substring(splitAt);
  document.getElementById("sunCompareEarthBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    tempCompareEarth.visible = !tempCompareEarth.visible;
    refreshSunPanel(); // update the button label
  });
  document.getElementById("sunCompareJupiterBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    tempCompareJupiter.visible = !tempCompareJupiter.visible;
    refreshSunPanel(); // update the button label
  });
}

// Mercury panel: toggle the precession trail + set how far to fast-forward the
// precession. This is the PRECESSION rate per orbit — 1× is the true ~0.1″/orbit
// (43″/century) drift, NOT real-time playback (Mercury is sped up to a watchable
// pace so the trail can trace out). Higher exaggerates the drift to build the
// rosette. The normal simulation clock is never touched.
function mercuryDemoLabel() {
  return mercuryDemoMult === 1
    ? "1× — true rate (~0.1″/orbit)"
    : mercuryDemoMult.toLocaleString() + "× fast-forward";
}
function refreshMercuryPanel() {
  const pc = document.getElementById("panelContent");
  const info = mercuryMesh.userData.info;
  const btnStyle = "background:rgba(255,255,255,0.15);color:white;border:1px solid rgba(255,255,255,0.4);padding:6px 12px;cursor:pointer;border-radius:4px;font-size:13px;margin-bottom:8px;width:100%;display:block";
  const trailLabel = mercuryTrailMode ? "Hide Precession Trail" : "Show Precession Trail";
  let ctrl = `<button id="mercTrailBtn" style="${btnStyle}">${trailLabel}</button>`;
  // In trail mode, a Pause button (under Hide) freezes Mercury + the elapsed time.
  if (mercuryTrailMode) {
    ctrl += `<button id="mercPauseBtn" style="${btnStyle}">${mercuryTrailPaused ? "Resume Spinning" : "Pause Spinning"}</button>`;
  }
  const boxStyle = "font-size:11.5px;opacity:0.9;line-height:1.55;background:rgba(255,255,255,0.06);border-left:3px solid rgba(255,180,90,0.8);padding:9px 11px;border-radius:4px;margin-bottom:10px";
  if (!mercuryTrailMode) {
    // Short teaser in the normal panel so you know what the button does.
    ctrl +=
      `<div style="${boxStyle}">Mercury's orbit slowly <b>rotates</b> over time — the famous effect Einstein's relativity explained. It's far too slow to see in real life, so click above to draw Mercury's path and fast-forward it into view.</div>`;
  } else {
    // Plain-language explanation + the speed control (which replaces the normal
    // speed bar) and the elapsed-time readout, only while the trail is showing.
    const exp = Math.round(Math.log10(mercuryDemoMult));
    ctrl +=
      `<div style="${boxStyle}">` +
        `<b>What you're seeing</b><br>` +
        `Mercury's orbit is a slightly squashed circle (an ellipse). Over time the whole oval slowly turns, so the point where Mercury swings closest to the Sun keeps shifting. Its path tracing that shift makes this flower-like <b>"rosette."</b><br><br>` +
        `<b>How slow it really is</b><br>` +
        `In reality the orbit turns only about <b>43 arcseconds per century</b> — roughly one-hundredth of a degree every 100 years (~0.1″ each lap). One complete turn takes about <b>3 million years</b>. Explaining this tiny extra drift was one of the first great confirmations of Einstein's general relativity.<br><br>` +
        `<b>The speed slider</b><br>` +
        `At <b>1×</b> the drift moves at that true real-life rate, so you'd never see it budge. Slide right to <b>fast-forward</b> — bigger numbers pack more centuries into each second, so the rosette fills in faster. (Mercury's own orbit is sped up too, just so you can watch it lap the Sun.)<br><br>` +
        `<b>"Elapsed"</b> below shows how much real time the drift on screen would actually represent — so even a small twist means many thousands of years.` +
      `</div>` +
      `<div style="font-size:12px;opacity:0.85;margin-bottom:4px">Precession speed: <span id="mercDemoLabel">${mercuryDemoLabel()}</span></div>` +
      `<input id="mercDemoSlider" type="range" min="0" max="7" step="1" value="${exp}" style="width:100%;margin-bottom:6px">` +
      `<div id="mercElapsed" style="font-size:12px;opacity:0.85;margin-bottom:10px"></div>`;
  }
  const splitAt = info.indexOf('<br><br>') + '<br><br>'.length;
  pc.innerHTML = info.substring(0, splitAt) + ctrl + info.substring(splitAt);
  document.getElementById("mercTrailBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMercuryTrail();
  });
  const pauseBtn = document.getElementById("mercPauseBtn");
  if (pauseBtn) pauseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    mercuryTrailPaused = !mercuryTrailPaused;
    refreshMercuryPanel(); // update the button label
  });
  const ds = document.getElementById("mercDemoSlider");
  if (ds) ds.addEventListener("input", (e) => {
    e.stopPropagation();
    mercuryDemoMult = Math.pow(10, parseFloat(e.target.value));
    document.getElementById("mercDemoLabel").textContent = mercuryDemoLabel();
  });
}
function toggleMercuryTrail() {
  mercuryTrailMode = !mercuryTrailMode;
  const normalBar = document.getElementById('normalSpeedControls');
  const simDisplay = document.getElementById('simTimeDisplay');
  if (mercuryTrailMode) {
    // The demo drives Mercury's orbit + precession on its own (see animate), so the
    // sim clock is left alone. Hide the normal speed bar (precession bar is the only
    // speed control) and the Simulation Time readout (the demo shows its own elapsed
    // time in the Mercury panel) while the trail is on — the Reset to Now button stays.
    if (normalBar) normalBar.style.display = 'none';
    if (simDisplay) simDisplay.style.display = 'none';
    mercuryTrailPaused = false; // always start spinning
    mercuryPerihelion = 0;   // fresh rosette
    mercuryTrailCount = 0;
    mercuryPrevM = mercuryMesh.userData.angle;
    mercuryTrailGeom.setDrawRange(0, 0);
    mercuryTrail.visible = true;
    if (mercuryOrbitLine) mercuryOrbitLine.visible = false;
  } else {
    if (normalBar) normalBar.style.display = 'block';
    if (simDisplay) simDisplay.style.display = '';
    mercuryPerihelion = 0;        // return Mercury to its base (un-drifted) inclined orbit
    mercuryTrail.visible = false;
    if (mercuryOrbitLine) mercuryOrbitLine.visible = orbitsVisible;
  }
  refreshMercuryPanel();
}

function refreshMarsPanel() {
  const pc = document.getElementById("panelContent");
  const info = marsTransformed ? marsTransformedInfo : marsOriginalInfo;
  const label = marsTransformed ? "Restore Mars" : "Transform Mars";
  const btnHtml = `<button id="marsTransformBtn" style="background:rgba(255,255,255,0.15);color:white;border:1px solid rgba(255,255,255,0.4);padding:6px 12px;cursor:pointer;border-radius:4px;font-size:13px;margin-bottom:10px;width:100%;display:block">${label}</button>`;
  // Insert the button right after the first <br><br> (after the heading)
  const splitAt = info.indexOf('<br><br>') + '<br><br>'.length;
  pc.innerHTML = info.substring(0, splitAt) + btnHtml + info.substring(splitAt);
  document.getElementById("marsTransformBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (marsTransformed) restoreMars(); else transformMars();
  });
}

function transformMars() {
  if (marsTransformed) return;
  marsTransformed = true;
  refreshMarsPanel();

  const marsRadius = marsMesh.userData.size;
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

  function applyTexQuality(tex) {
    tex.anisotropy = maxAnisotropy;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.offset.x = 0.5;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
  }

  const colorTex = textureLoader.load("ChatGPT Image May 19, 2026, 09_39_22 PM.png", applyTexQuality);
  // city_lights.png is the dedicated Mars night map (1774×887, within GPU limits):
  // dim continents + city lights baked in, used directly as the night side.
  const nightTex = textureLoader.load("city_lights.png", applyTexQuality);
  const cloudTex = textureLoader.load("clouds.png", applyTexQuality);

  // ShaderMaterial: city lights only appear on the night side and fade with the terminator
  terraformedMarsMaterial = new THREE.ShaderMaterial({
    uniforms: {
      dayTexture:   { value: colorTex },
      nightTexture: { value: nightTex },
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
      uniform sampler2D dayTexture;
      uniform sampler2D nightTexture;
      uniform vec3 sunDirection;
      varying vec2 vUv;
      varying vec3 vNormal;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float intensity = dot(vNormal, sunDirection);
        float blend = smoothstep(-0.15, 0.15, intensity);
        vec4 day   = texture2D(dayTexture,   vUv);
        vec4 night = texture2D(nightTexture, vUv);
        // Night side is the dedicated night map directly (like Earth) — its dim
        // continents and city lights are already baked in at the right brightness.
        gl_FragColor = vec4(mix(night.rgb, day.rgb, blend), 1.0);
      }
    `
  });

  terraformedMarsModel = new THREE.Group();
  terraformedMarsModel.add(new THREE.Mesh(
    new THREE.SphereGeometry(marsRadius, 64, 64),
    terraformedMarsMaterial
  ));

  // Cloud layer — same sun-lit shader as Earth's clouds (NORMAL alpha blending): dense
  // cloud reads as a solid white mass on the day side, dims toward a 0.1 floor across a
  // soft terminator, and stays faintly visible on the night side. clouds.png carries
  // coverage in its ALPHA channel (Earth's grayscale map used .r). sunDirection is
  // updated each frame alongside the terraformed-surface shader. No white glow ring.
  const cloudMat = new THREE.ShaderMaterial({
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
        float cloud = texture2D(cloudTexture, vUv).a;    // coverage (clouds.png: alpha channel)
        float intensity = dot(normalize(vNormal), sunDirection);
        float lit = smoothstep(-0.2, 0.3, intensity);    // wide, soft day↔night transition
        float brightness = mix(0.25, 1.0, lit);          // raised night floor so dark-side clouds stay visible
        gl_FragColor = vec4(vec3(brightness), cloud);    // clouds stay everywhere, just darker at night
      }
    `
  });
  marsCloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(marsRadius, 64, 64),
    cloudMat
  );
  marsCloudMesh.scale.setScalar(1.005);   // 0.5% above the surface — matches Earth
  terraformedMarsModel.add(marsCloudMesh);

  scene.add(terraformedMarsModel);
  terraformedMarsModel.position.copy(marsMesh.position);
  terraformedMarsModel.rotation.copy(marsMesh.rotation);
  marsMesh.visible = false;

  console.log("Transformed Mars optimized — GLB file can now be deleted");
}

function restoreMars() {
  if (!marsTransformed) return;
  marsTransformed = false;
  if (terraformedMarsModel) {
    scene.remove(terraformedMarsModel);
    terraformedMarsModel = null;
  }
  marsCloudMesh = null;
  terraformedMarsMaterial = null;
  marsMesh.visible = true;
  lockedObject = marsMesh; // re-establish camera lock so it doesn't drift to origin
  refreshMarsPanel();
}

// Build an exponential-distance interpolator about a focal point, for fly-tos that
// span a huge scale range. Returns fn(p, out) that writes the camera position at
// eased progress p∈[0,1]: the distance to the focal shrinks geometrically (constant
// visual zoom rate) while the view direction lerps. Endpoints match start/end exactly,
// so the only change vs a plain lerp is that the final approach no longer whips past.
function expFly(startPos, endPos, focal) {
  const sV = startPos.clone().sub(focal), eV = endPos.clone().sub(focal);
  const sD = Math.max(sV.length(), 1e-6), eD = Math.max(eV.length(), 1e-6);
  const sDir = sV.normalize(), eDir = eV.clone().normalize();
  const logR = Math.log(eD / sD);
  const _dir = new THREE.Vector3();
  return (p, out) => {
    const dist = sD * Math.exp(logR * p);
    _dir.copy(sDir).lerp(eDir, p).normalize();
    out.copy(focal).addScaledVector(_dir, dist);
  };
}

function flyToObject(obj, fromList = false) {
  if (!obj) return;

  // Ignore a canvas re-click on the body we're already focused on (e.g. an accidental
  // click while holding the mouse down to drag/orbit it) — re-flying would needlessly
  // zoom back out to the framing distance. Only the bodies panel (fromList=true) forces
  // a re-frame; to re-fly from the canvas, first leave the body (press Escape, or click
  // a different body) so it's no longer the locked one.
  if (!fromList && obj === lockedObject) return;

  // Walk up to find an object with info
  let infoObj = obj;
  while (infoObj && !infoObj.userData.info) {
    infoObj = infoObj.parent;
  }
  if (!infoObj || !infoObj.userData.info) return;

  document.getElementById("panel").style.display = "block";
  if (infoObj.userData.name === "Mars") {
    refreshMarsPanel();
  } else if (infoObj.userData.name === "Sun") {
    refreshSunPanel();
  } else if (infoObj.userData.name === "Mercury") {
    refreshMercuryPanel();
  } else {
    document.getElementById("panelContent").innerHTML = infoObj.userData.info;
    if (infoObj.userData.name === "Earth") { syncEarthAtmoBtn(); syncEarthGlowBtn(); }
    if (infoObj.userData.name === "Venus") syncVenusAtmoBtn();
  }
  document.getElementById("backToList").style.display = "inline-block";

  // Cancel any previous fly animation
  const myGeneration = ++flyGeneration;
  isFlyingTo = true;

  // Force world matrix update so getWorldPosition is accurate
  scene.updateMatrixWorld(true);

  const targetPos = new THREE.Vector3();
  obj.getWorldPosition(targetPos);

  // If position is still at origin, wait one frame and retry
  if (targetPos.lengthSq() < 0.001 && infoObj.userData.name !== "Sun") {
    requestAnimationFrame(() => {
      if (myGeneration !== flyGeneration) return; // superseded
      flyToObject(obj, fromList);
    });
    return;
  }

  // Only lock after we have a valid position
  lockedObject = obj;

  const startPos = camera.position.clone();

  // Frame at a fixed multiple of the body's TRUE radius (offset scales with the
  // real size, so planets and the Sun are all nicely framed at true scale).
  const size = obj.userData.size || obj.userData.trueRadius || 0.2;
  const offset = new THREE.Vector3(0, size * 2, size * 8);

  // We glide by lerping the camera's OFFSET from the target (not its absolute world
  // position), and every frame place the camera at (current target position + offset).
  // Because the camera rides the target's current position, the body stays rock-stable
  // in view for the whole glide — only the zoom (offset magnitude) changes. This makes
  // the zoom-in natural even at extreme time-warp, when the body races across space:
  // no swinging, no "flew to where it used to be" (far), no overshoot (too close).
  const startOffset = startPos.clone().sub(targetPos);   // current camera offset from the target

  // Let the zoom-in get proportionally close to whatever body we're framing — tiny
  // bodies (dwarf planets, Pluto's moons) need a far smaller min distance than the big
  // planets, or you'd be clamped many radii away (a dot) instead of ~2× (filling view).
  controls.minDistance = Math.max(0.0000001, size * 2.0);

  // Hand the glide to animate() (see the camera-follow block there): it lerps the offset
  // from its current value to `offset` over ~3s while always parking the camera at
  // (current target position + offset). Running it there — after the body's position is
  // updated for the frame — keeps the body centred even at extreme time-warp.
  _flyObj = obj;
  _flyOffset.copy(offset);
  _flyStartOffset.copy(startOffset);
  _flyStartMs = performance.now();
}

window.addEventListener("click", e => {
  // Ignore clicks on UI elements — only handle canvas clicks
  if (e.target !== renderer.domElement) return;
  // Spaceship Earth has no clickable bodies; galactic view handles its own
  // clickable marker below, so only bail out here for spaceship view.
  // The Kepler system scene has its own dedicated click handler.
  if (spaceshipViewActive || viewManager.active) return;

  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Galactic view: only the Kepler-22 marker is clickable → enter its system
  if (galacticViewActive) {
    const kHits = raycaster.intersectObject(galKeplerMarker, true);
    if (kHits.length > 0) viewManager.enter('kepler');
    return;
  }

  // Milky Way galaxy view: clicking the Kepler-22 System dot opens its system
  if (keplerSystemMarker.visible) {
    const mwHits = raycaster.intersectObject(keplerSystemMarker, true);
    if (mwHits.length > 0) { flyToKeplerDot(); return; }
  }

  // Check Jupiter moons first — hide Jupiter temporarily so it can't block
  const jupiterMesh = meshes.find(m => m.userData.name === "Jupiter");
  const jupiterWasVisible = jupiterMesh.visible;
  jupiterMesh.visible = false;
  const jupiterMoonMeshes = jupiterMoons.map(jm => jm.mesh);
  const moonHits = raycaster.intersectObjects(jupiterMoonMeshes, false);
  jupiterMesh.visible = jupiterWasVisible;

  if (moonHits.length > 0) {
    flyToObject(moonHits[0].object);
    return;
  }

  // Check Pluto's moons (hide Pluto so it can't block the tiny, close ones)
  if (plutoMoons.length && plutoMesh) {
    const plutoWasVisible = plutoMesh.visible;
    plutoMesh.visible = false;
    const pHits = raycaster.intersectObjects(plutoMoons.map(pm => pm.mesh), false);
    plutoMesh.visible = plutoWasVisible;
    if (pHits.length > 0) { flyToObject(pHits[0].object); return; }
  }

  // Check Neptune's moon (hide Neptune so it can't block close-orbiting Triton)
  if (neptuneMoons.length && neptuneMesh) {
    const neptuneWasVisible = neptuneMesh.visible;
    neptuneMesh.visible = false;
    const nHits = raycaster.intersectObjects(neptuneMoons.map(nm => nm.mesh), false);
    neptuneMesh.visible = neptuneWasVisible;
    if (nHits.length > 0) { flyToObject(nHits[0].object); return; }
  }

  // Check Uranus's moons (hide Uranus so it can't block them)
  if (uranusMoons.length && uranusMesh) {
    const uranusWasVisible = uranusMesh.visible;
    uranusMesh.visible = false;
    const uHits = raycaster.intersectObjects(uranusMoons.map(um => um.mesh), false);
    uranusMesh.visible = uranusWasVisible;
    if (uHits.length > 0) { flyToObject(uHits[0].object); return; }
  }

  // Check Saturn's moons (hide Saturn so it can't block them)
  if (saturnMoons.length && saturn) {
    const saturnWasVisible = saturn.visible;
    saturn.visible = false;
    const sHits = raycaster.intersectObjects(saturnMoons.map(sm => sm.mesh), false);
    saturn.visible = saturnWasVisible;
    if (sHits.length > 0) { flyToObject(sHits[0].object); return; }
  }

  // Check Haumea's moons (hide Haumea so it can't block them)
  if (haumeaMoons.length && haumeaMesh) {
    const haumeaWasVisible = haumeaMesh.visible;
    haumeaMesh.visible = false;
    const hHits = raycaster.intersectObjects(haumeaMoons.map(hm => hm.mesh), false);
    haumeaMesh.visible = haumeaWasVisible;
    if (hHits.length > 0) { flyToObject(hHits[0].object); return; }
  }

  // Check Eris's moon (hide Eris so it can't block Dysnomia)
  if (erisMoons.length && erisMesh) {
    const erisWasVisible = erisMesh.visible;
    erisMesh.visible = false;
    const eHits = raycaster.intersectObjects(erisMoons.map(em => em.mesh), false);
    erisMesh.visible = erisWasVisible;
    if (eHits.length > 0) { flyToObject(eHits[0].object); return; }
  }

  // Check Mars's moons (hide Mars so it can't block close-orbiting Phobos/Deimos)
  if (marsMoons.length && marsMesh) {
    const marsWasVisible = marsMesh.visible;
    marsMesh.visible = false;
    const mHits = raycaster.intersectObjects(marsMoons.map(mm => mm.mesh), false);
    marsMesh.visible = marsWasVisible;
    if (mHits.length > 0) { flyToObject(mHits[0].object); return; }
  }

  // Check everything else
  const allClickable = [...meshes, sun, moon];
  const hits = raycaster.intersectObjects(allClickable, true);

  if (hits.length > 0) {
    let obj = hits[0].object;
    // Walk up to find the actual planet/body mesh with userData.name
    while (obj && !obj.userData.name && obj.parent) {
      obj = obj.parent;
    }
    if (obj && obj.userData.name) flyToObject(obj);
  }
});

// Speed (exponential scaling)
let speed = 0.0001;

const SPEED_REALLIFE = Math.pow(10, -4); // speed value at the minimum slider position

function getSpeedLabel(speed) {
  const multiplier = speed / SPEED_REALLIFE;
  if (multiplier < 10)
    return `${multiplier.toFixed(2)}× real life`;
  if (multiplier < 1000)
    return `${Math.round(multiplier).toLocaleString()}× real life`;
  if (multiplier < 1e6)
    return `${(multiplier / 1000).toFixed(1)}k× real life`;
  return `${(multiplier / 1e6).toFixed(2)}M× real life`;
}

function updateSpeedLabel() {
  document.getElementById("speedLabel").textContent = getSpeedLabel(speed);
}

// Map-scale readout shown under the speed label. Picks the active view's camera,
// focus distance (camera → orbit target), and km-per-unit anchor, then renders a
// "1 : N" ratio that updates every frame as you zoom. Covers every view: the
// Solar System, the galactic schematic, the zoomed-out Milky Way, and the lazy
// rooms (Kepler, Andromeda), each of which exposes its own `kmPerUnit`.
const scaleLabelEl = document.getElementById("scaleLabel");
const _scaleTarget = new THREE.Vector3();
// True when the camera is at galaxy scale. Being outside the origin-centred
// solar skybox sphere is the usual test, but the galactic core sits only
// ~0.52·R from the origin while SKYBOX_RADIUS reaches ~0.48·R — so orbiting
// close to the core can swing the camera back to within SKYBOX_RADIUS of the
// ORIGIN. Without the near-core clause that flipped the app into solar-system
// mode mid-BH-view (galaxy + BH vanishing at certain camera angles). The
// target must be near the core too so an ordinary solar-system zoom-out
// (target at the origin) is unaffected.
function isGalaxyScale() {
  if (camera.position.length() > SKYBOX_RADIUS) return true;
  return galacticCorePos !== null && galaxyVisualRadius > 0 &&
    camera.position.distanceTo(galacticCorePos) < galaxyVisualRadius * 0.30 &&
    controls.target.distanceTo(galacticCorePos) < galaxyVisualRadius * 0.30;
}

function updateScaleReadout() {
  if (!scaleLabelEl) return;
  let cam, focusDist, kmPerUnit;
  const room = viewManager.active;
  if (room && room.camera) {
    cam = room.camera;
    const tgt = room.controls ? room.controls.target : _scaleTarget.set(0, 0, 0);
    focusDist = cam.position.distanceTo(tgt);
    kmPerUnit = room.kmPerUnit || SOLAR_KM_PER_UNIT;
  } else {
    cam = camera;
    focusDist = camera.position.distanceTo(controls.target);
    if (galacticViewActive) {
      kmPerUnit = GALACTIC_KM_PER_UNIT;
    } else if (isGalaxyScale() && galaxyVisualRadius > 0) {
      // Zoomed out to the Milky Way model: the Sun sits at 52% of its visual radius = 26,000 ly.
      kmPerUnit = (26000 / (0.52 * galaxyVisualRadius)) * LY_KM;
    } else {
      kmPerUnit = SOLAR_KM_PER_UNIT;
    }
  }
  const N = scaleRatioN(cam, focusDist, kmPerUnit);
  scaleLabelEl.innerHTML =
    formatRatio(N) + '<br><span style="opacity:0.7">1 cm ≈ ' + realPerCm(N) + '</span>';
}

document.getElementById("speed").oninput = e => {
  speed = Math.pow(10, parseFloat(e.target.value));
  updateSpeedLabel();
  // 1:1 coupling — both sliders share the same log scale [-4, 4]
  const galVal = Math.max(-4, Math.min(4, parseFloat(e.target.value)));
  document.getElementById('galSpeed').value = galVal;
  galacticSpeed = Math.pow(10, galVal);
  updateGalSpeedLabel();
};

document.getElementById("resetSpeed").onclick = () => {
  const slider = document.getElementById("speed");
  slider.value = "-4";
  speed = SPEED_REALLIFE;
  updateSpeedLabel();
};

updateSpeedLabel(); // show label on load

let lockedObject = null;
let flyGeneration = 0;
let isFlyingTo = false;
// Fly-to state, driven each frame inside animate() (after positions update, before
// render) so the focused body stays perfectly centred at any time-warp.
let _flyObj = null;
let _flyStartMs = 0;
const _flyDurMs = 3000;
const _flyStartOffset = new THREE.Vector3();
const _flyOffset = new THREE.Vector3();
const _camTmpA = new THREE.Vector3();
const _camTmpB = new THREE.Vector3();

// Simulation time — starts at the real current date/time
let simulationDate = new Date();

// Format a (possibly enormous) number of years for the precession readout.
function formatYears(y) {
  if (y >= 1e9) return (y / 1e9).toFixed(2) + ' billion yr';
  if (y >= 1e6) return (y / 1e6).toFixed(2) + ' million yr';
  return Math.round(y).toLocaleString() + ' yr';
}
function updateSimTimeDisplay() {
  document.getElementById('simDate').textContent = simulationDate.toLocaleDateString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
  });
  document.getElementById('simTime').textContent = simulationDate.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// Mean longitudes at J2000.0 (deg) and mean motion (deg/day) from JPL
const PLANET_EPHEMERIS = {
  Mercury: { L0: 252.251, n: 4.09234 },
  Venus:   { L0: 181.980, n: 1.60213 },
  Earth:   { L0: 100.464, n: 0.98561 },
  Mars:    { L0: 355.433, n: 0.52403 },
  Jupiter: { L0:  34.396, n: 0.08309 },
  Saturn:  { L0:  50.077, n: 0.03346 },
  Uranus:  { L0: 313.232, n: 0.01173 },
  Neptune: { L0: 304.880, n: 0.00598 },
  // Dwarf planets — mean longitude at J2000 (approximate for the distant TNOs) and
  // mean motion 360/period_days. Gives a roughly real starting configuration.
  Ceres:   { L0: 267.3, n: 0.2142660 },
  Pluto:   { L0: 238.9, n: 0.0039753 },
  Haumea:  { L0: 209.9, n: 0.0034691 },
  Makemake:{ L0: 167.8, n: 0.0032275 },
  Eris:    { L0:  31.8, n: 0.0017664 },
};
const J2000_MS = new Date('2000-01-01T12:00:00Z').getTime();

// Pluto's moons — mean longitude L = (Ω+ω+M) at epoch 2000-01-01.5 (which equals
// J2000_MS above) and mean motion n = 360/period (deg/day), from JPL PLU060 (Brozović &
// Jacobson 2024, ssd.jpl.nasa.gov/sats/elem, Pluto-equator frame). resetSimulation() uses
// these to seed each moon's orbital phase to its REAL position for the current date — like
// the planets above — instead of a random start angle.
// Caveat: the small moons' real inclinations are tiny (<0.5°) so we render them coplanar in
// plutoTiltGroup, and that group's azimuth zero-point is an art-directed tilt (not the ICRF
// node), so the whole fan carries one constant rotation offset. Net: the moons' positions
// RELATIVE to each other and their evolution over time are real; absolute orientation vs the
// real sky is approximate.
const MOON_EPHEMERIS = {
  Charon:   { L0: 304.1, n: 56.3645 },
  Styx:     { L0: 320.6, n: 17.8571 },
  Nix:      { L0:   9.6, n: 14.4869 },
  Kerberos: { L0: 262.5, n: 11.1906 },
  Hydra:    { L0: 228.6, n:  9.4241 },
};

function resetSimulation() {
  const now = new Date();
  simulationDate = now;

  const daysSinceJ2000 = (now.getTime() - J2000_MS) / 86400000;

  // Set each body's MEAN ANOMALY from real ephemeris data (mean longitude L from
  // JPL, minus the longitude of perihelion Ω+ω), then place it via its elements.
  meshes.forEach(m => {
    const ep = PLANET_EPHEMERIS[m.userData.name];
    if (!ep) return;
    const el = m.userData;
    const L = ep.L0 + ep.n * daysSinceJ2000;          // mean longitude (deg)
    el.angle = (L - (el.Om + el.w)) * (Math.PI / 180); // mean anomaly (rad)
    const nu = nuFromMean(el.angle, el.e);
    orbitalToXYZ(el.dist, el.e, el.i, el.Om, el.w, nu, m.position);
  });

  // Seed Pluto's moons to their real orbital phase for `now` (mean longitude L = L0 + n·days),
  // replacing the random start angle. Each moon's group.rotation.y is its orbital angle in the
  // tilted Pluto-equator plane; animate() advances it from here each frame. Charon's phase also
  // drives Pluto's tidal-lock spin. See MOON_EPHEMERIS for the frame caveat.
  if (typeof plutoMoons !== 'undefined' && plutoMoons.length) {
    plutoMoons.forEach(m => {
      const ep = MOON_EPHEMERIS[m.mesh.userData.name];
      if (!ep) return;
      const L = ep.L0 + ep.n * daysSinceJ2000;               // mean longitude now (deg)
      m.group.rotation.y = (((L % 360) + 360) % 360) * (Math.PI / 180);
    });
  }

  // Sync Saturn's ring group to the new position
  const saturnMesh = meshes.find(m => m.userData.name === 'Saturn');
  if (saturnMesh) {
    saturnTiltGroup.position.copy(saturnMesh.position);
    ringUniforms.saturnPos.value.copy(saturnMesh.position);
  }
  // Sync Jupiter's ring group to the new position
  if (jupiter) {
    jupiterTiltGroup.position.copy(jupiter.position);
    jupiterRingUniforms.jupiterPos.value.copy(jupiter.position);
  }
  // Sync Neptune's ring group to the new position
  if (neptuneMesh) {
    neptuneTiltGroup.position.copy(neptuneMesh.position);
    neptuneRingUniforms.neptunePos.value.copy(neptuneMesh.position);
  }
  // Sync Uranus's ring group to its position. Orientation is FIXED in inertial space (set at
  // construction — Uranus's pole points at a fixed sky direction, not the Sun), so we only
  // copy the position here and keep the moon group aligned to the same fixed plane.
  if (uranusMesh) {
    uranusTiltGroup.position.copy(uranusMesh.position);
    if (typeof uranusMoonGroup !== 'undefined' && uranusMoonGroup) {
      uranusMoonGroup.position.copy(uranusMesh.position);
      uranusMoonGroup.quaternion.copy(uranusTiltGroup.quaternion);
    }
  }

  // Orient Earth so the sub-solar point sits at longitude (12 − UTC)×15°E.
  // Three.js sphere UVs put Greenwich at +X when rotation.y=0, and a +Y turn maps
  // azimuth φ→φ−R, so the correct orientation is:
  //   rotation.y = −(orbitalAngle + π) − SSP_rad
  // (animate() recomputes this every frame; this just pre-seeds it on reset.)
  const earthMesh = meshes.find(m => m.userData.name === 'Earth');
  if (earthMesh) {
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const sspRad = (12 - utcH) * (Math.PI / 12);
    const _earthAz = Math.atan2(earthMesh.position.z, earthMesh.position.x);
    earthMesh.rotation.y = -(_earthAz + Math.PI) - sspRad;
    cloudMesh.rotation.y = earthMesh.rotation.y;
  }

  // Reset to Now also zeroes Mercury's precession demo, so its rosette + elapsed-
  // time readout restart from zero (otherwise the override display wouldn't change).
  mercuryPerihelion = 0;
  mercuryTrailCount = 0;
  if (mercuryMesh) mercuryPrevM = mercuryMesh.userData.angle;
  if (mercuryTrailGeom) mercuryTrailGeom.setDrawRange(0, 0);

  updateSimTimeDisplay();
}

document.getElementById('resetTime').onclick = () => {
  resetSimulation();
  // Reset galaxy-spin pivot to angle 0 so the solar-system marker and
  // milky way GLB snap back to their starting positions. BeauGa disc's
  // quaternion goes back to its initial flat-horizontal orientation
  // (only rotation.x = -π/2, no Y spin accumulated).
  if (galaxyPivot) galaxyPivot.rotation.y = 0;
  if (beauGaDisc)  beauGaDisc.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  // Galactic angle has no real-life ephemeris — convention: angle=0 means "now"
  if (galacticViewActive) {
    galacticAngle = 0;
    galEarthAngle = 0;
    galEarthTrailCount = 0;
    galSunTrailCount = 0;
    galElapsedMyr = 0;
    updateGalElapsedDisplay();
    galEarthTrailGeo.setDrawRange(0, 0);
    galSunTrailGeo.setDrawRange(0, 0);
    galSunMarker.position.set(GAL_R, 0, 0);
    galEarthMarker.position.set(GAL_R + GAL_EARTH_R, 0, 0);
    const resetArmAttr = galArm.geometry.attributes.position;
    resetArmAttr.setXYZ(1, GAL_R, 0, 0);
    resetArmAttr.needsUpdate = true;
  }
};

resetSimulation(); // start planets at real positions on load

// ─────────────────────────────────────────────────────────────
// GALACTIC VIEW
// Two reference frames:
//   Heliocentric  — planets orbit Sun (what we always show)
//   Galactocentric — entire solar system orbits the Milky Way
//
// Key facts encoded here:
//   • Galactic orbit radius  ≈ 26,000 ly  → GAL_R visual units
//   • Galactic orbital period ≈ 225 M yr
//   • Ecliptic plane tilted 60.2° from galactic plane
//   • Vertical oscillation: 2.7 bobs per galactic orbit, ±200 ly
// ─────────────────────────────────────────────────────────────
const GAL_R            = 280;                          // visual orbit radius (scene units)
// Map-scale anchors: how many real km one world unit represents in each view.
// Solar System: Earth's orbit = 10 units = 1 AU. Galactic schematic: Sun→core =
// GAL_R units = 26,000 ly. (Milky Way & rooms compute their own at runtime.)
const SOLAR_KM_PER_UNIT    = AU_KM / 10;
const GALACTIC_KM_PER_UNIT = (26000 / GAL_R) * LY_KM;
const GAL_Z_MAX        = 22;                           // vertical bob amplitude (exaggerated)
const GAL_OSC_RATIO    = 2.7;                          // oscillations per galactic orbit
const GAL_TILT         = 60.2 * Math.PI / 180;        // ecliptic tilt vs galactic plane
const GAL_BH_FAR       = 50;                           // distance to centre where BH starts fading in
const GAL_BH_CLOSE     = 6;                            // distance where BH is fully visible (inside disk)
const GALACTIC_YEAR_MS = 225e6 * 365.25 * 86400000;   // ms per galactic year

const galacticGroup = new THREE.Group();
scene.add(galacticGroup);
galacticGroup.visible = false;

// Galactic plane disc
const galPlane = new THREE.Mesh(
  new THREE.CircleGeometry(400, 64),
  new THREE.MeshBasicMaterial({ color: 0x0a1535, opacity: 0.55, transparent: true, side: THREE.DoubleSide })
);
galPlane.rotation.x = -Math.PI / 2;
galacticGroup.add(galPlane);

// Grid on the galactic plane for spatial reference
const galGrid = new THREE.GridHelper(640, 16, 0x4499cc, 0x1a3366);
galGrid.material.opacity = 0.55;
galGrid.material.transparent = true;
galacticGroup.add(galGrid);

// Galactic centre (Sagittarius A*) — canvas glow sprite matching the Milky Way page
let galCentreSprite = null;
(function() {
  const _cc = document.createElement('canvas');
  _cc.width = _cc.height = 256;
  const _cx = _cc.getContext('2d');
  const _cg = _cx.createRadialGradient(128, 128, 0, 128, 128, 128);
  _cg.addColorStop(0.00, 'rgba(255, 252, 240, 1.00)');
  _cg.addColorStop(0.20, 'rgba(255, 240, 210, 0.95)');
  _cg.addColorStop(0.45, 'rgba(255, 210, 160, 0.75)');
  _cg.addColorStop(0.75, 'rgba(230, 160, 100, 0.40)');
  _cg.addColorStop(1.00, 'rgba(180, 90, 40, 0.00)');
  _cx.fillStyle = _cg;
  _cx.fillRect(0, 0, 256, 256);
  galCentreSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(_cc),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false
  }));
  galCentreSprite.scale.set(70, 70, 1);
  galCentreSprite.renderOrder = 4;
  galacticGroup.add(galCentreSprite);
})();

// Galactic-view black hole sprite — 2D canvas image (dark event horizon + orange
// accretion ring) rendered as a billboard Sprite. Always faces the camera so it
// always looks like ONE centred black hole regardless of view angle. Replaces the
// flat ring geometry (which reads as two side arcs when viewed from above).
let galBHSprite = null;
(function() {
  const _c = document.createElement('canvas');
  _c.width = _c.height = 512;
  const _cx = _c.getContext('2d');
  // 1. Orange accretion ring (drawn first, then covered by dark centre)
  const _rg = _cx.createRadialGradient(256,256,100, 256,256,256);
  _rg.addColorStop(0.00, 'rgba(255,140,20,0.00)');
  _rg.addColorStop(0.18, 'rgba(255,160,40,1.00)');
  _rg.addColorStop(0.38, 'rgba(255,90,10,0.80)');
  _rg.addColorStop(0.62, 'rgba(200,45,5,0.45)');
  _rg.addColorStop(0.84, 'rgba(140,18,2,0.18)');
  _rg.addColorStop(1.00, 'rgba(80,5,0,0.00)');
  _cx.fillStyle = _rg;
  _cx.fillRect(0, 0, 512, 512);
  // 2. Dark event horizon overlaid on top (opaque black disk at centre)
  const _eg = _cx.createRadialGradient(256,256,0, 256,256,115);
  _eg.addColorStop(0.00, 'rgba(0,0,0,1.00)');
  _eg.addColorStop(0.80, 'rgba(0,0,0,0.98)');
  _eg.addColorStop(1.00, 'rgba(0,0,0,0.00)');
  _cx.fillStyle = _eg;
  _cx.fillRect(0, 0, 512, 512);
  galBHSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(_c),
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest: false,
    opacity: 0
  }));
  galBHSprite.scale.set(30, 30, 1);
  galBHSprite.renderOrder = 18;
  galBHSprite.visible = false;
  scene.add(galBHSprite);
})();

// Galactic orbit ring, corkscrew path, and radius arm removed (line primitives deleted)
const galArmGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0), new THREE.Vector3(GAL_R, 0, 0)
]);
const galArm = { geometry: galArmGeo }; // stub — keeps animate-loop references valid

// Solar system position marker — a Group so children (disc, arrow, glow) keep their
// orientation fixed in world space while only the texture sphere spins independently.
const galSunMarker = new THREE.Group();
galacticGroup.add(galSunMarker);
// Spinning sun texture — child of galSunMarker so it moves with it but rotates on its own
const galSunTexSphere = new THREE.Mesh(
  new THREE.SphereGeometry(0.8, 16, 16),
  new THREE.MeshBasicMaterial({ map: sunTexture })
);
galSunMarker.add(galSunTexSphere);
galSunMarker.add(new THREE.Mesh(
  new THREE.SphereGeometry(2.0, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.15 })
));

// Ecliptic disc around the marker — tilted 60.2° from the galactic plane
// RingGeometry lies in XY plane; rotate to galactic XZ plane then tilt by 60.2°
const galEclipticDisc = new THREE.Mesh(
  new THREE.RingGeometry(1.5, 4.5, 48),
  new THREE.MeshBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
);
galEclipticDisc.rotation.x = -Math.PI / 2 + GAL_TILT;
galSunMarker.add(galEclipticDisc);

// Solar apex arrow — direction of solar system drift toward Vega (layer 3)
// Vega: galactic longitude ~67°, latitude ~+19°  (in galactic XZ plane, CW convention so Z negated)
const vegaDir = new THREE.Vector3(
  Math.cos(19 * Math.PI/180) * Math.cos(67 * Math.PI/180),   //  0.370
  Math.sin(19 * Math.PI/180),                                  //  0.326
 -Math.cos(19 * Math.PI/180) * Math.sin(67 * Math.PI/180)    // -0.871
).normalize();
// ArrowHelper removed (line primitive deleted)

// ── Kepler-22 system marker ────────────────────────────────────────────────
// A Sun-like neighbour star ~644 ly away in Cygnus. Direction is the true
// galactic bearing (longitude 79.09°, latitude +15.79°); distance is
// exaggerated from its real ~7 scene-units to ~35 so the marker reads as a
// clearly separate, clickable system. Center-referenced convention: galactic
// centre (Sag A*) sits at the origin and the Sun marker at +X, so the
// centre direction is −X and the rotation direction (l=90°) is −Z.
const KEPLER_L = 79.09 * Math.PI / 180;
const KEPLER_B = 15.79 * Math.PI / 180;
const KEPLER_VIS_DIST = 35; // exaggerated for visibility (true scale ≈ 7)
const keplerOffset = new THREE.Vector3(
  -Math.cos(KEPLER_B) * Math.cos(KEPLER_L),
   Math.sin(KEPLER_B),
  -Math.cos(KEPLER_B) * Math.sin(KEPLER_L)
).multiplyScalar(KEPLER_VIS_DIST);

const galKeplerMarker = new THREE.Group();
galacticGroup.add(galKeplerMarker);
// Spinning star — slightly cooler tint than the Sun (Kepler-22 is 5,518 K)
const galKeplerStar = new THREE.Mesh(
  new THREE.SphereGeometry(0.7, 16, 16),
  new THREE.MeshBasicMaterial({ map: sunTexture, color: 0xfff0d8 })
);
galKeplerStar.userData = { name: "Kepler-22" };
galKeplerMarker.add(galKeplerStar);
galKeplerMarker.add(new THREE.Mesh(
  new THREE.SphereGeometry(1.8, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffee99, transparent: true, opacity: 0.15 })
));
// Ecliptic disc around the marker so it reads as "a system" like the Sun marker
const galKeplerDisc = new THREE.Mesh(
  new THREE.RingGeometry(1.3, 4.0, 48),
  new THREE.MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
);
galKeplerDisc.rotation.x = -Math.PI / 2 + GAL_TILT;
galKeplerMarker.add(galKeplerDisc);

// Earth dot orbiting inside the ecliptic ring.
// Lives in galacticGroup (world space) so its position is absolute —
// the trail stays fixed in space even as galSunMarker travels the galaxy.
const GAL_EARTH_R = 3; // orbit radius, sits mid-ring (inner=1.5, outer=4.5)
const galEarthMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.25, 16, 16),
  new THREE.MeshBasicMaterial({ map: earthTexture })
);
galEarthMarker.rotation.z = 23.4 * Math.PI / 180; // axial tilt, matches real Earth
// Small glow so it's easier to spot from galactic camera distance
galEarthMarker.add(new THREE.Mesh(
  new THREE.SphereGeometry(0.5, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0x0088ff, transparent: true, opacity: 0.25, depthWrite: false })
));
galEarthMarker.visible = false;
galacticGroup.add(galEarthMarker);

// Earth trail — world-space rolling buffer so it persists as galSunMarker moves
const GAL_EARTH_TRAIL_MAX = 100000;
const galEarthTrailPos = new Float32Array(GAL_EARTH_TRAIL_MAX * 3);
const galEarthTrailGeo = new THREE.BufferGeometry();
galEarthTrailGeo.setAttribute('position', new THREE.BufferAttribute(galEarthTrailPos, 3));
galEarthTrailGeo.setDrawRange(0, 0);
const galEarthTrail = new THREE.Line(
  galEarthTrailGeo,
  new THREE.LineBasicMaterial({ color: 0x33ccff, transparent: true, opacity: 0.8 })
);
galEarthTrail.visible = false;
galacticGroup.add(galEarthTrail);

// Sun trail — tracks the solar system's corkscrew galactic orbit path around Sag A*
const GAL_SUN_TRAIL_MAX = 20000;
const galSunTrailPos = new Float32Array(GAL_SUN_TRAIL_MAX * 3);
const galSunTrailGeo = new THREE.BufferGeometry();
galSunTrailGeo.setAttribute('position', new THREE.BufferAttribute(galSunTrailPos, 3));
galSunTrailGeo.setDrawRange(0, 0);
const galSunTrail = new THREE.Line(
  galSunTrailGeo,
  new THREE.LineBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.6 })
);
galSunTrail.visible = false;
galacticGroup.add(galSunTrail);

// ── Galactic view state ────────────────────────────────────────
let galacticViewActive  = false;
let galBHTransitionT    = 0;   // 0 = no BH, 1 = full BH environment (galactic view only)
let galBHOrigAlphaMuls  = null; // saved uAlphaMul values so we can restore on exit
let galBHDiskOriented   = false; // true once BH disk quaternion has been set for this galactic session
let galSavedCamPos      = null;
let galSavedCamTarget   = null;
let galSavedCamUp       = null;
let galSavedHelioVis    = null;
let galSavedMilkyWayScale = null;
let galSavedMilkyWayPos   = null;
let galSavedBeauGaScale   = null;
let galSavedBeauGaPos     = null;
let galGridVisible        = true;
let galacticSpeed       = 0.1;  // Myr/s — driven by log slider, independent of planet speed
let galacticAngle       = 0;    // radians, accumulated each frame
let galPaused           = false;
let galEarthTrailVisible = true;
let galSunTrailVisible   = true;
let galEarthAngle       = 0;    // Earth's angle within the ecliptic ring
let galEarthTrailCount  = 0;    // total points ever written (use % MAX for write index)
let galSunTrailCount    = 0;    // same pattern for the sun trail
let galElapsedMyr       = 0;    // galactic simulation time accumulated, in Myr
let spaceshipEnteredFrom = 'main'; // 'main' or 'galactic'
let galCamBeforeSpaceship = null;  // camera state saved when entering spaceship from galactic
let galEarthZoomedIn = false;      // true when camera is locked on Earth in galactic view

function enterGalacticView() {
  // Leave the Kepler-22 system scene if it's showing (it takes over the renderer)
  viewManager.exitActive();
  // Fully exit spaceship view first — the two views are independent
  if (spaceshipViewActive) exitSpaceshipView();

  // Hide every heliocentric object
  galSavedHelioVis = helioObjects.map(o => o.visible);
  helioObjects.forEach(o => { o.visible = false; });
  galacticGroup.visible = true;

  galSavedCamPos    = camera.position.clone();
  galSavedCamTarget = controls.target.clone();
  galSavedCamUp     = camera.up.clone();

  // Rescale galaxy objects to fit the galactic-view schematic (GAL_R = 280 units).
  // beauGaDisc: place centre at galactic origin (0,0,0) and shrink radius to 400.
  // milkyWayModel: same centre transformation — translate so galacticCorePos lands at
  //   origin, then scale uniformly so galaxy visual radius equals 400.
  if (galaxyVisualRadius > 0) {
    const f = 400 / galaxyVisualRadius;
    if (beauGaDisc) {
      galSavedBeauGaScale = beauGaDisc.scale.clone();
      galSavedBeauGaPos   = beauGaDisc.position.clone();
      beauGaDisc.scale.setScalar(f);
      beauGaDisc.position.set(0, 0, 0);
    }
    if (galaxyPivot) {
      // Save and reposition the pivot itself (not milkyWayModel — its local offset is correct).
      // Moving the pivot to world origin + scaling by f centers the GLB at (0,0,0)
      // with radius 400, matching the galactic-view coordinate system.
      galSavedMilkyWayScale = galaxyPivot.scale.clone();
      galSavedMilkyWayPos   = galaxyPivot.position.clone();
      galaxyPivot.position.set(0, 0, 0);
      galaxyPivot.scale.setScalar(f);
    }
  }

  lockedObject = null;
  galacticViewActive = true;
  galBHTransitionT = 0;
  galBHDiskOriented = false;
  galPaused = false;
  galEarthZoomedIn = false;
  document.getElementById('seFromGalBtn').textContent = 'Spaceship Earth →';

  // Start at angle=0 — solar system at (GAL_R, 0, 0), always in sync with the corkscrew path
  galacticAngle = 0;
  galSunMarker.position.set(GAL_R, 0, 0);
  // Sync the arm line endpoint too
  const initArmAttr = galArm.geometry.attributes.position;
  initArmAttr.setXYZ(1, GAL_R, 0, 0);
  initArmAttr.needsUpdate = true;

  // Reset Earth, trails, and elapsed time for a clean start
  galEarthAngle = 0;
  galEarthTrailCount = 0;
  galSunTrailCount = 0;
  galElapsedMyr = 0;
  galEarthTrailGeo.setDrawRange(0, 0);
  galSunTrailGeo.setDrawRange(0, 0);
  // Earth starts at angle=0: offset +GAL_EARTH_R along X from galSunMarker
  galEarthMarker.position.set(GAL_R + GAL_EARTH_R, 0, 0);
  galEarthMarker.visible = true;
  galEarthTrailVisible = true;
  galSunTrailVisible = true;
  galEarthTrail.visible = true;
  galSunTrail.visible = true;
  document.getElementById('galEarthTrailBtn').textContent = 'Hide Earth Trail';
  document.getElementById('galSunTrailBtn').textContent = 'Hide Sun Trail';
  galGridVisible = true;
  galGrid.visible = true;
  galPlane.visible = false; // beauGaDisc is the actual galaxy disc in this view
  document.getElementById('galGridBtn').textContent = 'Hide Grid';
  updateGalElapsedDisplay();

  document.getElementById('panel').style.display = 'none';
  document.getElementById('simTimeBlock').style.display = 'none';
  const _galPanel = document.getElementById('galacticLegend');
  _galPanel.style.top    = '8px';
  _galPanel.style.right  = '20px';
  _galPanel.style.bottom = 'auto';
  _galPanel.style.left   = 'auto';
  _galPanel.style.display = 'block';
  document.getElementById('galacticLegendCollapsed').style.display = 'none';

  camera.position.set(GAL_R * 0.5, GAL_R * 0.7, GAL_R * 1.5);
  camera.up.set(0, 1, 0);
  controls.target.set(0, 0, 0);
  controls.update();

  document.getElementById('galacticBtn').textContent = 'Exit Galactic View';
}

function _restoreGalaxyScale() {
  if (galSavedMilkyWayScale && galaxyPivot) {
    galaxyPivot.scale.copy(galSavedMilkyWayScale);
    galaxyPivot.position.copy(galSavedMilkyWayPos);
    galSavedMilkyWayScale = null;
    galSavedMilkyWayPos   = null;
  }
  if (galSavedBeauGaScale && beauGaDisc) {
    beauGaDisc.scale.copy(galSavedBeauGaScale);
    beauGaDisc.position.copy(galSavedBeauGaPos);
    galSavedBeauGaScale = null;
    galSavedBeauGaPos   = null;
  }
}

function exitGalacticView() {
  // Clear any camera lock before restoring position — prevents one-frame jump
  lockedObject = null;
  galEarthZoomedIn = false;
  document.getElementById('seFromGalBtn').textContent = 'Spaceship Earth →';

  // Reset galactic BH state — restores BH model to its Milky Way page position/scale
  galBHTransitionT = 0;
  galBHDiskOriented = false;
  if (galBHSprite) { galBHSprite.visible = false; galBHSprite.material.opacity = 0; }
  if (blackHoleModel) {
    // Restore ring mesh visibility and alphaMul values for the Milky Way view
    blackHoleModel.children.forEach(function(child) { child.visible = true; });
    if (galBHOrigAlphaMuls && bhDiskMaterials) {
      bhDiskMaterials.forEach(function(m, i) { m.uniforms.uAlphaMul.value = galBHOrigAlphaMuls[i]; });
    }
  }
  galBHOrigAlphaMuls = null;
  if (blackHoleModel && galacticCorePos) {
    blackHoleModel.position.copy(galacticCorePos);
    blackHoleModel.scale.set(1, 1, 1);
    blackHoleModel.quaternion.identity(); // restore upright orientation for Milky Way view
    blackHoleModel.visible = false;
  }
  if (beauGaDisc) { beauGaDisc.material.opacity = 1.0; beauGaDisc.material.needsUpdate = true; }
  if (galCentreSprite) { galCentreSprite.material.opacity = 1.0; }
  bhSkybox.visible = false; bhSkybox.material.opacity = 0;

  _restoreGalaxyScale();
  galacticViewActive = false;
  galacticGroup.visible = false;
  galEarthMarker.visible = false;
  galEarthTrail.visible = false;
  galSunTrail.visible = false;

  if (galSavedHelioVis) {
    helioObjects.forEach((o, i) => { o.visible = galSavedHelioVis[i]; });
    galSavedHelioVis = null;
  }

  document.getElementById('simTimeBlock').style.display = '';
  document.getElementById('galacticLegend').style.display = 'none';
  document.getElementById('galacticLegendCollapsed').style.display = 'none';

  // Always return to a clean view centred on the sun
  camera.position.set(0, 22, 110);
  camera.up.set(Math.sin(ECLIPTIC_TILT), Math.cos(ECLIPTIC_TILT), 0);
  controls.target.set(0, 0, 0);
  controls.update();

  document.getElementById('galacticBtn').textContent = 'Galactic View';
}

// Fly the camera from wherever it is back into the solar system (triggered by the
// "The Solar System" button that appears when zoomed out to galaxy scale).
function flyToSolarSystem() {
  viewManager.exitActive();
  renderer.setClearColor(0x000000, 1); // TEST: restore default clear colour when leaving Milky Way view
  showBodiesList();
  // Clean up galactic view state without jumping the camera position
  if (galacticViewActive) {
    lockedObject = null;
    galEarthZoomedIn = false;
    galBHTransitionT = 0;
    galBHDiskOriented = false;
    if (blackHoleModel) {
      blackHoleModel.children.forEach(function(child) { child.visible = true; });
      if (galBHOrigAlphaMuls && bhDiskMaterials) {
        bhDiskMaterials.forEach(function(m, i) { m.uniforms.uAlphaMul.value = galBHOrigAlphaMuls[i]; });
      }
    }
    galBHOrigAlphaMuls = null;
    if (blackHoleModel && galacticCorePos) {
      blackHoleModel.position.copy(galacticCorePos);
      blackHoleModel.scale.set(1, 1, 1);
      blackHoleModel.quaternion.identity();
      blackHoleModel.visible = false;
    }
    if (beauGaDisc) { beauGaDisc.material.opacity = 1.0; beauGaDisc.material.needsUpdate = true; }
    if (galCentreSprite) { galCentreSprite.material.opacity = 1.0; }
    if (galBHSprite) { galBHSprite.visible = false; galBHSprite.material.opacity = 0; }
    bhSkybox.visible = false; bhSkybox.material.opacity = 0;
    _restoreGalaxyScale();
    galacticViewActive = false;
    galacticGroup.visible = false;
    galEarthMarker.visible = false;
    galEarthTrail.visible = false;
    galSunTrail.visible = false;
    if (galSavedHelioVis) {
      helioObjects.forEach((o, i) => { o.visible = galSavedHelioVis[i]; });
      galSavedHelioVis = null;
    }
    document.getElementById('simTimeBlock').style.display = '';
    document.getElementById('galacticLegend').style.display = 'none';
    document.getElementById('galacticLegendCollapsed').style.display = 'none';
    document.getElementById('galacticBtn').textContent = 'Galactic View';
    document.getElementById('seFromGalBtn').textContent = 'Spaceship Earth →';
  }
  if (spaceshipViewActive) exitSpaceshipView();

  helioObjects.forEach(o => { o.visible = true; });
  orbitLines.forEach(o => { o.visible = orbitsVisible; });
  lockedObject = null;

  const myGeneration = ++flyGeneration;
  isFlyingTo = true;

  const startPos    = camera.position.clone();
  const startTarget = controls.target.clone();
  const endPos      = new THREE.Vector3(0, 22, 110);
  const endTarget   = new THREE.Vector3(0, 0, 0);

  // Capture starting galaxy spin so we can rotate it back to angle 0
  // over the fly — that brings the orbiting solarSystemMarker back to
  // world origin (where the actual planet meshes live) by the time the
  // camera arrives.
  const _startGalaxyAngle = galaxyPivot ? galaxyPivot.rotation.y : 0;
  const _startBeauGaQuat  = beauGaDisc ? beauGaDisc.quaternion.clone() : null;
  const _endBeauGaQuat    = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

  // Exponential (log) distance interpolation about the destination, so the zoom
  // rate feels CONSTANT across the huge scale change — without it, a linear lerp
  // makes the final approach (entering the skybox) whip past abnormally fast.
  const _exp = expFly(startPos, endPos, endTarget);

  const FLY_MS = 4500; let _flyLast = performance.now(); // time-based, display-independent
  let t = 0;
  (function flyIn() {
    if (myGeneration !== flyGeneration) { isFlyingTo = false; return; }
    const _now = performance.now(); t += (_now - _flyLast) / FLY_MS; _flyLast = _now;
    if (t > 1) t = 1;
    const ease = t * t * (3 - 2 * t);

    _exp(ease, camera.position);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    camera.up.set(Math.sin(ECLIPTIC_TILT), Math.cos(ECLIPTIC_TILT), 0);

    // Animate galaxy spin back toward angle 0 alongside the camera fly
    if (galaxyPivot) galaxyPivot.rotation.y = _startGalaxyAngle * (1.0 - ease);
    if (beauGaDisc && _startBeauGaQuat) {
      beauGaDisc.quaternion.copy(_startBeauGaQuat).slerp(_endBeauGaQuat, ease);
    }

    controls.update();

    if (t < 1) requestAnimationFrame(flyIn);
    else isFlyingTo = false;
  })();
}





function showMilkyWayPanel() {
  document.getElementById('panel').style.display = 'block';
  document.getElementById('panelContent').innerHTML = MILKY_WAY_INFO;
  document.getElementById('backToList').style.display = 'none';
}

function showSagAPanel() {
  document.getElementById('panel').style.display = 'block';
  document.getElementById('panelContent').innerHTML = SGR_A_INFO;
  document.getElementById('backToList').style.display = 'none';
}

function flyToMilkyWay() {
  if (!galacticCorePos) return; // GLB not yet loaded

  viewManager.exitActive();
  renderer.setClearColor(0x000005, 1); // TEST: force near-black canvas background for Milky Way view

  showMilkyWayPanel();

  // Exit galactic view first so the camera can fly to the full galaxy from solar-system space
  if (galacticViewActive) exitGalacticView();

  // Camera destination: above the galactic disc, looking down at the core
  const R = galaxyVisualRadius;
  const endTarget = galacticCorePos.clone();
  const endPos = new THREE.Vector3(
    galacticCorePos.x + R * 0.2,
    galacticCorePos.y + R * 1.4,
    galacticCorePos.z + R * 0.8
  );

  lockedObject = null;
  const myGeneration = ++flyGeneration;
  isFlyingTo = true;

  const startPos    = camera.position.clone();
  const startTarget = controls.target.clone();

  const FLY_MS = 5000; let _flyLast = performance.now(); // time-based, display-independent
  let t = 0;
  (function flyOut() {
    if (myGeneration !== flyGeneration) { isFlyingTo = false; return; }
    const _now = performance.now(); t += (_now - _flyLast) / FLY_MS; _flyLast = _now;
    if (t > 1) t = 1;
    const ease = t * t * (3 - 2 * t);

    camera.position.lerpVectors(startPos, endPos, ease);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    camera.up.set(0, 1, 0); // standard Y-up when viewing the galaxy face-on
    controls.update();

    if (t < 1) requestAnimationFrame(flyOut);
    else isFlyingTo = false;
  })();
}

document.getElementById('galacticBtn').onclick = () => {
  if (galacticViewActive) { exitGalacticView(); showBodiesList(); }
  else enterGalacticView();
};

function returnToMainMenu() {
  if (galacticViewActive) exitGalacticView();
  if (spaceshipViewActive) exitSpaceshipView();
  showBodiesList();
}

function collapseGalacticLegend() {
  document.getElementById('galacticLegend').style.display = 'none';
  document.getElementById('galacticLegendCollapsed').style.display = 'block';
}
function expandGalacticLegend() {
  document.getElementById('galacticLegend').style.display = 'block';
  document.getElementById('galacticLegendCollapsed').style.display = 'none';
}

// ── Drag and resize for the Galaxy Edit panel ──────────────────────────────
(function() {
  const panel  = document.getElementById('galacticLegend');
  const header = document.getElementById('galLegendHeader');
  const grip   = document.getElementById('galLegendResizeGrip');

  // On first interaction, convert CSS bottom/left into inline top/left so that
  // the element can be freely repositioned without fighting the stylesheet.
  function ensureTopLeft() {
    if (panel.style.right === 'auto' && panel.style.bottom === 'auto') return;
    panel.style.top    = panel.offsetTop  + 'px';
    panel.style.left   = panel.offsetLeft + 'px';
    panel.style.bottom = 'auto';
    panel.style.right  = 'auto';
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  let drag = null;
  header.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return; // let button clicks pass through
    ensureTopLeft();
    drag = { ox: e.clientX - panel.offsetLeft, oy: e.clientY - panel.offsetTop };
    header.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - drag.ox)) + 'px';
    panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - drag.oy)) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (drag) { drag = null; header.style.cursor = 'grab'; }
  });

  // ── Resize ────────────────────────────────────────────────────────────────
  let resz = null;
  grip.addEventListener('mousedown', e => {
    ensureTopLeft();
    resz = {
      sx: e.clientX, sy: e.clientY,
      sw: panel.offsetWidth, sh: panel.offsetHeight
    };
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener('mousemove', e => {
    if (!resz) return;
    panel.style.width    = Math.max(160, resz.sw + (e.clientX - resz.sx)) + 'px';
    panel.style.height   = Math.max(100, resz.sh + (e.clientY - resz.sy)) + 'px';
    panel.style.overflowY = 'auto';
  });
  document.addEventListener('mouseup', () => { resz = null; });
})();

function enterSpaceshipFromGalactic() {
  // Save galactic camera so we can restore it when returning
  galCamBeforeSpaceship = {
    pos: camera.position.clone(),
    target: controls.target.clone(),
    up: camera.up.clone()
  };
  // Zoom camera close to the sun marker so Earth is seen orbiting it.
  // Camera tracks the sun (not Earth), keeping the orbit arc fully visible.
  const sunPos = new THREE.Vector3();
  galSunMarker.getWorldPosition(sunPos);
  camera.position.set(sunPos.x + 28, sunPos.y + 14, sunPos.z + 28);
  camera.up.set(0, 1, 0);
  controls.target.copy(sunPos);
  controls.update();
  // Lock camera to follow the sun marker as it travels the galaxy
  lockedObject = galSunMarker;
  galEarthZoomedIn = true;
  document.getElementById('seFromGalBtn').textContent = '← Exit Earth Zoom';
}

function returnToGalacticFromSpaceship() {
  lockedObject = null;
  galEarthZoomedIn = false;
  if (galCamBeforeSpaceship) {
    camera.position.copy(galCamBeforeSpaceship.pos);
    camera.up.copy(galCamBeforeSpaceship.up);
    controls.target.copy(galCamBeforeSpaceship.target);
    controls.update();
    galCamBeforeSpaceship = null;
  }
  document.getElementById('seFromGalBtn').textContent = 'Spaceship Earth →';
}

function spaceshipBackBtn() {
  if (spaceshipEnteredFrom === 'galactic') {
    returnToGalacticFromSpaceship();
  } else {
    exitSpaceshipView();
  }
}

function updateGalSpeedLabel() {
  const myr = galacticSpeed;
  const myrStr = myr < 0.01 ? myr.toExponential(1)
               : myr < 10   ? myr.toFixed(2)
               : Math.round(myr).toLocaleString();
  const orbitSec = 225 / (myr * speed);
  let periodStr;
  if      (orbitSec < 120)    periodStr = `${orbitSec.toFixed(1)} s`;
  else if (orbitSec < 7200)   periodStr = `${(orbitSec / 60).toFixed(1)} min`;
  else if (orbitSec < 172800) periodStr = `${(orbitSec / 3600).toFixed(1)} hrs`;
  else if (orbitSec < 3.15e7) periodStr = `${(orbitSec / 86400).toFixed(1)} days`;
  else if (orbitSec < 3.15e9) periodStr = `${(orbitSec / 3.15e7).toFixed(1)} yrs`;
  else                         periodStr = `${(orbitSec / 3.15e9).toFixed(0)} k-yrs`;
  document.getElementById('galSpeedLabel').textContent =
    `${myrStr} Myr/s · galactic orbit ≈ ${periodStr}`;
}

function updateGalElapsedDisplay() {
  const m = galElapsedMyr;
  let s;
  if      (m < 0.001) s = `${(m * 1e6).toFixed(0)} yr`;
  else if (m < 1)     s = `${(m * 1000).toFixed(1)} kyr`;
  else if (m < 1000)  s = `${m.toFixed(3)} Myr`;
  else                s = `${(m / 1000).toFixed(4)} Gyr`;
  const earthOrbits = m * 1e6; // 1 Myr = 1 million Earth orbits
  let orbStr;
  if      (earthOrbits < 1e3) orbStr = `${earthOrbits.toFixed(0)}`;
  else if (earthOrbits < 1e6) orbStr = `${(earthOrbits/1e3).toFixed(1)}k`;
  else if (earthOrbits < 1e9) orbStr = `${(earthOrbits/1e6).toFixed(2)}M`;
  else                         orbStr = `${(earthOrbits/1e9).toFixed(2)}B`;
  document.getElementById('galElapsedLabel').textContent =
    `Elapsed: ${s}  ·  Earth orbits: ~${orbStr}`;
}

document.getElementById('galSpeed').oninput = e => {
  galacticSpeed = Math.pow(10, parseFloat(e.target.value));
  updateGalSpeedLabel();
  // 1:1 coupling — both sliders share the same log scale [-4, 4]
  const normalVal = Math.max(-4, Math.min(4, parseFloat(e.target.value)));
  document.getElementById('speed').value = normalVal;
  speed = Math.pow(10, normalVal);
  updateSpeedLabel();
};

document.getElementById('galEarthTrailBtn').onclick = () => {
  galEarthTrailVisible = !galEarthTrailVisible;
  galEarthTrail.visible = galEarthTrailVisible;
  document.getElementById('galEarthTrailBtn').textContent =
    galEarthTrailVisible ? 'Hide Earth Trail' : 'Show Earth Trail';
};

document.getElementById('galSunTrailBtn').onclick = () => {
  galSunTrailVisible = !galSunTrailVisible;
  galSunTrail.visible = galSunTrailVisible;
  document.getElementById('galSunTrailBtn').textContent =
    galSunTrailVisible ? 'Hide Sun Trail' : 'Show Sun Trail';
};

document.getElementById('galGridBtn').onclick = () => {
  galGridVisible = !galGridVisible;
  galGrid.visible = galGridVisible;
  // galPlane stays hidden — beauGaDisc provides the galaxy backdrop
  document.getElementById('galGridBtn').textContent =
    galGridVisible ? 'Hide Grid' : 'Show Grid';
};

document.getElementById('galResetBtn').onclick = () => {
  galacticAngle = 0;
  galEarthAngle = 0;
  galEarthTrailCount = 0;
  galSunTrailCount = 0;
  galElapsedMyr = 0;
  updateGalElapsedDisplay();
  galEarthTrailGeo.setDrawRange(0, 0);
  galSunTrailGeo.setDrawRange(0, 0);
  galSunMarker.position.set(GAL_R, 0, 0);
  galEarthMarker.position.set(GAL_R + GAL_EARTH_R, 0, 0);
  const armAttr = galArm.geometry.attributes.position;
  armAttr.setXYZ(1, GAL_R, 0, 0);
  armAttr.needsUpdate = true;
  // Restore trail visibility
  galEarthTrailVisible = true;
  galSunTrailVisible = true;
  galEarthTrail.visible = true;
  galSunTrail.visible = true;
  document.getElementById('galEarthTrailBtn').textContent = 'Hide Earth Trail';
  document.getElementById('galSunTrailBtn').textContent = 'Hide Sun Trail';
};

document.getElementById('seFromGalBtn').onclick = () => {
  if (galEarthZoomedIn) returnToGalacticFromSpaceship();
  else enterSpaceshipFromGalactic();
};

// Initialize galactic slider to match normal slider (both start at -4)
galacticSpeed = Math.pow(10, -4);
document.getElementById('galSpeed').value = '-4';
updateGalSpeedLabel();
updateSpeedLabel(); // ensure both labels are populated on load

// ─────────────────────────────────────────────────────────────
// SPACESHIP EARTH VIEW
// Shows the 5 nested layers of motion Vsauce describes.
// Earth's path through space over 100 years — a helix that is:
//   • Tilted 60.2° (ecliptic vs galactic plane)
//   • Drifting toward Vega (solar apex, layer 3)
//   • Powered forward by the galactic orbit (layer 4)
// Scale is intentionally compressed for visual clarity.
// ─────────────────────────────────────────────────────────────
const SE_R_HELIX    = 8;                         // Earth heliocentric orbit radius (visual)
const SE_PITCH      = 2;                         // units forward per year
const SE_YEARS      = 100;                       // years to trace
const SE_EC_TILT    = 60.2 * Math.PI / 180;     // ecliptic vs galactic plane
const SE_VEGA_DRIFT = 0.18;                      // units/year toward Vega (scaled: 70k/792k)

const spaceshipGroup = new THREE.Group();
scene.add(spaceshipGroup);
spaceshipGroup.visible = false;

// Forward axis line and travel trails removed (line primitives deleted)
const SE_TRAIL_MAX = 10000;

const seEarthTrailPos = new Float32Array(SE_TRAIL_MAX * 3);
const seEarthTrailGeo = new THREE.BufferGeometry();
seEarthTrailGeo.setAttribute('position', new THREE.BufferAttribute(seEarthTrailPos, 3));
seEarthTrailGeo.setDrawRange(0, 0);
const seEarthTrail = { geometry: seEarthTrailGeo, visible: false }; // stub

const seSunTrailPos = new Float32Array(SE_TRAIL_MAX * 3);
const seSunTrailGeo = new THREE.BufferGeometry();
seSunTrailGeo.setAttribute('position', new THREE.BufferAttribute(seSunTrailPos, 3));
seSunTrailGeo.setDrawRange(0, 0);
const seSunTrail = { geometry: seSunTrailGeo, visible: false }; // stub

let seEarthTrailCount = 0;
let seSunTrailCount   = 0;
let seLastTrailT      = -1; // last t (years) at which we sampled

// Sun marker — moves along the helix centerline (galactic forward motion only,
// no Earth orbit component). Earth circles around this as the system travels.
const seSunMarker = new THREE.Mesh(
  new THREE.SphereGeometry(4.0, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffdd44 })
);
seSunMarker.add(new THREE.Mesh(
  new THREE.SphereGeometry(6.5, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.15 })
));
spaceshipGroup.add(seSunMarker);

// "100 years from now" marker at end
const seFutureMarker = new THREE.Mesh(
  new THREE.SphereGeometry(1.5, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff8844 })
);
seFutureMarker.position.set(
  SE_YEARS * SE_VEGA_DRIFT * vegaDir.x,
  SE_YEARS * SE_VEGA_DRIFT * vegaDir.y,
  SE_YEARS * SE_PITCH
);
spaceshipGroup.add(seFutureMarker);

// seVegaArrow ArrowHelper removed (line primitive deleted)
const seVegaArrow = null;

// Great Attractor arrow (layer 5) — toward Leo/Virgo
// Galactic coords: l~307°, b~+18° (in our CW galactic frame)
const attractorDir = new THREE.Vector3(
   Math.cos(18 * Math.PI/180) * Math.cos(307 * Math.PI/180),
   Math.sin(18 * Math.PI/180),
  -Math.cos(18 * Math.PI/180) * Math.sin(307 * Math.PI/180)
).normalize();
// seAttractorArrow ArrowHelper removed (line primitive deleted)
const seAttractorArrow = null;

// Animated Earth marker — moves along the helix driven by simulation time
const seEarthMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.7, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0x33ccff })
);
// Glow around the marker
seEarthMarker.add(new THREE.Mesh(
  new THREE.SphereGeometry(1.4, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0x0088ff, transparent: true, opacity: 0.3 })
));
spaceshipGroup.add(seEarthMarker);

// ── Spaceship Earth state ──────────────────────────────────────
let spaceshipViewActive = false;
let spaceshipStartDate  = null;
let seSavedCamPos       = null;
let seSavedCamTarget    = null;
let seSavedCamUp        = null;
let seSavedHelioVis     = null;

function enterSpaceshipView() {
  spaceshipEnteredFrom = 'main';
  viewManager.exitActive();
  if (galacticViewActive) exitGalacticView();
  document.getElementById('panel').style.display = 'none';

  // Hide every heliocentric object explicitly — lights and alternate-view groups untouched
  seSavedHelioVis = helioObjects.map(o => o.visible);
  helioObjects.forEach(o => { o.visible = false; });
  spaceshipGroup.visible = true;

  seSavedCamPos    = camera.position.clone();
  seSavedCamTarget = controls.target.clone();
  seSavedCamUp     = camera.up.clone();

  // Clear trails so a fresh journey starts with no leftover lines
  seEarthTrailCount = 0; seSunTrailCount = 0; seLastTrailT = -1;
  seEarthTrailGeo.setDrawRange(0, 0);
  seSunTrailGeo.setDrawRange(0, 0);

  lockedObject = null;
  spaceshipViewActive = true;
  document.getElementById('spaceshipLegend').style.display = 'block';
  spaceshipStartDate = new Date(simulationDate.getTime());

  // Side view: camera to the left looking along +Z
  // Earth's Y oscillation (up-down) is clearly visible from here
  camera.position.set(-90, 8, 0);
  camera.up.set(0, 1, 0);
  controls.target.set(0, 0, 0);
  controls.update();

  document.getElementById('seBackBtn').textContent = '← Solar System';
}

function exitSpaceshipView() {
  if (spaceshipEnteredFrom === 'galactic') { returnToGalacticFromSpaceship(); return; }
  spaceshipViewActive = false;
  showBodiesList();
  spaceshipGroup.visible = false;
  document.getElementById('spaceshipLegend').style.display = 'none';

  if (seSavedHelioVis) {
    helioObjects.forEach((o, i) => { o.visible = seSavedHelioVis[i]; });
    seSavedHelioVis = null;
  }

  orbitLines.forEach(o => o.visible = orbitsVisible);

  camera.position.copy(seSavedCamPos);
  camera.up.copy(seSavedCamUp);
  controls.target.copy(seSavedCamTarget);
  controls.update();
}


document.getElementById('seResetBtn').onclick = () => {
  spaceshipStartDate = new Date(simulationDate.getTime());
  document.getElementById('seYearDisplay').textContent = '0.0 yrs';
  // Clear travel trails
  seEarthTrailCount = 0; seSunTrailCount = 0; seLastTrailT = -1;
  seEarthTrailGeo.setDrawRange(0, 0);
  seSunTrailGeo.setDrawRange(0, 0);
  // Reset camera
  camera.position.set(-90, 8, 0);
  controls.target.set(0, 0, 0);
  controls.update();
};

// Animation
let lastFrameMs = performance.now();

// ── Kepler-22 System View ─────────────────────────────────────────────────────
// A self-contained interactive scene that behaves like the Solar System view:
// a host star with Kepler-22b orbiting it, driven by the same speed slider, and
// clickable to fly in and read its info. For now Kepler-22b is the only planet —
// additional bodies later are just more orbit pivots.
// Tracks the skybox-boundary side last frame so the Solar System panel can flip
// to the Milky Way panel on zoom-out and back to the bodies list on zoom-in.
let prevOutsideSkybox  = false;

// Zooming all the way out of the Kepler system drops back into the Milky Way
// galaxy view, but — like zooming out of the Solar System — the Kepler dot stays
// the centre focus point (we DON'T jump to the galactic core). We hand the main
// camera the dot as its orbit target at a galaxy-scale framing (the reverse of
// the zoom-in entry), so the user simply keeps zooming out with the dot centred.
function escapeKeplerToGalaxy() {
  if (!galacticCorePos) return;
  const dotPos = keplerSystemMarker.getWorldPosition(new THREE.Vector3());
  const R = galaxyVisualRadius;

  viewManager.exitActive();           // leave the system (was exitKeplerSystem)
  renderer.setClearColor(0x000005, 1);
  showMilkyWayPanel();
  if (galacticViewActive) exitGalacticView();

  // Frame the Kepler dot, centred, just outside the skybox so the galaxy + dot
  // render — matching where the zoom-in entry began, so the hand-off is seamless.
  lockedObject = null;
  camera.up.set(0, 1, 0);
  // Land just OUTSIDE the skybox (scaled to its radius) so the galaxy + dot render.
  camera.position.set(dotPos.x, dotPos.y + SKYBOX_RADIUS * 0.94, dotPos.z + SKYBOX_RADIUS * 0.67);
  controls.target.copy(dotPos);
  controls.update();
}

// "The Kepler-22 System" button — one continuous zoom IN on the Kepler-22 dot
// that flows straight into the system scene (its skybox + star + orbiting planet),
// the same way zooming into the Solar System feels: no pause, no abrupt page swap.
//
// The galaxy + dot only render while the camera is outside the skybox sphere, so
// if we're still at solar-system scale we snap straight out to a galaxy overview
// first (instant — the visible part is the zoom that follows). The zoom uses an
// ease-IN curve so the camera is moving FASTEST at the moment we hand off to the
// system scene, which then continues the zoom-in (see keplerIntro), so the two
// segments read as a single uninterrupted dive.
function flyToKeplerDot() {
  if (!galacticCorePos) return; // GLB not yet loaded

  viewManager.exitActive();
  renderer.setClearColor(0x000005, 1); // near-black background, as in the Milky Way view
  showMilkyWayPanel();
  if (galacticViewActive) exitGalacticView();

  const R = galaxyVisualRadius;
  scene.updateMatrixWorld(true);
  const dotPos = keplerSystemMarker.getWorldPosition(new THREE.Vector3());

  camera.up.set(0, 1, 0);
  // Make sure we start out at galaxy scale so the dot is on screen for the zoom.
  if (camera.position.length() < SKYBOX_RADIUS * 1.5) {
    camera.position.set(dotPos.x, dotPos.y + R * 0.95, dotPos.z + R * 0.75);
    controls.target.copy(dotPos);
    controls.update();
  }

  // End framing: dot centred, just outside the skybox (scaled to its radius) so it
  // stays visible right up to the hand-off into the system scene.
  const endPos    = new THREE.Vector3(dotPos.x, dotPos.y + SKYBOX_RADIUS * 0.94, dotPos.z + SKYBOX_RADIUS * 0.67);
  const endTarget = dotPos.clone();

  lockedObject = null;
  const myGeneration = ++flyGeneration;
  isFlyingTo = true;
  const startPos    = camera.position.clone();
  const startTarget = controls.target.clone();

  const _exp = expFly(startPos, endPos, endTarget); // constant-rate zoom across scales
  const FLY_MS = 3800; let _flyLast = performance.now(); // time-based, display-independent
  let t = 0;
  (function zoomIn() {
    if (myGeneration !== flyGeneration) { isFlyingTo = false; return; }
    const _now = performance.now(); t += (_now - _flyLast) / FLY_MS; _flyLast = _now;
    if (t > 1) t = 1;
    const ease = t * t; // ease-IN: accelerate, fastest at the hand-off (no stop)
    _exp(ease, camera.position);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    camera.up.set(0, 1, 0);
    controls.update();
    if (t < 1) {
      requestAnimationFrame(zoomIn);
    } else {
      isFlyingTo = false;
      // Hand straight off to the system scene, which keeps zooming in from here.
      viewManager.enter('kepler');
    }
  })();
}

document.getElementById('otherGalaxiesBtn').onclick = () => { flyToKeplerDot(); };

// The Andromeda Galaxy view now lives in rooms/andromeda.js (lazy-loaded room).
document.getElementById('andromedaBtn').onclick = () => {
  if (galacticViewActive) exitGalacticView();
  if (spaceshipViewActive) exitSpaceshipView();
  viewManager.enter('andromeda');
};

function animate(){
  requestAnimationFrame(animate);

  // ── Frame pacing (see FPS_ACTIVE / FPS_IDLE / _camDirtyUntil above) ──────────
  // Hidden tab/window → draw nothing. Otherwise render at full rate only while
  // something is actually changing, and idle down when it isn't.
  if (document.hidden) return;
  const _frameNow = performance.now();
  // A room that implements isActive() paces like the main views (60fps only
  // during interaction/its own flights, 10fps idle — raw pointer/wheel input
  // feeds _camDirtyUntil above); rooms without it stay always-active.
  const _paceRoom = viewManager.active;
  const _active =
    isFlyingTo ||                                  // a fly-to / transition is animating
    _frameNow < _camDirtyUntil ||                  // camera moved very recently
    speed > SPEED_REALLIFE * 1.5 ||                // sim running fast enough to see motion
    galacticViewActive || spaceshipViewActive ||   // these views animate continuously
    (_paceRoom ? (_paceRoom.isActive ? !!_paceRoom.isActive() : true) : false);
  const _interval = 1000 / (_active ? FPS_ACTIVE : FPS_IDLE);
  // "Too soon" skip-gate. The fraction must leave enough margin below a vsync that normal
  // refresh jitter can't trip it: at 60fps the interval is 16.67ms, and the old 0.95 factor
  // (15.83ms) sat <1ms under a vsync, so jitter randomly dropped real 60Hz frames to the next
  // vsync (~33ms) — that's the zoom/pan stutter, even though each frame is <2ms of work. Use a
  // generous 0.75 when ACTIVE (~12.5ms → ~4ms margin on 60Hz, never skips; still halves very-
  // high-refresh displays toward the 60fps cap). Idle keeps a tight 0.95 to throttle hard.
  const _frac = _active ? 0.75 : 0.95;
  if (_frameNow - _lastDrawMs < _interval * _frac) return;
  const _dtDraw = _frameNow - _lastDrawMs;
  _lastDrawMs = _frameNow;
  fpsMeterTick(_frameNow, _dtDraw);

  // Map-scale readout — runs for every view (rooms included) before the room
  // hands itself this frame below.
  updateScaleReadout();

  // Strangler hook: while a migrated room (rooms/*.js) is active, let it drive
  // this frame and skip all legacy view code. Dormant until a room is registered.
  const _room = viewManager.active;
  if (_room) { _room.update(ctx); return; }


  // Real elapsed ms since last frame, capped to avoid huge jumps after tab switches
  const nowMs = performance.now();
  const deltaMs = Math.min(nowMs - lastFrameMs, 100);
  lastFrameMs = nowMs;

  // deltaScale normalises all per-frame speed coefficients (calibrated at 60fps)
  // so they behave identically at any refresh rate
  const FRAME_MS = 1000 / 60;
  const deltaScale = deltaMs / FRAME_MS;

  // Show galaxy + Solar System marker only when at galaxy scale (camera outside
  // the skybox sphere, or orbiting the galactic core — see isGalaxyScale());
  // hide the skybox itself at galaxy scale so it doesn't appear as a bubble over the galaxy.
  const camDist = camera.position.length();
  const outsideSkybox = isGalaxyScale();
  // Lazily build the procedural BH + lensing composer the first time we reach
  // galaxy scale (deferred from boot). Runs before any BH render below.
  if (!bhBuilt && (outsideSkybox || galacticViewActive)) ensureBH();
  // Only drive visibility from here when BH is NOT active — save/restore handles it during BH view
  if (!bhRendererSettings) {
    // Galactic (schematic) view swaps to the plain-stars galaxy skybox too —
    // its backdrop shouldn't be the Milky Way panorama we're floating inside of.
    skybox.visible       = !outsideSkybox && !galacticViewActive;
    galaxySkybox.visible =  outsideSkybox ||  galacticViewActive;
    // 3D starfield only in the solar/spaceship views (not at galaxy scale or in
    // the galactic schematic, where it would clutter).
    starfield.visible    = !outsideSkybox && !galacticViewActive;
    const showGalaxy = outsideSkybox || galacticViewActive;
    if (milkyWayModel) milkyWayModel.visible = showGalaxy;
    if (beauGaDisc)    beauGaDisc.visible    = showGalaxy;
  }
  galaxySkybox.position.copy(camera.position);
  bhSkybox.position.copy(camera.position);
  solarSystemMarker.visible = !bhRendererSettings && outsideSkybox && !galacticViewActive;
  keplerSystemMarker.visible = solarSystemMarker.visible;

  // Enter the Kepler-22 system by zooming in toward its dot — the symmetric
  // counterpart to the zoom-out escape. While focused on the Kepler dot in the
  // galaxy view, crossing the skybox boundary (the same boundary that reveals the
  // Solar System near the origin) hands off into the system scene, so the system
  // "appears" as you keep zooming in. Gated on the dot being the focus so zooming
  // in elsewhere (e.g. toward the Solar System) is unaffected.
  if (!galacticViewActive && !spaceshipViewActive &&
      !isFlyingTo && !bhRendererSettings && galaxyVisualRadius > 0) {
    const _kDot = keplerSystemMarker.getWorldPosition(new THREE.Vector3());
    if (controls.target.distanceTo(_kDot) < galaxyVisualRadius * 0.05 && camDist < SKYBOX_RADIUS) {
      viewManager.enter('kepler');
      return;
    }
  }

  // Side panel follows the skybox boundary in the Solar System, the same way the
  // Kepler system does it: zooming out to the galaxy shows the Milky Way panel,
  // zooming back in shows the Solar System bodies list. Only fires on a boundary
  // crossing, and only when focused on the Solar System (target near the origin)
  // so galaxy/Milky-Way/Kepler navigation is left alone. prevOutsideSkybox is
  // updated every (non-Kepler) frame so crossings made during fly-tos or other
  // views are consumed without flipping the panel.
  if (!galacticViewActive && !spaceshipViewActive && !isFlyingTo &&
      !bhRendererSettings && galaxyVisualRadius > 0 &&
      controls.target.length() < 5000 &&
      outsideSkybox !== prevOutsideSkybox) {
    if (outsideSkybox) showMilkyWayPanel();
    else showBodiesList();
  }
  prevOutsideSkybox = outsideSkybox;

  // Galaxy spin — same slow rate in all views, tied to planet speed slider.
  // Paused during fly-to animations, and also when galPaused is active in galactic view.
  if (!isFlyingTo && !(galacticViewActive && galPaused)) {
    var _galaxySpin = 0.000000395 * speed * deltaScale;
    if (galaxyPivot) galaxyPivot.rotation.y += _galaxySpin;
    if (beauGaDisc)  beauGaDisc.rotateOnWorldAxis(_galaxyAxis, _galaxySpin);
  }

  // === Galactic-core glow visibility & fade ===
  // Full bright at far zoom (replaces the BH model entirely when the
  // model is hidden at bhTransitionT < 0.15). Fades out as the user
  // zooms in past bhTransitionT > 0.5 so the detailed BH render
  // (lensing + disk) becomes the visual focus.
  if (galacticGlowSprite) {
    const showGlow = !bhRendererSettings && outsideSkybox && !galacticViewActive && !spaceshipViewActive;
    galacticGlowSprite.visible = showGlow;
    // Fade out as the BH takes over — same rate as the galactic view's
    // galCentreSprite (gone by t ≈ 0.33) so the two reveals feel identical.
    var _gOp = Math.max(0.0, Math.min(1.0, 1.0 - bhTransitionT * 3.0));
    // Glow now smaller (galaxyRadius * 0.18) so reduce opacity to match —
    // less prominence in the centre, still readable at far zoom.
    galacticGlowSprite.material.opacity = _gOp * 0.50;
  }

  // === Sun glow pulsation ===
  // Two incommensurate sines layered so the rhythm feels organic (a "breathing"
  // light bulb) rather than a clean metronome. Driven by real wall time so the
  // speed slider only affects orbital motion, not the pulse cadence.
  {
    const _t = nowMs * 0.001;
    const _pulse = 0.5 * Math.sin(_t * 1.6) + 0.5 * Math.sin(_t * 2.3 + 1.0);
    const _scaleF = 1.0 + _pulse * 0.06;   // ±6% halo size
    const _opF    = 1.0 + _pulse * 0.18;   // ±18% halo brightness
    glowMesh.scale.set(6 * _scaleF, 6 * _scaleF, 1);
    glowMesh.material.opacity = Math.max(0.0, Math.min(1.0, _opF));
    sunLight.intensity = 1.0 + _pulse * 0.08;
  }
  const _ssBtn = document.getElementById('solarSystemBtn');
  if (_ssBtn) _ssBtn.style.display = outsideSkybox ? 'block' : 'none';

  // ── Black hole galactic-core transition ──────────────────────────────────
  // Active only once fully arrived at the Milky Way page view — not during fly animations
  // and not inside any other mode. isFlyingTo gates out the transition that would otherwise
  // fire prematurely as the camera crosses SKYBOX_RADIUS on its way to the galaxy.
  //
  // The BH belongs to the Milky Way view reached via the galaxy button, where the orbit
  // target IS the galactic core. Gate on the target sitting near the core so an ordinary
  // solar-system zoom-out — where the target is the Sun at the origin, ~0.52R from the
  // core — never reveals the BH just because the camera's zoom path happens to pass near
  // the core's world position.
  const targetNearCore = galacticCorePos &&
    controls.target.distanceTo(galacticCorePos) < galaxyVisualRadius * 0.30;
  const inMilkyWayView = outsideSkybox && !galacticViewActive && !spaceshipViewActive &&
    !isFlyingTo && targetNearCore;
  if (inMilkyWayView && galacticCorePos && BH_CLOSE_DIST > 0) {
    const camToCore = camera.position.distanceTo(galacticCorePos);
    const rawFrac = (camToCore - BH_CLOSE_DIST) / (BH_FAR_DIST - BH_CLOSE_DIST);
    const rawT = 1 - Math.max(0, Math.min(1, rawFrac));
    bhTransitionT += (rawT - bhTransitionT) * 0.04;
  } else {
    // Fade out quickly when not in the right view
    bhTransitionT += (0 - bhTransitionT) * 0.10;
  }

  if (BH_CLOSE_DIST > 0) {
    if (blackHoleModel) {
      // BH model fades in as soon as the transition starts — same threshold
      // as the galactic-view zoom-in (galBHTransitionT > 0.04). The disk's
      // uZoomOut uniform keeps it near-transparent at the start, so the
      // reveal is gradual, not a pop.
      var _galaxyShown = outsideSkybox && !galacticViewActive && !spaceshipViewActive;
      blackHoleModel.visible = _galaxyShown && bhTransitionT > 0.04;
      if (_galaxyShown && galacticCorePos) {
        // Mirror the galactic view's per-frame placement: core position,
        // galactic-view proportions (BH = 0.5% of galaxy radius), flat disk.
        blackHoleModel.position.copy(galacticCorePos);
        blackHoleModel.scale.setScalar(BH_MW_SCALE);
        blackHoleModel.quaternion.identity();
      }
    }
    if (bhDiskMaterials && blackHoleModel && blackHoleModel.visible) {
      var _dt = deltaMs * 0.0005 * BH_TUNE.spinSpeed;
      var _zoomOut = 1.0 - bhTransitionT;
      for (var _di = 0; _di < bhDiskMaterials.length; _di++) {
        bhDiskMaterials[_di].uniforms.uTime.value += _dt;
        bhDiskMaterials[_di].uniforms.uZoomOut.value = _zoomOut;
      }
    }
  }

  // === BH reveal — same logic as the galactic-view zoom-in ===
  // Mirrors the galactic view's transition exactly: the flat galaxy disc
  // texture and the core glow fade out as the BH takes over, the 8K Milky Way
  // panorama backdrop fades in (see the bhSkybox block below), and the GLB's
  // star particles stay visible all around the camera. No renderer switch,
  // no scene hiding.
  {
    var _onGalaxyPage = outsideSkybox && !galacticViewActive && !spaceshipViewActive;
    if (_onGalaxyPage && BH_CLOSE_DIST > 0) {
      // Galaxy disc texture fades out as BH takes over (same rate as galactic view)
      if (beauGaDisc) {
        beauGaDisc.material.opacity = Math.max(0.0, 1.0 - bhTransitionT * 2.5);
        beauGaDisc.material.needsUpdate = true;
      }
      // Info panel: Sagittarius A* once the BH has clearly taken over,
      // back to the Milky Way article when zooming out. Hysteresis so the
      // panel doesn't flap at the boundary.
      if (!sgrPanelShown && bhTransitionT > 0.45) {
        sgrPanelShown = true;
        showSagAPanel();
      } else if (sgrPanelShown && bhTransitionT < 0.25) {
        sgrPanelShown = false;
        showMilkyWayPanel();
      }
    } else if (sgrPanelShown) {
      // Left the Milky Way page via a view button / fly-out — that flow sets
      // its own panel; just reset the flag so the panel can re-trigger later.
      sgrPanelShown = false;
    }
  }
  // ── End black hole transition ─────────────────────────────────────────────

  // ── Galactic view — black hole zoom-in ────────────────────────────────────
  // Reuses the real blackHoleModel (ring mesh + lensing composer) same as the
  // Milky Way view. Two galactic-view-specific fixes applied:
  //   1. One-time disk tilt: quaternion set ONCE to face the camera's approach
  //      direction — disk appears face-on, not as two side arcs.
  //   2. Lensing centre: project world (0,0,0) instead of galacticCorePos
  //      because the BH is repositioned to origin in galactic view coords.
  if (galacticViewActive && galaxyVisualRadius > 0 && blackHoleModel) {
    const _galCamDist = camera.position.length();
    const _galRaw = 1.0 - Math.max(0.0, Math.min(1.0,
      (_galCamDist - GAL_BH_CLOSE) / (GAL_BH_FAR - GAL_BH_CLOSE)
    ));
    galBHTransitionT += (_galRaw - galBHTransitionT) * 0.05;

    const _galF = 20.0 / (galaxyVisualRadius * 0.4);
    blackHoleModel.position.set(0, 0, 0);
    blackHoleModel.scale.setScalar(_galF);

    // Keep disk flat (identity rotation) — horizontal XZ plane as created.
    blackHoleModel.quaternion.identity();

    blackHoleModel.visible = galBHTransitionT > 0.04;

    if (bhDiskMaterials && blackHoleModel.visible) {
      const _gdt = deltaMs * 0.0005 * BH_TUNE.spinSpeed;
      const _gZoomOut = 1.0 - galBHTransitionT;
      for (var _gdi = 0; _gdi < bhDiskMaterials.length; _gdi++) {
        bhDiskMaterials[_gdi].uniforms.uTime.value    += _gdt;
        bhDiskMaterials[_gdi].uniforms.uZoomOut.value  = _gZoomOut;
        if (galBHOrigAlphaMuls) {
          bhDiskMaterials[_gdi].uniforms.uAlphaMul.value = galBHOrigAlphaMuls[_gdi];
        }
      }
    }

    // galCentreSprite fades out as BH takes over
    if (galCentreSprite) {
      galCentreSprite.material.opacity = Math.max(0.0, 1.0 - galBHTransitionT * 3.0);
      galCentreSprite.material.needsUpdate = true;
    }
    if (beauGaDisc) {
      beauGaDisc.material.opacity = Math.max(0.0, 1.0 - galBHTransitionT * 2.5);
      beauGaDisc.material.needsUpdate = true;
    }
    if (galBHSprite) galBHSprite.visible = false; // not needed; real BH is shown
  } else if (!galacticViewActive) {
    if (galBHTransitionT > 0) galBHTransitionT = 0;
    if (galBHSprite && galBHSprite.visible) galBHSprite.visible = false;
  }
  if (galacticViewActive && galBHTransitionT < 0.01 && galCentreSprite) {
    galCentreSprite.material.opacity = 1.0;
  }
  // ── End galactic view BH transition ───────────────────────────────────────

  // ── Black-hole backdrop ────────────────────────────────────────────────────
  // Cross-fade the 8K Milky Way panorama (the same texture the solar-system
  // skybox uses) in over the plain-stars backdrop as either BH reveal takes
  // over. Shared by the galactic view and the Milky Way view.
  {
    var _bhBackT = Math.max(bhTransitionT, galacticViewActive ? galBHTransitionT : 0);
    bhSkybox.visible = _bhBackT > 0.1;
    bhSkybox.material.opacity = bhSkybox.visible
      ? Math.min(1.0, (_bhBackT - 0.1) / 0.4)
      : 0.0;

    // GLB star particles defocus-fade out over the same reveal so they stop
    // peppering the BH backdrop: points swell (reads as going out of focus)
    // while their opacity drops. The window is front-loaded — gone by
    // t ≈ 0.22, well before the BH disk dominates the frame (the smoothed
    // transition also lags at low frame rates, so a late window leaves dots
    // over the disk mid-zoom). The identical curve runs in reverse as the
    // camera pulls back out. Shared by both views via _bhBackT. Materials
    // are this instance's own clones (see GLB load).
    if (mwStarMaterials) {
      var _sT = Math.max(0.0, Math.min(1.0, (_bhBackT - 0.02) / 0.20));
      _sT = _sT * _sT * (3.0 - 2.0 * _sT);   // smoothstep — eases both ends
      for (var _smi = 0; _smi < mwStarMaterials.length; _smi++) {
        var _sm = mwStarMaterials[_smi];
        _sm.mat.opacity = _sm.baseOpacity * (1.0 - _sT);
        if (_sm.baseSize !== undefined) _sm.mat.size = _sm.baseSize * (1.0 + _sT * 1.5);
      }
    }
  }

  // Advance simulation clock — at 1× real life, advances by real elapsed ms
  const simMsPerFrame = deltaMs * (speed / SPEED_REALLIFE);
  simulationDate = new Date(simulationDate.getTime() + simMsPerFrame);
  updateSimTimeDisplay();

  // Mercury perihelion precession (Einstein's GR effect). While the trail demo is
  // on, it's tied to the demo's own orbital advance (independent of the sim clock)
  // and fast-forwarded by mercuryDemoMult so the rosette is visible; otherwise it
  // tracks the real 43″/century against simulated time (an imperceptible drift).
  if (mercuryTrailMode) {
    // Paused → freeze the precession (so the drift and the elapsed-time readout stop).
    const dNu = mercuryTrailPaused ? 0 : MERC_DEMO_ORBIT_SPEED * deltaScale;
    mercuryDOmega = (dNu / (2 * Math.PI)) * MERC_PRECESS_PER_ORBIT_RAD * mercuryDemoMult;
    mercuryPerihelion += mercuryDOmega;
  } else {
    // Outside the demo Mercury sits exactly on its (static, inclined) ring; the real
    // 43″/century drift is imperceptible and the inclined ring can't be cheaply
    // rotated, so we don't accumulate it here (the demo is where precession is shown).
    mercuryDOmega = 0;
  }
  // Honest elapsed-time readout in the Mercury panel (the precession's real deep
  // time), shown there rather than overriding the normal simulation clock.
  if (mercuryTrailMode) {
    const _me = document.getElementById('mercElapsed');
    if (_me) _me.textContent = '≈ ' + formatYears(mercuryPerihelion * MERC_YEARS_PER_RAD)
      + ' elapsed · ' + (mercuryPerihelion * 180 / Math.PI).toFixed(1) + '° drift';
  }

  // Sun rotation — true sidereal rate. The Sun rotates differentially (≈25 d at the
  // equator, slower toward the poles); this uses the ~25.38-day Carrington equatorial
  // sidereal period. Calibrated like the planets: value = 0.012123 / period_days =
  // 0.012123 / 25.38 ≈ 0.0004776. (The old 0.135 spun it ~283× too fast — about one full
  // turn every ~2 hours of simulated time.)
  sun.rotation.y += 0.0004776 * speed * deltaScale;
  sun.rotation.z = 7.25 * (Math.PI / 180);

  meshes.forEach(m=>{
    if (m.userData.name === "Mercury") {
      // Elliptical orbit (Sun at the focus) whose perihelion precesses. While the
      // trail demo runs, Mercury orbits at its own fixed rate so the demo doesn't
      // depend on (or disturb) the sim clock; otherwise it follows the speed bar.
      // Paused → Mercury holds still (orbit advance 0) and the trail stops growing.
      // angle is Mercury's MEAN anomaly; Keplerian motion + its precessing perihelion
      // on its real inclined ellipse. Demo mode drives it at a fixed rate.
      const _mercRate = mercuryTrailMode ? (mercuryTrailPaused ? 0 : MERC_DEMO_ORBIT_SPEED)
                                         : m.userData.speed * speed;
      m.userData.angle += _mercRate * deltaScale;
      const el = m.userData, e = MERCURY_ECC;
      const nu = nuFromMean(m.userData.angle, e);
      orbitalToXYZ(el.dist, e, el.i, el.Om, el.w + mercuryPerihelion / _DEG, nu, m.position);
      if (mercuryTrailMode && !mercuryTrailPaused) appendMercuryTrail(m.userData.angle);
      mercuryPrevM = m.userData.angle;
    } else {
      // Every other body: advance MEAN anomaly, solve Kepler, position from its real
      // orbital elements (eccentric + inclined, Sun at the focus).
      const el = m.userData;
      m.userData.angle += el.speed * speed * deltaScale;
      const nu = nuFromMean(m.userData.angle, el.e);
      orbitalToXYZ(el.dist, el.e, el.i, el.Om, el.w, nu, m.position);
    }

    // Spin each planet around itself
    if (m.userData.name === "Mercury") {
      m.rotation.y += 0.0002067 * speed * deltaScale;
      m.rotation.z = 0.03 * (Math.PI / 180);
    }
    if (m.userData.name === "Venus") {
      m.rotation.y -= 0.00004988 * speed * deltaScale;
      m.rotation.z = 177 * (Math.PI / 180);
    }
    if (m.userData.name === "Earth") {
      // Orient Earth from the simulation clock so the day/night terminator tracks
      // the real time-of-day instead of free-running (which drifts off real time).
      // Sub-solar longitude = (12 − UTC hours)×15°; same formula resetSimulation()
      // and the Spaceship-Earth view use. Advances naturally when time is sped up,
      // since simulationDate advances faster.
      const utcH = simulationDate.getUTCHours()
                 + simulationDate.getUTCMinutes() / 60
                 + simulationDate.getUTCSeconds() / 3600;
      // Three.js sphere UVs: Greenwich faces +X at rotation.y=0 and a +Y turn maps
      // surface azimuth φ→φ−R, so to put sub-solar longitude (12−UTC)×15°E onto the
      // Sun (which lies at world azimuth angle+π from Earth):
      //   rotation.y = −(azimuth + π) − (12 − UTC)·15°
      // azimuth = Earth's actual ecliptic longitude from its position (true, not mean).
      const _earthAz = Math.atan2(m.position.z, m.position.x);
      m.rotation.y = -(_earthAz + Math.PI) - (12 - utcH) * (Math.PI / 12);
      m.rotation.z = 23.4 * (Math.PI / 180);
      cloudMesh.rotation.y += 0.01224 * speed * deltaScale;
    }
    if (m.userData.name === "Mars") {
      m.rotation.y += 0.01181 * speed * deltaScale;
      m.rotation.z = 25.2 * (Math.PI / 180);
      if (terraformedMarsModel) {
        terraformedMarsModel.position.copy(m.position);
        terraformedMarsModel.rotation.copy(m.rotation);
        if (marsCloudMesh) {
          // Extra 0.5× on top of inherited parent rotation = 1.5× total cloud spin
          marsCloudMesh.rotation.y += 0.01181 * speed * deltaScale * 0.5;
        }
      }
    }
    if (m.userData.name === "Jupiter") {
      m.rotation.y += 0.02931 * speed * deltaScale;
      m.rotation.z = 3.1 * (Math.PI / 180);
      jupiterTiltGroup.position.copy(m.position);
      jupiterRingUniforms.jupiterPos.value.copy(m.position);
    }
    if (m.userData.name === "Saturn") {
      m.rotation.y += 0.02730 * speed * deltaScale;
      m.rotation.z = 26.7 * (Math.PI / 180);

      saturnTiltGroup.position.copy(m.position);
      ringUniforms.saturnPos.value.copy(m.position);
      if (saturnRingShadow) saturnRingShadow.uSaturnCenter.value.copy(m.position);
    }
    if (m.userData.name === "Uranus") {
      // Spin about the fixed ring-plane axis (see _uranusSpinTilt) so the rotation axis
      // matches the ring plane and the pole stays put: orientation = tilt × spin-about-Y.
      uranusSpinAngle -= 0.01687 * speed * deltaScale;
      m.quaternion.copy(_uranusSpinTilt)
        .multiply(_uranusSpinQ.setFromAxisAngle(_uranusSpinAxis, uranusSpinAngle));

      uranusTiltGroup.position.copy(m.position);
    }
    if (m.userData.name === "Neptune") {
      // Spin about the fixed, ring-aligned axis (see _neptuneSpinTilt) so the pole stays
      // put instead of bobbing: orientation = tilt × spin-about-local-Y.
      neptuneSpinAngle += 0.01806 * speed * deltaScale;
      m.quaternion.copy(_neptuneSpinTilt)
        .multiply(_neptuneSpinQ.setFromAxisAngle(_neptuneSpinAxis, neptuneSpinAngle));

      neptuneTiltGroup.position.copy(m.position);
      neptuneRingUniforms.neptunePos.value.copy(m.position);
    }
    // Dwarf planets: spin + axial tilt from data (Haumea spins fast about its short
    // axis, etc.). Pluto is excluded — its orientation is driven by the Pluto–Charon
    // tidal lock in the moon-follow block below.
    if (m.userData.kind === "dwarf" && m.userData.name !== "Pluto") {
      if (m.userData.spinY) m.rotation.y += m.userData.spinY * speed * deltaScale;
      if (m.userData.tilt != null) m.rotation.z = m.userData.tilt * (Math.PI / 180);
    }
  });

  // 🌕 Moon follows Earth position in world space
  if (typeof moonGroup !== "undefined" && moonGroup) {
    const earthWorldPos = new THREE.Vector3();
    earth.getWorldPosition(earthWorldPos);
    moonGroup.position.copy(earthWorldPos);
    // Tidally locked: the Moon mesh is parented to moonGroup, so the group's orbital
    // rotation alone keeps one face (its near side) toward Earth. Adding a second spin
    // to the mesh would double-rotate it (showing all sides), so it is NOT applied.
    moonGroup.rotation.y += moonOrbitStep(0.0004434 * speed, MOON_ORBIT_DIST, deltaScale);
  }

  // 🪐 Jupiter moons follow Jupiter in world space — the whole tilted equatorial plane
  // (moons + orbit rings) rides Jupiter's position; each moon orbits within it.
  if (typeof jupiterMoons !== "undefined" && jupiterMoons.length) {
    const jupiterWorldPos = new THREE.Vector3();
    jupiter.getWorldPosition(jupiterWorldPos);
    jupiterMoonGroup.position.copy(jupiterWorldPos);
    jupiterMoons.forEach(m => {
      if (m.group) m.group.rotation.y += moonOrbitStep(m.speed * speed, m.distance, deltaScale);
    });
  }

  // 🌑 Pluto's moons follow Pluto; the whole tilted plane rides Pluto's position
  if (plutoMoons.length && plutoMesh) {
    const plutoWorldPos = new THREE.Vector3();
    plutoMesh.getWorldPosition(plutoWorldPos);
    plutoTiltGroup.position.copy(plutoWorldPos);
    plutoMoons.forEach(m => {
      // Cap the per-frame orbital step (see moonOrbitStep) so these short-period moons don't
      // alias into a shake at extreme time-warp.
      m.group.rotation.y += moonOrbitStep(m.speed * speed, m.distance, deltaScale);
      // Irregular moons spin chaotically (real fact — they're NOT tidally locked). Use each
      // moon's real self-rotation rate (m.spin, from planets.js) and scale it with the speed
      // slider exactly like the planets do (× speed × deltaScale, uncapped), so faster time-
      // warp = faster spin. No cap is needed: the shake/flash that used to appear here was the
      // min-dot scaler sizing the moon off a stale pre-follow camera position (now fixed by
      // running the camera-follow before applyMinDots), not the spin itself. The small x term
      // keeps the tumble looking multi-axis (these moons tumble on a wandering axis).
      if (m.irregular) {
        const spin = m.spin * speed * deltaScale;
        m.mesh.rotation.y += spin;
        m.mesh.rotation.x += spin * 0.3;
      }
    });
    // Mutual tidal lock: spin Pluto about the orbit-plane normal in lock-step with
    // Charon's orbital angle, so Pluto keeps one face toward Charon (as Charon keeps one
    // face toward Pluto). Same plane orientation as plutoTiltGroup, so the axis matches.
    if (plutoCharon) {
      plutoMesh.quaternion.copy(plutoTiltGroup.quaternion)
        .multiply(_plutoSpinQ.setFromAxisAngle(_plutoSpinAxis, plutoCharon.group.rotation.y));
    }
  }

  // 🔵 Triton follows Neptune in world space
  if (neptuneMoons.length && neptuneMesh) {
    const neptuneWorldPos = new THREE.Vector3();
    neptuneMesh.getWorldPosition(neptuneWorldPos);
    neptuneMoons.forEach(m => {
      m.tilt.position.copy(neptuneWorldPos);   // tilt holds the inclined orbit plane + ring
      m.group.rotation.y += moonOrbitStep(m.speed * speed, m.distance, deltaScale);
    });
  }

  // 🌙 Uranus's moons follow Uranus in world space (orbits ride the shared ring-plane group)
  if (uranusMoons.length && uranusMesh) {
    const uranusWorldPos = new THREE.Vector3();
    uranusMesh.getWorldPosition(uranusWorldPos);
    uranusMoonGroup.position.copy(uranusWorldPos);
    uranusMoons.forEach(m => {
      m.group.rotation.y += moonOrbitStep(m.speed * speed, m.distance, deltaScale);
    });
  }

  // 🪐 Saturn's moons follow Saturn in world space (orbits ride the shared ring-plane group)
  if (saturnMoons.length && saturn) {
    const saturnWorldPos = new THREE.Vector3();
    saturn.getWorldPosition(saturnWorldPos);
    saturnMoonGroup.position.copy(saturnWorldPos);
    saturnMoons.forEach(m => {
      m.group.rotation.y += moonOrbitStep(m.speed * speed, m.distance, deltaScale);
    });
  }

  // ✨ Haumea's moons follow Haumea; the whole tilted plane rides its position. Each moon
  // also spins on its own axis (NOT tidally locked — Hiʻiaka rotates ~5× per orbit).
  if (haumeaMoons.length && haumeaMesh) {
    const haumeaWorldPos = new THREE.Vector3();
    haumeaMesh.getWorldPosition(haumeaWorldPos);
    haumeaMoonGroup.position.copy(haumeaWorldPos);
    haumeaMoons.forEach(m => {
      m.group.rotation.y += moonOrbitStep(m.speed * speed, m.distance, deltaScale);
      if (m.spin) m.mesh.rotation.y += m.spin * speed * deltaScale;
    });
  }

  // ✨ Eris's moon Dysnomia follows Eris; tidally locked (orbit only, no own spin).
  if (erisMoons.length && erisMesh) {
    const erisWorldPos = new THREE.Vector3();
    erisMesh.getWorldPosition(erisWorldPos);
    erisMoonGroup.position.copy(erisWorldPos);
    erisMoons.forEach(m => {
      m.group.rotation.y += moonOrbitStep(m.speed * speed, m.distance, deltaScale);
    });
  }

  // 💨 Enceladus's plumes blow outward only as the sim runs faster than 1×: at LIVE the
  // jets are frozen (a static plume), and they stream out as you speed up time. uFlow stays
  // in [0,1) so the GPU `fract(phase0 + uFlow)` keeps full precision. uMoonScale/uSizeK keep
  // the soft sprites the right on-screen size as the moon is min-dot scaled / the view changes.
  if (enceladusPlume) {
    const flowStep = Math.min(0.5, enceladusPlume.flowRate * Math.max(0, speed - SPEED_REALLIFE) * deltaScale);
    enceladusPlume.flow = (enceladusPlume.flow + flowStep) % 1.0;
    enceladusPlume.uniforms.uFlow.value = enceladusPlume.flow;
    enceladusPlume.uniforms.uMoonScale.value = enceladusPlume.encMesh.scale.x;
    enceladusPlume.uniforms.uSizeK.value =
      renderer.domElement.clientHeight / (2 * Math.tan((camera.fov * Math.PI / 180) / 2));
  }

  // 🔴 Mars's moons follow Mars in world space. Each moon is a static child of its orbit
  // group (no own spin), so advancing only the group keeps it tidally locked — long axis
  // to Mars — exactly as Phobos and Deimos really are.
  if (marsMoons.length && marsMesh) {
    const marsWorldPos = new THREE.Vector3();
    marsMesh.getWorldPosition(marsWorldPos);
    marsMoonGroup.position.copy(marsWorldPos);
    marsMoons.forEach(m => {
      m.group.rotation.y += moonOrbitStep(m.speed * speed, m.distance, deltaScale);
    });
  }

  // Lock camera target to selected object (only after fly animation completes)
  // Camera follow — runs after every body position is updated this frame but BEFORE the
  // distance-dependent sizing below (near plane, min-dot scaling, orbit-ring proximity),
  // so those all measure against the camera's FINAL position for this frame. Running it
  // after that sizing left the min-dot scaler measuring a fast-orbiting moon against the
  // camera's stale (pre-follow) position — its parent had carried it a large world step
  // since the camera last centred — so the moon's scale pumped 1.5×–2.2× every frame
  // (violent shake/flash/"too close") even though its on-screen distance was rock-stable.
  if (isFlyingTo && _flyObj) {
    // Glide: lerp the camera's offset from the (moving) target toward the framing offset,
    // always sitting at target+offset → the body stays centred while we zoom in.
    _flyObj.getWorldPosition(_camTmpA);
    const _t = Math.min(1, (performance.now() - _flyStartMs) / _flyDurMs);
    const _ease = _t * _t * (3 - 2 * _t);
    _camTmpB.lerpVectors(_flyStartOffset, _flyOffset, _ease);
    camera.position.copy(_camTmpA).add(_camTmpB);
    controls.target.copy(_camTmpA);
    controls.update();
    if (_t >= 1) isFlyingTo = false;
  } else if (lockedObject) {
    // Steady lock: translate the camera by however far the body moved this frame.
    lockedObject.getWorldPosition(_camTmpA);
    _camTmpB.copy(_camTmpA).sub(controls.target);
    controls.target.copy(_camTmpA);
    camera.position.add(_camTmpB);
    controls.update();
  }

  // Dynamic near plane: keep it at ~5% of the distance to whatever we're orbiting,
  // capped at the default 0.0004 when zoomed out. So zooming into a body of any size
  // (even Pluto's 16-km moons) never clips it on the near plane, while the wide views
  // keep their depth precision. The galactic/spaceship views use the fixed default
  // (resetting it in case we entered them while zoomed into something tiny). The BH
  // composer view manages its own camera, so it's left alone.
  if (!bhRendererSettings) {
    let _wantNear;
    if (galacticViewActive || spaceshipViewActive) {
      _wantNear = 0.0004;
    } else {
      const _tDist = camera.position.distanceTo(controls.target);
      _wantNear = Math.max(1e-9, Math.min(0.0004, _tDist * 0.05));
    }
    if (Math.abs(camera.near - _wantNear) > _wantNear * 0.15) {
      camera.near = _wantNear;
      camera.updateProjectionMatrix();
    }
  }

  // True-scale visibility: size every body for the current zoom (dot when far,
  // real size up close). Runs after all positions are set this frame.
  applyMinDots();
  // Hide a body's orbit ring when zoomed in close to it (solar view only — the
  // alternate views manage orbit-line visibility themselves).
  if (!galacticViewActive && !spaceshipViewActive) updateOrbitRingProximity();

  // Re-express the far dwarf orbit rings in camera-relative coordinates so they sit
  // exactly on their (float64-positioned) planet and don't shimmer on zoom. Skipped
  // for hidden rings. See dwarfOrbitLines where the exact world points are stashed.
  if (dwarfOrbitLines.length) {
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (const line of dwarfOrbitLines) {
      if (!line.visible) continue;
      const wp = line.userData._dwarfWorld;
      const attr = line.geometry.attributes.position;
      const arr = attr.array;
      for (let k = 0, n = arr.length; k < n; k += 3) {
        arr[k]     = wp[k]     - cx;
        arr[k + 1] = wp[k + 1] - cy;
        arr[k + 2] = wp[k + 2] - cz;
      }
      attr.needsUpdate = true;
      line.position.set(cx, cy, cz);
    }
  }

// Galactic view — advance solar system + Earth dot along corkscrew path
  if (galacticViewActive) {
    const dtSec = deltaMs / 1000;
    const galTimeRate = galacticSpeed * speed; // Myr per real second

    // ── Advance galactic (solar system) orbit ──────────────────────────────
    const galAngleDelta = (galTimeRate / 225) * Math.PI * 2 * dtSec;
    galacticAngle += galAngleDelta;
    const galX = GAL_R * Math.cos(galacticAngle);
    const galY = GAL_Z_MAX * Math.sin(galacticAngle * GAL_OSC_RATIO);
    const galZ = -GAL_R * Math.sin(galacticAngle);
    galSunMarker.position.set(galX, galY, galZ);
    // galSunTexSphere spins independently — parent Group stays unrotated so the
    // eclipticDisc (sibling child) stays aligned with Earth's world-space orbit.
    // At 1× (SPEED_REALLIFE) the excess is zero → fully static.
    // As speed increases above 1×, spin ramps up proportionally.
    const galSpeedExcess = Math.max(0, speed - SPEED_REALLIFE);
    const galSunSpin = Math.min(0.12, 4.49e-4 * galSpeedExcess) * deltaScale;
    galSunTexSphere.rotation.y += galSunSpin;
    const armAttr = galArm.geometry.attributes.position;
    armAttr.setXYZ(1, galX, galY, galZ);
    armAttr.needsUpdate = true;

    // ── Kepler-22 marker co-travels with the Sun marker (644 ly neighbour) ──
    galKeplerMarker.position.set(galX + keplerOffset.x, galY + keplerOffset.y, galZ + keplerOffset.z);
    galKeplerStar.rotation.y += galSunSpin;

    // ── Earth orbit: galactic-time-scaled, frozen only at 1× real life (slider -4) ──
    // At slider -4: speed == SPEED_REALLIFE → delta = 0 → Earth appears static.
    // Any speed above -4: galTimeRate * 10^6 orbits/Myr → orbit visible; slider +4 fills instantly.
    const earthAngleDelta = speed > SPEED_REALLIFE
      ? galTimeRate * 1e6 * Math.PI * 2 * dtSec
      : 0;
    galEarthAngle += earthAngleDelta;

    // ── LOD: dense trail (up to 400 samples) when zoomed in, coarse (up to 20) when far ──
    const camToSun = camera.position.distanceTo(galSunMarker.position);
    const maxEarthSamples = camToSun < 30 ? 400 : 20;
    const orbitsThisFrame = Math.abs(earthAngleDelta) / (Math.PI * 2);
    // Skip trail when frozen so the buffer isn't filled with duplicate points
    const earthSamples = earthAngleDelta !== 0
      ? Math.max(1, Math.min(maxEarthSamples, Math.ceil(orbitsThisFrame)))
      : 0;

    const prevGalAngle   = galacticAngle - galAngleDelta;
    const prevEarthAngle = galEarthAngle - earthAngleDelta;

    // ── Earth trail ────────────────────────────────────────────────────────
    const earthWriteStart = galEarthTrailCount % GAL_EARTH_TRAIL_MAX;
    for (let i = 0; i < earthSamples; i++) {
      const t = (i + 1) / earthSamples;
      const sGalAng = prevGalAngle + galAngleDelta * t;
      const sGalX = GAL_R * Math.cos(sGalAng);
      const sGalY = GAL_Z_MAX * Math.sin(sGalAng * GAL_OSC_RATIO);
      const sGalZ = -GAL_R * Math.sin(sGalAng);
      const sEarthAng = prevEarthAngle + earthAngleDelta * t;
      const sex = GAL_EARTH_R * Math.cos(sEarthAng);
      const sey = GAL_EARTH_R * Math.sin(sEarthAng) * Math.sin(GAL_TILT);
      const sez = -GAL_EARTH_R * Math.sin(sEarthAng) * Math.cos(GAL_TILT);
      const eIdx = galEarthTrailCount % GAL_EARTH_TRAIL_MAX;
      galEarthTrailPos[eIdx * 3]     = sGalX + sex;
      galEarthTrailPos[eIdx * 3 + 1] = sGalY + sey;
      galEarthTrailPos[eIdx * 3 + 2] = sGalZ + sez;
      galEarthTrailCount++;
    }
    galEarthTrailGeo.setDrawRange(0, Math.min(galEarthTrailCount, GAL_EARTH_TRAIL_MAX));
    if (earthSamples > 0) {
      const eAttr = galEarthTrailGeo.attributes.position;
      const earthWriteEnd = galEarthTrailCount % GAL_EARTH_TRAIL_MAX;
      if (earthWriteEnd > earthWriteStart || galEarthTrailCount <= GAL_EARTH_TRAIL_MAX) {
        eAttr.updateRange.offset = earthWriteStart * 3;
        eAttr.updateRange.count  = earthSamples * 3;
      } else {
        eAttr.updateRange.offset = 0;
        eAttr.updateRange.count  = GAL_EARTH_TRAIL_MAX * 3;
      }
      eAttr.needsUpdate = true;
    }

    // ── Sun trail: sub-frame sampled galactic corkscrew path around Sag A* ──
    const galOrbitsThisFrame = Math.abs(galAngleDelta) / (Math.PI * 2);
    const sunSamples = Math.max(1, Math.min(200, Math.ceil(galOrbitsThisFrame)));
    const sunWriteStart = galSunTrailCount % GAL_SUN_TRAIL_MAX;
    for (let i = 0; i < sunSamples; i++) {
      const t = (i + 1) / sunSamples;
      const sGalAng = prevGalAngle + galAngleDelta * t;
      const sIdx = galSunTrailCount % GAL_SUN_TRAIL_MAX;
      galSunTrailPos[sIdx * 3]     = GAL_R * Math.cos(sGalAng);
      galSunTrailPos[sIdx * 3 + 1] = GAL_Z_MAX * Math.sin(sGalAng * GAL_OSC_RATIO);
      galSunTrailPos[sIdx * 3 + 2] = -GAL_R * Math.sin(sGalAng);
      galSunTrailCount++;
    }
    galSunTrailGeo.setDrawRange(0, Math.min(galSunTrailCount, GAL_SUN_TRAIL_MAX));
    if (sunSamples > 0) {
      const sAttr = galSunTrailGeo.attributes.position;
      const sunWriteEnd = galSunTrailCount % GAL_SUN_TRAIL_MAX;
      if (sunWriteEnd > sunWriteStart || galSunTrailCount <= GAL_SUN_TRAIL_MAX) {
        sAttr.updateRange.offset = sunWriteStart * 3;
        sAttr.updateRange.count  = sunSamples * 3;
      } else {
        sAttr.updateRange.offset = 0;
        sAttr.updateRange.count  = GAL_SUN_TRAIL_MAX * 3;
      }
      sAttr.needsUpdate = true;
    }

    // ── Final Earth marker position and self-rotation ──────────────────────
    const ex = GAL_EARTH_R * Math.cos(galEarthAngle);
    const ey = GAL_EARTH_R * Math.sin(galEarthAngle) * Math.sin(GAL_TILT);
    const ez = -GAL_EARTH_R * Math.sin(galEarthAngle) * Math.cos(GAL_TILT);
    galEarthMarker.position.set(galX + ex, galY + ey, galZ + ez);
    // At galactic scale: 1× → static; faster speeds → spin ramps up (24h looks instant)
    const galEarthSpin = Math.min(0.20, 0.01212 * galSpeedExcess) * deltaScale;
    galEarthMarker.rotation.y += galEarthSpin;

    galElapsedMyr += galTimeRate * dtSec;
    updateGalElapsedDisplay();
  }

// Spaceship Earth — move Earth marker along the helix based on simulation time
  if (spaceshipViewActive && spaceshipStartDate) {
    const seElapsedMs = simulationDate.getTime() - spaceshipStartDate.getTime();
    const t = Math.max(0, seElapsedMs / (365.25 * 24 * 3600 * 1000)); // years, no looping

    const angle = t * Math.PI * 2;
    const fwd   = t * SE_PITCH;
    const ex = SE_R_HELIX * Math.cos(angle) + t * SE_VEGA_DRIFT * vegaDir.x;
    const ey = SE_R_HELIX * Math.sin(angle) * Math.cos(SE_EC_TILT)
             + t * SE_VEGA_DRIFT * vegaDir.y;
    const ez = fwd + SE_R_HELIX * Math.sin(angle) * Math.sin(SE_EC_TILT);

    seEarthMarker.position.set(ex, ey, ez);

    // Sun moves along the galactic centerline (no Earth orbital component)
    // Earth visibly orbits around this Sun marker as both travel forward
    const sx = t * SE_VEGA_DRIFT * vegaDir.x;
    const sy = t * SE_VEGA_DRIFT * vegaDir.y;
    seSunMarker.position.set(sx, sy, fwd);

    // Grow travel trails — sample every 0.05 simulated years (~18 days)
    if (t - seLastTrailT >= 0.05) {
      seLastTrailT = t;
      if (seEarthTrailCount < SE_TRAIL_MAX) {
        seEarthTrailPos[seEarthTrailCount * 3]     = ex;
        seEarthTrailPos[seEarthTrailCount * 3 + 1] = ey;
        seEarthTrailPos[seEarthTrailCount * 3 + 2] = ez;
        seEarthTrailCount++;
        seEarthTrailGeo.attributes.position.needsUpdate = true;
        seEarthTrailGeo.setDrawRange(0, seEarthTrailCount);
      }
      if (seSunTrailCount < SE_TRAIL_MAX) {
        seSunTrailPos[seSunTrailCount * 3]     = sx;
        seSunTrailPos[seSunTrailCount * 3 + 1] = sy;
        seSunTrailPos[seSunTrailCount * 3 + 2] = fwd;
        seSunTrailCount++;
        seSunTrailGeo.attributes.position.needsUpdate = true;
        seSunTrailGeo.setDrawRange(0, seSunTrailCount);
      }
    }

    // Update year counter
    document.getElementById('seYearDisplay').textContent =
      t < 1 ? (t * 12).toFixed(1) + ' months' : t.toFixed(1) + ' yrs';

    // Camera target follows forward progress (Z) but not Y oscillation
    // so the up-down bounce stays visible against a stable horizon
    controls.target.lerp(new THREE.Vector3(ex * 0.25, 0, fwd), 0.025);
    controls.update();
  }

// ☀️ Update Earth shader sun direction
  const earthMesh = meshes.find(m => m.userData.name === "Earth");
  if (earthMesh && earthMesh.material.uniforms) {
    const earthPos = earthMesh.position.clone();
    const dir = earthPos.clone().negate().normalize(); // direction from Earth to Sun (Sun is at 0,0,0)
    earthMesh.material.uniforms.sunDirection.value.copy(dir);
    if (cloudMesh.material.uniforms) cloudMesh.material.uniforms.sunDirection.value.copy(dir);
  }

  // ☀️ Update Terraformed Mars shader sun direction (surface + clouds)
  if (terraformedMarsMaterial) {
    const marsDir = marsMesh.position.clone().negate().normalize();
    terraformedMarsMaterial.uniforms.sunDirection.value.copy(marsDir);
    if (marsCloudMesh && marsCloudMesh.material.uniforms) {
      marsCloudMesh.material.uniforms.sunDirection.value.copy(marsDir);
    }
  }

  // Use the lensing composer (gravitational-warp + photon-ring + halo +
  // solid-black shadow) whenever the BH model is visible. In skybox mode
  // this also locks the orbit target to the BH; in inline-galaxy mode the
  // user's camera target is left alone so they can pan across the galaxy.
  var _useLensComposer =
    finalComposer && (
      bhRendererSettings ||
      (blackHoleModel && blackHoleModel.visible)
    );
  setBHTunerAvailable('world', !!_useLensComposer);
  if (_useLensComposer) {
    if (bhRendererSettings && galacticCorePos) {
      controls.target.copy(galacticCorePos);
    }
    // Always update controls + camera matrix BEFORE projecting galacticCorePos
    // to screen space. Without this the projection uses last-frame's camera
    // matrix while the disk renders with this-frame's matrix, producing the
    // "BH bops out of place" effect during fast mouse drags.
    controls.update();
    camera.updateMatrixWorld(true);
    if (bhLensingUniforms && galacticCorePos) {
      // In galactic view the BH is repositioned to world origin, not galacticCorePos
      var _bhWorldPos = galacticViewActive ? new THREE.Vector3(0,0,0) : galacticCorePos;
      _bhScreenPos.copy(_bhWorldPos);
      if (bhEHRadius > 0) {
        var _camToBH = camera.position.distanceTo(_bhWorldPos);
        var _halfTanFov = Math.tan(camera.fov * Math.PI / 360);
        // The BH model is scaled in both views — by _galF in the galactic
        // view, by BH_MW_SCALE in the Milky Way view — so the world-space
        // event horizon radius must be scaled the same way.
        var _ehWorld = galacticViewActive && galaxyVisualRadius > 0
          ? bhEHRadius * (20.0 / (galaxyVisualRadius * 0.4))
          : bhEHRadius * BH_MW_SCALE;
        var _shadowR = _ehWorld / (_camToBH * _halfTanFov * 2.0) * BH_TUNE.sphereScale;
        bhLensingUniforms.uShadowR.value = Math.max(_shadowR, 0.015);
        bhLensingUniforms.uInnerR.value  = Math.max(_shadowR * 0.82, 0.012);
        bhLensingUniforms.uOuterR.value  = Math.max(_shadowR * 1.35, 0.04);
      }
      _bhScreenPos.project(camera);
      bhLensingUniforms.uCenter.value.set(
        (_bhScreenPos.x + 1.0) * 0.5,
        (_bhScreenPos.y + 1.0) * 0.5
      );
    }
    finalComposer.render();
  } else {
    renderer.render(scene, camera);
  }
}
animate();

// Close info panel and list
document.getElementById("closePanel").addEventListener("click", () => {
  document.getElementById("panel").style.display = "none";
  document.getElementById("backToList").style.display = "none";
  listVisible = false;
  document.getElementById("toggleList").textContent = "Show Bodies";
});

// Bodies list data
const bodyList = [
  { label: "• Sun", obj: sun },
  { label: "• Mercury", obj: meshes.find(m => m.userData.name === "Mercury") },
  { label: "• Venus", obj: meshes.find(m => m.userData.name === "Venus") },
  { label: "• Earth", obj: meshes.find(m => m.userData.name === "Earth") },
  { label: "　 ◦ Moon", obj: moon },
  { label: " • Mars", obj: meshes.find(m => m.userData.name === "Mars") },
  { label: "　 ◦ Phobos", obj: (marsMoons.find(p => p.mesh.userData.name === "Phobos") || {}).mesh },
  { label: "　 ◦ Deimos", obj: (marsMoons.find(p => p.mesh.userData.name === "Deimos") || {}).mesh },
  { label: " • Ceres", obj: meshes.find(m => m.userData.name === "Ceres") },
  { label: " • Jupiter", obj: meshes.find(m => m.userData.name === "Jupiter") },
  { label: "　 ◦ Io", obj: io.mesh },
  { label: "　 ◦ Europa", obj: europa.mesh },
  { label: "　 ◦ Ganymede", obj: ganymede.mesh },
  { label: "　 ◦ Callisto", obj: callisto.mesh },
  { label: " • Saturn", obj: meshes.find(m => m.userData.name === "Saturn") },
  { label: "　 ◦ Mimas",     obj: (saturnMoons.find(p => p.mesh.userData.name === "Mimas") || {}).mesh },
  { label: "　 ◦ Enceladus", obj: (saturnMoons.find(p => p.mesh.userData.name === "Enceladus") || {}).mesh },
  { label: "　 ◦ Tethys",    obj: (saturnMoons.find(p => p.mesh.userData.name === "Tethys") || {}).mesh },
  { label: "　 ◦ Dione",     obj: (saturnMoons.find(p => p.mesh.userData.name === "Dione") || {}).mesh },
  { label: "　 ◦ Rhea",      obj: (saturnMoons.find(p => p.mesh.userData.name === "Rhea") || {}).mesh },
  { label: "　 ◦ Titan",     obj: (saturnMoons.find(p => p.mesh.userData.name === "Titan") || {}).mesh },
  { label: "　 ◦ Iapetus",   obj: (saturnMoons.find(p => p.mesh.userData.name === "Iapetus") || {}).mesh },
  { label: " • Uranus", obj: meshes.find(m => m.userData.name === "Uranus") },
  { label: "　 ◦ Miranda", obj: (uranusMoons.find(p => p.mesh.userData.name === "Miranda") || {}).mesh },
  { label: "　 ◦ Ariel",   obj: (uranusMoons.find(p => p.mesh.userData.name === "Ariel") || {}).mesh },
  { label: "　 ◦ Umbriel", obj: (uranusMoons.find(p => p.mesh.userData.name === "Umbriel") || {}).mesh },
  { label: "　 ◦ Titania", obj: (uranusMoons.find(p => p.mesh.userData.name === "Titania") || {}).mesh },
  { label: "　 ◦ Oberon",  obj: (uranusMoons.find(p => p.mesh.userData.name === "Oberon") || {}).mesh },
  { label: " • Neptune", obj: meshes.find(m => m.userData.name === "Neptune") },
  { label: "　 ◦ Triton", obj: (neptuneMoons.find(p => p.mesh.userData.name === "Triton") || {}).mesh },
  { label: " • Pluto", obj: meshes.find(m => m.userData.name === "Pluto") },
  { label: "　 ◦ Charon", obj: (plutoMoons.find(p => p.mesh.userData.name === "Charon") || {}).mesh },
  { label: "　 ◦ Styx", obj: (plutoMoons.find(p => p.mesh.userData.name === "Styx") || {}).mesh },
  { label: "　 ◦ Nix", obj: (plutoMoons.find(p => p.mesh.userData.name === "Nix") || {}).mesh },
  { label: "　 ◦ Kerberos", obj: (plutoMoons.find(p => p.mesh.userData.name === "Kerberos") || {}).mesh },
  { label: "　 ◦ Hydra", obj: (plutoMoons.find(p => p.mesh.userData.name === "Hydra") || {}).mesh },
  { label: " • Haumea", obj: meshes.find(m => m.userData.name === "Haumea") },
  { label: "　 ◦ Hiʻiaka", obj: (haumeaMoons.find(p => p.mesh.userData.name === "Hi'iaka") || {}).mesh },
  { label: "　 ◦ Namaka", obj: (haumeaMoons.find(p => p.mesh.userData.name === "Namaka") || {}).mesh },
  { label: " • Makemake", obj: meshes.find(m => m.userData.name === "Makemake") },
  { label: " • Eris", obj: meshes.find(m => m.userData.name === "Eris") },
  { label: "　 ◦ Dysnomia", obj: (erisMoons.find(p => p.mesh.userData.name === "Dysnomia") || {}).mesh },
];

function showList() {
  if (galacticViewActive || spaceshipViewActive) return;
  document.getElementById("panel").style.display = "block";
  document.getElementById("backToList").style.display = "none";

  let html = "<b>Solar System</b><br><br>";
  bodyList.forEach(item => {
    html += `<div class="bodyItem" style="
      padding: 5px 8px;
      margin-bottom: 4px;
      cursor: pointer;
      border-radius: 4px;
      font-size: 13px;
      background: rgba(255,255,255,0.05);
      transition: background 0.2s;
    " onmouseover="this.style.background='rgba(255,255,255,0.15)'"
       onmouseout="this.style.background='rgba(255,255,255,0.05)'"
       data-label="${item.label}">
      ${item.label}
    </div>`;
  });

  document.getElementById("panelContent").innerHTML = html;

  // Add click handlers to each item
  document.querySelectorAll(".bodyItem").forEach((el, i) => {
    el.addEventListener("click", () => {
      const item = bodyList[i];
      flyToObject(item.obj, true);   // from the bodies panel: always (re-)frame the body
    });
  });
}


// Back to list button
document.getElementById("backToList").addEventListener("click", () => {
  if (viewManager.activeName === 'kepler') { viewManager.active.showList(); return; }
  // If Mercury's precession trail is on, Back first exits that mode and returns to
  // the normal Mercury panel (rather than jumping straight to the bodies list).
  if (mercuryTrailMode) { toggleMercuryTrail(); return; }
  showList();
});

function showBodiesList() {
  listVisible = true;
  showList();
  document.getElementById('toggleList').textContent = 'Hide Bodies';
}

// Toggle list button
let listVisible = false;
document.getElementById("toggleList").addEventListener("click", () => {
  // In the Kepler-22 system view this button toggles that system's bodies list
  if (viewManager.activeName === 'kepler') { viewManager.active.toggleList(); return; }
  listVisible = !listVisible;
  if (listVisible) {
    showList();
    document.getElementById("toggleList").textContent = "Hide Bodies";
  } else {
    document.getElementById("panel").style.display = "none";
    document.getElementById("toggleList").textContent = "Show Bodies";
  }
});

// Show bodies list on initial load
showBodiesList();

// Press Escape to unlock camera
window.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    lockedObject = null;
  }
  if (e.key === "f" || e.key === "F") {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    _fpsMeterOn = !_fpsMeterOn;
    const el = document.getElementById('fpsMeter');
    if (el) el.style.display = _fpsMeterOn ? 'block' : 'none';
  }
});

// Resize
window.addEventListener("resize", ()=>{
  markCameraActive(); // force full-rate redraw through the resize
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  if (viewManager.active && viewManager.active.camera) {
    viewManager.active.camera.aspect = innerWidth/innerHeight;
    viewManager.active.camera.updateProjectionMatrix();
  }
  renderer.setSize(innerWidth, innerHeight);
  if (bloomComposer) bloomComposer.setSize(innerWidth, innerHeight);
  if (finalComposer)  finalComposer.setSize(innerWidth, innerHeight);
  if (bhLensingUniforms) bhLensingUniforms.uAspect.value = innerWidth / innerHeight;
});

// ════════════════════════════════════════════════════════════════════════
// MAIN MENU SCREEN
// ════════════════════════════════════════════════════════════════════════

(function initMainMenu() {
  const menuEl = document.getElementById('mainMenu');
  if (!menuEl) return;

  // ── Planet timeline strip (sqrt scale, gives "real relative distance" feel)
  const stripData = [
    { name: 'Sun',     au: 0,    sun: true },
    { name: 'Mercury', au: 0.39 },
    { name: 'Venus',   au: 0.72 },
    { name: 'Earth',   au: 1.0  },
    { name: 'Mars',    au: 1.52 },
    { name: 'Jupiter', au: 5.2  },
    { name: 'Saturn',  au: 9.5  },
    { name: 'Uranus',  au: 19.2 },
    { name: 'Neptune', au: 30.0 }
  ];
  const stripInner = document.getElementById('stripInner');
  const maxAu = 30.0;

  // Glowing white chevron that points down at the planet the user clicks
  const stripPointer = document.createElement('div');
  stripPointer.className = 'stripPointer';
  stripInner.appendChild(stripPointer);
  let selectedStripPlanet = null;
  // Name of the body the user selected — read by the mini scene to aim its
  // own arrow at the matching planet/sun (set in the click handler below).
  let selectedBodyName = null;

  stripData.forEach(p => {
    const t = Math.sqrt(p.au / maxAu); // 0..1
    const leftPct = 3 + t * 94;        // 3% margin on each side
    const wrap = document.createElement('div');
    wrap.className = 'stripPlanet';
    wrap.style.left = leftPct + '%';
    const dot = document.createElement('div');
    dot.className = 'stripDot' + (p.sun ? ' sun' : '');
    const lbl = document.createElement('div');
    lbl.className = 'stripLabel';
    lbl.textContent = p.name;
    if (!p.sun) {
      const au = document.createElement('span');
      au.className = 'stripAu';
      au.textContent = p.au + ' AU';
      lbl.appendChild(au);
    }
    wrap.appendChild(dot);
    wrap.appendChild(lbl);
    // Clicking a planet (or the Sun) drops the glowing pointer onto it.
    // Clicking the already-selected body again deselects it.
    wrap.addEventListener('click', () => {
      if (selectedStripPlanet === wrap) {
        // Toggle off: clear selection, hide pointer and mini-scene ring
        wrap.classList.remove('selected');
        selectedStripPlanet = null;
        selectedBodyName = null;
        stripPointer.classList.remove('visible');
        return;
      }
      if (selectedStripPlanet) selectedStripPlanet.classList.remove('selected');
      wrap.classList.add('selected');
      selectedStripPlanet = wrap;
      selectedBodyName = p.name;
      stripPointer.style.left = leftPct + '%';
      stripPointer.classList.add('visible');
    });
    stripInner.appendChild(wrap);
  });

  // ── Animated star particle background
  const starCanvas = document.getElementById('starField');
  const starCtx = starCanvas.getContext('2d');
  let starW = 0, starH = 0;
  let stars = [];
  function resizeStarField() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    starW = starCanvas.clientWidth;
    starH = starCanvas.clientHeight;
    starCanvas.width = starW * dpr;
    starCanvas.height = starH * dpr;
    starCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.floor((starW * starH) / 3200);
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * starW,
        y: Math.random() * starH,
        r: Math.random() * 1.1 + 0.2,
        a: Math.random() * 0.7 + 0.2,
        vx: (Math.random() - 0.5) * 0.04,
        vy: (Math.random() - 0.5) * 0.02,
        tw: Math.random() * Math.PI * 2
      });
    }
  }
  resizeStarField();
  window.addEventListener('resize', resizeStarField);

  let menuActive = true;
  function drawStars(ts) {
    if (!menuActive) return;
    starCtx.clearRect(0, 0, starW, starH);
    const t = ts * 0.001;
    for (const s of stars) {
      s.x += s.vx; s.y += s.vy;
      if (s.x < 0) s.x += starW; else if (s.x > starW) s.x -= starW;
      if (s.y < 0) s.y += starH; else if (s.y > starH) s.y -= starH;
      const flicker = 0.75 + 0.25 * Math.sin(t * 1.2 + s.tw);
      starCtx.globalAlpha = s.a * flicker;
      starCtx.fillStyle = '#cfe0ff';
      starCtx.beginPath();
      starCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      starCtx.fill();
    }
    starCtx.globalAlpha = 1;
    requestAnimationFrame(drawStars);
  }
  requestAnimationFrame(drawStars);

  // ── Full-screen Milky Way skybox behind the menu — identical texture and
  //    camera framing to the main 3D view, so the background reads as the same
  //    sky you fly into when the menu fades out.
  const menuSkyCanvas = document.getElementById('menuSky');
  const menuSkyRenderer = new THREE.WebGLRenderer({
    canvas: menuSkyCanvas,
    antialias: true
  });
  menuSkyRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const menuSkyScene = new THREE.Scene();
  // fov matches the mini scene camera (55) so star scale is identical across the
  // card edge; position/orientation/skybox-rotation are synced to the mini scene
  // every frame in animateMini, so this is literally the same moving sky.
  const menuSkyCamera = new THREE.PerspectiveCamera(55, 1, 0.1, 100000);
  menuSkyCamera.position.set(0, 24, 52);
  menuSkyCamera.lookAt(0, 0, 0);
  const menuSkyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(20000, 64, 64),
    new THREE.MeshBasicMaterial({ map: milkyWayTexture, side: THREE.BackSide })
  );
  menuSkyScene.add(menuSkyMesh);
  function renderMenuSky() {
    const w = menuSkyCanvas.clientWidth;
    const h = menuSkyCanvas.clientHeight;
    if (w === 0 || h === 0) return;
    menuSkyRenderer.setSize(w, h, false);
    menuSkyCamera.aspect = w / h;
    menuSkyCamera.updateProjectionMatrix();
    menuSkyRenderer.render(menuSkyScene, menuSkyCamera);
  }
  renderMenuSky();
  window.addEventListener('resize', renderMenuSky);
  // Texture may finish loading after first render — repaint when it arrives
  if (milkyWayTexture.image && !milkyWayTexture.image.complete) {
    milkyWayTexture.image.addEventListener('load', renderMenuSky);
  }

  // ── Mini Three.js solar system in the left half
  const miniCanvas = document.getElementById('miniSolar');
  const miniRenderer = new THREE.WebGLRenderer({
    canvas: miniCanvas,
    antialias: true,
    alpha: true
  });
  miniRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const miniScene = new THREE.Scene();
  const miniCamera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);

  function resizeMini() {
    const w = miniCanvas.clientWidth;
    const h = miniCanvas.clientHeight;
    if (w === 0 || h === 0) return;
    miniRenderer.setSize(w, h, false);
    miniCamera.aspect = w / h;
    miniCamera.updateProjectionMatrix();
  }
  resizeMini();
  window.addEventListener('resize', resizeMini);

  // Glowing white V that tracks the selected body in the mini scene. Lives in
  // the (position:relative) left panel so canvas pixels map 1:1 to its coords.
  const miniPointer = document.createElement('div');
  miniPointer.id = 'miniPointer';
  miniCanvas.parentElement.appendChild(miniPointer);
  const _miniProj = new THREE.Vector3();
  const _miniCenter = new THREE.Vector3();
  const _miniRight = new THREE.Vector3();
  const _miniEdge = new THREE.Vector3();

  // Camera tilted to see orbital plane in 3/4 view, pulled back to fit Neptune
  miniCamera.position.set(0, 24, 52);
  miniCamera.lookAt(0, 0, 0);

  // No skybox here — the mini scene renders only the solar system on a
  // transparent canvas, floating over the single full-screen #menuSky behind it.

  // Sun (always self-lit). Sized down a touch (2.4 → 2.0) so the orbits have more
  // breathing room and the scene reads as cinematic rather than toy-sized.
  const miniSun = new THREE.Mesh(
    new THREE.SphereGeometry(2.0, 48, 48),
    new THREE.MeshBasicMaterial({ map: sunTexture, color: 0xffeecc })
  );
  miniScene.add(miniSun);
  // Sphere radii (scene units) for sizing the selection ring; Sun is 2.0
  const bodyRadius = { Sun: 2.0 };

  // Sun glow sprite (soft halo)
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = 256; glowCanvas.height = 256;
  const gctx = glowCanvas.getContext('2d');
  const grad = gctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0,   'rgba(255, 220, 150, 0.85)');
  grad.addColorStop(0.3, 'rgba(255, 180, 90, 0.35)');
  grad.addColorStop(1,   'rgba(255, 140, 50, 0)');
  gctx.fillStyle = grad;
  gctx.fillRect(0, 0, 256, 256);
  const glowTex = new THREE.CanvasTexture(glowCanvas);
  const miniGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  miniGlow.scale.set(9.2, 9.2, 1);
  miniScene.add(miniGlow);

  // Sun-side lighting: softer point light + warmer ambient floor so the night
  // side reads as shadowed but still has detail, and the day side isn't blown
  // out. decay=0 so distant outer planets aren't dimmer than inner.
  miniScene.add(new THREE.PointLight(0xffeecc, 1.3, 0, 0));
  miniScene.add(new THREE.AmbientLight(0x90a8c4, 0.32));

  // Real orbital periods span ~684× (Mercury 0.24 yr → Neptune 164.79 yr).
  // A single linear multiplier can't make all 8 planets visibly move — either
  // Mercury blurs or Neptune freezes. Compress with 1/sqrt(period) so outer
  // planets are still slower than inner, but visibly orbit during one session.
  const YEAR_SEC = 365.25 * 86400;
  const EARTH_VIEW_PERIOD_SEC = 10; // Earth completes one orbit every 10 s on screen
  const EARTH_BASE_SPEED = (2 * Math.PI) / EARTH_VIEW_PERIOD_SEC;
  const earthMultiplier = YEAR_SEC / EARTH_VIEW_PERIOD_SEC; // ≈ 3,155,760

  const speedLabelEl = document.getElementById('miniSpeedLabel');
  if (speedLabelEl) {
    const rounded = Math.round(earthMultiplier / 100000) * 100000;
    speedLabelEl.textContent = '≈ ' + rounded.toLocaleString() + '× real-life speed';
  }

  // Planets — all 8, compressed but monotonic distances, real period ratios
  // Sizes trimmed ~15% from their old values so the planets sit lighter on their orbits
  // (less toy-like, more negative space) while keeping the real relative-size ordering.
  const miniPlanetDefs = [
    { name:'Mercury', dist: 4.0,  size: 0.36, tex: mercuryTexture, color: 0xbbbbbb, years: 0.2408 },
    { name:'Venus',   dist: 5.6,  size: 0.53, tex: venusTexture,   color: 0xffcc88, years: 0.6152 },
    { name:'Earth',   dist: 7.4,  size: 0.60, tex: earthTexture,   color: 0xffffff, years: 1.0000 },
    { name:'Mars',    dist: 9.4,  size: 0.44, tex: marsTexture,    color: 0xff8866, years: 1.8810 },
    { name:'Jupiter', dist: 14.0, size: 1.32, tex: jupiterTexture, color: 0xffddaa, years: 11.862 },
    { name:'Saturn',  dist: 18.5, size: 1.10, tex: saturnTexture,  color: 0xffeebb, years: 29.457 },
    { name:'Uranus',  dist: 22.5, size: 0.78, tex: uranusTexture,  color: 0xaaddff, years: 84.011 },
    { name:'Neptune', dist: 26.5, size: 0.76, tex: neptuneTexture, color: 0x6688ff, years: 164.79 }
  ];

  const miniPlanets = [];
  let saturnMesh = null;
  let saturnRingMesh = null;
  let earthMesh = null;
  let earthShaderMat = null;

  // Comet-tail orbit trails (NASA-Eyes style): each body trails a fading arc behind it.
  const MINI_TRAIL_SEG = 80;                 // points per trail arc
  const MINI_TRAIL_SPAN = Math.PI * 1.5;     // arc length behind the body (~270° → leaves a clear empty gap, never a full ring)
  const MINI_TRAIL_HEAD = 0.78;              // peak brightness at the body (additive)
  const MINI_TRAIL_FADE = 2.3;               // fade exponent — higher = tail vanishes faster, sharper comet head

  // Build one comet-tail trail line (vertex-coloured, additive so the faded tail vanishes
  // cleanly over the transparent menu canvas). Returns a handle updated each frame by
  // updateMiniTrail. Used for both planets (centred on the Sun) and moons (centred on the
  // parent planet's current position).
  function makeMiniTrail(colorHex) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((MINI_TRAIL_SEG + 1) * 3);
    const col = new Float32Array((MINI_TRAIL_SEG + 1) * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    line.frustumCulled = false;       // tiny moon arcs can fall outside the frustum test cheaply
    miniScene.add(line);
    return { geo, pos, col, color: new THREE.Color(colorHex) };
  }

  // Lay the trail as an arc of `radius` centred on (cx,cy,cz): head sits on the body at
  // `angle`, sweeping back MINI_TRAIL_SPAN and fading to nothing at the tail. `dir` is the
  // sign of the body's angular velocity so the tail always trails BEHIND the motion — a
  // retrograde body (e.g. Triton, dir = -1) trails the opposite way, not ahead of itself.
  function updateMiniTrail(t, cx, cy, cz, radius, angle, dir) {
    const { pos, col, color } = t;
    const back = MINI_TRAIL_SPAN * (dir < 0 ? -1 : 1);
    for (let s = 0; s <= MINI_TRAIL_SEG; s++) {
      const f = s / MINI_TRAIL_SEG;                          // 0 at tail → 1 at head (the body)
      const a = angle - back * (1 - f);
      pos[s * 3] = cx + Math.cos(a) * radius;
      pos[s * 3 + 1] = cy;
      pos[s * 3 + 2] = cz + Math.sin(a) * radius;
      const inten = Math.pow(f, MINI_TRAIL_FADE) * MINI_TRAIL_HEAD;
      col[s * 3] = color.r * inten; col[s * 3 + 1] = color.g * inten; col[s * 3 + 2] = color.b * inten;
    }
    t.geo.attributes.position.needsUpdate = true;
    t.geo.attributes.color.needsUpdate = true;
  }

  // Custom Earth day/night shader: blends daymap with nightmap (city lights)
  // across the terminator using the dot product between surface normal and
  // the sun direction. sunDir is updated each frame as Earth orbits.
  function makeEarthMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        dayMap:   { value: earthTexture },
        nightMap: { value: earthNightTexture },
        sunDir:   { value: new THREE.Vector3(1, 0, 0) },
        ambient:  { value: 0.18 },
        nightBoost: { value: 3.2 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D dayMap;
        uniform sampler2D nightMap;
        uniform vec3 sunDir;
        uniform float ambient;
        uniform float nightBoost;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        void main() {
          float cosA = dot(normalize(vWorldNormal), normalize(sunDir));
          // Smooth dawn/dusk band roughly 18 deg wide centred on the terminator
          float dayWeight = smoothstep(-0.15, 0.20, cosA);
          vec3 dayColor   = texture2D(dayMap, vUv).rgb;
          // Warm sodium-lamp tint so the city glow reads as artificial light, not just bright pixels
          vec3 nightColor = texture2D(nightMap, vUv).rgb * nightBoost * vec3(1.05, 0.95, 0.72);
          // Day side: lambert-ish with an ambient floor so night→day mix is smooth
          float dayLight = mix(ambient, 1.0, max(cosA, 0.0));
          vec3 day = dayColor * dayLight;
          gl_FragColor = vec4(mix(nightColor, day, dayWeight), 1.0);
        }
      `
    });
  }

  miniPlanetDefs.forEach((p, i) => {
    let material;
    if (p.name === 'Earth') {
      earthShaderMat = makeEarthMaterial();
      material = earthShaderMat;
    } else {
      material = new THREE.MeshPhongMaterial({
        map: p.tex,
        color: p.color,
        shininess: 6,
        specular: 0x111111
      });
    }
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(p.size, 48, 48),
      material
    );
    if (p.name === 'Earth') earthMesh = mesh;
    bodyRadius[p.name] = p.size;
    const speed = EARTH_BASE_SPEED / Math.sqrt(p.years);
    const startAngle = (i / miniPlanetDefs.length) * Math.PI * 2 + Math.random() * 0.5;
    miniScene.add(mesh);

    // Comet-tail orbit trail instead of a static full ring: a fading C-shaped arc trailing
    // behind the planet, tinted with its real-model orbit colour (ORBIT_COLORS). See makeMiniTrail.
    const trail = makeMiniTrail(ORBIT_COLORS[p.name] || 0x6da8ff);
    miniPlanets.push({ mesh, name: p.name, dist: p.dist, speed, angle: startAngle, trail });

    if (p.name === 'Saturn') {
      saturnMesh = mesh;
      const ringInner = p.size * 1.35;
      const ringOuter = p.size * 2.35;
      const ringGeo = new THREE.RingGeometry(ringInner, ringOuter, 96, 1);
      // Remap UVs so the radial direction maps to U (texture x), matching the
      // saturn ring alpha texture's strip layout.
      const posArr = ringGeo.attributes.position.array;
      const uvAttr = ringGeo.attributes.uv;
      for (let v = 0; v < uvAttr.count; v++) {
        const vx = posArr[v * 3];
        const vy = posArr[v * 3 + 1];
        const r = Math.sqrt(vx * vx + vy * vy);
        const t = (r - ringInner) / (ringOuter - ringInner);
        uvAttr.setXY(v, t, 0.5);
      }
      const ringMat = new THREE.MeshBasicMaterial({
        map: ringTexture,
        transparent: true,
        side: THREE.DoubleSide,
        opacity: 0.95,
        depthWrite: false
      });
      saturnRingMesh = new THREE.Mesh(ringGeo, ringMat);
      // Lie in orbital plane, then tilt by Saturn's axial tilt (~26.7°)
      saturnRingMesh.rotation.x = Math.PI / 2;
      saturnRingMesh.rotation.y = 26.73 * Math.PI / 180;
      miniScene.add(saturnRingMesh);
    }
  });

  // ── Moons: Earth's Moon + Jupiter's four Galilean moons.
  // Moon periods (vs their parent's orbit) are much shorter than planet
  // periods vs the Sun, so applying the same 1/sqrt(period) scheme would
  // smear Io into a blur. Instead, pin reasonable on-screen periods that
  // preserve relative ordering.
  // Only moons large enough to actually read at this scale earn a spot — the tiny
  // Mars/Pluto moons would be sub-pixel specks and just add clutter. Titan (Saturn) and
  // Triton (Neptune) round out the two outer giants; Triton orbits retrograde (negative
  // period) like the real moon.
  // `color` tints each moon's comet-tail trail to roughly its real appearance.
  const moonDefs = [
    { name: 'Moon',     parent: 'Earth',   tex: moonTexture,     size: 0.18, dist: 1.30, period: 2.7, color: 0xc9c9c9 },
    { name: 'Io',       parent: 'Jupiter', tex: ioTexture,       size: 0.16, dist: 1.95, period: 1.5, color: 0xf4e07a },
    { name: 'Europa',   parent: 'Jupiter', tex: europaTexture,   size: 0.14, dist: 2.45, period: 2.1, color: 0xd8c9b0 },
    { name: 'Ganymede', parent: 'Jupiter', tex: ganymedeTexture, size: 0.19, dist: 3.10, period: 3.0, color: 0x9a8d79 },
    { name: 'Callisto', parent: 'Jupiter', tex: callistoTexture, size: 0.16, dist: 3.85, period: 4.6, color: 0x7e7163 },
    { name: 'Titan',    parent: 'Saturn',  tex: titanTexture,    size: 0.17, dist: 2.95, period: 3.9, color: 0xe6a63c },
    { name: 'Triton',   parent: 'Neptune', tex: tritonTexture,   size: 0.15, dist: 1.55, period: -2.6, color: 0xcbd2e0 }
  ];
  const planetByName = {};
  for (const p of miniPlanets) planetByName[p.name] = p.mesh;

  const miniMoons = moonDefs.map(m => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(m.size, 32, 32),
      new THREE.MeshPhongMaterial({ map: m.tex, shininess: 4, specular: 0x111111 })
    );
    miniScene.add(mesh);
    return {
      mesh,
      parentMesh: planetByName[m.parent],
      dist: m.dist,
      speed: (2 * Math.PI) / m.period,
      angle: Math.random() * Math.PI * 2,
      tilt: (Math.random() - 0.5) * 0.25,
      trail: makeMiniTrail(m.color || 0xc9c9c9)   // comet-tail trail, centred on the parent each frame
    };
  });

  // Slight orbital plane tilt for cinematic look
  const planeTilt = 0.18;
  let miniLast = performance.now();
  function animateMini() {
    if (!menuActive) return;
    const now = performance.now();
    const dt = (now - miniLast) * 0.001;
    miniLast = now;

    miniSun.rotation.y += dt * 0.28;

    for (const p of miniPlanets) {
      p.angle += p.speed * dt;
      const x = Math.cos(p.angle) * p.dist;
      const z = Math.sin(p.angle) * p.dist;
      p.mesh.position.set(x, Math.sin(p.angle) * planeTilt * p.dist * 0.05, z);
      p.mesh.rotation.y += dt * 0.5;

      // Rebuild the fading comet-tail trailing behind the planet (centred on the Sun).
      updateMiniTrail(p.trail, 0, 0, 0, p.dist, p.angle, p.speed);
    }

    if (saturnMesh && saturnRingMesh) {
      saturnRingMesh.position.copy(saturnMesh.position);
    }

    // Earth's sun direction (Earth → Sun, world space) drives the day/night shader
    if (earthShaderMat && earthMesh) {
      const ep = earthMesh.position;
      earthShaderMat.uniforms.sunDir.value
        .set(-ep.x, -ep.y, -ep.z)
        .normalize();
    }

    for (const m of miniMoons) {
      if (!m.parentMesh) continue;
      m.angle += m.speed * dt;
      const px = m.parentMesh.position.x;
      const py = m.parentMesh.position.y;
      const pz = m.parentMesh.position.z;
      const mx = Math.cos(m.angle) * m.dist;
      const mz = Math.sin(m.angle) * m.dist;
      m.mesh.position.set(px + mx, py + Math.sin(m.angle) * m.tilt, pz + mz);
      m.mesh.rotation.y += dt * 0.4;
      // Comet-tail trail orbiting the parent planet's CURRENT position.
      updateMiniTrail(m.trail, px, py, pz, m.dist, m.angle, m.speed);
    }

    // Very slow camera drift for cinematic feel
    const camT = now * 0.00004;
    miniCamera.position.x = Math.sin(camT) * 8;
    miniCamera.position.z = 50 + Math.cos(camT) * 5;
    miniCamera.position.y = 22 + Math.sin(camT * 1.3) * 2.5;
    miniCamera.lookAt(0, 0, 0);

    // Render the single full-screen sky first (the only background in the
    // menu), then the transparent solar-system canvas floats on top of it.
    // The mini camera drives the sky so planets and stars drift as one.
    menuSkyMesh.rotation.y += dt * 0.002;
    menuSkyCamera.position.copy(miniCamera.position);
    menuSkyCamera.quaternion.copy(miniCamera.quaternion);
    menuSkyRenderer.render(menuSkyScene, menuSkyCamera);

    miniRenderer.render(miniScene, miniCamera);

    // Encircle the selected body with the glowing ring and follow it as it
    // orbits, projecting its 3D position (and a sphere-radius offset for size)
    // onto the canvas each frame.
    if (selectedBodyName) {
      const target = selectedBodyName === 'Sun' ? miniSun : planetByName[selectedBodyName];
      if (target) {
        target.getWorldPosition(_miniCenter);
        _miniProj.copy(_miniCenter).project(miniCamera);
        if (_miniProj.z < 1) {
          const w = miniCanvas.clientWidth, h = miniCanvas.clientHeight;
          const cx = (_miniProj.x * 0.5 + 0.5) * w;
          const cy = (-_miniProj.y * 0.5 + 0.5) * h;
          // Project a point one sphere-radius to the camera's right → screen radius
          _miniRight.setFromMatrixColumn(miniCamera.matrixWorld, 0);
          _miniEdge.copy(_miniCenter).addScaledVector(_miniRight, bodyRadius[selectedBodyName] || 1);
          _miniEdge.project(miniCamera);
          const screenR = Math.hypot(
            (_miniEdge.x * 0.5 + 0.5) * w - cx,
            (-_miniEdge.y * 0.5 + 0.5) * h - cy
          );
          const dia = Math.max(10, screenR * 2 + 10); // ring sits just outside the sphere
          miniPointer.style.width = dia + 'px';
          miniPointer.style.height = dia + 'px';
          miniPointer.style.left = cx + 'px';
          miniPointer.style.top = cy + 'px';
          miniPointer.classList.add('visible');
        } else {
          miniPointer.classList.remove('visible');
        }
      }
    } else {
      miniPointer.classList.remove('visible');
    }

    requestAnimationFrame(animateMini);
  }
  requestAnimationFrame(animateMini);

  // ── Button handlers
  function dismissMenu(then) {
    menuActive = false;
    menuEl.classList.add('hidden');
    setTimeout(() => {
      if (typeof then === 'function') then();
    }, 950);
  }

  function openMenu() {
    // Return user to a clean default state — exit any non-default views
    if (typeof galacticViewActive !== 'undefined' && galacticViewActive
        && typeof exitGalacticView === 'function') {
      try { exitGalacticView(); } catch (e) { console.warn('exitGalacticView failed:', e); }
    }
    if (typeof spaceshipViewActive !== 'undefined' && spaceshipViewActive
        && typeof exitSpaceshipView === 'function') {
      try { exitSpaceshipView(); } catch (e) { console.warn('exitSpaceshipView failed:', e); }
    }
    try { viewManager.exitActive(); } catch (e) { console.warn('exitActive failed:', e); }
    // Close any open info panel
    const ipanel = document.getElementById('panel');
    if (ipanel) ipanel.style.display = 'none';

    menuEl.classList.remove('hidden');
    if (!menuActive) {
      menuActive = true;
      miniLast = performance.now();
      resizeStarField();
      resizeMini();
      renderMenuSky();
      requestAnimationFrame(drawStars);
      requestAnimationFrame(animateMini);
    }
  }

  // Expose so the floating "Main Menu" button can call it
  window.openMainMenu = openMenu;

  document.getElementById('btnEnter').addEventListener('click', () => {
    dismissMenu();
  });

  document.getElementById('btnGalaxy').addEventListener('click', () => {
    dismissMenu(() => {
      if (typeof enterGalacticView === 'function') {
        try { enterGalacticView(); } catch (e) { console.warn('enterGalacticView failed:', e); }
      }
    });
  });

  document.getElementById('btnSizes').addEventListener('click', () => {
    dismissMenu(() => {
      viewManager.enter('sizes').catch(e => console.warn('enter sizes failed:', e));
    });
  });

  // Floating return-to-menu button
  const returnBtn = document.getElementById('returnToMenuBtn');
  if (returnBtn) {
    returnBtn.addEventListener('click', () => openMenu());
  }
})();
// Bridge functions referenced by inline HTML on* attributes into the global
// scope (ES modules are scoped; inline handlers resolve against window).
Object.assign(window, {
  flyToSolarSystem, flyToMilkyWay, spaceshipBackBtn,
  returnToMainMenu, collapseGalacticLegend, expandGalacticLegend,
});

// ── BH Tuner panel ───────────────────────────────────────────────────────────
// Live controls for every black-hole visual parameter (BH_TUNE), shared by
// the galaxy view and the True-Size room. Markup shell lives in index.html;
// rows are built here from the ROWS table. Values persist in localStorage.
(function initBHTuner() {
  const btn     = document.getElementById('bhTunerBtn');
  const panel   = document.getElementById('bhTunerPanel');
  const rowsBox = document.getElementById('bhTunerRows');
  const ratioEl = document.getElementById('bhTunerRatio');
  if (!btn || !panel || !rowsBox) return;

  // [section] or [label, key, min, max, step, derivedFn]
  const ROWS = [
    ['SIZE'],
    ['Black sphere',    'sphereScale', 0.2,  3.0,  0.01, v => '≈ ' + (24 * v).toFixed(1) + ' M km wide'],
    ['Disc outer edge', 'discOuter',   2.0, 14.0,  0.1,  v => '≈ ' + (20.5 * v).toFixed(0) + ' M km wide'],
    ['Disc inner edge', 'discInner',   0.1,  3.0,  0.01, v => '≈ ' + (20.5 * v).toFixed(1) + ' M km wide'],
    ['Glow size',       'glowSize',    0,   20,    0.1,  v => '≈ ' + (20.5 * v).toFixed(0) + ' M km wide'],
    ['PHOTON RING'],
    ['Ring width',      'ringWidth',     0.005, 0.30, 0.005, null],
    ['Ring brightness', 'ringIntensity', 0,    12,    0.1,   null],
    ['Halo width',      'haloWidth',     0.02,  0.80, 0.01,  null],
    ['Halo brightness', 'haloIntensity', 0,     4,    0.02,  null],
    ['Lens warp',       'warpStrength',  0,     4,    0.02,  null],
    ['ACCRETION DISC'],
    ['Edge falloff',    'brightExp',  0.05, 2.5, 0.01, null],
    ['Disc brightness', 'brightPeak', 0.5,  8,   0.1,  null],
    ['Heat falloff',    'heatExp',    0.3,  3,   0.01, null],
    ['Wisp start',      'wispStart',  0.1,  1,   0.01, null],
    ['Flow speed',      'spinSpeed',  0,    5,   0.05, null],
    ['LIGHTING'],
    ['Colour boost',    'colorBoost',  0.5, 6, 0.1,  null],
    ['Glow opacity',    'glowOpacity', 0,   1, 0.01, null],
    ['Warm ambient',    'warmAmbient', 0,   2, 0.01, null],
  ];

  const inputs = {};   // key -> { slider, num, derivedEl, derivedFn }

  function saveTune() {
    try { localStorage.setItem('bhTune', JSON.stringify(BH_TUNE)); } catch (e) {}
  }
  function updateRatio() {
    if (!ratioEl) return;
    const sphere = 24 * BH_TUNE.sphereScale;
    const disc   = 20.5 * BH_TUNE.discOuter;
    ratioEl.textContent =
      'disc : sphere = ' + (disc / sphere).toFixed(2) + ':1  (true 8.54:1)';
  }
  function setValue(key, v, fromSlider) {
    const row = inputs[key];
    v = Math.max(row.min, Math.min(row.max, v));
    BH_TUNE[key] = v;
    if (!fromSlider) row.slider.value = v;
    row.num.value = v;
    if (row.derivedFn) row.derivedEl.textContent = row.derivedFn(v);
    applyBHTune();
    saveTune();
    updateRatio();
  }

  ROWS.forEach(r => {
    if (r.length === 1) {
      const h = document.createElement('div');
      h.className = 'bhTunerSection';
      h.textContent = r[0];
      rowsBox.appendChild(h);
      return;
    }
    const [label, key, min, max, step, derivedFn] = r;
    const row = document.createElement('div');
    row.className = 'bhTunerRow';

    const lab = document.createElement('span');
    lab.className = 'bhTunerLabel';
    lab.textContent = label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min; slider.max = max; slider.step = step;
    slider.value = BH_TUNE[key];

    const num = document.createElement('input');
    num.type = 'number';
    num.min = min; num.max = max; num.step = step;
    num.value = BH_TUNE[key];

    const derived = document.createElement('span');
    derived.className = 'bhTunerDerived';
    if (derivedFn) derived.textContent = derivedFn(BH_TUNE[key]);

    inputs[key] = { slider, num, derivedEl: derived, derivedFn, min, max };
    slider.addEventListener('input', () => setValue(key, parseFloat(slider.value), true));
    num.addEventListener('change', () => {
      const v = parseFloat(num.value);
      if (!isNaN(v)) setValue(key, v, false);
    });

    row.appendChild(lab);
    row.appendChild(slider);
    row.appendChild(num);
    if (derivedFn) row.appendChild(derived);
    rowsBox.appendChild(row);
  });
  updateRatio();

  btn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  });
  document.getElementById('bhTunerClose').addEventListener('click', () => {
    panel.style.display = 'none';
  });
  document.getElementById('bhTunerReset').addEventListener('click', () => {
    Object.keys(BH_TUNE_DEFAULTS).forEach(k => setValue(k, BH_TUNE_DEFAULTS[k], false));
  });
  document.getElementById('bhTunerCopy').addEventListener('click', function() {
    const txt = JSON.stringify(BH_TUNE, null, 2);
    if (navigator.clipboard) navigator.clipboard.writeText(txt);
    this.textContent = 'Copied!';
    setTimeout(() => { this.textContent = 'Copy values'; }, 1200);
  });
})();



