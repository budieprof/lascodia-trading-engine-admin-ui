import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import type { StrategyParameterSchemaDto } from '@core/api/api.types';

/** One typed parameter edited: its name and new value. */
export interface TypedParameterChange {
  name: string;
  value: unknown;
}

/**
 * b10-ui — the strategy form's typed parameter grid (split out of StrategyFormComponent, behaviour unchanged): one
 * input per field of the strategy type's registered schema (enum → select, bool → checkbox, int / decimal → number,
 * else text), showing the current value or the field's default. Each edit is reported; the form merges it into its
 * Parameters JSON, which stays the source of truth.
 *
 * Decorator inputs (not signal inputs): the repo's JIT component-test harness does not bind signal inputs from a
 * parent template, and the strategy form's specs render this component.
 */
@Component({
  selector: 'app-strategy-typed-parameters',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (schema; as schema) {
      <div class="typed-params">
        <header class="typed-params-head">
          <span>Typed parameters · {{ schema.fields.length }} fields</span>
          <span class="muted small">edits sync to Parameters JSON below</span>
        </header>
        <div class="typed-params-grid">
          @for (f of schema.fields; track f.name) {
            <div class="typed-params-field">
              <label class="form-label" [title]="f.description ?? ''">
                {{ f.label }}
                @if (f.description) {
                  <span class="muted small"> — {{ f.description }}</span>
                }
              </label>
              @if (f.kind === 'enum' && f.enumValues; as opts) {
                <select
                  class="form-input"
                  [value]="values[f.name] ?? f.default"
                  (change)="change(f.name, $any($event.target).value)"
                >
                  @for (o of opts; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
              } @else if (f.kind === 'bool') {
                <input
                  type="checkbox"
                  [checked]="$any(values[f.name] ?? f.default)"
                  (change)="change(f.name, $any($event.target).checked)"
                />
              } @else {
                <input
                  class="form-input"
                  [type]="f.kind === 'int' || f.kind === 'decimal' ? 'number' : 'text'"
                  [min]="f.min ?? null"
                  [max]="f.max ?? null"
                  [step]="f.step ?? (f.kind === 'int' ? 1 : 0.01)"
                  [value]="values[f.name] ?? f.default"
                  (input)="
                    change(
                      f.name,
                      f.kind === 'int'
                        ? +$any($event.target).value
                        : f.kind === 'decimal'
                          ? +$any($event.target).value
                          : $any($event.target).value
                    )
                  "
                />
              }
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      /* No box of its own: the grid sits in the form body as it always did. */
      :host {
        display: contents;
      }
      /* The strategy form's rules for what this markup uses (component styles do not cross into a child). */
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
      .typed-params {
        background: var(--bg-tertiary, #fafafa);
        border: 1px solid var(--border, #e5e5ea);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .typed-params-head {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary, #636366);
        margin-bottom: 8px;
      }
      .typed-params-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
        gap: 8px 12px;
      }
      .typed-params-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    `,
  ],
})
export class StrategyTypedParametersComponent {
  /** The strategy type's registered parameter schema; null renders nothing. */
  @Input() schema: StrategyParameterSchemaDto | null = null;
  /** The current values, by field name (a missing one shows the field's default). */
  @Input() values: Record<string, unknown> = {};
  /** A field was edited. */
  @Output() readonly changed = new EventEmitter<TypedParameterChange>();

  change(name: string, value: unknown): void {
    this.changed.emit({ name, value });
  }
}
