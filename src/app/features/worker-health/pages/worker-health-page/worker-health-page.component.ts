import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';

import { WorkersService } from '@core/services/workers.service';
import type { WorkerHealthDto, WorkerHealthStatus } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

type StatusFilter = 'all' | WorkerHealthStatus;

@Component({
  selector: 'app-worker-health-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    FormsModule,
    DatePipe,
    DecimalPipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Worker Health"
        subtitle="Real-time snapshot of every background worker"
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (workers().length > 0) {
        <div class="metrics">
          <app-metric-card
            label="Total Workers"
            [value]="workers().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Healthy"
            [value]="healthyCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Degraded"
            [value]="degradedCount()"
            format="number"
            dotColor="#FF9500"
          />
          <app-metric-card
            label="Failed"
            [value]="failedCount()"
            format="number"
            dotColor="#FF3B30"
          />
        </div>

        <div class="toolbar">
          <input
            type="text"
            class="input search"
            placeholder="Filter by name…"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
          <select
            class="input"
            [ngModel]="statusFilter()"
            (ngModelChange)="statusFilter.set($event)"
          >
            <option value="all">All statuses</option>
            <option value="Healthy">Healthy</option>
            <option value="Degraded">Degraded</option>
            <option value="Failed">Failed</option>
            <option value="Idle">Idle</option>
          </select>
          <select
            class="input"
            [ngModel]="categoryFilter()"
            (ngModelChange)="categoryFilter.set($event)"
          >
            <option value="all">All categories</option>
            @for (c of categories(); track c) {
              <option [value]="c">{{ c }}</option>
            }
          </select>
          <span class="muted">{{ filtered().length }} of {{ workers().length }}</span>
        </div>

        <section class="grid">
          @for (w of filtered(); track w.name) {
            <article class="card" [attr.data-status]="w.status">
              <header class="card-head">
                <span class="status-dot" [attr.data-status]="w.status"></span>
                <div class="title">
                  <h4>{{ w.name }}</h4>
                  @if (w.category) {
                    <span class="muted">{{ w.category }}</span>
                  }
                </div>
                <span class="pill" [attr.data-status]="w.status">{{ w.status }}</span>
              </header>
              <dl class="metrics-grid">
                <div>
                  <dt>Last Cycle</dt>
                  <dd class="mono">{{ w.lastCycleMs | number: '1.0-0' }}ms</dd>
                </div>
                <div>
                  <dt>Avg Cycle</dt>
                  <dd class="mono">
                    {{ w.avgCycleMs !== null ? (w.avgCycleMs | number: '1.0-0') + 'ms' : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Error Rate</dt>
                  <dd class="mono">{{ w.errorRate * 100 | number: '1.0-2' }}%</dd>
                </div>
                <div>
                  <dt>Backlog</dt>
                  <dd class="mono">{{ w.backlog !== null ? (w.backlog | number) : '—' }}</dd>
                </div>
              </dl>
              <footer class="card-foot muted">
                @if (w.lastSuccessAt) {
                  <span>Last success {{ w.lastSuccessAt | date: 'HH:mm:ss' }}</span>
                }
                @if (w.lastFailureAt) {
                  <span class="err">Last failure {{ w.lastFailureAt | date: 'HH:mm:ss' }}</span>
                }
                @if (w.lastMessage) {
                  <span class="msg">{{ w.lastMessage }}</span>
                }
              </footer>
            </article>
          }
        </section>
      } @else {
        <app-empty-state
          title="No worker data"
          description="The engine did not return any workers from /health/workers."
        />
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-4);
      }
      @media (max-width: 768px) {
        .metrics {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .toolbar {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .search {
        flex: 1 1 200px;
        min-width: 200px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        transition: border-color 0.15s ease;
      }
      .card[data-status='Healthy'] {
        border-left: 3px solid var(--profit);
      }
      .card[data-status='Degraded'] {
        border-left: 3px solid var(--warning);
      }
      .card[data-status='Failed'] {
        border-left: 3px solid var(--loss);
      }
      .card[data-status='Idle'] {
        border-left: 3px solid var(--text-tertiary);
      }
      .card-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--text-tertiary);
        flex-shrink: 0;
      }
      .status-dot[data-status='Healthy'] {
        background: var(--profit);
      }
      .status-dot[data-status='Degraded'] {
        background: var(--warning);
      }
      .status-dot[data-status='Failed'] {
        background: var(--loss);
      }
      .title {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .title h4 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .title .muted {
        font-size: 11px;
      }
      .pill {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pill[data-status='Healthy'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-status='Degraded'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .pill[data-status='Failed'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-2);
        margin: 0;
      }
      .metrics-grid dt {
        font-size: 11px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .metrics-grid dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .metrics-grid dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .card-foot {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 11px;
        border-top: 1px solid var(--border);
        padding-top: var(--space-2);
      }
      .card-foot .err {
        color: var(--loss);
      }
      .card-foot .msg {
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class WorkerHealthPageComponent {
  private readonly workersService = inject(WorkersService);

  protected readonly resource = createPolledResource(
    () =>
      this.workersService.list().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as WorkerHealthDto[])),
      ),
    { intervalMs: 30_000 },
  );

  readonly workers = computed(() => this.resource.value() ?? []);
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);

  readonly search = signal('');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly categoryFilter = signal<string>('all');

  readonly categories = computed(() => {
    const set = new Set<string>();
    for (const w of this.workers()) {
      if (w.category) set.add(w.category);
    }
    return Array.from(set).sort();
  });

  readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim();
    const st = this.statusFilter();
    const cat = this.categoryFilter();
    return this.workers().filter((w) => {
      if (st !== 'all' && w.status !== st) return false;
      if (cat !== 'all' && w.category !== cat) return false;
      if (q && !w.name.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  readonly healthyCount = computed(
    () => this.workers().filter((w) => w.status === 'Healthy').length,
  );
  readonly degradedCount = computed(
    () => this.workers().filter((w) => w.status === 'Degraded').length,
  );
  readonly failedCount = computed(() => this.workers().filter((w) => w.status === 'Failed').length);

  refresh(): void {
    this.resource.refresh();
  }
}
