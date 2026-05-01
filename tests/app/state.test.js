// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateUI, snapshotUI, updateSummaryUI } from '../../app/src/state.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('settings state', () => {
  it('round-trips optimizer quick settings through hydrate and snapshot', () => {
    const optimizerQuickSettingsSelection = document.createElement('input');
    const terminal = document.createElement('select');
    terminal.innerHTML = '<option value="zero">zero</option>';
    const terminalCustom = document.createElement('input');

    const els = {
      optimizerQuickSettingsSelection,
      terminal,
      terminalCustom,
    };

    hydrateUI(els, {
      optimizerQuickSettings: ['minSoc_percent', 'blockFeedInOnNegativePrices'],
      terminalSocValuation: 'zero',
      terminalSocCustomPrice_cents_per_kWh: 0,
    });

    expect(optimizerQuickSettingsSelection.value).toBe('["minSoc_percent","blockFeedInOnNegativePrices"]');
    expect(snapshotUI(els).optimizerQuickSettings).toEqual(['minSoc_percent', 'blockFeedInOnNegativePrices']);
  });

  it('keeps the DESS table toggle out of persisted settings', () => {
    const tableDess = document.createElement('input');
    tableDess.type = 'checkbox';
    tableDess.checked = true;

    expect(snapshotUI({ tableDess })).not.toHaveProperty('tableShowDess');

    tableDess.checked = false;
    hydrateUI({ tableDess }, { tableShowDess: true });

    expect(tableDess.checked).toBe(false);
  });

  it('renders and clears net grid cost in the summary panel', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="load-split-bar"></div><div id="flow-split-bar"></div>';

    const els = {
      sumLoad: document.createElement('div'),
      sumPv: document.createElement('div'),
      sumLoadGrid: document.createElement('div'),
      sumLoadBatt: document.createElement('div'),
      sumLoadPv: document.createElement('div'),
      avgImport: document.createElement('div'),
      netCost: document.createElement('div'),
      gridBatteryTp: document.createElement('div'),
      gridChargeTp: document.createElement('div'),
      batteryExportTp: document.createElement('div'),
    };
    document.body.append(...Object.values(els));

    updateSummaryUI(els, {
      loadTotal_kWh: 1,
      pvTotal_kWh: 2,
      loadFromGrid_kWh: 0.5,
      loadFromBattery_kWh: 0.25,
      loadFromPv_kWh: 0.25,
      gridToBattery_kWh: 0,
      batteryToGrid_kWh: 0,
      importEnergy_kWh: 0.5,
      avgImportPrice_cents_per_kWh: 12.345,
      netGridCost_cents: -4.2,
      gridBatteryTippingPoint_cents_per_kWh: null,
      gridChargeTippingPoint_cents_per_kWh: null,
      batteryExportTippingPoint_cents_per_kWh: null,
      pvExportTippingPoint_cents_per_kWh: null,
      rebalanceStatus: 'disabled',
      evChargeTotal_kWh: 0,
      evChargeFromGrid_kWh: 0,
      evChargeFromPv_kWh: 0,
      evChargeFromBattery_kWh: 0,
    });
    vi.runAllTimers();

    expect(els.avgImport.textContent).toBe('12.35 c€/kWh');
    expect(els.netCost.textContent).toBe('-4.20 c€');

    updateSummaryUI(els, null);
    vi.runAllTimers();

    expect(els.netCost.textContent).toBe('—');
  });
});
