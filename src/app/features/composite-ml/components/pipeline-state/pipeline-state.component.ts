import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of, switchMap } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import { ConfigService } from '@core/services/config.service';
import { unwrapResponse } from '@core/api/api.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';

import {
  CPC_SWITCH,
  DATASET_STATUS_LABEL,
  GENERATOR_SWITCH,
  LAST_CYCLE_MARKER_KEY,
  POLICY_TRAINER_SWITCH,
  ageText,
  stateFromConfigRows,
  summarisePipeline,
  utcText,
  type ConfigRowLite,
  type PipelineState,
} from '../../composite-ml-pipeline.logic';

const FALLBACK_KEYS = [GENERATOR_SWITCH, POLICY_TRAINER_SWITCH, CPC_SWITCH, LAST_CYCLE_MARKER_KEY];

/**
 * The CompositeML pipeline's real state, shared by every CompositeML tab: whether the generator is
 * switched on (and since when), when its last cycle ran, what each CompositeML table holds and
 * which parts still update without new cycles. `full` replaces an empty page body; `compact` is
 * one line (expandable) above a tab that has its own data.
 *
 * Reads `GET composite-ml/pipeline-state`; an engine without it falls back to the switch rows
 * (`GET config/{key}`), and the dataset table is then left out rather than guessed.
 */
@Component({
  selector: 'app-composite-ml-pipeline-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FeatureStateComponent],
  template: `
    @if (summary(); as sum) {
      @if (variant() === 'compact' && !expanded()) {
        <div class="strip" [attr.data-kind]="sum.kind" role="status">
          <span class="pill">CompositeML</span>
          <span class="line">{{ sum.compactLine }}</span>
          <button type="button" class="more" (click)="expanded.set(true)">Pipeline details</button>
        </div>
      } @else {
        <div class="full">
          <app-feature-state
            title="CompositeML pipeline"
            [summary]="summaryText()"
            [kind]="sum.kind"
            [stateLabel]="sum.stateLabel"
            [switchKey]="generatorKey"
            [detail]="sum.detail"
            [requirements]="sum.requirements"
            [links]="links"
          />

          @if (sum.datasetRows.length) {
            <section class="card" aria-label="What the CompositeML pipeline holds">
              <header class="card-head">
                <h3>What the pipeline holds</h3>
                <span class="sub">
                  Every CompositeML table, newest row first-hand from the engine
                  @if (state(); as st) {
                    · {{ st.cyclesRecorded }} cycles on record
                  }
                </span>
                @if (variant() === 'compact') {
                  <button type="button" class="more" (click)="expanded.set(false)">Hide</button>
                }
              </header>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th class="num">Rows</th>
                      <th>Newest</th>
                      <th>Status</th>
                      <th>Written by</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (d of sum.datasetRows; track d.key) {
                      <tr [class.focus]="d.focus">
                        <td>
                          {{ d.label }}
                          @if (d.focus) {
                            <span class="tag">this page</span>
                          }
                        </td>
                        <td class="num">{{ d.rows.toLocaleString('en-US') }}</td>
                        <td [title]="utc(d.latestUtc)">
                          {{ d.latestUtc ? age(d.latestUtc) : '—' }}
                        </td>
                        <td>
                          <span class="status" [attr.data-status]="d.status">{{
                            statusLabel[d.status]
                          }}</span>
                        </td>
                        <td class="producer">{{ d.producer }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (state(); as st) {
                @if (st.strategiesEverGenerated > 0) {
                  <p class="foot">
                    CompositeML strategies: {{ st.strategiesLive }} remain of
                    {{ st.strategiesEverGenerated }} generated
                    @if (st.strategiesByStatus.length) {
                      ({{ statusList() }})
                    }
                    · <a routerLink="/strategies">Strategies</a>
                  </p>
                }
              }
            </section>
          } @else if (variant() === 'compact') {
            <button type="button" class="more solo" (click)="expanded.set(false)">
              Hide details
            </button>
          }
        </div>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .full {
        display: grid;
        gap: var(--space-3);
      }
      .strip {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2) var(--space-3);
        padding: 8px 12px;
        border: 1px solid var(--border);
        border-left: 4px solid var(--text-tertiary);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .strip[data-kind='off'] {
        border-left-color: var(--warning);
      }
      .strip[data-kind='on'] {
        border-left-color: var(--profit);
      }
      .pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .line {
        flex: 1 1 20rem;
        min-width: 0;
      }
      .more {
        background: none;
        border: none;
        padding: 0;
        color: var(--accent);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .more:hover {
        text-decoration: underline;
      }
      .more.solo {
        justify-self: start;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4) var(--space-5);
      }
      .card-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-2) var(--space-3);
        margin-bottom: var(--space-3);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .card-head .sub {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        flex: 1;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        text-align: left;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        vertical-align: baseline;
      }
      th {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      tr.focus td {
        background: var(--bg-primary);
        font-weight: var(--font-medium);
      }
      .tag {
        margin-left: 6px;
        font-size: var(--text-xs);
        color: var(--accent);
      }
      .status {
        font-size: var(--text-xs);
        padding: 1px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .status[data-status='updating'] {
        color: var(--profit);
      }
      .status[data-status='never'] {
        color: var(--text-tertiary);
      }
      .producer {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .foot {
        margin: var(--space-3) 0 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .foot a {
        color: var(--accent);
      }
    `,
  ],
})
export class CompositeMlPipelineStateComponent {
  private readonly compositeMl = inject(CompositeMLService);
  private readonly config = inject(ConfigService);

  /** Dataset keys this page reads (see `PipelineDatasetKey`); they are named first. */
  readonly focus = input<readonly string[]>([]);
  /** `full` replaces an empty page body; `compact` sits above a tab with its own data. */
  readonly variant = input<'full' | 'compact'>('full');
  /** What this page shows, in plain language — the card's first sentence. */
  readonly pageSummary = input<string>(
    'CompositeML builds trading strategies from the active ML models: every generator cycle scores candidates layer by layer, the policy trainer learns from the decisions that matured, and the skill evaluators grade each layer and trainer.',
  );

  /** The loaded state, for pages that build their own tiles from it. */
  readonly stateChange = output<PipelineState>();

  protected readonly expanded = signal(false);
  protected readonly generatorKey = GENERATOR_SWITCH;
  protected readonly statusLabel = DATASET_STATUS_LABEL;
  protected readonly links = [
    {
      label: 'Engine config (CompositeML)',
      route: '/engine-config',
      query: { search: 'CompositeML' },
    },
    { label: 'Worker health', route: '/worker-health' },
    { label: 'ML models', route: '/ml-models' },
  ];

  protected readonly resource = createPolledResource(
    () =>
      this.compositeMl.getPipelineState().pipe(
        map(unwrapResponse),
        catchError(() => this.fallback()),
      ),
    { intervalMs: 300_000 },
  );

  protected readonly state = computed(() => this.resource.value() ?? null);
  protected readonly summary = computed(() => {
    const s = this.state();
    return s ? summarisePipeline(s, this.focus(), Date.now()) : null;
  });
  protected readonly summaryText = computed(() => this.pageSummary());
  protected readonly statusList = computed(() =>
    (this.state()?.strategiesByStatus ?? [])
      .map((x) => `${x.count} ${x.status.toLowerCase()}`)
      .join(', '),
  );

  constructor() {
    effect(() => {
      const s = this.state();
      if (s) untracked(() => this.stateChange.emit(s));
    });
  }

  protected age(iso: string): string {
    return ageText(iso, Date.now());
  }
  protected utc(iso: string | null): string {
    return utcText(iso);
  }

  /** Older engine: read the switches one by one; a key with no row reads as null. */
  private fallback() {
    const now = new Date().toISOString();
    return of(null).pipe(
      switchMap(() =>
        forkJoin(
          FALLBACK_KEYS.map((k) =>
            this.config.getByKey(k, { silent: true }).pipe(
              map((r) => (r.status && r.data ? (r.data as unknown as ConfigRowLite) : null)),
              catchError(() => of(null)),
            ),
          ),
        ),
      ),
      map((rows) => {
        const byKey: Record<string, ConfigRowLite | null> = {};
        FALLBACK_KEYS.forEach((k, i) => (byKey[k] = rows[i]));
        return stateFromConfigRows(byKey, now) as PipelineState;
      }),
    );
  }
}
