// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getJson, postJson } from '../../../app/scr/api/client.js';

describe('API Client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getJson calls fetch with GET', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true }),
    });

    const res = await getJson('/test');
    expect(fetchMock).toHaveBeenCalledWith('./test', expect.objectContaining({ method: 'GET' }));
    expect(res).toEqual({ success: true });
  });

  it('postJson calls fetch with POST and payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true }),
    });

    const payload = { foo: 'bar' };
    const res = await postJson('/test', payload);

    expect(fetchMock).toHaveBeenCalledWith('./test', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
    }));
    expect(res).toEqual({ success: true });
  });

  it('throws error on non-ok response', async () => {
     fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'Bad Request' }),
    });

    await expect(getJson('/fail')).rejects.toThrow('Bad Request');
  });

  it('throws error on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('Network Error'));
      await expect(getJson('/fail')).rejects.toThrow('Network Error');
  });
});
