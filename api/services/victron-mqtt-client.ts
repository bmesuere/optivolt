/**
 * victron-mqtt-client.ts
 *
 * MQTT client for a Victron GX device.
 * Uses the pure topic construction and payload encoding from lib/victron-topics.ts.
 */

import mqtt, { type MqttClient } from 'mqtt';
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
  protocol: string;
  reconnectPeriod: number;
  serial: string | null;
  private _serialPromise: Promise<string> | null;
  private _clientPromise: Promise<MqttClient> | null;

  constructor({
    host = 'venus.local',
    port = 1883,
    username = '',
    password = '',
    protocol = 'mqtt',    // 'mqtt', 'ws', 'wss', ...
    reconnectPeriod = 0,  // 0 = no auto reconnect by default
    serial,               // optional: if you already know the portal id
  }: VictronMqttConfig = {}) {
    this.host = host;
    this.port = port;
    this.username = username || undefined;
    this.password = password || undefined;
    this.protocol = protocol;
    this.reconnectPeriod = reconnectPeriod;

    this.serial = serial ?? null;  // cached portal id once known
    this._serialPromise = null;   // in-flight detection, if any
    this._clientPromise = null;
  }

  private async _getClient(): Promise<MqttClient> {
    if (this._clientPromise) return this._clientPromise;

    const url = `${this.protocol}://${this.host}:${this.port}`;

    const clientPromise = mqtt.connectAsync(url, {
      username: this.username,
      password: this.password,
      reconnectPeriod: this.reconnectPeriod,
    });
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
