import express from 'express';
import highsFactory from "highs";

import { buildLP } from "../../lib/build-lp.js";
import { parseSolution } from "../../lib/parse-solution.js";

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const cfg = req.body;

    const lpText = buildLP(cfg);
    const highs = await highsFactory({});
    const result = highs.solve(lpText);
    const { rows } = parseSolution(result, cfg);

    res.json({ status: result.Status, objectiveValue: result.ObjectiveValue, rows });
  } catch (error) {
    console.error("Calculation failed:", error);

    res.status(500).json({
      error: 'An internal server error occurred.',
      message: error.message
    });
  }
});

export default router;
