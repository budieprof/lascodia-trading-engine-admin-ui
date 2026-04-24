import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { AppValidators } from './app-validators';

describe('AppValidators', () => {
  describe('currencyPair', () => {
    it('accepts EURUSD', () => {
      expect(AppValidators.currencyPair(new FormControl('EURUSD'))).toBeNull();
    });
    it('rejects 5-letter input', () => {
      expect(AppValidators.currencyPair(new FormControl('EURUS'))).not.toBeNull();
    });
    it('rejects lowercase', () => {
      expect(AppValidators.currencyPair(new FormControl('eurusd'))).not.toBeNull();
    });
    it('passes through empty values', () => {
      expect(AppValidators.currencyPair(new FormControl(''))).toBeNull();
      expect(AppValidators.currencyPair(new FormControl(null))).toBeNull();
    });
  });

  describe('currencyCode', () => {
    it('accepts USD', () => {
      expect(AppValidators.currencyCode(new FormControl('USD'))).toBeNull();
    });
    it('rejects lowercase', () => {
      expect(AppValidators.currencyCode(new FormControl('usd'))).not.toBeNull();
    });
  });

  describe('positive', () => {
    it('accepts 0.01', () => {
      expect(AppValidators.positive(new FormControl(0.01))).toBeNull();
    });
    it('rejects 0', () => {
      expect(AppValidators.positive(new FormControl(0))).not.toBeNull();
    });
    it('rejects negatives', () => {
      expect(AppValidators.positive(new FormControl(-1))).not.toBeNull();
    });
  });

  describe('integer', () => {
    it('accepts 5', () => {
      expect(AppValidators.integer(new FormControl(5))).toBeNull();
    });
    it('rejects 5.5', () => {
      expect(AppValidators.integer(new FormControl(5.5))).not.toBeNull();
    });
  });

  describe('pastDate', () => {
    it('accepts a date in the past', () => {
      const iso = new Date(Date.now() - 60_000).toISOString();
      expect(AppValidators.pastDate(new FormControl(iso))).toBeNull();
    });
    it('rejects a future date', () => {
      const iso = new Date(Date.now() + 60_000).toISOString();
      expect(AppValidators.pastDate(new FormControl(iso))).not.toBeNull();
    });
  });

  describe('futureDate', () => {
    it('accepts a future date', () => {
      const iso = new Date(Date.now() + 60_000).toISOString();
      expect(AppValidators.futureDate(new FormControl(iso))).toBeNull();
    });
    it('rejects a past date', () => {
      const iso = new Date(Date.now() - 60_000).toISOString();
      expect(AppValidators.futureDate(new FormControl(iso))).not.toBeNull();
    });
  });
});
