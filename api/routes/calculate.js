import express from 'express';
import highsFactory from 'highs';

import { mapRowsToDess } from '../../lib/dess-mapper.js';
import { buildLP } from '../../lib/build-lp.js';
import { parseSolution } from '../../lib/parse-solution.js';
import { toHttpError } from '../http-errors.js';
import { loadSolverInputs } from '../services/settings-store.js';

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

function parseTimingHints(timing = {}, timeseries = {}, cfg = {}) {
  if (typeof timing !== 'object' || timing === null) {
    timing = {};
  }

  const startMs = Number(timing.startMs);
  const stepMin = Number(timing.stepMin);

  const timestampsMs = Array.isArray(timing.timestampsMs)
    ? timing.timestampsMs.map((value) => Number(value)).filter(Number.isFinite)
    : undefined;

  let fallbackStartMs;
  if (typeof timeseries.tsStart === 'string' && timeseries.tsStart.trim().length > 0) {
    const parsed = Date.parse(timeseries.tsStart);
    fallbackStartMs = Number.isFinite(parsed) ? parsed : undefined;
  }

  return {
    timestampsMs: timestampsMs?.length ? timestampsMs : undefined,
    startMs: Number.isFinite(startMs) ? startMs : fallbackStartMs,
    stepMin: Number.isFinite(stepMin) ? stepMin : (Number(cfg.stepSize_m) || 15),
  };
}

router.post('/', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const { config: cfg, timeseries } = await loadSolverInputs();

    const lpText = buildLP(cfg);
    const highs = await getHighsInstance();
    const result = highs.solve(lpText);

    const hints = parseTimingHints(body.timing, timeseries, cfg);
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
