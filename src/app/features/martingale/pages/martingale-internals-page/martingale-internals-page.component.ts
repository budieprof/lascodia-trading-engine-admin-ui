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

import {
  chainMatchesQuery,
  chainStatusTone,
  nextRungVerdict,
  type NextRungLike,
  type Tone,
} from '../../martingale-display';

/** One format for every timestamp on the page; all of them are UTC and the page says so. */
const TS = 'yyyy-MM-dd HH:mm';

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
  styleUrl: './martingale-internals-page.scss',
  template: `
    <app-page-header
      title="Martingale Internals"
      subtitle="Every chain, the closes that moved it, and what it would stake next."
    >
      @if (view(); as v) {
        <span class="asof" title="When the engine built this snapshot. Times on this page are UTC.">
          Generated {{ v.generatedAtUtc | date: 'yyyy-MM-dd HH:mm:ss' : 'UTC' }} UTC
        </span>
      }
      <button type="button" class="btn-ghost" (click)="reload()" [disabled]="loading()">
        {{ loading() ? 'Loading…' : 'Refresh' }}
      </button>
    </app-page-header>

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

      <!--
        The answer an operator comes for, before any totals: which chains are live right now and
        whether each one can take its next rung. One line per open chain with a jump to its ledger
        further down — the ledger is the "why", this is the "what".
      -->
      <section class="now card">
        <div class="now-head">
          <h2>Open right now</h2>
          <span class="dim">
            {{ openNow().length }} open chain{{ openNow().length === 1 ? '' : 's' }} in view
          </span>
        </div>
        @if (openNow().length === 0) {
          <p class="now-empty">
            <b>No open chains.</b>
            <span class="dim"
              >Nothing is mid-recovery — every laddered symbol is at base size.</span
            >
          </p>
        } @else {
          @for (c of openNow(); track c.id) {
            <div class="now-row">
              <span class="now-title">
                <b>{{ c.symbol }}</b> · {{ c.accountName }}
                <span class="dim">#{{ c.tradingAccountId }} · chain #{{ c.id }}</span>
              </span>
              <span class="now-fig num" [class.neg]="c.depth >= c.maxDepth">
                <span class="k">Depth</span> {{ c.depth }}/{{ c.maxDepth }}
              </span>
              <span class="now-fig num">
                <span class="k">Balance</span>
                @if (c.deficitAmount > 0) {
                  <span class="neg">{{ c.deficitAmount | number: '1.2-2' }} owed</span>
                } @else if (c.deficitAmount < 0) {
                  <span class="pos">{{ -c.deficitAmount | number: '1.2-2' }} banked</span>
                } @else {
                  <span class="dim">level</span>
                }
              </span>
              <span class="now-flags">
                @if (c.nextRung; as r) {
                  <span [class]="'pill ' + verdict(r).tone">
                    Next rung: {{ verdict(r).label }}
                  </span>
                }
                @if (c.depthDivergesFromLedger) {
                  <span class="pill bad">depth mismatch</span>
                }
                @if (c.isStale && c.waitingOnOpenPosition) {
                  <span class="pill">waiting on open position</span>
                } @else if (c.isStale) {
                  <span class="pill warn">stale</span>
                }
                @if (c.rungSkipCount > 0) {
                  <span class="pill bad">rung skipped ×{{ c.rungSkipCount }}</span>
                }
              </span>
              <button type="button" class="btn-link" (click)="jumpTo(c.id)">Ledger ↓</button>
            </div>
          }
        }
      </section>

      <!--
        The scoreboard. Two money figures carry the page — has laddering paid, and how much is
        still at risk — so they are set large; the chain counts are bookkeeping and sit smaller.
        Debt and banked surplus are kept apart deliberately. Money is in each account's own
        currency: the overview spans accounts, so no single unit is honest.
      -->
      <section class="totals">
        <div
          class="kpi primary"
          [class.pos]="v.totals.lifetimeRealisedPnl > 0"
          [class.neg]="v.totals.lifetimeRealisedPnl < 0"
        >
          <div class="k-label">Lifetime realised P&amp;L</div>
          <div
            class="k-value"
            [class.pos]="v.totals.lifetimeRealisedPnl > 0"
            [class.neg]="v.totals.lifetimeRealisedPnl < 0"
          >
            {{ v.totals.lifetimeRealisedPnl | number: '1.2-2' }}
          </div>
          <div class="k-hint">account currency · every close attributed to a chain</div>
        </div>
        <div class="kpi primary" [class.neg]="v.totals.outstandingDeficit > 0">
          <div class="k-label">Outstanding debt</div>
          <div class="k-value" [class.neg]="v.totals.outstandingDeficit > 0">
            {{ v.totals.outstandingDeficit | number: '1.2-2' }}
          </div>
          <div class="k-hint">account currency · still to win back</div>
        </div>
        <div class="kpi" [class.pos]="v.totals.bankedSurplus > 0">
          <div class="k-label">Banked surplus</div>
          <div class="k-value" [class.pos]="v.totals.bankedSurplus > 0">
            {{ v.totals.bankedSurplus | number: '1.2-2' }}
          </div>
          <div class="k-hint">progress toward targets</div>
        </div>
        <div class="kpi" [class.warn]="v.totals.openChains > 0">
          <div class="k-label">Open chains</div>
          <div class="k-value">{{ v.totals.openChains }}</div>
        </div>
        <div class="kpi" [class.pos]="v.totals.recoveredChains > 0">
          <div class="k-label">Recovered</div>
          <div class="k-value">{{ v.totals.recoveredChains }}</div>
        </div>
        <div class="kpi" [class.neg]="v.totals.abandonedChains > 0">
          <div class="k-label">Abandoned</div>
          <div class="k-value">{{ v.totals.abandonedChains }}</div>
          <div class="k-hint">{{ v.totals.abandonedDeficit | number: '1.2-2' }} written off</div>
        </div>
      </section>
      @if (mismatchWriteOff(); as m) {
        <p
          class="callout warn totals-note"
          title="These chains carry a stored depth the ledger does not support (legacy replay ledgers). Their write-off is a bookkeeping artefact of the inflated depth as much as a trading loss."
        >
          Of the {{ v.totals.abandonedDeficit | number: '1.2-2' }} written off,
          <b>{{ m.amount | number: '1.2-2' }}</b> comes from {{ m.count }} depth-mismatch chain{{
            m.count === 1 ? '' : 's'
          }}
          in view — chains whose stored depth the ledger does not support, so that share is a
          bookkeeping artefact as much as a trading loss.
        </p>
      }

      <!--
        Sweeper health. It is the repair path: when a close event is lost, this is what notices.
        Its cadence bounds how long a broken chain stays broken, so it belongs on this page rather
        than buried in config.
      -->
      <section class="sweeper card" [class.sweeper-off]="!v.sweeper.enabled">
        <div class="sweeper-head">
          <h2>Repair sweeper</h2>
          @if (!v.sweeper.enabled) {
            <span class="dot bad">disabled</span>
          } @else if (v.sweeper.chainsStaleIdle > 0) {
            <span class="dot warn">{{ v.sweeper.chainsStaleIdle }} in queue</span>
          } @else {
            <span class="dot ok">healthy</span>
          }
        </div>
        @if (!v.sweeper.enabled) {
          <p class="callout bad">
            <b>Disabled.</b> A chain whose close event is lost will stay Open holding a deficit that
            nothing will clear — and with serialisation on, that blocks its symbol.
          </p>
        } @else {
          @if (v.sweeper.chainsStaleIdle > 0) {
            <p class="callout warn">
              {{ v.sweeper.chainsStaleIdle }} chain(s) stale with nothing live on the symbol — in
              the sweeper's queue. A count that never drains means the repair path itself is stuck.
            </p>
          } @else if (v.sweeper.chainsWaitingOnOpenPosition > 0) {
            <p class="ok-line">
              No chain needs repair. {{ v.sweeper.chainsWaitingOnOpenPosition }} chain(s) show as
              stale only because their rung is still open at the broker — they are waiting on that
              position, not on the sweeper.
            </p>
          } @else {
            <p class="ok-line">No stale chains. Nothing waiting on repair.</p>
          }
          <p class="sweeper-line">
            Runs every <b>{{ v.sweeper.intervalSeconds }}s</b>. Treats a chain as stuck after
            <b>{{ v.sweeper.staleAfterMinutes }} min</b> without an advance, looks back
            <b>{{ v.sweeper.openLookbackMinutes }} min</b> for a losing close that should have
            opened a chain, and waits <b>{{ v.sweeper.openSettleSeconds }}s</b> for the broker's
            realised P&amp;L to settle before opening from one.
          </p>
        }
      </section>

      <!-- Chains, each expandable into its ledger. -->
      <section class="chains card">
        <div class="chains-head">
          <h2>Chains</h2>
          <div class="chains-tools">
            <input
              type="search"
              class="search"
              placeholder="Find symbol, account or chain #"
              aria-label="Filter the chains shown"
              [ngModel]="query()"
              (ngModelChange)="query.set($event)"
            />
            <div class="seg" role="group" aria-label="Chain status">
              @for (f of statusFilters; track f) {
                <button type="button" [class.on]="status() === f" (click)="setStatus(f)">
                  {{ f || 'All' }}
                </button>
              }
            </div>
          </div>
        </div>
        <p class="chains-sub dim">
          Newest {{ v.chains.length }} chain{{ v.chains.length === 1 ? '' : 's' }}
          @if (query().trim()) {
            · {{ visibleChains().length }} match "{{ query().trim() }}"
          }
          · open chains are expanded · times UTC
        </p>

        @if (v.chains.length === 0) {
          <app-empty-state
            title="No chains"
            description="A chain opens on the first losing close of a laddered symbol."
          />
        } @else if (visibleChains().length === 0) {
          <div class="empty">
            <strong>No chain matches "{{ query().trim() }}".</strong>
            Search runs over the {{ v.chains.length }} chains loaded — try a symbol, an account
            name, or a chain number.
          </div>
        } @else {
          <!--
            Fixed columns: status · title · when · depth · owed · net · flags · toggle. A flex row
            wrapped differently for every chain, so the eye had to re-find "owed" on each line.
          -->
          <div class="chain-cols" aria-hidden="true">
            <span>Status</span>
            <span>Chain</span>
            <span>Closed / last move</span>
            <span class="num">Depth</span>
            <span class="num">Balance</span>
            <span class="num">Net P&amp;L</span>
            <span>Flags</span>
            <span></span>
          </div>
          @for (c of visibleChains(); track c.id) {
            <article
              class="chain"
              [id]="'chain-' + c.id"
              [attr.data-status]="c.status"
              [attr.data-reset]="isOperatorReset(c) ? 'true' : null"
            >
              <header
                class="chain-head"
                role="button"
                tabindex="0"
                [attr.aria-expanded]="expanded().has(c.id)"
                (click)="toggle(c.id)"
                (keydown.enter)="toggle(c.id)"
                (keydown.space)="$event.preventDefault(); toggle(c.id)"
              >
                <span class="chain-status" [title]="c.closureReason ?? ''">
                  <span [class]="'pill ' + statusTone(c)">{{ statusLabel(c) }}</span>
                </span>
                <span
                  class="chain-title"
                  [title]="
                    c.symbol +
                    ' · ' +
                    c.accountName +
                    ' #' +
                    c.tradingAccountId +
                    ' · chain #' +
                    c.id
                  "
                >
                  <b>{{ c.symbol }}</b> · {{ c.accountName }}
                  <span class="dim">#{{ c.tradingAccountId }} · chain #{{ c.id }}</span>
                </span>
                <span class="chain-when dim">
                  {{ c.closedAtUtc ?? c.lastAdvancedAtUtc | date: ts : 'UTC' }}
                </span>

                <span class="chain-depth num" [class.neg]="c.depth >= c.maxDepth">
                  {{ c.depth }}/{{ c.maxDepth }}
                </span>

                <!--
                  A negative deficit is banked surplus, not debt. Showing it as "-2605.32 owed"
                  reads as a bigger hole when it is the opposite. A closed chain that ended level
                  says so in its status, so the balance cell stays quiet.
                -->
                @if (c.deficitAmount > 0) {
                  <span class="chain-money num neg">
                    {{ c.deficitAmount | number: '1.2-2' }} owed
                  </span>
                } @else if (c.deficitAmount < 0) {
                  <span class="chain-money num pos">
                    {{ -c.deficitAmount | number: '1.2-2' }} banked
                  </span>
                } @else {
                  <span class="chain-money num dim">level</span>
                }

                <span
                  class="chain-pnl num"
                  [class.pos]="c.realisedPnl > 0"
                  [class.neg]="c.realisedPnl < 0"
                >
                  {{ c.realisedPnl | number: '1.2-2' }}
                </span>

                <span class="chain-flags">
                  @if (c.depthDivergesFromLedger) {
                    <span class="pill bad">depth mismatch</span>
                  }
                  @if (c.isStale && c.waitingOnOpenPosition) {
                    <span
                      class="pill"
                      title="Its rung is still open at the broker; the chain advances when it closes."
                    >
                      waiting on open position
                    </span>
                  } @else if (c.isStale) {
                    <span
                      class="pill warn"
                      title="No advance inside the sweeper's stale window and nothing live on the symbol."
                    >
                      stale
                    </span>
                  }
                  @if (c.status === 'Open' && c.rungSkipCount > 0) {
                    <span class="pill bad">rung skipped ×{{ c.rungSkipCount }}</span>
                  }
                </span>

                <span class="chain-toggle" aria-hidden="true">{{
                  expanded().has(c.id) ? '−' : '+'
                }}</span>
              </header>

              @if (expanded().has(c.id)) {
                <div class="chain-body">
                  <dl class="chain-meta">
                    <div>
                      <dt>Opened</dt>
                      <dd>{{ c.openedAtUtc | date: ts : 'UTC' }} UTC</dd>
                    </div>
                    <div>
                      <dt>Last advance</dt>
                      <dd>{{ c.lastAdvancedAtUtc | date: ts : 'UTC' }} UTC</dd>
                    </div>
                    @if (c.closedAtUtc) {
                      <div>
                        <dt>Closed</dt>
                        <dd>{{ c.closedAtUtc | date: ts : 'UTC' }} UTC</dd>
                      </div>
                    }
                    <div>
                      <dt>Age</dt>
                      <dd>{{ c.ageHours | number: '1.1-1' }}h / {{ c.maxChainAgeHours }}h cap</dd>
                    </div>
                    <div>
                      <dt>Target</dt>
                      <dd>
                        {{ c.targetAmount | number: '1.2-2' }} <span class="dim">acct ccy</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Base stake</dt>
                      <dd>
                        {{ c.baseStakeAmount | number: '1.2-2' }} <span class="dim">acct ccy</span>
                      </dd>
                    </div>
                    @if (c.closureReason) {
                      <div class="wide">
                        <dt>{{ isOperatorReset(c) ? 'Reset by operator' : 'Closed because' }}</dt>
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
                    <div class="box bad">
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

                  @if (c.lastRungSkippedAtUtc) {
                    <!--
                      The poll path computed a LIVE rung and refused to place it — broker lot
                      ceiling, or an unfundable stake nothing abandons. Without this trace the
                      chain looks identical to one that is laddering, while it actually keeps
                      advancing on base-sized trades and the deficit compounds.
                    -->
                    <div class="box bad">
                      <h3>
                        Rung skipped at sizing time
                        <span class="dim"
                          >— last {{ c.lastRungSkippedAtUtc | date: ts : 'UTC' }} UTC,
                          {{ c.rungSkipCount }} episode{{ c.rungSkipCount === 1 ? '' : 's' }}</span
                        >
                      </h3>
                      <p>{{ c.lastRungSkipReason }}</p>
                      <p class="foot">
                        The chain stays open without escalating, so every later rung is even more
                        likely to hit the same ceiling. If it cannot recover at base size, reset it
                        below to write the deficit off and return to normal sizing.
                      </p>
                    </div>
                  }

                  @if (c.nextRung; as r) {
                    <div
                      class="box rung"
                      [class.warn]="!!r.blockedBy || r.rungWillBeSkipped"
                      [class.bad]="r.wouldAbandon"
                    >
                      <h3>
                        Next rung — depth {{ r.depth }}
                        <span [class]="'pill ' + verdict(r).tone">{{ verdict(r).label }}</span>
                      </h3>
                      <p>
                        Must make <b>{{ r.amountToRecover | number: '1.2-2' }}</b> ({{
                          r.stakeMultiple | number: '1.1-2'
                        }}× the base stake), which means risking
                        <b>{{ r.riskRequired | number: '1.2-2' }}</b>
                        @if (r.geometryR !== null) {
                          at {{ r.geometryR | number: '1.2-2' }}R
                        }
                        — <b>{{ r.stakePctEquity | number: '1.1-2' }}% of equity</b>, the figure the
                        stake ceiling is tested against.
                        @if (r.estimatedRungLots !== null) {
                          @if (r.brokerMaxLotSize !== null) {
                            Roughly <b>{{ r.estimatedRungLots | number: '1.0-2' }} lots</b> against
                            a broker ceiling of {{ r.brokerMaxLotSize | number: '1.0-0' }} lots.
                          } @else {
                            Roughly <b>{{ r.estimatedRungLots | number: '1.0-2' }} lots</b>.
                          }
                          <span class="dim">{{ r.estimateBasis }}</span>
                        }
                      </p>
                      @if (r.wouldAbandon) {
                        <p class="warn-line">
                          <b>Would not stake.</b> {{ r.bindingConstraint }} The deficit is taken as
                          a realised loss rather than escalated further.
                        </p>
                      } @else if (r.blockedBy) {
                        <p class="warn-line">
                          <b>Blocked:</b> {{ r.blockedBy }} on this symbol. Serialisation holds a
                          laddered symbol to one live thing at a time — a second would give the
                          chain two deficits it cannot tell apart.
                        </p>
                      } @else if (r.rungWillBeSkipped) {
                        <p class="warn-line">
                          <b>Will not fit.</b> {{ r.bindingConstraint }} Unlike a cap breach this
                          does NOT abandon the chain — it quietly under-ladders instead, which is
                          why it is surfaced here.
                        </p>
                      } @else {
                        <p class="ok-line">Clear to stake on the next signal for this symbol.</p>
                      }
                    </div>
                  }

                  <h3>
                    Ledger
                    @if (c.ledgerSource === 'replay') {
                      <span
                        class="pill warn"
                        title="This chain predates the advance ledger, so its closes are reconstructed from position history by account, symbol and time window. That attributes by coincidence and can include a neighbouring chain's close or miss one whose timestamp was revised."
                      >
                        reconstructed from position history
                      </span>
                    }
                  </h3>
                  @if (c.ledger.length === 0) {
                    <p class="dim">
                      No closes recorded. A chain opened before the advance ledger existed, from a
                      close outside the replay window, will show empty here.
                    </p>
                  } @else {
                    <div class="table-scroll">
                      <table class="ledger">
                        <thead>
                          <tr>
                            <th>Position</th>
                            <th>Applied (UTC)</th>
                            <th>Dir</th>
                            <th class="num">Lots</th>
                            <th class="num">P&amp;L</th>
                            <th class="num">Running balance</th>
                            <th class="num">Depth</th>
                            <th>Effect</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (e of c.ledger; track e.positionId) {
                            <tr>
                              <td class="mono">#{{ e.positionId }}</td>
                              <!--
                                The ladder's own clock: rows are ordered by when the service
                                APPLIED each close, so that is the column that explains the
                                order they appear in. The broker close time sits underneath —
                                it is the figure that can be wrong (an EA server-to-UTC
                                conversion fault put 55 of them hours into the future, which
                                made chains read as opening after their own rungs closed).
                              -->
                              <td>
                                {{ e.appliedAtUtc ?? e.closedAtUtc | date: ts : 'UTC' }}
                                @if (e.closedAtUtc) {
                                  <span
                                    class="sub"
                                    [class.bad-time]="e.closedAtImplausible"
                                    [title]="
                                      e.closedAtImplausible
                                        ? 'The broker close time postdates the advance that consumed this close, which is impossible. The timestamp reached the engine mis-converted; the ladder itself is unaffected.'
                                        : 'Broker close time'
                                    "
                                  >
                                    closed {{ e.closedAtUtc | date: ts : 'UTC' }}
                                    @if (e.closedAtImplausible) {
                                      ⚠
                                    }
                                  </span>
                                }
                              </td>
                              <td>{{ e.direction }}</td>
                              <td class="num">{{ e.lots | number: '1.2-2' }}</td>
                              <td
                                class="num"
                                [class.pos]="e.realisedPnl > 0"
                                [class.neg]="e.realisedPnl < 0"
                              >
                                {{ e.realisedPnl | number: '1.2-2' }}
                              </td>
                              <!--
                                "runningDeficit" is the advance's stored DeficitAfter — frozen at
                                what the chain believed when it applied the close. Drift
                                reconciliation restates the MONEY column against the broker's
                                settled figure but deliberately leaves that snapshot alone, so
                                the two can disagree and the column stops adding up (chain 44:
                                −9.87 leaving "9.38 owed", then +3.00 arriving at "6.87 owed").
                                When the engine can recover the true figure it sends it as
                                reconciledRunningDeficit; that is the balance to believe.
                              -->
                              <td
                                class="num"
                                [class.pos]="(e.reconciledRunningDeficit ?? e.runningDeficit) < 0"
                                [class.neg]="(e.reconciledRunningDeficit ?? e.runningDeficit) > 0"
                              >
                                @let bal = e.reconciledRunningDeficit ?? e.runningDeficit;
                                @if (bal > 0) {
                                  {{ bal | number: '1.2-2' }} owed
                                } @else if (bal < 0) {
                                  {{ -bal | number: '1.2-2' }} banked
                                } @else {
                                  level
                                }
                                @if (e.reconciledRunningDeficit !== null) {
                                  <span
                                    class="sub restated"
                                    [title]="
                                      'The chain booked ' +
                                      (e.runningDeficit | number: '1.2-2') +
                                      ' here. Reconciliation against the settled broker P&L later restated this close, and the chain carried the corrected total forward — the figure shown is the balance the close actually left.'
                                    "
                                  >
                                    restated from {{ e.runningDeficit | number: '1.2-2' }}
                                  </span>
                                }
                              </td>
                              <td class="num mono">
                                @if (e.depthBefore !== null && e.depthBefore !== e.depthAfter) {
                                  {{ e.depthBefore }} → {{ e.depthAfter }}
                                } @else {
                                  {{ e.depthAfter }}
                                }
                              </td>
                              <td>
                                @switch (e.advanceOutcome) {
                                  @case ('Opened') {
                                    <span class="pill">opened the chain — depth 0</span>
                                  }
                                  @case ('Recovered') {
                                    <span class="pill ok">recovered — chain closed</span>
                                  }
                                  @case ('Abandoned') {
                                    <span class="pill bad">abandoned — deficit written off</span>
                                  }
                                  @case ('Scratch') {
                                    <span class="pill">scratch — depth held</span>
                                  }
                                  @case ('Unfunded') {
                                    <span
                                      class="pill warn"
                                      title="Traded at base size while a rung was staked — the money counts, the depth does not."
                                    >
                                      unfunded — depth held
                                    </span>
                                  }
                                  @default {
                                    @if (e.openedTheChain) {
                                      <span class="pill">opened the chain — depth 0</span>
                                    } @else if (e.burnedARung && e.outcome === 'Loss') {
                                      <span class="pill warn">lost — burned a rung</span>
                                    } @else if (e.burnedARung || e.outcome === 'Win') {
                                      <!--
                                        A win that did not fully recover the chain still escalates:
                                        only a full recovery ends a ladder, so a partial win is a
                                        failed attempt that happened to close green.
                                      -->
                                      <span class="pill warn">paid down — burned a rung</span>
                                    } @else {
                                      <span class="pill">depth held</span>
                                    }
                                  }
                                }
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                    <details class="method">
                      <summary>How to read depth and the running balance</summary>
                      <p class="foot">
                        Depth is the escalation budget: the opening loss is depth 0 and each
                        recovery rung that fails to clear the debt raises it by one. Only a
                        <b>full recovery</b>
                        of the deficit ends a ladder, so a win that merely paid some of it down
                        burns a rung just as a loss does; a break-even or an unfunded close holds.
                        @if (c.ledgerSource === 'advances') {
                          Every row is what the service actually applied. Rows are in the order the
                          ladder applied them, which is the order that made the chain — not the
                          order the broker stamped on the closes. A row marked
                          <b>restated</b> had its money corrected against the broker's settled
                          P&amp;L after the fact; the balance shown is the reconciled one, and the
                          figure the chain originally booked is beside it. Once every restatement is
                          accounted for the last balance should match the header — if it still does
                          not, the row and the chain have genuinely diverged.
                        } @else {
                          The running balance is replayed from the chain's opening loss; if its last
                          row disagrees with the header, the reconstruction has attributed the wrong
                          closes.
                        }
                      </p>
                    </details>
                  }

                  @if (c.status === 'Open') {
                    <!--
                      The escape hatch for a stuck chain. A terminal close, not an in-place zeroing:
                      the deficit is written off and stays inspectable on the Abandoned row, sizing
                      reverts to base immediately, and the next loss opens a fresh chain at depth 0.
                    -->
                    <div class="reset">
                      @if (resettingId() === c.id) {
                        <input
                          type="text"
                          class="reset-reason"
                          placeholder="Why? Required — recorded verbatim on the chain."
                          [ngModel]="resetReason()"
                          (ngModelChange)="resetReason.set($event)"
                          [disabled]="resetBusy()"
                        />
                        <button
                          type="button"
                          class="btn-danger"
                          [disabled]="resetBusy() || !resetReason().trim()"
                          (click)="confirmReset(c.id)"
                        >
                          {{
                            resetBusy()
                              ? 'Resetting…'
                              : 'Write off ' +
                                (c.deficitAmount > 0
                                  ? (c.deficitAmount | number: '1.2-2')
                                  : 'chain') +
                                ' & reset'
                          }}
                        </button>
                        <button
                          type="button"
                          class="btn-plain"
                          [disabled]="resetBusy()"
                          (click)="cancelReset()"
                        >
                          Cancel
                        </button>
                        @if (resetError(); as re) {
                          <span class="warn-line">{{ re }}</span>
                        }
                      } @else {
                        <button type="button" class="btn-danger-outline" (click)="openReset(c.id)">
                          Reset chain…
                        </button>
                        <span class="dim">
                          Writes off the deficit, closes the chain as Abandoned, and reverts the
                          symbol to base sizing with no chain. The next loss opens a fresh chain at
                          depth 0.
                        </span>
                      }
                    </div>
                  }
                </div>
              }
            </article>
          }
        }
      </section>

      <!-- Laddered pairs, including ones with no chain yet. -->
      <section class="symbols card">
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
                  <th class="num" title="Model estimate at the profile's assumed ~0.5R geometry">
                    Worst case (model)
                  </th>
                  <th
                    class="num"
                    title="Next rung's stake at the open chain's actual entry geometry"
                  >
                    Next rung (live)
                  </th>
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
                        <span class="pill ok">active</span>
                      } @else if (!s.enabled) {
                        <span class="pill">symbol off</span>
                      } @else if (!s.profileEnabled) {
                        <span class="pill warn">profile off</span>
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
                    <td class="num">
                      @if (liveRungFor(s); as r) {
                        <span
                          [class.neg]="r.stakePctEquity > s.effectiveMaxStakePctEquity"
                          [title]="
                            'Depth ' +
                            r.depth +
                            (r.geometryR !== null
                              ? ' at ' + (r.geometryR | number: '1.2-2') + 'R'
                              : '') +
                            ' — next-rung estimate for the open chain'
                          "
                        >
                          {{ r.stakePctEquity | number: '1.1-1' }}%
                        </span>
                      } @else {
                        <span class="dim">—</span>
                      }
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
            <b>Worst case (model)</b> is the cumulative loss if every rung to the depth cap loses,
            estimated at the profile's assumed geometry (~0.5R, stake roughly tripling per rung).
            <b>Next rung (live)</b> is what the open chain would actually risk next, at the real
            entry geometry of its last close — a thin-geometry chain can need more on a single rung
            than the whole model series, which is why both are shown.
          </p>
        }
      </section>
    }
  `,
})
export class MartingaleInternalsPageComponent {
  private readonly service = inject(MartingaleService);

  readonly statusFilters = ['', 'Open', 'Recovered', 'Abandoned'] as const;
  readonly ts = TS;

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly status = signal<string>('');
  readonly expanded = signal<ReadonlySet<number>>(new Set<number>());
  /** Client-side search over the chains already loaded — never a new request. */
  readonly query = signal('');

  private readonly data = signal<MartingaleOverviewDto | null>(null);
  readonly view = computed(() => this.data());

  readonly visibleChains = computed(() => {
    const q = this.query();
    return (this.data()?.chains ?? []).filter((c) => chainMatchesQuery(c, q));
  });

  /** Open chains in view, for the "Open right now" headline. */
  readonly openNow = computed(() => (this.data()?.chains ?? []).filter((c) => c.status === 'Open'));

  /**
   * Written-off money that belongs to chains whose stored depth the ledger does not support.
   * The headline "written off" total is dominated by these (legacy replay ledgers), so the
   * scoreboard names the share rather than presenting it as a clean trading loss. Computed over
   * the chains in view — the list is capped and status-filtered — and the label says so.
   */
  readonly mismatchWriteOff = computed<{ amount: number; count: number } | null>(() => {
    const chains = this.data()?.chains ?? [];
    const rows = chains.filter((c) => c.status === 'Abandoned' && c.depthDivergesFromLedger);
    if (rows.length === 0) return null;
    return {
      amount: rows.reduce((s, c) => s + Math.max(0, c.deficitAmount), 0),
      count: rows.length,
    };
  });

  /** Open chain by id, for joining laddered symbols to their live next-rung estimate. */
  private readonly openChainById = computed(() => {
    const map = new Map<number, MartingaleChainViewDto>();
    for (const c of this.data()?.chains ?? []) if (c.status === 'Open') map.set(c.id, c);
    return map;
  });

  liveRungFor(s: { openChainId: number | null }): MartingaleChainViewDto['nextRung'] {
    if (s.openChainId == null) return null;
    return this.openChainById().get(s.openChainId)?.nextRung ?? null;
  }

  /** The service records manual resets as "Manually reset by operator at depth …: <reason>". */
  isOperatorReset(c: MartingaleChainViewDto): boolean {
    return c.status === 'Abandoned' && (c.closureReason ?? '').startsWith('Manually reset');
  }

  statusLabel(c: MartingaleChainViewDto): string {
    return this.isOperatorReset(c) ? 'Reset by operator' : c.status;
  }

  statusTone(c: MartingaleChainViewDto): Tone {
    return chainStatusTone(c.status, this.isOperatorReset(c));
  }

  verdict(r: NextRungLike): { tone: Tone; label: string } {
    return nextRungVerdict(r);
  }

  /** "Ledger ↓" in the headline: open the chain (if folded) and bring it into view. */
  jumpTo(chainId: number): void {
    if (!this.expanded().has(chainId)) this.toggle(chainId);
    if (this.query() && !this.visibleChains().some((c) => c.id === chainId)) this.query.set('');
    setTimeout(() =>
      document
        .getElementById('chain-' + chainId)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }

  constructor() {
    this.reload();
  }

  // ── Manual reset ──────────────────────────────────────────────────────────
  // Inline reason-and-confirm rather than a browser prompt: the reason is required (it becomes
  // the chain's closure record) and the destructive button must show what is being written off.
  readonly resettingId = signal<number | null>(null);
  readonly resetReason = signal('');
  readonly resetBusy = signal(false);
  readonly resetError = signal<string | null>(null);

  openReset(chainId: number): void {
    this.resettingId.set(chainId);
    this.resetReason.set('');
    this.resetError.set(null);
  }

  cancelReset(): void {
    this.resettingId.set(null);
    this.resetReason.set('');
    this.resetError.set(null);
  }

  confirmReset(chainId: number): void {
    const reason = this.resetReason().trim();
    if (!reason || this.resetBusy()) return;

    this.resetError.set(null);
    this.resetBusy.set(true);

    this.service.resetChain(chainId, reason).subscribe({
      next: () => {
        this.resetBusy.set(false);
        this.cancelReset();
        this.reload();
      },
      error: (err: unknown) => {
        this.resetBusy.set(false);
        this.resetError.set(err instanceof Error ? err.message : 'Reset failed.');
      },
    });
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
