import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MarketDataEntitlementsApiService } from '../md-entitlements-api.service';
import { subscriberTypeLabel } from '../md-entitlements.logic';
import type { DeclarationDecision, SubscriberDeclarationDto } from '../md-entitlements.types';

/**
 * Staff review of subscriber declarations (engine WS8 8.2, `platform.data.manage`): every organisation's people and their
 * professional / non-professional declarations per exchange. Accept, reject (their real-time access to that exchange
 * ends) or reclassify; a note is required except to accept and is shown to the person. Every review is audited.
 */
@Component({
  selector: 'app-md-declarations-review-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent],
  styleUrl: '../../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Subscriber declarations"
        subtitle="Review people's professional / non-professional declarations per exchange."
      >
        <select
          class="select"
          aria-label="Status"
          [ngModel]="status()"
          (ngModelChange)="status.set($event); list.reload()"
        >
          <option value="">Live (any status)</option>
          <option value="Submitted">Awaiting review</option>
          <option value="Accepted">Accepted</option>
          <option value="Rejected">Rejected</option>
          <option value="Superseded">Superseded</option>
          <option value="Withdrawn">Withdrawn</option>
        </select>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="list.reload()"
          [disabled]="list.loading()"
        >
          {{ list.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (list.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      } @else {
        <section class="card">
          @if (list.value().length === 0) {
            <p class="pad muted">No declarations{{ status() ? ' with that status' : '' }}.</p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Organisation</th>
                    <th>Exchange</th>
                    <th>Type</th>
                    <th>Signed</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of list.value(); track d.id) {
                    <tr>
                      <td>
                        {{ d.userName || 'User ' + d.adminUserId }}
                        <span class="sub">{{ d.userEmail }}</span>
                      </td>
                      <td class="small">
                        <code>{{ d.tenantSlug || d.tenantId }}</code>
                      </td>
                      <td class="small">{{ d.exchangeFamilyName }}</td>
                      <td class="small">
                        {{ type(d.subscriberType) }}
                        @if (d.subscriberType !== d.declaredType) {
                          <span class="sub">declared {{ type(d.declaredType) }}</span>
                        }
                      </td>
                      <td class="small">
                        {{ d.signedName }}
                        <span class="sub"
                          >{{ at(d.signedAtUtc) }} · until {{ d.expiresAtUtc.slice(0, 10) }}</span
                        >
                      </td>
                      <td class="small">
                        <span
                          class="chip"
                          [class.ok]="d.status === 'Accepted'"
                          [class.bad]="d.status === 'Rejected'"
                          >{{ d.status }}</span
                        >
                        @if (d.reviewNote) {
                          <span class="sub">{{ d.reviewNote }}</span>
                        }
                      </td>
                      <td class="actions">
                        @if (
                          d.status === 'Submitted' ||
                          d.status === 'Accepted' ||
                          d.status === 'Rejected'
                        ) {
                          <button type="button" class="btn btn-secondary btn-sm" (click)="open(d)">
                            Review
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        @if (reviewing(); as d) {
          <section class="card">
            <header class="card-head">
              <h3>
                Review {{ d.userName || 'user ' + d.adminUserId }} — {{ d.exchangeFamilyName }}
              </h3>
            </header>
            <div class="pad">
              <ul class="small">
                @for (a of answers(d); track a.key) {
                  <li>
                    <code>{{ a.key }}</code
                    >: {{ a.value ? 'Yes' : 'No' }}
                  </li>
                }
              </ul>
              <label class="field">
                <span class="label">Decision</span>
                <select
                  class="select"
                  [ngModel]="decision()"
                  (ngModelChange)="decision.set($event)"
                >
                  <option value="accept">Accept</option>
                  <option value="professional">Accept as professional</option>
                  <option value="nonProfessional">Accept as non-professional</option>
                  <option value="reject">Reject (no real-time access)</option>
                </select>
              </label>
              <label class="field">
                <span class="label"
                  >Note to the person{{ decision() === 'accept' ? ' (optional)' : '' }}</span
                >
                <input
                  class="input"
                  [ngModel]="note()"
                  (ngModelChange)="note.set($event)"
                  maxlength="1000"
                />
              </label>
              <div class="row">
                <button type="button" class="btn btn-primary" (click)="save(d)" [disabled]="busy()">
                  {{ busy() ? 'Saving…' : 'Save review' }}
                </button>
                <button type="button" class="btn btn-ghost" (click)="reviewing.set(null)">
                  Cancel
                </button>
              </div>
            </div>
          </section>
        }
      }
    </div>
  `,
})
export class MarketDataDeclarationsReviewPageComponent {
  private readonly api = inject(MarketDataEntitlementsApiService);
  private readonly notify = inject(NotificationService);

  protected readonly type = subscriberTypeLabel;
  protected readonly at = when;

  readonly status = signal('');
  readonly list = iamResource(
    () => this.api.declarations({ status: this.status() || null }),
    [] as SubscriberDeclarationDto[],
    'Could not load the declarations.',
  );
  readonly reviewing = signal<SubscriberDeclarationDto | null>(null);
  readonly decision = signal<DeclarationDecision>('accept');
  readonly note = signal('');
  readonly busy = signal(false);

  constructor() {
    this.list.reload();
  }

  protected answers(d: SubscriberDeclarationDto): { key: string; value: boolean }[] {
    return Object.entries(d.answers ?? {}).map(([key, value]) => ({ key, value }));
  }

  open(d: SubscriberDeclarationDto): void {
    this.reviewing.set(d);
    this.decision.set('accept');
    this.note.set('');
  }

  async save(d: SubscriberDeclarationDto): Promise<void> {
    if (this.busy()) return;
    if (this.decision() !== 'accept' && !this.note().trim()) {
      this.notify.error('Say why: the note is shown to the person.');
      return;
    }
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.reviewDeclaration(d.id, this.decision(), this.note()));
      this.notify.success('Review saved.');
      this.reviewing.set(null);
      this.list.reload();
    } catch (err: unknown) {
      if (reportable(err)) this.notify.error(errorText(err, 'The review could not be saved.'));
    } finally {
      this.busy.set(false);
    }
  }
}
