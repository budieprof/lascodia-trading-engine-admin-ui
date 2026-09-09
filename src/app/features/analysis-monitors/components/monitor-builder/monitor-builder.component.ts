import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { catchError, of } from 'rxjs';

import { AnalysisMonitorsService } from '@core/services/analysis-monitors.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { AnalysisMonitorDto } from '@core/api/api.types';
import type {
  MonitorAction,
  MonitorMetric,
  MonitorMetricCatalogue,
  MonitorPreviewResult,
} from '@features/analysis-monitors/analysis-monitors.types';

/** One condition row as the operator edits it. */
interface ConditionRow {
  metric: string;
  op: string;
  /** Free text — parsed to a number, a range or a set depending on the operator. */
  value: string;
  /** Blank means "the monitor's own subject". */
  subject: string;
  sustainedSeconds: number | null;
}

/**
 * Guided builder for a monitor, with the metric explorer and the historical
 * preview inline.
 *
 * <p>Monitors could previously only be born inside an analysis chat, which meant
 * the only way to create one was to ask a language model to author JSON and hope.
 * This is the other half of that: a subject picker scoped to what the registry
 * can actually answer, an operator-editable condition list, and — the part that
 * matters — a replay of the candidate spec over stored history <em>before</em> it
 * is armed.</p>
 *
 * <p>The raw spec stays visible and editable throughout. The rows are a
 * convenience over the grammar, not a replacement for it: anything the rows
 * cannot express (nesting, reference values, cron) is written directly in the
 * JSON pane, and the preview validates whichever one the operator last touched.</p>
 */
@Component({
  selector: 'app-monitor-builder',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
        <header class="head">
          <div class="title">
            <strong>{{ seed() ? 'Duplicate monitor' : 'New monitor' }}</strong>
            <span class="muted">· {{ subjectLabel() }}</span>
          </div>
          <button type="button" class="x" (click)="closed.emit()" aria-label="Close">×</button>
        </header>

        <div class="body">
          <!-- ── Subject ─────────────────────────────────────────────── -->
          <section class="block">
            <h3>What should this watch?</h3>
            <div class="row">
              <label class="field">
                <span>Subject</span>
                <select [(ngModel)]="subjectKind" (ngModelChange)="onSubjectChanged()">
                  @for (k of catalogue()?.subjectKinds ?? defaultKinds; track k) {
                    <option [value]="k">{{ k }}</option>
                  }
                </select>
              </label>

              @if (needsRef()) {
                <label class="field">
                  <span>{{ refLabel() }}</span>
                  <input
                    type="text"
                    [(ngModel)]="subjectRef"
                    (ngModelChange)="onSubjectChanged()"
                    [placeholder]="refPlaceholder()"
                  />
                </label>
              }

              <label class="field">
                <span>Timeframe</span>
                <select [(ngModel)]="timeframe" (ngModelChange)="onSubjectChanged()">
                  @for (tf of timeframes; track tf) {
                    <option [value]="tf">{{ tf }}</option>
                  }
                </select>
              </label>
            </div>

            <label class="field wide">
              <span>What you are asking for, in your words</span>
              <textarea
                rows="2"
                [(ngModel)]="intentText"
                placeholder="e.g. Tell me if EURUSD's spread stays above 3 pips for a minute"
              ></textarea>
            </label>
          </section>

          <!-- ── Conditions ──────────────────────────────────────────── -->
          <section class="block">
            <div class="block-head">
              <h3>When should it fire?</h3>
              <button type="button" class="btn btn-secondary sm" (click)="addRow()">
                Add condition
              </button>
            </div>

            @if (metricsLoading()) {
              <p class="muted">Loading what can be asked about {{ subjectLabel() }}…</p>
            } @else if (availableMetrics().length === 0) {
              <p class="muted">
                No metrics are available for {{ subjectLabel() }}. Pick a different subject, or
                write the condition in the intent above and let the model judge it.
              </p>
            }

            @for (row of rows(); track $index) {
              <div class="cond">
                <select
                  [ngModel]="row.metric"
                  (ngModelChange)="setRow($index, { metric: $event })"
                  class="metric"
                >
                  @for (group of metricsBySource(); track group.source) {
                    <optgroup [label]="group.source">
                      @for (m of group.metrics; track m.name) {
                        <option [value]="m.name">
                          {{ m.displayName }}{{ m.unit ? ' (' + m.unit + ')' : '' }}
                        </option>
                      }
                    </optgroup>
                  }
                </select>

                <select
                  [ngModel]="row.op"
                  (ngModelChange)="setRow($index, { op: $event })"
                  class="op"
                >
                  @for (op of operatorsFor(row.metric); track op) {
                    <option [value]="op">{{ op }}</option>
                  }
                </select>

                <input
                  type="text"
                  class="val"
                  [ngModel]="row.value"
                  (ngModelChange)="setRow($index, { value: $event })"
                  [placeholder]="valueHintFor(row)"
                />

                <input
                  type="number"
                  class="sustain"
                  [ngModel]="row.sustainedSeconds"
                  (ngModelChange)="setRow($index, { sustainedSeconds: $event })"
                  placeholder="held (s)"
                  title="Require the condition to hold continuously for this many seconds"
                />

                <button type="button" class="x sm" (click)="removeRow($index)" aria-label="Remove">
                  ×
                </button>

                <!-- The live reading is what actually answers 'why wouldn't this fire?' -->
                @if (currentValueFor(row.metric); as reading) {
                  <span class="reading" [class.stale]="!reading.available">
                    now: {{ reading.value }}
                  </span>
                }
              </div>
            }

            <label class="field">
              <span>Combine with</span>
              <select [(ngModel)]="combiner" (ngModelChange)="syncSpecFromRows()">
                <option value="all">all of them (AND)</option>
                <option value="any">any of them (OR)</option>
              </select>
            </label>
          </section>

          <!-- ── Raw spec ────────────────────────────────────────────── -->
          <section class="block">
            <div class="block-head">
              <h3>Trigger spec</h3>
              <span class="muted sm">
                Edit directly for nesting, reference values or a cron schedule.
              </span>
            </div>
            <textarea
              class="code"
              rows="6"
              [(ngModel)]="triggerSpecJson"
              (ngModelChange)="specEditedByHand.set(true)"
            ></textarea>
          </section>

          <!-- ── Preview ─────────────────────────────────────────────── -->
          <section class="block">
            <div class="block-head">
              <h3>What would it have done?</h3>
              <div class="inline">
                <label class="field sm">
                  <span>Look back</span>
                  <select [(ngModel)]="lookbackDays">
                    @for (d of lookbacks; track d) {
                      <option [value]="d">{{ d }}d</option>
                    }
                  </select>
                </label>
                <button
                  type="button"
                  class="btn btn-secondary sm"
                  (click)="runPreview()"
                  [disabled]="previewRunning()"
                >
                  {{ previewRunning() ? 'Replaying…' : 'Replay history' }}
                </button>
              </div>
            </div>

            @if (preview(); as p) {
              <div
                class="verdict"
                [class.bad]="p.errors.length > 0 || p.fireCount === 0"
                [class.warn]="p.warnings.length > 0 && p.fireCount > 0"
              >
                <p class="lead">{{ p.verdict }}</p>

                @if (p.explanation) {
                  <p class="explain">{{ p.explanation }}</p>
                }

                @for (e of p.errors; track e) {
                  <p class="err">{{ e }}</p>
                }
                @for (w of p.warnings; track w) {
                  <p class="warn-line">{{ w }}</p>
                }

                @if (p.fires.length > 0) {
                  <details>
                    <summary>
                      {{ p.fireCount }} fire(s) — show the first {{ p.fires.length }}
                    </summary>
                    <ul class="fires">
                      @for (f of p.fires; track f.atUtc) {
                        <li>
                          <time>{{ f.atUtc | date: 'MMM d, HH:mm' : 'UTC' }}</time>
                          <span class="note">{{ f.note }}</span>
                        </li>
                      }
                    </ul>
                  </details>
                }
              </div>
            } @else {
              <p class="muted">
                Replay before arming. A watch that would never have fired looks exactly like one
                whose condition simply has not been met yet.
              </p>
            }
          </section>

          <!-- ── Action ──────────────────────────────────────────────── -->
          <section class="block">
            <h3>What should happen?</h3>

            <div class="actions">
              @for (a of tier0And1Actions(); track a.type) {
                <label class="check">
                  <input
                    type="checkbox"
                    [checked]="selectedActions().includes(a.type)"
                    (change)="toggleAction(a.type)"
                  />
                  <span>
                    <strong>{{ a.displayName }}</strong>
                    <em>{{ a.description }}</em>
                  </span>
                </label>
              }
            </div>

            <!-- Tier 2 is deliberately separate, collapsed, and worded as a decision. -->
            @if (tier2Actions().length > 0) {
              <details class="tier2">
                <summary>Let this monitor change live trading state…</summary>
                <p class="tier2-warn">
                  These act on money. Each needs your name, a reason, and the exact actions
                  permitted. They run in dry-run first — describing what they would have done —
                  until you turn that off.
                </p>

                <div class="actions">
                  @for (a of tier2Actions(); track a.type) {
                    <label class="check">
                      <input
                        type="checkbox"
                        [checked]="selectedActions().includes(a.type)"
                        (change)="toggleAction(a.type)"
                      />
                      <span>
                        <strong>{{ a.displayName }}</strong>
                        <em>{{ a.description }}</em>
                      </span>
                    </label>
                  }
                </div>

                @if (hasTier2Selected()) {
                  <div class="row">
                    <label class="field">
                      <span>Authorised by</span>
                      <input type="text" [(ngModel)]="authorizedBy" placeholder="your name" />
                    </label>
                    <label class="field wide">
                      <span>Reason</span>
                      <input
                        type="text"
                        [(ngModel)]="authorizationReason"
                        placeholder="why this monitor may act"
                      />
                    </label>
                  </div>
                  <label class="check">
                    <input type="checkbox" [(ngModel)]="liveActions" />
                    <span>
                      <strong>Act for real, not dry-run</strong>
                      <em>Leave off until the intents in the timeline look right.</em>
                    </span>
                  </label>
                }
              </details>
            }
          </section>

          <!-- ── Delivery + limits ───────────────────────────────────── -->
          <section class="block">
            <h3>Where and how long?</h3>
            <div class="row">
              <label class="field">
                <span>Deliver to</span>
                <select multiple [(ngModel)]="deliverTo" size="3">
                  <option value="bell">Notification bell</option>
                  <option value="push">Live push</option>
                  <option value="chat">Chat thread (needs an anchor)</option>
                </select>
              </label>
              <label class="field">
                <span>Expires in (hours)</span>
                <input type="number" [(ngModel)]="expiresInHours" min="1" />
              </label>
              <label class="field">
                <span>Cooldown (s)</span>
                <input type="number" [(ngModel)]="cooldownSeconds" min="30" />
              </label>
              <label class="field">
                <span>Max fires</span>
                <input type="number" [(ngModel)]="maxTriggers" min="1" />
              </label>
            </div>

            <div class="row">
              <label class="check">
                <input type="checkbox" [(ngModel)]="recurring" />
                <span><strong>Recurring</strong><em>Keep watching after the first fire.</em></span>
              </label>
              <label class="check">
                <input type="checkbox" [(ngModel)]="requiresAck" />
                <span>
                  <strong>Require acknowledgement</strong>
                  <em>Escalates if nobody confirms it.</em>
                </span>
              </label>
            </div>
          </section>
        </div>

        <footer class="foot">
          @if (saveError(); as e) {
            <p class="err">{{ e }}</p>
          }
          <div class="spacer"></div>
          <button type="button" class="btn btn-secondary" (click)="closed.emit()">Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            (click)="save()"
            [disabled]="saving() || !intentText().trim()"
          >
            {{ saving() ? 'Arming…' : 'Arm monitor' }}
          </button>
        </footer>
      </div>
    </div>
  `,
  styles: [
    `
      .backdrop {
        position: fixed;
        inset: 0;
        background: rgb(0 0 0 / 45%);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 60;
        padding: 24px;
      }
      .modal {
        background: var(--surface, #fff);
        color: var(--text, #111);
        border-radius: 10px;
        width: min(920px, 100%);
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgb(0 0 0 / 30%);
      }
      .head,
      .foot {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border, #e3e6e8);
      }
      .foot {
        border-bottom: none;
        border-top: 1px solid var(--border, #e3e6e8);
      }
      .foot .spacer {
        flex: 1;
      }
      .title {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex: 1;
      }
      .x {
        background: none;
        border: none;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        color: var(--text-muted, #667);
      }
      .x.sm {
        font-size: 16px;
      }
      .body {
        overflow-y: auto;
        padding: 4px 18px 18px;
      }
      .block {
        padding: 14px 0;
        border-bottom: 1px solid var(--border, #eef1f2);
      }
      .block:last-child {
        border-bottom: none;
      }
      .block h3 {
        margin: 0 0 10px;
        font-size: 14px;
        font-weight: 600;
      }
      .block-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .block-head h3 {
        margin: 0;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 10px;
      }
      .inline {
        display: flex;
        align-items: flex-end;
        gap: 8px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        min-width: 140px;
      }
      .field.wide {
        flex: 1;
        min-width: 260px;
      }
      .field.sm {
        min-width: 90px;
      }
      .field > span {
        color: var(--text-muted, #667);
      }
      input,
      select,
      textarea {
        font: inherit;
        padding: 6px 8px;
        border: 1px solid var(--border, #ccd2d6);
        border-radius: 5px;
        background: var(--surface, #fff);
        color: inherit;
      }
      textarea.code {
        width: 100%;
        font-family: ui-monospace, Menlo, monospace;
        font-size: 12px;
      }
      .cond {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
        flex-wrap: wrap;
      }
      .cond .metric {
        min-width: 190px;
      }
      .cond .op {
        min-width: 110px;
      }
      .cond .val {
        min-width: 130px;
      }
      .cond .sustain {
        width: 90px;
      }
      .reading {
        font-size: 11px;
        color: var(--text-muted, #667);
        font-family: ui-monospace, Menlo, monospace;
      }
      .reading.stale {
        color: var(--warn, #a8761a);
      }
      .actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .check {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 13px;
      }
      .check span {
        display: flex;
        flex-direction: column;
      }
      .check em {
        font-style: normal;
        font-size: 11.5px;
        color: var(--text-muted, #667);
      }
      .tier2 {
        margin-top: 12px;
        border: 1px solid var(--danger-border, #e5c2c2);
        border-radius: 6px;
        padding: 10px 12px;
        background: var(--danger-bg, #fdf5f5);
      }
      .tier2 summary {
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
      }
      .tier2-warn {
        font-size: 12px;
        color: var(--danger, #97302a);
        margin: 8px 0;
      }
      .verdict {
        border-left: 3px solid var(--ok, #2c7a5b);
        padding: 10px 12px;
        background: var(--surface-2, #f6f8f8);
        border-radius: 0 5px 5px 0;
      }
      .verdict.bad {
        border-left-color: var(--danger, #a3352b);
      }
      .verdict.warn {
        border-left-color: var(--warn, #a8761a);
      }
      .verdict .lead {
        margin: 0 0 6px;
        font-weight: 600;
        font-size: 13px;
      }
      .explain {
        margin: 0 0 6px;
        font-size: 12.5px;
        color: var(--text-muted, #556);
      }
      .err {
        color: var(--danger, #a3352b);
        font-size: 12px;
        margin: 3px 0;
      }
      .warn-line {
        color: var(--warn, #8a6212);
        font-size: 12px;
        margin: 3px 0;
      }
      .fires {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
        max-height: 180px;
        overflow-y: auto;
        font-size: 12px;
      }
      .fires li {
        display: flex;
        gap: 10px;
        padding: 3px 0;
      }
      .fires time {
        font-family: ui-monospace, Menlo, monospace;
        color: var(--text-muted, #667);
        white-space: nowrap;
      }
      .fires .note {
        color: var(--text-muted, #556);
      }
      .muted {
        color: var(--text-muted, #667);
        font-size: 12.5px;
      }
      .muted.sm {
        font-size: 11.5px;
      }
      .btn.sm {
        padding: 4px 10px;
        font-size: 12px;
      }
    `,
  ],
})
export class MonitorBuilderComponent {
  private readonly monitors = inject(AnalysisMonitorsService);
  private readonly notify = inject(NotificationService);

  /** Pre-fill from an existing monitor (the Duplicate path). */
  readonly seed = input<AnalysisMonitorDto | null>(null);

  readonly closed = output<void>();
  readonly created = output<AnalysisMonitorDto>();

  protected readonly defaultKinds = [
    'Symbol',
    'Account',
    'Portfolio',
    'Strategy',
    'Signal',
    'Position',
    'Sweep',
    'Fleet',
    'Engine',
  ];
  protected readonly timeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
  protected readonly lookbacks = [7, 14, 30, 60, 90];

  // ── Form state ───────────────────────────────────────────────────────────

  protected readonly subjectKind = signal('Symbol');
  protected readonly subjectRef = signal('');
  protected readonly timeframe = signal('H1');
  protected readonly intentText = signal('');
  protected readonly combiner = signal<'all' | 'any'>('all');
  protected readonly rows = signal<ConditionRow[]>([]);
  protected readonly triggerSpecJson = signal('{}');
  protected readonly specEditedByHand = signal(false);

  protected readonly selectedActions = signal<string[]>(['notify']);
  protected readonly authorizedBy = signal('');
  protected readonly authorizationReason = signal('');
  protected readonly liveActions = signal(false);

  protected readonly deliverTo = signal<string[]>(['bell']);
  protected readonly expiresInHours = signal(24);
  protected readonly cooldownSeconds = signal(1800);
  protected readonly maxTriggers = signal(1);
  protected readonly recurring = signal(false);
  protected readonly requiresAck = signal(false);
  protected readonly lookbackDays = signal(30);

  // ── Async state ──────────────────────────────────────────────────────────

  protected readonly catalogue = signal<MonitorMetricCatalogue | null>(null);
  protected readonly metricsLoading = signal(false);
  protected readonly preview = signal<MonitorPreviewResult | null>(null);
  protected readonly previewRunning = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);

  constructor() {
    // Seed from a duplicated monitor, once.
    effect(() => {
      const s = this.seed();
      if (!s) {
        this.loadMetrics();
        return;
      }
      this.subjectKind.set(s.subjectKind ?? 'Symbol');
      this.subjectRef.set(s.subjectRef || s.symbol || '');
      this.timeframe.set(s.timeframe || 'H1');
      this.intentText.set(s.intentText ?? '');
      this.triggerSpecJson.set(s.triggerSpecJson ?? '{}');
      this.specEditedByHand.set(true);
      this.recurring.set(!!s.recurring);
      this.cooldownSeconds.set(s.cooldownSeconds ?? 1800);
      this.maxTriggers.set(s.maxTriggers ?? 1);
      this.deliverTo.set(s.deliverTo?.length ? [...s.deliverTo] : ['bell']);
      this.requiresAck.set(!!s.requiresAck);
      this.loadMetrics();
    });
  }

  // ── Subject ──────────────────────────────────────────────────────────────

  protected readonly needsRef = computed(
    () => !['Portfolio', 'Sweep', 'Fleet', 'Engine'].includes(this.subjectKind()),
  );

  protected readonly refLabel = computed(() =>
    this.subjectKind() === 'Symbol' ? 'Symbol' : `${this.subjectKind()} id`,
  );

  protected refPlaceholder(): string {
    return this.subjectKind() === 'Symbol' ? 'EURUSD' : '17';
  }

  protected readonly subjectLabel = computed(() => {
    const kind = this.subjectKind();
    const ref = this.subjectRef().trim();
    if (!this.needsRef()) return kind.toLowerCase();
    return ref ? (kind === 'Symbol' ? ref.toUpperCase() : `${kind.toLowerCase()} ${ref}`) : kind;
  });

  protected onSubjectChanged(): void {
    this.preview.set(null);
    this.loadMetrics();
  }

  private loadMetrics(): void {
    const kind = this.subjectKind();
    const ref = this.subjectRef().trim();

    // Nothing useful to resolve until the subject actually identifies something.
    if (this.needsRef() && !ref) {
      this.catalogue.set(null);
      return;
    }

    this.metricsLoading.set(true);
    this.monitors
      .getMetrics(kind, ref || null, this.timeframe())
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.metricsLoading.set(false);
        if (res?.status && res.data) {
          this.catalogue.set(res.data);
          // Drop rows whose metric no longer applies, rather than leaving a row
          // that would fail the create-time lint with a confusing message.
          const known = new Set(res.data.metrics.map((m) => m.name));
          const kept = this.rows().filter((r) => known.has(r.metric));
          if (kept.length !== this.rows().length) {
            this.rows.set(kept);
            this.syncSpecFromRows();
          }
        }
      });
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  protected readonly availableMetrics = computed(() => this.catalogue()?.metrics ?? []);

  protected readonly metricsBySource = computed(() => {
    const groups = new Map<string, MonitorMetric[]>();
    for (const m of this.availableMetrics()) {
      const list = groups.get(m.source) ?? [];
      list.push(m);
      groups.set(m.source, list);
    }
    return [...groups.entries()].map(([source, metrics]) => ({ source, metrics }));
  });

  protected operatorsFor(metricName: string): string[] {
    return (
      this.availableMetrics().find((m) => m.name === metricName)?.operators ?? [
        'below',
        'above',
        'eq',
      ]
    );
  }

  protected currentValueFor(metricName: string): { value: string; available: boolean } | null {
    const m = this.availableMetrics().find((x) => x.name === metricName);
    if (!m || m.currentValue == null) return null;
    return { value: m.currentValue, available: !!m.currentValueAvailable };
  }

  protected valueHintFor(row: ConditionRow): string {
    const m = this.availableMetrics().find((x) => x.name === row.metric);
    if (!m) return 'value';
    if (['between', 'outside', 'in', 'notIn'].includes(row.op)) {
      return m.kind === 'Numeric' ? 'low, high' : 'London, NewYork';
    }
    if (m.kind === 'Boolean') return 'true / false';
    return m.unit ? `value (${m.unit})` : 'value';
  }

  // ── Condition rows ───────────────────────────────────────────────────────

  protected addRow(): void {
    const first = this.availableMetrics()[0];
    if (!first) return;
    this.rows.update((rows) => [
      ...rows,
      {
        metric: first.name,
        op: first.operators[0] ?? 'above',
        value: '',
        subject: '',
        sustainedSeconds: null,
      },
    ]);
    this.syncSpecFromRows();
  }

  protected removeRow(index: number): void {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
    this.syncSpecFromRows();
  }

  protected setRow(index: number, patch: Partial<ConditionRow>): void {
    this.rows.update((rows) =>
      rows.map((r, i) => {
        if (i !== index) return r;
        const next = { ...r, ...patch };
        // Changing the metric can invalidate the operator, so snap it back to one
        // that means something rather than leaving a combination the linter refuses.
        if (patch.metric && !this.operatorsFor(patch.metric).includes(next.op)) {
          next.op = this.operatorsFor(patch.metric)[0] ?? 'above';
        }
        return next;
      }),
    );
    this.syncSpecFromRows();
  }

  /**
   * Rewrites the JSON pane from the rows.
   *
   * Skipped once the operator has edited the spec by hand: silently overwriting
   * hand-written nesting or a reference value would destroy exactly the work the
   * rows cannot express.
   */
  protected syncSpecFromRows(): void {
    if (this.specEditedByHand()) return;

    const conditions = this.rows()
      .filter((r) => r.metric && r.op)
      .map((r) => {
        const node: Record<string, unknown> = { metric: r.metric, op: r.op };
        const value = this.parseValue(r);
        if (value !== undefined) node['value'] = value;
        if (r.subject.trim()) node['subject'] = r.subject.trim();
        if (r.sustainedSeconds && r.sustainedSeconds > 0)
          node['sustainedSeconds'] = r.sustainedSeconds;
        return node;
      });

    if (conditions.length === 0) {
      this.triggerSpecJson.set('{}');
      return;
    }

    this.triggerSpecJson.set(JSON.stringify({ v: 2, [this.combiner()]: conditions }, null, 2));
  }

  /** Reads a row's free-text value as the shape its operator expects. */
  private parseValue(row: ConditionRow): unknown {
    const raw = row.value.trim();
    if (!raw) return undefined;

    const metric = this.availableMetrics().find((m) => m.name === row.metric);

    if (metric?.kind === 'Boolean') return raw.toLowerCase() === 'true';

    if (['between', 'outside'].includes(row.op)) {
      const parts = raw.split(',').map((p) => Number(p.trim()));
      return parts.length === 2 && parts.every((n) => Number.isFinite(n)) ? parts : raw;
    }

    if (['in', 'notIn'].includes(row.op)) {
      const parts = raw.split(',').map((p) => p.trim());
      if (metric?.kind === 'Numeric') {
        const nums = parts.map(Number);
        return nums.length === 2 && nums.every((n) => Number.isFinite(n)) ? nums : parts;
      }
      return parts;
    }

    const num = Number(raw);
    return Number.isFinite(num) ? num : raw;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  protected readonly tier0And1Actions = computed(() =>
    (this.catalogue()?.actions ?? []).filter((a) => a.tier < 2 && this.appliesToSubject(a)),
  );

  protected readonly tier2Actions = computed(() =>
    (this.catalogue()?.actions ?? []).filter((a) => a.tier === 2 && this.appliesToSubject(a)),
  );

  private appliesToSubject(a: MonitorAction): boolean {
    return a.subjectKinds.length === 0 || a.subjectKinds.includes(this.subjectKind());
  }

  protected toggleAction(type: string): void {
    this.selectedActions.update((list) =>
      list.includes(type) ? list.filter((t) => t !== type) : [...list, type],
    );
  }

  protected readonly hasTier2Selected = computed(() => {
    const tier2 = new Set(this.tier2Actions().map((a) => a.type));
    return this.selectedActions().some((t) => tier2.has(t));
  });

  // ── Preview ──────────────────────────────────────────────────────────────

  protected runPreview(): void {
    this.previewRunning.set(true);
    this.monitors
      .preview({
        triggerSpecJson: this.triggerSpecJson(),
        subjectKind: this.subjectKind(),
        subjectRef: this.subjectRef().trim() || undefined,
        timeframe: this.timeframe(),
        lookbackDays: Number(this.lookbackDays()),
        cooldownSeconds: Number(this.cooldownSeconds()),
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.previewRunning.set(false);
        if (res?.status && res.data) this.preview.set(res.data);
        else this.notify.error(res?.message ?? 'Could not replay this trigger.');
      });
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  protected save(): void {
    this.saveError.set(null);

    const steps = this.selectedActions().map((type) => ({ type }));
    const actionSpec = {
      steps: steps.length > 0 ? steps : [{ type: 'notify' }],
      deliverTo: this.deliverTo(),
    };

    const tier2 = this.hasTier2Selected();
    if (tier2 && (!this.authorizedBy().trim() || !this.authorizationReason().trim())) {
      this.saveError.set('A monitor that changes live trading state needs your name and a reason.');
      return;
    }

    this.saving.set(true);
    this.monitors
      .create({
        subjectKind: this.subjectKind(),
        subjectRef: this.subjectRef().trim() || undefined,
        symbol: this.subjectKind() === 'Symbol' ? this.subjectRef().trim().toUpperCase() : null,
        timeframe: this.timeframe(),
        intentText: this.intentText().trim(),
        triggerSpecJson: this.triggerSpecJson(),
        actionSpecJson: JSON.stringify(actionSpec),
        recurring: this.recurring(),
        cooldownSeconds: Number(this.cooldownSeconds()),
        maxTriggers: Number(this.maxTriggers()),
        expiresInHours: Number(this.expiresInHours()),
        deliverTo: this.deliverTo(),
        requiresAck: this.requiresAck(),
        maxActionTier: tier2 ? 2 : this.selectedActions().includes('propose_trade') ? 1 : 0,
        actionAuthorization: tier2
          ? {
              by: this.authorizedBy().trim(),
              reason: this.authorizationReason().trim(),
              actions: this.selectedActions().filter((t) =>
                this.tier2Actions().some((a) => a.type === t),
              ),
              live: this.liveActions(),
            }
          : null,
        // The operator has just seen the replay; a second refusal over the same
        // warnings would be nagging rather than protective. Fatal problems are
        // still refused server-side and are never overridable.
        acceptWarnings: true,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.saving.set(false);
        if (res?.status && res.data) {
          this.notify.success(res.message || 'Monitor armed.');
          this.created.emit(res.data);
          this.closed.emit();
        } else {
          this.saveError.set(res?.message ?? 'Could not arm this monitor.');
        }
      });
  }
}
