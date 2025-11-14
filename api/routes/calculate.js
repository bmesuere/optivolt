import express from 'express';
import highsFactory from 'highs';

import { mapRowsToDess } from '../../lib/dess-mapper.js';
import { buildLP } from '../../lib/build-lp.js';
import { parseSolution } from '../../lib/parse-solution.js';
import { toHttpError } from '../http-errors.js';
import { getEffectiveConfigAndHints } from '../services/config-service.js';

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

router.post('/', async (_req, res, next) => {
  try {
    // Server-only: build both cfg and timing from persisted settings
    const { cfg, hints } = await getEffectiveConfigAndHints();

    const lpText = buildLP(cfg);
    const highs = await getHighsInstance();
    const result = highs.solve(lpText);

    const { rows, timestampsMs } = parseSolution(result, cfg, hints);
    const { perSlot } = mapRowsToDess(rows, cfg);
    for (let i = 0; i < rows.length; i++) rows[i].dess = perSlot[i];

    res.json({ status: result.Status, objectiveValue: result.ObjectiveValue, rows, timestampsMs });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

export default router;
