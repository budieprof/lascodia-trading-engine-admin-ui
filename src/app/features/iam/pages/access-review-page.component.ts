import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '../iam-api.service';
import { errorText, reportable, scopeLabel, staleGrantIds, toggled, when } from '../iam.logic';
import type { AccessReviewEntry, AccessReviewReport } from '../iam.types';
import { iamResource } from '../shared/iam-resource';

/**
 * Access review (U3.4, ADR-0031 §7): every grant in the organisation with when it was last used;
 * grants unused for the review window (90 days) are flagged. Revoke what nobody needs in one action
 * (`iam.access_review`).
 */
@Component({
  selector: 'app-iam-access-review-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Access review"
        subtitle="Who holds what, and whether they still use it. Revoke grants nobody needs."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="report.reload()"
          [disabled]="report.loading()"
        >
          {{ report.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card">
        <header class="card-head">
          <h3>
            {{ shown().length }} grants · {{ staleCount() }} unused for
            {{ report.value().staleAfterDays ?? 90 }} days
          </h3>
          <span class="spacer"></span>
          <label class="check small">
            <input
              type="checkbox"
              name="staleOnly"
              [ngModel]="staleOnly()"
              (ngModelChange)="staleOnly.set($event)"
            />
            Unused only
          </label>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            [disabled]="staleCount() === 0"
            (click)="selectStale()"
          >
            Select all unused
          </button>
          <button
            type="button"
            class="btn btn-sm btn-danger"
            [disabled]="selected().size === 0 || busy()"
            (click)="confirming.set(true)"
          >
            Revoke selected ({{ selected().size }})
          </button>
        </header>
        @if (report.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (report.loaded() && shown().length === 0) {
          <p class="pad muted">{{ staleOnly() ? 'No unused grants.' : 'No grants.' }}</p>
        } @else if (shown().length > 0) {
          @if (report.value().generatedAtUtc) {
            <p class="pad small muted">Report from {{ when(report.value().generatedAtUtc) }}.</p>
          }
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th><span class="sr-only">Select</span></th>
                  <th>Who</th>
                  <th>Role</th>
                  <th>Applies to</th>
                  <th>Granted</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                @for (e of shown(); track e.grantId) {
                  <tr [class.selected]="selected().has(e.grantId)">
                    <td>
                      <input
                        type="checkbox"
                        [attr.aria-label]="'Select grant ' + e.grantId"
                        [checked]="selected().has(e.grantId)"
                        (change)="toggle(e.grantId)"
                      />
                    </td>
                    <td>
                      {{ e.principalName || '#' + e.principalId
                      }}<span class="sub">{{ e.principalType }}</span>
                    </td>
                    <td>{{ e.roleName || '—' }}</td>
                    <td>{{ scope(e) }}</td>
                    <td class="small">{{ when(e.grantedAtUtc) }}</td>
                    <td class="small">
                      @if (e.stale) {
                        <span class="chip warn">{{
                          e.lastUsedAtUtc ? when(e.lastUsedAtUtc) : 'Never used'
                        }}</span>
                      } @else {
                        {{ e.lastUsedAtUtc ? when(e.lastUsedAtUtc) : 'Never used' }}
                      }
                      @if (e.idleDays !== null && e.idleDays !== undefined) {
                        <span class="sub"
                          >{{ e.idleDays }} day{{ e.idleDays === 1 ? '' : 's' }} idle</span
                        >
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <app-confirm-dialog
        [open]="confirming()"
        [title]="'Revoke ' + selected().size + ' grant' + (selected().size === 1 ? '' : 's') + '?'"
        message="The permissions they gave stop working within seconds. Grant them again if someone still needs them."
        confirmLabel="Revoke"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="revoke()"
        (cancelled)="confirming.set(false)"
      />
    </div>
  `,
})
export class AccessReviewPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);

  protected readonly when = when;

  readonly report = iamResource<AccessReviewReport>(
    () => this.iam.accessReview(),
    { grants: [] },
    'Could not load the access review.',
  );
  readonly staleOnly = signal(true);
  readonly shown = computed(() =>
    this.report.value().grants.filter((e) => !this.staleOnly() || e.stale),
  );
  readonly staleCount = computed(() => staleGrantIds(this.report.value().grants).length);
  readonly selected = signal<Set<number>>(new Set());
  readonly confirming = signal(false);
  readonly busy = signal(false);

  constructor() {
    this.report.reload();
  }

  scope(e: AccessReviewEntry): string {
    return scopeLabel(e.scopeType, e.scopeId, e.scopeName);
  }

  toggle(id: number): void {
    this.selected.update((s) => toggled(s, id));
  }

  selectStale(): void {
    this.selected.set(new Set(staleGrantIds(this.report.value().grants)));
  }

  revoke(): void {
    const ids = [...this.selected()];
    if (ids.length === 0 || this.busy()) return;
    this.busy.set(true);
    this.iam.revokeReviewed(ids).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirming.set(false);
        this.selected.set(new Set());
        this.notify.success(`${ids.length} grant${ids.length === 1 ? '' : 's'} revoked.`);
        this.report.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.confirming.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'Nothing was revoked.'));
      },
    });
  }
}
