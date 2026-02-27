/* global Chart */
import { runValidation, savePredictionConfig } from './api/api.js';

let validationResults = null;
let _activeSensor = null;
let accuracyChart = null;
let diffChart = null;

export function initValidation({ readFormValues, renderLoadConfig, setComparisonStatus }) {
  const runBtn = document.getElementById('pred-run-validation');
  if (runBtn) {
    runBtn.addEventListener('click', () => onRunValidation({ readFormValues, renderLoadConfig, setComparisonStatus }));
  }
}

async function onRunValidation({ readFormValues, renderLoadConfig, setComparisonStatus }) {
  const runBtn = document.getElementById('pred-run-validation');
  const originalText = runBtn ? runBtn.textContent : '';
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    runBtn.classList.add('opacity-50', 'cursor-not-allowed');
  }

  try {
    const resultsEl = document.getElementById('pred-results');

    setComparisonStatus('Saving config…');

    try {
      const partial = readFormValues();
      await savePredictionConfig(partial);
    } catch (err) {
      setComparisonStatus(`Save failed: ${err.message}`, true);
      return;
    }

    setComparisonStatus('Fetching HA data and running validation…');
    if (resultsEl) resultsEl.hidden = true;
    const noResultsEl = document.getElementById('pred-no-results');
    if (noResultsEl) noResultsEl.hidden = true;

    try {
      const result = await runValidation();
      validationResults = result;
      renderResults(result, { readFormValues, renderLoadConfig, setComparisonStatus });
      setComparisonStatus(`Validation complete — ${result.results.length} combinations evaluated`);
    } catch (err) {
      setComparisonStatus(`Error: ${err.message}`, true);
    }
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = originalText;
      runBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  }
}

function renderResults({ sensorNames, results }, deps) {
  const resultsEl = document.getElementById('pred-results');
  if (!resultsEl) return;

  resultsEl.hidden = false;

  const noResultsEl = document.getElementById('pred-no-results');
  if (noResultsEl) noResultsEl.hidden = true;

  renderSensorTabs(sensorNames, deps);

  const firstSensor = sensorNames[0] ?? null;
  if (firstSensor) {
    _activeSensor = firstSensor;
    renderMetricsTable(results, firstSensor, deps);
  }
}

function renderSensorTabs(sensorNames, deps) {
  const container = document.getElementById('pred-sensor-tabs');
  if (!container) return;

  container.innerHTML = '';
  for (const name of sensorNames) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = name;
    btn.dataset.sensor = name;
    btn.className =
      'px-3 py-1.5 text-sm rounded-pill border border-slate-300 dark:border-white/10 ' +
      'focus:outline-none focus:ring-2 focus:ring-sky-400/30 transition-colors';
    btn.addEventListener('click', () => {
      _activeSensor = name;
      renderMetricsTable(validationResults.results, name, deps);
      updateTabActive(container, name);
    });
    container.appendChild(btn);
  }

  updateTabActive(container, sensorNames[0] ?? null);
}

function updateTabActive(container, activeName) {
  for (const btn of container.querySelectorAll('button')) {
    const isActive = btn.dataset.sensor === activeName;
    btn.classList.toggle('bg-sky-600', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('border-sky-600', isActive);
    btn.classList.toggle('hover:bg-sky-700', isActive);
    btn.classList.toggle('bg-white', !isActive);
    btn.classList.toggle('dark:bg-slate-800', !isActive);
    btn.classList.toggle('text-slate-700', !isActive);
    btn.classList.toggle('dark:text-slate-200', !isActive);
    btn.classList.toggle('hover:bg-slate-50', !isActive);
    btn.classList.toggle('dark:hover:bg-slate-700', !isActive);
  }
}

function renderMetricsTable(results, sensorName, deps) {
  const tbody = document.getElementById('pred-metrics-body');
  if (!tbody) return;

  const rows = results
    .filter(r => r.sensor === sensorName)
    .sort((a, b) => (isNaN(a.mae) ? 1 : isNaN(b.mae) ? -1 : a.mae - b.mae));

  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-slate-800/50';
    tr.innerHTML = `
      <td class="px-3 py-2 font-mono text-xs">${row.lookbackWeeks}w</td>
      <td class="px-3 py-2 text-xs">${row.dayFilter}</td>
      <td class="px-3 py-2 text-xs">${row.aggregation}</td>
      <td class="px-3 py-2 font-mono text-xs text-right">${isNaN(row.mae) ? '—' : row.mae.toFixed(1)}</td>
      <td class="px-3 py-2 font-mono text-xs text-right">${isNaN(row.rmse) ? '—' : row.rmse.toFixed(1)}</td>
      <td class="px-3 py-2 font-mono text-xs text-right">${isNaN(row.mape) ? '—' : row.mape.toFixed(1)}</td>
      <td class="px-3 py-2 font-mono text-xs text-right">${row.n}</td>
      <td class="px-3 py-2">
        <div class="flex gap-1">
          <button type="button" class="btn-use text-xs px-2 py-0.5 rounded border border-sky-500 text-sky-600 hover:bg-sky-50 dark:text-sky-400 dark:border-sky-400 dark:hover:bg-sky-900/30">Use</button>
          <button type="button" class="btn-chart text-xs px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:border-white/20 dark:hover:bg-slate-700">Chart</button>
        </div>
      </td>
    `;

    tr.querySelector('.btn-use').addEventListener('click', () => onUseConfig(row, deps));
    tr.querySelector('.btn-chart').addEventListener('click', () => onShowChart(row));

    tbody.appendChild(tr);
  }
}

async function onUseConfig(row, { readFormValues, renderLoadConfig, setComparisonStatus }) {
  const activeConfig = {
    sensor: row.sensor,
    lookbackWeeks: row.lookbackWeeks,
    dayFilter: row.dayFilter,
    aggregation: row.aggregation,
  };

  try {
    renderLoadConfig(activeConfig);
    const partial = readFormValues();
    await savePredictionConfig(partial);
    setComparisonStatus(`Active config updated: ${row.sensor} / ${row.lookbackWeeks}w / ${row.dayFilter} / ${row.aggregation}`);
  } catch (err) {
    setComparisonStatus(`Failed to save active config: ${err.message}`, true);
  }
}

function onShowChart(row) {
  const chartSection = document.getElementById('pred-chart-section');
  if (chartSection) chartSection.hidden = false;

  const canvas = document.getElementById('pred-accuracy-chart');
  const diffCanvas = document.getElementById('pred-accuracy-diff-chart');
  if (!canvas) return;

  const preds = row.validationPredictions ?? [];
  const labels = preds.map(p => {
    const d = new Date(p.date);
    return `${d.toISOString().slice(5, 10)} ${String(p.hour).padStart(2, '0')}h`;
  });

  if (accuracyChart) {
    accuracyChart.destroy();
    accuracyChart = null;
  }
  if (diffChart) {
    diffChart.destroy();
    diffChart = null;
  }

  // Chart 1: two clean lines, solid legend swatch (backgroundColor = line color, fill: false)
  accuracyChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Actual (Wh)',
          data: preds.map(p => p.actual),
          borderColor: 'rgb(14, 165, 233)',
          backgroundColor: 'rgb(14, 165, 233)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
        {
          label: 'Predicted (Wh)',
          data: preds.map(p => p.predicted),
          borderColor: 'rgb(249, 115, 22)',
          backgroundColor: 'rgb(249, 115, 22)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: { y: { title: { display: true, text: 'Wh' } } },
    },
  });

  // Chart 2: predicted − actual difference area, no legend
  if (diffCanvas) {
    diffChart = new Chart(diffCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Difference (pred − actual)',
            data: preds.map(p => p.predicted - p.actual),
            borderColor: 'rgba(100,116,139,0.6)',
            backgroundColor: 'transparent',
            borderWidth: 1,
            pointRadius: 0,
            tension: 0.3,
            fill: { target: 'origin', above: 'rgba(139,201,100,0.45)', below: 'rgba(233,122,131,0.45)' },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { title: { display: true, text: 'Wh diff' } } },
      },
    });
  }

  const title = document.getElementById('pred-chart-title');
  if (title) {
    title.textContent = `Accuracy: ${row.sensor} / ${row.lookbackWeeks}w / ${row.dayFilter} / ${row.aggregation}`;
  }
}
