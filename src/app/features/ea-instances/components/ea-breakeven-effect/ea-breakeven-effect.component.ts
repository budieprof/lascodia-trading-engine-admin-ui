import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, of } from 'rxjs';
import {
  PositionsService,
  type BreakevenCounterfactualDto,
} from '@core/services/positions.service';

/**
 * What the trail-to-break-even rule did on one trading account: every trade it moved to entry, beside the same trade
 * replayed with its original stop and target (engine `GET /position/breakeven-counterfactual`).
 *
 * <p>Reporting only. On 2026-11-24 the rule had cut 4 Patient Trader winners and saved 5 losers (net −2.5R over 20
 * trades) while being roughly neutral across all trades, and no alternative trigger beat it in both halves of the data;
 * the operator chose to keep it and measure. This is that measurement, next to the switch it informs.</p>
 */
@Component({
  selector: 'app-ea-breakeven-effect',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe],
  template: `
    <div class="bee">
      <div class="bee-head">
        <span class="bee-title">What break-even did on this account</span>
        <span class="bee-days">
          @for (d of dayOptions; track d) {
            <button type="button" class="bee-day" [class.on]="days() === d" (click)="days.set(d)">
              {{ d }}d
            </button>
          }
        </span>
      </div>

      @if (loading()) {
        <p class="muted small">Measuring…</p>
      } @else if (error()) {
        <p class="bad small">Could not load the report: {{ error() }}</p>
      } @else if (report(); as r) {
        @if (r.summary.trades === 0) {
          <p class="muted small">
            The rule moved no trades on this account in the last {{ r.days }} days.
          </p>
        } @else {
          <p
            class="bee-verdict"
            [class.good]="r.summary.netEffectR > 0"
            [class.bad]="r.summary.netEffectR < 0"
          >
            {{ verdict() }}
          </p>
          <p class="muted small">
            {{ r.summary.resolved }} of {{ r.summary.trades }} moved trades are settled:
            {{ r.summary.cutWinners }} would have reached their target without the rule (winners
            cut), {{ r.summary.savedLosers }} would have hit their original stop (losers saved).
          </p>

          @if (r.bySource.length > 1 || r.byPlannedR.length > 1) {
            <table class="bee-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Trades</th>
                  <th title="Would have reached the target without the rule">Cut</th>
                  <th title="Would have hit the original stop without the rule">Saved</th>
                  <th title="Realised R minus R without the rule">Effect</th>
                </tr>
              </thead>
              <tbody>
                @for (g of r.bySource; track g.key) {
                  <tr>
                    <td>{{ label(g.key) }}</td>
                    <td>{{ g.trades }}</td>
                    <td>{{ g.cutWinners }}</td>
                    <td>{{ g.savedLosers }}</td>
                    <td [class.good]="g.netEffectR > 0" [class.bad]="g.netEffectR < 0">
                      {{ signed(g.netEffectR) }}R
                    </td>
                  </tr>
                }
                @for (g of r.byPlannedR; track g.key) {
                  <tr class="bee-sub">
                    <td>target {{ g.key }}</td>
                    <td>{{ g.trades }}</td>
                    <td>{{ g.cutWinners }}</td>
                    <td>{{ g.savedLosers }}</td>
                    <td [class.good]="g.netEffectR > 0" [class.bad]="g.netEffectR < 0">
                      {{ signed(g.netEffectR) }}R
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }

          <details class="bee-trades">
            <summary class="small">Each trade ({{ r.trades.length }})</summary>
            <table class="bee-table">
              <thead>
                <tr>
                  <th>Moved</th>
                  <th>Trade</th>
                  <th>Target</th>
                  <th>Closed at</th>
                  <th>Without the rule</th>
                  <th>Effect</th>
                </tr>
              </thead>
              <tbody>
                @for (t of r.trades; track t.positionId) {
                  <tr>
                    <td class="mono">{{ t.movedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</td>
                    <td>
                      {{ t.symbol }} {{ t.direction === 'Long' ? 'buy' : 'sell' }}
                      <span class="muted">· {{ label(t.source) }}</span>
                    </td>
                    <td>{{ t.plannedR | number: '1.1-2' }}R</td>
                    <td>{{ t.realisedR === null ? 'still open' : signed(t.realisedR) + 'R' }}</td>
                    <td>{{ outcome(t.withoutRule, t.withoutRuleR) }}</td>
                    <td [class.good]="(t.effectR ?? 0) > 0" [class.bad]="(t.effectR ?? 0) < 0">
                      {{ t.effectR === null ? '—' : signed(t.effectR) + 'R' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </details>
          <p class="muted tiny">{{ r.basis }}</p>
        }
      }
    </div>
  `,
  styles: [
    `
      .bee {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px dashed var(--border, rgba(127, 127, 127, 0.3));
      }
      .bee-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }
      .bee-title {
        font-weight: 600;
        font-size: 13px;
      }
      .bee-days {
        display: inline-flex;
        gap: 4px;
      }
      .bee-day {
        border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
        background: none;
        border-radius: 4px;
        padding: 1px 6px;
        font-size: 11px;
        cursor: pointer;
        color: inherit;
      }
      .bee-day.on {
        background: var(--accent-soft, rgba(41, 98, 255, 0.12));
        border-color: var(--accent, #2962ff);
      }
      .bee-verdict {
        margin: 8px 0 2px;
        font-weight: 600;
      }
      .bee-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        margin-top: 6px;
      }
      .bee-table th,
      .bee-table td {
        text-align: left;
        padding: 3px 6px;
        border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.15));
      }
      .bee-table th {
        font-weight: 500;
        opacity: 0.75;
      }
      .bee-sub td:first-child {
        padding-left: 14px;
        opacity: 0.85;
      }
      .bee-trades {
        margin-top: 6px;
      }
      .good {
        color: var(--success, #089981);
      }
      .bad {
        color: var(--danger, #f23645);
      }
      .tiny {
        font-size: 11px;
        margin-top: 6px;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
    `,
  ],
})
export class EaBreakevenEffectComponent {
  private readonly positions = inject(PositionsService);

  readonly tradingAccountId = input<number | null>(null);

  protected readonly dayOptions = [30, 90, 180] as const;
  protected readonly days = signal<number>(90);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly report = signal<BreakevenCounterfactualDto | null>(null);

  /** The headline in plain words. */
  protected readonly verdict = computed(() => {
    const r = this.report();
    if (!r) return '';
    const n = r.summary.netEffectR;
    const span = `over the last ${r.days} days`;
    if (r.summary.resolved === 0)
      return `Too early to tell ${span}: no moved trade has settled yet.`;
    if (Math.abs(n) < 0.05) return `Break-even made no difference ${span}.`;
    return n > 0
      ? `Break-even earned ${n.toFixed(2)}R ${span} (it saved more than it cut).`
      : `Break-even cost ${Math.abs(n).toFixed(2)}R ${span} (it cut more than it saved).`;
  });

  constructor() {
    effect(() => {
      const account = this.tradingAccountId();
      const days = this.days();
      if (account == null) return;
      untracked(() => this.load(account, days));
    });
  }

  private load(account: number, days: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.positions
      .getBreakevenCounterfactual(days, account)
      .pipe(
        catchError((e: unknown) => {
          this.error.set(e instanceof Error ? e.message : 'request failed');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (!res) {
          this.report.set(null);
          return;
        }
        if (!res.status || !res.data) {
          this.error.set(res.message || 'no data');
          this.report.set(null);
          return;
        }
        this.report.set(res.data);
      });
  }

  protected label(source: string | null): string {
    switch (source) {
      case 'PatientTrader':
        return 'Patient Trader';
      case 'SpotAnalysis':
        return 'Spot analysis';
      case null:
      case undefined:
      case 'unknown':
        return 'other';
      default:
        return source;
    }
  }

  protected signed(r: number): string {
    return (r > 0 ? '+' : '') + r.toFixed(2);
  }

  protected outcome(label: string, r: number | null): string {
    if (label === 'HitTP') return `target, +${(r ?? 0).toFixed(2)}R`;
    if (label === 'HitSL') return 'original stop, −1R';
    return 'not reached yet';
  }
}
