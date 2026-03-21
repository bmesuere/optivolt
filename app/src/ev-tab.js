import { SOLUTION_COLORS, fmtHHMM, drawEvPowerChart, drawEvSocChartTab } from "./charts.js";
import { formatKWh, updateStackedBarContainer } from "./state.js";

export function updateEvPanel(els, rows, summary, stepSize_m = 15) {
  const evTotal = summary?.evChargeTotal_kWh ?? 0;
  const hasEv = evTotal > 0;

  if (els.evNoCharging) els.evNoCharging.classList.toggle('hidden', hasEv);
  if (els.evChargingSummary) els.evChargingSummary.classList.toggle('hidden', !hasEv);

  const currentSocDisplay = els.evSocValue?.dataset.haState ?? null;
  if (els.evTabCurrentSocRow) els.evTabCurrentSocRow.classList.toggle('hidden', !currentSocDisplay);
  if (els.evTabCurrentSoc && currentSocDisplay) els.evTabCurrentSoc.textContent = currentSocDisplay;

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

    if (els.evPowerChart) drawEvPowerChart(els.evPowerChart, rows, stepSize_m);
    if (els.evSocChartTab) drawEvSocChartTab(els.evSocChartTab, rows, {
      departureTime: els.evDepartureTime?.value,
      targetSoc_percent: parseFloat(els.evTargetSoc?.value),
    });
  }

  renderEvTable(rows, els.evScheduleTable, stepSize_m);
}

function renderEvTable(rows, tableEl, stepSize_m = 15) {
  if (!tableEl) return;

  const evRows = rows.filter(r => (r.ev_soc_percent ?? 0) > 0);

  if (evRows.length === 0) {
    tableEl.innerHTML = `<tbody><tr><td class="px-2 py-4 text-center text-slate-400 dark:text-slate-500 text-xs" colspan="7">No EV charging in current plan.</td></tr></tbody>`;
    return;
  }

  const h = Math.max(0.000001, stepSize_m / 60);
  const fmtKwh = (w) => {
    const v = (w || 0) * h / 1000;
    return v < 0.001 ? '–' : v.toFixed(2);
  };

  const MODE_BADGE = {
    fixed:         `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400">fixed</span>`,
    pv_charging:   `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400">PV</span>`,
    grid_headroom: `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400">grid</span>`,
  };

  const thead = `<thead>
    <tr class="text-left text-xs text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-white/5">
      <th class="px-2 py-1.5 font-medium">Time</th>
      <th class="px-2 py-1.5 font-medium">Mode</th>
      <th class="px-2 py-1.5 font-medium text-right">A</th>
      <th class="px-2 py-1.5 font-medium text-right" style="color:${SOLUTION_COLORS.g2ev}">Grid</th>
      <th class="px-2 py-1.5 font-medium text-right" style="color:${SOLUTION_COLORS.b2ev}">Battery</th>
      <th class="px-2 py-1.5 font-medium text-right" style="color:${SOLUTION_COLORS.pv2ev}">Solar</th>
      <th class="px-2 py-1.5 font-medium text-right">EV SoC</th>
    </tr>
  </thead>`;

  const tbody = evRows.map(r => {
    const isCharging = (r.ev_charge ?? 0) > 0;
    const ampStr = isCharging ? (r.ev_charge_A ?? 0).toFixed(1) : '–';
    const modeHtml = isCharging ? (MODE_BADGE[r.ev_charge_mode] ?? '') : '';
    return `
    <tr class="border-b border-slate-50 dark:border-white/3 hover:bg-slate-50/60 dark:hover:bg-white/3 font-mono text-xs">
      <td class="px-2 py-1.5">${fmtHHMM(new Date(r.timestampMs))}</td>
      <td class="px-2 py-1.5">${modeHtml}</td>
      <td class="px-2 py-1.5 text-right">${ampStr}</td>
      <td class="px-2 py-1.5 text-right">${fmtKwh(r.g2ev)}</td>
      <td class="px-2 py-1.5 text-right">${fmtKwh(r.b2ev)}</td>
      <td class="px-2 py-1.5 text-right">${fmtKwh(r.pv2ev)}</td>
      <td class="px-2 py-1.5 text-right">${(r.ev_soc_percent ?? 0).toFixed(2)}%</td>
    </tr>`;
  }).join('');

  tableEl.innerHTML = thead + `<tbody>${tbody}</tbody>`;
}
