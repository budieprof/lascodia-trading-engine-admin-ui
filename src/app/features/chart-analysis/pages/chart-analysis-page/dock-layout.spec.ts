import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_LAYOUT, DOCK_LAYOUT_KEY, clampSize, loadDockLayout, saveDockLayout } from './dock-layout';

describe('dock layout (Pine Editor docked / maximised / beside)', () => {
  afterEach(() => localStorage.removeItem(DOCK_LAYOUT_KEY));

  it('clamps a dragged size, the maximum winning when the window is too small for both', () => {
    expect(clampSize(50, 140, 600)).toBe(140);
    expect(clampSize(900, 140, 600)).toBe(600);
    expect(clampSize(320.6, 140, 600)).toBe(321);
    expect(clampSize(300, 360, 200)).toBe(200);
  });

  it('remembers the layout and reads it back', () => {
    saveDockLayout({ mode: 'side', height: 300, strip: 120, side: 700 });
    expect(loadDockLayout()).toEqual({ mode: 'side', height: 300, strip: 120, side: 700 });
  });

  it('falls back to defaults for a missing, malformed or partial layout', () => {
    expect(loadDockLayout()).toEqual(DEFAULT_DOCK_LAYOUT);
    localStorage.setItem(DOCK_LAYOUT_KEY, '{not json');
    expect(loadDockLayout()).toEqual(DEFAULT_DOCK_LAYOUT);
    localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify({ mode: 'sideways', height: -5, side: 'wide' }));
    expect(loadDockLayout()).toEqual(DEFAULT_DOCK_LAYOUT);
    localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify({ mode: 'max' }));
    expect(loadDockLayout()).toEqual({ ...DEFAULT_DOCK_LAYOUT, mode: 'max' });
  });
});
