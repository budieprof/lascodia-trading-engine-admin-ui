import type { UiCommand } from '@core/assistant/ui-command.types';
import { formatResolution } from '../datafeed/resolution';

/**
 * The chart's command palette (CC-I11), driven by `chart-commands.ts`: every chart command the assistant can run is
 * offered to the operator too, one entry per concrete choice ("Timeframe: 4h", "Style: Renko", "Add indicator: RSI",
 * "Volume: off"). An entry is a command id and its arguments, run through the same handler — so the palette never
 * drifts from what the commands do.
 *
 * Commands that read (describe, list, levels) are not entries; neither are those that need free input (a number, a
 * name, coordinates) — the toolbar and dialogs have those.
 */
export interface PaletteAction {
  /** Stable: `commandId` + its arguments. */
  id: string;
  title: string;
  /** What the command does (its description), shown under the title. */
  detail: string;
  /** Extra words it is found by. */
  keywords: string;
  commandId: string;
  args: Record<string, unknown>;
  /** Destroys work: asked before it runs. */
  confirm: boolean;
}

/** Choices for the commands' free-text parameters, from the page. */
export interface PaletteChoices {
  symbols: readonly string[];
  /** Indicator definitions (id, name) the chart can add. */
  indicators: readonly { id: string; name: string }[];
  /** Studies on the chart, for Remove / Show / Hide. */
  active: readonly { uid: string; label: string }[];
  tools: readonly { label: string }[];
  timezones: readonly { id: string; label: string }[];
  /** A style's label ("Heikin Ashi" for `heikin-ashi`). */
  styleLabel?: (style: string) => string;
}

/** Commands that only read: nothing to do from a palette. */
const READS = new Set(['chart.describe', 'chart.listIndicators', 'chart.listDrawings', 'chart.readLevels']);

/** What each command is called in the palette (its subject); the value follows after a colon. */
const SUBJECT: Record<string, string> = {
  'chart.setSymbol': 'Symbol',
  'chart.setTimeframe': 'Timeframe',
  'chart.setStyle': 'Style',
  'chart.addIndicator': 'Add indicator',
  'chart.removeIndicator': 'Remove indicator',
  'chart.setIndicatorVisible': 'Indicator',
  'chart.removeAllIndicators': 'Remove all indicators',
  'chart.setVolume': 'Volume',
  'chart.setTrades': 'Trades and signals',
  'chart.setEvents': 'Economic events',
  'chart.setMagnet': 'Magnet',
  'chart.setScaleMode': 'Scale',
  'chart.setSplit': 'Split layout',
  'chart.setTimezone': 'Time zone',
  'chart.selectTool': 'Drawing tool',
  'chart.clearDrawings': 'Remove all drawings',
  'chart.navigate': 'Go to',
  'chart.replay': 'Bar replay',
  'chart.loadMoreHistory': 'Load more history',
  'chart.setEventImpact': 'Event importance',
  'chart.setSidePane': 'Side pane',
  'chart.setPanel': 'Panel',
  'chart.setFullscreen': 'Fullscreen',
  'chart.setOverlay': 'Overlay',
  'chart.snapshot': 'Take a snapshot',
};

/** How an enum value reads, per command and parameter. */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  'chart.setScaleMode.mode': { normal: 'Regular', log: 'Logarithmic', percent: 'Percent', indexed: 'Indexed to 100' },
  'chart.setSplit.layout': {
    '1': 'One chart',
    '2h': 'Two side by side',
    '2v': 'Two stacked',
    '4': 'Four',
    '6': 'Six',
    '8': 'Eight',
  },
  'chart.navigate.mode': { fit: 'All bars', latest: 'Latest bar', resetScales: 'Reset scales' },
  'chart.replay.action': { start: 'Start', stop: 'Exit', play: 'Play', pause: 'Pause' },
  'chart.setSidePane.pane': {
    none: 'Closed',
    details: 'Details',
    news: 'News',
    calendar: 'Economic calendar',
    datawindow: 'Data window',
  },
  'chart.setPanel.panel': { watchlist: 'Watchlist', objects: 'Drawings' },
  'chart.setOverlay.overlay': {
    volumeProfile: 'Volume profile',
    supportResistance: 'Support and resistance',
    structure: 'Market structure',
  },
};

/**
 * Enum values a command offers in the palette when not all of them stand alone (the rest need more input, or only
 * read). Absent: every value.
 */
const OFFERED: Record<string, readonly string[]> = {
  'chart.navigate.mode': ['fit', 'latest', 'resetScales'],
  'chart.replay.action': ['start', 'stop', 'play', 'pause'],
};

/** Commands whose arguments the palette cannot supply (a name, a number, coordinates). */
const NEEDS_INPUT = new Set([
  'chart.setIndicatorParam',
  'chart.setBoxSize',
  'chart.placeDrawing',
  'chart.removeDrawing',
  'chart.styleDrawing',
  'chart.layouts',
  'chart.studyTemplates',
]);

const BOOL_WORDS: Record<string, [string, string]> = {
  'chart.setFullscreen': ['Enter', 'Leave'],
  'chart.setMagnet': ['On', 'Off'],
};

/** Every palette entry the chart's commands make, given the page's choices. */
export function buildPaletteActions(commands: readonly UiCommand[], choices: PaletteChoices): PaletteAction[] {
  const out: PaletteAction[] = [];
  for (const cmd of commands) {
    if (READS.has(cmd.id) || NEEDS_INPUT.has(cmd.id)) continue;
    const subject = SUBJECT[cmd.id] ?? cmd.description;
    const add = (value: string | null, args: Record<string, unknown>, keywords = ''): void => {
      const title = value === null ? subject : `${subject}: ${value}`;
      out.push({
        id: `${cmd.id}|${JSON.stringify(args)}`,
        title,
        detail: cmd.description,
        keywords: `${keywords} ${cmd.id.replace('chart.', '')}`.trim(),
        commandId: cmd.id,
        args,
        confirm: cmd.confirm === true,
      });
    };
    for (const combo of expand(cmd, choices)) add(combo.label, combo.args, combo.keywords);
  }
  return out;
}

interface Combo {
  label: string | null;
  args: Record<string, unknown>;
  keywords: string;
}

/** The concrete argument sets of one command. */
function expand(cmd: UiCommand, c: PaletteChoices): Combo[] {
  const required = (cmd.params ?? []).filter((p) => p.required);
  if (required.length === 0) return [{ label: null, args: {}, keywords: '' }];
  // The free-text parameters the page has choices for.
  const single = (name: string, values: readonly { value: string; label: string; keywords?: string }[]): Combo[] =>
    values.map((v) => ({ label: v.label, args: { [name]: v.value }, keywords: v.keywords ?? '' }));
  switch (cmd.id) {
    case 'chart.setSymbol':
      return single('symbol', c.symbols.map((s) => ({ value: s, label: s })));
    case 'chart.addIndicator':
      return single('indicator', c.indicators.map((d) => ({ value: d.id, label: d.name, keywords: d.id })));
    case 'chart.removeIndicator':
      return single('indicator', c.active.map((a) => ({ value: a.uid, label: a.label })));
    case 'chart.setIndicatorVisible':
      return c.active.flatMap((a) => [
        { label: `show ${a.label}`, args: { indicator: a.uid, visible: true }, keywords: 'show' },
        { label: `hide ${a.label}`, args: { indicator: a.uid, visible: false }, keywords: 'hide' },
      ]);
    case 'chart.selectTool':
      return single('tool', [{ label: 'none' }, ...c.tools].map((t) => ({
        value: t.label,
        label: t.label === 'none' ? 'Cursor' : t.label,
        keywords: 'draw',
      })));
    case 'chart.setTimezone':
      return single('timezone', c.timezones.map((z) => ({ value: z.id, label: z.label, keywords: z.id })));
  }
  // Enums and booleans only: every combination.
  if (!required.every((p) => p.type === 'enum' || p.type === 'boolean')) return [];
  let combos: Combo[] = [{ label: '', args: {}, keywords: '' }];
  for (const p of required) {
    const key = `${cmd.id}.${p.name}`;
    const values: { value: unknown; label: string }[] =
      p.type === 'boolean'
        ? [
            { value: true, label: BOOL_WORDS[cmd.id]?.[0] ?? 'on' },
            { value: false, label: BOOL_WORDS[cmd.id]?.[1] ?? 'off' },
          ]
        : (OFFERED[key] ?? p.values ?? []).map((v) => ({ value: v, label: enumLabel(cmd.id, p.name, v, c) }));
    combos = combos.flatMap((combo) =>
      values.map((v) => ({
        label: combo.label ? `${combo.label} ${v.label}` : v.label,
        args: { ...combo.args, [p.name]: v.value },
        keywords: `${combo.keywords} ${String(v.value)}`.trim(),
      })),
    );
  }
  return combos;
}

function enumLabel(commandId: string, param: string, value: string, c: PaletteChoices): string {
  const mapped = VALUE_LABELS[`${commandId}.${param}`]?.[value];
  if (mapped) return mapped;
  if (commandId === 'chart.setTimeframe') return formatResolution(value);
  if (commandId === 'chart.setStyle') return c.styleLabel?.(value) ?? value;
  return value;
}

/**
 * The entries matching `query`, best first: every word of it must appear in the title or its keywords; titles that
 * start with the query lead, then those with a word starting with it. An empty query lists `recent` first.
 */
export function filterActions(
  actions: readonly PaletteAction[],
  query: string,
  recent: readonly string[] = [],
  limit = 50,
): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    const byId = new Map(actions.map((a) => [a.id, a]));
    const first = recent.map((id) => byId.get(id)).filter((a): a is PaletteAction => !!a);
    const rest = actions.filter((a) => !recent.includes(a.id));
    return [...first, ...rest].slice(0, limit);
  }
  const words = q.split(/\s+/);
  const scored: { a: PaletteAction; score: number; i: number }[] = [];
  actions.forEach((a, i) => {
    const title = a.title.toLowerCase();
    const hay = `${title} ${a.keywords.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    const score = title.startsWith(q)
      ? 0
      : title.split(/[\s:]+/).some((w) => w.startsWith(words[0]))
        ? 1
        : title.includes(q)
          ? 2
          : 3;
    scored.push({ a, score: score - (recent.includes(a.id) ? 0.5 : 0), i });
  });
  return scored
    .sort((x, y) => x.score - y.score || x.i - y.i)
    .slice(0, limit)
    .map((s) => s.a);
}
