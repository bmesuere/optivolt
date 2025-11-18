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
  const { cfg, timing, data } = await getSolverInputs();

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const result = highs.solve(lpText);

  const rows = parseSolution(result, cfg, timing);
  const { perSlot } = mapRowsToDess(rows, cfg);

  for (let i = 0; i < rows.length; i++) {
    rows[i].dess = perSlot[i];
  }

  return { cfg, data, result, rows };
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

    const { cfg, data, result, rows } = await computePlan({
      updateData: shouldUpdateData,
    });

    if (writeToVictron) {
      await writePlanToVictron(rows);
    }

    res.json({
      status: result.Status,
      objectiveValue: result.ObjectiveValue,
      rows,
      initialSoc_percent: cfg.initialSoc_percent,
      tsStart: data.tsStart,
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

export default router;
