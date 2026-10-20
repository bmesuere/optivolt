/**
 * ev-connection.ts
 *
 * Electrical connection of the EV charger, which fixes how charge current
 * (what chargers and Home Assistant integrations set, in A per phase) maps to
 * charge power (what the solver plans, in W).
 *
 *   1x230 — single phase, 230 V:                      P = 230 V × I
 *   3x400 — three phase, 400 V between phases (star): P = 3 × 230 V × I
 *   3x230 — three phase, 230 V between phases (delta, no neutral; common in
 *           older Belgian and Norwegian homes):        P = √3 × 230 V × I
 */

export const EV_CONNECTIONS = ['1x230', '3x230', '3x400'] as const;
export type EvConnection = typeof EV_CONNECTIONS[number];

export const DEFAULT_EV_CONNECTION: EvConnection = '1x230';

const WATTS_PER_AMP: Record<EvConnection, number> = {
  '1x230': 230,
  '3x230': Math.sqrt(3) * 230,
  '3x400': 3 * 230,
};

export function isEvConnection(value: unknown): value is EvConnection {
  return typeof value === 'string' && (EV_CONNECTIONS as readonly string[]).includes(value);
}

/** Charge power (W) per ampere of per-phase current; unknown values fall back to single phase. */
export function evWattsPerAmp(connection: unknown): number {
  return WATTS_PER_AMP[isEvConnection(connection) ? connection : DEFAULT_EV_CONNECTION];
}
