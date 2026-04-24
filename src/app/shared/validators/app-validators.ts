import { AbstractControl, ValidationErrors } from '@angular/forms';

/**
 * Shared validators that belong to our domain (forex symbols, pip values, lot sizes).
 * Import from `@shared/validators/app-validators`.
 */
export class AppValidators {
  /** Validates a 6-letter currency pair like `EURUSD`, `USDJPY`. */
  static currencyPair(control: AbstractControl): ValidationErrors | null {
    const value: unknown = control.value;
    if (!value) return null;
    if (typeof value !== 'string') return { currencyPair: true };
    return /^[A-Z]{6}$/.test(value)
      ? null
      : { currencyPair: { message: '6 uppercase letters, e.g. EURUSD' } };
  }

  /** Validates a 3-letter currency code like `USD`, `EUR`. */
  static currencyCode(control: AbstractControl): ValidationErrors | null {
    const value: unknown = control.value;
    if (!value) return null;
    if (typeof value !== 'string') return { currencyCode: true };
    return /^[A-Z]{3}$/.test(value)
      ? null
      : { currencyCode: { message: '3 uppercase letters, e.g. USD' } };
  }

  /** Positive number, rejects zero and negatives. */
  static positive(control: AbstractControl): ValidationErrors | null {
    const value = control.value;
    if (value == null || value === '') return null;
    const num = Number(value);
    if (Number.isNaN(num)) return { positive: true };
    return num > 0 ? null : { positive: { message: 'Must be greater than zero' } };
  }

  /** Integer only. */
  static integer(control: AbstractControl): ValidationErrors | null {
    const value = control.value;
    if (value == null || value === '') return null;
    const num = Number(value);
    if (Number.isNaN(num)) return { integer: true };
    return Number.isInteger(num) ? null : { integer: { message: 'Must be a whole number' } };
  }

  /** Requires that a date string is in the past (exclusive). */
  static pastDate(control: AbstractControl): ValidationErrors | null {
    const value = control.value;
    if (!value) return null;
    const ts = Date.parse(String(value));
    if (Number.isNaN(ts)) return { pastDate: true };
    return ts < Date.now() ? null : { pastDate: { message: 'Must be a past date' } };
  }

  /** Requires that a date string is in the future (exclusive). */
  static futureDate(control: AbstractControl): ValidationErrors | null {
    const value = control.value;
    if (!value) return null;
    const ts = Date.parse(String(value));
    if (Number.isNaN(ts)) return { futureDate: true };
    return ts > Date.now() ? null : { futureDate: { message: 'Must be a future date' } };
  }
}
