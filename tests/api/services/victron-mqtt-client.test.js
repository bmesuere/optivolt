import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VictronMqttClient } from '../../../api/services/victron-mqtt-client.ts';

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
