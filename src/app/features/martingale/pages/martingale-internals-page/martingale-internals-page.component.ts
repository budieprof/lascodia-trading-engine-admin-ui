import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  MartingaleService,
  type MartingaleOverviewDto,
  type MartingaleChainViewDto,
} from '@core/services/martingale.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

/**
 * Full visibility into the recovery-ladder module.
 *
 * The sibling Ladders page answers "what is configured". This one answers "what is happening and
 * why" — the question that previously needed a psql session and a manual replay of position
 * history to answer.
 *
 * The load-bearing element is the per-chain LEDGER. A chain row stores only running totals, so a
 * chain sitting at depth 3 owing nothing is unreadable on its own: you cannot tell whether it got
 * there by winning, by scratching, or by a sweeper repair. The ledger replays the closes that
 * moved it and shows the running balance beside each one.
 */
@Component({
  selector: 'app-martingale-internals-page',
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
      title="Martingale Internals"
      subtitle="Every chain, the closes that moved it, and what it would stake next."
    />

    @if (loading()) {
      <app-card-skeleton />
    } @else if (error(); as e) {
      <app-empty-state title="Could not load ladder state" [description]="e" />
    } @else if (view(); as v) {
      <!--
        Mode first. Everything below is inert under Off, and computed-but-not-applied under
        Shadow, so reading the chain table without knowing the mode invites the wrong conclusion.
      -->
      <section class="mode" [attr.data-mode]="v.mode">
        <span class="mode-badge">{{ v.mode }}</span>
        <span class="mode-copy">
          @switch (v.mode) {
            @case ('Live') {
              <b>Rungs are being staked with real money.</b>
            }
            @case ('Shadow') {
              Rungs are computed and logged, never applied.
            }
            @case ('Off') {
              Nothing is computed.
            }
          }
          @if (!v.modeExplicitlySet) {
            <em>— from the compiled default, no stored row.</em>
          }
        </span>
        <a class="mode-link" routerLink="/martingale">Configure ladders →</a>
      </section>

      <!-- The scoreboard. Debt and banked surplus are kept apart deliberately. -->
      <section class="totals">
        <div class="stat">
          <span class="stat-label">Open chains</span>
          <span class="stat-value">{{ v.totals.openChains }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Outstanding debt</span>
          <span class="stat-value neg">{{ v.totals.outstandingDeficit | number: '1.2-2' }}</span>
          <span class="stat-note">still to win back</span>
        </div>
        <div class="stat">
          <span class="stat-label">Banked surplus</span>
          <span class="stat-value pos">{{ v.totals.bankedSurplus | number: '1.2-2' }}</span>
          <span class="stat-note">progress toward targets</span>
        </div>
        <div class="stat">
          <span class="stat-label">Recovered</span>
          <span class="stat-value">{{ v.totals.recoveredChains }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Abandoned</span>
          <span class="stat-value">{{ v.totals.abandonedChains }}</span>
          <span class="stat-note"
            >{{ v.totals.abandonedDeficit | number: '1.2-2' }} written off</span
          >
        </div>
        <div class="stat wide">
          <span class="stat-label">Lifetime realised P&amp;L</span>
          <span
            class="stat-value"
            [class.pos]="v.totals.lifetimeRealisedPnl > 0"
            [class.neg]="v.totals.lifetimeRealisedPnl < 0"
          >
            {{ v.totals.lifetimeRealisedPnl | number: '1.2-2' }}
          </span>
          <span class="stat-note">every close attributed to a chain — has laddering paid?</span>
        </div>
      </section>

      <!--
        Sweeper health. It is the repair path: when a close event is lost, this is what notices.
        Its cadence bounds how long a broken chain stays broken, so it belongs on this page rather
        than buried in config.
      -->
      <section class="sweeper" [class.sweeper-off]="!v.sweeper.enabled">
        <h2>Repair sweeper</h2>
        @if (!v.sweeper.enabled) {
          <p class="warn">
            <b>Disabled.</b> A chain whose close event is lost will stay Open holding a deficit that
            nothing will clear — and with serialisation on, that blocks its symbol.
          </p>
        } @else {
          <p class="sweeper-line">
            Runs every <b>{{ v.sweeper.intervalSeconds }}s</b>. Treats a chain as stuck after
            <b>{{ v.sweeper.staleAfterMinutes }} min</b> without an advance, looks back
            <b>{{ v.sweeper.openLookbackMinutes }} min</b> for a losing close that should have
            opened a chain, and waits <b>{{ v.sweeper.openSettleSeconds }}s</b> for the broker's
            realised P&amp;L to settle before opening from one.
          </p>
          @if (v.sweeper.chainsCurrentlyStale > 0) {
            <p class="warn">
              {{ v.sweeper.chainsCurrentlyStale }} chain(s) currently stale — in the sweeper's
              queue. A count that never drains means the repair path itself is stuck.
            </p>
          } @else {
            <p class="ok">No stale chains. Nothing waiting on repair.</p>
          }
        }
      </section>

      <!-- Laddered pairs, including ones with no chain yet. -->
      <section class="symbols">
        <h2>Laddered symbols</h2>
        @if (v.ladderedSymbols.length === 0) {
          <app-empty-state
            title="No symbols opted in"
            description="A ladder is switched on per account and symbol. Nothing is laddered yet."
          />
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Symbol</th>
                  <th>State</th>
                  <th class="num">Max depth</th>
                  <th class="num">Target R</th>
                  <th class="num">Stake cap</th>
                  <th class="num">Age cap</th>
                  <th class="num">Worst case</th>
                  <th>Live now</th>
                </tr>
              </thead>
              <tbody>
                @for (s of v.ladderedSymbols; track s.tradingAccountId + s.symbol) {
                  <tr [class.inactive]="!s.effectivelyActive">
                    <td>
                      {{ s.accountName }} <span class="dim">#{{ s.tradingAccountId }}</span>
                    </td>
                    <td class="mono">{{ s.symbol }}</td>
                    <td>
                      @if (s.effectivelyActive) {
                        <span class="pill pill-on">active</span>
                      } @else if (!s.enabled) {
                        <span class="pill">symbol off</span>
                      } @else if (!s.profileEnabled) {
                        <span class="pill pill-warn">profile off</span>
                      } @else {
                        <span class="pill">mode off</span>
                      }
                    </td>
                    <td class="num">{{ s.effectiveMaxDepth }}</td>
                    <td class="num">{{ s.effectiveTargetProfitR | number: '1.2-2' }}</td>
                    <td class="num">{{ s.effectiveMaxStakePctEquity | number: '1.0-2' }}%</td>
                    <td class="num">{{ s.effectiveMaxChainAgeHours }}h</td>
                    <td class="num" [class.neg]="s.worstCaseDrawdownPct > 50">
                      {{ s.worstCaseDrawdownPct | number: '1.1-1' }}%
                    </td>
                    <td>
                      @if (s.openPositions || s.ordersInFlight) {
                        <span class="dim">
                          {{ s.openPositions }} pos · {{ s.ordersInFlight }} ord
                        </span>
                      } @else {
                        <span class="dim">—</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="foot">
            <b>Worst case</b> is the cumulative loss if every rung to the depth cap loses. Each rung
            must recover the whole running debt plus the target, so the stake roughly triples per
            rung — the series grows far faster than the depth number suggests.
          </p>
        }
      </section>

      <!-- Chains, each expandable into its ledger. -->
      <section class="chains">
        <div class="chains-head">
          <h2>Chains</h2>
          <div class="filters">
            @for (f of statusFilters; track f) {
              <button
                type="button"
                class="filter"
                [class.filter-on]="status() === f"
                (click)="setStatus(f)"
              >
                {{ f || 'All' }}
              </button>
            }
          </div>
        </div>

        @if (v.chains.length === 0) {
          <app-empty-state
            title="No chains"
            description="A chain opens on the first losing close of a laddered symbol."
          />
        } @else {
          @for (c of v.chains; track c.id) {
            <article class="chain" [attr.data-status]="c.status">
              <header class="chain-head" (click)="toggle(c.id)">
                <span class="chain-status">{{ c.status }}</span>
                <span class="chain-title">
                  <b>{{ c.symbol }}</b> · {{ c.accountName }}
                  <span class="dim">#{{ c.tradingAccountId }}</span>
                </span>

                <span class="chain-depth" [class.neg]="c.depth >= c.maxDepth">
                  depth {{ c.depth }}/{{ c.maxDepth }}
                </span>

                <!--
                  A negative deficit is banked surplus, not debt. Showing it as "-2605.32 owed"
                  reads as a bigger hole when it is the opposite.
                -->
                @if (c.deficitAmount > 0) {
                  <span class="chain-money neg">
                    {{ c.deficitAmount | number: '1.2-2' }} owed
                  </span>
                } @else if (c.deficitAmount < 0) {
                  <span class="chain-money pos">
                    {{ -c.deficitAmount | number: '1.2-2' }} banked
                  </span>
                } @else {
                  <span class="chain-money dim">level</span>
                }

                <span
                  class="chain-pnl"
                  [class.pos]="c.realisedPnl > 0"
                  [class.neg]="c.realisedPnl < 0"
                >
                  {{ c.realisedPnl | number: '1.2-2' }} net
                </span>

                @if (c.depthDivergesFromLedger) {
                  <span class="pill pill-bad">depth mismatch</span>
                }
                @if (c.isStale) {
                  <span class="pill pill-warn">stale</span>
                }

                <span class="chain-toggle">{{ expanded().has(c.id) ? '−' : '+' }}</span>
              </header>

              @if (expanded().has(c.id)) {
                <div class="chain-body">
                  <dl class="chain-meta">
                    <div>
                      <dt>Opened</dt>
                      <dd>{{ c.openedAtUtc | date: 'short' : 'UTC' }}</dd>
                    </div>
                    <div>
                      <dt>Last advance</dt>
                      <dd>{{ c.lastAdvancedAtUtc | date: 'short' : 'UTC' }}</dd>
                    </div>
                    <div>
                      <dt>Age</dt>
                      <dd>{{ c.ageHours | number: '1.1-1' }}h / {{ c.maxChainAgeHours }}h cap</dd>
                    </div>
                    <div>
                      <dt>Target</dt>
                      <dd>{{ c.targetAmount | number: '1.2-2' }}</dd>
                    </div>
                    <div>
                      <dt>Base stake</dt>
                      <dd>{{ c.baseStakeAmount | number: '1.2-2' }}</dd>
                    </div>
                    @if (c.closureReason) {
                      <div class="wide">
                        <dt>Closed because</dt>
                        <dd>{{ c.closureReason }}</dd>
                      </div>
                    }
                  </dl>

                  @if (c.depthDivergesFromLedger) {
                    <!--
                      Not cosmetic: depth decides how close a chain is to its cap, and a chain at
                      its cap is abandoned rather than staked. An inflated depth writes off a chain
                      that still had headroom — possibly one that is winning.
                    -->
                    <div class="divergence">
                      <h3>Stored depth disagrees with the ledger</h3>
                      <p>
                        This chain records <b>depth {{ c.depth }}</b
                        >, but its trades show <b>depth {{ c.ledgerDerivedDepth }}</b> — one for the
                        opening loss plus one per subsequent loss.
                      </p>
                      <p>
                        Depth decides how close the chain is to its cap, and a chain at its cap is
                        <b>abandoned rather than staked</b>. An inflated count writes off a chain
                        that still had room to recover. The usual cause is rungs burned by closes
                        that did not lose, before that was corrected.
                      </p>
                    </div>
                  }

                  @if (c.nextRung; as r) {
                    <div
                      class="rung"
                      [class.rung-blocked]="!!r.blockedBy"
                      [class.rung-abandon]="r.wouldAbandon"
                    >
                      <h3>Next rung — depth {{ r.depth }}</h3>
                      <p>
                        Must make <b>{{ r.amountToRecover | number: '1.2-2' }}</b> ({{
                          r.stakeMultiple | number: '1.1-2'
                        }}× the base stake, {{ r.stakePctEquity | number: '1.1-2' }}% of equity).
                      </p>
                      @if (r.wouldAbandon) {
                        <p class="warn">
                          <b>Would not stake.</b> {{ r.bindingConstraint }} The deficit is taken as
                          a realised loss rather than escalated further.
                        </p>
                      } @else if (r.blockedBy) {
                        <p class="warn">
                          <b>Blocked:</b> {{ r.blockedBy }} on this symbol. Serialisation holds a
                          laddered symbol to one live thing at a time — a second would give the
                          chain two deficits it cannot tell apart.
                        </p>
                      } @else {
                        <p class="ok">Clear to stake on the next signal for this symbol.</p>
                      }
                    </div>
                  }

                  <h3>Ledger</h3>
                  @if (c.ledger.length === 0) {
                    <p class="dim">
                      No closes attributed. A chain opened by the sweeper from a close outside the
                      replay window will show empty here.
                    </p>
                  } @else {
                    <div class="table-scroll">
                      <table class="ledger">
                        <thead>
                          <tr>
                            <th>Position</th>
                            <th>When</th>
                            <th>Dir</th>
                            <th class="num">Lots</th>
                            <th class="num">P&amp;L</th>
                            <th class="num">Running balance</th>
                            <th>Effect</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (e of c.ledger; track e.positionId) {
                            <tr>
                              <td class="mono">#{{ e.positionId }}</td>
                              <td>{{ e.closedAtUtc | date: 'short' : 'UTC' }}</td>
                              <td>{{ e.direction }}</td>
                              <td class="num">{{ e.lots | number: '1.2-2' }}</td>
                              <td
                                class="num"
                                [class.pos]="e.realisedPnl > 0"
                                [class.neg]="e.realisedPnl < 0"
                              >
                                {{ e.realisedPnl | number: '1.2-2' }}
                              </td>
                              <td
                                class="num"
                                [class.pos]="e.runningDeficit < 0"
                                [class.neg]="e.runningDeficit > 0"
                              >
                                @if (e.runningDeficit > 0) {
                                  {{ e.runningDeficit | number: '1.2-2' }} owed
                                } @else if (e.runningDeficit < 0) {
                                  {{ -e.runningDeficit | number: '1.2-2' }} banked
                                } @else {
                                  level
                                }
                              </td>
                              <td>
                                @if (e.openedTheChain) {
                                  <span class="pill">opened the chain</span>
                                } @else if (e.burnedARung) {
                                  <span class="pill pill-warn">lost — burned a rung</span>
                                } @else if (e.outcome === 'Win') {
                                  <!--
                                    A win that did not fully recover the chain still escalates:
                                    only a full recovery ends a ladder, so a partial win is a
                                    failed attempt that happened to close green.
                                  -->
                                  <span class="pill pill-warn">paid down — burned a rung</span>
                                } @else {
                                  <span class="pill">scratch — depth held</span>
                                }
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                    <p class="foot">
                      Depth is the escalation budget. Only a <b>full recovery</b> ends a ladder, so
                      every close that falls short escalates it — a win that merely paid some of the
                      debt burns a rung just as a loss does. Only an exact break-even holds. The
                      running balance is replayed from the chain's opening loss; if its last row
                      disagrees with the header, the stored total and the position history have
                      diverged.
                    </p>
                  }
                </div>
              }
            </article>
          }
        }
      </section>

      <p class="generated">
        Generated {{ v.generatedAtUtc | date: 'medium' : 'UTC' }} UTC ·
        <button type="button" class="link" (click)="reload()">refresh</button>
      </p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      /* Mode banner: colour-coded by consequence — Live is the only one that moves money. */
      .mode {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
        border: 1px solid var(--border-default);
        border-left-width: 4px;
        border-radius: 8px;
        padding: 0.75rem 1rem;
        margin-bottom: 1rem;
        background: var(--surface-raised);
      }
      .mode[data-mode='Live'] {
        border-left-color: var(--color-danger, #d64545);
      }
      .mode[data-mode='Shadow'] {
        border-left-color: var(--color-warning, #d69e2e);
      }
      .mode[data-mode='Off'] {
        border-left-color: var(--border-default);
      }
      .mode-badge {
        font-weight: 700;
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 0.05em;
      }
      .mode-copy {
        flex: 1 1 20rem;
      }
      .mode-link {
        font-size: 0.875rem;
      }

      .totals {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      .stat {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        border: 1px solid var(--border-default);
        border-radius: 8px;
        padding: 0.7rem 0.85rem;
        background: var(--surface-raised);
      }
      .stat.wide {
        grid-column: span 2;
      }
      .stat-label {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
      }
      .stat-value {
        font-size: 1.3rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .stat-note {
        font-size: 0.72rem;
        color: var(--text-muted);
      }

      .sweeper,
      .symbols,
      .chains {
        border: 1px solid var(--border-default);
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 1rem;
        background: var(--surface-raised);
      }
      .sweeper-off {
        border-left: 4px solid var(--color-danger, #d64545);
      }
      h2 {
        margin: 0 0 0.6rem;
        font-size: 1rem;
      }
      h3 {
        margin: 1rem 0 0.4rem;
        font-size: 0.9rem;
      }
      .sweeper-line {
        margin: 0 0 0.4rem;
      }

      .chains-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .filters {
        display: flex;
        gap: 0.35rem;
      }
      .filter {
        border: 1px solid var(--border-default);
        background: transparent;
        color: inherit;
        border-radius: 999px;
        padding: 0.2rem 0.7rem;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .filter-on {
        background: var(--surface-sunken, rgba(127, 127, 127, 0.15));
        font-weight: 600;
      }

      .chain {
        border: 1px solid var(--border-default);
        border-radius: 8px;
        margin-top: 0.6rem;
        overflow: hidden;
      }
      .chain[data-status='Open'] {
        border-left: 4px solid var(--color-warning, #d69e2e);
      }
      .chain[data-status='Recovered'] {
        border-left: 4px solid var(--color-success, #2f855a);
      }
      .chain[data-status='Abandoned'] {
        border-left: 4px solid var(--color-danger, #d64545);
      }
      .chain-head {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
        padding: 0.6rem 0.85rem;
        cursor: pointer;
      }
      .chain-status {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        min-width: 5.5rem;
      }
      .chain-title {
        flex: 1 1 14rem;
      }
      .chain-depth,
      .chain-money,
      .chain-pnl {
        font-variant-numeric: tabular-nums;
        font-size: 0.875rem;
      }
      .chain-toggle {
        font-size: 1.1rem;
        width: 1rem;
        text-align: center;
      }
      .chain-body {
        padding: 0 0.85rem 0.85rem;
        border-top: 1px solid var(--border-default);
      }

      .chain-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
        gap: 0.5rem 1rem;
        margin: 0.75rem 0 0;
      }
      .chain-meta > div.wide {
        grid-column: 1 / -1;
      }
      .chain-meta dt {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
      }
      .chain-meta dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
      }

      .rung {
        border: 1px solid var(--border-default);
        border-radius: 6px;
        padding: 0.6rem 0.8rem;
        margin-top: 0.9rem;
        background: var(--surface-sunken, rgba(127, 127, 127, 0.06));
      }
      .rung h3 {
        margin-top: 0;
      }
      .rung-blocked {
        border-left: 3px solid var(--color-warning, #d69e2e);
      }
      .rung-abandon {
        border-left: 3px solid var(--color-danger, #d64545);
      }
      .rung p {
        margin: 0.25rem 0;
      }

      /* Wide tables scroll inside their own box — the page body never scrolls sideways. */
      .table-scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
      }
      th,
      td {
        text-align: left;
        padding: 0.4rem 0.6rem;
        border-bottom: 1px solid var(--border-default);
        white-space: nowrap;
      }
      th {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        font-weight: 600;
      }
      td.num,
      th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      tr.inactive td {
        opacity: 0.55;
      }

      .pill {
        display: inline-block;
        border: 1px solid var(--border-default);
        border-radius: 999px;
        padding: 0.05rem 0.5rem;
        font-size: 0.72rem;
        white-space: nowrap;
      }
      .pill-on {
        border-color: var(--color-success, #2f855a);
      }
      .pill-warn {
        border-color: var(--color-warning, #d69e2e);
      }
      .pill-bad {
        border-color: var(--color-danger, #d64545);
        color: var(--color-danger, #d64545);
        font-weight: 600;
      }

      .divergence {
        border: 1px solid var(--color-danger, #d64545);
        border-left-width: 3px;
        border-radius: 6px;
        padding: 0.6rem 0.8rem;
        margin-top: 0.9rem;
      }
      .divergence h3 {
        margin-top: 0;
        color: var(--color-danger, #d64545);
      }
      .divergence p {
        margin: 0.25rem 0;
      }

      .pos {
        color: var(--color-success, #2f855a);
      }
      .neg {
        color: var(--color-danger, #d64545);
      }
      .dim {
        color: var(--text-muted);
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }
      .warn {
        color: var(--color-warning, #b7791f);
      }
      .ok {
        color: var(--color-success, #2f855a);
      }
      .foot {
        margin: 0.5rem 0 0;
        font-size: 0.8rem;
        color: var(--text-muted);
      }
      .generated {
        font-size: 0.8rem;
        color: var(--text-muted);
      }
      .link {
        background: none;
        border: none;
        padding: 0;
        color: inherit;
        text-decoration: underline;
        cursor: pointer;
        font: inherit;
      }
    `,
  ],
})
export class MartingaleInternalsPageComponent {
  private readonly service = inject(MartingaleService);

  readonly statusFilters = ['', 'Open', 'Recovered', 'Abandoned'] as const;

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly status = signal<string>('');
  readonly expanded = signal<ReadonlySet<number>>(new Set<number>());

  private readonly data = signal<MartingaleOverviewDto | null>(null);
  readonly view = computed(() => this.data());

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);

    this.service.getOverview({ maxChains: 50, status: this.status() || undefined }).subscribe({
      next: (dto) => {
        this.data.set(dto);
        // Open chains are the ones an operator is here to look at, so expand them by default;
        // closed ones are history and stay folded.
        this.expanded.set(
          new Set(
            dto.chains.filter((c: MartingaleChainViewDto) => c.status === 'Open').map((c) => c.id),
          ),
        );
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(err instanceof Error ? err.message : 'Request failed.');
        this.loading.set(false);
      },
    });
  }

  setStatus(next: string): void {
    if (this.status() === next) return;
    this.status.set(next);
    this.reload();
  }

  toggle(chainId: number): void {
    const next = new Set(this.expanded());
    if (!next.delete(chainId)) next.add(chainId);
    this.expanded.set(next);
  }
}
