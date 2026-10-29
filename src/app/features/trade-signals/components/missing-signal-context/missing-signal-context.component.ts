import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Observable, catchError, forkJoin, of } from 'rxjs';

import type { PagedData, ResponseData, TradeSignalDto } from '@core/api/api.types';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import {
  daySummary,
  nearestPlan,
  sourceText,
  utcMidnightIso,
} from './missing-signal-context.logic';

/**
 * Shown under "No signal #N": the real signals nearest the requested id, today's counts and
 * outcomes, and the newest signals — so a dead link lands on something useful.
 */
@Component({
  selector: 'app-missing-signal-context',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, NgTemplateOutlet, RouterLink, MetricCardComponent],
  template: `
    @let d = day();
    <div class="tiles">
      <app-metric-card
        [label]="'Signals ' + windowLabel()"
        [value]="todayTotal()"
        format="number"
        dotColor="#0071E3"
      />
      <app-metric-card
        label="Reached an account"
        [value]="null"
        [displayValue]="d.pickedUp + ' of ' + d.total"
        dotColor="#34C759"
      />
      <app-metric-card
        label="With an order"
        [value]="d.withOrder"
        format="number"
        dotColor="#AF52DE"
      />
      <app-metric-card
        [label]="'Symbols ' + windowLabel()"
        [value]="d.symbols"
        format="number"
        dotColor="#5AC8FA"
      />
      <app-metric-card
        label="Signals on record"
        [value]="totalSignals()"
        format="number"
        dotColor="#8E8E93"
      />
    </div>

    <div class="grid">
      <section class="card">
        <header class="card-head">
          <h3>{{ nearestTitle() }}</h3>
          <span class="muted small">{{ nearestNote() }}</span>
        </header>
        @if (nearest().length === 0) {
          <p class="muted pad">{{ loading() ? 'Loading…' : 'No neighbouring signals found.' }}</p>
        } @else {
          <ng-container *ngTemplateOutlet="table; context: { $implicit: nearest() }" />
        }
      </section>

      <section class="card">
        <header class="card-head">
          <h3>{{ weekFallback() ? 'Last 7 days' : 'Today so far' }}</h3>
          <span class="muted small">{{
            weekFallback()
              ? 'nothing generated yet today (UTC), so the last 7 days'
              : 'generated since 00:00 UTC'
          }}</span>
        </header>
        @if (d.total === 0) {
          <p class="muted pad">
            {{ loading() ? 'Loading…' : 'No signal has been generated yet today (UTC).' }}
          </p>
        } @else {
          <div class="pad">
            <h4>Outcome</h4>
            @for (s of d.byStatus; track s.status) {
              <div class="bar-row">
                <span class="st" [attr.data-status]="s.status">{{ s.status }}</span>
                <span class="bar"><span [style.width.%]="(s.count / d.total) * 100"></span></span>
                <span class="n">{{ s.count }}</span>
              </div>
            }
            <h4>Source</h4>
            @for (s of d.bySource; track s.source) {
              <div class="bar-row">
                <span>{{ s.source }}</span>
                <span class="bar"><span [style.width.%]="(s.count / d.total) * 100"></span></span>
                <span class="n">{{ s.count }}</span>
              </div>
            }
            @if (todayTotal() > d.total) {
              <p class="muted small">
                Counts cover the {{ d.total }} newest of {{ todayTotal() }}.
              </p>
            }
          </div>
        }
      </section>
    </div>

    <section class="card">
      <header class="card-head">
        <h3>Most recent signals</h3>
        <a routerLink="/trade-signals" class="small">All signals →</a>
      </header>
      @if (recent().length === 0) {
        <p class="muted pad">{{ loading() ? 'Loading…' : 'No signals on record.' }}</p>
      } @else {
        <ng-container *ngTemplateOutlet="table; context: { $implicit: recent() }" />
      }
    </section>

    <ng-template #table let-rows>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Signal</th>
              <th>Generated (UTC)</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Source</th>
              <th>Status</th>
              <th class="num" title="Accounts that created an order from it">Accounts</th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows; track r.id) {
              <tr>
                <td>
                  <a [routerLink]="['/trade-signals', r.id]">#{{ r.id }}</a>
                </td>
                <td class="nowrap">{{ r.generatedAt | date: 'MMM d y, HH:mm' : 'UTC' }}</td>
                <td class="mono">{{ r.symbol }}</td>
                <td [class.buy]="r.direction === 'Buy'" [class.sell]="r.direction === 'Sell'">
                  {{ r.direction }}
                </td>
                <td>{{ sourceLabel(r) }}</td>
                <td>
                  <span class="st" [attr.data-status]="r.status">{{ r.status }}</span>
                </td>
                <td class="num">{{ r.accountsPickedUpCount | number }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </ng-template>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: var(--space-3);
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        gap: var(--space-4);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .tiles {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .card-head a {
        color: var(--accent);
      }
      .pad {
        padding: var(--space-3) var(--space-4);
        margin: 0;
      }
      h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      h4 + .bar-row,
      .bar-row + h4 {
        margin-top: var(--space-2);
      }
      .bar-row {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr) 36px;
        gap: var(--space-2);
        align-items: center;
        font-size: var(--text-sm);
        margin-bottom: 6px;
      }
      .bar {
        height: 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .bar span {
        display: block;
        height: 100%;
        background: var(--accent);
      }
      .n,
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .nowrap {
        white-space: nowrap;
      }
      .scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th {
        text-align: left;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      td {
        padding: 6px var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      tr:last-child td {
        border-bottom: none;
      }
      td a {
        color: var(--accent);
      }
      .buy {
        color: var(--profit);
      }
      .sell {
        color: var(--loss);
      }
      .st {
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .st[data-status='Executed'],
      .st[data-status='Approved'] {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .st[data-status='Rejected'] {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .st[data-status='Pending'] {
        background: rgba(255, 149, 0, 0.15);
        color: var(--warning);
      }
    `,
  ],
})
export class MissingSignalContextComponent implements OnInit {
  private readonly signals = inject(TradeSignalsService);

  readonly requestedId = input.required<number>();
  readonly earliestId = input<number | null>(null);
  readonly latestId = input<number | null>(null);
  readonly previousId = input<number | null>(null);
  readonly nextId = input<number | null>(null);
  readonly totalSignals = input<number | null>(null);

  readonly loading = signal(true);
  readonly recent = signal<TradeSignalDto[]>([]);
  readonly nearest = signal<TradeSignalDto[]>([]);
  private readonly today = signal<TradeSignalDto[]>([]);
  readonly todayTotal = signal(0);
  readonly day = computed(() => daySummary(this.today()));
  /** Nothing yet today (UTC): the panel shows the last 7 days instead, and says so. */
  readonly weekFallback = signal(false);
  readonly windowLabel = computed(() => (this.weekFallback() ? '(7 days)' : 'today (UTC)'));

  readonly plan = computed(() =>
    nearestPlan(this.requestedId(), this.earliestId(), this.latestId()),
  );
  readonly nearestTitle = computed(() => {
    switch (this.plan()) {
      case 'oldest':
        return 'Oldest signals on record';
      case 'newest':
        return 'Newest signals on record';
      default:
        return `Signals either side of #${this.requestedId()}`;
    }
  });
  readonly nearestNote = computed(() =>
    this.plan() === 'oldest'
      ? `the closest existing ids to #${this.requestedId()}`
      : this.plan() === 'newest'
        ? `#${this.requestedId()} has not been created yet`
        : 'the closest existing ids',
  );

  sourceLabel(r: TradeSignalDto): string {
    return sourceText(r);
  }

  private loadWeek(
    list: (
      d: 'asc' | 'desc',
      size: number,
      filter?: object,
    ) => Observable<ResponseData<PagedData<TradeSignalDto>> | null>,
  ): void {
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    list('desc', 200, { from }).subscribe((res) => {
      if (!res?.status) return;
      this.weekFallback.set(true);
      this.today.set(res.data?.data ?? []);
      this.todayTotal.set(res.data?.pager?.totalItemCount ?? res.data?.data?.length ?? 0);
    });
  }

  ngOnInit(): void {
    const list = (sortDirection: 'asc' | 'desc', size: number, filter?: object) =>
      this.signals
        .list({ currentPage: 1, itemCountPerPage: size, sortBy: 'id', sortDirection, filter })
        .pipe(catchError(() => of(null)));

    const plan = this.plan();
    const around =
      plan === 'around'
        ? forkJoin(
            [this.previousId(), this.nextId()]
              .filter((x): x is number => x != null)
              .map((id) => this.signals.getById(id).pipe(catchError(() => of(null)))),
          )
        : of([]);

    forkJoin({
      recent: list('desc', 10),
      oldest: plan === 'oldest' ? list('asc', 6) : of(null),
      today: list('desc', 200, { from: utcMidnightIso() }),
      around: around.pipe(catchError(() => of([]))),
    }).subscribe(({ recent, oldest, today, around: arr }) => {
      this.loading.set(false);
      const rec = recent?.status ? (recent.data?.data ?? []) : [];
      this.recent.set(rec);
      if (today?.status) {
        const n = today.data?.pager?.totalItemCount ?? today.data?.data?.length ?? 0;
        if (n === 0) {
          this.loadWeek(list);
        } else {
          this.today.set(today.data?.data ?? []);
          this.todayTotal.set(n);
        }
      }
      if (plan === 'oldest') this.nearest.set(oldest?.status ? (oldest.data?.data ?? []) : []);
      else if (plan === 'newest') this.nearest.set(rec.slice(0, 6));
      else
        this.nearest.set(
          (arr ?? [])
            .map((r) => (r?.status ? r.data : null))
            .filter((r): r is TradeSignalDto => r != null),
        );
    });
  }
}
