# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

Open `Solar app/index.html` via a local HTTP server — **not** directly from the filesystem. The app is an ES-module project (`<script type="module">`), and modules + Three.js textures load via XHR, which fails under `file://` due to browser CORS restrictions.

```bash
# From the project root
python3 -m http.server 8000
# Then open http://localhost:8000/Solar%20app/index.html
```

No build step, no package manager, no dependencies to install. Three.js r128, OrbitControls, GLTFLoader, and the post-processing/bloom passes are loaded from CDN; the app's own code is plain ES modules under `src/`.

## File Layout

All code lives in `Solar app/`. The **current / live app** is `index.html` plus the ES-module tree under `src/`. The `solar_iteration_*` HTML files are **historical snapshots** kept for reference — they are self-contained single-file builds and are *not* under active development.

**Live app:**

| Path | What's in it |
|------|-------------|
| `index.html` | **Current / live app.** Holds all markup (main menu, panels, UI shells) + inline CDN `<script>` tags, then loads `./src/main.js` as a module. Add new UI/markup here. |
| `css/styles.css` | All styles (extracted from the old inline `<style>`) |
| `src/main.js` | Module entry point — just imports `world.js` |
| `src/world.js` | **The core app** (~3.8k lines): scene construction, the three view modes, animation loop, interaction, speed/time controls, and UI wiring |
| `src/core/engine.js` | Shared mutable `ctx` (one renderer / camera / OrbitControls) read by every room |
| `src/core/assets.js` | Cached texture/GLB loaders (`loadTexture`, `loadGLB`) so assets upload to the GPU once and are shared across rooms |
| `src/data/planets.js` | Pure content: the `data` array (name, dist, size, color, speed, info HTML per body) |
| `src/data/info.js` | Pure content: long-form info-panel HTML (Milky Way, Sun, Moon, Kepler-22b, terraformed Mars, etc.) |
| `src/viewManager.js` | The "hallway" — registers rooms with lazy `() => import()` factories; `enter()`/`exit()`/per-frame `update()` |
| `src/rooms/kepler.js` | Lazy room: the Kepler-22 system (standalone scene) |
| `src/rooms/andromeda.js` | Lazy room: the Andromeda Galaxy (standalone scene) |

**Historical snapshots (do not edit for new features):**

| File | What's in it |
|------|-------------|
| `solar_iteration_1_.html` | Basic version: procedural planet colors, no textures on most bodies, simple speed slider |
| `solar_iteration_2_.html` | Adds planet textures, orbit toggle, bodies list panel, speed label |
| `solar_iteration_3_.html` | The full single-file build *before* the module refactor — superseded by `index.html` + `src/` |

Texture images (`.jpg`/`.png`/`.glb`) sit in `Solar app/` and are loaded by relative path.

## Architecture (`index.html` + `src/`)

> **Where to add features:** new logic goes in `src/` — usually `src/world.js` for the core solar/galactic/spaceship views, a file under `src/rooms/` for a new standalone scene, or `src/data/` for new body/info content. New markup or UI shells go in `index.html`, styles in `css/styles.css`. **Do not touch the `solar_iteration_*` files** — they're frozen snapshots.

The app boots from `index.html` → `src/main.js` → `src/world.js`. `world.js` builds the shared 3D scene and the views that live in it (Solar System, schematic Galactic view, the Milky Way galaxy, and Spaceship Earth) plus all the UI wiring. Standalone-scene views (Andromeda, Kepler-22) are separate **lazy rooms** under `src/rooms/`, loaded on demand by `src/viewManager.js` via `() => import(...)` so their code and assets cost nothing until visited (Kepler is preloaded so its zoom-in entry stays instant). Body/info content lives in `src/data/`, the shared renderer/camera/controls in `src/core/engine.js`'s `ctx`, and cached asset loaders in `src/core/assets.js`. Three.js itself is the global from the CDN `<script>` tags, available before any module runs.

> Note: some in-code comments still say `legacy.js` — that's the former name of `world.js` (renamed in commit `883e88d`); they refer to the same core module.

The descriptions below still apply — they now live in `src/world.js` (and the data modules) rather than a single inline `<script>`.

**Scene construction (top of `world.js`)**
- `THREE.WebGLRenderer` → `THREE.PerspectiveCamera` → `OrbitControls`
- Camera `up` vector is tilted 23.4° to match Earth's equatorial frame
- Milky Way skybox: `SphereGeometry(500)` with `BackSide` rendering
- Sun: `MeshBasicMaterial` + separate transparent glow mesh
- Planet instances are built from the `data` array (each entry has `name`, `dist`, `size`, `color`, `speed`, `info` HTML string, `texture`)
- Moons created via `createMoon(size, distance, speed, color, infoText, texture, startAngle)` — returns a mesh parented to its planet's orbit pivot

**Three mutually exclusive view modes**
1. **Solar System** (default) — planets orbit the Sun; camera uses OrbitControls
2. **Galactic View** (`galacticViewActive = true`) — `galacticGroup` THREE.Group becomes visible; sun and earth markers orbit a galactic centre at 60.2° ecliptic tilt; independent log-scale speed slider
3. **Spaceship Earth** (`spaceshipViewActive = true`) — fixed camera locked to Earth; five velocity arrows shown; years counter

Switching views calls `enterGalacticView()` / `exitSpaceshipView()` etc. The two non-default views are independent and fully exited before entering the other.

**Animation loop**
`animate()` called via `requestAnimationFrame`. Each frame:
- Advances each planet's `orbitAngle` by `speed × elapsed × simulationMultiplier`
- Updates moon angles relative to their parent planet
- If galactic view: advances `galacticAngle`, updates sun/earth trail buffers
- If spaceship view: updates `seYearDisplay` from elapsed ms

**Interaction**
- `THREE.Raycaster` on canvas `click` — hits checked against `allClickable` (planets + sun) and `jupiterMoonMeshes`
- On hit: `flyToObject(obj)` animates camera to the target over ~60 frames using `requestAnimationFrame` recursion
- Info panel populated from `mesh.userData.info` (raw HTML string)

**Speed control**
Slider value is on a log₁₀ scale: `simulationMultiplier = Math.pow(10, sliderValue)`. Negative slider values produce sub-realtime; positive values produce super-realtime. `getSpeedLabel()` formats the display.

**Simulation time**
`simElapsedMs` accumulates each frame. `updateSimTimeDisplay()` converts to a calendar date starting from a configurable epoch.

## Git Workflow

Repository: `https://github.com/psittcode/ClaudeCodeTest` (branch `main`)

**Commit and push after every meaningful unit of work.** Do not batch changes across multiple features or fixes into one commit. The goal is that the GitHub history always reflects the current working state so any version can be recovered.

```bash
git add "Solar app/<changed-file>"
git commit -m "<concise description of what changed and why>"
git push origin main
```

Good commit message examples:
- `Add Saturn ring opacity control to UI panel`
- `Fix Jupiter moon orbit speed to match real ratios`
- `Increase skybox radius to eliminate clipping at galactic view zoom`

A Stop hook auto-saves any uncommitted changes with a timestamped message as a safety net, but every intentional change must get a proper descriptive commit — not just the auto-save fallback.
