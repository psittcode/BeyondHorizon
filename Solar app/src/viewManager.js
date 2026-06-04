// View manager — the "hallway" between rooms.
//
// Each room is registered with a lazy factory: () => import('./rooms/x.js').
// The room's CODE is fetched only on the first enter(); the room then lazy-loads
// its own assets in init(). This is route-based code splitting: you never pay
// for a room you haven't walked into.
//
// Room contract (default export):
//   async init(ctx)  — build scene/camera/controls, load assets. Runs once.
//   enter(ctx)       — show UI, reset camera. Runs every entry.
//   update(ctx)      — per-frame; renders itself. Called by the main loop while active.
//   exit(ctx)        — hide UI / release input.
//   dispose(ctx)     — (optional) free GPU resources.
//
// During the migration the legacy animate() loop calls `viewManager.active.update(ctx)`
// when a room is active and otherwise runs its own (legacy) view code.

import { ctx } from './core/engine.js';

const factories = {};   // name -> () => import(...)
let _active = null;     // the active room object, or null (= legacy is driving)
let _activeName = null;

export function register(name, factory) { factories[name] = factory; }

export async function enter(name) {
  const factory = factories[name];
  if (!factory) { console.warn('viewManager: no room registered for', name); return; }
  const mod = await factory();
  const room = mod.default;
  if (!room.__inited) { await room.init(ctx); room.__inited = true; }
  if (_active && _active !== room && _active.exit) _active.exit(ctx);
  _active = room;
  _activeName = name;
  if (room.enter) room.enter(ctx);
}

// Leave the current room and hand control back to the legacy views.
export function exitActive() {
  if (_active && _active.exit) _active.exit(ctx);
  _active = null;
  _activeName = null;
}

export const viewManager = {
  register,
  enter,
  exitActive,
  get active() { return _active; },
  get activeName() { return _activeName; },
};
