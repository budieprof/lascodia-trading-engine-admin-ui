import { Component, ChangeDetectionStrategy, input, forwardRef, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, ReactiveFormsModule } from '@angular/forms';

@Component({
  selector: 'ui-input',
  standalone: true,
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => InputComponent),
      multi: true,
    },
  ],
  template: `
    @if (label()) {
      <label class="input__label" [for]="inputId">{{ label() }}</label>
    }
    <input
      class="input__field"
      [class.input__field--error]="!!error()"
      [class.input__field--disabled]="isDisabled()"
      [id]="inputId"
      [type]="type()"
      [placeholder]="placeholder()"
      [disabled]="isDisabled()"
      [value]="value()"
      (input)="onInput($event)"
      (blur)="onTouched()"
    />
    @if (error()) {
      <span class="input__error">{{ error() }}</span>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        width: 100%;
      }

      .input__label {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
        letter-spacing: -0.01em;
      }

      .input__field {
        height: 40px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: inherit;
        font-size: 14px;
        outline: none;
        transition:
          border-color 0.15s ease,
          box-shadow 0.15s ease;
        width: 100%;
        box-sizing: border-box;
      }

      .input__field::placeholder {
        color: var(--text-tertiary);
      }

      .input__field:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.3);
      }

      .input__field--error {
        border-color: #ff3b30;
      }

      .input__field--error:focus {
        border-color: #ff3b30;
        box-shadow: 0 0 0 3px rgba(255, 59, 48, 0.3);
      }

      .input__field--disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .input__error {
        font-size: 12px;
        color: #ff3b30;
        margin-top: 2px;
      }
    `,
  ],
})
export class InputComponent implements ControlValueAccessor {
  readonly label = input<string>('');
  readonly placeholder = input<string>('');
  readonly type = input<string>('text');
  readonly error = input<string>('');

  readonly value = signal('');
  readonly isDisabled = signal(false);

  readonly inputId = `ui-input-${Math.random().toString(36).substring(2, 9)}`;

  private onChange: (value: string) => void = () => {};
  onTouched: () => void = () => {};

  writeValue(value: string): void {
    this.value.set(value ?? '');
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.isDisabled.set(isDisabled);
  }

  onInput(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.value.set(val);
    this.onChange(val);
  }
}
