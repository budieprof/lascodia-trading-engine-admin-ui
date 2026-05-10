import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import type { SkillOverrideAction, Timeframe, TrainerSkillSnapshotDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-trainer-skill-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CompositeML — Trainer Skill"
        subtitle="Per-(trainer, partition tier) skill estimates driving promotion suppression"
      >
        <a routerLink="/composite-ml/layer-skill" class="btn btn-secondary">← Layer Skill</a>
        <a routerLink="/composite-ml" class="btn btn-secondary">Active Policies</a>
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
        <app-card-skeleton [lines]="8" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load trainer-skill snapshots"
          message="Engine returned an error. The trainer evaluator may not be enabled — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpi-strip">
          <span class="kpi"
            ><strong>{{ snapshots().length }}</strong> snapshots</span
          >
          <span class="kpi"
            ><strong>{{ distinctTrainers().length }}</strong> distinct trainers</span
          >
          <span class="kpi" [class.warn]="autoDisabledCount() > 0">
            <strong>{{ autoDisabledCount() }}</strong> auto-suppressed
          </span>
        </section>

        @if (snapshots().length === 0) {
          <app-empty-state
            title="No active trainer-skill snapshots"
            description="The trainer evaluator hasn't recorded any skill snapshots yet."
          />
        } @else {
          <section class="card">
            <table class="skill-table">
              <thead>
                <tr>
                  <th>Trainer</th>
                  <th>Scope</th>
                  <th class="num">Obs (A / Alt)</th>
                  <th class="num">Mean reward (A / Alt)</th>
                  <th class="num">Skill ± SE</th>
                  <th class="num">Z</th>
                  <th>Status</th>
                  <th>Evaluated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (row of snapshots(); track row.id) {
                  <tr>
                    <td class="mono trainer-cell">{{ row.trainerId }}</td>
                    <td>
                      <span class="scope-pill" [attr.data-tier]="tierOf(row)">
                        {{ scopeLabel(row) }}
                      </span>
                    </td>
                    <td class="num mono">
                      {{ row.observationsActive }} / {{ row.observationsAlternate }}
                    </td>
                    <td class="num mono">
                      {{ row.meanRewardActive | number: '1.0-4' }}
                      <span class="muted small">/</span>
                      {{ row.meanRewardAlternate | number: '1.0-4' }}
                    </td>
                    <td class="num mono">
                      {{ row.skillEstimate | number: '1.0-4' }}
                      <span class="muted small"
                        >± {{ row.skillStandardError | number: '1.0-3' }}</span
                      >
                    </td>
                    <td class="num mono" [attr.data-sig]="zSignificance(row.zStatistic)">
                      @if (row.zStatistic !== null) {
                        {{ row.zStatistic | number: '1.0-2' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      @if (row.autoDisabledUntilUtc) {
                        <span
                          class="status-pill suppressed"
                          [title]="
                            'Until ' + (row.autoDisabledUntilUtc | date: 'yyyy-MM-dd HH:mm UTC')
                          "
                        >
                          auto-suppressed
                        </span>
                      } @else {
                        <span class="status-pill active">active</span>
                      }
                    </td>
                    <td class="time" [title]="row.evaluatedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ row.evaluatedAtUtc | relativeTime }}
                    </td>
                    <td>
                      <button type="button" class="override-btn" (click)="openOverride(row)">
                        Override
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }

      @if (overrideTarget(); as target) {
        <div class="modal-overlay" (click)="closeOverride()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>Override trainer skill</h2>
              <button type="button" class="close-btn" (click)="closeOverride()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              <span class="mono">{{ target.trainerId }}</span> · {{ scopeLabel(target) }}
            </p>

            <fieldset class="action-fieldset">
              <legend>Action</legend>
              <label>
                <input type="radio" name="action" value="enabled" [(ngModel)]="pickedAction" />
                <span>Force <strong class="ok">enabled</strong> — allow promotions</span>
              </label>
              <label>
                <input type="radio" name="action" value="disabled" [(ngModel)]="pickedAction" />
                <span>Force <strong class="warn">disabled</strong> — suppress promotions</span>
              </label>
              <label>
                <input type="radio" name="action" value="clear" [(ngModel)]="pickedAction" />
                <span>Clear override — return to automated resolution</span>
              </label>
            </fieldset>

            <label class="reason-field">
              <span>Reason (written to audit trail)</span>
              <textarea
                rows="3"
                [(ngModel)]="reasonText"
                placeholder="Why is this override needed?"
              ></textarea>
            </label>

            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="closeOverride()">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="applyOverride()"
                [disabled]="!canSubmit()"
              >
                {{ submitting() ? 'Applying…' : 'Apply' }}
              </button>
            </footer>
          </div>
        </div>
      }
    </div>
  `,
  styles: [trainerSkillStyles()],
})
export class TrainerSkillPageComponent {
  private readonly compositeMl = inject(CompositeMLService);
  private readonly auditTrail = inject(AuditTrailService);

  protected readonly resource = createPolledResource(
    () =>
      this.compositeMl.listTrainerSkillSnapshots().pipe(
        map((res) => res.data ?? []),
        catchError(() => of([] as TrainerSkillSnapshotDto[])),
      ),
    { intervalMs: 30_000 },
  );

  protected readonly snapshots = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.snapshots().length === 0,
  );

  protected readonly distinctTrainers = computed(() => {
    const set = new Set<string>();
    for (const row of this.snapshots()) set.add(row.trainerId);
    return [...set].sort();
  });

  protected readonly autoDisabledCount = computed(
    () => this.snapshots().filter((s) => s.autoDisabledUntilUtc !== null).length,
  );

  protected readonly overrideTarget = signal<TrainerSkillSnapshotDto | null>(null);
  protected pickedAction: SkillOverrideAction = 'disabled';
  protected reasonText = '';
  protected readonly submitting = signal(false);

  protected openOverride(row: TrainerSkillSnapshotDto): void {
    this.pickedAction = 'disabled';
    this.reasonText = '';
    this.overrideTarget.set(row);
  }

  protected closeOverride(): void {
    if (this.submitting()) return;
    this.overrideTarget.set(null);
  }

  protected canSubmit = (): boolean => {
    if (this.submitting()) return false;
    return this.reasonText.trim().length >= 4;
  };

  protected applyOverride(): void {
    const target = this.overrideTarget();
    if (!target || !this.canSubmit()) return;
    this.submitting.set(true);
    const payload = {
      trainerId: target.trainerId,
      action: this.pickedAction,
      symbol: target.symbol,
      timeframe: target.timeframe ?? null,
    };
    this.compositeMl
      .setTrainerSkillOverride(payload)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.overrideTarget.set(null);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.auditTrail
              .create({
                entityType: 'CompositeMLTrainerSkill',
                entityId: target.id,
                decisionType: 'TrainerSkillOverride',
                outcome: this.pickedAction,
                reason: this.reasonText.trim(),
                contextJson: JSON.stringify(payload),
                source: 'AdminUI',
              })
              .subscribe({
                error: () => {
                  /* best-effort */
                },
              });
          }
        },
        error: () => {
          /* error state handled via resource auto-retry */
        },
      });
  }

  protected tierOf(row: TrainerSkillSnapshotDto): 'global' | 'symbol' | 'pair' {
    if (!row.symbol) return 'global';
    if (!row.timeframe) return 'symbol';
    return 'pair';
  }

  protected scopeLabel(row: TrainerSkillSnapshotDto): string {
    return scopeLabelFor(row.symbol, row.timeframe);
  }

  protected zSignificance(z: number | null): 'none' | 'weak' | 'strong' {
    if (z === null) return 'none';
    const a = Math.abs(z);
    if (a >= 2.5) return 'strong';
    if (a >= 1.5) return 'weak';
    return 'none';
  }
}

function scopeLabelFor(symbol: string | null, timeframe: Timeframe | null): string {
  if (!symbol) return 'global';
  if (!timeframe) return symbol;
  return `${symbol} · ${timeframe}`;
}

function trainerSkillStyles(): string {
  // Style block is identical to the layer-skill page — the two pages share
  // visual language but live as separate routed components for URL clarity.
  return `
    .page {
      padding: var(--space-2) 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .kpi-strip {
      display: flex;
      gap: var(--space-4);
      align-items: center;
      flex-wrap: wrap;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-3) var(--space-4);
    }
    .kpi {
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }
    .kpi strong {
      color: var(--text-primary);
      font-weight: var(--font-semibold);
      font-variant-numeric: tabular-nums;
      margin-right: 4px;
    }
    .kpi.warn {
      color: #c93400;
    }
    .kpi.warn strong {
      color: #c93400;
    }
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--card-padding);
      box-shadow: var(--shadow-sm);
      overflow-x: auto;
    }
    .skill-table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--text-sm);
    }
    .skill-table th,
    .skill-table td {
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .skill-table th {
      color: var(--text-secondary);
      font-weight: var(--font-medium);
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .skill-table td.num,
    .skill-table th.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .trainer-cell {
      font-weight: var(--font-medium);
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
    .scope-pill {
      font-size: var(--text-xs);
      padding: 2px 8px;
      border-radius: var(--radius-full);
      font-weight: var(--font-medium);
    }
    .scope-pill[data-tier='global'] {
      background: rgba(0, 113, 227, 0.12);
      color: #0040dd;
    }
    .scope-pill[data-tier='symbol'] {
      background: rgba(52, 199, 89, 0.12);
      color: #248a3d;
    }
    .scope-pill[data-tier='pair'] {
      background: rgba(175, 82, 222, 0.12);
      color: #8e44ad;
    }
    .status-pill {
      font-size: var(--text-xs);
      padding: 2px 8px;
      border-radius: var(--radius-full);
      font-weight: var(--font-semibold);
    }
    .status-pill.active {
      background: rgba(52, 199, 89, 0.12);
      color: #248a3d;
    }
    .status-pill.suppressed {
      background: rgba(255, 149, 0, 0.12);
      color: #c93400;
    }
    [data-sig='weak'] {
      color: #c93400;
    }
    [data-sig='strong'] {
      color: #d70015;
      font-weight: var(--font-semibold);
    }
    .time {
      color: var(--text-secondary);
      font-size: var(--text-xs);
    }
    .override-btn {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      color: var(--accent);
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: var(--font-medium);
      cursor: pointer;
    }
    .override-btn:hover {
      background: var(--accent);
      color: #fff;
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
      gap: var(--space-4);
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
      line-height: 1;
    }
    .modal-target {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }
    .action-fieldset {
      border: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .action-fieldset legend {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      font-weight: var(--font-medium);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: var(--space-2);
      padding: 0;
    }
    .action-fieldset label {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      font-size: var(--text-sm);
      cursor: pointer;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
    }
    .action-fieldset label:hover {
      background: var(--bg-secondary);
    }
    .action-fieldset strong.ok {
      color: #248a3d;
    }
    .action-fieldset strong.warn {
      color: #c93400;
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
  `;
}
