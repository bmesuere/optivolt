import express from 'express';
import highsFactory from 'highs';

import { mapRowsToDess, Strategy, Restrictions, FeedIn } from '../../lib/dess-mapper.js';
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
 * Shared pipeline:
 *  - optionally refresh VRM data
 *  - load settings + data
 *  - build LP
 *  - solve
 *  - parse solution
 *  - attach DESS mapping
 *
 * Returns { cfg, data, result, rows, timestampsMs }.
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
  const { cfg, hints, data } = await getSolverInputs();

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const result = highs.solve(lpText);

  const { rows } = parseSolution(result, cfg, hints);
  const { perSlot } = mapRowsToDess(rows, cfg);

  for (let i = 0; i < rows.length; i++) {
    rows[i].dess = perSlot[i];
  }

  return { cfg, data, result, rows };
}

/**
 * Write the plan to Victron via MQTT.
 */
async function writePlanToVictron(cfg, rows) {
  const batteryCapacity_Wh = cfg.batteryCapacity_Wh;

  const slotCount = Math.min(DESS_SLOTS, rows.length);

  await setDynamicEssSchedule(rows, slotCount, {
    batteryCapacity_Wh,
  });
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

    const { cfg, data, result, rows } = await computePlan({
      updateData: shouldUpdateData,
    });

    if (writeToVictron) {
      await writePlanToVictron(cfg, rows);
    }

    res.json({
      status: result.Status,
      objectiveValue: result.ObjectiveValue,
      rows,
      // For UI – this reflects the SoC from the data layer (MQTT-backed)
      initialSoc_percent: cfg.initialSoc_percent,
      tsStart: data.tsStart,
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

// ------------------- New /calculate/next-quarter ----------------------

/**
 * POST /calculate/next-quarter
 *
 * Optional body:
 * {
 *   "updateData": true,
 *   "writeToVictron": true    // optional: write schedule to Victron
 * }
 *
 * Returns a compact summary for the first slot ("next quarter").
 */
router.post('/next-quarter', async (req, res, next) => {
  try {
    const shouldUpdateData = !!req.body?.updateData;
    const writeToVictron = !!req.body?.writeToVictron;

    const { cfg, data, result, rows } = await computePlan({
      updateData: shouldUpdateData,
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('Solver returned empty plan');
    }

    if (writeToVictron) {
      await writePlanToVictron(cfg, rows);
    }

    const firstRow = rows[0];
    const firstDess = firstRow.dess || {};

    const slotIndex = 0;

    const tsStart = data.tsStart ?? null;
    const stepSize_m = cfg.stepSize_m ?? null;

    const batteryCapacity_Wh = cfg.batteryCapacity_Wh;
    const socNow_percent = cfg.initialSoc_percent;

    const targetWh = typeof firstDess.socTarget_Wh === 'number' ? firstDess.socTarget_Wh : firstRow.soc;

    const socTarget_percent = batteryCapacity_Wh > 0 ? (targetWh / batteryCapacity_Wh) * 100 : null;

    const strategyCode = typeof firstDess.strategy === 'number' ? firstDess.strategy : Strategy.unknown;
    const restrictionsCode = typeof firstDess.restrictions === 'number' ? firstDess.restrictions : Restrictions.unknown;
    const feedinCode = typeof firstDess.feedin === 'number' ? firstDess.feedin : -1;

    const strategy = strategyName(strategyCode);
    const restrictions = restrictionsName(restrictionsCode);
    const feedin = feedinName(feedinCode);

    res.json({
      status: result.Status,
      objectiveValue: result.ObjectiveValue,

      tsStart,
      stepSize_m,
      slotIndex,

      strategy,
      strategyCode,
      restrictions,
      restrictionsCode,
      feedin,
      feedinCode,
      feedinAllowed: feedinCode === FeedIn.allowed,

      socNow_percent,
      socTarget_percent,
      batteryCapacity_Wh,
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to calculate next quarter plan'));
  }
});

// ---------------------- small mapping helpers ------------------------

function strategyName(code) {
  switch (code) {
    case Strategy.targetSoc:
      return 'target_soc';
    case Strategy.selfConsumption:
      return 'self_consumption';
    case Strategy.proBattery:
      return 'pro_battery';
    case Strategy.proGrid:
      return 'pro_grid';
    default:
      return 'unknown';
  }
}

function restrictionsName(code) {
  switch (code) {
    case Restrictions.none:
      return 'none';
    case Restrictions.gridToBattery:
      return 'grid_to_battery';
    case Restrictions.batteryToGrid:
      return 'battery_to_grid';
    case Restrictions.both:
      return 'both';
    default:
      return 'unknown';
  }
}

function feedinName(code) {
  if (code === FeedIn.allowed) return 'allowed';
  if (code === FeedIn.blocked) return 'blocked';
  return 'unknown';
}

export default router;
