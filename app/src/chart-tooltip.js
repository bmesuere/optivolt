/**
 * Shared tooltip system for all OptiVolt charts.
 *
 * Provides:
 *  - injectTooltipStyles()       — injects shared .ov-tt-* CSS once
 *  - createTooltipHandler()      — generic Chart.js external tooltip factory
 *  - HTML helpers                — ttHeader, ttRow, ttSection, ttDivider, ttBadge, ttPrices
 *  - fmtKwh()                    — smart kWh value formatter
 *  - getChartAnimations()        — per-chart-type animation config
 */

// ---------------------------------------------------------------------------
// CSS injection
// ---------------------------------------------------------------------------

export function injectTooltipStyles() {
  if (document.getElementById("ov-tt-style")) return;
  const s = document.createElement("style");
  s.id = "ov-tt-style";
  s.textContent = `
    .ov-tt {
      position:absolute; pointer-events:none; z-index:10;
      border-radius:8px; padding:10px 12px; font-size:12px;
      font-family:system-ui,sans-serif; min-width:160px;
      box-shadow:0 4px 20px rgba(0,0,0,0.18);
      transition:opacity .1s ease;
      background:#fff; border:1px solid #e2e8f0; color:#1e293b;
    }
    .dark .ov-tt {
      background:#1e293b; border-color:rgba(255,255,255,0.10); color:#e2e8f0;
      box-shadow:0 4px 20px rgba(0,0,0,0.35);
    }
    .ov-tt-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:7px; }
    .ov-tt-time { font-weight:700; font-size:13px; color:#64748b; letter-spacing:.03em; }
    .dark .ov-tt-time { color:#94a3b8; }
    .ov-tt-meta { font-size:11px; color:#64748b; }
    .dark .ov-tt-meta { color:#94a3b8; }
    .ov-tt-meta strong { color:#3b82f6; }
    .dark .ov-tt-meta strong { color:#93c5fd; }
    .ov-tt-sec { font-size:10px; text-transform:uppercase; letter-spacing:.08em;
                 font-weight:600; margin:4px 0 2px; color:#94a3b8; }
    .dark .ov-tt-sec { color:#64748b; }
    .ov-tt-row { display:flex; justify-content:space-between; align-items:center;
                 gap:10px; padding:1.5px 0; }
    .ov-tt-lbl { display:flex; align-items:center; gap:5px; color:#475569; }
    .dark .ov-tt-lbl { color:#cbd5e1; }
    .ov-tt-dot { width:8px; height:8px; border-radius:2px; flex-shrink:0; }
    .ov-tt-val { font-variant-numeric:tabular-nums; font-weight:500; color:#0f172a; white-space:nowrap; }
    .dark .ov-tt-val { color:#f1f5f9; }
    .ov-tt-div { border-top:1px solid #e2e8f0; margin:5px 0; }
    .dark .ov-tt-div { border-color:rgba(255,255,255,0.08); }
    .ov-tt-prices { display:flex; justify-content:space-between; align-items:center;
                    font-size:11px; color:#64748b; padding:1px 0; }
    .dark .ov-tt-prices { color:#94a3b8; }
    .ov-tt-badge { display:inline-block; padding:1px 5px; border-radius:4px;
                   font-size:10px; font-weight:600; letter-spacing:.04em; margin-left:3px; }
    .ov-tt-buy  { background:rgba(239,68,68,0.15); color:#dc2626; }
    .ov-tt-sell { background:rgba(34,197,94,0.15); color:#16a34a; }
    .dark .ov-tt-buy  { background:rgba(239,68,68,0.2); color:#fca5a5; }
    .dark .ov-tt-sell { background:rgba(34,197,94,0.2); color:#86efac; }
  `;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function ttHeader(time, metaHtml = "") {
  return `<div class="ov-tt-head">
    <span class="ov-tt-time">${time}</span>
    ${metaHtml ? `<span class="ov-tt-meta">${metaHtml}</span>` : ""}
  </div>`;
}

export function ttRow(color, label, value) {
  return `<div class="ov-tt-row">
    <span class="ov-tt-lbl"><span class="ov-tt-dot" style="background:${color}"></span>${label}</span>
    <span class="ov-tt-val">${value}</span>
  </div>`;
}

export function ttSection(label) {
  return `<div class="ov-tt-sec">${label}</div>`;
}

export function ttDivider() {
  return `<div class="ov-tt-div"></div>`;
}

/** Renders a buy/sell price footer row. Pass only buyVal to show a single "Buy price" badge. */
export function ttPrices(buyVal, sellVal = null) {
  const label = sellVal != null ? "Buy / Sell" : "Buy price";
  const badges = sellVal != null
    ? `<span class="ov-tt-badge ov-tt-buy">${buyVal}</span><span class="ov-tt-badge ov-tt-sell">${sellVal}</span>`
    : `<span class="ov-tt-badge ov-tt-buy">${buyVal}</span>`;
  return `<div class="ov-tt-prices"><span>${label}</span><span>${badges}</span></div>`;
}

// ---------------------------------------------------------------------------
// Tooltip factory
// ---------------------------------------------------------------------------

/**
 * Creates a Chart.js external tooltip handler.
 *
 * @param {object} opts
 * @param {function(number, object): string} opts.renderContent
 *   Called with (dataIndex, tooltip) — returns HTML string for the tooltip body.
 */
export function createTooltipHandler({ renderContent }) {
  injectTooltipStyles();
  let el = null;
  let lastIdx = null;

  return function({ chart, tooltip }) {
    if (!el) {
      const parent = chart.canvas.parentNode;
      el = parent.querySelector(".ov-tt") ?? document.createElement("div");
      if (!el.parentNode) {
        el.className = "ov-tt";
        parent.style.position = "relative";
        parent.appendChild(el);
      }
    }

    if (tooltip.opacity === 0) { el.style.opacity = "0"; lastIdx = null; return; }

    const idx = tooltip.dataPoints?.[0]?.dataIndex;
    if (idx == null) return;

    if (idx !== lastIdx) {
      el.innerHTML = renderContent(idx, tooltip);
      lastIdx = idx;
    }
    el.style.opacity = "1";

    // Position beside caret; flip left if it would overflow the canvas
    const ttW = el.offsetWidth || 200;
    const ttH = el.offsetHeight || 120;
    const cW  = chart.canvas.offsetWidth;
    let x = tooltip.caretX + 12;
    if (x + ttW > cW - 8) x = tooltip.caretX - ttW - 12;
    let y = tooltip.caretY - ttH / 2;
    if (y < 0) y = 0;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function fmtKwh(v) {
  if (v >= 10) return v.toFixed(1);
  if (v >= 1)  return v.toFixed(2);
  return v.toFixed(3);
}

// ---------------------------------------------------------------------------
// Animation configs
// ---------------------------------------------------------------------------

export function getChartAnimations(type, numSlots = 1) {
  // Total stagger window is 500ms; per-slot delay is derived from slot count
  // so the animation always completes in ~500ms regardless of dataset size.
  const totalStagger = 500;
  const duration = type === 'bar' ? 600 : 500;
  const perSlot = numSlots > 1 ? totalStagger / (numSlots - 1) : 0;
  return {
    animation: {
      duration,
      easing: 'easeOutQuart',
      delay: (ctx) => ctx.type === 'data' && ctx.mode === 'default'
        ? ctx.dataIndex * perSlot : 0,
    },
  };
}
