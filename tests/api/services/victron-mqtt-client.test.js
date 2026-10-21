import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  VictronMqttClient,
  buildMqttConnectOptions,
  validateTlsConfig,
} from '../../../api/services/victron-mqtt-client.ts';
import {
  readVictronSetting,
  shutdownVictronClient,
} from '../../../api/services/mqtt-service.ts';

const envState = vi.hoisted(() => ({
  mqtt: {
    host: 'cerbo.local',
    port: 8883,
    username: 'user',
    password: 'pass',
    tls: true,
    tlsVerify: true,
    tlsCa: '-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----',
    tlsFingerprint: 'ab'.repeat(32),
  },
}));

vi.mock('../../../api/env.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getMqttEnv: () => envState.mqtt };
});

// Fake broker: records publishes and answers R/<serial>/<path> requests with a
// canned value on the matching N/ topic, the way a GX device does.
const { connectAsync, fake } = vi.hoisted(() => {
  const listeners = new Map();
  const fake = {
    published: [],
    subscribed: [],
    values: new Map(),
    listeners,
    on: (event, handler) => { listeners.set(event, [...(listeners.get(event) ?? []), handler]); },
    off: (event, handler) => { listeners.set(event, (listeners.get(event) ?? []).filter(h => h !== handler)); },
    emit: (event, ...args) => { for (const h of [...(listeners.get(event) ?? [])]) h(...args); },
    subscribeAsync: vi.fn(async (topic) => { fake.subscribed.push(topic); }),
    unsubscribeAsync: vi.fn(async () => {}),
    endAsync: vi.fn(async () => {}),
    publishAsync: vi.fn(async (topic, message) => {
      fake.published.push({ topic, message });
      if (topic.startsWith('R/')) {
        const answer = `N/${topic.slice(2)}`;
        const value = fake.values.get(answer);
        if (value !== undefined) {
          setImmediate(() => fake.emit('message', answer, Buffer.from(JSON.stringify(value))));
        }
      }
    }),
  };
  return { fake, connectAsync: vi.fn(async () => fake) };
});

vi.mock('mqtt', () => ({ default: { connectAsync } }));

describe('VictronMqttClient', () => {
  beforeEach(() => {
    fake.published.length = 0;
    fake.subscribed.length = 0;
    fake.values.clear();
    fake.listeners.clear();
    connectAsync.mockClear();
  });

  const client = (config = {}) => new VictronMqttClient({ serial: 'abc123', ...config });
  const ca = '-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----';
  const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

  it('connects over mqtts with a CA and fingerprint pin', async () => {
    const raw = Buffer.from('test-certificate');
    const c = client({
      host: 'cerbo.local',
      port: 8883,
      tls: true,
      tlsCa: ca,
      tlsFingerprint: sha256(raw),
    });

    await c.writeSetting('some/path', 1);

    const [url, options] = connectAsync.mock.calls[0];
    expect(url).toBe('mqtts://cerbo.local:8883');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca).toEqual([ca]);
    expect(typeof options.checkServerIdentity).toBe('function');
    expect(options.checkServerIdentity('cerbo.local', { raw })).toBeUndefined();
  });

  it('connects over plain mqtt without any TLS options', async () => {
    const c = client({ host: 'cerbo.local', port: 1883, username: 'user', password: 'pass' });

    await c.writeSetting('some/path', 1);

    const [url, options] = connectAsync.mock.calls[0];
    expect(url).toBe('mqtt://cerbo.local:1883');
    expect(Object.keys(options).sort()).toEqual(['password', 'reconnectPeriod', 'username']);
    expect(options).not.toHaveProperty('rejectUnauthorized');
    expect(options).not.toHaveProperty('ca');
    expect(options).not.toHaveProperty('checkServerIdentity');
  });

  it('rejects tls: true combined with an explicit plain protocol', () => {
    for (const protocol of ['mqtt', 'ws']) {
      const config = { host: 'cerbo.local', protocol, tls: true };
      expect(() => new VictronMqttClient(config)).toThrow(
        new RegExp(`conflicts with protocol "${protocol}"`),
      );
      expect(() => buildMqttConnectOptions(config)).toThrow(
        new RegExp(`conflicts with protocol "${protocol}"`),
      );
    }
  });

  it('derives mqtts from an explicit protocol when tls is unset', async () => {
    const c = client({ host: 'cerbo.local', port: 8883, protocol: 'mqtts', tlsCa: ca });

    await c.writeSetting('some/path', 1);

    const [url, options] = connectAsync.mock.calls[0];
    expect(url).toBe('mqtts://cerbo.local:8883');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca).toEqual([ca]);
  });

  it('defaults the port from the effective TLS mode, with an explicit port always winning', () => {
    expect(buildMqttConnectOptions({ host: 'cerbo.local', tls: true }).url)
      .toBe('mqtts://cerbo.local:8883');
    expect(buildMqttConnectOptions({ host: 'cerbo.local' }).url)
      .toBe('mqtt://cerbo.local:1883');
    expect(buildMqttConnectOptions({ host: 'cerbo.local', protocol: 'mqtts' }).url)
      .toBe('mqtts://cerbo.local:8883');
    expect(buildMqttConnectOptions({ host: 'cerbo.local', port: 1234, tls: true }).url)
      .toBe('mqtts://cerbo.local:1234');

    expect(new VictronMqttClient({ tls: true, tlsCa: ca }).port).toBe(8883);
    expect(new VictronMqttClient({}).port).toBe(1883);
    expect(new VictronMqttClient({ port: 1234, tls: true }).port).toBe(1234);
  });

  it('accepts a matching fingerprint and rejects a mismatching one', () => {
    const raw = Buffer.from('certificate');
    const expected = sha256(raw);

    const matching = buildMqttConnectOptions({
      tls: true,
      tlsCa: ca,
      tlsFingerprint: expected.toUpperCase().replace(/(..)/g, '$1:'),
    });
    expect(matching.options.checkServerIdentity('cerbo.local', { raw })).toBeUndefined();

    const wrong = sha256(Buffer.from('other-certificate'));
    const mismatching = buildMqttConnectOptions({ tls: true, tlsCa: ca, tlsFingerprint: wrong });
    const error = mismatching.options.checkServerIdentity('cerbo.local', { raw });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(expected);
    expect(error.message).toContain(wrong);
  });

  it.each([
    ['fingerprint without a CA', { tls: true, tlsFingerprint: 'a'.repeat(64) }],
    ['fingerprint with tlsVerify: false', { tls: true, tlsCa: ca, tlsFingerprint: 'a'.repeat(64), tlsVerify: false }],
    ['fingerprint with TLS disabled', { tls: false, tlsCa: ca, tlsFingerprint: 'a'.repeat(64) }],
    ['CA with TLS disabled', { tls: false, tlsCa: ca }],
  ])('fails closed for %s', (_label, config) => {
    expect(() => new VictronMqttClient(config)).toThrow();
    expect(() => buildMqttConnectOptions(config)).toThrow();
  });

  it.each([
    ['separator-only', '::'],
    ['too short', 'aabbcc'],
    ['SHA-1 length', 'ab'.repeat(20)],
    ['non-hex', 'z'.repeat(64)],
  ])('rejects a malformed fingerprint (%s)', (_label, tlsFingerprint) => {
    const config = { tls: true, tlsCa: ca, tlsFingerprint };
    expect(() => validateTlsConfig(config)).toThrow(/64-character SHA-256/);
    expect(() => new VictronMqttClient(config)).toThrow(/64-character SHA-256/);
    expect(() => buildMqttConnectOptions(config)).toThrow(/64-character SHA-256/);
  });

  it('passes rejectUnauthorized: false when verification is explicitly disabled', async () => {
    const c = client({
      host: 'cerbo.local',
      port: 8883,
      tls: true,
      tlsCa: ca,
      tlsVerify: false,
    });

    await c.writeSetting('some/path', 1);

    const [url, options] = connectAsync.mock.calls[0];
    expect(url).toBe('mqtts://cerbo.local:8883');
    expect(options.rejectUnauthorized).toBe(false);
    expect(options.ca).toEqual([ca]);
    expect(options).not.toHaveProperty('checkServerIdentity');
  });

  it('publishes every field of a schedule slot as its own setting write', async () => {
    await client().writeScheduleSlot(2, {
      startEpoch: 1_700_000_000,
      durationSeconds: 900,
      strategy: 1,
      socTarget: 80,
    });

    const base = 'W/abc123/settings/0/Settings/DynamicEss/Schedule/2';
    expect(fake.published.map(p => p.topic).sort()).toEqual([
      `${base}/Duration`,
      `${base}/Soc`,
      `${base}/Start`,
      `${base}/Strategy`,
      `${base}/TargetSoc`,
    ]);
    expect(fake.published.find(p => p.topic === `${base}/Start`).message).toBe('{"value":1700000000}');
  });

  it('reads the battery SoC by requesting the value first', async () => {
    fake.values.set('N/abc123/system/0/Dc/Battery/Soc', { value: 47.5 });

    const result = await client().readSocPercent({ timeoutMs: 500 });

    expect(result.soc_percent).toBe(47.5);
    expect(fake.subscribed).toContain('N/abc123/system/0/Dc/Battery/Soc');
    expect(fake.published[0].topic).toBe('R/abc123/system/0/Dc/Battery/Soc');
  });

  it('reads both ESS SoC limits and reports missing ones as null', async () => {
    fake.values.set('N/abc123/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit', { value: 15 });
    fake.values.set('N/abc123/settings/0/Settings/CGwacs/MaxChargePercentage', { value: [] });

    const limits = await client().readSocLimitsPercent({ timeoutMs: 500 });

    expect(limits.minSoc_percent).toBe(15);
    expect(limits.maxSoc_percent).toBeNull();
  });

  it('detects the serial from the wildcard topic and caches it', async () => {
    const c = new VictronMqttClient({});
    const pending = c.getSerial({ timeoutMs: 500 });
    // Traffic from other subscriptions must be ignored.
    setImmediate(() => {
      fake.emit('message', 'N/abc123/system/0/Dc/Battery/Soc', Buffer.from('{"value":50}'));
      fake.emit('message', 'N/serial9/system/0/Serial', Buffer.from('{"value":"serial9"}'));
    });

    expect(await pending).toBe('serial9');
    expect(await c.getSerial()).toBe('serial9');
    expect(fake.subscribed.filter(t => t === 'N/+/system/0/Serial')).toHaveLength(1);
  });

  it('rejects when no answer arrives before the deadline', async () => {
    await expect(client().readSocPercent({ timeoutMs: 20 })).rejects.toThrow(/Timeout after 20ms/);
  });

  it('reuses one connection and drops it on close', async () => {
    const c = client();
    await c.writeSetting('some/path', 1);
    await c.writeSetting('some/other/path', 2);
    expect(connectAsync).toHaveBeenCalledTimes(1);

    await c.close();
    await c.writeSetting('some/path', 3);
    expect(connectAsync).toHaveBeenCalledTimes(2);
  });
});

describe('mqtt-service TLS env forwarding', () => {
  afterEach(async () => {
    await shutdownVictronClient();
  });

  it('forwards tls, tlsVerify, tlsCa, and tlsFingerprint from the environment', async () => {
    await expect(readVictronSetting('some/path', { timeoutMs: 20 })).rejects.toThrow(/Timeout/);

    const [url, options] = connectAsync.mock.calls.at(-1);
    expect(url).toBe('mqtts://cerbo.local:8883');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca).toEqual([envState.mqtt.tlsCa]);
    expect(typeof options.checkServerIdentity).toBe('function');

    const error = options.checkServerIdentity('cerbo.local', { raw: Buffer.from('not-pinned') });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/fingerprint mismatch/i);
  });
});
