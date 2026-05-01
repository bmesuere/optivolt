// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderTable } from '../../app/src/table.js';

function makeRow(overrides = {}) {
  return {
    tIdx: 0,
    timestampMs: 1700000000000,
    load: 0,
    pv: 0,
    ic: 0,
    ec: 0,
    importCost_cents: 0,
    exportCost_cents: 0,
    g2l: 0,
    g2b: 0,
    pv2l: 0,
    pv2b: 0,
    pv2g: 0,
    b2l: 0,
    b2g: 0,
    imp: 0,
    exp: 0,
    soc: 0,
    soc_percent: 0,
    g2ev: 0,
    pv2ev: 0,
    b2ev: 0,
    ev_charge: 0,
    ev_charge_A: 0,
    ev_charge_mode: 'off',
    ev_soc_percent: 0,
    ...overrides,
  };
}

describe('renderTable', () => {
  it('shows price columns, cost columns, and summed cost totals', () => {
    const table = document.createElement('table');
    const rows = [
      makeRow({ ic: 20, ec: 8, importCost_cents: 20, exportCost_cents: 5 }),
      makeRow({ ic: 10, ec: -2, importCost_cents: 10, exportCost_cents: -2 }),
    ];

    renderTable({
      rows,
      cfg: { stepSize_m: 60 },
      targets: { table },
      showKwh: false,
    });

    expect(table.innerHTML).toContain('Import<br>price');
    expect(table.innerHTML).toContain('Export<br>price');
    expect(table.innerHTML).toContain('Import<br>cost');
    expect(table.innerHTML).toContain('Export<br>value');

    const firstBodyCells = table.querySelector('tbody tr').children;
    expect(firstBodyCells[14].textContent).toBe('20.00');
    expect(firstBodyCells[15].textContent).toBe('5.00');

    const totalCells = table.querySelectorAll('thead tr')[1].children;
    expect(totalCells[14].textContent).toBe('30.00');
    expect(totalCells[15].textContent).toBe('3.00');
  });

  it('hides DESS detail columns by default', () => {
    const table = document.createElement('table');

    renderTable({
      rows: [makeRow({ dess: { strategy: 1, restrictions: 2, feedin: 1, socTarget_percent: 50 } })],
      cfg: { stepSize_m: 60 },
      targets: { table },
      showKwh: false,
    });

    expect(table.innerHTML).not.toContain('DESS<br>strategy');
    expect(table.innerHTML).not.toContain('Restr.');
    expect(table.innerHTML).not.toContain('Feed-in');
    expect(table.innerHTML).toContain('Soc→');
  });

  it('shows DESS detail columns when enabled', () => {
    const table = document.createElement('table');

    renderTable({
      rows: [makeRow({ dess: { strategy: 1, restrictions: 2, feedin: 1, socTarget_percent: 50 } })],
      cfg: { stepSize_m: 60 },
      targets: { table },
      showKwh: false,
      showDess: true,
    });

    expect(table.innerHTML).toContain('DESS<br>strategy');
    expect(table.innerHTML).toContain('Restr.');
    expect(table.innerHTML).toContain('Feed-in');
  });
});
