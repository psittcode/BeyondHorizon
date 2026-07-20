// Cached asset loaders.
//
// A texture or model is fetched and uploaded to the GPU only once, then shared
// across rooms. This kills duplicate work like the galaxy GLB that the legacy
// code downloaded twice (Milky Way + Andromeda).
//
// THREE is the global from the CDN <script> tags (available before any module
// runs). loadGLB returns a Promise<GLTF>; clone gltf.scene per room as needed.

const texCache = new Map();
const glbCache = new Map();

export function loadTexture(url) {
  if (!texCache.has(url)) texCache.set(url, new THREE.TextureLoader().load(url));
  return texCache.get(url);
}

// One shared DRACOLoader (it spawns decoder workers — never one per model).
// Decoder wasm comes from the same three@0.128 CDN as the loader scripts.
// Needed for iss.glb: NASA's station model is Draco-compressed (13 MB vs 72 MB
// plain — the mesh's UV seams defeat decimation, so compression does the work).
let dracoLoader = null;
function getDraco() {
  if (!dracoLoader) {
    dracoLoader = new THREE.DRACOLoader();
    dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.128/examples/js/libs/draco/');
  }
  return dracoLoader;
}

export function loadGLB(url) {
  if (!glbCache.has(url)) {
    glbCache.set(url, new Promise((resolve, reject) => {
      const loader = new THREE.GLTFLoader();
      loader.setDRACOLoader(getDraco());
      loader.load(url, resolve, undefined, reject);
    }));
  }
  return glbCache.get(url);
}
