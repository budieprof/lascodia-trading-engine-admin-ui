import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, finalize, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { StrategyVariantDto } from '@core/api/api.types';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Variants tab content for the strategy detail page (PRD §5.3 FR-3.3).
 * Lists A/B shadow variants attached to one base strategy with their shadow
 * performance vs. the base, and exposes a promote-variant action that copies
 * the variant's overrides onto the parent and retires the variant.
 */
@Component({
  selector: 'app-strategy-variants-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel">
      <header class="panel-head">
        <h3>A/B Variants</h3>
        <span class="muted small">
          {{ variants().length }} variant{{ variants().length === 1 ? '' : 's' }} ·
          {{ promotedCount() }} promoted
        </span>
      </header>

      @if (loading()) {
        <app-card-skeleton [lines]="5" />
      } @else if (error()) {
        <app-error-state
          title="Could not load variants"
          message="Engine returned an error fetching shadow A/B variants for this strategy."
          (retry)="load()"
        />
      } @else if (variants().length === 0) {
        <app-empty-state
          title="No shadow variants"
          description="The engine generates shadow variants when the auto-optimizer flags a candidate parameter change worth A/B testing. They appear here as they accumulate."
        />
      } @else {
        <div class="variants-grid">
          @for (v of variants(); track v.id) {
            <article
              class="variant"
              [class.promoted]="v.isPromoted"
              [class.complete]="v.completedAt"
            >
              <header class="variant-head">
                <div class="variant-title">
                  <span class="mono small id">#{{ v.id }}</span>
                  <strong>{{ v.name }}</strong>
                </div>
                <div class="badges">
                  @if (v.isPromoted) {
                    <span class="badge ok">promoted</span>
                  }
                  @if (v.completedAt) {
                    <span class="badge muted">complete</span>
                  } @else if (v.isActive) {
                    <span class="badge active">running</span>
                  }
                </div>
              </header>

              <dl class="metrics">
                <div>
                  <dt>Signals</dt>
                  <dd class="mono">{{ v.shadowSignalCount }} / {{ v.requiredSignals }}</dd>
                </div>
                <div>
                  <dt>Win rate (shadow / base)</dt>
                  <dd class="mono">
                    {{ v.shadowWinRate * 100 | number: '1.0-1' }}%
                    <span class="muted small">
                      / {{ v.baseWinRate * 100 | number: '1.0-1' }}%
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Expected value (shadow / base)</dt>
                  <dd class="mono">
                    {{ v.shadowExpectedValue | number: '1.0-2' }}
                    <span class="muted small"> / {{ v.baseExpectedValue | number: '1.0-2' }} </span>
                  </dd>
                </div>
                <div>
                  <dt>Shadow Sharpe</dt>
                  <dd
                    class="mono"
                    [class.positive]="v.shadowSharpeRatio > 0"
                    [class.negative]="v.shadowSharpeRatio < 0"
                  >
                    {{ v.shadowSharpeRatio | number: '1.0-2' }}
                  </dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd class="mono small time" [title]="v.startedAt | date: 'yyyy-MM-dd HH:mm UTC'">
                    {{ v.startedAt | relativeTime }}
                  </dd>
                </div>
              </dl>

              <details class="overrides">
                <summary>Parameter overrides</summary>
                <pre class="json">{{ formatJson(v.parameterOverridesJson) }}</pre>
                @if (v.comparisonResultJson) {
                  <summary class="sub">Comparison result</summary>
                  <pre class="json">{{ formatJson(v.comparisonResultJson) }}</pre>
                }
              </details>

              @if (!v.isPromoted && !v.completedAt) {
                <footer class="variant-foot">
                  <button
                    type="button"
                    class="action ok"
                    (click)="askPromote(v)"
                    [disabled]="submitting()"
                  >
                    Promote →
                  </button>
                </footer>
              }
            </article>
          }
        </div>
      }
    </section>

    @if (pending(); as p) {
      <div class="modal-overlay" (click)="cancel()">
        <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <header class="modal-head">
            <h2>Promote variant</h2>
            <button type="button" class="close-btn" (click)="cancel()" aria-label="Close">×</button>
          </header>
          <p class="modal-target">
            <span class="mono">#{{ p.id }} · {{ p.name }}</span>
          </p>
          <p class="modal-desc">
            Promotion copies this variant's parameter overrides onto the base strategy and retires
            the shadow run. The base strategy continues trading with the new parameters. This is
            reversible only by capturing a strategy version before promoting (use the version
            history drawer).
          </p>
          <label class="reason-field">
            <span>Reason (optional, written to audit trail)</span>
            <textarea
              rows="2"
              [(ngModel)]="reasonText"
              placeholder="Why is this variant worth promoting?"
            ></textarea>
          </label>
          <footer class="modal-foot">
            <button type="button" class="btn btn-secondary" (click)="cancel()">Cancel</button>
            <button
              type="button"
              class="btn btn-primary"
              (click)="confirm()"
              [disabled]="submitting()"
            >
              {{ submitting() ? 'Promoting…' : 'Promote' }}
            </button>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .panel {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .variants-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: var(--space-3);
      }
      .variant {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .variant.promoted {
        border-left: 3px solid #34c759;
      }
      .variant.complete:not(.promoted) {
        opacity: 0.78;
      }
      .variant-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .variant-title {
        display: flex;
        align-items: baseline;
        gap: 6px;
      }
      .id {
        color: var(--text-tertiary);
      }
      .badges {
        display: inline-flex;
        gap: 4px;
      }
      .badge {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
      }
      .badge.ok {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .badge.active {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .badge.muted {
        background: rgba(142, 142, 147, 0.16);
        color: #636366;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: var(--space-2) var(--space-3);
        margin: 0;
      }
      .metrics > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .metrics dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .metrics dd {
        margin: 0;
        font-size: var(--text-sm);
      }
      .positive {
        color: #248a3d;
      }
      .negative {
        color: #d70015;
      }
      .time {
        color: var(--text-secondary);
      }
      .overrides {
        font-size: var(--text-xs);
      }
      .overrides summary {
        cursor: pointer;
        color: var(--text-secondary);
        user-select: none;
      }
      .overrides summary.sub {
        margin-top: var(--space-2);
      }
      .overrides summary:hover {
        color: var(--text-primary);
      }
      .json {
        margin: 6px 0 0;
        padding: var(--space-2);
        background: var(--bg-primary);
        border-radius: var(--radius-sm);
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 200px;
        overflow: auto;
        color: var(--text-secondary);
      }
      .variant-foot {
        display: flex;
        justify-content: flex-end;
      }
      .action {
        padding: 6px 14px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .action.ok {
        color: #248a3d;
      }
      .action.ok:hover:not(:disabled) {
        background: #34c759;
        color: #fff;
      }
      .action:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.45));
        display: grid;
        place-items: center;
        z-index: 1000;
      }
      .modal {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-width: 520px;
        width: 90%;
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .modal-head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary);
        cursor: pointer;
      }
      .modal-target,
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
      }
      .modal-target {
        color: var(--text-secondary);
      }
      .modal-desc {
        color: var(--text-primary);
      }
      .reason-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .reason-field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .reason-field textarea {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: var(--font-sans);
        resize: vertical;
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .btn-primary {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-primary:disabled {
        background: var(--bg-tertiary, #d1d1d6);
        cursor: not-allowed;
      }
    `,
  ],
})
export class StrategyVariantsTabComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly auditTrail = inject(AuditTrailService);
  private readonly notify = inject(NotificationService);

  readonly strategyId = input.required<number>();

  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly variants = signal<StrategyVariantDto[]>([]);

  protected readonly promotedCount = computed(
    () => this.variants().filter((v) => v.isPromoted).length,
  );

  constructor() {
    // Refetch whenever the strategy id changes (tab opens or parent re-binds).
    effect(() => {
      const id = this.strategyId();
      if (id) this.load(id);
    });
  }

  protected load(idOverride?: number): void {
    const id = idOverride ?? this.strategyId();
    if (!id) return;
    this.loading.set(true);
    this.error.set(false);
    this.strategies
      .getVariants(id)
      .pipe(
        map((res) => (res.status ? (res.data ?? []) : null)),
        catchError(() => of(null)),
        finalize(() => this.loading.set(false)),
      )
      .subscribe((rows) => {
        if (rows === null) this.error.set(true);
        else this.variants.set(rows);
      });
  }

  protected formatJson(json: string | null): string {
    if (!json) return '';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  // Promote modal --------------------------------------------------------
  protected readonly pending = signal<StrategyVariantDto | null>(null);
  protected reasonText = '';
  protected readonly submitting = signal(false);

  protected askPromote(v: StrategyVariantDto): void {
    this.reasonText = '';
    this.pending.set(v);
  }

  protected cancel(): void {
    if (this.submitting()) return;
    this.pending.set(null);
  }

  protected confirm(): void {
    const v = this.pending();
    if (!v) return;
    this.submitting.set(true);
    const reason = this.reasonText.trim();
    this.strategies
      .promoteVariant(v.id)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.pending.set(null);
          this.load();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(`Variant #${v.id} promoted.`);
            this.auditTrail
              .create({
                entityType: 'StrategyVariant',
                entityId: v.id,
                decisionType: 'StrategyVariantPromoted',
                outcome: 'Promoted',
                reason: reason || null,
                contextJson: JSON.stringify({
                  baseStrategyId: v.baseStrategyId,
                  name: v.name,
                  shadowSignalCount: v.shadowSignalCount,
                  shadowSharpeRatio: v.shadowSharpeRatio,
                }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          } else {
            this.notify.error(res.message ?? 'Variant promotion failed.');
          }
        },
        error: () => this.notify.error('Variant promotion failed.'),
      });
  }
}
