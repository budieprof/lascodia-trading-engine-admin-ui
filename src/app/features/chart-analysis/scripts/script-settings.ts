import { computed, linkedSignal, signal, type WritableSignal } from '@angular/core';
import type { Observable } from 'rxjs';

import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import { sameInputValues, withSavedDefaults } from '@features/scripting/pine/pine-inputs';
import { savedScriptId, type ChartScriptItem, type SavedChartScript } from './chart-script.service';

/** A Pine run on the chart, as far as its Settings dialog reads it. */
export interface SettingsRun {
  item: ChartScriptItem;
  result: { inputs: readonly ScriptInputDto[] };
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
  /** Engine strategies' stored inputs by id, read when their settings first open. */
  private readonly stored = signal<Record<number, ScriptInputValues>>({});
  /**
   * The open dialog's inputs. An engine strategy's stored inputs are its defaults — every run
   * applies them beneath the chart's overrides — so its dialog waits for them (null). Compared by
   * content: each live re-run brings an equal copy, which must not re-render the form.
   */
  readonly inputs = computed<readonly ScriptInputDto[] | null>(
    () => {
      const run = this.run();
      if (!run) return null;
      const id = run.item.strategyId;
      if (id === undefined || id === null) return run.result.inputs;
      const stored = this.stored();
      return id in stored ? withSavedDefaults(run.result.inputs, stored[id]) : null;
    },
    { equal: (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b) },
  );
  /** A "Save as default" is on its way. */
  readonly saving = signal(false);

  constructor(
    private readonly runs: WritableSignal<R[]>,
    private readonly host: ScriptSettingsHost,
  ) {}

  /** The gear on a Pine chip (or a double-click on its name). */
  open(key: string): void {
    const run = this.runs().find((r) => r.item.key === key);
    if (!run) return;
    this.item.set(run.item);
    const id = run.item.strategyId;
    if (id === undefined || id === null || id in this.stored()) return;
    this.host.storedInputs(id).subscribe({
      next: (inputs) => this.stored.update((m) => ({ ...m, [id]: inputs })),
      // Unreadable: the source's defaults, rather than a dialog that never shows its inputs.
      error: () => this.stored.update((m) => ({ ...m, [id]: {} })),
    });
  }

  close(): void {
    this.item.set(null);
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
