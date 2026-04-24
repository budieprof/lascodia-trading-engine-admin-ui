import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AbstractControl, FormsModule, ValidationErrors } from '@angular/forms';

export { FormFieldControlDirective } from './form-field-control.directive';

/**
 * Low-ceremony form-row wrapper that handles label/input association, required/invalid
 * semantics, and error display. Works with Reactive Forms via the [control] input.
 *
 * Two usage patterns:
 *
 *   1. Drop-in (preferred) — wrap the control with [appFormFieldControl]:
 *        <app-form-field label="Lot Size" [control]="form.controls.lotSize" [required]="true">
 *          <input appFormFieldControl formControlName="lotSize" type="number" step="0.01" />
 *        </app-form-field>
 *
 *      The directive binds to the wrapping `<label>`'s id and sets `aria-required`,
 *      `aria-invalid`, and `aria-describedby` automatically from the form control state.
 *
 *   2. Static — no directive, just label + hint/error:
 *        <app-form-field label="Notes" hint="Optional">
 *          <textarea formControlName="notes"></textarea>
 *        </app-form-field>
 */
@Component({
  selector: 'app-form-field',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <label class="field" [class.error]="hasError()">
      @if (label()) {
        <span class="label">
          {{ label() }}
          @if (required()) {
            <abbr class="required" title="required" aria-label="required">*</abbr>
          }
        </span>
      }
      <span class="control">
        <ng-content />
      </span>
      @if (hasError() && errorMessage()) {
        <span class="error-msg" [id]="errorId" role="alert">{{ errorMessage() }}</span>
      } @else if (hint()) {
        <span class="hint" [id]="hintId">{{ hint() }}</span>
      }
    </label>
  `,
  styles: [
    `
      .field {
        display: flex;
        flex-direction: column;
        min-width: 0;
        cursor: default;
      }
      .label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .required {
        color: var(--loss);
        margin-left: 2px;
        text-decoration: none;
      }
      .control {
        display: block;
      }
      .control ::ng-deep input,
      .control ::ng-deep select,
      .control ::ng-deep textarea {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
        width: 100%;
        box-sizing: border-box;
        font-family: inherit;
      }
      .control ::ng-deep textarea {
        height: auto;
        padding: var(--space-2) var(--space-3);
      }
      .control ::ng-deep input:focus-visible,
      .control ::ng-deep select:focus-visible,
      .control ::ng-deep textarea:focus-visible {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.15);
      }
      .error .control ::ng-deep input,
      .error .control ::ng-deep select,
      .error .control ::ng-deep textarea {
        border-color: var(--loss);
      }
      .hint {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-top: var(--space-1);
      }
      .error-msg {
        font-size: var(--text-xs);
        color: var(--loss);
        margin-top: var(--space-1);
      }
    `,
  ],
})
export class FormFieldComponent {
  private static nextId = 0;

  readonly hintId = `form-field-hint-${FormFieldComponent.nextId++}`;
  readonly errorId = `form-field-error-${FormFieldComponent.nextId++}`;

  readonly label = input<string>('');
  readonly hint = input<string>('');
  readonly required = input(false);
  readonly control = input<AbstractControl | null>(null);
  readonly errorMessages = input<Record<string, string>>({});

  readonly hasError = computed(() => {
    const c = this.control();
    if (!c) return false;
    return c.invalid && (c.touched || c.dirty);
  });

  readonly errorMessage = computed(() => {
    const c = this.control();
    if (!c || !c.errors) return null;
    const errors = c.errors as ValidationErrors;
    const provided = this.errorMessages();
    for (const key of Object.keys(errors)) {
      if (provided[key]) return provided[key];
      const fallback = DEFAULT_ERROR_MESSAGES[key];
      if (fallback) return fallback(errors[key]);
    }
    return 'Invalid value';
  });

  /** Resolve the description id surfaced to child inputs for `aria-describedby`. */
  readonly describedById = computed(() =>
    this.hasError() && this.errorMessage() ? this.errorId : this.hint() ? this.hintId : null,
  );
}

const DEFAULT_ERROR_MESSAGES: Record<string, (detail: unknown) => string> = {
  required: () => 'Required',
  min: (d) => `Must be at least ${(d as { min: number }).min}`,
  max: (d) => `Must be at most ${(d as { max: number }).max}`,
  minlength: (d) =>
    `Must be at least ${(d as { requiredLength: number }).requiredLength} characters`,
  maxlength: (d) =>
    `Must be at most ${(d as { requiredLength: number }).requiredLength} characters`,
  email: () => 'Invalid email address',
  pattern: () => 'Invalid format',
};
