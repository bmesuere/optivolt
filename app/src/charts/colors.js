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

const BUY_PRICE_COLOR_NEUTRAL_RGB = [226, 232, 240];
const BUY_PRICE_COLOR_STOPS = [
  { value: -10, rgb: [37, 99, 235] },
  { value: -1,  rgb: [96, 165, 250] },
  { value: 0,   rgb: BUY_PRICE_COLOR_NEUTRAL_RGB }, // zero / neutral
  { value: 1,   rgb: [254, 243, 199] },
  { value: 12,  rgb: [251, 191, 36] },
  { value: 24,  rgb: [249, 115, 22] },
  { value: 35,  rgb: [220, 38, 38] },
];

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

export function getBuyPriceColor(price_cents_per_kWh) {
  const price = Number(price_cents_per_kWh);
  if (!Number.isFinite(price)) return rgbString(BUY_PRICE_COLOR_NEUTRAL_RGB);

  const first = BUY_PRICE_COLOR_STOPS[0];
  const last = BUY_PRICE_COLOR_STOPS[BUY_PRICE_COLOR_STOPS.length - 1];
  if (price <= first.value) return rgbString(first.rgb);
  if (price >= last.value) return rgbString(last.rgb);

  for (let i = 1; i < BUY_PRICE_COLOR_STOPS.length; i++) {
    const lower = BUY_PRICE_COLOR_STOPS[i - 1];
    const upper = BUY_PRICE_COLOR_STOPS[i];
    if (price <= upper.value) {
      const t = (price - lower.value) / (upper.value - lower.value);
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
