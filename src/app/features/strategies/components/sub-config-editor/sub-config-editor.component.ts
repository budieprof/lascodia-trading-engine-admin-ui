import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  Input,
  signal,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import {
  fieldOptions,
  parseSubConfig,
  RISK_OVERRIDES_SCHEMA,
  serializeSubConfig,
  SubConfigField,
  SubConfigOption,
  SubConfigSchema,
} from '../../util/sub-config-schema';

/**
 * Typed editor for one of a strategy's sub-config JSON columns. Binds to the form control that
 * holds the raw JSON string (the control stays the source of truth, so the submit / version-diff /
 * template paths are unchanged): typed edits rewrite the string, and the "Advanced: raw JSON"
 * textarea edits it directly. Blank fields are omitted (= inherit); unknown keys are preserved.
 */
@Component({
  selector: 'app-sub-config-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SubConfigEditorComponent),
      multi: true,
    },
  ],
  template: `
    <fieldset class="sub-config" [attr.data-testid]="'sub-config-' + activeSchema().kind">
      <legend class="sub-config-title">{{ activeSchema().title }}</legend>

      @if (parsed().error; as err) {
        <div class="sub-config-error" role="alert">
          The stored JSON cannot be edited as a form: {{ err }} Fix it in the raw JSON below.
        </div>
      }

      <div class="sub-config-grid" [class.disabled]="!!parsed().error">
        @for (f of activeSchema().fields; track f.key) {
          @if (isShown(f)) {
            <div class="sub-config-field" [class.wide]="f.type === 'multiEnum'">
              <label class="form-label" [attr.for]="id(f)">{{ labelOf(f) }}</label>
              @switch (f.type) {
                @case ('enum') {
                  <select
                    class="form-input"
                    [id]="id(f)"
                    [disabled]="isDisabled() || !!parsed().error"
                    (change)="setEnum(f, $any($event.target).value)"
                  >
                    <option value="" [selected]="!hasValue(f)">— inherit —</option>
                    @for (o of optionsOf(f); track o.value) {
                      <option [value]="o.value" [selected]="values()[f.key] === o.value">
                        {{ o.label }}
                      </option>
                    }
                  </select>
                }
                @case ('triBool') {
                  <select
                    class="form-input"
                    [id]="id(f)"
                    [disabled]="isDisabled() || !!parsed().error"
                    (change)="setTriBool(f, $any($event.target).value)"
                  >
                    <option value="" [selected]="!hasValue(f)">— inherit —</option>
                    <option value="true" [selected]="values()[f.key] === true">Allowed</option>
                    <option value="false" [selected]="values()[f.key] === false">Blocked</option>
                  </select>
                }
                @case ('time') {
                  <input
                    class="form-input"
                    type="time"
                    [id]="id(f)"
                    [disabled]="isDisabled() || !!parsed().error"
                    [value]="values()[f.key] ?? ''"
                    (change)="setValue(f, $any($event.target).value || undefined)"
                  />
                }
                @case ('multiEnum') {
                  <div class="sub-config-checks" [id]="id(f)">
                    @for (o of optionsOf(f); track o.value) {
                      <label class="sub-config-check">
                        <input
                          type="checkbox"
                          [disabled]="isDisabled() || !!parsed().error"
                          [checked]="isChecked(f, o.value)"
                          (change)="toggleMulti(f, o.value, $any($event.target).checked)"
                        />
                        {{ o.label }}
                      </label>
                    }
                  </div>
                }
                @default {
                  <input
                    class="form-input"
                    type="number"
                    [id]="id(f)"
                    [disabled]="isDisabled() || !!parsed().error"
                    [attr.min]="f.min ?? null"
                    [attr.max]="f.max ?? null"
                    [attr.step]="f.step ?? (f.type === 'int' ? 1 : 'any')"
                    [placeholder]="f.placeholder ?? 'inherit'"
                    [value]="values()[f.key] ?? ''"
                    (change)="setNumber(f, $any($event.target).value)"
                  />
                }
              }
              @if (unrepresentable().includes(f.key)) {
                <span class="form-hint warn">
                  Stored value {{ rawOf(f) }} is not a valid {{ f.type }} — kept as-is until you
                  change this field.
                </span>
              } @else if (f.relevant && !f.relevant(values())) {
                <span class="form-hint warn">Not used by the current selection.</span>
              } @else if (hintOf(f); as h) {
                <span class="form-hint">{{ h }}</span>
              }
            </div>
          }
        }
      </div>

      @if (problems().length > 0) {
        <ul class="sub-config-problems">
          @for (p of problems(); track p) {
            <li>{{ p }}</li>
          }
        </ul>
      }
      @if (parsed().unknownKeys.length > 0) {
        <span class="form-hint">
          Preserved keys the engine does not read:
          <code>{{ parsed().unknownKeys.join(', ') }}</code>
        </span>
      }

      <div class="sub-config-raw">
        <button
          type="button"
          class="btn btn-link sub-config-raw-toggle"
          [attr.aria-expanded]="showRaw()"
          (click)="showRaw.set(!showRaw())"
        >
          {{ showRaw() ? '▾' : '▸' }} Advanced: raw JSON
        </button>
        @if (showRaw() || !!parsed().error) {
          <textarea
            class="form-input form-textarea form-mono"
            rows="4"
            [disabled]="isDisabled()"
            [value]="raw()"
            [placeholder]="placeholderText()"
            (input)="setRaw($any($event.target).value)"
          ></textarea>
          <span class="form-hint"
            >Blank = not configured (inherit). Edits here update the form above.</span
          >
        }
      </div>
    </fieldset>
  `,
  styles: [
    `
      .sub-config {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3) var(--space-4);
        margin: 0 0 var(--space-4);
      }
      .sub-config-title {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold, 600);
        color: var(--text-primary);
        padding: 0 var(--space-1);
      }
      .sub-config-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: var(--space-3) var(--space-4);
      }
      .sub-config-grid.disabled {
        opacity: 0.5;
      }
      .sub-config-field.wide {
        grid-column: 1 / -1;
      }
      .form-label {
        display: block;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
      }
      .form-input {
        width: 100%;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s ease;
      }
      .form-input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.1);
      }
      .form-textarea {
        height: auto;
        padding: var(--space-2) var(--space-3);
        resize: vertical;
        line-height: 1.5;
      }
      .form-mono {
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 12px;
      }
      .form-hint {
        display: block;
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-tertiary, #8e8e93);
      }
      .form-hint.warn {
        color: var(--warning, #ff9500);
      }
      .form-hint code {
        font-family: 'SF Mono', 'Menlo', monospace;
        background: rgba(142, 142, 147, 0.12);
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 10.5px;
      }
      .sub-config-checks {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-4);
      }
      .sub-config-check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .sub-config-error {
        font-size: var(--text-sm);
        color: var(--loss);
        margin-bottom: var(--space-2);
      }
      .sub-config-problems {
        margin: var(--space-3) 0 0;
        padding-left: var(--space-4);
        font-size: var(--text-xs, 12px);
        color: var(--warning, #ff9500);
      }
      .sub-config-raw {
        margin-top: var(--space-3);
      }
      .sub-config-raw-toggle {
        padding: 0;
        font-size: var(--text-xs, 12px);
        margin-bottom: var(--space-1);
      }
    `,
  ],
})
export class SubConfigEditorComponent implements ControlValueAccessor {
  // Decorator inputs (not signal inputs): the repo's JIT component-test harness does not bind
  // signal inputs from a parent template, and the strategy form's specs render this editor.
  readonly activeSchema = signal<SubConfigSchema>(RISK_OVERRIDES_SCHEMA);
  readonly gateTimeframe = signal<string | null>(null);
  readonly placeholderText = signal('');

  @Input({ required: true }) set schema(v: SubConfigSchema) {
    this.activeSchema.set(v);
  }
  /** The strategy's own timeframe (MTF gate options / validation). */
  @Input() set strategyTimeframe(v: string | null | undefined) {
    this.gateTimeframe.set(v ?? null);
  }
  @Input() set placeholder(v: string | null | undefined) {
    this.placeholderText.set(v ?? '');
  }

  readonly raw = signal('');
  readonly showRaw = signal(false);
  readonly isDisabled = signal(false);
  /** Known keys holding a value the form cannot show, not yet edited by the operator. */
  private readonly touched = signal<ReadonlySet<string>>(new Set());

  readonly parsed = computed(() => parseSubConfig(this.raw(), this.activeSchema()));
  readonly values = computed(() => this.parsed().values);
  readonly unrepresentable = computed(() => {
    const t = this.touched();
    return this.parsed()
      .unrepresentable.filter((k) => !t.has(k.toLowerCase()))
      .map(
        (k) => this.activeSchema().fields.find((f) => f.key.toLowerCase() === k.toLowerCase())!.key,
      );
  });
  readonly problems = computed(() => {
    const p = this.parsed();
    if (p.error) return [];
    return (
      this.activeSchema().problems?.(p.values, { strategyTimeframe: this.gateTimeframe() }) ?? []
    );
  });

  private onChange: (v: string) => void = () => {};
  private onTouched: () => void = () => {};

  // ── ControlValueAccessor ─────────────────────────────────────────────────
  writeValue(v: string | null): void {
    this.raw.set(v ?? '');
    this.touched.set(new Set());
  }
  registerOnChange(fn: (v: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(d: boolean): void {
    this.isDisabled.set(d);
  }

  // ── Template helpers ─────────────────────────────────────────────────────
  id(f: SubConfigField): string {
    return `sc-${this.activeSchema().kind}-${f.key}`;
  }
  labelOf(f: SubConfigField): string {
    return typeof f.label === 'function' ? f.label(this.values()) : f.label;
  }
  hintOf(f: SubConfigField): string | undefined {
    return typeof f.hint === 'function' ? f.hint(this.values()) : f.hint;
  }
  optionsOf(f: SubConfigField): readonly SubConfigOption[] {
    const base = fieldOptions(f, { strategyTimeframe: this.gateTimeframe() });
    // Keep a stored value visible even when it is outside the current option set (e.g. an MTF
    // timeframe no longer above the strategy's), so the form never silently changes it.
    const cur = this.values()[f.key];
    if (f.type === 'enum' && typeof cur === 'string' && !base.some((o) => o.value === cur))
      return [...base, { value: cur, label: `${cur} (not valid here)` }];
    return base;
  }
  isShown(f: SubConfigField): boolean {
    if (!f.relevant) return true;
    return (
      f.relevant(this.values()) ||
      this.values()[f.key] != null ||
      this.unrepresentable().includes(f.key)
    );
  }
  hasValue(f: SubConfigField): boolean {
    return this.values()[f.key] != null;
  }
  isChecked(f: SubConfigField, value: string): boolean {
    const v = this.values()[f.key];
    return Array.isArray(v) && v.includes(value);
  }
  rawOf(f: SubConfigField): string {
    const src = this.parsed().source ?? {};
    const k = Object.keys(src).find((x) => x.toLowerCase() === f.key.toLowerCase());
    return k ? JSON.stringify(src[k]) : '';
  }

  // ── Edits ────────────────────────────────────────────────────────────────
  setEnum(f: SubConfigField, v: string): void {
    this.setValue(f, v === '' ? undefined : v);
  }
  setTriBool(f: SubConfigField, v: string): void {
    this.setValue(f, v === '' ? undefined : v === 'true');
  }
  setNumber(f: SubConfigField, v: string): void {
    if (v === '' || v == null) return this.setValue(f, undefined);
    const n = Number(v);
    if (!Number.isFinite(n)) return this.setValue(f, undefined);
    this.setValue(f, f.type === 'int' ? Math.trunc(n) : n);
  }
  toggleMulti(f: SubConfigField, value: string, checked: boolean): void {
    const cur = (this.values()[f.key] as string[] | undefined) ?? [];
    const next = checked
      ? [...cur.filter((x) => x !== value), value]
      : cur.filter((x) => x !== value);
    // Keep the engine's enum order for a stable, diff-friendly JSON.
    const order = fieldOptions(f, {}).map((o) => o.value);
    next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    this.setValue(f, next.length ? next : undefined);
  }

  setValue(f: SubConfigField, v: unknown): void {
    const p = this.parsed();
    if (p.error) return;
    const touched = new Set(this.touched());
    touched.add(f.key.toLowerCase());
    this.touched.set(touched);
    const values = { ...p.values, [f.key]: v };
    if (v === undefined) delete values[f.key];
    const keep = p.unrepresentable.filter((k) => !touched.has(k.toLowerCase()));
    this.emit(serializeSubConfig(this.activeSchema(), values, p.source, keep));
  }

  setRaw(text: string): void {
    this.touched.set(new Set());
    this.emit(text);
  }

  private emit(text: string): void {
    this.raw.set(text);
    this.onChange(text);
    this.onTouched();
  }
}
