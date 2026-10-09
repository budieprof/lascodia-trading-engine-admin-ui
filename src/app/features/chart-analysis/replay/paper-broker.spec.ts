import { describe, expect, it } from 'vitest';
import { PaperBook, levelsProblem, pnlOf, unitOf, type PaperUnit } from './paper-broker';

const sym = { pipSize: 0.0001, contractSize: 100_000 };
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
