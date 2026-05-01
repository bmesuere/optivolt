/** Aggregate a ForecastSeries into { timestamps[], values[] } with the given stepMinutes. */
export function aggregateForecastKwh(forecast, stepMinutes = 60) {
  const timeMap = new Map();
  const values = forecast.values || [];
  const startTs = new Date(forecast.start).getTime();
  const inputStepMs = (forecast.step || 15) * 60 * 1000;
  const targetStepMs = stepMinutes * 60 * 1000;

  for (let i = 0; i < values.length; i++) {
    const ts = startTs + i * inputStepMs;
    const bucketTs = Math.floor(ts / targetStepMs) * targetStepMs;
    if (!timeMap.has(bucketTs)) timeMap.set(bucketTs, 0);
    timeMap.set(bucketTs, timeMap.get(bucketTs) + values[i] * (inputStepMs / 3600000));
  }

  const timestamps = [...timeMap.keys()].sort((a, b) => a - b);
  const aggregatedKwh = timestamps.map(k => timeMap.get(k) / 1000);
  return { timestamps, values: aggregatedKwh };
}

export function applyAdjustmentsToForecastSeries(forecast, adjustments, series) {
  if (!forecast || !Array.isArray(forecast.values)) return forecast;
  const nowMs = Date.now();
  const relevant = (adjustments || [])
    .filter(adj => adj.series === series)
    .map(adj => ({ ...adj, startMs: new Date(adj.start).getTime(), endMs: new Date(adj.end).getTime() }))
    .filter(adj => adj.endMs > nowMs);
  if (!relevant.length) return forecast;

  const startTs = new Date(forecast.start).getTime();
  const stepMs = (forecast.step || 15) * 60 * 1000;
  return {
    ...forecast,
    values: forecast.values.map((raw, index) => {
      const slotTs = startTs + index * stepMs;
      const matching = relevant.filter(adj => slotTs >= adj.startMs && slotTs < adj.endMs);
      if (!matching.length) return raw;

      const setAdjustment = matching
        .filter(adj => adj.mode === 'set')
        .reduce((best, adj) => !best || adj.updatedAt > best.updatedAt ? adj : best, null);
      const base = setAdjustment ? Number(setAdjustment.value_W) : raw;
      const delta = matching
        .filter(adj => adj.mode === 'add')
        .reduce((sum, adj) => sum + Number(adj.value_W || 0), 0);
      return Math.max(0, base + delta);
    }),
  };
}

export function buildForecastSelectionRange(startIndex, endIndex, timestamps, stepMinutes) {
  if (!timestamps.length) return null;
  const low = Math.min(startIndex, endIndex);
  const high = Math.max(startIndex, endIndex);
  const first = Math.max(0, Math.min(timestamps.length - 1, low));
  const last = Math.max(0, Math.min(timestamps.length - 1, high));
  const stepMs = stepMinutes * 60 * 1000;
  return {
    startIndex: first,
    endIndex: last,
    start: new Date(timestamps[first]).toISOString(),
    end: new Date(timestamps[last] + stepMs).toISOString(),
  };
}

export function forecastSeriesFromCategoryX(x, bounds) {
  if (!bounds || !Number.isFinite(x)) return 'load';
  const mid = (bounds.left + bounds.right) / 2;
  return x >= mid ? 'pv' : 'load';
}

export function futureForecastSeries(series, nowMs = Date.now()) {
  if (!series || !Array.isArray(series.values) || !series.values.length) return null;
  const startMs = new Date(series.start).getTime();
  if (!Number.isFinite(startMs)) return null;
  const step = Number(series.step || 15);
  if (!Number.isFinite(step) || step <= 0) return null;

  const stepMs = step * 60 * 1000;
  const offset = Math.max(0, Math.floor((nowMs - startMs) / stepMs));
  if (offset >= series.values.length) return null;
  return {
    ...series,
    start: new Date(startMs + offset * stepMs).toISOString(),
    step,
    values: series.values.slice(offset),
  };
}
