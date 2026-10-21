import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAddon, supervisorToken, getVrmCredentials, getMqttEnv, getServerEnv } from '../../api/env.ts';

const ENV_KEYS = [
  'SUPERVISOR_TOKEN',
  'VRM_INSTALLATION_ID',
  'VRM_TOKEN',
  'MQTT_HOST',
  'MQTT_PORT',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
  'MQTT_TLS',
  'MQTT_TLS_VERIFY',
  'MQTT_TLS_CA',
  'MQTT_TLS_FINGERPRINT',
  'HOST',
  'PORT',
];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('env', () => {
  it('detects add-on mode from SUPERVISOR_TOKEN', () => {
    expect(isAddon()).toBe(false);
    expect(supervisorToken()).toBeUndefined();
    process.env.SUPERVISOR_TOKEN = 'abc';
    expect(isAddon()).toBe(true);
    expect(supervisorToken()).toBe('abc');
  });

  it('returns trimmed VRM credentials', () => {
    process.env.VRM_INSTALLATION_ID = ' 123 ';
    process.env.VRM_TOKEN = ' tok ';
    expect(getVrmCredentials()).toEqual({ installationId: '123', token: 'tok' });
  });

  it('throws a user-facing message per missing VRM field', () => {
    expect(() => getVrmCredentials()).toThrow(/VRM Site ID not configured/);
    process.env.VRM_INSTALLATION_ID = '123';
    expect(() => getVrmCredentials()).toThrow(/VRM API token not configured/);
  });

  it('provides MQTT and server defaults', () => {
    expect(getMqttEnv()).toEqual({
      host: 'venus.local',
      port: 1883,
      username: '',
      password: '',
      tls: false,
      tlsVerify: true,
      tlsCa: undefined,
      tlsFingerprint: undefined,
    });
    expect(getServerEnv()).toEqual({ host: '0.0.0.0', port: 3000 });
    process.env.PORT = '4123';
    expect(getServerEnv().port).toBe(4123);
  });

  it('uses the host, username and password from the environment', () => {
    process.env.MQTT_HOST = 'cerbo.local';
    process.env.MQTT_USERNAME = 'user';
    process.env.MQTT_PASSWORD = 'pass';
    expect(getMqttEnv()).toMatchObject({ host: 'cerbo.local', username: 'user', password: 'pass' });
  });
});

describe('getMqttEnv port', () => {
  it('defaults to 8883 when TLS is on and no port is set', () => {
    process.env.MQTT_TLS = 'true';
    expect(getMqttEnv().port).toBe(8883);
  });

  it('lets an explicit positive port win over the TLS default', () => {
    process.env.MQTT_TLS = 'true';
    process.env.MQTT_PORT = '1234';
    expect(getMqttEnv().port).toBe(1234);
  });

  it('lets an explicit port win when TLS is off', () => {
    process.env.MQTT_TLS = 'false';
    process.env.MQTT_PORT = '8883';
    expect(getMqttEnv().port).toBe(8883);
  });

  it('treats port 0 as auto for both TLS modes', () => {
    process.env.MQTT_PORT = '0';
    process.env.MQTT_TLS = 'true';
    expect(getMqttEnv().port).toBe(8883);
    process.env.MQTT_TLS = 'false';
    expect(getMqttEnv().port).toBe(1883);
  });

  it('treats empty and non-numeric ports as auto', () => {
    process.env.MQTT_PORT = '';
    expect(getMqttEnv().port).toBe(1883);
    process.env.MQTT_PORT = 'abc';
    expect(getMqttEnv().port).toBe(1883);
    process.env.MQTT_PORT = '-1';
    expect(getMqttEnv().port).toBe(1883);
    process.env.MQTT_PORT = '1883abc';
    expect(getMqttEnv().port).toBe(1883);
  });

  it('rejects exponent, hex, decimal and out-of-range ports and falls back to auto', () => {
    for (const value of ['1e3', '0x10', '18.83', '70000', '65536', ' 1883']) {
      process.env.MQTT_PORT = value;
      expect(getMqttEnv().port).toBe(1883);
      process.env.MQTT_TLS = 'true';
      expect(getMqttEnv().port).toBe(8883);
      delete process.env.MQTT_TLS;
    }
    process.env.MQTT_PORT = '65535';
    expect(getMqttEnv().port).toBe(65535);
  });
});

describe('getMqttEnv TLS options', () => {
  it('parses TLS strictly and treats unset or empty as false', () => {
    expect(getMqttEnv().tls).toBe(false);
    process.env.MQTT_TLS = '';
    expect(getMqttEnv().tls).toBe(false);
    process.env.MQTT_TLS = 'false';
    expect(getMqttEnv().tls).toBe(false);
    process.env.MQTT_TLS = 'FALSE';
    expect(getMqttEnv().tls).toBe(false);
    process.env.MQTT_TLS = 'TRUE';
    expect(getMqttEnv().tls).toBe(true);
    process.env.MQTT_TLS = 'true';
    expect(getMqttEnv().tls).toBe(true);
  });

  it.each(['1', '0', 'yes', 'no', 'on', 'off', 'enabled'])(
    'rejects MQTT_TLS=%s instead of silently falling back to plaintext',
    (value) => {
      process.env.MQTT_TLS = value;
      expect(() => getMqttEnv()).toThrow(/MQTT_TLS must be "true" or "false"/);
    },
  );

  it('verifies TLS by default and only disables it for the literal string false', () => {
    expect(getMqttEnv().tlsVerify).toBe(true);
    process.env.MQTT_TLS_VERIFY = 'false';
    expect(getMqttEnv().tlsVerify).toBe(false);
    process.env.MQTT_TLS_VERIFY = '0';
    expect(getMqttEnv().tlsVerify).toBe(true);
    process.env.MQTT_TLS_VERIFY = 'no';
    expect(getMqttEnv().tlsVerify).toBe(true);
  });

  it('normalises the CA: whitespace is undefined and escaped newlines expand', () => {
    expect(getMqttEnv().tlsCa).toBeUndefined();
    process.env.MQTT_TLS_CA = '   \n\t ';
    expect(getMqttEnv().tlsCa).toBeUndefined();
    process.env.MQTT_TLS_CA = 'line1\\nline2';
    expect(getMqttEnv().tlsCa).toBe('line1\nline2');
  });

  it('treats a literal escaped newline as empty after expansion and trimming', () => {
    process.env.MQTT_TLS_CA = '\\n';
    expect(getMqttEnv().tlsCa).toBeUndefined();
    process.env.MQTT_TLS_CA = '\\n  \\n';
    expect(getMqttEnv().tlsCa).toBeUndefined();
  });

  it('preserves real newlines in a PEM', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----';
    process.env.MQTT_TLS_CA = pem;
    expect(getMqttEnv().tlsCa).toBe(pem);
  });

  it('normalises a valid fingerprint to lowercase hex without separators', () => {
    expect(getMqttEnv().tlsFingerprint).toBeUndefined();
    process.env.MQTT_TLS_FINGERPRINT = '   ';
    expect(getMqttEnv().tlsFingerprint).toBeUndefined();
    const hex = 'ab'.repeat(32);
    process.env.MQTT_TLS_FINGERPRINT = hex.toUpperCase().replace(/(..)/g, '$1:');
    expect(getMqttEnv().tlsFingerprint).toBe(hex);
    process.env.MQTT_TLS_FINGERPRINT = hex.replace(/(.{16})/g, '$1 ').trim();
    expect(getMqttEnv().tlsFingerprint).toBe(hex);
  });

  it('rejects malformed fingerprints instead of silently disabling the pin', () => {
    for (const value of ['::', 'aabbcc', 'AB:BB: CC', 'ab'.repeat(20), 'z'.repeat(64)]) {
      process.env.MQTT_TLS_FINGERPRINT = value;
      expect(() => getMqttEnv()).toThrow(/64-character SHA-256 hex string/);
    }
  });
});
