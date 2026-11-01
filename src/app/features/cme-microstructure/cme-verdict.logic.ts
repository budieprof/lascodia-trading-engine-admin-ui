import type { CmeExperimentRunDto } from '@features/cme-microstructure/cme-microstructure.types';

/** How one recorded run reads in the history table and the page headline. */
export interface RunVerdict {
  state: 'real' | 'proxy' | 'ambiguous' | 'skipped';
  icon: string;
  label: string;
  title: string;
}

type VerdictFields = Pick<
  CmeExperimentRunDto,
  | 'ran'
  | 'reason'
  | 'aggregateAndPerTradeDisagree'
  | 'oosNetPnlDelta'
  | 'oosPnlPerTradeDelta'
  | 'realNetPnl'
  | 'proxyNetPnl'
>;

/**
 * Verdict for a recorded run. Mirrors the live verdict card: a run where real beat the proxy on
 * both deltas but BOTH arms lost money is "Real lost less", never a green "Real ahead" — it shows
 * which way a losing system fails, not that real flow carries edge.
 */
export function runVerdict(r: VerdictFields): RunVerdict {
  if (!r.ran) {
    return { state: 'skipped', icon: '○', label: r.reason || 'not scored', title: 'Not scored' };
  }
  if (r.aggregateAndPerTradeDisagree) {
    return {
      state: 'ambiguous',
      icon: '⚠',
      label: 'Inconclusive',
      title: 'Net and per-trade deltas favour different arms — selectivity, not signal quality.',
    };
  }
  if (r.oosNetPnlDelta > 0 && r.oosPnlPerTradeDelta > 0) {
    if (r.realNetPnl < 0 && r.proxyNetPnl < 0) {
      return {
        state: 'ambiguous',
        icon: '▲',
        label: 'Real lost less',
        title:
          'Real beat the proxy on both deltas, but both arms lost money — this measures which way a losing system fails, not whether real flow carries edge.',
      };
    }
    return {
      state: 'real',
      icon: '▲',
      label: 'Real ahead',
      title: 'Real flow beat the proxy on both net and per-trade PnL.',
    };
  }
  return {
    state: 'proxy',
    icon: '▼',
    label: 'Proxy ahead',
    title: 'The tick-rule proxy did at least as well as real flow.',
  };
}

/** Signed USD with two decimals and a true minus sign: "+3,450.00", "−0.31", "0.00". */
export function signedUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (abs === '0.00') return abs;
  return (v > 0 ? '+' : '−') + abs;
}
