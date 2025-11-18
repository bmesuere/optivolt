import { SOLUTION_COLORS } from "./charts.js";

/**
 * Render the results table and unit label.
 * Pure function: no global DOM lookups; only uses args.
 *
 * @param {Object} opts
 * @param {Array<Object>} opts.rows               - parsed rows from parseSolution()
 * @param {Object}       opts.cfg                 - UI config (needs batteryCapacity_Wh, stepSize_m)
 * @param {number[]}     opts.timestampsMs        - canonical per-slot timestamps (ms)
 * @param {Object}       opts.targets
 * @param {HTMLElement}  opts.targets.table       - <table> element to write into
 * @param {HTMLElement}  [opts.targets.tableUnit] - element for the "Units: ..." label
 * @param {boolean}      opts.showKwh             - whether to display kWh instead of W
 */
export function renderTable({ rows, cfg, targets, showKwh }) {
  const { table, tableUnit } = targets || {};
  if (!table || !Array.isArray(rows) || rows.length === 0) return;

  // slot duration for W→kWh conversion
  const h = Math.max(0.000001, Number(cfg?.stepSize_m ?? 15) / 60); // hours per slot
  const W2kWh = (x) => (Number(x) || 0) * h / 1000;

  const fmtTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
  const fmtDate = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit" });

  const timesDisp = rows.map(row => {
    const dt = new Date(row.timestampMs);
    // If minutes and hours are 0, it's midnight -> show Date
    if (dt.getHours() === 0 && dt.getMinutes() === 0) {
      return fmtDate.format(dt);
    }
    return fmtTime.format(dt);
  });

  const cols = [
    { key: "time", headerHtml: "Time", fmt: (_, idx) => timesDisp[idx] },
    { key: "load", headerHtml: "Exp.<br>load", fmt: x => fmtEnergy(x, { dash: false }), tip: "Expected Load" },
    { key: "pv", headerHtml: "Exp.<br>PV", fmt: x => fmtEnergy(x, { dash: false }), tip: "Expected PV" },
    { key: "ic", headerHtml: "Import<br>cost", fmt: dec2Thin },
    { key: "ec", headerHtml: "Export<br>cost", fmt: dec2Thin },

    { key: "g2l", headerHtml: "g2l", fmt: x => fmtEnergy(x), tip: "Grid → Load" },
    { key: "b2l", headerHtml: "b2l", fmt: x => fmtEnergy(x), tip: "Battery → Load" },

    { key: "pv2l", headerHtml: "pv2l", fmt: x => fmtEnergy(x), tip: "Solar → Load" },
    { key: "pv2b", headerHtml: "pv2b", fmt: x => fmtEnergy(x), tip: "Solar → Battery" },
    { key: "pv2g", headerHtml: "pv2g", fmt: x => fmtEnergy(x), tip: "Solar → Grid" },

    { key: "g2b", headerHtml: "g2b", fmt: x => fmtEnergy(x), tip: "Grid → Battery" },
    { key: "b2g", headerHtml: "b2g", fmt: x => fmtEnergy(x), tip: "Battery → Grid" },

    { key: "imp", headerHtml: "Grid<br>import", fmt: x => fmtEnergy(x), tip: "Grid Import" },
    { key: "exp", headerHtml: "Grid<br>export", fmt: x => fmtEnergy(x), tip: "Grid Export" },

    {
      key: "dess_strategy",
      headerHtml: "DESS<br>strategy",
      fmt: (_, ri) => fmtDessStrategy(rows[ri]?.dess?.strategy),
      tip: '0=Target SOC, 1=Self-consumption, 2=Pro battery, 3=Pro grid; "?" = unknown',
    },
    {
      key: "dess_restrictions",
      headerHtml: "Restr.",
      fmt: (_, ri) => fmtDessRestrictions(rows[ri]?.dess?.restrictions),
      tip: '0=none, 1=grid→bat restricted, 2=bat→grid restricted, 3=both; "?" = unknown',
    },
    {
      key: "dess_feedin",
      headerHtml: "Feed-in",
      fmt: (_, ri) => {
        const d = rows[ri]?.dess;
        return fmtDessFeedin(d?.feedin);
      },
      tip: '1=allowed, 0=blocked; "?" = unknown',
    },
    {
      key: "dess_soc_target",
      headerHtml: "Soc→",
      fmt: (_, ri) => {
        const targetPct = rows[ri]?.dess?.socTarget_percent;
        return intThin(targetPct) + "%";
      },
      tip: "Target SoC at end of slot",
    },
  ];

  const thead = `
    <thead>
      <tr class="align-bottom">
        ${cols.map(c =>
    `<th class="px-2 py-1 border-b font-medium text-right align-bottom" ${c.tip ? `title="${escapeHtml(c.tip)}"` : ""}>${c.headerHtml}</th>`
  ).join("")}
      </tr>
    </thead>`;

  const tbody = `
    <tbody>
      ${rows.map((r, ri) => {
    const timeLabel = cols[0].fmt(null, ri); // "time" column
    const isMidnightRow = /^\d{2}\/\d{2}$/.test(timeLabel);

    const tds = cols.map(c => {
      const raw = c.key === "time" ? null : r[c.key];
      const displayVal = c.key === "time" ? timeLabel : c.fmt(raw, ri);
      const styleAttr = styleForCell(c.key, raw); // only applies to flow columns with > 0
      return `<td ${styleAttr} class="px-2 py-1 border-b text-right font-mono tabular-nums ${isMidnightRow ? "font-semibold" : ""}">${displayVal}</td>`;
    }).join("");

    return `<tr>${tds}</tr>`;
  }).join("")}
    </tbody>`;

  table.innerHTML = thead + tbody;
  if (tableUnit) tableUnit.textContent = `Units: ${showKwh ? "kWh" : "W"}`;

  // helpers (module-local)
  function fmtEnergy(x, { dash = true } = {}) {
    const raw = Number(x) || 0;
    if (showKwh) {
      const val = W2kWh(raw);
      if (dash && Math.abs(val) < 1e-12) return "–";
      return dec2Thin(val);
    } else {
      const n = Math.round(raw);
      if (dash && n === 0) return "–";
      return intThin(n);
    }
  }

  function fmtDessStrategy(v) {
    if (v === -1 || v === "-1" || v == null) return "?";
    const map = { 0: "TS", 1: "SC", 2: "PB", 3: "PG" }; // Target, Self, Pro-bat, Pro-grid
    return map[v] ?? String(v);
  }

  function fmtDessRestrictions(v) {
    if (v === -1 || v === "-1" || v == null) return "?";
    // 0=no restrictions, 1=grid→bat restricted, 2=bat→grid restricted, 3=both blocked
    return String(v);
  }

  function fmtDessFeedin(v) {
    if (v === -1 || v === "-1" || v == null) return "?";
    if (v === 0 || v === "0") return "no";
    if (v === 1 || v === "1") return "yes";
    return "–";
  }

  function intThin(x) {
    return groupThin(Math.round(Number(x) || 0));
  }

  function dec2Thin(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "";
    const s = n.toFixed(2);
    const [i, f] = s.split(".");
    return `${groupThin(i)}.${f}`;
  }

  // rgb(…, …, …) → rgba(…, …, …, a)
  function rgbToRgba(rgb, alpha = 0.16) {
    const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgb || "");
    return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : rgb;
  }

  // Build a style attribute for flow cells that are > 0
  function styleForCell(key, rawValue) {
    const color = SOLUTION_COLORS[key];
    if (!color) return ""; // not a flow column
    const v = Number(rawValue) || 0;
    if (v <= 0) return ""; // only highlight positive flows
    const bg = rgbToRgba(color, 0.80);
    // subtle rounded background; keep text default for contrast
    return `style="background:${bg}; border-radius:4px"`;
  }

  function groupThin(numOrStr) {
    const s = String(numOrStr);
    const neg = s.startsWith("-") ? "-" : "";
    const body = neg ? s.slice(1) : s;
    const parts = body.split(".");
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.length > 1 ? `${neg}${intPart}.${parts[1]}` : `${neg}${intPart}`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[m]));
  }
}
