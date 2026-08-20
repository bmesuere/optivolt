// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { collectEvSettings, initEvPanelToggles, updateEvPanel } from '../../app/src/ev-tab.js';
import { resetPlanStore, setPlan } from '../../app/src/plan-store.js';

describe('collectEvSettings — trips', () => {
  const trip = {
    id: 't1',
    type: 'trip',
    time: '2026-05-01T08:00:00.000Z',
    endTime: '2026-05-01T17:00:00.000Z',
    usage_percent: 25,
  };

  it('contributes a departure, an arrival, and an away span', () => {
    const result = collectEvSettings([trip]);
    expect(result.departures).toEqual([trip.time]);
    expect(result.arrivals).toEqual([trip.endTime]);
    expect(result.trips).toEqual([{ from: trip.time, to: trip.endTime }]);
  });

  // SoC deadlines are resolved by the solver and arrive on the plan rows, so the
  // client no longer re-derives them (trip usage + buffer, departure SoC, …).
  it('derives no SoC targets', () => {
    const result = collectEvSettings([
      trip,
      { id: 'd1', type: 'departure', time: '2026-05-02T08:00:00.000Z', soc_percent: 80 },
      { id: 'g1', type: 'target', time: '2026-05-02T09:00:00.000Z', soc_percent: 90 },
    ]);
    expect(result.targets).toBeUndefined();
    expect(result.departures).toEqual([trip.time, '2026-05-02T08:00:00.000Z']);
  });
});

describe('updateEvPanel', () => {
  const rows = [
    { timestampMs: Date.parse('2026-05-01T17:00:00.000Z'), ev_soc_percent: 40, ev_charge: 1, ev_charge_mode: 'max', ev_charge_A: 16, g2ev: 3600, ic: 25 },
    { timestampMs: Date.parse('2026-05-01T17:15:00.000Z'), ev_soc_percent: 55, ev_charge: 1, ev_charge_mode: 'max', ev_charge_A: 16, g2ev: 3600, ic: 25 },
  ];

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    resetPlanStore();
  });

  // The optimizer controller passes null whenever the EV toggle is off, and a default parameter
  // value does not cover null — so the panel has to normalise it itself.
  it('renders the schedule table when evSettings is null', () => {
    const evScheduleTable = document.createElement('table');

    expect(() => updateEvPanel(
      { evScheduleTable },
      rows,
      { evChargeTotal_kWh: 1.8 },
      15,
      null,
    )).not.toThrow();

    expect(evScheduleTable.innerHTML).toContain('EV SoC');
    expect(evScheduleTable.innerHTML).not.toContain('arrives');
  });

  it('annotates arrival and departure rows when evSettings is present', () => {
    const evScheduleTable = document.createElement('table');

    updateEvPanel({ evScheduleTable }, rows, { evChargeTotal_kWh: 1.8 }, 15, {
      arrivals: ['2026-05-01T17:00:00.000Z'],
      departures: ['2026-05-01T17:15:00.000Z'],
      trips: [],
    });

    expect(evScheduleTable.innerHTML).toContain('arrives');
    expect(evScheduleTable.innerHTML).toContain('leaves');
  });

  // The deadline comes from the solver's resolved target on the row, not from the
  // schedule entries — so the column follows what the LP actually enforced.
  it('shows the target column from the row-carried solver target', () => {
    const evScheduleTable = document.createElement('table');
    const withTarget = [rows[0], { ...rows[1], ev_target_soc_percent: 79.6 }];

    updateEvPanel({ evScheduleTable }, withTarget, { evChargeTotal_kWh: 1.8 }, 15, null);

    expect(evScheduleTable.innerHTML).toContain('Target');
    expect(evScheduleTable.innerHTML).toContain('target 80%');
  });

  it('reads EV grid cost and effective rate from the summary', () => {
    const els = {
      evScheduleTable: document.createElement('table'),
      evTabTotalCost: document.createElement('span'),
      evTabEffectiveRate: document.createElement('span'),
    };

    updateEvPanel(els, rows, {
      evChargeTotal_kWh: 1.8,
      evChargeGridCost_cents: 42.75,
      evChargeEffectiveRate_cents_per_kWh: 23.75,
    }, 15, null);

    expect(els.evTabTotalCost.textContent).toBe('42.8¢');
    expect(els.evTabEffectiveRate.textContent).toBe('23.8¢/kWh');
  });

  // The tab keeps no plan of its own: a view-toggle replay re-reads the store,
  // so it can never redraw a plan the store has already replaced.
  it('replays a view-toggle change from the plan store', () => {
    document.body.innerHTML = '<div id="ev-toggles"></div>';
    const els = {
      evViewToggles: document.getElementById('ev-toggles'),
      evScheduleTable: document.createElement('table'),
    };
    initEvPanelToggles(els);
    updateEvPanel(els, rows, { evChargeTotal_kWh: 1.8 }, 15, null);
    expect(els.evScheduleTable.innerHTML).toContain('55.0%');

    setPlan({
      rows: [{ ...rows[0], ev_soc_percent: 77 }],
      summary: { evChargeTotal_kWh: 0.9 },
    });
    document.querySelector('[data-res="60"]').dispatchEvent(new Event('click', { bubbles: true }));

    expect(els.evScheduleTable.innerHTML).toContain('77.0%');
    expect(els.evScheduleTable.innerHTML).not.toContain('55.0%');
  });
});
