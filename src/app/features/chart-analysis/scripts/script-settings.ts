import { computed, linkedSignal, signal, type WritableSignal } from '@angular/core';
import type { Observable } from 'rxjs';

import type {
  ScriptInputDto,
  ScriptInputValues,
  ScriptStrategyPropertyOverrides,
} from '@core/api/scripting.types';
import { sameInputValues, withSavedDefaults } from '@features/scripting/pine/pine-inputs';
import { savedScriptId, type ChartScriptItem, type SavedChartScript } from './chart-script.service';
import {
  readTemplates,
  templateScope,
  withTemplate,
  withoutTemplate,
  writeTemplates,
  type ScriptInputTemplate,
  type ScriptInputTemplates,
} from './script-input-templates';

/** A Pine run on the chart, as far as its Settings dialog reads it. */
export interface SettingsRun {
  item: ChartScriptItem;
  result: { inputs: readonly ScriptInputDto[]; title?: string };
  /** The input overrides the script runs with. */
  values: ScriptInputValues;
}

/** What the Settings dialog needs of the page. */
export interface ScriptSettingsHost {
  /** An explicit run of a script on the chart with these overrides (supersedes the one in flight). */
  run(item: ChartScriptItem, values: ScriptInputValues): void;
  /** An engine strategy's stored inputs (`GET strategy/{id}`). */
  storedInputs(strategyId: number): Observable<ScriptInputValues>;
  /** "Save as default" for a script in "My scripts". */
  saveDefault(id: string, values: ScriptInputValues): Observable<SavedChartScript>;
  notify(kind: 'success' | 'error', message: string): void;
  /**
   * Where named input templates are kept (the engine-synced chart prefs, PC-I12). Absent: they last
   * as long as the page.
   */
  prefs?: Pick<Storage, 'getItem' | 'setItem'>;
}

/**
 * The page's side of a Pine script's Settings dialog (TradingView's study Settings): which script's
 * dialog is open, the inputs it shows, and new values applied to the script on the chart.
 *
 * The page owns the runs; this only reads and updates them. Kept free of Angular injection so the
 * chip → dialog → re-run wiring is testable without the page.
 */
export class ScriptSettings<R extends SettingsRun> {
  /**
   * The script whose dialog is open, by its item: an edited copy replacing it, or another layout's
   * script under the same key, is another script. Once its run leaves the chart the dialog is over,
   * so the same script added back later does not reopen it.
   */
  private readonly item = linkedSignal<R[], ChartScriptItem | null>({
    source: () => this.runs(),
    computation: (runs, previous) => {
      const item = previous?.value ?? null;
      return item && runs.some((r) => r.item === item) ? item : null;
    },
  });
  /** The open dialog's run. */
  readonly run = computed(() => {
    const item = this.item();
    return item ? (this.runs().find((r) => r.item === item) ?? null) : null;
  });
  /** Engine strategies' stored inputs by id, read once each ({@link loadStoredInputs}). */
  private readonly stored = signal<Record<number, ScriptInputValues>>({});
  /** Ids whose stored inputs are being read. */
  private readonly reading = new Set<number>();
  /**
   * The open dialog's inputs ({@link inputsOf}). Compared by content: each live re-run brings an
   * equal copy, which must not re-render the form.
   */
  readonly inputs = computed<readonly ScriptInputDto[] | null>(() => this.inputsOf(this.run()), {
    equal: (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  });
  /** A "Save as default" is on its way. */
  readonly saving = signal(false);
  /** The script whose dialog asks for its `confirm = true` inputs, as it was just added (PC-I12). */
  private readonly confirmFor = signal<ChartScriptItem | null>(null);
  /** The open dialog asks for the script's `confirm = true` inputs: Cancel takes it off the chart. */
  readonly confirming = computed(() => {
    const item = this.item();
    return item !== null && this.confirmFor() === item;
  });
  /** Every script's named input templates ({@link templates}), read when a dialog opens. */
  private readonly templateStore = signal<ScriptInputTemplates>({});
  /** The open dialog's script's named input templates, newest first. */
  readonly templates = computed<readonly ScriptInputTemplate[]>(() => {
    const run = this.run();
    return run ? (this.templateStore()[this.scopeOf(run)] ?? []) : [];
  });

  constructor(
    private readonly runs: WritableSignal<R[]>,
    private readonly host: ScriptSettingsHost,
  ) {}

  /**
   * The gear on a Pine chip (or a double-click on its name). `confirm`: the script was just added
   * and declares `confirm = true` inputs — the dialog asks for those (TradingView's prompt on add).
   */
  open(key: string, confirm = false): void {
    const run = this.runs().find((r) => r.item.key === key);
    if (!run) return;
    this.item.set(run.item);
    this.confirmFor.set(confirm ? run.item : null);
    if (this.host.prefs) this.templateStore.set(readTemplates(this.host.prefs));
    this.loadStoredInputs(run.item);
  }

  /** "Save as…": the dialog's inputs under a name, for this script on any chart. */
  saveTemplate(key: string, name: string, values: ScriptInputValues): void {
    const run = this.runs().find((r) => r.item.key === key);
    if (!run) return;
    const next = withTemplate(this.templateStore(), this.scopeOf(run), name, values);
    if (!next) return;
    this.templateStore.set(next);
    writeTemplates(this.host.prefs, next);
    this.host.notify('success', `Saved the inputs as “${name.trim()}”.`);
  }

  deleteTemplate(key: string, name: string): void {
    const run = this.runs().find((r) => r.item.key === key);
    if (!run) return;
    const next = withoutTemplate(this.templateStore(), this.scopeOf(run), name);
    this.templateStore.set(next);
    writeTemplates(this.host.prefs, next);
  }

  private scopeOf(run: SettingsRun): string {
    return templateScope(run.item, run.result.title);
  }

  /**
   * A run's inputs with the defaults it runs on — what "unchanged" means for each of them. An
   * engine strategy's stored inputs are its defaults: every run applies them beneath the chart's
   * overrides, so a value equal to its SOURCE's default is still a change to send while the stored
   * one differs. Null while those are read ({@link loadStoredInputs}): a form that showed the source's
   * defaults meanwhile would show values the strategy does not run with.
   */
  inputsOf(run: SettingsRun | null): readonly ScriptInputDto[] | null {
    if (!run) return null;
    const id = run.item.strategyId;
    if (id === undefined || id === null) return run.result.inputs;
    const stored = this.stored();
    return id in stored ? withSavedDefaults(run.result.inputs, stored[id]) : null;
  }

  /** Read an engine strategy's stored inputs (`GET strategy/{id}`), once per id; others have none. */
  loadStoredInputs(item: ChartScriptItem): void {
    const id = item.strategyId;
    if (id === undefined || id === null || id in this.stored() || this.reading.has(id)) return;
    this.reading.add(id);
    this.host.storedInputs(id).subscribe({
      next: (inputs) => {
        this.reading.delete(id);
        this.stored.update((m) => ({ ...m, [id]: inputs }));
      },
      // Unreadable: the source's defaults, rather than a dialog that never shows its inputs.
      error: () => {
        this.reading.delete(id);
        this.stored.update((m) => ({ ...m, [id]: {} }));
      },
    });
  }

  close(): void {
    this.item.set(null);
    this.confirmFor.set(null);
  }

  /** Only a script saved in the engine ("My scripts") can keep default inputs. */
  canSaveDefault(item: ChartScriptItem): boolean {
    return savedScriptId(item) !== null;
  }

  /**
   * New values from the dialog. The script runs with them at once — an explicit run, superseding
   * the one in flight — and they are its values from now: live re-runs, a symbol switch, more
   * history and the saved layout take them without waiting for this run to land.
   */
  apply(key: string, values: ScriptInputValues): void {
    const run = this.runs().find((r) => r.item.key === key);
    if (!run) return;
    if (!sameInputValues(run.values, values))
      this.runs.update((runs) => runs.map((r) => (r === run ? { ...r, values } : r)));
    this.host.run(run.item, values);
  }

  /**
   * PC-I5: the Strategy Tester's Properties — re-run the strategy at once with these `strategy()`
   * overrides (`{}` = the script's own again). They ride on its chart item, so its later runs (live
   * re-runs, a symbol switch, Bar Replay) keep them for this chart session.
   */
  applyProperties(key: string, properties: ScriptStrategyPropertyOverrides): void {
    const run = this.runs().find((r) => r.item.key === key);
    if (!run || run.item.kind !== 'strategy') return;
    const { strategyProperties: _previous, ...rest } = run.item;
    const item: ChartScriptItem = Object.keys(properties).length
      ? { ...rest, strategyProperties: { ...properties } }
      : rest;
    this.runs.update((runs) => runs.map((r) => (r === run ? { ...r, item } : r)));
    this.host.run(item, run.values);
  }

  /** "Save as default": a copy of this saved script added to a chart starts with these values. */
  saveDefault(key: string, values: ScriptInputValues): void {
    const run = this.runs().find((r) => r.item.key === key);
    const id = run ? savedScriptId(run.item) : null;
    if (id === null || this.saving()) return;
    this.saving.set(true);
    this.host.saveDefault(id, values).subscribe({
      next: (saved) => {
        this.saving.set(false);
        this.host.notify(
          'success',
          Object.keys(values).length
            ? `Saved as the default inputs of “${saved.name}”.`
            : `“${saved.name}” starts with its own defaults again.`,
        );
      },
      error: (e: Error) => {
        this.saving.set(false);
        this.host.notify('error', e?.message || 'Saving the default inputs failed.');
      },
    });
  }
}
