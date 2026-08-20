// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountViewToggles, subscribeViewToggles } from '../../app/src/view-toggles.js';
import { resolveFlowsResolution } from '../../app/src/plan-view.js';

const host = () => {
  document.body.innerHTML = '<div id="host"></div>';
  return document.getElementById('host');
};

const click = (el, selector) => el.querySelector(selector).dispatchEvent(new Event('click', { bubbles: true }));

describe('resolveFlowsResolution', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to 15 min on short spans and hourly beyond 48 h', () => {
    expect(resolveFlowsResolution(24)).toBe('15');
    expect(resolveFlowsResolution(48)).toBe('15');
    expect(resolveFlowsResolution(72)).toBe('60');
  });

  it('honours an explicit choice on any span', () => {
    localStorage.setItem('optivolt:flowsResolution', '60');
    expect(resolveFlowsResolution(12)).toBe('60');
    localStorage.setItem('optivolt:flowsResolution', '15');
    expect(resolveFlowsResolution(96)).toBe('15');
  });
});

describe('mountViewToggles', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('styles the segments at mount, before the first update()', () => {
    localStorage.setItem('optivolt:flowsResolution', '60');
    const el = host();
    mountViewToggles(el);

    // The stored choice reads as active straight away; no bare buttons while
    // the initial solve runs.
    expect(el.querySelector('[data-res="60"]').getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-res="15"]').getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[data-res="15"]').className).not.toBe('');
  });

  it('always shows the resolution pair, and the range pair only when extended', () => {
    const el = host();
    const toggles = mountViewToggles(el);

    toggles.update({ hasExtended: false, view: 'standard', resolution: '15' });
    expect(el.querySelector('[data-res-toggle]').classList.contains('hidden')).toBe(false);
    expect(el.querySelector('[data-range-toggle]').classList.contains('hidden')).toBe(true);

    toggles.update({ hasExtended: true, view: 'full', resolution: '60' });
    expect(el.querySelector('[data-range-toggle]').classList.contains('hidden')).toBe(false);
  });

  it('marks the active button via aria-pressed', () => {
    const el = host();
    mountViewToggles(el).update({ hasExtended: true, view: 'full', resolution: '60' });

    expect(el.querySelector('[data-res="60"]').getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-res="15"]').getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[data-range="full"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('persists a click and notifies subscribers so other tabs re-render', () => {
    const el = host();
    mountViewToggles(el);
    const listener = vi.fn();
    const unsubscribe = subscribeViewToggles(listener);

    click(el, '[data-res="60"]');
    expect(localStorage.getItem('optivolt:flowsResolution')).toBe('60');
    expect(listener).toHaveBeenCalledTimes(1);

    click(el, '[data-range="full"]');
    expect(localStorage.getItem('optivolt:viewRange')).toBe('full');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    click(el, '[data-res="15"]');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps two mounted pairs in sync through the shared store', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    mountViewToggles(a);
    const bToggles = mountViewToggles(b);

    click(a, '[data-res="60"]');
    // The second pair reflects the shared choice on its next render pass.
    bToggles.update({ hasExtended: false, view: 'standard', resolution: resolveFlowsResolution(24) });
    expect(b.querySelector('[data-res="60"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('tolerates a missing host', () => {
    expect(() => mountViewToggles(null).update({})).not.toThrow();
  });
});
