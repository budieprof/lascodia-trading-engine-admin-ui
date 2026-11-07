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
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { BacktestRunDto } from '@core/api/api.types';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { BacktestsService } from '@core/services/backtests.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { describeFailure } from '@features/scripting/shared/api-error';
import { ConfigHashBadgeComponent } from '@features/strategies/components/config-hash-badge/config-hash-badge.component';
import { COCKPIT_CARD_STYLES } from '@features/strategies/research-cockpit/cockpit.styles';
import { ResearchCockpitApiService } from '@features/strategies/research-cockpit/research-cockpit-api.service';
import type { BacktestRunDiffDto } from '@features/strategies/research-cockpit/research-cockpit.types';

import { intrabarEvidence, manifestView } from './run-manifest.model';
import { evidenceInvalidation, queueSourceLabel } from '../../run-provenance';

/** C9 fields the engine stores on a run; on the DTO only once the engine maps them (optional). */
export type ManifestRun = BacktestRunDto & {
  manifestJson?: string | null;
  dataFingerprint?: string | null;
  strategyConfigHash?: string | null;
};

const VERDICT_TONE: Record<string, string> = {
  identical: 'ok',
  reproduced: 'ok',
  'inputs differ': 'warn',
  'results differ': 'bad',
};

/**
 * U11 / U12 — a backtest's provenance for ANY run (script or legacy rules): the run manifest (C9), the intrabar evidence
 * of its fills (C3: ambiguous bars, magnifier coverage), an exact re-run (analyst action, confirm dialog) and a diff
 * against another run of the strategy (manifest inputs, metrics, trades).
 */
@Component({
  selector: 'app-run-manifest-card',
  standalone: true,
  imports: [RouterLink, ConfirmDialogComponent, ConfigHashBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="rm-title" data-testid="run-manifest">
      <header class="head">
        <h3 id="rm-title" class="title">How this run was made</h3>
        <app-config-hash-badge [hash]="run().strategyConfigHash ?? manifestHash()" />
        @if (manifest()?.rerunOfRunId; as of) {
          <span class="chip"
            >re-run of <a [routerLink]="['/backtests', of]">#{{ of }}</a></span
          >
        }
        <span class="spacer"></span>
        @if (canRerun() && run().status === 'Completed') {
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            [disabled]="busy()"
            (click)="confirmRerun.set(true)"
            data-testid="rm-rerun"
          >
            Re-run exactly
          </button>
        }
      </header>
      @if (rerunNotice(); as n) {
        <p class="note" role="status">
          {{ n.text }}
          @if (n.id) {
            <a [routerLink]="['/backtests', n.id]">Open run #{{ n.id }}</a>
          }
        </p>
      }
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      }

      @if (manifest(); as m) {
        <div class="sections">
          @for (s of m.sections; track s.title) {
            <div>
              <h4 class="sub">{{ s.title }}</h4>
              <table>
                <tbody>
                  @for (r of s.rows; track r.label) {
                    <tr>
                      <th scope="row">{{ r.label }}</th>
                      <td class="mono small">{{ r.value }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
        @if (m.libraries.length > 0) {
          <p class="small">
            Libraries: <span class="mono">{{ m.libraries.join(', ') }}</span>
          </p>
        }
        @if (m.series.length > 0) {
          <details>
            <summary class="small">Data series ({{ m.series.length }})</summary>
            <table>
              <thead>
                <tr>
                  <th>Series</th>
                  <th class="num">Points</th>
                  <th>Span (UTC)</th>
                  <th>sha256</th>
                </tr>
              </thead>
              <tbody>
                @for (s of m.series; track s.key) {
                  <tr>
                    <td class="mono small">{{ s.key }}</td>
                    <td class="num">{{ s.count ?? '—' }}</td>
                    <td class="small">{{ s.span }}</td>
                    <td class="mono small">{{ s.sha }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </details>
        }
        @if (m.configKeys.length > 0) {
          <details>
            <summary class="small">
              Engine config read during the run ({{ m.configKeys.length }} keys)
            </summary>
            <table>
              <tbody>
                @for (k of m.configKeys; track k.key) {
                  <tr>
                    <td class="mono small">{{ k.key }}</td>
                    <td class="mono small">{{ k.value }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </details>
        }
      } @else {
        <p class="muted small" data-testid="rm-no-manifest">
          No run manifest on this answer — the run predates manifests, or this engine build does not
          send <code>manifestJson</code> on a backtest. Re-run and diff still work.
        </p>
      }

      @if (intrabar(); as ib) {
        <h4 class="sub">Intrabar fills</h4>
        <p class="small" data-testid="rm-intrabar">
          @if (ib.resolution) {
            Order of each bar's high and low: {{ ib.resolution }}.
          }
          @if (ib.ambiguousBars !== null) {
            {{ ib.ambiguousBars }} bar(s) had levels on both sides of the open (ambiguous).
          }
          @if (ib.coverage; as c) {
            Fill path of the walked bars: ticks {{ pct(c.tick) }} · M1 {{ pct(c.m1) }} · lower
            timeframe {{ pct(c.lower) }} · OHLC only {{ pct(c.ohlc)
            }}{{ c.bars !== null ? ' (' + c.bars + ' bars)' : '' }}.
          }
        </p>
      }

      <h4 class="sub">Compare with another run</h4>
      <div class="actions">
        <select
          class="field-input"
          aria-label="Run to compare with"
          (change)="otherId.set(+$any($event.target).value || null)"
        >
          <option value="">Pick a run of this strategy…</option>
          @for (o of others(); track o.id) {
            <option [value]="o.id">
              #{{ o.id }} · {{ o.fromDate.slice(0, 10) }} → {{ o.toDate.slice(0, 10) }} ·
              {{ o.queueSource ? queueSourceLabel(o.queueSource) : '' }}{{ isInvalidated(o) ? ' · excluded from evidence' : '' }}
            </option>
          }
        </select>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          [disabled]="!otherId() || diffing()"
          (click)="loadDiff()"
          data-testid="rm-diff"
        >
          Diff
        </button>
      </div>
      @if (diff(); as d) {
        <div class="diff" data-testid="rm-diff-result">
          <p class="small">
            <span class="chip" [attr.data-tone]="verdictTone(d.verdict)">{{ d.verdict }}</span>
            #{{ d.leftId }} vs #{{ d.rightId }} ·
            {{ d.sameDataFingerprint ? 'same data' : 'different data' }} ·
            {{ d.sameManifestInputs ? 'same inputs' : 'inputs differ' }}
          </p>
          @if (d.manifest.length > 0) {
            <table aria-label="Manifest differences">
              <thead>
                <tr>
                  <th>Input</th>
                  <th>#{{ d.leftId }}</th>
                  <th>#{{ d.rightId }}</th>
                </tr>
              </thead>
              <tbody>
                @for (m of d.manifest; track m.path) {
                  <tr>
                    <td class="mono small">{{ m.path }}</td>
                    <td class="mono small">{{ m.left ?? '—' }}</td>
                    <td class="mono small">{{ m.right ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          @if (d.metrics.length > 0) {
            <table aria-label="Metric differences">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th class="num">#{{ d.leftId }}</th>
                  <th class="num">#{{ d.rightId }}</th>
                  <th class="num">Δ</th>
                </tr>
              </thead>
              <tbody>
                @for (m of d.metrics; track m.metric) {
                  <tr>
                    <td>{{ m.metric }}</td>
                    <td class="num">{{ metric(m.metric, m.left) }}</td>
                    <td class="num">{{ metric(m.metric, m.right) }}</td>
                    <td class="num">{{ metric(m.metric, m.delta) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          @if (d.trades; as t) {
            <p class="small">
              Trades {{ t.leftTrades }} vs {{ t.rightTrades }}: {{ t.identical }} identical,
              {{ t.changed }} changed, {{ t.onlyLeft }} only in #{{ d.leftId }},
              {{ t.onlyRight }} only in #{{ d.rightId
              }}{{
                t.firstDivergenceUtc
                  ? '; first divergence ' + t.firstDivergenceUtc.slice(0, 16) + ' UTC'
                  : ''
              }}.
            </p>
          }
          @for (n of d.notes; track n) {
            <p class="muted small">{{ n }}</p>
          }
        </div>
      }
    </section>

    <app-confirm-dialog
      [open]="confirmRerun()"
      title="Re-run this backtest?"
      message="Queues an exact copy: the same strategy snapshot (script revision), inputs, options (costs, evidence policy, calibration), window and balance — on today's engine build. It counts against the plan's backtest quota like a manual run."
      confirmLabel="Queue re-run"
      [loading]="busy()"
      (confirm)="rerun()"
      (cancelled)="confirmRerun.set(false)"
    />
  `,
  styles: [
    COCKPIT_CARD_STYLES,
    `
      .sub {
        margin: var(--space-2) 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .sections {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
        gap: var(--space-3);
      }
      .diff {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      details summary {
        cursor: pointer;
      }
    `,
  ],
})
export class RunManifestCardComponent {
  private readonly api = inject(ResearchCockpitApiService);
  private readonly backtests = inject(BacktestsService);
  private readonly auth = inject(AuthService);

  readonly run = input.required<ManifestRun>();

  protected readonly queueSourceLabel = queueSourceLabel;
  protected readonly isInvalidated = (r: BacktestRunDto): boolean => evidenceInvalidation(r) !== null;

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly confirmRerun = signal(false);
  readonly rerunNotice = signal<{ text: string; id: number | null } | null>(null);
  readonly others = signal<BacktestRunDto[]>([]);
  readonly otherId = signal<number | null>(null);
  readonly diff = signal<BacktestRunDiffDto | null>(null);
  readonly diffing = signal(false);

  readonly canRerun = computed(() => this.auth.hasPermission(Permission.AccessAnalyst));
  readonly manifest = computed(() =>
    manifestView(this.run().manifestJson, this.run().dataFingerprint),
  );
  readonly manifestHash = computed(() => {
    const s = this.manifest()?.sections.find((x) => x.title === 'Strategy');
    return s?.rows.find((r) => r.label === 'Configuration (C1)')?.value ?? null;
  });
  readonly intrabar = computed(() => intrabarEvidence(this.run().resultJson));

  constructor() {
    effect(() => {
      const r = this.run();
      untracked(() => void this.loadOthers(r.strategyId, r.id));
    });
  }

  private async loadOthers(strategyId: number, selfId: number): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.backtests.list({
          currentPage: 1,
          itemCountPerPage: 50,
          filter: { strategyId, status: 'Completed' },
          sortBy: 'id',
          sortDirection: 'desc',
        }),
      );
      this.others.set((res?.data?.data ?? []).filter((r) => r.id !== selfId));
    } catch {
      this.others.set([]);
    }
  }

  async rerun(): Promise<void> {
    if (!this.canRerun()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.rerun(this.run().id));
      if (res?.status)
        this.rerunNotice.set({ text: `Re-run queued as #${res.data}.`, id: res.data });
      else this.error.set(describeFailure(res, 'The re-run was refused.'));
    } catch (err) {
      this.error.set(describeFailure(err, 'The re-run was refused.'));
    } finally {
      this.busy.set(false);
      this.confirmRerun.set(false);
    }
  }

  async loadDiff(): Promise<void> {
    const other = this.otherId();
    if (!other) return;
    this.diffing.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.diff(this.run().id, other));
      if (res?.status && res.data) this.diff.set(res.data);
      else this.error.set(describeFailure(res, 'The runs could not be compared.'));
    } catch (err) {
      this.error.set(describeFailure(err, 'The runs could not be compared.'));
    } finally {
      this.diffing.set(false);
    }
  }

  verdictTone(v: string): string {
    return VERDICT_TONE[v] ?? '';
  }

  pct(v: number | null): string {
    return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
  }

  /** Units as the engine states them: TotalReturn / MaxDrawdownPct PERCENT, WinRate FRACTION. */
  metric(name: string, v: number | null): string {
    if (v === null || v === undefined) return '—';
    const n = name.toLowerCase();
    if (n === 'winrate') return `${(v * 100).toFixed(1)}%`;
    if (n === 'totalreturn' || n.endsWith('pct')) return `${v.toFixed(2)}%`;
    if (n === 'profitfactor' && v >= 9999) return '∞';
    return Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(4);
  }
}
