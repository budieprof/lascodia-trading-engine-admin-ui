import { describe, expect, it, vi } from 'vitest';

import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  isChunkLoadError,
  reloadOnceForChunkError,
} from './chunk-reload';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('isChunkLoadError', () => {
  it('recognises every browser’s failed dynamic import, also wrapped', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/chunk-ABCDEFGH.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: 'x' })).toBe(true);
    expect(isChunkLoadError({ rejection: new TypeError('Importing a module script failed.') })).toBe(true);
  });

  it('ignores everything else', () => {
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
  });
});

describe('reloadOnceForChunkError', () => {
  const err = new TypeError('Failed to fetch dynamically imported module');

  it('reloads once, then not again within the window', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadOnceForChunkError(err, { storage, reload, now: 1_000_000 })).toBe(true);
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe('1000000');
    expect(reloadOnceForChunkError(err, { storage, reload, now: 1_000_000 + 5_000 })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(
      reloadOnceForChunkError(err, { storage, reload, now: 1_000_000 + CHUNK_RELOAD_WINDOW_MS + 1 }),
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads for other errors, or without storage for the loop guard', () => {
    const reload = vi.fn();
    expect(reloadOnceForChunkError(new Error('boom'), { storage: memoryStorage(), reload })).toBe(false);
    expect(reloadOnceForChunkError(err, { storage: null, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
