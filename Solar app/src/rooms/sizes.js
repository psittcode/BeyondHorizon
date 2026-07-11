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

import { loadTexture } from '../core/assets.js';
import { data } from '../data/planets.js';
import { LY_KM } from '../core/scale.js';
import {
  makeGriddedMoonGeometry, makeMoonShapeGeometry, makeAsteroidGeometry,
  REAL_MOON_SHAPES, BH_DISK_VERT, BH_DISK_FRAG,
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
    // Right after the Sun — its event horizon dwarfs the Sun but fits well
    // inside Kepler-22b's orbit, so this is its size-order slot.
    name: 'Sagittarius A*', type: 'Supermassive black hole · heart of the Milky Way',
    mega: 'sgr-a', span: (12.3e6 / KM_PER_UNIT / 1.2) * 10, sky: 'stars',
    stats: 'Event horizon ≈ 24 million km wide · 4.3 million Suns',
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
  _lastT: 0, _fly: null, _active: false,
  _raycaster: null, _downXY: null,

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
    scene.add(new THREE.AmbientLight(0xffffff, 0.10));
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.35);
    sunLight.position.copy(SUN_DIR);   // direction only — magnitude is irrelevant
    scene.add(sunLight);
    scene.add(sunLight.target);

    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1e-7, 1e12);
    this.controls = new THREE.OrbitControls(this.camera, ctx.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 0.5;
    this.controls.enabled = false;

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
        data.forEach(p => {
          inner.add(makeOrbitLine(p.dist,
            p.kind === 'dwarf' ? 0x99aabb : 0xaaccff,
            p.kind === 'dwarf' ? 0.28 : 0.55));
        });
      }
      // Invisible-ish disc as the click target for the whole system.
      clickMesh = new THREE.Mesh(
        new THREE.CircleGeometry(b.span, 64),
        new THREE.MeshBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.02,
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
      const diskGeo = new THREE.RingGeometry(bhR * 0.92, bhR * 10.0, 512, 1);
      const diskLayerCount = 5, diskLayerSpacing = bhR * 0.030;
      for (let di = 0; di < diskLayerCount; di++) {
        const slot = di - (diskLayerCount - 1) * 0.5;
        const layerMat = new THREE.ShaderMaterial({
          uniforms: {
            uInnerR:   { value: bhR * 0.92 },
            uOuterR:   { value: bhR * 10.0 },
            uTime:     { value: 0.0 },
            uAlphaMul: { value: Math.exp(-Math.pow(slot / 1.6, 2.0)) * 0.55 },
            uLayerY:   { value: slot },
            uZoomOut:  { value: 0.0 },
          },
          vertexShader: BH_DISK_VERT, fragmentShader: BH_DISK_FRAG,
          transparent: true, depthWrite: false, depthTest: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        });
        const layerMesh = new THREE.Mesh(diskGeo, layerMat);
        layerMesh.rotation.x = -Math.PI / 2;
        layerMesh.position.y = slot * diskLayerSpacing;
        layerMesh.renderOrder = 25;
        inner.add(layerMesh);
        this._bhMats.push(layerMat);
      }

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
        transparent: true, depthWrite: false, depthTest: false,
      }));
      gSprite.scale.set(bhR * 7, bhR * 7, 1);
      gSprite.renderOrder = 15;
      inner.add(gSprite);

      // The sim draws the event-horizon shadow + photon ring in its screen-space
      // lensing pass; here the same look is baked into a camera-facing billboard
      // drawn over the discs: black void (radius = bhR×1.20×1.18, the shadow the
      // lens shader paints), a tight photon ring, and a warm halo at its edge.
      const shadowR = bhR * 1.20 * 1.18;
      const spriteHalf = shadowR * 2.0;               // billboard half-width (world)
      const frac = shadowR / spriteHalf;              // shadow edge in [0,1] of half-width
      const sc = document.createElement('canvas'); sc.width = sc.height = 512;
      const sx = sc.getContext('2d');
      const ring = sx.createRadialGradient(256, 256, 0, 256, 256, 256);
      ring.addColorStop(0, 'rgba(0,0,0,1)');
      ring.addColorStop(Math.max(0, frac - 0.015), 'rgba(0,0,0,1)');
      ring.addColorStop(frac, 'rgba(255,199,89,1)');          // photon ring
      ring.addColorStop(Math.min(1, frac + 0.05), 'rgba(255,160,60,0.35)'); // warm halo
      ring.addColorStop(Math.min(1, frac + 0.22), 'rgba(255,120,30,0.06)');
      ring.addColorStop(1, 'rgba(0,0,0,0)');
      sx.fillStyle = ring; sx.fillRect(0, 0, 512, 512);
      const shadow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(sc), transparent: true,
        depthWrite: false, depthTest: false,
      }));
      shadow.scale.set(spriteHalf * 2, spriteHalf * 2, 1);
      shadow.renderOrder = 30;                        // over the discs, like the lens pass
      inner.add(shadow);

      // Click target: an invisible-in-practice black sphere inside the shadow.
      clickMesh = new THREE.Mesh(
        new THREE.SphereGeometry(shadowR, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0x000000 }));
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
    group.rotation.x = 0.6;                     // tip the plane toward the camera
    group.position.set(b.x, 0, 0);
    clickMesh.userData.bodyIndex = this.bodies.indexOf(b);

    b.group = group; b.mesh = clickMesh;
    this._spins.push({ obj: inner, rate: 0.0006 });
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
      const dist = b.span * 2.3;
      const target = new THREE.Vector3(b.x, 0, 0);
      const pos = target.clone().add(new THREE.Vector3(0, dist * 0.18, dist));
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
    for (const s of this._spins) s.obj.rotation.y += s.rate * dScale;

    // Sgr A*'s accretion discs flow at the sim's rate (world.js: deltaMs × 0.0005).
    for (const m of this._bhMats) m.uniforms.uTime.value += dScale * (1000 / 60) * 0.0005;

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
