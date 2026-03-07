import { fetchData, fetchEvSchedule, fetchEvRefresh } from './api/api.js';
import { SOLUTION_COLORS, toRGBA } from './charts.js';

/** @type {import('chart.js').Chart | null} */
let evChartInstance = null;

function fmtHHMM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDDMM_HHMM(ts) {
  const date = new Date(ts);
  if (isNaN(date.getTime())) return String(ts);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const HH = String(date.getHours()).padStart(2, '0');
  const MM = String(date.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${HH}:${MM}`;
}

function updateEvStatusCard(els, evState) {
  if (!evState) {
    if (els.evTabSoc) els.evTabSoc.textContent = '—';
    if (els.evTabPlugged) {
      els.evTabPlugged.textContent = '—';
      els.evTabPlugged.className = 'stat-value text-base';
    }
    if (els.evTabTimestamp) els.evTabTimestamp.textContent = '—';
    return;
  }

  if (els.evTabSoc) {
    els.evTabSoc.textContent = Number.isFinite(evState.soc_percent)
      ? String(Math.round(evState.soc_percent))
      : '—';
  }

  if (els.evTabPlugged) {
    els.evTabPlugged.textContent = evState.plugged ? 'Plugged in' : 'Unplugged';
    els.evTabPlugged.className = evState.plugged
      ? 'stat-value text-base text-emerald-600 dark:text-emerald-400'
      : 'stat-value text-base text-slate-500 dark:text-slate-400';
  }

  if (els.evTabTimestamp) {
    els.evTabTimestamp.textContent = evState.timestamp ? fmtDDMM_HHMM(evState.timestamp) : '—';
  }
}

/**
 * Update the sensor value indicators in the Settings tab.
 * @param {object} els
 * @param {object | null} evState
 */
export function updateEvSensorValues(els, evState) {
  if (els.evSocValue) {
    els.evSocValue.textContent = evState?.soc_percent != null
      ? `${Math.round(evState.soc_percent)}%`
      : '—';
  }
  if (els.evPlugValue) {
    els.evPlugValue.textContent = evState?.plugged != null
      ? (evState.plugged ? 'Plugged in' : 'Unplugged')
      : '—';
  }
}

function renderEvScheduleTable(els, schedule) {
  if (!els.evScheduleTbody) return;
  if (!schedule || schedule.length === 0) {
    els.evScheduleTbody.innerHTML =
      '<tr><td colspan="3" class="px-3 py-4 text-center text-slate-400 dark:text-slate-500">No plan computed yet</td></tr>';
    return;
  }

  els.evScheduleTbody.innerHTML = schedule.map((slot) => {
    const timeLabel = slot.timestampMs != null ? fmtHHMM(slot.timestampMs) : '—';
    const power = Number.isFinite(slot.chargePower_W) ? `${Math.round(slot.chargePower_W)} W` : '—';
    const charging = slot.shouldCharge
      ? '<span class="text-emerald-600 dark:text-emerald-400">Yes</span>'
      : '<span class="text-slate-400 dark:text-slate-500">No</span>';
    return `<tr class="hover:bg-slate-50 dark:hover:bg-white/5">
      <td class="px-3 py-1.5 font-mono text-xs">${timeLabel}</td>
      <td class="px-3 py-1.5 font-mono text-xs">${power}</td>
      <td class="px-3 py-1.5 text-xs">${charging}</td>
    </tr>`;
  }).join('');
}

function renderEvChart(canvas, schedule) {
  if (!canvas) return;
  const Chart = window.Chart;
  if (!Chart) return;

  const labels = schedule.map(s => s.timestampMs != null ? fmtHHMM(s.timestampMs) : '');
  const data = schedule.map(s => s.chargePower_W ?? 0);
  const color = SOLUTION_COLORS.ev;

  if (evChartInstance) {
    evChartInstance.data.labels = labels;
    evChartInstance.data.datasets[0].data = data;
    evChartInstance.update();
    return;
  }

  evChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Charge Power (W)',
        data,
        backgroundColor: toRGBA(color, 0.7),
        borderColor: color,
        borderWidth: 1,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { maxTicksLimit: 12, font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { font: { size: 10 } },
          title: { display: true, text: 'W', font: { size: 10 } },
        },
      },
    },
  });
}

/**
 * Fetch fresh EV state from HA, update status card + sensor indicators.
 * Returns the evState or null on failure.
 * @param {object} els
 */
export async function refreshEvState(els) {
  try {
    const evState = await fetchEvRefresh();
    updateEvStatusCard(els, evState ?? null);
    updateEvSensorValues(els, evState ?? null);
    return evState ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error';
    if (els.evSocValue) els.evSocValue.textContent = msg;
    if (els.evPlugValue) els.evPlugValue.textContent = msg;
    return null;
  }
}

async function refreshEvTab(els) {
  // HA refresh and schedule fetch are independent — run in parallel
  const [, schedule] = await Promise.allSettled([
    refreshEvState(els),
    fetchEvSchedule(),
  ]);
  const arr = schedule.status === 'fulfilled' && Array.isArray(schedule.value) ? schedule.value : [];
  renderEvScheduleTable(els, arr);
  renderEvChart(els.evChart, arr);
}

/**
 * Initialize the EV tab: load stored evState on boot, wire reload button.
 * @param {object} els - element refs from getElements()
 * @param {number} _stepSize_m
 */
export async function initEvTab(els, _stepSize_m = 15) {
  els.evReload?.addEventListener('click', () => void refreshEvTab(els));

  // Fetch stored evState and schedule in parallel
  const [dataResult, scheduleResult] = await Promise.allSettled([fetchData(), fetchEvSchedule()]);

  const evState = dataResult.status === 'fulfilled' ? (dataResult.value?.evState ?? null) : null;
  updateEvStatusCard(els, evState);
  updateEvSensorValues(els, evState);

  const arr = scheduleResult.status === 'fulfilled' && Array.isArray(scheduleResult.value) ? scheduleResult.value : [];
  renderEvScheduleTable(els, arr);
  renderEvChart(els.evChart, arr);
}
