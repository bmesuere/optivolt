import express from 'express';

import highsFactory from "highs";
import { buildLP } from "../src/build-lp.js";
import { parseSolution } from "../src/parse-solution.js";

const app = express();
const port = 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Optivolt API is running.');
});

app.post('/calculate', async (req, res) => {
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

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
