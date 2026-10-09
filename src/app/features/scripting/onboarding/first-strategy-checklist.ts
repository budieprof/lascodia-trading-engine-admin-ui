/**
 * The first-strategy checklist (PE-I9): the path from a script to trading on a demo account —
 * save a compiling script, preview it, backtest it, paper-trade it, bind a demo account — with
 * what each step needs and where to do it.
 */

export type ChecklistStepId = 'compile' | 'preview' | 'backtest' | 'paper' | 'demo';

/** Where a step is done: the editor, the Backtests tab, the paper-trading button, the Execution tab. */
export type ChecklistAction = 'edit' | 'backtests' | 'paper' | 'execution';

export interface ChecklistStep {
  id: ChecklistStepId;
  title: string;
  detail: string;
  /** null while it is not known yet (still loading). */
  done: boolean | null;
  action: ChecklistAction;
  actionLabel: string;
}

export interface ChecklistFacts {
  /** The strategy has a saved script (a save compiles it first). */
  hasScript: boolean;
  /** This browser ran a Preview of the saved script. */
  previewed: boolean;
  /** Completed or queued backtest runs; null while loading. */
  backtests: number | null;
  lifecycleStage: string | null;
  /** An enabled binding to a demo, contest or paper account; null while loading. */
  demoBound: boolean | null;
}

/** Stages past paper trading: the checklist has nothing left to say. */
export const GRADUATED_STAGES: readonly string[] = ['ShadowLive', 'Approved', 'Active'];

const PAPER_OR_LATER = ['PaperTrading', 'BacktestQualified', ...GRADUATED_STAGES];

export function checklistSteps(f: ChecklistFacts): ChecklistStep[] {
  return [
    {
      id: 'compile',
      title: 'Save a script that compiles',
      detail: 'The engine compiles every save; errors are shown in the editor.',
      done: f.hasScript,
      action: 'edit',
      actionLabel: 'Edit script',
    },
    {
      id: 'preview',
      title: 'Preview it',
      detail:
        'Run the saved script over recent bars in the editor: check its plots, trades and Strategy report look right.',
      done: f.previewed,
      action: 'edit',
      actionLabel: 'Open the editor',
    },
    {
      id: 'backtest',
      title: 'Backtest it',
      detail:
        'A backtest over a long window with the engine’s costs — then read its R analysis before trusting it.',
      done: f.backtests === null ? null : f.backtests > 0,
      action: 'backtests',
      actionLabel: 'Go to Backtests',
    },
    {
      id: 'paper',
      title: 'Paper-trade it',
      detail: 'Its live signals are recorded as paper executions; nothing reaches an account.',
      done: PAPER_OR_LATER.includes(f.lifecycleStage ?? ''),
      action: 'paper',
      actionLabel: 'Start paper trading',
    },
    {
      id: 'demo',
      title: 'Bind a demo account',
      detail:
        'Trade it on a demo account before any real one: a script strategy with no binding never trades live.',
      done: f.demoBound,
      action: 'execution',
      actionLabel: 'Go to Execution',
    },
  ];
}

/** The first step not done (unknown counts as not done), or null when every step is done. */
export function nextStep(steps: readonly ChecklistStep[]): ChecklistStep | null {
  return steps.find((s) => s.done !== true) ?? null;
}

export const CHECKLIST_DISMISSED_PREFIX = 'lascodia.pine.checklist.hidden.v1:';

export function isChecklistDismissed(strategyId: number): boolean {
  try {
    return globalThis.localStorage?.getItem(CHECKLIST_DISMISSED_PREFIX + strategyId) === '1';
  } catch {
    return false;
  }
}

export function dismissChecklist(strategyId: number): void {
  try {
    globalThis.localStorage?.setItem(CHECKLIST_DISMISSED_PREFIX + strategyId, '1');
  } catch {
    /* storage unavailable: it hides for this visit only */
  }
}
