import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { catchError, forkJoin, of } from 'rxjs';

import { ConfigService } from '@core/services/config.service';
import { MLModelsService } from '@core/services/ml-models.service';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import {
  modelComparisonRows,
  modelIdsOf,
  modelLabel,
  planFromApproval,
  planNeedsFetch,
  type ApprovalPlan,
  type ModelLike,
} from './approval-preview';

/**
 * The change an approval card would make, shown on the card.
 *
 * A card describes its own change in prose the agent wrote ("Writes a live EngineConfig value"). An
 * operator approving it on that basis is trusting the description; this renders the change itself —
 * the value that is live now against the one being written, the exact request that will be sent, the
 * two models being swapped on the metrics the swap turns on.
 *
 * Three rules, because this is decoration on a decision the operator has to make anyway:
 *  · nothing is fetched until the card is Pending AND on screen — a scrolled-back thread with forty
 *    resolved approvals must not fire forty requests;
 *  · every fetch is silent and best-effort. A failure renders nothing at all and the card falls back
 *    to its own verb/target/side-effect rendering — it never becomes an error the operator has to
 *    read past on their way to Approve;
 *  · one fetch per card. The thread refetches about once a second during a live run, and this must
 *    not multiply that.
 *
 * A child component so its styles bill to their own budget; `<app-engineer-turn>`'s stylesheet is
 * already the biggest in the app.
 */
@Component({
  selector: 'app-engineer-approval-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = plan();
    @switch (p.kind) {
      @case ('config') {
        @if (configLoaded()) {
          <div class="prev">
            <div class="head">{{ p.key }}</div>
            <div class="diff">
              <code class="old" title="The value live right now">{{
                currentValue() || '(unset)'
              }}</code>
              <span class="arrow" aria-hidden="true">→</span>
              <code class="new" title="What approving writes">{{ p.value || '(empty)' }}</code>
            </div>
          </div>
        }
      }
      @case ('platform') {
        <div class="prev">
          <div class="head">
            <code class="method">{{ p.method }}</code>
            <code class="path">{{ p.path }}</code>
            @if (p.operationId) {
              <span class="op">{{ p.operationId }}</span>
            }
          </div>
          @if (p.query) {
            <pre class="body">query {{ p.query }}</pre>
          }
          @if (p.body) {
            <pre class="body">{{ p.body }}</pre>
          }
        </div>
      }
      @case ('models') {
        @if (models().length > 0) {
          <div class="prev">
            <table class="cmp">
              <thead>
                <tr>
                  <th></th>
                  @for (m of models(); track m.id) {
                    <th>
                      <span class="role">{{ roleOf(m) }}</span>
                      {{ label(m) }}
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.label) {
                  <tr>
                    <th scope="row">{{ row.label }}</th>
                    @for (v of row.values; track $index) {
                      <td [class.best]="row.best === $index">{{ v }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (p.scope) {
          <div class="prev">
            <div class="head">
              Restores the previous champion for <code>{{ p.scope }}</code>
            </div>
          </div>
        }
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .prev {
        margin-top: 8px;
        padding: 7px 9px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        font-size: var(--text-xs);
        overflow-x: auto;
      }
      .head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 6px;
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      code {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .method {
        font-weight: var(--font-bold);
        color: var(--accent);
      }
      .path {
        background: none;
        padding: 0;
      }
      .op {
        margin-left: auto;
        color: var(--text-tertiary);
        font-size: 10px;
      }
      /* old → new. The new value carries the accent because it is the thing being decided. */
      .diff {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 5px;
      }
      .old {
        color: var(--text-tertiary);
        text-decoration: line-through;
        text-decoration-color: color-mix(in srgb, var(--text-tertiary) 55%, transparent);
      }
      .arrow {
        color: var(--text-tertiary);
      }
      .new {
        color: var(--accent);
        font-weight: var(--font-semibold);
        background: color-mix(in srgb, var(--accent) 12%, transparent);
      }
      .body {
        margin: 5px 0 0;
        padding: 6px 8px;
        background: var(--bg-tertiary);
        border-radius: 6px;
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 200px;
        overflow: auto;
      }
      .cmp {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
      }
      .cmp th,
      .cmp td {
        padding: 3px 8px;
        text-align: right;
        white-space: nowrap;
        border-bottom: 1px solid var(--border);
      }
      .cmp thead th {
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
      }
      .cmp tbody th {
        text-align: left;
        font-weight: var(--font-normal, 400);
        color: var(--text-tertiary);
      }
      .cmp tbody tr:last-child th,
      .cmp tbody tr:last-child td {
        border-bottom: none;
      }
      .role {
        display: inline-block;
        margin-right: 5px;
        padding: 0 5px;
        border-radius: var(--radius-full);
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
      }
      td.best {
        color: color-mix(in srgb, var(--profit) 72%, var(--text-primary));
        font-weight: var(--font-semibold);
      }
      .cmp td {
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
    `,
  ],
})
export class EngineerApprovalPreviewComponent {
  readonly turn = input.required<SpotAnalysisFollowUpTurnDto>();
  /** True while the card is still awaiting the operator — the only state worth a fetch. */
  readonly pending = input<boolean>(false);

  private readonly config = inject(ConfigService);
  private readonly mlModels = inject(MLModelsService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly plan = computed<ApprovalPlan>(() => planFromApproval(this.turn()));

  /** The live config value. Null until it lands; `configLoaded` gates the render. */
  protected readonly currentValue = signal<string | null>(null);
  protected readonly configLoaded = signal(false);
  protected readonly models = signal<ModelLike[]>([]);

  protected readonly rows = computed(() => modelComparisonRows(this.models()));
  protected readonly label = modelLabel;

  /** Which side of the swap a column is. Read off the plan, not the column order — a card that
   *  names only the model being replaced would otherwise be captioned as the one coming in. */
  protected roleOf(m: ModelLike): string {
    const p = this.plan();
    return p.kind === 'models' && p.incomingId === m.id ? 'In' : 'Out';
  }

  /** Guards the one-fetch-per-card rule against the thread's once-a-second refetch. */
  private fetched = false;
  private observer: IntersectionObserver | null = null;

  constructor() {
    effect(() => {
      const plan = this.plan();
      const pending = this.pending();
      untracked(() => {
        if (!pending || this.fetched || !planNeedsFetch(plan)) return;
        this.armWhenVisible(plan);
      });
    });
    this.destroyRef.onDestroy(() => this.observer?.disconnect());
  }

  /**
   * Wait until the card is actually on screen before spending a request on it.
   * Where `IntersectionObserver` is unavailable (older embeddings, jsdom) the fetch just runs —
   * a preview that never appears would be the worse failure.
   */
  private armWhenVisible(plan: ApprovalPlan): void {
    const el = this.host.nativeElement as HTMLElement | undefined;
    if (typeof IntersectionObserver === 'undefined' || !el) {
      this.load(plan);
      return;
    }
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      this.observer?.disconnect();
      this.observer = null;
      this.load(plan);
    });
    this.observer.observe(el);
  }

  private load(plan: ApprovalPlan): void {
    if (this.fetched) return;
    this.fetched = true;
    if (plan.kind === 'config') this.loadConfig(plan.key);
    else if (plan.kind === 'models') this.loadModels(modelIdsOf(plan));
  }

  private loadConfig(key: string): void {
    this.config
      .getByKey(key, { silent: true })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        // A key with no row is a real answer — "(unset)" is exactly what the operator needs to know.
        if (!res) return;
        this.currentValue.set(res.data?.value ?? null);
        this.configLoaded.set(true);
      });
  }

  private loadModels(ids: readonly number[]): void {
    if (ids.length === 0) return;
    forkJoin(
      ids.map((id) => this.mlModels.getById(id, { silent: true }).pipe(catchError(() => of(null)))),
    ).subscribe((results) => {
      const models = results
        .map((r) => (r?.data ?? null) as ModelLike | null)
        .filter((m): m is ModelLike => m !== null);
      this.models.set(models);
    });
  }
}
