import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import type { PatientTraderHealth } from '@features/patient-trader/patient-trader.types';
import {
  catalystLines,
  marketHealthState,
  relativeTime,
} from '@features/patient-trader/patient-trader.logic';
import { injectNow } from '../pt-clock';

/**
 * Is it working, per market, at a glance: when it last looked and why, when it looks next, and
 * every known reason it is not looking (closed market, news blackout, kill switch, spend cap). A
 * run that ended without writing a view is flagged loudly with a link to the conversation — that
 * is the "stuck" case the counters cannot show.
 */
@Component({
  selector: 'app-pt-health-strip',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-label="Is it running">
      <div class="row">
        <h2>Is it running?</h2>
        @if (health(); as h) {
          <span class="tag" [class.accent]="h.enabled && h.mode === 'Live'">
            {{ h.enabled ? h.mode : 'Switched off' }}
          </span>
          <span class="tag">{{ h.engine }} engine</span>
          @if (h.killSwitchActive) {
            <span class="tag bad">
              Kill switch on{{
                h.respectKillSwitch ? ' — standing down' : ' — ignored by this module'
              }}
            </span>
          }
          @if (problemCount() > 0) {
            <span class="tag bad"
              >{{ problemCount() }} market{{ problemCount() === 1 ? '' : 's' }} need a look</span
            >
          }
          <span class="spacer"></span>
          <span class="muted small" [title]="h.atUtc | date: 'medium'"
            >checked {{ rel(h.atUtc) }}</span
          >
        }
      </div>

      @if (error() && !health()) {
        <p class="muted small">Could not load the health check. It retries on the next refresh.</p>
      } @else if (health(); as h) {
        <div class="row small spend" aria-label="Spend today">
          <span class="muted">Spend today:</span>
          <span title="Billed API spend">paid {{ h.spend.paidToday | number: '1.2-2' }} USD</span>
          <span
            class="muted"
            title="What subscription (flat-fee) analyses would have cost at API prices — not billed"
            >· notional {{ h.spend.notionalToday | number: '1.2-2' }} USD</span
          >
          <span class="muted">
            · caps {{ h.spend.dailyCapUsd | number: '1.2-2' }} USD a day{{
              h.spend.perMarketCapUsd > 0
                ? ', ' + (h.spend.perMarketCapUsd | number: '1.2-2') + ' USD per market'
                : ''
            }}, counting {{ h.spend.capCountsNotional ? 'paid + notional' : 'paid only' }}
          </span>
          @if (h.spend.dailyCapReached) {
            <span class="tag bad">daily cap reached — no more analyses today</span>
          }
        </div>

        @if (h.markets.length === 0) {
          <p class="muted small">No markets followed. Tick some under Configuration → Markets.</p>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>State</th>
                  <th>Mode</th>
                  <th>Last look</th>
                  <th>Next look</th>
                  <th class="num">Armed</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.m.symbol) {
                  <tr [class.alert]="r.state === 'stuck' || r.state === 'overdue'">
                    <td class="mono nowrap">{{ r.m.symbol }} {{ r.m.timeframe }}</td>
                    <td class="nowrap">
                      <span class="dot" [class]="'dot ' + r.state" aria-hidden="true"></span>
                      {{ r.reason }}
                    </td>
                    <td class="nowrap">
                      {{ r.m.mode }}
                      @if (r.m.ownMode) {
                        <span
                          class="tag"
                          title="This market has its own mode rather than the module's"
                          >own mode</span
                        >
                      }
                    </td>
                    <td class="nowrap">
                      <span
                        [title]="r.m.lastViewAtUtc ? (r.m.lastViewAtUtc | date: 'medium') : ''"
                        >{{ r.m.lastViewAtUtc ? rel(r.m.lastViewAtUtc) : 'never' }}</span
                      >
                      @if (r.m.lastViewTrigger) {
                        <span class="muted"> · {{ r.m.lastViewTrigger }}</span>
                      }
                    </td>
                    <td class="nowrap" [class.warn-text]="r.state === 'overdue'">
                      <span [title]="r.m.nextDueAtUtc ? (r.m.nextDueAtUtc | date: 'medium') : ''">{{
                        r.m.nextDueAtUtc ? rel(r.m.nextDueAtUtc) : '—'
                      }}</span>
                    </td>
                    <td class="num">{{ r.m.armedCards }}</td>
                    <td class="notes">
                      @if (r.stuckRun) {
                        <span class="note bad">
                          Ran {{ rel(r.m.lastRunWithoutViewAtUtc) }} and wrote no view.
                          @if (r.m.lastRunWithoutViewSessionId; as sid) {
                            <a
                              class="linkish"
                              [routerLink]="['/conversations']"
                              [queryParams]="{ conversation: sid }"
                              >Open that run →</a
                            >
                          }
                        </span>
                      }
                      @if (r.closed) {
                        <span class="note"
                          >Market closed until {{ r.m.closedUntilUtc | date: 'EEE HH:mm'
                          }}{{ r.m.closedReason ? ' (' + r.m.closedReason + ')' : '' }}</span
                        >
                      }
                      @if (r.blackout) {
                        <span class="note warn-text"
                          >News blackout until {{ r.m.blackoutUntilUtc | date: 'HH:mm'
                          }}{{ r.m.blackoutTitle ? ' — ' + r.m.blackoutTitle : '' }}</span
                        >
                      }
                      @if (r.m.marketCapReached) {
                        <span class="note bad">Market spend cap reached</span>
                      }
                      @if (r.catalysts.length > 0) {
                        <details class="note">
                          <summary>
                            {{ r.catalysts.length }} release{{
                              r.catalysts.length === 1 ? '' : 's'
                            }}
                            coming up
                          </summary>
                          <ul>
                            @for (c of r.catalysts; track $index) {
                              <li>{{ c }}</li>
                            }
                          </ul>
                        </details>
                      }
                      @if (r.m.paidToday > 0 || r.m.notionalToday > 0) {
                        <span class="note muted"
                          >Today: paid {{ r.m.paidToday | number: '1.2-2' }} · notional
                          {{ r.m.notionalToday | number: '1.2-2' }} USD</span
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
    </section>
  `,
  styleUrls: ['../pt-common.css'],
  styles: [
    `
      .spend {
        gap: 6px;
      }
      .table-wrap {
        overflow-x: auto;
        max-height: 360px;
        overflow-y: auto;
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
      td.num,
      th.num {
        text-align: right;
      }
      .nowrap {
        white-space: nowrap;
      }
      tr.alert td:first-child {
        box-shadow: inset 3px 0 0 var(--loss, #b91c1c);
      }
      .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 4px;
        background: var(--text-tertiary);
      }
      .dot.ok {
        background: var(--profit, #15803d);
      }
      .dot.paused {
        background: #b45309;
      }
      .dot.overdue,
      .dot.stuck {
        background: var(--loss, #b91c1c);
      }
      .notes {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 220px;
      }
      .note.bad {
        color: var(--loss, #b91c1c);
      }
      details.note summary {
        cursor: pointer;
        color: var(--text-secondary);
      }
      details.note ul {
        margin: 2px 0 0;
        padding-left: var(--space-4);
      }
    `,
  ],
})
export class PtHealthStripComponent {
  readonly health = input<PatientTraderHealth | null>(null);
  readonly error = input<unknown>(null);

  private readonly now = injectNow(30_000);

  protected rel(iso: string | null | undefined): string {
    return relativeTime(iso, this.now());
  }

  protected readonly rows = computed(() => {
    const h = this.health();
    if (!h) return [];
    const now = this.now();
    return h.markets.map((m) => {
      const s = marketHealthState(m, h, now);
      const lastView = m.lastViewAtUtc ? Date.parse(m.lastViewAtUtc) : 0;
      const lastEmpty = m.lastRunWithoutViewAtUtc ? Date.parse(m.lastRunWithoutViewAtUtc) : 0;
      return {
        m,
        state: s.state,
        reason: s.reason,
        stuckRun: !!m.lastRunWithoutViewAtUtc && lastEmpty > lastView,
        closed: !!m.closedUntilUtc && Date.parse(m.closedUntilUtc) > now,
        blackout: !!m.blackoutUntilUtc && Date.parse(m.blackoutUntilUtc) > now,
        catalysts: catalystLines(m.upcomingCatalysts),
      };
    });
  });

  protected readonly problemCount = computed(
    () => this.rows().filter((r) => r.state === 'stuck' || r.state === 'overdue').length,
  );
}
