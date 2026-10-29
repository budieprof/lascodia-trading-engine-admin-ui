import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, firstValueFrom, map, of } from 'rxjs';

import { ApiService } from '@core/api/api.service';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MarketDataEntitlementsApiService } from '../md-entitlements-api.service';
import {
  classifyAnswers,
  declarationBody,
  declarationErrors,
  subscriberTypeLabel,
} from '../md-entitlements.logic';
import type { DeclarationFamily, MyDeclarations } from '../md-entitlements.types';
import {
  accessLabel,
  feedsOfFamily,
  holdingLabel,
  liveSourcesPerFeed,
  type MyFeedRow,
} from '../md-feeds.logic';

interface DeclarationDraft {
  answers: Record<string, boolean | null>;
  selfDeclaredProfessional: boolean;
  signedName: string;
  attest: boolean;
}

/**
 * Subscriber declarations (engine WS8 8.2, `marketdata.read`): the signed-in person declares, per exchange family, whether
 * they are a professional or non-professional subscriber — the exchanges require it before a person sees their
 * real-time data, and bill the two differently. Valid for a year, then renewed. Crypto exchanges and delayed data need none.
 */
@Component({
  selector: 'app-md-declarations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent],
  styleUrls: ['../../../iam/shared/iam-page.scss', '../../md-summary.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Subscriber declarations"
        subtitle="Professional or non-professional, per exchange — needed before you see an exchange's real-time data."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="me.reload()"
          [disabled]="me.loading()"
        >
          {{ me.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (me.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      } @else if (me.value(); as m) {
        @if (!m.tenantId) {
          <p class="note warn">
            Choose an organisation first: you declare in the organisation whose data you use.
          </p>
        } @else {
          @if (m.houseExempt) {
            <p class="note">
              Your organisation reads every feed under the platform's own exchange licences: no
              declaration is needed here.
            </p>
          } @else if (!m.required) {
            <p class="note">Declarations are not checked at the moment; you can still sign them.</p>
          }
          <div class="tiles" aria-label="Summary">
            <div class="tile">
              <span class="t-label">Exchanges</span>
              <span class="t-value">{{ m.families.length }}</span>
              <span class="t-hint">with a professional / non-professional rule</span>
            </div>
            <div class="tile" [attr.data-tone]="neededOpen(m) ? 'warn' : null">
              <span class="t-label">Needed now</span>
              <span class="t-value">{{ neededOpen(m) }}</span>
              <span class="t-hint">licences you hold without a current declaration</span>
            </div>
            <div class="tile">
              <span class="t-label">Feeds you can read</span>
              <span class="t-value">{{ myFeeds().length || '—' }}</span>
              <span class="t-hint">{{ exchangeFeedCount() }} of them exchange or venue feeds</span>
            </div>
            <div class="tile" [attr.data-tone]="liveFeedCount() ? 'ok' : null">
              <span class="t-label">With a live source</span>
              <span class="t-value">{{ myFeeds().length ? liveFeedCount() : '—' }}</span>
              <span class="t-hint">feeds an enabled source delivers now</span>
            </div>
            <div class="tile">
              <span class="t-label">Declared</span>
              <span class="t-value">{{ declaredCount(m) }}</span>
              <span class="t-hint">renewed every {{ m.validityDays }} days</span>
            </div>
          </div>
          <section class="card">
            <header class="card-head"><h3>Exchanges</h3></header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Exchange</th>
                    <th>Your declaration</th>
                    <th>Valid until</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of m.families; track f.id) {
                    <tr>
                      <td>
                        {{ f.name }}
                        @if (f.needed && !f.declaration?.current) {
                          <span class="chip warn">Needed for your licences</span>
                        }
                        <span class="sub">
                          {{
                            f.needed
                              ? 'Needed: your organisation holds a real-time licence of this exchange.'
                              : m.houseExempt
                                ? 'Not needed: covered by the platform licence.'
                                : 'Not needed now: your organisation holds no real-time licence of this exchange.'
                          }}
                        </span>
                        @if (familyFeeds(f.id); as fs) {
                          @if (fs.length) {
                            <span class="sub">Your feeds: {{ fs }}</span>
                          }
                        }
                      </td>
                      <td class="small">
                        @if (f.declaration; as d) {
                          {{ type(d.subscriberType) }}
                          <span
                            class="chip"
                            [class.bad]="d.status === 'Rejected'"
                            [class.ok]="d.status === 'Accepted'"
                            >{{ d.status }}</span
                          >
                          @if (d.reviewNote) {
                            <span class="sub">{{ d.reviewNote }}</span>
                          }
                        } @else {
                          <span class="muted">Not declared</span>
                        }
                      </td>
                      <td class="small">
                        @if (f.declaration; as d) {
                          {{ d.expiresAtUtc.slice(0, 10) }}
                          @if (d.renewalDue) {
                            <span class="chip warn">Renew</span>
                          }
                        }
                      </td>
                      <td class="actions">
                        <button type="button" class="btn btn-secondary btn-sm" (click)="open(f)">
                          {{ f.declaration ? 'Re-declare' : 'Declare' }}
                        </button>
                        @if (f.declaration; as d) {
                          <button
                            type="button"
                            class="btn btn-ghost btn-sm"
                            (click)="withdraw(d.id, f.name)"
                            [disabled]="busy()"
                          >
                            Withdraw
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          @if (myFeeds().length) {
            <section class="card" aria-label="Your feed access">
              <header class="card-head">
                <h3>Your organisation's feed access</h3>
                <span class="chip">{{ myFeeds().length }} feeds</span>
                <span class="spacer"></span>
                <a class="small" routerLink="/market-data/instrument-candles">Instrument candles</a>
              </header>
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Feed</th>
                      <th>Access</th>
                      <th>Held as</th>
                      <th title="Enabled sources delivering this feed now">Live sources</th>
                      <th>Declaration</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (f of myFeeds(); track f.feedId) {
                      <tr>
                        <td><code>{{ f.feedId }}</code><span class="sub">{{ f.name }}</span></td>
                        <td class="small">{{ access(f) }}@if (f.validTo) {<span class="sub">until {{ f.validTo.slice(0, 10) }}</span>}</td>
                        <td class="small">{{ holding(f.source) }}</td>
                        <td class="small">
                          <span class="chip" [class.ok]="(live().get(f.feedId) ?? 0) > 0">{{ live().get(f.feedId) ?? 0 }}</span>
                        </td>
                        <td class="small">{{ f.declarationRequired ? 'Needed for real-time viewing' : 'Not needed' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          @if (!family()) {
            <section class="card" aria-label="What you will be asked">
              <header class="card-head">
                <h3>What you will be asked</h3>
                <span class="chip">questionnaire v{{ m.questionnaireVersion }}</span>
              </header>
              <div class="card-body">
                <ol class="small q-list">
                  @for (q of m.questions; track q.key) {
                    <li>{{ q.text }}</li>
                  }
                </ol>
                <p class="note">
                  Any answer that points to professional use makes you a professional subscriber for that exchange (its
                  fees are higher). You sign with your typed name; staff may review and reclassify it.
                </p>
              </div>
            </section>
          }

          @if (family(); as f) {
            <section class="card">
              <header class="card-head">
                <h3>Declare for {{ f.name }}</h3>
              </header>
              <div class="pad">
                @for (q of m.questions; track q.key) {
                  <fieldset class="field">
                    <legend class="label">{{ q.text }}</legend>
                    <label class="check">
                      <input
                        type="radio"
                        [name]="'q-' + q.key"
                        [checked]="draft().answers[q.key] === true"
                        (change)="answer(q.key, true)"
                      />
                      Yes
                    </label>
                    <label class="check">
                      <input
                        type="radio"
                        [name]="'q-' + q.key"
                        [checked]="draft().answers[q.key] === false"
                        (change)="answer(q.key, false)"
                      />
                      No
                    </label>
                  </fieldset>
                }
                <label class="check">
                  <input
                    type="checkbox"
                    name="selfPro"
                    [ngModel]="draft().selfDeclaredProfessional"
                    (ngModelChange)="patch({ selfDeclaredProfessional: $event })"
                  />
                  I am a professional subscriber whatever the answers above
                </label>
                @if (classification(); as c) {
                  <p class="small">
                    You will be declared a <strong>{{ type(c) }}</strong> subscriber for
                    {{ f.name }}, valid {{ m.validityDays }} days.
                  </p>
                }
                <label class="field">
                  <span class="label">Your full name (your signature)</span>
                  <input
                    class="input"
                    name="signedName"
                    autocomplete="name"
                    [ngModel]="draft().signedName"
                    (ngModelChange)="patch({ signedName: $event })"
                  />
                </label>
                <label class="check">
                  <input
                    type="checkbox"
                    name="attest"
                    [ngModel]="draft().attest"
                    (ngModelChange)="patch({ attest: $event })"
                  />
                  I confirm these answers are true, and I will declare again when they change.
                </label>
                @if (submitted() && errors().length > 0) {
                  <ul class="errors" role="alert">
                    @for (e of errors(); track e) {
                      <li>{{ e }}</li>
                    }
                  </ul>
                }
                <div class="row">
                  <button
                    type="button"
                    class="btn btn-primary"
                    (click)="sign(m)"
                    [disabled]="busy()"
                  >
                    {{ busy() ? 'Signing…' : 'Sign declaration' }}
                  </button>
                  <button type="button" class="btn btn-ghost" (click)="family.set(null)">
                    Cancel
                  </button>
                </div>
              </div>
            </section>
          }
          <p class="muted small">
            Signing records your name, the date and your answers. Staff may review it and reclassify
            it; you will see their note here. Crypto exchanges, FX venues and delayed data need no
            declaration.
          </p>
        }
      }
    </div>
  `,
})
export class MarketDataDeclarationsPageComponent {
  private readonly api = inject(MarketDataEntitlementsApiService);
  private readonly notify = inject(NotificationService);

  protected readonly type = subscriberTypeLabel;
  protected readonly at = when;

  private readonly http = inject(ApiService);
  protected readonly access = accessLabel;
  protected readonly holding = holdingLabel;
  /** `GET md/entitlements/me` — every feed the organisation may read, with how it holds it. */
  readonly feedsRes = iamResource<MyFeedRow[]>(
    () =>
      this.http.getEnvelope<{ feeds: MyFeedRow[] }>('/md/entitlements/me', { silent: true }).pipe(
        map((r) => r?.feeds ?? []),
        catchError(() => of([] as MyFeedRow[])),
      ),
    [],
  );
  /** `GET md/sources` — the enabled sources the caller may read, each with its feeds. */
  readonly sourcesRes = iamResource<{ feeds?: Record<string, string> | null }[]>(
    () =>
      this.http
        .getEnvelope<{ feeds?: Record<string, string> | null }[]>('/md/sources', { silent: true })
        .pipe(
          map((r) => r ?? []),
          catchError(() => of([])),
        ),
    [],
  );
  readonly myFeeds = computed(() =>
    [...this.feedsRes.value()].sort(
      (a, b) =>
        Number(!!b.exchangeFamily) - Number(!!a.exchangeFamily) || a.feedId.localeCompare(b.feedId),
    ),
  );
  readonly live = computed(() => liveSourcesPerFeed(this.sourcesRes.value()));
  readonly exchangeFeedCount = computed(() => this.myFeeds().filter((f) => !!f.exchangeFamily).length);
  readonly liveFeedCount = computed(() => this.myFeeds().filter((f) => (this.live().get(f.feedId) ?? 0) > 0).length);

  familyFeeds(family: string): string {
    return feedsOfFamily(this.myFeeds(), family)
      .map((f) => `${f.feedId} (${(f.delayMinutes ?? 0) > 0 ? 'delayed' : 'real time'})`)
      .join(', ');
  }

  neededOpen(m: MyDeclarations): number {
    return m.families.filter((f) => f.needed && !f.declaration?.current).length;
  }

  declaredCount(m: MyDeclarations): number {
    return m.families.filter((f) => f.declaration?.status === 'Accepted' || f.declaration?.status === 'Submitted').length;
  }

  readonly me = iamResource(
    () => this.api.myDeclarations(),
    null as MyDeclarations | null,
    'Could not load your declarations.',
  );
  readonly family = signal<DeclarationFamily | null>(null);
  readonly draft = signal<DeclarationDraft>({
    answers: {},
    selfDeclaredProfessional: false,
    signedName: '',
    attest: false,
  });
  readonly submitted = signal(false);
  readonly busy = signal(false);
  readonly errors = computed(() =>
    declarationErrors(this.me.value()?.questions ?? [], this.draft()),
  );
  readonly classification = computed(() =>
    classifyAnswers(
      this.me.value()?.questions ?? [],
      this.draft().answers,
      this.draft().selfDeclaredProfessional,
    ),
  );

  constructor() {
    this.me.reload();
    this.feedsRes.reload();
    this.sourcesRes.reload();
  }

  open(f: DeclarationFamily): void {
    this.family.set(f);
    this.submitted.set(false);
    this.draft.set({ answers: {}, selfDeclaredProfessional: false, signedName: '', attest: false });
  }

  answer(key: string, value: boolean): void {
    this.draft.update((d) => ({ ...d, answers: { ...d.answers, [key]: value } }));
  }

  patch(p: Partial<DeclarationDraft>): void {
    this.draft.update((d) => ({ ...d, ...p }));
  }

  async sign(m: MyDeclarations): Promise<void> {
    const f = this.family();
    this.submitted.set(true);
    if (!f || this.errors().length > 0 || this.busy()) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.declare(declarationBody(f.id, m.questions, this.draft())));
      this.notify.success(`Declaration for ${f.name} signed.`);
      this.family.set(null);
      this.me.reload();
    } catch (err: unknown) {
      if (reportable(err))
        this.notify.error(errorText(err, 'The declaration could not be signed.'));
    } finally {
      this.busy.set(false);
    }
  }

  async withdraw(id: number, name: string): Promise<void> {
    if (this.busy()) return;
    if (
      !window.confirm(
        `Withdraw your declaration for ${name}? Its real-time data will no longer be shown to you.`,
      )
    )
      return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.withdrawDeclaration(id));
      this.notify.success(`Declaration for ${name} withdrawn.`);
      this.me.reload();
    } catch (err: unknown) {
      if (reportable(err))
        this.notify.error(errorText(err, 'The declaration could not be withdrawn.'));
    } finally {
      this.busy.set(false);
    }
  }
}
