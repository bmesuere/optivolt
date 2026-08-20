import { describe, it, expect } from 'vitest';
import {
  SERIAL_WILDCARD_TOPIC,
  isSerialTopic,
  parsePercentPayload,
  parseSerialPayload,
  readTopic,
  requestTopic,
  scheduleSlotWrites,
  writeTopic,
} from '../../lib/victron-topics.ts';

describe('topic builders', () => {
  it('prefixes read/request/write topics with the serial', () => {
    expect(readTopic('abc123', 'system/0/Dc/Battery/Soc')).toBe('N/abc123/system/0/Dc/Battery/Soc');
    expect(requestTopic('abc123', 'system/0/Dc/Battery/Soc')).toBe('R/abc123/system/0/Dc/Battery/Soc');
    expect(writeTopic('abc123', 'settings/0/Settings/DynamicEss/Schedule/0/Start')).toBe(
      'W/abc123/settings/0/Settings/DynamicEss/Schedule/0/Start',
    );
  });
});

describe('serial detection', () => {
  it('accepts only serial topics from the shared message stream', () => {
    expect(SERIAL_WILDCARD_TOPIC).toBe('N/+/system/0/Serial');
    expect(isSerialTopic('N/abc123/system/0/Serial')).toBe(true);
    expect(isSerialTopic('N/abc123/system/0/Dc/Battery/Soc')).toBe(false);
    expect(isSerialTopic('W/abc123/system/0/Serial')).toBe(false);
    // The serial segment is a single level: a nested path must not match.
    expect(isSerialTopic('N/abc/123/system/0/Serial')).toBe(false);
  });

  it('reads the portal id out of the payload', () => {
    expect(parseSerialPayload(Buffer.from('{"value":"d41243af8c1f"}'))).toBe('d41243af8c1f');
    expect(parseSerialPayload('{}')).toBeUndefined();
  });

  it('throws on a malformed payload so the caller can retry', () => {
    expect(() => parseSerialPayload('not json')).toThrow();
  });
});

describe('parsePercentPayload', () => {
  it('clamps to [0, 100]', () => {
    expect(parsePercentPayload({ value: 55 })).toBe(55);
    expect(parsePercentPayload({ value: '42.5' })).toBe(42.5);
    expect(parsePercentPayload({ value: 120 })).toBe(100);
    expect(parsePercentPayload({ value: -5 })).toBe(0);
  });

  it('returns null for the "no value" shapes Victron sends', () => {
    expect(parsePercentPayload({ value: [] })).toBeNull();
    expect(parsePercentPayload({ value: null })).toBeNull();
    expect(parsePercentPayload({})).toBeNull();
    expect(parsePercentPayload(null)).toBeNull();
    expect(parsePercentPayload(undefined)).toBeNull();
    expect(parsePercentPayload({ value: 'unknown' })).toBeNull();
  });
});

describe('scheduleSlotWrites', () => {
  const slot = {
    startEpoch: 1_700_000_000,
    durationSeconds: 900,
    strategy: 1,
    flags: 0,
    socTarget: 80,
    restrictions: 2,
    allowGridFeedIn: 1,
  };

  it('maps a full slot onto the DynamicEss schedule paths', () => {
    expect(scheduleSlotWrites(3, slot)).toEqual([
      { path: 'settings/0/Settings/DynamicEss/Schedule/3/Start', value: 1_700_000_000 },
      { path: 'settings/0/Settings/DynamicEss/Schedule/3/Duration', value: 900 },
      { path: 'settings/0/Settings/DynamicEss/Schedule/3/Strategy', value: 1 },
      { path: 'settings/0/Settings/DynamicEss/Schedule/3/Flags', value: 0 },
      { path: 'settings/0/Settings/DynamicEss/Schedule/3/Soc', value: 80 },
      { path: 'settings/0/Settings/DynamicEss/Schedule/3/TargetSoc', value: 80 },
      { path: 'settings/0/Settings/DynamicEss/Schedule/3/Restrictions', value: 2 },
      { path: 'settings/0/Settings/DynamicEss/Schedule/3/AllowGridFeedIn', value: 1 },
    ]);
  });

  it('writes both Soc and TargetSoc for a SoC target', () => {
    expect(scheduleSlotWrites(0, { socTarget: 0 })).toEqual([
      { path: 'settings/0/Settings/DynamicEss/Schedule/0/Soc', value: 0 },
      { path: 'settings/0/Settings/DynamicEss/Schedule/0/TargetSoc', value: 0 },
    ]);
  });

  it('skips undefined fields instead of writing them', () => {
    expect(scheduleSlotWrites(1, { strategy: 0 })).toEqual([
      { path: 'settings/0/Settings/DynamicEss/Schedule/1/Strategy', value: 0 },
    ]);
    expect(scheduleSlotWrites(1, {})).toEqual([]);
  });
});
