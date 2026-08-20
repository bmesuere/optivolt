/**
 * pv-linear-fit.ts
 *
 * Robust per-bucket linear PV models: production_W ≈ directCoeff × direct
 * + diffuseCoeff × diffuse, fitted with a non-negative ridge, a low-outlier
 * rejection pass and a cross-validated gate against the clear-sky fallback.
 */

import {
  getRadiationFeatures,
  slotOfDay,
  type IrradianceRecord,
  type PvProductionRecord,
} from './pv-capacity.ts';
import type { PvForecastPoint } from './pv-forecast.ts';

export interface PvLinearModel {
  index: number;             // hour (0-23) or slot (0-95)
  directCoeff: number;       // W PV per W/m² direct radiation
  diffuseCoeff: number;      // W PV per W/m² diffuse radiation
  sampleCount: number;
  excludedCount: number;
  fallback: boolean;
}

interface PvLinearSample {
  direct: number;
  diffuse: number;
  production_W: number;
  fallback_W?: number;
}

interface PvLinearFitOptions {
  minSamples: number;
  minCrossValidationSamples: number;
  minStrongRadiation_W_per_m2: number;
  lowOutlierRatio: number;
  minOutlierDelta_W: number;
  minFallbackImprovementRatio: number;
  ridgeLambda: number;
}

const DEFAULT_LINEAR_FIT_OPTIONS: PvLinearFitOptions = {
  minSamples: 3,
  minCrossValidationSamples: 4,
  minStrongRadiation_W_per_m2: 120,
  lowOutlierRatio: 0.35,
  minOutlierDelta_W: 300,
  minFallbackImprovementRatio: 0.05,
  ridgeLambda: 1,
};

function fallbackLinearModel(index: number): PvLinearModel {
  return {
    index,
    directCoeff: 0,
    diffuseCoeff: 0,
    sampleCount: 0,
    excludedCount: 0,
    fallback: true,
  };
}

function fitNonNegativeRidge(samples: PvLinearSample[], options: PvLinearFitOptions): { directCoeff: number; diffuseCoeff: number } | null {
  let sDD = options.ridgeLambda;
  let sFF = options.ridgeLambda;
  let sDF = 0;
  let tD = 0;
  let tF = 0;

  for (const sample of samples) {
    const { direct, diffuse, production_W } = sample;
    sDD += direct * direct;
    sFF += diffuse * diffuse;
    sDF += direct * diffuse;
    tD += direct * production_W;
    tF += diffuse * production_W;
  }

  const candidates: { directCoeff: number; diffuseCoeff: number }[] = [];
  const det = sDD * sFF - sDF * sDF;

  if (Math.abs(det) > 1e-9) {
    candidates.push({
      directCoeff: (tD * sFF - tF * sDF) / det,
      diffuseCoeff: (sDD * tF - sDF * tD) / det,
    });
  }

  candidates.push({ directCoeff: tD / sDD, diffuseCoeff: 0 });
  candidates.push({ directCoeff: 0, diffuseCoeff: tF / sFF });
  candidates.push({ directCoeff: 0, diffuseCoeff: 0 });

  let best: { directCoeff: number; diffuseCoeff: number } | null = null;
  let bestLoss = Infinity;

  for (const candidate of candidates) {
    const directCoeff = Math.max(0, candidate.directCoeff);
    const diffuseCoeff = Math.max(0, candidate.diffuseCoeff);
    let loss = options.ridgeLambda * (directCoeff * directCoeff + diffuseCoeff * diffuseCoeff);
    for (const sample of samples) {
      const predicted = directCoeff * sample.direct + diffuseCoeff * sample.diffuse;
      const error = sample.production_W - predicted;
      loss += error * error;
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      best = { directCoeff, diffuseCoeff };
    }
  }

  if (!best || !Number.isFinite(best.directCoeff) || !Number.isFinite(best.diffuseCoeff)) return null;
  if (best.directCoeff + best.diffuseCoeff <= 1e-9) return null;
  return best;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function predictLinear(fit: { directCoeff: number; diffuseCoeff: number }, sample: Pick<PvLinearSample, 'direct' | 'diffuse'>): number {
  return Math.max(0, fit.directCoeff * sample.direct + fit.diffuseCoeff * sample.diffuse);
}

function fitWithOutlierPass(samples: PvLinearSample[], options: PvLinearFitOptions): {
  fit: { directCoeff: number; diffuseCoeff: number } | null;
  effectiveSamples: PvLinearSample[];
  excludedCount: number;
} {
  const initial = fitNonNegativeRidge(samples, options);
  if (!initial) return { fit: null, effectiveSamples: samples, excludedCount: 0 };

  const outliers = lowOutlierIndexes(samples, initial, options);
  if (outliers.size > 0 && samples.length - outliers.size >= options.minSamples) {
    const filtered = samples.filter((_sample, i) => !outliers.has(i));
    const refit = fitNonNegativeRidge(filtered, options);
    if (refit) return { fit: refit, effectiveSamples: filtered, excludedCount: outliers.size };
  }

  return { fit: initial, effectiveSamples: samples, excludedCount: 0 };
}

function lowOutlierIndexes(
  samples: PvLinearSample[],
  fit: { directCoeff: number; diffuseCoeff: number },
  options: PvLinearFitOptions,
): Set<number> {
  const totals = samples.map(s => s.direct + s.diffuse);
  const strongThreshold = Math.max(options.minStrongRadiation_W_per_m2, Math.max(...totals) * 0.35);
  const strongRatios = samples
    .map((sample, i) => ({ sample, total: totals[i] }))
    .filter(({ sample, total }) => total >= strongThreshold && sample.production_W > 0)
    .map(({ sample, total }) => sample.production_W / Math.max(1, total));
  const medianRatio = median(strongRatios);
  const outliers = new Set<number>();

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const total = totals[i];
    if (total < strongThreshold) continue;

    const trainingWithoutSample = samples.filter((_other, j) => j !== i);
    const leaveOneOutFit = trainingWithoutSample.length >= options.minSamples
      ? fitNonNegativeRidge(trainingWithoutSample, options)
      : null;
    const predicted = leaveOneOutFit
      ? predictLinear(leaveOneOutFit, sample)
      : predictLinear(fit, sample);
    const modelLow = predicted >= options.minOutlierDelta_W
      && sample.production_W < predicted * options.lowOutlierRatio
      && predicted - sample.production_W >= options.minOutlierDelta_W;
    const ratioLow = medianRatio > 0
      && sample.production_W / Math.max(1, total) < medianRatio * options.lowOutlierRatio
      && medianRatio * total - sample.production_W >= options.minOutlierDelta_W;

    if (modelLow || ratioLow) outliers.add(i);
  }

  return outliers;
}

function crossValidatedLinearMae(samples: PvLinearSample[], options: PvLinearFitOptions): number | null {
  const fallbackCount = samples.filter(s => s.fallback_W != null).length;
  if (fallbackCount < options.minCrossValidationSamples) return null;

  let sumAbs = 0;
  let count = 0;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.fallback_W == null) continue;
    const training = samples.filter((_other, j) => j !== i);
    if (training.length < options.minSamples) continue;

    const fit = fitNonNegativeRidge(training, options);
    if (!fit) continue;

    sumAbs += Math.abs(sample.production_W - predictLinear(fit, sample));
    count++;
  }

  return count >= options.minCrossValidationSamples ? sumAbs / count : null;
}

function fallbackMae(samples: PvLinearSample[]): number | null {
  let sumAbs = 0;
  let count = 0;

  for (const sample of samples) {
    if (sample.fallback_W == null) continue;
    sumAbs += Math.abs(sample.production_W - sample.fallback_W);
    count++;
  }

  return count > 0 ? sumAbs / count : null;
}

function fitRobustLinearModel(index: number, samples: PvLinearSample[], options: PvLinearFitOptions): PvLinearModel {
  if (samples.length < options.minSamples) return fallbackLinearModel(index);

  const { fit, effectiveSamples, excludedCount } = fitWithOutlierPass(samples, options);
  if (!fit) return fallbackLinearModel(index);

  // Use effectiveSamples (post-outlier-removal) for both MAEs so the gate
  // is evaluated on the same data the returned coefficients were fitted on.
  const cvMae = crossValidatedLinearMae(effectiveSamples, options);
  const baseMae = fallbackMae(effectiveSamples);
  // baseMae exists but cvMae is null: enough fallback data to judge but not enough to cross-validate
  // the linear model — distrust it conservatively.
  if (baseMae != null && cvMae == null) {
    return {
      index,
      ...fit,
      sampleCount: effectiveSamples.length,
      excludedCount,
      fallback: true,
    };
  }
  if (
    cvMae != null
    && baseMae != null
    && cvMae >= baseMae * (1 - options.minFallbackImprovementRatio)
  ) {
    return {
      index,
      ...fit,
      sampleCount: effectiveSamples.length,
      excludedCount,
      fallback: true,
    };
  }

  return {
    index,
    ...fit,
    sampleCount: effectiveSamples.length,
    excludedCount,
    fallback: false,
  };
}

/**
 * Estimate per-hour or per-15-minute-slot PV models using direct + diffuse
 * radiation. Zero production samples are treated as invalid sensor/curtailment
 * observations. Low non-zero outliers under strong radiation are treated as
 * likely derating and excluded before a second fit.
 */
export function estimateRobustLinearPvModels(
  productionRecords: PvProductionRecord[],
  irradiance: IrradianceRecord[],
  bucketCount: 24 | 96,
  fallbackPoints?: Map<number, PvForecastPoint>,
): PvLinearModel[] {
  const options = DEFAULT_LINEAR_FIT_OPTIONS;
  const productionByTime = new Map<number, number>();
  for (const rec of productionRecords) {
    if (Number.isFinite(rec.production_Wh) && rec.production_Wh > 0) {
      productionByTime.set(rec.time, rec.production_Wh);
    }
  }

  const samplesByIndex = Array.from({ length: bucketCount }, () => [] as PvLinearSample[]);

  for (const rec of irradiance) {
    const production_W = productionByTime.get(rec.time);
    if (production_W == null) continue;
    const features = getRadiationFeatures(rec);
    if (!features) continue;
    if (features.direct + features.diffuse <= 5) continue;

    const index = bucketCount === 96 ? slotOfDay(rec.time) : rec.hour;
    const fallback_W = fallbackPoints?.get(rec.time)?.predicted ?? undefined;
    samplesByIndex[index].push({ ...features, production_W, fallback_W });
  }

  return samplesByIndex.map((samples, index) => fitRobustLinearModel(index, samples, options));
}
