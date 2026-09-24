import type { PineCatalog } from '@core/api/scripting.types';

/**
 * Persists the language catalog between sessions so the editor has full completion and docs
 * the moment it opens; the service then revalidates with `If-None-Match: <version>`.
 *
 * IndexedDB first (the catalog runs to hundreds of kB — too big to be a polite localStorage
 * tenant), localStorage as the fallback. Every access is wrapped: private windows, blocked site
 * data and quota errors all degrade to "no cache", never to an error.
 */

const DB_NAME = 'lascodia-pine';
const STORE = 'cache';
const KEY = 'catalog';
const LS_KEY = 'lascodia.pine.catalog';

function isCatalog(value: unknown): value is PineCatalog {
  const v = value as Partial<PineCatalog> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.version === 'string' &&
    Array.isArray(v.functions) &&
    Array.isArray(v.variables) &&
    Array.isArray(v.constants)
  );
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbRequest<T>(run: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const req = run(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
          tx.onabort = () => db.close();
        } catch {
          db.close();
          resolve(null);
        }
      }),
  );
}

export async function readCachedCatalog(): Promise<PineCatalog | null> {
  try {
    const fromDb = await idbRequest<unknown>((s) => s.get(KEY), 'readonly');
    if (isCatalog(fromDb)) return fromDb;
  } catch {
    /* fall through */
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCatalog(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCachedCatalog(catalog: PineCatalog): Promise<void> {
  let stored = false;
  try {
    stored = (await idbRequest((s) => s.put(catalog, KEY), 'readwrite')) !== null;
  } catch {
    stored = false;
  }
  if (stored) {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* storage unavailable */
    }
    return;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(catalog));
  } catch {
    /* quota exceeded or storage unavailable — run without a cache */
  }
}
