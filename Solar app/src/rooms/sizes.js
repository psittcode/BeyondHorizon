// Room: True Size Comparison.
//
// Every body in the program — the Sun, the 8 planets, the 5 dwarf planets, all
// 28 moons, plus the Kepler-22 star and its exoplanet — lined up side by side at
// TRUE relative scale (the same 1 unit = 14.96M km anchor the solar view uses),
// sorted smallest → largest like the classic "star size comparison" image, in
// front of the same 8k Milky Way skybox the solar system uses. After the Sun the
// line-up keeps going up the cosmic scale ladder: the whole Kepler-22 system,
// the whole Solar System (out to Eris's orbit), then the Milky Way and Andromeda
// galaxies — for those two the sky switches to the plain 8k star field
// (8k_stars.jpg), since you can't be "inside" the Milky Way while looking at it.
//
// Lighting is realistic: one fixed sun-like directional light (plus a whisper of
// ambient), so bodies have a day side and a night side — orbit behind one and it
// goes dark. Earth uses the same day/night city-lights shader, cloud layer and
// fresnel atmosphere rim as the main simulation; Venus and Titan keep their haze
// rims, Enceladus its south-polar vapour plumes, Kepler-22b its cloud deck, and
// Saturn/Jupiter/Neptune/Uranus their real ring systems — all ported from
// world.js / kepler.js with the sun direction swapped from "the origin" to the
// room's fixed light direction.
//
// Navigation: ◀ / ▶ steps through one at a time (camera flies with log-distance
// easing so hops across scales stay smooth), clicking a body selects it, arrow
// keys work, and "Full line-up" reframes the classic bodies row (the system/
// galaxy stops are too large to share a frame with the moons).
//
// Lazy room (see viewManager.js): costs nothing until the main-menu "True Size"
// button is clicked. Radii come straight from src/data/planets.js; moons reuse
// the exact real shape models / seeded procedural shapes via world.js exports
// (safe: world.js has long finished evaluating by the time this lazy-loads).

import { loadTexture, loadGLB } from '../core/assets.js';
import { data } from '../data/planets.js';
import { LY_KM } from '../core/scale.js';
import {
  makeGriddedMoonGeometry, makeMoonShapeGeometry, makeAsteroidGeometry,
  REAL_MOON_SHAPES, BH_DISK_VERT, BH_DISK_FRAG, BH_LENS_FRAG,
  BH_TUNE, bhTuneRegister, bhTuneDiskUniforms, bhTuneLensUniforms,
  setBHTunerAvailable,
  orbitalToXYZ, ORBIT_COLORS, getStudioEnvMap, renderStationOverlay,
} from '../world.js';

const KM_PER_UNIT   = 14959787.07;  // same anchor as the solar view (1 AU = 10 units)
const AU_UNITS      = 10;
const R_EARTH_KM    = 6371;
const SKYBOX_RADIUS = 3000;
const FLY_MS = 900;

// Special `selected` value (real stops are indices >= 0).
const INTRO = -1;   // start of the tour: empty sky just before the smallest body

// Fixed "sun" direction for the whole room (world space, pointing TOWARD the
// light). Every lit material, atmosphere rim and ring shadow uses this one
// vector, so the terminator is consistent across all bodies. Angled well off
// the default camera direction so each body shows a real lit side and night
// side — the terminator is clearly visible instead of a flat full-phase disc.
const SUN_DIR = new THREE.Vector3(-0.62, 0.32, 0.72).normalize();

// Visual info the data module doesn't carry for the major planets (their meshes
// are built in world.js): texture file + axial tilt (deg) + ring spec. Ring
// inner/outer are body-radius multiples, matching the main sim's geometry.
const PLANET_EXTRAS = {
  Mercury: { tex: '2k_mercury.jpg',          tilt: 0.03 },
  Venus:   { tex: '4k_venus_atmosphere.jpg', tilt: 177.4, atmoRim: '#d8954a' },
  Earth:   { tex: '2k_earth_daymap.jpg',     tilt: 23.4,  atmoRim: '#ffffff' },
  Mars:    { tex: '2k_mars.jpg',             tilt: 25.2 },
  Jupiter: { tex: 'jupiter.jpg',             tilt: 3.1,  ring: { kind: 'jupiter', inner: 1.4,  outer: 1.81 } },
  Saturn:  { tex: '2k_saturn.jpg',           tilt: 26.7, ring: { kind: 'saturn',  inner: 1.5,  outer: 2.5  } },
  Uranus:  { tex: '2k_uranus.jpg',           tilt: 97.8, ring: { kind: 'uranus',  inner: 1.12, outer: 4.0  } },
  Neptune: { tex: '2k_neptune.jpg',          tilt: 28.3, ring: { kind: 'neptune', inner: 1.7,  outer: 2.6  } },
};

// Bodies that live outside the data array (built directly in world.js / kepler.js),
// with the same true radii those files use.
const EXTRA_BODIES = [
  // The line-up's new first stop, and the only thing in it we built ourselves.
  // At 109 m it is ~113× smaller than Deimos, the smallest natural body here —
  // so it opens the tour by making the whole rest of the row look enormous.
  // NASA's own glTF model (nasa/NASA-3D-Resources), not a sphere: `glb` sends it
  // down the model branch in the build loop instead of the SphereGeometry path.
  { name: 'International Space Station', r: (0.109 / 2) / KM_PER_UNIT,
    glb: 'iss.glb?v=3', type: 'Space station · orbits Earth at 408 km',  // ?v must match world.js so the loader cache is shared
    stats: '109 m across the solar arrays · 420 tonnes · the largest structure humans have put in space' },
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
    type: 'Exoplanet · orbits Kepler-22', clouds: 'kepler' },
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

// ── Ported shaders (world.js / kepler.js originals, sun at the origin swapped
//    for the room's fixed uSunDir) ─────────────────────────────────────────────

// Sun-masked fresnel atmosphere rim — the exact Titan/Venus/Earth shell from the
// main sim: a thin BackSide shell whose glow hugs the sunlit limb only.
function makeAtmoShell(R, colorHex) {
  const geo = new THREE.SphereGeometry(R * 1.09, 64, 48);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor:    { value: new THREE.Color(colorHex) },
      uCoef:     { value: 0.56 },
      uPower:    { value: 14.0 },
      uStrength: { value: 1.67 },
      uSunDir:   { value: SUN_DIR },
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
      uniform vec3 uSunDir;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float rim = pow(max(0.0, uCoef - dot(vNormal, vView)), uPower);
        // Reflect the BackSide (far) normal to the near hemisphere, then mask by
        // the sun direction so only the sunlit limb glows (see world.js Titan).
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 nearN = normalize(N - 2.0 * dot(N, V) * V);
        float sunMask = smoothstep(0.0, 0.40, dot(nearN, uSunDir));
        gl_FragColor = vec4(uColor, rim * uStrength * sunMask);
      }
    `,
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.frustumCulled = false;
  shell.renderOrder = 3;
  return shell;
}

// Earth's day/night material — the main sim's shader: daymap on the lit side
// blending to the city-lights night map across the terminator.
function makeEarthMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      dayTexture:   { value: loadTexture('2k_earth_daymap.jpg') },
      nightTexture: { value: loadTexture('2k_earth_nightmap.jpg') },
      sunDirection: { value: SUN_DIR },
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
    `,
  });
}

// Sun-lit cloud layer (normal alpha blending) — Earth's clouds read coverage
// from the grayscale map's red channel; Kepler-22b's clouds.png carries it in
// its alpha channel (× 1.15 accent), exactly as in kepler.js.
function makeCloudLayer(R, texFile, coverageExpr) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(R, 48, 48),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        cloudTexture: { value: loadTexture(texFile) },
        sunDirection: { value: SUN_DIR },
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
          float cloud = ${coverageExpr};
          float intensity = dot(normalize(vNormal), sunDirection);
          float lit = smoothstep(-0.2, 0.3, intensity);   // wide, soft day↔night transition
          float brightness = mix(0.25, 1.0, lit);         // raised night floor
          gl_FragColor = vec4(vec3(brightness), cloud);
        }
      `,
    })
  );
  mesh.scale.setScalar(1.005);   // 0.5% above the surface
  return mesh;
}

// Enceladus's south-polar vapour plumes — the main sim's GPU particle jets
// (world.js buildEnceladusPlume), with the same hand-traced tiger-stripe vents.
// Here uFlow advances steadily so the jets always stream (there's no speed
// slider in this room). Returns { points, uniforms } — parent points to the moon
// mesh so the vents stay pinned to the south pole as it rotates.
const ENCELADUS_VENTS = [
  [0.0782,-0.9878,-0.1350], [-0.0259,-0.9980,-0.0584], [-0.1305,-0.9909,0.0338],
  [0.1903,-0.9817,-0.0067], [0.0647,-0.9947,0.0796],   [-0.0588,-0.9879,0.1432],
  [0.2368,-0.9626,0.1316],  [0.1066,-0.9789,0.1744],   [-0.1999,-0.9721,-0.1226],
  [0.0864,-0.9958,-0.0309], [-0.0923,-0.9761,-0.1969], [-0.2557,-0.9667,-0.0121],
];
const VAPOR = { opacity: 0.03, size: 0.87, length: 1.15, spread: 0.31, brightness: 0.51 };
function makeEnceladusPlume(R) {
  const PER_VENT = 130;
  const N = ENCELADUS_VENTS.length * PER_VENT;
  const position = new Float32Array(N * 3);
  const aDir     = new Float32Array(N * 3);
  const aPhase0  = new Float32Array(N);
  const aSize    = new Float32Array(N);
  const up = new THREE.Vector3();
  let i = 0;
  ENCELADUS_VENTS.forEach(v => {
    const n = new THREE.Vector3(v[0], v[1], v[2]).normalize();
    up.set(0, 1, 0); if (Math.abs(n.dot(up)) > 0.9) up.set(1, 0, 0);
    const t1 = new THREE.Vector3().crossVectors(n, up).normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
    const base = n.clone().multiplyScalar(R);
    for (let k = 0; k < PER_VENT; k++) {
      position[i * 3] = base.x; position[i * 3 + 1] = base.y; position[i * 3 + 2] = base.z;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.pow(Math.random(), 0.7) * VAPOR.spread;
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
    uMoonScale:   { value: 1 },
    uSizeK:       { value: 600 },   // refreshed each frame from the camera/viewport
    uSizeMul:     { value: VAPOR.size },
    uOpacity:     { value: VAPOR.opacity },
    uBrightness:  { value: VAPOR.brightness },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    vertexShader: `
      attribute vec3 aDir;
      attribute float aPhase0;
      attribute float aSize;
      uniform float uFlow, uPlumeLength, uMoonScale, uSizeK, uSizeMul;
      varying float vAlpha;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        float phase = fract(aPhase0 + uFlow);
        vec3 pos = position + aDir * (phase * uPlumeLength);
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        float worldR = aSize * uSizeMul * uMoonScale * (0.45 + phase * 1.7);
        gl_PointSize = clamp(worldR * uSizeK / max(1e-9, -mv.z), 1.0, 400.0);
        vAlpha = pow(1.0 - phase, 1.3) * smoothstep(0.0, 0.06, phase);
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
        float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
        float a = exp(-d * d * 2.8) * vAlpha * uOpacity;
        if (a < 0.002) discard;
        gl_FragColor = vec4(vec3(0.86, 0.91, 1.0) * uBrightness, a);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  return { points: pts, uniforms };
}

// Ring meshes — the main sim's ring shaders. Saturn keeps the full-strength
// C/B/Cassini/A banding; Jupiter is the dark reddish dust band (alpha ×0.06);
// Neptune the ghostly pale haze (×0.05); all three carry the planet's cast
// shadow across the night side (sun direction = uSunDir). Uranus is the
// procedural 13-ring system with the dark mains, bright Epsilon, and the faint
// red Nu / blue Mu dust ribbons. uPlanetPos/uRingNormal are filled in after
// layout (see _initRingUniforms).
const RING_TINTS = {
  saturn:  { tint: [1, 1, 1],          mix: 0.0,  alpha: 1.0  },
  jupiter: { tint: [0.42, 0.30, 0.22], mix: 0.85, alpha: 0.06 },
  neptune: { tint: [0.72, 0.78, 0.88], mix: 0.85, alpha: 0.05 },
};
function makeShaderRing(bodyR, spec) {
  const geo = new THREE.RingGeometry(bodyR * spec.inner, bodyR * spec.outer,
                                     spec.kind === 'uranus' ? 160 : 96);
  let mat;
  if (spec.kind === 'uranus') {
    mat = new THREE.ShaderMaterial({
      uniforms: { outerMul: { value: spec.outer } },
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
        float ribbon(float r, float c, float halfW, float edge){
          return smoothstep(c - halfW - edge, c - halfW, r)
               * (1.0 - smoothstep(c + halfW, c + halfW + edge, r));
        }
        void main() {
          #include <logdepthbuf_fragment>
          float rr = length(vUv - 0.5) * 2.0;
          float physR = rr * outerMul;
          float inner = smoothstep(1.12, 1.34, physR) * (1.0 - smoothstep(1.90, 2.04, physR));
          vec3  innerCol = vec3(0.42, 0.40, 0.38);
          float mains =
              band(physR,1.637,0.006) + band(physR,1.665,0.006)
            + band(physR,1.749,0.007) + band(physR,1.786,0.007)
            + band(physR,1.846,0.006) + band(physR,1.863,0.006)
            + band(physR,1.890,0.007) + band(physR,1.957,0.008);
          vec3  mainsCol = vec3(0.46, 0.44, 0.42);
          float eps    = band(physR, 2.00, 0.012);
          vec3  epsCol = vec3(0.62, 0.60, 0.57);
          float nu    = ribbon(physR, 2.63, 0.10, 0.05);
          vec3  nuCol = vec3(0.22, 0.04, 0.03);   // deep, dark red (Nu — rocky)
          float mu    = ribbon(physR, 3.50, 0.22, 0.07);
          vec3  muCol = vec3(0.04, 0.07, 0.20);   // deep, dark blue (Mu — ice)
          vec3  col = innerCol * inner + mainsCol * mains + epsCol * eps + nuCol * nu + muCol * mu;
          float a   = inner * 0.10 + mains * 0.04 + eps * 0.15 + nu * 0.15 + mu * 0.15;
          if (a < 0.003) discard;
          gl_FragColor = vec4(col, a);
        }
      `,
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
    });
  } else {
    const t = RING_TINTS[spec.kind];
    mat = new THREE.ShaderMaterial({
      uniforms: {
        map:           { value: loadTexture('8k_saturn_ring_alpha.png') },
        uTint:         { value: new THREE.Vector3(t.tint[0], t.tint[1], t.tint[2]) },
        uTintMix:      { value: t.mix },
        uAlphaMul:     { value: t.alpha },
        uSunDir:       { value: SUN_DIR },
        uPlanetPos:    { value: new THREE.Vector3() },   // set after layout
        uPlanetRadius: { value: bodyR },
        uRingNormal:   { value: new THREE.Vector3(0, 1, 0) },   // set after layout
      },
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
        uniform vec3 uTint;
        uniform float uTintMix;
        uniform float uAlphaMul;
        uniform vec3 uSunDir;
        uniform vec3 uPlanetPos;
        uniform float uPlanetRadius;
        uniform vec3 uRingNormal;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          float rr = length(vUv - 0.5) * 2.0;
          float t  = clamp((rr - 0.6) / 0.4, 0.0, 1.0);
          vec4 texColor = texture2D(map, vec2(t, 0.5));
          if (texColor.a < 0.01) discard;
          vec3 col = mix(texColor.rgb, uTint, uTintMix);
          // Planet shadow: sun direction projected into the ring plane → a long
          // band across the rings' night side (same construction as the sim).
          vec3 ringPoint = vWorldPos - uPlanetPos;
          vec3 nrm = normalize(uRingNormal);
          vec3 sunFlat = uSunDir - dot(uSunDir, nrm) * nrm;
          float sfl = length(sunFlat);
          vec3 shadowDir = sfl > 0.001 ? sunFlat / sfl : uSunDir;
          float proj = dot(ringPoint, shadowDir);
          float shadowFactor = 1.0;
          if (proj < 0.0) {
            float perpDist = length(ringPoint - proj * shadowDir);
            float edge = uPlanetRadius * 0.10;
            float shadow = 1.0 - smoothstep(uPlanetRadius - edge, uPlanetRadius + edge, perpDist);
            shadowFactor = 1.0 - shadow * 0.7;
          }
          gl_FragColor = vec4(col * shadowFactor, texColor.a * uAlphaMul);
        }
      `,
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
    });
  }
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  return ring;
}

// Soft radial-gradient glow sprite for the stars.
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

// 1px orbit circle in the xz-plane (like the sim's orbit lines).
function makeOrbitLine(radius, color, opacity) {
  const pts = [];
  for (let i = 0; i <= 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity })
  );
}

function fmtKm(km) {
  if (km < 100) return km.toFixed(1);
  return Math.round(km).toLocaleString('en-US');
}
function fmtVsEarth(km) {
  const x = km / R_EARTH_KM;
  if (x >= 10)   return x.toFixed(1);
  if (x >= 0.01) return x.toFixed(2);
  return x.toPrecision(2);
}

// ── Catalog ───────────────────────────────────────────────────────────────────

// Spherical bodies: every planet/dwarf/moon in the data array + the extras,
// sorted smallest → largest (the classic comparison-image order).
function buildBodyCatalog() {
  const cat = [];
  data.forEach(p => {
    const ex = PLANET_EXTRAS[p.name] || {};
    cat.push({
      name: p.name, r: p.size,
      tex: p.texture || ex.tex, color: p.color,
      tilt: (p.tilt != null ? p.tilt : ex.tilt) || 0,
      ellipsoid: p.ellipsoid, ring: ex.ring, atmoRim: ex.atmoRim,
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
  cat.sort((a, b) => a.r - b.r);
  return cat;
}

// The cosmic-scale ladder appended after the Sun: whole systems, then galaxies
// (which switch the sky to the plain 8k star field — you can't see the Milky
// Way as a backdrop while looking AT the Milky Way).
const LY_UNITS = LY_KM / KM_PER_UNIT;
const MEGA_ENTRIES = [
  {
    // Right after the Sun — with its accretion disc (10× the horizon radius,
    // as the sim models it) Sgr A* spans ≈ 205 million km ≈ 1.4 AU: genuinely
    // almost as wide as Kepler-22b's whole orbit. Supermassive is not a metaphor.
    name: 'Sagittarius A*', type: 'Supermassive black hole · heart of the Milky Way',
    mega: 'sgr-a', span: (12.3e6 / KM_PER_UNIT / 1.2) * 10,
    stats: 'Accretion disc ≈ 205 million km wide · event horizon ≈ 24 million km · 4.3 million Suns',
  },
  {
    name: 'The Kepler-22 System', type: 'Planetary system', mega: 'kepler-system',
    span: 0.849 * AU_UNITS,
    stats: 'Kepler-22b’s orbit ≈ 0.85 AU · 254 million km across',
  },
  {
    name: 'The Solar System', type: 'Planetary system', mega: 'solar-system',
    span: 678.6,   // Eris's semi-major axis (data units)
    stats: 'Out to Eris’s orbit ≈ 136 AU · 20 billion km across',
  },
  {
    name: 'The Milky Way', type: 'Spiral galaxy · our home', mega: 'milky-way',
    span: 50000 * LY_UNITS, sky: 'stars',
    stats: '≈ 100,000 light-years across · 200–400 billion stars',
  },
  {
    name: 'The Andromeda Galaxy', type: 'Spiral galaxy · 2.5 million ly away', mega: 'andromeda',
    span: 110000 * LY_UNITS, sky: 'stars',
    stats: '≈ 220,000 light-years across · ~1 trillion stars',
  },
];

const room = {
  scene: null, camera: null, controls: null,
  bodies: [],           // catalog entries, each with .group/.mesh/.x added
  selected: -1,         // -1 = overview, else index into bodies
  kmPerUnit: KM_PER_UNIT,
  _skybox: null, _skyGalaxyTex: null, _skyStarsTex: null, _currentSky: 'galaxy',
  _spins: [],           // { obj, rate } — rotation.y advanced every frame
  _plume: null,
  _bhMats: [],          // Sgr A* accretion-disc materials (uTime advanced per frame)
  _bhWorldPos: null, _bhEHWorld: 0,
  _rt: null, _lensMat: null, _lensScene: null, _lensCam: null, _rtW: 0, _rtH: 0,
  _lastT: 0, _fly: null, _active: false,
  _raycaster: null, _downXY: null,
  _glbStops: [],        // { obj, span } — redrawn by renderStationOverlay each frame
  _occluders: null,     // sphere stops as { pos, r }, built lazily for the overlay

  async init(ctx) {
    window.__sizesRoom = this;   // debug/inspection handle (harmless)
    const scene = new THREE.Scene();
    this.scene = scene;

    // Skybox: the solar view's 8k Milky Way panorama by default, swapped to the
    // plain 8k star field while a galaxy is selected. Follows the camera; draws
    // first with no depth so objects beyond its radius still render in front.
    this._skyGalaxyTex = ctx.milkyWayTexture || loadTexture('8k_stars_milky_way.jpg');
    this._skyStarsTex  = ctx.starsTexture   || loadTexture('8k_stars.jpg');
    this._skybox = new THREE.Mesh(
      new THREE.SphereGeometry(SKYBOX_RADIUS, 60, 40),
      new THREE.MeshBasicMaterial({ map: this._skyGalaxyTex, side: THREE.BackSide, depthWrite: false })
    );
    this._skybox.renderOrder = -100;
    scene.add(this._skybox);

    // Realistic lighting: one fixed sun-like key light + a whisper of ambient,
    // so every body has a proper day side and night side.
    const ambient = new THREE.AmbientLight(0xffffff, 0.10);
    scene.add(ambient);
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.35);
    sunLight.position.copy(SUN_DIR);   // direction only — magnitude is irrelevant
    scene.add(sunLight);
    scene.add(sunLight.target);
    // The ISS stop renders in a depth-cleared layer-1 pass (renderStationOverlay
    // in world.js) — enable the lights there too or it draws unlit.
    ambient.layers.enable(1);
    sunLight.layers.enable(1);

    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1e-7, 1e12);
    this.controls = new THREE.OrbitControls(this.camera, ctx.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 0.5;
    this.controls.enabled = false;
    // Keep the main loop at full rate while damping is still settling after
    // the pointer is released (raw input is already covered by world.js's
    // listeners on the shared canvas — see isActive() / animate()'s pacing).
    if (ctx.markCameraActive) this.controls.addEventListener('change', ctx.markCameraActive);

    // ── Build + lay out the line-up ─────────────────────────────────────────
    this.bodies = buildBodyCatalog();
    // span = half-width the entry occupies in the row: rings stick out past the
    // surface, and the stars' glow halos (sprite = 4.6×r wide → ~2.3×r half)
    // count too so the Sun's and Kepler-22's halos can never overlap.
    this.bodies.forEach(b => {
      b.span = b.ring ? b.r * (b.ring.outer + 0.15) : (b.glow ? b.r * 2.4 : b.r);
    });
    MEGA_ENTRIES.forEach(m => this.bodies.push(Object.assign({}, m)));

    // Side-by-side along +x, generously spaced (NASA-Eyes style): the gap scales
    // with the larger neighbour so each body stands clearly apart.
    let edge = 0, prevSpan = 0;
    this.bodies.forEach((b, i) => {
      const gap = i === 0 ? 0 : Math.max(prevSpan, b.span) * 1.8;
      b.x = edge + gap + b.span;
      edge = b.x + b.span;
      prevSpan = b.span;
    });
    // Centre the classic bodies row (not the mega stops) on the origin.
    const lastBody = this.bodies.filter(b => !b.mega).pop();
    const shift = (lastBody.x + lastBody.span) / 2;
    this.bodies.forEach(b => { b.x -= shift; });

    const ringsToInit = [];
    for (const b of this.bodies) {
      if (b.mega) { this._buildMega(b); continue; }
      if (b.glb)  { this._buildGLB(b);  continue; }

      const geo = b.mn ? moonGeometry(b.mn, b.mnIdx) : new THREE.SphereGeometry(b.r, 64, 64);
      let mesh;
      if (b.name === 'Earth') {
        mesh = new THREE.Mesh(geo, makeEarthMaterial());
      } else {
        const matOpts = {};
        if (b.tex) matOpts.map = loadTexture(b.tex); else matOpts.color = b.color || 0xaaaaaa;
        if (b.tint) matOpts.color = b.tint;
        mesh = new THREE.Mesh(geo, b.selfLit
          ? new THREE.MeshBasicMaterial(matOpts)
          : new THREE.MeshStandardMaterial(matOpts));
      }
      if (b.ellipsoid) mesh.scale.set(b.ellipsoid[0], b.ellipsoid[1], b.ellipsoid[2]);
      mesh.userData.bodyIndex = this.bodies.indexOf(b);

      const group = new THREE.Group();          // tilt container
      group.add(mesh);

      // The sim's per-body dressing: rings, atmosphere rims, clouds, plumes.
      if (b.ring) {
        const ring = makeShaderRing(b.r, b.ring);
        group.add(ring);
        if (b.ring.kind !== 'uranus') ringsToInit.push({ ring, group });
      }
      if (b.atmoRim) mesh.add(makeAtmoShell(b.r, b.atmoRim));
      if (b.name === 'Titan') mesh.add(makeAtmoShell(b.r, '#e7be62'));
      if (b.name === 'Earth') {
        const clouds = makeCloudLayer(b.r, '2k_earth_clouds.jpg',
          'texture2D(cloudTexture, vUv).r');
        group.add(clouds);
        this._spins.push({ obj: clouds, rate: 0.0033 });   // clouds drift past the surface
      }
      if (b.clouds === 'kepler') {
        const clouds = makeCloudLayer(b.r, 'clouds.png',
          'clamp(texture2D(cloudTexture, vUv).a * 1.15, 0.0, 1.0)');
        group.add(clouds);
        this._spins.push({ obj: clouds, rate: 0.0033 });
      }
      if (b.name === 'Enceladus') {
        this._plume = makeEnceladusPlume(b.r);
        mesh.add(this._plume.points);
      }
      if (b.glow) group.add(makeGlowSprite(b.glow, b.r));

      group.rotation.z = -(b.tilt || 0) * Math.PI / 180;
      group.position.set(b.x, b.r, 0);          // centre at y = r → rests on the baseline

      b.group = group; b.mesh = mesh;
      this._spins.push({ obj: mesh, rate: 0.0028 });
      scene.add(group);
    }

    // Gravitational-lensing pipeline for Sagittarius A* — the sim's exact
    // screen-space shader (shadow void, photon ring, warm halo, background
    // warp), fed the BH's projected screen position/radius each frame, and
    // running from EVERY viewpoint so the lensed look never pops out when you
    // step away. The one thing the sim's shader can't know is occlusion, so
    // the scene is rendered into a target with a DEPTH texture and the shader
    // is given a per-pixel guard: any pixel whose scene depth is closer than
    // the BH keeps its original colour — a foreground planet passes cleanly
    // in front of the void instead of having it stamped on top.
    const LENS_FRAG_DEPTH = BH_LENS_FRAG
      .replace('uniform sampler2D tDiffuse;',
               'uniform sampler2D tDiffuse;\nuniform sampler2D tDepth;\nuniform float uBHDepth;')
      .replace('void main(){',
               'void main(){\n' +
               '  if (texture2D(tDepth, vUv).x < uBHDepth) { gl_FragColor = texture2D(tDiffuse, vUv); return; }');
    // No size corrections needed here: the shared shader draws the void at
    // exactly uShadowR (true horizon radius) with a tight halo, so this room
    // and the galaxy view stay in lockstep — one change updates every BH.
    const depthTex = new THREE.DepthTexture(innerWidth, innerHeight);
    depthTex.type = THREE.UnsignedIntType;
    this._rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight);
    this._rt.depthTexture = depthTex;
    this._lensMat = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        tDiffuse:  { value: null },
        tDepth:    { value: null },
        uBHDepth:  { value: 1.0 },
        uCenter:   { value: new THREE.Vector2(0.5, 0.5) },
        uStrength: { value: BH_TUNE.warpStrength },
        uInnerR:   { value: 0.03 },
        uOuterR:   { value: 0.12 },
        uShadowR:  { value: 0.06 },
        uAspect:   { value: innerWidth / innerHeight },
      }, bhTuneLensUniforms()),
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }',
      fragmentShader: LENS_FRAG_DEPTH,
      depthTest: false, depthWrite: false,
    });
    bhTuneRegister('lenses', this._lensMat.uniforms);
    this._lensScene = new THREE.Scene();
    this._lensScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._lensMat));
    this._lensCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Ring shadow uniforms need world transforms — resolve them, then bake the
    // (static) planet position + ring-plane normal into each tinted ring.
    scene.updateMatrixWorld(true);
    const q = new THREE.Quaternion();
    ringsToInit.forEach(({ ring, group }) => {
      group.getWorldPosition(ring.material.uniforms.uPlanetPos.value);
      group.getWorldQuaternion(q);
      ring.material.uniforms.uRingNormal.value.set(0, 1, 0).applyQuaternion(q);
    });

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
      const hits = this._raycaster.intersectObjects(
        this.bodies.map(b => b.mesh).filter(Boolean));
      if (hits.length) this.select(hits[0].object.userData.bodyIndex);
    });
    window.addEventListener('keydown', e => {
      if (!this._active) return;
      if (e.key === 'ArrowRight') { this.step(1);  e.preventDefault(); }
      if (e.key === 'ArrowLeft')  { this.step(-1); e.preventDefault(); }
    });
    document.getElementById('sizePrev').onclick = () => this.step(-1);
    document.getElementById('sizeNext').onclick = () => this.step(1);
  },

  // Build a model-based stop (the ISS): an actual mesh rather than a sphere,
  // normalised so its longest dimension is the real span 2·r. The GLB arrives
  // asynchronously, so the stop's group, its click proxy and its slot in the row
  // all exist immediately — the model just drops into the group when it lands.
  _buildGLB(b) {
    const group = new THREE.Group();
    group.position.set(b.x, b.r, 0);            // rests on the same baseline as the spheres

    // Invisible sphere at the stop's own scale so clicking works the moment the
    // room opens (and regardless of how sparse the model's geometry is — a truss
    // is mostly empty space, and rays would sail straight through it). Same
    // trick _buildMega uses for the flat cosmic-scale stops.
    const clickMesh = new THREE.Mesh(
      new THREE.SphereGeometry(b.r, 16, 16),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    clickMesh.userData.bodyIndex = this.bodies.indexOf(b);
    group.add(clickMesh);

    loadGLB(b.glb).then(gltf => {
      const model = gltf.scene.clone(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3(), centre = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(centre);
      model.position.sub(centre);
      const wrap = new THREE.Group();
      wrap.add(model);
      wrap.scale.setScalar((b.r * 2) / Math.max(size.x, size.y, size.z));
      // Materials are shared with the main sim's cached GLB — clone before
      // touching them, or the solar view's station changes with it. PBR as
      // authored + the shared studio environment map (see world.js) so metal
      // reflects like it does in a Sketchfab-class viewer.
      const env = getStudioEnvMap();
      model.traverse(o => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        o.material.envMap = env;
        o.material.envMapIntensity = 1.0;
        // Both faces: the array blankets are single-sided sheets that would
        // otherwise cull (turn see-through) viewed from behind — see world.js.
        o.material.side = THREE.DoubleSide;
        o.material.needsUpdate = true;
        // Layer 1: drawn only by renderStationOverlay's depth-tight pass —
        // at 7e-9 units the main pass's depth buffer can't resolve the model.
        o.layers.set(1);
      });
      group.add(wrap);
      this._spins.push({ obj: wrap, rate: 0.0028 });   // same slow turn as the globes
      this._glbStops.push({ obj: wrap, span: b.r * 2 });
    });

    b.group = group; b.mesh = clickMesh;
    this.scene.add(group);
  },

  // Build one cosmic-scale entry: a whole planetary system (star + true-scale
  // orbit circles) or a whole galaxy (its disc texture from the sim). All are
  // flat, so they sit in an inner group (spun slowly in-plane) inside an outer
  // group tipped toward the camera for a readable 3/4 view.
  _buildMega(b) {
    const inner = new THREE.Group();
    let clickMesh = null;

    if (b.mega === 'kepler-system' || b.mega === 'solar-system') {
      const starR = b.mega === 'kepler-system'
        ? (0.979 * 696340) / KM_PER_UNIT : 696340 / KM_PER_UNIT;
      const star = new THREE.Mesh(
        new THREE.SphereGeometry(starR, 32, 32),
        new THREE.MeshBasicMaterial({
          map: loadTexture('2k_sun.jpg'),
          color: b.mega === 'kepler-system' ? 0xffd9a6 : 0xffffff,
        }));
      inner.add(star);
      inner.add(makeGlowSprite(0xffcc66, Math.max(starR * 40, b.span * 0.012)));
      if (b.mega === 'kepler-system') {
        inner.add(makeOrbitLine(0.849 * AU_UNITS, 0xaaccff, 0.55));
        const planet = new THREE.Mesh(
          new THREE.SphereGeometry((2.4 * R_EARTH_KM) / KM_PER_UNIT, 16, 16),
          new THREE.MeshStandardMaterial({ map: loadTexture('Kepler 22b_0.jpeg') }));
        planet.position.set(0.849 * AU_UNITS, 0, 0);
        inner.add(planet);
      } else {
        // The real orbit structure from the sim: each body's true inclined
        // Keplerian ellipse (Sun at the focus, from its e/i/Ω/ω elements) in
        // that body's orbit-ring colour — Pluto and Eris visibly tilted out of
        // the ecliptic, exactly like the main view.
        data.forEach(p => {
          const pts = [];
          for (let k = 0; k <= 512; k++) {
            const nu = (k / 512) * Math.PI * 2;
            pts.push(orbitalToXYZ(p.dist, p.e, p.i, p.Om, p.w, nu, new THREE.Vector3()));
          }
          inner.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.LineBasicMaterial({
              color: ORBIT_COLORS[p.name] || 0xffffff, transparent: true,
              opacity: p.kind === 'dwarf' ? 0.35 : 0.55,
            })));
        });
      }
      // Fully invisible disc as the click target for the whole system — it
      // renders nothing (colorWrite off) but the raycaster still hits it.
      clickMesh = new THREE.Mesh(
        new THREE.CircleGeometry(b.span, 64),
        new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, opacity: 0,
                                      side: THREE.DoubleSide, depthWrite: false }));
      clickMesh.rotation.x = -Math.PI / 2;
      inner.add(clickMesh);
    } else if (b.mega === 'sgr-a') {
      // Sagittarius A*: the SAME procedural black hole the galaxy view builds
      // (world.js bhBuilder) — five stacked accretion-disc shader layers using
      // the shared BH_DISK_VERT/FRAG materials, plus the same soft orange glow
      // sprite. Scaled so the event horizon (bhR × 1.20 in the sim) equals the
      // true Schwarzschild diameter of Sgr A* (~24.6 million km).
      const bhR = 12.3e6 / KM_PER_UNIT / 1.2;
      // Inner radius 0.05 bhR (hidden under the shadow) feeds the lensing
      // warp real disc material at every sample radius — same fix as the
      // sim's diskGeo; a central hole paints a dark annulus around the sphere.
      // Outer 14 bhR is headroom for the BH Tuner's discOuter slider; the
      // visible edge is the uOuterR uniform (default 10 bhR = 205M km).
      const diskGeo = new THREE.RingGeometry(bhR * 0.05, bhR * 14.0, 512, 1);
      const diskLayerCount = 7, diskLayerSpacing = bhR * 0.045;
      for (let di = 0; di < diskLayerCount; di++) {
        const slot = di - (diskLayerCount - 1) * 0.5;
        const layerMat = new THREE.ShaderMaterial({
          uniforms: Object.assign({
            uInnerR:   { value: bhR * BH_TUNE.discInner },
            uOuterR:   { value: bhR * BH_TUNE.discOuter },
            uTime:     { value: 0.0 },
            uAlphaMul: { value: Math.exp(-Math.pow(slot / 2.2, 2.0)) * 0.42 },
            uLayerY:   { value: slot },
            uZoomOut:  { value: 0.0 },
          }, bhTuneDiskUniforms()),
          vertexShader: BH_DISK_VERT, fragmentShader: BH_DISK_FRAG,
          // depthTest ON (the sim runs it off): here the BH has true-scale
          // neighbours, and without the test its disc drew straight through
          // foreground planets.
          transparent: true, depthWrite: false, depthTest: true,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        });
        const layerMesh = new THREE.Mesh(diskGeo, layerMat);
        layerMesh.rotation.x = -Math.PI / 2;
        layerMesh.position.y = slot * diskLayerSpacing;
        layerMesh.renderOrder = 25;
        inner.add(layerMesh);
        this._bhMats.push(layerMat);
      }
      bhTuneRegister('disks', { mats: this._bhMats, bhR });

      // Soft orange glow sprite — same canvas gradient as the sim's BH.
      const gc = document.createElement('canvas'); gc.width = gc.height = 256;
      const gx = gc.getContext('2d');
      const gr = gx.createRadialGradient(128, 128, 0, 128, 128, 128);
      gr.addColorStop(0,    'rgba(255,120,10,0.25)');
      gr.addColorStop(0.40, 'rgba(220,60,2,0.10)');
      gr.addColorStop(0.70, 'rgba(160,25,0,0.03)');
      gr.addColorStop(1.0,  'rgba(100,8,0,0)');
      gx.fillStyle = gr; gx.fillRect(0, 0, 256, 256);
      const gSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(gc), blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false,
      }));
      gSprite.scale.set(bhR * BH_TUNE.glowSize, bhR * BH_TUNE.glowSize, 1);
      gSprite.renderOrder = 15;
      inner.add(gSprite);
      bhTuneRegister('glows', { sprite: gSprite, bhR });

      // The event-horizon shadow, photon ring, warm halo and background warp
      // come from the sim's screen-space gravitational-lensing pass (see
      // update()), which runs from every viewpoint — the sim has no horizon
      // mesh ("the lensing shader shadow mask IS the event horizon"), and a
      // visible sphere here would black out the disc around the horizon in
      // the pre-lens frame, smearing into a wide empty annulus. The click
      // target renders nothing (colorWrite/depthWrite off).
      this._bhEHWorld = bhR * 1.20;   // = 12.3e6 km / KM_PER_UNIT — the true EH radius (bhR was defined as EH/1.2)
      clickMesh = new THREE.Mesh(
        new THREE.SphereGeometry(this._bhEHWorld, 32, 32),
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      inner.add(clickMesh);
    } else {
      // Galaxy disc — same additive disc textures the sim uses for the Milky
      // Way (galaxyDiamond1) and the Andromeda room (androgalaxy).
      const texFile = b.mega === 'milky-way' ? 'galaxyDiamond1 fix1.png' : 'androgalaxy.png';
      clickMesh = new THREE.Mesh(
        new THREE.CircleGeometry(b.span, 96),
        new THREE.MeshBasicMaterial({
          map: loadTexture(texFile), transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
      clickMesh.rotation.x = -Math.PI / 2;
      inner.add(clickMesh);
    }

    const group = new THREE.Group();
    group.add(inner);
    // Orientation per entry:
    //  · Solar System — match the main sim's ecliptic: keep the orbit plane
    //    flat and roll it 23.4° about the view axis, the same tilt world.js
    //    gives the ecliptic via its camera.up (world.js ECLIPTIC_TILT). That
    //    23.4° is Earth's obliquity of the ecliptic — real, and specific to our
    //    Earth-anchored equatorial frame.
    //  · Kepler-22 — left flat, matching the main sim's Kepler room. The 23.4°
    //    is Earth's number and has no meaning there; the system's true obliquity
    //    is unknown, so an untilted orbital plane is the honest neutral choice.
    //  · Sgr A* — stays flat: the near-grazing camera + lensing give the sim's
    //    "plasma wrapped around the void" look, not a top-down vinyl record.
    //  · Galaxy discs — tipped 0.6 rad toward the camera for a readable 3/4
    //    face-on view of the disc.
    const ECLIPTIC_TILT = 23.4 * Math.PI / 180;
    if (b.mega === 'solar-system') {
      group.rotation.z = ECLIPTIC_TILT;
    } else if (b.mega !== 'kepler-system') {
      group.rotation.x = b.mega === 'sgr-a' ? 0 : 0.6;
    }
    group.position.set(b.x, 0, 0);
    if (b.mega === 'sgr-a') this._bhWorldPos = new THREE.Vector3(b.x, 0, 0);
    clickMesh.userData.bodyIndex = this.bodies.indexOf(b);

    b.group = group; b.mesh = clickMesh;
    // Only the galaxy discs get the gentle presentation spin. Excluded:
    // Sgr A* (its geometry is static — all apparent motion comes from the disc
    // shader's uTime flow), and the planetary systems (their orbit rings are
    // fixed real structures; the ecliptic doesn't visibly precess, so a spin
    // would just misrepresent the physics).
    const staticMega = b.mega === 'sgr-a'
      || b.mega === 'solar-system' || b.mega === 'kepler-system';
    if (!staticMega) this._spins.push({ obj: inner, rate: 0.0006 });
    this.scene.add(group);
  },

  // ── Camera framing ─────────────────────────────────────────────────────────
  // i >= 0: a body/stop. INTRO (-1): an empty patch of sky just before the
  // smallest body, so the tour begins on nothing and ▶ reveals Deimos.
  _frameFor(i) {
    if (i === INTRO) {
      const first = this.bodies[0];
      const dist = first.r * 3.6;
      // Empty patch of sky just before the smallest body. Distance alone can't
      // empty the frame (the bodies grow along the row, so the line-up stays
      // visible from any offset) — instead the camera sits on the ROW side of
      // the target, looking away down the line toward -x, so the whole row is
      // behind it and the tour opens on nothing but stars.
      const target = new THREE.Vector3(first.x - first.r * 40, first.r, 0);
      const pos = target.clone().add(
        new THREE.Vector3(0.85, 0.2, 0.49).multiplyScalar(dist));
      return { target, pos };
    }
    const b = this.bodies[i];
    if (b.mega) {
      const dist = b.span * (b.mega === 'sgr-a' ? 2.0 : 2.3);
      // Sgr A*: near-grazing view of the flat disc, like the sim's BH framing.
      const lift = b.mega === 'sgr-a' ? 0.09 : 0.18;
      const target = new THREE.Vector3(b.x, 0, 0);
      const pos = target.clone().add(new THREE.Vector3(0, dist * lift, dist));
      return { target, pos };
    }
    const dist = b.r * (b.ring ? 6.2 : 3.6);
    const target = new THREE.Vector3(b.x, b.r, 0);
    const pos = target.clone().add(new THREE.Vector3(dist * 0.18, dist * 0.16, dist));
    return { target, pos };
  },

  select(i, instant) {
    this.selected = i;
    this._applySky(i >= 0 && this.bodies[i].sky === 'stars' ? 'stars' : 'galaxy');
    const f = this._frameFor(i);
    if (instant) {
      this.controls.target.copy(f.target);
      this.camera.position.copy(f.pos);
      this.camera.up.set(0, 1, 0);
      this._fly = null;
      this._applyLimits();
    } else {
      // Zoom-arc parameters: when two stops are far apart relative to their
      // framing distances (Sun → Kepler-22 system → Solar System…), the camera
      // pulls BACK to a peak distance around the midpoint and dives back in —
      // the hop reads as a scale change, not a sideways pan. For neighbouring
      // moons the peak never exceeds the endpoints, so nothing changes.
      const fromT = this.controls.target.clone(), fromP = this.camera.position.clone();
      const d0 = Math.max(fromP.distanceTo(fromT), 1e-9);
      const d1 = Math.max(f.pos.distanceTo(f.target), 1e-9);
      const sep = fromT.distanceTo(f.target);
      const dPeak = Math.max(d0, d1, sep * 0.55);
      const bumpA = Math.max(0, Math.log(dPeak) - (Math.log(d0) + Math.log(d1)) / 2);
      this._fly = {
        t: 0,
        fromT, toT: f.target,
        fromP, toP: f.pos,
        d0, d1, bumpA,
        dur: FLY_MS * (1 + Math.min(1.6, bumpA * 0.22)),
      };
      this.controls.enabled = false;
      // Open the distance limits for the flight. controls.update() runs every
      // frame even while disabled and CLAMPS the camera radius to the limits of
      // the *previous* stop — flying out to a galaxy from a planet, the clamp
      // yanked the camera back in each frame (the zoom in-out-in stutter).
      // _applyLimits() restores proper limits on arrival.
      this.controls.minDistance = 0;
      this.controls.maxDistance = Infinity;
    }
    this._updateCaption();
  },

  _applySky(which) {
    if (which === this._currentSky) return;
    this._currentSky = which;
    this._skybox.material.map = which === 'stars' ? this._skyStarsTex : this._skyGalaxyTex;
    this._skybox.material.needsUpdate = true;
  },

  // Cyclic tour: intro → smallest → … → Andromeda → back to the intro.
  step(dir) {
    const n = this.bodies.length;
    let i = this.selected + dir;
    if (i >= n) i = INTRO;
    if (i < INTRO) i = n - 1;
    this.select(i);
  },

  _applyLimits() {
    // INTRO sits at the smallest body's scale, so it borrows the first body's
    // limits — a stale larger minDistance would let OrbitControls clamp the
    // camera thousands of Deimos radii out and wreck the framing.
    const b = this.selected >= 0 ? this.bodies[this.selected] : this.bodies[0];
    this.controls.minDistance = b.mega ? b.span * 0.05 : b.r * 1.25;
    this.controls.maxDistance = Math.max(b.span * 12, 0.01);
    // The default 1e-7 near plane sits in FRONT of the whole ISS (span 7.3e-9),
    // clipping it away entirely. Pull the near plane in for any stop small enough
    // to need it; the log depth buffer absorbs the widened near/far ratio.
    const wantNear = Math.min(1e-7, this.controls.minDistance * 0.05);
    if (this.camera.near !== wantNear) {
      this.camera.near = wantNear;
      this.camera.updateProjectionMatrix();
    }
  },

  _updateCaption() {
    const nameEl = document.getElementById('sizeName');
    const subEl  = document.getElementById('sizeSub');
    const statEl = document.getElementById('sizeStats');
    const cntEl  = document.getElementById('sizeCount');
    // Only the ▶ button shows on the intro panel — the tour hasn't started yet.
    document.getElementById('sizePrev').style.visibility =
      this.selected === INTRO ? 'hidden' : 'visible';
    if (this.selected === INTRO) {
      nameEl.textContent = 'The Solar System & Kepler-22';
      subEl.textContent  = `${this.bodies.length} stops · true relative scale`;
      statEl.textContent = 'Press ▶ to begin — smallest to largest';
      cntEl.textContent  = 'Start';
    } else {
      const b = this.bodies[this.selected];
      nameEl.textContent = b.name;
      subEl.textContent  = b.type;
      if (b.stats) {
        statEl.textContent = b.stats;
      } else {
        const km = b.r * KM_PER_UNIT;
        statEl.textContent = `Mean radius ${fmtKm(km)} km · ${fmtVsEarth(km)} × Earth`;
      }
      cntEl.textContent  = `${this.selected + 1} / ${this.bodies.length}`;
    }
  },

  // Frame-pacing report for world.js's animate(): full 60fps only while the
  // camera is flying between stops — everything else (drags, wheel zooms,
  // damping) refreshes _camDirtyUntil via the shared-canvas input listeners
  // and this room's controls 'change' hook, so a still scene idles at 10fps
  // exactly like the main views (the fans settle; the shader flows just
  // advance in coarser steps since all motion here is delta-timed).
  isActive() {
    return !!this._fly;
  },

  // ── Room contract ──────────────────────────────────────────────────────────
  enter(ctx) {
    ctx.controls.enabled = false;               // main-view controls off
    if (ctx.markCameraActive) ctx.markCameraActive();   // smooth entry
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
    for (const s of this._spins) s.obj.rotation.y += s.rate * dScale;

    // Sgr A*'s accretion discs flow at the sim's rate (world.js: deltaMs × 0.0005).
    for (const m of this._bhMats) m.uniforms.uTime.value += dScale * (1000 / 60) * 0.0005 * BH_TUNE.spinSpeed;

    // Enceladus's jets stream steadily; sprite size follows the viewport/fov.
    if (this._plume) {
      const u = this._plume.uniforms;
      u.uFlow.value = (u.uFlow.value + 0.004 * dScale) % 1.0;
      u.uSizeK.value = ctx.renderer.domElement.clientHeight /
        (2 * Math.tan((this.camera.fov * Math.PI / 180) / 2));
    }

    // Camera fly: target lerps linearly, camera distance interpolates in LOG
    // space so hops between a 6 km moon and a galaxy stay smooth. The bumpA
    // term (see select()) arcs the distance up to a midpoint peak on long hops
    // so the transition reads as zooming out and back in, not a sideways pan.
    if (this._fly) {
      const f = this._fly;
      f.t = Math.min(1, f.t + (now - (f._last || now - 16)) / f.dur);
      f._last = now;
      const e = f.t < 0.5 ? 4 * f.t * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 3) / 2; // easeInOutCubic
      // The target pans only through the middle of the flight (smoothstep
      // window): the camera first ZOOMS OUT in place over the start body, then
      // slides across while high, then settles down onto the destination —
      // reads as a scale change, never a sideways whip at close zoom.
      const p = THREE.MathUtils.smoothstep(e, 0.22, 0.85);
      const target = f.fromT.clone().lerp(f.toT, p);
      const dir0 = f.fromP.clone().sub(f.fromT).normalize();
      const dir1 = f.toP.clone().sub(f.toT).normalize();
      const dir = dir0.lerp(dir1, p).normalize();
      const d = Math.exp((1 - e) * Math.log(f.d0) + e * Math.log(f.d1)
                         + f.bumpA * Math.sin(Math.PI * e));
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir, d);
      this.camera.up.set(0, 1, 0);
      if (f.t >= 1) { this._fly = null; this._applyLimits(); this.controls.enabled = true; }
    }

    this.controls.update();
    // Sky follows the camera AFTER controls.update() — damping moves the camera
    // in update(), and at galaxy scale one frame's delta dwarfs the sky radius,
    // so copying first left the camera outside the sphere (black sky while orbiting).
    this._skybox.position.copy(this.camera.position);

    // Sgr A*'s gravitational lens runs whenever the horizon is in front of the
    // camera and big enough to matter (≥ ~1px) — from its own stop OR across
    // the row, so the lensed look never vanishes with distance. Same
    // projection math as world.js; no minimum-size floors (the sim's 0.015
    // floor assumes the BH is always the focus — here it would paint a giant
    // phantom shadow when the BH is a distant speck).
    let lensOn = false;
    if (this._bhWorldPos) {
      this.camera.updateMatrixWorld(true);
      const v = this._bhWorldPos.clone().applyMatrix4(this.camera.matrixWorldInverse);
      if (-v.z > 0) {   // in front of the camera
        const camToBH = this.camera.position.distanceTo(this._bhWorldPos);
        const halfTanFov = Math.tan(this.camera.fov * Math.PI / 360);
        const shadowR = this._bhEHWorld / (camToBH * halfTanFov * 2.0) * BH_TUNE.sphereScale;
        const p = this._bhWorldPos.clone().project(this.camera);
        const margin = 1 + 6 * shadowR;   // include the halo just off-screen
        if (shadowR > 0.0015 && Math.abs(p.x) < margin && Math.abs(p.y) < margin) {
          const u = this._lensMat.uniforms;
          u.uShadowR.value = shadowR;
          u.uInnerR.value  = shadowR * 0.82;
          u.uOuterR.value  = shadowR * 1.35;
          u.uAspect.value  = innerWidth / innerHeight;
          u.uCenter.value.set((p.x + 1.0) * 0.5, (p.y + 1.0) * 0.5);
          // BH centre's logarithmic depth (three.js: log2(1+w)/log2(far+1)) —
          // the shader's per-pixel occlusion guard compares scene depth to this.
          u.uBHDepth.value = Math.log2(1 - v.z) / Math.log2(this.camera.far + 1);
          lensOn = true;
        }
      }
    }
    if (lensOn) {
      const w = ctx.renderer.domElement.width, h = ctx.renderer.domElement.height;
      if (w !== this._rtW || h !== this._rtH) {
        this._rt.setSize(w, h);
        this._rtW = w; this._rtH = h;
      }
      ctx.renderer.setRenderTarget(this._rt);
      ctx.renderer.render(this.scene, this.camera);
      ctx.renderer.setRenderTarget(null);
      this._lensMat.uniforms.tDiffuse.value = this._rt.texture;
      this._lensMat.uniforms.tDepth.value   = this._rt.depthTexture;
      ctx.renderer.render(this._lensScene, this._lensCam);
    } else {
      ctx.renderer.render(this.scene, this.camera);
    }
    // Redraw the true-scale ISS with a depth range it can actually resolve
    // (see renderStationOverlay in world.js). Neighbouring sphere stops act as
    // occluders so e.g. orbiting behind Deimos still hides the station.
    if (this._glbStops.length) {
      if (!this._occluders) {
        this._occluders = this.bodies
          .filter(b => !b.mega && !b.glb)
          .map(b => ({ pos: new THREE.Vector3(b.x, b.r, 0), r: b.r }));
      }
      for (const g of this._glbStops) {
        renderStationOverlay(ctx.renderer, this.scene, this.camera,
                             g.obj, g.span, this._occluders);
      }
    }
    setBHTunerAvailable('room', lensOn);
  },

  exit(ctx) {
    this._active = false;
    setBHTunerAvailable('room', false);
    this.controls.enabled = false;
    document.getElementById('sizeUI').style.display = 'none';
    document.getElementById('speedPanel').style.display = '';
    ctx.controls.enabled = true;
  },
};

export default room;
