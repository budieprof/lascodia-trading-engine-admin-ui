import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

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
  imports: [FormsModule, PageHeaderComponent],
  styleUrl: '../../../iam/shared/iam-page.scss',
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
