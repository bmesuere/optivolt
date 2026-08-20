import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { getLastPlan } from '../services/planner-service.ts';
import type { EvScheduleEntryInput } from '../services/ev-schedule-entries.ts';
import {
  createStoredEvScheduleEntry,
  deleteStoredEvScheduleEntry,
  loadActiveEvScheduleEntriesAndPrune,
  updateStoredEvScheduleEntry,
} from '../services/ev-schedule-store.ts';

const router = express.Router();

// GET /ev/schedule — full per-slot EV schedule from last computed plan
router.get('/schedule', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = getLastPlan();
    assertCondition(!!plan, 404, 'No plan computed yet');

    const slots = plan.rows.map(row => ({
      timestampMs: row.timestampMs,
      ev_charge_W: row.ev_charge,
      ev_charge_A: row.ev_charge_A,
      ev_charge_mode: row.ev_charge_mode,
      g2ev_W: row.g2ev,
      pv2ev_W: row.pv2ev,
      b2ev_W: row.b2ev,
      ev_soc_percent: row.ev_soc_percent,
    }));

    res.json({
      planStart: new Date(plan.timing.startMs).toISOString(),
      slots,
      summary: {
        evChargeTotal_kWh: plan.summary.evChargeTotal_kWh,
        evChargeFromGrid_kWh: plan.summary.evChargeFromGrid_kWh,
        evChargeFromPv_kWh: plan.summary.evChargeFromPv_kWh,
        evChargeFromBattery_kWh: plan.summary.evChargeFromBattery_kWh,
      },
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read the EV schedule'));
  }
});

// GET /ev/current — current time slot's EV charging decision
router.get('/current', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = getLastPlan();
    assertCondition(!!plan, 404, 'No plan computed yet');

    const nowMs = Date.now();
    const rows = plan.rows;
    assertCondition(rows.length > 0, 404, 'Computed plan has no slots');

    const firstSlotMs = rows[0].timestampMs;
    const planEndMs = rows[rows.length - 1].timestampMs + plan.timing.stepMin * 60_000;
    if (nowMs < firstSlotMs || nowMs >= planEndMs) {
      const reason = nowMs < firstSlotMs ? 'before_plan' : 'expired_plan';
      res.json({
        timestampMs: null,
        ev_charge_W: 0,
        ev_charge_A: 0,
        ev_charge_mode: 'off',
        g2ev_W: 0,
        pv2ev_W: 0,
        b2ev_W: 0,
        ev_soc_percent: null,
        is_charging: false,
        plan_valid: false,
        reason,
      });
      return;
    }

    let row = rows[0];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].timestampMs <= nowMs) {
        row = rows[i];
        break;
      }
    }

    res.json({
      timestampMs: row.timestampMs,
      ev_charge_W: row.ev_charge,
      ev_charge_A: row.ev_charge_A,
      ev_charge_mode: row.ev_charge_mode,
      g2ev_W: row.g2ev,
      pv2ev_W: row.pv2ev,
      b2ev_W: row.b2ev,
      ev_soc_percent: row.ev_soc_percent,
      is_charging: row.ev_charge > 0,
      plan_valid: true,
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read the current EV decision'));
  }
});

// ----------------------------- Schedule entries -------------------------
// A list of typed (arrival/departure/target) schedule entries, persisted in data.json.

router.get('/schedule-entries', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { entries } = await loadActiveEvScheduleEntriesAndPrune();
    res.json({ entries });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read EV schedule entries'));
  }
});

router.post('/schedule-entries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertCondition(
      req.body && typeof req.body === 'object' && !Array.isArray(req.body),
      400,
      'EV schedule entry payload must be an object',
    );
    const result = await createStoredEvScheduleEntry(req.body as EvScheduleEntryInput);
    res.status(201).json(result);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to create EV schedule entry'));
  }
});

router.patch('/schedule-entries/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertCondition(
      req.body && typeof req.body === 'object' && !Array.isArray(req.body),
      400,
      'EV schedule entry payload must be an object',
    );
    const result = await updateStoredEvScheduleEntry(String(req.params.id), req.body as EvScheduleEntryInput);
    res.json(result);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to update EV schedule entry'));
  }
});

router.delete('/schedule-entries/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteStoredEvScheduleEntry(String(req.params.id)));
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to delete EV schedule entry'));
  }
});

export default router;
