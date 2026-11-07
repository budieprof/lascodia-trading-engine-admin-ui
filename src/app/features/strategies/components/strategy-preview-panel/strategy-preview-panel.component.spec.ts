import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { StrategyPreviewPanelComponent } from './strategy-preview-panel.component';

declareSignalIo(StrategyPreviewPanelComponent, { inputs: ['form'] });

// U13: moved from strategy-form.component.spec.ts with the preview panel (cases unchanged), plus the form wiring.
describe('StrategyPreviewPanelComponent (logic)', () => {
  let cmp: StrategyPreviewPanelComponent;
  let listPreviewSnapshots: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listPreviewSnapshots = vi.fn().mockReturnValue(of({ status: true, data: [] }));
    TestBed.configureTestingModule({
      imports: [StrategyPreviewPanelComponent],
      providers: [
        {
          provide: StrategiesService,
          useValue: { listPreviewSnapshots, runBacktestPreview: vi.fn() },
        },
        { provide: NotificationService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(StrategyPreviewPanelComponent);
    fixture.componentRef.setInput(
      'form',
      new FormBuilder().group({ symbol: 'EURUSD', timeframe: 'H1', strategyType: 'RuleBased' }),
    );
    cmp = fixture.componentInstance;
  });

  it('lists the snapshots matching the form on init', () => {
    cmp.ngOnInit();
    expect(listPreviewSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'EURUSD',
        timeframe: 'H1',
        strategyType: 'RuleBased',
        scope: 'mine',
      }),
    );
  });

  describe('equitySparklinePoints', () => {
    it('returns empty for empty curve', () => {
      expect(cmp.equitySparklinePoints([], 100, 50)).toBe('');
    });

    it('maps a flat curve to a flat baseline near the bottom', () => {
      const pts = cmp.equitySparklinePoints([100, 100, 100], 100, 50).split(' ');
      // All y coords identical (range=0 → division by 1 → y = height - 0 = height)
      const ys = pts.map((p) => p.split(',')[1]);
      expect(new Set(ys).size).toBe(1);
    });

    it('maps a monotonic-up curve to monotonically-decreasing y values (svg origin top-left)', () => {
      const pts = cmp.equitySparklinePoints([1, 2, 3, 4, 5], 100, 50);
      const ys = pts.split(' ').map((p) => parseFloat(p.split(',')[1]));
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i]).toBeLessThanOrEqual(ys[i - 1]);
      }
    });

    it('places the first point at x=0 and the last at x=width', () => {
      const pts = cmp.equitySparklinePoints([1, 2, 3], 100, 50).split(' ');
      const firstX = parseFloat(pts[0].split(',')[0]);
      const lastX = parseFloat(pts[pts.length - 1].split(',')[0]);
      expect(firstX).toBe(0);
      expect(lastX).toBe(100);
    });
  });

  describe('equityBaselineY', () => {
    it('returns the full height for an empty curve', () => {
      expect(cmp.equityBaselineY([], 1000, 80)).toBe(80);
    });

    it('places the baseline at the top when initial equals max', () => {
      // initial = max → (max - min)/range = 1 → y = height - height = 0
      expect(cmp.equityBaselineY([100, 200], 200, 80)).toBe(0);
    });

    it('places the baseline at the bottom when initial equals min', () => {
      // initial = min → 0/range = 0 → y = height
      expect(cmp.equityBaselineY([100, 200], 100, 80)).toBe(80);
    });
  });

  describe('overlayCurves / overlayBounds (computed signals)', () => {
    it('produces no curves when there is nothing to plot', () => {
      expect(cmp.overlayCurves().length).toBe(0);
      expect(cmp.overlayBounds()).toBeNull();
    });
  });

  describe('snapshot scope toggle', () => {
    it('starts in "mine" scope', () => {
      expect(cmp.snapshotScope()).toBe('mine');
    });

    it('toggles between mine and all', () => {
      cmp.toggleSnapshotScope();
      expect(cmp.snapshotScope()).toBe('all');
      cmp.toggleSnapshotScope();
      expect(cmp.snapshotScope()).toBe('mine');
    });
  });

  describe('hidden curves', () => {
    it('starts empty', () => {
      expect(cmp.hiddenCurves().size).toBe(0);
    });

    it('toggleCurveVisibility flips membership', () => {
      cmp.toggleCurveVisibility('s1');
      expect(cmp.hiddenCurves().has('s1')).toBe(true);
      cmp.toggleCurveVisibility('s1');
      expect(cmp.hiddenCurves().has('s1')).toBe(false);
    });
  });
});
