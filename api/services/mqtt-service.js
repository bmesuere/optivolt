import { VictronMqttClient } from '../../lib/victron-mqtt.js';

let victronClient = null;

function getVictronClient() {
  if (!victronClient) {
    const host = process.env.MQTT_HOST || 'venus.local';
    const port = process.env.MQTT_PORT ? Number(process.env.MQTT_PORT) : 1883;
    const username = process.env.MQTT_USERNAME || '';
    const password = process.env.MQTT_PASSWORD || '';

    victronClient = new VictronMqttClient({
      host,
      port,
      username,
      password,
    });
  }

  return victronClient;
}

export async function getVictronSerial() {
  const client = getVictronClient();
  return client.getSerial();
}

export async function readVictronSetting(relativePath, { timeoutMs } = {}) {
  const client = getVictronClient();
  return client.readSetting(relativePath, { timeoutMs });
}

export async function writeVictronSetting(relativePath, value) {
  const client = getVictronClient();
  await client.writeSetting(relativePath, value);
}

/**
 * Read the current battery SoC (%) from MQTT.
 * Returns a number in [0, 100] or null if unavailable.
 */
export async function readVictronSocPercent({ timeoutMs } = {}) {
  const client = getVictronClient();
  const res = await client.readSocPercent({ timeoutMs });
  return res?.soc_percent ?? null;
}

/**
 * Read ESS SoC limits (min/max %) from MQTT.
 * Returns { minSoc_percent: number | null, maxSoc_percent: number | null }.
 */
export async function readVictronSocLimits({ timeoutMs } = {}) {
  const client = getVictronClient();
  const res = await client.readSocLimitsPercent({ timeoutMs });
  return {
    minSoc_percent: res?.minSoc_percent ?? null,
    maxSoc_percent: res?.maxSoc_percent ?? null,
  };
}

/**
 * High-level Dynamic ESS schedule writer.
 *
 * rows: optimizer rows like the example you gave
 * slotCount: how many slots to push (starting from rows[0])
 *
 * options:
 *   - firstTimestampMs : ms since epoch for rows[0]
 *   - stepSeconds      : duration of each slot (default 900)
 *   - batteryCapacity_Wh : battery capacity in Wh, used to compute SoC %
 */
export async function setDynamicEssSchedule(
  rows,
  slotCount,
  { batteryCapacity_Wh },
) {
  const client = getVictronClient();
  const serial = await client.getSerial();

  const nSlots = Math.min(slotCount, rows.length);
  const tasks = [];
  const stepSeconds = (rows[1].timestampMs - rows[0].timestampMs) / 1000;

  for (let i = 0; i < nSlots; i += 1) {
    const row = rows[i];

    const socTargetPercent = Math.round((row.dess.socTarget_Wh / batteryCapacity_Wh) * 100);

    const slot = {
      startEpoch: Math.round(row.timestampMs / 1000),
      durationSeconds: stepSeconds,
      strategy: row.dess.strategy,
      flags: row.dess.flags,
      socTarget: socTargetPercent,
      restrictions: row.dess.restrictions,
      allowGridFeedIn: Number(row.dess.feedin),
    };
    console.log(`[victron-service] Writing slot ${i}:`, slot);
    //tasks.push(client.writeScheduleSlot(i, slot, { serial }));
  }

  await Promise.all(tasks);

  return {
    serial,
    slotsWritten: nSlots,
  };
}

export async function shutdownVictronClient() {
  if (!victronClient) return;
  await victronClient.close();
  victronClient = null;
}
