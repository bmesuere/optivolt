import express from 'express';
import { toHttpError } from '../http-errors.js';
import { planAndMaybeWrite } from '../services/planner-service.js';

const router = express.Router();

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
    const body = req.body ?? {};
    const shouldUpdateData = !!body.updateData;
    const shouldWriteToVictron = !!body.writeToVictron;

    // minimal logging: call + parsed parameters
    logCalculateCall(body, {
      updateData: shouldUpdateData,
      writeToVictron: shouldWriteToVictron,
    });

    const { cfg, data, timing, result, rows, summary } =
      await planAndMaybeWrite({
        updateData: shouldUpdateData,
        writeToVictron: shouldWriteToVictron,
      });

    res.json({
      solverStatus: result.Status,
      objectiveValue: result.ObjectiveValue,
      rows,
      initialSoc_percent: cfg.initialSoc_percent,
      tsStart: new Date(timing.startMs).toISOString(),
      summary,
    });
  } catch (error) {
    logCalculateError(error);
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

function logCalculateCall(rawBody, parsed) {
  const timestamp = new Date().toISOString();
  console.log('[calculate] request', {
    timestamp,
    rawBody: rawBody ?? null,
    parsed,
  });
}

function logCalculateError(error) {
  const timestamp = new Date().toISOString();
  console.error('[calculate] error', {
    timestamp,
    message: error?.message,
    name: error?.name,
    stack: error?.stack,
  });
}

export default router;
