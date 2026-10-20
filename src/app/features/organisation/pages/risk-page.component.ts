import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, map, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { ConfigChangeDialogComponent } from '../components/config-change-dialog.component';
import { OrganisationApiService } from '../organisation-api.service';
import { confirmationMatches, failureMessage, isApprovalPending } from '../organisation.logic';
import type {
  AccountRef,
  AccountSwitchRow,
  EffectiveConfig,
  EffectiveConfigEntry,
  ScopedKillSwitchStatus,
} from '../organisation.types';
import {
  KILL_REASON_MAX,
  flattenEffects,
  flattenPhrase,
  lastChange,
  limitLabel,
  reasonProblem,
  riskLimitEntries,
  switchState,
} from '../risk.logic';
import { sourceLabel, valueText } from '../settings.logic';
import { accountLabel, accountRefs } from '../terminals.logic';

/** A kill-switch change waiting for its confirmation. */
interface SwitchChange {
  scope: 'organisation' | 'account';
  account: AccountRef | null;
  /** True = engage, false = release. */
  enable: boolean;
}

/** A flatten waiting for its typed confirmation. */
interface FlattenRequest {
  scope: 'organisation' | 'account';
  account: AccountRef | null;
  phrase: string;
}

/**
 * Risk & kill switches (multi-tenancy Phase 7, T7.3; engine R6R.1–R6R.3). The organisation's and
 * each account's kill switch (engaging needs `engine.killswitch`; releasing `engine.killswitch.release`
 * — a fresh second-factor sign-in and, where two-person rules apply, a second person's approval), a
 * scoped emergency flatten behind a typed confirmation (`positions.flatten`), and the organisation-wide
 * limits `TenantRisk:*` (organisation layer, tighten-only; loosening is governed — `engine.config`).
 */
@Component({
  selector: 'app-org-risk-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    LscCanDirective,
    PageHeaderComponent,
    ConfirmDialogComponent,
    ModalA11yDirective,
    MfaHintComponent,
    ConfigChangeDialogComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .card.engaged {
        border-color: var(--loss);
      }
      .card.danger .card-head h3 {
        color: var(--loss);
      }
      .effects {
        margin: 0;
        padding-left: var(--space-5);
        font-size: var(--text-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .dialog {
        background: var(--bg-primary);
        border: 1px solid var(--loss);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(520px, calc(100vw - 32px));
        max-height: calc(100vh - 48px);
        overflow: auto;
      }
      .dialog h3 {
        margin: 0;
        font-size: var(--text-base);
        color: var(--loss);
      }
      .btn-flatten {
        background: var(--loss);
        color: #fff;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Risk & kill switches"
        subtitle="Stop the organisation or one account trading, flatten in an emergency, and set limits across every account."
      >
        <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (canReadSwitches()) {
        <section class="card" [class.engaged]="org.value()?.enabled">
          <header class="card-head">
            <h3>Organisation kill switch</h3>
            <span class="chip" [class]="state(org.value()).tone">{{
              state(org.value()).label
            }}</span>
            <span class="spacer"></span>
            @if (org.value()?.enabled) {
              <app-mfa-hint [permission]="P.EngineKillswitchRelease" />
              <button
                *lscCan="P.EngineKillswitchRelease"
                type="button"
                class="btn btn-sm btn-secondary"
                (click)="startSwitch('organisation', false)"
              >
                Release…
              </button>
            } @else if (org.loaded() && !org.error()) {
              <button
                *lscCan="P.EngineKillswitch"
                type="button"
                class="btn btn-sm btn-danger"
                (click)="startSwitch('organisation', true)"
              >
                Engage…
              </button>
            }
          </header>
          <div class="card-body">
            @if (org.error(); as err) {
              <p role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
            }
            <p class="muted small">
              Engaged, no new orders are placed on any of the organisation's accounts and its EAs
              are told to halt. Open positions stay open — use the emergency flatten to close them.
            </p>
            @if (lastChange(org.value()); as change) {
              <p class="small">{{ change }}</p>
            }
            @if (org.value()?.haltedBy === 'Platform') {
              <p class="note warn">
                The platform's kill switch is engaged: nothing trades, whatever this switch says.
                Platform staff release it.
              </p>
            }
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Accounts</h3>
            <span class="spacer"></span>
            <span class="muted small"
              >An account trades only when its own, the organisation's and the platform's switches
              are all released.</span
            >
          </header>
          @if (accountRows().length) {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>State</th>
                    <th>Last change</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of accountRows(); track r.account.id) {
                    <tr>
                      <td>{{ accountLabel(r.account) }}</td>
                      <td>
                        @if (r.error) {
                          <span class="chip bad" [title]="r.error">Could not load</span>
                        } @else {
                          <span class="chip" [class]="state(r.status).tone">{{
                            state(r.status).label
                          }}</span>
                        }
                      </td>
                      <td class="small">{{ lastChange(r.status) ?? '—' }}</td>
                      <td class="actions">
                        @if (r.status?.enabled) {
                          <button
                            *lscCan="P.EngineKillswitchRelease"
                            type="button"
                            class="btn btn-sm btn-secondary"
                            (click)="startSwitch('account', false, r.account)"
                          >
                            Release…
                          </button>
                        } @else if (r.status) {
                          <button
                            *lscCan="P.EngineKillswitch"
                            type="button"
                            class="btn btn-sm btn-secondary"
                            (click)="startSwitch('account', true, r.account)"
                          >
                            Engage…
                          </button>
                        }
                        <button
                          *lscCan="P.PositionsFlatten"
                          type="button"
                          class="btn btn-sm btn-danger"
                          (click)="startFlatten('account', r.account)"
                        >
                          Flatten…
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (!accountsLoading()) {
            <p class="pad muted">The organisation has no trading accounts yet.</p>
          }
        </section>
      }

      <section class="card danger" *lscCan="P.PositionsFlatten">
        <header class="card-head"><h3>Emergency flatten — the whole organisation</h3></header>
        <div class="card-body">
          <ul class="effects">
            @for (line of orgFlattenEffects; track $index) {
              <li>{{ line }}</li>
            }
          </ul>
          <div class="actions-row">
            <button type="button" class="btn btn-flatten" (click)="startFlatten('organisation')">
              Flatten the organisation…
            </button>
          </div>
        </div>
      </section>

      @if (canReadLimits()) {
        <section class="card">
          <header class="card-head">
            <h3>Organisation-wide limits</h3>
            <span class="spacer"></span>
            <app-mfa-hint [permission]="P.RiskLoosen" />
          </header>
          @if (limits.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
          @if (limitRows().length) {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Limit</th>
                    <th>In effect</th>
                    <th>Platform's</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of limitRows(); track e.key) {
                    <tr>
                      <td>
                        {{ limitLabel(e.key) }}
                        <span class="sub">{{ e.description }}</span>
                      </td>
                      <td>
                        {{ valueText(e, e.value) }}
                        <span class="sub">{{ sourceLabel(e.source) }}</span>
                      </td>
                      <td>
                        {{ e.inheritedValue === undefined ? '—' : valueText(e, e.inheritedValue) }}
                      </td>
                      <td class="actions">
                        <ng-container *lscCan="P.EngineConfig">
                          <button
                            type="button"
                            class="btn btn-sm btn-secondary"
                            (click)="editLimit(e, 'set')"
                          >
                            Change
                          </button>
                          @if (e.source === 'Tenant') {
                            <button
                              type="button"
                              class="btn btn-sm btn-danger"
                              (click)="editLimit(e, 'remove')"
                            >
                              Remove
                            </button>
                          }
                        </ng-container>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (limits.loaded() && !limits.error()) {
            <p class="pad muted">This engine does not offer organisation-wide limits yet.</p>
          }
          <p class="note">
            Each limit counts every account of the organisation, and the stricter of the platform's
            and the organisation's own value applies (0 = no limit). The organisation may only set a
            limit stricter than the platform's; raising or removing its own limit is a loosening: it
            needs a reason and the risk.loosen permission, may need a second person, and waits out
            the cooling-off period.
          </p>
        </section>
      }

      <app-config-change-dialog (closed)="limitDone($event)" />

      <app-confirm-dialog
        [open]="switching() !== null"
        [title]="switchTitle()"
        [message]="switchMessage()"
        [confirmLabel]="switching()?.enable ? 'Engage' : 'Release'"
        [confirmVariant]="switching()?.enable ? 'destructive' : 'primary'"
        [loading]="busy()"
        (confirm)="confirmSwitch()"
        (cancelled)="switching.set(null)"
      >
        @if (switching() && !switching()!.enable) {
          <p class="note warn">
            Releasing needs a sign-in with your second factor within the last five minutes. Where
            two-person rules apply it is sent to another person for approval and stays engaged until
            they approve.
          </p>
        }
        <label class="field">
          <span class="label">Reason (required)</span>
          <textarea
            class="textarea"
            name="switchReason"
            rows="2"
            [maxlength]="reasonMax"
            [ngModel]="switchReason()"
            (ngModelChange)="switchReason.set($event)"
          ></textarea>
        </label>
        @if (switchSubmitted() && reasonProblem(switchReason()); as p) {
          <p class="errors" role="alert">{{ p }}</p>
        }
      </app-confirm-dialog>

      @if (flattening(); as f) {
        <div class="overlay" role="presentation" (click)="cancelFlatten()">
          <div
            class="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="flatten-title"
            tabindex="-1"
            appModalA11y
            (dismiss)="cancelFlatten()"
            (click)="$event.stopPropagation()"
            (keydown)="$event.stopPropagation()"
          >
            <form class="card-body" (ngSubmit)="confirmFlatten()">
              <h3 id="flatten-title">
                Flatten
                {{
                  f.scope === 'organisation' ? 'the whole organisation' : accountLabel(f.account)
                }}?
              </h3>
              <ul class="effects">
                @for (line of flattenEffects(f.scope); track $index) {
                  <li>{{ line }}</li>
                }
              </ul>
              <label class="field">
                <span class="label">Reason (required)</span>
                <textarea
                  class="textarea"
                  name="flattenReason"
                  rows="2"
                  [maxlength]="reasonMax"
                  [ngModel]="flattenReason()"
                  (ngModelChange)="flattenReason.set($event)"
                ></textarea>
              </label>
              <label class="field">
                <span class="label"
                  >Type <code>{{ f.phrase }}</code> to confirm</span
                >
                <input
                  class="input"
                  name="typed"
                  autocomplete="off"
                  spellcheck="false"
                  [ngModel]="typed()"
                  (ngModelChange)="typed.set($event)"
                />
              </label>
              @if (flattenSubmitted() && reasonProblem(flattenReason()); as p) {
                <p class="errors" role="alert">{{ p }}</p>
              }
              <div class="actions-row">
                <button
                  type="button"
                  class="btn btn-secondary"
                  data-autofocus
                  [disabled]="busy()"
                  (click)="cancelFlatten()"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-flatten"
                  [disabled]="busy() || !flattenReady()"
                >
                  {{ busy() ? 'Flattening…' : 'Flatten now' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      }
    </div>
  `,
})
export class RiskPageComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);
  private readonly scope = inject(AccountScopeService);
  private readonly auth = inject(AuthService);

  protected readonly P = Permission;
  protected readonly state = switchState;
  protected readonly lastChange = lastChange;
  protected readonly accountLabel = accountLabel;
  protected readonly limitLabel = limitLabel;
  protected readonly valueText = valueText;
  protected readonly sourceLabel = sourceLabel;
  protected readonly reasonProblem = reasonProblem;
  protected readonly flattenEffects = flattenEffects;
  protected readonly orgFlattenEffects = flattenEffects('organisation');
  protected readonly reasonMax = KILL_REASON_MAX;

  readonly canReadSwitches = computed(() => this.auth.hasPermission(Permission.EngineKillswitch));
  readonly canReadLimits = computed(() => this.auth.hasPermission(Permission.EngineConfig));

  readonly accounts = computed(() => accountRefs(this.scope.accounts()));
  private readonly accountIdsKey = computed(() =>
    this.accounts()
      .map((a) => a.id)
      .join(','),
  );

  readonly org = iamResource<ScopedKillSwitchStatus | null>(
    () => this.api.tenantKillSwitch(),
    null,
    "Could not read the organisation's kill switch.",
  );
  readonly limits = iamResource<EffectiveConfig | null>(
    () => this.api.effectiveConfig(null),
    null,
    'Could not load the organisation-wide limits.',
  );
  readonly limitRows = computed(() => riskLimitEntries(this.limits.value()?.entries ?? []));

  readonly accountRows = signal<AccountSwitchRow[]>([]);
  readonly accountsLoading = signal(false);
  readonly loading = computed(
    () => this.org.loading() || this.limits.loading() || this.accountsLoading(),
  );

  readonly busy = signal(false);
  readonly switching = signal<SwitchChange | null>(null);
  readonly switchReason = signal('');
  readonly switchSubmitted = signal(false);
  readonly switchTitle = computed(() => {
    const s = this.switching();
    if (!s) return '';
    const what = s.scope === 'organisation' ? "the organisation's" : "this account's";
    return `${s.enable ? 'Engage' : 'Release'} ${what} kill switch?`;
  });
  readonly switchMessage = computed(() => {
    const s = this.switching();
    if (!s) return '';
    const who =
      s.scope === 'organisation'
        ? "every one of the organisation's accounts"
        : accountLabel(s.account);
    return s.enable
      ? `No new orders are placed on ${who}, and their EAs are told to halt. Open positions stay open.`
      : `${who} may trade again once nothing else halts it.`;
  });

  readonly flattening = signal<FlattenRequest | null>(null);
  readonly typed = signal('');
  readonly flattenReason = signal('');
  readonly flattenSubmitted = signal(false);
  readonly flattenReady = computed(() => {
    const f = this.flattening();
    return (
      !!f && confirmationMatches(this.typed(), f.phrase) && !reasonProblem(this.flattenReason())
    );
  });

  private readonly changer = viewChild(ConfigChangeDialogComponent);

  constructor() {
    this.loadOrganisation();
    this.loadLimits();
    // The account list is kept by the account scope (refreshed every 30 s): read the switches again
    // only when the set of accounts changes, never on an unchanged refresh.
    effect(() => {
      this.accountIdsKey();
      untracked(() => this.loadAccounts());
    });
  }

  reload(): void {
    this.loadOrganisation();
    this.loadLimits();
    this.loadAccounts();
  }

  private loadOrganisation(): void {
    if (this.canReadSwitches()) this.org.reload();
  }

  private loadLimits(): void {
    if (this.canReadLimits()) this.limits.reload();
  }

  loadAccounts(): void {
    const accounts = this.accounts();
    if (!this.canReadSwitches() || !accounts.length) {
      this.accountRows.set(accounts.map((account) => ({ account, status: null, error: null })));
      return;
    }
    this.accountsLoading.set(true);
    forkJoin(
      accounts.map((account) =>
        this.api.accountKillSwitch(account.id).pipe(
          map((status): AccountSwitchRow => ({ account, status, error: null })),
          catchError((e) =>
            of<AccountSwitchRow>({
              account,
              status: null,
              error: errorText(e, 'Could not read this switch.'),
            }),
          ),
        ),
      ),
    ).subscribe((rows) => {
      this.accountRows.set(rows);
      this.accountsLoading.set(false);
    });
  }

  // ── Kill switches ──

  startSwitch(
    scope: 'organisation' | 'account',
    enable: boolean,
    account: AccountRef | null = null,
  ): void {
    this.switchReason.set('');
    this.switchSubmitted.set(false);
    this.switching.set({ scope, account, enable });
  }

  confirmSwitch(): void {
    const s = this.switching();
    this.switchSubmitted.set(true);
    if (!s || this.busy() || reasonProblem(this.switchReason())) return;
    const reason = this.switchReason().trim();
    const call$ =
      s.scope === 'organisation'
        ? this.api.setTenantKillSwitch(s.enable, reason)
        : this.api.setAccountKillSwitch(s.account!.id, s.enable, reason);
    this.busy.set(true);
    call$.subscribe({
      next: () => {
        this.busy.set(false);
        this.switching.set(null);
        const what =
          s.scope === 'organisation' ? "The organisation's" : `${accountLabel(s.account)}:`;
        this.notify.success(`${what} kill switch ${s.enable ? 'engaged' : 'released'}.`);
        this.afterSwitch(s);
      },
      error: (e) => {
        this.busy.set(false);
        this.switching.set(null);
        // A release sent for a second person's approval stays engaged; the interceptor said so.
        if (!isApprovalPending(e)) {
          const msg = failureMessage(e, 'The kill switch was not changed.');
          if (msg) this.notify.error(msg);
        }
        this.afterSwitch(s);
      },
    });
  }

  private afterSwitch(s: SwitchChange): void {
    if (s.scope === 'organisation') this.loadOrganisation();
    this.loadAccounts();
  }

  // ── Emergency flatten ──

  startFlatten(scope: 'organisation' | 'account', account: AccountRef | null = null): void {
    this.typed.set('');
    this.flattenReason.set('');
    this.flattenSubmitted.set(false);
    this.flattening.set({
      scope,
      account,
      phrase: flattenPhrase(scope, this.auth.activeTenant()?.name ?? null, account),
    });
  }

  cancelFlatten(): void {
    if (this.busy()) return;
    this.flattening.set(null);
  }

  confirmFlatten(): void {
    const f = this.flattening();
    this.flattenSubmitted.set(true);
    if (!f || this.busy() || !this.flattenReady()) return;
    const reason = this.flattenReason().trim();
    const call$ =
      f.scope === 'organisation'
        ? this.api.flattenOrganisation(reason)
        : this.api.flattenAccount(f.account!.id, reason);
    this.busy.set(true);
    call$.subscribe({
      next: () => {
        this.busy.set(false);
        this.flattening.set(null);
        this.notify.success(
          f.scope === 'organisation'
            ? 'Flattening the organisation: its kill switch is engaged, orders are being cancelled and positions closed.'
            : `Flattening ${accountLabel(f.account)}: its kill switch is engaged, orders are being cancelled and positions closed.`,
        );
        this.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.flattening.set(null);
        const msg = failureMessage(e, 'The flatten was not started.');
        if (msg) this.notify.error(msg);
        this.reload();
      },
    });
  }

  // ── Organisation-wide limits ──

  editLimit(e: EffectiveConfigEntry, mode: 'set' | 'remove'): void {
    this.changer()?.open({
      entry: e,
      mode,
      layer: 'Tenant',
      tradingAccountId: null,
      scopeName: 'The organisation',
    });
  }

  limitDone(changed: boolean): void {
    if (changed) this.loadLimits();
  }
}
