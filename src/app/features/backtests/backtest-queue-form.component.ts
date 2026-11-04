import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  Observable,
  catchError,
  debounceTime,
  distinctUntilChanged,
  forkJoin,
  map,
  of,
  switchMap,
} from 'rxjs';

import {
  isRetiredStrategyType,
  type CreateBacktestRequest,
  type StrategyDto,
} from '@core/api/api.types';
import { BacktestsService } from '@core/services/backtests.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ScriptStrategyFields } from '@features/scripting/api/scripting-api.types';
import { isScriptStrategy } from '@features/scripting/shared/script-strategy';
import {
  ENGINE_TIMEFRAMES,
  ScriptBacktestLauncherComponent,
} from '@features/scripting/backtest/script-backtest-launcher.component';
import {
  DATE_RANGE_PRESETS,
  describeSpan,
  matchingPreset,
  presetRange,
  type DateRangePresetKey,
} from '@features/scripting/backtest/backtest-date-range';
import { MAJOR_PAIRS } from '@features/scripting/backtest/run-compare.model';

import {
  mergeStrategies,
  strategyIdFromQuery,
  validateRuleBacktestForm,
} from './backtest-queue-form.model';

type Strategy = StrategyDto & Partial<ScriptStrategyFields>;
type SearchState = 'idle' | 'loading' | 'ready' | 'error';

const SEARCH_LIMIT = 20;

/**
 * Queues a backtest from the Backtests page. Pick the strategy by name, symbol or id (never a bare
 * id field), then:
 * - a Pine script strategy gets the full script launcher (overrides, inputs, deep mode, bar
 *   magnifier, basket) — the same form as the strategy's own Backtests tab;
 * - a CompositeML / Custom strategy gets the window, the balance and the market override.
 */
@Component({
  selector: 'app-backtest-queue-form',
  standalone: true,
  imports: [RouterLink, ScriptBacktestLauncherComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="qf" aria-labelledby="qf-title">
      <header class="qf-head">
        <div>
          <h3 id="qf-title">Queue a backtest</h3>
          <p class="sub">Choose a strategy, then the window and options for the run.</p>
        </div>
        <button type="button" class="btn ghost" (click)="cancelled.emit()">Close</button>
      </header>

      <!-- ── 1. Strategy ─────────────────────────────────────────── -->
      <div class="step">
        <span class="step-n">1</span>
        <div class="step-body">
          <h4 class="step-title">Strategy</h4>
          @if (selected(); as s) {
            <div class="picked">
              <div class="picked-main">
                <span class="picked-id">#{{ s.id }}</span>
                <span class="picked-name">{{ s.name || 'Strategy #' + s.id }}</span>
                <span class="tag">{{ s.symbol ?? '?' }} · {{ s.timeframe }}</span>
                <span class="tag" [class.tag-accent]="isScript()">{{ kindLabel() }}</span>
                <span class="tag muted">{{ s.lifecycleStage }}</span>
                <span class="tag muted">{{ s.status }}</span>
              </div>
              <div class="picked-actions">
                <a class="link" [routerLink]="['/strategies', s.id]">Open strategy</a>
                <button type="button" class="btn ghost sm" (click)="clearSelection()">
                  Change
                </button>
              </div>
            </div>
          } @else {
            <div class="search">
              <input
                type="search"
                class="search-input"
                spellcheck="false"
                autocomplete="off"
                placeholder="Search by name, symbol or #id…"
                aria-label="Search strategies"
                role="combobox"
                aria-autocomplete="list"
                [attr.aria-expanded]="results().length > 0"
                aria-controls="qf-results"
                [attr.aria-activedescendant]="
                  activeIndex() >= 0 ? 'qf-opt-' + results()[activeIndex()]?.id : null
                "
                [value]="query()"
                (input)="query.set($any($event.target).value)"
                (keydown)="onSearchKey($event)"
                data-testid="strategy-search"
              />
              @if (searchState() === 'loading') {
                <span class="search-status" role="status">Searching…</span>
              }
            </div>

            @if (results().length > 0) {
              <ul id="qf-results" class="results" role="listbox" aria-label="Strategies">
                @for (r of results(); track r.id; let i = $index) {
                  <li
                    role="option"
                    tabindex="-1"
                    [id]="'qf-opt-' + r.id"
                    [attr.aria-selected]="i === activeIndex()"
                    [class.active]="i === activeIndex()"
                    (mousedown)="$event.preventDefault()"
                    (click)="select(r)"
                    (mouseenter)="activeIndex.set(i)"
                  >
                    <span class="r-id">#{{ r.id }}</span>
                    <span class="r-name">{{ r.name || 'Strategy #' + r.id }}</span>
                    <span class="r-market">{{ r.symbol ?? '?' }} · {{ r.timeframe }}</span>
                    <span class="r-stage">{{ r.lifecycleStage }}</span>
                  </li>
                }
              </ul>
            } @else if (searchState() === 'ready' && query().trim()) {
              <p class="hint">No strategy matches “{{ query().trim() }}”.</p>
            } @else if (searchState() === 'error') {
              <p class="hint error-text">The strategy search failed — try again.</p>
            }

            @if (recent().length > 0 && !query().trim()) {
              <div class="recent">
                <span class="recent-label">Recently backtested</span>
                @for (r of recent(); track r.id) {
                  <button type="button" class="chip" (click)="select(r)" [title]="r.name ?? ''">
                    #{{ r.id }} {{ r.name || '' }}
                    <span class="chip-sub">{{ r.symbol }} {{ r.timeframe }}</span>
                  </button>
                }
              </div>
            }
          }
          @if (loadingSelected()) {
            <p class="hint" role="status">Loading the strategy…</p>
          }
          @if (selectError()) {
            <p class="hint error-text" role="alert">{{ selectError() }}</p>
          }
        </div>
      </div>

      <!-- ── 2. Run ──────────────────────────────────────────────── -->
      @if (selected(); as s) {
        <div class="step">
          <span class="step-n">2</span>
          <div class="step-body">
            <h4 class="step-title">Run</h4>

            @if (retired()) {
              <p class="warn" role="alert">
                {{ s.strategyType }} is a retired strategy type with no evaluator — the engine
                cannot backtest it. Its idea lives on as a Pine script (RuleBased).
              </p>
            } @else if (isScript()) {
              <!-- Re-created per strategy so no override or input carries over from the last one. -->
              @for (one of [s]; track one.id) {
                <app-script-backtest-launcher
                  [strategy]="$any(one)"
                  [embedded]="true"
                  (queued)="queued.emit($event)"
                />
              }
            } @else {
              <form class="form" novalidate (submit)="$event.preventDefault(); submitRule()">
                <div class="presets" role="group" aria-label="Date range">
                  <span class="presets-label">Window</span>
                  @for (p of presets; track p.key) {
                    <button
                      type="button"
                      class="chip"
                      [class.on]="activePreset() === p.key"
                      [attr.aria-pressed]="activePreset() === p.key"
                      [title]="p.title"
                      (click)="applyPreset(p.key)"
                    >
                      {{ p.label }}
                    </button>
                  }
                  @if (spanText()) {
                    <span class="presets-span">{{ spanText() }}</span>
                  }
                </div>
                <div class="grid">
                  <label class="field">
                    <span>From (UTC)</span>
                    <input
                      type="date"
                      [value]="fromDate()"
                      (change)="fromDate.set($any($event.target).value)"
                    />
                  </label>
                  <label class="field">
                    <span>To (UTC)</span>
                    <input
                      type="date"
                      [value]="toDate()"
                      (change)="toDate.set($any($event.target).value)"
                    />
                  </label>
                  <label class="field">
                    <span>Initial balance</span>
                    <input
                      type="number"
                      min="1"
                      step="1000"
                      inputmode="decimal"
                      [value]="initialBalance() ?? ''"
                      (input)="setBalance($any($event.target).value)"
                    />
                  </label>
                  <label class="field">
                    <span>Symbol override</span>
                    <input
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      list="qf-symbols"
                      [placeholder]="'Strategy’s own (' + (s.symbol ?? '?') + ')'"
                      [value]="symbolOverride()"
                      (input)="symbolOverride.set($any($event.target).value.toUpperCase())"
                    />
                    <datalist id="qf-symbols">
                      @for (sym of symbolSuggestions(); track sym) {
                        <option [value]="sym"></option>
                      }
                    </datalist>
                  </label>
                  <label class="field">
                    <span>Timeframe override</span>
                    <select (change)="timeframeOverride.set($any($event.target).value)">
                      <option value="" [selected]="timeframeOverride() === ''">
                        Strategy’s own ({{ s.timeframe }})
                      </option>
                      @for (tf of timeframes; track tf) {
                        @if (tf !== s.timeframe) {
                          <option [value]="tf" [selected]="timeframeOverride() === tf">
                            {{ tf }}
                          </option>
                        }
                      }
                    </select>
                  </label>
                </div>
                @if (ruleOverride()) {
                  <p class="note">
                    Override run: the strategy’s rules on {{ ruleOverride() }}. Recorded as such and
                    never read as validation of the deployed strategy.
                  </p>
                }
                @if (ruleError()) {
                  <p class="error" role="alert">{{ ruleError() }}</p>
                }
                @if (lastRunId(); as id) {
                  <p class="queued" role="status">
                    Backtest #{{ id }} queued.
                    <a [routerLink]="['/backtests', id]">Open the run</a>
                  </p>
                }
                <div class="actions">
                  <button type="submit" class="btn primary" [disabled]="submitting()">
                    {{ submitting() ? 'Queuing…' : 'Queue backtest' }}
                  </button>
                </div>
              </form>
            }
          </div>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .qf {
        margin-bottom: var(--space-4);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .qf-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
      }
      .qf-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .sub {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .step {
        display: grid;
        grid-template-columns: 24px 1fr;
        gap: var(--space-3);
      }
      .step-n {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: var(--accent);
        color: #fff;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .step-body {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-width: 0;
      }
      .step-title {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .search {
        position: relative;
        max-width: 560px;
      }
      .search-input,
      .field input,
      .field select {
        width: 100%;
        height: 34px;
        padding: 0 var(--space-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        box-sizing: border-box;
      }
      .search-input:focus,
      .field input:focus,
      .field select:focus {
        outline: none;
        border-color: var(--accent);
      }
      .search-status {
        position: absolute;
        right: var(--space-2);
        top: 50%;
        transform: translateY(-50%);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .results {
        list-style: none;
        margin: 0;
        padding: var(--space-1);
        max-width: 560px;
        max-height: 280px;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .results li {
        display: grid;
        grid-template-columns: 56px 1fr auto auto;
        gap: var(--space-2);
        align-items: baseline;
        padding: 6px var(--space-2);
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--text-sm);
      }
      .results li.active {
        background: var(--bg-tertiary, rgba(0, 113, 227, 0.08));
      }
      .r-id,
      .picked-id {
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .r-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .r-market,
      .r-stage {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .recent {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-1);
      }
      .recent-label,
      .presets-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-right: var(--space-1);
      }
      .chip {
        height: 26px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-xs);
        cursor: pointer;
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chip.on {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .chip-sub {
        color: var(--text-tertiary);
        margin-left: 4px;
      }
      .chip:focus-visible,
      .btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .picked {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .picked-main,
      .picked-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
      }
      .picked-name {
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
      }
      .tag {
        padding: 0 8px;
        line-height: 20px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .tag.muted {
        color: var(--text-secondary);
      }
      .tag-accent {
        border-color: var(--accent);
        color: var(--accent);
      }
      .link,
      .queued a {
        color: var(--accent);
        font-size: var(--text-sm);
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .presets {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-1);
      }
      .presets-span {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-left: var(--space-2);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
        gap: var(--space-3);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .hint,
      .note {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .error-text {
        color: var(--loss);
      }
      .warn,
      .error {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
      }
      .warn {
        background: rgba(255, 149, 0, 0.1);
      }
      .error {
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
      }
      .queued {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(52, 199, 89, 0.1);
        font-size: var(--text-sm);
      }
      .queued a {
        margin-left: var(--space-2);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
      }
      .btn {
        height: 34px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn.sm {
        height: 28px;
        padding: 0 var(--space-3);
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .btn.ghost {
        background: transparent;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ],
})
export class BacktestQueueFormComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly backtests = inject(BacktestsService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  /** Strategies with recent runs, newest first — offered as one-click picks. */
  readonly recentStrategyIds = input<readonly number[]>([]);
  /** Preselect this strategy (e.g. from `?strategyId=`). */
  readonly initialStrategyId = input<number | null>(null);
  /** Symbols seen in recent runs, offered beside the majors for an override. */
  readonly knownSymbols = input<readonly string[]>([]);

  readonly queued = output<number>();
  readonly cancelled = output<void>();

  readonly timeframes = ENGINE_TIMEFRAMES;
  readonly presets = DATE_RANGE_PRESETS;

  // ── Picker ───────────────────────────────────────────────────────
  readonly query = signal('');
  readonly results = signal<StrategyDto[]>([]);
  readonly searchState = signal<SearchState>('idle');
  readonly activeIndex = signal(-1);
  readonly recent = signal<StrategyDto[]>([]);

  readonly selected = signal<Strategy | null>(null);
  readonly loadingSelected = signal(false);
  readonly selectError = signal<string | null>(null);
  private selectSeq = 0;

  readonly isScript = computed(() => isScriptStrategy(this.selected()));
  readonly retired = computed(() => isRetiredStrategyType(this.selected()?.strategyType));
  readonly kindLabel = computed(() => {
    const s = this.selected();
    if (!s) return '';
    if (this.isScript()) return 'Pine script';
    return s.strategyType;
  });

  // ── Non-script run ───────────────────────────────────────────────
  readonly fromDate = signal(presetRange('1Y').fromDate);
  readonly toDate = signal(presetRange('1Y').toDate);
  readonly initialBalance = signal<number | null>(10_000);
  readonly symbolOverride = signal('');
  readonly timeframeOverride = signal('');
  readonly submitting = signal(false);
  readonly ruleError = signal<string | null>(null);
  readonly lastRunId = signal<number | null>(null);

  readonly activePreset = computed(() => matchingPreset(this.fromDate(), this.toDate()));
  readonly spanText = computed(() => describeSpan(this.fromDate(), this.toDate()));
  readonly symbolSuggestions = computed(() => {
    const own = this.selected()?.symbol ?? '';
    return [...new Set([...MAJOR_PAIRS, ...this.knownSymbols()])].filter((s) => s !== own).sort();
  });
  /** "GBPUSD H4" when the run overrides the market; null otherwise. */
  readonly ruleOverride = computed(() => {
    const s = this.selected();
    if (!s) return null;
    const sym = this.symbolOverride().trim();
    const tf = this.timeframeOverride();
    const symDiff = !!sym && sym !== (s.symbol ?? '').toUpperCase();
    const tfDiff = !!tf && tf !== s.timeframe;
    if (!symDiff && !tfDiff) return null;
    return `${symDiff ? sym : s.symbol} ${tfDiff ? tf : s.timeframe}`;
  });

  constructor() {
    toObservable(this.query)
      .pipe(
        map((q) => q.trim()),
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((q) => this.search(q)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ rows, state }) => {
        this.results.set(rows);
        this.searchState.set(state);
        this.activeIndex.set(rows.length > 0 ? 0 : -1);
      });

    effect(() => {
      const ids = this.recentStrategyIds();
      untracked(() => this.loadRecent(ids));
    });

    effect(() => {
      const id = this.initialStrategyId();
      untracked(() => {
        if (id && id > 0 && this.selected()?.id !== id) this.selectById(id);
      });
    });
  }

  private search(q: string): Observable<{ rows: StrategyDto[]; state: SearchState }> {
    if (!q) return of({ rows: [], state: 'idle' as SearchState });
    this.searchState.set('loading');
    const id = strategyIdFromQuery(q);
    const byText = (term: string) =>
      this.strategies
        .list({
          currentPage: 1,
          itemCountPerPage: SEARCH_LIMIT,
          filter: { search: term },
          sortBy: 'name',
          sortDirection: 'asc',
        })
        .pipe(
          map((res) => (res?.status ? (res.data?.data ?? []) : [])),
          catchError(() => of(null)),
        );
    const byId = (n: number) =>
      this.strategies.getById(n).pipe(
        map((res) => (res?.status && res.data ? [res.data] : [])),
        catchError(() => of([] as StrategyDto[])),
      );
    // The engine's search is a case-sensitive contains on name and symbol: "eurusd" would miss
    // "EURUSD", so a lower/mixed-case term is also searched upper-cased.
    const upper = q.toUpperCase();
    const queries: Observable<StrategyDto[] | null>[] = [];
    if (id != null) queries.push(byId(id));
    queries.push(byText(q));
    if (upper !== q) queries.push(byText(upper));
    return forkJoin(queries).pipe(
      map((lists) => {
        const failed = lists.every((l) => l === null);
        const rows = mergeStrategies(...lists.map((l) => l ?? [])).slice(0, SEARCH_LIMIT);
        return { rows, state: (failed ? 'error' : 'ready') as SearchState };
      }),
    );
  }

  private loadRecent(ids: readonly number[]): void {
    const pick = [...new Set(ids)].filter((n) => n > 0).slice(0, 6);
    if (pick.length === 0) {
      this.recent.set([]);
      return;
    }
    forkJoin(
      pick.map((n) =>
        this.strategies.getById(n).pipe(
          map((res) => (res?.status && res.data ? res.data : null)),
          catchError(() => of(null)),
        ),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.recent.set(rows.filter((r): r is StrategyDto => r != null)));
  }

  onSearchKey(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'ArrowDown' && n > 0) {
      e.preventDefault();
      this.activeIndex.set((this.activeIndex() + 1) % n);
    } else if (e.key === 'ArrowUp' && n > 0) {
      e.preventDefault();
      this.activeIndex.set((this.activeIndex() - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = this.results()[this.activeIndex()];
      if (hit) this.select(hit);
      else {
        const id = strategyIdFromQuery(this.query());
        if (id != null) this.selectById(id);
      }
    } else if (e.key === 'Escape') {
      this.query.set('');
    }
  }

  /**
   * Loads the full strategy before showing the run form: a list row may not carry the script
   * fields, and would briefly show the wrong form.
   */
  select(row: StrategyDto): void {
    this.selectById(row.id);
  }

  selectById(id: number): void {
    const seq = ++this.selectSeq;
    this.selectError.set(null);
    this.loadingSelected.set(true);
    this.strategies.getById(id).subscribe({
      next: (res) => {
        if (seq !== this.selectSeq) return;
        this.loadingSelected.set(false);
        if (res?.status && res.data) this.applySelected(res.data);
        else {
          this.selected.set(null);
          this.selectError.set(res?.message || `Strategy #${id} was not found.`);
        }
      },
      error: () => {
        if (seq !== this.selectSeq) return;
        this.loadingSelected.set(false);
        this.selected.set(null);
        this.selectError.set(`Strategy #${id} could not be loaded.`);
      },
    });
  }

  private applySelected(s: StrategyDto): void {
    const prev = this.selected();
    this.selected.set(s);
    if (prev?.id !== s.id) {
      this.symbolOverride.set('');
      this.timeframeOverride.set('');
      this.ruleError.set(null);
      this.lastRunId.set(null);
    }
  }

  clearSelection(): void {
    this.selectSeq++;
    this.selected.set(null);
    this.loadingSelected.set(false);
    this.selectError.set(null);
  }

  applyPreset(key: DateRangePresetKey): void {
    const r = presetRange(key);
    this.fromDate.set(r.fromDate);
    this.toDate.set(r.toDate);
  }

  setBalance(raw: string): void {
    const n = raw === '' ? null : Number(raw);
    this.initialBalance.set(n != null && Number.isFinite(n) ? n : null);
  }

  /** The request for a non-script strategy, or the reason it cannot be sent. */
  buildRuleRequest(): CreateBacktestRequest | string {
    const s = this.selected();
    if (!s) return 'Choose a strategy first.';
    if (!s.symbol) return 'The strategy has no symbol.';
    const problem = validateRuleBacktestForm({
      fromDate: this.fromDate(),
      toDate: this.toDate(),
      symbolOverride: this.symbolOverride(),
      initialBalance: this.initialBalance(),
    });
    if (problem) return problem;
    const req: CreateBacktestRequest = {
      strategyId: s.id,
      symbol: s.symbol,
      timeframe: s.timeframe,
      initialBalance: this.initialBalance()!,
      // UTC midnight: the engine's dates are UTC.
      fromDate: `${this.fromDate()}T00:00:00Z`,
      toDate: `${this.toDate()}T00:00:00Z`,
    };
    const sym = this.symbolOverride().trim().toUpperCase();
    if (sym && sym !== s.symbol.toUpperCase()) req.symbolOverride = sym;
    const tf = this.timeframeOverride();
    if (tf && tf !== s.timeframe) req.timeframeOverride = tf;
    return req;
  }

  submitRule(): void {
    if (this.submitting()) return;
    const req = this.buildRuleRequest();
    if (typeof req === 'string') {
      this.ruleError.set(req);
      return;
    }
    this.ruleError.set(null);
    this.submitting.set(true);
    this.backtests.create(req).subscribe({
      next: (res) => {
        this.submitting.set(false);
        if (!res?.status || !res.data) {
          this.ruleError.set(res?.message || 'The engine refused the backtest.');
          return;
        }
        this.lastRunId.set(res.data);
        this.notifications.success(`Backtest #${res.data} queued`);
        this.queued.emit(res.data);
      },
      error: (err: unknown) => {
        this.submitting.set(false);
        this.ruleError.set(
          (err as { message?: string })?.message || 'Queuing the backtest failed.',
        );
      },
    });
  }
}
