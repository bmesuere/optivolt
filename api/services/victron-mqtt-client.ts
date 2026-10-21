/**
 * victron-mqtt-client.ts
 *
 * MQTT client for a Victron GX device.
 * Uses the pure topic construction and payload encoding from lib/victron-topics.ts.
 */

import { createHash } from 'node:crypto';
import type { ConnectionOptions } from 'node:tls';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import {
  MAX_SOC_LIMIT_PATH,
  MIN_SOC_LIMIT_PATH,
  SERIAL_WILDCARD_TOPIC,
  SOC_PATH,
  isSerialTopic,
  parsePercentPayload,
  parseSerialPayload,
  readTopic,
  requestTopic,
  scheduleSlotWrites,
  writeTopic,
  type ScheduleSlot,
} from '../../lib/victron-topics.ts';

export type { ScheduleSlot } from '../../lib/victron-topics.ts';

export interface VictronMqttConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  protocol?: string;
  reconnectPeriod?: number;
  serial?: string;
  tls?: boolean;
  tlsVerify?: boolean;
  tlsCa?: string | Buffer;
  tlsFingerprint?: string;
}

export type VictronMqttConnectOptions = IClientOptions &
  Pick<ConnectionOptions, 'checkServerIdentity'>;

function resolveProtocol(config: VictronMqttConfig): string {
  return config.protocol ?? (config.tls ? 'mqtts' : 'mqtt');
}

function normalizeFingerprint(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      'MQTT TLS fingerprint must be a 64-character SHA-256 hex string (colons and whitespace are ignored)',
    );
  }
  return normalized;
}

function hasTlsCa(ca: VictronMqttConfig['tlsCa']): ca is string | Buffer {
  if (ca === undefined) return false;
  return typeof ca === 'string' ? ca.trim().length > 0 : ca.length > 0;
}

export function validateTlsConfig(config: VictronMqttConfig): void {
  if (config.tls === true && config.protocol !== undefined && config.protocol !== 'mqtts') {
    throw new Error(
      `MQTT TLS requires a TLS protocol; "tls: true" conflicts with protocol "${config.protocol}"`,
    );
  }

  const effectiveTls = resolveProtocol(config) === 'mqtts';
  const hasFingerprint = normalizeFingerprint(config.tlsFingerprint) !== undefined;
  const caSupplied = hasTlsCa(config.tlsCa);

  if (hasFingerprint) {
    if (!effectiveTls) {
      throw new Error('MQTT TLS fingerprint requires TLS (protocol mqtts or tls: true)');
    }
    if (!caSupplied) {
      throw new Error('MQTT TLS fingerprint requires a CA certificate');
    }
    if (config.tlsVerify === false) {
      throw new Error('MQTT TLS fingerprint cannot be used with tlsVerify: false');
    }
  }

  if (caSupplied && !effectiveTls) {
    throw new Error('MQTT TLS CA certificate supplied but TLS is disabled');
  }
}

export function buildMqttConnectOptions(
  config: VictronMqttConfig,
): { url: string; options: VictronMqttConnectOptions } {
  validateTlsConfig(config);

  const protocol = resolveProtocol(config);
  const effectiveTls = protocol === 'mqtts';
  const host = config.host ?? 'venus.local';
  const port = config.port ?? (effectiveTls ? 8883 : 1883);

  const options: VictronMqttConnectOptions = {
    username: config.username || undefined,
    password: config.password || undefined,
    reconnectPeriod: config.reconnectPeriod ?? 0,
  };

  if (effectiveTls) {
    options.rejectUnauthorized = config.tlsVerify !== false;

    if (hasTlsCa(config.tlsCa)) {
      options.ca = [config.tlsCa] as string[] | Buffer[];
    }

    const fingerprint = normalizeFingerprint(config.tlsFingerprint);
    if (fingerprint) {
      options.checkServerIdentity = (_hostname, cert) => {
        const actual = createHash('sha256').update(cert.raw).digest('hex');
        if (actual === fingerprint) return undefined;
        return new Error(`Certificate fingerprint mismatch: got ${actual}, expected ${fingerprint}`);
      };
    }
  }

  return { url: `${protocol}://${host}:${port}`, options };
}

interface WaitForMessageOptions {
  timeoutMs?: number;
  label?: string;
}

interface ReadSettingOptions {
  serial?: string;
  timeoutMs?: number;
}

export class VictronMqttClient {
  host: string;
  port: number;
  username: string | undefined;
  password: string | undefined;
  reconnectPeriod: number;
  serial: string | null;
  private _config: VictronMqttConfig;
  private _serialPromise: Promise<string> | null;
  private _clientPromise: Promise<MqttClient> | null;

  constructor(config: VictronMqttConfig = {}) {
    validateTlsConfig(config);

    const {
      host = 'venus.local',
      port,
      username = '',
      password = '',
      reconnectPeriod = 0,  // 0 = no auto reconnect by default
      serial,               // optional: if you already know the portal id
    } = config;

    this.host = host;
    this.port = port ?? (resolveProtocol(config) === 'mqtts' ? 8883 : 1883);
    this.username = username || undefined;
    this.password = password || undefined;
    this.reconnectPeriod = reconnectPeriod;
    this._config = config;

    this.serial = serial ?? null;  // cached portal id once known
    this._serialPromise = null;   // in-flight detection, if any
    this._clientPromise = null;
  }

  private async _getClient(): Promise<MqttClient> {
    if (this._clientPromise) return this._clientPromise;

    const { url, options } = buildMqttConnectOptions(this._config);

    const clientPromise = mqtt.connectAsync(url, options);
    this._clientPromise = clientPromise;

    let client: MqttClient;
    try {
      client = await clientPromise;
    } catch (err) {
      if (this._clientPromise === clientPromise) this._clientPromise = null;
      throw err;
    }

    client.on('error', (err) => {
      console.error('[victron-mqtt] client error:', err.message);
    });
    // With reconnectPeriod 0 the client never reconnects on its own; drop the cached
    // instance when the connection closes so the next call establishes a fresh one.
    client.on('close', () => {
      if (this._clientPromise === clientPromise) this._clientPromise = null;
    });

    return client;
  }

  async close(): Promise<void> {
    if (!this._clientPromise) return;
    const client = await this._clientPromise;
    this._clientPromise = null;
    await client.endAsync();
  }

  // ---------------------------------------------------------------------------
  // Internal helper: wait for the first message that matchFn() accepts
  // matchFn(topic, payload) -> result | undefined
  // ---------------------------------------------------------------------------
  private _waitForFirstMessage<T>(
    client: MqttClient,
    matchFn: (topic: string, payload: Buffer) => T | undefined,
    { timeoutMs = 2000, label = 'message' }: WaitForMessageOptions = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof client.off === 'function') {
          client.off('message', handler);
        } else {
          client.removeListener('message', handler);
        }
      };

      const handler = (topic: string, payload: Buffer) => {
        if (settled) return;
        try {
          const maybeResult = matchFn(topic, payload);
          if (maybeResult === undefined) return;
          cleanup();
          resolve(maybeResult);
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);

      client.on('message', handler);
    });
  }

  // ---------------------------------------------------------------------------
  // Serial / portal id detection
  // ---------------------------------------------------------------------------

  /**
   * Public API: get the Victron serial (portal id).
   * - If already known, returns cached value.
   * - Otherwise subscribes once to the serial wildcard and resolves from payload.value.
   */
  async getSerial({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<string> {
    if (this.serial) return this.serial;

    if (!this._serialPromise) {
      this._serialPromise = this._detectSerialOnce({ timeoutMs });
    }

    try {
      const serial = await this._serialPromise;
      this.serial = serial;
      return serial;
    } finally {
      // always clear so a later call can retry if detection failed
      this._serialPromise = null;
    }
  }

  // Internal: one-shot detection using the serial wildcard topic
  private async _detectSerialOnce({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<string> {
    const client = await this._getClient();

    const wait = this._waitForFirstMessage(
      client,
      (topic, payload) => (isSerialTopic(topic) ? parseSerialPayload(payload) : undefined),
      { timeoutMs, label: SERIAL_WILDCARD_TOPIC },
    );

    try {
      await client.subscribeAsync(SERIAL_WILDCARD_TOPIC);
      const serial = await wait;
      return serial;
    } finally {
      try {
        await client.unsubscribeAsync(SERIAL_WILDCARD_TOPIC);
      } catch {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------------

  async publishJson(topic: string, payload: unknown, { qos = 0, retain = false }: { qos?: 0 | 1 | 2; retain?: boolean } = {}): Promise<void> {
    const client = await this._getClient();
    const json = JSON.stringify(payload);
    await client.publishAsync(topic, json, { qos, retain });
  }

  /**
   * Subscribe to a specific topic and resolve with the first JSON payload.
   * If requestTopic is given, publish an empty message there after subscribe.
   */
  async readJsonOnce(topic: string, { timeoutMs = 2000, requestTopic: request }: { timeoutMs?: number; requestTopic?: string } = {}): Promise<unknown> {
    const client = await this._getClient();

    const wait = this._waitForFirstMessage(
      client,
      (incomingTopic, payload) => {
        if (incomingTopic !== topic) return undefined;
        return JSON.parse(payload.toString()) as unknown;
      },
      { timeoutMs, label: topic },
    );

    try {
      await client.subscribeAsync(topic);
      if (request) {
        await client.publishAsync(request, '');
      }
      return await wait;
    } finally {
      try {
        await client.unsubscribeAsync(topic);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Generic setting read helper:
   *   - Reads from N/<serial>/<relativePath>
   *   - Triggers R/<serial>/<relativePath> first to force an update
   */
  async readSetting(relativePath: string, { serial, timeoutMs = 2000 }: ReadSettingOptions = {}): Promise<unknown> {
    const s = serial ?? (await this.getSerial({ timeoutMs }));
    return this.readJsonOnce(readTopic(s, relativePath), {
      timeoutMs,
      requestTopic: requestTopic(s, relativePath),
    });
  }

  /**
   * Generic write helper: writes {"value": X} to W/<serial>/<relativePath>
   */
  async writeSetting(relativePath: string, value: unknown, { serial }: { serial?: string } = {}): Promise<void> {
    const s = serial ?? (await this.getSerial());
    await this.publishJson(writeTopic(s, relativePath), { value });
  }

  // ---------------------------------------------------------------------------
  // Battery SoC helpers
  // ---------------------------------------------------------------------------

  /** Read the current system-level battery state-of-charge (%) via MQTT. */
  async readSocPercent({ timeoutMs = 8000 }: { timeoutMs?: number } = {}): Promise<{ soc_percent: number | null; raw: unknown }> {
    const s = await this.getSerial({ timeoutMs });
    const payload = await this.readSetting(SOC_PATH, { serial: s, timeoutMs }) as { value?: unknown } | null;
    return { soc_percent: parsePercentPayload(payload), raw: payload };
  }

  /**
   * Read the ESS SoC limits (%) via MQTT: the minimum SoC (reserve for grid
   * failures) and the active BatteryLife / ESS upper bound.
   */
  async readSocLimitsPercent({ timeoutMs = 8000 }: { timeoutMs?: number } = {}): Promise<{ minSoc_percent: number | null; maxSoc_percent: number | null; raw: { min: unknown; max: unknown } }> {
    const s = await this.getSerial({ timeoutMs });

    const [minPayload, maxPayload] = await Promise.all([
      this.readSetting(MIN_SOC_LIMIT_PATH, { serial: s, timeoutMs }),
      this.readSetting(MAX_SOC_LIMIT_PATH, { serial: s, timeoutMs }),
    ]) as [{ value?: unknown } | null, { value?: unknown } | null];

    return {
      minSoc_percent: parsePercentPayload(minPayload),
      maxSoc_percent: parsePercentPayload(maxPayload),
      raw: { min: minPayload, max: maxPayload },
    };
  }

  // ---------------------------------------------------------------------------
  // Dynamic ESS schedule helpers
  // ---------------------------------------------------------------------------

  /** Write a single Dynamic ESS schedule slot. */
  async writeScheduleSlot(slotIndex: number, slot: ScheduleSlot, { serial }: { serial?: string } = {}): Promise<void> {
    const s = serial ?? (await this.getSerial());
    await Promise.all(
      scheduleSlotWrites(slotIndex, slot).map(({ path, value }) => this.writeSetting(path, value, { serial: s })),
    );
  }
}

// Convenience helper for one-off scripts
export async function withVictronMqtt<T>(config: VictronMqttConfig, fn: (client: VictronMqttClient) => Promise<T>): Promise<T> {
  const client = new VictronMqttClient(config);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
