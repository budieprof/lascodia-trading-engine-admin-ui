import type { UiCommand, UiCommandOutcome } from '@core/assistant/ui-command.types';
import { INDICATORS, indicatorById, indicatorLabel } from './indicators/registry';
import { SUPPORTED_RESOLUTIONS } from './datafeed/resolution';
import { TOOLS, type DrawingKind } from './drawings/model';
import type { ActiveIndicator, ChartStyle } from './chart/chart-host.component';

/**
 * What the assistant can do to the chart.
 *
 * <p>Defined against a narrow surface rather than the page component so the vocabulary can
 * be read — and tested — without standing up a chart. Everything here is a view change the
 * operator could make from the toolbar; the one command that destroys work
 * (`chart.clearDrawings`) is marked `confirm`.</p>
 */
export interface ChartCommandHost {
  symbol: { (): string; set(v: string): void };
  resolution: { (): string; set(v: string): void };
  style: { (): ChartStyle; set(v: ChartStyle): void };
  showVolume: { (): boolean; set(v: boolean): void };
  showOverlays: { (): boolean; set(v: boolean): void };
  showEvents: { (): boolean; set(v: boolean): void };
  magnet: { (): boolean; set(v: boolean): void };
  scaleMode: { (): string; set(v: 'normal' | 'log' | 'percent'): void };
  timezone: { (): string; set(v: string): void };
  splitLayout: { (): string };
  active: { (): readonly ActiveIndicator[] };
  boxSizeAtr: { (): number; set(v: number): void };
  drawingCount: () => number;

  selectSymbol(symbol: string): void;
  selectResolution(r: string): void;
  addIndicator(defId: string): void;
  removeIndicator(uid: string): void;
  toggleIndicator(uid: string): void;
  setIndicatorParam(uid: string, key: string, value: number): void;
  setSplitLayout(id: '1' | '2h' | '2v' | '4' | '6' | '8'): void;
  selectTool(kind: DrawingKind | null): void;
  clearDrawings(): void;
  takeSnapshot(): void;
  knownSymbols(): readonly string[];
  timezones(): readonly { id: string; label: string }[];
}

const ok = (message: string, data?: unknown): UiCommandOutcome => ({ ok: true, message, data });
const fail = (message: string): UiCommandOutcome => ({ ok: false, message });

const str = (a: Record<string, unknown>, k: string): string => String(a[k] ?? '').trim();
const bool = (a: Record<string, unknown>, k: string): boolean => a[k] === true;

/**
 * Find an indicator DEFINITION from whatever the operator called it.
 *
 * <p>A model asked to add "RSI" will say `rsi`, `RSI`, or "Relative Strength Index"
 * depending on the sentence it came from. Matching only on the registry id would refuse two
 * of those three and make the assistant look broken at the one thing it was asked to do.</p>
 *
 * <p>Ambiguity is reported rather than resolved: "moving average" matches ten entries, and
 * silently picking the first would load a study nobody asked for.</p>
 */
function resolveDefinition(query: string): { id: string; name: string } | string {
  const q = query.trim().toLowerCase();
  if (!q) return 'No indicator named.';
  const all = INDICATORS.map((d) => ({ id: d.id, name: d.name }));

  const exact = all.filter((d) => d.id.toLowerCase() === q || d.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];

  const partial = all.filter(
    (d) => d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    return `"${query}" matches ${partial.length} indicators: ${partial
      .slice(0, 8)
      .map((d) => d.name)
      .join(', ')}${partial.length > 8 ? '…' : ''}. Be more specific.`;
  }
  return `No indicator matches "${query}".`;
}

/** Find a LOADED indicator by id, name or the label shown in the studies strip. */
function resolveActive(
  host: ChartCommandHost,
  query: string,
): { item: ActiveIndicator; label: string } | string {
  const q = query.trim().toLowerCase();
  if (!q) return 'No indicator named.';

  const withLabels = host.active().map((item) => {
    const def = indicatorById(item.defId);
    return { item, label: def ? indicatorLabel(def, item.params) : item.defId, def };
  });
  if (withLabels.length === 0) return 'No indicators are loaded on the chart.';

  // uid is exact and unambiguous — prefer it when the model echoes one back.
  const byUid = withLabels.find((w) => w.item.uid.toLowerCase() === q);
  if (byUid) return byUid;

  const hits = withLabels.filter(
    (w) =>
      w.label.toLowerCase() === q ||
      w.item.defId.toLowerCase() === q ||
      w.def?.name.toLowerCase() === q ||
      w.label.toLowerCase().includes(q) ||
      w.def?.name.toLowerCase().includes(q) ||
      w.item.defId.toLowerCase().includes(q),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    return `"${query}" matches ${hits.length} loaded studies: ${hits
      .map((h) => h.label)
      .join(', ')}. Name one exactly.`;
  }
  return `No loaded indicator matches "${query}". Loaded: ${withLabels
    .map((w) => w.label)
    .join(', ')}.`;
}

const STYLES: readonly ChartStyle[] = [
  'candles',
  'hollow',
  'bars',
  'hlc-bars',
  'hilo',
  'vol-candle',
  'line',
  'line-markers',
  'stepline',
  'area',
  'hlc-area',
  'baseline',
  'column',
  'heikin-ashi',
  'renko',
  'kagi',
  'pnf',
  'line-break',
];

/** Every command the chart page offers the assistant. */
export function chartCommands(host: ChartCommandHost): UiCommand[] {
  return [
    {
      id: 'chart.describe',
      description:
        'Read the chart’s current state: symbol, timeframe, style, loaded studies, drawing count and toggles. Call this before changing something you were asked to change relative to "current".',
      run: () => {
        const studies = host.active().map((item) => {
          const def = indicatorById(item.defId);
          return {
            uid: item.uid,
            id: item.defId,
            label: def ? indicatorLabel(def, item.params) : item.defId,
            visible: item.visible,
            params: item.params,
          };
        });
        return ok(
          `${host.symbol()} ${host.resolution()} ${host.style()}, ${studies.length} stud${
            studies.length === 1 ? 'y' : 'ies'
          }, ${host.drawingCount()} drawing(s).`,
          {
            symbol: host.symbol(),
            timeframe: host.resolution(),
            style: host.style(),
            scaleMode: host.scaleMode(),
            timezone: host.timezone(),
            splitLayout: host.splitLayout(),
            volume: host.showVolume(),
            trades: host.showOverlays(),
            events: host.showEvents(),
            magnet: host.magnet(),
            boxSizeAtr: host.boxSizeAtr(),
            drawings: host.drawingCount(),
            studies,
          },
        );
      },
    },
    {
      id: 'chart.setSymbol',
      description: 'Change which instrument the chart shows.',
      params: [
        {
          name: 'symbol',
          type: 'string',
          required: true,
          description: 'Engine symbol, e.g. EURUSD.',
        },
      ],
      run: (a) => {
        const wanted = str(a, 'symbol').toUpperCase().replace(/\//g, '');
        const known = host.knownSymbols();
        const hit = known.find((s) => s.toUpperCase() === wanted);
        if (!hit) {
          return fail(
            `"${wanted}" is not a tracked pair. Known: ${known.slice(0, 12).join(', ')}${
              known.length > 12 ? '…' : ''
            }`,
          );
        }
        host.selectSymbol(hit);
        return ok(`Chart switched to ${hit}.`);
      },
    },
    {
      id: 'chart.setTimeframe',
      description: 'Change the chart timeframe.',
      params: [
        {
          name: 'timeframe',
          type: 'enum',
          required: true,
          values: SUPPORTED_RESOLUTIONS as readonly string[],
          description: 'TradingView resolution: 1, 5, 15, 30, 60, 240, 1D, 1W, 1M.',
        },
      ],
      run: (a) => {
        const tf = str(a, 'timeframe');
        host.selectResolution(tf);
        return ok(`Timeframe set to ${tf}.`);
      },
    },
    {
      id: 'chart.setStyle',
      description: 'Change how bars are drawn (candles, Heikin Ashi, Renko, Point & Figure, …).',
      params: [
        {
          name: 'style',
          type: 'enum',
          required: true,
          values: STYLES,
          description: 'Chart style.',
        },
      ],
      run: (a) => {
        host.style.set(str(a, 'style') as ChartStyle);
        return ok(`Chart style set to ${str(a, 'style')}.`);
      },
    },
    {
      id: 'chart.listIndicators',
      description:
        'List studies currently loaded on the chart, with their instance ids and parameters.',
      run: () => {
        const items = host.active().map((item) => {
          const def = indicatorById(item.defId);
          return {
            uid: item.uid,
            label: def ? indicatorLabel(def, item.params) : item.defId,
            visible: item.visible,
          };
        });
        return ok(
          items.length ? `Loaded: ${items.map((i) => i.label).join(', ')}.` : 'No studies loaded.',
          items,
        );
      },
    },
    {
      id: 'chart.addIndicator',
      description:
        'Add a study to the chart. Accepts the registry id or the display name ("rsi", "Relative Strength Index").',
      params: [
        { name: 'indicator', type: 'string', required: true, description: 'Which study to add.' },
      ],
      run: (a) => {
        const found = resolveDefinition(str(a, 'indicator'));
        if (typeof found === 'string') return fail(found);
        host.addIndicator(found.id);
        return ok(`Added ${found.name}.`);
      },
    },
    {
      id: 'chart.removeIndicator',
      description: 'Remove one loaded study, by name, id or the label shown in the studies strip.',
      params: [
        {
          name: 'indicator',
          type: 'string',
          required: true,
          description: 'Which study to remove.',
        },
      ],
      run: (a) => {
        const found = resolveActive(host, str(a, 'indicator'));
        if (typeof found === 'string') return fail(found);
        host.removeIndicator(found.item.uid);
        return ok(`Removed ${found.label}.`);
      },
    },
    {
      id: 'chart.removeAllIndicators',
      description: 'Remove every study from the chart. Drawings are not affected.',
      run: () => {
        const n = host.active().length;
        if (n === 0) return ok('No studies were loaded.');
        for (const item of [...host.active()]) host.removeIndicator(item.uid);
        return ok(`Removed ${n} stud${n === 1 ? 'y' : 'ies'}.`);
      },
    },
    {
      id: 'chart.setIndicatorVisible',
      description:
        'Hide or show a loaded study without removing it — the eye toggle in the studies strip.',
      params: [
        { name: 'indicator', type: 'string', required: true, description: 'Which study.' },
        { name: 'visible', type: 'boolean', required: true, description: 'true to show.' },
      ],
      run: (a) => {
        const found = resolveActive(host, str(a, 'indicator'));
        if (typeof found === 'string') return fail(found);
        const want = bool(a, 'visible');
        if (found.item.visible === want)
          return ok(`${found.label} is already ${want ? 'visible' : 'hidden'}.`);
        host.toggleIndicator(found.item.uid);
        return ok(`${want ? 'Showing' : 'Hid'} ${found.label}.`);
      },
    },
    {
      id: 'chart.setIndicatorParam',
      description: 'Change one numeric input of a loaded study, e.g. RSI length to 21.',
      params: [
        { name: 'indicator', type: 'string', required: true, description: 'Which study.' },
        {
          name: 'name',
          type: 'string',
          required: true,
          description: 'Parameter key, e.g. length.',
        },
        { name: 'value', type: 'number', required: true, description: 'New value.' },
      ],
      run: (a) => {
        const found = resolveActive(host, str(a, 'indicator'));
        if (typeof found === 'string') return fail(found);
        const def = indicatorById(found.item.defId);
        const key = str(a, 'name').toLowerCase();
        const input = def?.inputs.find((i) => i.key.toLowerCase() === key && i.type === 'number');
        if (!input) {
          const keys = def?.inputs.filter((i) => i.type === 'number').map((i) => i.key) ?? [];
          return fail(
            `${found.label} has no numeric input "${str(a, 'name')}". It has: ${
              keys.length ? keys.join(', ') : 'none'
            }.`,
          );
        }
        const value = Number(a['value']);
        // The studies strip clamps with min/max attributes; the assistant must not be able
        // to set a period the UI itself would refuse.
        const min = input.min ?? 1;
        const max = input.max ?? 500;
        if (value < min || value > max)
          return fail(`${input.key} must be between ${min} and ${max}.`);
        host.setIndicatorParam(found.item.uid, input.key, value);
        return ok(`${found.label}: ${input.key} → ${value}.`);
      },
    },
    {
      id: 'chart.setVolume',
      description: 'Show or hide the volume histogram.',
      params: [{ name: 'visible', type: 'boolean', required: true, description: 'true to show.' }],
      run: (a) => {
        host.showVolume.set(bool(a, 'visible'));
        return ok(`Volume ${bool(a, 'visible') ? 'shown' : 'hidden'}.`);
      },
    },
    {
      id: 'chart.setTrades',
      description: 'Show or hide open positions, order lines and trade-signal markers.',
      params: [{ name: 'visible', type: 'boolean', required: true, description: 'true to show.' }],
      run: (a) => {
        host.showOverlays.set(bool(a, 'visible'));
        return ok(`Trade overlays ${bool(a, 'visible') ? 'shown' : 'hidden'}.`);
      },
    },
    {
      id: 'chart.setEvents',
      description: 'Show or hide economic-event marks on the time axis.',
      params: [{ name: 'visible', type: 'boolean', required: true, description: 'true to show.' }],
      run: (a) => {
        host.showEvents.set(bool(a, 'visible'));
        return ok(`Economic events ${bool(a, 'visible') ? 'shown' : 'hidden'}.`);
      },
    },
    {
      id: 'chart.setMagnet',
      description: 'Turn magnet mode on or off — drawings snap to nearby OHLC values.',
      params: [
        { name: 'enabled', type: 'boolean', required: true, description: 'true to enable.' },
      ],
      run: (a) => {
        host.magnet.set(bool(a, 'enabled'));
        return ok(`Magnet ${bool(a, 'enabled') ? 'on' : 'off'}.`);
      },
    },
    {
      id: 'chart.setScaleMode',
      description: 'Switch the price scale between normal, logarithmic and percentage.',
      params: [
        {
          name: 'mode',
          type: 'enum',
          required: true,
          values: ['normal', 'log', 'percent'],
          description: 'Price scale mode.',
        },
      ],
      run: (a) => {
        host.scaleMode.set(str(a, 'mode') as 'normal' | 'log' | 'percent');
        return ok(`Price scale: ${str(a, 'mode')}.`);
      },
    },
    {
      id: 'chart.setSplit',
      description:
        'Change the multi-chart layout: 1 chart, 2 side by side (2h) or stacked (2v), 4, 6 or 8.',
      params: [
        {
          name: 'layout',
          type: 'enum',
          required: true,
          values: ['1', '2h', '2v', '4', '6', '8'],
          description: 'Layout id.',
        },
      ],
      run: (a) => {
        host.setSplitLayout(str(a, 'layout') as '1' | '2h' | '2v' | '4' | '6' | '8');
        return ok(`Layout: ${str(a, 'layout')}.`);
      },
    },
    {
      id: 'chart.setTimezone',
      description: 'Change the timezone the time axis is drawn in.',
      params: [
        {
          name: 'timezone',
          type: 'string',
          required: true,
          description: 'e.g. UTC, London, New York.',
        },
      ],
      run: (a) => {
        const q = str(a, 'timezone').toLowerCase();
        const zones = host.timezones();
        // Match the LABEL as well as the id: an operator says "New York", not
        // "America/New_York", and so will the model quoting them.
        const hit =
          zones.find((z) => z.id.toLowerCase() === q || z.label.toLowerCase() === q) ??
          zones.find((z) => z.label.toLowerCase().includes(q) || z.id.toLowerCase().includes(q));
        if (!hit)
          return fail(`Unknown timezone. Available: ${zones.map((z) => z.label).join(', ')}.`);
        host.timezone.set(hit.id);
        return ok(`Time axis in ${hit.label}.`);
      },
    },
    {
      id: 'chart.setBoxSize',
      description:
        'Set the box size for the price-based styles (Renko, Kagi, Point & Figure) as a multiple of ATR.',
      params: [
        {
          name: 'multiple',
          type: 'number',
          required: true,
          description: 'ATR multiple, 0.1 to 20.',
        },
      ],
      run: (a) => {
        const v = Number(a['multiple']);
        if (v < 0.1 || v > 20) return fail('Box size must be between 0.1 and 20 × ATR.');
        host.boxSizeAtr.set(v);
        return ok(`Box size: ${v} × ATR.`);
      },
    },
    {
      id: 'chart.selectTool',
      description:
        'Arm a drawing tool so the operator’s next clicks place it. Pass "none" to go back to the cursor.',
      params: [
        {
          name: 'tool',
          type: 'string',
          required: true,
          description: 'Tool name as shown in the drawing rail, e.g. "Trend Line", or "none".',
        },
      ],
      run: (a) => {
        const q = str(a, 'tool').toLowerCase();
        if (q === 'none' || q === 'cursor') {
          host.selectTool(null);
          return ok('Back to the cursor.');
        }
        const hits = TOOLS.filter(
          (t) => t.kind.toLowerCase() === q || t.label.toLowerCase() === q,
        ).concat(
          TOOLS.filter(
            (t) => t.label.toLowerCase().includes(q) || t.kind.toLowerCase().includes(q),
          ),
        );
        const unique = hits.filter((t, i) => hits.findIndex((x) => x.kind === t.kind) === i);
        if (unique.length === 0) return fail(`No drawing tool matches "${str(a, 'tool')}".`);
        if (
          unique.length > 1 &&
          unique[0].label.toLowerCase() !== q &&
          unique[0].kind.toLowerCase() !== q
        ) {
          return fail(
            `"${str(a, 'tool')}" matches ${unique.length} tools: ${unique
              .slice(0, 8)
              .map((t) => t.label)
              .join(', ')}. Name one exactly.`,
          );
        }
        host.selectTool(unique[0].kind);
        // Deliberately explicit: arming a tool changes nothing until the operator clicks.
        return ok(`${unique[0].label} armed — click on the chart to place it.`);
      },
    },
    {
      id: 'chart.clearDrawings',
      // The one destructive command here. Drawings persist server-side and the delete has
      // no undo once it reaches the engine, so this asks first.
      confirm: true,
      description:
        'Delete every drawing on the current symbol and timeframe. This cannot be undone.',
      run: () => {
        const n = host.drawingCount();
        if (n === 0) return ok('There were no drawings to clear.');
        host.clearDrawings();
        return ok(`Cleared ${n} drawing(s).`);
      },
    },
    {
      id: 'chart.snapshot',
      description: 'Save a PNG of the chart as it currently looks.',
      run: () => {
        host.takeSnapshot();
        return ok('Snapshot saved.');
      },
    },
  ];
}
