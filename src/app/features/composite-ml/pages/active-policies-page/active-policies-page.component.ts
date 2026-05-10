import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import type { ActivePolicyDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type TierFilter = 'all' | 'live' | 'coldstart';

@Component({
  selector: 'app-active-policies-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CompositeML — Active Policies"
        subtitle="One row per (Symbol, Timeframe, IsColdStart) partition tier"
      >
        <a routerLink="/composite-ml/layer-health" class="btn btn-secondary">Layer Health →</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load active policies"
          message="Engine returned an error. Verify the engine is reachable and the CompositeML controller is wired."
          (retry)="resource.refresh()"
        />
      } @else {
        <div class="kpis">
          <app-metric-card
            label="Active partitions"
            [value]="policies().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Cold-start tiers"
            [value]="coldStartCount()"
            format="number"
            [dotColor]="coldStartCount() > 0 ? '#AF52DE' : '#34C759'"
          />
          <app-metric-card
            label="Distinct trainers"
            [value]="distinctTrainers().length"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Most recent activation"
            [value]="null"
            format="number"
            dotColor="#0071E3"
          />
        </div>

        <section class="card">
          <header class="filters">
            <div class="filter-group">
              <label for="tier">Tier</label>
              <select id="tier" [(ngModel)]="tierFilter">
                <option value="all">All ({{ policies().length }})</option>
                <option value="live">Live ({{ policies().length - coldStartCount() }})</option>
                <option value="coldstart">Cold-start ({{ coldStartCount() }})</option>
              </select>
            </div>

            <div class="filter-group">
              <label for="trainer">Trainer</label>
              <select id="trainer" [(ngModel)]="trainerFilter">
                <option value="all">All trainers</option>
                @for (t of distinctTrainers(); track t) {
                  <option [value]="t">{{ t }}</option>
                }
              </select>
            </div>

            <div class="filter-group">
              <label for="search">Symbol</label>
              <input
                id="search"
                type="search"
                placeholder="e.g. EURUSD"
                [(ngModel)]="symbolFilter"
              />
            </div>

            <span class="result-count">
              {{ filteredPolicies().length }} of {{ policies().length }}
            </span>
          </header>

          @if (filteredPolicies().length === 0) {
            <app-empty-state
              title="No matching policies"
              description="Adjust the filters or wait for the next activation cycle."
            />
          } @else {
            <table class="policies-table">
              <thead>
                <tr>
                  <th>Snapshot</th>
                  <th>Pair</th>
                  <th>Tier</th>
                  <th>Trainer</th>
                  <th>Outcome</th>
                  <th class="num">Activated</th>
                  <th>Knob delta</th>
                </tr>
              </thead>
              <tbody>
                @for (p of filteredPolicies(); track p.id) {
                  <tr [class.expanded]="expandedId() === p.id">
                    <td>
                      <span class="mono">#{{ p.id }}</span>
                    </td>
                    <td>
                      @if (p.symbol) {
                        <span class="pair">
                          <span class="symbol">{{ p.symbol }}</span>
                          @if (p.timeframe) {
                            <span class="timeframe">{{ p.timeframe }}</span>
                          }
                        </span>
                      } @else {
                        <span class="muted">global</span>
                      }
                    </td>
                    <td>
                      @if (p.isColdStart) {
                        <span class="tier-pill cold">cold-start</span>
                      } @else {
                        <span class="tier-pill live">live</span>
                      }
                    </td>
                    <td>
                      @if (p.trainer) {
                        <span class="mono">{{ p.trainer }}</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      <span class="outcome">{{ p.evaluationOutcome }}</span>
                    </td>
                    <td class="num">
                      @if (p.activatedAtUtc) {
                        <span [title]="p.activatedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                          {{ p.activatedAtUtc | relativeTime }}
                        </span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      @if (p.policyKnobDeltaJson) {
                        <button type="button" class="link" (click)="toggleExpand(p.id)">
                          {{ expandedId() === p.id ? 'Hide' : 'Show' }} delta
                        </button>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                  @if (expandedId() === p.id && p.policyKnobDeltaJson) {
                    <tr class="delta-row">
                      <td colspan="7">
                        <pre class="delta-json">{{ formatDeltaJson(p.policyKnobDeltaJson) }}</pre>
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          }
        </section>

        <p class="footnote">
          Walk a snapshot's ancestry chain via
          <code class="mono">/composite-ml/policy-lineage/{{ '{id}' }}</code
          >; diff two snapshots via
          <code class="mono">/composite-ml/policy-snapshots/diff?fromId=&amp;toId=</code>. UI
          surfaces for both ship later in Phase 1.
        </p>
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
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        align-items: end;
        margin-bottom: var(--space-4);
      }
      .filter-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .filter-group label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .filter-group select,
      .filter-group input {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 140px;
      }
      .result-count {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin-left: auto;
        align-self: center;
      }
      .policies-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .policies-table th,
      .policies-table td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .policies-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .policies-table tr.expanded {
        background: var(--bg-primary);
      }
      .policies-table td.num,
      .policies-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: 0.95em;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .pair {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
      }
      .symbol {
        font-weight: var(--font-semibold);
      }
      .timeframe {
        color: var(--text-secondary);
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .tier-pill {
        display: inline-block;
        padding: 2px 8px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        border-radius: var(--radius-full);
      }
      .tier-pill.live {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .tier-pill.cold {
        background: rgba(175, 82, 222, 0.12);
        color: #8e44ad;
      }
      .outcome {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        padding: 2px 8px;
        background: var(--bg-primary);
        border-radius: var(--radius-full);
      }
      .link {
        background: none;
        border: none;
        color: var(--accent);
        cursor: pointer;
        font-size: var(--text-sm);
        padding: 0;
      }
      .link:hover {
        text-decoration: underline;
      }
      .delta-row td {
        padding: 0 12px 12px;
        background: var(--bg-primary);
      }
      .delta-json {
        background: var(--bg-tertiary, #f5f5f7);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-family: var(--font-mono);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 320px;
        overflow: auto;
        color: var(--text-secondary);
      }
      .footnote {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .footnote code {
        background: var(--bg-secondary);
        padding: 1px 5px;
        border-radius: 4px;
      }
    `,
  ],
})
export class ActivePoliciesPageComponent {
  private readonly compositeMl = inject(CompositeMLService);

  protected readonly resource = createPolledResource(
    () =>
      this.compositeMl.listActivePolicies().pipe(
        map((res) => res.data ?? []),
        catchError(() => of([] as ActivePolicyDto[])),
      ),
    // 60s — operators don't make rapid-fire activations; reduce engine load.
    { intervalMs: 60_000 },
  );

  protected readonly tierFilter = signal<TierFilter>('all');
  protected readonly trainerFilter = signal<string>('all');
  protected readonly symbolFilter = signal<string>('');
  protected readonly expandedId = signal<number | null>(null);

  protected readonly policies = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.policies().length === 0,
  );

  protected readonly coldStartCount = computed(
    () => this.policies().filter((p) => p.isColdStart).length,
  );

  protected readonly distinctTrainers = computed(() => {
    const set = new Set<string>();
    for (const p of this.policies()) {
      if (p.trainer) set.add(p.trainer);
    }
    return [...set].sort();
  });

  protected readonly filteredPolicies = computed(() => {
    const tier = this.tierFilter();
    const trainer = this.trainerFilter();
    const symbolNeedle = this.symbolFilter().trim().toUpperCase();
    return this.policies().filter((p) => {
      if (tier === 'live' && p.isColdStart) return false;
      if (tier === 'coldstart' && !p.isColdStart) return false;
      if (trainer !== 'all' && p.trainer !== trainer) return false;
      if (symbolNeedle && !(p.symbol ?? '').toUpperCase().includes(symbolNeedle)) return false;
      return true;
    });
  });

  protected toggleExpand(id: number): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  protected formatDeltaJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }
}
