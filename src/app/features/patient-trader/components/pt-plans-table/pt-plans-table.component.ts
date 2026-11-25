import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DatePipe, DecimalPipe, LowerCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  PLAN_STATUSES,
  PatientTraderPlan,
  planOcoChipPartners,
} from '@features/patient-trader/patient-trader.types';
import {
  PlanFilters,
  codeWords,
  formatR,
  isRefused,
  planRewardRisk,
  refusalStage,
  relativeTime,
  summariseOutcome,
} from '@features/patient-trader/patient-trader.logic';
import { OcoChipComponent } from '@shared/components/oco-chip/oco-chip.component';
import { OcoBannerComponent } from '@shared/components/oco-chip/oco-banner.component';
import { ocoHue } from '@shared/utils/oco';
import { injectNow } from '../pt-clock';

function toggled(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Every plan the agent wrote — including the ones it passed on and the ones the checks refused —
 * with its levels, its outcome, and links to the card, watch and signal it became. Filters and the
 * page live in the URL (the container owns them); an OCO focus shows every leg of one group.
 */
@Component({
  selector: 'app-pt-plans-table',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    DecimalPipe,
    LowerCasePipe,
    RouterLink,
    OcoChipComponent,
    OcoBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-label="Plans and refusals">
      <h2>Plans and refusals</h2>
      <p class="muted small">
        The setups it passed on and the ones the checks refused are shown next to the ones that ran,
        on purpose — that is how a patient agent is told apart from a broken one that never finds
        anything.
      </p>

      @if (oco(); as group) {
        <app-oco-banner
          [groupId]="group"
          [text]="
            'Showing every plan of one OCO group (' +
            plans().length +
            ') — the first to file stands the others down.'
          "
          otherPage="/trade-recommendations"
          otherLabel="Their cards on Recommendations →"
          secondPage="/analysis-monitors"
          secondLabel="Their watches on Monitors →"
          clearLabel="Show all plans ✕"
          (cleared)="ocoSelect.emit(null)"
        />
      } @else {
        <div class="row small filters" aria-label="Filters">
          <details class="multi">
            <summary>
              Status{{ filters().status.length ? ': ' + filters().status.join(', ') : ': any' }}
            </summary>
            <div class="multi-list">
              @for (s of statuses; track s) {
                <label>
                  <input
                    type="checkbox"
                    [checked]="filters().status.includes(s)"
                    (change)="toggleStatus(s)"
                  />
                  {{ s }}
                </label>
              }
            </div>
          </details>
          <select
            aria-label="Direction"
            [ngModel]="filters().direction ?? ''"
            name="pf-dir"
            (ngModelChange)="set({ direction: $event || null })"
          >
            <option value="">Buy or Sell</option>
            <option value="Buy">Buy</option>
            <option value="Sell">Sell</option>
          </select>
          <select
            aria-label="Refused because"
            [ngModel]="filters().rejectionCode ?? ''"
            name="pf-code"
            (ngModelChange)="set({ rejectionCode: $event || null })"
          >
            <option value="">Any reason</option>
            @for (c of codeOptions(); track c) {
              <option [value]="c">{{ codeWords(c) }}</option>
            }
          </select>
          <select
            aria-label="Market"
            [ngModel]="filters().symbol ?? ''"
            name="pf-sym"
            (ngModelChange)="set({ symbol: $event || null })"
          >
            <option value="">All markets</option>
            @for (s of symbolOptions(); track s) {
              <option [value]="s">{{ s }}</option>
            }
          </select>
          @if (hasFilters()) {
            <button type="button" class="linkish" (click)="clear()">Clear filters</button>
          }
          <span class="spacer"></span>
          <span class="muted">{{ pageLabel() }}</span>
          <button
            type="button"
            class="linkish"
            [disabled]="filters().page === 0"
            (click)="set({ page: filters().page - 1 }, false)"
          >
            ‹ Newer
          </button>
          <button
            type="button"
            class="linkish"
            [disabled]="(filters().page + 1) * pageSize() >= total()"
            (click)="set({ page: filters().page + 1 }, false)"
          >
            Older ›
          </button>
        </div>
      }

      @if (plans().length === 0) {
        <p class="muted small">
          {{
            oco()
              ? 'No plan belongs to this OCO group.'
              : hasFilters()
                ? 'No plan matches these filters.'
                : 'Nothing written yet.'
          }}
        </p>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Market</th>
                <th>Status</th>
                <th class="num">Entry</th>
                <th class="num">Stop</th>
                <th class="num">Target</th>
                <th class="num">R:R</th>
                <th>Expires</th>
                <th>Outcome</th>
                <th>Links</th>
                <th>Reasoning</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.p.id) {
                @let p = row.p;
                <tr
                  [class.refused]="row.refused"
                  [class.oco-row]="!!p.ocoGroupId"
                  [class.oco-lit]="!!p.ocoGroupId && hoveredOco() === p.ocoGroupId"
                  [style.--oco-h]="p.ocoGroupId ? ocoHue(p.ocoGroupId) : null"
                  (mouseenter)="p.ocoGroupId && hoveredOco.set(p.ocoGroupId)"
                  (mouseleave)="p.ocoGroupId && hoveredOco.set(null)"
                >
                  <td class="nowrap">{{ p.createdAtUtc | date: 'dd MMM HH:mm' }}</td>
                  <td class="nowrap">
                    <span class="mono">{{ p.symbol }}</span>
                    @if (p.timeframe) {
                      <span class="muted"> {{ p.timeframe }}</span>
                    }
                    @if (p.direction !== 'None') {
                      <span class="dir" [class.buy]="p.direction === 'Buy'">{{ p.direction }}</span>
                    }
                    @if (p.entryStyle && p.entryStyle !== 'Limit') {
                      <span class="muted"> · {{ p.entryStyle | lowercase }}</span>
                    }
                  </td>
                  <td>
                    <span class="status" [class]="'status ' + row.statusClass">{{ p.status }}</span>
                    @if (p.observeOnly) {
                      <span class="tag" title="Walked on paper — no real order was placed"
                        >paper</span
                      >
                    }
                    @if (row.stage) {
                      <span class="tag warn">{{ row.stage }}</span>
                    }
                    @if (p.nearFloor) {
                      <span class="tag warn" title="Stop right at the minimum allowed">floor</span>
                    }
                    @if (p.conviction === 'High') {
                      <span class="tag accent" title="Backed above the ordinary bar">high</span>
                    }
                    @if (p.rejectionCode) {
                      <div class="muted small" [title]="p.rejectionCode">
                        {{ codeWords(p.rejectionCode) }}
                      </div>
                    }
                    @if (p.ocoGroupId) {
                      <div class="oco-line">
                        <app-oco-chip
                          [groupId]="p.ocoGroupId"
                          [partners]="row.partners"
                          [highlighted]="hoveredOco() === p.ocoGroupId"
                          [selectable]="oco() !== p.ocoGroupId"
                          [showLonely]="true"
                          (hover)="hoveredOco.set($event)"
                          (selected)="ocoSelect.emit($event)"
                        />
                      </div>
                    }
                  </td>
                  <td class="num">{{ price(p.entryPrice) }}</td>
                  <td class="num">{{ price(p.stopLoss) }}</td>
                  <td class="num">{{ price(p.takeProfit) }}</td>
                  <td class="num">{{ row.rr !== null ? (row.rr | number: '1.2-2') : '—' }}</td>
                  <td class="nowrap">
                    @if (p.status === 'Armed' && p.expiresAtUtc) {
                      <span [title]="p.expiresAtUtc | date: 'dd MMM HH:mm'">{{
                        rel(p.expiresAtUtc)
                      }}</span>
                    } @else if (p.expiresAtUtc) {
                      <span class="muted">{{ p.expiresAtUtc | date: 'dd MMM HH:mm' }}</span>
                    } @else {
                      —
                    }
                  </td>
                  <td class="outcome">
                    @if (row.outcome; as o) {
                      <span>{{ o.label }}</span>
                      @if (o.r !== null) {
                        <span [class.pos]="o.r > 0" [class.neg]="o.r < 0"> {{ r_(o.r) }}</span>
                      }
                      @if (o.bestR !== null) {
                        <span class="muted"> · best {{ r_(o.bestR) }}</span>
                      }
                      @if (o.isReplay) {
                        <span
                          class="tag"
                          title="Walked over the candles afterwards — no real position"
                          >replay</span
                        >
                      }
                      @if (o.asWritten) {
                        <div class="muted">{{ o.asWritten }}</div>
                      }
                      @if (o.note) {
                        <div class="muted">{{ o.note }}</div>
                      }
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="links">
                    @if (p.recommendationId) {
                      <a class="tag" [routerLink]="['/trade-recommendations', p.recommendationId]"
                        >card #{{ p.recommendationId }}</a
                      >
                    }
                    @if (p.entryMonitorId) {
                      <a
                        class="tag"
                        [routerLink]="['/analysis-monitors']"
                        [queryParams]="{ focus: p.entryMonitorId }"
                        >watch #{{ p.entryMonitorId }}</a
                      >
                    }
                    @if (p.tradeSignalId) {
                      <a class="tag" [routerLink]="['/trade-signals', p.tradeSignalId]"
                        >signal #{{ p.tradeSignalId }}</a
                      >
                    }
                    @if (p.journalLlmInvocationId; as jid) {
                      <a
                        class="thread-link"
                        [routerLink]="['/conversations']"
                        [queryParams]="{ conversation: jid }"
                        [title]="'Open the ' + p.symbol + ' journal — this plan in context'"
                        aria-label="Open this market's journal"
                        >💬</a
                      >
                    }
                  </td>
                  <td class="reason" [class.open]="isOpen(p.id)">
                    <button
                      type="button"
                      class="reason-body"
                      [attr.aria-expanded]="isOpen(p.id)"
                      (click)="toggle(p.id)"
                    >
                      @if (p.rejectionReason) {
                        <span class="muted">{{ p.rejectionReason }}</span>
                      } @else {
                        {{ p.thesis }}
                      }
                    </button>
                    @if (isOpen(p.id)) {
                      @if (p.entryBasis) {
                        <span class="detail muted">Entry: {{ p.entryBasis }}</span>
                      }
                      @if (p.stopBasis) {
                        <span class="detail muted">Stop: {{ p.stopBasis }}</span>
                      }
                      @if (p.targetBasis) {
                        <span class="detail muted">Target: {{ p.targetBasis }}</span>
                      }
                    }
                    @if (p.preMortem) {
                      <span class="detail muted premortem" title="Named before the plan was armed">
                        How it dies: {{ p.preMortem }}
                      </span>
                    }
                    @if (p.invalidationPrice) {
                      <span
                        class="detail muted"
                        title="Called off before entry if price reaches this"
                      >
                        Call off at {{ p.invalidationPrice }}
                      </span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
  styleUrls: ['../pt-common.css'],
  styles: [
    `
      .filters {
        gap: 6px;
      }
      .multi {
        position: relative;
      }
      .multi > summary {
        cursor: pointer;
        list-style: none;
        padding: 4px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .multi > summary::-webkit-details-marker {
        display: none;
      }
      .multi-list {
        position: absolute;
        z-index: 5;
        top: calc(100% + 4px);
        left: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: var(--space-2);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        min-width: 160px;
      }
      .multi-list label {
        display: flex;
        gap: 6px;
        align-items: center;
        cursor: pointer;
      }
      .table-wrap {
        max-height: 560px;
        overflow: auto;
        overscroll-behavior: contain;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      th,
      td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        font-size: 10.5px;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .nowrap {
        white-space: nowrap;
      }
      tr.refused {
        opacity: 0.75;
      }
      .status {
        font-weight: var(--font-semibold);
        margin-right: 4px;
      }
      .status.ok {
        color: var(--profit, #15803d);
      }
      .status.bad {
        color: var(--loss, #b91c1c);
      }
      .status.neutral {
        color: var(--text-secondary);
      }
      .status.live {
        color: var(--accent);
      }
      .tag {
        margin: 1px 2px;
      }
      .dir {
        margin-left: 4px;
        color: var(--loss, #b91c1c);
      }
      .dir.buy {
        color: var(--profit, #15803d);
      }
      .oco-line {
        margin-top: 4px;
      }
      tr.oco-row td:first-child {
        box-shadow: inset 3px 0 0 hsl(var(--oco-h) 65% 52%);
      }
      tr.oco-lit {
        opacity: 1;
        background: hsl(var(--oco-h) 70% 50% / 0.12);
      }
      app-oco-banner {
        display: block;
      }
      .outcome {
        min-width: 120px;
        font-variant-numeric: tabular-nums;
      }
      .links {
        min-width: 90px;
      }
      .reason {
        max-width: 42ch;
        min-width: 24ch;
        line-height: 1.45;
      }
      /* Clamped to two lines, opened on click — a full thesis per row ran to five screens. */
      .reason-body {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        cursor: pointer;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        padding: 0;
        text-align: left;
      }
      .reason.open .reason-body {
        display: block;
        overflow: visible;
      }
      .reason-body:hover {
        opacity: 0.8;
      }
      .detail {
        display: block;
        margin-top: 3px;
        font-size: 11px;
      }
      .premortem {
        font-style: italic;
      }
    `,
  ],
})
export class PtPlansTableComponent {
  readonly plans = input<PatientTraderPlan[]>([]);
  /** Plans matching the filters (for the pager). */
  readonly total = input(0);
  readonly pageSize = input(50);
  readonly filters = input.required<PlanFilters>();
  /** The OCO group the table is narrowed to, or null. */
  readonly oco = input<string | null>(null);
  /** Refusal codes seen in the counters' window (the reason filter's options). */
  readonly codes = input<string[]>([]);
  /** Followed markets (the market filter's options). */
  readonly symbols = input<string[]>([]);

  readonly filtersChange = output<PlanFilters>();
  readonly ocoSelect = output<string | null>();

  protected readonly statuses = PLAN_STATUSES;
  protected readonly codeWords = codeWords;
  protected readonly ocoHue = ocoHue;
  /** The group under the pointer — its legs light up together. */
  protected readonly hoveredOco = signal<string | null>(null);

  private readonly now = injectNow(30_000);
  /**
   * Which plan rows the operator has opened. Collapsed is the default: the page is a cockpit, not
   * a document. A set rather than one id, so two can be compared side by side.
   */
  private readonly openRows = signal<ReadonlySet<number>>(new Set());

  protected readonly rows = computed(() =>
    this.plans().map((p) => ({
      p,
      refused: isRefused(p),
      stage: refusalStage(p),
      statusClass: statusClass(p.status),
      rr: planRewardRisk(p),
      outcome: summariseOutcome(p.outcomeJson),
      partners: planOcoChipPartners(p),
    })),
  );

  /** The reason filter keeps a code chosen from the URL even when this window has none of it. */
  protected readonly codeOptions = computed(() => {
    const set = new Set(this.codes());
    const chosen = this.filters().rejectionCode;
    if (chosen) set.add(chosen);
    return [...set].sort();
  });

  protected readonly symbolOptions = computed(() => {
    const set = new Set(this.symbols());
    const chosen = this.filters().symbol;
    if (chosen) set.add(chosen);
    return [...set].sort();
  });

  protected readonly hasFilters = computed(() => {
    const f = this.filters();
    return f.status.length > 0 || !!f.direction || !!f.rejectionCode || !!f.symbol;
  });

  protected readonly pageLabel = computed(() => {
    const total = this.total();
    if (!total) return '0 plans';
    const from = this.filters().page * this.pageSize() + 1;
    const to = Math.min(total, from + this.plans().length - 1);
    return `${from}–${to} of ${total}`;
  });

  protected isOpen(id: number): boolean {
    return this.openRows().has(id);
  }

  protected toggle(id: number): void {
    this.openRows.update((s) => toggled(s, id));
  }

  protected rel(iso: string): string {
    return relativeTime(iso, this.now());
  }

  protected r_(v: number | null): string {
    return formatR(v);
  }

  protected price(v: number | null | undefined): string {
    return typeof v === 'number' && v > 0 ? String(v) : '—';
  }

  /** Applies a filter change; any change other than paging goes back to the first page. */
  protected set(patch: Partial<PlanFilters>, resetPage = true): void {
    const next = { ...this.filters(), ...patch };
    if (resetPage) next.page = 0;
    this.filtersChange.emit(next);
  }

  protected toggleStatus(s: string): void {
    const cur = this.filters().status;
    this.set({ status: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
  }

  protected clear(): void {
    this.filtersChange.emit({
      status: [],
      direction: null,
      rejectionCode: null,
      symbol: null,
      page: 0,
    });
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'Settled':
    case 'Filled':
      return 'ok';
    case 'Armed':
      return 'live';
    case 'Rejected':
      return 'bad';
    default:
      return 'neutral';
  }
}
