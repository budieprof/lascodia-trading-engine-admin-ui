import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { failureMessage } from '@features/organisation/organisation.logic';
import { ProgramEditorComponent } from '../components/program-editor.component';
import { PropGateComponent, PROP_DIALOG_STYLES } from '../components/prop-gate.component';
import { PropApiService } from '../prop-api.service';
import { phaseSummary } from '../prop.logic';
import type { PropProgram } from '../prop.types';

/** Challenge programs (`prop.read`; changes `prop.manage`): phases, rules, versions and enrolment counts. */
@Component({
  selector: 'app-prop-programs-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    LscCanDirective,
    PageHeaderComponent,
    ConfirmDialogComponent,
    PropGateComponent,
    ProgramEditorComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    PROP_DIALOG_STYLES,
    `
      ul.rules {
        margin: 0;
        padding-left: var(--space-5);
        font-size: var(--text-xs);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Challenge programs"
        subtitle="Phases and rules your traders are evaluated against."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="programs.reload()"
          [disabled]="programs.loading()"
        >
          {{ programs.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button
          *lscCan="P.PropManage"
          type="button"
          class="btn btn-primary"
          (click)="editor()?.open(null)"
        >
          New program
        </button>
      </app-page-header>
      <app-prop-gate (ready)="programs.reload()">
        @if (programs.error(); as err) {
          <section class="card">
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          </section>
        }
        @for (p of programs.value(); track p.id) {
          <section class="card">
            <header class="card-head">
              <h3>{{ p.name }}</h3>
              <span class="chip" [class.ok]="p.status === 'Active'">{{ p.status }}</span>
              <span class="muted small"
                >version {{ p.currentVersion }} · {{ p.rules.profitSplit.traderSharePct }}% to the
                trader · day resets {{ p.rules.tradingDay.resetTime }}
                {{ p.rules.tradingDay.timeZone }}</span
              >
              <span class="spacer"></span>
              <span class="muted small"
                >{{ p.runningEnrollments }} running · {{ p.passedEnrollments }} passed ·
                {{ p.failedEnrollments }} failed</span
              >
              <ng-container *lscCan="P.PropManage">
                <button type="button" class="btn btn-sm btn-secondary" (click)="editor()?.open(p)">
                  Edit
                </button>
                @if (p.status === 'Active') {
                  <button type="button" class="btn btn-sm btn-danger" (click)="archiving.set(p)">
                    Archive
                  </button>
                }
              </ng-container>
            </header>
            <div class="card-body">
              @if (p.description) {
                <p class="muted small">{{ p.description }}</p>
              }
              <div class="form-grid">
                @for (ph of p.rules.phases; track $index) {
                  <div>
                    <strong class="small">{{ $index + 1 }}. {{ ph.name }} ({{ ph.kind }})</strong>
                    <ul class="rules">
                      @for (line of summary(ph); track line) {
                        <li>{{ line }}</li>
                      }
                    </ul>
                  </div>
                }
              </div>
              <p class="small muted">
                {{
                  p.rules.haltOnBreach
                    ? 'A breach halts the account (kill switch, no new orders).'
                    : 'A breach is recorded; the account is not halted.'
                }}
                {{ p.rules.haltOnPass ? 'A pass halts the account too.' : '' }}
                Versions:
                @for (v of p.versions; track v.id) {
                  <span title="{{ v.changeNote ?? '' }}"
                    >v{{ v.version }} ({{ when(v.createdAtUtc) }}){{ $last ? '' : ', ' }}</span
                  >
                }
              </p>
            </div>
          </section>
        } @empty {
          @if (programs.loaded() && !programs.error()) {
            <section class="card"><p class="pad muted">No program yet.</p></section>
          }
        }
      </app-prop-gate>
      <app-prop-program-editor (saved)="onSaved($event)" />
      <app-confirm-dialog
        [open]="archiving() !== null"
        [title]="'Archive ' + (archiving()?.name ?? '') + '?'"
        message="No new account can be enrolled in it. Running enrolments carry on under their rules."
        confirmLabel="Archive"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="archive()"
        (cancelled)="archiving.set(null)"
      />
    </div>
  `,
})
export class PropProgramsPageComponent {
  private readonly api = inject(PropApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly summary = phaseSummary;
  readonly editor = viewChild(ProgramEditorComponent);
  readonly programs = iamResource<PropProgram[]>(
    () => this.api.programs(true),
    [],
    'Could not load the programs.',
  );
  readonly archiving = signal<PropProgram | null>(null);
  readonly busy = signal(false);

  onSaved(p: PropProgram): void {
    this.notify.success(`${p.name} saved (version ${p.currentVersion}).`);
    this.programs.reload();
  }

  archive(): void {
    const p = this.archiving();
    if (!p || this.busy()) return;
    this.busy.set(true);
    this.api.archiveProgram(p.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.archiving.set(null);
        this.notify.success(`${p.name} archived.`);
        this.programs.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.archiving.set(null);
        const msg = failureMessage(e, 'The program was not archived.');
        if (msg) this.notify.error(msg);
      },
    });
  }
}
