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

/** Three days of hourly bars ending 2026-09-18, so date arguments have something to hit. */
const LAST_MS = Date.parse('2026-09-18T20:00:00Z');
const bars = Array.from({ length: 72 }, (_, i) => ({
  time: LAST_MS - (71 - i) * 3_600_000,
  high: 1.15,
  low: 1.14,
  close: 1.145,
}));

let savedLayouts: Array<{ id: string; name: string; symbol: string; resolution: string }>;
let savedTemplates: Array<{ id: string; name: string; count: number }>;
let replayState: { active: boolean; index: number; total: number; playing: boolean; speed: number };
let impact: string;
let pane: string;
let fullscreen: boolean;
let activeCount: () => number;

let placed: Array<{
  id: string;
  kind: string;
  points: { time: number; price: number }[];
  color?: string;
  text?: string;
}>;
let moves: string[];

function makeHost(over: Partial<ChartCommandHost> = {}) {
  placed = [];
  moves = [];
  savedLayouts = [];
  savedTemplates = [];
  replayState = { active: false, index: 0, total: bars.length, playing: false, speed: 4 };
  impact = 'Medium';
  pane = 'none';
  fullscreen = false;
  const active = sig<ActiveIndicator[]>([]);
  activeCount = () => active().length;
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
    bars: () => bars,
    drawings: () => placed,
    addDrawing: (kind, points, color) => {
      const id = `d${placed.length + 1}`;
      placed.push({ id, kind, points, color });
      return id;
    },
    removeDrawing: (id) => {
      const i = placed.findIndex((d) => d.id === id);
      if (i >= 0) placed.splice(i, 1);
    },
    styleDrawing: (id, patch) => {
      const d = placed.find((x) => x.id === id);
      if (d) Object.assign(d, patch);
    },
    setVisibleRange: (from, to) => {
      moves.push(`range:${from}-${to}`);
      return true;
    },
    showLastBars: (n) => {
      moves.push(`lastBars:${n}`);
      return true;
    },
    fitContent: () => moves.push('fit'),
    scrollToRealtime: () => moves.push('latest'),
    resetScales: () => moves.push('reset'),
    layouts: () => savedLayouts,
    saveLayout: (name) => {
      const id = `L${savedLayouts.length + 1}`;
      savedLayouts.push({ id, name, symbol: 'EURUSD', resolution: '60' });
      return id;
    },
    applyLayout: (id) => moves.push(`applyLayout:${id}`),
    removeLayout: (id) => {
      savedLayouts = savedLayouts.filter((l) => l.id !== id);
    },
    studyTemplates: () => savedTemplates,
    saveStudyTemplate: (name) => {
      if (activeCount() === 0) return false;
      savedTemplates.push({ id: `T${savedTemplates.length + 1}`, name, count: activeCount() });
      return true;
    },
    applyStudyTemplate: (id) => moves.push(`applyTemplate:${id}`),
    removeStudyTemplate: (id) => {
      savedTemplates = savedTemplates.filter((t) => t.id !== id);
    },
    replay: () => replayState,
    startReplay: () => {
      replayState = { ...replayState, active: true, index: 48, total: bars.length };
    },
    exitReplay: () => {
      replayState = { ...replayState, active: false, playing: false };
    },
    stepReplay: (d) => moves.push(`step:${d}`),
    toggleReplayPlay: () => {
      replayState = { ...replayState, playing: !replayState.playing };
    },
    setReplaySpeed: (x) => moves.push(`speed:${x}`),
    setReplayIndex: (i) => moves.push(`goto:${i}`),
    loadOlder: async () => {
      moves.push('loadOlder');
    },
    eventImpact: () => impact,
    setEventImpact: (v) => {
      impact = v;
    },
    sidePane: () => pane,
    setSidePane: (v) => {
      pane = v;
    },
    watchlistOpen: sig(false),
    objectTreeOpen: sig(false),
    toggleFullscreen: async () => {
      fullscreen = !fullscreen;
    },
    isFullscreen: () => fullscreen,
    showVolumeProfile: sig(false),
    showSupportResistance: sig(false),
    showStructure: sig(false),
    structureSummary: () => 'Balancing 43 pips over 50 bars, 1.14548–1.14979.',
    srLevels: () => [{ price: 1.15, kind: 'resistance', touches: 3, strength: 0.8 }],
    volumeProfile: () => ({ poc: 1.147, valueAreaLow: 1.144, valueAreaHigh: 1.15 }),
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

describe('placing drawings and navigating', () => {
  let host: ChartCommandHost;
  let cmds: UiCommand[];

  beforeEach(() => {
    host = makeHost();
    cmds = chartCommands(host);
  });

  const place = (args: Record<string, unknown>) => byId(cmds, 'chart.placeDrawing').run(args);

  it('places a trend line at exact coordinates, no clicking', async () => {
    // The gap this closes: selectTool only ARMS a tool and waits for the operator's clicks,
    // so the assistant could never actually draw anything itself.
    const r = await place({
      tool: 'Trend Line',
      points: JSON.stringify([
        { price: 1.144, time: '2026-09-17T00:00:00Z' },
        { price: 1.149, time: '2026-09-18T00:00:00Z' },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(placed).toHaveLength(1);
    expect(placed[0].kind).toBe('trend-line');
    expect(placed[0].points[0].price).toBe(1.144);
  });

  it('matches a tool named in camelCase, snake_case or a short alias', async () => {
    // Conversation #33534: the model asked for "horizontalLine" and was told no such tool exists.
    for (const tool of ['horizontalLine', 'horizontal_line', 'HORIZONTAL LINE', 'hline']) {
      const r = await place({ tool, points: JSON.stringify([{ price: 1.14775 }]) });
      expect(r.ok).toBe(true);
    }
    expect(placed.map((p) => p.kind)).toEqual(Array(4).fill('horizontal-line'));
  });

  it('takes `label` as the drawing text', async () => {
    await place({
      tool: 'horizontal-line',
      points: JSON.stringify([{ price: 1.14775 }]),
      label: 'POC 1.14775',
    });
    expect(placed[0].text).toBe('POC 1.14775');
  });

  it('lets a horizontal line omit the time', async () => {
    // Its anchor time does not affect what is drawn, so refusing over a missing coordinate
    // would be pedantry.
    const r = await place({ tool: 'Horizontal Line', points: JSON.stringify([{ price: 1.147 }]) });
    expect(r.ok).toBe(true);
    expect(placed[0].points[0].time).toBeGreaterThan(0);
  });

  it('refuses too few points for the tool', async () => {
    const r = await place({ tool: 'Trend Line', points: JSON.stringify([{ price: 1.14 }]) });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/needs 2/);
    expect(placed).toHaveLength(0);
  });

  it('refuses points that are not JSON, or not an array', async () => {
    expect((await place({ tool: 'Trend Line', points: 'nope' })).ok).toBe(false);
    expect((await place({ tool: 'Trend Line', points: '{}' })).ok).toBe(false);
  });

  it('refuses a non-numeric price and a bad date, naming the index', async () => {
    const bad = await place({
      tool: 'Trend Line',
      points: JSON.stringify([{ price: 'x' }, { price: 1.15 }]),
    });
    expect(bad.message).toMatch(/points\[0\]\.price/);
    const badTime = await place({
      tool: 'Trend Line',
      points: JSON.stringify([
        { price: 1.14, time: 'yesterday' },
        { price: 1.15, time: '2026-09-18T00:00:00Z' },
      ]),
    });
    expect(badTime.message).toMatch(/points\[0\]\.time/);
  });

  it('applies a colour and a label', async () => {
    await place({
      tool: 'Horizontal Line',
      points: JSON.stringify([{ price: 1.147 }]),
      color: '#FF6D00',
      text: 'Weekly high',
    });
    expect(placed[0].color).toBe('#FF6D00');
    expect(placed[0].text).toBe('Weekly high');
  });

  it('lists, restyles and removes a drawing by id', async () => {
    await place({ tool: 'Horizontal Line', points: JSON.stringify([{ price: 1.147 }]) });
    const list = await byId(cmds, 'chart.listDrawings').run({});
    expect((list.data as unknown[]).length).toBe(1);

    const styled = await byId(cmds, 'chart.styleDrawing').run({ id: 'd1', width: 4 });
    expect(styled.ok).toBe(true);

    const gone = await byId(cmds, 'chart.removeDrawing').run({ id: 'd1' });
    expect(gone.ok).toBe(true);
    expect(placed).toHaveLength(0);
  });

  it('refuses to restyle with a colour that is not hex', async () => {
    await place({ tool: 'Horizontal Line', points: JSON.stringify([{ price: 1.147 }]) });
    const r = await byId(cmds, 'chart.styleDrawing').run({ id: 'd1', color: 'orange' });
    expect(r.ok).toBe(false);
  });

  it('refuses an unknown drawing id rather than doing nothing quietly', async () => {
    expect((await byId(cmds, 'chart.removeDrawing').run({ id: 'nope' })).ok).toBe(false);
    expect((await byId(cmds, 'chart.styleDrawing').run({ id: 'nope', width: 2 })).ok).toBe(false);
  });

  it('navigates: fit, latest, last N bars and a date range', async () => {
    const nav = byId(cmds, 'chart.navigate');
    expect((await nav.run({ mode: 'fit' })).ok).toBe(true);
    expect((await nav.run({ mode: 'latest' })).ok).toBe(true);
    expect((await nav.run({ mode: 'lastBars', bars: 50 })).ok).toBe(true);
    expect(
      (await nav.run({ mode: 'range', from: '2026-09-17T00:00:00Z', to: '2026-09-18T00:00:00Z' }))
        .ok,
    ).toBe(true);
    expect(moves).toEqual(['fit', 'latest', 'lastBars:50', expect.stringMatching(/^range:/)]);
  });

  it('says a range is outside the loaded data, and names the window that is loaded', async () => {
    // "the chart could not show that range" would send the operator looking for a bug; the
    // real answer is that the bars are not loaded yet.
    const r = await byId(cmds, 'chart.navigate').run({
      mode: 'range',
      from: '2020-01-01T00:00:00Z',
      to: '2020-02-01T00:00:00Z',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/outside the loaded data/);
    expect(r.message).toMatch(/2026-09/);
  });

  it('refuses a nonsense date range', async () => {
    const r = await byId(cmds, 'chart.navigate').run({ mode: 'range', from: 'soon', to: 'later' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ISO dates/);
  });
});

describe('workspace, replay and chrome', () => {
  let host: ChartCommandHost;
  let cmds: UiCommand[];

  beforeEach(() => {
    host = makeHost();
    cmds = chartCommands(host);
  });

  const run = (id: string, args: Record<string, unknown> = {}) => byId(cmds, id).run(args);

  describe('layouts', () => {
    it('saves, lists, applies and deletes by name', async () => {
      expect((await run('chart.layouts', { action: 'save', name: 'Swing EU' })).ok).toBe(true);
      const list = await run('chart.layouts', { action: 'list' });
      expect((list.data as unknown[]).length).toBe(1);
      expect((await run('chart.layouts', { action: 'apply', name: 'Swing EU' })).ok).toBe(true);
      expect(moves).toContain('applyLayout:L1');
      expect((await run('chart.layouts', { action: 'delete', name: 'Swing EU' })).ok).toBe(true);
      expect(savedLayouts).toHaveLength(0);
    });

    it('needs a name for anything but list', async () => {
      const r = await run('chart.layouts', { action: 'apply' });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/name/);
    });

    it('refuses an ambiguous name rather than applying the wrong layout', async () => {
      await run('chart.layouts', { action: 'save', name: 'EU swing' });
      await run('chart.layouts', { action: 'save', name: 'EU scalp' });
      const r = await run('chart.layouts', { action: 'apply', name: 'EU' });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/matches 2/);
    });

    it('lists the available names when nothing matches', async () => {
      await run('chart.layouts', { action: 'save', name: 'Swing EU' });
      const r = await run('chart.layouts', { action: 'apply', name: 'nope' });
      expect(r.message).toMatch(/Swing EU/);
    });
  });

  describe('study templates', () => {
    it('refuses to save with no studies loaded', async () => {
      const r = await run('chart.studyTemplates', { action: 'save', name: 'Mine' });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no studies/i);
    });

    it('saves once studies exist', async () => {
      await byId(cmds, 'chart.addIndicator').run({ indicator: 'rsi' });
      expect((await run('chart.studyTemplates', { action: 'save', name: 'Mine' })).ok).toBe(true);
      expect((await run('chart.studyTemplates', { action: 'apply', name: 'Mine' })).ok).toBe(true);
      expect(moves).toContain('applyTemplate:T1');
    });
  });

  describe('replay', () => {
    it('reports off, then starts', async () => {
      expect((await run('chart.replay', { action: 'status' })).message).toMatch(/off/);
      expect((await run('chart.replay', { action: 'start' })).ok).toBe(true);
      expect(host.replay().active).toBe(true);
    });

    it('refuses to step, play or seek while replay is off', async () => {
      // Doing nothing silently is the failure here: the operator asked for a step and the
      // chart did not move, with no reason given.
      for (const action of ['step', 'play', 'pause', 'speed', 'goto']) {
        const r = await run('chart.replay', { action, bars: 1, speed: 4, index: 2 });
        expect(r.ok, action).toBe(false);
        expect(r.message).toMatch(/not running/);
      }
    });

    it('steps forward and back', async () => {
      await run('chart.replay', { action: 'start' });
      expect((await run('chart.replay', { action: 'step', bars: 5 })).message).toMatch(/forward 5/);
      expect((await run('chart.replay', { action: 'step', bars: -2 })).message).toMatch(/back 2/);
    });

    it('refuses a zero step', async () => {
      await run('chart.replay', { action: 'start' });
      expect((await run('chart.replay', { action: 'step', bars: 0 })).ok).toBe(false);
    });

    it('is idempotent about play and pause', async () => {
      await run('chart.replay', { action: 'start' });
      expect((await run('chart.replay', { action: 'pause' })).message).toMatch(/already paused/);
      expect((await run('chart.replay', { action: 'play' })).ok).toBe(true);
      expect(host.replay().playing).toBe(true);
    });

    it('bounds speed and index', async () => {
      await run('chart.replay', { action: 'start' });
      expect((await run('chart.replay', { action: 'speed', speed: 99 })).ok).toBe(false);
      expect((await run('chart.replay', { action: 'goto', index: 99999 })).ok).toBe(false);
      expect((await run('chart.replay', { action: 'goto', index: 10 })).ok).toBe(true);
      expect(moves).toContain('goto:10');
    });
  });

  it('fetches older history, and says when none came back', async () => {
    // chart.navigate only moves what is SHOWN; this is the one that fetches.
    const r = await run('chart.loadMoreHistory');
    expect(moves).toContain('loadOlder');
    expect(r.message).toMatch(/No older bars|Loaded/);
  });

  it('sets the economic-event impact threshold', async () => {
    expect((await run('chart.setEventImpact', { impact: 'High' })).ok).toBe(true);
    expect(host.eventImpact()).toBe('High');
  });

  it('opens and closes the side panes', async () => {
    await run('chart.setSidePane', { pane: 'news' });
    expect(host.sidePane()).toBe('news');
    await run('chart.setSidePane', { pane: 'none' });
    expect(host.sidePane()).toBe('none');
  });

  it('toggles the watchlist and object tree', async () => {
    await run('chart.setPanel', { panel: 'watchlist', visible: true });
    expect(host.watchlistOpen()).toBe(true);
    await run('chart.setPanel', { panel: 'objects', visible: true });
    expect(host.objectTreeOpen()).toBe(true);
  });

  it('is idempotent about fullscreen', async () => {
    expect((await run('chart.setFullscreen', { on: false })).message).toMatch(/Already/);
    expect((await run('chart.setFullscreen', { on: true })).ok).toBe(true);
    expect(host.isFullscreen()).toBe(true);
  });
});

describe('analysis overlays', () => {
  let host: ChartCommandHost;
  let cmds: UiCommand[];

  beforeEach(() => {
    host = makeHost();
    cmds = chartCommands(host);
  });

  it('toggles the volume profile and support/resistance independently', async () => {
    await byId(cmds, 'chart.setOverlay').run({ overlay: 'volumeProfile', visible: true });
    expect(host.showVolumeProfile()).toBe(true);
    expect(host.showSupportResistance()).toBe(false);

    await byId(cmds, 'chart.setOverlay').run({ overlay: 'supportResistance', visible: true });
    expect(host.showSupportResistance()).toBe(true);
  });

  it('reads the levels back as NUMBERS, not as a picture', async () => {
    // The point of this command: the assistant can quote a level or draw on it without
    // squinting at the screenshot and guessing the price.
    const r = await byId(cmds, 'chart.readLevels').run({});
    expect(r.ok).toBe(true);
    const data = r.data as { levels: unknown[]; volumeProfile: { poc: number } | null };
    expect(data.levels).toHaveLength(1);
    expect(data.volumeProfile?.poc).toBe(1.147);
    expect(r.message).toMatch(/POC/);
  });

  it('says plainly when nothing was detected', async () => {
    const empty = makeHost({
      srLevels: () => [],
      volumeProfile: () => null,
      structureSummary: () => null,
    });
    const r = await byId(chartCommands(empty), 'chart.readLevels').run({});
    expect(r.message).toMatch(/No levels detected/);
  });
});
