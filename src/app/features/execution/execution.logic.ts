import type {
  AlgoEvent,
  AlgoOrderStatus,
  AlgoOrderSummary,
  AllocationMember,
  BlockOrder,
  ExecutionAlgorithm,
  ExecutionKey,
  SaveAllocationGroup,
} from './execution.types';

/** Pure decisions of the execution pages (gaps program, execution). */

export const ALGORITHMS: ExecutionAlgorithm[] = ['Direct', 'TWAP', 'VWAP', 'Iceberg', 'Adaptive'];
export const ROUTER_MODES = ['Off', 'Suggest', 'Auto'] as const;

/** Plain words for each algorithm (ticket, strategy form). */
export const ALGORITHM_HELP: Record<ExecutionAlgorithm, string> = {
  Direct: 'One order, as always.',
  TWAP: 'Equal child orders spread evenly over the window.',
  VWAP: 'Child orders sized by the symbol’s hourly activity profile over the window.',
  Iceberg: 'Shows only the display size at a time; the next child goes out when the previous one has filled.',
  Adaptive: 'A TWAP whose slice count follows size against daily volume and the current spread.',
};

/** Filled share of the parent, 0–100. */
export function progressPct(o: Pick<AlgoOrderSummary, 'filledQuantity' | 'totalQuantity'>): number {
  if (!(o.totalQuantity > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((o.filledQuantity / o.totalQuantity) * 1000) / 10));
}

export function isActive(status: AlgoOrderStatus): boolean {
  return status === 'Working' || status === 'Paused';
}

export function statusTone(status: AlgoOrderStatus | string): 'ok' | 'warn' | 'bad' | 'muted' {
  switch (status) {
    case 'Working':
    case 'Completed':
    case 'Filled':
    case 'Allocated':
      return 'ok';
    case 'Paused':
    case 'Expired':
    case 'Open':
    case 'Pending':
    case 'Submitted':
    case 'PartialFill':
      return 'warn';
    case 'Failed':
    case 'Rejected':
      return 'bad';
    default:
      return 'muted';
  }
}

/** Slippage in words: positive pips are worse for the parent. */
export function slippageText(pips: number | null): string {
  if (pips === null || pips === undefined) return '—';
  if (pips === 0) return '0 pips';
  return `${pips > 0 ? '+' : ''}${pips} pips ${pips > 0 ? '(worse than arrival)' : '(better than arrival)'}`;
}

/** The algorithm a router decision named (its data.suggested), or null. */
export function routerSuggested(e: AlgoEvent): ExecutionAlgorithm | null {
  const s = e.data?.['suggested'];
  return typeof s === 'string' && (ALGORITHMS as string[]).includes(s) ? (s as ExecutionAlgorithm) : null;
}

// ── Settings keys ────────────────────────────────────────────────────────────────────────────────

export type ControlKind = 'bool' | 'mode' | 'number';

/** The engine's ConfigDataType name for a key (the JSON may carry the name or the number). */
export function dataTypeName(k: ExecutionKey): string {
  const t = k.dataType;
  if (typeof t === 'number') return ['String', 'Int', 'Decimal', 'Bool'][t] ?? 'String';
  return t;
}

export function controlKind(k: ExecutionKey): ControlKind {
  if (k.key === 'Execution:SmartRouter:Mode') return 'mode';
  return dataTypeName(k) === 'Bool' ? 'bool' : 'number';
}

/** The value in force: the stored one, else the default. */
export function effective(k: ExecutionKey): string {
  return (k.value ?? k.default).trim();
}

/** Bounds of each integer key (mirror of the engine's clamps in AlgoSettings). */
export const INT_BOUNDS: Record<string, [number, number]> = {
  'Execution:Algo:PollIntervalSeconds': [1, 60],
  'Execution:Algo:DefaultDurationSeconds': [60, 86_400],
  'Execution:Algo:DefaultSlices': [2, 50],
  'Execution:Algo:MaxDurationSeconds': [300, 86_400],
  'Execution:Algo:ChildTtlSeconds': [30, 3_600],
  'Execution:Algo:ChildStaleGraceSeconds': [60, 7_200],
  'Execution:Algo:MaxConsecutiveRefusals': [1, 20],
  'Execution:Algo:WindowGraceSeconds': [0, 3_600],
  'Execution:Algo:ResidueIntervalSeconds': [5, 600],
  'Execution:SmartRouter:MaxEvaluationsPerCycle': [1, 100],
};

/** What is wrong with a draft value, or null. */
export function valueProblem(k: ExecutionKey, raw: string): string | null {
  const v = raw.trim();
  switch (controlKind(k)) {
    case 'bool':
      return v === 'true' || v === 'false' ? null : 'true or false';
    case 'mode':
      return (ROUTER_MODES as readonly string[]).includes(v) ? null : 'Off, Suggest or Auto';
    default: {
      if (!/^-?\d+$/.test(v)) return 'a whole number';
      const n = Number(v);
      const b = INT_BOUNDS[k.key];
      if (b && (n < b[0] || n > b[1])) return `between ${b[0]} and ${b[1]}`;
      return null;
    }
  }
}

/** "Execution:Algo:ChildTtlSeconds" → "Child ttl seconds". */
export function keyLabel(key: string): string {
  const last = key.split(':').pop() ?? key;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Which card a key belongs to. */
export function keyGroup(key: string): 'Algorithms' | 'Smart router' | 'Block allocation' {
  if (key.startsWith('Execution:SmartRouter:')) return 'Smart router';
  if (key.startsWith('Execution:Allocation:')) return 'Block allocation';
  return 'Algorithms';
}

/** "3 min ago" from an ISO time. */
export function relative(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const t = Date.parse(iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now.getTime() - t) / 1000);
  const abs = Math.abs(s);
  const unit = abs < 60 ? `${abs} s` : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86_400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86_400)} d`;
  return s >= 0 ? `${unit} ago` : `in ${unit}`;
}

// ── Allocation groups ────────────────────────────────────────────────────────────────────────────

export function emptyGroup(): SaveAllocationGroup {
  return {
    name: '',
    description: null,
    strategyId: 0,
    method: 'ProRataEquity',
    blockLotMultiplier: 1,
    riskFraction: 0.01,
    maxKellyFraction: 0.02,
    averagePriceAllocation: true,
    isActive: true,
    members: [],
  };
}

/** What stops the editor saving, in plain words (empty = fine). */
export function groupProblems(g: SaveAllocationGroup): string[] {
  const out: string[] = [];
  if (!g.name.trim()) out.push('Give the group a name.');
  if (!(g.strategyId > 0)) out.push('Choose the strategy whose signals the group trades.');
  if (g.members.length === 0) out.push('Add at least one member account.');
  const ids = g.members.map((m) => m.tradingAccountId);
  if (new Set(ids).size !== ids.length) out.push('An account is listed twice.');
  if (g.members.some((m) => !(m.tradingAccountId > 0))) out.push('Every member needs an account.');
  if (g.members.some((m) => !(m.ratio > 0))) out.push('Every ratio must be positive.');
  if (!(g.blockLotMultiplier >= 0.01 && g.blockLotMultiplier <= 100)) out.push('Block multiplier: 0.01 to 100.');
  if (g.method === 'EqualRisk' && !(g.riskFraction > 0 && g.riskFraction <= 0.1))
    out.push('Risk per account: above 0 and at most 10 % of equity.');
  if (g.method === 'Kelly' && !(g.maxKellyFraction > 0 && g.maxKellyFraction <= 0.25))
    out.push('Kelly cap: above 0 and at most 25 % of equity.');
  return out;
}

export function toggleMember(members: AllocationMember[], accountId: number): AllocationMember[] {
  return members.some((m) => m.tradingAccountId === accountId)
    ? members.filter((m) => m.tradingAccountId !== accountId)
    : [...members, { tradingAccountId: accountId, ratio: 1, isActive: true }];
}

/** Σ of the block's fairness amounts (0 for a correct average-price allocation). */
export function fairnessSum(b: BlockOrder): number {
  return Math.round(b.allocations.reduce((s, a) => s + (a.fairnessAmount ?? 0), 0) * 10_000) / 10_000;
}

/** A ticket's algorithm fields for the request (only for a live ticket that chose one). */
export function ticketAlgoFields(
  mode: 'Paper' | 'Live',
  algorithm: ExecutionAlgorithm,
  durationMinutes: number | null,
  slices: number | null,
  displayLots: number | null,
): {
  executionAlgorithm?: ExecutionAlgorithm;
  algoDurationSeconds?: number | null;
  algoSlices?: number | null;
  algoDisplayQuantity?: number | null;
} {
  if (mode !== 'Live' || algorithm === 'Direct') return {};
  return {
    executionAlgorithm: algorithm,
    algoDurationSeconds: durationMinutes && durationMinutes > 0 ? Math.round(durationMinutes * 60) : null,
    algoSlices: algorithm === 'TWAP' || algorithm === 'VWAP' ? (slices && slices > 0 ? Math.round(slices) : null) : null,
    algoDisplayQuantity: algorithm === 'Iceberg' ? displayLots : null,
  };
}
