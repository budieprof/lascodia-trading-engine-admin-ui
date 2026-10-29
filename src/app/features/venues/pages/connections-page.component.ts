import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';

import { VenuesApiService } from '../venues-api.service';
import {
  credentialBody,
  credentialFieldsFor,
  credentialLabel,
  credentialTone,
  healthTone,
  orderTypeName,
  quantityUnitName,
  tifName,
  type CredentialField,
} from '../venues.logic';
import type {
  ExecutionAccount,
  ExecutionAccountHealth,
  ExecutionAdapter,
  ExecutionCredentialStatus,
  ExecutionHealth,
} from '../venues.types';

interface ConnectionsData {
  adapters: ExecutionAdapter[];
  accounts: ExecutionAccount[];
  health: ExecutionHealth;
}

interface CredentialForm {
  account: ExecutionAccount;
  fields: CredentialField[];
  values: Record<string, string>;
  extraName: string;
}

type Pending =
  | { kind: 'verify'; account: ExecutionAccount }
  | { kind: 'revoke'; account: ExecutionAccount }
  | {
      kind: 'status';
      account: ExecutionAccount;
      status: 'Active' | 'Disabled' | 'Suspended';
      reason: string;
    };

const EMPTY: ConnectionsData = {
  adapters: [],
  accounts: [],
  health: { switches: {}, accounts: [], workers: [] },
};

/**
 * Connections (multi-asset WS7 7.7): the organisation's execution accounts at venues (exec-gateway `execution/*`) and
 * the health of their adapters (`execution-console/health`). Credentials are WRITE-ONLY: pasted once, sent to the
 * engine (encrypted at rest, never logged) and never shown again — the page shows the fingerprint and status only, and
 * clears the form the moment it is sent. Verification signs in at the venue (testnet / paper endpoints by default) and
 * the engine REFUSES and erases a key that can withdraw or transfer — the page shows that refusal in the engine's words.
 * Reads `accounts.read`; adding / activating `accounts.manage`; credentials and verification `accounts.connect`.
 * Nothing here places an order.
 */
@Component({
  selector: 'app-connections-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    LscCanDirective,
    ConfirmDialogComponent,
    StatTilesComponent,
    FeatureStateComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      textarea.input {
        min-height: 72px;
        font-family: var(--font-mono, monospace);
        font-size: var(--text-xs);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .problems {
        margin: 2px 0 0;
        padding-left: 16px;
        font-size: var(--text-xs);
        color: var(--loss);
      }
      .switches {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: var(--space-3);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Connections"
        subtitle="Execution accounts at exchanges and brokers, their API credentials (write-only) and adapter health. MT5 accounts need none: their Expert Advisor is the adapter."
      >
        <a class="btn btn-secondary" routerLink="/connections/drift">Reconciliation drift</a>
        <button
          *lscCan="'accounts.manage'"
          type="button"
          class="btn btn-secondary"
          (click)="startCreate()"
        >
          Add account
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="data.reload()"
          [disabled]="data.loading()"
        >
          {{ data.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (data.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }

      <app-stat-tiles [tiles]="tiles()" label="Connections summary" />

      <section class="card" aria-label="Execution switches">
        <header class="card-head"><h3>Execution switches (platform)</h3></header>
        <div class="switches">
          @for (s of switchList(); track s.key) {
            <span
              class="chip"
              [class.ok]="s.value === 'true' || s.value === 'act'"
              title="{{ s.key }}"
              >{{ s.short }}: {{ s.value }}</span
            >
          } @empty {
            <span class="muted small">No Execution:* switch is stored.</span>
          }
        </div>
        <p class="note">
          {{ switchNote() }} The switches are platform settings (engine config), not this page's.
        </p>
      </section>

      @if (creating(); as c) {
        <section class="card" aria-label="Add an execution account">
          <header class="card-head"><h3>Add an execution account</h3></header>
          <form class="card-body" (ngSubmit)="create()">
            <p class="note">
              The account is created DISABLED. Store a credential, verify it, then activate it.
              Paper uses the venue's testnet / paper endpoint; Live trades real money.
            </p>
            <div class="form-grid">
              <label class="field">
                <span class="label">Name</span>
                <input class="input" name="c-name" maxlength="128" [(ngModel)]="c.name" />
              </label>
              <label class="field">
                <span class="label">Adapter</span>
                <select class="select" name="c-kind" [(ngModel)]="c.adapterKind">
                  <option value="">Choose…</option>
                  @for (a of venueAdapters(); track a.kind) {
                    <option [value]="a.kind">{{ a.kind }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="label">Venue (e.g. binance, cme)</span>
                <input class="input" name="c-venue" maxlength="64" [(ngModel)]="c.venue" />
              </label>
              <label class="field">
                <span class="label">Venue account id (optional)</span>
                <input
                  class="input"
                  name="c-ext"
                  maxlength="128"
                  [(ngModel)]="c.externalAccountId"
                />
              </label>
              <label class="field">
                <span class="label">Linked trading account id (optional)</span>
                <input
                  class="input"
                  type="number"
                  name="c-ta"
                  min="1"
                  [(ngModel)]="c.tradingAccountId"
                />
              </label>
              <label class="field">
                <span class="label">Mode</span>
                <select class="select" name="c-mode" [(ngModel)]="c.mode">
                  <option value="Paper">Paper (testnet)</option>
                  <option value="Live">Live</option>
                </select>
              </label>
              <label class="field">
                <span class="label">Account currency (optional)</span>
                <input class="input" name="c-ccy" maxlength="8" [(ngModel)]="c.currency" />
              </label>
            </div>
            @if (c.mode === 'Live') {
              <p class="note warn">
                Live: once activated, orders the engine routes here trade real money.
              </p>
            }
            <div class="actions-row">
              <button
                type="button"
                class="btn btn-secondary"
                data-autofocus
                (click)="creating.set(null)"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || !c.name.trim() || !c.adapterKind || !c.venue.trim()"
              >
                {{ busy() ? 'Adding…' : 'Add (disabled)' }}
              </button>
            </div>
          </form>
        </section>
      }

      @if (credential(); as f) {
        <section class="card" aria-label="Store a credential">
          <header class="card-head">
            <h3>Credential · {{ f.account.name }} ({{ f.account.adapterKind }})</h3>
          </header>
          <form class="card-body" (ngSubmit)="saveCredential()" autocomplete="off">
            <p class="note">
              Write-only: the values go to the engine once, are stored encrypted and are never shown
              again — only a fingerprint is. Use a <strong>trade-only</strong> key: a key that can
              withdraw or transfer is refused and erased at verification.
            </p>
            <div class="form-grid">
              @for (fld of f.fields; track fld.name) {
                <label class="field">
                  <span class="label"
                    >{{ fld.label }}{{ fld.optional ? ' (optional)' : '' }} ·
                    <code>{{ fld.name }}</code></span
                  >
                  @if (fld.multiline) {
                    <textarea
                      class="input"
                      [name]="'cred-' + fld.name"
                      spellcheck="false"
                      [(ngModel)]="f.values[fld.name]"
                    ></textarea>
                  } @else {
                    <input
                      class="input"
                      type="password"
                      [name]="'cred-' + fld.name"
                      autocomplete="new-password"
                      [(ngModel)]="f.values[fld.name]"
                    />
                  }
                </label>
              }
              <label class="field">
                <span class="label">Add another field (name)</span>
                <input
                  class="input"
                  name="cred-extra"
                  maxlength="64"
                  [(ngModel)]="f.extraName"
                  (keydown.enter)="$event.preventDefault(); addField()"
                />
              </label>
            </div>
            <div class="actions-row">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="addField()"
                [disabled]="!f.extraName.trim()"
              >
                Add field
              </button>
              <span class="spacer"></span>
              <button
                type="button"
                class="btn btn-secondary"
                data-autofocus
                (click)="cancelCredential()"
              >
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busy()">
                {{ busy() ? 'Saving…' : 'Save credential' }}
              </button>
            </div>
          </form>
        </section>
      }

      @if (lastResult(); as r) {
        <section class="card" aria-label="Last credential result" role="status">
          <div class="card-body">
            <p>
              <span class="chip" [class]="credTone(r.status)">{{ credLabel(r.status) }}</span>
              @if (r.keyFingerprint) {
                fingerprint <code>{{ r.keyFingerprint }}</code>
              }
              @if (r.observedPermissions) {
                · permissions <code>{{ r.observedPermissions }}</code>
              }
            </p>
            @if (r.reason) {
              <p
                class="note"
                [class.warn]="r.status === 'RefusedWithdrawalRights' || r.status === 'Rejected'"
                data-testid="credential-reason"
              >
                {{ r.reason }}
              </p>
            }
          </div>
        </section>
      }

      <section class="card" aria-label="Execution accounts">
        <header class="card-head"><h3>Execution accounts</h3></header>
        @if (rows().length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Adapter</th>
                  <th>State</th>
                  <th>Credential</th>
                  <th>Health</th>
                  <th>Outbox 24 h</th>
                  <th>Last fill</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.account.id) {
                  <tr>
                    <td>
                      {{ r.account.name }}
                      <span class="sub"
                        >#{{ r.account.id
                        }}{{ r.account.externalAccountId ? ' · ' + r.account.externalAccountId : ''
                        }}{{
                          r.account.tradingAccountId
                            ? ' · trading account ' + r.account.tradingAccountId
                            : ''
                        }}</span
                      >
                    </td>
                    <td class="small">
                      <code>{{ r.account.adapterKind }}</code
                      ><span class="sub">{{ r.account.venue }}</span>
                    </td>
                    <td>
                      <span
                        class="chip"
                        [class.ok]="r.account.status === 'Active'"
                        [class.warn]="r.account.status === 'Suspended'"
                        >{{ r.account.status }}</span
                      >
                      <span class="sub">{{ r.account.mode }}</span>
                    </td>
                    <td class="small">
                      <span class="chip" [class]="credTone(r.account.credential?.status)">{{
                        credLabel(r.account.credential?.status)
                      }}</span>
                      @if (r.account.credential; as cred) {
                        @if (cred.keyFingerprint) {
                          <span class="sub"
                            ><code>{{ cred.keyFingerprint }}</code></span
                          >
                        }
                        @if (cred.reason) {
                          <span class="sub">{{ cred.reason }}</span>
                        }
                      }
                    </td>
                    <td class="small">
                      @if (r.health; as h) {
                        <span class="chip" [class]="hTone(h.health)">{{ h.health }}</span>
                        @if (h.problems.length) {
                          <ul class="problems">
                            @for (p of h.problems; track p) {
                              <li>{{ p }}</li>
                            }
                          </ul>
                        }
                        @if (h.lastConnectResult) {
                          <span class="sub"
                            >{{ h.lastConnectResult }} · {{ when(h.lastConnectedAtUtc) }}</span
                          >
                        }
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="small">
                      @if (r.health; as h) {
                        <div class="chips">
                          @for (k of outboxKeys(h); track k) {
                            <span class="chip">{{ k }} {{ h.instructions24h[k] }}</span>
                          } @empty {
                            <span class="muted">none</span>
                          }
                        </div>
                        @if (h.lastFailure) {
                          <span class="sub">last failure: {{ h.lastFailure }}</span>
                        }
                      }
                    </td>
                    <td class="small">
                      {{ when(r.health?.lastFillAtUtc)
                      }}<span class="sub">{{ r.health?.fills24h ?? 0 }} in 24 h</span>
                    </td>
                    <td class="actions">
                      <button
                        *lscCan="'accounts.connect'"
                        type="button"
                        class="btn btn-sm btn-secondary"
                        (click)="startCredential(r.account)"
                      >
                        {{ r.account.credential ? 'Replace key' : 'Add key' }}
                      </button>
                      @if (hasStoredKey(r.account)) {
                        <button
                          *lscCan="'accounts.connect'"
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="ask({ kind: 'verify', account: r.account })"
                        >
                          Verify
                        </button>
                        <button
                          *lscCan="'accounts.connect'"
                          type="button"
                          class="btn btn-sm btn-danger"
                          (click)="ask({ kind: 'revoke', account: r.account })"
                        >
                          Revoke
                        </button>
                      }
                      @if (r.account.status !== 'Active') {
                        <button
                          *lscCan="'accounts.manage'"
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="
                            ask({
                              kind: 'status',
                              account: r.account,
                              status: 'Active',
                              reason: '',
                            })
                          "
                        >
                          Activate
                        </button>
                      } @else {
                        <button
                          *lscCan="'accounts.manage'"
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="
                            ask({
                              kind: 'status',
                              account: r.account,
                              status: 'Disabled',
                              reason: '',
                            })
                          "
                        >
                          Disable
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (data.loaded() && !data.error()) {
          <div class="card-body">
            <app-feature-state
              title="Trading at exchanges and brokers"
              summary="An execution account is an exchange or broker login (crypto, futures, equities) that the engine places orders on directly through one of the adapters below. MT5 accounts trade through their Expert Advisor and are not listed here."
              kind="waiting"
              stateLabel="No account connected"
              [requirements]="venueRequirements()"
              [links]="[
                { label: 'Multi-asset set-up guide', route: '/docs/multi-asset-setup' },
                { label: 'Connections guide', route: '/docs/connections-guide' },
              ]"
            />
          </div>
        }
      </section>

      <section class="card" aria-label="Adapters">
        <header class="card-head"><h3>Adapters in this build</h3></header>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Entries</th>
                <th>Order types</th>
                <th>Time in force</th>
                <th>Stops at venue</th>
                <th>Positions</th>
                <th>Unit</th>
              </tr>
            </thead>
            <tbody>
              @for (a of data.value().adapters; track a.kind) {
                <tr>
                  <td>
                    <code>{{ a.kind }}</code
                    ><span class="sub">{{
                      a.requiresCredential ? 'needs a credential' : 'no credential'
                    }}</span>
                  </td>
                  <td class="small">{{ a.capabilities.entryModel }}</td>
                  <td class="small">{{ names(a.capabilities.orderTypes, 'type') }}</td>
                  <td class="small">{{ names(a.capabilities.timeInForce, 'tif') }}</td>
                  <td class="small">{{ a.capabilities.positionStops ? 'yes' : 'engine-held' }}</td>
                  <td class="small">{{ a.capabilities.positionModel }}</td>
                  <td class="small">{{ unit(a.capabilities.quantityUnit) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="card" aria-label="Execution workers">
        <header class="card-head"><h3>Execution workers (this engine process)</h3></header>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Running</th>
                <th>Last success</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              @for (w of data.value().health.workers; track w.workerName) {
                <tr>
                  <td>
                    <code>{{ w.workerName }}</code>
                  </td>
                  <td>
                    <span class="chip" [class.ok]="w.isRunning">{{
                      w.isRunning ? 'yes' : 'no'
                    }}</span>
                  </td>
                  <td class="small">{{ when(w.lastSuccessAt) }}</td>
                  <td class="small">
                    {{ w.lastErrorMessage ?? '—'
                    }}{{ w.consecutiveFailures ? ' (' + w.consecutiveFailures + ' in a row)' : '' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <app-confirm-dialog
        [open]="!!pending()"
        [title]="confirmTitle()"
        [message]="confirmMessage()"
        [confirmLabel]="confirmLabel()"
        [confirmVariant]="confirmVariant()"
        [loading]="busy()"
        (confirm)="runPending()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
})
export class ConnectionsPageComponent {
  private readonly api = inject(VenuesApiService);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);

  protected readonly when = when;
  protected readonly credTone = credentialTone;
  protected readonly credLabel = credentialLabel;
  protected readonly hTone = healthTone;

  readonly data = iamResource<ConnectionsData>(
    () =>
      forkJoin({
        adapters: this.api.adapters(),
        accounts: this.api.accounts(),
        health: this.api.health(),
      }),
    EMPTY,
    'Could not load the connections.',
  );
  readonly busy = signal(false);
  readonly creating = signal<{
    name: string;
    adapterKind: string;
    venue: string;
    externalAccountId: string;
    tradingAccountId: number | null;
    mode: 'Paper' | 'Live';
    currency: string;
  } | null>(null);
  readonly credential = signal<CredentialForm | null>(null);
  readonly lastResult = signal<ExecutionCredentialStatus | null>(null);
  readonly pending = signal<Pending | null>(null);

  readonly venueAdapters = computed(() =>
    this.data.value().adapters.filter((a) => a.kind !== 'mt5-ea'),
  );
  readonly rows = computed(() => {
    const d = this.data.value();
    const byId = new Map<number, ExecutionAccountHealth>(
      d.health.accounts.map((h) => [h.executionAccountId, h]),
    );
    return d.accounts.map((account) => ({ account, health: byId.get(account.id) ?? null }));
  });
  readonly switchList = computed(() =>
    Object.entries(this.data.value().health.switches).map(([key, value]) => ({
      key,
      value,
      short: key.replace(/^Execution:/, '').replace(/:Enabled$/, ''),
    })),
  );

  private sw(key: string): string | null {
    return this.data.value().health.switches[key] ?? null;
  }
  readonly switchNote = computed(() => {
    const router = this.sw('Execution:Router:Enabled') === 'true';
    const entries = this.sw('Execution:Entries:Enabled') === 'true';
    if (router && entries)
      return 'Routing and venue entries are on: an approved signal for an instrument with an execution account is placed at its venue.';
    return `${router ? 'Routing is on' : 'Nothing is routed to a venue (Execution:Router:Enabled is off)'}; ${
      entries
        ? 'venue entries are on.'
        : 'no venue entry is placed (Execution:Entries:Enabled is off).'
    }`;
  });
  readonly venueRequirements = computed<FeatureRequirement[]>(() => {
    const router = this.sw('Execution:Router:Enabled') === 'true';
    const entries = this.sw('Execution:Entries:Enabled') === 'true';
    return [
      {
        label: 'Execution:Router:Enabled',
        ok: router,
        detail: router ? 'On.' : 'Off — nothing is routed to a venue.',
        route: '/engine-config',
        query: { search: 'Execution:' },
      },
      {
        label: 'Execution:Entries:Enabled',
        ok: entries,
        detail: entries ? 'On.' : 'Off — no venue entry is placed.',
        route: '/engine-config',
        query: { search: 'Execution:' },
      },
      {
        label: 'An execution account with an API key',
        ok: false,
        detail:
          'None yet — use Add account, then store its key (write-only; withdrawal rights are refused).',
      },
    ];
  });
  readonly tiles = computed<StatTile[]>(() => {
    const d = this.data.value();
    const on = Object.values(d.health.switches).filter((v) => v === 'true' || v === 'act').length;
    const workers = d.health.workers ?? [];
    const workersOk = workers.filter((w) => w.isRunning).length;
    const workersAll = workers.length;
    return [
      {
        label: 'Execution accounts',
        value: this.data.loaded() ? String(d.accounts.length) : '…',
        caption: d.accounts.length
          ? 'at exchanges and brokers'
          : 'none connected; MT5 trades through its EA',
      },
      {
        label: 'Venue adapters in this build',
        value: String(this.venueAdapters().length),
        caption: 'exchanges and brokers the engine can talk to',
      },
      {
        label: 'Execution switches on',
        value: `${on} of ${Object.keys(d.health.switches).length}`,
        caption: 'platform settings',
        route: '/engine-config',
      },
      {
        label: 'Execution workers running',
        value: workersAll ? `${workersOk} of ${workersAll}` : '—',
        caption: 'in this engine process',
      },
    ];
  });

  readonly confirmTitle = computed(() => {
    const p = this.pending();
    if (!p) return '';
    return p.kind === 'verify'
      ? `Verify ${p.account.name}`
      : p.kind === 'revoke'
        ? `Revoke the key of ${p.account.name}`
        : `${p.status === 'Active' ? 'Activate' : p.status === 'Disabled' ? 'Disable' : 'Suspend'} ${p.account.name}`;
  });
  readonly confirmMessage = computed(() => {
    const p = this.pending();
    if (!p) return '';
    switch (p.kind) {
      case 'verify':
        return `The engine signs in at ${p.account.venue} (${p.account.mode === 'Live' ? 'LIVE endpoint' : 'testnet / paper endpoint'}) with the stored key and records what it may do. A key with withdrawal or transfer rights is refused and erased.`;
      case 'revoke':
        return 'The stored key is erased and the account is disabled. Nothing more is sent to the venue for it.';
      default:
        return p.status === 'Active'
          ? `Once active (and with the platform router on), the engine routes ${p.account.name}'s orders to ${p.account.venue}${p.account.mode === 'Live' ? ' — real money' : ''}. The engine refuses activation without a verified key.`
          : 'The engine stops routing to this account.';
    }
  });
  readonly confirmVariant = computed<'primary' | 'destructive'>(() => {
    const p = this.pending();
    return p?.kind === 'revoke' || (p?.kind === 'status' && p.status !== 'Active')
      ? 'destructive'
      : 'primary';
  });
  readonly confirmLabel = computed(() => {
    const p = this.pending();
    return !p
      ? 'Confirm'
      : p.kind === 'verify'
        ? 'Verify'
        : p.kind === 'revoke'
          ? 'Revoke'
          : p.status === 'Active'
            ? 'Activate'
            : 'Disable';
  });

  constructor() {
    if (this.auth.hasPermission(Permission.AccountsRead)) this.data.reload();
  }

  /** A key is stored (refused and revoked keys were erased by the engine: nothing to verify or revoke). */
  hasStoredKey(a: ExecutionAccount): boolean {
    const s = a.credential?.status;
    return s === 'Unverified' || s === 'Verified' || s === 'Rejected';
  }

  outboxKeys(h: ExecutionAccountHealth): string[] {
    return Object.keys(h.instructions24h ?? {}).sort();
  }

  names(values: (string | number)[], kind: 'type' | 'tif'): string {
    const list = (values ?? []).map((v) =>
      (kind === 'type' ? orderTypeName(v) : tifName(v)).toString(),
    );
    return list.length ? list.join(', ') : '—';
  }

  unit(v: string | number): string {
    return quantityUnitName(v);
  }

  startCreate(): void {
    this.credential.set(null);
    this.creating.set({
      name: '',
      adapterKind: '',
      venue: '',
      externalAccountId: '',
      tradingAccountId: null,
      mode: 'Paper',
      currency: '',
    });
  }

  create(): void {
    const c = this.creating();
    if (!c || this.busy()) return;
    this.busy.set(true);
    this.api
      .createAccount({
        name: c.name.trim(),
        adapterKind: c.adapterKind,
        venue: c.venue.trim(),
        externalAccountId: c.externalAccountId.trim() || null,
        tradingAccountId: c.tradingAccountId && c.tradingAccountId > 0 ? c.tradingAccountId : null,
        mode: c.mode,
        currency: c.currency.trim() || null,
      })
      .subscribe({
        next: (a) => {
          this.busy.set(false);
          this.creating.set(null);
          this.notify.success(`${a.name} added (disabled).`);
          this.data.reload();
        },
        error: (e) => {
          this.busy.set(false);
          if (reportable(e)) this.notify.error(errorText(e, 'The account was not added.'));
        },
      });
  }

  startCredential(account: ExecutionAccount): void {
    this.creating.set(null);
    this.lastResult.set(null);
    const fields = credentialFieldsFor(account.adapterKind);
    this.credential.set({
      account,
      fields,
      values: Object.fromEntries(fields.map((f) => [f.name, ''])),
      extraName: '',
    });
  }

  addField(): void {
    this.credential.update((f) => {
      if (!f) return f;
      const name = f.extraName.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || f.fields.some((x) => x.name === name))
        return { ...f, extraName: '' };
      return {
        ...f,
        fields: [...f.fields, { name, label: name }],
        values: { ...f.values, [name]: '' },
        extraName: '',
      };
    });
  }

  cancelCredential(): void {
    this.credential.set(null); // the typed values go with the form
  }

  saveCredential(): void {
    const f = this.credential();
    if (!f || this.busy()) return;
    const body = credentialBody(f.fields, f.values);
    if (!body) {
      this.notify.error('Fill every field that is not optional.');
      return;
    }
    // The secret leaves the page now: the form (and its values) is dropped before the answer arrives.
    this.credential.set(null);
    this.busy.set(true);
    this.api.saveCredential(f.account.id, body).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.lastResult.set(r);
        this.notify.success('Credential stored. Verify it next.');
        this.data.reload();
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The credential was not stored.'));
      },
    });
  }

  ask(p: Pending): void {
    this.pending.set(p);
  }

  runPending(): void {
    const p = this.pending();
    if (!p || this.busy()) return;
    this.busy.set(true);
    const done = () => {
      this.busy.set(false);
      this.pending.set(null);
      this.data.reload();
    };
    const fail = (e: unknown, msg: string) => {
      this.busy.set(false);
      this.pending.set(null);
      if (reportable(e)) this.notify.error(errorText(e, msg));
    };
    switch (p.kind) {
      case 'verify':
        this.api.verify(p.account.id).subscribe({
          next: (r) => {
            this.lastResult.set(r);
            if (r.status === 'Verified') this.notify.success(`${p.account.name}: key verified.`);
            else this.notify.error(r.reason ?? `${p.account.name}: ${credentialLabel(r.status)}.`);
            done();
          },
          error: (e) => fail(e, 'Verification failed.'),
        });
        break;
      case 'revoke':
        this.api.revokeCredential(p.account.id).subscribe({
          next: () => {
            this.notify.success(`${p.account.name}: key erased, account disabled.`);
            done();
          },
          error: (e) => fail(e, 'The key was not revoked.'),
        });
        break;
      case 'status':
        this.api.setStatus(p.account.id, p.status, p.reason.trim() || null).subscribe({
          next: (a) => {
            this.notify.success(`${a.name} is ${a.status}.`);
            done();
          },
          error: (e) => fail(e, 'The status was not changed.'),
        });
        break;
    }
  }
}
