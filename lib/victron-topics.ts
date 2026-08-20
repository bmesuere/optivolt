/**
 * victron-topics.ts
 *
 * Pure topic construction and payload encoding for the Victron MQTT interface.
 * No I/O — the client lives in api/services/victron-mqtt-client.ts.
 *
 * Victron's topic prefixes: N/ = notification (value), R/ = read request,
 * W/ = write request, each followed by the portal id (serial).
 */

export interface ScheduleSlot {
  startEpoch?: number;
  durationSeconds?: number;
  strategy?: number;
  flags?: number;
  socTarget?: number;
  restrictions?: number;
  allowGridFeedIn?: number;
}

export const SOC_PATH = 'system/0/Dc/Battery/Soc';
export const MIN_SOC_LIMIT_PATH = 'settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit';
export const MAX_SOC_LIMIT_PATH = 'settings/0/Settings/CGwacs/MaxChargePercentage';

/** Wildcard used to discover the portal id before it is known. */
export const SERIAL_WILDCARD_TOPIC = 'N/+/system/0/Serial';

const SERIAL_TOPIC_RE = /^N\/[^/]+\/system\/0\/Serial$/;

/**
 * The MQTT message handler sees traffic from ALL subscriptions on the shared
 * client, so serial detection must reject anything that isn't a serial topic.
 */
export function isSerialTopic(topic: string): boolean {
  return SERIAL_TOPIC_RE.test(topic);
}

/** Read the portal id out of a serial payload ({"value":"xxxxxxxxx"}). */
export function parseSerialPayload(payload: string | Buffer): string | undefined {
  const obj = JSON.parse(payload.toString()) as { value?: string } | null;
  return obj?.value;
}

export function readTopic(serial: string, relativePath: string): string {
  return `N/${serial}/${relativePath}`;
}

export function requestTopic(serial: string, relativePath: string): string {
  return `R/${serial}/${relativePath}`;
}

export function writeTopic(serial: string, relativePath: string): string {
  return `W/${serial}/${relativePath}`;
}

/**
 * Normalize a percentage payload to [0, 100].
 * Victron sometimes sends [] (or nothing) when a value is unavailable.
 */
export function parsePercentPayload(payload: { value?: unknown } | null | undefined): number | null {
  const raw = payload?.value;
  if (raw === null || raw === undefined || Array.isArray(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/**
 * Encode a Dynamic ESS schedule slot as the settings writes it maps to:
 *   Settings/DynamicEss/Schedule/<slotIndex>/{Start,Duration,Strategy,Flags,Soc,TargetSoc,Restrictions,AllowGridFeedIn}
 * Undefined fields are skipped so a partial slot leaves the rest untouched.
 * `socTarget` writes both Soc and TargetSoc — firmware versions differ on which one they read.
 */
export function scheduleSlotWrites(slotIndex: number, slot: ScheduleSlot): { path: string; value: number }[] {
  const base = `settings/0/Settings/DynamicEss/Schedule/${slotIndex}`;
  const writes: { path: string; value: number }[] = [];

  if (slot.startEpoch !== undefined) writes.push({ path: `${base}/Start`, value: slot.startEpoch });
  if (slot.durationSeconds !== undefined) writes.push({ path: `${base}/Duration`, value: slot.durationSeconds });
  if (slot.strategy !== undefined) writes.push({ path: `${base}/Strategy`, value: slot.strategy });
  if (slot.flags !== undefined) writes.push({ path: `${base}/Flags`, value: slot.flags });
  if (slot.socTarget !== undefined) {
    writes.push({ path: `${base}/Soc`, value: slot.socTarget });
    writes.push({ path: `${base}/TargetSoc`, value: slot.socTarget });
  }
  if (slot.restrictions !== undefined) writes.push({ path: `${base}/Restrictions`, value: slot.restrictions });
  if (slot.allowGridFeedIn !== undefined) writes.push({ path: `${base}/AllowGridFeedIn`, value: slot.allowGridFeedIn });

  return writes;
}
