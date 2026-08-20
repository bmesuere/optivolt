/**
 * chart-empty.js
 *
 * The "no chart drawn yet" overlay. The same markup used to sit inline in
 * `index.html` once per chart; it now lives in the `#chart-empty-template`
 * element there and is cloned into every `[data-chart-empty]` wrapper, with
 * the attribute value as the caption.
 *
 * Must run before any chart is drawn: `renderChart()` hides the overlay next
 * to the canvas it just painted, and optimizer-controller rewrites the caption.
 */

export function mountChartPlaceholders() {
  const template = document.getElementById('chart-empty-template');
  if (!template) return;

  for (const wrap of document.querySelectorAll('[data-chart-empty]')) {
    if (wrap.querySelector('.chart-empty')) continue;
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector('span').textContent = wrap.dataset.chartEmpty;
    wrap.append(node);
  }
}
