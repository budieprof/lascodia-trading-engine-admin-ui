import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TICKET,
  defaultBrackets,
  firstRefusal,
  flipBrackets,
  marketEntry,
  moveTicketLine,
  stopGuardProblem,
  ticketEntry,
  ticketLines,
  ticketRequest,
  type TicketState,
} from './ticket-model';
import { grabbedTradeLine, roundPrice, tradeDragPrice, type TradeLine } from './trade-lines';

const quote = { bid: 1.1, ask: 1.1001 };
const state = (over: Partial<TicketState> = {}): TicketState => ({
  ...DEFAULT_TICKET,
  accountId: 17,
  ...over,
});

describe('ticket model (SP-I4)', () => {
  it('enters a market buy at the ask and a market sell at the bid', () => {
    expect(marketEntry('Buy', quote)).toBe(1.1001);
    expect(marketEntry('Sell', quote)).toBe(1.1);
    expect(marketEntry('Buy', { bid: 1.1, ask: null })).toBe(1.1);
    expect(marketEntry('Buy', null)).toBeNull();
    expect(ticketEntry(state({ atMarket: false, entry: 1.095 }), quote)).toBe(1.095);
  });

  it('asks for a market ticket without an entry price, and for nothing without an account', () => {
    expect(ticketRequest(state({ stop: 1.097, target: 1.106 }), 'EURUSD')).toEqual({
      tradingAccountId: 17,
      symbol: 'EURUSD',
      direction: 'Buy',
      entryPrice: null,
      stopLoss: 1.097,
      takeProfit: 1.106,
      mode: 'Paper',
    });
    expect(ticketRequest(state({ atMarket: false, entry: 1.095 }), 'EURUSD')!.entryPrice).toBe(
      1.095,
    );
    expect(ticketRequest({ ...DEFAULT_TICKET }, 'EURUSD')).toBeNull();
  });

  it('defaults to paper', () => expect(DEFAULT_TICKET.mode).toBe('Paper'));

  it('places default brackets 1.5 ATR away with a 2R target, on the right sides', () => {
    expect(defaultBrackets('Buy', 1.1, 0.002, 5)).toEqual({ stop: 1.097, target: 1.106 });
    expect(defaultBrackets('Sell', 1.1, 0.002, 5)).toEqual({ stop: 1.103, target: 1.094 });
    expect(defaultBrackets('Buy', 1.1, 0, 5)).toBeNull();
  });

  it('mirrors the brackets when the direction flips', () => {
    expect(flipBrackets(1.1, 1.097, 1.106, 5)).toEqual({ stop: 1.103, target: 1.094 });
    expect(flipBrackets(1.1, null, 1.106, 5)).toEqual({ stop: null, target: 1.094 });
  });

  describe('stop guard (refused in the chart before the engine is asked)', () => {
    it('refuses no stop, a stop on the wrong side, and a stop inside the ATR guard', () => {
      expect(stopGuardProblem('Buy', 1.1, null, 0.002, 1, 5)).toContain('Set a stop loss');
      expect(stopGuardProblem('Buy', 1.1, 1.101, 0.002, 1, 5)).toContain('below the entry');
      expect(stopGuardProblem('Sell', 1.1, 1.099, 0.002, 1, 5)).toContain('above the entry');
      const tight = stopGuardProblem('Buy', 1.1, 1.099, 0.002, 1, 5);
      expect(tight).toContain('0.50 ATR');
      expect(tight).toContain('1.09800');
    });

    it('accepts a stop at or beyond the guard, and cannot judge without an ATR', () => {
      expect(stopGuardProblem('Buy', 1.1, 1.098, 0.002, 1, 5)).toBeNull();
      expect(stopGuardProblem('Sell', 1.1, 1.103, 0.002, 1.5, 5)).toBeNull();
      expect(stopGuardProblem('Buy', 1.1, 1.0999, null, 1, 5)).toBeNull();
    });
  });

  it('names the first blocking refusal and ignores information-only failures', () => {
    expect(
      firstRefusal([
        {
          key: 'eaSafety',
          name: 'EA',
          passed: false,
          blocking: false,
          detail: 'paper: shown only',
        },
        { key: 'tier2', name: 'Tier 2', passed: false, blocking: true, detail: 'margin' },
      ])?.detail,
    ).toBe('margin');
    expect(
      firstRefusal([{ key: 'x', name: 'x', passed: true, blocking: true, detail: '' }]),
    ).toBeNull();
  });

  it('draws the brackets as draggable lines, the entry only away from the market', () => {
    const lines = ticketLines(state({ stop: 1.097, target: 1.106 }), 1.1001, 0.0001, null);
    expect(lines.map((l) => l.kind)).toEqual(['ticketStop', 'ticketTarget']);
    expect(lines.every((l) => l.draggable && l.drawn)).toBe(true);
    expect(lines[0].label).toBe('BUY SL 31.0p');
    const pending = ticketLines(
      state({ atMarket: false, entry: 1.095, stop: 1.092 }),
      1.095,
      0.0001,
      null,
    );
    expect(pending.map((l) => l.kind)).toEqual(['ticketEntry', 'ticketStop']);
  });

  it('applies a dragged bracket to the ticket; dragging the entry leaves the market', () => {
    const s = state({ stop: 1.097 });
    expect(moveTicketLine(s, 'ticketStop', 1.096).stop).toBe(1.096);
    expect(moveTicketLine(s, 'ticketTarget', 1.11).target).toBe(1.11);
    expect(moveTicketLine(s, 'ticketEntry', 1.095)).toMatchObject({
      atMarket: false,
      entry: 1.095,
    });
    expect(moveTicketLine(s, 'positionStop', 1)).toBe(s);
  });
});

describe('trade lines', () => {
  const line = (key: string, price: number, draggable = true): TradeLine => ({
    key,
    kind: 'ticketStop',
    price,
    label: key,
    color: '#f00',
    draggable,
    drawn: true,
  });
  const toY = (p: number) => (1.2 - p) * 10_000; // 1 pip = 1 px

  it('grabs the nearest draggable line within the tolerance', () => {
    const lines = [line('a', 1.1), line('b', 1.1004), line('c', 1.1002, false)];
    expect(grabbedTradeLine(lines, toY(1.1001), toY)?.key).toBe('a');
    expect(grabbedTradeLine(lines, toY(1.1003), toY)?.key).toBe('b');
    expect(grabbedTradeLine(lines, toY(1.101), toY)).toBeNull();
  });

  it('rounds a drop to the symbol digits and refuses off-scale pixels', () => {
    expect(roundPrice(1.0975499, 5)).toBe(1.09755);
    expect(tradeDragPrice(10, () => 1.0975512, 5)).toBe(1.09755);
    expect(tradeDragPrice(10, () => null, 5)).toBeNull();
    expect(tradeDragPrice(10, () => -1, 5)).toBeNull();
  });
});
