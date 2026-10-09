import type { Bar } from '../datafeed/candle-feed.service';

/**
 * Bar Replay's paper trading (CC-I4): a browser-only simulation. Nothing here reaches the engine — no signal, no
 * order, no paper execution row; the trades live in the page and go when replay ends.
 *
 * Prices are the engine's: bars are BID (MT5 FX bars and quotes, contract C1), so a buy fills at the ask = bid +
 * the bar's recorded spread, a sell at the bid; a long position's stop and target are hit by the bid, a short
 * one's by the ask. Each price unit replay reveals (an intrabar bar, or a whole bar where none were shown) is
 * checked in order. Inside one unit the order of its high and low is unknown: when both the stop and the target
 * are inside it, the stop is taken (the worse outcome). A unit that opens past a level fills at its open.
 */

export type PaperSide = 'buy' | 'sell';

export interface PaperTrade {
  id: number;
  side: PaperSide;
  lots: number;
  /** Fill price: the ask for a buy, the bid for a sell. */
  entry: number;
  /** The spread paid at the entry, in price. */
  entrySpread: number;
  stop: number | null;
  target: number | null;
  /** The replay instant it opened at (UTC ms): the head's last revealed unit. */
  openedAt: number;
  /** Set once closed. */
  exit?: number;
  closedAt?: number;
  reason?: 'stop' | 'target' | 'manual';
}

/** One price unit, as the paper broker reads it: a bid bar and the spread (in price) to add for the ask. */
export interface PaperUnit {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  spread: number;
}

/** What a trade made: pips, money in the quote currency, R against its opening stop (null without one). */
export interface PaperPnl {
  pips: number;
  money: number;
  r: number | null;
}

export interface PaperTally {
  trades: number;
  wins: number;
  losses: number;
  pips: number;
  money: number;
  /** Sum of R over the closed trades that had a stop. */
  r: number;
  /** Open trades' P&L at the head. */
  openPips: number;
  openMoney: number;
}

/** The symbol facts a P&L needs. */
export interface PaperSymbol {
  pipSize: number;
  /** Units per lot (100,000 on FX). */
  contractSize: number;
}

const dirOf = (side: PaperSide): 1 | -1 => (side === 'buy' ? 1 : -1);

/**
 * The spread of a unit, in price: its recorded spread (MT5 points × 10^-digits) when it has one, else
 * `fallbackPoints` (the last one recorded), else 0.
 */
export function unitOf(bar: Bar, digits: number, fallbackPoints: number | null): PaperUnit {
  const points = bar.spreadPoints ?? fallbackPoints ?? 0;
  return {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    spread: points * 10 ** -digits,
  };
}

/** A trade's result at an exit price (for an open one: the price it would close at now). */
export function pnlOf(t: PaperTrade, exit: number, sym: PaperSymbol): PaperPnl {
  const diff = (exit - t.entry) * dirOf(t.side);
  const risk = t.stop !== null ? Math.abs(t.entry - t.stop) : 0;
  return {
    pips: sym.pipSize > 0 ? diff / sym.pipSize : 0,
    money: diff * t.lots * sym.contractSize,
    r: risk > 0 ? diff / risk : null,
  };
}

/** Where an open trade closes at `unit`'s close: a long sells at the bid, a short buys at the ask. */
export function markOf(t: PaperTrade, unit: PaperUnit): number {
  return t.side === 'buy' ? unit.close : unit.close + unit.spread;
}

/**
 * Why a stop / target is refused for a market order at `head`: a buy's stop must be below its ask and its target
 * above; a sell's the other way. Null when they are fine.
 */
export function levelsProblem(side: PaperSide, head: PaperUnit, stop: number | null, target: number | null): string | null {
  const entry = side === 'buy' ? head.close + head.spread : head.close;
  if (stop !== null && (side === 'buy' ? stop >= entry : stop <= entry))
    return side === 'buy' ? 'A buy’s stop must be below the ask.' : 'A sell’s stop must be above the bid.';
  if (target !== null && (side === 'buy' ? target <= entry : target >= entry))
    return side === 'buy' ? 'A buy’s target must be above the ask.' : 'A sell’s target must be below the bid.';
  return null;
}

/**
 * The paper account of one replay: open and closed trades, filled against the units replay reveals. Rewinding
 * (replay stepped back) undoes everything after the new head — trades opened later go, trades closed later are
 * open again — so stepping forward again replays them the same way.
 */
export class PaperBook {
  private seq = 0;
  private list: PaperTrade[] = [];

  trades(): readonly PaperTrade[] {
    return this.list;
  }

  open(): PaperTrade[] {
    return this.list.filter((t) => t.exit === undefined);
  }

  closed(): PaperTrade[] {
    return this.list.filter((t) => t.exit !== undefined);
  }

  /** A market order at the head: a buy at its ask, a sell at its bid. */
  place(side: PaperSide, lots: number, head: PaperUnit, stop: number | null, target: number | null): PaperTrade {
    const trade: PaperTrade = {
      id: ++this.seq,
      side,
      lots,
      entry: side === 'buy' ? head.close + head.spread : head.close,
      entrySpread: head.spread,
      stop,
      target,
      openedAt: head.time,
    };
    this.list = [...this.list, trade];
    return trade;
  }

  /** Close an open trade at the head's price. */
  close(id: number, head: PaperUnit): PaperTrade | null {
    const t = this.list.find((x) => x.id === id && x.exit === undefined);
    if (!t) return null;
    const closed: PaperTrade = { ...t, exit: markOf(t, head), closedAt: head.time, reason: 'manual' };
    this.list = this.list.map((x) => (x.id === id ? closed : x));
    return closed;
  }

  /** Check the open trades against units revealed in order; returns the trades this closed. */
  advance(units: readonly PaperUnit[]): PaperTrade[] {
    const done: PaperTrade[] = [];
    if (!units.length) return done;
    let list = this.list;
    for (const u of units) {
      list = list.map((t) => {
        if (t.exit !== undefined || u.time <= t.openedAt) return t;
        const hit = exitIn(t, u);
        if (!hit) return t;
        const closed: PaperTrade = { ...t, exit: hit.price, closedAt: u.time, reason: hit.reason };
        done.push(closed);
        return closed;
      });
    }
    this.list = list;
    return done;
  }

  /** Undo everything after `timeMs` (replay stepped back to it). */
  rewind(timeMs: number): void {
    this.list = this.list
      .filter((t) => t.openedAt <= timeMs)
      .map((t) => {
        if (t.closedAt === undefined || t.closedAt <= timeMs) return t;
        const reopened: PaperTrade = { ...t };
        delete reopened.exit;
        delete reopened.closedAt;
        delete reopened.reason;
        return reopened;
      });
  }

  clear(): void {
    this.list = [];
  }

  /** Closed trades' totals, and the open ones at `head`. */
  tally(sym: PaperSymbol, head: PaperUnit | null): PaperTally {
    const out: PaperTally = { trades: 0, wins: 0, losses: 0, pips: 0, money: 0, r: 0, openPips: 0, openMoney: 0 };
    for (const t of this.list) {
      if (t.exit !== undefined) {
        const p = pnlOf(t, t.exit, sym);
        out.trades++;
        if (p.money > 0) out.wins++;
        else if (p.money < 0) out.losses++;
        out.pips += p.pips;
        out.money += p.money;
        out.r += p.r ?? 0;
      } else if (head) {
        const p = pnlOf(t, markOf(t, head), sym);
        out.openPips += p.pips;
        out.openMoney += p.money;
      }
    }
    return out;
  }
}

/** Where and why an open trade closes in `u`, if it does. */
function exitIn(t: PaperTrade, u: PaperUnit): { price: number; reason: 'stop' | 'target' } | null {
  if (t.side === 'buy') {
    // A long exits by selling at the bid.
    if (t.stop !== null && u.low <= t.stop) return { price: Math.min(t.stop, u.open), reason: 'stop' };
    if (t.target !== null && u.high >= t.target) return { price: Math.max(t.target, u.open), reason: 'target' };
    return null;
  }
  // A short exits by buying at the ask = bid + spread.
  const s = u.spread;
  if (t.stop !== null && u.high + s >= t.stop) return { price: Math.max(t.stop, u.open + s), reason: 'stop' };
  if (t.target !== null && u.low + s <= t.target) return { price: Math.min(t.target, u.open + s), reason: 'target' };
  return null;
}
