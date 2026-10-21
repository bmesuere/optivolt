/**
 * Single home for process.env access in the API layer. Values are read at
 * call time, not import time, so tests and the add-on runtime can set them
 * late. (DATA_DIR stays in json-store's resolveDataDir, its existing seam.)
 */

/** Supervisor token present ⇒ running as a Home Assistant add-on. */
export function isAddon(): boolean {
  return !!process.env.SUPERVISOR_TOKEN;
}

export function supervisorToken(): string | undefined {
  return process.env.SUPERVISOR_TOKEN || undefined;
}

export interface VrmCredentials {
  installationId: string;
  token: string;
}

/** VRM credentials, trimmed; throws with a user-facing message when missing. */
export function getVrmCredentials(): VrmCredentials {
  const installationId = (process.env.VRM_INSTALLATION_ID ?? '').trim();
  const token = (process.env.VRM_TOKEN ?? '').trim();
  if (!installationId) throw new Error('VRM Site ID not configured in add-on settings');
  if (!token) throw new Error('VRM API token not configured in add-on settings');
  return { installationId, token };
}

export interface MqttEnv {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  tlsVerify: boolean;
  tlsCa: string | undefined;
  tlsFingerprint: string | undefined;
}

function parseStrictBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be "true" or "false" (got "${value}")`);
}

function normalizeFingerprint(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      'MQTT_TLS_FINGERPRINT must be a 64-character SHA-256 hex string (colons and whitespace are ignored)',
    );
  }
  return normalized;
}

export function getMqttEnv(): MqttEnv {
  const tls = parseStrictBoolean('MQTT_TLS', process.env.MQTT_TLS);
  const rawPort = process.env.MQTT_PORT ?? '';
  const parsedPort = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : tls
        ? 8883
        : 1883;
  const tlsCa = (process.env.MQTT_TLS_CA ?? '').replace(/\\n/g, '\n').trim() || undefined;
  const tlsFingerprint = normalizeFingerprint(process.env.MQTT_TLS_FINGERPRINT);

  return {
    host: process.env.MQTT_HOST ?? 'venus.local',
    port,
    username: process.env.MQTT_USERNAME ?? '',
    password: process.env.MQTT_PASSWORD ?? '',
    tls,
    tlsVerify: process.env.MQTT_TLS_VERIFY !== 'false',
    tlsCa,
    tlsFingerprint,
  };
}

export interface ServerEnv {
  host: string;
  port: number;
}

export function getServerEnv(): ServerEnv {
  const rawPort = Number.parseInt(process.env.PORT ?? '', 10);
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number.isFinite(rawPort) ? rawPort : 3000,
  };
}
