// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hydrateUI, snapshotUI } from '../../app/src/state.js';

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
});
