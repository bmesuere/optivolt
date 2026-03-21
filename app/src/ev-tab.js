import { SOLUTION_COLORS, toRGBA, drawEvPowerChart, drawEvSocChartTab } from "./charts.js";
import { formatKWh, updateStackedBarContainer } from "./state.js";

export function updateEvPanel(els, rows, summary, stepSize_m = 15) {
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

  const evSettings = {
    targetSoc_percent: parseFloat(els.evTargetSoc?.value) || null,
    departureTime: els.evDepartureTime?.value || null,
  };

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

    if (els.evPowerChart) drawEvPowerChart(els.evPowerChart, rows, stepSize_m, evSettings);
    if (els.evSocChartTab) drawEvSocChartTab(els.evSocChartTab, rows, evSettings);
  }
  renderEvTable(rows, els.evScheduleTable, stepSize_m, evSettings);
}

function renderEvTable(rows, tableEl, stepSize_m = 15, evSettings = {}) {
  if (!tableEl) return;

  const evRows = rows.filter(r => (r.ev_soc_percent ?? 0) > 0);

  if (evRows.length === 0) {
    tableEl.innerHTML = `<tbody><tr><td class="px-2 py-4 text-center text-slate-400 dark:text-slate-500 text-xs" colspan="8">No EV charging in current plan.</td></tr></tbody>`;
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
  const finalSoc = evRows[evRows.length - 1]?.ev_soc_percent ?? 0;

  const fmtTotalChip = (val, colorKey) => {
    const bg = toRGBA(SOLUTION_COLORS[colorKey], val > 0.001 ? 0.55 : 0.22);
    return `<span class="inline-block font-mono tabular-nums text-[11px] font-semibold px-1.5 py-0.5 rounded" style="background:${bg}">${val.toFixed(2)}</span>`;
  };

  const baseTh = "px-2 py-1.5 border-b border-slate-200/80 dark:border-slate-700/60 bg-slate-50 dark:bg-slate-900";

  const totalsRow = `<tr>
    <th class="${baseTh}" scope="row"><span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-200/80 dark:bg-slate-700/60 text-[9px] font-bold text-slate-400 dark:text-slate-500" title="Column totals (kWh)">Σ</span></th>
    <th class="${baseTh}"></th>
    <th class="${baseTh}"></th>
    <th class="${baseTh} text-right">${fmtTotalChip(totGrid,  'g2ev')}</th>
    <th class="${baseTh} text-right">${fmtTotalChip(totBatt,  'b2ev')}</th>
    <th class="${baseTh} text-right">${fmtTotalChip(totSolar, 'pv2ev')}</th>
    <th class="${baseTh} text-right font-mono tabular-nums text-[11px] font-semibold text-slate-500 dark:text-slate-400">${finalSoc.toFixed(1)}%</th>
    ${evSettings.targetSoc_percent != null ? `<th class="${baseTh}"></th>` : ''}
  </tr>`;

  const departureMs = evSettings.departureTime ? new Date(evSettings.departureTime).getTime() : null;
  const departureIdx = departureMs != null
    ? (evRows.findIndex(r => r.timestampMs >= departureMs))
    : -1;

  const hasTarget = evSettings.targetSoc_percent != null && !isNaN(evSettings.targetSoc_percent);

  const MODE_BADGE = {
    fixed:      `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400">fixed</span>`,
    solar:      `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400">solar</span>`,
    solar_plus: `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">solar+</span>`,
    max:        `<span class="rounded px-1 py-0.5 text-[10px] font-medium bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400">max</span>`,
  };

  const thead = `<thead>
    <tr class="align-bottom text-right text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-200/80 dark:border-slate-700/60 bg-slate-50 dark:bg-slate-900">
      <th class="px-2 py-2 text-left">Time</th>
      <th class="px-2 py-2">Mode</th>
      <th class="px-2 py-2" title="Charge current (Amps)">A</th>
      <th class="px-2 py-2" title="Grid → EV (kWh)">Grid</th>
      <th class="px-2 py-2" title="Battery → EV (kWh)">Batt</th>
      <th class="px-2 py-2" title="Solar → EV (kWh)">Solar</th>
      <th class="px-2 py-2" title="EV battery state of charge">EV SoC</th>
      ${hasTarget ? `<th class="px-2 py-2" title="Target SoC at departure">Target</th>` : ''}
    </tr>
    ${totalsRow}
  </thead>`;

  const tbody = evRows.map((r, i) => {
    const timeLabel = fmtRowTime(r.timestampMs);
    const isMidnight = /^\d{2}\/\d{2}$/.test(timeLabel);
    const isDeparture = i === departureIdx;
    const isCharging = (r.ev_charge ?? 0) > 0;
    const ampStr = isCharging ? (r.ev_charge_A ?? 0).toFixed(1) : '–';
    const modeHtml = isCharging ? (MODE_BADGE[r.ev_charge_mode] ?? '') : '';
    const soc = (r.ev_soc_percent ?? 0).toFixed(1);

    const timeCell = isDeparture
      ? `${timeLabel}<span class="ml-1.5 inline-block rounded px-1 py-0 text-[9px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400" title="Departure time">dep</span>`
      : timeLabel;

    const targetCell = hasTarget
      ? `<td class="px-2 py-1 text-right font-mono tabular-nums text-[11px] ${isDeparture ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-600'}">${isDeparture ? `${evSettings.targetSoc_percent}%` : '—'}</td>`
      : '';

    const rowBg = isMidnight ? 'bg-slate-50/50 dark:bg-slate-800/30' : '';

    return `
    <tr class="border-b border-slate-100/70 dark:border-slate-800/60 hover:bg-slate-50/60 dark:hover:bg-slate-800/60 font-mono text-xs ${rowBg}${isDeparture ? ' ring-1 ring-inset ring-emerald-200 dark:ring-emerald-800/50' : ''}">
      <td class="px-2 py-1 text-left tabular-nums${isMidnight ? ' font-semibold text-slate-600 dark:text-slate-300' : ''}">${timeCell}</td>
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
