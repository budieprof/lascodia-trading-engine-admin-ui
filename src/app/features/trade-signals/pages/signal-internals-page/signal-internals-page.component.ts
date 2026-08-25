import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  SignalInternalsService,
  type SignalAccountReadinessDto,
  type SignalPipelineOverviewDto,
  type SignalPipelineSignalDto,
} from '@core/services/signal-internals.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

/**
 * Full visibility into the signal module.
 *
 * The Signals page answers "what signals exist". This one answers "why did nothing happen" —
 * the question that previously needed a psql session across TradeSignal, SignalAccountAttempt,
 * Order, DrawdownSnapshot and EAInstance.
 *
 * The load-bearing element is the per-signal ACCOUNT MATRIX. A signal row on its own cannot
 * distinguish "no account wanted it" from "every account was blocked by the same gate" — and
 * those call for opposite responses. The matrix shows each account's disposition side by side,
 * so a single blocked account among four fills reads as an account problem at a glance, which
 * is exactly the shape of the account-24 case this was built from.
 */
@Component({
  selector: 'app-signal-internals-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    DecimalPipe,
    DatePipe,
    PageHeaderComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
  ],
  template: `
    <app-page-header
      title="Signal Internals"
      subtitle="Every signal, what each account did with it, and exactly what stopped the rest."
    />

    <section class="controls">
      <label>
        Window
        <select [ngModel]="windowHours()" (ngModelChange)="setWindow($event)">
          <option [value]="6">6 hours</option>
          <option [value]="24">24 hours</option>
          <option [value]="72">3 days</option>
          <option [value]="168">7 days</option>
        </select>
      </label>
      <label>
        Symbol
        <input
          type="text"
          placeholder="all"
          [ngModel]="symbolFilter()"
          (ngModelChange)="setSymbol($event)"
        />
      </label>
      <button class="refresh" (click)="reload()" [disabled]="loading()">Refresh</button>
      @if (view(); as v) {
        <span class="as-of">as of {{ v.generatedAtUtc | date: 'HH:mm:ss' }} UTC</span>
      }
    </section>

    @if (loading()) {
      <app-card-skeleton />
    } @else if (error(); as e) {
      <app-empty-state title="Could not load signal state" [description]="e" />
    } @else if (view(); as v) {
      <!--
        Blocked accounts first, unconditionally. A blanket account gate is the single most
        common cause of "no signals" and the least visible: it produces no error, no alert,
        and a signal table that looks entirely normal.
      -->
      @if (blockedAccounts().length > 0) {
        <section class="blockers">
          <h2>{{ blockedAccounts().length }} account(s) cannot act on ANY signal</h2>
          @for (a of blockedAccounts(); track a.tradingAccountId) {
            <article class="blocker">
              <header>
                <span class="acct">{{ a.accountName }}</span>
                <span class="acct-num">#{{ a.tradingAccountId }} · {{ a.accountNumber }}</span>
                <span class="blocker-badge">{{ a.blockingCondition }}</span>
              </header>
              <p class="detail">{{ a.blockingDetail }}</p>
              @if (a.blockingRemedy) {
                <p class="remedy"><b>How to clear it:</b> {{ a.blockingRemedy }}</p>
              }
              @if (a.recoveryMode === 'Halted') {
                <dl class="dd">
                  <div>
                    <dt>Equity</dt>
                    <dd>{{ a.equity | number: '1.2-2' }}</dd>
                  </div>
                  <div>
                    <dt>Anchor peak</dt>
                    <dd>{{ a.peakEquity | number: '1.2-2' }}</dd>
                  </div>
                  <div>
                    <dt>Drawdown</dt>
                    <dd class="neg">{{ a.drawdownPct | number: '1.2-2' }}%</dd>
                  </div>
                </dl>
              }
            </article>
          }
        </section>
      }

      <!-- The funnel. Each stage names what dropping there MEANS, not just how many. -->
      <section class="funnel">
        <h2>Pipeline · last {{ v.windowHours }}h</h2>
        <div class="stages">
          @for (f of v.funnel; track f.stage) {
            <div class="stage" [class.has-drop]="f.dropped > 0">
              <span class="stage-label">{{ f.label }}</span>
              <span class="stage-entered">{{ f.entered }}</span>
              @if (f.dropped > 0) {
                <span class="stage-dropped">−{{ f.dropped }} stopped here</span>
              }
              <span class="stage-why">{{ f.explanation }}</span>
            </div>
          }
        </div>
      </section>

      <!-- Why signals were refused, ranked. -->
      @if (v.topBlockReasons.length > 0) {
        <section class="reasons">
          <h2>Tier-2 refusals by reason</h2>
          <table>
            <thead>
              <tr>
                <th>Reason</th>
                <th class="num">Count</th>
                <th>Most recent</th>
              </tr>
            </thead>
            <tbody>
              @for (r of v.topBlockReasons; track r.reason) {
                <tr>
                  <td>{{ r.reason }}</td>
                  <td class="num">{{ r.count }}</td>
                  <td class="muted">{{ r.latestAtUtc | date: 'MMM d HH:mm' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }

      @if (v.generationRejections.length > 0) {
        <section class="reasons">
          <h2>Never became signals</h2>
          <p class="section-note">
            Generation-stage rejections. These never reach the signal table at all, so they are
            invisible everywhere else.
          </p>
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Reason</th>
                <th class="num">Count</th>
              </tr>
            </thead>
            <tbody>
              @for (g of v.generationRejections; track g.stage) {
                @for (r of g.reasons; track r.reason) {
                  <tr>
                    <td>{{ g.stage }}</td>
                    <td>{{ r.reason }}</td>
                    <td class="num">{{ r.count }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </section>
      }

      <!-- Per-account readiness. -->
      <section class="accounts">
        <h2>Account readiness</h2>
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Recovery</th>
              <th>Symbols polled</th>
              <th>EA</th>
              <th class="num">Attempts</th>
              <th class="num">Passed</th>
              <th class="num">Blocked</th>
              <th>Last pass</th>
            </tr>
          </thead>
          <tbody>
            @for (a of v.accounts; track a.tradingAccountId) {
              <tr [class.row-blocked]="a.blockingCondition">
                <td>
                  <b>{{ a.accountName }}</b>
                  <span class="muted"> #{{ a.tradingAccountId }}</span>
                </td>
                <td>
                  <span class="mode" [attr.data-mode]="a.recoveryMode">{{ a.recoveryMode }}</span>
                  @if (a.drawdownPct !== null) {
                    <span class="muted"> {{ a.drawdownPct | number: '1.1-1' }}%</span>
                  }
                </td>
                <td class="mono">
                  {{ a.polledSymbols.length ? a.polledSymbols.join(', ') : '—' }}
                </td>
                <td>
                  @for (i of a.instances; track i.instanceId) {
                    <div class="ea" [class.ea-down]="!i.isPolling" [title]="i.instanceId">
                      {{ i.isPolling ? '● polling' : '○ ' + i.status }}
                      <span class="muted">v{{ i.eaVersion }}</span>
                      @if (i.notPollingReason) {
                        <span class="ea-why">{{ i.notPollingReason }}</span>
                      }
                    </div>
                  } @empty {
                    <span class="muted">no instance</span>
                  }
                </td>
                <td class="num">{{ a.attempts }}</td>
                <td class="num pos">{{ a.attemptsPassed }}</td>
                <td class="num" [class.neg]="a.attemptsBlocked > 0">{{ a.attemptsBlocked }}</td>
                <td class="muted">
                  {{ a.lastPassedAtUtc ? (a.lastPassedAtUtc | date: 'MMM d HH:mm') : 'never' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </section>

      <!-- The matrix. -->
      <section class="signals">
        <h2>Signals · {{ v.signals.length }} shown, {{ v.liveSignalCount }} still live</h2>
        @if (v.signals.length === 0) {
          <app-empty-state
            title="No signals in this window"
            description="Nothing was generated. Check the generation-stage rejections above."
          />
        }
        @for (s of v.signals; track s.signalId) {
          <article class="signal" [class.live]="s.isLive">
            <header
              role="button"
              tabindex="0"
              [attr.aria-expanded]="expanded().has(s.signalId)"
              (click)="toggle(s.signalId)"
              (keydown.enter)="toggle(s.signalId)"
              (keydown.space)="toggle(s.signalId)"
            >
              <span class="sig-id">#{{ s.signalId }}</span>
              <span class="sym">{{ s.symbol }}</span>
              <span class="dir" [attr.data-dir]="s.direction">{{ s.direction }}</span>
              <span class="status" [attr.data-status]="s.status">{{ s.status }}</span>
              @if (s.isLive && s.minutesToExpiry !== null) {
                <span class="ttl">{{ s.minutesToExpiry | number: '1.0-0' }}m left</span>
              }
              <span class="tally">
                <span class="pos">{{ s.accountsFilled }} filled</span>
                @if (s.accountsBlocked > 0) {
                  <span class="neg">{{ s.accountsBlocked }} blocked</span>
                }
                @if (s.accountsUntouched > 0) {
                  <span class="muted">{{ s.accountsUntouched }} untouched</span>
                }
              </span>
              <span class="chev">{{ expanded().has(s.signalId) ? '▾' : '▸' }}</span>
            </header>

            @if (s.rejectionReason) {
              <p class="sig-reject">{{ s.rejectionReason }}</p>
            }

            @if (expanded().has(s.signalId)) {
              <div class="matrix">
                <div class="sig-meta">
                  <span>{{ s.source }}</span>
                  <span>generated {{ s.generatedAtUtc | date: 'MMM d HH:mm' }}</span>
                  @if (s.expiresAtUtc) {
                    <span>expires {{ s.expiresAtUtc | date: 'MMM d HH:mm' }}</span>
                  }
                  @if (s.llmInvocationId) {
                    <a [routerLink]="['/conversations', s.llmInvocationId]">rationale →</a>
                  }
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Outcome</th>
                      <th>Why</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (a of s.accounts; track a.tradingAccountId) {
                      <tr>
                        <td>{{ a.accountName }}</td>
                        <td>
                          <span class="disp" [attr.data-disp]="a.disposition">{{
                            a.disposition
                          }}</span>
                        </td>
                        <td>
                          {{ a.explanation }}
                          @if (a.blockReason) {
                            <div class="block-reason">{{ a.blockReason }}</div>
                          }
                          @if (a.retryPossible && a.retryEligibleAtUtc) {
                            <div class="retry">
                              retries after {{ a.retryEligibleAtUtc | date: 'HH:mm:ss' }} UTC
                            </div>
                          }
                        </td>
                        <td class="muted">{{ a.atUtc ? (a.atUtc | date: 'HH:mm:ss') : '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </article>
        }
      </section>

      <!-- The contract, stated. -->
      <section class="rules">
        <h2>Serving rules</h2>
        <p class="section-note">
          A signal is offered to an account's EA only when ALL of these hold. Without them stated, a
          correct exclusion is indistinguishable from a bug.
        </p>
        <ul>
          @for (c of v.rules.servingCriteria; track c) {
            <li>{{ c }}</li>
          }
        </ul>
        <p class="rule-note">
          <b>since parameter:</b>
          {{ v.rules.sinceParameterBehaviour }}
        </p>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      h2 {
        font-size: 0.95rem;
        margin: 1.5rem 0 0.5rem;
      }
      .section-note {
        margin: 0 0 0.6rem;
        font-size: 0.8rem;
        opacity: 0.75;
      }
      .controls {
        display: flex;
        gap: 1rem;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 1rem;
      }
      .controls label {
        display: flex;
        gap: 0.4rem;
        align-items: center;
        font-size: 0.85rem;
      }
      .controls input,
      .controls select {
        padding: 0.3rem 0.5rem;
      }
      .as-of {
        font-size: 0.78rem;
        opacity: 0.7;
      }

      .blockers {
        border: 1px solid var(--color-danger, #c0392b);
        border-radius: 8px;
        padding: 0.9rem 1rem;
        margin-bottom: 1rem;
      }
      .blockers h2 {
        margin-top: 0;
        color: var(--color-danger, #c0392b);
      }
      .blocker {
        padding: 0.6rem 0;
        border-top: 1px solid rgba(128, 128, 128, 0.25);
      }
      .blocker:first-of-type {
        border-top: none;
      }
      .blocker header {
        display: flex;
        gap: 0.6rem;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .acct {
        font-weight: 600;
      }
      .acct-num,
      .muted {
        opacity: 0.65;
        font-size: 0.8rem;
      }
      .blocker-badge {
        background: var(--color-danger, #c0392b);
        color: #fff;
        border-radius: 4px;
        padding: 0.1rem 0.45rem;
        font-size: 0.75rem;
      }
      .detail,
      .remedy {
        margin: 0.35rem 0 0;
        font-size: 0.85rem;
      }
      .dd {
        display: flex;
        gap: 1.5rem;
        margin: 0.5rem 0 0;
      }
      .dd dt {
        font-size: 0.72rem;
        opacity: 0.7;
      }
      .dd dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
      }

      .stages {
        display: flex;
        gap: 0.6rem;
        flex-wrap: wrap;
      }
      .stage {
        flex: 1 1 180px;
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 6px;
        padding: 0.6rem;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }
      .stage-label {
        font-size: 0.75rem;
        text-transform: uppercase;
        opacity: 0.7;
      }
      .stage-entered {
        font-size: 1.4rem;
        font-variant-numeric: tabular-nums;
      }
      .stage-dropped {
        font-size: 0.78rem;
        color: var(--color-danger, #c0392b);
      }
      .stage-why {
        font-size: 0.72rem;
        opacity: 0.72;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.84rem;
      }
      th,
      td {
        text-align: left;
        padding: 0.35rem 0.5rem;
        border-bottom: 1px solid rgba(128, 128, 128, 0.18);
        vertical-align: top;
      }
      th.num,
      td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: ui-monospace, monospace;
        font-size: 0.78rem;
      }
      .row-blocked {
        background: rgba(192, 57, 43, 0.08);
      }

      .mode[data-mode='Halted'] {
        color: var(--color-danger, #c0392b);
        font-weight: 600;
      }
      .mode[data-mode='Reduced'] {
        color: var(--color-warning, #d68910);
      }

      .ea {
        font-size: 0.78rem;
      }
      .ea-down {
        color: var(--color-danger, #c0392b);
      }
      .ea-why {
        display: block;
        opacity: 0.75;
        font-size: 0.72rem;
      }

      .signal {
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 6px;
        margin-bottom: 0.5rem;
      }
      .signal.live {
        border-left: 3px solid var(--color-success, #1e8449);
      }
      .signal header {
        display: flex;
        gap: 0.7rem;
        align-items: center;
        padding: 0.5rem 0.7rem;
        cursor: pointer;
        flex-wrap: wrap;
      }
      .sig-id {
        font-family: ui-monospace, monospace;
        opacity: 0.7;
      }
      .sym {
        font-weight: 600;
      }
      .dir[data-dir='Sell'] {
        color: var(--color-danger, #c0392b);
      }
      .dir[data-dir='Buy'] {
        color: var(--color-success, #1e8449);
      }
      .ttl {
        font-size: 0.75rem;
        opacity: 0.75;
      }
      .tally {
        margin-left: auto;
        display: flex;
        gap: 0.6rem;
        font-size: 0.78rem;
      }
      .chev {
        opacity: 0.6;
      }
      .sig-reject {
        margin: 0;
        padding: 0 0.7rem 0.5rem;
        font-size: 0.8rem;
        color: var(--color-warning, #d68910);
      }
      .matrix {
        padding: 0 0.7rem 0.7rem;
      }
      .sig-meta {
        display: flex;
        gap: 1rem;
        font-size: 0.75rem;
        opacity: 0.75;
        padding: 0.3rem 0;
        flex-wrap: wrap;
      }
      .disp {
        border-radius: 4px;
        padding: 0.1rem 0.4rem;
        font-size: 0.75rem;
      }
      .disp[data-disp='Filled'] {
        background: rgba(30, 132, 73, 0.18);
      }
      .disp[data-disp='Blocked'] {
        background: rgba(192, 57, 43, 0.18);
      }
      .disp[data-disp='NotAttempted'],
      .disp[data-disp='NotServed'] {
        background: rgba(128, 128, 128, 0.18);
      }
      .block-reason {
        font-family: ui-monospace, monospace;
        font-size: 0.74rem;
        opacity: 0.85;
        margin-top: 0.2rem;
      }
      .retry {
        font-size: 0.72rem;
        opacity: 0.7;
        margin-top: 0.15rem;
      }

      .rules ul {
        margin: 0.3rem 0;
        padding-left: 1.1rem;
        font-size: 0.84rem;
      }
      .rule-note {
        font-size: 0.8rem;
        opacity: 0.8;
      }

      .pos {
        color: var(--color-success, #1e8449);
      }
      .neg {
        color: var(--color-danger, #c0392b);
      }
    `,
  ],
})
export class SignalInternalsPageComponent {
  private readonly service = inject(SignalInternalsService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly view = signal<SignalPipelineOverviewDto | null>(null);

  readonly windowHours = signal(24);
  readonly symbolFilter = signal('');
  readonly expanded = signal<Set<number>>(new Set());

  /** Accounts that cannot act on ANY signal — surfaced above everything else. */
  readonly blockedAccounts = computed<SignalAccountReadinessDto[]>(
    () => this.view()?.accounts.filter((a) => a.blockingCondition) ?? [],
  );

  constructor() {
    this.reload();
  }

  setWindow(hours: number | string): void {
    this.windowHours.set(Number(hours));
    this.reload();
  }

  setSymbol(symbol: string): void {
    this.symbolFilter.set(symbol);
    this.reload();
  }

  toggle(signalId: number): void {
    const next = new Set(this.expanded());
    if (next.has(signalId)) next.delete(signalId);
    else next.add(signalId);
    this.expanded.set(next);
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service
      .getOverview({
        windowHours: this.windowHours(),
        symbol: this.symbolFilter().trim() || null,
      })
      .subscribe({
        next: (data) => {
          this.view.set(data);
          // Auto-open any live signal that is not fully filled — if something is
          // still actionable and something stopped it, that is the row worth reading.
          const interesting = data.signals
            .filter((s: SignalPipelineSignalDto) => s.isLive && s.accountsBlocked > 0)
            .map((s: SignalPipelineSignalDto) => s.signalId);
          if (interesting.length > 0) this.expanded.set(new Set(interesting));
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(err?.message ?? 'Request failed.');
          this.loading.set(false);
        },
      });
  }
}
