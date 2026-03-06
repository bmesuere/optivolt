import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getLatestEvSchedule, getCurrentEvSlot } from '../services/planner-service.ts';
import { HttpError, toHttpError } from '../http-errors.ts';

const router = express.Router();

function requireSchedule(): NonNullable<ReturnType<typeof getLatestEvSchedule>> {
  const schedule = getLatestEvSchedule();
  if (schedule === null) throw new HttpError(404, 'No plan has been computed yet');
  return schedule;
}

router.get('/schedule', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(requireSchedule());
  } catch (error) {
    next(toHttpError(error));
  }
});

router.get('/current', (_req: Request, res: Response, next: NextFunction) => {
  try {
    requireSchedule(); // validates a plan exists before checking current slot
    const slot = getCurrentEvSlot();
    if (slot === null) throw new HttpError(404, 'No current EV slot (all slots are in the future)');
    res.json(slot);
  } catch (error) {
    next(toHttpError(error));
  }
});

export default router;
