import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { toHttpError } from '../http-errors.ts';
import { planAndMaybeWrite } from '../services/planner-service.ts';

const router = express.Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    const shouldUpdateData = !!body.updateData;
    const shouldWriteToVictron = !!body.writeToVictron;

    logCalculateCall(body, {
      updateData: shouldUpdateData,
      writeToVictron: shouldWriteToVictron,
    });

    const { cfg, timing, result, rows, summary, dessDiff, rebalanceWindow } =
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
      dessDiff,
      rebalanceWindow,
    });
  } catch (error) {
    logCalculateError(error);
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

function logCalculateCall(rawBody: unknown, parsed: { updateData: boolean; writeToVictron: boolean }): void {
  console.log('[calculate] request', {
    timestamp: new Date().toISOString(),
    rawBody: rawBody ?? null,
    parsed,
  });
}

function logCalculateError(error: unknown): void {
  const err = error instanceof Error ? error : undefined;
  console.error('[calculate] error', {
    timestamp: new Date().toISOString(),
    message: err?.message,
    name: err?.name,
    stack: err?.stack,
  });
}

export default router;
