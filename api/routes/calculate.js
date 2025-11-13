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

function parseTimingHints(timing = {}) {
  if (typeof timing !== 'object' || timing === null) return {};
  const startMs = Number(timing.startMs);
  const stepMin = Number(timing.stepMin);
  const timestampsMs = Array.isArray(timing.timestampsMs)
    ? timing.timestampsMs.map((v) => Number(v)).filter(Number.isFinite)
    : undefined;
  return {
    timestampsMs: timestampsMs?.length ? timestampsMs : undefined,
    startMs: Number.isFinite(startMs) ? startMs : undefined,
    stepMin: Number.isFinite(stepMin) ? stepMin : undefined,
  };
}

router.post('/', async (req, res, next) => {
  try {
    // 1) Build config from server-side settings
    const { cfg, hints: settingsHints } = await getEffectiveConfigAndHints();

    // 2) Optional client timing overrides (timestamps/start/step) – data stays server-side
    const clientHints = parseTimingHints(req.body?.timing);
    const hints = { ...settingsHints, ...clientHints };

    // 3) Solve
    const lpText = buildLP(cfg);
    const highs = await getHighsInstance();
    const result = highs.solve(lpText);

    // 4) Decode + DESS mapping
    const { rows, timestampsMs } = parseSolution(result, cfg, hints);
    const { perSlot } = mapRowsToDess(rows, cfg);
    for (let i = 0; i < rows.length; i++) rows[i].dess = perSlot[i];

    res.json({ status: result.Status, objectiveValue: result.ObjectiveValue, rows, timestampsMs });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

export default router;
