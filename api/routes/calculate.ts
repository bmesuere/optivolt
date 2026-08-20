import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, HttpError, toHttpError } from '../http-errors.ts';
import { SolverStatusError } from '../../lib/parse-solution.ts';
import { planAndMaybeWrite, getLastPlan, type ComputePlanResult } from '../services/planner-service.ts';
import { getForecastTimeRange } from '../../lib/time-series-utils.ts';
import { getSolverInputsVersion } from '../services/solver-inputs-version.ts';

const router = express.Router();

function planToResponse({ cfg, computedAtMs, pricesKnownUntilMs, timing, result, rows, summary, rebalanceWindow, rebalanceNudge }: ComputePlanResult) {
  return {
    solverStatus: result.Status,
    objectiveValue: result.ObjectiveValue,
    computedAtMs,
    rows,
    initialSoc_percent: cfg.initialSoc_percent,
    tsStart: new Date(timing.startMs).toISOString(),
    summary,
    rebalanceWindow,
    rebalanceNudge,
    // Extended horizon: prices past this instant are forecast, not actuals.
    pricesKnownUntilMs,
    // Canonical end of the classic day-ahead window, computed in the
    // server's timezone so every client slices the "Standard" view alike.
    standardWindowEndMs: new Date(getForecastTimeRange(timing.startMs).endIso).getTime(),
  };
}

// A plan is served from cache only while its horizon still covers "now" —
// after that it can't answer what the system should be doing anymore.
function planCoversNow(plan: ComputePlanResult): boolean {
  const lastRow = plan.rows[plan.rows.length - 1];
  if (!lastRow) return false;
  return Date.now() < lastRow.timestampMs + plan.timing.stepMin * 60_000;
}

router.get('/last', (_req: Request, res: Response) => {
  const plan = getLastPlan();
  // Only an optimal plan is worth serving: computePlan caches every solve,
  // and an infeasible/unbounded one holds all-zero garbage rows.
  if (!plan || plan.result.Status !== 'Optimal' || !planCoversNow(plan)) {
    res.status(404).json({ error: 'No current plan available' });
    return;
  }
  res.json({
    ...planToResponse(plan),
    // False when settings/data changed since this plan solved — the client
    // may still paint it, but must not skip its own recompute.
    inputsCurrent: plan.inputsVersion === getSolverInputsVersion(),
  });
});

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

    const plan = await planAndMaybeWrite({
      updateData: shouldUpdateData,
      writeToVictron: shouldWriteToVictron,
    });

    res.json(planToResponse(plan));
  } catch (error) {
    logCalculateError(error);
    if (error instanceof SolverStatusError) {
      next(new HttpError(502, error.message, { cause: error }));
      return;
    }
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
