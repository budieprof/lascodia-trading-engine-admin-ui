import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { when } from '@features/iam/iam.logic';
import { dayLabel, money, monthLabel, quantity } from '../billing.logic';
import type { BillingUsageMonth } from '../billing.types';

/**
 * One organisation's metered month: tiles, the estimate (clearly NOT an invoice), the days and the
 * feeds. Shared by the organisation's "Usage & billing" page and the staff billing page.
 */
@Component({
  selector: 'app-billing-usage-month',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
        padding: 12px 16px;
      }
      .tile {
        border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
        border-radius: 8px;
        padding: 10px 12px;
      }
      .tile .value {
        font-size: 1.35rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .explain {
        max-width: 520px;
      }
    `,
  ],
  template: `
    @let u = usage();
    @if (u.partial) {
      <p class="note warn" role="status">
        {{ monthLabel(u.month) }} is still open: today's figures and days not yet closed can still
        change.
      </p>
    }
    <section class="card">
      <header class="card-head">
        <h3>{{ monthLabel(u.month) }} at a glance</h3>
        <span class="spacer"></span>
        <span class="muted small"
          >{{ u.days.length }} of {{ u.daysInMonth }} days metered · as of
          {{ when(u.generatedAtUtc) }}</span
        >
      </header>
      <div class="tiles">
        <div class="tile">
          <div class="muted small">Peak connected terminals</div>
          <div class="value">{{ u.peakConnectedTerminals }}</div>
          <div class="muted small">{{ u.terminalDays }} terminal-days</div>
        </div>
        <div class="tile">
          <div class="muted small">Peak active users</div>
          <div class="value">{{ u.peakActiveUsers }}</div>
        </div>
        <div class="tile">
          <div class="muted small">Licensed data feeds</div>
          <div class="value">{{ licensedFeeds() }}</div>
        </div>
        <div class="tile">
          <div class="muted small">LLM spend (platform-paid)</div>
          <div class="value">{{ u.llmUsd === null ? '—' : money(u.llmUsd, 'USD') }}</div>
        </div>
        @if (u.estimate; as e) {
          <div class="tile">
            <div class="muted small">Estimate (not an invoice)</div>
            <div class="value">{{ e.ok ? money(e.total, e.currency) : '—' }}</div>
          </div>
        }
      </div>
    </section>

    @if (u.notInvoiced) {
      <p class="note" role="status">
        House is the platform operator and is not invoiced; its usage is metered for the record.
      </p>
    } @else if (u.estimate; as e) {
      <section class="card">
        <header class="card-head">
          <h3>Estimated charges</h3>
          <span class="spacer"></span>
          <span class="muted small"
            >On the price books in force — the invoice is drafted and reviewed after the month
            ends.</span
          >
        </header>
        @if (!e.ok) {
          <p class="pad" role="alert"><span class="chip bad">Cannot price</span> {{ e.error }}</p>
        } @else if (e.lines.length === 0) {
          <p class="pad muted">Nothing is charged on the price books in force.</p>
        } @else {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Line</th>
                  <th class="num">Quantity</th>
                  <th class="num">Unit price</th>
                  <th class="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                @for (l of e.lines; track l.sortOrder) {
                  <tr>
                    <td>
                      {{ l.description }}
                      <span class="sub explain">{{ l.explanation }}</span>
                    </td>
                    <td class="num">{{ quantity(l.quantity) }}</td>
                    <td class="num">{{ l.unitPrice }}</td>
                    <td class="num">{{ money(l.amount, e.currency) }}</td>
                  </tr>
                }
                <tr>
                  <td><strong>Total (no tax computed)</strong></td>
                  <td></td>
                  <td></td>
                  <td class="num">
                    <strong>{{ money(e.total, e.currency) }}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        }
        @if (e.warnings.length) {
          <ul class="pad small">
            @for (w of e.warnings; track $index) {
              <li>{{ w }}</li>
            }
          </ul>
        }
      </section>
    }

    <section class="card">
      <header class="card-head">
        <h3>Metered days</h3>
        <span class="spacer"></span>
        <span class="muted small"
          >A terminal that heartbeats at any time on a UTC day is connected that day, however often
          it reconnects.</span
        >
      </header>
      @if (u.days.length === 0) {
        <p class="pad muted">No metered days in this month yet.</p>
      } @else {
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th>Plan</th>
                <th class="num">Terminals</th>
                <th class="num">Active users</th>
                <th>Modules</th>
                <th>Licensed feeds</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              @for (d of days(); track d.dayUtc) {
                <tr>
                  <td>{{ dayLabel(d.dayUtc) }}</td>
                  <td>
                    <code>{{ d.planSlug }}</code>
                  </td>
                  <td class="num">{{ d.connectedTerminals }}</td>
                  <td class="num">{{ d.activeUsers }}</td>
                  <td class="small">{{ modules(d) || '—' }}</td>
                  <td class="small">
                    {{ d.licensedFeeds.join(', ') || '—' }}
                    @if (d.feedsDegraded) {
                      <span class="chip warn" title="Licences could not be read at some pass"
                        >incomplete</span
                      >
                    }
                  </td>
                  <td>
                    <span class="chip" [class.ok]="d.isClosed" [class.warn]="!d.isClosed">{{
                      d.isClosed ? 'Closed' : 'Open'
                    }}</span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    @if (u.feeds.length) {
      <section class="card">
        <header class="card-head"><h3>Market-data use</h3></header>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Feed</th>
                <th class="num">Licensed days</th>
                <th class="num">Display users</th>
                <th class="num">Machines / algorithms</th>
                <th class="num">Reads</th>
              </tr>
            </thead>
            <tbody>
              @for (f of u.feeds; track f.feedId) {
                <tr>
                  <td>
                    <code>{{ f.feedId }}</code>
                  </td>
                  <td class="num">{{ f.licensedDays }}</td>
                  <td class="num">{{ f.distinctDisplayUsers }}</td>
                  <td class="num">{{ f.distinctNonDisplayUsers }}</td>
                  <td class="num">{{ f.accesses }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
})
export class UsageMonthViewComponent {
  readonly usage = input.required<BillingUsageMonth>();

  protected readonly when = when;
  protected readonly money = money;
  protected readonly quantity = quantity;
  protected readonly monthLabel = monthLabel;
  protected readonly dayLabel = dayLabel;

  readonly days = computed(() => [...this.usage().days].reverse());
  readonly licensedFeeds = computed(
    () => new Set(this.usage().days.flatMap((d) => d.licensedFeeds)).size,
  );

  protected modules(d: {
    propModule: boolean;
    brokerModule: boolean;
    fundModule: boolean;
  }): string {
    return [d.propModule ? 'Prop' : '', d.brokerModule ? 'Broker' : '', d.fundModule ? 'Fund' : '']
      .filter(Boolean)
      .join(', ');
  }
}
