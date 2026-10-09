import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
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
import { AuthService } from '@core/auth/auth.service';
import { StrategiesService } from '@core/services/strategies.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { ScriptingService } from '@core/services/scripting.service';
import type { ChartIndicatorScriptDetailDto, ScriptDiagnostic } from '@core/api/scripting.types';

import type {
  ScriptInputDef,
  ScriptLibrarySummary,
  ScriptStrategyDto,
} from '../api/scripting-api.types';
import { PineEditorComponent } from '../components/pine-editor/pine-editor.component';
import { formatDateTime } from '../report/report-format';
import { ANALYST_PERMISSION } from '../research/research-permissions';
import { describeFailure, isOk } from '../shared/api-error';
import { fileStamp, saveBlob } from '../shared/download';
import { InputOverridesEditorComponent } from '../shared/input-overrides-editor.component';
import { OPERATOR_PERMISSION } from '../shared/permissions';
import { isScriptStrategy, scriptInputsOf, scriptSourceOf } from '../shared/script-strategy';
import { SavedScreensPanelComponent } from './saved-screens-panel.component';
import { ScreenHistoryComponent } from './screen-history.component';
import { ScreenSettingsComponent } from './screen-settings.component';
import {
  MAX_SCREENER_BARS,
  MAX_SCREENER_SYMBOLS,
  alertsSummary,
  formatPlotValue,
  summarize,
  validateScreenerForm,
  type ScreenerSourceMode,
} from './screener.model';
import { ScreensApiService } from './screens-api.service';
import {
  MAX_EXTRA_TIMEFRAMES,
  MAX_SCREEN_NAME,
  SCREENER_TIMEFRAMES,
  buildSaveRequest,
  changeLabel,
  cleanExtras,
  emptySettings,
  filterColumnOptions,
  formatMetric,
  isoText,
  lastBarLabel,
  metricLabel,
  modeOfScreen,
  normalizeResultRows,
  normalizeScreenRows,
  onTimeframe,
  resultColumns,
  resultsCsv,
  rowError,
  settingsOfScreen,
  timeframeName,
  verdictLabel,
  type ScreenScriptRef,
  type ScreenSettingsDraft,
} from './screens.model';
import type {
  ScreenRowDto,
  ScreenRunDto,
  ScreenerRequestV2,
  ScreenerResultRow,
  ScriptScreenDto,
} from './screens.types';

ModuleRegistry.registerModules([AllCommunityModule]);

interface Option {
  id: number;
  label: string;
}

const SOURCE_PLACEHOLDER = '//@version=6\nindicator("My screener")\nplot(ta.rsi(close, 14), "RSI")';

/**
 * Pine screener (§6 `POST scripting/screener`, §6a saved screens — PE-I11, SS-I6, BX-6): run a script strategy, one of
 * the operator's chart scripts, a library or a written source over up to 200 symbols' last ≤ 500 bars — on up to three
 * more timeframes, optionally on the bar still forming — and compare its screener plots, strategy figures, fired alerts
 * and errors side by side. A run can be saved as a screen: filters decide which symbols match, a schedule runs it at
 * every bar close, and alerts say when a symbol starts or stops matching. Results sort, filter and export as CSV.
 */
@Component({
  selector: 'app-pine-screener-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    InputOverridesEditorComponent,
    AgGridAngular,
    PineEditorComponent,
    SavedScreensPanelComponent,
    ScreenSettingsComponent,
    ScreenHistoryComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        title="Pine screener"
        subtitle="Run a Pine script across many symbols, save it as a screen, and get alerts when symbols start or stop matching"
      />

      <app-saved-screens-panel
        [activeId]="openScreen()?.id ?? null"
        [refreshKey]="screensKey()"
        [canWrite]="canWrite()"
        [canRun]="canRun()"
        (opened)="openScreenById($event)"
        (ran)="onRan($event)"
        (removed)="onScreenRemoved($event)"
        (changed)="onScreenChanged($event)"
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
              <span>Script strategy</span>
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
          @case ('chart') {
            <label class="field">
              <span>My script</span>
              <select
                data-testid="chart-script-select"
                (change)="selectChartScript($any($event.target).value)"
              >
                <option value="" [selected]="selectedChartScriptId() === null">
                  {{ chartScripts() === null ? 'Loading your scripts…' : 'Choose a script…' }}
                </option>
                @for (s of chartScriptOptions(); track s.id) {
                  <option [value]="s.id" [selected]="selectedChartScriptId() === s.id">
                    {{ s.label }}
                  </option>
                }
              </select>
            </label>
            @if (chartNote()) {
              <p class="note">{{ chartNote() }}</p>
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
            <div class="field">
              <span>Pine source</span>
              <app-pine-editor
                [value]="pastedSource()"
                (valueChange)="onSourceEdited($event)"
                [diagnostics]="diagnostics()"
                height="260px"
                ariaLabel="Pine source to screen"
                [placeholder]="sourcePlaceholder"
              />
            </div>
            <div class="row-actions">
              <button
                type="button"
                class="btn"
                [disabled]="!pastedSource().trim() || compiling()"
                (click)="compileSource(pastedSource())"
              >
                {{ compiling() ? 'Checking…' : 'Check and read inputs' }}
              </button>
            </div>
          }
        }
        @if (copyNote(); as n) {
          <p class="note" data-testid="copy-note">{{ n }}</p>
        }

        <div class="grid">
          <label class="field">
            <span>Timeframe</span>
            <select (change)="setTimeframe($any($event.target).value)">
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

        <fieldset class="options" data-testid="screen-options">
          <legend>Also run on (up to {{ maxExtras }} more timeframes)</legend>
          <div class="option-row">
            @for (tf of extraOptions(); track tf) {
              <label class="check">
                <input
                  type="checkbox"
                  [attr.data-extra]="tf"
                  [checked]="extraTimeframes().includes(tf)"
                  [disabled]="
                    !extraTimeframes().includes(tf) && extraTimeframes().length >= maxExtras
                  "
                  (change)="toggleExtra(tf, $any($event.target).checked)"
                />
                {{ tf }}
              </label>
            }
          </div>
          <label class="check">
            <input
              type="checkbox"
              data-testid="forming-bar"
              [checked]="formingBar()"
              (change)="formingBar.set($any($event.target).checked)"
            />
            Use the bar still forming as the last bar (its values move until it closes)
          </label>
        </fieldset>

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
          @if (openScreen()) {
            <button
              type="button"
              class="btn"
              data-testid="run-saved"
              [disabled]="running() || !canRun()"
              title="Runs the screen as saved (not unsaved changes) and keeps the run in its history"
              (click)="runSaved()"
            >
              Run saved screen
            </button>
          }
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
        @if (runLabel(); as label) {
          <p class="note" data-testid="run-label">{{ label }}</p>
        }
        @if (runError(); as e) {
          <p class="error" role="status">The run failed: {{ e }}</p>
        }
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

      <app-screen-settings
        [draft]="settings()"
        [screen]="openScreen()"
        [columns]="filterColumns()"
        [mainTimeframe]="timeframe()"
        [extraTimeframes]="extraTimeframes()"
        [canWrite]="canWrite()"
        [saving]="saving()"
        [problem]="screenProblem()"
        [note]="screenNote()"
        (draftChange)="settings.set($event)"
        (save)="saveScreen(false)"
        (saveAsNew)="saveScreen(true)"
        (closeScreen)="closeScreen()"
        (refreshSource)="useCurrentScript()"
      />

      @if (openScreen(); as s) {
        <app-screen-history
          [screenId]="s.id"
          [refreshKey]="historyKey()"
          (runOpened)="showRun($event)"
        />
      }
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
        min-width: 0;
      }
      .field select,
      .field input,
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
      .symbols,
      .options {
        margin: 0;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-width: 0;
      }
      .symbols legend,
      .options legend {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        padding: 0 var(--space-1);
      }
      .option-row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-4);
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-sm);
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
      :host ::ng-deep .scr-match {
        color: var(--profit);
        font-weight: var(--font-semibold);
      }
      :host ::ng-deep .scr-unknown {
        color: var(--text-tertiary);
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
  private readonly scripting = inject(ScriptingService);
  private readonly strategiesApi = inject(StrategiesService);
  private readonly pairsApi = inject(CurrencyPairsService);
  private readonly screensApi = inject(ScreensApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly modes: readonly { id: ScreenerSourceMode; label: string }[] = [
    { id: 'saved', label: 'Script strategy' },
    { id: 'chart', label: 'My scripts' },
    { id: 'library', label: 'Library' },
    { id: 'source', label: 'Write source' },
  ];
  readonly timeframes = SCREENER_TIMEFRAMES;
  readonly maxBars = MAX_SCREENER_BARS;
  readonly maxSymbols = MAX_SCREENER_SYMBOLS;
  readonly maxExtras = MAX_EXTRA_TIMEFRAMES;
  readonly sourcePlaceholder = SOURCE_PLACEHOLDER;

  /** Saving a screen is `access.operator`; running one is `access.analyst`. */
  readonly canWrite = computed(() => this.auth.hasPermission(OPERATOR_PERMISSION));
  readonly canRun = computed(() => this.auth.hasPermission(ANALYST_PERMISSION));

  readonly mode = signal<ScreenerSourceMode>('saved');

  readonly strategiesLoading = signal(false);
  readonly strategyOptions = signal<Option[]>([]);
  readonly selectedStrategyId = signal<number | null>(null);
  readonly selectedStrategy = signal<ScriptStrategyDto | null>(null);
  readonly strategyNote = signal<string | null>(null);

  /** The operator's chart scripts (own and shared); null until "My scripts" is first opened. */
  readonly chartScripts = signal<ChartIndicatorScriptDetailDto[] | null>(null);
  readonly selectedChartScriptId = signal<number | null>(null);
  readonly chartNote = signal<string | null>(null);
  private chartScriptsLoading = false;

  readonly libraries = signal<ScriptLibrarySummary[]>([]);
  readonly selectedLibraryId = signal<number | null>(null);

  readonly pastedSource = signal('');
  readonly diagnostics = signal<readonly ScriptDiagnostic[]>([]);

  readonly allSymbols = signal<string[]>([]);
  readonly symbolsError = signal<string | null>(null);
  readonly selectedSymbols = signal<ReadonlySet<string>>(new Set());
  readonly symbolFilter = signal('');
  readonly timeframe = signal('H1');
  readonly extraTimeframes = signal<string[]>([]);
  readonly formingBar = signal(false);
  readonly lastBars = signal<number | string>(200);

  readonly compiling = signal(false);
  readonly compileNote = signal<string | null>(null);
  /** The script declares strategy(): it has strategy figures to filter on. */
  readonly isStrategyScript = signal(false);
  /** undefined = no script chosen yet; null = schema unavailable (free-form overrides). */
  readonly inputDefs = signal<ScriptInputDef[] | null | undefined>(undefined);
  readonly inputsBaseline = signal<Record<string, unknown>>({});
  readonly overrides = signal<Record<string, unknown>>({});
  readonly inputsValid = signal(true);

  readonly running = signal(false);
  readonly formError = signal<string | null>(null);
  readonly results = signal<ScreenerResultRow[] | null>(null);
  /** A screen run's verdicts by symbol; null for an ad-hoc run. */
  readonly verdicts = signal<ReadonlyMap<string, ScreenRowDto> | null>(null);
  readonly runLabel = signal<string | null>(null);
  readonly runError = signal<string | null>(null);
  readonly lastRun = signal<{ timeframe: string; ms: number } | null>(null);
  readonly quickFilter = signal('');
  private gridApi: GridApi<ScreenerResultRow> | null = null;

  // ── The saved screen open on the page ──────────────────────────────────────
  readonly openScreen = signal<ScriptScreenDto | null>(null);
  readonly settings = signal<ScreenSettingsDraft>(emptySettings());
  /** "Use the current script": the next update copies the origin's script again. */
  readonly refreshRequested = signal(false);
  readonly saving = signal(false);
  readonly screenProblem = signal<string | null>(null);
  readonly screenNote = signal<string | null>(null);
  readonly screensKey = signal(0);
  readonly historyKey = signal(0);
  private openingId: number | null = null;

  readonly visibleSymbols = computed(() => {
    const f = this.symbolFilter().trim().toUpperCase();
    return f ? this.allSymbols().filter((s) => s.includes(f)) : this.allSymbols();
  });

  readonly extraOptions = computed(() => this.timeframes.filter((tf) => tf !== this.timeframe()));

  readonly chartScriptOptions = computed<Option[]>(() =>
    (this.chartScripts() ?? [])
      .map((s) => ({
        id: s.id,
        label:
          `${s.name || `Script #${s.id}`}${s.kind === 'strategy' ? ' (strategy)' : ''}` +
          (s.ownedByMe === false ? ' — shared' : ''),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  /**
   * An open strategy or chart-script screen runs its own copy of the script; the page runs that copy too (so a preview
   * shows what the screen will do) until the operator picks another script or asks for the current one.
   */
  readonly useCopy = computed(() => {
    const s = this.openScreen();
    if (!s?.pineSource || this.refreshRequested()) return false;
    if (this.mode() === 'saved') {
      return s.sourceKind === 'Strategy' && this.selectedStrategyId() === s.sourceId;
    }
    if (this.mode() === 'chart') {
      return s.sourceKind === 'ChartScript' && this.selectedChartScriptId() === s.sourceId;
    }
    return false;
  });

  readonly copyNote = computed(() => {
    const s = this.openScreen();
    if (!s || !this.useCopy()) return null;
    const name = s.sourceName ?? 'the script';
    const what = s.sourceKind === 'ChartScript' ? 'chart script' : 'strategy';
    if (s.sourceMissing) return `Runs this screen's copy of ${name}; the ${what} no longer exists.`;
    return s.sourceChanged
      ? `Runs this screen's copy of ${name}; the ${what} has changed since it was copied.`
      : `Runs this screen's copy of ${name}.`;
  });

  readonly columns = computed(() => resultColumns(this.results() ?? []));

  readonly filterColumns = computed(() =>
    filterColumnOptions(this.results() ?? [], this.isStrategyScript()),
  );

  readonly summaryText = computed(() => {
    const rows = this.results();
    if (!rows) return '';
    const s = summarize(rows);
    const run = this.lastRun();
    const verdicts = this.verdicts();
    const matched = verdicts
      ? [...verdicts.values()].filter((v) => v.status === 'matched').length
      : null;
    return [
      `${s.symbols} symbol${s.symbols === 1 ? '' : 's'}`,
      matched === null ? '' : `${matched} matched`,
      `${s.withAlerts} with alerts`,
      `${s.errors} error${s.errors === 1 ? '' : 's'}`,
      run ? `${run.timeframe}, ${run.ms} ms` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });

  readonly defaultColDef: ColDef<ScreenerResultRow> = {
    sortable: true,
    resizable: true,
    filter: true,
    wrapHeaderText: true,
    autoHeaderHeight: true,
    minWidth: 96,
  };

  readonly rowClassRules: RowClassRules<ScreenerResultRow> = {
    'scr-error-row': (p) => !!p.data?.error,
  };

  readonly columnDefs = computed<ColDef<ScreenerResultRow>[]>(() => {
    const cols = this.columns();
    const verdicts = this.verdicts();
    const rows = this.results() ?? [];
    const verdictOf = (row: ScreenerResultRow | undefined) =>
      row && verdicts ? (verdicts.get(row.symbol) ?? null) : null;
    const defs: ColDef<ScreenerResultRow>[] = [
      {
        headerName: 'Symbol',
        field: 'symbol',
        pinned: 'left',
        width: 120,
        filter: 'agTextColumnFilter',
      },
    ];
    if (verdicts) {
      defs.push(
        {
          headerName: 'Status',
          colId: 'status',
          width: 120,
          filter: 'agTextColumnFilter',
          valueGetter: (p) => verdictLabel(verdictOf(p.data)?.status),
          tooltipValueGetter: (p) => verdictOf(p.data)?.reason ?? '',
          cellClassRules: {
            'scr-match': (p) => p.value === 'Match',
            'scr-unknown': (p) => p.value === 'Unknown',
          },
        },
        {
          headerName: 'Change',
          colId: 'change',
          width: 110,
          filter: 'agTextColumnFilter',
          valueGetter: (p) => changeLabel(verdictOf(p.data)),
        },
      );
    }
    defs.push({
      headerName: 'Last bar (UTC)',
      field: 'lastBarTimeMs',
      width: 170,
      filter: false,
      valueFormatter: (p) => lastBarLabel(p.value ?? null, !!p.data?.lastBarForming),
    });
    for (const title of cols.plots) {
      defs.push({
        headerName: title,
        colId: `plot:${title}`,
        type: 'numericColumn',
        filter: 'agNumberColumnFilter',
        minWidth: 110,
        valueGetter: (p) => p.data?.values[title] ?? null,
        valueFormatter: (p) => formatPlotValue(p.value ?? null),
      });
    }
    for (const key of cols.metrics) {
      defs.push({
        headerName: metricLabel(key),
        colId: `metric:${key}`,
        type: 'numericColumn',
        filter: 'agNumberColumnFilter',
        minWidth: 110,
        valueGetter: (p) => p.data?.metrics?.[key] ?? null,
        valueFormatter: (p) => formatMetric(key, p.value ?? null),
      });
    }
    for (const t of cols.timeframes) {
      for (const title of t.plots) {
        defs.push({
          headerName: `${title} · ${t.label}`,
          colId: `tf:${t.key}:plot:${title}`,
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          minWidth: 110,
          valueGetter: (p) => (p.data ? (onTimeframe(p.data, t.key)?.values[title] ?? null) : null),
          valueFormatter: (p) => formatPlotValue(p.value ?? null),
        });
      }
      for (const key of t.metrics) {
        defs.push({
          headerName: `${metricLabel(key)} · ${t.label}`,
          colId: `tf:${t.key}:metric:${key}`,
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          minWidth: 110,
          valueGetter: (p) =>
            p.data ? (onTimeframe(p.data, t.key)?.metrics?.[key] ?? null) : null,
          valueFormatter: (p) => formatMetric(key, p.value ?? null),
        });
      }
      if (rows.some((r) => (onTimeframe(r, t.key)?.alerts.length ?? 0) > 0)) {
        defs.push({
          headerName: `Alerts · ${t.label}`,
          colId: `tf:${t.key}:alerts`,
          minWidth: 140,
          filter: 'agNumberColumnFilter',
          valueGetter: (p) => (p.data ? (onTimeframe(p.data, t.key)?.alerts.length ?? 0) : 0),
          valueFormatter: (p) =>
            p.data ? alertsSummary(onTimeframe(p.data, t.key)?.alerts ?? []) : '',
        });
      }
    }
    defs.push(
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
        valueGetter: (p) => (p.data ? (rowError(p.data) ?? '') : ''),
        cellClass: 'scr-error',
        tooltipValueGetter: (p) => (p.data ? (rowError(p.data) ?? '') : ''),
      },
    );
    return defs;
  });

  ngOnInit(): void {
    this.loadStrategies();
    this.loadLibraries();
    this.loadSymbols();
    // ?screen={id}: the notification bell and alert pop-ups open a screen here.
    const params = this.route.queryParamMap;
    if (params) {
      params
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((m) => this.onScreenParam(m.get('screen')));
    } else {
      this.onScreenParam(this.route.snapshot?.queryParamMap?.get('screen') ?? null);
    }
  }

  setMode(mode: ScreenerSourceMode): void {
    this.mode.set(mode);
    this.formError.set(null);
    this.compileNote.set(null);
    const screen = this.openScreen();
    if (mode === 'saved') {
      if (this.useCopy()) {
        this.applyCopy(screen!);
        return;
      }
      const s = this.selectedStrategy();
      this.inputsBaseline.set(scriptInputsOf(s));
      if (s) this.compileSource(scriptSourceOf(s) ?? '');
      else this.inputDefs.set(undefined);
    } else if (mode === 'chart') {
      this.ensureChartScripts();
      if (this.useCopy()) {
        this.applyCopy(screen!);
        return;
      }
      const script = this.chartScripts()?.find((c) => c.id === this.selectedChartScriptId());
      if (script) this.applyChartScript(script);
      else {
        this.inputsBaseline.set({});
        this.inputDefs.set(undefined);
      }
    } else if (mode === 'source') {
      const own = screen?.sourceKind === 'Source';
      this.inputsBaseline.set(own ? ((screen!.inputs ?? {}) as Record<string, unknown>) : {});
      this.inputDefs.set(undefined);
      if (own && this.pastedSource().trim()) this.compileSource(this.pastedSource());
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

  selectChartScript(value: string): void {
    const id = Number(value);
    this.selectedChartScriptId.set(value && Number.isFinite(id) ? id : null);
    this.chartNote.set(null);
    this.inputDefs.set(undefined);
    const chosen = this.selectedChartScriptId();
    if (!chosen) return;
    const script = this.chartScripts()?.find((s) => s.id === chosen);
    if (script) {
      this.applyChartScript(script);
      return;
    }
    // Not in the list (still loading, or a screen's origin): read it on its own.
    this.scripting.getChartScript(chosen).subscribe({
      next: (s) => {
        if (this.selectedChartScriptId() === chosen) this.applyChartScript(s);
      },
      error: (err: unknown) =>
        this.chartNote.set(describeFailure(err, 'That script could not be loaded.')),
    });
  }

  selectLibrary(value: string): void {
    const id = Number(value);
    this.selectedLibraryId.set(value && Number.isFinite(id) ? id : null);
  }

  onSourceEdited(source: string): void {
    this.pastedSource.set(source);
    // Markers for an older text would point at the wrong places.
    if (this.diagnostics().length > 0) this.diagnostics.set([]);
  }

  setTimeframe(tf: string): void {
    this.timeframe.set(tf);
    this.extraTimeframes.update((list) => list.filter((x) => x !== tf));
  }

  toggleExtra(tf: string, on: boolean): void {
    this.extraTimeframes.update((list) => {
      const rest = list.filter((x) => x !== tf);
      if (!on) return rest;
      return rest.length >= MAX_EXTRA_TIMEFRAMES ? rest : [...rest, tf];
    });
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
        this.diagnostics.set(result.diagnostics ?? []);
        this.isStrategyScript.set(result.declaration?.kind === 'strategy');
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

  /** The ad-hoc request, or the reason it cannot be sent. */
  buildRequest(): ScreenerRequestV2 | string {
    const mode = this.mode();
    const copy = this.useCopy() ? (this.openScreen()?.pineSource ?? null) : null;
    const source =
      mode === 'saved'
        ? (copy ?? scriptSourceOf(this.selectedStrategy()))
        : mode === 'source'
          ? this.pastedSource()
          : mode === 'chart'
            ? copy
            : null;
    const problem = validateScreenerForm({
      mode,
      source,
      libraryId: this.selectedLibraryId(),
      chartScriptId: this.selectedChartScriptId(),
      symbols: [...this.selectedSymbols()],
      timeframe: this.timeframe(),
      lastBars: this.lastBars(),
    });
    if (problem) return problem;
    if (mode !== 'library' && !this.inputsValid()) return 'Fix the highlighted inputs first.';
    const req: ScreenerRequestV2 = {
      symbols: [...this.selectedSymbols()].sort(),
      timeframe: this.timeframe(),
      lastBars: Number(this.lastBars()),
    };
    const extras = cleanExtras(this.extraTimeframes(), this.timeframe());
    if (extras.length > 0) req.timeframes = extras;
    if (this.formingBar()) req.formingBar = true;
    if (mode === 'library') {
      req.libraryId = this.selectedLibraryId()!;
      return req;
    }
    if (mode === 'chart' && !copy) {
      // By id: the engine applies the script's saved inputs, then these overrides.
      req.chartScriptId = this.selectedChartScriptId()!;
      if (Object.keys(this.overrides()).length > 0) req.inputs = { ...this.overrides() };
      return req;
    }
    req.source = source!;
    // A source runs alone, so the inputs it was saved with travel with the overrides.
    const inputs = { ...this.inputsBaseline(), ...this.overrides() };
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
    this.screensApi.runScreener(req).subscribe({
      next: (res) => {
        this.running.set(false);
        if (!isOk(res)) {
          this.formError.set(describeFailure(res, 'The screener did not run.'));
          return;
        }
        this.results.set(normalizeResultRows(res.data));
        this.verdicts.set(null);
        this.runLabel.set(null);
        this.runError.set(null);
        this.lastRun.set({ timeframe: req.timeframe, ms: Date.now() - started });
      },
      error: (err: unknown) => {
        this.running.set(false);
        this.formError.set(describeFailure(err, 'The screener request failed.'));
      },
    });
  }

  /** "Run saved screen": the stored definition, stored as a Manual run (never alerts). */
  async runSaved(): Promise<void> {
    const s = this.openScreen();
    if (!s || this.running()) return;
    this.running.set(true);
    this.formError.set(null);
    try {
      const res = await firstValueFrom(this.screensApi.run(s.id));
      if (!res?.status || !res.data) throw res;
      this.showRun(res.data);
      this.historyKey.update((k) => k + 1);
      this.screensKey.update((k) => k + 1);
    } catch (err) {
      this.formError.set(describeFailure(err, `${s.name} did not run.`));
    } finally {
      this.running.set(false);
    }
  }

  /** A stored run's rows and verdicts in the grid. */
  showRun(run: ScreenRunDto): void {
    const rows = normalizeScreenRows(run.rows ?? []);
    this.results.set(rows.map((r) => r.row));
    this.verdicts.set(new Map(rows.map((r) => [r.row.symbol, r])));
    const screen = this.openScreen();
    this.lastRun.set({
      timeframe: timeframeName(screen?.id === run.screenId ? screen.timeframe : this.timeframe()),
      ms: run.durationMs,
    });
    const bar = run.barTimeMs === null ? '' : ` · bar ${formatDateTime(run.barTimeMs)} UTC`;
    this.runLabel.set(
      `${run.trigger === 'Scheduled' ? 'Scheduled run' : 'Run'} #${run.id} of the saved screen, ${isoText(run.startedAt)} UTC${bar}`,
    );
    this.runError.set(run.error);
  }

  /** "Run now" in the list: show the run with its screen. */
  onRan(run: ScreenRunDto): void {
    this.historyKey.update((k) => k + 1);
    if (this.openScreen()?.id === run.screenId) this.showRun(run);
    else void this.openScreenById(run.screenId, run);
  }

  onScreenRemoved(id: number): void {
    if (this.openScreen()?.id === id) this.closeScreen();
  }

  /** The list changed a screen (its schedule): keep the open one in step. */
  onScreenChanged(dto: ScriptScreenDto): void {
    const open = this.openScreen();
    if (!open || open.id !== dto.id) return;
    this.openScreen.set({
      ...dto,
      pineSource: open.pineSource,
      sourceChanged: open.sourceChanged,
      sourceMissing: open.sourceMissing,
    });
    this.settings.update((d) => ({ ...d, scheduleEnabled: dto.scheduleEnabled }));
  }

  async openScreenById(id: number, run?: ScreenRunDto): Promise<void> {
    this.openingId = id;
    this.screenProblem.set(null);
    this.screenNote.set(null);
    try {
      const res = await firstValueFrom(this.screensApi.get(id));
      if (!res?.status || !res.data) throw res;
      if (this.openingId !== id) return;
      this.applyScreen(res.data);
      this.setScreenParam(id);
      if (run) this.showRun(run);
      else if (res.data.lastRunId) void this.loadRun(id, res.data.lastRunId);
      else this.clearScreenResults();
    } catch (err) {
      this.screenProblem.set(describeFailure(err, `Screen ${id} could not be opened.`));
    } finally {
      if (this.openingId === id) this.openingId = null;
    }
  }

  closeScreen(): void {
    this.openScreen.set(null);
    this.refreshRequested.set(false);
    this.settings.set(emptySettings());
    this.screenProblem.set(null);
    this.screenNote.set(null);
    this.clearScreenResults();
    this.setScreenParam(null);
  }

  /** The banner's "Use the current script": load the origin's script now; the update copies it. */
  useCurrentScript(): void {
    const s = this.openScreen();
    if (!s?.sourceId) return;
    this.refreshRequested.set(true);
    this.screenProblem.set(null);
    this.screenNote.set(
      'The current script is loaded. Update the screen to keep it; its next run then starts a new baseline.',
    );
    if (s.sourceKind === 'Strategy') {
      this.mode.set('saved');
      this.selectStrategy(String(s.sourceId));
    } else if (s.sourceKind === 'ChartScript') {
      this.mode.set('chart');
      this.ensureChartScripts();
      this.selectChartScript(String(s.sourceId));
    }
  }

  async saveScreen(asNew: boolean): Promise<void> {
    if (this.saving()) return;
    const open = this.openScreen();
    const updating = !!open && !asNew;
    let draft = this.settings();
    if (asNew && open && draft.name.trim() === open.name) {
      draft = { ...draft, name: `${open.name} (copy)`.slice(0, MAX_SCREEN_NAME) };
    }
    if (this.mode() !== 'library' && !this.inputsValid()) {
      this.screenProblem.set('Fix the highlighted inputs first.');
      return;
    }
    const req = buildSaveRequest({
      script: this.scriptRef(),
      inputs: this.mode() === 'library' ? {} : { ...this.inputsBaseline(), ...this.overrides() },
      symbols: [...this.selectedSymbols()],
      timeframe: this.timeframe(),
      extraTimeframes: this.extraTimeframes(),
      lastBars: this.lastBars(),
      formingBar: this.formingBar(),
      settings: draft,
      refreshSource: updating && this.refreshRequested(),
    });
    if (typeof req === 'string') {
      this.screenProblem.set(req);
      return;
    }
    this.saving.set(true);
    this.screenProblem.set(null);
    this.screenNote.set(null);
    try {
      const res = await firstValueFrom(
        updating ? this.screensApi.update(open.id, req) : this.screensApi.create(req),
      );
      if (!res?.status || !res.data) throw res;
      const saved = res.data;
      const keepSource = saved.pineSource ?? (updating ? open.pineSource : null);
      this.openScreen.set({ ...saved, pineSource: keepSource ?? null, sourceChanged: false });
      this.refreshRequested.set(false);
      this.settings.set(settingsOfScreen(saved));
      if (this.mode() !== 'library') {
        this.inputsBaseline.set((saved.inputs ?? {}) as Record<string, unknown>);
      }
      const message = res.message && res.message !== 'Successful' ? res.message : null;
      this.screenNote.set(message ?? (updating ? 'Screen updated.' : 'Screen saved.'));
      this.screensKey.update((k) => k + 1);
      this.historyKey.update((k) => k + 1);
      this.setScreenParam(saved.id);
    } catch (err) {
      this.screenProblem.set(describeFailure(err, 'The screen could not be saved.'));
    } finally {
      this.saving.set(false);
    }
  }

  onGridReady(event: GridReadyEvent<ScreenerResultRow>): void {
    this.gridApi = event.api;
  }

  /** Exports what the grid shows (its filter and sort); every row when the grid is not up. */
  exportCsv(): void {
    const rows: ScreenerResultRow[] = [];
    if (this.gridApi) {
      this.gridApi.forEachNodeAfterFilterAndSort((n) => {
        if (n.data) rows.push(n.data);
      });
    } else {
      rows.push(...(this.results() ?? []));
    }
    const csv = resultsCsv(rows, this.columns(), this.verdicts());
    const name = `${fileStamp('pine-screener', this.lastRun()?.timeframe ?? this.timeframe(), new Date().toISOString().slice(0, 16).replace(':', ''))}.csv`;
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name);
  }

  private scriptRef(): ScreenScriptRef | null {
    switch (this.mode()) {
      case 'saved': {
        const id = this.selectedStrategyId();
        return id ? { kind: 'strategy', strategyId: id } : null;
      }
      case 'chart': {
        const id = this.selectedChartScriptId();
        return id ? { kind: 'chart', chartScriptId: id } : null;
      }
      case 'library': {
        const id = this.selectedLibraryId();
        return id ? { kind: 'library', libraryId: id } : null;
      }
      default:
        return { kind: 'source', source: this.pastedSource() };
    }
  }

  private onScreenParam(text: string | null): void {
    const id = Number(text);
    if (!text || !Number.isInteger(id) || id <= 0) return;
    if (id === this.openScreen()?.id || id === this.openingId) return;
    void this.openScreenById(id);
  }

  private setScreenParam(id: number | null): void {
    void this.router.navigate([], {
      queryParams: { screen: id },
      replaceUrl: true,
      queryParamsHandling: 'merge',
    });
  }

  /** Fills the form from a saved screen. */
  private applyScreen(s: ScriptScreenDto): void {
    this.openScreen.set(s);
    this.refreshRequested.set(false);
    this.settings.set(settingsOfScreen(s));
    const main = timeframeName(s.timeframe) || 'H1';
    this.timeframe.set(main);
    this.extraTimeframes.set(cleanExtras(s.extraTimeframes ?? [], main));
    this.lastBars.set(s.lastBars);
    this.formingBar.set(!!s.formingBar);
    this.selectedSymbols.set(new Set(s.symbols ?? []));
    this.formError.set(null);
    this.compileNote.set(null);
    this.strategyNote.set(null);
    this.chartNote.set(null);
    this.diagnostics.set([]);
    const mode = modeOfScreen(s);
    this.mode.set(mode);
    switch (mode) {
      case 'saved':
        this.selectedStrategyId.set(s.sourceId);
        this.selectedStrategy.set(null);
        break;
      case 'chart':
        this.selectedChartScriptId.set(s.sourceId);
        this.ensureChartScripts();
        break;
      case 'library':
        this.selectedLibraryId.set(s.sourceId);
        break;
      default:
        this.pastedSource.set(s.pineSource ?? '');
    }
    if (mode === 'library') {
      this.inputsBaseline.set({});
      this.inputDefs.set(undefined);
      return;
    }
    this.applyCopy(s);
  }

  /** The screen's copy of its script on the form: its inputs as the baseline, compiled for the input editor. */
  private applyCopy(s: ScriptScreenDto): void {
    this.inputsBaseline.set((s.inputs ?? {}) as Record<string, unknown>);
    if (s.pineSource) this.compileSource(s.pineSource);
    else this.inputDefs.set(null);
  }

  private applyChartScript(script: ChartIndicatorScriptDetailDto): void {
    this.inputsBaseline.set((script.inputs ?? {}) as Record<string, unknown>);
    this.isStrategyScript.set(script.kind === 'strategy');
    this.compileSource(script.pineSource);
  }

  private clearScreenResults(): void {
    if (!this.verdicts()) return;
    this.results.set(null);
    this.verdicts.set(null);
    this.runLabel.set(null);
    this.runError.set(null);
  }

  private async loadRun(screenId: number, runId: number): Promise<void> {
    try {
      const res = await firstValueFrom(this.screensApi.runDetail(screenId, runId));
      if (!res?.status || !res.data || this.openScreen()?.id !== screenId) return;
      if (res.data.rows?.length) this.showRun(res.data);
      else this.clearScreenResults();
    } catch {
      // The newest run's rows are a convenience; the history still lists the runs.
    }
  }

  private ensureChartScripts(): void {
    if (this.chartScripts() !== null || this.chartScriptsLoading) return;
    this.chartScriptsLoading = true;
    this.scripting.listChartScripts().subscribe({
      next: (list) => {
        this.chartScriptsLoading = false;
        this.chartScripts.set(list);
      },
      error: (err: unknown) => {
        this.chartScriptsLoading = false;
        this.chartScripts.set([]);
        this.chartNote.set(describeFailure(err, 'Your scripts could not be loaded.'));
      },
    });
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
