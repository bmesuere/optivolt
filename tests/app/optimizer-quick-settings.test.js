// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initOptimizerQuickSettings,
  parseQuickSettingSelection,
} from '../../app/src/optimizer-quick-settings.js';

const definitions = [
  { id: 'minSoc_percent', selector: '#minsoc', label: 'Min SoC (%)', kind: 'number' },
  { id: 'mode', selector: '#mode', label: 'Mode', kind: 'select' },
  { id: 'blockFeedInOnNegativePrices', selector: '#block-feedin-negative-prices', label: 'Block feed-in', kind: 'checkbox' },
];

function setupDom(selection = '[]') {
  document.body.innerHTML = `
    <section id="optimizer-quick-settings" class="hidden">
      <div id="optimizer-quick-settings-body"></div>
      <input id="optimizer-quick-settings-selection" value='${selection}' />
    </section>
    <label class="text-sm">Min SoC (%)
      <input id="minsoc" type="number" class="form-input" value="20" min="0" max="100" />
    </label>
    <label class="text-sm">Mode
      <select id="mode" class="form-select">
        <option value="zero">zero</option>
        <option value="max">max</option>
      </select>
    </label>
    <label class="toggle">
      <input id="block-feedin-negative-prices" type="checkbox" />
      <span class="toggle-knob"></span>
      <span>Block feed-in</span>
    </label>
  `;

  return {
    body: document.querySelector('#optimizer-quick-settings-body'),
    section: document.querySelector('#optimizer-quick-settings'),
    selectionInput: document.querySelector('#optimizer-quick-settings-selection'),
  };
}

describe('optimizer quick settings', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('pins and unpins settings without triggering a recompute callback', () => {
    const els = setupDom();
    const onSelectionChange = vi.fn();
    const controller = initOptimizerQuickSettings({ ...els, definitions, onSelectionChange });

    document.querySelector('[data-quick-setting-pin="minSoc_percent"]').click();

    expect(controller.getSelectedIds()).toEqual(['minSoc_percent']);
    expect(JSON.parse(els.selectionInput.value)).toEqual(['minSoc_percent']);
    expect(els.section.classList.contains('hidden')).toBe(false);
    expect(els.body.querySelector('#optimizer-quick-minSoc_percent')).toBeTruthy();
    expect(onSelectionChange).toHaveBeenCalledWith(['minSoc_percent']);

    document.querySelector('[data-quick-setting-pin="minSoc_percent"]').click();

    expect(controller.getSelectedIds()).toEqual([]);
    expect(JSON.parse(els.selectionInput.value)).toEqual([]);
    expect(els.section.classList.contains('hidden')).toBe(true);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });

  it('places toggle pins after the toggle text', () => {
    const els = setupDom();
    initOptimizerQuickSettings({ ...els, definitions });

    const toggleLabel = document.querySelector('#block-feedin-negative-prices').closest('label');

    expect(toggleLabel.lastElementChild).toBe(document.querySelector('[data-quick-setting-pin="blockFeedInOnNegativePrices"]'));
  });

  it('can unpin a setting from its optimizer mirror', () => {
    const els = setupDom('["minSoc_percent"]');
    const onSelectionChange = vi.fn();
    const controller = initOptimizerQuickSettings({ ...els, definitions, onSelectionChange });

    document.querySelector('[data-quick-setting-unpin="minSoc_percent"]').click();

    expect(controller.getSelectedIds()).toEqual([]);
    expect(JSON.parse(els.selectionInput.value)).toEqual([]);
    expect(els.section.classList.contains('hidden')).toBe(true);
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it('syncs number, select, and checkbox mirrors in both directions', () => {
    const els = setupDom('["minSoc_percent","mode","blockFeedInOnNegativePrices"]');
    initOptimizerQuickSettings({ ...els, definitions });

    const minSoc = document.querySelector('#minsoc');
    const minSocMirror = document.querySelector('#optimizer-quick-minSoc_percent');
    const mode = document.querySelector('#mode');
    const modeMirror = document.querySelector('#optimizer-quick-mode');
    const block = document.querySelector('#block-feedin-negative-prices');
    const blockMirror = document.querySelector('#optimizer-quick-blockFeedInOnNegativePrices');

    minSocMirror.value = '35';
    minSocMirror.dispatchEvent(new Event('input', { bubbles: true }));
    expect(minSoc.value).toBe('35');

    modeMirror.value = 'max';
    modeMirror.dispatchEvent(new Event('change', { bubbles: true }));
    expect(mode.value).toBe('max');

    blockMirror.checked = true;
    blockMirror.dispatchEvent(new Event('change', { bubbles: true }));
    expect(block.checked).toBe(true);

    minSoc.value = '42';
    minSoc.dispatchEvent(new Event('input', { bubbles: true }));
    expect(minSocMirror.value).toBe('42');

    mode.value = 'zero';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modeMirror.value).toBe('zero');

    block.checked = false;
    block.dispatchEvent(new Event('change', { bubbles: true }));
    expect(blockMirror.checked).toBe(false);
  });

  it('routes mirror edits through the source input event path', () => {
    const els = setupDom('["minSoc_percent"]');
    initOptimizerQuickSettings({ ...els, definitions });

    const onInput = vi.fn();
    const minSoc = document.querySelector('#minsoc');
    const minSocMirror = document.querySelector('#optimizer-quick-minSoc_percent');
    minSoc.addEventListener('input', onInput);

    minSocMirror.value = '30';
    minSocMirror.dispatchEvent(new Event('input', { bubbles: true }));

    expect(minSoc.value).toBe('30');
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown saved IDs safely', () => {
    const els = setupDom('["missing","minSoc_percent","minSoc_percent"]');
    const controller = initOptimizerQuickSettings({ ...els, definitions });

    expect(controller.getSelectedIds()).toEqual(['minSoc_percent']);
    expect(JSON.parse(els.selectionInput.value)).toEqual(['minSoc_percent']);
    expect(els.body.querySelector('#optimizer-quick-missing')).toBeNull();
  });

  it('parses JSON and comma-separated selection values', () => {
    expect(parseQuickSettingSelection('["minSoc_percent","missing"]', definitions)).toEqual(['minSoc_percent']);
    expect(parseQuickSettingSelection('mode, missing, mode', definitions)).toEqual(['mode']);
  });
});
