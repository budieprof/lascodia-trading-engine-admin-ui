import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Output,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EAConfigInputs, UpdateInstanceConfigRequest } from '@core/api/api.types';
import { SkeletonComponent } from '@shared/components/ui/skeleton/skeleton.component';

/**
 * Phase-4 EA configuration editor.  Two tabs:
 *   - **Editable** — 16 hot-reloadable input shadows grouped by Timing /
 *     Entry tolerance / Execution / Runtime safety.  Each field shows the
 *     current value (from the heartbeat envelope), an editable input, and
 *     a "Hot-reloadable" badge.  Only dirty fields (non-empty, non-equal to
 *     current) are sent on submit.
 *   - **Read-only** — frozen Inp* declarations (engine URL, symbols, magic
 *     number, etc.).  Displayed for reference with a "Restart required"
 *     badge; no edit controls.
 *
 * The component is purely client-side: it inspects `inputs()` for current
 * values and posts to `EAAdminService.updateInstanceConfig`.  Parent page
 * passes the state envelope's inputs block and listens for `configPushed`
 * to refresh.
 */
@Component({
  selector: 'app-ea-config-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, SkeletonComponent],
  template: `
    <section class="panel" aria-label="EA configuration">
      <header class="panel-head">
        <h3>Configuration</h3>
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'editable'"
            (click)="tab.set('editable')"
            [attr.aria-selected]="tab() === 'editable'"
          >
            Editable
            <span class="badge tone-ok">{{ HOT_RELOAD_FIELDS.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'readonly'"
            (click)="tab.set('readonly')"
            [attr.aria-selected]="tab() === 'readonly'"
          >
            Read-only
            <span class="badge tone-muted">{{ READ_ONLY_FIELDS.length }}</span>
          </button>
        </div>
      </header>

      @if (loading() && !inputs()) {
        <div class="form-grid skeleton-grid" aria-label="Loading configuration" role="status">
          @for (i of skeletonFields(); track i) {
            <div class="field skeleton-field">
              <ui-skeleton height="11px" width="48%" borderRadius="4px" />
              <ui-skeleton height="32px" width="100%" borderRadius="6px" />
            </div>
          }
        </div>
      } @else if (!inputs()) {
        <p class="empty muted">
          No input envelope yet — the EA pushes one on each heartbeat starting at v8.47.137. Older
          builds report only legacy safety params via the existing "Push safety config" modal.
        </p>
      } @else if (tab() === 'editable') {
        <p class="hint muted">
          Hot-reload takes effect on the next read-site cycle. A few fields seed object-internal
          copies at OnInit (HTTP / heartbeat / engine timeout) — those need a re-attach to take
          effect even though the shadow updates live. Empty = keep current.
        </p>
        @for (group of HOT_RELOAD_GROUPS; track group.title) {
          <fieldset class="group">
            <legend>{{ group.title }}</legend>
            <div class="form-grid">
              @for (field of group.fields; track field.key) {
                <label class="field">
                  <span class="field-label">
                    {{ field.label }}
                    <span
                      class="badge"
                      [attr.data-badge]="field.badge"
                      [title]="field.takesEffect"
                      >{{ field.badge }}</span
                    >
                  </span>
                  <div class="field-row">
                    @switch (field.kind) {
                      @case ('bool') {
                        <select [(ngModel)]="edits[field.key]" class="input">
                          <option [ngValue]="undefined">— keep current —</option>
                          <option [ngValue]="true">true</option>
                          <option [ngValue]="false">false</option>
                        </select>
                      }
                      @case ('enum') {
                        <select [(ngModel)]="edits[field.key]" class="input">
                          <option [ngValue]="undefined">— keep current —</option>
                          @for (opt of field.options ?? []; track opt) {
                            <option [ngValue]="opt">{{ opt }}</option>
                          }
                        </select>
                      }
                      @case ('string') {
                        <input
                          type="text"
                          [placeholder]="formatCurrent(field.key) || '(blank)'"
                          [(ngModel)]="edits[field.key]"
                          class="input"
                          autocomplete="off"
                        />
                      }
                      @default {
                        <input
                          type="number"
                          [step]="field.step ?? 'any'"
                          [min]="field.min ?? null"
                          [max]="field.max ?? null"
                          [placeholder]="formatCurrent(field.key)"
                          [(ngModel)]="edits[field.key]"
                          class="input"
                        />
                      }
                    }
                    <span
                      class="current mono"
                      [title]="'Current shadow value: ' + formatCurrent(field.key)"
                    >
                      now: {{ formatCurrent(field.key) || '(blank)' }}
                    </span>
                  </div>
                </label>
              }
            </div>
          </fieldset>
        }

        <footer class="actions">
          <button
            type="button"
            class="btn btn-secondary"
            (click)="clearEdits()"
            [disabled]="submitting()"
          >
            Reset form
          </button>
          <button
            type="button"
            class="btn btn-primary"
            (click)="submit()"
            [disabled]="submitting() || !hasDirty()"
          >
            {{
              submitting()
                ? 'Pushing…'
                : 'Push ' + dirtyCount() + ' change' + (dirtyCount() === 1 ? '' : 's')
            }}
          </button>
        </footer>
      } @else {
        <p class="hint muted">
          These inputs are read at attach-time and cached on objects that don't expose live setters.
          Re-attach the EA in MT5 after editing the input dialog to apply changes.
        </p>
        <div class="form-grid">
          @for (field of READ_ONLY_FIELDS; track field.key) {
            <div class="ro-field">
              <span class="field-label">
                {{ field.label }}
                <span class="badge tone-muted">restart required</span>
              </span>
              <span class="ro-value mono">{{ formatCurrent(field.key) }}</span>
            </div>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .tabs {
        display: flex;
        gap: 4px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 2px;
      }
      .tabs button {
        padding: 6px 14px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        border-radius: calc(var(--radius-sm) - 2px);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .tabs button.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.06));
      }
      .badge {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .badge.tone-ok,
      .badge[data-badge='live'] {
        background: rgba(52, 199, 89, 0.15);
        color: #248a3d;
      }
      .badge.tone-muted {
        background: rgba(0, 0, 0, 0.06);
        color: var(--text-secondary);
      }
      .badge[data-badge='next-job'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .badge[data-badge='restart'] {
        background: rgba(255, 149, 0, 0.15);
        color: #c93400;
      }
      .hint,
      .empty {
        margin: 0;
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .group {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        background: var(--bg-primary);
      }
      .group legend {
        padding: 0 6px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .form-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: var(--space-3);
      }
      .skeleton-grid {
        margin-top: var(--space-2);
      }
      .skeleton-field {
        gap: 6px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .field-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .input {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
      }
      .current {
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .ro-field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .ro-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
        font-variant-numeric: tabular-nums;
        word-break: break-all;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .btn {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid transparent;
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .btn-secondary {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `,
  ],
})
export class EAConfigPanelComponent {
  readonly instanceId = input.required<string>();
  readonly inputs = input<EAConfigInputs | null>(null);
  /**
   * True while the parent detail resource is still mid-flight on first
   * load.  Shimmers placeholder fields instead of the "no input envelope
   * yet" copy — that copy is reserved for the legitimate case of a pre-
   * 8.47.137 EA build that never publishes the inputs block.
   */
  readonly loading = input(false);
  @Output() readonly configPushed = new EventEmitter<void>();

  /** Six placeholder rows for the loading skeleton — enough to fill the panel. */
  protected readonly skeletonFields = computed(() => Array.from({ length: 6 }, (_, i) => i));

  private readonly admin = inject(EAAdminService);
  private readonly notify = inject(NotificationService);
  private readonly cdr = inject(ChangeDetectorRef);

  // Per-key edit values.  Number fields use strings to preserve
  // empty-vs-zero semantics (empty = keep current).  Bool fields use
  // true/false/undefined.  Enum fields use the option string or undefined.
  // String fields use the raw text (empty = keep current).
  protected edits: Partial<Record<HotReloadKey, string | number | boolean | null | undefined>> = {};
  protected readonly tab = signal<'editable' | 'readonly'>('editable');
  protected readonly submitting = signal(false);

  // ── Field catalogues (driven from the engine DTO schema) ───────────────

  protected readonly HOT_RELOAD_GROUPS: readonly FieldGroup[] = [
    {
      title: 'Symbols',
      fields: [
        {
          key: 'symbols',
          label: 'Owned symbols (CSV)',
          kind: 'string',
          badge: 'live',
          takesEffect:
            'CInstanceManager.TryUpdateOwnedSymbols — diff against current set, ' +
            'release ownership of removed symbols + claim added ones via SymbolOwnership CAS. ' +
            'REFUSED when any removed symbol still has open positions — close them first. ' +
            'Empty / "CHART" / "ALL" rejected as init-only modes. ' +
            'Sibling instances on the same MT5 terminal can only own NON-overlapping sets.',
        },
      ],
    },
    {
      title: 'Timing',
      fields: [
        {
          key: 'tickThrottleMs',
          label: 'Tick throttle (ms)',
          kind: 'int',
          step: 10,
          badge: 'live',
          takesEffect: 'Next AutotuneThrottle cycle.',
        },
        {
          key: 'signalPollSec',
          label: 'Signal poll (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next Phase-6 cycle.',
        },
        {
          key: 'positionSyncSec',
          label: 'Position sync (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next Phase-7 cycle.',
        },
        {
          key: 'accountSyncSec',
          label: 'Account sync (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next Phase-7 cycle.',
        },
        {
          key: 'heartbeatSec',
          label: 'Heartbeat (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CHeartbeat.SetIntervalSec — next heartbeat cycle. Floored at 5s.',
        },
        {
          key: 'commandPollSec',
          label: 'Command poll (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next Phase-6 cycle.',
        },
      ],
    },
    {
      title: 'Entry tolerance',
      fields: [
        {
          key: 'entryToleranceBandPct',
          label: 'Tolerance band % (0.0010 = 10 bps)',
          kind: 'double',
          step: 0.0001,
          badge: 'live',
          takesEffect: 'Next signal ClassifyExecutionType.',
        },
        {
          key: 'entryToleranceMaxSignalAgeSec',
          label: 'Max signal age (s) — tolerance band gate',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next signal ClassifyExecutionType.',
        },
        {
          key: 'maxSignalAgeSec',
          label: 'Hard staleness gate (s, 0 = disabled)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next SignalProcessor::Poll cycle — older signals are skipped locally.',
        },
      ],
    },
    {
      title: 'Execution',
      fields: [
        {
          key: 'maxSlippagePoints',
          label: 'Max slippage (points)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'COrderExecutor.SetMaxSlippagePoints — next OrderSend.',
        },
        {
          key: 'maxOrderRetries',
          label: 'Max order retries',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'COrderExecutor.SetMaxRetries — next retry loop.',
        },
        {
          key: 'httpTimeoutData',
          label: 'HTTP timeout: data (ms)',
          kind: 'int',
          step: 100,
          badge: 'live',
          takesEffect:
            'CHttpClient.SetDefaultDataTimeoutMs — next request without an explicit timeout.',
        },
        {
          key: 'httpTimeoutOrder',
          label: 'HTTP timeout: order (ms)',
          kind: 'int',
          step: 100,
          badge: 'live',
          takesEffect: 'Shadow available for code that opts in — wiring lands in Phase 4c.',
        },
      ],
    },
    {
      title: 'Runtime safety',
      fields: [
        {
          key: 'maxNotionalExposurePct',
          label: 'Max notional exposure %',
          kind: 'double',
          step: 1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.SetMaxNotionalExposurePct — next exposure check.',
        },
        {
          key: 'maxPeakDrawdownPct',
          label: 'Max peak drawdown %',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.SetMaxPeakDrawdownPct — next drawdown check.',
        },
        {
          key: 'flashCrashPct',
          label: 'Flash-crash threshold %',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect:
            'CGlobalCircuitBreaker.SetFlashCrashPct — rolling window resets on each update.',
        },
        {
          key: 'engineTimeoutSec',
          label: 'Engine timeout (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect:
            'CConnectionMonitor.SetEngineTimeoutSec + CGlobalCircuitBreaker.SetEngineTimeoutSec — next SAFE_MODE gate. Floored at 5s.',
        },
        {
          key: 'engineFailThreshold',
          label: 'Engine fail threshold',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CConnectionMonitor.SetEngineFailThreshold — next failure check.',
        },
        {
          key: 'unmatchedDealExpirySec',
          label: 'Unmatched deal expiry (s)',
          kind: 'int',
          step: 30,
          badge: 'restart',
          takesEffect: 'Cached on TradeTransactionHandler at OnInit.',
        },
        {
          key: 'safeModeTimeoutSec',
          label: 'SAFE_MODE → SAFETY_STOP escalation (s)',
          kind: 'int',
          step: 30,
          badge: 'live',
          takesEffect: 'Read every cycle in EAEngineHealthAndCoordinationPhases.',
        },
      ],
    },
    {
      title: 'Data + backfill',
      fields: [
        {
          key: 'backfillBars',
          label: 'Backfill bars / TF / symbol',
          kind: 'int',
          step: 100,
          badge: 'next-job',
          takesEffect: 'Read at backfill-job creation — new jobs use the new value.',
        },
        {
          key: 'backfillChunkSize',
          label: 'Backfill chunk size',
          kind: 'int',
          step: 100,
          badge: 'next-job',
          takesEffect: 'Read at backfill-chunk creation.',
        },
        {
          key: 'specRefreshHour',
          label: 'Daily spec-refresh hour',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'BackfillCursor reads shadow each scheduler check.',
        },
        {
          key: 'tickBufferMax',
          label: 'Max ticks to buffer',
          kind: 'int',
          step: 100,
          badge: 'restart',
          takesEffect: 'Cached on tick buffer at OnInit.',
        },
      ],
    },
    {
      title: 'Telemetry',
      fields: [
        {
          key: 'telemetryEndpoint',
          label: 'Telemetry push URL (blank = file-only)',
          kind: 'string',
          badge: 'restart',
          takesEffect: 'Cached on telemetry config at OnInit.',
        },
        {
          key: 'telemetryPushSec',
          label: 'Telemetry push interval (s)',
          kind: 'int',
          step: 1,
          badge: 'restart',
          takesEffect: 'Same cached path.',
        },
      ],
    },
    {
      title: 'News blackout',
      fields: [
        {
          key: 'enableNewsBlackout',
          label: 'Reject entries during scheduled news',
          kind: 'bool',
          badge: 'restart',
          takesEffect: 'Cached on news-blackout manager at OnInit.',
        },
        {
          key: 'newsBlackoutFilePath',
          label: 'Override schedule file path',
          kind: 'string',
          badge: 'restart',
          takesEffect: 'Same cached path.',
        },
      ],
    },
    {
      title: 'Logging + chart',
      fields: [
        {
          key: 'logLevel',
          label: 'Log verbosity',
          kind: 'enum',
          options: ['DEBUG', 'INFO', 'WARN', 'ERROR'],
          badge: 'live',
          takesEffect: 'CLogger.SetLevel — propagates to file sink.',
        },
        {
          key: 'enableFileLogging',
          label: 'Write logs to file',
          kind: 'bool',
          badge: 'restart',
          takesEffect: 'File logger init cached at OnInit.',
        },
        {
          key: 'logJsonFormat',
          label: 'JSON-per-line log format',
          kind: 'bool',
          badge: 'restart',
          takesEffect: 'File logger init cached at OnInit.',
        },
        {
          key: 'enableChartPanel',
          label: 'Show status panel on chart',
          kind: 'bool',
          badge: 'restart',
          takesEffect: 'Chart panel init cached at OnInit.',
        },
        {
          key: 'enableChartMarkers',
          label: 'Show trade markers on chart',
          kind: 'bool',
          badge: 'live',
          takesEffect: 'OperationalHelpers reads shadow before each marker.',
        },
      ],
    },
    {
      title: 'Safety — per-instance',
      fields: [
        {
          key: 'maxPosPerSymbol',
          label: 'Max positions per symbol',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — next safety check.',
        },
        {
          key: 'maxLotPerOrder',
          label: 'Max lot per order',
          kind: 'double',
          step: 0.01,
          badge: 'live',
          takesEffect:
            'CCircuitBreaker.HotReload + COrderExecutor.SetMaxLotPerOrder — next OrderSend.',
        },
        {
          key: 'maxSpreadPoints',
          label: 'Max spread (points)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — next pre-send check.',
        },
        {
          key: 'maxConsecLosses',
          label: 'Max consecutive losses',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — next loss tally.',
        },
        {
          key: 'consecLossPauseMin',
          label: 'Consec-loss pause (min)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — applies when pause is next armed.',
        },
        {
          key: 'maxDailyLossPerSymbolPct',
          label: 'Max daily loss % / symbol',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — next daily-PnL check. 0 = disabled.',
        },
      ],
    },
    {
      title: 'Safety — fleet',
      fields: [
        {
          key: 'maxOpenPositions',
          label: 'Max total open positions (global)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.HotReload — next position-count check.',
        },
        {
          key: 'maxDailyLossPct',
          label: 'Max daily loss % of equity',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.HotReload — next equity check.',
        },
        {
          key: 'maxOrdersPerMin',
          label: 'Max orders per minute',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.HotReload — next rate-limit window.',
        },
        {
          key: 'maxTotalLots',
          label: 'Max total open lots',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.HotReload — next position-open check.',
        },
      ],
    },
  ];

  protected readonly HOT_RELOAD_FIELDS = this.HOT_RELOAD_GROUPS.flatMap((g) => g.fields);

  protected readonly READ_ONLY_FIELDS: readonly ReadOnlyField[] = [
    // Truly load-bearing — changing mid-flight breaks identity, transport
    // re-bind, or concurrency invariants.  Surfaced here as inspection-only
    // so operators can see the current value without poking the EA host.
    { key: 'engineBaseUrl', label: 'Engine base URL' },
    // symbols was moved to the editable tab (Phase-13).  Kept commented
    // here so future maintainers can quickly trace the migration.
    // { key: 'symbols',                  label: 'Symbols (CSV)' },
    { key: 'symbolMapping', label: 'Broker→Engine symbol map' },
    { key: 'timeframes', label: 'Timeframes' },
    { key: 'instanceLabel', label: 'Instance label' },
    { key: 'magicNumber', label: 'Magic number' },
    { key: 'useAsyncOrders', label: 'Use async orders' },
    { key: 'useDllTransport', label: 'Use DLL transport' },
    { key: 'dllBridgeHost', label: 'DLL bridge host (override)' },
    { key: 'dllBridgePort', label: 'DLL bridge port (override)' },
    { key: 'dllBridgeUseTls', label: 'DLL bridge TLS' },
    { key: 'dllBridgeStrictTls', label: 'DLL bridge strict TLS' },
    { key: 'dllBridgeCertFingerprint', label: 'DLL bridge cert fingerprint (SHA-256)' },
    { key: 'coordinatorStaleSec', label: 'Coordinator stale (s)' },
    { key: 'casEscalateThreshold', label: 'CAS escalate threshold' },
  ];

  // ── Field helpers ──────────────────────────────────────────────────────

  protected formatCurrent(key: string): string {
    const inputs = this.inputs();
    if (!inputs) return '—';
    const v = inputs[key];
    if (v == null) return '—';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return String(v);
  }

  protected hasDirty(): boolean {
    return this.dirtyCount() > 0;
  }

  protected dirtyCount(): number {
    let n = 0;
    for (const f of this.HOT_RELOAD_FIELDS) {
      if (this.isDirty(f)) n++;
    }
    return n;
  }

  private isDirty(field: FieldDef): boolean {
    const raw = this.edits[field.key];
    if (raw === undefined || raw === null || raw === '') return false;
    const current = this.inputs()?.[field.key];
    if (field.kind === 'bool') return typeof raw === 'boolean' && raw !== current;
    if (field.kind === 'enum' || field.kind === 'string')
      return String(raw) !== String(current ?? '');
    const num = Number(raw);
    if (!Number.isFinite(num)) return false;
    return current !== num;
  }

  protected clearEdits(): void {
    this.edits = {};
    this.cdr.markForCheck();
  }

  protected submit(): void {
    if (!this.hasDirty()) return;
    // Echo `instanceId` in the body even though the API takes it from the
    // route — the server-side DTO marks it `required` and System.Text.Json
    // rejects the request body otherwise (the controller's route-binding
    // assignment runs *after* JSON deserialisation).
    const body: UpdateInstanceConfigRequest = { instanceId: this.instanceId() };
    for (const f of this.HOT_RELOAD_FIELDS) {
      if (!this.isDirty(f)) continue;
      const raw = this.edits[f.key];
      let value: number | string | boolean;
      if (f.kind === 'bool') value = raw as boolean;
      else if (f.kind === 'enum' || f.kind === 'string') value = String(raw);
      else value = Number(raw);
      (body as Record<string, number | string | boolean>)[f.key] = value;
    }
    this.submitting.set(true);
    this.admin
      .updateInstanceConfig(this.instanceId(), body)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.cdr.markForCheck();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(
              `Config push queued (${Object.keys(body).length} field${Object.keys(body).length === 1 ? '' : 's'}).`,
            );
            this.edits = {};
            this.configPushed.emit();
          } else {
            this.notify.error(res.message ?? 'Config push failed.');
          }
        },
        error: () => this.notify.error('Config push failed.'),
      });
  }
}

type HotReloadKey =
  | 'tickThrottleMs'
  | 'signalPollSec'
  | 'positionSyncSec'
  | 'accountSyncSec'
  | 'heartbeatSec'
  | 'commandPollSec'
  | 'entryToleranceBandPct'
  | 'entryToleranceMaxSignalAgeSec'
  | 'maxSignalAgeSec'
  | 'maxSlippagePoints'
  | 'maxOrderRetries'
  | 'httpTimeoutData'
  | 'httpTimeoutOrder'
  | 'maxNotionalExposurePct'
  | 'maxPeakDrawdownPct'
  | 'flashCrashPct'
  | 'engineTimeoutSec'
  // Phase-4c
  | 'engineFailThreshold'
  | 'unmatchedDealExpirySec'
  | 'safeModeTimeoutSec'
  | 'backfillBars'
  | 'backfillChunkSize'
  | 'specRefreshHour'
  | 'tickBufferMax'
  | 'telemetryEndpoint'
  | 'telemetryPushSec'
  | 'enableNewsBlackout'
  | 'newsBlackoutFilePath'
  | 'logLevel'
  | 'enableFileLogging'
  | 'logJsonFormat'
  | 'enableChartPanel'
  | 'enableChartMarkers'
  // Phase-13: owned-symbol CSV (string)
  | 'symbols'
  // Phase-4d: legacy safety knobs (already hot-reloadable via CB.HotReload)
  | 'maxPosPerSymbol'
  | 'maxLotPerOrder'
  | 'maxSpreadPoints'
  | 'maxConsecLosses'
  | 'consecLossPauseMin'
  | 'maxDailyLossPerSymbolPct'
  | 'maxOpenPositions'
  | 'maxDailyLossPct'
  | 'maxOrdersPerMin'
  | 'maxTotalLots';

interface FieldDef {
  key: HotReloadKey;
  label: string;
  kind: 'int' | 'double' | 'string' | 'bool' | 'enum';
  step?: number;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** UI hint: `live` = next read-cycle; `next-job` = applies to subsequent jobs; `restart` = re-attach to take effect. */
  badge: 'live' | 'next-job' | 'restart';
  takesEffect: string;
}

interface FieldGroup {
  title: string;
  fields: readonly FieldDef[];
}

interface ReadOnlyField {
  key: string;
  label: string;
}
