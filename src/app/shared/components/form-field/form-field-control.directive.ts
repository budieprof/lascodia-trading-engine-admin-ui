import { Directive, inject } from '@angular/core';
import { FormFieldComponent } from './form-field.component';

/**
 * Applied to the input/select/textarea inside `<app-form-field>`. Copies the
 * wrapper's `required` state and live validation state into `aria-required`,
 * `aria-invalid`, and `aria-describedby` on the host element so the input is
 * announced correctly by screen readers and can be picked up by assistive tech.
 */
@Directive({
  selector: '[appFormFieldControl]',
  standalone: true,
  host: {
    '[attr.aria-required]': 'field.required() ? "true" : null',
    '[attr.aria-invalid]': 'field.hasError() ? "true" : null',
    '[attr.aria-describedby]': 'field.describedById()',
  },
})
export class FormFieldControlDirective {
  protected readonly field = inject(FormFieldComponent, { host: true });
}
