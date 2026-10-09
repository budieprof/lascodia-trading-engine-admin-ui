import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { StrategiesService } from '@core/services/strategies.service';

import { parseSavedInputs } from '../pine/pine-saved-inputs';
import { scriptSourceHash } from '../shared/sha256';
import {
  inputDifferences,
  inputValueText,
  type InputDifference,
  type RunProvenance,
} from './engine-run';
import { formatDateTime, formatInteger, formatMoney } from './report-format';

type ScriptState = 'same' | 'changed' | 'unknown';

interface CurrentScript {
  hash: string;
  inputs: Record<string, unknown>;
}

/**
 * How a script backtest was made (PE-13 / PE-I1): the script it ran (its hash against the
 * strategy's script now), the inputs applied and the ones left out, compile warnings, whether an
 * operator queued it by hand, deep / magnifier / news-shock modes, the cost model, the data and the
 * capital. A strip of chips with the details folded underneath.
 */
@Component({
  selector: 'app-run-provenance',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = provenance();
    <section class="prov" aria-label="How this run was made" data-testid="run-provenance">
      <div class="strip">
        <span class="strip-title">Provenance</span>
        <span
          class="chip"
          data-testid="prov-script"
          [attr.data-tone]="
            scriptState() === 'changed' ? 'warn' : scriptState() === 'same' ? 'ok' : ''
          "
          [title]="'Script hash ' + (p.sourceHash || 'unknown')"
        >
          {{ scriptText() }}
        </span>
        <span
          class="chip"
          data-testid="prov-inputs"
          [attr.data-tone]="inputDiffs().length ? 'warn' : ''"
        >
          {{ inputsText() }}
        </span>
        @if (p.ignoredInputs.length > 0) {
          <span class="chip" data-tone="warn" data-testid="prov-ignored">
            {{ p.ignoredInputs.length }} input{{ p.ignoredInputs.length === 1 ? '' : 's' }} ignored
          </span>
        }
        @if (p.compileWarnings.length > 0) {
          <span class="chip" data-tone="warn" data-testid="prov-warnings">
            {{ p.compileWarnings.length }} compile warning{{
              p.compileWarnings.length === 1 ? '' : 's'
            }}
          </span>
        }
        @if (p.operatorAdHoc) {
          <span
            class="chip"
            data-testid="prov-adhoc"
            title="Queued by an operator, not by the pipeline or an optimization run"
            >Queued by hand</span
          >
        }
        @if (p.deep) {
          <span class="chip">Deep backtest</span>
        }
        @if (p.barMagnifier) {
          <span class="chip">Bar magnifier</span>
        }
        @if (p.priceShock) {
          <span
            class="chip"
            data-tone="warn"
            title="The adversarial gate's synthetic news shock moved prices in this run"
            >News shock applied</span
          >
        }
      </div>

      <details class="details">
        <summary>How this run was made</summary>
        <dl>
          <div>
            <dt>Script</dt>
            <dd>
              <span class="mono">{{ p.sourceHash || '—' }}</span>
              @if (p.languageVersion !== null) {
                · Pine v{{ p.languageVersion }}
              }
              · {{ scriptExplanation() }}
            </dd>
          </div>
          <div>
            <dt>Inputs applied</dt>
            <dd>
              @if (inputEntries().length === 0) {
                Every input at its default.
              } @else {
                <ul>
                  @for (e of inputEntries(); track e[0]) {
                    <li>
                      <span class="mono">{{ e[0] }}</span> = <span class="mono">{{ e[1] }}</span>
                    </li>
                  }
                </ul>
              }
            </dd>
          </div>
          @if (inputDiffs().length > 0) {
            <div data-testid="prov-input-diffs">
              <dt>Inputs now</dt>
              <dd>
                The strategy's inputs differ from this run's:
                <ul>
                  @for (d of inputDiffs(); track d.id) {
                    <li>
                      <span class="mono">{{ d.id }}</span
                      >: {{ d.run ?? 'default' }} in this run → {{ d.now ?? 'default' }} now
                    </li>
                  }
                </ul>
              </dd>
            </div>
          }
          @if (p.ignoredInputs.length > 0) {
            <div>
              <dt>Ignored inputs</dt>
              <dd>
                <ul>
                  @for (i of p.ignoredInputs; track $index) {
                    <li>{{ i }}</li>
                  }
                </ul>
              </dd>
            </div>
          }
          @if (p.compileWarnings.length > 0) {
            <div>
              <dt>Compile warnings</dt>
              <dd>
                <ul>
                  @for (w of p.compileWarnings; track $index) {
                    <li class="mono">{{ w }}</li>
                  }
                </ul>
              </dd>
            </div>
          }
          @if (p.costModel) {
            <div>
              <dt>Costs</dt>
              <dd>
                {{ p.costModel }}
                @if (p.costModelReason) {
                  — {{ p.costModelReason }}
                }
              </dd>
            </div>
          }
          <div>
            <dt>Data</dt>
            <dd>{{ dataText() }}</dd>
          </div>
          @if (p.initialCapital !== null) {
            <div>
              <dt>Capital</dt>
              <dd>
                {{ money(p.initialCapital, p.accountCurrency) }}
                {{
                  p.capitalSource === 'Script'
                    ? "(the script's initial_capital)"
                    : p.capitalSource === 'EngineDefault'
                      ? "(the engine's default — the script declares none)"
                      : ''
                }}
              </dd>
            </div>
          }
          @if (p.elapsedMs !== null) {
            <div>
              <dt>Run</dt>
              <dd>
                {{ int(p.elapsedMs) }} ms
                @if (p.executions !== null) {
                  · {{ int(p.executions) }} script executions
                }
                @if (p.lazyLoads.length > 0) {
                  · loaded during the run: {{ p.lazyLoads.join(', ') }}
                }
              </dd>
            </div>
          }
        </dl>
      </details>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .prov {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-2) var(--space-3);
        background: var(--bg-secondary);
      }
      .strip {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .strip-title {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        margin-right: 4px;
      }
      .chip {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
        color: var(--text-primary);
      }
      .chip[data-tone='warn'] {
        border-color: rgba(255, 149, 0, 0.5);
        background: rgba(255, 149, 0, 0.1);
      }
      .chip[data-tone='ok'] {
        border-color: rgba(52, 199, 89, 0.45);
        background: rgba(52, 199, 89, 0.08);
      }
      .details summary {
        margin-top: var(--space-2);
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      dl {
        margin: var(--space-2) 0 0;
        display: grid;
        gap: 6px;
        font-size: var(--text-sm);
      }
      dl > div {
        display: grid;
        grid-template-columns: minmax(110px, 160px) 1fr;
        gap: var(--space-2);
      }
      dt {
        color: var(--text-secondary);
      }
      dd {
        margin: 0;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      ul {
        margin: 0;
        padding-left: 16px;
      }
      .mono {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 12px;
      }
    `,
  ],
})
export class RunProvenanceComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly provenance = input.required<RunProvenance>();
  /** The run's strategy: its script now is compared with the one the run executed. */
  readonly strategyId = input<number | null>(null);

  readonly current = signal<CurrentScript | null>(null);

  readonly scriptState = computed<ScriptState>(() => {
    const now = this.current();
    const hash = this.provenance().sourceHash;
    if (!now || !hash) return 'unknown';
    return now.hash === hash ? 'same' : 'changed';
  });
  readonly scriptText = computed(() => {
    const short = this.provenance().sourceHash.slice(0, 8) || 'unknown';
    switch (this.scriptState()) {
      case 'same':
        return `Script ${short} · the strategy's script now`;
      case 'changed':
        return `Script ${short} · changed since this run`;
      default:
        return `Script ${short}`;
    }
  });
  readonly scriptExplanation = computed(() => {
    switch (this.scriptState()) {
      case 'same':
        return "the same source as the strategy's script now.";
      case 'changed':
        return "the strategy's script has been edited since: this run does not describe it any more.";
      default:
        return "the strategy's script now could not be compared.";
    }
  });

  readonly inputEntries = computed(() =>
    Object.entries(this.provenance().inputs).map(([k, v]) => [k, inputValueText(v)] as const),
  );
  readonly inputDiffs = computed<InputDifference[]>(() => {
    const now = this.current();
    return now ? inputDifferences(this.provenance().inputs, now.inputs) : [];
  });
  readonly inputsText = computed(() => {
    const n = this.inputEntries().length;
    const base = n === 0 ? 'Default inputs' : `${n} input${n === 1 ? '' : 's'} set`;
    const diffs = this.inputDiffs().length;
    return diffs > 0 ? `${base} · ${diffs} differ from now` : base;
  });

  readonly dataText = computed(() => {
    const p = this.provenance();
    const parts: string[] = [];
    if (p.chartTimeframe) parts.push(`${p.chartTimeframe} bars`);
    if (p.chartSource) {
      parts.push(
        p.chartSource === 'Candles'
          ? 'stored candles'
          : `built from ${p.chartSource.replace(/^Aggregated/, 'lower timeframes ')}`,
      );
    }
    if (p.bars !== null) parts.push(`${formatInteger(p.bars)} traded`);
    if (p.warmupBars !== null) parts.push(`${formatInteger(p.warmupBars)} warm-up`);
    if (p.tradingStartUtc) {
      const t = Date.parse(
        p.tradingStartUtc.endsWith('Z') ? p.tradingStartUtc : `${p.tradingStartUtc}Z`,
      );
      if (Number.isFinite(t)) parts.push(`trading from ${formatDateTime(t)} UTC`);
    }
    return parts.join(' · ') || '—';
  });

  constructor() {
    effect(() => {
      const id = this.strategyId();
      untracked(() => this.loadCurrent(id));
    });
  }

  private loadCurrent(id: number | null): void {
    this.current.set(null);
    if (id === null) return;
    this.strategies
      .getById(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const s = res?.status ? res.data : null;
          if (!s || id !== this.strategyId()) return;
          this.current.set({
            hash: scriptSourceHash(s.scriptSource ?? ''),
            inputs: parseSavedInputs(s.scriptInputs),
          });
        },
        error: () => {
          /* left as "could not be compared" */
        },
      });
  }

  int(v: number | null): string {
    return formatInteger(v);
  }

  money(v: number | null, currency: string): string {
    return formatMoney(v, currency);
  }
}
