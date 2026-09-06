import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  SignalInternalsService,
  type SignalAccountReadinessDto,
  type SignalEaInstanceDto,
  type SignalPipelineOverviewDto,
  type SignalPipelineSignalDto,
} from '@core/services/signal-internals.service';

/** Blocked accounts collapsed by the cause they share. */
interface BlockedGroup {
  key: string;
  condition: string;
  detail: string;
  remedy: string;
  accounts: SignalAccountReadinessDto[];
}

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';

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
    ErrorStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Signal Internals"
        subtitle="Every signal, what each account did with it, and exactly what stopped the rest."
      >
        <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'Refreshing…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="controls filter-bar">
        <label class="field">
          <span class="field-label">Window</span>
          <select class="input" [ngModel]="windowHours()" (ngModelChange)="setWindow($event)">
            <option [value]="6">6 hours</option>
            <option [value]="24">24 hours</option>
            <option [value]="72">3 days</option>
            <option [value]="168">7 days</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">Symbol</span>
          <input
            class="input"
            type="search"
            placeholder="All symbols"
            [ngModel]="symbolFilter()"
            (ngModelChange)="setSymbol($event)"
          />
        </label>
        @if (view(); as v) {
          <span class="as-of">as of {{ v.generatedAtUtc | date: 'MMM d, HH:mm:ss' }} UTC</span>
        }
      </section>

      @if (loading()) {
        <app-card-skeleton />
      } @else if (error(); as e) {
        <app-error-state title="Could not load signal state" [message]="e" (retry)="reload()" />
      } @else if (view(); as v) {
        <!--
        Blocked accounts first, unconditionally. A blanket account gate is the single most
        common cause of "no signals" and the least visible: it produces no error, no alert,
        and a signal table that looks entirely normal.
      -->
        @if (blockedAccounts().length > 0) {
          <section class="blockers">
            <h2>{{ blockedAccounts().length }} account(s) cannot act on ANY signal</h2>
            <!--
            Grouped by CAUSE, not listed per account. Every account sharing a
            cause also shares its detail and remedy verbatim, so the per-account
            layout printed the same two sentences once per account — 7 accounts
            filled the viewport with 14 lines of identical prose and pushed the
            signals (the subject of this page) entirely below the fold.
            One block per cause, accounts as chips, and the reader can see both
            the problem and the page.
          -->
            @for (g of blockedGroups(); track g.key) {
              <article class="blocker">
                <header>
                  <span class="blocker-badge">{{ g.condition }}</span>
                  <span class="acct-num">{{ g.accounts.length }} account(s)</span>
                </header>
                <p class="detail">{{ g.detail }}</p>
                @if (g.remedy) {
                  <p class="remedy"><b>How to clear it:</b> {{ g.remedy }}</p>
                }
                <div class="chips">
                  @for (a of g.accounts; track a.tradingAccountId) {
                    <span class="chip" [title]="'#' + a.tradingAccountId + ' · ' + a.accountNumber">
                      {{ a.accountName }}
                      <span class="muted">#{{ a.tradingAccountId }}</span>
                    </span>
                  }
                </div>
                <!-- Per-account figures only where they carry information:
                   one compact table for the halted accounts, not a loose
                   dl per account floating under the chips. -->
                @if (haltedAccounts(g).length > 0) {
                  <table class="halted">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th class="num">Equity</th>
                        <th class="num">Anchor peak</th>
                        <th class="num">Drawdown</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (a of haltedAccounts(g); track a.tradingAccountId) {
                        <tr>
                          <td>
                            {{ a.accountName }} <span class="muted">#{{ a.tradingAccountId }}</span>
                          </td>
                          <td class="num">{{ a.equity | number: '1.2-2' }}</td>
                          <td class="num">{{ a.peakEquity | number: '1.2-2' }}</td>
                          <td class="num neg">{{ a.drawdownPct | number: '1.2-2' }}%</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </article>
            }
          </section>
        }

        <!-- The funnel. Each stage names what dropping there MEANS, not just how many. -->
        <section class="funnel card">
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
          <section class="reasons card">
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
                    <td class="muted">{{ r.latestAtUtc | date: 'MMM d, HH:mm' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        @if (v.generationRejections.length > 0) {
          <section class="reasons card">
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
        <section class="accounts card">
          <h2>Account readiness</h2>
          <div class="table-scroll">
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
                      <span class="mode" [attr.data-mode]="a.recoveryMode">{{
                        a.recoveryMode
                      }}</span>
                      @if (a.drawdownPct !== null) {
                        <span class="muted"> {{ a.drawdownPct | number: '1.1-1' }}%</span>
                      }
                    </td>
                    <td class="mono">
                      {{ a.polledSymbols.length ? a.polledSymbols.join(', ') : '—' }}
                    </td>
                    <!--
                  Live instances in full; dead ones folded away.

                  An EA re-derives its instanceId at OnInit from its owned-symbol
                  set, so every restart leaves the previous registration behind as
                  a Disconnected row — they accumulate forever. Account #5 has 34,
                  and rendering each with its notPollingReason produced 68 lines of
                  identical text in ONE table cell, about 1,900px tall. The reason
                  is the same sentence for all of them, so it is stated once on the
                  summary; the roster stays reachable behind a disclosure for
                  anyone who needs the versions or ids.
                -->
                    <td>
                      @for (i of pollingInstances(a); track i.instanceId) {
                        <div class="ea" [title]="i.instanceId">
                          ● polling
                          <span class="muted">v{{ i.eaVersion }}</span>
                        </div>
                      }
                      @if (downInstances(a).length > 0) {
                        <details class="ea-dead">
                          <summary class="ea-down">
                            {{ downInstances(a).length }} disconnected
                            <span class="muted">· newest v{{ newestDownVersion(a) }}</span>
                          </summary>
                          @for (why of distinctDownReasons(a); track why) {
                            <span class="ea-why">{{ why }}</span>
                          }
                          @for (i of downInstances(a); track i.instanceId) {
                            <div class="ea ea-down" [title]="i.instanceId">
                              ○ {{ i.status }}
                              <span class="muted">v{{ i.eaVersion }}</span>
                            </div>
                          }
                        </details>
                      }
                      @if (a.instances.length === 0) {
                        <span class="muted">no instance</span>
                      }
                    </td>
                    <td class="num">{{ a.attempts }}</td>
                    <td class="num" [class.pos]="a.attemptsPassed > 0">{{ a.attemptsPassed }}</td>
                    <td class="num" [class.neg]="a.attemptsBlocked > 0">{{ a.attemptsBlocked }}</td>
                    <td class="muted">
                      {{ a.lastPassedAtUtc ? (a.lastPassedAtUtc | date: 'MMM d, HH:mm') : 'never' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- The matrix. -->
        <section class="signals card">
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
                <a
                  class="sig-id"
                  [routerLink]="['/trade-signals', s.signalId]"
                  (click)="$event.stopPropagation()"
                  >#{{ s.signalId }}</a
                >
                <span class="sym">{{ s.symbol }}</span>
                <span class="dir" [attr.data-dir]="s.direction">{{ s.direction }}</span>
                <span class="status" [attr.data-status]="s.status">{{ s.status }}</span>
                @if (s.isLive && s.minutesToExpiry !== null) {
                  <span class="ttl">{{ s.minutesToExpiry | number: '1.0-0' }}m left</span>
                }
                <span class="tally">
                  <span [class.pos]="s.accountsFilled > 0" [class.muted]="s.accountsFilled === 0"
                    >{{ s.accountsFilled }} filled</span
                  >
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
                    <span>generated {{ s.generatedAtUtc | date: 'MMM d, HH:mm' }}</span>
                    @if (s.expiresAtUtc) {
                      <span>expires {{ s.expiresAtUtc | date: 'MMM d, HH:mm' }}</span>
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
        <section class="rules card">
          <h2>Serving rules</h2>
          <p class="section-note">
            A signal is offered to an account's EA only when ALL of these hold. Without them stated,
            a correct exclusion is indistinguishable from a bug.
          </p>
          <ol class="rule-list">
            @for (c of v.rules.servingCriteria; track c; let i = $index) {
              <li>
                <span class="rule-idx">{{ i + 1 }}</span>
                <span>{{ c }}</span>
              </li>
            }
          </ol>
          <p class="rule-note">
            <b>Poll cursor (<code>since</code>):</b>
            {{ v.rules.sinceParameterBehaviour }}
          </p>
        </section>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      h2 {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-2);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .section-note {
        margin: 0 0 var(--space-3);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .controls {
        display: flex;
        gap: var(--space-4);
        align-items: flex-end;
        flex-wrap: wrap;
        padding: var(--space-3) var(--space-4);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .field-label {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .input {
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        min-width: 160px;
      }
      .input:focus {
        outline: none;
        border-color: var(--accent);
      }
      .as-of {
        margin-left: auto;
        align-self: center;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }

      .blockers {
        border: 1px solid rgba(255, 59, 48, 0.4);
        border-left: 3px solid var(--loss);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        background: var(--bg-secondary);
      }
      .blockers h2 {
        color: var(--loss);
      }
      .blocker {
        padding: var(--space-3) 0;
        border-top: 1px solid var(--border);
      }
      .blocker:first-of-type {
        border-top: none;
        padding-top: 0;
      }
      .blocker:last-of-type {
        padding-bottom: 0;
      }
      .blocker header {
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
        flex-wrap: wrap;
      }
      .acct-num,
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .blocker-badge {
        background: var(--loss);
        color: #fff;
        border-radius: var(--radius-sm);
        padding: 2px 8px;
        font-size: 11px;
        font-weight: var(--font-semibold);
      }
      .detail,
      .remedy {
        margin: var(--space-2) 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .remedy {
        color: var(--text-secondary);
      }
      .halted {
        margin-top: var(--space-3);
        width: auto;
        min-width: 480px;
      }

      .stages {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-2);
        align-items: start;
      }
      .stage {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: 2px;
        background: var(--bg-primary);
      }
      .stage.has-drop {
        border-color: rgba(255, 59, 48, 0.4);
      }
      .stage-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
      }
      .stage-entered {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .stage-dropped {
        font-size: var(--text-xs);
        color: var(--loss);
        font-weight: var(--font-medium);
      }
      .stage-why {
        font-size: 11px;
        color: var(--text-tertiary);
      }

      .table-scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      th,
      td {
        text-align: left;
        padding: var(--space-2);
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
        white-space: nowrap;
      }
      tbody tr:last-child td {
        border-bottom: none;
      }
      th.num,
      td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .row-blocked {
        background: rgba(255, 59, 48, 0.06);
      }

      .mode {
        font-weight: var(--font-medium);
      }
      .mode[data-mode='Halted'] {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }
      .mode[data-mode='Reduced'] {
        color: var(--warning);
      }

      .ea {
        font-size: var(--text-xs);
        white-space: nowrap;
      }
      .ea-down {
        color: var(--loss);
      }
      .ea-why {
        display: block;
        color: var(--text-tertiary);
        font-size: 11px;
      }
      .ea-dead > summary {
        cursor: pointer;
        font-size: var(--text-xs);
        list-style-position: outside;
      }
      /* Keep the expanded roster from re-inflating the row height. */
      .ea-dead[open] {
        max-height: 12rem;
        overflow-y: auto;
      }

      /* Affected accounts read as a compact set, not as repeated paragraphs. */
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);
        margin-top: var(--space-2);
      }
      .chip {
        border: 1px solid var(--border);
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        padding: 2px 10px;
        font-size: var(--text-xs);
        white-space: nowrap;
        color: var(--text-primary);
      }

      .signal {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        margin-bottom: var(--space-2);
        background: var(--bg-primary);
      }
      .signal.live {
        border-left: 3px solid var(--profit);
      }
      .signal header {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        padding: var(--space-2) var(--space-3);
        cursor: pointer;
        flex-wrap: wrap;
      }
      .sig-id {
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--accent);
        text-decoration: none;
        font-size: var(--text-xs);
      }
      .sig-id:hover {
        text-decoration: underline;
      }
      .sym {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .dir,
      .status,
      .ttl {
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .dir[data-dir='Sell'] {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .dir[data-dir='Buy'] {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .status[data-status='Pending'],
      .status[data-status='Approved'] {
        background: rgba(255, 149, 0, 0.15);
        color: var(--warning);
      }
      .status[data-status='Executed'] {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .status[data-status='Rejected'] {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .tally {
        margin-left: auto;
        display: flex;
        gap: var(--space-3);
        font-size: var(--text-xs);
      }
      .chev {
        color: var(--text-tertiary);
      }
      .sig-reject {
        margin: 0;
        padding: 0 var(--space-3) var(--space-2);
        font-size: var(--text-xs);
        color: var(--warning);
      }
      .matrix {
        padding: 0 var(--space-3) var(--space-3);
      }
      .sig-meta {
        display: flex;
        gap: var(--space-3);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        padding: var(--space-1) 0 var(--space-2);
        flex-wrap: wrap;
      }
      .sig-meta a {
        color: var(--accent);
        text-decoration: none;
      }
      .disp {
        border-radius: var(--radius-sm);
        padding: 2px 8px;
        font-size: 11px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .disp[data-disp='Filled'] {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .disp[data-disp='Blocked'] {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .block-reason {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        color: var(--text-secondary);
        margin-top: 2px;
        overflow-wrap: anywhere;
      }
      .retry {
        font-size: 11px;
        color: var(--text-tertiary);
        margin-top: 2px;
      }

      .rule-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .rule-list li {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
        font-size: var(--text-sm);
        color: var(--text-primary);
        padding: var(--space-2) var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .rule-idx {
        flex-shrink: 0;
        width: 22px;
        height: 22px;
        border-radius: var(--radius-full);
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
        font-size: 11px;
        font-weight: var(--font-semibold);
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .rule-note {
        margin: var(--space-3) 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .rule-note code {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }

      .pos {
        color: var(--profit);
      }
      .neg {
        color: var(--loss);
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

  /**
   * Blocked accounts collapsed by cause.
   *
   * The detail and remedy are properties of the CONDITION, not of the account,
   * so a per-account list repeats them verbatim once per account. Grouping keeps
   * every fact on screen while spending one block per distinct cause.
   */
  readonly blockedGroups = computed<BlockedGroup[]>(() => {
    const groups = new Map<string, BlockedGroup>();
    for (const a of this.blockedAccounts()) {
      const condition = a.blockingCondition ?? '';
      const detail = a.blockingDetail ?? '';
      const remedy = a.blockingRemedy ?? '';
      const key = `${condition} ${detail} ${remedy}`;
      const existing = groups.get(key);
      if (existing) {
        existing.accounts.push(a);
      } else {
        groups.set(key, { key, condition, detail, remedy, accounts: [a] });
      }
    }
    // Biggest group first — the widest-reaching cause is the one to fix first.
    return [...groups.values()].sort((x, y) => y.accounts.length - x.accounts.length);
  });

  /** Halted accounts within a blocked-cause group — the only ones whose equity figures carry information. */
  haltedAccounts(g: BlockedGroup): SignalAccountReadinessDto[] {
    return g.accounts.filter((a) => a.recoveryMode === 'Halted');
  }

  /** Instances actively polling for signals. */
  pollingInstances(a: SignalAccountReadinessDto): SignalEaInstanceDto[] {
    return a.instances.filter((i) => i.isPolling);
  }

  /** Registrations left behind by restarts — superseded, never cleaned up. */
  downInstances(a: SignalAccountReadinessDto): SignalEaInstanceDto[] {
    return a.instances.filter((i) => !i.isPolling);
  }

  /**
   * Newest EA version among the dead registrations, for the summary line.
   *
   * Not every eaVersion is a version. Harness builds register as `vsmoke`, and
   * a segment-wise numeric compare turns that into NaN — every comparison
   * returns 0, the sort leaves it wherever it started, and the summary reported
   * "newest vsmoke" for an account whose real newest build was 8.47.216.
   * Rank the parseable ones and only fall back to a raw label when there is
   * nothing numeric to report.
   */
  newestDownVersion(a: SignalAccountReadinessDto): string {
    const versions = this.downInstances(a)
      .map((i) => i.eaVersion)
      .filter((v): v is string => !!v);
    if (versions.length === 0) return '—';

    const numeric = versions.filter((v) => /^\d+(\.\d+)*$/.test(v));
    if (numeric.length === 0) return versions[0];

    return numeric.sort((x, y) => {
      const xs = x.split('.').map(Number);
      const ys = y.split('.').map(Number);
      for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
        const d = (ys[i] ?? 0) - (xs[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    })[0];
  }

  /**
   * The DISTINCT reasons across dead registrations, stated once each.
   *
   * An earlier version only deduplicated when all rows agreed exactly, which
   * failed the moment one registration among 34 differed — the other 33
   * identical sentences printed anyway. Reasons are a small closed set, so
   * listing the distinct ones is always shorter than one per row and never
   * loses information.
   */
  distinctDownReasons(a: SignalAccountReadinessDto): string[] {
    const reasons = new Set(
      this.downInstances(a)
        .map((i) => i.notPollingReason)
        .filter((r): r is string => !!r),
    );
    return [...reasons];
  }

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
