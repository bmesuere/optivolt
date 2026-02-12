import highsFactory from 'highs';

import { mapRowsToDess, mapRowsToDessV2, computeDessDiff } from '../../lib/dess-mapper.js';
import { buildLP } from '../../lib/build-lp.js';
import { parseSolution } from '../../lib/parse-solution.js';
import { buildPlanSummary } from '../../lib/plan-summary.js';
import { getSolverInputs } from './config-builder.js';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.js';
import { setDynamicEssSchedule } from './mqtt-service.js';

// How many slots we push into Dynamic ESS
const DESS_SLOTS = 4;

// Lazy, shared HiGHS instance
let highsPromise;
async function getHighsInstance() {
  if (!highsPromise) {
    highsPromise = highsFactory({}).catch((error) => {
      // Allow retry on next call
      highsPromise = undefined;
      throw error;
    });
  }
  return highsPromise;
}

/**
 * Shared pipeline (pure planner):
 *  - optionally refresh VRM data
 *  - load settings + data
 *  - build LP
 *  - solve
 *  - parse solution
 *  - attach DESS mapping
 *
 * Returns { cfg, data, result, rows, summary, dessDiagnostics }.
 */
export async function computePlan({ updateData = false } = {}) {
  if (updateData) {
    try {
      // Fetch from VRM and save to data.json
      await refreshSeriesFromVrmAndPersist();
    } catch (vrmError) {
      // Don't kill the calculation; just log the error and proceed with old data
      console.error(
        'Failed to refresh VRM data before calculation:',
        vrmError?.message ?? String(vrmError),
      );
    }
  }

  // This will read the (possibly freshly) persisted data
  const { cfg, timing, data } = await getSolverInputs();

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const result = highs.solve(lpText);

  const rows = parseSolution(result, cfg, timing);

  const useV2 = cfg.dessAlgorithm === 'v2';
  const activeMapper = useV2 ? mapRowsToDessV2 : mapRowsToDess;
  const { perSlot, diagnostics } = activeMapper(rows, cfg);
  const dessDiagnostics = diagnostics;

  for (let i = 0; i < rows.length; i++) {
    rows[i].dess = perSlot[i];
  }

  // When v2 is active, also run v1 and compute diff
  let dessDiff;
  if (useV2) {
    const v1Result = mapRowsToDess(rows, cfg);
    dessDiff = computeDessDiff(v1Result.perSlot, perSlot);
  }

  const summary = buildPlanSummary(rows, cfg, dessDiagnostics);

  return { cfg, data, timing, result, rows, summary, dessDiff };
}

/**
 * Write the plan to Victron via MQTT.
 */
export async function writePlanToVictron(rows) {
  const slotCount = Math.min(DESS_SLOTS, rows.length);
  await setDynamicEssSchedule(rows, slotCount);
}

/**
 * High-level façade: compute plan and optionally push to Victron.
 *
 * options:
 *   - updateData: boolean (refresh VRM data first)
 *   - writeToVictron: boolean (push schedule via MQTT)
 */
export async function planAndMaybeWrite({
  updateData = false,
  writeToVictron = false,
} = {}) {
  const { cfg, data, timing, result, rows, summary, dessDiff } =
    await computePlan({ updateData });

  if (writeToVictron) {
    await writePlanToVictron(rows);
  }

  return { cfg, data, timing, result, rows, summary, dessDiff };
}
