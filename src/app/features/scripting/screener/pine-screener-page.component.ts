import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { catchError, of } from 'rxjs';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type RowClassRules,
} from 'ag-grid-community';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StrategiesService } from '@core/services/strategies.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { ScriptingService } from '@core/services/scripting.service';

import { ScriptStrategyService } from '../api/script-strategy.service';
import type {
  ScreenerRequest,
  ScreenerRow,
  ScriptInputDef,
  ScriptLibrarySummary,
  ScriptStrategyDto,
} from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import { fileStamp, saveBlob } from '../shared/download';
import { isScriptStrategy, scriptInputsOf, scriptSourceOf } from '../shared/script-strategy';
import { InputOverridesEditorComponent } from '../shared/input-overrides-editor.component';
import {
  MAX_SCREENER_BARS,
  MAX_SCREENER_SYMBOLS,
  alertsSummary,
  formatPlotValue,
  lastBarText,
  normalizeScreenerRows,
  plotColumns,
  screenerCsv,
  summarize,
  validateScreenerForm,
  type ScreenerSourceMode,
} from './screener.model';

ModuleRegistry.registerModules([AllCommunityModule]);

const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

interface StrategyOption {
  id: number;
  label: string;
}

/**
 * Pine screener (§6 `POST scripting/screener`): run a saved script, a library or a pasted source
 * over up to 200 symbols' last ≤ 500 bars, and compare its screener plots, fired alerts and errors
 * side by side. Results sort and filter per column and export as CSV.
 */
@Component({
  selector: 'app-pine-screener-page',
  standalone: true,
  imports: [PageHeaderComponent, InputOverridesEditorComponent, AgGridAngular],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        title="Pine screener"
        subtitle="Run a Pine script across many symbols and compare its screener plots and alerts"
      />

      <section class="card" aria-labelledby="scr-config-title">
        <h2 class="card-title" id="scr-config-title">Script and universe</h2>

        <div class="modes" role="radiogroup" aria-label="Script to run">
          @for (m of modes; track m.id) {
            <label class="mode" [class.active]="mode() === m.id">
              <input
                type="radio"
                name="scr-mode"
                [value]="m.id"
                [checked]="mode() === m.id"
                (change)="setMode(m.id)"
              />
              <span>{{ m.label }}</span>
            </label>
          }
        </div>

        @switch (mode()) {
          @case ('saved') {
            <label class="field">
              <span>Saved script</span>
              <select (change)="selectStrategy($any($event.target).value)">
                <option value="" [selected]="selectedStrategyId() === null">
                  {{ strategiesLoading() ? 'Loading scripts…' : 'Choose a script…' }}
                </option>
                @for (s of strategyOptions(); track s.id) {
                  <option [value]="s.id" [selected]="selectedStrategyId() === s.id">
                    {{ s.label }}
                  </option>
                }
              </select>
            </label>
            @if (strategyNote()) {
              <p class="note">{{ strategyNote() }}</p>
            }
          }
          @case ('library') {
            <label class="field">
              <span>Library</span>
              <select (change)="selectLibrary($any($event.target).value)">
                <option value="" [selected]="selectedLibraryId() === null">
                  Choose a library…
                </option>
                @for (l of libraries(); track l.id) {
                  <option [value]="l.id" [selected]="selectedLibraryId() === l.id">
                    {{ l.publisher }}/{{ l.name }} v{{ l.version }}
                  </option>
                }
              </select>
            </label>
          }
          @case ('source') {
            <label class="field">
              <span>Pine source</span>
              <textarea
                rows="8"
                spellcheck="false"
                placeholder='//@version=6&#10;indicator("My screener")&#10;plot(ta.rsi(close, 14), "RSI")'
                [value]="pastedSource()"
                (input)="pastedSource.set($any($event.target).value)"
              ></textarea>
            </label>
            <div class="row-actions">
              <button
                type="button"
                class="btn"
                [disabled]="!pastedSource().trim() || compiling()"
                (click)="compileSource(pastedSource())"
              >
                {{ compiling() ? 'Reading…' : 'Read inputs' }}
              </button>
            </div>
          }
        }

        <div class="grid">
          <label class="field">
            <span>Timeframe</span>
            <select (change)="timeframe.set($any($event.target).value)">
              @for (tf of timeframes; track tf) {
                <option [value]="tf" [selected]="timeframe() === tf">{{ tf }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>Bars (1–{{ maxBars }})</span>
            <input
              type="number"
              min="1"
              [attr.max]="maxBars"
              step="1"
              [value]="lastBars()"
              (change)="lastBars.set($any($event.target).value)"
            />
          </label>
        </div>

        <fieldset class="symbols">
          <legend>
            Symbols <span class="count">{{ selectedSymbols().size }} of max {{ maxSymbols }}</span>
          </legend>
          <div class="symbol-tools">
            <label class="sr-only" for="scr-symbol-filter">Filter symbols</label>
            <input
              id="scr-symbol-filter"
              type="search"
              placeholder="Filter…"
              autocomplete="off"
              [value]="symbolFilter()"
              (input)="symbolFilter.set($any($event.target).value)"
            />
            <button type="button" class="btn small" (click)="selectVisible()">Select shown</button>
            <button type="button" class="btn small" (click)="clearSymbols()">Clear</button>
          </div>
          @if (symbolsError()) {
            <p class="note">{{ symbolsError() }}</p>
          }
          <div class="symbol-list">
            @for (s of visibleSymbols(); track s) {
              <label class="symbol">
                <input
                  type="checkbox"
                  [checked]="selectedSymbols().has(s)"
                  (change)="toggleSymbol(s, $any($event.target).checked)"
                />
                <span>{{ s }}</span>
              </label>
            }
          </div>
        </fieldset>

        @if (mode() !== 'library') {
          <div class="inputs">
            <h3 class="inputs-title">Inputs</h3>
            @if (compileNote()) {
              <p class="note">{{ compileNote() }}</p>
            }
            @if (inputDefs() !== undefined) {
              <app-input-overrides-editor
                [inputs]="inputDefs() ?? null"
                [baseline]="inputsBaseline()"
                (overridesChange)="overrides.set($event)"
                (validityChange)="inputsValid.set($event)"
              />
            } @else {
              <p class="muted">Choose a script to edit its inputs.</p>
            }
          </div>
        }

        @if (formError()) {
          <p class="error" role="alert">{{ formError() }}</p>
        }
        <div class="row-actions">
          <button type="button" class="btn primary" [disabled]="running()" (click)="run()">
            {{ running() ? 'Running…' : 'Run screener' }}
          </button>
        </div>
      </section>

      <section class="card" aria-labelledby="scr-results-title" [attr.aria-busy]="running()">
        <div class="results-head">
          <h2 class="card-title" id="scr-results-title">Results</h2>
          @if (results(); as rows) {
            <span class="muted" aria-live="polite">{{ summaryText() }}</span>
            <div class="results-tools">
              <label class="sr-only" for="scr-quick">Search results</label>
              <input
                id="scr-quick"
                type="search"
                placeholder="Search…"
                autocomplete="off"
                [value]="quickFilter()"
                (input)="quickFilter.set($any($event.target).value)"
              />
              <button
                type="button"
                class="btn small"
                [disabled]="rows.length === 0"
                (click)="exportCsv()"
              >
                Export CSV
              </button>
            </div>
          }
        </div>
        @if (results(); as rows) {
          @if (rows.length === 0) {
            <p class="muted">The screener returned no rows.</p>
          } @else {
            <ag-grid-angular
              class="ag-theme-alpine"
              [class.stale]="running()"
              [theme]="'legacy'"
              [rowData]="rows"
              [columnDefs]="columnDefs()"
              [defaultColDef]="defaultColDef"
              [domLayout]="'autoHeight'"
              [pagination]="true"
              [paginationPageSize]="50"
              [quickFilterText]="quickFilter()"
              [rowClassRules]="rowClassRules"
              [tooltipShowDelay]="300"
              [enableCellTextSelection]="true"
              (gridReady)="onGridReady($event)"
              style="width: 100%"
            />
          }
        } @else {
          <p class="muted">Choose a script and symbols, then run the screener.</p>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .card {
        padding: var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }
      .card-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .modes {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .mode {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        padding: var(--space-1) var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .mode.active {
        border-color: var(--accent);
        color: var(--accent);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
        gap: var(--space-3);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .field select,
      .field input,
      .field textarea,
      .symbol-tools input,
      .results-tools input {
        min-width: 0;
        padding: var(--space-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      .field textarea {
        font-family: 'SF Mono', 'Fira Code', monospace;
        resize: vertical;
      }
      .symbols {
        margin: 0;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-width: 0;
      }
      .symbols legend {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        padding: 0 var(--space-1);
      }
      .count {
        margin-left: var(--space-1);
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .symbol-tools,
      .results-tools {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: center;
      }
      .symbol-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
        gap: var(--space-1) var(--space-3);
        max-height: 220px;
        overflow: auto;
      }
      .symbol {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-sm);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .inputs-title {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .row-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
      .results-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
      }
      .results-tools {
        margin-left: auto;
      }
      .btn {
        height: 34px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn.small {
        height: 30px;
        padding: 0 var(--space-3);
        font-size: var(--text-xs);
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn:focus-visible,
      .mode:focus-within {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .note,
      .muted {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .error {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .stale {
        opacity: 0.55;
      }
      /* enableCellTextSelection wraps each value in a .ag-cell-wrapper that shrinks to its
         content, so the cell's text-align cannot move it: stretch the wrapper across the cell
         and push the value to its end for right-aligned (numeric) columns. */
      :host ::ng-deep .ag-right-aligned-cell .ag-cell-wrapper {
        flex: 1 1 auto;
        width: 100%;
        justify-content: flex-end;
      }
      :host ::ng-deep .scr-error-row {
        background: rgba(255, 59, 48, 0.05);
      }
      :host ::ng-deep .scr-error {
        color: var(--loss);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class PineScreenerPageComponent implements OnInit {
  private readonly api = inject(ScriptStrategyService);
  private readonly scripting = inject(ScriptingService);
  private readonly strategiesApi = inject(StrategiesService);
  private readonly pairsApi = inject(CurrencyPairsService);

  readonly modes: readonly { id: ScreenerSourceMode; label: string }[] = [
    { id: 'saved', label: 'Saved script' },
    { id: 'library', label: 'Library' },
    { id: 'source', label: 'Paste source' },
  ];
  readonly timeframes = TIMEFRAMES;
  readonly maxBars = MAX_SCREENER_BARS;
  readonly maxSymbols = MAX_SCREENER_SYMBOLS;

  readonly mode = signal<ScreenerSourceMode>('saved');

  readonly strategiesLoading = signal(false);
  readonly strategyOptions = signal<StrategyOption[]>([]);
  readonly selectedStrategyId = signal<number | null>(null);
  readonly selectedStrategy = signal<ScriptStrategyDto | null>(null);
  readonly strategyNote = signal<string | null>(null);

  readonly libraries = signal<ScriptLibrarySummary[]>([]);
  readonly selectedLibraryId = signal<number | null>(null);

  readonly pastedSource = signal('');

  readonly allSymbols = signal<string[]>([]);
  readonly symbolsError = signal<string | null>(null);
  readonly selectedSymbols = signal<ReadonlySet<string>>(new Set());
  readonly symbolFilter = signal('');
  readonly timeframe = signal('H1');
  readonly lastBars = signal<number | string>(200);

  readonly compiling = signal(false);
  readonly compileNote = signal<string | null>(null);
  /** undefined = no script chosen yet; null = schema unavailable (free-form overrides). */
  readonly inputDefs = signal<ScriptInputDef[] | null | undefined>(undefined);
  readonly inputsBaseline = signal<Record<string, unknown>>({});
  readonly overrides = signal<Record<string, unknown>>({});
  readonly inputsValid = signal(true);

  readonly running = signal(false);
  readonly formError = signal<string | null>(null);
  readonly results = signal<ScreenerRow[] | null>(null);
  readonly lastRun = signal<{ timeframe: string; ms: number } | null>(null);
  readonly quickFilter = signal('');
  private gridApi: GridApi<ScreenerRow> | null = null;

  readonly visibleSymbols = computed(() => {
    const f = this.symbolFilter().trim().toUpperCase();
    return f ? this.allSymbols().filter((s) => s.includes(f)) : this.allSymbols();
  });

  readonly plots = computed(() => plotColumns(this.results() ?? []));

  readonly summaryText = computed(() => {
    const rows = this.results();
    if (!rows) return '';
    const s = summarize(rows);
    const run = this.lastRun();
    return [
      `${s.symbols} symbol${s.symbols === 1 ? '' : 's'}`,
      `${s.withAlerts} with alerts`,
      `${s.errors} error${s.errors === 1 ? '' : 's'}`,
      run ? `${run.timeframe}, ${run.ms} ms` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });

  readonly defaultColDef: ColDef<ScreenerRow> = {
    sortable: true,
    resizable: true,
    filter: true,
    wrapHeaderText: true,
    autoHeaderHeight: true,
    minWidth: 96,
  };

  readonly rowClassRules: RowClassRules<ScreenerRow> = {
    'scr-error-row': (p) => !!p.data?.error,
  };

  readonly columnDefs = computed<ColDef<ScreenerRow>[]>(() => [
    {
      headerName: 'Symbol',
      field: 'symbol',
      pinned: 'left',
      width: 120,
      filter: 'agTextColumnFilter',
    },
    {
      headerName: 'Last bar (UTC)',
      field: 'lastBarTimeMs',
      width: 150,
      filter: false,
      valueFormatter: (p) => lastBarText(p.value ?? null),
    },
    ...this.plots().map(
      (title): ColDef<ScreenerRow> => ({
        headerName: title,
        colId: `plot:${title}`,
        type: 'numericColumn',
        filter: 'agNumberColumnFilter',
        minWidth: 110,
        valueGetter: (p) => p.data?.values[title] ?? null,
        valueFormatter: (p) => formatPlotValue(p.value ?? null),
      }),
    ),
    {
      headerName: 'Alerts',
      colId: 'alerts',
      minWidth: 160,
      flex: 1,
      filter: 'agNumberColumnFilter',
      valueGetter: (p) => p.data?.alerts.length ?? 0,
      valueFormatter: (p) => (p.data ? alertsSummary(p.data.alerts) : ''),
      tooltipValueGetter: (p) =>
        p.data?.alerts.map((a) => `${a.title || 'alert()'}: ${a.message}`).join('\n') ?? '',
    },
    {
      headerName: 'Error',
      colId: 'error',
      minWidth: 160,
      flex: 1,
      filter: 'agTextColumnFilter',
      valueGetter: (p) => p.data?.error ?? '',
      cellClass: 'scr-error',
      tooltipValueGetter: (p) => p.data?.error ?? '',
    },
  ]);

  ngOnInit(): void {
    this.loadStrategies();
    this.loadLibraries();
    this.loadSymbols();
  }

  setMode(mode: ScreenerSourceMode): void {
    this.mode.set(mode);
    this.formError.set(null);
    this.compileNote.set(null);
    if (mode === 'saved') {
      const s = this.selectedStrategy();
      this.inputsBaseline.set(scriptInputsOf(s));
      if (s) this.compileSource(scriptSourceOf(s) ?? '');
      else this.inputDefs.set(undefined);
    } else if (mode === 'source') {
      this.inputsBaseline.set({});
      this.inputDefs.set(undefined);
    }
  }

  selectStrategy(value: string): void {
    const id = Number(value);
    this.selectedStrategyId.set(value && Number.isFinite(id) ? id : null);
    this.selectedStrategy.set(null);
    this.strategyNote.set(null);
    this.inputDefs.set(undefined);
    if (!this.selectedStrategyId()) return;
    this.strategiesApi.getById(id).subscribe({
      next: (res) => {
        const s = (isOk(res) ? res.data : null) as ScriptStrategyDto | null;
        const source = scriptSourceOf(s);
        if (!s || !source) {
          this.strategyNote.set('That strategy has no Pine source to run.');
          return;
        }
        this.selectedStrategy.set(s);
        this.inputsBaseline.set(scriptInputsOf(s));
        this.compileSource(source);
      },
      error: (err: unknown) =>
        this.strategyNote.set(describeFailure(err, 'The strategy could not be loaded.')),
    });
  }

  selectLibrary(value: string): void {
    const id = Number(value);
    this.selectedLibraryId.set(value && Number.isFinite(id) ? id : null);
  }

  compileSource(source: string): void {
    if (!source.trim()) return;
    this.compiling.set(true);
    this.compileNote.set(null);
    // A script with errors still resolves (with its diagnostics); only a refusal without a
    // compile result, or an unreachable engine, rejects.
    this.scripting.compile({ source, timeframe: this.timeframe() }).subscribe({
      next: (result) => {
        this.compiling.set(false);
        this.inputDefs.set(result.inputs ?? []);
        const firstError = (result.diagnostics ?? []).find((d) => d.severity === 'error');
        if (firstError) {
          this.compileNote.set(`Line ${firstError.line}: ${firstError.message}`);
        }
      },
      error: (err: unknown) => {
        this.compiling.set(false);
        this.inputDefs.set(null);
        this.compileNote.set(
          `The script could not be compiled (${describeFailure(err, 'the engine did not answer')}); enter overrides by input id.`,
        );
      },
    });
  }

  toggleSymbol(symbol: string, on: boolean): void {
    const next = new Set(this.selectedSymbols());
    if (on) next.add(symbol);
    else next.delete(symbol);
    this.selectedSymbols.set(next);
  }

  selectVisible(): void {
    const next = new Set(this.selectedSymbols());
    for (const s of this.visibleSymbols()) {
      if (next.size >= MAX_SCREENER_SYMBOLS) break;
      next.add(s);
    }
    this.selectedSymbols.set(next);
  }

  clearSymbols(): void {
    this.selectedSymbols.set(new Set());
  }

  /** The request, or the reason it cannot be sent. */
  buildRequest(): ScreenerRequest | string {
    const mode = this.mode();
    const source =
      mode === 'saved'
        ? scriptSourceOf(this.selectedStrategy())
        : mode === 'source'
          ? this.pastedSource()
          : null;
    const problem = validateScreenerForm({
      mode,
      source,
      libraryId: this.selectedLibraryId(),
      symbols: [...this.selectedSymbols()],
      timeframe: this.timeframe(),
      lastBars: this.lastBars(),
    });
    if (problem) return problem;
    if (mode !== 'library' && !this.inputsValid()) return 'Fix the highlighted inputs first.';
    const req: ScreenerRequest = {
      symbols: [...this.selectedSymbols()].sort(),
      timeframe: this.timeframe(),
      lastBars: Number(this.lastBars()),
    };
    if (mode === 'library') {
      req.libraryId = this.selectedLibraryId()!;
      return req;
    }
    req.source = source!;
    // A saved script runs from its source alone, so its saved inputs travel with the overrides.
    const inputs = { ...(mode === 'saved' ? this.inputsBaseline() : {}), ...this.overrides() };
    if (Object.keys(inputs).length > 0) req.inputs = inputs;
    return req;
  }

  run(): void {
    if (this.running()) return;
    const req = this.buildRequest();
    if (typeof req === 'string') {
      this.formError.set(req);
      return;
    }
    this.formError.set(null);
    this.running.set(true);
    const started = Date.now();
    this.api.runScreener(req).subscribe({
      next: (res) => {
        this.running.set(false);
        if (!isOk(res)) {
          this.formError.set(describeFailure(res, 'The screener did not run.'));
          return;
        }
        this.results.set(normalizeScreenerRows(res.data));
        this.lastRun.set({ timeframe: req.timeframe, ms: Date.now() - started });
      },
      error: (err: unknown) => {
        this.running.set(false);
        this.formError.set(describeFailure(err, 'The screener request failed.'));
      },
    });
  }

  onGridReady(event: GridReadyEvent<ScreenerRow>): void {
    this.gridApi = event.api;
  }

  /** Exports what the grid shows (its filter and sort); every row when the grid is not up. */
  exportCsv(): void {
    const rows: ScreenerRow[] = [];
    if (this.gridApi) {
      this.gridApi.forEachNodeAfterFilterAndSort((n) => {
        if (n.data) rows.push(n.data);
      });
    } else {
      rows.push(...(this.results() ?? []));
    }
    const csv = screenerCsv(rows, this.plots());
    const name = `${fileStamp('pine-screener', this.lastRun()?.timeframe ?? this.timeframe(), new Date().toISOString().slice(0, 16).replace(':', ''))}.csv`;
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name);
  }

  private loadStrategies(): void {
    this.strategiesLoading.set(true);
    this.strategiesApi
      .list({
        currentPage: 1,
        itemCountPerPage: 500,
        filter: null,
        sortBy: 'name',
        sortDirection: 'asc',
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.strategiesLoading.set(false);
        const rows = (res && isOk(res) ? (res.data?.data ?? []) : []) as ScriptStrategyDto[];
        // The list DTO may not carry authoringMode; then every rule-based strategy is offered
        // and a non-script one is caught when its source is fetched.
        const modeKnown = rows.some((r) => r.authoringMode != null);
        const candidates = rows.filter((r) =>
          modeKnown ? isScriptStrategy(r) : r.strategyType === 'RuleBased',
        );
        this.strategyOptions.set(
          candidates
            .map((r) => ({
              id: r.id,
              label:
                `${r.name || `Strategy #${r.id}`} — ${r.symbol ?? '?'} ${r.timeframe ?? ''}`.trim(),
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
      });
  }

  private loadLibraries(): void {
    this.scripting
      .listLibraries()
      .pipe(catchError(() => of([])))
      .subscribe((list) => this.libraries.set(list));
  }

  private loadSymbols(): void {
    this.pairsApi
      .list({ currentPage: 1, itemCountPerPage: 500, filter: null })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (!res || !isOk(res)) {
          this.symbolsError.set('The symbol list could not be loaded.');
          return;
        }
        const symbols = (res.data?.data ?? [])
          .filter((p) => p.isActive !== false && !!p.symbol)
          .map((p) => p.symbol as string);
        this.allSymbols.set([...new Set(symbols)].sort((a, b) => a.localeCompare(b)));
      });
  }
}
