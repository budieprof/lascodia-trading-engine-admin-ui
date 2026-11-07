import { computed, signal } from '@angular/core';

/** The part of a chart script the editor reads. */
export interface EditorScriptItem {
  key: string;
  name: string;
  pineSource?: string | null;
  strategyId?: number | null;
}

/** The part of a chart script run the editor reads. */
export interface EditorScriptRun<I extends EditorScriptItem = EditorScriptItem> {
  item: I;
  result: { title?: string | null; kind: string };
}

/** What the editor reads on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartEditorStateDeps<I extends EditorScriptItem, R extends EditorScriptRun<I>> {
  scriptRuns: () => readonly R[];
  /** Scripts whose first run failed: not on the chart yet, but the editor can show (and fix) them. */
  pendingScripts: () => ReadonlyMap<string, { item: I }>;
  /** The dock: opening the editor shows it and brings it to the front. */
  dock: { editorOpen: { set(open: boolean): void; (): boolean }; frontDock(which: 'editor'): void };
  /**
   * Read an engine strategy's Pine source; `done` receives it ('' when it has none or the read failed). The page ties
   * the read to its lifetime.
   */
  fetchStrategySource: (id: number, done: (source: string) => void) => void;
}

/**
 * U13 (fu-ui) — the Pine Editor's link to the chart, moved out of the chart page unchanged: which chart script the editor
 * shows ({@link editorKey}, {@link editorTarget}), engine strategy sources fetched once per id, the "cleared" state after
 * the shown script was removed, the editor's current text ({@link editorDraft}) and text pushed into it by the assistant
 * or a layout ({@link assistSource}). The page keeps its old member names as aliases of these signals.
 */
export class ChartEditorState<
  I extends EditorScriptItem = EditorScriptItem,
  R extends EditorScriptRun<I> = EditorScriptRun<I>,
> {
  constructor(private readonly deps: ChartEditorStateDeps<I, R>) {}

  /** The chart script the editor is showing (its run key), or null for a new script. */
  readonly editorKey = signal<string | null>(null);
  /** Engine strategy sources, fetched once per id. */
  readonly strategySources = signal<Record<number, string | null>>({});
  readonly editorTarget = computed(() => {
    const runs = this.deps.scriptRuns();
    const key = this.editorKey();
    const run = runs.find((r) => r.item.key === key) ?? null;
    // A script whose first run failed is not on the chart yet, but its source can be fixed here.
    const pending = run || key === null ? null : (this.deps.pendingScripts().get(key) ?? null);
    const item = run?.item ?? pending?.item;
    if (!item) return null;
    const id = item.strategyId ?? null;
    const source = item.pineSource ?? (id !== null ? (this.strategySources()[id] ?? null) : null);
    return {
      key: item.key,
      name: run?.result.title || item.name,
      source,
      strategyId: id,
      loading: id !== null && source === null,
    };
  });

  /**
   * The operator removed the script the editor showed: until it is pointed at a script again, the editor opens on the
   * starter template. Saved with the layout's dock, so a reload does not bring a chart script back into it.
   */
  readonly editorCleared = signal(false);

  /** The editor's current text, for the script it shows — kept here so it reads even with the tester in front. */
  readonly editorDraft = signal<{ key: string | null; text: string } | null>(null);
  /** Text the assistant (or a layout, or a draft) wrote, pushed into the editor (a new seq applies it). */
  readonly assistSource = signal<{ text: string; seq: number } | null>(null);
  private assistSeq = 0;

  /** Push text into the editor (a new seq, so the editor applies it even when the text is the same). */
  pushAssist(text: string): void {
    this.assistSource.set({ text, seq: ++this.assistSeq });
  }

  /** Point the editor at a chart script, loading an engine strategy's source when needed. */
  openScriptSource(key: string | null): void {
    if (key !== this.editorKey()) this.assistSource.set(null);
    const runs = this.deps.scriptRuns();
    // Unlinked, it shows the chart's strategy or newest script — unless a removal cleared it.
    const fallback = this.editorCleared()
      ? null
      : ((runs.find((r) => r.result.kind === 'strategy') ?? runs[runs.length - 1])?.item.key ??
        null);
    const target = key ?? fallback;
    if (target !== null) this.editorCleared.set(false);
    this.editorKey.set(target);
    const item =
      runs.find((r) => r.item.key === target)?.item ??
      (target !== null ? this.deps.pendingScripts().get(target)?.item : undefined);
    const id = item?.strategyId;
    if (id !== undefined && id !== null && !item?.pineSource && !(id in this.strategySources())) {
      this.deps.fetchStrategySource(id, (source) =>
        this.strategySources.update((m) => ({ ...m, [id]: source })),
      );
    }
    this.deps.dock.editorOpen.set(true);
    this.deps.dock.frontDock('editor');
  }

  onEditorSource(text: string): void {
    this.editorDraft.set({ key: this.editorKey(), text });
  }

  /** The editor's text for the script it shows: the draft when it is that script's, else its source. */
  draftText(): string {
    const d = this.editorDraft();
    if (d && d.key === this.editorKey()) return d.text;
    return this.editorTarget()?.source ?? '';
  }

  /** The assistant writes the editor's text (opening the editor on its script first). */
  writeDraft(text: string): void {
    if (!this.deps.dock.editorOpen()) this.openScriptSource(this.editorKey());
    this.deps.dock.frontDock('editor');
    this.editorDraft.set({ key: this.editorKey(), text });
    this.pushAssist(text);
  }
}
