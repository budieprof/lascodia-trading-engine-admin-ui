import { Injectable } from '@angular/core';

export interface TableState {
  currentPage: number;
  pageSize: number;
  searchTerm: string;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}

const STORAGE_PREFIX = 'lascodia.table.';

/**
 * Persists a DataTable's filter / pagination / sort state per route so
 * operators don't lose their place when they navigate away and back.
 * Keyed by the current window location path by default. sessionStorage so
 * state doesn't leak across tabs or survive a browser restart.
 */
@Injectable({ providedIn: 'root' })
export class TableStateService {
  private readonly memory = new Map<string, TableState>();

  read(key: string): TableState | null {
    const full = STORAGE_PREFIX + key;
    const cached = this.memory.get(full);
    if (cached) return cached;
    try {
      const raw = sessionStorage.getItem(full);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as TableState;
      this.memory.set(full, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  write(key: string, state: TableState): void {
    const full = STORAGE_PREFIX + key;
    this.memory.set(full, state);
    try {
      sessionStorage.setItem(full, JSON.stringify(state));
    } catch {
      /* storage unavailable */
    }
  }

  clear(key: string): void {
    const full = STORAGE_PREFIX + key;
    this.memory.delete(full);
    try {
      sessionStorage.removeItem(full);
    } catch {
      /* noop */
    }
  }

  /** Default key is the current pathname so routes auto-scope. */
  defaultKey(): string {
    return typeof window !== 'undefined' ? window.location.pathname : 'default';
  }
}
