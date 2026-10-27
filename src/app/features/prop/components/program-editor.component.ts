import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { failureMessage } from '@features/organisation/organisation.logic';
import { PropApiService } from '../prop-api.service';
import { cloneRules, defaultRules, newPhase, ruleErrors } from '../prop.logic';
import { PROP_PRESETS, presetById, sizeLabels, type PropPresetId } from '../prop-presets';
import type { PropPhaseKind, PropPhaseRules, PropProgram, PropProgramRules } from '../prop.types';
import { PROP_DIALOG_STYLES } from './prop-gate.component';

/**
 * Creates or edits a program (`prop.manage`). Rules are data: saving changed rules writes a NEW version
 * for new enrolments — running enrolments keep the version they started under (the dialog says so).
 * Opened through {@link open} so the pure vitest runner can drive it.
 */
@Component({
  selector: 'app-prop-program-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModalA11yDirective],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    PROP_DIALOG_STYLES,
    `
      .phase {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .phase h4 {
        margin: 0;
        font-size: var(--text-sm);
      }
    `,
  ],
  template: `
    @if (opened()) {
      <div class="overlay" role="presentation" (click)="close()">
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="prop-program-title"
          tabindex="-1"
          appModalA11y
          (dismiss)="close()"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <form class="card-body" (ngSubmit)="save()">
            <h3 id="prop-program-title">
              {{ editing() ? 'Edit ' + editing()!.name : 'New program' }}
            </h3>
            @if (editing(); as p) {
              <p class="note">
                Changed rules are saved as version {{ p.currentVersion + 1 }} for new enrolments.
                The {{ p.runningEnrollments }} running enrolment(s) keep the rules they started
                with.
              </p>
            } @else {
              <!-- Multi-asset WS7 7.8: start from an FX, futures (contracts) or crypto (coins) preset. -->
              <label class="field">
                <span class="label">Start from</span>
                <select
                  class="select"
                  name="preset"
                  [ngModel]="presetId()"
                  (ngModelChange)="applyPreset($event)"
                  data-testid="prop-preset"
                >
                  @for (pr of presets; track pr.id) {
                    <option [value]="pr.id">{{ pr.label }}</option>
                  }
                </select>
              </label>
              <p class="note">{{ preset().description }}</p>
            }
            <div class="form-grid">
              <label class="field">
                <span class="label">Name</span>
                <input class="input" name="name" [(ngModel)]="name" required maxlength="128" />
              </label>
              <label class="field">
                <span class="label">Account currency</span>
                <input
                  class="input"
                  name="currency"
                  [(ngModel)]="currency"
                  [disabled]="!!editing()"
                  maxlength="10"
                />
              </label>
              <label class="field">
                <span class="label">Trading day resets at (HH:mm)</span>
                <input class="input" name="reset" [(ngModel)]="rules().tradingDay.resetTime" />
              </label>
              <label class="field">
                <span class="label">Time zone (IANA)</span>
                <input
                  class="input"
                  name="tz"
                  [(ngModel)]="rules().tradingDay.timeZone"
                  placeholder="America/New_York"
                />
              </label>
              <label class="field">
                <span class="label">Trader's profit share (%)</span>
                <input
                  class="input"
                  type="number"
                  name="split"
                  min="0"
                  max="100"
                  [(ngModel)]="rules().profitSplit.traderSharePct"
                />
              </label>
            </div>
            <label class="field">
              <span class="label">Description</span>
              <input class="input" name="description" [(ngModel)]="description" maxlength="2000" />
            </label>
            <label class="check">
              <input type="checkbox" name="haltOnBreach" [(ngModel)]="rules().haltOnBreach" />
              On a breach, engage the account's kill switch (no new orders; open positions are not
              closed)
            </label>
            <label class="check">
              <input type="checkbox" name="haltOnPass" [(ngModel)]="rules().haltOnPass" />
              Also halt the account when a phase is passed
            </label>

            @for (ph of rules().phases; track $index; let i = $index) {
              <div class="phase">
                <div class="row">
                  <h4>Phase {{ i + 1 }}</h4>
                  <span class="spacer"></span>
                  <button
                    type="button"
                    class="btn btn-sm btn-secondary"
                    [disabled]="i === 0"
                    (click)="move(i, -1)"
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-secondary"
                    [disabled]="i === rules().phases.length - 1"
                    (click)="move(i, 1)"
                  >
                    Down
                  </button>
                  <button type="button" class="btn btn-sm btn-danger" (click)="removePhase(i)">
                    Remove
                  </button>
                </div>
                <div class="form-grid">
                  <label class="field">
                    <span class="label">Name</span>
                    <input
                      class="input"
                      [name]="'ph-name-' + i"
                      [(ngModel)]="ph.name"
                      maxlength="64"
                    />
                  </label>
                  <label class="field">
                    <span class="label">Kind</span>
                    <select class="select" [name]="'ph-kind-' + i" [(ngModel)]="ph.kind">
                      @for (k of kinds; track k) {
                        <option [value]="k">{{ k }}</option>
                      }
                    </select>
                  </label>
                  @if (ph.kind !== 'Funded') {
                    <label class="field">
                      <span class="label">Profit target (%)</span>
                      <input
                        class="input"
                        type="number"
                        [name]="'ph-target-' + i"
                        [(ngModel)]="ph.profitTargetPct"
                      />
                    </label>
                    <label class="field">
                      <span class="label">Time limit (days, empty = none)</span>
                      <input
                        class="input"
                        type="number"
                        [name]="'ph-time-' + i"
                        [(ngModel)]="ph.timeLimitDays"
                      />
                    </label>
                    <label class="field">
                      <span class="label">Minimum trading days</span>
                      <input
                        class="input"
                        type="number"
                        [name]="'ph-days-' + i"
                        [(ngModel)]="ph.minTradingDays"
                      />
                    </label>
                  }
                  <label class="field">
                    <span class="label">Max daily loss (%)</span>
                    <input
                      class="input"
                      type="number"
                      [name]="'ph-daily-' + i"
                      [(ngModel)]="ph.maxDailyLossPct"
                    />
                  </label>
                  <label class="field">
                    <span class="label">Daily loss measured from</span>
                    <select
                      class="select"
                      [name]="'ph-dref-' + i"
                      [(ngModel)]="ph.dailyLossReference"
                    >
                      <option value="StartOfDayBalance">Day-start balance</option>
                      <option value="StartOfDayEquity">Day-start equity</option>
                      <option value="HigherOfBalanceAndEquity">Higher of the two</option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="label">Daily loss % of</span>
                    <select
                      class="select"
                      [name]="'ph-dof-' + i"
                      [(ngModel)]="ph.dailyLossAmountOf"
                    >
                      <option value="InitialBalance">Initial balance</option>
                      <option value="DayReference">The day reference</option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="label">Max overall drawdown (%)</span>
                    <input
                      class="input"
                      type="number"
                      [name]="'ph-dd-' + i"
                      [(ngModel)]="ph.maxOverallDrawdownPct"
                    />
                  </label>
                  <label class="field">
                    <span class="label">Drawdown</span>
                    <select class="select" [name]="'ph-ddm-' + i" [(ngModel)]="ph.drawdownMode">
                      <option value="Static">Static (from the initial balance)</option>
                      <option value="Trailing">Trailing (follows the high-water mark)</option>
                    </select>
                  </label>
                  @if (ph.drawdownMode === 'Trailing') {
                    <label class="field">
                      <span class="label">Trailing on</span>
                      <select class="select" [name]="'ph-tb-' + i" [(ngModel)]="ph.trailingBasis">
                        <option value="Equity">Equity</option>
                        <option value="Balance">Closed balance</option>
                      </select>
                    </label>
                  }
                  <label class="field">
                    <span class="label">{{ sizeLabel().perPosition }}</span>
                    <input
                      class="input"
                      type="number"
                      step="0.01"
                      [name]="'ph-lots-' + i"
                      [(ngModel)]="ph.maxLotsPerPosition"
                    />
                  </label>
                  <label class="field">
                    <span class="label">{{ sizeLabel().total }}</span>
                    <input
                      class="input"
                      type="number"
                      step="0.01"
                      [name]="'ph-tlots-' + i"
                      [(ngModel)]="ph.maxTotalOpenLots"
                    />
                  </label>
                  <label class="field">
                    <span class="label">Lot limits</span>
                    <select class="select" [name]="'ph-la-' + i" [(ngModel)]="ph.lotsAction">
                      <option value="Fail">Fail the enrolment</option>
                      <option value="Warn">Warn only</option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="label">Consistency: best day ≤ % of profit</span>
                    <input
                      class="input"
                      type="number"
                      [name]="'ph-cons-' + i"
                      [(ngModel)]="ph.consistencyMaxBestDayPct"
                    />
                  </label>
                </div>
                @if (ph.drawdownMode === 'Trailing') {
                  <label class="check">
                    <input
                      type="checkbox"
                      [name]="'ph-lock-' + i"
                      [(ngModel)]="ph.trailingLocksAtInitialBalance"
                    />
                    The trailing floor stops at the initial balance
                  </label>
                }
                @if (ph.kind !== 'Funded') {
                  <label class="check">
                    <input
                      type="checkbox"
                      [name]="'ph-flat-' + i"
                      [(ngModel)]="ph.profitTargetRequiresFlat"
                    />
                    The target counts only with no open position
                  </label>
                }
                <div class="row">
                  <label class="check">
                    <input
                      type="checkbox"
                      [name]="'ph-news-' + i"
                      [ngModel]="!ph.newsTradingAllowed"
                      (ngModelChange)="ph.newsTradingAllowed = !$event"
                    />
                    No trading within
                  </label>
                  <input
                    class="input"
                    style="width: 80px"
                    type="number"
                    [name]="'ph-nw-' + i"
                    [(ngModel)]="ph.newsWindowMinutes"
                  />
                  <span class="small">min of a high-impact release</span>
                  <select
                    class="select"
                    style="width: auto"
                    [name]="'ph-na-' + i"
                    [(ngModel)]="ph.newsAction"
                  >
                    <option value="Fail">fails</option>
                    <option value="Warn">warns</option>
                  </select>
                </div>
                <div class="row">
                  <label class="check">
                    <input
                      type="checkbox"
                      [name]="'ph-wk-' + i"
                      [ngModel]="!ph.weekendHoldingAllowed"
                      (ngModelChange)="ph.weekendHoldingAllowed = !$event"
                    />
                    No holding from {{ ph.weekend.startDay }}
                  </label>
                  <input
                    class="input"
                    style="width: 80px"
                    [name]="'ph-ws-' + i"
                    [(ngModel)]="ph.weekend.startTime"
                  />
                  <span class="small">to {{ ph.weekend.endDay }}</span>
                  <input
                    class="input"
                    style="width: 80px"
                    [name]="'ph-we-' + i"
                    [(ngModel)]="ph.weekend.endTime"
                  />
                  <select
                    class="select"
                    style="width: auto"
                    [name]="'ph-wa-' + i"
                    [(ngModel)]="ph.weekendAction"
                  >
                    <option value="Fail">fails</option>
                    <option value="Warn">warns</option>
                  </select>
                </div>
              </div>
            }
            <div class="row">
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                (click)="addPhase('Evaluation')"
              >
                Add evaluation phase
              </button>
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                (click)="addPhase('Verification')"
              >
                Add verification phase
              </button>
              <button type="button" class="btn btn-sm btn-secondary" (click)="addPhase('Funded')">
                Add funded phase
              </button>
            </div>
            @if (editing()) {
              <label class="field">
                <span class="label">What changed (kept with the version)</span>
                <input class="input" name="note" [(ngModel)]="changeNote" maxlength="1000" />
              </label>
            }
            @if (submitted() && errors().length) {
              <ul class="errors" role="alert">
                @for (e of errors(); track e) {
                  <li>{{ e }}</li>
                }
              </ul>
            }
            @if (serverError(); as err) {
              <p class="errors" role="alert">{{ err }}</p>
            }
            <div class="actions-row">
              <button type="button" class="btn btn-secondary" (click)="close()" data-autofocus>
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busy()">
                {{ busy() ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
})
export class ProgramEditorComponent {
  private readonly api = inject(PropApiService);

  readonly saved = output<PropProgram>();

  protected readonly kinds: PropPhaseKind[] = ['Evaluation', 'Verification', 'Funded'];
  protected readonly presets = PROP_PRESETS;
  /** The preset a NEW program starts from (multi-asset WS7 7.8); size rules are read in its unit. */
  readonly presetId = signal<PropPresetId>('fx-two-step');
  readonly preset = computed(() => presetById(this.presetId()));
  readonly sizeLabel = computed(() => sizeLabels(this.editing() ? 'lots' : this.preset().unit));

  readonly opened = signal(false);
  readonly editing = signal<PropProgram | null>(null);
  readonly rules = signal<PropProgramRules>(defaultRules());
  readonly busy = signal(false);
  readonly submitted = signal(false);
  readonly serverError = signal<string | null>(null);
  readonly version = signal(0);
  name = '';
  description = '';
  currency = 'USD';
  changeNote = '';

  /** Validation over the current rules (recomputed on every change through `version`). */
  readonly errors = computed(() => {
    this.version();
    const problems = ruleErrors(this.rules());
    if (!this.name.trim()) problems.unshift('Give the program a name.');
    return problems;
  });

  open(program: PropProgram | null): void {
    this.editing.set(program);
    this.presetId.set('fx-two-step');
    this.rules.set(program ? cloneRules(program.rules) : defaultRules());
    this.name = program?.name ?? '';
    this.description = program?.description ?? '';
    this.currency = program?.currency ?? 'USD';
    this.changeNote = '';
    this.submitted.set(false);
    this.serverError.set(null);
    this.opened.set(true);
  }

  close(): void {
    if (this.busy()) return;
    this.opened.set(false);
  }

  applyPreset(id: PropPresetId): void {
    if (this.editing()) return;
    this.presetId.set(id);
    this.rules.set(presetById(id).rules());
    this.version.update((v) => v + 1);
  }

  addPhase(kind: PropPhaseKind): void {
    this.rules.update((r) => ({ ...r, phases: [...r.phases, newPhase(kind)] }));
  }

  removePhase(i: number): void {
    this.rules.update((r) => ({ ...r, phases: r.phases.filter((_, j) => j !== i) }));
  }

  move(i: number, by: number): void {
    this.rules.update((r) => {
      const phases: PropPhaseRules[] = [...r.phases];
      const [p] = phases.splice(i, 1);
      phases.splice(i + by, 0, p);
      return { ...r, phases };
    });
  }

  save(): void {
    this.submitted.set(true);
    this.version.update((v) => v + 1);
    if (this.busy() || this.errors().length) return;
    this.busy.set(true);
    this.serverError.set(null);
    const body = {
      name: this.name.trim(),
      description: this.description.trim() || null,
      currency: this.currency.trim() || 'USD',
      rules: this.rules(),
      changeNote: this.changeNote.trim() || null,
    };
    const p = this.editing();
    (p ? this.api.updateProgram(p.id, body) : this.api.createProgram(body)).subscribe({
      next: (program) => {
        this.busy.set(false);
        this.opened.set(false);
        this.saved.emit(program);
      },
      error: (e) => {
        this.busy.set(false);
        this.serverError.set(failureMessage(e, 'The program was not saved.'));
      },
    });
  }
}
