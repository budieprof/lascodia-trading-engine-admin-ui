import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  NamespacedStorage,
  STORAGE_MIGRATION_MARKER,
  isManagedKey,
  storageNamespace,
} from './app-storage';

/** A plain in-memory Storage, so each test starts empty and sees the raw keys. */
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  keys() {
    return [...this.m.keys()].sort();
  }
}

describe('NamespacedStorage', () => {
  let raw: MemoryStorage;
  let store: NamespacedStorage;

  beforeEach(() => {
    raw = new MemoryStorage();
    store = new NamespacedStorage(() => raw);
  });

  it('names namespaces by person and organisation', () => {
    expect(storageNamespace({ userKey: 'u12', tenantId: 3 })).toBe('lascodia.u12.t3.');
    expect(storageNamespace({ userKey: 'acct17', tenantId: 1 })).toBe('lascodia.acct17.t1.');
    expect(() => storageNamespace({ userKey: 'u12.t1', tenantId: 1 })).toThrow();
    expect(() => storageNamespace({ userKey: 'u1', tenantId: 0 })).toThrow();
  });

  it('keeps each person and organisation apart', () => {
    raw.setItem(STORAGE_MIGRATION_MARKER, 'x');
    store.setIdentity({ userKey: 'u1', tenantId: 3 });
    store.setItem('lascodia.scope.selectedAccountId', '17');
    store.setItem('tradingChart.watchlist.size.v1', 'L');
    expect(raw.getItem('lascodia.u1.t3.scope.selectedAccountId')).toBe('17');
    expect(raw.getItem('lascodia.u1.t3.tradingChart.watchlist.size.v1')).toBe('L');

    store.setIdentity({ userKey: 'u1', tenantId: 4 }); // same person, other organisation
    expect(store.getItem('lascodia.scope.selectedAccountId')).toBeNull();
    store.setIdentity({ userKey: 'u2', tenantId: 3 }); // other person, same organisation
    expect(store.getItem('lascodia.scope.selectedAccountId')).toBeNull();
    store.setIdentity({ userKey: 'u1', tenantId: 3 });
    expect(store.getItem('lascodia.scope.selectedAccountId')).toBe('17');
  });

  it('shuts per-person keys while nobody is signed in', () => {
    store.setIdentity(null);
    store.setItem('lascodia.wallMode', '1');
    expect(raw.length).toBe(0);
    raw.setItem('lascodia.u1.t1.wallMode', '1');
    expect(store.getItem('lascodia.wallMode')).toBeNull();
  });

  it('keeps device-level keys global and leaves foreign keys alone', () => {
    store.setIdentity({ userKey: 'u1', tenantId: 3 });
    store.setItem('lascodia.theme', 'dark');
    store.setItem('lascodia.idle.lastActivity', '5');
    store.setItem('other.lib.key', 'v');
    expect(raw.getItem('lascodia.theme')).toBe('dark');
    expect(raw.getItem('lascodia.idle.lastActivity')).toBe('5');
    expect(raw.getItem('other.lib.key')).toBe('v');
    store.setIdentity(null);
    expect(store.getItem('lascodia.theme')).toBe('dark');
  });

  it('behaves like plain localStorage until configured', () => {
    store.setItem('lascodia.wallMode', '1');
    expect(raw.getItem('lascodia.wallMode')).toBe('1');
    expect(store.getItem('lascodia.wallMode')).toBe('1');
  });

  it('moves un-namespaced keys into the first House identity, once', () => {
    raw.setItem('lascodia.scope.selectedAccountId', '22');
    raw.setItem('tradingChart.lastAnalysis.v2:EURUSD:H1', '{}');
    raw.setItem('lascodia.theme', 'dark');
    store.setIdentity({ userKey: 'u7', tenantId: 1 });
    expect(raw.keys()).toEqual([
      'lascodia.storage.migrated.v1',
      'lascodia.theme',
      'lascodia.u7.t1.scope.selectedAccountId',
      'lascodia.u7.t1.tradingChart.lastAnalysis.v2:EURUSD:H1',
    ]);
    expect(store.getItem('lascodia.scope.selectedAccountId')).toBe('22');

    // A later stray un-namespaced key is never handed to the next person.
    raw.setItem('lascodia.scope.selectedAccountId', '99');
    store.setIdentity({ userKey: 'u8', tenantId: 1 });
    expect(store.getItem('lascodia.scope.selectedAccountId')).toBeNull();
  });

  it('does not migrate into a customer organisation', () => {
    raw.setItem('lascodia.scope.selectedAccountId', '22');
    store.setIdentity({ userKey: 'u7', tenantId: 3 });
    expect(raw.getItem('lascodia.scope.selectedAccountId')).toBe('22');
    expect(store.getItem('lascodia.scope.selectedAccountId')).toBeNull();
  });

  it('never overwrites a value already in the namespace', () => {
    raw.setItem('lascodia.u7.t1.wallMode', '0');
    raw.setItem('lascodia.wallMode', '1');
    store.setIdentity({ userKey: 'u7', tenantId: 1 });
    expect(store.getItem('lascodia.wallMode')).toBe('0');
    expect(raw.getItem('lascodia.wallMode')).toBeNull();
  });

  it('iterates and clears only what this identity owns', () => {
    raw.setItem(STORAGE_MIGRATION_MARKER, 'x');
    raw.setItem('lascodia.u2.t1.pine.draft.v1:strategy:4', 'theirs');
    store.setIdentity({ userKey: 'u1', tenantId: 1 });
    store.setItem('lascodia.pine.draft.v1:strategy:1', 'mine');
    const keys = Array.from({ length: store.length }, (_, i) => store.key(i));
    expect(keys).toContain('lascodia.pine.draft.v1:strategy:1');
    expect(keys).not.toContain('lascodia.pine.draft.v1:strategy:4');
    expect(keys.some((k) => k?.startsWith('lascodia.u'))).toBe(false);
    store.clear();
    expect(raw.getItem('lascodia.u2.t1.pine.draft.v1:strategy:4')).toBe('theirs');
    expect(raw.getItem(STORAGE_MIGRATION_MARKER)).toBe('x');
    expect(store.getItem('lascodia.pine.draft.v1:strategy:1')).toBeNull();
  });

  it('classifies managed keys', () => {
    expect(isManagedKey('lascodia.chart.drawings.v1')).toBe(true);
    expect(isManagedKey('tradingChart.showVolume')).toBe(true);
    expect(isManagedKey('lascodia.u1.t1.chart.drawings.v1')).toBe(false);
    expect(isManagedKey('lascodia.theme')).toBe(false);
    expect(isManagedKey('ag-grid')).toBe(false);
  });
});

/** Static guard: feature code goes through appStorage, never `localStorage` itself. */
describe('no direct localStorage use', () => {
  const root = join(__dirname, '..', '..');
  const ALLOWED = new Set(['core/storage/app-storage.ts']);
  const USE = /\blocalStorage\s*(\?\.|\.)\s*(getItem|setItem|removeItem|key|clear|length)\b|[:=(]\s*localStorage\b(?!\s*\()/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts') && !p.includes('_generated')) out.push(p);
    }
    return out;
  }

  it('finds no direct access outside core/storage', () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file);
      if (ALLOWED.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*(\*|\/\*)/.test(code)) return;
        if (USE.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
