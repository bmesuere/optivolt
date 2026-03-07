import { describe, it, expect } from 'vitest';
import { wsUrlToHttp } from '../../../api/services/ha-client.ts';

describe('wsUrlToHttp', () => {
  it('converts ws:// to http://', () => {
    expect(wsUrlToHttp('ws://homeassistant.local:8123/api/websocket')).toBe('http://homeassistant.local:8123');
  });

  it('converts wss:// to https://', () => {
    expect(wsUrlToHttp('wss://homeassistant.example.com:8123/api/websocket')).toBe('https://homeassistant.example.com:8123');
  });

  it('strips /api/websocket suffix', () => {
    expect(wsUrlToHttp('ws://192.168.1.10:8123/api/websocket')).toBe('http://192.168.1.10:8123');
  });

  it('handles URL without /api/websocket suffix', () => {
    expect(wsUrlToHttp('ws://homeassistant.local:8123')).toBe('http://homeassistant.local:8123');
  });
});
