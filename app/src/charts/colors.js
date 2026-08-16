export const SOLUTION_COLORS = {
  b2g: "rgb(15, 192, 216)",   // Battery to Grid (teal-ish)
  pv2g: "rgb(247, 171, 62)",  // Solar to Grid (amber)
  pv2b: "rgb(139, 201, 100)", // Solar to Battery (green)
  pv2l: "rgb(212, 222, 95)",  // Solar to Consumption (yellow-green)
  b2l: "rgb(71, 144, 208)",   // Battery to Consumption (blue)
  g2l: "rgb(233, 122, 131)",  // Grid to Consumption (red)
  g2b: "rgb(225, 142, 233)",  // Grid to Battery (purple)
  soc: "rgb(71, 144, 208)",   // SoC line color = battery-ish blue
  g2ev: "rgb(185, 38, 55)",   // Grid to EV (dark red - variant of g2l)
  pv2ev: "rgb(142, 158, 22)", // Solar to EV (dark yellow-green - variant of pv2l)
  b2ev: "rgb(20, 78, 160)",   // Battery to EV (dark blue - variant of b2l)
  ev_charge: "rgb(16, 185, 129)", // EV total (emerald - distinct EV colour)
};

const PRICE_STRIP_NEUTRAL_RGB = [226, 232, 240];

// Continuous scale for positive buy prices. Hue anchors sit at band centers
// (green <15c, yellow 15-20c, orange 20-25c, red 25-30c, dark red 30c+) so
// each band reads as its own hue family while neighbouring prices stay
// near-identical: 9.9c vs 10.1c is negligible in practice and looks like it.
const BUY_PRICE_STOPS = [
  { value: 0,    rgb: [187, 247, 208] }, // pale green
  { value: 12.5, rgb: [34, 197, 94] },   // green
  { value: 17.5, rgb: [234, 179, 8] },   // yellow
  { value: 22.5, rgb: [249, 115, 22] },  // orange
  { value: 27.5, rgb: [220, 38, 38] },   // red
  { value: 40,   rgb: [127, 29, 29] },   // dark red
];

// The exceptional regimes get flat colors: crossing zero is the one place
// where a tiny price difference matters, so the color change is abrupt.
// Buy and sell derive from the same raw price, so these zones sit below the
// positive scale and never interleave with it.
const PAID_TO_CONSUME_RGB = [37, 99, 235]; // blue: buy < 0
const NEGATIVE_SELL_RGB = [124, 58, 237];  // violet: sell < 0, buy >= 0

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel) {
  const c = Math.max(0, Math.min(1, channel));
  const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * (c ** (1 / 2.4)) - 0.055;
  return Math.round(srgb * 255);
}

function rgbToOklab(rgb) {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return [
    0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot,
  ];
}

function oklabToRgb(oklab) {
  const lRoot = oklab[0] + 0.3963377774 * oklab[1] + 0.2158037573 * oklab[2];
  const mRoot = oklab[0] - 0.1055613458 * oklab[1] - 0.0638541728 * oklab[2];
  const sRoot = oklab[0] - 0.0894841775 * oklab[1] - 1.2914855480 * oklab[2];

  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;

  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

function interpolateOklab(from, to, t) {
  const fromLab = rgbToOklab(from);
  const toLab = rgbToOklab(to);
  return oklabToRgb(fromLab.map((channel, idx) => lerp(channel, toLab[idx], t)));
}

function rgbString(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function getPriceStripColor(buyPrice_cents_per_kWh, sellPrice_cents_per_kWh = 0) {
  const buy = Number(buyPrice_cents_per_kWh);
  if (buyPrice_cents_per_kWh == null || !Number.isFinite(buy)) {
    return rgbString(PRICE_STRIP_NEUTRAL_RGB);
  }

  if (buy < 0) return rgbString(PAID_TO_CONSUME_RGB);

  const sell = Number(sellPrice_cents_per_kWh);
  if (Number.isFinite(sell) && sell < 0) return rgbString(NEGATIVE_SELL_RGB);

  const last = BUY_PRICE_STOPS[BUY_PRICE_STOPS.length - 1];
  if (buy >= last.value) return rgbString(last.rgb);

  for (let i = 1; i < BUY_PRICE_STOPS.length; i++) {
    const lower = BUY_PRICE_STOPS[i - 1];
    const upper = BUY_PRICE_STOPS[i];
    if (buy <= upper.value) {
      const t = (buy - lower.value) / (upper.value - lower.value);
      return rgbString(interpolateOklab(lower.rgb, upper.rgb, t));
    }
  }

  return rgbString(last.rgb);
}

export const toRGBA = (rgb, alpha = 1) => {
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgb);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : rgb;
};

export const dim = (rgb) => toRGBA(rgb, 0.6);
