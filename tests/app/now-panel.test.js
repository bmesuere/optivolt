// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  describeSlotAction,
  findCurrentRowIndex,
  renderNowPanel,
  socEnteringSlot,
  startNowPanelTicker,
} from '../../app/src/now-panel.js';

const T0 = new Date('2026-08-16T18:00:00').getTime();
const STEP = 15;
const slotAt = (i, extra = {}) => ({
  tIdx: i,
  timestampMs: T0 + i * STEP * 60_000,
  g2b: 0, pv2b: 0, b2l: 0, b2g: 0, b2ev: 0, ev_charge: 0,
  soc_percent: 50 + i,
  ...extra,
});

describe('findCurrentRowIndex', () => {
  const rows = [slotAt(0), slotAt(1), slotAt(2)];

  it('finds the slot containing the instant, not row 0', () => {
    expect(findCurrentRowIndex(rows, STEP, T0)).toBe(0);
    expect(findCurrentRowIndex(rows, STEP, T0 + 20 * 60_000)).toBe(1);
    expect(findCurrentRowIndex(rows, STEP, T0 + 44 * 60_000)).toBe(2);
  });

  it('is half-open: a slot boundary belongs to the later slot', () => {
    expect(findCurrentRowIndex(rows, STEP, T0 + 15 * 60_000)).toBe(1);
  });

  it('returns -1 outside the plan or with no plan', () => {
    expect(findCurrentRowIndex(rows, STEP, T0 - 1)).toBe(-1);
    expect(findCurrentRowIndex(rows, STEP, T0 + 45 * 60_000)).toBe(-1);
    expect(findCurrentRowIndex([], STEP, T0)).toBe(-1);
  });
});

describe('describeSlotAction', () => {
  it('names the dominant charge source', () => {
    expect(describeSlotAction(slotAt(0, { pv2b: 2000 })).label).toBe('Charging from PV');
    expect(describeSlotAction(slotAt(0, { g2b: 2000 })).label).toBe('Charging from grid');
    expect(describeSlotAction(slotAt(0, { g2b: 1000, pv2b: 900 })).label).toBe('Charging from grid + PV');
  });

  it('names the dominant discharge sink', () => {
    expect(describeSlotAction(slotAt(0, { b2l: 800 })).label).toBe('Discharging to load');
    expect(describeSlotAction(slotAt(0, { b2g: 800 })).label).toBe('Discharging to grid');
    expect(describeSlotAction(slotAt(0, { b2ev: 800 })).label).toBe('Discharging to EV');
  });

  it('reports total battery power, not the dominant leg', () => {
    expect(describeSlotAction(slotAt(0, { g2b: 1000, pv2b: 500 })).power_W).toBe(1500);
    expect(describeSlotAction(slotAt(0, { b2l: 300, b2g: 200 })).power_W).toBe(500);
  });

  it('falls back to EV charging when the battery is idle', () => {
    const action = describeSlotAction(slotAt(0, { ev_charge: 3000, g2ev: 3000 }));
    expect(action).toEqual({ label: 'Charging EV', power_W: 3000 });
  });

  it('treats rounding noise as idle', () => {
    expect(describeSlotAction(slotAt(0, { g2b: 3, b2l: 2 })).label).toBe('Idle');
    expect(describeSlotAction(slotAt(0)).label).toBe('Idle');
    expect(describeSlotAction(null).label).toBe('—');
  });
});

describe('socEnteringSlot', () => {
  const rows = [slotAt(0), slotAt(1), slotAt(2)];

  it('uses the measured value for the first slot', () => {
    expect(socEnteringSlot(rows, 0, 64)).toBe(64);
  });

  it('uses the previous slot result for later slots', () => {
    expect(socEnteringSlot(rows, 2, 64)).toBe(51);
  });

  it('falls back when the measured value is missing', () => {
    expect(socEnteringSlot(rows, 0, null)).toBe(50);
  });
});

describe('renderNowPanel', () => {
  let els;

  beforeEach(() => {
    document.body.innerHTML = `
      <span id="w"></span><span id="a"></span><span id="p"></span>
      <span id="s"></span><span id="t"></span>`;
    els = {
      nowSlotWindow: document.getElementById('w'),
      nowAction: document.getElementById('a'),
      nowPower: document.getElementById('p'),
      nowSoc: document.getElementById('s'),
      nowSocTarget: document.getElementById('t'),
    };
  });

  it('renders the slot the clock is in, with its window and target', () => {
    const rows = [
      slotAt(0, { pv2b: 500 }),
      slotAt(1, { g2b: 2400, dess: { socTarget_percent: 80 } }),
    ];
    const idx = renderNowPanel(els, { rows, stepSize_m: STEP, initialSoc_percent: 64 }, T0 + 20 * 60_000);

    expect(idx).toBe(1);
    expect(els.nowSlotWindow.textContent).toBe('18:15 – 18:30');
    expect(els.nowAction.textContent).toBe('Charging from grid');
    expect(els.nowPower.textContent).toBe('2.40 kW');
    expect(els.nowSoc.textContent).toBe('50'); // previous slot's result
    expect(els.nowSocTarget.textContent).toBe('target 80%');
  });

  it('flags an expired plan rather than showing a stale slot', () => {
    const rows = [slotAt(0, { g2b: 1000 })];
    const idx = renderNowPanel(els, { rows, stepSize_m: STEP }, T0 + 10 * 3_600_000);

    expect(idx).toBe(-1);
    expect(els.nowSlotWindow.textContent).toBe('plan expired');
    expect(els.nowPower.textContent).toBe('—');
  });

  it('shows placeholders before the first plan', () => {
    renderNowPanel(els, { rows: [] }, T0);
    expect(els.nowSlotWindow.textContent).toBe('—');
    expect(els.nowAction.textContent).toBe('—');
  });
});

describe('startNowPanelTicker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders immediately and then on each interval, until stopped', () => {
    const render = vi.fn();
    const stop = startNowPanelTicker(render, 30_000);

    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(render).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(render).toHaveBeenCalledTimes(3);
  });
});
