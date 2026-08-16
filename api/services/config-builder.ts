import { HttpError } from '../http-errors.ts';
import { loadSettings } from './settings-store.ts';
import { loadData, saveData } from './data-store.ts';
import { applyPredictionAdjustmentsToData, pruneExpiredPredictionAdjustments } from './prediction-adjustments.ts';
import { recordFullSocObservation } from './rebalance-nudge.ts';
import { extractWindow, extendSeriesWithForecast, getForecastTimeRange, getQuarterStart } from '../../lib/time-series-utils.ts';
import { fetchHaEntityState } from './ha-client.ts';
import { buildEvConfig } from './ev-config-builder.ts';
import { normalizeEvScheduleEntries, recordEvLastState } from './ev-schedule-entries.ts';
import type { SolverConfig, TimeSeries } from '../../lib/types.ts';
import type { Settings, Data } from '../types.ts';

function getSeriesEndMs(source: TimeSeries): number {
  const step = source.step ?? 15;
  return new Date(source.start).getTime() + source.values.length * step * 60_000;
}

/**
 * Build a fully resolved SolverConfig from stored settings + data.
 * Settings and data are already validated by their respective stores.
 * Throws 422 when there is insufficient future data to optimise.
 *
 * `nowMs` defaults to the start of the current slot so tests can call this
 * directly without worrying about timing. Production callers should pass a
 * pre-computed value so the same instant is used for both the window and the
 * returned timing.
 */
export function buildSolverConfigFromSettings(
  settings: Settings,
  data: Data,
  nowMs = getQuarterStart(new Date(), settings.stepSize_m),
  evState?: { pluggedIn: boolean; soc_percent: number },
): SolverConfig {
  // Extended horizon: append forecast prices past the end of the actual price
  // series. Actual values always win — the forecast never overrides them, and
  // pricesKnownUntilMs marks where actuals end so the UI can flag the rest.
  let importPrice = data.importPrice;
  let exportPrice = data.exportPrice;
  let pricesKnownUntilMs: number | undefined;
  if (settings.extendedHorizonDays > 0) {
    importPrice = extendSeriesWithForecast(data.importPrice, data.importPriceForecast);
    exportPrice = extendSeriesWithForecast(data.exportPrice, data.exportPriceForecast);
    if (importPrice !== data.importPrice || exportPrice !== data.exportPrice) {
      pricesKnownUntilMs = Math.min(getSeriesEndMs(data.importPrice), getSeriesEndMs(data.exportPrice));
    }
  }

  const loadEndMs   = getSeriesEndMs(data.load);
  const pvEndMs     = getSeriesEndMs(data.pv);
  const importEndMs = getSeriesEndMs(importPrice);
  const exportEndMs = getSeriesEndMs(exportPrice);
  // Clamp to the configured horizon. Series already in data.json are not
  // truncated when extendedHorizonDays is lowered (and the price forecast is
  // stored in full regardless), so without this the plan would keep running to
  // the end of whatever stale data happens to be persisted.
  const configuredEndMs = new Date(getForecastTimeRange(nowMs, settings.extendedHorizonDays).endIso).getTime();
  const endMs = Math.min(loadEndMs, pvEndMs, importEndMs, exportEndMs, configuredEndMs);

  // A series that starts after the plan window begins would be silently
  // zero-padded by extractWindow for the leading slots. Zero PV just means
  // "no sun yet" and is legitimate (e.g. a forecast that starts at sunrise),
  // but zero load or zero prices would make the solver plan against free
  // energy, so reject those outright.
  const mustCoverStart: Array<[string, TimeSeries]> = [
    ['load',        data.load],
    ['importPrice', importPrice],
    ['exportPrice', exportPrice],
  ];
  for (const [name, series] of mustCoverStart) {
    const seriesStartMs = new Date(series.start).getTime();
    if (seriesStartMs > nowMs) {
      throw new HttpError(422, `Series '${name}' starts after the plan window begins`, {
        details: {
          now:         new Date(nowMs).toISOString(),
          seriesStart: new Date(seriesStartMs).toISOString(),
        },
      });
    }
  }
  const stepMs = settings.stepSize_m * 60_000;
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new HttpError(422, 'Invalid solver step size');
  }
  const slotCount = Math.floor((endMs - nowMs) / stepMs);

  if (slotCount <= 0) {
    throw new HttpError(422, 'Insufficient future data', {
      details: {
        now:       new Date(nowMs).toISOString(),
        loadEnd:   new Date(loadEndMs).toISOString(),
        pvEnd:     new Date(pvEndMs).toISOString(),
        importEnd: new Date(importEndMs).toISOString(),
        exportEnd: new Date(exportEndMs).toISOString(),
      },
    });
  }

  const alignedEndMs = nowMs + slotCount * stepMs;

  const base: SolverConfig = {
    load_W:      extractWindow(data.load,   nowMs, alignedEndMs, settings.stepSize_m),
    pv_W:        extractWindow(data.pv,     nowMs, alignedEndMs, settings.stepSize_m),
    importPrice: extractWindow(importPrice, nowMs, alignedEndMs, settings.stepSize_m),
    exportPrice: extractWindow(exportPrice, nowMs, alignedEndMs, settings.stepSize_m),

    stepSize_m:                           settings.stepSize_m,
    batteryCapacity_Wh:                   settings.batteryCapacity_Wh,
    minSoc_percent:                       settings.minSoc_percent,
    maxSoc_percent:                       settings.maxSoc_percent,
    maxChargePower_W:                     settings.maxChargePower_W,
    maxDischargePower_W:                  settings.maxDischargePower_W,
    maxGridImport_W:                      settings.maxGridImport_W,
    maxGridExport_W:                      settings.maxGridExport_W,
    chargeEfficiency_percent:             settings.chargeEfficiency_percent,
    dischargeEfficiency_percent:          settings.dischargeEfficiency_percent,
    batteryCost_cent_per_kWh:             settings.batteryCost_cent_per_kWh,
    idleDrain_W:                          settings.idleDrain_W,
    terminalSocValuation:                 settings.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: settings.terminalSocCustomPrice_cents_per_kWh,
    evSocValue_cents_per_kWh:             settings.evSocValue_cents_per_kWh,
    // Clamp to maxSoc: a battery fuller than the configured ceiling (e.g. after lowering
    // maxSoc) would otherwise force an infeasible one-slot discharge in the LP.
    initialSoc_percent:                   Math.min(data.soc.value, settings.maxSoc_percent),
  };

  // Only meaningful when forecast slots actually made it into the window.
  if (pricesKnownUntilMs != null && pricesKnownUntilMs < alignedEndMs) {
    base.pricesKnownUntilMs = pricesKnownUntilMs;
  }

  if (settings.rebalanceEnabled) {
    // Math.ceil ensures the hold is never shorter than requested; Math.max(1, …) prevents 0-slot holds
    // from a bad/zero rebalanceHoldHours setting (which would immediately complete the cycle).
    const holdSlots = Math.max(1, Math.ceil(settings.rebalanceHoldHours / (settings.stepSize_m / 60)));
    const startMs_ = data.rebalanceState?.startMs ?? null;
    const slotsElapsed = startMs_ != null
      ? Math.floor((nowMs - startMs_) / (settings.stepSize_m * 60_000))
      : 0;
    const remainingSlots = startMs_ != null
      ? Math.max(0, holdSlots - slotsElapsed)
      : holdSlots;
    base.rebalanceHoldSlots = holdSlots;
    base.rebalanceRemainingSlots = remainingSlots;
    base.rebalanceTargetSoc_percent = settings.maxSoc_percent;
    // On an extended horizon, keep "hold once" a day-1 decision: the window
    // must start within the first 24 h instead of drifting days out. This also
    // caps the start_balance binary count at one day's worth of slots.
    if (settings.extendedHorizonDays > 0) {
      base.rebalanceMaxStartSlot = Math.max(0, Math.floor((24 * 60) / settings.stepSize_m) - 1);
    }
  }

  const ev = buildEvConfig(settings, data.evScheduleEntries ?? [], evState, nowMs, base.load_W.length);
  if (ev) base.ev = ev;

  return base;
}

export async function getSolverInputs(): Promise<{ cfg: SolverConfig; timing: { startMs: number; stepMin: number }; data: Data; settings: Settings }> {
  const [settings, loadedData] = await Promise.all([loadSettings(), loadData()]);
  const startMs = getQuarterStart(new Date(), settings.stepSize_m);

  // Read the live EV state before normalizing schedule entries: pruning overdue departures and
  // converting departed trips both depend on an up-to-date plug state (persisted as evLastState).
  let evState: { pluggedIn: boolean; soc_percent: number } | undefined;
  if (settings.evEnabled && settings.evSocSensor && settings.evPlugSensor) {
    try {
      const [socEntity, plugEntity] = await Promise.all([
        fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evSocSensor }),
        fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evPlugSensor }),
      ]);
      // Clamp so a misreporting sensor (e.g. 255 for "unknown") cannot distort the plan; NaN passes through.
      const soc_percent = Math.min(100, Math.max(0, parseFloat(socEntity.state)));
      const pluggedIn = plugEntity.state !== 'disconnected'
        && plugEntity.state !== 'unavailable'
        && plugEntity.state !== 'unknown'
        && plugEntity.state !== 'off';
      // soc_percent may be NaN (e.g. the car is away and the sensor is unavailable);
      // an away-charging plan can still proceed using the manual arrival-SoC override.
      evState = { pluggedIn, soc_percent };
    } catch (err) {
      console.warn('Could not read EV state from HA:', err instanceof Error ? err.message : String(err));
    }
  }

  const withEvState = recordEvLastState(loadedData, evState, startMs);
  const pruned = pruneExpiredPredictionAdjustments(withEvState, startMs);
  const prunedEv = normalizeEvScheduleEntries(pruned.data, startMs);
  let data = prunedEv.data;
  let shouldSaveData = withEvState !== loadedData || pruned.changed || prunedEv.changed;

  const observedData = recordFullSocObservation(data);
  if (observedData !== data) {
    data = observedData;
    shouldSaveData = true;
  }

  if (shouldSaveData) await saveData(data);

  const adjustedData = applyPredictionAdjustmentsToData(data);
  const cfg = buildSolverConfigFromSettings(settings, adjustedData, startMs, evState);
  return { cfg, timing: { startMs, stepMin: settings.stepSize_m }, data, settings };
}
