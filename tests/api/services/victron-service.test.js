import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { buildTlsOptions } from '../../../api/services/mqtt-service.ts';

describe('buildTlsOptions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty object when MQTT_TLS is false', () => {
    process.env.MQTT_TLS = 'false';
    expect(buildTlsOptions()).toEqual({});
  });

  it('returns rejectUnauthorized: true by default when TLS is enabled', () => {
    process.env.MQTT_TLS = 'true';
    expect(buildTlsOptions()).toEqual({ rejectUnauthorized: true });
  });

  it('returns rejectUnauthorized: false when MQTT_TLS_VERIFY is false', () => {
    process.env.MQTT_TLS = 'true';
    process.env.MQTT_TLS_VERIFY = 'false';
    expect(buildTlsOptions()).toEqual({ rejectUnauthorized: false });
  });

  it('returns checkServerIdentity when fingerprint is set', () => {
    process.env.MQTT_TLS = 'true';
    process.env.MQTT_TLS_FINGERPRINT = 'aabbcc';
    const options = buildTlsOptions();
    expect(options.rejectUnauthorized).toBe(false);
    expect(options.checkServerIdentity).toBeTypeOf('function');
  });

  it('checkServerIdentity passes when fingerprint matches', () => {
    const raw = Buffer.from('testcert');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    process.env.MQTT_TLS = 'true';
    process.env.MQTT_TLS_FINGERPRINT = hash;

    const { checkServerIdentity } = buildTlsOptions();
    expect(checkServerIdentity('venus.local', { raw })).toBeUndefined();
  });

  it('checkServerIdentity throws when fingerprint does not match', () => {
    process.env.MQTT_TLS = 'true';
    process.env.MQTT_TLS_FINGERPRINT = 'aabbcc';

    const { checkServerIdentity } = buildTlsOptions();
    const result = checkServerIdentity('venus.local', { raw: Buffer.from('wrongcert') });
    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toMatch(/fingerprint mismatch/);
  });

  it('normalises fingerprint with colons', () => {
    const raw = Buffer.from('testcert');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const withColons = hash.match(/.{2}/g).join(':');

    process.env.MQTT_TLS = 'true';
    process.env.MQTT_TLS_FINGERPRINT = withColons;

    const { checkServerIdentity } = buildTlsOptions();
    expect(checkServerIdentity('venus.local', { raw })).toBeUndefined();
  });
});
