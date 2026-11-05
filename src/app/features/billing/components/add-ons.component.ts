import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { take, timer } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { BrowserLocation } from '@core/browser/browser-location';
import { SALES_EMAIL } from '@core/branding/contact';
import { reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { BillingApiService } from '../billing-api.service';
import {
  ADD_ON_RETURN_PARAMS,
  addOnAction,
  addOnReturn,
  grantsLabel,
  heldLabel,
  priceLabel,
  showsBar,
  usageTone,
  usedLabel,
  usedPercent,
} from '../add-ons.logic';
import type { AddOn, UsageUnit } from '../add-ons.types';
import {
  PAYSTACK_CONFIRM_FALLBACK,
  billingRefusal,
  isFollowableRedirect,
  paystackOutcome,
  paystackReference,
} from '../plan-offers.logic';

/**
 * "Usage & add-ons" on Usage & billing (freemium program): each priced unit used against the plan's allowance plus
 * add-ons (`GET tenant/usage`, needs `tenant.usage.read`), and the add-ons — AI analyst, platform signals — with Start
 * free trial / Buy / Manage for someone holding `tenant.billing.manage`. Coming back from a payment page
 * (`?addon=success|cancelled|paystack`) it says what happened and re-reads the add-ons.
 */
@Component({
  selector: 'app-billing-add-ons',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .units {
        display: grid;
        gap: 1rem 1.5rem;
        padding: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
      }
      .unit {
        display: grid;
        gap: 0.4rem;
        align-content: start;
        min-width: 0;
      }
      .unit-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 0.75rem;
      }
      .unit-head > :first-child {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .unit-head > :last-child {
        flex-shrink: 0;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .track {
        height: 0.4rem;
        border-radius: 0.2rem;
        background: var(--surface-2, rgba(127, 127, 127, 0.18));
        overflow: hidden;
      }
      .fill {
        height: 100%;
        background: var(--ok, #2e9d5b);
      }
      .fill.warn {
        background: var(--warn, #c98a12);
      }
      .fill.bad {
        background: var(--bad, #c43d3d);
      }
      .addons {
        display: grid;
        gap: 0.75rem;
        padding: 0 1rem 1rem;
        grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
      }
      .addon {
        border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
        border-radius: 0.5rem;
        padding: 0.85rem;
        display: grid;
        gap: 0.4rem;
        align-content: start;
      }
      .addon h4 {
        margin: 0;
      }
      .row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
      }
    `,
  ],
  template: `
    <section class="card">
      <header class="card-head">
        <h3>Usage & add-ons</h3>
        <span class="spacer"></span>
        <span class="muted small">Monthly allowances start again on the 1st (UTC).</span>
      </header>

      @if (notice(); as n) {
        <p class="pad" role="status">
          <span class="chip" [class]="n.tone">{{ n.title }}</span> {{ n.text }}
        </p>
      }
      @if (actionError(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Not done</span> {{ err }}</p>
      }

      @if (units.value().length) {
        <div class="units">
          @for (u of units.value(); track u.unit) {
            <div class="unit">
              <div class="unit-head">
                <span>{{ u.label }}</span>
                <span class="small" [class.muted]="!u.nearLimit">{{ usedLabel(u) }}</span>
              </div>
              @if (showsBar(u)) {
                <div
                  class="track"
                  role="progressbar"
                  [attr.aria-valuenow]="usedPercent(u)"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-label]="u.label"
                >
                  <div class="fill" [class]="usageTone(u)" [style.width.%]="usedPercent(u)"></div>
                </div>
              }
              @if (u.resetsOnUtc && u.allowance !== null) {
                <span class="muted small">Starts again {{ when(u.resetsOnUtc) }}</span>
              }
            </div>
          }
        </div>
      } @else if (units.error() && !unitsForbidden()) {
        <p class="pad muted">Usage could not be loaded just now.</p>
      }

      @if (addOns.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      } @else if (addOns.value().length) {
        <div class="addons">
          @for (a of addOns.value(); track a.id) {
            <div class="addon">
              <div class="row">
                <h4>{{ a.name }}</h4>
                <span class="spacer"></span>
                @if (priceLabel(a); as p) {
                  <span class="small">{{ p }}</span>
                }
              </div>
              @if (a.description) {
                <span class="small">{{ a.description }}</span>
              }
              <span class="muted small">{{ grantsLabel(a.grants) }}</span>
              @if (a.held) {
                <span class="chip ok">{{ heldLabel(a, when) }}</span>
              }
              @if (canManage()) {
                <div class="row">
                  @switch (action(a)) {
                    @case ('manage') {
                      <button
                        type="button"
                        class="btn btn-sm btn-secondary"
                        [disabled]="busy() !== null"
                        (click)="manage(a)"
                      >
                        {{ busy() === a.slug ? 'Opening…' : 'Manage' }}
                      </button>
                    }
                    @case ('buy') {
                      <button
                        type="button"
                        class="btn btn-sm btn-primary"
                        [disabled]="busy() !== null || pending()"
                        (click)="buy(a)"
                      >
                        {{
                          busy() === a.slug ? 'Opening…' : a.held ? 'Keep it — pay by card' : 'Add'
                        }}
                      </button>
                      @if (a.trialAvailable) {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          [disabled]="busy() !== null"
                          (click)="trial(a)"
                        >
                          Try free for {{ a.trialDays }} days
                        </button>
                      }
                    }
                    @case ('trial') {
                      <button
                        type="button"
                        class="btn btn-sm btn-primary"
                        [disabled]="busy() !== null"
                        (click)="trial(a)"
                      >
                        {{
                          busy() === a.slug ? 'Starting…' : 'Try free for ' + a.trialDays + ' days'
                        }}
                      </button>
                    }
                    @case ('contact') {
                      <a class="small" [href]="'mailto:' + salesEmail + '?subject=' + a.name"
                        >Contact us to add it</a
                      >
                    }
                  }
                </div>
              }
            </div>
          }
        </div>
      } @else if (!addOns.loaded()) {
        <p class="pad muted">Loading…</p>
      }
    </section>
  `,
})
export class AddOnsComponent {
  private readonly api = inject(BillingApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(BrowserLocation);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly salesEmail = SALES_EMAIL;
  protected readonly when = when;
  protected readonly usedLabel = usedLabel;
  protected readonly usedPercent = usedPercent;
  protected readonly showsBar = showsBar;
  protected readonly usageTone = usageTone;
  protected readonly grantsLabel = grantsLabel;
  protected readonly priceLabel = priceLabel;
  protected readonly heldLabel = heldLabel;
  protected readonly action = addOnAction;

  readonly canManage = computed(() => this.auth.hasPermission(Permission.TenantBillingManage));
  readonly unitsForbidden = computed(() => !this.auth.hasPermission(Permission.TenantUsageRead));

  readonly units = iamResource<UsageUnit[]>(() => this.api.myUnits(), [], 'Could not load usage.');
  readonly addOns = iamResource<AddOn[]>(() => this.api.myAddOns(), [], 'Could not load add-ons.');

  readonly busy = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  /** Just paid: no second checkout while the payment is being applied. */
  readonly pending = signal(false);
  readonly notice = signal<{ tone: 'ok' | 'info' | 'warn'; title: string; text: string } | null>(
    null,
  );

  constructor() {
    if (!this.unitsForbidden()) this.units.reload();
    const params = this.route.snapshot.queryParamMap;
    const ret = addOnReturn(params.get('addon'));
    if (ret) this.stripReturnParams();
    if (ret === 'cancelled')
      this.notice.set({
        tone: 'info',
        title: 'Not added',
        text: 'The payment was cancelled. Nothing was charged.',
      });
    if (ret === 'success') this.waitForPayment();
    else if (ret === 'paystack')
      this.confirmPaystack(paystackReference(params.get('reference'), params.get('trxref')));
    else this.addOns.reload();
  }

  /** Re-reads usage and add-ons (the page's Refresh). */
  reload(): void {
    if (!this.unitsForbidden()) this.units.reload();
    this.addOns.reload();
  }

  trial(a: AddOn): void {
    this.busy.set(a.slug);
    this.actionError.set(null);
    this.api
      .startAddOnTrial(a.slug)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set(null);
          this.notice.set({
            tone: 'ok',
            title: 'Trial started',
            text: `${a.name} is on for ${a.trialDays} days.`,
          });
          this.reload();
        },
        error: (e: unknown) => {
          this.busy.set(null);
          if (reportable(e)) this.actionError.set(billingRefusal(e, 'Could not start the trial.'));
        },
      });
  }

  buy(a: AddOn): void {
    this.redirect(a.slug, this.api.addOnCheckout(a.slug), 'Could not open the payment page.');
  }

  manage(a: AddOn): void {
    this.redirect(a.slug, this.api.manageAddOn(a.slug), 'Could not open the billing page.');
  }

  private redirect(
    slug: string,
    call: ReturnType<BillingApiService['addOnCheckout']>,
    fallback: string,
  ): void {
    this.busy.set(slug);
    this.actionError.set(null);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (isFollowableRedirect(r?.url))
          this.location.assign(r.url); // leaving the console; stays busy
        else {
          this.busy.set(null);
          this.actionError.set(fallback);
        }
      },
      error: (e: unknown) => {
        this.busy.set(null);
        if (reportable(e)) this.actionError.set(billingRefusal(e, fallback));
      },
    });
  }

  private confirmPaystack(reference: string | null): void {
    this.addOns.reload();
    if (!reference) {
      this.actionError.set(PAYSTACK_CONFIRM_FALLBACK);
      return;
    }
    this.pending.set(true);
    this.api
      .confirmAddOnPaystack(reference)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const outcome = paystackOutcome(r);
          this.pending.set(false);
          if (outcome.kind === 'done') {
            this.notice.set({
              tone: 'ok',
              title: 'Added',
              text: 'Payment received. Your add-on is on.',
            });
            this.reload();
          } else if (outcome.kind === 'wait') this.waitForPayment();
          else if (outcome.kind === 'cancelled')
            this.notice.set({
              tone: 'info',
              title: 'Not added',
              text: 'The payment was not completed. Nothing was charged.',
            });
          else this.actionError.set(outcome.text);
        },
        error: (e: unknown) => {
          this.pending.set(false);
          if (reportable(e)) this.actionError.set(billingRefusal(e, PAYSTACK_CONFIRM_FALLBACK));
        },
      });
  }

  /** After a paid checkout: re-read the add-ons a few times while the provider confirms (it takes seconds, rarely a minute). */
  private waitForPayment(): void {
    this.pending.set(true);
    this.notice.set({
      tone: 'info',
      title: 'Payment received',
      text: 'Your add-on is being turned on; this can take a minute.',
    });
    timer(0, 4000)
      .pipe(take(10), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.reload(),
        complete: () => this.pending.set(false),
      });
  }

  private stripReturnParams(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: Object.fromEntries(ADD_ON_RETURN_PARAMS.map((k) => [k, null])),
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
