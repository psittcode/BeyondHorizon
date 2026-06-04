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

export function loadGLB(url) {
  if (!glbCache.has(url)) {
    glbCache.set(url, new Promise((resolve, reject) =>
      new THREE.GLTFLoader().load(url, resolve, undefined, reject)));
  }
  return glbCache.get(url);
}
