import type { PlanRow, EvSlot } from './types.ts';
import { FLOW_EPSILON_W } from './dess-mapper.ts';

export interface EvScheduleInput {
  evEnabled: boolean;
  plugged: boolean;
  chargePower_W: number;
}

export function buildEvSchedule(rows: PlanRow[], ev: EvScheduleInput): EvSlot[] {
  if (!ev.evEnabled || !ev.plugged) {
    return rows.map((row) => ({ timestampMs: row.timestampMs, chargePower_W: 0, shouldCharge: false }));
  }
  return rows.map((row) => {
    const shouldCharge = row.pv2g > FLOW_EPSILON_W;
    return {
      timestampMs: row.timestampMs,
      chargePower_W: shouldCharge ? ev.chargePower_W : 0,
      shouldCharge,
    };
  });
}
