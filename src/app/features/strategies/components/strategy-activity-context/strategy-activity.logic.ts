/**
 * Why a strategy has produced no signals / orders / scores — derived ONLY from what the engine reports
 * about it (status, lifecycle stage, bindings, evidence runs, recorded gate attempts, rejections).
 */

export interface StrategyActivityFacts {
  id: number;
  name: string | null;
  symbol: string | null;
  timeframe: string | null;
  status: string | null;
  lifecycleStage: string | null;
  pauseReason: string | null;
  isScript: boolean;
  accountBindingCount: number | null;
  lastSignalAt: string | null;
  /** Backtests of the strategy, any market. */
  backtestCount: number | null;
  /** Newest backtest of any market. */
  newestBacktest: {
    id: number;
    symbol: string | null;
    trades: number | null;
    completedAt: string | null;
  } | null;
  /** Newest run on the strategy's OWN market (the one promotion reads); null = none. */
  ownMarketBacktestId: number | null;
  ownMarketBacktestReturnPct: number | null;
  walkForwardRunId: number | null;
  walkForwardOosScore: number | null;
  /** Newest recorded promotion attempt; null = never attempted. */
  lastGate: {
    outcome: string;
    passed: boolean;
    isVerdict: boolean;
    failureSummary: string | null;
    at: string;
  } | null;
  rejectionTotal: number | null;
  worstRejectionStage: string | null;
  worstRejectionReason: string | null;
}

export type ReasonTone = 'block' | 'info' | 'ok';

export interface ActivityReason {
  tone: ReasonTone;
  title: string;
  detail: string;
  /** Tab of the strategy detail page that acts on it, or a route. */
  tab?: string | null;
  route?: string | null;
}

const PAPER_STAGES = new Set(['PaperTrading', 'ShadowLive']);

export function activityReasons(f: StrategyActivityFacts): ActivityReason[] {
  const out: ActivityReason[] = [];
  const market = [f.symbol, f.timeframe].filter(Boolean).join(' ');

  if (f.status === 'Paused' || f.status === 'Stopped') {
    out.push({
      tone: 'block',
      title: f.status === 'Paused' ? 'Paused' : 'Stopped',
      detail:
        (f.pauseReason ? `Reason recorded: ${f.pauseReason}. ` : '') +
        (f.lifecycleStage === 'Approved' || PAPER_STAGES.has(f.lifecycleStage ?? '')
          ? 'Its live signals are simulated as paper executions; nothing is sent to an account until it is activated.'
          : 'A paused strategy is not evaluated on live bars, so it emits no signals and places no orders.'),
    });
  }

  switch (f.lifecycleStage) {
    case 'Draft':
      out.push({
        tone: 'block',
        title: 'Draft — not approved',
        detail:
          'Submit for approval runs the promotion gates on its evidence. An Approved strategy paper-trades; Activate then takes it live once paper evidence satisfies the graduation gate.',
        tab: 'promotion',
      });
      break;
    case 'PaperTrading':
    case 'ShadowLive':
      out.push({
        tone: 'info',
        title: f.lifecycleStage === 'PaperTrading' ? 'Paper-trading stage' : 'Shadow-live stage',
        detail:
          'Signals are recorded as paper executions to build forward evidence; none reach a broker.',
        route: '/paper-trading',
      });
      break;
    case 'Approved':
      if (f.status !== 'Active')
        out.push({
          tone: 'info',
          title: 'Approved, waiting to be activated',
          detail:
            'It passed the promotion gates and paper-trades while Paused. Activate it to trade live.',
          route: '/paper-trading',
        });
      break;
  }

  if (f.isScript && (f.accountBindingCount ?? 0) === 0) {
    out.push({
      tone: f.status === 'Active' ? 'block' : 'info',
      title: 'No account binding',
      detail:
        'A script strategy sends orders only to the accounts it is bound to; with none, even Active it never trades live.',
      tab: 'execution',
    });
  }

  if (f.backtestCount === 0) {
    out.push({
      tone: 'block',
      title: 'No backtest yet',
      detail: `There is no evidence to approve it on${market ? ' — queue a backtest on ' + market : ''}.`,
      tab: 'backtests',
    });
  } else if (f.newestBacktest && f.newestBacktest.trades === 0) {
    out.push({
      tone: 'info',
      title: 'Its newest backtest closed no trade',
      detail: `Run #${f.newestBacktest.id}${f.newestBacktest.symbol ? ' on ' + f.newestBacktest.symbol : ''} finished with 0 trades — its rules never placed an order on that history, so there is nothing to score.`,
      route: `/backtests/${f.newestBacktest.id}`,
    });
  }
  if (f.backtestCount && f.backtestCount > 0 && f.ownMarketBacktestId === null && market) {
    out.push({
      tone: 'info',
      title: `No completed backtest on its own market (${market})`,
      detail:
        'Promotion only reads runs of the strategy as deployed on its own symbol and timeframe at current costs.',
      tab: 'backtests',
    });
  }

  if (f.lastGate) {
    if (!f.lastGate.isVerdict)
      out.push({
        tone: 'info',
        title: `Last promotion attempt reached no verdict (${f.lastGate.outcome})`,
        detail: 'The gates did not finish — it was never judged, which is not a rejection.',
        tab: 'promotion',
      });
    else if (!f.lastGate.passed)
      out.push({
        tone: 'block',
        title: 'Last promotion attempt was rejected',
        detail: f.lastGate.failureSummary ?? 'One or more gates failed.',
        tab: 'promotion',
      });
  } else if (f.lifecycleStage === 'Draft') {
    out.push({
      tone: 'info',
      title: 'Never submitted for approval',
      detail: 'No promotion attempt is recorded for it.',
      tab: 'promotion',
    });
  }

  if (f.status === 'Active' && !f.lastSignalAt) {
    if ((f.rejectionTotal ?? 0) > 0)
      out.push({
        tone: 'block',
        title: `Signals were rejected (${f.rejectionTotal})`,
        detail: `Worst stage: ${f.worstRejectionStage ?? '—'}${f.worstRejectionReason ? ' — ' + f.worstRejectionReason : ''}.`,
        tab: 'rejections',
      });
    else
      out.push({
        tone: 'info',
        title: 'Active, conditions not met yet',
        detail: `It is evaluated on every ${market || 'bar'} close; its entry conditions have not fired since activation.`,
      });
  }

  if (out.length === 0)
    out.push({
      tone: 'ok',
      title: 'Nothing is holding it back',
      detail: 'It is Active and has signalled before.',
    });
  return out;
}

/** One-line headline for the context card. */
export function activityHeadline(f: StrategyActivityFacts): string {
  if (f.status === 'Active')
    return f.lastSignalAt ? 'Active and signalling' : 'Active — no signal yet';
  if (f.lifecycleStage === 'Draft') return 'Not trading: a paused draft';
  if (f.lifecycleStage === 'Approved' || PAPER_STAGES.has(f.lifecycleStage ?? ''))
    return 'Paper-trading only — nothing reaches an account';
  return `Not trading: ${(f.status ?? 'unknown').toLowerCase()}`;
}
