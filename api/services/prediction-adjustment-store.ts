import { assertCondition } from '../http-errors.ts';
import { loadData, saveData } from './data-store.ts';
import type { PredictionAdjustmentInput } from './prediction-adjustments.ts';
import {
  createPredictionAdjustment,
  pruneExpiredPredictionAdjustments,
  updatePredictionAdjustment,
} from './prediction-adjustments.ts';

export async function loadActiveAdjustmentsAndPrune() {
  const data = await loadData();
  const pruned = pruneExpiredPredictionAdjustments(data);
  if (pruned.changed) await saveData(pruned.data);
  return { data: pruned.data, adjustments: pruned.adjustments };
}

export async function createStoredPredictionAdjustment(input: PredictionAdjustmentInput) {
  const data = await loadData();
  const { data: pruned } = pruneExpiredPredictionAdjustments(data);
  const adjustment = createPredictionAdjustment(input);
  const adjustments = [...(pruned.predictionAdjustments ?? []), adjustment];
  const nextData = { ...pruned, predictionAdjustments: adjustments };
  await saveData(nextData);
  return { adjustment, adjustments };
}

export async function updateStoredPredictionAdjustment(id: string, input: PredictionAdjustmentInput) {
  const data = await loadData();
  const { data: pruned } = pruneExpiredPredictionAdjustments(data);
  const adjustments = pruned.predictionAdjustments ?? [];
  const index = adjustments.findIndex(adj => adj.id === id);
  assertCondition(index >= 0, 404, 'Prediction adjustment not found');

  const updated = updatePredictionAdjustment(adjustments[index], input);
  const nextAdjustments = adjustments.map((adj, i) => i === index ? updated : adj);
  const nextData = { ...pruned, predictionAdjustments: nextAdjustments };
  await saveData(nextData);
  return { adjustment: updated, adjustments: nextAdjustments };
}

export async function deleteStoredPredictionAdjustment(id: string) {
  const data = await loadData();
  const { data: pruned } = pruneExpiredPredictionAdjustments(data);
  const adjustments = pruned.predictionAdjustments ?? [];
  const nextAdjustments = adjustments.filter(adj => adj.id !== id);
  assertCondition(nextAdjustments.length !== adjustments.length, 404, 'Prediction adjustment not found');

  const nextData = { ...pruned, predictionAdjustments: nextAdjustments };
  await saveData(nextData);
  return { adjustments: nextAdjustments };
}
