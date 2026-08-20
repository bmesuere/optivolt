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
}

export function getMqttEnv(): MqttEnv {
  return {
    host: process.env.MQTT_HOST ?? 'venus.local',
    port: Number(process.env.MQTT_PORT ?? '1883'),
    username: process.env.MQTT_USERNAME ?? '',
    password: process.env.MQTT_PASSWORD ?? '',
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
