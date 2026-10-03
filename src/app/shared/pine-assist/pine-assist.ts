import type { UiCommand, UiCommandOutcome } from '@core/assistant/ui-command.types';

/**
 * Page commands that let the admin assistant work on the Pine script the operator has open,
 * live: read it, patch it, compile it, run it, read the results, and (on the strategy edit
 * page) save it — the same operations the operator's own buttons perform.
 *
 * Both Pine editors register these through one adapter, so the assistant sees the same
 * vocabulary on the chart page's Pine Editor and on the strategy edit page:
 *
 *   pine.read / pine.edit / pine.replaceLines / pine.setSource      — the live editor text
 *   pine.toBuffer / pine.fromBuffer                                 — move text to/from the
 *        assistant's server-side buffers (for long scripts, saves and backtests)
 *   pine.compile / pine.run                                         — compile; run on bars
 *   strategy.results / strategy.trade / strategy.focusTrade         — read what the run did
 *   strategy.setInput                                               — change an input and re-run
 *   strategy.save                                                   — save to the engine (confirm)
 *
 * Every write to the editor is applied exactly (find/replace must match once unless `all`)
 * and is undoable with the editor's own undo, because it goes through the same setter the
 * keyboard uses.
 */

export interface PineDiagnostic {
  line: number;
  column: number;
  severity: string;
  message: string;
  code?: string;
}

export interface PineRunSummary {
  title: string;
  kind: 'indicator' | 'strategy' | 'library' | string;
  /** Headline metrics for a strategy (net profit, PF, win rate, drawdown, trades). */
  metrics: Record<string, number | string | null>;
  tradeCount: number;
  warnings: string[];
}

export interface PineTradeRow {
  number: number;
  side: string;
  entryTime: string;
  entryPrice: number;
  entrySignal: string;
  exitTime: string | null;
  exitPrice: number | null;
  exitSignal: string | null;
  qty: number;
  profit: number;
  profitPercent: number | null;
}

export interface PineInput {
  id: string;
  title: string;
  kind: string;
  value: unknown;
  defaultValue: unknown;
  options?: readonly unknown[] | null;
  min?: number | null;
  max?: number | null;
}

/** What a page must provide. Optional members simply leave their commands out. */
export interface PineEditorAdapter {
  /** Where this editor lives, for messages: "Pine Editor (chart)" or "strategy #1154". */
  label(): string;
  getSource(): string;
  setSource(source: string): void;
  /** The editor is open / the page can show it. Commands open it when this exists. */
  ensureVisible?(): void;
  compile(): Promise<{ ok: boolean; diagnostics: PineDiagnostic[]; title?: string | null; kind?: string | null }>;
  /** Run the current source on the page's bars (chart: update/add on chart; edit page: preview). */
  run(): Promise<PineRunSummary | { error: string }>;
  /** The last run's results, or null when nothing has run. */
  results?(): { summary: PineRunSummary; trades: PineTradeRow[] } | null;
  /** Full detail of one trade (fills, excursions, plotted values at entry/exit, inputs). */
  tradeDetail?(n: number): unknown | null;
  focusTrade?(n: number): boolean;
  inputs?(): PineInput[];
  /** Change one input and re-run. */
  setInput?(id: string, value: unknown): Promise<PineRunSummary | { error: string }>;
  /** Save to the engine strategy. Confirm-gated by the command. */
  save?(reason: string): Promise<{ ok: boolean; message: string }>;
  /** Load a server-side assistant buffer's text (via the engine). */
  readBuffer?(name: string): Promise<string | null>;
}

const MAX_READ_LINES = 400;
const MAX_SET_CHARS = 60_000;

function numbered(lines: readonly string[], from: number): string {
  const width = String(from + lines.length - 1).length;
  return lines.map((l, i) => `${String(from + i).padStart(width, ' ')}| ${l}`).join('\n');
}

/** Exact find/replace, all-or-nothing, like the server's buffer_edit. */
export function applyExactEdit(
  source: string,
  find: string,
  replace: string,
  all: boolean,
): { ok: true; source: string; count: number; firstLine: number } | { ok: false; error: string } {
  if (!find) return { ok: false, error: '`find` is empty.' };
  let count = 0;
  let at = source.indexOf(find);
  const first = at;
  while (at !== -1) {
    count++;
    at = source.indexOf(find, at + find.length);
  }
  if (count === 0) return { ok: false, error: '`find` was not found. Read the lines first with pine.read; it must match exactly (spaces and quotes included).' };
  if (count > 1 && !all)
    return { ok: false, error: `\`find\` matches ${count} places. Include a neighbouring line to make it unique, or pass all:true.` };
  const next = all ? source.split(find).join(replace) : source.slice(0, first) + replace + source.slice(first + find.length);
  return { ok: true, source: next, count, firstLine: source.slice(0, first).split('\n').length };
}

export function pineAssistCommands(a: PineEditorAdapter): UiCommand[] {
  const where = () => a.label();
  const cmds: UiCommand[] = [
    {
      id: 'pine.read',
      description: `Read the Pine script open in the ${'editor'} (numbered lines, unsaved edits included). Page long scripts with fromLine/lines.`,
      params: [
        { name: 'fromLine', type: 'number', description: 'First line to return (1-based). Default 1.' },
        { name: 'lines', type: 'number', description: `How many lines (max ${MAX_READ_LINES}). Default 200.` },
      ],
      run: (args) => {
        a.ensureVisible?.();
        const all = a.getSource().split('\n');
        const from = Math.max(1, Math.floor(Number(args['fromLine'] ?? 1)));
        const n = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(Number(args['lines'] ?? 200))));
        const slice = all.slice(from - 1, from - 1 + n);
        const to = from + slice.length - 1;
        return {
          ok: true,
          message: `Read lines ${from}–${to} of ${all.length} from ${where()}.`,
          data: { totalLines: all.length, fromLine: from, toLine: to, more: to < all.length, text: numbered(slice, from) },
        };
      },
    },
    {
      id: 'pine.edit',
      description:
        'Patch the open Pine script: replace an exact piece of text (must match once unless all:true). Use several calls for several edits; read first.',
      params: [
        { name: 'find', type: 'string', description: 'Exact text to replace, copied from pine.read (without line numbers).', required: true },
        { name: 'replace', type: 'string', description: 'Replacement text (may be empty to delete).', required: true },
        { name: 'all', type: 'boolean', description: 'Replace every occurrence. Default false.' },
      ],
      run: (args) => {
        a.ensureVisible?.();
        const r = applyExactEdit(a.getSource(), String(args['find'] ?? ''), String(args['replace'] ?? ''), args['all'] === true);
        if (!r.ok) return { ok: false, message: r.error };
        a.setSource(r.source);
        return { ok: true, message: `Edited ${r.count} place${r.count > 1 ? 's' : ''} (first at line ${r.firstLine}) in ${where()}. Not saved yet.` };
      },
    },
    {
      id: 'pine.replaceLines',
      description: 'Replace a range of lines in the open Pine script (inclusive). toLine = fromLine - 1 inserts before fromLine.',
      params: [
        { name: 'fromLine', type: 'number', description: 'First line to replace (1-based).', required: true },
        { name: 'toLine', type: 'number', description: 'Last line to replace (inclusive).', required: true },
        { name: 'text', type: 'string', description: 'New text for those lines (newline-separated).', required: true },
      ],
      run: (args) => {
        a.ensureVisible?.();
        const lines = a.getSource().split('\n');
        const from = Math.floor(Number(args['fromLine']));
        const to = Math.floor(Number(args['toLine']));
        if (!(from >= 1 && from <= lines.length + 1 && to >= from - 1 && to <= lines.length))
          return { ok: false, message: `Line range ${from}–${to} is outside the script (1–${lines.length}).` };
        const text = String(args['text'] ?? '');
        lines.splice(from - 1, to - from + 1, ...text.split('\n'));
        a.setSource(lines.join('\n'));
        return { ok: true, message: `Replaced lines ${from}–${to} in ${where()}. Not saved yet.` };
      },
    },
    {
      id: 'pine.setSource',
      description: `Replace the whole open Pine script with new text (up to ${MAX_SET_CHARS} chars). For longer scripts write a buffer and use pine.fromBuffer.`,
      params: [{ name: 'source', type: 'string', description: 'The complete new Pine v6 script.', required: true }],
      run: (args) => {
        const src = String(args['source'] ?? '');
        if (!src.trim()) return { ok: false, message: 'The new source is empty.' };
        if (src.length > MAX_SET_CHARS) return { ok: false, message: 'Too long for one command; use a buffer and pine.fromBuffer.' };
        a.ensureVisible?.();
        a.setSource(src);
        return { ok: true, message: `Replaced the script in ${where()} (${src.split('\n').length} lines). Not saved yet.` };
      },
    },
    {
      id: 'pine.toBuffer',
      description:
        'Copy the open Pine script (unsaved edits included) into one of your text buffers, so you can buffer_edit it or pass it as {"$buffer":name} to Scripting_Compile/Run, Strategy_UpdateScript or a backtest.',
      params: [{ name: 'name', type: 'string', description: 'Buffer name (letters, digits, _ . -).', required: true }],
      run: (args) => {
        const name = String(args['name'] ?? '');
        if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) return { ok: false, message: 'Buffer name must be 1-40 of A-Z a-z 0-9 _ . -' };
        const text = a.getSource();
        return {
          ok: true,
          message: `Copied ${text.split('\n').length} lines from ${where()} into buffer "${name}".`,
          data: { buffer: { name, text } },
        };
      },
    },
  ];
  if (a.readBuffer) {
    const readBuffer = a.readBuffer.bind(a);
    cmds.push({
      id: 'pine.fromBuffer',
      description: 'Replace the open Pine script with the text of one of your buffers (for long scripts you wrote or edited with buffer_* tools).',
      params: [{ name: 'name', type: 'string', description: 'Buffer name.', required: true }],
      run: async (args) => {
        const name = String(args['name'] ?? '');
        const text = await readBuffer(name);
        if (text === null) return { ok: false, message: `No buffer "${name}" in this conversation.` };
        a.ensureVisible?.();
        a.setSource(text);
        return { ok: true, message: `Loaded buffer "${name}" (${text.split('\n').length} lines) into ${where()}. Not saved yet.` };
      },
    });
  }
  cmds.push(
    {
      id: 'pine.compile',
      description: 'Compile the open Pine script and return every error and warning with its line and column.',
      run: async () => {
        const r = await a.compile();
        const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
        return {
          ok: true,
          message: r.ok
            ? `Compiled cleanly${r.diagnostics.length ? ` with ${r.diagnostics.length} warning(s)` : ''}.`
            : `Compile failed: ${errors} error(s).`,
          data: { ok: r.ok, title: r.title ?? null, kind: r.kind ?? null, diagnostics: r.diagnostics.slice(0, 50) },
        };
      },
    },
    {
      id: 'pine.run',
      description: 'Run the open Pine script on the page\'s bars (the chart: update it on the chart; the strategy page: run the preview) and return the headline results.',
      run: async () => {
        const r = await a.run();
        if ('error' in r) return { ok: false, message: r.error };
        return { ok: true, message: `Ran "${r.title}": ${r.tradeCount} trade(s).`, data: r };
      },
    },
  );
  if (a.results) {
    const results = a.results.bind(a);
    cmds.push({
      id: 'strategy.results',
      description: "Read the last run's strategy results: headline metrics and a page of the List of trades.",
      params: [
        { name: 'offset', type: 'number', description: 'First trade index (0-based). Default 0.' },
        { name: 'limit', type: 'number', description: 'Trades to return (max 100). Default 50.' },
      ],
      run: (args) => {
        const r = results();
        if (!r) return { ok: false, message: 'Nothing has run yet. Use pine.run first.' };
        const offset = Math.max(0, Math.floor(Number(args['offset'] ?? 0)));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(args['limit'] ?? 50))));
        const page = r.trades.slice(offset, offset + limit);
        return {
          ok: true,
          message: `${r.summary.title}: ${r.trades.length} trades; returned ${page.length} from #${offset + 1}.`,
          data: { summary: r.summary, totalTrades: r.trades.length, offset, nextOffset: offset + page.length < r.trades.length ? offset + page.length : null, trades: page },
        };
      },
    });
  }
  if (a.tradeDetail) {
    const detail = a.tradeDetail.bind(a);
    cmds.push({
      id: 'strategy.trade',
      description: 'Full detail of one trade: fills, exit leg, run-up/drawdown, bars held, every plotted series at the entry and exit bars, OHLC, inputs.',
      params: [{ name: 'number', type: 'number', description: 'Trade number from the List of trades.', required: true }],
      run: (args) => {
        const d = detail(Math.floor(Number(args['number'])));
        return d ? { ok: true, message: `Trade #${args['number']} detail.`, data: d } : { ok: false, message: `No trade #${args['number']}.` };
      },
    });
  }
  if (a.focusTrade) {
    const focus = a.focusTrade.bind(a);
    cmds.push({
      id: 'strategy.focusTrade',
      description: 'Pan and zoom the chart to one trade so the operator can see it.',
      params: [{ name: 'number', type: 'number', description: 'Trade number.', required: true }],
      run: (args) => {
        const n = Math.floor(Number(args['number']));
        return focus(n) ? { ok: true, message: `Showing trade #${n} on the chart.` } : { ok: false, message: `No trade #${n} on the chart.` };
      },
    });
  }
  if (a.inputs && a.setInput) {
    const inputs = a.inputs.bind(a);
    const setInput = a.setInput.bind(a);
    cmds.push(
      {
        id: 'strategy.inputs',
        description: 'List the script inputs (id, title, kind, current value, default, options, min/max).',
        run: () => ({ ok: true, message: `${inputs().length} input(s).`, data: inputs() }),
      },
      {
        id: 'strategy.setInput',
        description: 'Change one script input (by id from strategy.inputs) and re-run. Does not edit the source.',
        params: [
          { name: 'id', type: 'string', description: 'Input id.', required: true },
          { name: 'value', type: 'string', description: 'New value (numbers and true/false are converted).', required: true },
        ],
        run: async (args) => {
          const def = inputs().find((i) => i.id === String(args['id']));
          if (!def) return { ok: false, message: `No input "${args['id']}". Use strategy.inputs.` };
          const raw = String(args['value'] ?? '');
          const value: unknown =
            typeof def.defaultValue === 'number' ? Number(raw) : typeof def.defaultValue === 'boolean' ? raw === 'true' : raw;
          if (typeof value === 'number' && !Number.isFinite(value)) return { ok: false, message: `"${raw}" is not a number.` };
          const r = await setInput(def.id, value);
          if ('error' in r) return { ok: false, message: r.error };
          return { ok: true, message: `Set ${def.title} = ${String(value)} and re-ran: ${r.tradeCount} trade(s).`, data: r };
        },
      },
    );
  }
  if (a.save) {
    const save = a.save.bind(a);
    cmds.push({
      id: 'strategy.save',
      description: 'Save the edited script to the engine strategy (restarts its live session; never closes positions). The operator must confirm.',
      params: [{ name: 'reason', type: 'string', description: 'Change reason recorded in the version history.', required: true }],
      confirm: true,
      run: async (args): Promise<UiCommandOutcome> => {
        const reason = String(args['reason'] ?? '').trim();
        if (!reason) return { ok: false, message: 'A change reason is required.' };
        return save(reason);
      },
    });
  }
  return cmds;
}

/** A compact, always-current description of the editor for the assistant's page context. */
export function pineEditorFacts(a: PineEditorAdapter): Record<string, unknown> {
  const src = a.getSource();
  const r = a.results?.() ?? null;
  return {
    pineEditor: {
      where: a.label(),
      lines: src.split('\n').length,
      chars: src.length,
      head: src.split('\n').slice(0, 3).join('\n').slice(0, 300),
      lastRun: r ? { ...r.summary, trades: r.trades.length } : null,
      howTo: 'Use the pine.* and strategy.* page commands to read, edit, compile, run and inspect this script live.',
    },
  };
}
