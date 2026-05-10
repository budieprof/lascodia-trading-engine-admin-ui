import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import type { GateCutoverStatusDto, GateCutoverStatusRowDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

interface PendingFlip {
  row: GateCutoverStatusRowDto;
  intended: boolean;
}

const EMPTY_STATUS: GateCutoverStatusDto = { rows: [] };

@Component({
  selector: 'app-gate-cutover-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
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
        title="CompositeML — Gate Cutover"
        subtitle="Flip cold-start catalogue layers between ledger (cutover) and legacy idiom (default)"
      >
        <a routerLink="/composite-ml" class="btn btn-secondary">← Active Policies</a>
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
          title="Could not load cutover status"
          message="Engine returned an error. The cold-start catalogue may be unavailable — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpi-strip">
          <span class="kpi"
            ><strong>{{ rows().length }}</strong> catalogue layers</span
          >
          <span class="kpi"
            ><strong>{{ cutoverCount() }}</strong> on ledger (cutover)</span
          >
          <span class="kpi"
            ><strong>{{ legacyCount() }}</strong> on legacy idiom</span
          >
        </section>

        @if (rows().length === 0) {
          <app-empty-state
            title="No catalogue layers registered"
            description="The cold-start catalogue is empty. This usually means the engine isn't running the CompositeML cold-start pipeline."
          />
        } @else {
          <section class="card">
            <table class="cutover-table">
              <thead>
                <tr>
                  <th>Layer key</th>
                  <th>Covered knob</th>
                  <th>Description</th>
                  <th>Source of truth</th>
                  <th>Flipped</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.layerKey) {
                  <tr [class.on-ledger]="row.returnLedgerCount">
                    <td class="mono">{{ row.layerKey }}</td>
                    <td class="mono small">{{ row.coveredKnob }}</td>
                    <td class="desc">{{ row.description }}</td>
                    <td>
                      @if (row.returnLedgerCount) {
                        <span class="state-pill ledger">ledger</span>
                      } @else {
                        <span class="state-pill legacy">legacy</span>
                      }
                    </td>
                    <td class="time">
                      @if (row.lastUpdatedAtUtc) {
                        <span [title]="row.lastUpdatedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                          {{ row.lastUpdatedAtUtc | relativeTime }}
                        </span>
                      } @else {
                        <span class="muted">never</span>
                      }
                    </td>
                    <td>
                      <button
                        type="button"
                        class="flip-btn"
                        (click)="askFlip(row)"
                        [disabled]="submitting()"
                      >
                        {{ row.returnLedgerCount ? 'Revert to legacy' : 'Cut over to ledger' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>

          <p class="footnote">
            Gate-cutover flips are hot-reloaded — the change takes effect on the next gate
            invocation, no engine restart required. Each flip writes an audit-trail entry with the
            operator reason.
          </p>
        }
      }

      @if (pendingFlip(); as p) {
        <div class="modal-overlay" (click)="cancelFlip()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>{{ p.intended ? 'Cut over to ledger' : 'Revert to legacy idiom' }}</h2>
              <button type="button" class="close-btn" (click)="cancelFlip()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              <span class="mono">{{ p.row.layerKey }}</span>
            </p>
            <p class="modal-desc">{{ p.row.description }}</p>
            <p class="modal-warn">
              @if (p.intended) {
                The gate will start returning the <strong>ledger count</strong> on the next
                invocation. Make sure the ledger is warm for this layer before cutting over.
              } @else {
                The gate will revert to the <strong>legacy idiom</strong> on the next invocation —
                the ledger override row is soft-deleted.
              }
            </p>

            <label class="reason-field">
              <span>Reason (written to audit trail)</span>
              <textarea
                rows="3"
                [(ngModel)]="reasonText"
                placeholder="Why is this flip needed?"
              ></textarea>
            </label>

            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancelFlip()">Cancel</button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="confirmFlip()"
                [disabled]="!canSubmit()"
              >
                {{ submitting() ? 'Flipping…' : p.intended ? 'Cut over' : 'Revert' }}
              </button>
            </footer>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
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
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .cutover-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .cutover-table th,
      .cutover-table td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .cutover-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cutover-table tr.on-ledger {
        background: rgba(52, 199, 89, 0.04);
      }
      .desc {
        color: var(--text-secondary);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .mono.small {
        font-size: 0.9em;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .state-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .state-pill.ledger {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .state-pill.legacy {
        background: rgba(142, 142, 147, 0.16);
        color: #636366;
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .flip-btn {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--accent);
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        white-space: nowrap;
      }
      .flip-btn:hover:not(:disabled) {
        background: var(--accent);
        color: #fff;
      }
      .flip-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .footnote {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin: 0;
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
        max-width: 540px;
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
        line-height: 1;
      }
      .modal-target {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .modal-warn {
        margin: 0;
        font-size: var(--text-xs);
        color: #c93400;
        background: rgba(255, 149, 0, 0.08);
        padding: 8px 12px;
        border-left: 3px solid #ff9500;
        border-radius: var(--radius-sm);
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
export class GateCutoverPageComponent {
  private readonly compositeMl = inject(CompositeMLService);
  private readonly auditTrail = inject(AuditTrailService);

  protected readonly resource = createPolledResource(
    () =>
      this.compositeMl.getGateCutoverStatus().pipe(
        map((res) => res.data ?? EMPTY_STATUS),
        catchError(() => of(EMPTY_STATUS)),
      ),
    { intervalMs: 60_000 },
  );

  protected readonly rows = computed(() => this.resource.value()?.rows ?? []);
  protected readonly loading = computed(() => this.resource.loading() && this.rows().length === 0);
  protected readonly cutoverCount = computed(
    () => this.rows().filter((r) => r.returnLedgerCount).length,
  );
  protected readonly legacyCount = computed(
    () => this.rows().filter((r) => !r.returnLedgerCount).length,
  );

  // Modal state -----------------------------------------------------------
  protected readonly pendingFlip = signal<PendingFlip | null>(null);
  protected reasonText = '';
  protected readonly submitting = signal(false);

  protected askFlip(row: GateCutoverStatusRowDto): void {
    this.reasonText = '';
    this.pendingFlip.set({ row, intended: !row.returnLedgerCount });
  }

  protected cancelFlip(): void {
    if (this.submitting()) return;
    this.pendingFlip.set(null);
  }

  protected canSubmit = (): boolean => {
    if (this.submitting()) return false;
    return this.reasonText.trim().length >= 4;
  };

  protected confirmFlip(): void {
    const p = this.pendingFlip();
    if (!p || !this.canSubmit()) return;
    this.submitting.set(true);
    const payload = { layerKey: p.row.layerKey, returnLedgerCount: p.intended };
    this.compositeMl
      .setGateCutover(payload)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.pendingFlip.set(null);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.auditTrail
              .create({
                entityType: 'CompositeMLGateCutover',
                entityId: 0,
                decisionType: 'GateCutoverFlip',
                outcome: p.intended ? 'Cutover' : 'Reverted',
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
          /* error state surfaces via the polled-resource on next refresh */
        },
      });
  }
}
