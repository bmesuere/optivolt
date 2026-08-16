import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { planAndMaybeWrite } from '../services/planner-service.ts';
import { getForecastTimeRange } from '../../lib/time-series-utils.ts';

const router = express.Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    assertCondition(
      body && typeof body === 'object' && !Array.isArray(body),
      400,
      'calculate payload must be an object',
    );
    assertOptionalBoolean(body.updateData, 'updateData');
    assertOptionalBoolean(body.writeToVictron, 'writeToVictron');

    const shouldUpdateData = body.updateData ?? false;
    const shouldWriteToVictron = body.writeToVictron ?? false;

    logCalculateCall(body, {
      updateData: shouldUpdateData,
      writeToVictron: shouldWriteToVictron,
    });

    const { cfg, timing, result, rows, summary, rebalanceWindow, rebalanceNudge } =
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
      rebalanceWindow,
      rebalanceNudge,
      // Extended horizon: prices past this instant are forecast, not actuals.
      pricesKnownUntilMs: cfg.pricesKnownUntilMs ?? null,
      // Canonical end of the classic day-ahead window, computed in the
      // server's timezone so every client slices the "Standard" view alike.
      standardWindowEndMs: new Date(getForecastTimeRange(timing.startMs).endIso).getTime(),
    });
  } catch (error) {
    logCalculateError(error);
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

function assertOptionalBoolean(value: unknown, field: string): asserts value is boolean | undefined {
  assertCondition(value === undefined || typeof value === 'boolean', 400, `${field} must be a boolean`);
}

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
