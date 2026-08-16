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

// Buy-price bands: one hue per band, ramping light → deep within the band.
// The lightness reset at each boundary makes the 15/20/25/30c thresholds
// read as hard seams while within-band differences stay visible.
const BUY_PRICE_BANDS = [
  { min: 0,  max: 15, from: [220, 252, 231], to: [22, 163, 74] },   // green: cheap
  { min: 15, max: 20, from: [254, 249, 195], to: [234, 179, 8] },   // yellow
  { min: 20, max: 25, from: [254, 215, 170], to: [234, 88, 12] },   // orange
  { min: 25, max: 30, from: [254, 202, 202], to: [220, 38, 38] },   // red
  { min: 30, max: 40, from: [185, 28, 28],  to: [127, 29, 29] },    // dark red
];

// Overrides for the exceptional low-price regimes. Buy and sell derive from
// the same raw price, so these zones sit below the banded scale and never
// interleave with it.
const PAID_TO_CONSUME_BAND = { span: 10, from: [191, 219, 254], to: [29, 78, 216] };  // blue, buy < 0
const NEGATIVE_SELL_BAND = { span: 10, from: [221, 214, 254], to: [124, 58, 237] };   // violet, sell < 0

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

function bandColor(band, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return rgbString(interpolateOklab(band.from, band.to, clamped));
}

export function getPriceStripColor(buyPrice_cents_per_kWh, sellPrice_cents_per_kWh = 0) {
  const buy = Number(buyPrice_cents_per_kWh);
  if (buyPrice_cents_per_kWh == null || !Number.isFinite(buy)) {
    return rgbString(PRICE_STRIP_NEUTRAL_RGB);
  }

  if (buy < 0) return bandColor(PAID_TO_CONSUME_BAND, -buy / PAID_TO_CONSUME_BAND.span);

  const sell = Number(sellPrice_cents_per_kWh);
  if (Number.isFinite(sell) && sell < 0) {
    return bandColor(NEGATIVE_SELL_BAND, -sell / NEGATIVE_SELL_BAND.span);
  }

  for (const band of BUY_PRICE_BANDS) {
    if (buy < band.max) return bandColor(band, (buy - band.min) / (band.max - band.min));
  }

  const last = BUY_PRICE_BANDS[BUY_PRICE_BANDS.length - 1];
  return rgbString(last.to);
}

export const toRGBA = (rgb, alpha = 1) => {
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgb);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : rgb;
};

export const dim = (rgb) => toRGBA(rgb, 0.6);
