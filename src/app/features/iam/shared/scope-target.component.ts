import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { fetchAllPages } from '@core/scope/account-scope.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import type { TradingAccountDto } from '@core/api/api.types';
import { IamApiService } from '../iam-api.service';
import type { IamAccountGroup, ScopeType } from '../iam.types';
import { SCOPE_TYPES } from '../iam.types';
import { iamResource } from './iam-resource';

const SCOPE_NAMES: Record<ScopeType, string> = {
  Tenant: 'Whole organisation',
  AccountGroup: 'An account group',
  TradingAccount: 'One trading account',
  Strategy: 'One strategy',
};

/**
 * Where a role applies (ADR-0031 §2): the whole organisation, an account group, one trading account
 * or one strategy. Account groups and accounts are picked from what the engine lets this person
 * see; a strategy is entered by its id (the strategy list is too long for a select).
 */
@Component({
  selector: 'app-scope-target',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="scope">
      <label class="field">
        <span class="label">{{ label() }}</span>
        <select
          class="select"
          [ngModel]="scopeType()"
          (ngModelChange)="onType($event)"
          [name]="idPrefix() + '-type'"
        >
          @for (t of types; track t) {
            <option [value]="t">{{ names[t] }}</option>
          }
        </select>
      </label>
      @switch (scopeType()) {
        @case ('AccountGroup') {
          <label class="field">
            <span class="label">Account group</span>
            <select
              class="select"
              [ngModel]="scopeId()"
              (ngModelChange)="scopeId.set(toId($event))"
              [name]="idPrefix() + '-group'"
              [attr.aria-invalid]="!scopeId()"
            >
              <option [ngValue]="null">Choose…</option>
              @for (g of groups.value(); track g.id) {
                <option [ngValue]="g.id">{{ g.name }}</option>
              }
            </select>
            @if (groups.loaded() && groups.value().length === 0) {
              <span class="small muted">No account groups yet — create one under Account groups.</span>
            }
          </label>
        }
        @case ('TradingAccount') {
          <label class="field">
            <span class="label">Trading account</span>
            <select
              class="select"
              [ngModel]="scopeId()"
              (ngModelChange)="scopeId.set(toId($event))"
              [name]="idPrefix() + '-account'"
              [attr.aria-invalid]="!scopeId()"
            >
              <option [ngValue]="null">Choose…</option>
              @for (a of accounts.value(); track a.id) {
                <option [ngValue]="a.id">
                  {{ a.accountName || a.accountId }} · {{ a.accountId }}{{ a.isPaper ? ' · paper' : '' }}
                </option>
              }
            </select>
          </label>
        }
        @case ('Strategy') {
          <label class="field">
            <span class="label">Strategy id</span>
            <input
              class="input"
              type="number"
              min="1"
              step="1"
              [ngModel]="scopeId()"
              (ngModelChange)="scopeId.set(toId($event))"
              [name]="idPrefix() + '-strategy'"
              placeholder="e.g. 1181"
              [attr.aria-invalid]="!scopeId()"
            />
          </label>
        }
      }
    </div>
  `,
  styles: [
    `
      .scope {
        display: contents;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 0;
      }
      .label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .select,
      .input {
        padding: 7px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        width: 100%;
        box-sizing: border-box;
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-secondary);
      }
    `,
  ],
})
export class ScopeTargetComponent {
  private readonly iam = inject(IamApiService);
  private readonly accountsApi = inject(TradingAccountsService);
  private readonly auth = inject(AuthService);

  readonly scopeType = model<ScopeType>('Tenant');
  readonly scopeId = model<number | null>(null);
  readonly label = input('Applies to');
  /** Distinguishes control names when several pickers share a form. */
  readonly idPrefix = input('scope');

  readonly types = SCOPE_TYPES;
  readonly names = SCOPE_NAMES;

  readonly groups = iamResource<IamAccountGroup[]>(() => this.iam.accountGroups(), [], 'Could not load account groups.');
  readonly accounts = iamResource<TradingAccountDto[]>(
    () =>
      this.auth.hasPermission(Permission.AccountsRead)
        ? fetchAllPages((page) =>
            this.accountsApi.list({ currentPage: page, itemCountPerPage: 100, sortBy: 'id', sortDirection: 'asc' }),
          ).pipe(catchError(() => of([] as TradingAccountDto[])))
        : of([] as TradingAccountDto[]),
    [],
  );

  private readonly needs = computed(() => this.scopeType());

  constructor() {
    // Load the list a scope type needs, once, when it is first chosen.
    effect(() => {
      const t = this.needs();
      untracked(() => {
        if (t === 'AccountGroup' && !this.groups.loaded() && !this.groups.loading()) this.groups.reload();
        if (t === 'TradingAccount' && !this.accounts.loaded() && !this.accounts.loading()) this.accounts.reload();
      });
    });
  }

  onType(t: ScopeType): void {
    this.scopeType.set(t);
    this.scopeId.set(null);
  }

  toId(v: unknown): number | null {
    const n = Number(v);
    return v === null || v === '' || !Number.isInteger(n) || n <= 0 ? null : n;
  }
}
