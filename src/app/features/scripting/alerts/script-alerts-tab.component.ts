import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { catchError, forkJoin, of } from 'rxjs';

import type { AlertChannel, StrategyDto } from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';

import { ScriptStrategyApiService } from '../api/script-strategy-api.service';
import type { ScriptCompileResult, ScriptStrategyFields } from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import { scriptSourceOf } from '../shared/script-strategy';
import {
  ALERT_CHANNELS,
  alertRowsDiffer,
  buildAlertRows,
  extractAlertConditions,
  extractPlots,
  insertAt,
  placeholderGroupsFor,
  rowTitle,
  scriptKind,
  toAlertBindings,
  validateRow,
  type AlertConditionScan,
  type AlertRow,
  type PlaceholderGroup,
  type PlotInfo,
} from './alerts.model';

const KIND_LABELS: Record<AlertRow['kind'], string> = {
  condition: 'alertcondition',
  'alert-calls': 'alert()',
  'order-fills': 'Order fills',
};

const KIND_HINTS: Record<AlertRow['kind'], string> = {
  condition: 'Fires when this alertcondition() is true on a bar close.',
  'alert-calls':
    'Every alert() the script calls. Leave the message empty to send the script’s own text.',
  'order-fills':
    'Every order the strategy fills (entries, exits, reversals). The strategy.order placeholders describe the fill.',
};

/**
 * Alerts tab of a script strategy (§10 `GET|PUT strategy/{id}/script/alerts`): one row per
 * alertcondition title (read from the compiled script), plus alert() calls and order fills — each
 * with an enable switch, channels, a webhook URL when Webhook is chosen and a message template
 * with a Pine placeholder picker.
 */
@Component({
  selector: 'app-script-alerts-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack">
      <header class="head">
        <div>
          <h3 class="title">Alerts</h3>
          <p class="sub">
            Where this script's alerts are delivered. Channels use the engine's alert settings
            (Configuration → Alerts).
          </p>
        </div>
        <button type="button" class="btn" (click)="reload()" [disabled]="loading() || saving()">
          Reload
        </button>
      </header>

      @if (loading()) {
        <p class="muted" role="status">Loading alerts…</p>
      } @else if (loadError()) {
        <div class="error" role="alert">
          <span>{{ loadError() }}</span>
          <button type="button" class="btn" (click)="reload()">Retry</button>
        </div>
      } @else {
        @if (compileNote()) {
          <p class="note" role="status">{{ compileNote() }}</p>
        }
        @if (scan().untitled > 0) {
          <p class="note">
            {{ scan().untitled }} alertcondition() call{{
              scan().untitled === 1 ? ' has' : 's have'
            }}
            no constant title and cannot be bound individually.
          </p>
        }

        @for (row of rows(); track row.alertKey; let i = $index) {
          <section
            class="row"
            [class.enabled]="row.enabled"
            [class.orphan]="row.orphan"
            [attr.aria-labelledby]="uid + '-row-' + i"
          >
            <div class="row-head">
              <button
                type="button"
                role="switch"
                class="switch"
                [attr.aria-checked]="row.enabled"
                [attr.aria-label]="(row.enabled ? 'Disable ' : 'Enable ') + rowTitle(row)"
                (click)="patch(i, { enabled: !row.enabled })"
              >
                <span class="knob" aria-hidden="true"></span>
              </button>
              <h4 class="row-title" [id]="uid + '-row-' + i">{{ rowTitle(row) }}</h4>
              <span class="kind">{{ kindLabel(row) }}</span>
              @if (row.orphan) {
                <span class="orphan-tag">not in the script any more</span>
                <button type="button" class="btn small danger-text" (click)="removeRow(i)">
                  Remove
                </button>
              }
            </div>
            <p class="hint">{{ kindHint(row) }}</p>

            <fieldset class="channels">
              <legend>Channels</legend>
              @for (c of channels; track c) {
                <label class="check">
                  <input
                    type="checkbox"
                    [checked]="row.channels.includes(c)"
                    (change)="toggleChannel(i, c, $any($event.target).checked)"
                  />
                  <span>{{ c }}</span>
                </label>
              }
            </fieldset>

            @if (row.channels.includes('Webhook')) {
              <label class="field">
                <span class="field-label">Webhook URL</span>
                <input
                  type="url"
                  inputmode="url"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://example.com/hook"
                  [value]="row.webhookUrl ?? ''"
                  [attr.aria-invalid]="!!urlError(row)"
                  (input)="patch(i, { webhookUrl: $any($event.target).value })"
                />
              </label>
            }

            <div class="field">
              <label class="field-label" [attr.for]="uid + '-tpl-' + i">Message</label>
              <div class="tpl-tools">
                <label class="sr-only" [attr.for]="uid + '-ph-' + i">Insert a placeholder</label>
                <select
                  [id]="uid + '-ph-' + i"
                  class="picker"
                  (change)="onPick(i, tpl, $any($event.target))"
                >
                  <option value="">Insert placeholder…</option>
                  @for (g of groupsFor(row); track g.label) {
                    <optgroup [label]="g.label">
                      @for (p of g.items; track p.token) {
                        <option [value]="p.token">{{ p.token }} — {{ p.label }}</option>
                      }
                    </optgroup>
                  }
                </select>
              </div>
              <textarea
                #tpl
                [id]="uid + '-tpl-' + i"
                rows="3"
                spellcheck="false"
                [placeholder]="templatePlaceholder(row)"
                [value]="row.messageTemplate ?? ''"
                (input)="patch(i, { messageTemplate: $any($event.target).value })"
              ></textarea>
            </div>

            @if (issues()[i]; as is) {
              @for (e of is.errors; track $index) {
                <p class="row-error">{{ e }}</p>
              }
              @for (w of is.warnings; track $index) {
                <p class="row-warn">{{ w }}</p>
              }
            }
          </section>
        } @empty {
          <p class="muted">This script has no alerts to bind.</p>
        }

        @if (saveError()) {
          <p class="error" role="alert">{{ saveError() }}</p>
        }
        <div class="save-row">
          <button type="button" class="btn" [disabled]="!dirty() || saving()" (click)="discard()">
            Discard
          </button>
          <button
            type="button"
            class="btn primary"
            [disabled]="!dirty() || saving() || hasErrors()"
            (click)="save()"
          >
            {{ saving() ? 'Saving…' : 'Save alerts' }}
          </button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .sub {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .row {
        padding: var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .row.enabled {
        border-color: rgba(0, 113, 227, 0.4);
      }
      .row.orphan {
        border-style: dashed;
      }
      .row-head {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .row-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        overflow-wrap: anywhere;
      }
      .kind {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        padding: 1px 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
      }
      .orphan-tag {
        font-size: var(--text-xs);
        color: #b25000;
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .switch {
        border: none;
        background: none;
        padding: 0;
        cursor: pointer;
      }
      .knob {
        display: block;
        width: 32px;
        height: 18px;
        border-radius: 9px;
        background: var(--bg-tertiary);
        position: relative;
      }
      .knob::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #fff;
        box-shadow: var(--shadow-sm);
        transition: transform var(--dur-fast);
      }
      .switch[aria-checked='true'] .knob {
        background: var(--accent);
      }
      .switch[aria-checked='true'] .knob::after {
        transform: translateX(14px);
      }
      .channels {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        border: none;
        margin: 0;
        padding: 0;
      }
      .channels legend {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        padding: 0;
      }
      .check {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-sm);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .field-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .field input,
      textarea,
      .picker {
        padding: var(--space-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      textarea {
        font-family: 'SF Mono', 'Fira Code', monospace;
        resize: vertical;
      }
      .field input[aria-invalid='true'] {
        border-color: var(--loss);
      }
      .tpl-tools {
        display: flex;
        justify-content: flex-end;
      }
      .picker {
        max-width: 100%;
        font-size: var(--text-xs);
      }
      .row-error {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--loss);
      }
      .row-warn {
        margin: 0;
        font-size: var(--text-xs);
        color: #b25000;
      }
      .note {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .save-row {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn.small {
        height: 26px;
        padding: 0 var(--space-2);
        font-size: var(--text-xs);
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .btn.danger-text {
        color: var(--loss);
      }
      .btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .btn:focus-visible,
      .switch:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .muted {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .error {
        margin: 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
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
export class ScriptAlertsTabComponent {
  private readonly api = inject(ScriptStrategyApiService);
  private readonly notifications = inject(NotificationService);

  readonly strategy = input.required<StrategyDto & ScriptStrategyFields>();

  private static nextUid = 0;
  readonly uid = `alerts-${ScriptAlertsTabComponent.nextUid++}`;
  readonly channels = ALERT_CHANNELS;

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly compileNote = signal<string | null>(null);

  readonly scan = signal<AlertConditionScan>({ conditions: [], untitled: 0 });
  readonly plots = signal<PlotInfo[]>([]);
  readonly plotsKnown = signal(false);
  readonly savedRows = signal<AlertRow[]>([]);
  readonly rows = signal<AlertRow[]>([]);

  readonly dirty = computed(() => alertRowsDiffer(this.savedRows(), this.rows()));
  readonly issues = computed(() =>
    this.rows().map((r) => validateRow(r, this.groupsFor(r), this.plotsKnown())),
  );
  readonly hasErrors = computed(() => this.issues().some((i) => i.errors.length > 0));

  constructor() {
    // A new strategy object (another strategy, or this one after its script was edited) reloads.
    effect(() => {
      if (this.strategy()) untracked(() => this.reload());
    });
  }

  reload(): void {
    const s = this.strategy();
    const source = scriptSourceOf(s);
    this.loading.set(true);
    this.loadError.set(null);
    this.saveError.set(null);
    this.compileNote.set(null);
    forkJoin({
      alerts: this.api.getAlerts(s.id),
      compile: source
        ? this.api
            .compile({ source, symbol: s.symbol ?? undefined, timeframe: s.timeframe ?? undefined })
            .pipe(catchError(() => of(null)))
        : of(null),
    }).subscribe({
      next: ({ alerts, compile }) => {
        if (!isOk(alerts)) {
          this.loadError.set(describeFailure(alerts, 'Could not load the alert bindings.'));
          this.loading.set(false);
          return;
        }
        const compiled: ScriptCompileResult | null = compile && isOk(compile) ? compile.data : null;
        if (!source) {
          this.compileNote.set(
            'This strategy carries no script source; only saved bindings are shown.',
          );
        } else if (!compiled) {
          this.compileNote.set(
            'The script could not be compiled just now; alert titles were read from its source.',
          );
        }
        const scan: AlertConditionScan = compiled?.alertConditions?.length
          ? {
              conditions: compiled.alertConditions.map((c, i) => ({
                title: c.title,
                message: c.message ?? null,
                line: i,
              })),
              untitled: 0,
            }
          : extractAlertConditions(source);
        const plots: PlotInfo[] = compiled?.plots?.length
          ? compiled.plots.map((p, index) => ({ index, title: p.title || null }))
          : extractPlots(source);
        const isStrategy = scriptKind(compiled, source) !== 'indicator';
        const rows = buildAlertRows(alerts.data ?? [], scan.conditions, isStrategy);
        this.scan.set(scan);
        this.plots.set(plots);
        this.plotsKnown.set(!!source);
        this.savedRows.set(rows);
        this.rows.set(rows.map((r) => ({ ...r, channels: [...r.channels] })));
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.loadError.set(describeFailure(err, 'Could not load the alert bindings.'));
        this.loading.set(false);
      },
    });
  }

  rowTitle(row: AlertRow): string {
    return rowTitle(row);
  }

  kindLabel(row: AlertRow): string {
    return KIND_LABELS[row.kind];
  }

  kindHint(row: AlertRow): string {
    return KIND_HINTS[row.kind];
  }

  groupsFor(row: AlertRow): PlaceholderGroup[] {
    return placeholderGroupsFor(row.kind, this.plots());
  }

  templatePlaceholder(row: AlertRow): string {
    if (row.defaultMessage) return `Default: ${row.defaultMessage}`;
    if (row.kind === 'order-fills') {
      return 'e.g. {{strategy.order.action}} {{strategy.order.contracts}} {{ticker}} @ {{strategy.order.price}}';
    }
    return row.kind === 'alert-calls' ? 'Empty = the message the script passes to alert()' : '';
  }

  urlError(row: AlertRow): boolean {
    const i = this.rows().indexOf(row);
    return (this.issues()[i]?.errors ?? []).some((e) => /URL|webhook/i.test(e));
  }

  patch(index: number, change: Partial<AlertRow>): void {
    this.rows.update((rows) => rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
  }

  toggleChannel(index: number, channel: AlertChannel, on: boolean): void {
    const row = this.rows()[index];
    const channels = on
      ? ALERT_CHANNELS.filter((c) => c === channel || row.channels.includes(c))
      : row.channels.filter((c) => c !== channel);
    this.patch(index, { channels });
  }

  onPick(index: number, textarea: HTMLTextAreaElement, select: HTMLSelectElement): void {
    const token = select.value;
    select.value = '';
    if (!token) return;
    const current = this.rows()[index].messageTemplate ?? '';
    const start = textarea.selectionStart ?? current.length;
    const end = textarea.selectionEnd ?? start;
    const { text, caret } = insertAt(current, start, end, token);
    this.patch(index, { messageTemplate: text });
    textarea.value = text;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }

  removeRow(index: number): void {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
  }

  discard(): void {
    this.rows.set(this.savedRows().map((r) => ({ ...r, channels: [...r.channels] })));
    this.saveError.set(null);
  }

  save(): void {
    if (this.saving() || !this.dirty() || this.hasErrors()) return;
    this.saving.set(true);
    this.saveError.set(null);
    this.api.saveAlerts(this.strategy().id, toAlertBindings(this.rows())).subscribe({
      next: (res) => {
        this.saving.set(false);
        if (!isOk(res)) {
          this.saveError.set(describeFailure(res, 'The engine did not save the alerts.'));
          return;
        }
        this.notifications.success('Alerts saved');
        this.reload();
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.saveError.set(describeFailure(err, 'Saving the alerts failed.'));
      },
    });
  }
}
