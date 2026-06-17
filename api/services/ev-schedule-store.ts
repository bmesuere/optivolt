import { assertCondition } from '../http-errors.ts';
import { loadData, saveData } from './data-store.ts';
import type { EvScheduleEntryInput } from './ev-schedule-entries.ts';
import {
  createEvScheduleEntry,
  pruneExpiredEvScheduleEntries,
  updateEvScheduleEntry,
} from './ev-schedule-entries.ts';

export async function loadActiveEvScheduleEntriesAndPrune() {
  const data = await loadData();
  const pruned = pruneExpiredEvScheduleEntries(data);
  if (pruned.changed) await saveData(pruned.data);
  return { data: pruned.data, entries: pruned.entries };
}

export async function createStoredEvScheduleEntry(input: EvScheduleEntryInput) {
  const data = await loadData();
  const { data: pruned } = pruneExpiredEvScheduleEntries(data);
  const entry = createEvScheduleEntry(input);
  const entries = [...(pruned.evScheduleEntries ?? []), entry];
  await saveData({ ...pruned, evScheduleEntries: entries });
  return { entry, entries };
}

export async function updateStoredEvScheduleEntry(id: string, input: EvScheduleEntryInput) {
  const data = await loadData();
  const { data: pruned } = pruneExpiredEvScheduleEntries(data);
  const entries = pruned.evScheduleEntries ?? [];
  const index = entries.findIndex(entry => entry.id === id);
  assertCondition(index >= 0, 404, 'EV schedule entry not found');

  const updated = updateEvScheduleEntry(entries[index], input);
  const nextEntries = entries.map((entry, i) => i === index ? updated : entry);
  await saveData({ ...pruned, evScheduleEntries: nextEntries });
  return { entry: updated, entries: nextEntries };
}

export async function deleteStoredEvScheduleEntry(id: string) {
  const data = await loadData();
  const { data: pruned } = pruneExpiredEvScheduleEntries(data);
  const entries = pruned.evScheduleEntries ?? [];
  const nextEntries = entries.filter(entry => entry.id !== id);
  assertCondition(nextEntries.length !== entries.length, 404, 'EV schedule entry not found');

  await saveData({ ...pruned, evScheduleEntries: nextEntries });
  return { entries: nextEntries };
}
