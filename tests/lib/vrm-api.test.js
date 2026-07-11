import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VRMClient } from '../../lib/vrm-api.ts';

describe('VRMClient HTTP requests', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies the configured request deadline', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const client = new VRMClient({ installationId: '123', token: 'secret', timeoutMs: 2500 });

    await client._fetch('/test');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://vrmapi.victronenergy.com/v2/test',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports a clear timeout error', async () => {
    global.fetch.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const client = new VRMClient({ installationId: '123', token: 'secret', timeoutMs: 75 });

    await expect(client._fetch('/test')).rejects.toThrow('VRM API request timed out after 75ms');
  });
});
