import { describe, expect, it, beforeEach } from 'vitest';
import { chartCommands, type ChartCommandHost } from './chart-commands';
import type { UiCommand } from '@core/assistant/ui-command.types';
import type { ActiveIndicator, ChartStyle } from './chart/chart-host.component';
import { SUPPORTED_RESOLUTIONS } from './datafeed/resolution';

/** A signal-shaped stub: callable, with `.set`. */
function sig<T>(initial: T) {
  let value = initial;
  const fn = (() => value) as { (): T; set(v: T): void };
  fn.set = (v: T) => {
    value = v;
  };
  return fn;
}

function makeHost(over: Partial<ChartCommandHost> = {}) {
  const active = sig<ActiveIndicator[]>([]);
  const host: ChartCommandHost = {
    symbol: sig('EURUSD'),
    resolution: sig('60'),
    style: sig<ChartStyle>('candles'),
    showVolume: sig(true),
    showOverlays: sig(true),
    showEvents: sig(true),
    magnet: sig(false),
    scaleMode: sig('normal'),
    timezone: sig('UTC'),
    splitLayout: sig('1'),
    active: active as ChartCommandHost['active'],
    boxSizeAtr: sig(1),
    drawingCount: () => 3,
    selectSymbol: (s) => host.symbol.set(s),
    selectResolution: (r) => host.resolution.set(r),
    addIndicator: (defId) =>
      active.set([
        ...active(),
        { uid: `${defId}-1`, defId, params: { length: 14 }, visible: true },
      ]),
    removeIndicator: (uid) => active.set(active().filter((i) => i.uid !== uid)),
    toggleIndicator: (uid) =>
      active.set(active().map((i) => (i.uid === uid ? { ...i, visible: !i.visible } : i))),
    setIndicatorParam: (uid, key, value) =>
      active.set(
        active().map((i) => (i.uid === uid ? { ...i, params: { ...i.params, [key]: value } } : i)),
      ),
    setSplitLayout: () => void 0,
    selectTool: () => void 0,
    clearDrawings: () => void 0,
    takeSnapshot: () => void 0,
    knownSymbols: () => ['EURUSD', 'GBPUSD', 'AUDCAD'],
    timezones: () => [
      { id: 'UTC', label: 'UTC' },
      { id: 'America/New_York', label: 'New York' },
    ],
    ...over,
  };
  return host;
}

function byId(cmds: UiCommand[], id: string): UiCommand {
  const c = cmds.find((x) => x.id === id);
  if (!c) throw new Error(`no command ${id}`);
  return c;
}

describe('chart commands', () => {
  let host: ChartCommandHost;
  let cmds: UiCommand[];

  beforeEach(() => {
    host = makeHost();
    cmds = chartCommands(host);
  });

  it('gives every command a namespaced id and a description', () => {
    for (const c of cmds) {
      expect(c.id, 'commands must be namespaced so ids cannot collide across pages').toMatch(
        /^chart\./,
      );
      expect(c.description.length).toBeGreaterThan(10);
    }
  });

  it('marks exactly the destructive command as needing confirmation', () => {
    // Everything else is a view change the operator could undo from the toolbar. Drawings
    // persist server-side and their delete has no undo, so that one asks first.
    const confirming = cmds.filter((c) => c.confirm).map((c) => c.id);
    expect(confirming).toEqual(['chart.clearDrawings']);
  });

  it('advertises only timeframes the datafeed can serve', () => {
    const tf = byId(cmds, 'chart.setTimeframe').params?.[0];
    expect(tf?.values).toEqual(SUPPORTED_RESOLUTIONS);
  });

  describe('setSymbol', () => {
    it('switches to a tracked pair', async () => {
      expect((await byId(cmds, 'chart.setSymbol').run({ symbol: 'gbpusd' })).ok).toBe(true);
      expect(host.symbol()).toBe('GBPUSD');
    });

    it('accepts the slash display form', async () => {
      await byId(cmds, 'chart.setSymbol').run({ symbol: 'GBP/USD' });
      expect(host.symbol()).toBe('GBPUSD');
    });

    it('refuses a pair the console does not track', async () => {
      const r = await byId(cmds, 'chart.setSymbol').run({ symbol: 'XAUUSD' });
      expect(r.ok).toBe(false);
      expect(host.symbol()).toBe('EURUSD');
    });
  });

  describe('indicators', () => {
    it('adds by registry id or by display name', async () => {
      expect((await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' })).ok).toBe(true);
      expect(host.active()).toHaveLength(1);
      expect(host.active()[0].defId).toBe('rsi');
    });

    it('refuses an ambiguous name rather than picking one', async () => {
      // "moving average" matches ten entries; silently loading the first would put a study
      // on the chart that nobody asked for.
      const r = await byId(cmds, 'chart.addIndicator').run({ indicator: 'moving average' });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('matches');
      expect(host.active()).toHaveLength(0);
    });

    it('refuses a name that matches nothing', async () => {
      expect((await byId(cmds, 'chart.addIndicator').run({ indicator: 'zzz' })).ok).toBe(false);
    });

    it('removes a loaded study by name', async () => {
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
      const r = await byId(cmds, 'chart.removeIndicator').run({ indicator: 'RSI' });
      expect(r.ok).toBe(true);
      expect(host.active()).toHaveLength(0);
    });

    it('says so when nothing is loaded', async () => {
      const r = await byId(cmds, 'chart.removeIndicator').run({ indicator: 'RSI' });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('No indicators are loaded');
    });

    it('removes all studies at once', async () => {
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'macd' });
      const r = await byId(cmds, 'chart.removeAllIndicators').run({});
      expect(r.ok).toBe(true);
      expect(host.active()).toHaveLength(0);
    });

    it('hides without removing', async () => {
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
      await byId(cmds, 'chart.setIndicatorVisible').run({ indicator: 'rsi', visible: false });
      expect(host.active()).toHaveLength(1);
      expect(host.active()[0].visible).toBe(false);
    });

    it('is idempotent about visibility rather than toggling blindly', async () => {
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
      await byId(cmds, 'chart.setIndicatorVisible').run({ indicator: 'rsi', visible: true });
      expect(host.active()[0].visible).toBe(true);
    });

    it('changes a numeric parameter', async () => {
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
      const r = await byId(cmds, 'chart.setIndicatorParam').run({
        indicator: 'rsi',
        name: 'length',
        value: 21,
      });
      expect(r.ok).toBe(true);
      expect(host.active()[0].params['length']).toBe(21);
    });

    it('refuses a parameter outside the range the UI itself enforces', async () => {
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
      const r = await byId(cmds, 'chart.setIndicatorParam').run({
        indicator: 'rsi',
        name: 'length',
        value: 9999,
      });
      expect(r.ok).toBe(false);
      expect(host.active()[0].params['length']).toBe(14);
    });

    it('names the available parameters when asked for one that does not exist', async () => {
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
      const r = await byId(cmds, 'chart.setIndicatorParam').run({
        indicator: 'rsi',
        name: 'wavelength',
        value: 3,
      });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('length');
    });
  });

  it('matches a timezone by city label, not just IANA id', async () => {
    const r = await byId(cmds, 'chart.setTimezone').run({ timezone: 'new york' });
    expect(r.ok).toBe(true);
    expect(host.timezone()).toBe('America/New_York');
  });

  it('reports the chart state as structured data', async () => {
    await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
    const r = await byId(cmds, 'chart.describe').run({});
    expect(r.ok).toBe(true);
    const data = r.data as Record<string, unknown>;
    expect(data['symbol']).toBe('EURUSD');
    expect(data['drawings']).toBe(3);
    expect((data['studies'] as unknown[]).length).toBe(1);
  });

  it('refuses a box size the toolbar would refuse', async () => {
    expect((await byId(cmds, 'chart.setBoxSize').run({ multiple: 50 })).ok).toBe(false);
    expect(host.boxSizeAtr()).toBe(1);
  });

  it('arms a drawing tool and says it is not placed yet', async () => {
    let armed: string | null = 'unset';
    const h = makeHost({ selectTool: (k) => (armed = k) });
    const r = await byId(chartCommands(h), 'chart.selectTool').run({ tool: 'Trend Line' });
    expect(r.ok).toBe(true);
    expect(armed).toBe('trend-line');
    // Arming changes nothing on its own; saying "done" would be a lie.
    expect(r.message).toMatch(/click/i);
  });

  it('disarms back to the cursor', async () => {
    let armed: string | null = 'unset';
    const h = makeHost({ selectTool: (k) => (armed = k) });
    await byId(chartCommands(h), 'chart.selectTool').run({ tool: 'none' });
    expect(armed).toBeNull();
  });

  it('does not clear drawings when there are none', async () => {
    let cleared = false;
    const h = makeHost({ drawingCount: () => 0, clearDrawings: () => (cleared = true) });
    const r = await byId(chartCommands(h), 'chart.clearDrawings').run({});
    expect(r.ok).toBe(true);
    expect(cleared).toBe(false);
  });
});
