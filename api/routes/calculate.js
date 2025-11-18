import express from 'express';
import highsFactory from 'highs';

import { mapRowsToDess } from '../../lib/dess-mapper.js';
import { buildLP } from '../../lib/build-lp.js';
import { parseSolution } from '../../lib/parse-solution.js';
import { toHttpError } from '../http-errors.js';
import { getSolverInputs } from '../services/solver-input-service.js';
import { refreshSeriesFromVrmAndPersist } from '../services/vrm-refresh.js';
import { setDynamicEssSchedule } from '../services/mqtt-service.js';

const router = express.Router();

// How many slots we push into Dynamic ESS
const DESS_SLOTS = 4;

let highsPromise;
async function getHighsInstance() {
  if (!highsPromise) {
    highsPromise = highsFactory({}).catch((error) => {
      highsPromise = undefined;
      throw error;
    });
  }
  return highsPromise;
}

/**
 * Build high-level summary numbers for the plan:
 *  - totals for load / PV
 *  - load served from grid / battery / PV
 *  - import energy & energy-weighted avg import price
 *  - tipping point from DESS diagnostics
 */
function buildPlanSummary(rows, cfg, dessDiagnostics = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      loadTotal_kWh: 0,
      pvTotal_kWh: 0,
      loadFromGrid_kWh: 0,
      loadFromBattery_kWh: 0,
      loadFromPv_kWh: 0,
      importEnergy_kWh: 0,
      avgImportPrice_cents_per_kWh: null,
      firstSegmentTippingPoint_cents_per_kWh: dessDiagnostics.firstSegmentTippingPoint_cents_per_kWh ?? null,
    };
  }

  const stepMinutes = Number(cfg.stepSize_m ?? 15);
  const stepHours = Number.isFinite(stepMinutes) && stepMinutes > 0 ? stepMinutes / 60 : 0.25;
  const W2kWh = (x) => (Number(x) || 0) * stepHours / 1000;

  let loadTotal = 0;
  let pvTotal = 0;
  let loadFromGrid = 0;
  let loadFromBattery = 0;
  let loadFromPv = 0;
  let importEnergy = 0;
  let priceTimesEnergy = 0;

  for (const row of rows) {
    const loadK = W2kWh(row.load);
    const pvK = W2kWh(row.pv);
    const g2lK = W2kWh(row.g2l);
    const b2lK = W2kWh(row.b2l);
    const pv2lK = W2kWh(row.pv2l);
    const impK = W2kWh(row.imp);

    loadTotal += loadK;
    pvTotal += pvK;
    loadFromGrid += g2lK;
    loadFromBattery += b2lK;
    loadFromPv += pv2lK;
    importEnergy += impK;

    const price = Number(row.ic);
    if (impK > 0 && Number.isFinite(price)) {
      priceTimesEnergy += price * impK;
    }
  }

  const avgImportPrice = importEnergy > 0 ? priceTimesEnergy / importEnergy : null;

  return {
    loadTotal_kWh: loadTotal,
    pvTotal_kWh: pvTotal,
    loadFromGrid_kWh: loadFromGrid,
    loadFromBattery_kWh: loadFromBattery,
    loadFromPv_kWh: loadFromPv,
    importEnergy_kWh: importEnergy,
    avgImportPrice_cents_per_kWh: avgImportPrice,
    firstSegmentTippingPoint_cents_per_kWh: dessDiagnostics.firstSegmentTippingPoint_cents_per_kWh ?? null,
  };
}

/**
 * Shared pipeline:
 *  - optionally refresh VRM data
 *  - load settings + data
 *  - build LP
 *  - solve
 *  - parse solution
 *  - attach DESS mapping
 *
 * Returns { cfg, data, result, rows, summary, dessDiagnostics }.
 */
async function computePlan({ updateData = false } = {}) {
  if (updateData) {
    try {
      // Fetch from VRM and save to data.json
      await refreshSeriesFromVrmAndPersist();
    } catch (vrmError) {
      // Don't kill the calculation; just log the error and proceed with old data
      console.error(
        'Failed to refresh VRM data before calculation:',
        vrmError?.message ?? String(vrmError),
      );
    }
  }

  // This will read the (possibly freshly) persisted data
  const { cfg, timing, data } = await getSolverInputs();

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const result = highs.solve(lpText);

  const rows = parseSolution(result, cfg, timing);
  const { perSlot, diagnostics } = mapRowsToDess(rows, cfg);
  const dessDiagnostics = diagnostics;

  for (let i = 0; i < rows.length; i++) {
    rows[i].dess = perSlot[i];
  }

  const summary = buildPlanSummary(rows, cfg, dessDiagnostics);

  return { cfg, data, result, rows, summary, dessDiagnostics };
}

/**
 * Write the plan to Victron via MQTT.
 */
async function writePlanToVictron(rows) {
  const slotCount = Math.min(DESS_SLOTS, rows.length);

  await setDynamicEssSchedule(rows, slotCount);
}

// ------------------------- Existing /calculate -------------------------

/**
 * POST /calculate
 *
 * Optional body:
 * {
 *   "updateData": true,
 *   "writeToVictron": true    // optional: write schedule to Victron
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const shouldUpdateData = !!req.body?.updateData;
    const writeToVictron = !!req.body?.writeToVictron;

    const { cfg, data, result, rows, summary, dessDiagnostics } = await computePlan({
      updateData: shouldUpdateData,
    });

    if (writeToVictron) {
      await writePlanToVictron(rows);
    }

    res.json({
      solverStatus: result.Status,
      objectiveValue: result.ObjectiveValue,
      rows,
      initialSoc_percent: cfg.initialSoc_percent,
      tsStart: data.tsStart,
      summary,
      dessDiagnostics,
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

export default router;
