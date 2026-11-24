import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { CurrencyPairDto } from '@core/api/api.types';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { ScriptingService } from '@core/services/scripting.service';
import { appStorage } from '@core/storage/app-storage';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { chartAnalysisTarget } from '@shared/components/trading-chart/chart-analysis-link';
import { instrumentFacts } from '@features/chart-analysis/datafeed/instrument-facts';
import { WatchlistService } from '@features/chart-analysis/watchlist/watchlist.service';
import { listSymbols } from '@features/chart-analysis/watchlist/watchlist.model';
import { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import type { ScreenerRow } from '@features/scripting/api/scripting-api.types';
import { describeFailure, isOk } from '@features/scripting/shared/api-error';

import {
  BOARD_TIMEFRAMES,
  PLAYBOOK_SCRIPT_ID,
  boardSource,
  mapRow,
  refreshDue,
  sortRows,
  type BoardRow,
  type DistanceFacts,
} from './playbook-board.model';

/** Symbols per screener request: the engine screens a request within one run deadline (60 s by default). */
export const BOARD_CHUNK = 20;
/** Bars each symbol runs on (the screener's maximum). */
export const BOARD_BARS = 500;
/** How often the page checks whether a re-read is due ({@link refreshDue}) while it is open and visible. */
export const BOARD_REFRESH_MS = 5 * 60_000;

const SOURCE_KEY = 'lascodia.playbookBoard.source';
const TF_KEY = 'lascodia.playbookBoard.timeframe';

interface SourceOption {
  key: string;
  label: string;
  symbols: string[];
}

/**
 * Playbook board — the "LLM Playbook" chart indicator (engine chart script #21) read on every pair of a
 * watchlist at once: the call, the next step, the buy and sell levels with their distance and how far they
 * can be trusted, trend and market type. Runs through the script screener (see playbook-board.model.ts for
 * why the script's source is sent rather than its id). A research tool: the playbook has no proven edge.
 */
@Component({
  selector: 'app-playbook-board-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, PageHeaderComponent, FeatureStateComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Playbook board"
        subtitle="The LLM Playbook chart indicator's reading on every pair at once: what it says now, what it waits for, and where it would buy or sell."
      >
        <span
          slot="title-after"
          class="research-pill"
          title="The playbook is a research codification. Backtests found no proven edge: read it as a chart-reading aid, not as a signal service."
        >
          Research tool — no proven edge
        </span>
      </app-page-header>

      <section class="toolbar" aria-label="Board settings">
        <label class="field">
          Pairs
          <select
            class="input"
            [value]="sourceKey()"
            (change)="pickSource($any($event.target).value)"
            data-testid="source"
          >
            @for (o of sourceOptions(); track o.key) {
              <option [value]="o.key">{{ o.label }} ({{ o.symbols.length }})</option>
            }
          </select>
        </label>
        <label class="field">
          Timeframe
          <select
            class="input"
            [value]="timeframe()"
            (change)="pickTimeframe($any($event.target).value)"
            data-testid="timeframe"
          >
            @for (t of timeframes; track t.value) {
              <option [value]="t.value">{{ t.label }}</option>
            }
          </select>
        </label>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          (click)="run(true)"
          [disabled]="running()"
          data-testid="refresh"
        >
          {{ running() ? 'Reading…' : 'Refresh' }}
        </button>
        <span class="status muted" data-testid="status">
          @if (running()) {
            Reading the playbook on {{ progress().done }} of {{ progress().total }} pairs…
          } @else if (lastRunAt(); as at) {
            Last read {{ at | date: 'HH:mm:ss' }} · {{ rows().length }} pairs · last closed bar
            {{ lastBarMs() ? (lastBarMs() | date: 'dd MMM HH:mm') : '—' }} · re-reads every 5
            minutes
          }
        </span>
      </section>

      @if (error(); as err) {
        <p class="alert" role="alert" data-testid="error">{{ err }}</p>
      }

      @if (ready() && !symbols().length) {
        <app-feature-state
          title="No pairs to read"
          kind="waiting"
          summary="The board reads the playbook on the pairs of a watchlist. The chosen watchlist is empty — add symbols to it, or pick another list above."
          [links]="[
            { label: 'Watchlist', route: '/watchlist' },
            { label: 'Charts', route: '/chart-analysis' },
          ]"
        />
      } @else if (!rows().length && (running() || !ready())) {
        <p class="muted pad">Reading the playbook…</p>
      } @else if (rows().length) {
        <div class="table-wrap">
          <table class="table" data-testid="board">
            <thead>
              <tr>
                <th>Pair</th>
                <th>The call</th>
                <th>Next step</th>
                <th>Buy level</th>
                <th>Sell level</th>
                <th>Trend</th>
                <th>Market</th>
                @if (showHeld()) {
                  <th>Held-back setups</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.symbol) {
                <tr [attr.data-kind]="r.callKind" data-testid="row">
                  <td class="pair">
                    <a
                      [routerLink]="link(r.symbol).commands"
                      [queryParams]="link(r.symbol).queryParams"
                      title="Open the chart (add “LLM Playbook” from My scripts to see the levels drawn)"
                      >{{ r.symbol }}</a
                    >
                  </td>
                  <td class="call">
                    <span class="call-pill" [attr.data-kind]="r.callKind" data-testid="call">{{
                      r.call
                    }}</span>
                    @if (r.callDetail) {
                      <div class="sub">{{ r.callDetail }}</div>
                    }
                    @if (r.error) {
                      <div class="sub bad">{{ r.error }}</div>
                    }
                  </td>
                  <td data-testid="next">
                    {{ r.next }}
                    @if (r.heldBack) {
                      <div
                        class="sub warn"
                        [title]="'A safety rule blocks a setup here: ' + r.heldBack"
                      >
                        held back: {{ r.heldBack }}
                      </div>
                    }
                  </td>
                  <td>
                    @if (r.buy; as l) {
                      <span class="px">{{ l.priceText }}</span>
                      <div class="sub" [class.faint]="l.weak">
                        {{ l.quality }}
                        @if (l.heldText) {
                          ({{ l.heldText }})
                        }
                        @if (l.distanceText) {
                          · {{ l.distanceText }}
                        }
                      </div>
                    } @else if (!r.error) {
                      <span class="muted">none within reach</span>
                    }
                  </td>
                  <td>
                    @if (r.sell; as l) {
                      <span class="px">{{ l.priceText }}</span>
                      <div class="sub" [class.faint]="l.weak">
                        {{ l.quality }}
                        @if (l.heldText) {
                          ({{ l.heldText }})
                        }
                        @if (l.distanceText) {
                          · {{ l.distanceText }}
                        }
                      </div>
                    } @else if (!r.error) {
                      <span class="muted">none within reach</span>
                    }
                  </td>
                  <td>{{ r.trend }}</td>
                  <td>{{ r.regime }}</td>
                  @if (showHeld()) {
                    <td>{{ r.heldResolved ?? '—' }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="muted pad foot">
          Read on the last closed {{ timeframeLabel() }} bar. Levels: reliable = held on 60% or more
          of recent visits, mixed = 40–60%, weak = under 40% (price often goes through it); with
          fewer than 3 visits the indicator's own rating is shown (strong, respected, tested,
          broken). Virtual levels at chart prices — no spread, no commission.
        </p>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .research-pill {
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--warning, #b7791f);
        color: var(--warning, #b7791f);
        white-space: nowrap;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .status {
        font-size: 12px;
        margin-left: auto;
      }
      .muted {
        color: var(--text-secondary);
      }
      .pad {
        padding: 8px 4px;
      }
      .foot {
        font-size: 12px;
      }
      .alert {
        margin: 0;
        padding: 10px 14px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--danger, #c53030);
        color: var(--danger, #c53030);
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .table th,
      .table td {
        text-align: left;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      .table th {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--text-secondary);
        background: var(--bg-secondary);
      }
      .pair a {
        font-weight: var(--font-semibold);
      }
      .px {
        font-variant-numeric: tabular-nums;
      }
      .sub {
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 2px;
      }
      .sub.faint {
        opacity: 0.6;
      }
      .sub.warn {
        color: var(--warning, #b7791f);
      }
      .sub.bad {
        color: var(--danger, #c53030);
      }
      .call-pill {
        display: inline-block;
        font-weight: var(--font-semibold);
        font-size: 12px;
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }
      .call-pill[data-kind='trade'] {
        background: var(--accent, #2b6cb0);
        color: #fff;
      }
      .call-pill[data-kind='watch'] {
        border: 1px solid var(--warning, #b7791f);
        color: var(--warning, #b7791f);
        background: transparent;
      }
      .call-pill[data-kind='in-trade'] {
        border: 1px solid var(--accent, #2b6cb0);
        background: transparent;
      }
      .call-pill[data-kind='error'] {
        color: var(--text-secondary);
      }
    `,
  ],
})
export class PlaybookBoardPageComponent implements OnInit {
  private readonly screener = inject(ScriptStrategyService);
  private readonly scripting = inject(ScriptingService);
  private readonly watchlists = inject(WatchlistService);
  private readonly pairs = inject(CurrencyPairsService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly timeframes = BOARD_TIMEFRAMES;

  readonly timeframe = signal<string>(readPref(TF_KEY) ?? 'H1');
  private readonly pickedSource = signal<string | null>(readPref(SOURCE_KEY));
  private readonly catalogue = signal<readonly CurrencyPairDto[]>([]);
  /** Watchlists and the pair catalogue have loaded (or failed): the symbol list is final. */
  readonly ready = signal(false);

  readonly running = signal(false);
  readonly progress = signal({ done: 0, total: 0 });
  readonly error = signal<string | null>(null);
  readonly lastRunAt = signal<Date | null>(null);
  private readonly raw = signal<BoardRow[]>([]);
  readonly rows = computed(() => sortRows(this.raw()));
  readonly showHeld = computed(() => this.rows().some((r) => r.heldResolved !== null));
  readonly lastBarMs = computed(() =>
    this.rows().reduce<number | null>(
      (m, r) =>
        r.lastBarTimeMs != null && (m == null || r.lastBarTimeMs > m) ? r.lastBarTimeMs : m,
      null,
    ),
  );
  readonly timeframeLabel = computed(
    () => this.timeframes.find((t) => t.value === this.timeframe())?.label ?? this.timeframe(),
  );

  readonly sourceOptions = computed<SourceOption[]>(() => {
    const out: SourceOption[] = [];
    for (const list of this.watchlists.lists()) {
      out.push({ key: `list:${list.id}`, label: `${list.name} — all`, symbols: listSymbols(list) });
      for (const s of list.sections) {
        if (list.sections.length < 2 || !s.items.length) continue;
        const symbols = [...new Set(s.items.map((i) => i.symbol))];
        out.push({ key: `section:${list.id}:${s.id}`, label: `${list.name} › ${s.name}`, symbols });
      }
    }
    const all = this.catalogue()
      .map((p) => (p.symbol ?? '').toUpperCase())
      .filter((s) => s.length > 0)
      .sort();
    out.push({ key: 'all', label: 'All active pairs', symbols: all });
    return out;
  });

  /** The picked source while it exists, else the active watchlist, else every active pair. */
  readonly sourceKey = computed(() => {
    const options = this.sourceOptions();
    const picked = this.pickedSource();
    if (picked && options.some((o) => o.key === picked)) return picked;
    const active = this.watchlists.active();
    return active ? `list:${active.id}` : 'all';
  });
  readonly symbols = computed(
    () => this.sourceOptions().find((o) => o.key === this.sourceKey())?.symbols ?? [],
  );

  private readonly facts = computed(() => {
    const map = new Map<string, DistanceFacts>();
    for (const p of this.catalogue()) {
      const symbol = (p.symbol ?? '').toUpperCase();
      if (!symbol) continue;
      const f = instrumentFacts(symbol, { pair: p });
      map.set(symbol, {
        unit: f.distanceUnit,
        label: f.distanceLabel,
        digits: p.decimalPlaces ?? f.precision,
      });
    }
    return map;
  });

  private source: string | null = null;
  private runSeq = 0;

  async ngOnInit(): Promise<void> {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (this.running()) return;
      const tfMs = this.timeframes.find((t) => t.value === this.timeframe())?.ms ?? 60 * 60_000;
      const last = this.lastRunAt()?.getTime() ?? null;
      if (refreshDue(Date.now(), last, this.lastBarMs(), tfMs)) void this.run(false);
    }, BOARD_REFRESH_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.runSeq++;
    });
    await Promise.all([this.watchlists.load(), this.loadCatalogue()]);
    this.ready.set(true);
    await this.run(false);
  }

  pickSource(key: string): void {
    this.pickedSource.set(key);
    writePref(SOURCE_KEY, key);
    void this.run(false);
  }

  pickTimeframe(tf: string): void {
    this.timeframe.set(tf);
    writePref(TF_KEY, tf);
    void this.run(false);
  }

  link(symbol: string) {
    return chartAnalysisTarget(symbol, this.timeframe());
  }

  /**
   * One read of the board: the script's source (fetched again on a manual refresh, so an edited script is
   * picked up), then the symbols in chunks of {@link BOARD_CHUNK}, each chunk's rows shown as it lands.
   */
  async run(manual: boolean): Promise<void> {
    const symbols = this.symbols();
    if (!this.ready() || !symbols.length) return;
    const seq = ++this.runSeq;
    const live = () => seq === this.runSeq;
    const timeframe = this.timeframe();
    this.running.set(true);
    this.error.set(null);
    this.progress.set({ done: 0, total: symbols.length });
    try {
      if (manual || this.source === null) {
        const script = await firstValueFrom(this.scripting.getChartScript(PLAYBOOK_SCRIPT_ID));
        if (!live()) return;
        if (!script.pineSource)
          throw new Error('The LLM Playbook script came back without its source.');
        this.source = boardSource(script.pineSource);
      }
      const source = this.source;
      const collected = new Map<string, BoardRow>();
      // A re-read of the same pairs and timeframe keeps the previous rows on screen until each is replaced;
      // another list or timeframe starts from an empty board.
      const readKey = `${this.sourceKey()}|${timeframe}`;
      const previous = readKey === this.lastReadKey ? this.raw() : [];
      this.lastReadKey = readKey;
      this.raw.set(previous);
      const failures: string[] = [];
      for (let i = 0; i < symbols.length; i += BOARD_CHUNK) {
        const chunk = symbols.slice(i, i + BOARD_CHUNK);
        let rows: ScreenerRow[];
        try {
          const res = await firstValueFrom(
            this.screener.runScreener({ source, symbols: chunk, timeframe, lastBars: BOARD_BARS }),
          );
          if (!isOk(res)) throw res;
          rows = res.data ?? [];
        } catch (err) {
          const why = describeFailure(err, 'The screener did not run.');
          failures.push(why);
          rows = chunk.map((symbol) => ({
            symbol,
            lastBarTimeMs: null,
            values: {},
            alerts: [],
            error: why,
          }));
        }
        if (!live()) return;
        for (const r of rows) {
          const key = r.symbol.toUpperCase();
          collected.set(key, mapRow(r, this.facts().get(key) ?? null));
        }
        const stale = previous.filter((r) => !collected.has(r.symbol.toUpperCase()));
        this.raw.set([...collected.values(), ...stale]);
        this.progress.set({
          done: Math.min(i + chunk.length, symbols.length),
          total: symbols.length,
        });
      }
      if (failures.length && failures.length * BOARD_CHUNK >= symbols.length) {
        this.error.set(failures[0]);
      }
      this.lastRunAt.set(new Date());
    } catch (err) {
      if (!live()) return;
      this.error.set(
        describeFailure(
          err,
          `The LLM Playbook script (#${PLAYBOOK_SCRIPT_ID}) could not be loaded. It may be private to another operator — its owner can share it from My scripts.`,
        ),
      );
    } finally {
      if (live()) this.running.set(false);
    }
  }

  private lastReadKey: string | null = null;

  private async loadCatalogue(): Promise<void> {
    try {
      const res = await firstValueFrom(this.pairs.list({ currentPage: 1, itemCountPerPage: 400 }));
      this.catalogue.set((res?.data?.data ?? []).filter((p) => p.isActive));
    } catch {
      // Distances need the catalogue; the board still reads without it.
      this.catalogue.set([]);
    }
  }
}

function readPref(key: string): string | null {
  try {
    return appStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    appStorage.setItem(key, value);
  } catch {
    /* best-effort */
  }
}
