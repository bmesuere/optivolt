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
    global.fetch.mockImplementation((_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    await expect(fetchWithTimeout('https://example.com', {}, {
      timeoutMs: 5,
      label: 'Example request',
    })).rejects.toThrow('Example request timed out after 5ms');
  });

  it('preserves caller-initiated aborts', async () => {
    const controller = new AbortController();
    global.fetch.mockImplementation((_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    const request = fetchWithTimeout(
      'https://example.com',
      { signal: controller.signal },
      { timeoutMs: 1000, label: 'Example request' },
    );
    controller.abort(new DOMException('Caller cancelled', 'AbortError'));

    await expect(request).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Caller cancelled',
    });
  });

  it('preserves non-timeout failures', async () => {
    global.fetch.mockRejectedValue(new Error('DNS failed'));

    await expect(fetchWithTimeout('https://example.com', {}, {
      timeoutMs: 20,
      label: 'Example request',
    })).rejects.toThrow('DNS failed');
  });
});
