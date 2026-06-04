import { ctx } from './core/engine.js';
import { viewManager } from './viewManager.js';
import { loadGLB } from './core/assets.js';
import { data } from './data/planets.js';
import { MILKY_WAY_INFO, KEPLER_22B_INFO, marsTransformedInfo } from './data/info.js';

// Rooms (lazy-loaded). register() only stores a factory; the module is import()-ed
// on first entry, so its code + assets don't load until you visit it.
viewManager.register('andromeda', () => import('./rooms/andromeda.js'));

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.1, 1000000);
camera.position.set(0, 22, 110);

// Tilt the camera's "up" vector by 23.4° so the ecliptic plane appears inclined
// relative to Earth's equatorial reference frame — matching NASA Eyes' orientation
const ECLIPTIC_TILT = 23.4 * Math.PI / 180;
camera.up.set(Math.sin(ECLIPTIC_TILT), Math.cos(ECLIPTIC_TILT), 0);

const renderer = new THREE.WebGLRenderer({ antialias:true });
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

controls.enablePan = false;
controls.maxDistance = 1000000;

// Lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
scene.add(ambientLight);

const sunLight = new THREE.PointLight(0xffffff, 1.5);
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
const venusTexture = textureLoader.load("2k_venus_surface.jpg");
const moonTexture = textureLoader.load("2k_earth_moon.jpg");
const sunTexture = textureLoader.load("2k_sun.jpg");
const earthTexture = textureLoader.load("2k_earth_daymap.jpg");
const earthNightTexture = textureLoader.load("2k_earth_nightmap.jpg");
const ringTexture = textureLoader.load("8k_saturn_ring_alpha.png");
const milkyWayTexture = textureLoader.load("8k_stars_milky_way.jpg");
const callistoTexture = textureLoader.load("Callisto.jpg");
const europaTexture = textureLoader.load("Europa.jpg");
const ganymedeTexture = textureLoader.load("Ganymede.jpeg");
const ioTexture = textureLoader.load("Io.jpeg");

// 🌌 MILKY WAY SKYBOX
const SKYBOX_RADIUS = 20000;
const skyGeometry = new THREE.SphereGeometry(SKYBOX_RADIUS, 64, 64);
const skyMaterial = new THREE.MeshBasicMaterial({
  map: milkyWayTexture,
  side: THREE.BackSide // render on the inside of the sphere
});
const skybox = new THREE.Mesh(skyGeometry, skyMaterial);
scene.add(skybox);

// ── Galaxy-view skybox ────────────────────────────────────────────────────────
// Same 8k_stars_milky_way.jpg texture as the inner skybox, on a large BackSide
// sphere. Position is updated every frame to follow the camera so it can never
// be escaped regardless of zoom level.
const galaxySkybox = new THREE.Mesh(
  new THREE.SphereGeometry(800000, 32, 32),
  new THREE.MeshBasicMaterial({
    map: milkyWayTexture,
    side: THREE.BackSide,
    depthWrite: false
  })
);
galaxySkybox.visible = false;
scene.add(galaxySkybox);

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
let bhStarfield           = null; // procedural starfield for BH mode (no galactic band)
let bhDiskMaterials       = null; // materials of each stacked disk layer, for uTime animation
let galacticGlowSprite    = null; // bright white glow at the galactic core, visible at far zoom before BH detail kicks in
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

  // Set black hole thresholds based on actual galaxy scale
  BH_CLOSE_DIST = galaxyVisualRadius * 0.10;
  BH_FAR_DIST   = galaxyVisualRadius * 0.55;

  // Procedural black hole — flat RingGeometry layers + Fresnel event horizon.
  // Deferred: defined here but built lazily on the first galaxy-scale frame
  // (ensureBH), keeping its shader compilation + EffectComposer off the boot path.
  bhBuilder = function buildProceduralBH() {
    var bhR = galaxyVisualRadius * 0.04;

    // DISK — complete rewrite. One flat mesh, zero noise, zero directional streak functions.
    // Previous approach: 52 separate rings with vnoise() created angular bright patches
    // that appeared as directional streaks when viewed at any angle.
    // New approach: single RingGeometry, pure radial + smooth sinusoidal functions only.

    var diskVert = [
      'varying float vRadius;',
      'varying float vAngle;',
      'void main(){',
      '  vRadius = length(position.xy);',
      '  vAngle  = atan(position.y, position.x);',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n');

    var diskFrag = [
      'uniform float uInnerR, uOuterR, uTime, uAlphaMul, uLayerY, uZoomOut;',
      'varying float vRadius, vAngle;',
      // --- 2D value noise + 4-octave FBM for cloud-like turbulence ---
      'float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
      'float vnoise(vec2 p){',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  vec2 u = f*f*(3.0 - 2.0*f);',
      '  return mix(mix(hash21(i+vec2(0.0,0.0)), hash21(i+vec2(1.0,0.0)), u.x),',
      '             mix(hash21(i+vec2(0.0,1.0)), hash21(i+vec2(1.0,1.0)), u.x), u.y);',
      '}',
      'float fbm4(vec2 p){',
      '  float v = 0.0;',
      '  v += 0.533 * vnoise(p);',
      '  v += 0.267 * vnoise(p * 2.03);',
      '  v += 0.133 * vnoise(p * 4.07);',
      '  v += 0.067 * vnoise(p * 8.13);',
      '  return v;',
      '}',
      'void main(){',
      '  float t    = clamp((vRadius - uInnerR) / (uOuterR - uInnerR), 0.0, 1.0);',
      '  float logR = log(max(vRadius / max(uInnerR, 0.001), 1.001));',
      // Static disk-local coords — used by all LARGE-scale noise so it
      // can\'t form arc-shaped shadow stripes. NO uLayerY offset so the 5
      // stacked layers reinforce the same pattern from any view angle.
      '  vec2 pStatic = vec2(vRadius*cos(vAngle), vRadius*sin(vAngle)) / max(uInnerR * 0.55, 0.001);',
      // Rotating disk-local coords — used ONLY for high-frequency orbital
      // motion below. Features too fine to form visible arc stripes, but
      // sweep around the BH over time to give the disk a sense of flow.
      '  float rotAng = vAngle - uTime * 0.18;',
      '  vec2 pCloud  = vec2(vRadius*cos(rotAng), vRadius*sin(rotAng)) / max(uInnerR * 0.55, 0.001);',
      // Grain octaves on pStatic (no rotation). grainBig scale bumped
      // 1.0 -> 3.5 so the dark patches of the noise field are ~3x smaller
      // — small enough that they no longer span large angular arcs on
      // the disk and don\'t read as shadow blobs / strips. Weights
      // shifted 0.70/0.30 -> 0.50/0.50 so the large grain doesn\'t
      // dominate visually either.
      '  float grainBig  = vnoise(pStatic * 3.5);',
      '  float grainFine = vnoise(pStatic * 20.0);',
      '  float grainHi   = 0.50 * grainBig + 0.50 * grainFine;',
      // Static colour-modulation noise sources.
      '  float cloudS     = vnoise(pStatic * 1.4);',
      '  float grainColor = vnoise(pStatic * 8.0);',
      // Orbital-motion noise — rotates with the disk over time. High
      // frequency (scale 28) so features are tiny — they sweep around
      // the BH visually as uTime advances, giving the disk a sense of
      // flow without the features being large enough to form visible
      // arc-shaped shadow stripes.
      '  float orbitalGrain = vnoise(pCloud * 28.0);',
      // === Dual ring sets — ~80 rings with non-uniform clustering ===
      // Two ring sets at spacings 0.030 and 0.044 in logR (was 0.14 / 0.20).
      // Set 1 -> ~80 rings, set 2 -> ~55 rings. They drift in and out of
      // alignment for natural clustering.
      // Ring positions: NO uLayerY offset (layer reinforcement from above).
      // Smooth organic clustering only — rings stay as concentric arcs,
      // not zigzag wobble.
      '  float perturbLogR  = logR + 0.02 * sin(logR * 5.0 + 1.0);',
      '  float ringSpacing1 = 0.030;',
      '  float ringInput1   = perturbLogR / ringSpacing1;',
      '  float ringDist1    = min(fract(ringInput1), 1.0 - fract(ringInput1));',
      '  float ringSpacing2 = 0.044;',
      '  float ringInput2   = perturbLogR / ringSpacing2 + 0.3;',
      '  float ringDist2    = min(fract(ringInput2), 1.0 - fract(ringInput2));',
      // === Core + halo per ring (canvas "shadowBlur" emulation) ===
      // Halo widens AND brightens with zoom-out so the world-space halo
      // grows in screen size as the camera retreats — same blurry feel at
      // far zoom as at close zoom.
      '  float core1 = exp(-ringDist1 * ringDist1 * 80.0);',
      '  float core2 = exp(-ringDist2 * ringDist2 * 80.0);',
      '  float haloK = mix(12.0, 30.0, smoothstep(0.0, 0.5, t));',
      // Aggressive widening: at full zoom-out, haloK -> haloK/3 so the
      // halo is 3x wider in world-space than at close zoom.
      '  haloK *= 1.0 / (1.0 + uZoomOut * 2.0);',
      '  float halo1 = exp(-ringDist1 * ringDist1 * haloK);',
      '  float halo2 = exp(-ringDist2 * ringDist2 * haloK);',
      '  float coreMask = max(core1, core2);',
      '  float haloMask = max(halo1, halo2);',
      // Halo brightness also boosted with zoom-out: 0.40 -> up to 0.80
      // so the diffuse glow dominates over crisp ring cores at far zoom.
      '  float haloMul = mix(0.40, 0.80, uZoomOut);',
      '  float ringMaskHard = max(coreMask, haloMask * haloMul);',
      // Per-ring opacity — narrowed to [0.45, 0.90] so the dimmest rings
      // still pop visibly above the uniform bleed floor below.
      '  float ringIndex = floor(ringInput1 + 0.5);',
      '  float ringOpVar = 0.45 + 0.45 * hash21(vec2(ringIndex * 0.7, 3.0));',
      '  ringMaskHard *= ringOpVar;',
      // Removed: rotating-cloud arc-patchiness multiplier was creating
      // consistent dark shadow stripes that swept around the disk as the
      // cloud field rotated with the disk. All brightness variation now
      // comes from the static grain octaves below — no rotating shadows.
      // Grain strength ramps with radial position AND camera zoom-out.
      // Both ramps push toward 0.85 so a near-fully-swinging grain
      // multiplier acts at outer disk OR full zoom-out. At zoom-out from
      // any angle (including straight above) the grain becomes the
      // dominant brightness modulation, breaking the ring-circle
      // appearance into a grainy cloud.
      '  float grainStrength = mix(0.40, 0.80, smoothstep(0.0, 0.85, t));',
      '  grainStrength = mix(grainStrength, 0.85, uZoomOut * 0.7);',
      '  ringMaskHard *= (1.0 - grainStrength) + grainStrength * grainHi;',
      // Subtle orbital flow — tiny rotating noise patches modulate ring
      // brightness ±12% as they sweep around the BH. Visible as motion
      // without forming arc-shaped shadow stripes.
      '  ringMaskHard *= 0.88 + 0.24 * orbitalGrain;',
      // === Bleed floor fades with radial position AND zoom-out ===
      // Lowered base (0.08 -> 0.05) and further reduced by zoom-out so the
      // grain's full swing (0.40 multiplier at full strength) doesn't run
      // into the floor and average back into solid mass. At zoom-out the
      // gaps between rings get darker, letting the grain dominate visually.
      '  float bleedFloor = 0.05 * pow(max(1.0 - t, 0.0), 0.5) * (1.0 - 0.5 * uZoomOut);',
      '  ringMaskHard = max(ringMaskHard, bleedFloor);',
      // === Soft haze base — diffuse glow behind rings ===
      // Brightens with zoom-out (0.06 -> 0.18 max) for ambient cloud glow.
      // Capped so it doesn\'t overpower grain variation in gaps.
      '  float baseHaze = 0.06 * (1.0 - smoothstep(0.0, 0.95, t)) * (1.0 + 2.0 * uZoomOut);',
      '  ringMaskHard = max(ringMaskHard, baseHaze);',
      // === Outer fog transition ===
      // For t > 0.65 the rings dissolve smoothly into a diffuse fog layer.
      // fogMix=0 -> pure ring-gated alpha; fogMix=1 -> pure cloud-driven fog.
      '  float fogMix   = smoothstep(0.65, 0.92, t);',
      '  float fogAlpha = 0.25 + 0.40 * cloudS;',
      '  float effMask  = mix(ringMaskHard, fogAlpha, fogMix);',
      // === Colour gradient — hot inner to cool outer ===
      // Inner: white-yellow -> yellow-orange (hot plasma)
      // Mid:   orange -> burnt orange (cooler)
      // Outer: dusty rose / salmon (cooler still)
      // Far:   muted rose -> lavender -> pale purple-white (nebula haze)
      '  vec3 col;',
      // Reddish-orange inner, smoothly fading through dusty rose to lavender
      // out to the nebula-white edge. Each stop's start matches the previous
      // stop's end so the gradient blends continuously across t.
      '  if      (t < 0.15) { col = mix(vec3(1.00,0.22,0.06), vec3(1.00,0.17,0.04), smoothstep(0.00, 0.15, t)); }',
      '  else if (t < 0.32) { col = mix(vec3(1.00,0.17,0.04), vec3(1.00,0.13,0.02), smoothstep(0.15, 0.32, t)); }',
      '  else if (t < 0.50) { col = mix(vec3(1.00,0.13,0.02), vec3(0.92,0.10,0.02), smoothstep(0.32, 0.50, t)); }',
      '  else if (t < 0.68) { col = mix(vec3(0.92,0.10,0.02), vec3(0.85,0.22,0.13), smoothstep(0.50, 0.68, t)); }',
      '  else if (t < 0.85) { col = mix(vec3(0.85,0.22,0.13), vec3(0.72,0.40,0.32), smoothstep(0.68, 0.85, t)); }',
      '  else if (t < 0.95) { col = mix(vec3(0.72,0.40,0.32), vec3(0.73,0.62,0.78), smoothstep(0.85, 0.95, t)); }',
      '  else               { col = mix(vec3(0.73,0.62,0.78), vec3(0.93,0.93,1.00), smoothstep(0.95, 1.00, t)); }',
      // Strong over-brightness boost so the additive disk contribution
      // dominates the galaxy texture behind it. With colour > 1.0 each
      // disk pixel writes more luminance than the BeauGa galaxy can.
      '  col *= 2.5;',
      // Removed: cloudS-based colour brightness modulation. Even without
      // rotation its scale-1.4 features formed large patches that read as
      // arc-shaped shadow stripes on the annular disk geometry. Only the
      // small-scale grainColor (scale 8) survives, dropped to ±4 % so it
      // adds subtle texture without forming visible shadow patches.
      '  col *= (0.96 + 0.08 * grainColor);',
      // === Inner Planckian boost — applied to colour (not alpha) so the
      // per-ring opacity hash (0.30-0.90) doesn't saturate inside the cap
      // at the inner edge where pBoost would otherwise blow alpha to 1.
      '  float innerDist = max(0.0, vRadius - uInnerR);',
      '  float sigma     = uInnerR * 0.10;',
      '  float pr        = exp(-(innerDist*innerDist) / (2.0*sigma*sigma));',
      '  col *= 1.0 + 0.8 * pr;',
      // === Alpha — radial falloff × ring mask ===
      // Cap dropped 0.55 -> 0.38 to compensate for the higher ring count.
      // With ~80 rings cumulatively additive blending across 5 layers, a
      // lower per-layer cap is needed to keep the cumulative disk from
      // saturating into one opaque mass.
      '  float bright = pow(max(1.0-t, 0.0), 1.3) * 5.0;',
      '  float alpha  = clamp(effMask * bright, 0.0, 1.0);',
      '  alpha = min(alpha, 0.95);',
      '  alpha *= uAlphaMul;',
      '  gl_FragColor = vec4(col, alpha);',
      '}'
    ].join('\n');

    var bhSpin = new THREE.Group();
    bhSpin.position.copy(galacticCorePos);
    bhSpin.visible = false;

    // === Stacked thin disks form 3D thickness ===
    // 5 RingGeometry layers at slight world-Y offsets. Edge-on viewing (camera
    // at or near the galactic plane) no longer collapses the disk to a single
    // line — the stack shows a Gaussian-profile thickness from any angle.
    // Each layer has its own ShaderMaterial sharing diskGeo (cheap), with a
    // uAlphaMul that dims outer layers so the cross-section looks volumetric.
    var diskGeo = new THREE.RingGeometry(bhR * 0.92, bhR * 10.0, 512, 1);
    bhDiskMaterials = [];
    var diskLayerCount   = 5;
    var diskLayerSpacing = bhR * 0.030;  // vertical gap between adjacent layers
    for (var di = 0; di < diskLayerCount; di++) {
      var slot = di - (diskLayerCount - 1) * 0.5;   // -2, -1, 0, 1, 2
      var yOff = slot * diskLayerSpacing;
      var alphaMul = Math.exp(-Math.pow(slot / 1.6, 2.0)) * 0.55;
      var layerMat = new THREE.ShaderMaterial({
        uniforms: {
          uInnerR:   { value: bhR * 0.92 },
          uOuterR:   { value: bhR * 10.0 },
          uTime:     { value: 0.0 },
          uAlphaMul: { value: alphaMul },
          uLayerY:   { value: slot },
          uZoomOut:  { value: 0.0 }
        },
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
      _gSprite.scale.set(bhR * 7, bhR * 7, 1);
      _gSprite.renderOrder = 15;
      bhSpin.add(_gSprite);
    })();

    // Event horizon radius used for dynamic shadow calculation.
    // No sphere mesh: the lensing shader shadow mask IS the event horizon — eliminates
    // any frame-to-frame desync between a mesh position and the screen-space mask.
    // Bumped 1.00 → 1.20 (+20%) — central dark void grows, photon ring and halo
    // scale with bhEHRadius so they expand proportionally.
    bhEHRadius = bhR * 1.20;

    // Procedural BH starfield — uniform random points on a sphere, no galactic band.
    // Shown during BH mode instead of the 8K Milky Way texture (which has a bright
    // galactic band that appears as a diagonal streak when the camera faces the core).
    (function() {
      var _sfGeo = new THREE.BufferGeometry();
      var _sfPos  = new Float32Array(6000 * 3);
      var _sfCol  = new Float32Array(6000 * 3);
      for (var _i = 0; _i < 6000; _i++) {
        var _theta = Math.random() * Math.PI * 2;
        var _phi   = Math.acos(2.0 * Math.random() - 1.0);
        _sfPos[_i*3]   = 450 * Math.sin(_phi) * Math.cos(_theta);
        _sfPos[_i*3+1] = 450 * Math.sin(_phi) * Math.sin(_theta);
        _sfPos[_i*3+2] = 450 * Math.cos(_phi);
        var _b = 0.4 + 0.6 * Math.random();
        _sfCol[_i*3] = _b; _sfCol[_i*3+1] = _b; _sfCol[_i*3+2] = _b;
      }
      _sfGeo.setAttribute('position', new THREE.BufferAttribute(_sfPos, 3));
      _sfGeo.setAttribute('color',    new THREE.BufferAttribute(_sfCol, 3));
      bhStarfield = new THREE.Points(
        _sfGeo,
        new THREE.PointsMaterial({ size: 1.8, sizeAttenuation: false, vertexColors: true })
      );
      bhStarfield.visible = false;
      scene.add(bhStarfield);
    })();

    // finalComposer: full scene render + gravitational lensing only.
    // Bloom/UnrealBloomPass completely removed — it produced cross-spike artifacts
    // on compact annular sources (photon ring) regardless of strength setting.
    finalComposer = new THREE.EffectComposer(renderer);
    finalComposer.addPass(new THREE.RenderPass(scene, camera));

    // Gravitational lensing pass — uShadowR updated dynamically every frame
    var _lensUniforms = {
      tDiffuse:  { value: null },
      uCenter:   { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: 1.80 },
      uInnerR:   { value: 0.03 },
      uOuterR:   { value: 0.12 },
      uShadowR:  { value: 0.06 },
      uAspect:   { value: window.innerWidth / window.innerHeight }
    };
    bhLensingUniforms = _lensUniforms;
    finalComposer.addPass(new THREE.ShaderPass(new THREE.ShaderMaterial({
      uniforms: _lensUniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: [
        'uniform sampler2D tDiffuse;',
        'uniform vec2 uCenter;',
        'uniform float uStrength,uInnerR,uOuterR,uShadowR,uAspect;',
        'varying vec2 vUv;',
        'void main(){',
        '  vec2 d=(vUv-uCenter)*vec2(uAspect,1.0);',
        '  float dist=length(d);',
        // Shadow extended from 0.97 to 1.18 — black takes up more of the
        // visible BH. Photon ring and halo move outward to the new shadow
        // edge (peaked at uShadowR*1.18), and the halo sigma is narrowed
        // (0.28 -> 0.19) so the outer fade ends at roughly the same screen
        // radius as before — i.e. the overall "sphere" stays the same size,
        // just the dark void inside it grows.
        '  float shadowR = uShadowR * 1.18;',
        '  if(dist < shadowR){ gl_FragColor=vec4(0.0,0.0,0.0,1.0); return; }',
        // Gravitational warp — smooth Gaussian, no hard threshold (eliminates seam-line artifacts)
        '  vec2 uv=vUv;',
        '  float warpMag=uStrength*uShadowR*exp(-pow((dist/uShadowR-1.0)*1.1,2.0));',
        '  vec2 dir=d/max(dist,0.001); dir.x/=uAspect;',
        '  uv-=dir*warpMag; uv=clamp(uv,0.001,0.999);',
        '  vec4 col=texture2D(tDiffuse,uv);',
        // Photon ring + warm halo at the new shadow edge
        '  float prD=(dist-shadowR)/(uShadowR*0.04);',
        '  float prRing=exp(-prD*prD);',
        '  float haloD=(dist-shadowR)/(uShadowR*0.19);',
        '  float halo=exp(-haloD*haloD)*0.28;',
        '  col.rgb+=vec3(1.0,0.78,0.35)*(prRing+halo)*4.5;',
        '  gl_FragColor=col;',
        '}'
      ].join('\n')
    })));

    scene.add(bhSpin);
    blackHoleModel = bhSpin;
  };

  console.log('Milky Way GLB loaded successfully');
}).catch(function(error) {
  console.error('GLB load error:', error);
});

// Build the procedural black hole + lensing composer the first time we reach
// galaxy scale (deferred from boot to cut startup GPU/shader-compile cost).
// Idempotent; a no-op until the GLB callback has assigned bhBuilder.
function ensureBH() {
  if (bhBuilt || !bhBuilder) return;
  bhBuilt = true;
  console.log('ensureBH: building black hole + lensing composer (deferred from boot)');
  bhBuilder();
}

// SUN CORE (keep emissive low so shading is visible)
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(2, 64, 64),
  new THREE.MeshBasicMaterial({
    map: sunTexture
  })
);
scene.add(sun);

// 👇 ADD THIS BLOCK HERE
sun.userData = {
  name: "Sun",
  info: `
<b>Sun</b><br><br>

<b>General Overview</b><br>
• Type: G-type main-sequence star (G2V)<br>
• Age: ~4.6 billion years<br>
• Diameter: ~1.39 million km (≈109× Earth)<br>
• Mass: 1.989 × 10^30 kg (≈99.86% of total Solar System mass)<br>
• Surface Temperature: ~5,500°C<br>
• Core Temperature: ~15 million °C<br><br>

The Sun is the central star of the Solar System and the dominant source of energy for all planetary bodies. Its immense gravity holds the entire system together, governing the motion of planets, asteroids, and comets.<br><br>

<b>Structure and Layers</b><br>
The Sun is composed of several distinct layers:<br>
• Core: Region where nuclear fusion occurs<br>
• Radiative Zone: Energy moves outward via radiation<br>
• Convective Zone: Heat transferred by plasma movement<br>
• Photosphere: Visible “surface” of the Sun<br>
• Chromosphere: Thin atmospheric layer above the surface<br>
• Corona: Outer atmosphere extending millions of kilometers<br><br>

The corona is significantly hotter than the surface, a phenomenon that remains an active area of astrophysical research.<br><br>

<b>Energy Production (Nuclear Fusion)</b><br>
At its core, the Sun produces energy through nuclear fusion, where hydrogen nuclei combine to form helium. This process releases enormous amounts of energy according to Einstein’s equation E = mc².<br><br>

Every second, the Sun converts approximately 600 million tons of hydrogen into helium, releasing energy that travels outward and eventually radiates into space as sunlight.<br><br>

<b>Solar Activity</b><br>
The Sun is not static—it is highly dynamic and exhibits various forms of activity:<br>
• Sunspots: Cooler, darker regions caused by magnetic activity<br>
• Solar Flares: Sudden bursts of radiation<br>
• Coronal Mass Ejections (CMEs): Massive plasma eruptions<br><br>

These events can affect space weather and impact satellites, communication systems, and power grids on Earth.<br><br>

<b>Distance and Scale</b><br>
• Average distance from Earth: ~149.6 million km (1 AU)<br>
• Light travel time to Earth: ~8 minutes 20 seconds<br><br>

If the Sun were hollow, approximately 1.3 million Earths could fit inside it, illustrating its immense scale relative to planets.<br><br>

<b>Lifecycle and Future</b><br>
The Sun is currently in a stable phase of its lifecycle known as the main sequence. In about 5 billion years, it will exhaust its hydrogen fuel and expand into a red giant, potentially engulfing the inner planets.<br><br>

Eventually, it will shed its outer layers and become a white dwarf, leaving behind a dense stellar remnant.<br><br>

<b>Importance to Life</b><br>
The Sun provides the energy necessary for photosynthesis, climate systems, and the water cycle on Earth. Without it, life as we know it would not exist.<br><br>

Its stability over billions of years has been a key factor in allowing complex life to develop.<br>
`
};

// 👇 ADD THIS LINE HERE
sun.castShadow = true;


// SUN GLOW — light-orb sprite (matches the galactic-core glow style)
// Camera-facing canvas sprite with a soft radial gradient, so the Sun reads
// as a luminous orb at every viewing angle/zoom instead of a flat shaded sphere.
const glowMesh = (function() {
  const _gc = document.createElement('canvas');
  _gc.width = _gc.height = 256;
  const _gx = _gc.getContext('2d');
  const _gd = _gx.createRadialGradient(128, 128, 0, 128, 128, 128);
  _gd.addColorStop(0.00, 'rgba(255, 240, 170, 1.00)');
  _gd.addColorStop(0.20, 'rgba(255, 215, 110, 0.95)');
  _gd.addColorStop(0.45, 'rgba(255, 175,  60, 0.75)');
  _gd.addColorStop(0.75, 'rgba(235, 120,  20, 0.40)');
  _gd.addColorStop(1.00, 'rgba(180,  70,   0, 0.00)');
  _gx.fillStyle = _gd;
  _gx.fillRect(0, 0, 256, 256);
  const _sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(_gc),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  }));
  // Sun core diameter is 4 (radius 2); glow sits as a thin halo at 1.5× → 6.
  _sprite.scale.set(6, 6, 1);
  _sprite.renderOrder = 4;
  scene.add(_sprite);
  return _sprite;
})();

// 🪐 PLANET DATA (FULL + RICH INFO)


const meshes = [];

data.forEach(p=>{
  
  let material;

  if (p.name === "Jupiter") {
    material = new THREE.MeshStandardMaterial({
      map: jupiterTexture
    });
  } else if (p.name === "Saturn") {
    material = new THREE.MeshStandardMaterial({
      map: saturnTexture
    });
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
        void main() {
          vUv = uv;
          vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D dayTexture;
        uniform sampler2D nightTexture;
        uniform vec3 sunDirection;
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
          float intensity = dot(vNormal, sunDirection);
          float blend = smoothstep(-0.1, 0.1, intensity);
          vec4 day = texture2D(dayTexture, vUv);
          vec4 night = texture2D(nightTexture, vUv);
          gl_FragColor = mix(night, day, blend);
        }
      `
    });
  } else {
    material = new THREE.MeshStandardMaterial({
      color: p.color
    });
  }

  const m = new THREE.Mesh(
    new THREE.SphereGeometry(p.size,32,32),
    material
  );

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

// Cloud layer
const cloudTexture = textureLoader.load("2k_earth_clouds.jpg");
const cloudMesh = new THREE.Mesh(
  new THREE.SphereGeometry(0.57, 32, 32),
  new THREE.MeshBasicMaterial({
    map: cloudTexture,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
);
earth.add(cloudMesh);

// Moon orbit group
const moonGroup = new THREE.Object3D();
moonGroup.rotation.x = 5.1 * (Math.PI / 180);
scene.add(moonGroup);

// Moon mesh
const moon = new THREE.Mesh(
  new THREE.SphereGeometry(0.15, 32, 32),
  new THREE.MeshStandardMaterial({ map: moonTexture })
);
moon.position.set(1.5, 0, 0);
moonGroup.add(moon);

// 🪐 ORBIT LINES
const orbitLines = [];
meshes.forEach(m => {
  const points = [];
  for (let i = 0; i <= 128; i++) {
    const angle = (i / 128) * Math.PI * 2;
    points.push(new THREE.Vector3(
      Math.cos(angle) * m.userData.dist,
      0,
      Math.sin(angle) * m.userData.dist
    ));
  }
  const orbit = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15 })
  );
  scene.add(orbit);
  orbitLines.push(orbit);
});

// 🌕 Moon orbit line
const moonOrbitPoints = [];
for (let i = 0; i <= 128; i++) {
  const angle = (i / 128) * Math.PI * 2;
  moonOrbitPoints.push(new THREE.Vector3(Math.cos(angle) * 1.5, 0, Math.sin(angle) * 1.5));
}
const moonOrbitLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(moonOrbitPoints),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15 })
);
moonGroup.add(moonOrbitLine);
orbitLines.push(moonOrbitLine);

// 🪐 Jupiter moon orbit lines
const jupiterMoonOrbitLines = [];
[2.1, 3.3, 5.25, 9.24].forEach(dist => {
  const pts = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * dist, 0, Math.sin(a) * dist));
  }
  const orbitLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15 })
  );
  scene.add(orbitLine);
  orbitLines.push(orbitLine);
  jupiterMoonOrbitLines.push(orbitLine);
});

let orbitsVisible = true;
document.getElementById("toggleOrbits").addEventListener("click", () => {
  // In the Kepler-22 system view this button toggles that system's orbit ring
  if (keplerSystemViewActive) {
    keplerOrbitsVisible = !keplerOrbitsVisible;
    if (keplerOrbit) keplerOrbit.visible = keplerOrbitsVisible;
    document.getElementById("toggleOrbits").textContent = keplerOrbitsVisible ? "Hide Orbits" : "Show Orbits";
    return;
  }
  orbitsVisible = !orbitsVisible;
  if (!spaceshipViewActive && !galacticViewActive) {
    orbitLines.forEach(o => o.visible = orbitsVisible);
  }
  document.getElementById("toggleOrbits").textContent = orbitsVisible ? "Hide Orbits" : "Show Orbits";
});



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
  moonMesh.userData = { info: infoText };
  group.userData = { info: infoText };
  group.add(moonMesh);

  return { group, speed, mesh: moonMesh, distance };
}

const io = createMoon(
  0.18,
  2.1,   // 5.9 Jupiter radii × 0.35 scale
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
  0.16,
  3.3,   // 9.4 Jupiter radii × 0.35 scale
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
  0.22,
  5.25,  // 15.0 Jupiter radii × 0.35 scale
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
  0.2,
  9.24,  // 26.4 Jupiter radii × 0.35 scale
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


moon.userData = {
  name: "Moon",
  info: `
<b>Moon</b><br><br>

<b>General Overview</b><br>
• Type: Natural satellite of Earth<br>
• Average distance from Earth: ~384,400 km<br>
• Diameter: 3,474 km (≈27% of Earth’s size)<br>
• Gravity: ~16.6% of Earth’s gravity<br>
• Orbital period: ~27.3 days<br><br>

The Moon is Earth’s only permanent natural satellite and is the fifth largest moon in the Solar System relative to its parent planet. It plays a critical role in stabilizing Earth’s axial tilt and influencing ocean tides.<br><br>

<b>Orbital Behavior</b><br>
The Moon is tidally locked to Earth, meaning it rotates once on its axis in the same time it takes to complete one orbit. As a result, the same side of the Moon always faces Earth.<br><br>

Its orbit is slightly elliptical, causing variations in distance (perigee and apogee), which influence the apparent size of the Moon seen from Earth.<br><br>

<b>Surface and Geology</b><br>
The Moon’s surface is covered by:<br>
• Regolith: Fine layer of dust and rock fragments<br>
• Impact craters: Formed by billions of years of asteroid impacts<br>
• Maria: Large basaltic plains formed by ancient volcanic activity<br><br>

Because it lacks an atmosphere, the Moon has no erosion processes, preserving geological features for billions of years.<br><br>

<b>Atmosphere</b><br>
The Moon has an extremely thin exosphere composed of trace elements such as helium, neon, and hydrogen. It is not dense enough to support weather, wind, or breathable conditions.<br><br>

<b>Formation Theory</b><br>
The most widely accepted theory is the Giant Impact Hypothesis, which suggests the Moon formed from debris after a Mars-sized object collided with early Earth approximately 4.5 billion years ago.<br><br>

<b>Role in Earth System</b><br>
The Moon significantly influences Earth in several ways:<br>
• Stabilizes Earth’s axial tilt, contributing to long-term climate stability<br>
• Generates ocean tides through gravitational interaction<br>
• Gradually slows Earth’s rotation over geological time<br><br>

<b>Exploration</b><br>
The Moon is the only extraterrestrial body visited by humans.<br>
• Apollo program: First human landings (1969–1972)<br>
• Robotic missions: LRO, Chang’e program, Chandrayaan missions<br><br>

Future exploration focuses on establishing lunar bases and using the Moon as a platform for deep space missions.<br>
`
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
  saturnRadius:  { value: 1.0 }
};

const ringGeometry = new THREE.RingGeometry(1.5, 2.5, 64);
const ringMaterial = new THREE.ShaderMaterial({
  uniforms: ringUniforms,
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vWorldPos;
    void main() {
      vUv = uv;
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D map;
    uniform vec3 saturnPos;
    uniform float saturnRadius;
    varying vec2 vUv;
    varying vec3 vWorldPos;
    void main() {
      vec4 texColor = texture2D(map, vUv);
      if (texColor.a < 0.01) discard;

      // Direction from Saturn toward the Sun (Sun is at origin)
      vec3 toSun = normalize(-saturnPos);
      vec3 ringPoint = vWorldPos - saturnPos;

      // Project ring point onto the sun direction
      float proj = dot(ringPoint, toSun);

      float shadowFactor = 1.0;
      if (proj < 0.0) {
        // Fragment is on the side facing away from the Sun
        float perpDist = length(ringPoint - proj * toSun);
        float edge = saturnRadius * 0.08;
        float shadow = 1.0 - smoothstep(saturnRadius - edge, saturnRadius + edge, perpDist);
        shadowFactor = 1.0 - shadow * 0.55;
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

// 👇 ADD IT HERE (outside the loop)
meshes.forEach(m => {
  m.castShadow = true;
  m.receiveShadow = true;
});

// Explicit list of every heliocentric object that should be hidden in alternate views.
// Using an explicit array (not scene.children sweep) so lights are never accidentally touched
// and nothing is missed when new objects are added.
const helioObjects = [
  sun,
  glowMesh,
  moonGroup,
  saturnTiltGroup,
  ...meshes,
  ...orbitLines,
  ...jupiterMoons.map(jm => jm.group),
];

// Click interaction
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

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
  // terraformed_mars_emissive.png is the safe-sized 4096×2048 version of city_lights.png
  // (city_lights.png extracted from GLB is 8192×4096 and exceeds GPU texture limits)
  const nightTex = textureLoader.load("terraformed_mars_emissive.png", applyTexQuality);
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
      void main() {
        vUv = uv;
        vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D dayTexture;
      uniform sampler2D nightTexture;
      uniform vec3 sunDirection;
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        float intensity = dot(vNormal, sunDirection);
        float blend = smoothstep(-0.15, 0.15, intensity);
        vec4 day   = texture2D(dayTexture,   vUv);
        vec4 night = texture2D(nightTexture, vUv);
        // Dim ambient keeps night side from being pitch-black; city lights add on top
        vec3 darkSide = day.rgb * 0.06 + night.rgb;
        gl_FragColor = vec4(mix(darkSide, day.rgb, blend), 1.0);
      }
    `
  });

  terraformedMarsModel = new THREE.Group();
  terraformedMarsModel.add(new THREE.Mesh(
    new THREE.SphereGeometry(marsRadius, 64, 64),
    terraformedMarsMaterial
  ));

  // Cloud layer — RGBA alpha channel drives per-pixel cloud opacity
  const cloudMat = new THREE.MeshStandardMaterial({
    map: cloudTex,
    transparent: true,
    depthWrite: false
  });
  marsCloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(marsRadius, 64, 64),
    cloudMat
  );
  marsCloudMesh.scale.setScalar(1.02);
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

function flyToObject(obj) {
  if (!obj) return;

  // Walk up to find an object with info
  let infoObj = obj;
  while (infoObj && !infoObj.userData.info) {
    infoObj = infoObj.parent;
  }
  if (!infoObj || !infoObj.userData.info) return;

  document.getElementById("panel").style.display = "block";
  if (infoObj.userData.name === "Mars") {
    refreshMarsPanel();
  } else {
    document.getElementById("panelContent").innerHTML = infoObj.userData.info;
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
      flyToObject(obj);
    });
    return;
  }

  // Only lock after we have a valid position
  lockedObject = obj;

  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();

  const size = obj.userData.size || 0.2;
  const offset = new THREE.Vector3(0, size * 2, size * 8);
  const endPos = targetPos.clone().add(offset);

  let t = 0;
  function flyTo() {
    if (myGeneration !== flyGeneration) { isFlyingTo = false; return; } // cancelled
    t += 0.03;
    if (t > 1) t = 1;
    const ease = t * t * (3 - 2 * t);

    const currentTarget = new THREE.Vector3();
    obj.getWorldPosition(currentTarget);

    camera.position.lerpVectors(startPos, endPos, ease);
    controls.target.lerpVectors(startTarget, currentTarget, ease);
    controls.update();

    if (t < 1) {
      requestAnimationFrame(flyTo);
    } else {
      isFlyingTo = false;
    }
  }
  flyTo();
}

window.addEventListener("click", e => {
  // Ignore clicks on UI elements — only handle canvas clicks
  if (e.target !== renderer.domElement) return;
  // Spaceship Earth has no clickable bodies; galactic view handles its own
  // clickable marker below, so only bail out here for spaceship view.
  // The Kepler system scene has its own dedicated click handler.
  if (spaceshipViewActive || keplerSystemViewActive || viewManager.active) return;

  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Galactic view: only the Kepler-22 marker is clickable → enter its system
  if (galacticViewActive) {
    const kHits = raycaster.intersectObject(galKeplerMarker, true);
    if (kHits.length > 0) enterKeplerSystem();
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

// Simulation time — starts at the real current date/time
let simulationDate = new Date();

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
};
const J2000_MS = new Date('2000-01-01T12:00:00Z').getTime();

function resetSimulation() {
  const now = new Date();
  simulationDate = now;

  const daysSinceJ2000 = (now.getTime() - J2000_MS) / 86400000;

  // Set each planet's orbital angle from real ephemeris data
  meshes.forEach(m => {
    const ep = PLANET_EPHEMERIS[m.userData.name];
    if (!ep) return;
    const L = ((ep.L0 + ep.n * daysSinceJ2000) % 360 + 360) % 360;
    m.userData.angle = L * (Math.PI / 180);
    // Update position immediately so the ring group moves too
    m.position.x = Math.cos(m.userData.angle) * m.userData.dist;
    m.position.z = Math.sin(m.userData.angle) * m.userData.dist;
  });

  // Sync Saturn's ring group to the new position
  const saturnMesh = meshes.find(m => m.userData.name === 'Saturn');
  if (saturnMesh) {
    saturnTiltGroup.position.copy(saturnMesh.position);
    ringUniforms.saturnPos.value.copy(saturnMesh.position);
  }

  // Orient Earth so Japan (135°E) faces the sun at the correct UTC time.
  // At UTC noon, Greenwich (0°) faces the sun.  Sub-solar longitude:
  //   SSP = (12 − utcHours) × 15°
  // Earth's texture: Greenwich faces +X at rotation.y = 0.
  // For longitude L to face sun (at world angle = orbitalAngle + π):
  //   rotation.y = orbitalAngle + π + SSP_rad
  const earthMesh = meshes.find(m => m.userData.name === 'Earth');
  if (earthMesh) {
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const sspRad = (12 - utcH) * (Math.PI / 12);
    earthMesh.rotation.y = earthMesh.userData.angle + Math.PI + sspRad;
    cloudMesh.rotation.y = earthMesh.rotation.y;
  }

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
  if (keplerSystemViewActive) exitKeplerSystem();
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
  if (bhStarfield) bhStarfield.visible = false;

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
  if (keplerSystemViewActive) exitKeplerSystem();
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
    if (bhStarfield) bhStarfield.visible = false;
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

  let t = 0;
  (function flyIn() {
    if (myGeneration !== flyGeneration) { isFlyingTo = false; return; }
    t += 0.012; // ~83-frame descent for a cinematic feel
    if (t > 1) t = 1;
    const ease = t * t * (3 - 2 * t);

    camera.position.lerpVectors(startPos, endPos, ease);
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

function flyToMilkyWay() {
  if (!galacticCorePos) return; // GLB not yet loaded

  viewManager.exitActive();
  if (keplerSystemViewActive) exitKeplerSystem();
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

  let t = 0;
  (function flyOut() {
    if (myGeneration !== flyGeneration) { isFlyingTo = false; return; }
    t += 0.01; // ~100-frame arc for a sweeping feel
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
  if (keplerSystemViewActive) exitKeplerSystem();
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
let keplerSystemViewActive = false;
let keplerScene        = null;
let keplerCamera       = null;
let keplerControls     = null;
let keplerBPivot       = null;   // orbit pivot for Kepler-22b
let keplerB            = null;   // the planet mesh
let keplerStar         = null;   // the host-star mesh
let keplerOrbit        = null;   // Kepler-22b's orbit ring (toggled by Hide Orbits)
let keplerLockedObject = null;   // body the camera is locked onto (after a fly-to)
let keplerFlying       = false;  // true during a fly-to animation
let keplerListVisible  = false;  // whether the Kepler bodies list is showing
let keplerOrbitsVisible = true;  // whether Kepler-22b's orbit ring is showing
// Tracks the skybox-boundary side last frame so the Solar System panel can flip
// to the Milky Way panel on zoom-out and back to the bodies list on zoom-in.
let prevOutsideSkybox  = false;
const KEPLER_B_ORBIT_R = 8;      // scene units
const KEPLER_B_SPEED   = 0.00009; // angular speed (period 289.9 d, ~Earth-like), scaled by global `speed`
// Entry "fly-in": when the system view opens it starts zoomed way out (the star
// is a small point, matching the galaxy dot we just dove into) and keeps zooming
// in, so the system grows in continuously instead of cutting to a static page.
let keplerIntroActive  = false;
let keplerIntroT       = 0;
const KEPLER_INTRO_FROM = new THREE.Vector3(0, 5, 90); // far: star is a tiny point
const KEPLER_INTRO_TO   = new THREE.Vector3(0, 6, 18); // settled system view

function initKeplerScene() {
  if (keplerScene) return;
  keplerScene = new THREE.Scene();

  // Skybox — same texture and radius as the main scene
  keplerScene.add(new THREE.Mesh(
    new THREE.SphereGeometry(SKYBOX_RADIUS, 64, 64),
    new THREE.MeshBasicMaterial({ map: milkyWayTexture, side: THREE.BackSide })
  ));

  // Lighting — point light sits at the host star
  keplerScene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const kLight = new THREE.PointLight(0xfff5e0, 2.5, 0, 1.2);
  kLight.position.set(0, 0, 0);
  keplerScene.add(kLight);

  // Host star Kepler-22 — G-type, slightly cooler than the Sun (5,518 K)
  keplerStar = new THREE.Mesh(
    new THREE.SphereGeometry(2, 64, 64),
    new THREE.MeshBasicMaterial({ map: sunTexture, color: 0xfff0d8 })
  );
  keplerStar.userData = {
    name: "Kepler-22",
    size: 2,
    info: `<b>Kepler-22</b><br><br>The Sun-like G-type host star of this system, about 644 light-years away in the constellation Cygnus. It is roughly 3% less massive than the Sun with a surface temperature of 5,518 K. Its one confirmed planet, Kepler-22b, orbits within the habitable zone — click it to learn more.`
  };
  keplerScene.add(keplerStar);
  // Soft star glow (camera-facing sprite, matches the Sun's glow style)
  (function() {
    const _gc = document.createElement('canvas');
    _gc.width = _gc.height = 256;
    const _gx = _gc.getContext('2d');
    const _gd = _gx.createRadialGradient(128, 128, 0, 128, 128, 128);
    _gd.addColorStop(0.00, 'rgba(255, 244, 200, 1.00)');
    _gd.addColorStop(0.20, 'rgba(255, 222, 140, 0.95)');
    _gd.addColorStop(0.45, 'rgba(255, 185,  80, 0.70)');
    _gd.addColorStop(0.75, 'rgba(235, 130,  30, 0.35)');
    _gd.addColorStop(1.00, 'rgba(180,  80,   0, 0.00)');
    _gx.fillStyle = _gd;
    _gx.fillRect(0, 0, 256, 256);
    const _sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(_gc),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    _sprite.scale.set(6, 6, 1);
    keplerScene.add(_sprite);
  })();

  // Kepler-22b on an orbit pivot — 2.1 × Earth's radius (Earth size = 0.55)
  const kTex = textureLoader.load("Kepler 22b_0.jpeg");
  keplerBPivot = new THREE.Group();
  keplerScene.add(keplerBPivot);
  keplerB = new THREE.Mesh(
    new THREE.SphereGeometry(0.55 * 2.1, 64, 64),
    new THREE.MeshStandardMaterial({ map: kTex })
  );
  keplerB.position.set(KEPLER_B_ORBIT_R, 0, 0);
  keplerB.userData = { name: "Kepler-22b", size: 0.55 * 2.1, info: KEPLER_22B_INFO };
  keplerBPivot.add(keplerB);
  // Faint orbit ring for context (toggled by the Hide/Show Orbits button)
  keplerOrbit = new THREE.Mesh(
    new THREE.RingGeometry(KEPLER_B_ORBIT_R - 0.03, KEPLER_B_ORBIT_R + 0.03, 128),
    new THREE.MeshBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
  );
  keplerOrbit.rotation.x = -Math.PI / 2;
  keplerOrbit.visible = keplerOrbitsVisible;
  keplerScene.add(keplerOrbit);

  keplerCamera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, SKYBOX_RADIUS * 2);
  keplerCamera.position.set(0, 6, 18);

  keplerControls = new THREE.OrbitControls(keplerCamera, renderer.domElement);
  keplerControls.enableDamping = true;
  keplerControls.dampingFactor = 0.08;
  keplerControls.minDistance   = 1.8;
  keplerControls.maxDistance   = 200;
  keplerControls.target.set(0, 0, 0);
  keplerControls.update();
}

// Fly the Kepler-scene camera to a clicked body and lock onto it (mirrors flyToObject)
function flyToKeplerObject(obj) {
  if (!obj || !obj.userData) return;
  document.getElementById('panel').style.display = 'block';
  document.getElementById('panelContent').innerHTML = obj.userData.info || '';
  document.getElementById('backToList').style.display = 'inline-block';

  keplerLockedObject = obj;
  keplerFlying = true;

  const startPos    = keplerCamera.position.clone();
  const startTarget = keplerControls.target.clone();
  const endTarget   = obj.getWorldPosition(new THREE.Vector3());
  const size        = obj.userData.size || 0.5;
  const endPos      = endTarget.clone().add(new THREE.Vector3(0, size * 2, size * 8));

  let t = 0;
  (function flyTo() {
    if (!keplerSystemViewActive) { keplerFlying = false; return; }
    t += 0.03;
    if (t > 1) t = 1;
    const ease = t * t * (3 - 2 * t);
    keplerCamera.position.lerpVectors(startPos, endPos, ease);
    keplerControls.target.lerpVectors(startTarget, endTarget, ease);
    keplerControls.update();
    if (t < 1) requestAnimationFrame(flyTo);
    else keplerFlying = false;
  })();
}

// Bodies list for the Kepler-22 system — same panel template as the Solar System
// list, but with only the star and its one confirmed planet for now.
function showKeplerList() {
  if (!keplerSystemViewActive) return;
  document.getElementById("panel").style.display = "block";
  document.getElementById("backToList").style.display = "none";

  const items = [
    { label: "• Kepler-22",  obj: keplerStar },
    { label: "• Kepler-22b", obj: keplerB },
  ];

  let html = "<b>The Kepler-22 System</b><br><br>";
  items.forEach(item => {
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

  document.querySelectorAll(".bodyItem").forEach((el, i) => {
    el.addEventListener("click", () => { flyToKeplerObject(items[i].obj); });
  });
}

// Click handling scoped to the Kepler system scene
window.addEventListener("click", e => {
  if (!keplerSystemViewActive) return;
  if (e.target !== renderer.domElement) return;
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, keplerCamera);
  const hits = raycaster.intersectObjects(keplerScene.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o && !(o.userData && o.userData.name) && o.parent) o = o.parent;
    if (o && o.userData && o.userData.name) { flyToKeplerObject(o); return; }
  }
});

function enterKeplerSystem() {
  initKeplerScene();
  keplerSystemViewActive = true;
  controls.enabled = false; // prevent main OrbitControls from consuming mouse input

  document.getElementById('speedPanel').style.display = 'block'; // slider drives the orbit
  // Hide the "The Kepler-22 System" button — we're already in the system
  document.getElementById('otherGalaxiesBtn').style.display = 'none';

  // Show the system's bodies list (same as the Solar System opens with its list)
  keplerListVisible = true;
  showKeplerList();
  document.getElementById('toggleList').textContent = 'Hide Bodies';
  // Sync the orbit toggle to this scene's orbit ring
  if (keplerOrbit) keplerOrbit.visible = keplerOrbitsVisible;
  document.getElementById('toggleOrbits').textContent = keplerOrbitsVisible ? 'Hide Orbits' : 'Show Orbits';

  // Begin the fly-in: start far out (star is a small point, continuing the dive
  // from the galaxy dot) and zoom in to the system. The render loop animates this.
  keplerLockedObject = null;
  keplerFlying = false;
  keplerIntroActive = true;
  keplerIntroT = 0;
  keplerCamera.position.copy(KEPLER_INTRO_FROM);
  keplerControls.target.set(0, 0, 0);
  keplerCamera.lookAt(0, 0, 0);
}

// Tear down the Kepler-22 system scene and hand control back to the main view.
// Called from the main-menu button (there is no in-scene back button).
function exitKeplerSystem() {
  keplerSystemViewActive = false;
  keplerLockedObject = null;
  controls.enabled = true;
  // Restore the "The Kepler-22 System" button now that we've left the system
  document.getElementById('otherGalaxiesBtn').style.display = 'block';
  // Restore the orbit/list button labels to reflect the Solar System's state
  document.getElementById('toggleOrbits').textContent = orbitsVisible ? 'Hide Orbits' : 'Show Orbits';
  document.getElementById('toggleList').textContent = listVisible ? 'Hide Bodies' : 'Show Bodies';
}

// Zooming all the way out of the Kepler system drops back into the Milky Way
// galaxy view, but — like zooming out of the Solar System — the Kepler dot stays
// the centre focus point (we DON'T jump to the galactic core). We hand the main
// camera the dot as its orbit target at a galaxy-scale framing (the reverse of
// the zoom-in entry), so the user simply keeps zooming out with the dot centred.
function escapeKeplerToGalaxy() {
  if (!galacticCorePos) return;
  const dotPos = keplerSystemMarker.getWorldPosition(new THREE.Vector3());
  const R = galaxyVisualRadius;

  exitKeplerSystem();                 // restores the button + leaves the system
  renderer.setClearColor(0x000005, 1);
  showMilkyWayPanel();
  if (galacticViewActive) exitGalacticView();

  // Frame the Kepler dot, centred, just outside the skybox so the galaxy + dot
  // render — matching where the zoom-in entry began, so the hand-off is seamless.
  lockedObject = null;
  camera.up.set(0, 1, 0);
  camera.position.set(dotPos.x, dotPos.y + R * 0.14, dotPos.z + R * 0.10);
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
  if (keplerSystemViewActive) exitKeplerSystem();
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

  // End framing: dot centred and as close as we can get while still outside the
  // skybox (so it stays visible right up to the hand-off into the system scene).
  const endPos    = new THREE.Vector3(dotPos.x, dotPos.y + R * 0.14, dotPos.z + R * 0.10);
  const endTarget = dotPos.clone();

  lockedObject = null;
  const myGeneration = ++flyGeneration;
  isFlyingTo = true;
  const startPos    = camera.position.clone();
  const startTarget = controls.target.clone();

  let t = 0;
  (function zoomIn() {
    if (myGeneration !== flyGeneration) { isFlyingTo = false; return; }
    t += 0.015;
    if (t > 1) t = 1;
    const ease = t * t; // ease-IN: accelerate, fastest at the hand-off (no stop)
    camera.position.lerpVectors(startPos, endPos, ease);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    camera.up.set(0, 1, 0);
    controls.update();
    if (t < 1) {
      requestAnimationFrame(zoomIn);
    } else {
      isFlyingTo = false;
      // Hand straight off to the system scene, which keeps zooming in from here.
      enterKeplerSystem();
    }
  })();
}

document.getElementById('otherGalaxiesBtn').onclick = () => { flyToKeplerDot(); };

// The Andromeda Galaxy view now lives in rooms/andromeda.js (lazy-loaded room).
document.getElementById('andromedaBtn').onclick = () => {
  if (keplerSystemViewActive) exitKeplerSystem();
  if (galacticViewActive) exitGalacticView();
  if (spaceshipViewActive) exitSpaceshipView();
  viewManager.enter('andromeda');
};

function animate(){
  requestAnimationFrame(animate);

  // Strangler hook: while a migrated room (rooms/*.js) is active, let it drive
  // this frame and skip all legacy view code. Dormant until a room is registered.
  const _room = viewManager.active;
  if (_room) { _room.update(ctx); return; }

  // Kepler-22 system takes over the renderer entirely — skip all solar-system logic
  if (keplerSystemViewActive) {
    const kNow = performance.now();
    const kDelta = Math.min(kNow - lastFrameMs, 100);
    lastFrameMs = kNow;
    const kScale = kDelta / (1000 / 60);

    // Advance Kepler-22b's orbit and self-spin using the global speed slider
    keplerBPivot.rotation.y += KEPLER_B_SPEED * speed * kScale;
    keplerB.rotation.y      += 0.01 * speed * kScale;

    if (keplerIntroActive) {
      // Continuous zoom-in on entry — ease-OUT so it's moving fastest right after
      // the swap (continuing the galaxy dive) and settles smoothly. Drive the
      // camera directly (no OrbitControls) so the lerp isn't overridden.
      keplerIntroT += 0.02 * kScale;
      if (keplerIntroT >= 1) keplerIntroT = 1;
      const e = keplerIntroT * (2 - keplerIntroT); // ease-out
      keplerCamera.position.lerpVectors(KEPLER_INTRO_FROM, KEPLER_INTRO_TO, e);
      keplerControls.target.set(0, 0, 0);
      keplerCamera.lookAt(0, 0, 0);
      if (keplerIntroT >= 1) { keplerIntroActive = false; keplerControls.update(); }
    } else {
      // Keep the camera locked onto the selected body as it orbits (after fly-in)
      if (keplerLockedObject && !keplerFlying) {
        const tp = keplerLockedObject.getWorldPosition(new THREE.Vector3());
        const delta = tp.clone().sub(keplerControls.target);
        keplerControls.target.copy(tp);
        keplerCamera.position.add(delta);
      }
      keplerControls.update();

      // Zoomed all the way out → drop back into the galaxy with the Kepler dot
      // kept as the centre focus (same feel as zooming out of the Solar System),
      // rather than jumping to the galactic-core overview.
      if (!keplerFlying &&
          keplerCamera.position.distanceTo(keplerControls.target) >= keplerControls.maxDistance - 2) {
        escapeKeplerToGalaxy();
        return;
      }
    }

    renderer.render(keplerScene, keplerCamera);
    return;
  }

  // Real elapsed ms since last frame, capped to avoid huge jumps after tab switches
  const nowMs = performance.now();
  const deltaMs = Math.min(nowMs - lastFrameMs, 100);
  lastFrameMs = nowMs;

  // deltaScale normalises all per-frame speed coefficients (calibrated at 60fps)
  // so they behave identically at any refresh rate
  const FRAME_MS = 1000 / 60;
  const deltaScale = deltaMs / FRAME_MS;

  // Show galaxy + Solar System marker only when camera has exited the skybox sphere;
  // hide the skybox itself at galaxy scale so it doesn't appear as a bubble over the galaxy.
  const camDist = camera.position.length();
  const outsideSkybox = camDist > SKYBOX_RADIUS;
  // Lazily build the procedural BH + lensing composer the first time we reach
  // galaxy scale (deferred from boot). Runs before any BH render below.
  if (!bhBuilt && (outsideSkybox || galacticViewActive)) ensureBH();
  // Only drive visibility from here when BH is NOT active — save/restore handles it during BH view
  if (!bhRendererSettings) {
    skybox.visible       = !outsideSkybox;
    galaxySkybox.visible =  outsideSkybox;
    const showGalaxy = outsideSkybox || galacticViewActive;
    if (milkyWayModel) milkyWayModel.visible = showGalaxy;
    if (beauGaDisc)    beauGaDisc.visible    = showGalaxy;
  }
  galaxySkybox.position.copy(camera.position);
  if (bhStarfield) bhStarfield.position.copy(camera.position);
  solarSystemMarker.visible = !bhRendererSettings && outsideSkybox && !galacticViewActive;
  keplerSystemMarker.visible = solarSystemMarker.visible;

  // Enter the Kepler-22 system by zooming in toward its dot — the symmetric
  // counterpart to the zoom-out escape. While focused on the Kepler dot in the
  // galaxy view, crossing the skybox boundary (the same boundary that reveals the
  // Solar System near the origin) hands off into the system scene, so the system
  // "appears" as you keep zooming in. Gated on the dot being the focus so zooming
  // in elsewhere (e.g. toward the Solar System) is unaffected.
  if (!keplerSystemViewActive && !galacticViewActive && !spaceshipViewActive &&
      !isFlyingTo && !bhRendererSettings && galaxyVisualRadius > 0) {
    const _kDot = keplerSystemMarker.getWorldPosition(new THREE.Vector3());
    if (controls.target.distanceTo(_kDot) < galaxyVisualRadius * 0.05 && camDist < SKYBOX_RADIUS) {
      enterKeplerSystem();
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
    var _gOp = Math.max(0.0, Math.min(1.0, (0.90 - bhTransitionT) / 0.40));
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
    sunLight.intensity = 1.5 + _pulse * 0.15;
  }
  const _ssBtn = document.getElementById('solarSystemBtn');
  if (_ssBtn) _ssBtn.style.display = outsideSkybox ? 'block' : 'none';

  // ── Black hole galactic-core transition ──────────────────────────────────
  // Active only once fully arrived at the Milky Way page view — not during fly animations
  // and not inside any other mode. isFlyingTo gates out the transition that would otherwise
  // fire prematurely as the camera crosses SKYBOX_RADIUS on its way to the galaxy.
  const inMilkyWayView = outsideSkybox && !galacticViewActive && !spaceshipViewActive && !isFlyingTo;
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
      // Inline galaxy mode: BH model visible when galaxy is shown AND the
      // camera is close enough that the detail is actually worth drawing.
      // At very far zoom (bhTransitionT < 0.15) the BH hides and only the
      // galacticGlowSprite remains — at that scale the model is sub-pixel
      // anyway and the giant glow is the better visual.
      var _galaxyShown = outsideSkybox && !galacticViewActive && !spaceshipViewActive;
      blackHoleModel.visible = _galaxyShown && bhTransitionT > 0.15;
    }
    if (bhDiskMaterials && blackHoleModel && blackHoleModel.visible) {
      var _dt = deltaMs * 0.0005;
      var _zoomOut = 1.0 - bhTransitionT;
      for (var _di = 0; _di < bhDiskMaterials.length; _di++) {
        bhDiskMaterials[_di].uniforms.uTime.value += _dt;
        bhDiskMaterials[_di].uniforms.uZoomOut.value = _zoomOut;
      }
    }
  }

  // === BH skybox renderer-switch DISABLED for inline-galaxy mode ===
  // Original (disabled): when bhTransitionT > 0.06, this would hide the
  // galaxy / set black background / enable the lensing composer. In
  // inline-galaxy mode we keep the normal renderer running so the BH
  // disk renders on top of the visible galaxy.
  // To restore the skybox mode: change "false &&" back to nothing.
  if (false && bhTransitionT > 0.06 && !bhRendererSettings) {
    bhOrigToneMapping    = renderer.toneMapping;
    bhOrigExposure       = renderer.toneMappingExposure;
    bhOrigOutputEncoding = renderer.outputEncoding;
    bhOrigClearColor     = renderer.getClearColor(new THREE.Color()).getHex();
    renderer.toneMapping         = THREE.ReinhardToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.outputEncoding      = THREE.sRGBEncoding;
    renderer.setClearColor(0x000000, 1); // pure black background
    _bhSavedVisibility = new Map();
    const _bhTree = new Set();
    if (blackHoleModel) blackHoleModel.traverse(function(o) { _bhTree.add(o); });
    scene.traverse(function(obj) {
      if (obj === scene) return;
      _bhSavedVisibility.set(obj, obj.visible);
      // Hide everything except BH meshes — procedural starfield shown explicitly below
      if (!_bhTree.has(obj)) obj.visible = false;
    });
    if (bhPointLight)  bhPointLight.visible  = true;
    if (bhPointLight2) bhPointLight2.visible = true;
    if (bhPointLight3) bhPointLight3.visible = true;
    // Dim the real 8K skybox so lensing shader warps the actual starfield texture
    if (galaxySkybox && galaxySkybox.material) {
      galaxySkybox.visible = true;
      galaxySkybox.material.color.setScalar(0.35);
    }
    bhRendererSettings = true;
  } else if (bhTransitionT <= 0.03 && bhRendererSettings) {
    renderer.toneMapping         = bhOrigToneMapping;
    renderer.toneMappingExposure = bhOrigExposure;
    renderer.outputEncoding      = bhOrigOutputEncoding;
    if (bhOrigClearColor !== null) renderer.setClearColor(bhOrigClearColor, 1);
    if (bhPointLight)  bhPointLight.visible  = false;
    if (bhPointLight2) bhPointLight2.visible = false;
    if (bhPointLight3) bhPointLight3.visible = false;
    if (_bhSavedVisibility) {
      _bhSavedVisibility.forEach(function(wasVisible, obj) { obj.visible = wasVisible; });
      _bhSavedVisibility = null;
    }
    // Hide procedural starfield, restore full-brightness 8K skybox
    if (bhStarfield) bhStarfield.visible = false;
    if (galaxySkybox && galaxySkybox.material) galaxySkybox.material.color.setScalar(1.0);
    bhRendererSettings = false;
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
      const _gdt = deltaMs * 0.0005;
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
    if (bhStarfield) bhStarfield.visible = galBHTransitionT > 0.1;
  } else if (!galacticViewActive) {
    if (galBHTransitionT > 0) galBHTransitionT = 0;
    if (galBHSprite && galBHSprite.visible) galBHSprite.visible = false;
  }
  if (galacticViewActive && galBHTransitionT < 0.01 && galCentreSprite) {
    galCentreSprite.material.opacity = 1.0;
  }
  // ── End galactic view BH transition ───────────────────────────────────────

  // Advance simulation clock — at 1× real life, advances by real elapsed ms
  const simMsPerFrame = deltaMs * (speed / SPEED_REALLIFE);
  simulationDate = new Date(simulationDate.getTime() + simMsPerFrame);
  updateSimTimeDisplay();

  // Sun rotation
  sun.rotation.y += 0.135 * speed * deltaScale;
  sun.rotation.z = 7.25 * (Math.PI / 180);

  meshes.forEach(m=>{
    m.userData.angle += m.userData.speed * speed * deltaScale;
    m.position.x = Math.cos(m.userData.angle) * m.userData.dist;
    m.position.z = Math.sin(m.userData.angle) * m.userData.dist;

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
      m.rotation.y += 0.01212 * speed * deltaScale;
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
    }
    if (m.userData.name === "Saturn") {
      m.rotation.y += 0.02730 * speed * deltaScale;
      m.rotation.z = 26.7 * (Math.PI / 180);

      saturnTiltGroup.position.copy(m.position);
      ringUniforms.saturnPos.value.copy(m.position);
    }
    if (m.userData.name === "Uranus") {
      m.rotation.y -= 0.01687 * speed * deltaScale;
      m.rotation.z = 97.8 * (Math.PI / 180);
    }
    if (m.userData.name === "Neptune") {
      m.rotation.y += 0.01806 * speed * deltaScale;
      m.rotation.z = 28.3 * (Math.PI / 180);
    }
  });

  // 🌕 Moon follows Earth position in world space
  if (typeof moonGroup !== "undefined" && moonGroup) {
    const earthWorldPos = new THREE.Vector3();
    earth.getWorldPosition(earthWorldPos);
    moonGroup.position.copy(earthWorldPos);
    moonGroup.rotation.y += 0.0004434 * speed * deltaScale;
    moon.rotation.y += 0.0004434 * speed * deltaScale; // tidally locked
  }

  // 🪐 Jupiter moons follow Jupiter in world space
  if (typeof jupiterMoons !== "undefined" && jupiterMoons.length) {
    const jupiterWorldPos = new THREE.Vector3();
    jupiter.getWorldPosition(jupiterWorldPos);

    jupiterMoons.forEach(m => {
      if (m.group) {
        m.group.position.copy(jupiterWorldPos);
        m.group.rotation.y += m.speed * speed * deltaScale;
      }
    });

    jupiterMoonOrbitLines.forEach(line => {
      line.position.copy(jupiterWorldPos);
    });
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
  }

  // ☀️ Update Terraformed Mars shader sun direction
  if (terraformedMarsMaterial) {
    terraformedMarsMaterial.uniforms.sunDirection.value
      .copy(marsMesh.position.clone().negate().normalize());
  }

  // Lock camera target to selected object (only after fly animation completes)
  if (lockedObject && !isFlyingTo) {
    const targetPos = new THREE.Vector3();
    lockedObject.getWorldPosition(targetPos);

    const delta = targetPos.clone().sub(controls.target);
    controls.target.copy(targetPos);
    camera.position.add(delta);
    controls.update();
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
        // In galactic view blackHoleModel is scaled down by _galF, so the
        // world-space event horizon radius is bhEHRadius * _galF, not bhEHRadius.
        var _ehWorld = galacticViewActive && galaxyVisualRadius > 0
          ? bhEHRadius * (20.0 / (galaxyVisualRadius * 0.4))
          : bhEHRadius;
        var _shadowR = _ehWorld / (_camToBH * _halfTanFov * 2.0);
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
  { label: " • Jupiter", obj: meshes.find(m => m.userData.name === "Jupiter") },
  { label: "　 ◦ Io", obj: io.mesh },
  { label: "　 ◦ Europa", obj: europa.mesh },
  { label: "　 ◦ Ganymede", obj: ganymede.mesh },
  { label: "　 ◦ Callisto", obj: callisto.mesh },
  { label: " • Saturn", obj: meshes.find(m => m.userData.name === "Saturn") },
  { label: " • Uranus", obj: meshes.find(m => m.userData.name === "Uranus") },
  { label: " • Neptune", obj: meshes.find(m => m.userData.name === "Neptune") },
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
      flyToObject(item.obj);
    });
  });
}


// Back to list button
document.getElementById("backToList").addEventListener("click", () => {
  if (keplerSystemViewActive) showKeplerList();
  else showList();
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
  if (keplerSystemViewActive) {
    keplerListVisible = !keplerListVisible;
    if (keplerListVisible) {
      showKeplerList();
      document.getElementById("toggleList").textContent = "Hide Bodies";
    } else {
      document.getElementById("panel").style.display = "none";
      document.getElementById("toggleList").textContent = "Show Bodies";
    }
    return;
  }
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
});

// Resize
window.addEventListener("resize", ()=>{
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  if (keplerCamera) {
    keplerCamera.aspect = innerWidth/innerHeight;
    keplerCamera.updateProjectionMatrix();
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

  // Sun (always self-lit)
  const miniSun = new THREE.Mesh(
    new THREE.SphereGeometry(2.4, 48, 48),
    new THREE.MeshBasicMaterial({ map: sunTexture, color: 0xffeecc })
  );
  miniScene.add(miniSun);
  // Sphere radii (scene units) for sizing the selection ring; Sun is 2.4
  const bodyRadius = { Sun: 2.4 };

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
  miniGlow.scale.set(11, 11, 1);
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
  const miniPlanetDefs = [
    { name:'Mercury', dist: 4.0,  size: 0.42, tex: mercuryTexture, color: 0xbbbbbb, years: 0.2408 },
    { name:'Venus',   dist: 5.6,  size: 0.62, tex: venusTexture,   color: 0xffcc88, years: 0.6152 },
    { name:'Earth',   dist: 7.4,  size: 0.70, tex: earthTexture,   color: 0xffffff, years: 1.0000 },
    { name:'Mars',    dist: 9.4,  size: 0.52, tex: marsTexture,    color: 0xff8866, years: 1.8810 },
    { name:'Jupiter', dist: 14.0, size: 1.55, tex: jupiterTexture, color: 0xffddaa, years: 11.862 },
    { name:'Saturn',  dist: 18.5, size: 1.30, tex: saturnTexture,  color: 0xffeebb, years: 29.457 },
    { name:'Uranus',  dist: 22.5, size: 0.92, tex: uranusTexture,  color: 0xaaddff, years: 84.011 },
    { name:'Neptune', dist: 26.5, size: 0.90, tex: neptuneTexture, color: 0x6688ff, years: 164.79 }
  ];

  const miniPlanets = [];
  let saturnMesh = null;
  let saturnRingMesh = null;
  let earthMesh = null;
  let earthShaderMat = null;

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
    miniPlanets.push({ mesh, name: p.name, dist: p.dist, speed, angle: startAngle });
    miniScene.add(mesh);

    // Faint orbit ring
    const orbitGeo = new THREE.RingGeometry(p.dist - 0.02, p.dist + 0.02, 128);
    const orbitMat = new THREE.MeshBasicMaterial({
      color: 0x6da8ff, transparent: true, opacity: 0.13, side: THREE.DoubleSide
    });
    const orbit = new THREE.Mesh(orbitGeo, orbitMat);
    orbit.rotation.x = -Math.PI / 2;
    miniScene.add(orbit);

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
  const moonDefs = [
    { name: 'Moon',     parent: 'Earth',   tex: moonTexture,     size: 0.18, dist: 1.30, period: 2.7 },
    { name: 'Io',       parent: 'Jupiter', tex: ioTexture,       size: 0.16, dist: 1.95, period: 1.5 },
    { name: 'Europa',   parent: 'Jupiter', tex: europaTexture,   size: 0.14, dist: 2.45, period: 2.1 },
    { name: 'Ganymede', parent: 'Jupiter', tex: ganymedeTexture, size: 0.19, dist: 3.10, period: 3.0 },
    { name: 'Callisto', parent: 'Jupiter', tex: callistoTexture, size: 0.16, dist: 3.85, period: 4.6 }
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
      tilt: (Math.random() - 0.5) * 0.25
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
    if (typeof keplerSystemViewActive !== 'undefined' && keplerSystemViewActive
        && typeof exitKeplerSystem === 'function') {
      try { exitKeplerSystem(); } catch (e) { console.warn('exitKeplerSystem failed:', e); }
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
