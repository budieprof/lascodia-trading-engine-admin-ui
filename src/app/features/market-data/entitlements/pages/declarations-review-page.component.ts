import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MarketDataEntitlementsApiService } from '../md-entitlements-api.service';
import { subscriberTypeLabel } from '../md-entitlements.logic';
import { declarationCounts, declarationHolders } from '../md-feeds.logic';
import type {
  DeclarationDecision,
  MarketDataEntitlementDto,
  MarketDataFeedCatalog,
  MyDeclarations,
  SubscriberDeclarationDto,
} from '../md-entitlements.types';

/**
 * Staff review of subscriber declarations (engine WS8 8.2, `platform.data.manage`): every organisation's people and their
 * professional / non-professional declarations per exchange. Accept, reject (their real-time access to that exchange
 * ends) or reclassify; a note is required except to accept and is shown to the person. Every review is audited.
 */
@Component({
  selector: 'app-md-declarations-review-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent],
  styleUrls: ['../../../iam/shared/iam-page.scss', '../../md-summary.scss'],
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
        <div class="tiles" aria-label="Summary">
          <div class="tile" [attr.data-tone]="counts().Submitted ? 'warn' : null">
            <span class="t-label">Awaiting review</span>
            <span class="t-value">{{ counts().Submitted }}</span>
            <span class="t-hint">submitted, not yet reviewed</span>
          </div>
          <div class="tile">
            <span class="t-label">Accepted</span>
            <span class="t-value">{{ counts().Accepted }}</span>
            <span class="t-hint">valid {{ me.value()?.validityDays ?? 365 }} days from signing</span>
          </div>
          <div class="tile">
            <span class="t-label">Rejected or withdrawn</span>
            <span class="t-value">{{ counts().Rejected + counts().Withdrawn }}</span>
            <span class="t-hint">{{ counts().Superseded }} superseded by a newer one</span>
          </div>
          <div class="tile">
            <span class="t-label">Exchanges that need one</span>
            <span class="t-value">{{ me.value()?.families?.length ?? '—' }}</span>
            <span class="t-hint">licensor families with a declaration rule</span>
          </div>
          <div class="tile">
            <span class="t-label">Organisations that must declare</span>
            <span class="t-value">{{ holders().length }}</span>
            <span class="t-hint">hold a real-time display grant of such a feed</span>
          </div>
        </div>

        <section class="card" aria-label="Declarations">
          <header class="card-head"><h3>Declarations</h3></header>
          @if (list.value().length === 0) {
            <p class="pad muted">
              @if (status()) {
                No declarations with that status.
              } @else if (holders().length === 0) {
                None — and none is expected yet: no organisation holds a real-time display grant of a feed that needs
                one{{ me.value()?.houseExempt ? ', and House is exempt' : '' }}. A person is asked to declare when their
                organisation is granted, for example, CME depth for display (Market data → Entitlements); they answer
                the questionnaire below on the Data declarations page and it lands here for review.
              } @else {
                None yet, although {{ holders().length }} organisation(s) hold a feed that needs one — their people are
                asked when they open that data.
              }
            </p>
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
        <div class="two-col">
          <section class="card" aria-label="Exchanges">
            <header class="card-head"><h3>Exchanges with a declaration rule</h3></header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Exchange family</th>
                    <th>Feeds</th>
                    <th>Organisations holding real-time display</th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of me.value()?.families ?? []; track f.id) {
                    <tr>
                      <td>{{ f.name }}<span class="sub"><code>{{ f.id }}</code></span></td>
                      <td class="small">{{ feedsOf(f.id) || '— no feed in the catalog yet' }}</td>
                      <td class="small">{{ holdersOf(f.id) || 'none' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
          <section class="card" aria-label="Questionnaire">
            <header class="card-head">
              <h3>The questionnaire</h3>
              @if (me.value(); as m) {
                <span class="chip">version {{ m.questionnaireVersion }}</span>
              }
            </header>
            <div class="card-body">
              <ol class="small q-list">
                @for (q of me.value()?.questions ?? []; track q.key) {
                  <li>
                    {{ q.text }}
                    <span class="muted">— “{{ q.professionalWhen ? 'Yes' : 'No' }}” makes the person professional.</span>
                  </li>
                }
              </ol>
              <p class="note">
                Any professional answer classifies the person as a professional subscriber (exchange fees are higher);
                people with no declaration are counted as professional in the usage report, as exchanges do. The person
                signs with their typed name; a declaration renews yearly.
              </p>
              <nav class="links-row" aria-label="Related">
                <a routerLink="/market-data/declarations">Data declarations (the person's page)</a>
                <a routerLink="/market-data/entitlements">Entitlements</a>
                <a routerLink="/market-data/usage">Usage per exchange</a>
              </nav>
            </div>
          </section>
        </div>
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
  /** Every declaration including history, for the counts. */
  readonly history = iamResource(
    () => this.api.declarations({ includeHistory: true }).pipe(catchError(() => of([]))),
    [] as SubscriberDeclarationDto[],
  );
  /** The questionnaire and exchange families (the same read every person's page uses). */
  readonly me = iamResource<MyDeclarations | null>(
    () => this.api.myDeclarations().pipe(catchError(() => of(null))),
    null,
  );
  readonly catalog = iamResource<MarketDataFeedCatalog | null>(
    () => this.api.feeds().pipe(catchError(() => of(null))),
    null,
  );
  readonly grants = iamResource<MarketDataEntitlementDto[]>(
    () => this.api.list({ includeRevoked: false }).pipe(catchError(() => of([]))),
    [],
  );
  readonly counts = computed(() => declarationCounts(this.history.value()));
  readonly holders = computed(() => declarationHolders(this.catalog.value(), this.grants.value()));
  readonly reviewing = signal<SubscriberDeclarationDto | null>(null);
  readonly decision = signal<DeclarationDecision>('accept');
  readonly note = signal('');
  readonly busy = signal(false);

  constructor() {
    this.list.reload();
    this.history.reload();
    this.me.reload();
    this.catalog.reload();
    this.grants.reload();
  }

  feedsOf(family: string): string {
    return (this.catalog.value()?.feeds ?? [])
      .filter((f) => f.exchangeFamily === family && f.requiresDeclaration)
      .map((f) => f.feedId)
      .join(', ');
  }

  holdersOf(family: string): string {
    const feeds = new Set(
      (this.catalog.value()?.feeds ?? []).filter((f) => f.exchangeFamily === family).map((f) => f.feedId),
    );
    return this.holders()
      .filter((h) => h.feeds.some((f) => feeds.has(f)))
      .map((h) => h.tenant)
      .join(', ');
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
