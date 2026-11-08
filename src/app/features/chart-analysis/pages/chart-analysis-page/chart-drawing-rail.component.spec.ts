import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveJitResources } from '@shared/testing/jit-resources';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingStore } from '../../drawings/drawing-store.service';
import { DrawingFavorites } from '../../drawings/drawing-favorites.service';
import { ChartDrawingTools } from './chart-drawing-tools';
import { ChartDrawingRailComponent } from './chart-drawing-rail.component';

declareSignalIo(ChartIconComponent, { inputs: ['name', 'size'] });

const TEMPLATE = readFileSync(
  resolve(
    process.cwd(),
    'src/app/features/chart-analysis/pages/chart-analysis-page/chart-drawing-rail.component.html',
  ),
  'utf8',
);

// US02b: the rail reads the page's ChartDrawingTools (no page slice) and the drawings from their store.
describe('ChartDrawingRailComponent (US02b drawing tools)', () => {
  it('arms and disarms a tool, toggles the magnet and asks the drawings to lock', async () => {
    await resolveJitResources({
      'chart-drawing-rail.component.html': TEMPLATE,
      'chart-drawing-rail.component.scss': '',
    });
    const tools = new ChartDrawingTools({
      readPref: (_key, fallback) => fallback,
      writePref: () => undefined,
      favorites: { toggle: vi.fn() },
    });
    const drawings = {
      allLocked: signal(false),
      visible: signal([{ id: 'a' }]),
      hidden: signal(false),
      setLockAll: vi.fn(),
      clearVisible: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [ChartDrawingRailComponent],
      providers: [
        { provide: ChartDrawingTools, useValue: tools },
        { provide: DrawingStore, useValue: drawings },
        { provide: DrawingFavorites, useValue: { has: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(ChartDrawingRailComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const btn = (label: string) =>
      el.querySelector(`button[aria-label^="${label}"]`) as HTMLButtonElement;

    btn('Trend Line').click();
    expect(tools.tool()).toBe('trend-line');
    fixture.detectChanges();
    expect(btn('Trend Line').classList).toContain('active');
    btn('Cursor').click();
    expect(tools.tool()).toBeNull();

    btn('Weak magnet').click();
    expect(tools.magnet()).toBe(true);
    btn('Lock all drawings').click();
    expect(drawings.setLockAll).toHaveBeenCalledWith(true);
  });
});
