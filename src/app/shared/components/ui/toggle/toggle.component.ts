import {
  Component,
  ChangeDetectionStrategy,
  forwardRef,
  signal,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'ui-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => ToggleComponent),
      multi: true,
    },
  ],
  template: `
    <button
      type="button"
      role="switch"
      class="toggle"
      [class.toggle--active]="checked()"
      [class.toggle--disabled]="isDisabled()"
      [attr.aria-checked]="checked()"
      [disabled]="isDisabled()"
      (click)="toggle()"
    >
      <span class="toggle__knob"></span>
    </button>
  `,
  styles: [`
    :host {
      display: inline-block;
    }

    .toggle {
      width: 44px;
      height: 24px;
      border-radius: var(--radius-full);
      background: var(--bg-tertiary);
      border: none;
      cursor: pointer;
      position: relative;
      padding: 0;
      transition: background-color 0.2s ease;
      outline: none;
    }

    .toggle:focus-visible {
      box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.3);
    }

    .toggle--active {
      background: var(--accent);
    }

    .toggle--disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .toggle__knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #FFFFFF;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      transition: transform 0.2s ease;
    }

    .toggle--active .toggle__knob {
      transform: translateX(20px);
    }
  `],
})
export class ToggleComponent implements ControlValueAccessor {
  readonly checked = signal(false);
  readonly isDisabled = signal(false);

  private onChange: (value: boolean) => void = () => {};
  private onTouched: () => void = () => {};

  writeValue(value: boolean): void {
    this.checked.set(!!value);
  }

  registerOnChange(fn: (value: boolean) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.isDisabled.set(isDisabled);
  }

  toggle(): void {
    if (this.isDisabled()) return;
    const newValue = !this.checked();
    this.checked.set(newValue);
    this.onChange(newValue);
    this.onTouched();
  }
}
