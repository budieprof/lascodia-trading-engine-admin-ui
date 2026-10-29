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
import { PropAccountFitComponent } from '../components/prop-account-fit.component';
import { PropGateComponent, PROP_DIALOG_STYLES } from '../components/prop-gate.component';
import { PropSetupComponent } from '../components/prop-setup.component';
import { PROP_PRESETS, type PropPresetId } from '../prop-presets';
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
    PropSetupComponent,
    PropAccountFitComponent,
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
      .gate-body {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .presets {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }
      .preset {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        background: var(--bg-primary);
      }
      .preset h4 {
        margin: 0;
        font-size: var(--text-sm);
      }
      .preset .grow {
        flex: 1;
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
      <app-prop-gate (ready)="start()">
        <div class="gate-body">
          <app-prop-setup [intro]="intro" />
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
                  <button
                    type="button"
                    class="btn btn-sm btn-secondary"
                    (click)="editor()?.open(p)"
                  >
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
              <section class="card">
                <header class="card-head">
                  <h3>No program yet — start from a preset</h3>
                  <span class="muted small"
                    >Every number is a starting point you edit, not any real firm's rules.</span
                  >
                </header>
                <div class="presets">
                  @for (pr of presets; track pr.id) {
                    <article class="preset">
                      <h4>{{ pr.label }}</h4>
                      <p class="small muted">{{ pr.description }}</p>
                      <div class="grow">
                        @for (ph of pr.rules().phases; track $index) {
                          <strong class="small">{{ $index + 1 }}. {{ ph.name }}</strong>
                          <ul class="rules">
                            @for (line of summary(ph); track line) {
                              <li>{{ line }}</li>
                            }
                          </ul>
                        }
                      </div>
                      <button
                        *lscCan="P.PropManage"
                        type="button"
                        class="btn btn-sm btn-secondary"
                        (click)="startFrom(pr.id)"
                      >
                        Start a program from this
                      </button>
                    </article>
                  }
                </div>
              </section>
            }
          }
          <app-prop-account-fit />
        </div>
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
  readonly setup = viewChild(PropSetupComponent);
  readonly fit = viewChild(PropAccountFitComponent);
  protected readonly presets = PROP_PRESETS;
  protected readonly intro =
    'A program is a sequence of phases (evaluation, verification, funded), each with its own rules; changing rules creates a new version and running enrolments keep the version they started on. Below, your real accounts are measured against the first phase so you can calibrate the limits before anyone is enrolled.';
  readonly programs = iamResource<PropProgram[]>(
    () => this.api.programs(true),
    [],
    'Could not load the programs.',
  );
  readonly archiving = signal<PropProgram | null>(null);
  readonly busy = signal(false);

  start(): void {
    this.programs.reload();
    this.setup()?.load();
    this.api.programs(false).subscribe({
      next: (list) => this.fit()?.load(list.find((p) => p.status === 'Active')?.id ?? null),
      error: () => this.fit()?.load(null),
    });
  }

  startFrom(id: PropPresetId): void {
    const editor = this.editor();
    if (!editor) return;
    editor.open(null);
    editor.applyPreset(id);
  }

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
