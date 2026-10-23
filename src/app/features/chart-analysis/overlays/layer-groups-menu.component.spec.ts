import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { LayerGroupsMenuComponent } from './layer-groups-menu.component';
import type { LayerGroupsState } from './layer-groups';

// The JIT runner cannot set signal inputs, so these drive the component at its default groups and read its output.
function render() {
  const fixture = TestBed.createComponent(LayerGroupsMenuComponent);
  const seen: LayerGroupsState[] = [];
  fixture.componentInstance.groupsChange.subscribe((s) => seen.push(s));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, seen };
}

describe('LayerGroupsMenuComponent (PR-5)', () => {
  it('lists the five groups with their opacity', () => {
    const { el } = render();
    const rows = [...el.querySelectorAll('.lg-row')];
    expect(rows.map((r) => r.querySelector('.lg-toggle')!.textContent!.trim())).toEqual([
      '✓ Structure',
      '✓ Profiles',
      '✓ Order flow',
      '✓ Events',
      '✓ Trades',
    ]);
    expect(el.querySelector('[data-testid="layer-group-flow"]')!.getAttribute('aria-checked')).toBe('true');
    expect(rows[2].querySelector('.lg-value')!.textContent).toBe('100%');
  });

  it('hides a group on a click, and fades one with its slider', () => {
    const { el, seen } = render();
    (el.querySelector('[data-testid="layer-group-events"]') as HTMLButtonElement).click();
    expect(seen.at(-1)!.events.visible).toBe(false);
    const slider = el.querySelector('[data-testid="layer-opacity-profiles"]') as HTMLInputElement;
    slider.value = '0.45';
    slider.dispatchEvent(new Event('input'));
    expect(seen.at(-1)!.profiles.opacity).toBe(0.45);
  });
});
