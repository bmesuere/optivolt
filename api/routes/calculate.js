import express from 'express';
import highsFactory from 'highs';

import { mapRowsToDess } from '../../lib/dess-mapper.js';
import { buildLP } from '../../lib/build-lp.js';
import { parseSolution } from '../../lib/parse-solution.js';
import { toHttpError } from '../http-errors.js';
import { getSolverInputs } from '../services/solver-input-service.js';
import { refreshSeriesFromVrmAndPersist } from '../services/vrm-refresh.js';
import { loadData } from '../services/data-store.js';

const router = express.Router();

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

router.post('/', async (req, res, next) => {
  try {
    const shouldUpdateData = !!req.body?.updateData;

    if (shouldUpdateData) {
      try {
        // Fetch from VRM and save to data.json
        await refreshSeriesFromVrmAndPersist();
      } catch (vrmError) {
        // Don't kill the calculation; just log the error and proceed with old data
        console.error("Failed to refresh VRM data before calculation:", vrmError.message);
        // We could throw here, but user might want to calculate with stale data
        // if VRM is down. Let's proceed.
      }
    }

    // This will read the freshly persisted data (if updated)
    const { cfg, hints } = await getSolverInputs();

    const lpText = buildLP(cfg);
    const highs = await getHighsInstance();
    const result = highs.solve(lpText);

    const { rows, timestampsMs } = parseSolution(result, cfg, hints);
    const { perSlot } = mapRowsToDess(rows, cfg);
    for (let i = 0; i < rows.length; i++) rows[i].dess = perSlot[i];

    // Re-load data to get the tsStart string (which might have been updated)
    const data = await loadData();

    res.json({
      status: result.Status,
      objectiveValue: result.ObjectiveValue,
      rows,
      timestampsMs,
      // Add the new fields for the UI
      initialSoc_percent: cfg.initialSoc_percent,
      tsStart: data.tsStart,
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

export default router;
