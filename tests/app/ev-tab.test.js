// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { collectEvSettings, updateEvPanel } from '../../app/src/ev-tab.js';

describe('collectEvSettings — trips', () => {
  const trip = {
    id: 't1',
    type: 'trip',
    time: '2026-05-01T08:00:00.000Z',
    endTime: '2026-05-01T17:00:00.000Z',
    usage_percent: 25,
  };

  it('contributes a departure, an arrival, an away span, and a derived target', () => {
    const result = collectEvSettings([trip], 20);
    expect(result.departures).toEqual([trip.time]);
    expect(result.arrivals).toEqual([trip.endTime]);
    expect(result.trips).toEqual([{ from: trip.time, to: trip.endTime }]);
    expect(result.targets).toEqual([{ time: trip.time, soc_percent: 45 }]); // 25 + 20% buffer
  });

  it('caps the derived target at 100%', () => {
    const result = collectEvSettings([{ ...trip, usage_percent: 95 }], 20);
    expect(result.targets).toEqual([{ time: trip.time, soc_percent: 100 }]);
  });

  it('derives no target for a trip without a usage estimate', () => {
    const { usage_percent: _unused, ...noUsage } = trip;
    const result = collectEvSettings([noUsage], 20);
    expect(result.targets).toEqual([]);
    expect(result.trips).toEqual([{ from: trip.time, to: trip.endTime }]);
  });
});

describe('updateEvPanel', () => {
  const rows = [
    { timestampMs: Date.parse('2026-05-01T17:00:00.000Z'), ev_soc_percent: 40, ev_charge: 1, ev_charge_mode: 'max', ev_charge_A: 16, g2ev: 3600, ic: 25 },
    { timestampMs: Date.parse('2026-05-01T17:15:00.000Z'), ev_soc_percent: 55, ev_charge: 1, ev_charge_mode: 'max', ev_charge_A: 16, g2ev: 3600, ic: 25 },
  ];

  afterEach(() => {
    document.body.innerHTML = '';
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

  it('annotates arrival, departure, and target rows when evSettings is present', () => {
    const evScheduleTable = document.createElement('table');

    updateEvPanel({ evScheduleTable }, rows, { evChargeTotal_kWh: 1.8 }, 15, {
      arrivals: ['2026-05-01T17:00:00.000Z'],
      departures: ['2026-05-01T17:15:00.000Z'],
      targets: [{ time: '2026-05-01T17:15:00.000Z', soc_percent: 80 }],
      trips: [],
    });

    expect(evScheduleTable.innerHTML).toContain('arrives');
    expect(evScheduleTable.innerHTML).toContain('leaves');
    expect(evScheduleTable.innerHTML).toContain('target 80%');
  });
});
