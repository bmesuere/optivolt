import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAddon, supervisorToken, getVrmCredentials, getMqttEnv, getServerEnv } from '../../api/env.ts';

const ENV_KEYS = ['SUPERVISOR_TOKEN', 'VRM_INSTALLATION_ID', 'VRM_TOKEN', 'MQTT_HOST', 'MQTT_PORT', 'HOST', 'PORT'];
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
    expect(getMqttEnv()).toEqual({ host: 'venus.local', port: 1883, username: '', password: '' });
    expect(getServerEnv()).toEqual({ host: '0.0.0.0', port: 3000 });
    process.env.PORT = '4123';
    expect(getServerEnv().port).toBe(4123);
  });
});
