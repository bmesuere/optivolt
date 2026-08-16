/**
 * view-toggles.js
 *
 * The bar-resolution (15 min / 1 h) and view-range (Standard / Full horizon)
 * segmented controls, shared by every tab that charts the plan.
 *
 * Each tab mounts its own pair in the header of its first chart, but the
 * choice itself is global: it lives in localStorage (see plan-view.js) and a
 * change on one tab broadcasts to the others so their cached charts re-render
 * instead of going stale behind a tab switch.
 */

import {
  getStoredFlowsResolution,
  getStoredViewRange,
  storeFlowsResolution,
  storeViewRange,
} from "./plan-view.js";

const SEG_ACTIVE = "rounded-full px-2.5 py-1 text-xs font-medium bg-white text-ink shadow-sm dark:bg-slate-700 dark:text-slate-100 transition-all";
const SEG_INACTIVE = "rounded-full px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-all";

const GROUP_CLASS = "inline-flex rounded-full bg-slate-100 p-0.5 dark:bg-slate-800";

const MARKUP = `
  <div data-res-toggle class="${GROUP_CLASS}" role="group" aria-label="Bar resolution">
    <button data-res="15" type="button">15 min</button>
    <button data-res="60" type="button">1 h</button>
  </div>
  <div data-range-toggle class="hidden ${GROUP_CLASS}" role="group" aria-label="View range">
    <button data-range="standard" type="button">Standard</button>
    <button data-range="full" type="button">Full horizon</button>
  </div>
`;

// Server-provided end of the standard window, published once a plan has run.
// Null until then; consumers fall back to the browser-local rule in plan-view.
let standardWindowEndMs = null;

export function setStandardWindowEndMs(ms) {
  standardWindowEndMs = Number.isFinite(ms) ? ms : null;
}

export function getStandardWindowEndMs() {
  return standardWindowEndMs;
}

const listeners = new Set();

/** Re-render callback, invoked on every tab whenever either toggle changes. */
export function subscribeViewToggles(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function broadcast() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error("View toggle listener failed", err);
    }
  }
}

/**
 * Resolution for a view spanning `spanH` hours: the user's explicit choice if
 * they made one, otherwise hourly beyond 48 h to keep multi-day bars readable.
 */
export function resolveFlowsResolution(spanH) {
  return getStoredFlowsResolution() ?? (spanH > 48 ? "60" : "15");
}

export { getStoredViewRange };

function setSegState(btn, active) {
  btn.className = active ? SEG_ACTIVE : SEG_INACTIVE;
  btn.setAttribute("aria-pressed", String(active));
}

/**
 * Render a toggle pair into `host` and wire it. Returns an `update` handle the
 * caller invokes from its own render pass.
 *
 * The resolution pair is always shown — it is meaningful on any horizon. The
 * range pair only appears once the plan actually exceeds the standard window,
 * since there is nothing to switch to otherwise.
 */
export function mountViewToggles(host) {
  if (!host) return { update: () => {} };

  host.innerHTML = MARKUP;
  const rangeToggle = host.querySelector("[data-range-toggle]");
  const resButtons = [...host.querySelectorAll("[data-res]")];
  const rangeButtons = [...host.querySelectorAll("[data-range]")];

  for (const btn of resButtons) {
    btn.addEventListener("click", () => {
      storeFlowsResolution(btn.dataset.res);
      broadcast();
    });
  }
  for (const btn of rangeButtons) {
    btn.addEventListener("click", () => {
      storeViewRange(btn.dataset.range);
      broadcast();
    });
  }

  return {
    update({ hasExtended = false, view = "standard", resolution = "15" } = {}) {
      rangeToggle?.classList.toggle("hidden", !hasExtended);
      for (const btn of resButtons) setSegState(btn, btn.dataset.res === resolution);
      for (const btn of rangeButtons) setSegState(btn, btn.dataset.range === view);
    },
  };
}
