import { SOLUTION_COLORS, fmtHHMM, drawEvPowerChart, drawEvSocChartTab } from "./charts.js";
import { formatKWh, updateStackedBarContainer } from "./state.js";

export function updateEvPanel(els, rows, summary, stepSize_m = 15) {
  const evTotal = summary?.evChargeTotal_kWh ?? 0;
  const hasEv = evTotal > 0;

  if (els.evNoCharging) els.evNoCharging.classList.toggle('hidden', hasEv);
  if (els.evChargingSummary) els.evChargingSummary.classList.toggle('hidden', !hasEv);

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
      { value: pv,   color: SOLUTION_COLORS.pv2ev },
      { value: batt, color: SOLUTION_COLORS.b2ev },
    ]);

    if (els.evTabDeparture) {
      els.evTabDeparture.textContent = els.evDepartureTime?.value || '—';
    }
    if (els.evTabTargetSoc) {
      const soc = els.evTargetSoc?.value;
      els.evTabTargetSoc.textContent = soc ? `${soc}%` : '—';
    }

    if (els.evPowerChart) drawEvPowerChart(els.evPowerChart, rows, stepSize_m);
    if (els.evSocChartTab) drawEvSocChartTab(els.evSocChartTab, rows);
  }

  renderEvTable(rows, els.evScheduleTable, stepSize_m);
}

function renderEvTable(rows, tableEl, stepSize_m = 15) {
  if (!tableEl) return;

  const evRows = rows.filter(r => r.ev_charge > 0);

  if (evRows.length === 0) {
    tableEl.innerHTML = `<tbody><tr><td class="px-2 py-4 text-center text-slate-400 dark:text-slate-500 text-xs" colspan="6">No EV charging in current plan.</td></tr></tbody>`;
    return;
  }

  const h = Math.max(0.000001, stepSize_m / 60);
  const fmt = (w) => ((w || 0) * h / 1000).toFixed(3);

  const thead = `<thead>
    <tr class="text-left text-xs text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-white/5">
      <th class="px-2 py-1.5 font-medium">Time</th>
      <th class="px-2 py-1.5 font-medium text-right">Total (kWh)</th>
      <th class="px-2 py-1.5 font-medium text-right" style="color:${SOLUTION_COLORS.g2ev}">Grid</th>
      <th class="px-2 py-1.5 font-medium text-right" style="color:${SOLUTION_COLORS.pv2ev}">Solar</th>
      <th class="px-2 py-1.5 font-medium text-right" style="color:${SOLUTION_COLORS.b2ev}">Battery</th>
      <th class="px-2 py-1.5 font-medium text-right">EV SoC</th>
    </tr>
  </thead>`;

  const tbody = evRows.map(r => `
    <tr class="border-b border-slate-50 dark:border-white/3 hover:bg-slate-50/60 dark:hover:bg-white/3 font-mono text-xs">
      <td class="px-2 py-1.5">${fmtHHMM(new Date(r.timestampMs))}</td>
      <td class="px-2 py-1.5 text-right">${fmt(r.ev_charge)}</td>
      <td class="px-2 py-1.5 text-right">${fmt(r.g2ev)}</td>
      <td class="px-2 py-1.5 text-right">${fmt(r.pv2ev)}</td>
      <td class="px-2 py-1.5 text-right">${fmt(r.b2ev)}</td>
      <td class="px-2 py-1.5 text-right">${(r.ev_soc_percent ?? 0).toFixed(1)}%</td>
    </tr>`).join('');

  tableEl.innerHTML = thead + `<tbody>${tbody}</tbody>`;
}
