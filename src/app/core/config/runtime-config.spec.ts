import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig, RuntimeConfigUnavailableError } from './runtime-config';
import { authModeFrom } from '../auth/auth-mode';

const GOOD = { apiBaseUrl: '', featureFlags: { bffAuth: true }, releaseId: 'r1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const noSleep = () => Promise.resolve();

describe('loadRuntimeConfig', () => {
  it('returns the served settings on the first good answer', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(GOOD));
    const cfg = await loadRuntimeConfig({ fetchFn, sleep: noSleep, onFailure: 'throw' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(authModeFrom(cfg)).toBe('bff');
    expect(cfg.releaseId).toBe('r1');
  });

  it('retries a failed read and uses the answer that arrives', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(GOOD));
    const cfg = await loadRuntimeConfig({ fetchFn, sleep: noSleep, onFailure: 'throw' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(authModeFrom(cfg)).toBe('bff');
  });

  it('treats an HTML page answered with 200 as a failure, not as empty settings', async () => {
    const html = () =>
      new Response('<!doctype html><title>Just a moment…</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(html()));
    await expect(
      loadRuntimeConfig({ fetchFn, sleep: noSleep, onFailure: 'throw' }),
    ).rejects.toBeInstanceOf(RuntimeConfigUnavailableError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('rejects JSON that is not an object', async () => {
    const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(null)));
    await expect(
      loadRuntimeConfig({ fetchFn, sleep: noSleep, retryDelaysMs: [], onFailure: 'throw' }),
    ).rejects.toBeInstanceOf(RuntimeConfigUnavailableError);
  });

  it('in production never starts on the defaults (they would show the password sign-in)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('offline'));
    await expect(
      loadRuntimeConfig({ fetchFn, sleep: noSleep, onFailure: 'throw' }),
    ).rejects.toBeInstanceOf(RuntimeConfigUnavailableError);
  });

  it('in development falls back to the defaults after the retries', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('offline'));
    const cfg = await loadRuntimeConfig({ fetchFn, sleep: noSleep, onFailure: 'fallback' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(cfg.featureFlags).toBeUndefined();
  });

  it('waits between attempts', async () => {
    const waits: number[] = [];
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('offline'));
    await loadRuntimeConfig({
      fetchFn,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      onFailure: 'fallback',
    });
    expect(waits).toEqual([500, 1500]);
  });
});
