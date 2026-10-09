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
import { catchError, forkJoin, of } from 'rxjs';

import type { StrategyDto } from '@core/api/api.types';
import { TradingAccountsService } from '@core/services/trading-accounts.service';

import { StrategyExecutionService } from '../api/strategy-execution.service';
import { isLiveMoney, toBindingRows } from '../execution/execution.model';
import { isOk } from '../shared/api-error';
import {
  GRADUATED_STAGES,
  checklistSteps,
  dismissChecklist,
  isChecklistDismissed,
  nextStep,
  type ChecklistAction,
  type ChecklistStep,
} from './first-strategy-checklist';
import { wasPreviewed } from './previewed-scripts';

/**
 * PE-I9: a script strategy's first-strategy checklist on its detail page — compile, preview,
 * backtest, paper, demo binding — ticked from what the console can see, with the next step's
 * action. Hidden once every step is done, once the strategy is past paper trading, or when the
 * operator hides it.
 */
@Component({
  selector: 'app-first-strategy-checklist',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <section class="checklist" aria-labelledby="fsc-title" data-testid="first-strategy-checklist">
        <header class="head">
          <h3 id="fsc-title" class="title">From script to a demo account</h3>
          <span class="progress">{{ doneCount() }} of {{ steps().length }} done</span>
          <span class="spacer"></span>
          <button type="button" class="btn btn-ghost btn-sm" (click)="hide()">Hide</button>
        </header>
        <ol class="steps">
          @for (s of steps(); track s.id) {
            <li
              class="step"
              [attr.data-step]="s.id"
              [attr.data-state]="s.done === true ? 'done' : s.done === null ? 'unknown' : 'todo'"
            >
              <span class="mark" aria-hidden="true">{{
                s.done === true ? '✓' : s.done === null ? '…' : ''
              }}</span>
              <span class="body">
                <span class="step-title">
                  {{ s.title }}
                  <span class="sr-only">{{
                    s.done === true ? '(done)' : s.done === null ? '(checking)' : '(to do)'
                  }}</span>
                </span>
                <span class="step-detail">{{ s.detail }}</span>
              </span>
              @if (next()?.id === s.id && canAct(s)) {
                <button type="button" class="btn btn-primary btn-sm" (click)="act(s.action)">
                  {{ s.actionLabel }}
                </button>
              }
            </li>
          }
        </ol>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .checklist {
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 12px);
        padding: var(--space-3, 12px) var(--space-4, 16px);
        background: var(--bg-primary);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .title {
        margin: 0;
        font-size: var(--text-base, 15px);
        font-weight: var(--font-semibold, 600);
      }
      .progress {
        font-size: var(--text-xs, 12px);
        color: var(--text-secondary);
      }
      .spacer {
        flex: 1;
      }
      .steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .step {
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }
      .mark {
        flex: 0 0 22px;
        height: 22px;
        border-radius: 50%;
        border: 1px solid var(--border);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .step[data-state='done'] .mark {
        border-color: var(--profit, #34c759);
        background: rgba(52, 199, 89, 0.12);
        color: var(--profit, #34c759);
      }
      .body {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .step-title {
        font-size: var(--text-sm, 13px);
        font-weight: 500;
      }
      .step[data-state='done'] .step-title {
        color: var(--text-secondary);
      }
      .step-detail {
        font-size: var(--text-xs, 12px);
        color: var(--text-secondary);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
    `,
  ],
})
export class FirstStrategyChecklistComponent {
  private readonly execution = inject(StrategyExecutionService);
  private readonly accountsApi = inject(TradingAccountsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly strategy = input.required<StrategyDto>();
  /** The strategy's backtest runs (the detail page's count); null while it loads. */
  readonly backtests = input<number | null>(null);
  /** Without operator access the steps are shown, their actions are not. */
  readonly canOperate = input(true);
  /** Paper trading can be started from here (a Draft, paused script strategy). */
  readonly canStartPaper = input(false);

  /** The operator asked to do a step: the page opens the editor, a tab, or starts paper trading. */
  readonly actionRequested = output<ChecklistAction>();

  readonly demoBound = signal<boolean | null>(null);
  readonly dismissed = signal(false);

  readonly steps = computed<ChecklistStep[]>(() => {
    const s = this.strategy();
    return checklistSteps({
      hasScript: !!s.scriptSource?.trim(),
      previewed: wasPreviewed(s.scriptSource),
      backtests: this.backtests(),
      lifecycleStage: s.lifecycleStage ?? null,
      demoBound: this.demoBound(),
    });
  });
  readonly next = computed(() => nextStep(this.steps()));
  readonly doneCount = computed(() => this.steps().filter((s) => s.done === true).length);
  readonly visible = computed(
    () =>
      !this.dismissed() &&
      !GRADUATED_STAGES.includes(this.strategy().lifecycleStage ?? '') &&
      this.next() !== null,
  );

  constructor() {
    effect(() => {
      const id = this.strategy().id;
      untracked(() => {
        this.dismissed.set(isChecklistDismissed(id));
        this.loadBindings(id);
      });
    });
  }

  private loadBindings(id: number): void {
    this.demoBound.set(null);
    forkJoin({
      bindings: this.execution.getAccountBindings(id),
      accounts: this.accountsApi
        .list({
          currentPage: 1,
          itemCountPerPage: 500,
          filter: null,
          sortBy: 'accountName',
          sortDirection: 'asc',
        })
        .pipe(catchError(() => of(null))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ bindings, accounts }) => {
          if (id !== this.strategy().id || !isOk(bindings)) return;
          const list = accounts && isOk(accounts) ? (accounts.data?.data ?? []) : [];
          const rows = toBindingRows(bindings.data ?? [], list);
          this.demoBound.set(rows.some((r) => r.isEnabled && !isLiveMoney(r.environment)));
        },
        error: () => {
          /* left unknown */
        },
      });
  }

  canAct(step: ChecklistStep): boolean {
    if (step.action === 'paper') return this.canOperate() && this.canStartPaper();
    if (step.action === 'edit') return this.canOperate();
    return true;
  }

  act(action: ChecklistAction): void {
    this.actionRequested.emit(action);
  }

  hide(): void {
    dismissChecklist(this.strategy().id);
    this.dismissed.set(true);
  }
}
