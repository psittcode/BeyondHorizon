// Modular entry point.
//
// world.js builds the shared 3D scene and the views that live in it (the Solar
// System, the schematic Galactic view, the Milky Way galaxy, and Spaceship
// Earth) plus the UI wiring. Standalone-scene views are separate lazy rooms
// under rooms/ (andromeda, kepler), loaded on demand by the viewManager.
// Content lives in data/, styles in css/.
import './world.js';
