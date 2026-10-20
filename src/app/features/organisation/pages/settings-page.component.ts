import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { ConfigChangeDialogComponent } from '../components/config-change-dialog.component';
import { OrganisationApiService } from '../organisation-api.service';
import { failureMessage } from '../organisation.logic';
import type {
  ConfigOverrides,
  EffectiveConfig,
  EffectiveConfigEntry,
  PendingConfigOverride,
} from '../organisation.types';
import {
  canSetAt,
  groupEntries,
  ownOverride,
  pendingFor,
  scopeLayer,
  sourceLabel,
  valueText,
} from '../settings.logic';
import { accountLabel, accountRefs } from '../terminals.logic';

/**
 * Settings (multi-tenancy Phase 7, T7.2; engine `/config/effective` + `/config/overrides`, ADR-0012
 * addendum). What the organisation — or one of its accounts — runs with, the layer each value came
 * from (engine default → platform → organisation → account) and every layer's value; the
 * organisation's and the account's own values can be set or removed within what the key registry
 * allows. Tighten-only keys are marked and checked before saving; a change that loosens a risk key
 * shows the governed path (reason, `risk.loosen`, second factor, two-person, cooling-off) and may be
 * queued or sent for approval rather than applied. Secrets are write-only. `engine.config` on the
 * scope (organisation-wide, or an account grant for that account).
 */
@Component({
  selector: 'app-org-settings-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    LscCanDirective,
    PageHeaderComponent,
    ConfirmDialogComponent,
    ConfigChangeDialogComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .layers {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        font-size: var(--text-xs);
      }
      .layers li {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 2px 8px;
      }
      .layers li.applied {
        border-color: var(--accent);
      }
      .key {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: var(--text-xs);
        word-break: break-all;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Settings"
        subtitle="What the organisation and each account run with, and where each value comes from."
      >
        <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card">
        <div class="card-body">
          <div class="form-grid">
            <label class="field">
              <span class="label">Settings of</span>
              <select
                class="select"
                name="scope"
                [ngModel]="accountId()"
                (ngModelChange)="selectScope($event)"
              >
                <option [ngValue]="null">The organisation (every account)</option>
                @for (a of accounts(); track a.id) {
                  <option [ngValue]="a.id">{{ accountLabel(a) }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span class="label">Find a setting</span>
              <input
                class="input search"
                name="filter"
                placeholder="Key or description"
                [ngModel]="filter()"
                (ngModelChange)="filter.set($event)"
              />
            </label>
          </div>
          <p class="note">
            A value comes from the most specific layer that sets it: this account, then the
            organisation, then the platform, then the engine default. Tighten-only keys may only be
            set stricter than what they inherit. Loosening a risk setting needs a reason and the
            risk.loosen permission, may need a second person's approval, and waits out a cooling-off
            period.
          </p>
        </div>
      </section>

      @if (pending().length) {
        <section class="card">
          <header class="card-head"><h3>Queued changes</h3></header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>For</th>
                  <th>Change</th>
                  <th>Takes effect</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (p of pending(); track p.id) {
                  <tr>
                    <td>
                      <span class="key">{{ p.key }}</span>
                      <span class="sub">{{ p.reason }}</span>
                    </td>
                    <td>{{ pendingScope(p) }}</td>
                    <td>
                      {{
                        p.remove
                          ? 'Remove (inherit again)'
                          : (p.oldValue ?? '—') + ' → ' + (p.newValue ?? '—')
                      }}
                    </td>
                    <td>{{ when(p.effectiveAt) }}</td>
                    <td class="actions">
                      <button
                        *lscCan="P.EngineConfig"
                        type="button"
                        class="btn btn-sm btn-secondary"
                        (click)="cancelling.set(p)"
                      >
                        Cancel change
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (effective.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }

      @for (g of groups(); track g.name) {
        <section class="card">
          <header class="card-head">
            <h3>{{ g.name }}</h3>
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Value</th>
                  <th>Inherits</th>
                  <th>Rules</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (e of g.entries; track e.key) {
                  <tr>
                    <td>
                      <span class="key">{{ e.key }}</span>
                      <span class="sub">{{ e.description }}</span>
                    </td>
                    <td>
                      {{ valueText(e, e.value) }}
                      <span class="sub">
                        <span
                          class="chip"
                          [class.info]="e.source === 'Tenant' || e.source === 'Account'"
                          >{{ sourceLabel(e.source) }}</span
                        >
                      </span>
                    </td>
                    <td>
                      {{ e.inheritedValue === undefined ? '—' : valueText(e, e.inheritedValue) }}
                    </td>
                    <td>
                      <span class="row">
                        @if (e.tightenOnly) {
                          <span
                            class="chip warn"
                            title="May only be set stricter than the inherited value"
                            >Tighten-only</span
                          >
                        }
                        @if (e.riskSensitive) {
                          <span class="chip bad" title="Loosening it is governed">Risk</span>
                        }
                        @if (e.secret) {
                          <span class="chip" title="Never shown; write a new value to replace it"
                            >Secret</span
                          >
                        }
                        @if (!canSetHere(e)) {
                          <span
                            class="chip"
                            [title]="'Can be set at: ' + e.allowedLayers.join(', ')"
                            >{{ layerHint(e) }}</span
                          >
                        }
                        @for (q of pendingOf(e); track q.id) {
                          <span class="chip info">Queued until {{ when(q.effectiveAt) }}</span>
                        }
                      </span>
                    </td>
                    <td class="actions">
                      <button
                        type="button"
                        class="btn btn-sm btn-secondary"
                        [attr.aria-expanded]="expanded() === e.key"
                        (click)="toggle(e.key)"
                      >
                        Layers
                      </button>
                      @if (canSetHere(e)) {
                        <ng-container *lscCan="P.EngineConfig">
                          <button
                            type="button"
                            class="btn btn-sm btn-secondary"
                            (click)="edit(e, 'set')"
                          >
                            Change
                          </button>
                          @if (hasOwnValue(e)) {
                            <button
                              type="button"
                              class="btn btn-sm btn-danger"
                              (click)="edit(e, 'remove')"
                            >
                              Remove
                            </button>
                          }
                        </ng-container>
                      }
                    </td>
                  </tr>
                  @if (expanded() === e.key) {
                    <tr>
                      <td colspan="5">
                        <ul class="layers">
                          @for (l of e.layers; track $index) {
                            <li [class.applied]="l.applied">
                              {{ sourceLabel(l.layer) }}: {{ valueText(e, l.value) }}
                              {{ l.applied ? '— in effect' : '' }}
                              @if (l.note) {
                                ({{ l.note }})
                              }
                            </li>
                          }
                        </ul>
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        </section>
      } @empty {
        @if (effective.loaded() && !effective.error()) {
          <section class="card">
            <p class="pad muted">
              {{
                filter()
                  ? 'No setting matches.'
                  : 'No setting can be changed by an organisation here.'
              }}
            </p>
          </section>
        }
      }

      <app-config-change-dialog (closed)="editDone($event)" />

      <app-confirm-dialog
        [open]="cancelling() !== null"
        title="Cancel this queued change?"
        [message]="
          (cancelling()?.key ?? '') + ' keeps its current value; the queued change is dropped.'
        "
        confirmLabel="Cancel the change"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="cancelPending()"
        (cancelled)="cancelling.set(null)"
      />
    </div>
  `,
})
export class SettingsPageComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);
  private readonly scope = inject(AccountScopeService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly valueText = valueText;
  protected readonly sourceLabel = sourceLabel;
  protected readonly accountLabel = accountLabel;

  readonly accounts = computed(() => accountRefs(this.scope.accounts()));
  readonly accountId = signal<number | null>(null);
  readonly layer = computed(() => scopeLayer(this.accountId()));
  readonly scopeName = computed(() => {
    const id = this.accountId();
    if (!id) return 'The organisation';
    return accountLabel(
      this.accounts().find((a) => a.id === id),
      id,
    );
  });
  readonly filter = signal('');

  readonly effective = iamResource<EffectiveConfig | null>(
    () => this.api.effectiveConfig(this.accountId()),
    null,
    'Could not load the settings.',
  );
  readonly overrides = iamResource<ConfigOverrides | null>(
    () => this.api.configOverrides(this.accountId()),
    null,
    'Could not load the organisation’s own values.',
  );
  readonly loading = computed(() => this.effective.loading() || this.overrides.loading());

  readonly groups = computed(() =>
    groupEntries(this.effective.value()?.entries ?? [], this.filter()),
  );
  /** Queued changes of the scope shown (the organisation's; with an account, also that account's). */
  readonly pending = computed(() => this.overrides.value()?.pending ?? []);

  readonly expanded = signal<string | null>(null);
  private readonly changer = viewChild(ConfigChangeDialogComponent);
  readonly cancelling = signal<PendingConfigOverride | null>(null);
  readonly busy = signal(false);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.effective.reload();
    this.overrides.reload();
  }

  selectScope(id: number | null): void {
    this.accountId.set(id === null ? null : Number(id));
    this.expanded.set(null);
    this.reload();
  }

  canSetHere(e: EffectiveConfigEntry): boolean {
    return canSetAt(e, this.layer());
  }

  layerHint(e: EffectiveConfigEntry): string {
    if (e.allowedLayers.includes('Account') && !e.allowedLayers.includes('Tenant')) {
      return 'Per account';
    }
    if (e.allowedLayers.includes('Tenant') && !e.allowedLayers.includes('Account')) {
      return 'Organisation-wide';
    }
    return 'Platform only';
  }

  hasOwnValue(e: EffectiveConfigEntry): boolean {
    return !!ownOverride(this.overrides.value(), e.key, this.layer(), this.accountId());
  }

  pendingOf(e: EffectiveConfigEntry): PendingConfigOverride[] {
    return pendingFor(this.overrides.value(), e.key, this.layer(), this.accountId());
  }

  pendingScope(p: PendingConfigOverride): string {
    if (p.scopeType !== 'Account') return 'The organisation';
    return accountLabel(
      this.accounts().find((a) => a.id === p.tradingAccountId),
      p.tradingAccountId,
    );
  }

  toggle(key: string): void {
    this.expanded.update((k) => (k === key ? null : key));
  }

  edit(e: EffectiveConfigEntry, mode: 'set' | 'remove'): void {
    this.changer()?.open({
      entry: e,
      mode,
      layer: this.layer(),
      tradingAccountId: this.accountId(),
      scopeName: this.scopeName(),
    });
  }

  editDone(changed: boolean): void {
    if (changed) this.reload();
  }

  cancelPending(): void {
    const p = this.cancelling();
    if (!p || this.busy()) return;
    this.busy.set(true);
    this.api.cancelPendingOverride(p.id, null).subscribe({
      next: () => {
        this.busy.set(false);
        this.cancelling.set(null);
        this.notify.success(`The queued change of ${p.key} was cancelled.`);
        this.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.cancelling.set(null);
        const msg = failureMessage(e, 'The queued change was not cancelled.');
        if (msg) this.notify.error(msg);
        this.reload();
      },
    });
  }
}
