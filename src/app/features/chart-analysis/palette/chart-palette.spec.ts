import { describe, expect, it, vi } from 'vitest';
import { chartCommands, type ChartCommandHost } from '../chart-commands';
import { buildPaletteActions, filterActions } from './chart-palette';

// The real command list, over a host the palette never touches (it only reads the definitions).
const commands = chartCommands(new Proxy({}, { get: () => vi.fn() }) as unknown as ChartCommandHost);
const actions = buildPaletteActions(commands, {
  symbols: ['EURUSD', 'GBPUSD'],
  indicators: [
    { id: 'rsi', name: 'Relative Strength Index' },
    { id: 'ema', name: 'Exponential Moving Average' },
  ],
  active: [{ uid: 'u1', label: 'RSI 14' }],
  tools: [{ label: 'Trend Line' }],
  timezones: [{ id: 'America/New_York', label: 'New York' }],
  styleLabel: (s) => (s === 'heikin-ashi' ? 'Heikin Ashi' : s),
});
const find = (title: string) => actions.find((a) => a.title === title);

describe('chart command palette (CC-I11)', () => {
  it('offers each command’s concrete choices, run through the command itself', () => {
    expect(find('Timeframe: 4h')).toMatchObject({ commandId: 'chart.setTimeframe', args: { timeframe: '240' } });
    expect(find('Style: Heikin Ashi')).toMatchObject({ args: { style: 'heikin-ashi' } });
    expect(find('Symbol: GBPUSD')).toMatchObject({ commandId: 'chart.setSymbol', args: { symbol: 'GBPUSD' } });
    expect(find('Add indicator: Relative Strength Index')).toMatchObject({ args: { indicator: 'rsi' } });
    expect(find('Indicator: hide RSI 14')).toMatchObject({ args: { indicator: 'u1', visible: false } });
    expect(find('Volume: off')).toMatchObject({ args: { visible: false } });
    expect(find('Overlay: Volume profile on')).toMatchObject({ args: { overlay: 'volumeProfile', visible: true } });
    expect(find('Bar replay: Start')).toMatchObject({ args: { action: 'start' } });
    expect(find('Drawing tool: Cursor')).toMatchObject({ args: { tool: 'none' } });
    expect(find('Take a snapshot')).toMatchObject({ args: {} });
  });

  it('leaves out reads and what needs typed input; marks what destroys work', () => {
    const ids = new Set(actions.map((a) => a.commandId));
    for (const id of ['chart.describe', 'chart.listIndicators', 'chart.readLevels', 'chart.placeDrawing', 'chart.layouts'])
      expect(ids.has(id), id).toBe(false);
    expect(actions.some((a) => a.commandId === 'chart.replay' && a.args['action'] === 'goto')).toBe(false);
    expect(find('Remove all drawings')?.confirm).toBe(true);
    // Every entry names a command that exists.
    const known = new Set(commands.map((c) => c.id));
    expect(actions.every((a) => known.has(a.commandId))).toBe(true);
  });

  it('finds entries by every word, best match first, recent ones first when empty', () => {
    expect(filterActions(actions, '4h')[0].title).toBe('Timeframe: 4h');
    // By its title words first (the study on the chart), then by its id (the catalogue entry).
    const rsi = filterActions(actions, 'rsi').map((a) => a.title);
    expect(rsi.indexOf('Remove indicator: RSI 14')).toBeLessThan(rsi.indexOf('Add indicator: Relative Strength Index'));
    expect(filterActions(actions, 'relative')[0].title).toBe('Add indicator: Relative Strength Index');
    expect(filterActions(actions, 'volume off').map((a) => a.title)).toContain('Volume: off');
    expect(filterActions(actions, 'zzzz')).toEqual([]);
    const recentId = find('Symbol: GBPUSD')!.id;
    expect(filterActions(actions, '', [recentId])[0].id).toBe(recentId);
  });
});
