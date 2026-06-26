/** Categorises which code path produced an SL change row. */
export type SlChangeSource =
  | 'Initial'
  | 'Manual'
  | 'TrailingStop'
  | 'SpreadBump'
  | 'SpreadRevert'
  | 'SpreadRevertDrift'
  | 'BreakevenMove'
  | 'SalvageExit'
  | 'Reconciliation'
  | 'LlmExit';

export const ALL_SL_CHANGE_SOURCES: SlChangeSource[] = [
  'Initial',
  'Manual',
  'TrailingStop',
  'SpreadBump',
  'SpreadRevert',
  'SpreadRevertDrift',
  'BreakevenMove',
  'SalvageExit',
  'Reconciliation',
  'LlmExit',
];

/** Position side — mirrors the engine `PositionDirection` enum. */
export type PositionDirection = 'Long' | 'Short';

/** One row of the SL audit feed. */
export interface PositionSlChangeLog {
  id: number;
  positionId: number;
  tradingAccountId: number;
  symbol: string;
  /** Position side at change time — immutable post-open. */
  direction: PositionDirection;
  /** Weighted-average entry price at change time. */
  entryPrice: number | null;
  /** UTC ISO of when the position opened. */
  openedAt: string | null;
  /** SL the position opened with — constant per position. */
  initialSl: number | null;
  oldSl: number | null;
  newSl: number | null;
  source: SlChangeSource;
  reason: string | null;
  changedByUserId: number | null;
  changedByWorker: string | null;
  spread: number | null;
  /** UTC ISO timestamp the change was recorded. */
  createdAt: string;
}

/** Query body for `POST /position/sl-history/list`. */
export interface SlAuditQuery {
  positionId?: number;
  tradingAccountId?: number;
  symbol?: string;
  source?: SlChangeSource | '';
  /** UTC ISO timestamp, inclusive. */
  from?: string;
  /** UTC ISO timestamp, inclusive. */
  to?: string;
  pageNumber: number;
  pageSize: number;
}
