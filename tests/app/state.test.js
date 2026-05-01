// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateUI, snapshotUI, updateRebalanceNudgeUI, updateSummaryUI } from '../../app/src/state.js';

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

  it('shows tooltip text when the last full SoC timestamp is unknown', () => {
    const els = {
      rebalanceToggleLabel: document.createElement('label'),
      rebalanceEnabled: document.createElement('input'),
      rebalanceNudge: document.createElement('p'),
    };
    els.rebalanceEnabled.type = 'checkbox';

    updateRebalanceNudgeUI(els, null);

    expect(els.rebalanceToggleLabel.title).toContain('Last 100% SoC: not recorded yet');
    expect(els.rebalanceNudge.classList.contains('hidden')).toBe(true);
  });

  it('shows the inline rebalance nudge only when recommended and not already enabled', () => {
    const els = {
      rebalanceToggleLabel: document.createElement('label'),
      rebalanceEnabled: document.createElement('input'),
      rebalanceNudge: document.createElement('p'),
    };
    els.rebalanceEnabled.type = 'checkbox';
    els.rebalanceNudge.className = 'hidden';

    updateRebalanceNudgeUI(els, {
      lastFullSocAt: '2024-01-01T00:00:00.000Z',
      daysSinceLastFullSoc: 12,
      rebalanceRecommended: true,
      thresholdDays: 10,
    });

    expect(els.rebalanceToggleLabel.title).toContain('Last 100% SoC:');
    expect(els.rebalanceToggleLabel.title).not.toContain('not recorded yet');
    expect(els.rebalanceNudge.classList.contains('hidden')).toBe(false);
    expect(els.rebalanceNudge.textContent).toContain('12 days ago');

    els.rebalanceEnabled.checked = true;
    updateRebalanceNudgeUI(els, {
      lastFullSocAt: '2024-01-01T00:00:00.000Z',
      daysSinceLastFullSoc: 12,
      rebalanceRecommended: true,
      thresholdDays: 10,
    });

    expect(els.rebalanceNudge.classList.contains('hidden')).toBe(true);
  });
});
