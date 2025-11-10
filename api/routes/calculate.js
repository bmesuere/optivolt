import express from 'express';
import highsFactory from 'highs';

import { mapRowsToDess } from '../../lib/dess-mapper.js';
import { buildLP } from '../../lib/build-lp.js';
import { parseSolution } from '../../lib/parse-solution.js';
import { assertCondition, toHttpError } from '../http-errors.js';

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

function parseTimingHints(timing = {}) {
  if (typeof timing !== 'object' || timing === null) {
    return {};
  }

  const startMs = Number(timing.startMs);
  const stepMin = Number(timing.stepMin);

  const timestampsMs = Array.isArray(timing.timestampsMs)
    ? timing.timestampsMs.map((value) => Number(value)).filter(Number.isFinite)
    : undefined;

  return {
    timestampsMs: timestampsMs?.length ? timestampsMs : undefined,
    startMs: Number.isFinite(startMs) ? startMs : undefined,
    stepMin: Number.isFinite(stepMin) ? stepMin : undefined,
  };
}

router.post('/', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const cfg = body.config ?? body;

    assertCondition(cfg && typeof cfg === 'object' && !Array.isArray(cfg), 400, 'config payload must be an object');

    const lpText = buildLP(cfg);
    const highs = await getHighsInstance();
    const result = highs.solve(lpText);

    const hints = parseTimingHints(body.timing);
    const { rows, timestampsMs } = parseSolution(result, cfg, hints);

    const { perSlot } = mapRowsToDess(rows, cfg);
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].dess = perSlot[i];
    }

    res.json({ status: result.Status, objectiveValue: result.ObjectiveValue, rows, timestampsMs });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

export default router;
