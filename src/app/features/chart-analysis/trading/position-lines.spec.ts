import { describe, expect, it } from 'vitest';

import type { OrderDto } from '@core/api/api.types';

import type { ChartPosition } from '../overlays/trade-layer';
import {
  actionableLines,
  dragSideProblem,
  canMoveOrderEntry,
  livePending,
  movedOrderLevels,
  newCorrelationId,
  PENDING_TIMEOUT_MS,
  pendingLines,
  type PendingChange,
} from './position-lines';
import { grabbedTradeLine } from './trade-lines';

const pos = (over: Partial<ChartPosition> = {}): ChartPosition =>
  ({
    id: 501,
    tradingAccountId: 17,
    symbol: 'EURUSD',
    direction: 'Long',
    openLots: 0.5,
    averageEntryPrice: 1.1,
    stopLoss: 1.097,
    takeProfit: 1.106,
    ...over,
  }) as ChartPosition;

const order = (over: Partial<OrderDto> = {}): OrderDto =>
  ({
    id: 601,
    tradingAccountId: 17,
    symbol: 'EURUSD',
    orderType: 'Buy',
    executionType: 'Limit',
    quantity: 0.2,
    price: 1.095,
    stopLoss: 1.092,
    takeProfit: 1.101,
    status: 'Submitted',
    brokerOrderId: '77001',
    isPaper: false,
    ...over,
  }) as OrderDto;

const inScope = (id: number | null | undefined) => id === 17;

describe('actionable position and order lines (SP-I3)', () => {
  it('makes a position’s stop and target draggable and its entry clickable, drawn by the trade layer', () => {
    const lines = actionableLines([pos()], [], 'EURUSD', inScope, []);
    expect(lines.map((l) => [l.kind, l.draggable, !!l.clickable, l.drawn])).toEqual([
      ['positionEntry', false, true, false],
      ['positionStop', true, false, false],
      ['positionTarget', true, false, false],
    ]);
  });

  it('makes a working order’s stop and target draggable, and its price both draggable (move) and clickable (cancel)', () => {
    const lines = actionableLines([], [order()], 'EURUSD', inScope, []);
    expect(lines.map((l) => [l.kind, l.draggable, !!l.clickable])).toEqual([
      ['orderPrice', true, true],
      ['orderStop', true, false],
      ['orderTarget', true, false],
    ]);
  });

  it('only lets an order working at the broker have its entry dragged', () => {
    expect(canMoveOrderEntry(order())).toBe(true);
    expect(canMoveOrderEntry(order({ status: 'Pending' as OrderDto['status'] }))).toBe(false);
    expect(canMoveOrderEntry(order({ status: 'PartialFill' as OrderDto['status'] }))).toBe(false);
    expect(canMoveOrderEntry(order({ brokerOrderId: null }))).toBe(false);
    expect(canMoveOrderEntry(order({ isPaper: true }))).toBe(false);
    expect(canMoveOrderEntry(order({ executionType: 'Market' as OrderDto['executionType'] }))).toBe(
      false,
    );
    // Not movable: the price line stays clickable (cancel) only.
    const [price] = actionableLines([], [order({ brokerOrderId: null })], 'EURUSD', inScope, []);
    expect([price.kind, price.draggable, price.clickable]).toEqual(['orderPrice', false, true]);
  });

  it('holds an order still while its entry move waits for the EA (its stop and target move with it)', () => {
    const pending: PendingChange = {
      correlationId: 'chart-1',
      kind: 'orderEntry',
      refId: 601,
      price: 1.096,
      label: 'Entry',
      startedAt: 0,
    };
    const lines = actionableLines([], [order()], 'EURUSD', inScope, [pending]);
    expect(lines.map((l) => [l.kind, l.draggable])).toEqual([['orderPrice', false]]);
  });

  it('moves the stop and target with the entry by default, or keeps them', () => {
    expect(movedOrderLevels(order(), 1.09612, true, 5)).toEqual({
      price: 1.09612,
      stopLoss: 1.09312,
      takeProfit: 1.10212,
    });
    expect(movedOrderLevels(order(), 1.096, false, 5)).toEqual({
      price: 1.096,
      stopLoss: 1.092,
      takeProfit: 1.101,
    });
    expect(movedOrderLevels(order({ takeProfit: null }), 1.096, true, 5).takeProfit).toBeNull();
  });

  it('skips other symbols, other accounts and orders that can no longer fill', () => {
    expect(
      actionableLines(
        [pos({ symbol: 'GBPUSD' }), pos({ tradingAccountId: 18 })],
        [],
        'EURUSD',
        inScope,
        [],
      ),
    ).toEqual([]);
    expect(
      actionableLines(
        [],
        [order({ status: 'Filled' as OrderDto['status'] })],
        'EURUSD',
        inScope,
        [],
      ),
    ).toEqual([]);
  });

  it('locks a line while its change waits for the EA, and a closing position entirely', () => {
    const pendingStop: PendingChange = {
      correlationId: 'c1',
      kind: 'stop',
      refId: 501,
      price: 1.0975,
      label: 'SL',
      startedAt: 0,
    };
    expect(
      actionableLines([pos()], [], 'EURUSD', inScope, [pendingStop]).map((l) => l.kind),
    ).toEqual(['positionEntry', 'positionTarget']);
    const closing: PendingChange = { ...pendingStop, kind: 'close' };
    expect(actionableLines([pos()], [], 'EURUSD', inScope, [closing])).toEqual([]);
  });

  it('draws a pending change as a faded, fixed line saying it waits for the EA', () => {
    const [line] = pendingLines(
      [{ correlationId: 'c1', kind: 'stop', refId: 501, price: 1.0975, label: 'SL', startedAt: 0 }],
      5,
    );
    expect(line).toMatchObject({ kind: 'pending', drawn: true, faded: true, draggable: false });
    expect(line.label).toBe('SL 1.09750 · waiting for the EA');
  });

  it('a press grabs a draggable line before a clickable one at the same distance only when asked', () => {
    const lines = actionableLines([pos()], [], 'EURUSD', inScope, []);
    const toY = (p: number) => (1.2 - p) * 10_000;
    expect(grabbedTradeLine(lines, toY(1.1), toY)?.kind).toBe('positionEntry');
    expect(grabbedTradeLine(lines, toY(1.1), toY, 5, 'draggable')).toBeNull();
  });

  it('refuses a stop or target dragged through the price that would trigger it', () => {
    expect(dragSideProblem('positionStop', true, 1.1001, 1.1)).toContain('below');
    expect(dragSideProblem('positionStop', false, 1.0999, 1.1)).toContain('above');
    expect(dragSideProblem('positionTarget', true, 1.0999, 1.1)).toContain('above');
    expect(dragSideProblem('orderStop', true, 1.096, 1.095)).toContain('below');
    expect(dragSideProblem('positionStop', true, 1.098, 1.1)).toBeNull();
    expect(dragSideProblem('positionStop', true, 1.2, null)).toBeNull();
  });

  it('stops following a change after the timeout', () => {
    const p: PendingChange = {
      correlationId: 'c',
      kind: 'stop',
      refId: 1,
      price: 1,
      label: 'SL',
      startedAt: 1000,
    };
    expect(livePending([p], 1000 + PENDING_TIMEOUT_MS - 1)).toHaveLength(1);
    expect(livePending([p], 1000 + PENDING_TIMEOUT_MS)).toHaveLength(0);
  });

  it('makes correlation ids that fit the engine’s 64 characters', () => {
    const id = newCorrelationId(() => 0.5);
    expect(id).toBe('chart-88888888888888888888');
    expect(newCorrelationId().length).toBeLessThanOrEqual(64);
  });
});
