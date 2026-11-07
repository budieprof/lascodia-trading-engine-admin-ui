import { describe, expect, it } from 'vitest';
import { PaperBook, levelsProblem, pnlOf, unitOf, type PaperTrade, type PaperUnit } from './paper-broker';

const sym = { pipSize: 0.0001, unitLabel: 'pips', valuePerPrice: 100_000 };
const u = (time: number, o: number, h: number, l: number, c: number, spread = 0.0001): PaperUnit => ({
  time,
  open: o,
  high: h,
  low: l,
  close: c,
  spread,
});

describe('unitOf', () => {
  it('turns recorded MT5 points into price, falling back to the last recorded spread', () => {
    const bar = { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 };
    expect(unitOf({ ...bar, spreadPoints: 12 }, 5, null).spread).toBeCloseTo(0.00012, 10);
    expect(unitOf(bar, 5, 8).spread).toBeCloseTo(0.00008, 10);
    expect(unitOf(bar, 3, null).spread).toBe(0);
  });
});

describe('PaperBook', () => {
  it('buys at the ask and sells at the bid', () => {
    const book = new PaperBook();
    const head = u(10, 1.1, 1.1, 1.1, 1.1);
    expect(book.place('buy', 1, head, null, null).entry).toBeCloseTo(1.1001, 10);
    expect(book.place('sell', 1, head, null, null).entry).toBe(1.1);
  });

  it('closes a long on its stop at the bid, and takes the stop when a unit holds both levels', () => {
    const book = new PaperBook();
    const t = book.place('buy', 1, u(10, 1.1, 1.1, 1.1, 1.1), 1.098, 1.103);
    // Not checked against the unit it opened in.
    expect(book.advance([u(10, 1.1, 1.2, 1.0, 1.1)])).toEqual([]);
    const done = book.advance([u(11, 1.1, 1.104, 1.097, 1.1)]);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: t.id, exit: 1.098, reason: 'stop', closedAt: 11 });
    const p = pnlOf(done[0], done[0].exit!, sym);
    expect(p.pips).toBeCloseTo(-21, 6); // entry 1.1001 (the ask) → 1.0980
    expect(p.money).toBeCloseTo(-210, 6); // −0.0021 × 1 lot × 100,000
    expect(p.r).toBeCloseTo(-1, 6); // the risk is entry → stop
  });

  it('closes a short when the ASK reaches its levels, and fills a gap at the open', () => {
    const book = new PaperBook();
    book.place('sell', 0.5, u(10, 1.2, 1.2, 1.2, 1.2), 1.205, 1.19);
    // Bid high 1.2045 + spread 0.0001 = ask 1.2046: not yet.
    expect(book.advance([u(11, 1.2, 1.2045, 1.199, 1.2)])).toEqual([]);
    // Bid low 1.1899 + spread = ask 1.19: target.
    expect(book.advance([u(12, 1.195, 1.196, 1.1899, 1.19)])[0]).toMatchObject({ exit: 1.19, reason: 'target' });

    const gap = new PaperBook();
    gap.place('sell', 1, u(10, 1.2, 1.2, 1.2, 1.2), 1.205, null);
    expect(gap.advance([u(11, 1.21, 1.212, 1.208, 1.21)])[0].exit).toBeCloseTo(1.2101, 10);
  });

  it('closes by hand at the exit side and tallies wins, losses, pips, money and R', () => {
    const book = new PaperBook();
    const a = book.place('buy', 1, u(10, 1.1, 1.1, 1.1, 1.1, 0), 1.099, null);
    book.place('sell', 1, u(10, 1.1, 1.1, 1.1, 1.1, 0), null, null);
    book.close(a.id, u(20, 1.102, 1.102, 1.102, 1.102, 0));
    const tally = book.tally(sym, u(20, 1.102, 1.102, 1.102, 1.102, 0.0001));
    expect(tally).toMatchObject({ trades: 1, wins: 1, losses: 0 });
    expect(tally.pips).toBeCloseTo(20, 6);
    expect(tally.r).toBeCloseTo(2, 6);
    // The open short marks at the ask: 1.1 − 1.1021 = −21 pips.
    expect(tally.openPips).toBeCloseTo(-21, 6);
  });

  it('rewinds: trades opened later go, trades closed later reopen', () => {
    const book = new PaperBook();
    const a = book.place('buy', 1, u(10, 1.1, 1.1, 1.1, 1.1), 1.09, null);
    book.advance([u(15, 1.1, 1.1, 1.08, 1.085)]);
    book.place('sell', 1, u(16, 1.085, 1.085, 1.085, 1.085), null, null);
    book.rewind(12);
    expect(book.trades()).toHaveLength(1);
    expect(book.open().map((t) => t.id)).toEqual([a.id]);
  });
});

describe('levelsProblem', () => {
  it('refuses levels on the wrong side of the fill', () => {
    const head = u(1, 1.1, 1.1, 1.1, 1.1);
    expect(levelsProblem('buy', head, 1.2, null)).toMatch(/below the ask/);
    expect(levelsProblem('sell', head, null, 1.2)).toMatch(/below the bid/);
    expect(levelsProblem('buy', head, 1.09, 1.11)).toBeNull();
  });
});

describe('paper money in the instrument\'s own terms (UI03)', () => {
  const trade = (over: Partial<PaperTrade>): PaperTrade => ({
    id: 1,
    side: 'buy',
    lots: 1,
    entry: 100,
    entrySpread: 0,
    stop: null,
    target: null,
    openedAt: 0,
    ...over,
  });

  it('FX: diff × lots × 100 000, exactly the old formula', () => {
    const t = trade({ entry: 1.1, lots: 0.5 });
    expect(pnlOf(t, 1.1012, sym).money).toBe((1.1012 - 1.1) * 0.5 * 100_000);
  });

  it('BTC spot (linear): move × coins', () => {
    const btc = { pipSize: 0.01, unitLabel: 'points', valuePerPrice: 1 };
    const p = pnlOf(trade({ entry: 60_000, lots: 0.015 }), 61_000, btc);
    expect(p.money).toBeCloseTo(15, 9);
    expect(p.pips).toBeCloseTo(100_000, 6);
  });

  it('ES future: 4 ticks a point × $12.50 = $50 a point per contract', () => {
    const es = { pipSize: 0.25, unitLabel: 'ticks', valuePerPrice: 50 };
    const p = pnlOf(trade({ entry: 5000, lots: 2, side: 'sell' }), 4990, es);
    expect(p.money).toBeCloseTo(1000, 9);
    expect(p.pips).toBeCloseTo(40, 9);
  });

  it('inverse perpetual: contracts × value × (1/entry − 1/exit), in the coin', () => {
    const inv = { pipSize: 0.5, unitLabel: 'points', valuePerPrice: null, inverse: true, contractValue: 100 };
    const long = pnlOf(trade({ entry: 50_000, lots: 10 }), 60_000, inv);
    expect(long.money).toBeCloseTo(10 * 100 * (1 / 50_000 - 1 / 60_000), 12);
    const short = pnlOf(trade({ entry: 50_000, lots: 10, side: 'sell' }), 60_000, inv);
    expect(short.money).toBeCloseTo(-long.money!, 12);
  });

  it('unknown money stays unknown — the tally says so instead of counting an FX lot', () => {
    const unknown = { pipSize: 0.01, unitLabel: 'points', valuePerPrice: null };
    expect(pnlOf(trade({}), 101, unknown).money).toBeNull();
    const book = new PaperBook();
    const head = { time: 1, open: 100, high: 100, low: 100, close: 100, spread: 0 };
    const t = book.place('buy', 1, head, null, null);
    book.close(t.id, { ...head, time: 2, close: 101 });
    const tally = book.tally(unknown, null);
    expect(tally.money).toBeNull();
    expect(tally.wins).toBe(1);
  });
});
