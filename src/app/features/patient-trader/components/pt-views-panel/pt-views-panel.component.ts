import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { PatientTraderService } from '@core/services/patient-trader.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type { PatientTraderView } from '@features/patient-trader/patient-trader.types';
import { ScenarioRow, scenarioRows } from '@features/patient-trader/patient-trader.logic';

function toggled(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * What the agent currently thinks about each market, and — on the History tab — every past view
 * with how it was scored against what the market did and against the naive baseline.
 */
@Component({
  selector: 'app-pt-views-panel',
  standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-label="Views">
      <div class="row">
        <h2>What it thinks</h2>
        <span class="spacer"></span>
        <div class="seg" role="group" aria-label="Which views">
          <button
            type="button"
            [attr.aria-pressed]="tab() === 'current'"
            (click)="setTab('current')"
          >
            Now
          </button>
          <button
            type="button"
            [attr.aria-pressed]="tab() === 'history'"
            (click)="setTab('history')"
          >
            History
          </button>
        </div>
      </div>

      @if (tab() === 'current') {
        @if (views().length === 0) {
          <p class="muted small">
            No views yet. The agent writes one per followed market on its cadence — nothing here
            means it is switched off, has no markets, or has not reached its first look. The health
            check above says which.
          </p>
        } @else {
          <!-- Bounded and scrolling: twenty full narratives once ran to eleven screens. -->
          <div class="scroll-list">
            @for (v of views(); track v.id) {
              <article class="view" [class.open]="isOpen(v.id)">
                <header>
                  <button
                    type="button"
                    class="view-toggle"
                    [attr.aria-expanded]="isOpen(v.id)"
                    (click)="toggle(v.id)"
                  >
                    <span class="mono">{{ v.symbol }} {{ v.timeframe }}</span>
                    <span class="muted small">{{ v.regime }}</span>
                    <span
                      class="lean-pill"
                      [class.buy]="v.lean === 'Buy'"
                      [class.sell]="v.lean === 'Sell'"
                    >
                      {{ v.lean === 'None' ? 'no view' : v.lean }}
                      @if (v.lean !== 'None') {
                        · {{ v.confidence | number: '1.2-2' }}
                      }
                    </span>
                    <span class="spacer"></span>
                    <span class="muted small">{{ ago(v.ageMinutes) }}</span>
                    <span class="chev" aria-hidden="true">{{ isOpen(v.id) ? '▴' : '▾' }}</span>
                  </button>
                  @if (v.journalLlmInvocationId; as jid) {
                    <a
                      class="thread-link"
                      [routerLink]="['/conversations']"
                      [queryParams]="{ conversation: jid }"
                      [title]="'Open the ' + v.symbol + ' journal — every view and plan in order'"
                      aria-label="Open this market's journal"
                      >💬</a
                    >
                  }
                  @if (v.analysisLlmInvocationId; as aid) {
                    <a
                      class="thread-link"
                      [routerLink]="['/conversations']"
                      [queryParams]="{ conversation: aid }"
                      title="Open the full analysis behind this view"
                      aria-label="Open the analysis"
                      >🔎</a
                    >
                  }
                </header>

                @if (isOpen(v.id)) {
                  <p class="narrative">{{ v.narrative }}</p>
                  @if (scenariosOf(v); as rows) {
                    @if (rows.length > 0) {
                      <ul class="scenarios">
                        @for (s of rows; track $index) {
                          <li>
                            @if (s.kind === 'level') {
                              <span class="level mono">{{ s.level }}</span>
                              @if (s.direction) {
                                <span
                                  class="tag"
                                  [class.good]="s.direction === 'Up'"
                                  [class.bad]="s.direction === 'Down'"
                                  >{{ dirWords(s.direction) }}</span
                                >
                              }
                              @if (s.probability !== null) {
                                <span class="muted"
                                  >{{ s.probability * 100 | number: '1.0-0' }}%</span
                                >
                              }
                              @if (s.text) {
                                <span> — {{ s.text }}</span>
                              }
                            } @else {
                              @if (s.text) {
                                <b>{{ s.text }}</b>
                              }
                              @if (s.expectedReaction) {
                                <span> → {{ s.expectedReaction }}</span>
                              }
                              @if (s.myAction) {
                                <span class="muted"> · I would: {{ s.myAction }}</span>
                              }
                              @if (s.invalidation) {
                                <span class="muted"> · wrong if: {{ s.invalidation }}</span>
                              }
                            }
                          </li>
                        }
                      </ul>
                    }
                  }
                  @if (v.whatWouldChangeMyMind) {
                    <p class="muted small">Would change my mind: {{ v.whatWouldChangeMyMind }}</p>
                  }
                } @else {
                  <p class="narrative clamp-2">{{ v.narrative }}</p>
                }
              </article>
            }
          </div>
        }
      } @else {
        <div class="row small">
          <label class="muted" for="pt-vh-lean">Lean</label>
          <select
            id="pt-vh-lean"
            [ngModel]="lean()"
            (ngModelChange)="setLean($event)"
            name="vh-lean"
          >
            <option value="">Any</option>
            <option value="Buy">Buy</option>
            <option value="Sell">Sell</option>
            <option value="None">No view</option>
          </select>
          <label class="muted" for="pt-vh-sym">Market</label>
          <select
            id="pt-vh-sym"
            [ngModel]="symbol()"
            (ngModelChange)="setSymbol($event)"
            name="vh-sym"
          >
            <option value="">All</option>
            @for (s of symbols(); track s) {
              <option [value]="s">{{ s }}</option>
            }
          </select>
          <span class="spacer"></span>
          @if (history.value(); as h) {
            <span class="muted">{{ pageLabel(h.total) }}</span>
            <button type="button" class="linkish" [disabled]="offset() === 0" (click)="page(-1)">
              ‹ Newer
            </button>
            <button
              type="button"
              class="linkish"
              [disabled]="offset() + pageSize >= h.total"
              (click)="page(1)"
            >
              Older ›
            </button>
          }
        </div>

        @if (history.error() && !history.value()) {
          <p class="muted small">Could not load past views.</p>
        } @else if (history.value(); as h) {
          @if (h.views.length === 0) {
            <p class="muted small">No past views match.</p>
          } @else {
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Market</th>
                    <th>View</th>
                    <th>Why it looked</th>
                    <th>Scored</th>
                    <th class="num">Moved</th>
                    <th>Baseline</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (v of h.views; track v.id) {
                    <tr>
                      <td
                        class="nowrap"
                        [title]="'Scored at ' + (v.horizonUtc | date: 'dd MMM HH:mm')"
                      >
                        {{ v.createdAtUtc | date: 'dd MMM HH:mm' }}
                      </td>
                      <td class="mono nowrap">{{ v.symbol }} {{ v.timeframe }}</td>
                      <td class="nowrap">
                        <span
                          class="lean-pill"
                          [class.buy]="v.lean === 'Buy'"
                          [class.sell]="v.lean === 'Sell'"
                          [title]="v.narrative"
                          >{{ v.lean === 'None' ? 'no view' : v.lean }}
                          @if (v.lean !== 'None') {
                            · {{ v.confidence | number: '1.2-2' }}
                          }
                        </span>
                      </td>
                      <td class="muted">{{ v.trigger }}</td>
                      <td class="nowrap">
                        <span [class]="verdictClass(v.verdict)">{{ verdictWords(v.verdict) }}</span>
                      </td>
                      <td class="num">
                        {{ v.movedPips !== null ? (v.movedPips | number: '1.1-1') + ' pips' : '—' }}
                      </td>
                      <td class="nowrap">
                        @if (v.baseline) {
                          <span class="muted">{{ v.baseline }}: </span>
                        }
                        <span [class]="verdictClass(v.baselineVerdict)">{{
                          verdictWords(v.baselineVerdict)
                        }}</span>
                      </td>
                      <td>
                        @if (v.llmInvocationId; as cid) {
                          <a
                            class="thread-link"
                            [routerLink]="['/conversations']"
                            [queryParams]="{ conversation: cid }"
                            title="Open the conversation behind this view"
                            aria-label="Open the conversation behind this view"
                            >💬</a
                          >
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        } @else {
          <p class="muted small">Loading…</p>
        }
      }
    </section>
  `,
  styleUrls: ['../pt-common.css'],
  styles: [
    `
      .view {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .view.open {
        background: var(--bg-secondary);
      }
      .view header {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .view-toggle {
        flex: 1;
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        min-width: 0;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        padding: 0;
        text-align: left;
        cursor: pointer;
      }
      .view-toggle:hover {
        opacity: 0.85;
      }
      .lean-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .lean-pill.buy {
        background: rgba(52, 199, 89, 0.16);
        color: var(--profit, #15803d);
      }
      .lean-pill.sell {
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss, #b91c1c);
      }
      .narrative {
        font-size: var(--text-sm);
        line-height: 1.5;
      }
      .clamp-2 {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        color: var(--text-secondary);
      }
      .scroll-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        max-height: 620px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding-right: 4px;
      }
      .chev {
        color: var(--text-secondary);
        font-size: 11px;
      }
      .scenarios {
        margin: 0;
        padding-left: var(--space-4);
        font-size: var(--text-xs);
        line-height: 1.5;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .scenarios .tag {
        margin: 0 4px;
      }
      .level {
        font-weight: var(--font-semibold);
      }
      .table-wrap {
        max-height: 520px;
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
        padding: 5px 8px;
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
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .nowrap {
        white-space: nowrap;
      }
    `,
  ],
})
export class PtViewsPanelComponent {
  private readonly svc = inject(PatientTraderService);

  /** The standing view per market (from the board). */
  readonly views = input<PatientTraderView[]>([]);
  /** Markets offered in the history filter. */
  readonly symbols = input<string[]>([]);

  protected readonly tab = signal<'current' | 'history'>('current');
  private readonly open = signal<ReadonlySet<number>>(new Set());

  protected readonly pageSize = 50;
  protected readonly offset = signal(0);
  protected readonly lean = signal('');
  protected readonly symbol = signal('');

  protected readonly history = createPolledResource(
    () =>
      this.svc.getViewHistory({
        symbol: this.symbol() || null,
        lean: this.lean() || null,
        limit: this.pageSize,
        offset: this.offset(),
      }),
    {
      intervalMs: 600_000,
      active: computed(() => this.tab() === 'history'),
      runImmediately: false,
      key: () => [this.symbol(), this.lean(), this.offset()],
    },
  );

  /** Scenario rows per view id, parsed once per board rather than on every change detection. */
  private readonly scenarioCache = computed(() => {
    const map = new Map<number, ScenarioRow[]>();
    for (const v of this.views()) map.set(v.id, scenarioRows(v.scenariosJson));
    return map;
  });

  protected scenariosOf(v: PatientTraderView): ScenarioRow[] {
    return this.scenarioCache().get(v.id) ?? [];
  }

  protected isOpen(id: number): boolean {
    return this.open().has(id);
  }

  protected toggle(id: number): void {
    this.open.update((s) => toggled(s, id));
  }

  protected setTab(t: 'current' | 'history'): void {
    if (t === this.tab()) return;
    this.tab.set(t);
    if (t === 'history') this.history.refresh();
  }

  protected setLean(v: string): void {
    this.lean.set(v ?? '');
    this.offset.set(0);
    this.history.refresh();
  }

  protected setSymbol(v: string): void {
    this.symbol.set(v ?? '');
    this.offset.set(0);
    this.history.refresh();
  }

  protected page(dir: 1 | -1): void {
    this.offset.set(Math.max(0, this.offset() + dir * this.pageSize));
    this.history.refresh();
  }

  protected pageLabel(total: number): string {
    if (total === 0) return '0 views';
    const from = this.offset() + 1;
    const to = Math.min(total, this.offset() + this.pageSize);
    return `${from}–${to} of ${total}`;
  }

  protected ago(minutes: number): string {
    if (!(minutes >= 0)) return '';
    if (minutes < 60) return `${Math.round(minutes)}m ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
  }

  protected dirWords(d: string): string {
    return d === 'Up' ? 'up' : d === 'Down' ? 'down' : d === 'Flat' ? 'flat' : d;
  }

  protected verdictWords(v: string | null): string {
    switch (v) {
      case 'Correct':
        return 'right';
      case 'Wrong':
        return 'wrong';
      case 'Flat':
        return 'flat';
      case 'Abstained':
        return 'no view';
      case null:
      case undefined:
      case '':
        return 'not yet';
      default:
        return v.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    }
  }

  protected verdictClass(v: string | null): string {
    return v === 'Correct' ? 'pos' : v === 'Wrong' ? 'neg' : 'muted';
  }
}
