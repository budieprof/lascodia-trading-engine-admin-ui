import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ExecutionQualityService } from '@core/services/execution-quality.service';
import { describeFailure } from '@features/scripting/shared/api-error';

import { COCKPIT_CARD_STYLES } from './cockpit.styles';
import { ConfigHashBadgeComponent } from '../components/config-hash-badge/config-hash-badge.component';
import { ResearchCockpitApiService } from './research-cockpit-api.service';
import {
  execQualitySummary,
  isNotOffered,
  readCalibration,
  readSequential,
  readSpecHistory,
  type CalibrationRow,
  type ExecQualityRow,
  type SequentialRow,
  type SpecChange,
} from './research-cockpit.model';

type Load<T> =
  | { state: 'loading' }
  | { state: 'ok'; data: T }
  | { state: 'absent'; text: string }
  | { state: 'error'; text: string };

const NOT_OFFERED = 'This engine build does not offer this view yet.';

/**
 * U12 — what the strategy's live evidence rests on, read-only: the sequential decay test's state (S09), its fills'
 * execution quality by session (C4 when the engine sends it), the fitted cost-calibration profiles of its symbol (C7)
 * and the broker's symbol-spec history (C6). Sequential state, calibration and spec history have no engine read yet —
 * each section says so on a 404 instead of showing anything it did not receive.
 */
@Component({
  selector: 'app-execution-evidence-card',
  standalone: true,
  imports: [ConfigHashBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="ee-title" data-testid="execution-evidence">
      <header class="head">
        <h3 id="ee-title" class="title">Live evidence — decay test, execution, costs, spec</h3>
      </header>

      <h4 class="sub">Sequential decay test (CUSUM on R)</h4>
      @switch (sequential().state) {
        @case ('loading') {
          <p class="muted small">Loading…</p>
        }
        @case ('ok') {
          @if (seqRows().length === 0) {
            <p class="muted small">
              No test state yet (it starts with the first live trades of a version).
            </p>
          } @else {
            @if (seqMode()) {
              <p class="muted small">
                Mode {{ seqMode() }} — Observe records an alarm, Enforce pauses.
              </p>
            }
            <table aria-label="Sequential test state">
              <thead>
                <tr>
                  <th>Configuration</th>
                  <th class="num">Statistic</th>
                  <th class="num">Alarm at</th>
                  <th class="num">Trades</th>
                  <th class="num">Baseline R (μ₀ / σ₀)</th>
                  <th>Alarm</th>
                </tr>
              </thead>
              <tbody>
                @for (s of seqRows(); track s.configHash) {
                  <tr>
                    <td>
                      <app-config-hash-badge [hash]="s.configHash" [currentHash]="currentHash()" />
                    </td>
                    <td class="num">{{ n(s.statistic, 2) }}</td>
                    <td class="num">{{ s.threshold === null ? '—' : '−' + n(s.threshold, 1) }}</td>
                    <td class="num">{{ s.observations ?? '—' }}</td>
                    <td class="num">{{ n(s.baselineMeanR, 3) }} / {{ n(s.baselineSdR, 3) }}</td>
                    <td>
                      @if (s.alarmedAtUtc) {
                        <span class="chip" data-tone="bad">{{ s.alarmedAtUtc.slice(0, 16) }}</span>
                      } @else {
                        <span class="muted small">none</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        }
        @default {
          <p class="muted small">{{ text(sequential()) }}</p>
        }
      }

      <h4 class="sub">Execution quality of the strategy's fills</h4>
      @switch (fills().state) {
        @case ('loading') {
          <p class="muted small">Loading…</p>
        }
        @case ('ok') {
          @if (summary(); as s) {
            @if (s.groups.length === 0) {
              <p class="muted small">No fill recorded for this strategy.</p>
            } @else {
              <div class="table-wrap">
                <table aria-label="Execution quality by session">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th class="num">Fills</th>
                      <th class="num">Slippage mean / P50 / P90 (pips)</th>
                      <th class="num">Latency P50 / P90 (ms)</th>
                      <th class="num">Partial</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (g of s.groups; track g.session) {
                      <tr>
                        <th scope="row">{{ g.session }}</th>
                        <td class="num">{{ g.fills }}</td>
                        <td class="num">
                          {{ n(g.slipMean, 2) }} / {{ n(g.slipP50, 2) }} / {{ n(g.slipP90, 2) }}
                        </td>
                        <td class="num">{{ n(g.latP50, 0) }} / {{ n(g.latP90, 0) }}</td>
                        <td class="num">{{ g.partial }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="muted small">
                Newest {{ fillCount() }} fills. Slippage:
                {{
                  s.slippageBasis === 'engine'
                    ? 'engine-derived pips (C4)'
                    : 'as the EA reported it (points ÷ 10)'
                }}; latency:
                {{
                  s.latencyBasis === 'sendToFill'
                    ? 'first send → fill (C4)'
                    : 'submit → fill (0 = not measured, left out)'
                }}.
              </p>
            }
          }
        }
        @default {
          <p class="muted small">{{ text(fills()) }}</p>
        }
      }

      <h4 class="sub">Cost calibration profiles{{ symbol() ? ' — ' + symbol() : '' }}</h4>
      @switch (calibration().state) {
        @case ('loading') {
          <p class="muted small">Loading…</p>
        }
        @case ('ok') {
          @if (calRows().length === 0) {
            <p class="muted small">No profile fitted for this symbol yet.</p>
          } @else {
            <div class="table-wrap">
              <table aria-label="Execution cost calibration profiles">
                <thead>
                  <tr>
                    <th>Broker</th>
                    <th>Session</th>
                    <th>Fitted (UTC)</th>
                    <th class="num">Samples</th>
                    <th class="num">Slippage mean / P50 / P90 (pips)</th>
                    <th class="num">× spread P50</th>
                    <th class="num">Latency P50 / P90 (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of calRows(); track c.brokerKey + c.sessionBucket + c.computedAtUtc) {
                    <tr>
                      <td>{{ c.brokerKey }}</td>
                      <td>{{ c.sessionBucket }}</td>
                      <td>{{ c.computedAtUtc.slice(0, 16) }}</td>
                      <td class="num">{{ c.sampleCount ?? '—' }}</td>
                      <td class="num">
                        {{ n(c.slipMean, 2) }} / {{ n(c.slipP50, 2) }} / {{ n(c.slipP90, 2) }}
                      </td>
                      <td class="num">{{ n(c.spreadMultipleP50, 2) }}</td>
                      <td class="num">{{ n(c.latencyP50, 0) }} / {{ n(c.latencyP90, 0) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
        @default {
          <p class="muted small">{{ text(calibration()) }}</p>
        }
      }

      <h4 class="sub">Broker symbol-spec history{{ symbol() ? ' — ' + symbol() : '' }}</h4>
      @switch (spec().state) {
        @case ('loading') {
          <p class="muted small">Loading…</p>
        }
        @case ('ok') {
          @if (specRows().length === 0) {
            <p class="muted small">No spec history recorded for this symbol.</p>
          } @else {
            <ul class="spec">
              @for (c of specRows(); track c.validFromUtc + c.brokerKey) {
                <li>
                  <span class="small"
                    ><strong>{{ c.validFromUtc.slice(0, 16) }}</strong> ·
                    {{ c.brokerKey || 'broker' }}</span
                  >
                  <span class="muted small">
                    @for (ch of c.changes; track ch.field) {
                      <span class="diff"
                        >{{ ch.field }} {{ ch.from ? ch.from + ' → ' : '' }}{{ ch.to }}</span
                      >
                    }
                  </span>
                </li>
              }
            </ul>
          }
        }
        @default {
          <p class="muted small">{{ text(spec()) }}</p>
        }
      }
    </section>
  `,
  styles: [
    COCKPIT_CARD_STYLES,
    `
      .sub {
        margin: var(--space-2) 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .spec {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 260px;
        overflow: auto;
      }
      .spec li {
        display: flex;
        flex-direction: column;
      }
      .diff {
        display: inline-block;
        margin-right: 8px;
      }
    `,
  ],
})
export class ExecutionEvidenceCardComponent {
  private readonly api = inject(ResearchCockpitApiService);
  private readonly execQuality = inject(ExecutionQualityService);

  readonly strategyId = input.required<number>();
  readonly symbol = input<string | null>(null);
  readonly currentHash = input<string | null>(null);

  readonly sequential = signal<Load<unknown>>({ state: 'loading' });
  readonly fills = signal<Load<ExecQualityRow[]>>({ state: 'loading' });
  readonly calibration = signal<Load<unknown>>({ state: 'loading' });
  readonly spec = signal<Load<unknown>>({ state: 'loading' });

  private readonly seq = computed(() => {
    const s = this.sequential();
    return s.state === 'ok' ? readSequential(s.data) : { mode: '', rows: [] as SequentialRow[] };
  });
  readonly seqRows = computed(() => this.seq().rows);
  readonly seqMode = computed(() => this.seq().mode);
  readonly summary = computed(() => {
    const f = this.fills();
    return f.state === 'ok' ? execQualitySummary(f.data) : null;
  });
  readonly fillCount = computed(() => {
    const f = this.fills();
    return f.state === 'ok' ? f.data.length : 0;
  });
  readonly calRows = computed<CalibrationRow[]>(() => {
    const c = this.calibration();
    return c.state === 'ok' ? readCalibration(c.data) : [];
  });
  readonly specRows = computed<SpecChange[]>(() => {
    const s = this.spec();
    return s.state === 'ok' ? readSpecHistory(s.data) : [];
  });

  constructor() {
    effect(() => {
      const id = this.strategyId();
      const symbol = this.symbol();
      untracked(() => void this.load(id, symbol));
    });
  }

  private async load(id: number, symbol: string | null): Promise<void> {
    this.sequential.set({ state: 'loading' });
    this.fills.set({ state: 'loading' });
    this.calibration.set(
      symbol
        ? { state: 'loading' }
        : { state: 'absent', text: 'The strategy has no single symbol.' },
    );
    this.spec.set(
      symbol
        ? { state: 'loading' }
        : { state: 'absent', text: 'The strategy has no single symbol.' },
    );
    await Promise.all([
      this.read(this.api.sequentialTest(id), this.sequential, 'The test state could not be read.'),
      this.loadFills(id),
      symbol
        ? this.read(
            this.api.calibrationProfiles(symbol),
            this.calibration,
            'The profiles could not be read.',
          )
        : null,
      symbol
        ? this.read(this.api.specHistory(symbol), this.spec, 'The spec history could not be read.')
        : null,
    ]);
  }

  private async read(
    call: ReturnType<ResearchCockpitApiService['sequentialTest']>,
    target: WritableSignal<Load<unknown>>,
    fallback: string,
  ): Promise<void> {
    try {
      const res = await firstValueFrom(call);
      if (res?.status) target.set({ state: 'ok', data: res.data });
      else target.set({ state: 'absent', text: describeFailure(res, fallback) });
    } catch (err) {
      target.set(
        isNotOffered(err)
          ? { state: 'absent', text: NOT_OFFERED }
          : { state: 'error', text: describeFailure(err, fallback) },
      );
    }
  }

  private async loadFills(id: number): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.execQuality.list({
          currentPage: 1,
          itemCountPerPage: 500,
          filter: { strategyId: id },
          sortBy: 'recordedAt',
          sortDirection: 'desc',
        }),
      );
      this.fills.set({ state: 'ok', data: (res?.data?.data ?? []) as unknown as ExecQualityRow[] });
    } catch (err) {
      this.fills.set({
        state: 'error',
        text: describeFailure(err, 'The execution-quality log could not be read.'),
      });
    }
  }

  n(v: number | null | undefined, d: number): string {
    return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d);
  }

  text(l: Load<unknown>): string {
    return l.state === 'absent' || l.state === 'error' ? l.text : '';
  }
}
