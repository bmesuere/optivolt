/**
 * predict-pv.ts
 *
 * Public entry point for PV forecasting — pure logic, no I/O.
 *
 * Algorithm overview:
 *   1. From HA history, find the max production (Wh) for each UTC hour.
 *   2. From Open-Meteo archive, find the max ratio (GHI_actual / GHI_clear)
 *      for each UTC hour using the Bird Clear Sky Model.
 *   3. Estimate "true capacity" per hour: what the system would produce at
 *      100% clear sky = maxProduction / maxRatio.
 *   4. For each forecast hour, compute prediction = forecastRatio × trueCapacity,
 *      where forecastRatio = GHI_forecast / GHI_clear.
 *
 * Implementation lives in:
 *   - pv-clear-sky.ts   Bird clear-sky irradiance physics
 *   - pv-capacity.ts    observation records + clear-sky capacity estimation
 *   - pv-linear-fit.ts  robust direct/diffuse linear models
 *   - pv-forecast.ts    forecast point assembly + validation
 */

export { calculateClearSkyGHI } from './pv-clear-sky.ts';

export {
  slotOfDay,
  calculateMaxProductionPerHour,
  calculateMaxProductionPerSlot,
  calculateMaxRatioPerHour,
  estimateHourlyCapacity,
  estimateSlotCapacity,
} from './pv-capacity.ts';
export type {
  IrradianceRecord,
  PvProductionRecord,
  HourlyCapacity,
  SlotCapacity,
} from './pv-capacity.ts';

export { estimateRobustLinearPvModels } from './pv-linear-fit.ts';
export type { PvLinearModel } from './pv-linear-fit.ts';

export {
  forecastPv,
  forecastPvSlot,
  forecastPvLinear,
  validatePvForecast,
} from './pv-forecast.ts';
export type { PvForecastPoint } from './pv-forecast.ts';
