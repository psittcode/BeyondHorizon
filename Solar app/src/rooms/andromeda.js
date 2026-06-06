// Room: The Andromeda Galaxy.
//
// A standalone scene — a custom procedural star field + the galaxy built the same
// way as the Milky Way (need_some_space.glb model, loaded from the shared cache,
// + a flat androgalaxy.png disc). Lazy-imported by the viewManager on first entry,
// so neither this code nor its assets cost anything until you visit.

import { loadGLB, loadTexture } from '../core/assets.js';
import { LY_KM } from '../core/scale.js';

const SKYBOX_RADIUS = 20000;

const ANDROMEDA_INFO = `<b>The Andromeda Galaxy — Our Magnificent, Doomed Neighbor</b><br><br>

On a clear, moonless night, far from city lights, there is something remarkable hidden in plain sight above us. At 2.5 million light-years away, the Andromeda Galaxy is the most distant object visible to the naked human eye — appearing as a soft, milky smudge in the constellation of Andromeda, roughly the angular size of six full Moons. For thousands of years, our ancestors looked at it without knowing what it was. Today, we know it is the largest galaxy in our cosmic neighborhood, a majestic island of a trillion suns — and it is heading straight for us.<br><br>

<b>History — Known Since Ancient Times</b><br>
The Andromeda Galaxy was first documented in 964 CE by Persian astronomer Abd al-Rahman al-Sufi in his <i>Book of the Fixed Stars</i>, where he described it as a "small cloud." It was rediscovered in 1612, shortly after the invention of the telescope, by German astronomer Simon Marius, who said it resembled the light of a candle seen through a horn. For centuries, astronomers debated whether it was a nebula within our own galaxy or something else entirely. It wasn't until the 1920s that Edwin Hubble, using Cepheid variable stars as distance markers, proved it was an entirely separate galaxy — a revelation that transformed humanity's understanding of the scale of the universe.<br><br>

<b>Size — A Galaxy That Dwarfs Our Own</b><br>
The Andromeda Galaxy is enormous by any measure. It has a diameter of approximately 220,000 light-years — more than double the size of our own Milky Way — and contains around one trillion stars. Our own Milky Way, by comparison, spans roughly 100,000 light-years and holds an estimated 200 to 400 billion stars. Its total mass is estimated at around 1.5 trillion solar masses. In 2015, the Hubble Space Telescope captured the largest image ever taken of Andromeda — a 1.5 billion pixel mosaic. It took over 600 overlapping snapshots and more than 10 years to assemble, capturing the glow of over 200 million individual stars — still only a fraction of Andromeda's total population.<br><br>

<b>Structure — Spiral Arms and a Dual Heart</b><br>
Like the Milky Way, Andromeda is a spiral galaxy, its vast arms of stars and dust curling outward from a bright central bulge. But one of its most intriguing structural features is its center. The Andromeda Galaxy may not have just one nucleus but two — a two-nucleus theory based on a Hubble study that spotted what appeared to be two distinct bright regions at the galaxy's core. At the very heart of this double nucleus sits a supermassive black hole. Andromeda's central black hole has a mass more than 100 million times that of our Sun — roughly 25 times more massive than the Milky Way's own central black hole, Sagittarius A*. Despite this enormous mass, Andromeda's black hole is among the least active known supermassive black holes in any galaxy center, emitting very little radiation.<br><br>

Over its lifetime, Andromeda has also absorbed numerous smaller galaxies, and it features two prominent companion dwarf galaxies — M32 and M110 — which orbit around it as satellites. The gravitational signatures of these past galactic mergers are written into the star distribution of Andromeda's halo and disk, like geological layers recording ancient events.<br><br>

<b>The Inevitable Collision — Milkomeda</b><br>
Here is the most dramatic fact about Andromeda: it is falling toward us right now. NASA astronomers, using painstaking Hubble Space Telescope measurements, have confirmed with certainty that the Andromeda Galaxy is approaching the Milky Way under the mutual pull of gravity, and the two galaxies will crash together in a head-on collision approximately 4 billion years from now. Andromeda is currently closing the distance between us at roughly 110 kilometers per second. Though the collision is billions of years away, on cosmic timescales it is practically tomorrow.<br><br>

The thin disk shapes of both spiral galaxies will be strongly distorted and irrevocably transformed by the encounter. Around 6 billion years from now, the two galaxies will fully merge to form a single, enormous elliptical galaxy. Scientists and the public have nicknamed this future merged galaxy "Milkomeda." A smaller galaxy, Triangulum, may also be part of the smashup, though some computer models show it continuing to orbit the merged pair rather than being consumed.<br><br>

What will the collision actually look like up close? About 3.75 billion years from now, Andromeda's disk will fill the night sky, and its gravity will begin creating tidal distortions in the Milky Way. During the first close approach, the sky will be ablaze with new star formation, evident in a plethora of emission nebulae and open young star clusters. Crucially, despite the catastrophic scale of this event, individual stars are so widely spaced that actual stellar collisions will be exceedingly rare. Earth and our solar system are in no danger of being destroyed — though our night sky will be permanently and magnificently transformed. Scientists calculate a 50% chance that in the merged galaxy, our solar system will be swept out three times farther from the galactic core than it currently sits.<br><br>

<b>Planets in Andromeda — The Frontier of Detection</b><br>
With a trillion stars, the statistical likelihood that Andromeda hosts billions of planets is essentially certain. But actually detecting them is an almost unimaginably difficult challenge. At 2.5 million light-years away, conventional methods like transit photometry — which detect tiny dips in starlight as a planet passes in front of its star — cannot work, as the distances make individual stars impossible to resolve with current instruments.<br><br>

However, one tantalizing candidate has emerged. In 1999, astronomers using the 2.5-meter Isaac Newton Telescope detected a peculiar gravitational microlensing event in the direction of the Andromeda Galaxy, catalogued as PA-99-N2. A microlensing event occurs when a foreground star's gravity bends and briefly amplifies the light of a background star — and if a planet orbits the foreground star, it leaves an additional anomalous signature in the light curve. The light curve of PA-99-N2 showed small but statistically significant deviations from the expected single-lens model, interpreted as evidence of a binary lens system involving a low-mass companion — possibly a planet or brown dwarf. Modeling of the event places this possible planet's mass at approximately 6.34 Jupiter masses, orbiting a star of roughly half the mass of our Sun, located inside Andromeda's disk.<br><br>

If confirmed, PA-99-N2 b would be the first exoplanet ever discovered in another galaxy. However, microlensing events are random and never repeat, so the discovery cannot be verified the way repeating transits can — meaning its status remains an intriguing but unconfirmed candidate. Researchers have noted that future extremely large telescopes and next-generation X-ray observatories may eventually develop the capability to search for extragalactic planets more systematically.<br><br>

<b>Why Andromeda Matters</b><br>
Andromeda isn't just a beautiful object in the sky — it is our best laboratory for understanding how large spiral galaxies form, evolve, and eventually merge. Because it is close enough for Hubble to resolve individual stars, studying Andromeda allows astronomers to piece together the galaxy's past history of mergers with smaller satellite galaxies, offering a window into the processes that shaped all galaxies — including our own. In many ways, looking at Andromeda is like looking at a mirror: a massive barred spiral, roughly similar age to ours, surrounded by satellite galaxies, anchored by a supermassive black hole. The key difference is that Andromeda's story, and ours, are not separate tales — in the cosmic long run, they are the same story, building toward one inevitable, spectacular finale billions of years from now.<br><br>

<span style="font-size:10px;opacity:0.6;">Sources: NASA Science – Messier 31 / Hubble Andromeda Panorama; NASA Science – Milky Way is Destined for Head-on Collision with Andromeda; NASA Science – Crash of the Titans: Milky Way and Andromeda Collision; NASA Science – First Evidence of a Planet Beyond Our Galaxy; Astronomy.com – The Andromeda and Milky Way Collision, Explained; Wikipedia – Andromeda Galaxy; Wikipedia – PA-99-N2; Britannica – Andromeda Galaxy; EarthSky – The Andromeda Galaxy: All You Need to Know; Spitzer Science Center / Caltech – Observers Measure How Andromeda's Central Black Hole is Fed</span>`;

// Custom, resolution-independent star field: thousands of additive soft-sprite
// star points (varied colour/size) over a deep-space background, plus faint
// coloured nebula clouds for depth.
function buildStarfield() {
  const group = new THREE.Group();
  const R = SKYBOX_RADIUS * 0.9;

  const sc = document.createElement('canvas'); sc.width = sc.height = 64;
  const sx = sc.getContext('2d');
  const sg = sx.createRadialGradient(32, 32, 0, 32, 32, 32);
  sg.addColorStop(0.00, 'rgba(255,255,255,1)');
  sg.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  sg.addColorStop(0.55, 'rgba(255,255,255,0.25)');
  sg.addColorStop(1.00, 'rgba(255,255,255,0)');
  sx.fillStyle = sg; sx.fillRect(0, 0, 64, 64);
  const starTex = new THREE.CanvasTexture(sc);

  const COUNT = 16000;
  const pos = new Float32Array(COUNT * 3);
  const col = new Float32Array(COUNT * 3);
  const siz = new Float32Array(COUNT);
  const palette = [
    [1.00, 1.00, 1.00], [1.00, 1.00, 1.00], [1.00, 1.00, 1.00], [0.96, 0.98, 1.00],
    [0.74, 0.83, 1.00], [0.60, 0.72, 1.00],
    [1.00, 0.96, 0.82], [1.00, 0.86, 0.62], [1.00, 0.72, 0.62],
  ];
  for (let i = 0; i < COUNT; i++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const rr = R * (0.95 + Math.random() * 0.1);
    pos[i*3]     = s * Math.cos(th) * rr;
    pos[i*3 + 1] = u * rr;
    pos[i*3 + 2] = s * Math.sin(th) * rr;
    const c = palette[(Math.random() * palette.length) | 0];
    const b = 0.55 + Math.random() * 0.45;
    col[i*3] = c[0]*b; col[i*3+1] = c[1]*b; col[i*3+2] = c[2]*b;
    const r = Math.random();
    siz[i] = r < 0.87 ? (0.4 + Math.random()*0.7)
           : r < 0.98 ? (1.0 + Math.random()*1.0)
                       : (2.2 + Math.random()*1.8);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(siz, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: starTex }, uPix: { value: Math.min(window.devicePixelRatio || 1, 2) } },
    vertexShader: `
      attribute float size; attribute vec3 color; varying vec3 vColor; uniform float uPix;
      void main(){ vColor = color; gl_PointSize = size * uPix;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D uTex; varying vec3 vColor;
      void main(){ vec4 t = texture2D(uTex, gl_PointCoord); if (t.a < 0.01) discard;
        gl_FragColor = vec4(vColor * t.rgb, t.a); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
  });
  const stars = new THREE.Points(geo, mat);
  stars.frustumCulled = false;
  stars.renderOrder = -2;
  group.add(stars);

  const nebColors = ['80,120,255', '150,90,230', '60,180,200', '220,90,180', '90,140,255', '120,80,210'];
  for (let n = 0; n < 8; n++) {
    const nc = document.createElement('canvas'); nc.width = nc.height = 256;
    const nx = nc.getContext('2d');
    const cc = nebColors[n % nebColors.length];
    const ng = nx.createRadialGradient(128, 128, 0, 128, 128, 128);
    ng.addColorStop(0.0, 'rgba(' + cc + ',0.55)');
    ng.addColorStop(0.4, 'rgba(' + cc + ',0.18)');
    ng.addColorStop(1.0, 'rgba(' + cc + ',0)');
    nx.fillStyle = ng; nx.fillRect(0, 0, 256, 256);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(nc), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      opacity: 0.10 + Math.random() * 0.12
    }));
    const u = Math.random() * 2 - 1; const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    sp.position.set(s * Math.cos(th) * R * 0.95, u * R * 0.55, s * Math.sin(th) * R * 0.95);
    const sz = R * (0.5 + Math.random() * 0.9);
    sp.scale.set(sz, sz, 1);
    sp.renderOrder = -3;
    group.add(sp);
  }
  return group;
}

const room = {
  scene: null,
  camera: null,
  controls: null,
  galaxyPivot: null,
  starfield: null,
  radius: 3780,
  kmPerUnit: 0,   // map-scale anchor; set in init() once the galaxy radius is measured
  _lastT: 0,

  // Frame the galaxy in a 3/4 view from above.
  frameCamera() {
    const R = this.radius;
    this.camera.position.set(0, R * 0.9, R * 2.2);
    this.camera.up.set(0, 1, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  },

  async init(ctx) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x01010a); // deep-space near-black

    this.starfield = buildStarfield();
    scene.add(this.starfield);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, SKYBOX_RADIUS * 2);
    this.controls = new THREE.OrbitControls(this.camera, ctx.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 0.5;   // gentler zoom, matching the main view
    this.controls.minDistance   = 1;
    this.controls.maxDistance   = SKYBOX_RADIUS * 0.9;
    this.controls.target.set(0, 0, 0);
    this.scene = scene;
    this.frameCamera();

    // Galaxy: shared (cached) GLB model — cloned so it doesn't conflict with the
    // Milky Way's instance — plus the flat androgalaxy.png disc.
    const ANDRO_SCALE = 1500;
    this.galaxyPivot = new THREE.Group();
    scene.add(this.galaxyPivot);

    const gltf = await loadGLB('need_some_space.glb');
    const model = gltf.scene.clone();
    model.scale.set(ANDRO_SCALE, ANDRO_SCALE, ANDRO_SCALE);
    model.rotation.set(0, 0, 0);
    model.renderOrder = 1;
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const size = box.getSize(new THREE.Vector3());
    this.radius = Math.max(size.x, size.z) / 2;
    // Andromeda is ~220,000 ly across, so its visual radius represents 110,000 ly.
    this.kmPerUnit = (110000 / this.radius) * LY_KM;
    this.galaxyPivot.add(model);

    const aTex = loadTexture('androgalaxy.png');
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(this.radius, 128),
      new THREE.MeshBasicMaterial({
        map: aTex, transparent: true, alphaTest: 0, blending: THREE.AdditiveBlending,
        color: 0xffffff, depthWrite: false, depthTest: false, side: THREE.DoubleSide
      })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = 0;
    this.galaxyPivot.add(disc);

    this.controls.maxDistance = Math.min(SKYBOX_RADIUS * 0.9, this.radius * 6);
    this.frameCamera();
  },

  enter(ctx) {
    ctx.controls.enabled = false; // stop the main OrbitControls consuming input
    document.getElementById('andromedaBtn').style.display = 'none';
    document.getElementById('panel').style.display = 'block';
    document.getElementById('panelContent').innerHTML = ANDROMEDA_INFO;
    document.getElementById('backToList').style.display = 'none';
    this._lastT = performance.now();
    this.frameCamera();
  },

  update(ctx) {
    const now = performance.now();
    const dScale = Math.min(now - this._lastT, 100) / (1000 / 60);
    this._lastT = now;
    // Same spin rate as the Milky Way — static at 1× speed, faster as the slider rises.
    if (this.galaxyPivot) this.galaxyPivot.rotation.y += 0.000000395 * ctx.speed * dScale;
    if (this.starfield) this.starfield.position.copy(this.camera.position); // sky follows camera
    this.controls.update();
    ctx.renderer.render(this.scene, this.camera);
  },

  exit(ctx) {
    ctx.controls.enabled = true;
    document.getElementById('andromedaBtn').style.display = 'block';
  },

  // Free the uniquely-owned heavy GPU resources (the 16k-point star field +
  // its canvas textures). The GLB clone shares geometry/materials with the
  // cached asset and the disc texture is cached, so those are left alone.
  // Not auto-invoked yet — wired up in the Phase 5 memory pass.
  dispose() {
    if (this.starfield) {
      this.starfield.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (m) {
          if (m.map && m.map.dispose) m.map.dispose();
          if (m.uniforms && m.uniforms.uTex && m.uniforms.uTex.value) m.uniforms.uTex.value.dispose();
          m.dispose();
        }
      });
    }
  },
};

export default room;
