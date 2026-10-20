/**
 * Per-person, per-organisation `localStorage` (multi-tenancy W3, U3.2).
 *
 * The console used to keep ~45 `lascodia.*` (and `tradingChart.*`) keys global to the browser: the
 * account scope, chart layouts and drawings, Pine drafts, the last LLM analysis per symbol… With
 * organisations, one browser can be used by two people, or one person in two organisations, and
 * none of that may leak across. Every such key is therefore stored under a namespace:
 *
 *     lascodia.<user>.t<tenantId>.<key without its "lascodia." prefix>
 *     lascodia.u12.t1.scope.selectedAccountId
 *     lascodia.u12.t1.tradingChart.watchlist.size.v1
 *
 * `<user>` is `u<adminUserId>` for people (the same id before and after the BFF flip, so preferences
 * survive it) and `acct<tradingAccountId>` for the legacy trading-account web login.
 *
 * Code reads and writes through {@link appStorage} with the key it always used; the namespace is
 * applied underneath. With nobody signed in, managed keys read as absent and writes are dropped.
 * Until the auth layer has configured it (AuthService does so at construction, before any page
 * renders) the storage behaves like plain `localStorage` — which is also what feature unit tests,
 * which never sign anyone in, rely on.
 *
 * Kept global on purpose ({@link GLOBAL_STORAGE_KEYS}): the theme (the login page needs it before
 * anyone is known), the cross-tab idle-activity stamp (one browser, one session cookie, one idle
 * clock) and the migration marker.
 *
 * Migration: the first time a House identity is set in a browser, every un-namespaced managed key
 * is moved into that identity's House namespace (copied when the target is free, then removed), so
 * the person who used this browser before keeps their settings and nobody else inherits them.
 */

/** House is tenant #1 (ADR-0029); legacy sessions always act in it. */
export const HOUSE_TENANT_ID = 1;

/** Marks that the one-time move of un-namespaced keys has happened in this browser. */
export const STORAGE_MIGRATION_MARKER = 'lascodia.storage.migrated.v1';

/** Keys that stay global to the browser. */
export const GLOBAL_STORAGE_KEYS: ReadonlySet<string> = new Set([
  'lascodia.theme',
  'lascodia.idle.lastActivity',
  STORAGE_MIGRATION_MARKER,
]);

const MANAGED_PREFIXES = ['lascodia.', 'tradingChart.'] as const;
const NAMESPACED = /^lascodia\.(?:u|acct)\d+\.t\d+\./;

export interface StorageIdentity {
  /** `u<adminUserId>` or `acct<tradingAccountId>`. */
  userKey: string;
  tenantId: number;
}

/** `lascodia.u12.t1.` */
export function storageNamespace(id: StorageIdentity): string {
  if (!/^(?:u|acct)\d+$/.test(id.userKey) || !Number.isInteger(id.tenantId) || id.tenantId <= 0) {
    throw new Error(`invalid storage identity ${id.userKey}/${id.tenantId}`);
  }
  return `lascodia.${id.userKey}.t${id.tenantId}.`;
}

/** True for a key the namespace applies to (as written by feature code, i.e. not yet namespaced). */
export function isManagedKey(key: string): boolean {
  return (
    MANAGED_PREFIXES.some((p) => key.startsWith(p)) &&
    !GLOBAL_STORAGE_KEYS.has(key) &&
    !NAMESPACED.test(key)
  );
}

function suffixOf(key: string): string {
  return key.startsWith('lascodia.') ? key.slice('lascodia.'.length) : key;
}

/**
 * A `Storage` that namespaces managed keys. Exported as a class for tests; the app uses the
 * {@link appStorage} singleton over `window.localStorage`.
 */
export class NamespacedStorage implements Storage {
  /** undefined = not configured yet (plain localStorage); null = signed out; else the prefix. */
  private ns: string | null | undefined = undefined;

  constructor(private readonly backing: () => Storage | null) {}

  /** Switch identity (null = signed out). A House identity triggers the one-time migration. */
  setIdentity(id: StorageIdentity | null): void {
    this.ns = id ? storageNamespace(id) : null;
    if (id && this.ns && id.tenantId === HOUSE_TENANT_ID) this.migrateInto(this.ns);
  }

  /** The current namespace prefix; null when signed out; undefined before configuration. */
  get namespace(): string | null | undefined {
    return this.ns;
  }

  /** The physical key for a logical one; null when the key is managed and nobody is signed in. */
  physicalKey(key: string): string | null {
    if (this.ns === undefined || !isManagedKey(key)) return key;
    return this.ns ? this.ns + suffixOf(key) : null;
  }

  getItem(key: string): string | null {
    const physical = this.physicalKey(key);
    if (physical === null) return null;
    try {
      return this.backing()?.getItem(physical) ?? null;
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    const physical = this.physicalKey(key);
    if (physical === null) return;
    // Quota and blocked-storage errors propagate exactly as localStorage's would: callers already
    // guard their writes.
    this.backing()?.setItem(physical, value);
  }

  removeItem(key: string): void {
    const physical = this.physicalKey(key);
    if (physical === null) return;
    try {
      this.backing()?.removeItem(physical);
    } catch {
      /* storage blocked */
    }
  }

  /** Logical keys visible to the current identity: its namespace plus unmanaged/global keys. */
  private visibleKeys(): string[] {
    const s = this.backing();
    if (!s) return [];
    const out: string[] = [];
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k === null) continue;
        if (this.ns === undefined) {
          out.push(k);
        } else if (this.ns && k.startsWith(this.ns)) {
          const suffix = k.slice(this.ns.length);
          out.push(suffix.startsWith('tradingChart.') ? suffix : `lascodia.${suffix}`);
        } else if (!NAMESPACED.test(k) && !isManagedKey(k)) {
          out.push(k);
        }
      }
    } catch {
      return [];
    }
    return out;
  }

  get length(): number {
    return this.visibleKeys().length;
  }

  key(index: number): string | null {
    return this.visibleKeys()[index] ?? null;
  }

  /** Clears only the current identity's namespace (never other people's, never global keys). */
  clear(): void {
    const s = this.backing();
    if (!s) return;
    if (this.ns === undefined) {
      s.clear();
      return;
    }
    if (!this.ns) return;
    const mine: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(this.ns)) mine.push(k);
    }
    for (const k of mine) s.removeItem(k);
  }

  private migrateInto(ns: string): void {
    const s = this.backing();
    if (!s) return;
    try {
      if (s.getItem(STORAGE_MIGRATION_MARKER)) return;
      const legacy: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null && isManagedKey(k)) legacy.push(k);
      }
      let complete = true;
      for (const k of legacy) {
        try {
          const target = ns + suffixOf(k);
          const value = s.getItem(k);
          if (value !== null && s.getItem(target) === null) s.setItem(target, value);
          s.removeItem(k);
        } catch {
          complete = false; // quota: leave this key for the next sign-in to retry
        }
      }
      if (complete) s.setItem(STORAGE_MIGRATION_MARKER, ns);
    } catch {
      /* storage blocked — nothing to migrate */
    }
  }
}

function browserLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The app's localStorage. Use it everywhere instead of `localStorage`. */
export const appStorage = new NamespacedStorage(browserLocalStorage);

/** Called by AuthService whenever the signed-in identity or organisation changes. */
export function setStorageIdentity(id: StorageIdentity | null): void {
  appStorage.setIdentity(id);
}
