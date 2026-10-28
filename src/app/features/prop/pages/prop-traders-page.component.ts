import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { failureMessage } from '@features/organisation/organisation.logic';
import { PropGateComponent, PROP_DIALOG_STYLES } from '../components/prop-gate.component';
import { PropSetupComponent } from '../components/prop-setup.component';
import { PropApiService } from '../prop-api.service';
import { optionalNumber } from '../prop.logic';
import type { PropTrader, SavePropTraderBody } from '../prop.types';

/**
 * Traders (`prop.read`; changes `prop.manage`). A trader owns accounts through enrolments; linking a
 * console user (an active member of the organisation) lets that person open "My challenge".
 */
@Component({
  selector: 'app-prop-traders-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    LscCanDirective,
    ModalA11yDirective,
    PageHeaderComponent,
    PropGateComponent,
    PropSetupComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    PROP_DIALOG_STYLES,
    `
      .gate-body {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .split {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .split {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      ol.steps {
        margin: 0;
        padding-left: var(--space-5);
        font-size: var(--text-xs);
        line-height: 1.6;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Traders"
        subtitle="The people trading your programs and the accounts they hold."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="traders.reload()"
          [disabled]="traders.loading()"
        >
          {{ traders.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button *lscCan="P.PropManage" type="button" class="btn btn-primary" (click)="edit(null)">
          New trader
        </button>
      </app-page-header>
      <app-prop-gate (ready)="start()">
        <div class="gate-body">
          <app-prop-setup
            [intro]="intro"
            [showChecklist]="traders.loaded() && !traders.value().length"
          />
          <div class="split">
            <section class="card">
              @if (traders.error(); as err) {
                <p class="pad" role="alert">
                  <span class="chip bad">Could not load</span> {{ err }}
                </p>
              }
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Trader</th>
                      <th>E-mail</th>
                      <th>Reference</th>
                      <th>Console user</th>
                      <th class="num">Running</th>
                      <th class="num">All</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (t of traders.value(); track t.id) {
                      <tr>
                        <td>
                          {{ t.displayName }}
                          @if (!t.isActive) {
                            <span class="chip">inactive</span>
                          }
                        </td>
                        <td>{{ t.email ?? '—' }}</td>
                        <td>{{ t.externalRef ?? '—' }}</td>
                        <td>{{ t.adminUserId ? '#' + t.adminUserId : '—' }}</td>
                        <td class="num">
                          <a
                            [routerLink]="['/prop/enrollments']"
                            [queryParams]="{ traderId: t.id }"
                            >{{ t.runningEnrollments }}</a
                          >
                        </td>
                        <td class="num">{{ t.totalEnrollments }}</td>
                        <td class="actions">
                          <button
                            *lscCan="P.PropManage"
                            type="button"
                            class="btn btn-sm btn-secondary"
                            (click)="edit(t)"
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="7" class="muted">
                          No trader yet. Add the person who will trade a challenge account — a name
                          is enough; e-mail and your own reference (e.g. a CRM id) are optional.
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
            <section class="card">
              <header class="card-head"><h3>How traders work</h3></header>
              <div class="card-body">
                <ol class="steps">
                  <li>
                    <strong>Add a trader</strong> — the person, not the account. One trader can hold
                    several accounts over time (one per phase).
                  </li>
                  <li>
                    <strong>Link a console user</strong> (optional) — a member of your organisation;
                    that person then sees their own progress on
                    <a routerLink="/prop/me">My challenge</a> and nothing else.
                  </li>
                  <li>
                    <strong>Enrol an account</strong> for them on
                    <a routerLink="/prop/enrollments">Enrolments</a> — the account is judged against
                    the program from that moment.
                  </li>
                  <li>
                    <strong>Advance or fund</strong> — when a phase is passed, advance them to the
                    next phase; funded traders get
                    <a routerLink="/prop/payouts">payout statements</a>.
                  </li>
                </ol>
                <p class="note">
                  A trader can be made inactive but never deleted: their enrolments, breaches and
                  payout statements stay on record.
                </p>
              </div>
            </section>
          </div>
        </div>
      </app-prop-gate>

      @if (draft(); as d) {
        <div class="overlay" role="presentation" (click)="close()">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prop-trader-title"
            tabindex="-1"
            appModalA11y
            (dismiss)="close()"
            (click)="$event.stopPropagation()"
            (keydown)="$event.stopPropagation()"
          >
            <form class="card-body" (ngSubmit)="save()">
              <h3 id="prop-trader-title">{{ editingId() ? 'Edit trader' : 'New trader' }}</h3>
              <div class="form-grid">
                <label class="field"
                  ><span class="label">Name</span>
                  <input
                    class="input"
                    name="name"
                    [(ngModel)]="d.displayName"
                    maxlength="128"
                    required
                  />
                </label>
                <label class="field"
                  ><span class="label">E-mail</span>
                  <input
                    class="input"
                    name="email"
                    type="email"
                    [(ngModel)]="d.email"
                    maxlength="256"
                  />
                </label>
                <label class="field"
                  ><span class="label">Your reference</span>
                  <input class="input" name="ref" [(ngModel)]="d.externalRef" maxlength="128" />
                </label>
                <label class="field"
                  ><span class="label">Console user id (a member; optional)</span>
                  <input
                    class="input"
                    name="user"
                    inputmode="numeric"
                    [ngModel]="d.adminUserId"
                    (ngModelChange)="d.adminUserId = optionalNumber($event)"
                  />
                </label>
              </div>
              <label class="check"
                ><input type="checkbox" name="active" [(ngModel)]="d.isActive" /> Active</label
              >
              @if (error(); as err) {
                <p class="errors" role="alert">{{ err }}</p>
              }
              <div class="actions-row">
                <button type="button" class="btn btn-secondary" (click)="close()" data-autofocus>
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="busy() || !d.displayName.trim()"
                >
                  {{ busy() ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      }
    </div>
  `,
})
export class PropTradersPageComponent {
  readonly setup = viewChild(PropSetupComponent);
  protected readonly intro =
    'Traders are the people who take your challenges. Add them here, then enrol one of your trading accounts for each in a program.';

  start(): void {
    this.traders.reload();
    this.setup()?.load();
  }

  private readonly api = inject(PropApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly optionalNumber = optionalNumber;
  readonly traders = iamResource<PropTrader[]>(
    () => this.api.traders(),
    [],
    'Could not load the traders.',
  );
  readonly draft = signal<SavePropTraderBody | null>(null);
  readonly editingId = signal<number | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  edit(t: PropTrader | null): void {
    this.editingId.set(t?.id ?? null);
    this.error.set(null);
    this.draft.set({
      displayName: t?.displayName ?? '',
      email: t?.email ?? null,
      externalRef: t?.externalRef ?? null,
      adminUserId: t?.adminUserId ?? null,
      isActive: t?.isActive ?? true,
    });
  }

  close(): void {
    if (!this.busy()) this.draft.set(null);
  }

  save(): void {
    const d = this.draft();
    if (!d || this.busy()) return;
    if (d.adminUserId !== null && Number.isNaN(d.adminUserId)) {
      this.error.set('The console user id must be a number.');
      return;
    }
    this.busy.set(true);
    const body: SavePropTraderBody = {
      ...d,
      email: d.email?.trim() || null,
      externalRef: d.externalRef?.trim() || null,
    };
    const id = this.editingId();
    (id ? this.api.updateTrader(id, body) : this.api.createTrader(body)).subscribe({
      next: (t) => {
        this.busy.set(false);
        this.draft.set(null);
        this.notify.success(`${t.displayName} saved.`);
        this.traders.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(failureMessage(e, 'The trader was not saved.'));
      },
    });
  }
}
