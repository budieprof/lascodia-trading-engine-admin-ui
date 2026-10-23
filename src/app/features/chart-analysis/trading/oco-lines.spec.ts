import { describe, expect, it } from 'vitest';

import type { OcoGroup } from './manual-trading.types';
import { OCO_COLOR, ocoLines, ocoOrderIndex } from './oco-lines';

const group = (over: Partial<OcoGroup> = {}): OcoGroup => ({
  id: 12,
  tradingAccountId: 17,
  symbol: 'EURUSD',
  status: 'Active',
  filledLeg: null,
  note: null,
  cancelRequested: false,
  createdAtUtc: '',
  updatedAtUtc: '',
  closedAtUtc: null,
  legs: [
    { leg: 1, tradeSignalId: 901, orderId: 601, direction: 'Buy', entryPrice: 1.095, stopLoss: 1.09, takeProfit: null, phase: 'OrderWorking', detail: '' },
    { leg: 2, tradeSignalId: 902, orderId: null, direction: 'Sell', entryPrice: 1.105, stopLoss: 1.11, takeProfit: null, phase: 'SignalWorking', detail: '' },
  ],
  ...over,
});
const all = () => true;

describe('OCO lines (C8)', () => {
  it('draws both working legs as linked, clickable purple lines', () => {
    const lines = ocoLines([group()], 'eurusd', all);
    expect(lines.map((l) => l.label)).toEqual(['OCO #12 · BUY 1/2', 'OCO #12 · SELL 2/2']);
    expect(lines.every((l) => l.kind === 'ocoLeg' && l.color === OCO_COLOR && l.clickable && l.drawn && !l.draggable)).toBe(true);
    expect(lines.map((l) => l.refId)).toEqual([12, 12]);
  });

  it('leaves out filled and gone legs, closed pairs, other symbols and accounts out of scope', () => {
    const triggered = group({
      status: 'Triggered',
      legs: [
        { ...group().legs[0], phase: 'Filled' },
        { ...group().legs[1], phase: 'Cancelling' },
      ],
    });
    const lines = ocoLines([triggered], 'EURUSD', all);
    expect(lines).toHaveLength(1);
    expect(lines[0].faded).toBe(true);
    expect(lines[0].label).toContain('cancelling');
    expect(ocoLines([group({ status: 'Completed' })], 'EURUSD', all)).toEqual([]);
    expect(ocoLines([group()], 'GBPUSD', all)).toEqual([]);
    expect(ocoLines([group()], 'EURUSD', (id) => id === 18)).toEqual([]);
  });

  it('a pair already being cancelled is drawn but not clickable again', () => {
    expect(ocoLines([group({ cancelRequested: true })], 'EURUSD', all).every((l) => !l.clickable)).toBe(true);
  });

  it('indexes each leg’s order to its pair', () => {
    const idx = ocoOrderIndex([group()]);
    expect(idx.get(601)?.id).toBe(12);
    expect(idx.size).toBe(1);
  });
});
