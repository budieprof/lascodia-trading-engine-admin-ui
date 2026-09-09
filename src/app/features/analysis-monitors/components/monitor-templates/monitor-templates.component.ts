import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { AnalysisMonitorsService } from '@core/services/analysis-monitors.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  MonitorInstantiationResult,
  MonitorTemplate,
  MonitorTemplateParameter,
} from '@features/analysis-monitors/analysis-monitors.types';

/**
 * The template library, and the fan-out that instantiates one across many subjects.
 *
 * <p>Templates are how a proven watch stops being re-derived — slightly differently —
 * in every conversation that needs it. Fan-out is what makes them usable rather than
 * merely tidy: "watch spread on the majors" is one operator intention and eight
 * monitors, and without a group they would be eight unrelated rows to pause one at
 * a time.</p>
 *
 * <p>Built-ins are read-only. They are re-seeded on startup, so an edit here would be
 * silently reverted; duplicating is the supported way to tune one, and the UI says so
 * rather than letting the operator discover it after a restart.</p>
 */
@Component({
  selector: 'app-monitor-templates',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
        <header class="head">
          <strong>Monitor templates</strong>
          <span class="muted">· instantiate a proven watch across many subjects</span>
          <div class="spacer"></div>
          <button type="button" class="x" (click)="closed.emit()" aria-label="Close">×</button>
        </header>

        <div class="body">
          @if (loading()) {
            <p class="muted">Loading templates…</p>
          } @else if (templates().length === 0) {
            <p class="muted">No templates yet.</p>
          }

          <div class="list">
            @for (t of templates(); track t.id) {
              <button
                type="button"
                class="tpl"
                [class.selected]="selected()?.id === t.id"
                (click)="select(t)"
              >
                <div class="tpl-head">
                  <strong>{{ t.name }}</strong>
                  @if (t.isBuiltIn) {
                    <span class="chip">built-in</span>
                  }
                  <span class="chip subtle">{{ t.subjectKind }}</span>
                  @if (t.instantiationCount > 0) {
                    <span class="chip subtle">used {{ t.instantiationCount }}×</span>
                  }
                </div>
                <p class="desc">{{ t.description }}</p>
              </button>
            }
          </div>

          @if (selected(); as t) {
            <section class="detail">
              <h3>{{ t.name }}</h3>
              <p class="intent">{{ t.intentTemplate }}</p>

              @if (parameters().length > 0) {
                <div class="params">
                  @for (p of parameters(); track p.name) {
                    <label class="field">
                      <span>{{ p.label || p.name }}</span>
                      <input
                        type="text"
                        [ngModel]="paramValues()[p.name] ?? p.default ?? ''"
                        (ngModelChange)="setParam(p.name, $event)"
                        [placeholder]="p.example ?? ''"
                      />
                    </label>
                  }
                </div>
              }

              @if (needsSubjects()) {
                <label class="field wide">
                  <span>
                    {{ t.subjectKind === 'Symbol' ? 'Symbols' : t.subjectKind + ' ids' }}
                    — one monitor per entry
                  </span>
                  <input
                    type="text"
                    [(ngModel)]="subjectsText"
                    [placeholder]="
                      t.subjectKind === 'Symbol' ? 'EURUSD, GBPUSD, USDJPY' : '17, 22, 24'
                    "
                  />
                </label>
              } @else {
                <p class="muted">
                  This template watches the {{ t.subjectKind.toLowerCase() }} as a whole — one
                  monitor, no subjects to name.
                </p>
              }

              <div class="row">
                <label class="field">
                  <span>Expires in (hours)</span>
                  <input type="number" [(ngModel)]="expiresInHours" min="1" />
                </label>
                @if (t.subjectKind === 'Symbol') {
                  <label class="field">
                    <span>Timeframe</span>
                    <select [(ngModel)]="timeframe">
                      @for (tf of timeframes; track tf) {
                        <option [value]="tf">{{ tf }}</option>
                      }
                    </select>
                  </label>
                }
              </div>

              @if (result(); as r) {
                <div class="result" [class.partial]="r.failures.length > 0">
                  <p>
                    <strong>{{ r.created.length }}</strong> monitor(s) armed as group
                    <code>{{ r.monitorGroupId }}</code
                    >.
                  </p>
                  @for (f of r.failures; track f) {
                    <p class="err">{{ f }}</p>
                  }
                </div>
              }
            </section>
          }
        </div>

        <footer class="foot">
          <div class="spacer"></div>
          <button type="button" class="btn btn-secondary" (click)="closed.emit()">Close</button>
          <button
            type="button"
            class="btn btn-primary"
            (click)="instantiate()"
            [disabled]="!selected() || working()"
          >
            {{ working() ? 'Arming…' : 'Create monitors' }}
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
        width: min(780px, 100%);
        max-height: 88vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgb(0 0 0 / 30%);
      }
      .head,
      .foot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border, #e3e6e8);
      }
      .foot {
        border-bottom: none;
        border-top: 1px solid var(--border, #e3e6e8);
      }
      .spacer {
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
      .body {
        overflow-y: auto;
        padding: 14px 18px;
      }
      .list {
        display: grid;
        gap: 8px;
      }
      .tpl {
        text-align: left;
        background: var(--surface-2, #f7f9f9);
        border: 1px solid var(--border, #e3e6e8);
        border-radius: 7px;
        padding: 10px 12px;
        cursor: pointer;
        font: inherit;
        color: inherit;
      }
      .tpl.selected {
        border-color: var(--accent, #0f5c57);
        background: var(--accent-soft, #eaf3f2);
      }
      .tpl-head {
        display: flex;
        align-items: center;
        gap: 7px;
        flex-wrap: wrap;
      }
      .chip {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--accent-soft, #dfeceb);
        color: var(--accent, #0f5c57);
        font-weight: 600;
      }
      .chip.subtle {
        background: var(--surface-3, #e8ecee);
        color: var(--text-muted, #556);
      }
      .desc {
        margin: 5px 0 0;
        font-size: 12.5px;
        color: var(--text-muted, #556);
      }
      .detail {
        margin-top: 16px;
        padding-top: 14px;
        border-top: 1px solid var(--border, #e3e6e8);
      }
      .detail h3 {
        margin: 0 0 6px;
        font-size: 14px;
      }
      .intent {
        font-size: 13px;
        color: var(--text-muted, #556);
        margin: 0 0 12px;
      }
      .params,
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 12px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        min-width: 150px;
      }
      .field.wide {
        width: 100%;
      }
      .field > span {
        color: var(--text-muted, #667);
      }
      input,
      select {
        font: inherit;
        padding: 6px 8px;
        border: 1px solid var(--border, #ccd2d6);
        border-radius: 5px;
        background: var(--surface, #fff);
        color: inherit;
      }
      .result {
        margin-top: 12px;
        padding: 10px 12px;
        border-left: 3px solid var(--ok, #2c7a5b);
        background: var(--surface-2, #f6f8f8);
        border-radius: 0 5px 5px 0;
        font-size: 12.5px;
      }
      .result.partial {
        border-left-color: var(--warn, #a8761a);
      }
      .result p {
        margin: 3px 0;
      }
      .err {
        color: var(--danger, #a3352b);
      }
      .muted {
        color: var(--text-muted, #667);
        font-size: 12.5px;
      }
      code {
        font-family: ui-monospace, Menlo, monospace;
        font-size: 11.5px;
      }
    `,
  ],
})
export class MonitorTemplatesComponent {
  private readonly monitors = inject(AnalysisMonitorsService);
  private readonly notify = inject(NotificationService);

  readonly closed = output<void>();
  readonly instantiated = output<MonitorInstantiationResult>();

  protected readonly timeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

  protected readonly templates = signal<MonitorTemplate[]>([]);
  protected readonly loading = signal(true);
  protected readonly selected = signal<MonitorTemplate | null>(null);
  protected readonly paramValues = signal<Record<string, string>>({});
  protected readonly subjectsText = signal('');
  protected readonly timeframe = signal('H1');
  protected readonly expiresInHours = signal(24);
  protected readonly working = signal(false);
  protected readonly result = signal<MonitorInstantiationResult | null>(null);

  constructor() {
    this.monitors
      .getTemplates()
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) this.templates.set(res.data);
      });
  }

  protected select(t: MonitorTemplate): void {
    this.selected.set(t);
    this.result.set(null);
    this.expiresInHours.set(t.defaultExpiryHours);

    // Pre-fill from the declared defaults so the common case is one click.
    const defaults: Record<string, string> = {};
    for (const p of this.parseParameters(t)) {
      if (p.default) defaults[p.name] = p.default;
    }
    this.paramValues.set(defaults);
  }

  protected readonly parameters = computed(() => {
    const t = this.selected();
    return t ? this.parseParameters(t) : [];
  });

  /**
   * Reads the template's declared parameters.
   *
   * Falls back to the placeholders actually found in the bodies when the JSON is
   * missing or malformed — an unfilled placeholder survives substitution verbatim
   * and would otherwise produce an unparseable spec with no clue which parameter
   * was to blame.
   */
  private parseParameters(t: MonitorTemplate): MonitorTemplateParameter[] {
    try {
      const parsed = JSON.parse(t.parametersJson || '[]');
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as MonitorTemplateParameter[];
    } catch {
      // fall through
    }

    return (t.placeholders ?? [])
      .filter((name) => name !== 'symbol' && name !== 'subject')
      .map((name) => ({ name, label: name, type: 'string' }));
  }

  protected setParam(name: string, value: string): void {
    this.paramValues.update((v) => ({ ...v, [name]: value }));
  }

  protected readonly needsSubjects = computed(() => {
    const kind = this.selected()?.subjectKind ?? 'Symbol';
    return !['Portfolio', 'Sweep', 'Fleet', 'Engine'].includes(kind);
  });

  protected instantiate(): void {
    const t = this.selected();
    if (!t) return;

    const subjectRefs = this.needsSubjects()
      ? this.subjectsText()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [''];

    if (this.needsSubjects() && subjectRefs.length === 0) {
      this.notify.error('Name at least one subject to create this template for.');
      return;
    }

    this.working.set(true);
    this.monitors
      .instantiateTemplate(t.id, {
        subjectRefs,
        parameters: this.paramValues(),
        timeframe: t.subjectKind === 'Symbol' ? this.timeframe() : null,
        expiresInHours: Number(this.expiresInHours()),
        // Templates are lint-validated at authoring time with their example
        // values, so a warning here is about this instance's parameters and the
        // operator has already chosen them deliberately.
        acceptWarnings: true,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.working.set(false);
        if (res?.data) {
          this.result.set(res.data);
          this.instantiated.emit(res.data);
          if (res.data.created.length > 0) this.notify.success(res.message || 'Monitors armed.');
          else this.notify.error(res.message || 'No monitors could be armed.');
        } else {
          this.notify.error(res?.message ?? 'Could not instantiate this template.');
        }
      });
  }
}
