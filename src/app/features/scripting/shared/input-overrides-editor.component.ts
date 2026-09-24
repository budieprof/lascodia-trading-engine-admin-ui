import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import type { ScriptInputDef } from '../api/scripting-api.types';
import {
  diffOverrides,
  displayValue,
  effectiveValue,
  fieldFor,
  groupFields,
  isInactive,
  parseInputValue,
  parseLooseValue,
  type InputField,
} from './script-inputs';

interface FreeRow {
  id: number;
  key: string;
  value: string;
}

let nextEditorUid = 0;

/**
 * Edits a script's input overrides. With the compiled inputs schema it shows one typed control
 * per `input.*()` (grouped, bounded, with the script's own options and tooltips) pre-filled with
 * the values in effect; without a schema it falls back to a plain key / value list.
 *
 * Emits only what differs from the baseline (`overridesChange`) and whether every field is valid
 * (`validityChange`).
 */
@Component({
  selector: 'app-input-overrides-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (inputs(); as defs) {
      @if (defs.length === 0) {
        <p class="muted">This script declares no inputs.</p>
      }
      @for (g of groups(); track g.title) {
        <fieldset class="group">
          @if (g.title) {
            <legend>{{ g.title }}</legend>
          }
          @for (f of g.fields; track f.def.id) {
            <div class="row" [class.changed]="isChanged(f)" [class.inactive]="inactive(f)">
              <label class="label" [attr.for]="uid + '-' + f.def.id">
                {{ f.def.title || f.def.id }}
              </label>
              <div class="control">
                @if (f.control === 'integer' || f.control === 'number') {
                  <input
                    type="number"
                    [id]="uid + '-' + f.def.id"
                    [attr.min]="f.def.minValue ?? null"
                    [attr.max]="f.def.maxValue ?? null"
                    [attr.step]="f.def.step ?? (f.control === 'integer' ? 1 : 'any')"
                    [value]="display(f)"
                    [disabled]="disabled() || inactive(f)"
                    [attr.aria-invalid]="!!errors()[f.def.id]"
                    (change)="onChange(f, $any($event.target).value)"
                  />
                } @else if (f.control === 'checkbox') {
                  <input
                    type="checkbox"
                    [id]="uid + '-' + f.def.id"
                    [checked]="values()[f.def.id] === true"
                    [disabled]="disabled() || inactive(f)"
                    (change)="onChange(f, $any($event.target).checked)"
                  />
                } @else if (f.control === 'select') {
                  <select
                    [id]="uid + '-' + f.def.id"
                    [disabled]="disabled() || inactive(f)"
                    (change)="onChange(f, $any($event.target).value)"
                  >
                    @for (o of f.options; track o.key) {
                      <option [value]="o.key" [selected]="o.key === display(f)">
                        {{ o.label }}
                      </option>
                    }
                  </select>
                } @else if (f.control === 'textarea') {
                  <textarea
                    rows="2"
                    [id]="uid + '-' + f.def.id"
                    [value]="display(f)"
                    [disabled]="disabled() || inactive(f)"
                    (change)="onChange(f, $any($event.target).value)"
                  ></textarea>
                } @else if (f.control === 'datetime') {
                  <input
                    type="datetime-local"
                    [id]="uid + '-' + f.def.id"
                    [value]="display(f)"
                    [disabled]="disabled() || inactive(f)"
                    [attr.aria-invalid]="!!errors()[f.def.id]"
                    (change)="onChange(f, $any($event.target).value)"
                  />
                } @else {
                  <input
                    type="text"
                    spellcheck="false"
                    [id]="uid + '-' + f.def.id"
                    [value]="display(f)"
                    [disabled]="disabled() || inactive(f)"
                    [attr.aria-invalid]="!!errors()[f.def.id]"
                    (change)="onChange(f, $any($event.target).value)"
                  />
                }
                @if (isChanged(f)) {
                  <button
                    type="button"
                    class="reset"
                    [disabled]="disabled()"
                    [attr.aria-label]="'Reset ' + (f.def.title || f.def.id)"
                    (click)="reset(f)"
                  >
                    Reset
                  </button>
                }
              </div>
              @if (errors()[f.def.id]; as e) {
                <span class="err">{{ e }}</span>
              }
              @if (f.def.tooltip) {
                <span class="tip">{{ f.def.tooltip }}</span>
              }
            </div>
          }
        </fieldset>
      }
    } @else {
      <p class="muted">
        The inputs schema is not available. Enter overrides by input id; values are read as numbers,
        true / false or text.
      </p>
      @for (r of freeRows(); track r.id) {
        <div class="free">
          <label class="sr-only" [attr.for]="uid + '-k' + r.id">Input id</label>
          <input
            type="text"
            spellcheck="false"
            placeholder="input id"
            [id]="uid + '-k' + r.id"
            [value]="r.key"
            [disabled]="disabled()"
            (input)="editFree(r.id, 'key', $any($event.target).value)"
          />
          <label class="sr-only" [attr.for]="uid + '-v' + r.id">Value</label>
          <input
            type="text"
            spellcheck="false"
            placeholder="value"
            [id]="uid + '-v' + r.id"
            [value]="r.value"
            [disabled]="disabled()"
            (input)="editFree(r.id, 'value', $any($event.target).value)"
          />
          <button type="button" class="reset" [disabled]="disabled()" (click)="removeFree(r.id)">
            Remove
          </button>
        </div>
      }
      <button type="button" class="add" [disabled]="disabled()" (click)="addFree()">
        + Add override
      </button>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .group {
        margin: 0;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
        gap: var(--space-3);
      }
      legend {
        padding: 0 var(--space-1);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .row.inactive {
        opacity: 0.55;
      }
      .label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .row.changed .label::after {
        content: ' • changed';
        color: var(--accent);
      }
      .control {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }
      input[type='text'],
      input[type='number'],
      input[type='datetime-local'],
      select,
      textarea {
        flex: 1;
        min-width: 0;
        height: 32px;
        padding: 0 var(--space-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      textarea {
        height: auto;
        padding: var(--space-1) var(--space-2);
      }
      [aria-invalid='true'] {
        border-color: var(--loss);
      }
      .reset,
      .add {
        height: 28px;
        padding: 0 var(--space-2);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .add {
        align-self: flex-start;
      }
      .reset:focus-visible,
      .add:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .err {
        font-size: var(--text-xs);
        color: var(--loss);
      }
      .tip {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .free {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }
      .muted {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
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
export class InputOverridesEditorComponent {
  /** The compiled inputs schema; null when it is not available (free-form mode). */
  readonly inputs = input<readonly ScriptInputDef[] | null>(null);
  /** Values already in effect for the strategy (its saved input overrides). */
  readonly baseline = input<Readonly<Record<string, unknown>>>({});
  readonly disabled = input(false);

  /** Inputs that differ from the baseline — what a run needs to send. */
  readonly overridesChange = output<Record<string, unknown>>();
  readonly validityChange = output<boolean>();

  readonly uid = `inputs-${nextEditorUid++}`;
  readonly values = signal<Record<string, unknown>>({});
  readonly errors = signal<Record<string, string>>({});
  readonly freeRows = signal<FreeRow[]>([]);
  private nextFreeId = 0;

  readonly fields = computed<InputField[]>(() => (this.inputs() ?? []).map(fieldFor));
  readonly groups = computed(() => groupFields(this.fields()));
  private readonly baselineValues = computed<Record<string, unknown>>(() => {
    const saved = this.baseline();
    return Object.fromEntries(this.fields().map((f) => [f.def.id, effectiveValue(f.def, saved)]));
  });

  constructor() {
    effect(() => {
      const base = this.baselineValues();
      untracked(() => {
        this.values.set({ ...base });
        this.errors.set({});
        this.emit();
      });
    });
  }

  display(f: InputField): string {
    return displayValue(f, this.values()[f.def.id]);
  }

  isChanged(f: InputField): boolean {
    return (
      JSON.stringify(this.values()[f.def.id]) !== JSON.stringify(this.baselineValues()[f.def.id])
    );
  }

  inactive(f: InputField): boolean {
    return isInactive(f.def, this.values());
  }

  onChange(f: InputField, raw: string | boolean): void {
    const { value, error } = parseInputValue(f, raw);
    this.values.update((v) => ({ ...v, [f.def.id]: value }));
    this.errors.update((e) => {
      const next = { ...e };
      if (error) next[f.def.id] = error;
      else delete next[f.def.id];
      return next;
    });
    this.emit();
  }

  reset(f: InputField): void {
    this.values.update((v) => ({ ...v, [f.def.id]: this.baselineValues()[f.def.id] }));
    this.errors.update((e) => {
      const next = { ...e };
      delete next[f.def.id];
      return next;
    });
    this.emit();
  }

  addFree(): void {
    this.freeRows.update((rows) => [...rows, { id: this.nextFreeId++, key: '', value: '' }]);
  }

  editFree(id: number, field: 'key' | 'value', text: string): void {
    this.freeRows.update((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: text } : r)));
    this.emit();
  }

  removeFree(id: number): void {
    this.freeRows.update((rows) => rows.filter((r) => r.id !== id));
    this.emit();
  }

  private emit(): void {
    if (this.inputs() === null) {
      const out: Record<string, unknown> = {};
      for (const r of this.freeRows()) {
        if (r.key.trim()) out[r.key.trim()] = parseLooseValue(r.value);
      }
      this.overridesChange.emit(out);
      this.validityChange.emit(true);
      return;
    }
    const errors = this.errors();
    const current = Object.fromEntries(
      Object.entries(this.values()).filter(([k]) => !(k in errors)),
    );
    this.overridesChange.emit(diffOverrides(this.baselineValues(), current));
    this.validityChange.emit(Object.keys(errors).length === 0);
  }
}
