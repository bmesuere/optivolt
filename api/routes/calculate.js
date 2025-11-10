import express from 'express';
import highsFactory from "highs";

import { buildLP } from "../../lib/build-lp.js";
import { parseSolution } from "../../lib/parse-solution.js";
import { mapRowsToDess } from "../../lib/dess-mapper.js";

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const body = req.body ?? {};
    const cfg = body.config ?? body;
    const timing = body.timing ?? {};

    const lpText = buildLP(cfg);
    const highs = await highsFactory({});
    const result = highs.solve(lpText);
    const startMs = Number(timing.startMs);
    const stepMin = Number(timing.stepMin);
    const hints = {
      timestampsMs: Array.isArray(timing.timestampsMs) ? timing.timestampsMs : undefined,
      startMs: Number.isFinite(startMs) ? startMs : undefined,
      stepMin: Number.isFinite(stepMin) ? stepMin : undefined,
    };
    const { rows, timestampsMs } = parseSolution(result, cfg, hints);

    const { perSlot } = mapRowsToDess(rows, cfg);
    for (let i = 0; i < rows.length; i++) {
      rows[i].dess = perSlot[i];
    }

    res.json({ status: result.Status, objectiveValue: result.ObjectiveValue, rows, timestampsMs });
  } catch (error) {
    console.error("Calculation failed:", error);

    res.status(500).json({
      error: 'An internal server error occurred.',
      message: error.message
    });
  }
});

export default router;
