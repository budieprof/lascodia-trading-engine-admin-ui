import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import { unwrapResponse } from '@core/api/api.service';
import { createPolledResource } from '@core/polling/polled-resource';

import { OptionsHealthCardComponent } from '../../components/options-health-card/options-health-card.component';
import { CompositeMlNavComponent } from '../../components/composite-ml-nav/composite-ml-nav.component';
import { CompositeMlPipelineStateComponent } from '../../components/pipeline-state/pipeline-state.component';
import { CompositeMlEvidenceFloorsComponent } from '../../components/evidence-floors/evidence-floors.component';
import { ageText, utcText, type PipelineState } from '../../composite-ml-pipeline.logic';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
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
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    OptionsHealthCardComponent,
    CompositeMlNavComponent,
    CompositeMlPipelineStateComponent,
    CompositeMlEvidenceFloorsComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CompositeML — Active Policies"
        subtitle="One row per (Symbol, Timeframe, IsColdStart) partition tier"
      />
      <app-composite-ml-nav
        [showRefresh]="true"
        [refreshing]="resource.refreshing()"
        (refresh)="resource.refresh()"
      />

      <app-options-health-card />

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load active policies"
          message="Engine returned an error. Verify the engine is reachable and the CompositeML controller is wired."
          (retry)="resource.refresh()"
        />
      } @else if (policies().length === 0) {
        <!-- No active snapshot exists at all (not a filter miss): show what the pipeline holds and
             why nothing was activated, instead of four zero tiles over an empty table. -->
        <div class="kpis">
          <div class="kpi">
            <span class="kpi-label">Active partitions</span>
            <span class="kpi-value dim">0</span>
            <span class="kpi-hint">no policy snapshot is active</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Policy snapshots</span>
            <span class="kpi-value" [class.dim]="!dataset('policySnapshots')?.rows">{{
              count(dataset('policySnapshots')?.rows)
            }}</span>
            <span class="kpi-hint">ever written by the policy trainer</span>
          </div>
          <div class="kpi tone-info">
            <span class="kpi-label">Generation decisions</span>
            <span class="kpi-value" [class.dim]="!dataset('generationAudits')?.rows">{{
              count(dataset('generationAudits')?.rows)
            }}</span>
            <span class="kpi-hint" [title]="newestUtc('generationAudits')">{{
              newestCaption('generationAudits')
            }}</span>
          </div>
          <div class="kpi tone-warn">
            <span class="kpi-label">CompositeML strategies</span>
            <span class="kpi-value">{{
              count(pipeline()?.datasets?.length ? pipeline()!.strategiesLive : null)
            }}</span>
            <span class="kpi-hint">{{
              pipeline()?.strategiesEverGenerated
                ? 'remaining of ' + pipeline()!.strategiesEverGenerated + ' generated'
                : 'remaining'
            }}</span>
          </div>
        </div>
        <app-composite-ml-pipeline-state
          variant="full"
          [focus]="['policySnapshots', 'generationAudits']"
          pageSummary="A policy snapshot is the set of scoring weights the CompositeML generator uses for one symbol and timeframe (or globally). The policy trainer writes one from the generator's matured decisions and activates it once it beats the current one; this tab lists the active ones. None is active right now."
          (stateChange)="pipeline.set($event)"
        />
        <app-composite-ml-evidence-floors
          [prefixes]="['PolicyTraining.']"
          title="Evidence the policy trainers need before a snapshot can activate"
        />
      } @else {
        <app-composite-ml-pipeline-state
          variant="compact"
          [focus]="['policySnapshots']"
          (stateChange)="pipeline.set($event)"
        />
        <div class="kpis">
          <div class="kpi tone-info">
            <span class="kpi-label">Active partitions</span>
            <span class="kpi-value">{{ count(policies().length) }}</span>
            <span class="kpi-hint">symbol × timeframe × tier</span>
          </div>
          <div class="kpi" [class.tone-purple]="coldStartCount() > 0">
            <span class="kpi-label">Cold-start tiers</span>
            <span class="kpi-value" [class.dim]="coldStartCount() === 0">{{
              count(coldStartCount())
            }}</span>
            <span class="kpi-hint">partitions marked cold-start</span>
          </div>
          <div class="kpi tone-good">
            <span class="kpi-label">Distinct trainers</span>
            <span class="kpi-value">{{ count(distinctTrainers().length) }}</span>
            <span class="kpi-hint" [title]="distinctTrainers().join(', ')">{{
              distinctTrainers().join(', ') || 'none named'
            }}</span>
          </div>
          <div class="kpi tone-good">
            <span class="kpi-label">Live tiers</span>
            <span class="kpi-value">{{ count(policies().length - coldStartCount()) }}</span>
            <span class="kpi-hint">partitions not cold-start</span>
          </div>
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
              @if (latestActivation(); as at) {
                · latest activation
                <span [title]="at | date: 'yyyy-MM-dd HH:mm:ss UTC'">{{ at | relativeTime }}</span>
              }
            </span>
          </header>

          @if (filteredPolicies().length === 0) {
            <app-empty-state
              title="No matching policies"
              description="No active policy matches these filters. Clear the symbol or pick another tier or trainer."
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
                      <a
                        class="snapshot-link mono"
                        [routerLink]="['/composite-ml/snapshot', p.id]"
                        title="Walk ancestry chain"
                      >
                        #{{ p.id }}
                      </a>
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
          Click a snapshot id to walk its ancestry chain; use the <strong>Diff</strong> tab to
          compare any two snapshots knob by knob.
        </p>
      }
    </div>
  `,
  styles: [
    `
      /* Pill/text tones. The light-theme hexes these replace (#0040dd blue at
         ~2.2:1, #c93400 amber, #d70015 red ~3:1) were used on the dark theme
         too, where they were barely readable; dark gets the system tints. */
      :host {
        --tone-green: #248a3d;
        --tone-amber: #c93400;
        --tone-red: #d70015;
        --tone-blue: #0040dd;
        --tone-grey: #636366;
        --tone-purple: #8e44ad;
      }
      :host-context([data-theme='dark']) {
        --tone-green: #30d158;
        --tone-amber: #ff9f0a;
        --tone-red: #ff6961;
        --tone-blue: #64d2ff;
        --tone-grey: #a1a1a6;
        --tone-purple: #bf5af2;
      }
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      /* KPI strip — Drift Report family: tone stripe, short label, figure, one-line caption. */
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));
        gap: var(--space-3);
      }
      .kpi {
        --tone: var(--text-tertiary);
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        overflow: hidden;
        padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + 2px);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
      }
      .kpi::before {
        content: '';
        position: absolute;
        inset: 0 auto 0 0;
        width: 3px;
        background: var(--tone);
        opacity: 0.35;
      }
      .kpi.tone-info {
        --tone: var(--accent);
      }
      .kpi.tone-good {
        --tone: var(--profit);
      }
      .kpi.tone-warn {
        --tone: var(--warning);
      }
      .kpi.tone-purple {
        --tone: var(--tone-purple);
      }
      .kpi[class*='tone-']::before {
        opacity: 1;
      }
      .kpi-label {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kpi-value {
        font-size: 26px;
        line-height: 1.2;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .kpi-value.dim {
        color: var(--text-tertiary);
      }
      .kpi-hint {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--bg-primary);
        white-space: nowrap;
      }
      .policies-table tbody tr:hover td {
        background: var(--bg-primary);
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
      .snapshot-link {
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-semibold);
      }
      .snapshot-link:hover {
        text-decoration: underline;
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
        color: var(--tone-green);
      }
      .tier-pill.cold {
        background: rgba(175, 82, 222, 0.12);
        color: var(--tone-purple);
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
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        padding: 3px 10px;
        margin-left: -10px;
        border-radius: var(--radius-full);
      }
      .link:hover {
        background: rgba(0, 113, 227, 0.08);
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
      // Errors propagate: swallowing them into [] made an engine failure read
      // as "no policies" and left the error state below unreachable.
      this.compositeMl.listActivePolicies().pipe(map(unwrapResponse)),
    // Activations arrive as pushes; the fallback stays slow because operators
    // don't make rapid-fire activations and the engine load is not worth it.
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['compositeMLCatalogueDriftDropAlert', 'mlModelActivated', 'mlModelRetired'],
    },
  );

  protected readonly pipeline = signal<PipelineState | null>(null);

  protected dataset(key: string) {
    return this.pipeline()?.datasets.find((d) => d.key === key) ?? null;
  }
  protected newestCaption(key: string): string {
    const d = this.dataset(key);
    return d?.latestUtc ? `newest ${ageText(d.latestUtc, Date.now())}` : 'none recorded yet';
  }
  protected newestUtc(key: string): string {
    return utcText(this.dataset(key)?.latestUtc ?? null);
  }
  /** Tile figure: grouped thousands, or a dash while the pipeline state is still loading. */
  protected count(n: number | null | undefined): string {
    return n == null ? '—' : n.toLocaleString('en-US');
  }

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

  /** Newest activatedAtUtc across the active set, or null when none carry one. */
  protected readonly latestActivation = computed<string | null>(() => {
    let best: string | null = null;
    for (const p of this.policies()) {
      if (p.activatedAtUtc && (best === null || p.activatedAtUtc > best)) best = p.activatedAtUtc;
    }
    return best;
  });

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
