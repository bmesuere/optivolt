import { SOLUTION_COLORS, toRGBA, drawEvPowerChart, drawEvSocChartTab } from "./charts.js";
import { formatKWh, updateStackedBarContainer } from "./state.js";
import { resolvePlanView } from "./plan-view.js";
import { getPlan } from "./plan-store.js";
import { mountViewToggles, subscribeViewToggles } from "./view-toggles.js";
import { rowIndexAtOrAfter } from "./utils.js";

// The non-plan inputs of the last render (elements, step size, EV settings);
// the plan itself is re-read from the store on replay.
let lastRenderInputs = null;
let viewToggles = null;

/**
 * Mount the EV tab's view toggles. Kept separate from updateEvPanel so the
 * controls exist (and re-render on change) before the first plan arrives.
 */
export function initEvPanelToggles(els) {
  viewToggles = mountViewToggles(els.evViewToggles);
  subscribeViewToggles(() => {
    if (!lastRenderInputs) return;
    const plan = getPlan();
    renderEvPanel({ ...lastRenderInputs, rows: plan.rows, summary: plan.summary });
  });
}

/**
 * Derive the chart/table annotation inputs from the EV schedule entries: arrival and departure
 * times (multiple possible) and the away spans of trips. SoC deadlines are not derived here —
 * the solver resolves them (clamped to what is reachable, de-duped per slot) and the plan rows
 * carry the result as `ev_target_soc_percent`.
 */
export function collectEvSettings(entries = []) {
  const arrivals = [];
  const departures = [];
  const trips = [];
  for (const e of entries) {
    if (e.type === 'arrival') {
      arrivals.push(e.time);
    } else if (e.type === 'departure') {
      departures.push(e.time);
    } else if (e.type === 'trip') {
      departures.push(e.time);
      if (e.endTime) {
        arrivals.push(e.endTime);
        trips.push({ from: e.time, to: e.endTime });
      }
    }
  }
  return { arrivals, departures, trips };
}

export function updateEvPanel(els, rows, summary, stepSize_m = 15, evSettings = null) {
  // Callers pass null explicitly when EV support is off, and a default parameter only covers
  // undefined — so normalise here rather than relying on one.
  const ev = evSettings ?? { arrivals: [], departures: [], trips: [] };
  lastRenderInputs = { els, stepSize_m, ev };
  renderEvPanel({ els, rows, summary, stepSize_m, ev });
}

function renderEvPanel({ els, rows, summary, stepSize_m, ev }) {
  const evTotal = summary?.evChargeTotal_kWh ?? 0;
  const hasEv = evTotal > 0;

  if (els.evNoCharging) els.evNoCharging.classList.toggle('hidden', hasEv);
  if (els.evChargingSummary) els.evChargingSummary.classList.toggle('hidden', !hasEv);

  const currentSocDisplay = els.evSocValue?.dataset.haState ?? null;
  if (els.evTabCurrentSocRow) els.evTabCurrentSocRow.classList.toggle('hidden', !currentSocDisplay);
  if (els.evTabCurrentSoc && currentSocDisplay) els.evTabCurrentSoc.textContent = `${currentSocDisplay}%`;

  const plugDisplay = els.evPlugValue?.dataset.haState ?? null;
  if (els.evTabPlugRow) els.evTabPlugRow.classList.toggle('hidden', !plugDisplay);
  if (els.evTabPlugStatus && plugDisplay) {
    const isPlugged = plugDisplay === 'on' || plugDisplay === 'true';
    els.evTabPlugStatus.textContent = isPlugged ? 'Connected' : 'Disconnected';
    els.evTabPlugStatus.className = `stat-value ${isPlugged ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}`;
  }

  const evRows = rows.filter(r => (r.ev_soc_percent ?? 0) > 0);

  if (hasEv) {
    const grid = summary.evChargeFromGrid_kWh ?? 0;
    const pv = summary.evChargeFromPv_kWh ?? 0;
    const batt = summary.evChargeFromBattery_kWh ?? 0;

    if (els.evTabGridKwh) els.evTabGridKwh.textContent = formatKWh(grid);
    if (els.evTabPvKwh) els.evTabPvKwh.textContent = formatKWh(pv);
    if (els.evTabBattKwh) els.evTabBattKwh.textContent = formatKWh(batt);
    if (els.evTabTotalKwh) els.evTabTotalKwh.textContent = formatKWh(evTotal);
    updateStackedBarContainer(els.evTabSplitBar, grid + pv + batt, [
      { value: grid, color: SOLUTION_COLORS.g2ev },
      { value: batt, color: SOLUTION_COLORS.b2ev },
      { value: pv,   color: SOLUTION_COLORS.pv2ev },
    ]);

    const totalCost_cents = summary.evChargeGridCost_cents ?? 0;
    const effectiveRate = summary.evChargeEffectiveRate_cents_per_kWh ?? 0;

    if (els.evTabTotalCost) els.evTabTotalCost.textContent = `${totalCost_cents.toFixed(1)}¢`;
    if (els.evTabEffectiveRate) els.evTabEffectiveRate.textContent = `${effectiveRate.toFixed(1)}¢/kWh`;
    if (els.evTabFreeSolar) {
      els.evTabFreeSolar.textContent = `${formatKWh(pv)} free`;
      els.evTabFreeSolar.className = `stat-value ${pv > 0.001 ? 'text-emerald-600 dark:text-emerald-400' : ''}`;
    }

    renderModeRows(els.evTabModeRows, evRows);
  }

  // The stat panel stays whole-plan (it summarises the plan, not the view);
  // only the charts and the table follow the view toggles, as on the optimizer.
  const planView = resolvePlanView({
    rows,
    stepSize_m,
    standardEndMs: getPlan().standardWindowEndMs,
  });
  viewToggles?.update(planView);

  if (els.evPowerChart) {
    drawEvPowerChart(els.evPowerChart, planView.chartRows, planView.chartStepSize_m, ev);
  }
  if (els.evSocChartTab) drawEvSocChartTab(els.evSocChartTab, planView.rows, ev);
  renderEvTable(planView.rows.filter(r => (r.ev_soc_percent ?? 0) > 0), els.evScheduleTable, stepSize_m, ev);
}

const MODE_CONFIG = [
  { key: 'solar_only', label: 'solar only',  color: '#10b981', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
  { key: 'solar_grid', label: 'solar+grid', color: '#f59e0b', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
  { key: 'max',        label: 'max',     color: '#ef4444', badge: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400' },
  { key: 'fixed',      label: 'fixed',   color: '#94a3b8', badge: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400' },
];

function renderModeRows(el, evRows) {
  if (!el) return;

  const counts = {};
  for (const r of evRows) {
    if ((r.ev_charge ?? 0) > 0 && r.ev_charge_mode) {
      counts[r.ev_charge_mode] = (counts[r.ev_charge_mode] ?? 0) + 1;
    }
  }

  const present = MODE_CONFIG.filter(m => (counts[m.key] ?? 0) > 0);
  if (present.length === 0) { el.innerHTML = ''; return; }

  const maxCount = Math.max(...present.map(m => counts[m.key]));

  const trackBg = document.documentElement.classList.contains('dark') ? '#334155' : '#e2e8f0';

  el.innerHTML = present.map(m => {
    const count = counts[m.key];
    const pct = Math.round((count / maxCount) * 100);
    return `<div style="display:grid;grid-template-columns:4.5rem 1fr 2.5rem;align-items:center;gap:6px;margin-bottom:5px">
      <span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${m.badge}">${m.label}</span>
      <div style="height:4px;border-radius:2px;background:${trackBg}">
        <div style="height:4px;border-radius:2px;width:${pct}%;background:${m.color}"></div>
      </div>
      <span class="text-right font-mono text-[10px] text-slate-400 dark:text-slate-500">${count}</span>
    </div>`;
  }).join('');
}

function renderEvTable(evRows, tableEl, stepSize_m = 15, evSettings = {}) {
  if (!tableEl) return;

  if (evRows.length === 0) {
    tableEl.innerHTML = `<tbody><tr><td class="px-2 py-4 text-center text-slate-400 dark:text-slate-500 text-xs" colspan="9">No EV charging in current plan.</td></tr></tbody>`;
    return;
  }

  const h = Math.max(0.000001, stepSize_m / 60);

  const fmtDate = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit" });
  const fmtTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

  const fmtRowTime = (ts) => {
    const dt = new Date(ts);
    if (dt.getHours() === 0 && dt.getMinutes() === 0) return fmtDate.format(dt);
    return fmtTime.format(dt);
  };

  const fmtKwh = (w) => {
    const v = (w || 0) * h / 1000;
    return v < 0.001 ? '–' : v.toFixed(2);
  };

  const flowCellStyle = (w, colorKey) => {
    const v = (w || 0) * h / 1000;
    if (v < 0.001) return '';
    return `style="background:${toRGBA(SOLUTION_COLORS[colorKey], 0.80)}; border-radius:4px"`;
  };

  const totGrid  = evRows.reduce((s, r) => s + (r.g2ev  || 0) * h / 1000, 0);
  const totBatt  = evRows.reduce((s, r) => s + (r.b2ev  || 0) * h / 1000, 0);
  const totSolar = evRows.reduce((s, r) => s + (r.pv2ev || 0) * h / 1000, 0);
  const totGridCost_cents = evRows.reduce((s, r) => s + (r.g2ev || 0) * h / 1000 * (r.ic || 0), 0);

  const fmtTotalChip = (val, colorKey) => {
    const bg = toRGBA(SOLUTION_COLORS[colorKey], val > 0.001 ? 0.55 : 0.22);
    return `<span class="inline-block font-mono tabular-nums text-[11px] font-semibold px-1.5 py-0.5 rounded" style="background:${bg}">${val.toFixed(2)}</span>`;
  };

  const baseTh = "px-2 py-1.5 border-b border-slate-200/80 dark:border-slate-700/60 bg-slate-50 dark:bg-slate-900";

  const rowIdxSet = (times) => {
    const set = new Set();
    for (const t of (times ?? [])) {
      const idx = rowIndexAtOrAfter(evRows, t);
      if (idx >= 0) set.add(idx);
    }
    return set;
  };

  const arrivalIdxs = rowIdxSet(evSettings?.arrivals);
  const departureIdxs = rowIdxSet(evSettings?.departures);

  const hasTarget = evRows.some(r => r.ev_target_soc_percent != null);

  const totalsRow = `<tr>
    <th class="${baseTh} text-left" scope="row"><span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-200/80 dark:bg-slate-700/60 text-[9px] font-bold text-slate-400 dark:text-slate-500" title="Column totals (kWh)">Σ</span></th>
    <th class="${baseTh} text-right font-mono tabular-nums text-[11px] font-semibold text-slate-500 dark:text-slate-400">${totGridCost_cents.toFixed(1)}¢</th>
    <th class="${baseTh}"></th>
    <th class="${baseTh}"></th>
    <th class="${baseTh} text-right">${fmtTotalChip(totGrid,  'g2ev')}</th>
    <th class="${baseTh} text-right">${fmtTotalChip(totBatt,  'b2ev')}</th>
    <th class="${baseTh} text-right">${fmtTotalChip(totSolar, 'pv2ev')}</th>
    <th class="${baseTh}"></th>
    ${hasTarget ? `<th class="${baseTh}"></th>` : ''}
  </tr>`;

  const MODE_BADGE = {
    fixed:      `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400">fixed</span>`,
    solar_only: `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400">solar only</span>`,
    solar_grid: `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">solar+grid</span>`,
    max:        `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400">max</span>`,
  };

  const thead = `<thead>
    <tr class="align-bottom text-right text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-200/80 dark:border-slate-700/60 bg-slate-50 dark:bg-slate-900">
      <th class="px-2 py-2 text-left">Time</th>
      <th class="px-2 py-2" title="Grid cost for EV charging (¢)">Cost</th>
      <th class="px-2 py-2">Mode</th>
      <th class="px-2 py-2" title="Charge current (Amps)">A</th>
      <th class="px-2 py-2" title="Grid → EV (kWh)">Grid</th>
      <th class="px-2 py-2" title="Battery → EV (kWh)">Batt</th>
      <th class="px-2 py-2" title="Solar → EV (kWh)">Solar</th>
      <th class="px-2 py-2" title="EV battery state of charge">EV SoC</th>
      ${hasTarget ? `<th class="px-2 py-2" title="Target SoC when ready">Target</th>` : ''}
    </tr>
    ${totalsRow}
  </thead>`;

  const tbody = evRows.map((r, i) => {
    const timeLabel = fmtRowTime(r.timestampMs);
    const isMidnight = /^\d{2}\/\d{2}$/.test(timeLabel);
    const isArrival = arrivalIdxs.has(i);
    const isDeparture = departureIdxs.has(i);
    const hasRowTarget = r.ev_target_soc_percent != null;
    const rowTargetSoc = hasRowTarget ? Math.round(r.ev_target_soc_percent) : null;
    const isCharging = (r.ev_charge ?? 0) > 0;
    const ampStr = isCharging ? (r.ev_charge_A ?? 0).toFixed(1) : '–';
    const modeHtml = isCharging ? (MODE_BADGE[r.ev_charge_mode] ?? '') : '';
    const soc = (r.ev_soc_percent ?? 0).toFixed(1);
    const gridCost_cents = (r.g2ev || 0) * h / 1000 * (r.ic || 0);
    const costStr = gridCost_cents < 0.05 ? '–' : `${gridCost_cents.toFixed(1)}¢`;

    const badge = (label, classes, title) =>
      `<span class="ml-1.5 inline-block rounded px-1 py-0 text-[9px] font-medium ${classes}" title="${title}">${label}</span>`;
    const markers = [];
    if (isArrival) markers.push(badge('arrives', 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400', 'Car arrives'));
    if (isDeparture) markers.push(badge('leaves', 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400', 'Car leaves'));
    if (hasRowTarget) markers.push(badge(`target ${rowTargetSoc}%`, 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400', 'Target SoC deadline'));
    const timeCell = `${timeLabel}${markers.join('')}`;

    const targetCell = hasTarget
      ? `<td class="px-2 py-1 text-right font-mono tabular-nums text-[11px] ${hasRowTarget ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-600'}">${hasRowTarget ? `${rowTargetSoc}%` : '—'}</td>`
      : '';

    const rowBg = isMidnight ? 'bg-slate-50/50 dark:bg-slate-800/30' : '';
    const isEventRow = isArrival || isDeparture || hasRowTarget;

    return `
    <tr class="border-b border-slate-100/70 dark:border-slate-800/60 hover:bg-slate-50/60 dark:hover:bg-slate-800/60 font-mono text-xs ${rowBg}${isEventRow ? ' ring-1 ring-inset ring-emerald-200 dark:ring-emerald-800/50' : ''}">
      <td class="px-2 py-1 text-left tabular-nums${isMidnight ? ' font-semibold text-slate-600 dark:text-slate-300' : ''}">${timeCell}</td>
      <td class="px-2 py-1 text-right">${costStr}</td>
      <td class="px-2 py-1 text-right">${modeHtml}</td>
      <td class="px-2 py-1 text-right">${ampStr}</td>
      <td class="px-2 py-1 text-right" ${flowCellStyle(r.g2ev, 'g2ev')}>${fmtKwh(r.g2ev)}</td>
      <td class="px-2 py-1 text-right" ${flowCellStyle(r.b2ev, 'b2ev')}>${fmtKwh(r.b2ev)}</td>
      <td class="px-2 py-1 text-right" ${flowCellStyle(r.pv2ev, 'pv2ev')}>${fmtKwh(r.pv2ev)}</td>
      <td class="px-2 py-1 text-right">${soc}%</td>
      ${targetCell}
    </tr>`;
  }).join('');

  tableEl.innerHTML = thead + `<tbody>${tbody}</tbody>`;
}
