import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { catchError, forkJoin, of } from 'rxjs';

import type { TradingAccountDto } from '@core/api/api.types';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { NotificationService } from '@core/notifications/notification.service';

import { StrategyExecutionApiService } from '../api/strategy-execution-api.service';
import { MAX_LOT_MULTIPLIER } from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import {
  ENVIRONMENT_HINTS,
  ENVIRONMENT_LABELS,
  confirmationTargets,
  deliveryEffect,
  describeAccount,
  diffBindings,
  formatMultiplier,
  isLiveMoney,
  requiresTypedConfirmation,
  toBindingInputs,
  toBindingRows,
  unconfirmedLiveChanges,
  validateBindingSet,
  validateMultiplier,
  widensToFleet,
  type AccountEnvironment,
  type BindingChange,
  type BindingRow,
} from './execution.model';
import { TypedConfirmDialogComponent } from './typed-confirm-dialog.component';

type Pending =
  | { kind: 'bind'; row: BindingRow }
  | { kind: 'enable'; row: BindingRow }
  | { kind: 'widen' };

interface AccountOption {
  id: number;
  label: string;
  environment: AccountEnvironment;
}

/**
 * Edits a strategy's account bindings (ADR-0027 DEC-05): which accounts it may trade on, each
 * account's lot multiplier and whether delivery to it is enabled. Save replaces the whole set.
 *
 * Live-capital gates:
 * - binding a REAL (or unverifiable) account, and enabling one, opens a dialog where the operator
 *   types the account number (or name) — the change is not even staged without it;
 * - saving re-checks that every new / newly-enabled live-money binding was confirmed in this
 *   session and refuses otherwise;
 * - removing the last binding of a non-script strategy (which widens it to the whole fleet)
 *   needs its own typed confirmation.
 */
@Component({
  selector: 'app-account-bindings-editor',
  standalone: true,
  imports: [TypedConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" [attr.aria-labelledby]="'bindings-title-' + strategyId()">
      <header class="card-head">
        <div>
          <h3 class="card-title" [id]="'bindings-title-' + strategyId()">Account bindings</h3>
          <p class="card-sub">
            Where this strategy may trade live, and how its lot size scales per account.
          </p>
        </div>
        @if (!loading()) {
          <button type="button" class="btn ghost" (click)="reload()" [disabled]="saving()">
            Reload
          </button>
        }
      </header>

      @if (loading()) {
        <p class="muted" role="status">Loading bindings…</p>
      } @else if (loadError()) {
        <div class="error" role="alert">
          <span>{{ loadError() }}</span>
          <button type="button" class="btn ghost" (click)="reload()">Retry</button>
        </div>
      } @else {
        @if (accountsError()) {
          <p class="warn" role="status">
            {{ accountsError() }} Every binding is treated as a REAL account until the list loads.
          </p>
        }

        @if (rows().length === 0) {
          <p class="empty">No account is bound.</p>
        } @else {
          <div class="table-wrap">
            <table>
              <caption class="sr-only">
                Bound accounts
              </caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Type</th>
                  <th scope="col" class="num">Lot multiplier</th>
                  <th scope="col">Delivery</th>
                  <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.tradingAccountId) {
                  <tr [class.changed]="rowChanged(row)" [class.live]="isLive(row.environment)">
                    <th scope="row">
                      <span class="acct-name">{{ row.accountName }}</span>
                      <span class="acct-meta">{{ accountMeta(row) }}</span>
                      @if (row.saved === null) {
                        <span class="tag new">new</span>
                      } @else if (rowChanged(row)) {
                        <span class="tag">changed</span>
                      }
                    </th>
                    <td>
                      <span
                        class="env"
                        [attr.data-env]="row.environment"
                        [attr.title]="envHint(row.environment)"
                        >{{ envLabel(row.environment) }}</span
                      >
                    </td>
                    <td class="num">
                      <label class="sr-only" [attr.for]="'mult-' + row.tradingAccountId"
                        >Lot multiplier for {{ row.accountName }}</label
                      >
                      <input
                        class="mult"
                        type="number"
                        min="0.01"
                        [attr.max]="maxMultiplier"
                        step="0.1"
                        inputmode="decimal"
                        [id]="'mult-' + row.tradingAccountId"
                        [value]="row.lotMultiplier"
                        [attr.aria-invalid]="!!multiplierError(row)"
                        (change)="setMultiplier(row, $any($event.target).value)"
                      />
                      @if (multiplierError(row); as e) {
                        <span class="field-error">{{ e }}</span>
                      }
                    </td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        class="switch"
                        [attr.aria-checked]="row.isEnabled"
                        [attr.aria-label]="'Deliver signals to ' + row.accountName"
                        (click)="toggleEnabled(row)"
                      >
                        <span class="knob" aria-hidden="true"></span>
                        <span class="switch-text">{{ row.isEnabled ? 'Enabled' : 'Paused' }}</span>
                      </button>
                    </td>
                    <td class="actions">
                      <button
                        type="button"
                        class="btn ghost danger-text"
                        [attr.aria-label]="'Remove ' + row.accountName"
                        (click)="remove(row)"
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

        <form class="add" (submit)="$event.preventDefault(); addBinding()">
          <label class="add-field grow">
            <span>Add account</span>
            <select
              [value]="addAccountId() ?? ''"
              (change)="onAddAccountChange($any($event.target).value)"
              [disabled]="availableAccounts().length === 0"
            >
              <option value="">
                {{ availableAccounts().length === 0 ? 'No unbound account' : 'Choose an account…' }}
              </option>
              @if (liveOptions().length > 0) {
                <optgroup label="REAL accounts — real money">
                  @for (o of liveOptions(); track o.id) {
                    <option [value]="o.id">{{ o.label }}</option>
                  }
                </optgroup>
              }
              @if (otherOptions().length > 0) {
                <optgroup label="Demo, contest and paper accounts">
                  @for (o of otherOptions(); track o.id) {
                    <option [value]="o.id">{{ o.label }}</option>
                  }
                </optgroup>
              }
            </select>
          </label>
          <label class="add-field">
            <span>Lot multiplier</span>
            <input
              type="number"
              min="0.01"
              [attr.max]="maxMultiplier"
              step="0.1"
              inputmode="decimal"
              [value]="addMultiplier()"
              [attr.aria-invalid]="!!addMultiplierError()"
              (input)="addMultiplier.set($any($event.target).value)"
            />
          </label>
          <label class="add-check">
            <input
              type="checkbox"
              [checked]="addEnabled()"
              (change)="addEnabled.set($any($event.target).checked)"
            />
            <span>Enabled</span>
          </label>
          <button type="submit" class="btn" [disabled]="!canAdd()">Add</button>
        </form>
        @if (addMultiplierError(); as e) {
          <p class="field-error">{{ e }}</p>
        }
        @if (selectedAddIsLive()) {
          <p class="warn">
            This is a real-money account. Adding it asks you to type its account number.
          </p>
        }

        <div class="effect" [attr.data-real]="effect().touchesRealMoney" aria-live="polite">
          <span class="effect-label">{{ dirty() ? 'After saving' : 'Now' }}</span>
          <span>{{ effect().summary }}</span>
        </div>

        @if (dirty()) {
          <div class="pending">
            <p class="pending-title">Unsaved changes</p>
            <ul>
              @for (c of changes(); track $index) {
                <li>{{ describeChange(c) }}</li>
              }
            </ul>
          </div>
        }

        @if (saveError()) {
          <p class="error" role="alert">{{ saveError() }}</p>
        }

        <div class="save-row">
          <button
            type="button"
            class="btn ghost"
            [disabled]="!dirty() || saving()"
            (click)="discard()"
          >
            Discard
          </button>
          <button
            type="button"
            class="btn primary"
            [disabled]="!dirty() || saving() || hasErrors()"
            (click)="save()"
          >
            {{ saving() ? 'Saving…' : 'Save bindings' }}
          </button>
        </div>
      }
    </section>

    <app-typed-confirm-dialog
      [open]="pending() !== null"
      [title]="dialogTitle()"
      [message]="dialogMessage()"
      [details]="dialogDetails()"
      [expected]="dialogExpected()"
      [promptLabel]="dialogPrompt()"
      [confirmLabel]="dialogConfirmLabel()"
      [busy]="saving()"
      tone="danger"
      (confirmed)="onConfirmed()"
      (cancelled)="pending.set(null)"
    />
  `,
  styles: [
    `
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
      }
      .card-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .card-sub {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        min-width: 620px;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: middle;
      }
      thead th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
      }
      tbody th {
        font-weight: var(--font-regular);
      }
      tr.live {
        background: rgba(255, 59, 48, 0.04);
      }
      tr.changed {
        box-shadow: inset 3px 0 0 var(--accent);
      }
      .acct-name {
        display: block;
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .acct-meta {
        display: block;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .tag {
        display: inline-block;
        margin-top: 2px;
        padding: 0 6px;
        border-radius: var(--radius-full);
        font-size: 10px;
        border: 1px solid var(--accent);
        color: var(--accent);
      }
      .env {
        display: inline-block;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-bold);
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .env[data-env='REAL'] {
        background: var(--loss);
        color: #fff;
      }
      .env[data-env='UNKNOWN'] {
        border: 1px solid var(--loss);
        color: var(--loss);
        background: transparent;
      }
      .num {
        text-align: right;
      }
      .mult {
        width: 88px;
        height: 32px;
        padding: 0 var(--space-2);
        text-align: right;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
      }
      .mult[aria-invalid='true'] {
        border-color: var(--loss);
      }
      .field-error {
        display: block;
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--loss);
      }
      .switch {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        border: none;
        background: none;
        padding: 0;
        cursor: pointer;
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      .knob {
        width: 32px;
        height: 18px;
        border-radius: 9px;
        background: var(--bg-tertiary);
        position: relative;
        transition: background var(--dur-fast);
      }
      .knob::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #fff;
        box-shadow: var(--shadow-sm);
        transition: transform var(--dur-fast);
      }
      .switch[aria-checked='true'] .knob {
        background: var(--profit);
      }
      .switch[aria-checked='true'] .knob::after {
        transform: translateX(14px);
      }
      .switch:focus-visible,
      .btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .actions {
        text-align: right;
      }
      .add {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: var(--space-3);
      }
      .add-field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .add-field.grow {
        flex: 1 1 260px;
      }
      .add-field select,
      .add-field input {
        height: 34px;
        padding: 0 var(--space-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      .add-field input {
        width: 100px;
      }
      .add-check {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        height: 34px;
        font-size: var(--text-sm);
      }
      .effect {
        display: flex;
        gap: var(--space-3);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .effect[data-real='true'] {
        border-color: rgba(255, 59, 48, 0.4);
      }
      .effect-label {
        flex-shrink: 0;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        padding-top: 1px;
      }
      .pending {
        font-size: var(--text-sm);
      }
      .pending-title {
        margin: 0 0 var(--space-1);
        font-weight: var(--font-semibold);
      }
      .pending ul {
        margin: 0;
        padding-left: var(--space-5);
        color: var(--text-secondary);
      }
      .save-row {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
      .btn {
        height: 34px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .btn.ghost {
        background: transparent;
      }
      .btn.danger-text {
        color: var(--loss);
      }
      .btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .muted,
      .empty {
        margin: 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .warn {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 149, 0, 0.1);
        font-size: var(--text-sm);
      }
      .error {
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class AccountBindingsEditorComponent {
  private readonly api = inject(StrategyExecutionApiService);
  private readonly accountsApi = inject(TradingAccountsService);
  private readonly notifications = inject(NotificationService);

  readonly strategyId = input.required<number>();
  readonly isScript = input(false);
  readonly symbol = input<string | null>(null);
  readonly strategyName = input<string | null>(null);

  /** After a successful save (the host may refresh the strategy). */
  readonly saved = output<void>();

  readonly maxMultiplier = MAX_LOT_MULTIPLIER;

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly accountsError = signal<string | null>(null);
  readonly accounts = signal<TradingAccountDto[]>([]);
  readonly savedRows = signal<BindingRow[]>([]);
  readonly rows = signal<BindingRow[]>([]);
  /** Live-money accounts the operator confirmed by typing, in this edit session. */
  readonly confirmedIds = signal<ReadonlySet<number>>(new Set());
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly pending = signal<Pending | null>(null);

  readonly addAccountId = signal<number | null>(null);
  readonly addMultiplier = signal<number | string>(1);
  readonly addEnabled = signal(true);

  readonly changes = computed(() => diffBindings(this.savedRows(), this.rows()));
  readonly dirty = computed(() => this.changes().length > 0);
  readonly hasErrors = computed(() => validateBindingSet(this.rows()).length > 0);
  readonly effect = computed(() => deliveryEffect(this.rows(), this.isScript(), this.symbol()));

  readonly availableAccounts = computed<AccountOption[]>(() => {
    const bound = new Set(this.rows().map((r) => r.tradingAccountId));
    return this.accounts()
      .filter((a) => !bound.has(a.id))
      .map((a) => {
        const d = describeAccount(a.id, a);
        const bits = [d.accountNumber ? `#${d.accountNumber}` : null, d.brokerName, d.currency]
          .filter(Boolean)
          .join(' · ');
        return {
          id: a.id,
          environment: d.environment,
          label: `${ENVIRONMENT_LABELS[d.environment]} — ${d.accountName}${bits ? ` (${bits})` : ''}`,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  });
  readonly liveOptions = computed(() =>
    this.availableAccounts().filter((o) => isLiveMoney(o.environment)),
  );
  readonly otherOptions = computed(() =>
    this.availableAccounts().filter((o) => !isLiveMoney(o.environment)),
  );

  readonly addMultiplierError = computed(() => validateMultiplier(this.addMultiplier()));
  readonly canAdd = computed(
    () => this.addAccountId() !== null && !this.addMultiplierError() && !this.saving(),
  );
  readonly selectedAddIsLive = computed(() => {
    const id = this.addAccountId();
    const o = this.availableAccounts().find((a) => a.id === id);
    return !!o && isLiveMoney(o.environment);
  });

  // ── Dialog wording ────────────────────────────────────────────────────────

  readonly dialogTitle = computed(() => {
    const p = this.pending();
    if (!p) return '';
    if (p.kind === 'widen') return 'Let this strategy trade on every account?';
    return p.kind === 'bind' ? 'Bind a REAL-money account' : 'Enable a REAL-money account';
  });

  readonly dialogMessage = computed(() => {
    const p = this.pending();
    const name = this.strategyName() || `Strategy #${this.strategyId()}`;
    if (!p) return '';
    if (p.kind === 'widen') {
      return `Removing the last binding returns "${name}" to the fleet-wide fan-out: its signals will go to every account whose EA streams ${this.symbol() || 'its symbol'}, including REAL accounts.`;
    }
    const acct =
      p.row.environment === 'UNKNOWN'
        ? 'an account the console cannot verify'
        : 'a REAL-money account';
    return `"${name}" will be able to place live orders on ${acct}: ${p.row.accountName}${p.row.accountNumber ? ` (#${p.row.accountNumber})` : ''}.`;
  });

  readonly dialogDetails = computed<string[]>(() => {
    const p = this.pending();
    if (!p) return [];
    if (p.kind === 'widen') {
      return [
        'Bound strategies trade only on their enabled bound accounts; unbound non-script strategies trade everywhere.',
        'To stop it trading live instead, keep a binding and pause it.',
      ];
    }
    return [
      `Lots on this account are multiplied by ${formatMultiplier(p.row.lotMultiplier)}, then clamped by the account's RiskProfile.`,
      p.kind === 'bind' && !p.row.isEnabled
        ? 'It is added paused; enabling it later asks again.'
        : 'Delivery starts as soon as you save.',
      p.row.brokerName
        ? `Broker: ${p.row.brokerName}.`
        : 'Check the account in Trading Accounts first.',
    ];
  });

  readonly dialogExpected = computed<string[]>(() => {
    const p = this.pending();
    if (!p) return [];
    if (p.kind === 'widen') return ['UNRESTRICTED'];
    return confirmationTargets(p.row);
  });

  readonly dialogPrompt = computed(() => {
    const p = this.pending();
    if (!p) return '';
    if (p.kind === 'widen') return 'Type UNRESTRICTED to confirm';
    const targets = confirmationTargets(p.row);
    return p.row.accountNumber
      ? `Type the account number ${p.row.accountNumber} (or the account name) to confirm`
      : `Type "${targets[0]}" to confirm`;
  });

  readonly dialogConfirmLabel = computed(() => {
    const p = this.pending();
    if (!p) return 'Confirm';
    if (p.kind === 'widen') return 'Remove binding and save';
    return p.kind === 'bind' ? 'Bind REAL account' : 'Enable REAL account';
  });

  constructor() {
    effect(() => {
      this.strategyId();
      untracked(() => this.reload());
    });
  }

  reload(): void {
    const id = this.strategyId();
    if (!id) return;
    this.loading.set(true);
    this.loadError.set(null);
    this.accountsError.set(null);
    this.saveError.set(null);
    this.pending.set(null);
    forkJoin({
      bindings: this.api.getAccountBindings(id),
      accounts: this.accountsApi
        .list({
          currentPage: 1,
          itemCountPerPage: 500,
          filter: null,
          sortBy: 'accountName',
          sortDirection: 'asc',
        })
        .pipe(catchError((err: unknown) => of({ failed: err }))),
    }).subscribe({
      next: ({ bindings, accounts }) => {
        if (!isOk(bindings)) {
          this.loadError.set(describeFailure(bindings, 'Could not load the account bindings.'));
          this.loading.set(false);
          return;
        }
        let list: TradingAccountDto[] = [];
        if ('failed' in accounts || !isOk(accounts)) {
          this.accountsError.set('Could not load the trading accounts.');
        } else {
          list = accounts.data?.data ?? [];
        }
        const rows = toBindingRows(bindings.data ?? [], list);
        this.accounts.set(list);
        this.savedRows.set(rows);
        this.rows.set(rows.map((r) => ({ ...r })));
        this.confirmedIds.set(new Set());
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.loadError.set(describeFailure(err, 'Could not load the account bindings.'));
        this.loading.set(false);
      },
    });
  }

  onAddAccountChange(value: string): void {
    const id = Number(value);
    this.addAccountId.set(value && Number.isFinite(id) ? id : null);
  }

  addBinding(): void {
    if (!this.canAdd()) return;
    const id = this.addAccountId()!;
    const account = this.accounts().find((a) => a.id === id);
    const row: BindingRow = {
      tradingAccountId: id,
      ...describeAccount(id, account),
      lotMultiplier: Number(this.addMultiplier()),
      isEnabled: this.addEnabled(),
      saved: null,
    };
    if (requiresTypedConfirmation(row)) {
      this.pending.set({ kind: 'bind', row });
      return;
    }
    this.stageNewRow(row);
  }

  toggleEnabled(row: BindingRow): void {
    const enabling = !row.isEnabled;
    // Re-enabling a binding that is saved enabled restores the saved state; anything else that
    // starts live-money delivery needs the typed confirmation.
    const restoresSaved = row.saved?.isEnabled === true;
    if (
      enabling &&
      requiresTypedConfirmation(row) &&
      !restoresSaved &&
      !this.confirmedIds().has(row.tradingAccountId)
    ) {
      this.pending.set({ kind: 'enable', row });
      return;
    }
    this.updateRow(row.tradingAccountId, { isEnabled: enabling });
  }

  setMultiplier(row: BindingRow, value: string): void {
    const n = Number(value);
    this.updateRow(row.tradingAccountId, { lotMultiplier: Number.isFinite(n) ? n : NaN });
  }

  remove(row: BindingRow): void {
    this.rows.update((rows) => rows.filter((r) => r.tradingAccountId !== row.tradingAccountId));
    if (row.saved === null) {
      const next = new Set(this.confirmedIds());
      next.delete(row.tradingAccountId);
      this.confirmedIds.set(next);
    }
  }

  discard(): void {
    this.rows.set(this.savedRows().map((r) => ({ ...r })));
    this.confirmedIds.set(new Set());
    this.saveError.set(null);
  }

  save(): void {
    if (this.saving() || !this.dirty()) return;
    const rows = this.rows();
    const errors = validateBindingSet(rows);
    if (errors.length > 0) {
      this.saveError.set(errors.join(' '));
      return;
    }
    const unconfirmed = unconfirmedLiveChanges(rows, this.confirmedIds());
    if (unconfirmed.length > 0) {
      this.saveError.set(
        `Confirm ${unconfirmed.map((r) => r.accountName).join(', ')} before saving: binding or enabling a REAL account needs its account number typed.`,
      );
      return;
    }
    if (widensToFleet(this.savedRows(), rows, this.isScript())) {
      this.pending.set({ kind: 'widen' });
      return;
    }
    this.persist();
  }

  onConfirmed(): void {
    const p = this.pending();
    if (!p) return;
    if (p.kind === 'widen') {
      this.persist();
      return;
    }
    const next = new Set(this.confirmedIds());
    next.add(p.row.tradingAccountId);
    this.confirmedIds.set(next);
    if (p.kind === 'bind') this.stageNewRow(p.row);
    else this.updateRow(p.row.tradingAccountId, { isEnabled: true });
    this.pending.set(null);
  }

  rowChanged(row: BindingRow): boolean {
    return (
      row.saved !== null &&
      (row.saved.isEnabled !== row.isEnabled ||
        Number(row.saved.lotMultiplier) !== Number(row.lotMultiplier))
    );
  }

  multiplierError(row: BindingRow): string | null {
    return validateMultiplier(row.lotMultiplier);
  }

  isLive(env: AccountEnvironment): boolean {
    return isLiveMoney(env);
  }

  envLabel(env: AccountEnvironment): string {
    return ENVIRONMENT_LABELS[env];
  }

  envHint(env: AccountEnvironment): string {
    return ENVIRONMENT_HINTS[env];
  }

  accountMeta(row: BindingRow): string {
    return [
      row.accountNumber ? `#${row.accountNumber}` : `id ${row.tradingAccountId}`,
      row.brokerName,
      row.currency,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  describeChange(c: BindingChange): string {
    const who = `${c.row.accountName} (${ENVIRONMENT_LABELS[c.row.environment]})`;
    switch (c.kind) {
      case 'added':
        return `Bind ${who}, lots ×${formatMultiplier(c.row.lotMultiplier)}, ${c.row.isEnabled ? 'enabled' : 'paused'}`;
      case 'removed':
        return `Unbind ${who}`;
      case 'enabled':
        return `Enable ${who}`;
      case 'disabled':
        return `Pause ${who}`;
      case 'multiplier':
        return `${who}: lots ×${formatMultiplier(c.from ?? NaN)} → ×${formatMultiplier(c.to ?? NaN)}`;
    }
  }

  private stageNewRow(row: BindingRow): void {
    this.rows.update((rows) => [...rows, row]);
    this.addAccountId.set(null);
    this.addMultiplier.set(1);
    this.addEnabled.set(true);
    this.pending.set(null);
  }

  private updateRow(id: number, patch: Partial<BindingRow>): void {
    this.rows.update((rows) =>
      rows.map((r) => (r.tradingAccountId === id ? { ...r, ...patch } : r)),
    );
  }

  private persist(): void {
    const id = this.strategyId();
    this.saving.set(true);
    this.saveError.set(null);
    this.api.replaceAccountBindings(id, toBindingInputs(this.rows())).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.pending.set(null);
        if (!isOk(res)) {
          this.saveError.set(describeFailure(res, 'The engine did not save the bindings.'));
          return;
        }
        this.notifications.success('Account bindings saved');
        this.saved.emit();
        this.reload();
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.pending.set(null);
        this.saveError.set(describeFailure(err, 'Saving the bindings failed.'));
      },
    });
  }
}
