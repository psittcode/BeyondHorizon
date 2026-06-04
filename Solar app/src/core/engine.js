// Shared engine context.
//
// One renderer, one camera, one OrbitControls instance — the handles every
// "room" (view) draws with. During the migration these are populated by
// legacy.js as it boots; as views are lifted into rooms/ they read them from
// here instead of relying on module-scoped globals.
//
// It's a single mutable object so importers always see the live values.
export const ctx = {};
