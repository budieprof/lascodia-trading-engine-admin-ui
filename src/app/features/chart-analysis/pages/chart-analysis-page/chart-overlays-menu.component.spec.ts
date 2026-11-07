import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveJitResources } from '@shared/testing/jit-resources';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { CHART_OVERLAYS_MENU } from './chart-page.token';
import { ChartOverlaysMenuComponent } from './chart-overlays-menu.component';

declareSignalIo(ChartIconComponent, { inputs: ['name', 'size'] });

const TEMPLATE = readFileSync(
  resolve(
    process.cwd(),
    'src/app/features/chart-analysis/pages/chart-analysis-page/chart-overlays-menu.component.html',
  ),
  'utf8',
);

// U13: the overlays menu renders the page's own state and calls the page's own handlers — exactly as inline.
describe('ChartOverlaysMenuComponent (U13 split)', () => {
  it('shows the active-overlay count and asks the page to open its menu', async () => {
    await resolveJitResources({ 'chart-overlays-menu.component.html': TEMPLATE });
    const page = {
      openMenu: signal<string | null>(null),
      overlayCount: signal(3),
      toggleMenu: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [ChartOverlaysMenuComponent],
      providers: [{ provide: CHART_OVERLAYS_MENU, useValue: page }],
    });
    const fixture = TestBed.createComponent(ChartOverlaysMenuComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector('[data-testid="overlays-button"]') as HTMLButtonElement;
    expect(button.classList).toContain('active');
    expect(el.querySelector('.tb-badge')!.textContent!.trim()).toBe('3');
    expect(el.querySelector('.tb-overlays-menu')).toBeNull();
    button.click();
    expect(page.toggleMenu).toHaveBeenCalledWith('overlays', expect.any(MouseEvent));
  });
});
