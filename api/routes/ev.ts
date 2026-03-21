import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http-errors.ts';
import { getLastPlan } from '../services/planner-service.ts';

const router = express.Router();

// GET /ev/schedule — full per-slot EV schedule from last computed plan
router.get('/schedule', (req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = getLastPlan();
    if (!plan) {
      throw new HttpError(404, 'No plan computed yet');
    }

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
  } catch (err) {
    next(err);
  }
});

// GET /ev/current — current time slot's EV charging decision
router.get('/current', (req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = getLastPlan();
    if (!plan) {
      throw new HttpError(404, 'No plan computed yet');
    }

    const nowMs = Date.now();
    const rows = plan.rows;
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
    });
  } catch (err) {
    next(err);
  }
});

export default router;
