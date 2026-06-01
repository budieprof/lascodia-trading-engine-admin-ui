import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, of, switchMap, take, timer } from 'rxjs';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { EAInstancesService } from '@core/services/ea-instances.service';
import type { EAInstanceDto, TradingAccountDto } from '@core/api/api.types';

/**
 * Single source of truth for "which trading account(s) does the
 * admin-UI operator currently care about".  Every page that lists
 * account-tagged data (orders, positions, drawdown, P&L tiles, …)
 * reads from this service so flipping the header dropdown reshapes
 * the entire console at once.
 *
 * Scope model:
 *
 *   - `__all_real__`  → aggregate across every live REAL account
 *     (paper accounts are excluded so play money doesn't contaminate
 *     headline numbers; the engine query path receives N account ids
 *     and rolls up server-side).
 *
 *   - `__all__`       → aggregate across every live account
 *     (real + paper), useful when the operator IS running paper
 *     rollouts and wants the full picture.
 *
 *   - `<accountId>`   → singleton: that one account, verbatim.
 *
 * "Live" means: at least one Active EAInstance has this account as
 * its TradingAccountId.  Sticky `TradingAccount.IsActive=true` rows
 * with no running EA are dormant and excluded — they would silently
 * inflate aggregates.  Mirrors the EA Instances page.
 *
 * Persistence: the selection is mirrored to localStorage so the
 * operator's choice survives navigation, refresh, and process kill.
 */
@Injectable({ providedIn: 'root' })
export class AccountScopeService {
  static readonly SCOPE_AGGREGATE_REAL = '__all_real__';
  static readonly SCOPE_AGGREGATE_ALL = '__all__';
  private static readonly STORAGE_KEY = 'lascodia.scope.selectedAccountId';
  // Refresh the underlying account + EA-instance lists on this cadence
  // so the scope stays accurate as accounts come online / go dormant.
  private static readonly REFRESH_INTERVAL_MS = 30_000;

  private readonly accountsService = inject(TradingAccountsService);
  private readonly eaService = inject(EAInstancesService);

  readonly accounts = signal<TradingAccountDto[]>([]);
  readonly eaInstances = signal<EAInstanceDto[]>([]);

  /** Live accounts = accounts with at least one Active EA attached. */
  readonly liveAccounts = computed<TradingAccountDto[]>(() => {
    const all = this.accounts();
    if (all.length === 0) return [];
    const liveIds = new Set(
      this.eaInstances()
        .filter((e) => e.status === 'Active')
        .map((e) => e.tradingAccountId),
    );
    return all.filter((a) => liveIds.has(a.id));
  });

  readonly liveRealAccounts = computed(() => this.liveAccounts().filter((a) => !a.isPaper));

  /** Operator's selection — sentinel string or specific account id. */
  readonly selected = signal<number | string>(AccountScopeService.readPersisted());

  /**
   * Concrete set of account ids the current scope expands to.  This
   * is what every consumer should pass to engine queries.  Empty set
   * means "no live accounts" — consumers should render placeholder
   * state (not fall back to fleet-wide).
   */
  readonly accountIds = computed<ReadonlyArray<number>>(() => {
    const sel = this.selected();
    const live = this.liveAccounts();
    if (live.length === 0) return [];

    if (sel === AccountScopeService.SCOPE_AGGREGATE_REAL) {
      return live.filter((a) => !a.isPaper).map((a) => a.id);
    }
    if (sel === AccountScopeService.SCOPE_AGGREGATE_ALL) {
      return live.map((a) => a.id);
    }
    const id = typeof sel === 'string' ? Number(sel) : sel;
    if (Number.isFinite(id) && live.some((a) => a.id === id)) {
      return [id];
    }
    // Persisted selection points at a stale id → fall back to real-aggregate.
    return live.filter((a) => !a.isPaper).map((a) => a.id);
  });

  /** True when the current scope is the operator-friendly "all real" default. */
  readonly isAggregateReal = computed(
    () => this.selected() === AccountScopeService.SCOPE_AGGREGATE_REAL,
  );

  /** Convenience: the single resolved account (or null when aggregate). */
  readonly singleAccount = computed<TradingAccountDto | null>(() => {
    const ids = this.accountIds();
    if (ids.length !== 1) return null;
    return this.liveAccounts().find((a) => a.id === ids[0]) ?? null;
  });

  constructor() {
    // Kick off the first refresh immediately, then refresh on a fixed
    // cadence.  Errors are swallowed and the previous data is kept —
    // a transient engine blip should NOT empty out the scope.
    timer(0, AccountScopeService.REFRESH_INTERVAL_MS)
      .pipe(
        switchMap(() => this.fetchAccounts()),
        switchMap(() => this.fetchEaInstances()),
      )
      .subscribe();
  }

  /** Pick a new scope.  Persists to localStorage. */
  select(next: number | string): void {
    this.selected.set(next);
    try {
      localStorage.setItem(AccountScopeService.STORAGE_KEY, String(next));
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }

  /**
   * Merge the current scope into an arbitrary filter object so a list
   * query gets `tradingAccountIds` automatically.  Returns a new
   * object — the caller's filter is not mutated.  When the scope is
   * empty (no live accounts) the filter is returned unchanged so
   * callers see fleet-wide data rather than a forced empty result —
   * the page itself can choose to render an empty state.
   */
  decorateFilter<T extends object>(filter: T): T & { tradingAccountIds?: number[] } {
    const ids = this.accountIds();
    if (ids.length === 0) return filter;
    return { ...(filter as object), tradingAccountIds: Array.from(ids) } as T & {
      tradingAccountIds?: number[];
    };
  }

  // ── Refresh helpers ─────────────────────────────────────────────────

  private fetchAccounts() {
    return this.accountsService.list({ currentPage: 1, itemCountPerPage: 50 }).pipe(
      take(1),
      catchError(() => of(null)),
      switchMap((res) => {
        const list = res?.data?.data ?? [];
        if (list.length > 0) this.accounts.set(list);
        return of(list);
      }),
    );
  }

  private fetchEaInstances() {
    return this.eaService.list().pipe(
      take(1),
      catchError(() => of(null)),
      switchMap((res) => {
        const list = res?.data ?? [];
        // Allow empty list to propagate — "no live EAs" is genuine state.
        this.eaInstances.set(list);
        return of(list);
      }),
    );
  }

  // ── Persistence helpers ─────────────────────────────────────────────

  private static readPersisted(): number | string {
    try {
      const raw = localStorage.getItem(AccountScopeService.STORAGE_KEY);
      if (raw == null) return AccountScopeService.SCOPE_AGGREGATE_REAL;
      if (
        raw === AccountScopeService.SCOPE_AGGREGATE_REAL ||
        raw === AccountScopeService.SCOPE_AGGREGATE_ALL
      )
        return raw;
      const n = Number(raw);
      return Number.isFinite(n) ? n : AccountScopeService.SCOPE_AGGREGATE_REAL;
    } catch {
      return AccountScopeService.SCOPE_AGGREGATE_REAL;
    }
  }
}
