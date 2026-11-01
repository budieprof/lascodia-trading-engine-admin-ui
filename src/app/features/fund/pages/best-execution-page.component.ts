import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { errorText } from '@features/iam/iam.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { FundApiService } from '../fund-api.service';
import {
  bestExTiles,
  defaultPeriod,
  isUpgradeNotice,
  matchPreset,
  minuteUtc,
  num,
  pct,
  periodLabel,
  periodPresets,
  periodQuery,
  splitAccount,
  splitBroker,
  tone,
  type PresetKey,
} from '../fund.logic';
import type { BestExecutionReport, FillGroupStats, FundScope } from '../fund.types';

type Breakdown = 'broker' | 'account' | 'symbol';

/** Fills shown per step in the fills table (the CSV has every fill). */
const FILL_PAGE = 25;

/**
 * Best-execution evidence (fund module): how each live fill compared with the market around it —
 * slippage against the arrival mid and the requested price, spread paid, fill latency and markouts —
 * per broker, account and symbol, with the methodology. Evidence for the organisation's own policy;
 * it is not a regulatory report template and the page says so. Needs `fund.bestex.read`.
 */
@Component({
  selector: 'app-fund-best-execution-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, PageHeaderComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './fund-page.scss', './best-execution-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Best execution"
        subtitle="Evidence of execution quality for live fills. Not a regulatory report template."
      >
        @if (!upgrade()) {
          <button
            type="button"
            class="btn btn-secondary"
            [disabled]="!report() || busy()"
            (click)="download('pdf')"
          >
            ⤓ PDF
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            [disabled]="!report() || busy()"
            (click)="download('csv')"
            title="Every fill, not just the ones shown"
          >
            ⤓ CSV
          </button>
        }
      </app-page-header>

      @if (upgrade()) {
        <section class="card upgrade" role="status">
          <span class="chip warn">Not in your plan</span> {{ upgrade() }}
        </section>
      } @else {
        <section class="card">
          <div class="query">
            <label class="field grow">
              <span class="label">Account</span>
              <select
                class="select"
                name="account"
                [ngModel]="account()"
                (ngModelChange)="account.set($event)"
              >
                <option [ngValue]="null">Every account I may see</option>
                @for (a of scope().accounts; track a.id) {
                  <option [ngValue]="a.id">
                    {{ a.accountId }} — {{ a.accountName }} · {{ a.broker }}
                  </option>
                }
              </select>
            </label>
            <label class="field sym">
              <span class="label">Symbol</span>
              <input
                class="input"
                name="symbol"
                placeholder="All symbols"
                list="bestex-symbols"
                autocomplete="off"
                [ngModel]="symbol()"
                (ngModelChange)="symbol.set($event)"
                (keydown.enter)="load()"
              />
              <datalist id="bestex-symbols">
                @for (s of knownSymbols(); track s) {
                  <option [value]="s"></option>
                }
              </datalist>
            </label>
            <div class="field">
              <span class="label">Period</span>
              <div class="seg" role="group" aria-label="Quick periods">
                @for (p of presets; track p.key) {
                  <button
                    type="button"
                    [class.on]="preset() === p.key"
                    [attr.aria-pressed]="preset() === p.key"
                    (click)="applyPreset(p.key)"
                  >
                    {{ p.label }}
                  </button>
                }
                <button type="button" [class.on]="preset() === null" disabled>Custom</button>
              </div>
            </div>
            <label class="field date">
              <span class="label">From (UTC)</span>
              <input
                class="input"
                type="date"
                name="from"
                [ngModel]="from()"
                (ngModelChange)="from.set($event)"
              />
            </label>
            <label class="field date">
              <span class="label">To (not included)</span>
              <input
                class="input"
                type="date"
                name="to"
                [ngModel]="to()"
                (ngModelChange)="to.set($event)"
              />
            </label>
            <button type="button" class="btn btn-primary" [disabled]="loading()" (click)="load()">
              {{ loading() ? 'Measuring…' : 'Show' }}
            </button>
          </div>
          @if (error()) {
            <p class="alert" role="alert"><strong>Could not load.</strong> {{ error() }}</p>
          }
        </section>

        @if (!report() && loading()) {
          <section class="card"><p class="empty">Measuring the period's fills…</p></section>
        }

        @if (report(); as r) {
          <!-- ── Headline ───────────────────────────── -->
          <section class="card" [class.stale]="loading()">
            <div class="card-head">
              <h3>Execution quality</h3>
              <span class="hint"
                >{{ periodText(r) }} ·
                {{ r.tradingAccountId ? 'one account' : 'every account you may see' }}
                {{ r.symbol ? ' · ' + r.symbol : '' }}</span
              >
            </div>
            @if (r.fillsMeasured === 0) {
              <p class="empty">
                <strong>No live fill in this period</strong>
                A fill is measured when an EA reports an execution of a live (not paper) order;
                widen the period or pick another account.
              </p>
            } @else {
              <div class="kpis pad-all">
                @for (t of summary(r); track t.label) {
                  <div class="kpi" [class.pos]="t.tone === 'pos'" [class.neg]="t.tone === 'neg'">
                    <div class="k-label">{{ t.label }}</div>
                    <div
                      class="k-value"
                      [class.pos]="t.tone === 'pos'"
                      [class.neg]="t.tone === 'neg'"
                    >
                      {{ t.value }}
                    </div>
                    <div class="k-hint">{{ t.hint }}</div>
                  </div>
                }
              </div>
              <p class="legend">
                <span><b class="neg">Red</b> = cost to you (pips positive)</span>
                <span><b class="pos">Green</b> = better than the benchmark</span>
                <span
                  >Markouts: where the market went after the fill — positive means it moved in the
                  account's favour</span
                >
              </p>
            }
          </section>

          @if (r.fillsMeasured > 0) {
            <!-- ── Breakdown ────────────────────────── -->
            <section class="card">
              <div class="card-head">
                <h3>Breakdown</h3>
                <div class="seg" role="tablist" aria-label="Group fills by">
                  <button
                    type="button"
                    role="tab"
                    [class.on]="breakdown() === 'broker'"
                    (click)="breakdown.set('broker')"
                  >
                    By broker <span class="n">{{ r.byBroker.length }}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    [class.on]="breakdown() === 'account'"
                    (click)="breakdown.set('account')"
                  >
                    By account <span class="n">{{ r.byAccount.length }}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    [class.on]="breakdown() === 'symbol'"
                    (click)="breakdown.set('symbol')"
                  >
                    By symbol <span class="n">{{ r.bySymbol.length }}</span>
                  </button>
                </div>
                <span class="hint">all slippage and spread figures in pips</span>
              </div>
              <div class="table-wrap">
                <table class="grid stats">
                  <thead>
                    <tr class="groups">
                      <th rowspan="2" class="first">{{ groupTitle() }}</th>
                      <th rowspan="2" class="num">Fills</th>
                      <th rowspan="2" class="num">Lots</th>
                      <th colspan="4" class="grp">Slippage vs arrival</th>
                      <th
                        rowspan="2"
                        class="num"
                        title="Fill price against the price the order asked for"
                      >
                        Vs req.
                      </th>
                      <th colspan="2" class="grp">Spread</th>
                      <th rowspan="2" class="num">Latency<span class="sub">p50/p95 ms</span></th>
                      @if (r.markoutHorizons.length) {
                        <th [attr.colspan]="r.markoutHorizons.length" class="grp">Markout after</th>
                      }
                    </tr>
                    <tr>
                      <th class="num">Mean</th>
                      <th class="num">Median</th>
                      <th class="num" title="95th percentile of the absolute slippage">
                        Worst 5 %
                      </th>
                      <th class="num" title="Share of fills at a better price than arrival">
                        Better
                      </th>
                      <th class="num">Quoted</th>
                      <th class="num">Effective</th>
                      @for (h of r.markoutHorizons; track h) {
                        <th class="num">{{ h }}</th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of groupRows(); track s.key) {
                      <ng-container
                        *ngTemplateOutlet="statRow; context: { $implicit: s, total: false }"
                      />
                    } @empty {
                      <tr>
                        <td [attr.colspan]="11 + r.markoutHorizons.length" class="empty">
                          No fills.
                        </td>
                      </tr>
                    }
                  </tbody>
                  <tfoot>
                    <ng-container
                      *ngTemplateOutlet="statRow; context: { $implicit: r.overall, total: true }"
                    />
                  </tfoot>
                </table>
              </div>
            </section>

            <!-- ── Fills ────────────────────────────── -->
            <section class="card">
              <div class="card-head">
                <h3>Fills</h3>
                <span class="count">{{ r.fillsMeasured }}</span>
                <span class="hint"
                  >newest first · {{ r.fills.length }} of {{ r.fillsMeasured }} listed here — the
                  CSV has every fill</span
                >
              </div>
              <div class="table-wrap">
                <table class="grid fills stats">
                  <thead>
                    <tr class="groups">
                      <th rowspan="2" class="first">Filled (UTC)</th>
                      <th rowspan="2">Order</th>
                      <th rowspan="2">Account</th>
                      <th rowspan="2">Symbol</th>
                      <th rowspan="2">Side</th>
                      <th rowspan="2" class="num">Lots</th>
                      <th rowspan="2" class="num">Fill price</th>
                      <th rowspan="2" class="num">Arrival mid</th>
                      <th rowspan="2" class="num">Slippage<span class="sub">pips</span></th>
                      <th rowspan="2" class="num">Latency</th>
                      @if (r.markoutHorizons.length) {
                        <th [attr.colspan]="r.markoutHorizons.length" class="grp">Markout after</th>
                      }
                    </tr>
                    <tr>
                      @for (h of r.markoutHorizons; track h) {
                        <th class="num">{{ h }}</th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (f of shownFills(); track f.orderId) {
                      <tr>
                        <td class="first nowrap">
                          {{ minuteUtc(f.filledAtUtc).slice(0, 10) }}
                          <span class="sub">{{ f.filledAtUtc.slice(11, 19) }}</span>
                        </td>
                        <td class="mono">#{{ f.orderId }}</td>
                        <td [title]="f.account + ' · ' + f.broker">
                          <span class="mono">{{ acct(f.account).login }}</span>
                          <span class="sub ellipsis">{{ acct(f.account).name }}</span>
                        </td>
                        <td class="strong">{{ f.symbol }}</td>
                        <td>
                          <span
                            class="pill"
                            [class.buy]="f.side.toLowerCase() === 'buy'"
                            [class.sell]="f.side.toLowerCase() === 'sell'"
                            >{{ f.side }}</span
                          >
                        </td>
                        <td class="num">{{ num(f.lots) }}</td>
                        <td class="num">{{ price(f.fillPrice) }}</td>
                        <td class="num" [title]="'Benchmark: ' + f.arrivalSource">
                          {{ price(f.arrivalMid) }}
                          <span class="sub">{{ sourceWords(f.arrivalSource) }}</span>
                        </td>
                        <td class="num strong" [class]="cost(f.slippageVsArrivalPips)">
                          {{ num(f.slippageVsArrivalPips) }}
                        </td>
                        <td class="num">{{ f.latencyMs === null ? '—' : f.latencyMs + ' ms' }}</td>
                        @for (m of f.markoutPips; track $index) {
                          <td class="num" [class]="pip(m)">{{ num(m) }}</td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (r.fills.length > shown()) {
                <div class="more">
                  <span>Showing {{ shown() }} of {{ r.fills.length }}</span>
                  <button type="button" class="btn btn-sm btn-secondary" (click)="showMore()">
                    Show {{ nextStep(r) }} more
                  </button>
                </div>
              }
            </section>
          }

          <!-- ── Notes and methodology ──────────────── -->
          <section class="card">
            <div class="card-head">
              <h3>About these figures</h3>
              <span class="hint">generated {{ minuteUtc(r.generatedAtUtc) }} UTC</span>
            </div>
            <div class="notes">
              @for (n of r.dataNotes; track $index) {
                <p class="callout">{{ n }}</p>
              } @empty {
                <p class="small muted">No data caveats for this report.</p>
              }
            </div>
            @if (r.methodology.length) {
              <details class="method">
                <summary>How execution is measured ({{ r.methodology.length }} notes)</summary>
                <ol>
                  @for (m of r.methodology; track $index) {
                    <li>{{ m }}</li>
                  }
                </ol>
              </details>
            }
          </section>
        }
      }
    </div>

    <ng-template #statRow let-s let-total="total">
      <tr [class.total]="total">
        <td class="first">
          @if (total) {
            <span class="strong">All fills</span>
          } @else {
            @switch (breakdown()) {
              @case ('broker') {
                <span class="strong">{{ broker(s.key).broker }}</span>
                <span class="sub">{{ broker(s.key).server }}</span>
              }
              @case ('account') {
                <span class="strong mono">{{ acct(s.key).login }}</span>
                <span class="sub">{{ acct(s.key).name }}</span>
              }
              @default {
                <span class="strong">{{ s.key }}</span>
              }
            }
          }
        </td>
        <td class="num">{{ s.fills }}</td>
        <td class="num">{{ num(s.lots) }}</td>
        <td class="num strong" [class]="cost(s.meanSlippagePips)">{{ num(s.meanSlippagePips) }}</td>
        <td class="num" [class]="cost(s.medianSlippagePips)">{{ num(s.medianSlippagePips) }}</td>
        <td class="num">{{ num(s.p95AbsSlippagePips) }}</td>
        <td class="num">{{ pct(s.priceImprovementShare, 0) }}</td>
        <td class="num" [class]="cost(s.meanVsRequestedPips)">{{ num(s.meanVsRequestedPips) }}</td>
        <td class="num">{{ num(s.meanQuotedSpreadPips) }}</td>
        <td class="num" [class]="cost(s.meanEffectiveSpreadPips)">
          {{ num(s.meanEffectiveSpreadPips) }}
        </td>
        <td class="num">{{ num(s.medianLatencyMs, 0) }} / {{ num(s.p95LatencyMs, 0) }}</td>
        @for (m of s.meanMarkoutPips; track $index) {
          <td
            class="num"
            [class]="pip(m)"
            [title]="(s.markoutSamples[$index] ?? 0) + ' fills measured'"
          >
            {{ num(m) }}
          </td>
        }
      </tr>
    </ng-template>
  `,
})
export class BestExecutionPageComponent {
  private readonly fund = inject(FundApiService);
  private readonly notify = inject(NotificationService);

  protected readonly num = num;
  protected readonly pct = pct;
  protected readonly tone = tone;
  protected readonly minuteUtc = minuteUtc;
  protected readonly acct = splitAccount;
  protected readonly broker = splitBroker;
  protected readonly presets = periodPresets(new Date());

  readonly scope = signal<FundScope>({ accounts: [], groups: [], bestExecution: false });
  readonly account = signal<number | null>(null);
  readonly symbol = signal('');
  readonly from = signal(defaultPeriod(new Date(), 30).from);
  readonly to = signal(defaultPeriod(new Date(), 30).to);
  readonly report = signal<BestExecutionReport | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly upgrade = signal<string | null>(null);
  readonly breakdown = signal<Breakdown>('broker');
  readonly shown = signal(FILL_PAGE);
  /** Every symbol seen in a report this visit — suggestions for the symbol box. */
  readonly knownSymbols = signal<string[]>([]);

  protected readonly summary = bestExTiles;

  readonly preset = computed(() => matchPreset(this.from(), this.to(), new Date()));
  readonly groupRows = computed<FillGroupStats[]>(() => {
    const r = this.report();
    if (!r) return [];
    const b = this.breakdown();
    return b === 'broker' ? r.byBroker : b === 'account' ? r.byAccount : r.bySymbol;
  });
  readonly groupTitle = computed(() =>
    this.breakdown() === 'broker'
      ? 'Broker'
      : this.breakdown() === 'account'
        ? 'Account'
        : 'Symbol',
  );
  readonly shownFills = computed(() => this.report()?.fills.slice(0, this.shown()) ?? []);

  constructor() {
    // Open on the default question (every account you may see, last 30 days) instead of a blank page.
    this.fund.scope().subscribe({
      next: (s) => {
        this.scope.set(s);
        this.load();
      },
      error: (e) => this.fail(e),
    });
  }

  periodText(r: BestExecutionReport): string {
    return periodLabel(r.fromUtc, r.toUtc);
  }

  /** Pips are costs when positive: red for a cost, green for an improvement. */
  cost(v: number | null | undefined): string {
    const t = this.pip(v);
    return t === 'pos' ? 'neg' : t === 'neg' ? 'pos' : '';
  }

  /** Tone of a pip figure as shown (two decimals): "0.00" is never coloured. */
  pip(v: number | null | undefined): string {
    return v === null || v === undefined ? '' : tone(Math.round(v * 100) / 100);
  }

  /** Enough decimals for the instrument: 5 for FX, 2 for indices. */
  price(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    return num(v, Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 50 ? 3 : 5);
  }

  sourceWords(source: string): string {
    const s = source.replace(/[-_]/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  nextStep(r: BestExecutionReport): number {
    return Math.min(FILL_PAGE, r.fills.length - this.shown());
  }

  showMore(): void {
    this.shown.update((n) => n + FILL_PAGE);
  }

  applyPreset(key: PresetKey): void {
    const p = this.presets.find((x) => x.key === key);
    if (!p) return;
    this.from.set(p.from);
    this.to.set(p.to);
    this.load();
  }

  private params() {
    const period = periodQuery(this.from(), this.to());
    if ('problem' in period) {
      this.error.set(period.problem);
      return null;
    }
    return {
      from: period.from,
      to: period.to,
      tradingAccountId: this.account(),
      symbol: this.symbol().trim().toUpperCase() || null,
    };
  }

  private fail(e: unknown): void {
    this.loading.set(false);
    if (isUpgradeNotice(e))
      this.upgrade.set(errorText(e, 'Your plan does not include the fund module.'));
    else this.error.set(errorText(e, 'The report could not be loaded.'));
  }

  load(): void {
    const params = this.params();
    if (!params) return;
    this.loading.set(true);
    this.error.set(null);
    this.fund.bestExecution(params).subscribe({
      next: (r) => {
        this.report.set(r);
        this.shown.set(FILL_PAGE);
        this.knownSymbols.update((known) =>
          [...new Set([...known, ...r.bySymbol.map((s) => s.key)])].sort(),
        );
        this.loading.set(false);
      },
      error: (e) => this.fail(e),
    });
  }

  download(format: 'pdf' | 'csv'): void {
    const params = this.params();
    if (!params) return;
    this.busy.set(true);
    this.fund.bestExecutionExport(params, format).subscribe({
      next: (file) => {
        this.busy.set(false);
        saveBlob(file.blob, file.fileName);
      },
      error: (e) => {
        this.busy.set(false);
        this.notify.error(errorText(e, 'The download failed.'));
      },
    });
  }
}
