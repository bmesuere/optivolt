import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSolverConfigFromSettings } from '../../api/services/config-builder.ts';
import { selectSolveOptions } from '../../api/services/planner-service.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
import highsFactory from '../../vendor/highs-build/highs.js';

/**
 * Full-pipeline integration test for the extended horizon: persisted-style
 * data (actual prices + forecast tail) → config-builder merge → LP → a REAL
 * HiGHS solve → parsed rows. Guards the interplay that unit tests mock away.
 */

const NOW_ISO = '2024-01-01T12:00:00Z';
const SLOT_MS = 15 * 60_000;
const T = 384; // 4 days

const settings = {
  stepSize_m: 15,
  batteryCapacity_Wh: 20000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 3600,
  maxDischargePower_W: 4000,
  maxGridImport_W: 5000,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 2,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  evSocValue_cents_per_kWh: 0,
  extendedHorizonDays: 3,
  evEnabled: true,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evBatteryCapacity_kWh: 60,
  evChargeEfficiency_percent: 90,
  evTripSocBuffer_percent: 20,
};

function buildData() {
  const nowMs = new Date(NOW_ISO).getTime();
  // Daily price shape so the solver has real structure to optimise against.
  const price = (i) => {
    const h = ((i % 96) / 4 + 12) % 24; // slot 0 = 12:00
    return Math.round((22 + 10 * Math.sin(((h - 6) / 24) * 2 * Math.PI)) * 100) / 100;
  };
  return {
    load: { start: NOW_ISO, step: 15, values: Array.from({ length: T }, () => 400) },
    pv: {
      start: NOW_ISO, step: 15,
      values: Array.from({ length: T }, (_, i) => {
        const h = ((i % 96) / 4 + 12) % 24;
        return h > 8 && h < 19 ? 2500 : 0;
      }),
    },
    // Actual prices cover only the first 24 h; the forecast continues from there.
    importPrice: { start: NOW_ISO, step: 15, values: Array.from({ length: 96 }, (_, i) => price(i)) },
    exportPrice: { start: NOW_ISO, step: 15, values: Array.from({ length: 96 }, (_, i) => price(i) * 0.4) },
    importPriceForecast: {
      start: new Date(nowMs + 96 * SLOT_MS).toISOString(), step: 15,
      values: Array.from({ length: T - 96 }, (_, i) => price(96 + i) + 1),
    },
    exportPriceForecast: {
      start: new Date(nowMs + 96 * SLOT_MS).toISOString(), step: 15,
      values: Array.from({ length: T - 96 }, (_, i) => (price(96 + i) + 1) * 0.4),
    },
    soc: { timestamp: NOW_ISO, value: 50 },
    // "80% in 3 days": a target far beyond the standard horizon.
    evScheduleEntries: [{
      id: 'tgt1', type: 'target', time: '2024-01-04T11:00:00Z', soc_percent: 80,
      createdAt: NOW_ISO, updatedAt: NOW_ISO,
    }],
  };
}

describe('extended horizon — full pipeline with real HiGHS solve', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('solves a 4-day plan with merged forecast prices and a multi-day EV target', async () => {
    const nowMs = new Date(NOW_ISO).getTime();
    const { cfg, pricesKnownUntilMs } = buildSolverConfigFromSettings(
      settings, buildData(), nowMs,
      { pluggedIn: true, soc_percent: 30 },
    );

    // The merge extended the horizon to the full 4 days, actuals first.
    expect(cfg.load_W.length).toBe(T);
    expect(pricesKnownUntilMs).toBe(nowMs + 96 * SLOT_MS);
    // Forecast slots carry the +1 offset applied above.
    expect(cfg.importPrice[96]).toBeCloseTo(cfg.importPrice[0] + 1, 6);

    // The multi-day EV target survived into the solver config: the 11:00
    // day-4 deadline is boundary slot 284, pinned at the slot before it.
    expect(cfg.ev).toBeDefined();
    expect(cfg.ev.targets).toEqual([{ slot: 283, soc_Wh: 48000 }]);

    // Solve with the production option selector (EV binaries, no rebalance →
    // the tight gap). No duration assertion here: fake timers are active, so
    // performance.now() would not measure anything real anyway.
    const solveOptions = selectSolveOptions(cfg);
    expect(solveOptions).toEqual({ mip_rel_gap: 0.005, mip_abs_gap: 0.01, time_limit: 30 });

    const highs = await highsFactory({});
    const lp = buildLP(cfg);
    const result = highs.solve(lp, solveOptions);

    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, { startMs: nowMs, stepMin: 15 });
    expect(rows).toHaveLength(T);
    // The EV reaches its 3-days-out target by the deadline.
    expect(rows[283].ev_soc_percent).toBeGreaterThanOrEqual(79.9);
    // Load is met in every slot (LP balance holds through the forecast region).
    for (const r of [rows[0], rows[200], rows[383]]) {
      expect(r.g2l + r.pv2l + r.b2l).toBeCloseTo(r.load, 1);
    }
  }, 60_000);
});
