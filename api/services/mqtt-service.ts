import { VictronMqttClient } from '../../lib/victron-mqtt.ts';
import type { PlanRowWithDess } from '../types.ts';

let victronClient: VictronMqttClient | null = null;

function getVictronClient(): VictronMqttClient {
  if (!victronClient) {
    const host = process.env.MQTT_HOST ?? 'venus.local';
    const port = Number(process.env.MQTT_PORT ?? '1883');
    const username = process.env.MQTT_USERNAME ?? '';
    const password = process.env.MQTT_PASSWORD ?? '';

    victronClient = new VictronMqttClient({ host, port, username, password });
  }

  return victronClient;
}

export async function getVictronSerial(): Promise<string> {
  const client = getVictronClient();
  return client.getSerial();
}

export async function readVictronSetting(relativePath: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<unknown> {
  const client = getVictronClient();
  return client.readSetting(relativePath, { timeoutMs });
}

export async function writeVictronSetting(relativePath: string, value: unknown): Promise<void> {
  const client = getVictronClient();
  await client.writeSetting(relativePath, value);
}

/**
 * Read the current battery SoC (%) from MQTT.
 * Returns a number in [0, 100] or null if unavailable.
 */
export async function readVictronSocPercent({ timeoutMs }: { timeoutMs?: number } = {}): Promise<number | null> {
  const client = getVictronClient();
  const res = await client.readSocPercent({ timeoutMs });
  return res.soc_percent;
}

/**
 * Read ESS SoC limits (min/max %) from MQTT.
 * Returns { minSoc_percent: number | null, maxSoc_percent: number | null }.
 */
export async function readVictronSocLimits({ timeoutMs }: { timeoutMs?: number } = {}): Promise<{ minSoc_percent: number | null; maxSoc_percent: number | null }> {
  const client = getVictronClient();
  const res = await client.readSocLimitsPercent({ timeoutMs });
  return { minSoc_percent: res.minSoc_percent, maxSoc_percent: res.maxSoc_percent };
}

/**
 * High-level Dynamic ESS schedule builder.
 *
 * rows: optimizer rows with DESS slot data
 * slotCount: how many slots to push (starting from rows[0])
 */
export async function setDynamicEssSchedule(rows: PlanRowWithDess[], slotCount: number): Promise<{ serial: string; slotsWritten: number }> {
  const client = getVictronClient();
  const serial = await client.getSerial();

  const nSlots = Math.min(slotCount, rows.length);
  const tasks = [];
  const stepSeconds = (rows[1].timestampMs - rows[0].timestampMs) / 1000;

  for (let i = 0; i < nSlots; i += 1) {
    const row = rows[i];

    const slot = {
      startEpoch: Math.round(row.timestampMs / 1000),
      durationSeconds: stepSeconds,
      strategy: row.dess.strategy,
      flags: row.dess.flags,
      socTarget: Math.round(row.dess.socTarget_percent),
      restrictions: row.dess.restrictions,
      allowGridFeedIn: row.dess.feedin,
    };
    tasks.push(client.writeScheduleSlot(i, slot, { serial }));
  }

  await Promise.all(tasks);

  return { serial, slotsWritten: nSlots };
}

export async function shutdownVictronClient(): Promise<void> {
  if (!victronClient) return;
  await victronClient.close();
  victronClient = null;
}
