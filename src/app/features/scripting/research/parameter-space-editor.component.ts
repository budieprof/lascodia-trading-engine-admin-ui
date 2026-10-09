import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, firstValueFrom, of, switchMap } from 'rxjs';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { describeFailure } from '../shared/api-error';
import {
  OBJECTIVES,
  buildSpec,
  draftFromSpace,
  rangeSourceText,
  shapedRangeText,
  specSummary,
  valueText,
  type ConstraintsDraft,
  type DimensionDraft,
  type SpecDraft,
} from './parameter-space.model';
import { ResearchApiService } from './research-api.service';
import type { OptimizationObjective, ParameterSpaceDto } from './research.types';

/** How long the editor waits after the last keystroke before asking the engine to check the spec. */
export const PREVIEW_DEBOUNCE_MS = 400;

/**
 * PE-I4 — the optimizer's search space for a script strategy, editable: narrow an input's range, hold an input at one
 * value, pick what the search ranks by and the constraints a candidate must meet. Every change is checked by the engine
 * (`POST strategy/{id}/script/parameter-space`, which writes nothing) and "Start optimization run" queues a run with the
 * spec. A run only searches; its winner still goes through the unchanged out-of-sample validation and approval.
 */
@Component({
  selector: 'app-parameter-space-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="pse-title" data-testid="parameter-space-editor">
      <header class="head">
        <h3 id="pse-title" class="title">Search space</h3>
        @if (shaped(); as s) {
          <span class="chip chip-accent" data-testid="pse-grid">
            {{ s.initialCandidates }} starting candidate{{ s.initialCandidates === 1 ? '' : 's' }}
          </span>
        }
      </header>

      @if (loading()) {
        <p class="muted">Reading the script's inputs…</p>
      } @else if (loadError(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      } @else if (draft(); as d) {
        <p class="muted small">
          The optimizer searches these inputs on training folds, then re-tests its winner out of
          sample. What you rank by steers the search only: validation, approval and every promotion
          gate stay as they are.
        </p>

        @if (d.dimensions.length === 0) {
          <p class="muted">This script has no input the optimizer can search.</p>
        } @else {
          <div class="table-wrap">
            <table class="dims" data-testid="pse-dimensions">
              <thead>
                <tr>
                  <th scope="col">Input</th>
                  <th scope="col">Search or hold</th>
                  <th scope="col">Values</th>
                  <th scope="col">The engine searches</th>
                </tr>
              </thead>
              <tbody>
                @for (dim of d.dimensions; track dim.id; let i = $index) {
                  <tr [attr.data-dim]="dim.id">
                    <th scope="row">
                      {{ dim.title }}
                      <span class="muted small block">{{ rangeSourceText(dim.rangeSource) }}</span>
                    </th>
                    <td>
                      <select
                        class="field-input"
                        [attr.aria-label]="dim.title + ': search or hold'"
                        (change)="setMode(i, $any($event.target).value)"
                      >
                        <option value="search" [selected]="dim.mode === 'search'">Search</option>
                        <option value="lock" [selected]="dim.mode === 'lock'">Hold at</option>
                      </select>
                    </td>
                    <td>
                      @if (dim.mode === 'lock') {
                        @if (dim.kind === 'choice') {
                          <select
                            class="field-input"
                            [attr.aria-label]="dim.title + ': value to hold'"
                            (change)="setLockOption(i, +$any($event.target).value)"
                          >
                            @for (opt of dim.options; track $index; let oi = $index) {
                              <option [value]="oi" [selected]="same(opt, dim.lockValue)">
                                {{ valueText(opt) }}
                              </option>
                            }
                          </select>
                        } @else {
                          <input
                            class="field-input num"
                            type="number"
                            [attr.aria-label]="dim.title + ': value to hold'"
                            [value]="dim.lockValue"
                            (input)="patch(i, { lockValue: $any($event.target).value })"
                          />
                        }
                      } @else if (dim.kind === 'choice') {
                        <div
                          class="options"
                          role="group"
                          [attr.aria-label]="dim.title + ': options to search'"
                        >
                          @for (opt of dim.options; track $index) {
                            <label class="opt">
                              <input
                                type="checkbox"
                                [checked]="isChosen(dim, opt)"
                                (change)="toggleChoice(i, opt, $any($event.target).checked)"
                              />
                              {{ valueText(opt) }}
                            </label>
                          }
                        </div>
                      } @else {
                        <div class="range">
                          <input
                            class="field-input num"
                            type="number"
                            [attr.aria-label]="dim.title + ': lowest value'"
                            [value]="dim.min"
                            (input)="patch(i, { min: $any($event.target).value })"
                          />
                          <span class="muted small">to</span>
                          <input
                            class="field-input num"
                            type="number"
                            [attr.aria-label]="dim.title + ': highest value'"
                            [value]="dim.max"
                            (input)="patch(i, { max: $any($event.target).value })"
                          />
                          <span class="muted small">step</span>
                          <input
                            class="field-input num"
                            type="number"
                            placeholder="any"
                            [attr.aria-label]="dim.title + ': step'"
                            [value]="dim.step"
                            (input)="patch(i, { step: $any($event.target).value })"
                          />
                        </div>
                      }
                    </td>
                    <td class="muted small">{{ engineSearches(dim) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (d.skipped.length > 0) {
          <details class="skipped">
            <summary>Inputs the optimizer does not search ({{ d.skipped.length }})</summary>
            <ul>
              @for (s of d.skipped; track s.id; let i = $index) {
                <li [attr.data-skipped]="s.id">
                  <span class="strong">{{ s.title }}</span>
                  <span class="muted small"> — {{ s.reason }}</span>
                  <label class="hold">
                    <input
                      type="checkbox"
                      [checked]="s.locked"
                      (change)="patchSkipped(i, { locked: $any($event.target).checked })"
                    />
                    Hold at
                  </label>
                  <input
                    class="field-input"
                    [disabled]="!s.locked"
                    [attr.aria-label]="s.title + ': value to hold'"
                    [value]="s.lockValue"
                    (input)="patchSkipped(i, { lockValue: $any($event.target).value })"
                  />
                </li>
              }
            </ul>
          </details>
        }

        <div class="objective">
          <label>
            <span class="muted small">Rank candidates by</span>
            <select
              class="field-input"
              (change)="setObjective($any($event.target).value)"
              data-testid="pse-objective"
            >
              @for (o of objectives; track o.id) {
                <option [value]="o.id" [selected]="d.objective === o.id">{{ o.label }}</option>
              }
            </select>
          </label>
          <span class="muted small">{{ objectiveHint() }}</span>
        </div>

        <fieldset class="constraints">
          <legend class="muted small">
            Constraints a candidate must meet over its folds (optional)
          </legend>
          <label>
            <span class="muted small">Minimum trades</span>
            <input
              class="field-input num"
              type="number"
              min="1"
              step="1"
              [value]="d.constraints.minTrades"
              (input)="setConstraint('minTrades', $any($event.target).value)"
            />
          </label>
          <label>
            <span class="muted small">Maximum drawdown (%)</span>
            <input
              class="field-input num"
              type="number"
              [value]="d.constraints.maxDrawdownPct"
              (input)="setConstraint('maxDrawdownPct', $any($event.target).value)"
            />
          </label>
          <label>
            <span class="muted small">Minimum win rate (%)</span>
            <input
              class="field-input num"
              type="number"
              [value]="d.constraints.minWinRatePct"
              (input)="setConstraint('minWinRatePct', $any($event.target).value)"
            />
          </label>
          <label>
            <span class="muted small">Minimum profit factor</span>
            <input
              class="field-input num"
              type="number"
              step="0.1"
              [value]="d.constraints.minProfitFactor"
              (input)="setConstraint('minProfitFactor', $any($event.target).value)"
            />
          </label>
          <label>
            <span class="muted small">Minimum expectancy (R per trade)</span>
            <input
              class="field-input num"
              type="number"
              step="0.05"
              [value]="d.constraints.minExpectancyR"
              (input)="setConstraint('minExpectancyR', $any($event.target).value)"
            />
          </label>
        </fieldset>

        <div class="verdict" aria-live="polite">
          @if (problems().length > 0) {
            <ul class="problems" role="alert" data-testid="pse-problems">
              @for (p of problems(); track p) {
                <li>{{ p }}</li>
              }
            </ul>
          } @else if (previewing()) {
            <p class="muted small">Checking the spec with the engine…</p>
          } @else if (built().isDefault) {
            <p class="muted small">
              No changes: the run searches the script's own space and ranks by health score.
            </p>
          } @else {
            <p class="ok small" data-testid="pse-accepted">The engine accepts this spec.</p>
          }
          @if (summary().length > 0) {
            <ul class="summary" data-testid="pse-summary">
              @for (line of summary(); track line) {
                <li>{{ line }}</li>
              }
            </ul>
          }
        </div>

        <div class="actions">
          <button type="button" class="btn btn-ghost" (click)="reset()">
            Back to the script's space
          </button>
          <button
            type="button"
            class="btn btn-primary"
            data-testid="pse-start"
            [disabled]="!canStart()"
            [attr.title]="canRun() ? null : 'Starting a run needs the analyst permission.'"
            (click)="start()"
          >
            @if (starting()) {
              <span class="spinner" aria-hidden="true"></span>
            }
            Start optimization run
          </button>
        </div>
        @if (startError(); as e) {
          <p class="error-box" role="alert" data-testid="pse-start-error">{{ e }}</p>
        }
      }
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: middle;
        font-weight: normal;
      }
      thead th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .block {
        display: block;
      }
      .range,
      .options {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .num {
        width: 90px;
      }
      .opt {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: var(--text-sm);
      }
      .skipped ul {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .skipped li {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .strong {
        font-weight: var(--font-medium);
      }
      .hold {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: var(--text-sm);
      }
      .objective {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 12px;
      }
      .objective label,
      .constraints label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .constraints {
        margin: 0;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .problems {
        margin: 0;
        padding-left: 18px;
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .summary {
        margin: 4px 0 0;
        padding-left: 18px;
        font-size: var(--text-sm);
      }
      .ok {
        margin: 0;
        color: var(--profit, #1f8a3b);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class ParameterSpaceEditorComponent {
  private readonly api = inject(ResearchApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly strategyId = input.required<number>();
  /** The caller may start runs (`access.analyst`). */
  readonly canRun = input(true);
  /** A run was queued: its id. */
  readonly started = output<number>();

  readonly objectives = OBJECTIVES;
  readonly rangeSourceText = rangeSourceText;
  readonly valueText = valueText;

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly space = signal<ParameterSpaceDto | null>(null);
  readonly draft = signal<SpecDraft | null>(null);
  readonly previewing = signal(false);
  /** The engine's answer for the current draft (null while it is the default, or before it answered). */
  readonly preview = signal<ParameterSpaceDto | null>(null);
  readonly engineProblems = signal<string[]>([]);
  readonly starting = signal(false);
  readonly startError = signal<string | null>(null);

  readonly built = computed(() => {
    const d = this.draft();
    return d
      ? buildSpec(d)
      : {
          spec: { ranges: {}, locked: {}, objective: 'HealthScore' as const },
          problems: [],
          isDefault: true,
        };
  });
  readonly problems = computed(() => [...this.built().problems, ...this.engineProblems()]);
  /** The space the run will search: the engine's preview of the spec, else the declared space. */
  readonly shaped = computed(() => (this.built().isDefault ? this.space() : this.preview()));
  readonly summary = computed(() =>
    this.built().isDefault ? [] : specSummary(this.built().spec, this.space()),
  );
  readonly objectiveHint = computed(
    () => OBJECTIVES.find((o) => o.id === this.draft()?.objective)?.hint ?? '',
  );
  readonly canStart = computed(
    () =>
      this.canRun() &&
      !this.starting() &&
      !this.previewing() &&
      this.draft() !== null &&
      this.problems().length === 0 &&
      (this.built().isDefault || this.preview() !== null),
  );

  private readonly previews = new Subject<SpecDraft>();

  constructor() {
    effect(() => {
      const id = this.strategyId();
      untracked(() => void this.load(id));
    });
    this.previews
      .pipe(
        debounceTime(PREVIEW_DEBOUNCE_MS),
        switchMap((d) => {
          const built = buildSpec(d);
          if (built.isDefault || built.problems.length > 0) return of(null);
          this.previewing.set(true);
          return this.api
            .previewSpace(this.strategyId(), built.spec)
            .pipe(catchError((err: unknown) => of({ error: err })));
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.previewing.set(false);
        if (res === null) return;
        if ('error' in res) {
          this.preview.set(null);
          this.engineProblems.set([
            describeFailure(res.error, 'The engine could not check the spec.'),
          ]);
          return;
        }
        if (!res.status || !res.data) {
          this.preview.set(null);
          this.engineProblems.set([describeFailure(res, 'The engine could not check the spec.')]);
          return;
        }
        this.preview.set(res.data);
        this.engineProblems.set(res.data.problems ?? []);
      });
  }

  async load(strategyId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const res = await firstValueFrom(this.api.parameterSpace(strategyId));
      if (!res?.status || !res.data) throw res;
      this.space.set(res.data);
      this.draft.set(draftFromSpace(res.data));
      this.preview.set(null);
      this.engineProblems.set([]);
    } catch (err) {
      this.space.set(null);
      this.draft.set(null);
      this.loadError.set(describeFailure(err, 'The script’s search space could not be read.'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Any edit: store it, drop the stale engine answer, and ask again after a pause. */
  private update(next: SpecDraft): void {
    this.draft.set(next);
    this.preview.set(null);
    this.engineProblems.set([]);
    this.startError.set(null);
    const built = buildSpec(next);
    if (!built.isDefault && built.problems.length === 0) this.previewing.set(true);
    this.previews.next(next);
  }

  patch(index: number, change: Partial<DimensionDraft>): void {
    const d = this.draft();
    if (!d) return;
    this.update({
      ...d,
      dimensions: d.dimensions.map((x, i) => (i === index ? { ...x, ...change } : x)),
    });
  }

  setMode(index: number, mode: string): void {
    this.patch(index, { mode: mode === 'lock' ? 'lock' : 'search' });
  }

  setLockOption(index: number, optionIndex: number): void {
    const dim = this.draft()?.dimensions[index];
    if (dim) this.patch(index, { lockValue: dim.options[optionIndex] });
  }

  toggleChoice(index: number, option: unknown, on: boolean): void {
    const dim = this.draft()?.dimensions[index];
    if (!dim) return;
    const chosen = on
      ? dim.options.filter((o) => this.same(o, option) || dim.chosen.some((c) => this.same(c, o)))
      : dim.chosen.filter((c) => !this.same(c, option));
    this.patch(index, { chosen });
  }

  patchSkipped(index: number, change: { locked?: boolean; lockValue?: string }): void {
    const d = this.draft();
    if (!d) return;
    this.update({
      ...d,
      skipped: d.skipped.map((s, i) => (i === index ? { ...s, ...change } : s)),
    });
  }

  setObjective(objective: string): void {
    const d = this.draft();
    if (d) this.update({ ...d, objective: objective as OptimizationObjective });
  }

  setConstraint(key: keyof ConstraintsDraft, value: string): void {
    const d = this.draft();
    if (d) this.update({ ...d, constraints: { ...d.constraints, [key]: value } });
  }

  reset(): void {
    const s = this.space();
    if (s) this.update(draftFromSpace(s));
  }

  isChosen(dim: DimensionDraft, option: unknown): boolean {
    return dim.chosen.some((c) => this.same(c, option));
  }

  same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** What the engine will search for an input under the current draft (its preview, else its own range). */
  engineSearches(dim: DimensionDraft): string {
    if (dim.mode === 'lock') return 'held — not searched';
    const source = this.built().isDefault ? this.space() : this.preview();
    return shapedRangeText(source?.searched.find((s) => s.id === dim.id)) ?? '…';
  }

  async start(): Promise<void> {
    if (!this.canStart()) return;
    const built = this.built();
    this.starting.set(true);
    this.startError.set(null);
    try {
      const res = await firstValueFrom(
        this.api.triggerOptimization(this.strategyId(), built.isDefault ? null : built.spec),
      );
      if (res?.status && typeof res.data === 'number' && res.data > 0) {
        this.started.emit(res.data);
        return;
      }
      if (res?.responseCode === '-409')
        this.startError.set(
          `An optimization run is already queued or running for this strategy (#${res.data}). A spec applies only to a new run — wait for that one to finish.`,
        );
      else this.startError.set(describeFailure(res, 'The optimization run could not be started.'));
    } catch (err) {
      this.startError.set(describeFailure(err, 'The optimization run could not be started.'));
    } finally {
      this.starting.set(false);
    }
  }
}
