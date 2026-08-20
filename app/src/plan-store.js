/**
 * plan-store.js
 *
 * The single owner of "the current plan": the last /calculate (or cached
 * /calculate/last) payload the UI accepted. Every tab reads it from here
 * instead of keeping its own copy, so a plan can never be half-updated across
 * modules.
 *
 * Plan requests overlap (boot's cached fetch, debounced reruns, the Run
 * button), and a slow older response must never overwrite a newer one — so the
 * store also hands out the tickets that decide which response may paint.
 */

const EMPTY_PLAN = Object.freeze({
  rows: Object.freeze([]),
  summary: null,
  rebalanceWindow: null,
  rebalanceNudge: null,
  initialSoc_percent: null,
  pricesKnownUntilMs: null,
  standardWindowEndMs: null,
  tsStart: null,
});

let plan = EMPTY_PLAN;
let requestSeq = 0;
const listeners = new Set();

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/** Take a ticket for an in-flight plan request. */
export function beginPlanRequest() {
  return ++requestSeq;
}

/** False once a newer request has been started — the response must be dropped. */
export function isCurrentPlanRequest(seq) {
  return seq === requestSeq;
}

/** The current plan. Always an object; `rows` is always an array. */
export function getPlan() {
  return plan;
}

/**
 * Adopt a plan payload (or null to clear) and notify subscribers. Listeners run
 * in subscription order and are not shielded: a render failure propagates to
 * the caller, which is what lets the optimizer report a display failure without
 * discarding the plan it just solved.
 */
export function setPlan(result) {
  plan = result
    ? {
      rows: Array.isArray(result.rows) ? result.rows : [],
      summary: result.summary ?? null,
      rebalanceWindow: result.rebalanceWindow ?? null,
      rebalanceNudge: result.rebalanceNudge ?? null,
      initialSoc_percent: result.initialSoc_percent ?? null,
      pricesKnownUntilMs: finiteOrNull(result.pricesKnownUntilMs),
      standardWindowEndMs: finiteOrNull(result.standardWindowEndMs),
      tsStart: result.tsStart ?? null,
    }
    : EMPTY_PLAN;

  for (const fn of [...listeners]) fn(plan);
  return plan;
}

/** Re-render callback, invoked whenever the plan is replaced. Returns an unsubscribe. */
export function subscribePlan(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Drop the plan, the request tickets and every subscriber. The page never needs
 * this — the store lives as long as the document does — but a test file mounts
 * many consumers against the same module instance.
 */
export function resetPlanStore() {
  plan = EMPTY_PLAN;
  requestSeq = 0;
  listeners.clear();
}
