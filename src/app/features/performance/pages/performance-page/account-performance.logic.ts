import type {
  AccountPerformanceSeriesDto,
  AttributionSliceDto,
} from '@core/services/performance.service';

/** Totals over the accounts in the window. Money is summed per currency; `currency` is null when mixed. */
export interface AccountTotals {
  accounts: number;
  activeAccounts: number;
  currency: string | null;
  endEquity: number;
  equityChange: number;
  realizedPnl: number;
  executionCosts: number;
  trades: number;
  /** Trade-weighted win rate (fraction), null with no trades. */
  winRate: number | null;
  /** Equity-weighted compounded return over the window (fraction), null with no starting equity. */
  weightedReturn: number | null;
}

export function accountTotals(accounts: readonly AccountPerformanceSeriesDto[]): AccountTotals {
  const currencies = new Set(accounts.map((a) => a.currency || 'USD'));
  let trades = 0;
  let wins = 0;
  let start = 0;
  let weighted = 0;
  for (const a of accounts) {
    trades += a.trades;
    if (a.winRate != null) wins += a.winRate * a.trades;
    if (a.startEquity > 0) {
      start += a.startEquity;
      weighted += a.startEquity * a.compoundedReturn;
    }
  }
  return {
    accounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.isActive).length,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    endEquity: sum(accounts, (a) => a.endEquity),
    equityChange: sum(accounts, (a) => a.equityChange),
    realizedPnl: sum(accounts, (a) => a.realizedPnl),
    executionCosts: sum(accounts, (a) => a.executionCosts),
    trades,
    winRate: trades > 0 ? wins / trades : null,
    weightedReturn: start > 0 ? weighted / start : null,
  };
}

/**
 * Growth of 100 per account: compounds each day's return so accounts of very different size
 * (a 66k and a 1.6k account) share one axis. Points are [ISO date, value].
 */
export function growthOf100(a: AccountPerformanceSeriesDto): [string, number][] {
  let v = 100;
  const out: [string, number][] = [];
  for (const d of a.daily) {
    v *= 1 + (Number.isFinite(d.dailyReturn) ? d.dailyReturn : 0);
    out.push([d.date, Math.round(v * 100) / 100]);
  }
  return out;
}

/** Slices that actually carry something — a zero-trade, zero-P&L slice is noise in a ranked list. */
export function meaningfulSlices(slices: readonly AttributionSliceDto[]): AttributionSliceDto[] {
  return slices.filter((s) => s.trades > 0 || Math.abs(s.pnl) >= 0.005);
}

/** Best and worst day across accounts (by daily return), for the summary strip. */
export function extremeDays(accounts: readonly AccountPerformanceSeriesDto[]): {
  best: DayRef | null;
  worst: DayRef | null;
} {
  let best: DayRef | null = null;
  let worst: DayRef | null = null;
  for (const a of accounts) {
    for (const d of a.daily) {
      const ref = {
        account: a.accountName || `#${a.tradingAccountId}`,
        date: d.date,
        ret: d.dailyReturn,
      };
      if (!best || d.dailyReturn > best.ret) best = ref;
      if (!worst || d.dailyReturn < worst.ret) worst = ref;
    }
  }
  return { best, worst };
}

export interface DayRef {
  account: string;
  date: string;
  ret: number;
}

function sum<T>(rows: readonly T[], f: (r: T) => number): number {
  return rows.reduce((s, r) => s + (Number.isFinite(f(r)) ? f(r) : 0), 0);
}
