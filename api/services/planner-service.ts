import highsFactoryRaw from 'highs';
import { mapRowsToDess, mapRowsToDessV2, computeDessDiff } from '../../lib/dess-mapper.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import type { SolverConfig, PlanSummary } from '../../lib/types.ts';
import { getSolverInputs } from './config-builder.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { setDynamicEssSchedule } from './mqtt-service.ts';
import type { PlanRowWithDess, Data } from '../types.ts';

// The highs package has malformed .d.ts declarations, so we define the minimal
// interface we need and cast once at module level.
interface HighsInstance { solve(lp: string): unknown; }
type HighsLoader = (opts?: Record<string, unknown>) => Promise<HighsInstance>;
const highsFactory = highsFactoryRaw as unknown as HighsLoader;

// How many slots we push into Dynamic ESS
const DESS_SLOTS = 4;

// Lazy, shared HiGHS instance
let highsPromise: Promise<HighsInstance> | undefined;

async function getHighsInstance(): Promise<HighsInstance> {
  if (!highsPromise) {
    highsPromise = highsFactory({}).catch((error: unknown) => {
      highsPromise = undefined;
      throw error;
    });
  }
  return highsPromise;
}

type DessDiff = ReturnType<typeof computeDessDiff>;

export interface ComputePlanResult {
  cfg: SolverConfig;
  data: Data;
  timing: { startMs: number; stepMin: number };
  result: HighsSolution;
  rows: PlanRowWithDess[];
  summary: PlanSummary;
  dessDiff?: DessDiff;
}

export async function computePlan({ updateData = false } = {}): Promise<ComputePlanResult> {
  if (updateData) {
    try {
      await refreshSeriesFromVrmAndPersist();
    } catch (vrmError) {
      console.error(
        'Failed to refresh VRM data before calculation:',
        vrmError instanceof Error ? vrmError.message : String(vrmError),
      );
    }
  }

  const { cfg, timing, data } = await getSolverInputs();

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const result = highs.solve(lpText) as HighsSolution;

  const rows = parseSolution(result, cfg, timing);

  const useV2 = cfg.dessAlgorithm === 'v2';
  const activeMapper = useV2 ? mapRowsToDessV2 : mapRowsToDess;
  const { perSlot, diagnostics } = activeMapper(rows, cfg);

  const rowsWithDess: PlanRowWithDess[] = rows.map((row, i) => ({ ...row, dess: perSlot[i] }));

  let dessDiff: DessDiff | undefined;
  if (useV2) {
    const v1Result = mapRowsToDess(rowsWithDess, cfg);
    dessDiff = computeDessDiff(v1Result.perSlot, perSlot);
  }

  const summary = buildPlanSummary(rowsWithDess, cfg, diagnostics);

  return { cfg, data, timing, result, rows: rowsWithDess, summary, dessDiff };
}

export async function writePlanToVictron(rows: PlanRowWithDess[]): Promise<void> {
  await setDynamicEssSchedule(rows, Math.min(DESS_SLOTS, rows.length));
}

export async function planAndMaybeWrite({
  updateData = false,
  writeToVictron = false,
} = {}): Promise<ComputePlanResult> {
  const result = await computePlan({ updateData });
  if (writeToVictron) {
    await writePlanToVictron(result.rows);
  }
  return result;
}
