import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { DslBuilderComponent } from './dsl-builder.component';

// Validation hints + drag-to-reorder are pure-state logic on the component
// instance; they don't need a rendered template, so we drive the methods
// directly. Template-level tests would need TestBed with full DI for the
// recursive ng-template, which adds complexity without exercising new
// behaviour beyond what these unit tests cover.

describe('DslBuilderComponent (logic)', () => {
  let cmp: DslBuilderComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [DslBuilderComponent] });
    const fixture = TestBed.createComponent(DslBuilderComponent);
    cmp = fixture.componentInstance;
  });

  describe('validateNode', () => {
    it('flags an empty AND group', () => {
      const node = { uid: 'n1', op: 'And' as const, children: [] };
      expect(cmp.validateNode(node)).toContain('Empty AND');
    });

    it('flags an AND with a single child as redundant', () => {
      const node = {
        uid: 'n1',
        op: 'And' as const,
        children: [
          {
            uid: 'n2',
            op: null,
            children: [],
            leaf: { type: 'PriceVsMa', config: { maPeriod: 200, operator: 'GreaterThan' } },
          },
        ],
      };
      expect(cmp.validateNode(node)).toContain('redundant');
    });

    it('flags NOT with the wrong arity', () => {
      const empty = { uid: 'n1', op: 'Not' as const, children: [] };
      expect(cmp.validateNode(empty)).toContain('exactly one');
      const two = {
        uid: 'n1',
        op: 'Not' as const,
        children: [
          { uid: 'a', op: null, children: [], leaf: { type: 'PriceVsMa', config: {} } },
          { uid: 'b', op: null, children: [], leaf: { type: 'PriceVsMa', config: {} } },
        ],
      };
      expect(cmp.validateNode(two)).toContain('exactly one');
    });

    it('flags IndicatorThreshold with missing indicator/period', () => {
      const node = {
        uid: 'n1',
        op: null,
        children: [],
        leaf: { type: 'IndicatorThreshold', config: { value: 30 } },
      };
      expect(cmp.validateNode(node)).toContain('positive period');
    });

    it('flags HourWindow with start === end', () => {
      const node = {
        uid: 'n1',
        op: null,
        children: [],
        leaf: { type: 'HourWindow', config: { startHourUtc: 8, endHourUtc: 8 } },
      };
      expect(cmp.validateNode(node)).toContain('same hour');
    });

    it('flags self-comparison in IndicatorComparison', () => {
      const node = {
        uid: 'n1',
        op: null,
        children: [],
        leaf: {
          type: 'IndicatorComparison',
          config: {
            leftIndicator: 'Ema',
            leftPeriod: 20,
            rightIndicator: 'Ema',
            rightPeriod: 20,
            operator: 'GreaterThan',
          },
        },
      };
      expect(cmp.validateNode(node)).toContain('itself');
    });

    it('flags RegimeMatch with no allowed regimes', () => {
      const node = {
        uid: 'n1',
        op: null,
        children: [],
        leaf: { type: 'RegimeMatch', config: { allowedRegimes: [] } },
      };
      expect(cmp.validateNode(node)).toContain('at least one');
    });

    it('returns null for a healthy AND with two leaves', () => {
      const node = {
        uid: 'n1',
        op: 'And' as const,
        children: [
          {
            uid: 'a',
            op: null,
            children: [],
            leaf: {
              type: 'IndicatorThreshold',
              config: { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 },
            },
          },
          {
            uid: 'b',
            op: null,
            children: [],
            leaf: { type: 'PriceVsMa', config: { maPeriod: 200, operator: 'GreaterThan' } },
          },
        ],
      };
      expect(cmp.validateNode(node)).toBeNull();
    });
  });

  describe('indicatorHint', () => {
    it('returns a description for known indicators', () => {
      expect(cmp.indicatorHint('Rsi')).toContain('Relative Strength');
      expect(cmp.indicatorHint('Ema')).toContain('Exponential');
    });

    it('returns empty string for unknown indicators', () => {
      expect(cmp.indicatorHint('NotARealIndicator')).toBe('');
    });
  });
});
