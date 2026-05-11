import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, finalize, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import type { StrategyRejectionDistributionDto } from '@core/api/api.types';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Right-side drawer that answers "why isn't this strategy generating signals?"
 * by querying /strategy/{id}/rejection-distribution and rendering per-gate
 * reject counts + per-reason breakdowns over a selectable window (PRD §5.3
 * FR-3.6). Caller owns the open/close state and embeds the component when
 * needed; the drawer reads the strategyId via input and refetches on change.
 */
@Component({
  selector: 'app-rejection-distribution-drawer',
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
    <div class="overlay" (click)="closed.emit()" role="presentation">
      <aside
        class="drawer"
        (click)="$event.stopPropagation()"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rdd-title"
      >
        <header class="drawer-head">
          <div>
            <h2 id="rdd-title">Pipeline rejections</h2>
            <p class="sub muted small">
              Why didn't this strategy fire? Reasons grouped by gate, ordered by count.
            </p>
          </div>
          <button type="button" class="close-btn" (click)="closed.emit()" aria-label="Close">
            ×
          </button>
        </header>

        <section class="controls">
          <div class="control-group">
            <label for="rdd-window">Window</label>
            <div class="window-pills">
              @for (h of WINDOW_HOURS; track h) {
                <button
                  type="button"
                  [class.active]="windowHours() === h"
                  (click)="windowHours.set(h)"
                >
                  {{ formatWindow(h) }}
                </button>
              }
            </div>
          </div>
        </section>

        @if (loading()) {
          <app-card-skeleton [lines]="6" />
        } @else if (error()) {
          <app-error-state
            title="Could not load rejection distribution"
            message="Engine returned an error. The signal-rejection audit may be paused."
            (retry)="load()"
          />
        } @else if (!data() || data()!.totalRejections === 0) {
          <app-empty-state
            title="No rejections in this window"
            description="Either no signals were generated (and so nothing got rejected) or no gates fired in the selected window."
          />
        } @else {
          <section class="summary">
            <span class="kpi">
              <strong>{{ data()!.totalRejections | number: '1.0-0' }}</strong> total rejections
            </span>
            <span class="kpi">
              <strong>{{ data()!.stages.length }}</strong> distinct gate{{
                data()!.stages.length === 1 ? '' : 's'
              }}
            </span>
            @if (data()!.from && data()!.to) {
              <span class="kpi muted">
                <span [title]="data()!.from! | date: 'yyyy-MM-dd HH:mm UTC'">
                  {{ data()!.from! | relativeTime }}
                </span>
                →
                <span [title]="data()!.to! | date: 'yyyy-MM-dd HH:mm UTC'">
                  {{ data()!.to! | relativeTime }}
                </span>
              </span>
            }
          </section>

          <ol class="stages">
            @for (stage of data()!.stages; track stage.stage) {
              <li class="stage">
                <header class="stage-head">
                  <span class="stage-name mono">{{ stage.stage }}</span>
                  <span class="stage-count mono">
                    {{ stage.count | number: '1.0-0' }}
                    <span class="muted small">
                      ({{ (stage.count / data()!.totalRejections) * 100 | number: '1.0-1' }}%)
                    </span>
                  </span>
                </header>
                <div class="bar-track">
                  <span
                    class="bar-fill"
                    [style.width.%]="(stage.count / data()!.totalRejections) * 100"
                  ></span>
                </div>
                <ul class="reasons">
                  @for (r of stage.reasons; track r.reason) {
                    <li class="reason">
                      <span class="reason-name mono small">{{ r.reason }}</span>
                      <span class="reason-count mono small">
                        {{ r.count | number: '1.0-0' }}
                      </span>
                      <span class="reason-when muted small">
                        first
                        <span [title]="r.firstSeen | date: 'yyyy-MM-dd HH:mm UTC'">
                          {{ r.firstSeen | relativeTime }}
                        </span>
                        · last
                        <span [title]="r.lastSeen | date: 'yyyy-MM-dd HH:mm UTC'">
                          {{ r.lastSeen | relativeTime }}
                        </span>
                      </span>
                    </li>
                  }
                </ul>
              </li>
            }
          </ol>
        }
      </aside>
    </div>
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.4));
        z-index: 1000;
        display: flex;
        justify-content: flex-end;
      }
      .drawer {
        width: min(560px, 100%);
        background: var(--bg-primary);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-5);
        overflow-y: auto;
      }
      .drawer-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .drawer-head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .sub {
        margin: 4px 0 0;
      }
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary);
        cursor: pointer;
        line-height: 1;
      }
      .controls {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .control-group {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .control-group label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .window-pills {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-secondary);
        padding: 4px;
        border-radius: var(--radius-md);
      }
      .window-pills button {
        background: transparent;
        border: none;
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .window-pills button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .summary {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
        padding: var(--space-3);
      }
      .kpi {
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .kpi strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        margin-right: 4px;
      }
      .kpi.muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .stages {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .stage {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .stage-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .stage-name {
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
      }
      .stage-count {
        font-variant-numeric: tabular-nums;
        font-size: var(--text-sm);
      }
      .bar-track {
        width: 100%;
        height: 6px;
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        overflow: hidden;
      }
      .bar-fill {
        display: block;
        height: 100%;
        background: #ff9500;
        border-radius: var(--radius-full);
      }
      .reasons {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .reason {
        display: grid;
        grid-template-columns: 1fr max-content;
        grid-template-areas: 'name count' 'when when';
        gap: 2px var(--space-2);
        padding: 6px 0;
        border-top: 1px solid var(--border);
      }
      .reason-name {
        grid-area: name;
        font-weight: var(--font-medium);
      }
      .reason-count {
        grid-area: count;
        font-variant-numeric: tabular-nums;
      }
      .reason-when {
        grid-area: when;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class RejectionDistributionDrawerComponent {
  private readonly strategies = inject(StrategiesService);

  readonly strategyId = input.required<number>();
  readonly closed = output<void>();

  protected readonly WINDOW_HOURS: readonly number[] = [24, 72, 168, 720] as const;
  protected readonly windowHours = signal<number>(168);

  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly data = signal<StrategyRejectionDistributionDto | null>(null);

  constructor() {
    effect(() => {
      this.strategyId();
      this.windowHours();
      this.load();
    });
  }

  protected load(): void {
    const id = this.strategyId();
    if (!id) return;
    this.loading.set(true);
    this.error.set(false);
    const to = new Date();
    const from = new Date(to.getTime() - this.windowHours() * 3600 * 1000);
    this.strategies
      .getRejectionDistribution(id, { from: from.toISOString(), to: to.toISOString() })
      .pipe(
        map((res) => (res.status ? (res.data ?? null) : null)),
        catchError(() => of(null)),
        finalize(() => this.loading.set(false)),
      )
      .subscribe((d) => {
        if (d === null) this.error.set(true);
        else this.data.set(d);
      });
  }

  protected formatWindow(h: number): string {
    if (h < 48) return `${h}h`;
    if (h < 168) return `${Math.round(h / 24)}d`;
    if (h < 720) return `${Math.round(h / 168)}w`;
    return `${Math.round(h / 168)}w`;
  }
}
