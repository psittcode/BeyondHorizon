// Map-scale readout — a paper-map-style "1 : N" ratio of on-screen size to
// real-world size. N is how many real-world centimetres one on-screen centimetre
// spans, given a perspective camera focused `focusDist` world-units away and a
// per-view conversion of `kmPerUnit` (how many real km one world unit represents).
//
// Derivation (vertical axis):
//   visibleWorldHeight = 2 · focusDist · tan(fov/2)   // world units across the viewport height
//   worldPerCssPx      = visibleWorldHeight / innerHeight
//   worldPerScreenCm   = worldPerCssPx · CSS_PX_PER_CM
//   kmPerScreenCm      = worldPerScreenCm · kmPerUnit
//   N                  = kmPerScreenCm · CM_PER_KM     // 1 screen-cm : N real-cm
//
// Because it depends on focusDist, the ratio updates as you dolly in/out. The
// only display assumption is the CSS reference pixel (96px = 1in); a monitor's
// true physical pixel size varies, so the figure is a close approximation.

export const AU_KM = 149597870.7;   // 1 astronomical unit, in km
export const LY_KM = 9.4607e12;     // 1 light-year, in km
const CSS_PX_PER_CM = 96 / 2.54;    // CSS reference pixel: 96px = 1 inch = 2.54 cm
const CM_PER_KM = 1e5;

// Returns N for the ratio "1 : N" (real cm per on-screen cm), or NaN if inputs
// aren't usable yet (e.g. a view whose galaxy model hasn't finished loading).
export function scaleRatioN(camera, focusDist, kmPerUnit) {
  if (!camera || !(focusDist > 0) || !(kmPerUnit > 0)) return NaN;
  const vFov = camera.fov * Math.PI / 180;
  const worldPerPx = (2 * focusDist * Math.tan(vFov / 2)) / window.innerHeight;
  const worldPerCm = worldPerPx * CSS_PX_PER_CM;
  return worldPerCm * kmPerUnit * CM_PER_KM;
}

const SUP = { '-':'⁻','0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹' };
const toSuper = n => String(n).split('').map(c => SUP[c] || c).join('');

// "1 : 3.24 × 10¹³" (plain "1 : 1,234" for small ratios).
export function formatRatio(N) {
  if (!isFinite(N) || N <= 0) return '1 : —';
  if (N < 1000) return '1 : ' + Math.round(N).toLocaleString();
  const exp = Math.floor(Math.log10(N));
  const mant = N / Math.pow(10, exp);
  return `1 : ${mant.toFixed(2)} × 10${toSuper(exp)}`;
}

// Round to a readable figure: thousands get grouped separators, smaller values
// keep ~3 significant figures — never forced into exponential notation.
function human(x) {
  if (x >= 1000) return Math.round(x).toLocaleString();
  if (x >= 1)    return parseFloat(x.toPrecision(3)).toString();
  return parseFloat(x.toPrecision(2)).toString();
}

// Human-readable "what one on-screen cm spans in the real world", from N.
export function realPerCm(N) {
  if (!isFinite(N) || N <= 0) return '—';
  const km = N / CM_PER_KM;
  if (km >= 0.1 * LY_KM)  return human(km / LY_KM) + ' ly';
  if (km >= 0.01 * AU_KM) return human(km / AU_KM) + ' AU';
  if (km >= 1e6)          return human(km / 1e6) + ' million km';
  if (km >= 1)            return Math.round(km).toLocaleString() + ' km';
  if (km >= 1e-5)         return Math.round(km * 1e5).toLocaleString() + ' cm';
  return km.toExponential(2) + ' km';
}
