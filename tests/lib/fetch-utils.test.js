import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from '../../lib/fetch-utils.ts';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes a timeout signal to fetch', async () => {
    const response = { ok: true };
    global.fetch.mockResolvedValue(response);

    await expect(fetchWithTimeout('https://example.com', {}, {
      timeoutMs: 1000,
      label: 'Example request',
    })).resolves.toBe(response);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('maps aborts to a stable timeout error', async () => {
    global.fetch.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(fetchWithTimeout('https://example.com', {}, {
      timeoutMs: 20,
      label: 'Example request',
    })).rejects.toThrow('Example request timed out after 20ms');
  });

  it('preserves non-timeout failures', async () => {
    global.fetch.mockRejectedValue(new Error('DNS failed'));

    await expect(fetchWithTimeout('https://example.com', {}, {
      timeoutMs: 20,
      label: 'Example request',
    })).rejects.toThrow('DNS failed');
  });
});
