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
import { catchError, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import type { RiskProfileDto, StrategyDto, StrategyVersionDto } from '@core/api/api.types';
import { ago, day } from '../../util/figures';
import { isScriptStrategy } from '@features/scripting/shared/script-strategy';
import { TAB_FIELDS, savedEntries, versionChanges, type EditTab } from './edit-context.logic';

interface GuideRow {
  field: string;
  help: string;
}

/** What each form tab's fields do, and what a blank one falls back to. */
const GUIDE: Record<EditTab, GuideRow[]> = {
  inputs: [
    {
      field: 'Script inputs',
      help: 'Values for the script’s input() declarations; blank keeps the script’s default.',
    },
  ],
  risk: [
    {
      field: 'Stop-loss / take-profit mode',
      help: 'How the engine places SL/TP for this strategy’s signals (ATR multiple, fixed pips, …). Inherit = the signal’s own levels within the risk profile’s minimum distances.',
    },
    {
      field: 'Multiplier',
      help: 'The ATR multiple or pip distance for the chosen mode; ignored until a mode is chosen.',
    },
    {
      field: 'Trailing stop (× ATR)',
      help: 'Distance the EA trails at, in ATRs of the strategy timeframe. Blank = no strategy trailing (the account / EA setting applies).',
    },
    { field: 'Trailing ATR period', help: 'Bars used for that ATR. Blank = 14.' },
    {
      field: 'Max open positions',
      help: 'Rule strategies only, 1–100. Pine scripts use their own pyramiding. Blank = 1.',
    },
  ],
  sizing: [
    {
      field: 'Sizing method',
      help: 'Fixed lots, risk % of equity, or volatility-scaled. Blank = the risk profile sizes the trade from its max risk per trade.',
    },
    {
      field: 'Risk / lot values',
      help: 'Never above the risk profile’s caps (max lot, max risk per trade, max absolute risk) — those always win.',
    },
  ],
  filters: [
    {
      field: 'Sessions',
      help: 'Only signal inside the ticked trading sessions (New York time). None ticked = every session.',
    },
    {
      field: 'Days / hours',
      help: 'Optional extra windows; blank = no restriction. The engine-wide news blackout still applies unless the strategy is exempt.',
    },
  ],
  gates: [
    {
      field: 'Regime gate',
      help: 'Signals fire only in the ticked market regimes of the strategy’s symbol/timeframe. None ticked = no gate.',
    },
    {
      field: 'Multi-timeframe gate',
      help: 'Requires a higher-timeframe indicator condition (e.g. H4 EMA rising) before a signal passes. Blank = no gate.',
    },
  ],
};

/** A Pine script sizes its own orders; the form shows no sizing fields for it. */
const SCRIPT_SIZING_GUIDE: GuideRow[] = [
  {
    field: 'Order size',
    help: 'Set in the script: default_qty_type / default_qty_value in strategy(), or qty on an order — in TradingView units (100,000 = one EURUSD lot).',
  },
  {
    field: 'Per-account size',
    help: 'Each bound account trades that size times its binding’s lot multiplier (Execution tab).',
  },
  {
    field: 'Caps',
    help: 'The risk profile’s max lot, max risk per trade and max absolute risk below always clamp the result.',
  },
];

/**
 * Beside the strategy edit form: what the current tab's fields mean, what is saved now, what a blank field
 * inherits (the strategy's risk profile, or the default one) and the recent changes from its version history.
 */
@Component({
  selector: 'app-strategy-edit-context',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="grid">
      <section class="card">
        <h3>{{ tabTitle() }} — field guide</h3>
        <dl>
          @for (g of guide(); track g.field) {
            <div>
              <dt>{{ g.field }}</dt>
              <dd>{{ g.help }}</dd>
            </div>
          }
        </dl>
      </section>

      <section class="card">
        <h3>Saved now</h3>
        @if (tab() === 'inputs') {
          <p class="muted">
            {{ inputCount() }} input override(s) saved{{
              inputCount() ? '' : ' — every input runs on the script’s default'
            }}.
          </p>
        } @else {
          @for (f of fields(); track f.key) {
            <h4>{{ f.label }}</h4>
            @if (f.entries.length === 0) {
              <p class="muted">Nothing set — {{ f.blankMeans }}</p>
            } @else {
              <table>
                <tbody>
                  @for (e of f.entries; track e.path) {
                    <tr>
                      <td class="mono">{{ e.path }}</td>
                      <td class="mono val">{{ e.value }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          }
        }
        @if (tab() === 'filters') {
          <p class="muted">
            News blackout:
            {{ strategy().newsBlackoutExempt ? 'EXEMPT (audited opt-out)' : 'applies' }}.
          </p>
        }
      </section>

      <section class="card">
        <h3>
          Inherited from the risk profile
          <span class="muted">{{ profileSource() }}</span>
        </h3>
        @if (profile(); as p) {
          <table>
            <tbody>
              @for (r of profileRows(); track r[0]) {
                <tr>
                  <td>{{ r[0] }}</td>
                  <td class="num">{{ r[1] }}</td>
                </tr>
              }
            </tbody>
          </table>
          <a [routerLink]="['/risk-profiles']" class="small">Risk profiles →</a>
        } @else {
          <p class="muted">{{ profileLoaded() ? 'No risk profile found.' : 'Loading…' }}</p>
        }
      </section>

      <section class="card">
        <h3>Recent changes <span class="muted">from its version history</span></h3>
        @if (changes() === null) {
          <p class="muted">Loading…</p>
        } @else if (changes()!.length === 0) {
          <p class="muted">
            No version captured — its settings have not changed since it was created
            {{ day(strategy().createdAt) }}.
          </p>
        } @else {
          <ul class="changes">
            @for (c of changes(); track c.version.id) {
              <li>
                <strong>v{{ c.version.versionNumber }}</strong> ·
                {{ day(c.version.capturedAt) }} ({{ ago(c.version.capturedAt) }})
                <span class="muted"
                  >{{ c.changed.length ? c.changed.join(', ') : 'first capture' }}
                  {{ c.version.changeReason ? '— ' + c.version.changeReason : ''
                  }}{{ c.version.createdBy ? ' · ' + c.version.createdBy : '' }}</span
                >
              </li>
            }
          </ul>
        }
      </section>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        margin-top: var(--space-4);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--space-3);
      }
      @media (max-width: 1000px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-width: 0;
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      h4 {
        margin: var(--space-2) 0 0;
        font-size: var(--text-sm);
      }
      dl {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      dt {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      dd {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.45;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      td {
        padding: 4px 6px;
        border-bottom: 1px solid var(--border);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
      }
      .val {
        overflow-wrap: anywhere;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        font-weight: normal;
        margin: 0;
      }
      .small {
        font-size: var(--text-xs);
      }
      .changes {
        margin: 0;
        padding-left: 18px;
        font-size: var(--text-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
    `,
  ],
})
export class StrategyEditContextComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly riskProfiles = inject(RiskProfilesService);

  readonly strategy = input.required<StrategyDto>();
  readonly tab = input<EditTab>('inputs');

  protected readonly profile = signal<RiskProfileDto | null>(null);
  protected readonly profileLoaded = signal(false);
  private readonly versions = signal<StrategyVersionDto[] | null>(null);
  protected readonly day = day;
  protected readonly ago = ago;

  constructor() {
    effect(() => {
      const s = this.strategy();
      untracked(() => this.load(s));
    });
  }

  private load(s: StrategyDto): void {
    const profile$ = s.riskProfileId
      ? this.riskProfiles.getById(s.riskProfileId).pipe(map((r) => r?.data ?? null))
      : this.riskProfiles
          .list({ currentPage: 1, itemCountPerPage: 100, filter: null })
          .pipe(map((r) => (r?.data?.data ?? []).find((p) => p.isDefault) ?? null));
    profile$.pipe(catchError(() => of(null))).subscribe((p) => {
      this.profile.set(p);
      this.profileLoaded.set(true);
    });
    this.strategies
      .getVersions(s.id, 8)
      .pipe(catchError(() => of(null)))
      .subscribe((r) => this.versions.set(r?.data ?? []));
  }

  protected readonly tabTitle = computed(
    () =>
      ({ inputs: 'Inputs', risk: 'Risk', sizing: 'Sizing', filters: 'Filters', gates: 'Gates' })[
        this.tab()
      ],
  );
  protected readonly guide = computed(() =>
    this.tab() === 'sizing' && isScriptStrategy(this.strategy())
      ? SCRIPT_SIZING_GUIDE
      : GUIDE[this.tab()],
  );
  protected readonly inputCount = computed(() => {
    const raw = this.strategy().scriptInputs;
    if (!raw) return 0;
    if (typeof raw !== 'string') return Object.keys(raw).length;
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === 'object' ? Object.keys(v).length : 0;
    } catch {
      return 0;
    }
  });

  protected readonly fields = computed(() =>
    TAB_FIELDS[this.tab()].map((f) => ({
      ...f,
      entries: savedEntries(this.strategy()[f.key]),
      blankMeans:
        f.key === 'riskOverridesJson'
          ? 'SL/TP/trailing come from the signal within the risk profile below.'
          : f.key === 'sizingConfigJson'
            ? 'the risk profile below sizes every trade.'
            : f.key === 'sessionFilterJson'
              ? 'it may signal in every session.'
              : 'no gate.',
    })),
  );

  protected readonly profileSource = computed(() =>
    this.strategy().riskProfileId
      ? `assigned: ${this.profile()?.name ?? '#' + this.strategy().riskProfileId}`
      : `none assigned — the default${this.profile() ? ' (' + this.profile()!.name + ')' : ''} applies unless the account has its own`,
  );

  protected readonly profileRows = computed<[string, string][]>(() => {
    const p = this.profile();
    if (!p) return [];
    const rows: [string, string][] = [];
    const t = this.tab();
    if (t === 'risk' || t === 'inputs' || t === 'gates' || t === 'filters')
      rows.push(
        ['Stop loss required', p.requireStopLoss ? 'yes' : 'no'],
        ['Min stop distance', `${p.minStopLossDistancePips} pips`],
        ['Min reward : risk', `${p.minRiskRewardRatio}`],
        ['Max open positions', `${p.maxOpenPositions}`],
        ['Max positions per symbol', `${p.maxPositionsPerSymbol}`],
        ['Max spread', `${p.maxSpreadPips} pips`],
      );
    if (t === 'sizing' || t === 'inputs')
      rows.push(
        ['Max risk per trade', `${p.maxRiskPerTradePct}%`],
        ['Max lot per trade', `${p.maxLotSizePerTrade}`],
        ['Max absolute risk per trade', `${p.maxAbsoluteRiskPerTrade}`],
        ['Max symbol exposure', `${p.maxSymbolExposurePct}%`],
      );
    if (t === 'filters' || t === 'gates')
      rows.push(
        ['Max daily trades', `${p.maxDailyTrades}`],
        ['Loss-streak cooldown', `${p.consecutiveLossCooldownMinutes} min`],
      );
    return rows;
  });

  protected readonly changes = computed(() => {
    const v = this.versions();
    return v === null ? null : versionChanges(v);
  });
}
