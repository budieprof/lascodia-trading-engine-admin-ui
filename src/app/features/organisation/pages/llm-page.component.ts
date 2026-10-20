import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, when } from '@features/iam/iam.logic';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import {
  LLM_KEY_PROVIDERS,
  availabilityOf,
  budgetLine,
  keyProblem,
  paidByLabel,
  providerLabel,
  tokens,
  usd,
  type Availability,
} from '../llm.logic';
import { OrganisationApiService } from '../organisation-api.service';
import { failureMessage } from '../organisation.logic';
import type { LlmUsageReport, TenantLlmKey } from '../organisation.types';

/**
 * LLM usage & key (multi-tenancy Phase 7, T7.6; engine r6-llm `GET /llm/usage`, `GET|PUT|DELETE
 * /llm/tenant-key`). This month's LLM calls, tokens and cost against the organisation's budget, the
 * provider each tier runs on, and the organisation's own provider keys (write-only; changes are
 * step-up). The page asks the engine itself whether these endpoints exist: on an engine without them
 * it says "not available yet". The engine enforces `llm.usage.read` and `llm.keys.manage`.
 */
@Component({
  selector: 'app-org-llm-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    LscCanDirective,
    PageHeaderComponent,
    ConfirmDialogComponent,
    MfaHintComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .meter {
        height: 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        overflow: hidden;
        margin-top: 4px;
      }
      .meter span {
        display: block;
        height: 100%;
        background: var(--accent);
      }
      .meter span.warn {
        background: #b25000;
      }
      .meter span.bad {
        background: var(--loss);
      }
      .figures {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .figure .value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="LLM usage & key"
        subtitle="This month's LLM use against the organisation's budget, and the organisation's own provider key."
      >
        <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card">
        <header class="card-head">
          <h3>This month</h3>
          @if (usage(); as u) {
            <span class="muted small">
              {{ u.from }} to {{ u.to }} (UTC){{
                u.asOfUtc ? ' · added up ' + when(u.asOfUtc) : ''
              }}
            </span>
          }
        </header>
        @switch (usageState()) {
          @case ('missing') {
            <p class="pad muted">LLM usage is not available on this engine yet.</p>
          }
          @case ('forbidden') {
            <p class="pad muted">You do not have permission to see the organisation's LLM usage.</p>
          }
          @case ('error') {
            <p class="pad" role="alert">
              <span class="chip bad">Could not load</span> {{ usageError() }}
            </p>
          }
        }
        @if (usage(); as u) {
          <div class="card-body">
            @if (u.budget; as b) {
              @if (b.blocked) {
                <p class="note warn" role="status">New LLM calls are refused now: {{ b.reason }}</p>
              }
              <div class="figures">
                <div class="figure">
                  <span class="label">Today</span>
                  <div class="value">{{ daily()?.text }}</div>
                  @if (daily()?.percent !== null && daily()?.percent !== undefined) {
                    <div class="meter" role="presentation">
                      <span [class]="daily()!.tone" [style.width.%]="daily()!.percent"></span>
                    </div>
                  }
                  <span class="muted small">Resets {{ when(b.dailyResetsAtUtc) }}</span>
                </div>
                <div class="figure">
                  <span class="label">This month</span>
                  <div class="value">{{ monthly()?.text }}</div>
                  @if (monthly()?.percent !== null && monthly()?.percent !== undefined) {
                    <div class="meter" role="presentation">
                      <span [class]="monthly()!.tone" [style.width.%]="monthly()!.percent"></span>
                    </div>
                  }
                  <span class="muted small">Resets {{ when(b.monthlyResetsAtUtc) }}</span>
                </div>
              </div>
              <p class="muted small">
                Calls stop once spend reaches {{ thresholdPct() }}% of a cap.
                {{
                  b.assistantExemptFromDaily
                    ? 'The console assistant is not held to the daily cap.'
                    : ''
                }}
              </p>
            }
            <div class="figures">
              <div class="figure">
                <span class="label">Calls</span>
                <div class="value">{{ u.totals.calls }}</div>
                <span class="muted small"
                  >{{ u.totals.failedCalls }} failed · {{ u.totals.refusedCalls }} refused</span
                >
              </div>
              <div class="figure">
                <span class="label">Billed</span>
                <div class="value">{{ usd(u.totals.costUsd) }}</div>
                <span class="muted small"
                  >Platform {{ usd(u.totals.platformPaidCostUsd) }} · own key
                  {{ usd(u.totals.ownKeyCostUsd) }}</span
                >
              </div>
              <div class="figure">
                <span class="label">At API list prices</span>
                <div class="value">{{ usd(u.totals.notionalCostUsd) }}</div>
              </div>
              <div class="figure">
                <span class="label">Tokens in / out</span>
                <div class="value">
                  {{ tokens(u.totals.tokensInput) }} / {{ tokens(u.totals.tokensOutput) }}
                </div>
                <span class="muted small"
                  >cache read {{ tokens(u.totals.tokensCacheRead) }} · written
                  {{ tokens(u.totals.tokensCacheWrite) }}</span
                >
              </div>
            </div>
            @if (u.deepTier || u.quickTier) {
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Tier</th>
                      <th>Provider and model</th>
                      <th>Paid by</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (t of tiers(); track t.name) {
                      <tr>
                        <td>{{ t.name }}</td>
                        <td>
                          {{ providerLabel(t.tier.provider) }} ·
                          {{ t.tier.model || 'default model' }}
                        </td>
                        <td>{{ paidByLabel(t.tier.paidBy) }}</td>
                        <td>
                          @if (t.tier.ready) {
                            <span class="chip ok">Ready</span>
                          } @else {
                            <span class="chip bad">Refused</span>
                            <span class="sub">{{ t.tier.problem }}</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            @if (u.byModel.length) {
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Provider and model</th>
                      <th>Paid by</th>
                      <th>Calls</th>
                      <th>Billed</th>
                      <th>List price</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (m of u.byModel; track m.provider + m.model + m.paidBy) {
                      <tr>
                        <td>{{ providerLabel(m.provider) }} · {{ m.model }}</td>
                        <td>{{ paidByLabel(m.paidBy) }}</td>
                        <td>{{ m.calls }}</td>
                        <td>{{ usd(m.costUsd) }}</td>
                        <td>{{ usd(m.notionalCostUsd) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <p class="muted small">No LLM call was made for the organisation this month.</p>
            }
          </div>
        }
      </section>

      <section class="card">
        <header class="card-head">
          <h3>Your own provider key</h3>
          <span class="spacer"></span>
          <app-mfa-hint [permission]="P.LlmKeysManage" />
        </header>
        @switch (keysState()) {
          @case ('missing') {
            <p class="pad muted">Organisation keys are not available on this engine yet.</p>
          }
          @case ('forbidden') {
            <p class="pad muted">
              You do not have permission to manage the organisation's LLM keys.
            </p>
          }
          @case ('error') {
            <p class="pad" role="alert">
              <span class="chip bad">Could not load</span> {{ keysError() }}
            </p>
          }
        }
        @if (keysState() === 'ok') {
          <div class="card-body">
            <p class="muted small">
              A key is used only when the organisation's Llm:Tenant:PaidBy setting is OwnKey (see
              <a routerLink="/organisation/settings">Settings</a>); otherwise the platform pays.
              Keys are never shown again: only their last four characters.
            </p>
            @if (keys().length) {
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Key</th>
                      <th>Stored</th>
                      <th><span class="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (k of keys(); track k.provider) {
                      <tr>
                        <td>{{ providerLabel(k.provider) }}</td>
                        <td>
                          <code>{{ k.hint }}</code>
                        </td>
                        <td>
                          {{ when(k.updatedAtUtc) }}
                          @if (k.updatedBy) {
                            <span class="sub">{{ k.updatedBy }}</span>
                          }
                        </td>
                        <td class="actions">
                          <button
                            *lscCan="P.LlmKeysManage"
                            type="button"
                            class="btn btn-sm btn-danger"
                            (click)="removing.set(k)"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            @if (isHouse()) {
              <p class="note">
                House runs on the engine-wide LLM provider settings (LLM → Settings) and stores no
                organisation key.
              </p>
            } @else {
              <form class="form-grid" *lscCan="P.LlmKeysManage" (ngSubmit)="store()">
                <label class="field">
                  <span class="label">Provider</span>
                  <select
                    class="select"
                    name="provider"
                    [ngModel]="provider()"
                    (ngModelChange)="provider.set($event)"
                  >
                    @for (p of providers; track p.id) {
                      <option [value]="p.id">{{ p.label }}</option>
                    }
                  </select>
                </label>
                <label class="field">
                  <span class="label">
                    API key{{ hasKey(provider()) ? ' (replaces the stored one)' : '' }}
                  </span>
                  <input
                    class="input"
                    type="password"
                    name="apiKey"
                    autocomplete="new-password"
                    spellcheck="false"
                    [ngModel]="apiKey()"
                    (ngModelChange)="apiKey.set($event)"
                  />
                </label>
                <div class="field">
                  <span class="label">&nbsp;</span>
                  <button type="submit" class="btn btn-primary" [disabled]="busy()">
                    {{ busy() ? 'Storing…' : hasKey(provider()) ? 'Replace key' : 'Store key' }}
                  </button>
                </div>
              </form>
              @if (submitted() && keyProblem(); as p) {
                <p class="errors" role="alert">{{ p }}</p>
              }
            }
          </div>
        }
      </section>

      <app-confirm-dialog
        [open]="removing() !== null"
        [title]="'Remove the ' + providerLabel(removing()?.provider ?? '') + ' key?'"
        message="Calls that need the organisation's own key for this provider are refused until a key is stored again. The stored key is deleted."
        confirmLabel="Remove key"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="removing.set(null)"
      />
    </div>
  `,
})
export class LlmPageComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);

  protected readonly when = when;
  protected readonly usd = usd;
  protected readonly tokens = tokens;
  protected readonly providerLabel = providerLabel;
  protected readonly paidByLabel = paidByLabel;
  protected readonly providers = LLM_KEY_PROVIDERS;
  protected readonly P = Permission;

  readonly usage = signal<LlmUsageReport | null>(null);
  readonly usageState = signal<Availability | null>(null);
  readonly usageError = signal<string | null>(null);
  readonly usageLoading = signal(false);

  readonly keys = signal<TenantLlmKey[]>([]);
  readonly keysState = signal<Availability | null>(null);
  readonly keysError = signal<string | null>(null);
  readonly keysLoading = signal(false);

  readonly loading = computed(() => this.usageLoading() || this.keysLoading());

  readonly daily = computed(() => {
    const b = this.usage()?.budget;
    return b ? budgetLine(b.spentTodayUsd, b.dailyCapUsd, b.thresholdFraction) : null;
  });
  readonly monthly = computed(() => {
    const b = this.usage()?.budget;
    return b ? budgetLine(b.spentThisMonthUsd, b.monthlyCapUsd, b.thresholdFraction) : null;
  });
  readonly thresholdPct = computed(() =>
    Math.round((this.usage()?.budget?.thresholdFraction ?? 1) * 100),
  );
  readonly tiers = computed(() => {
    const u = this.usage();
    return [
      { name: 'Deep analysis', tier: u?.deepTier ?? null },
      { name: 'Quick tasks', tier: u?.quickTier ?? null },
    ].filter((t): t is { name: string; tier: NonNullable<typeof t.tier> } => t.tier !== null);
  });

  /** House stores no organisation key (the engine refuses it); a legacy sign-in acts in House. */
  readonly isHouse = computed(() => {
    const t = this.auth.activeTenant();
    return t ? t.kind === 'House' : this.auth.mode === 'legacy';
  });

  readonly provider = signal('anthropic');
  readonly apiKey = signal('');
  readonly submitted = signal(false);
  readonly keyProblem = computed(() => keyProblem(this.provider(), this.apiKey()));
  readonly busy = signal(false);
  readonly removing = signal<TenantLlmKey | null>(null);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loadUsage();
    this.loadKeys();
  }

  private loadUsage(): void {
    this.usageLoading.set(true);
    this.api.llmUsage().subscribe({
      next: (u) => {
        this.usageLoading.set(false);
        this.usage.set(u);
        this.usageState.set('ok');
        this.usageError.set(null);
      },
      error: (e) => {
        this.usageLoading.set(false);
        this.usage.set(null);
        this.usageState.set(availabilityOf(e));
        this.usageError.set(errorText(e, 'Could not load the LLM usage.'));
      },
    });
  }

  private loadKeys(): void {
    this.keysLoading.set(true);
    this.api.tenantLlmKeys().subscribe({
      next: (k) => {
        this.keysLoading.set(false);
        this.keys.set(k);
        this.keysState.set('ok');
        this.keysError.set(null);
      },
      error: (e) => {
        this.keysLoading.set(false);
        this.keys.set([]);
        this.keysState.set(availabilityOf(e));
        this.keysError.set(errorText(e, 'Could not load the organisation keys.'));
      },
    });
  }

  hasKey(provider: string): boolean {
    return this.keys().some((k) => k.provider === provider);
  }

  store(): void {
    this.submitted.set(true);
    if (this.busy() || this.keyProblem()) return;
    const provider = this.provider();
    this.busy.set(true);
    this.api.storeTenantLlmKey(provider, this.apiKey().trim()).subscribe({
      next: (k) => {
        this.busy.set(false);
        this.apiKey.set('');
        this.submitted.set(false);
        this.notify.success(`${providerLabel(provider)} key stored (${k.hint}).`);
        this.loadKeys();
      },
      error: (e) => {
        this.busy.set(false);
        // The key stays in the box only for a correction; it is never sent anywhere else.
        const msg = failureMessage(e, 'The key was not stored.');
        if (msg) this.notify.error(msg);
      },
    });
  }

  remove(): void {
    const k = this.removing();
    if (!k || this.busy()) return;
    this.busy.set(true);
    this.api.removeTenantLlmKey(k.provider).subscribe({
      next: () => {
        this.busy.set(false);
        this.removing.set(null);
        this.notify.success(`${providerLabel(k.provider)} key removed.`);
        this.loadKeys();
      },
      error: (e) => {
        this.busy.set(false);
        this.removing.set(null);
        const msg = failureMessage(e, 'The key was not removed.');
        if (msg) this.notify.error(msg);
      },
    });
  }
}
