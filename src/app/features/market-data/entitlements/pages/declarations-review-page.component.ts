import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { ago } from '@features/iam/shared/admin-context.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MarketDataEntitlementsApiService } from '../md-entitlements-api.service';
import { subscriberTypeLabel } from '../md-entitlements.logic';
import { declarationCounts, declarationHolders } from '../md-feeds.logic';
import { MarketDataSourcesApiService } from '../../sources/md-sources-api.service';
import type { MarketDataUsageReport } from '../md-entitlements.types';
import type {
  DeclarationDecision,
  MarketDataEntitlementDto,
  MarketDataFeedCatalog,
  MyDeclarations,
  SubscriberDeclarationDto,
} from '../md-entitlements.types';

/** The status filter pills; '' is every live declaration. */
const STATUS_TABS: { key: string; label: string; title: string }[] = [
  { key: '', label: 'Live', title: 'Live (any status)' },
  { key: 'Submitted', label: 'Awaiting review', title: 'Submitted, not yet reviewed' },
  { key: 'Accepted', label: 'Accepted', title: 'Accepted' },
  { key: 'Rejected', label: 'Rejected', title: 'Rejected' },
  { key: 'Superseded', label: 'Superseded', title: 'Superseded by a newer declaration' },
  { key: 'Withdrawn', label: 'Withdrawn', title: 'Withdrawn by the person' },
];

/**
 * Staff review of subscriber declarations (engine WS8 8.2, `platform.data.manage`): every organisation's people and their
 * professional / non-professional declarations per exchange. Accept, reject (their real-time access to that exchange
 * ends) or reclassify; a note is required except to accept and is shown to the person. Every review is audited.
 */
@Component({
  selector: 'app-md-declarations-review-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, MetricCardComponent],
  styleUrls: [
    '../../../iam/shared/iam-page.scss',
    '../../md-summary.scss',
    './declarations-review-page.scss',
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Subscriber declarations"
        subtitle="Review people's professional / non-professional declarations per exchange."
      >
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
        <div class="kpis" aria-label="Summary">
          <app-metric-card
            label="Awaiting review"
            [value]="counts().Submitted"
            [dotColor]="counts().Submitted ? '#FF9500' : '#34C759'"
            caption="not yet reviewed"
          />
          <app-metric-card
            label="Accepted"
            [value]="counts().Accepted"
            dotColor="#34C759"
            [caption]="'valid ' + (me.value()?.validityDays ?? 365) + ' days'"
          />
          <app-metric-card
            label="Rejected or withdrawn"
            [value]="counts().Rejected + counts().Withdrawn"
            [dotColor]="counts().Rejected ? '#FF3B30' : '#8E8E93'"
            [caption]="counts().Superseded + ' superseded'"
          />
          <app-metric-card
            label="Exchanges that need one"
            [value]="me.value()?.families?.length ?? null"
            [displayValue]="me.value() ? null : '—'"
            dotColor="#0071E3"
            caption="licensor families"
          />
          <app-metric-card
            label="Exchange reads this month"
            [value]="usage.value() ? exchangeReads() : null"
            [displayValue]="usage.value() ? null : '—'"
            dotColor="#5856D6"
            [caption]="monthLabel"
          />
          <app-metric-card
            label="Organisations that must declare"
            [value]="holders().length"
            [dotColor]="holders().length ? '#0071E3' : '#8E8E93'"
            caption="real-time display grant"
          />
        </div>

        <section class="card" aria-label="Declarations">
          <header class="card-head">
            <h3>Declarations</h3>
            <span class="count">{{ list.value().length }}</span>
            <span class="hint">{{ statusTitle() }}</span>
          </header>
          <div class="toolbar">
            <div class="seg" role="group" aria-label="Status">
              @for (t of statusTabs; track t.key) {
                <button
                  type="button"
                  [class.on]="status() === t.key"
                  [attr.aria-pressed]="status() === t.key"
                  [title]="t.title"
                  (click)="setStatus(t.key)"
                >
                  {{ t.label }}
                  @if (t.key) {
                    <span class="n">{{ countOf(t.key) }}</span>
                  }
                </button>
              }
            </div>
          </div>
          @if (list.value().length === 0) {
            <div class="empty">
              @if (status()) {
                <strong>No declarations with that status.</strong>
                Pick another status above, or Live to see every current one.
              } @else if (holders().length === 0) {
                <strong>No declarations yet.</strong>
                None — and none is expected yet: no organisation holds a real-time display grant of
                a feed that needs one{{ me.value()?.houseExempt ? ', and House is exempt' : '' }}. A
                person is asked to declare when their organisation is granted, for example, CME
                depth for display (Market data → Entitlements); they answer the questionnaire below
                on the Data declarations page and it lands here for review.
              } @else {
                <strong>No declarations yet.</strong>
                None yet, although {{ holders().length }} organisation(s) hold a feed that needs one
                — their people are asked when they open that data.
              }
            </div>
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
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of list.value(); track d.id) {
                    <tr [class.is-reviewing]="reviewing()?.id === d.id">
                      <td>
                        <span class="strong">{{ d.userName || 'User ' + d.adminUserId }}</span>
                        <span class="sub">{{ d.userEmail }}</span>
                      </td>
                      <td class="small">
                        <span class="tag">{{ d.tenantSlug || d.tenantId }}</span>
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
                        <span class="sub" [title]="at(d.signedAtUtc)"
                          >{{ rel(d.signedAtUtc) }} · until {{ d.expiresAtUtc.slice(0, 10) }}</span
                        >
                        @if (d.renewalDue) {
                          <span class="flag">Renewal due</span>
                        }
                      </td>
                      <td class="small">
                        <span class="dot" [class]="statusTone(d.status)" [title]="d.status">{{
                          statusLabel(d.status)
                        }}</span>
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
                          <button
                            type="button"
                            class="btn btn-sm"
                            [class.btn-secondary]="d.status === 'Submitted'"
                            [class.btn-ghost]="d.status !== 'Submitted'"
                            (click)="open(d)"
                          >
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
          <section class="card review-card" aria-label="Review">
            <header class="card-head">
              <h3>
                Review {{ d.userName || 'user ' + d.adminUserId }} — {{ d.exchangeFamilyName }}
              </h3>
              <span class="dot" [class]="statusTone(d.status)">{{ statusLabel(d.status) }}</span>
              <span class="hint"
                >signed by {{ d.signedName }} · questionnaire v{{ d.questionnaireVersion }}</span
              >
            </header>
            <div class="card-body">
              @if (answers(d).length) {
                <ul class="answers">
                  @for (a of answers(d); track a.key) {
                    <li>
                      <span
                        >{{ questionText(a.key) }}<code>{{ a.key }}</code></span
                      >
                      <span class="yn" [class.pro]="isProAnswer(a.key, a.value)">{{
                        a.value ? 'Yes' : 'No'
                      }}</span>
                    </li>
                  }
                </ul>
              }
              <p class="note">
                Answers say <strong>{{ type(d.declaredType) }}</strong
                >; in force: <strong>{{ type(d.subscriberType) }}</strong
                >. Rejecting ends their real-time access to {{ d.exchangeFamilyName }}.
              </p>
              <div class="form-grid">
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
              </div>
              <div class="actions-row">
                <button type="button" class="btn btn-ghost" (click)="reviewing.set(null)">
                  Cancel
                </button>
                <button type="button" class="btn btn-primary" (click)="save(d)" [disabled]="busy()">
                  {{ busy() ? 'Saving…' : 'Save review' }}
                </button>
              </div>
            </div>
          </section>
        }
        <section class="card" aria-label="Exchanges">
          <header class="card-head">
            <h3>Exchanges with a declaration rule</h3>
            <span class="count">{{ me.value()?.families?.length ?? 0 }}</span>
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Exchange family</th>
                  <th>Feeds</th>
                  <th title="Enabled registry sources behind the family's feeds / all">
                    Sources live
                  </th>
                  <th
                    class="num"
                    title="Reads of the family's feeds this month (all organisations)"
                  >
                    Reads this month
                  </th>
                  <th>Organisations holding real-time display</th>
                </tr>
              </thead>
              <tbody>
                @for (f of me.value()?.families ?? []; track f.id) {
                  <tr>
                    <td>
                      <span class="strong">{{ f.name }}</span
                      ><span class="sub"
                        ><span class="tag">{{ f.id }}</span></span
                      >
                    </td>
                    <td class="small">
                      @if (feedsOf(f.id)) {
                        <div class="chips">
                          @for (id of feedList(f.id); track id) {
                            <span class="tag">{{ id }}</span>
                          }
                        </div>
                      } @else {
                        <span class="muted">— no feed in the catalog yet</span>
                      }
                    </td>
                    <td class="small">
                      @if (enabledIds(); as ids) {
                        <span class="dot" [class.ok]="sourcesLive(f.id, ids) > 0"
                          >{{ sourcesLive(f.id, ids) }} / {{ sourcesAll(f.id) }}</span
                        >
                      } @else {
                        {{ sourcesAll(f.id) }} registered
                      }
                    </td>
                    <td class="small num">{{ readsOf(f.id).toLocaleString() }}</td>
                    <td class="small" [class.muted]="!holdersOf(f.id)">
                      {{ holdersOf(f.id) || 'none' }}
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="muted small">
                      {{ me.value() ? 'No exchange has a declaration rule.' : 'Loading…' }}
                    </td>
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
              <span class="count">version {{ m.questionnaireVersion }}</span>
            }
          </header>
          <div class="card-body">
            <ol class="q-list">
              @for (q of me.value()?.questions ?? []; track q.key) {
                <li>
                  {{ q.text }}
                  <span class="muted"
                    >— “{{ q.professionalWhen ? 'Yes' : 'No' }}” makes the person
                    professional.</span
                  >
                </li>
              }
            </ol>
            <p class="note">
              Any professional answer classifies the person as a professional subscriber (exchange
              fees are higher); people with no declaration are counted as professional in the usage
              report, as exchanges do. The person signs with their typed name; a declaration renews
              yearly.
            </p>
            <nav class="links-row" aria-label="Related">
              <a routerLink="/market-data/declarations">Data declarations (the person's page)</a>
              <a routerLink="/market-data/entitlements">Entitlements</a>
              <a routerLink="/market-data/usage">Usage per exchange</a>
            </nav>
          </div>
        </section>
      }
    </div>
  `,
})
export class MarketDataDeclarationsReviewPageComponent {
  private readonly api = inject(MarketDataEntitlementsApiService);
  private readonly notify = inject(NotificationService);

  protected readonly type = subscriberTypeLabel;
  protected readonly at = when;
  protected readonly rel = (utc: string | null | undefined): string => ago(utc);
  protected readonly statusTabs = STATUS_TABS;
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
  private readonly sourcesApi = inject(MarketDataSourcesApiService);
  protected readonly monthLabel = new Date().toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  readonly usage = iamResource<MarketDataUsageReport | null>(
    () => this.api.usage(new Date().toISOString().slice(0, 7)).pipe(catchError(() => of(null))),
    null,
  );
  /** Enabled registry source ids; null when the registry could not be read. */
  readonly enabledIds = signal<ReadonlySet<string> | null>(null);
  readonly exchangeReads = computed(() => {
    const feeds = new Set(
      (this.catalog.value()?.feeds ?? []).filter((f) => f.requiresDeclaration).map((f) => f.feedId),
    );
    return (this.usage.value()?.feeds ?? [])
      .filter((f) => feeds.has(f.feedId))
      .reduce((a, f) => a + f.accessCount, 0);
  });
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
    this.usage.reload();
    this.sourcesApi
      .list()
      .pipe(catchError(() => of(null)))
      .subscribe((rows) =>
        this.enabledIds.set(
          rows ? new Set(rows.filter((r) => r.enabled).map((r) => r.sourceId)) : null,
        ),
      );
  }

  private familyFeeds(family: string) {
    return (this.catalog.value()?.feeds ?? []).filter((f) => f.exchangeFamily === family);
  }

  sourcesAll(family: string): number {
    return new Set(this.familyFeeds(family).flatMap((f) => f.sources)).size;
  }

  sourcesLive(family: string, ids: ReadonlySet<string>): number {
    return new Set(
      this.familyFeeds(family)
        .flatMap((f) => f.sources)
        .filter((s) => ids.has(s)),
    ).size;
  }

  readsOf(family: string): number {
    const feeds = new Set(this.familyFeeds(family).map((f) => f.feedId));
    return (this.usage.value()?.feeds ?? [])
      .filter((f) => feeds.has(f.feedId))
      .reduce((a, f) => a + f.accessCount, 0);
  }

  feedsOf(family: string): string {
    return (this.catalog.value()?.feeds ?? [])
      .filter((f) => f.exchangeFamily === family && f.requiresDeclaration)
      .map((f) => f.feedId)
      .join(', ');
  }

  /** feedsOf() as a list, for the feed tags. */
  feedList(family: string): string[] {
    const s = this.feedsOf(family);
    return s ? s.split(', ') : [];
  }

  holdersOf(family: string): string {
    const feeds = new Set(
      (this.catalog.value()?.feeds ?? [])
        .filter((f) => f.exchangeFamily === family)
        .map((f) => f.feedId),
    );
    return this.holders()
      .filter((h) => h.feeds.some((f) => feeds.has(f)))
      .map((h) => h.tenant)
      .join(', ');
  }

  protected answers(d: SubscriberDeclarationDto): { key: string; value: boolean }[] {
    return Object.entries(d.answers ?? {}).map(([key, value]) => ({ key, value }));
  }

  setStatus(key: string): void {
    this.status.set(key);
    this.list.reload();
  }

  /** How many declarations (history included) have this status — the pill counts. */
  countOf(key: string): number {
    const c = this.counts();
    return key in c ? c[key as keyof typeof c] : 0;
  }

  statusTitle(): string {
    return STATUS_TABS.find((t) => t.key === this.status())?.title ?? '';
  }

  /** `Submitted` → "Awaiting review"; the other statuses read as they are. */
  statusLabel(status: string): string {
    return status === 'Submitted' ? 'Awaiting review' : status;
  }

  statusTone(status: string): string {
    return status === 'Accepted'
      ? 'ok'
      : status === 'Submitted'
        ? 'warn'
        : status === 'Rejected'
          ? 'bad'
          : '';
  }

  /** The questionnaire's wording for an answer key (the key itself when the questionnaire is unknown). */
  questionText(key: string): string {
    return (this.me.value()?.questions ?? []).find((q) => q.key === key)?.text ?? key;
  }

  /** Whether this answer is the one that makes the person professional. */
  isProAnswer(key: string, value: boolean): boolean {
    const q = (this.me.value()?.questions ?? []).find((x) => x.key === key);
    return !!q && q.professionalWhen === value;
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
