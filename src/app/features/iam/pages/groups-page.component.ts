import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Observable, catchError, map, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { fetchAllPages } from '@core/scope/account-scope.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '../iam-api.service';
import { errorText, memberLabel, reportable } from '../iam.logic';
import type { SaveNamedBody } from '../iam.types';
import { iamResource } from '../shared/iam-resource';
import { MfaHintComponent } from '../shared/mfa-hint.component';

/** One group (team or account group) as the page shows it. */
interface Group {
  id: number;
  name: string;
  description: string;
  size: number | null;
}

/** One entry of a group: a person (team) or a trading account (account group). */
interface Entry {
  id: number;
  label: string;
  detail: string;
  /** Shown when already in a group, never offered for adding (e.g. a suspended member). */
  inactive?: boolean;
}

/** What differs between teams and account groups. */
interface GroupKind {
  title: string;
  subtitle: string;
  noun: string;
  entryNoun: string;
  emptyEntries: string;
  list(): Observable<Group[]>;
  create(b: SaveNamedBody): Observable<unknown>;
  update(id: number, b: SaveNamedBody): Observable<unknown>;
  remove(id: number): Observable<unknown>;
  /** Ids in the group (the engine answers ids; labels come from the candidates). */
  entryIds(id: number): Observable<number[]>;
  /** How to show an id that is not among the candidates (left the organisation, not visible). */
  unknownLabel(id: number): string;
  add(id: number, entryId: number): Observable<unknown>;
  drop(id: number, entryId: number): Observable<unknown>;
  /** Everything that could be added (people of the organisation / visible trading accounts). */
  candidates(): Observable<Entry[]>;
}

/**
 * Teams and account groups (U3.4, ADR-0031 §2): named sets a role can be granted to (a team) or at
 * (an account group). One page, configured by the route's `groupKind`. Changes need
 * `iam.grants.manage`; the lists need `iam.members.read`.
 */
@Component({
  selector: 'app-iam-groups-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    LscCanDirective,
    MfaHintComponent,
  ],
  styleUrl: '../shared/iam-page.scss',
  styles: [
    `
      .layout {
        display: grid;
        grid-template-columns: minmax(260px, 1fr) 2fr;
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1024px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .item {
        width: 100%;
        display: block;
        text-align: left;
        padding: var(--space-2) var(--space-4);
        border: none;
        border-bottom: 1px solid var(--border);
        background: transparent;
        color: inherit;
        font-family: inherit;
        cursor: pointer;
      }
      .item:hover,
      .item[aria-current='true'] {
        background: var(--bg-tertiary);
      }
      .item[aria-current='true'] {
        box-shadow: inset 3px 0 0 var(--accent);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header [title]="kind.title" [subtitle]="kind.subtitle">
        <button
          type="button"
          class="btn btn-secondary"
          (click)="groups.reload()"
          [disabled]="groups.loading()"
        >
          {{ groups.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          *lscCan="P.IamGrantsManage"
          (click)="startCreate()"
        >
          New {{ kind.noun }}
        </button>
      </app-page-header>

      <div class="layout">
        <section class="card">
          <header class="card-head">
            <h3>{{ groups.value().length }} {{ kind.noun }}s</h3>
          </header>
          @if (groups.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          } @else if (groups.loaded() && groups.value().length === 0) {
            <p class="pad muted">None yet.</p>
          }
          <ul class="list">
            @for (g of groups.value(); track g.id) {
              <li>
                <button
                  type="button"
                  class="item"
                  [attr.aria-current]="selectedId() === g.id"
                  (click)="select(g)"
                >
                  <strong>{{ g.name }}</strong>
                  <span class="sub small muted">
                    {{ g.description || 'No description'
                    }}{{ g.size !== null ? ' · ' + g.size : '' }}
                  </span>
                </button>
              </li>
            }
          </ul>
        </section>

        <section class="card">
          @if (editing() === null) {
            <p class="pad muted">Choose a {{ kind.noun }} to see who or what is in it.</p>
          } @else {
            <header class="card-head">
              <h3>{{ editing() === 'new' ? 'New ' + kind.noun : name() }}</h3>
              <span class="spacer"></span>
              <button type="button" class="btn btn-sm btn-secondary" (click)="close()">
                Close
              </button>
            </header>
            <form class="card-body" (ngSubmit)="save()">
              <div class="form-grid">
                <label class="field">
                  <span class="label">Name</span>
                  <input
                    class="input"
                    name="name"
                    [ngModel]="name()"
                    (ngModelChange)="name.set($event)"
                    [disabled]="!canManage()"
                  />
                </label>
                <label class="field">
                  <span class="label">Description</span>
                  <input
                    class="input"
                    name="description"
                    [ngModel]="description()"
                    (ngModelChange)="description.set($event)"
                    [disabled]="!canManage()"
                  />
                </label>
              </div>
              @if (canManage()) {
                <div class="actions-row">
                  <app-mfa-hint [permission]="P.IamGrantsManage" />
                  @if (editing() !== 'new') {
                    <button
                      type="button"
                      class="btn btn-danger"
                      (click)="deleting.set(true)"
                      [disabled]="busy()"
                    >
                      Delete
                    </button>
                  }
                  <button
                    type="submit"
                    class="btn btn-primary"
                    [disabled]="busy() || !name().trim()"
                  >
                    {{ busy() ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              }
            </form>

            @if (editing() !== 'new') {
              <header class="card-head">
                <h3>
                  {{ entries().length }} {{ kind.entryNoun }}{{ entries().length === 1 ? '' : 's' }}
                </h3>
                <span class="spacer"></span>
                @if (canManage()) {
                  <select
                    class="select search"
                    name="add"
                    [ngModel]="adding()"
                    (ngModelChange)="adding.set($event)"
                    [attr.aria-label]="'Add a ' + kind.entryNoun"
                  >
                    <option [ngValue]="null">Add a {{ kind.entryNoun }}…</option>
                    @for (c of addable(); track c.id) {
                      <option [ngValue]="c.id">{{ c.label }}</option>
                    }
                  </select>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    [disabled]="adding() === null || busy()"
                    (click)="add()"
                  >
                    Add
                  </button>
                }
              </header>
              @if (entriesError(); as e) {
                <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ e }}</p>
              } @else if (entries().length === 0) {
                <p class="pad muted">{{ kind.emptyEntries }}</p>
              } @else {
                <table class="grid">
                  <tbody>
                    @for (e of entries(); track e.id) {
                      <tr>
                        <td>
                          {{ e.label }} <span class="sub">{{ e.detail }}</span>
                        </td>
                        <td class="actions">
                          @if (canManage()) {
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
                              [disabled]="busy()"
                              (click)="dropping.set(e)"
                            >
                              Remove
                            </button>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            }
          }
        </section>
      </div>

      <app-confirm-dialog
        [open]="dropping() !== null"
        [title]="'Remove ' + (dropping()?.label ?? '') + ' from ' + name() + '?'"
        [message]="dropMessage()"
        confirmLabel="Remove"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="drop()"
        (cancelled)="dropping.set(null)"
      />

      <app-confirm-dialog
        [open]="deleting()"
        [title]="'Delete ' + kind.noun + ' ' + name() + '?'"
        message="Grants given to it or at it are revoked with it. This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="deleting.set(false)"
      />
    </div>
  `,
})
export class GroupsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly accountsApi = inject(TradingAccountsService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  readonly kind: GroupKind =
    inject(ActivatedRoute).snapshot.data['groupKind'] === 'account-group'
      ? this.accountGroupKind()
      : this.teamKind();

  readonly canManage = computed(() => this.auth.hasPermission(Permission.IamGrantsManage));
  readonly groups = iamResource(() => this.kind.list(), [] as Group[], 'Could not load the list.');
  readonly candidates = iamResource(() => this.kind.candidates(), [] as Entry[]);

  readonly selectedId = signal<number | null>(null);
  readonly editing = signal<number | 'new' | null>(null);
  readonly name = signal('');
  readonly description = signal('');
  readonly entryIds = signal<number[]>([]);
  readonly entries = computed<Entry[]>(() => {
    const known = new Map(this.candidates.value().map((c) => [c.id, c]));
    return this.entryIds().map(
      (id) => known.get(id) ?? { id, label: this.kind.unknownLabel(id), detail: '' },
    );
  });
  readonly entriesError = signal<string | null>(null);
  readonly addable = computed(() => {
    const inside = new Set(this.entryIds());
    return this.candidates.value().filter((c) => !inside.has(c.id) && !c.inactive);
  });
  readonly adding = signal<number | null>(null);
  readonly busy = signal(false);
  readonly deleting = signal(false);
  readonly dropping = signal<Entry | null>(null);
  readonly dropMessage = computed(() =>
    this.kind.entryNoun === 'member'
      ? 'They lose every role granted to this team (roles granted to them directly stay).'
      : 'Roles granted at this group no longer apply to this account.',
  );

  constructor() {
    this.groups.reload();
    // Also the labels of what is in a group: the engine answers ids only.
    this.candidates.reload();
  }

  private teamKind(): GroupKind {
    return {
      title: 'Teams',
      subtitle: 'Groups of people. Grant a role to a team and every member holds it.',
      noun: 'team',
      entryNoun: 'member',
      emptyEntries: 'Nobody is in this team yet.',
      list: () =>
        this.iam.teams().pipe(
          map((ts) =>
            ts.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description ?? '',
              size: t.memberCount ?? null,
            })),
          ),
        ),
      create: (b) => this.iam.createTeam(b),
      update: (id, b) => this.iam.updateTeam(id, b),
      remove: (id) => this.iam.deleteTeam(id),
      entryIds: (id) => this.iam.teamMemberIds(id),
      unknownLabel: (id) => `Member #${id}`,
      add: (id, userId) => this.iam.addTeamMember(id, userId),
      drop: (id, userId) => this.iam.removeTeamMember(id, userId),
      candidates: () =>
        this.iam.members().pipe(
          map((ms) =>
            ms.map((m) => ({
              id: m.userId,
              label: memberLabel(m),
              detail: m.status === 'Active' ? (m.email ?? '') : `${m.status} · ${m.email ?? ''}`,
              inactive: m.status !== 'Active',
            })),
          ),
        ),
    };
  }

  private accountGroupKind(): GroupKind {
    return {
      title: 'Account groups',
      subtitle:
        'Sets of trading accounts. Grant a role at an account group and it applies to every account in it.',
      noun: 'account group',
      entryNoun: 'account',
      emptyEntries: 'No trading accounts in this group yet.',
      list: () =>
        this.iam.accountGroups().pipe(
          map((gs) =>
            gs.map((g) => ({
              id: g.id,
              name: g.name,
              description: g.description ?? '',
              size: g.accountCount ?? null,
            })),
          ),
        ),
      create: (b) => this.iam.createAccountGroup(b),
      update: (id, b) => this.iam.updateAccountGroup(id, b),
      remove: (id) => this.iam.deleteAccountGroup(id),
      entryIds: (id) => this.iam.accountGroupMemberIds(id),
      unknownLabel: (id) => `Account #${id}`,
      add: (id, accountId) => this.iam.addAccountGroupMember(id, accountId),
      drop: (id, accountId) => this.iam.removeAccountGroupMember(id, accountId),
      candidates: () =>
        this.auth.hasPermission(Permission.AccountsRead)
          ? fetchAllPages((page) =>
              this.accountsApi.list({
                currentPage: page,
                itemCountPerPage: 100,
                sortBy: 'id',
                sortDirection: 'asc',
              }),
            ).pipe(
              map((as) =>
                as.map((a) => ({
                  id: a.id,
                  label: a.accountName || a.accountId || `Account #${a.id}`,
                  detail: `${a.accountId ?? ''}${a.isPaper ? ' · paper' : ''}`,
                })),
              ),
              catchError(() => of([] as Entry[])),
            )
          : of([] as Entry[]),
    };
  }

  select(g: Group): void {
    this.selectedId.set(g.id);
    this.editing.set(g.id);
    this.name.set(g.name);
    this.description.set(g.description);
    this.loadEntries(g.id);
  }

  startCreate(): void {
    this.selectedId.set(null);
    this.editing.set('new');
    this.name.set('');
    this.description.set('');
    this.entryIds.set([]);
  }

  close(): void {
    this.editing.set(null);
    this.selectedId.set(null);
  }

  private loadEntries(id: number): void {
    this.entryIds.set([]);
    this.entriesError.set(null);
    this.kind.entryIds(id).subscribe({
      next: (ids) => this.entryIds.set(ids),
      error: (err) => this.entriesError.set(errorText(err, 'Could not load the members.')),
    });
  }

  save(): void {
    const target = this.editing();
    if (target === null || this.busy() || !this.name().trim()) return;
    const body = { name: this.name().trim(), description: this.description().trim() };
    this.busy.set(true);
    const call = target === 'new' ? this.kind.create(body) : this.kind.update(target, body);
    call.subscribe({
      next: (created) => {
        this.busy.set(false);
        this.notify.success(`${body.name} saved.`);
        this.groups.reload();
        const id = (created as { id?: number } | null)?.id;
        if (target === 'new' && id) {
          this.selectedId.set(id);
          this.editing.set(id);
          this.loadEntries(id);
        }
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'It was not saved.'));
      },
    });
  }

  remove(): void {
    const id = this.editing();
    if (typeof id !== 'number' || this.busy()) return;
    this.busy.set(true);
    this.kind.remove(id).subscribe({
      next: () => {
        this.busy.set(false);
        this.deleting.set(false);
        this.notify.success('Deleted.');
        this.close();
        this.groups.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.deleting.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'It was not deleted.'));
      },
    });
  }

  add(): void {
    const id = this.editing();
    const entry = this.adding();
    if (typeof id !== 'number' || entry === null || this.busy()) return;
    this.busy.set(true);
    this.kind.add(id, entry).subscribe({
      next: () => {
        this.busy.set(false);
        this.adding.set(null);
        this.loadEntries(id);
        this.groups.reload();
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'It was not added.'));
      },
    });
  }

  drop(): void {
    const id = this.editing();
    const e = this.dropping();
    if (typeof id !== 'number' || !e || this.busy()) return;
    this.busy.set(true);
    this.kind.drop(id, e.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.dropping.set(null);
        this.loadEntries(id);
        this.groups.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.dropping.set(null);
        if (reportable(err)) this.notify.error(errorText(err, 'It was not removed.'));
      },
    });
  }
}
