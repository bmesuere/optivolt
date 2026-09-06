// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAllChartThemes } from '../../app/src/charts/core.js';

/**
 * Chart.js resolves scriptable options through a view over the config we handed it: reading
 * `chart.options.scales.x.grid.color` yields the colour the callback last returned, while a
 * write lands on the config object underneath. This proxy stands in for that.
 */
function resolvedView(target) {
  return new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop];
      if (typeof value === 'function') return 'transparent'; // a scriptable option, resolved
      return value && typeof value === 'object' ? resolvedView(value) : value;
    },
  });
}

function fakeChart({ gridColorFn }) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);

  const config = {
    options: {
      plugins: { legend: { labels: { color: 'light-legend' } } },
      scales: {
        x: { ticks: { color: 'light-ticks' }, grid: { color: gridColorFn } },
        y: { ticks: { color: 'light-ticks' }, grid: { color: 'light-grid', zeroLineColor: 'light-zero' } },
      },
    },
  };
  const chart = { canvas, config, options: resolvedView(config.options), update: vi.fn() };
  canvas._chart = chart;
  return chart;
}

describe('refreshAllChartThemes', () => {
  beforeEach(() => {
    globalThis.Chart = { getChart: () => null };
    document.documentElement.classList.add('dark');
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    document.body.innerHTML = '';
    delete globalThis.Chart;
  });

  it('leaves a scriptable grid colour in place so it repaints in the new theme', () => {
    const gridColorFn = () => 'per-tick';
    const chart = fakeChart({ gridColorFn });

    refreshAllChartThemes();

    // Overwriting this with a flat colour would draw a gridline at every tick, in the theme
    // that was current when the chart was built.
    expect(chart.config.options.scales.x.grid.color).toBe(gridColorFn);
    expect(chart.update).toHaveBeenCalledWith('none');
  });

  it('recolours the static options on the config Chart.js resolves from', () => {
    const chart = fakeChart({ gridColorFn: () => 'per-tick' });

    refreshAllChartThemes();

    const { scales, plugins } = chart.config.options;
    expect(scales.y.grid.color).toBe('rgba(148, 163, 184, 0.28)'); // the dark theme's grid
    expect(scales.y.grid.zeroLineColor).toBe('rgba(148, 163, 184, 0.6)');
    expect(scales.y.ticks.color).toBe('rgba(226, 232, 240, 0.9)');
    expect(scales.x.ticks.color).toBe('rgba(226, 232, 240, 0.9)');
    expect(plugins.legend.labels.color).toBe('rgba(226, 232, 240, 0.9)');
  });
});
