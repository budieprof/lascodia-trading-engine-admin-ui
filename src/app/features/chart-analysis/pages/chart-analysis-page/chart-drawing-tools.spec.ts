import { describe, expect, it, vi } from 'vitest';

import { ChartDrawingTools } from './chart-drawing-tools';

// US02b: the drawing-tool state moved out of the page; these pin what the rail and the page's shortcuts rely on.

function setup(prefs: Record<string, unknown> = {}) {
  const written: Record<string, unknown> = {};
  const favorites = { toggle: vi.fn() };
  const tools = new ChartDrawingTools({
    readPref: <T>(key: string, fallback: T): T => (key in prefs ? (prefs[key] as T) : fallback),
    writePref: (key, value) => (written[key] = value),
    favorites,
  });
  return { tools, written, favorites };
}

describe('ChartDrawingTools', () => {
  it('starts from the stored preferences and re-reads them', () => {
    const prefs: Record<string, unknown> = { magnetStrength: 'strong' };
    const { tools } = setup(prefs);
    expect(tools.magnetStrength()).toBe('strong');
    expect(tools.stayInDrawing()).toBe(false);
    expect(tools.magnetMode()).toBe('off');
    prefs['stayInDrawing'] = true;
    tools.reloadPrefs();
    expect(tools.stayInDrawing()).toBe(true);
  });

  it('a strength from the magnet menu turns the magnet on and is remembered', () => {
    const { tools, written } = setup();
    tools.magnetMenuOpen.set(true);
    tools.setMagnetStrength('strong');
    expect(tools.magnetMode()).toBe('strong');
    expect(tools.magnetMenuOpen()).toBe(false);
    expect(written['magnetStrength']).toBe('strong');
    tools.toggleStayInDrawing();
    expect(written['stayInDrawing']).toBe(true);
  });

  it('a family’s pick arms the tool, becomes its button and closes the flyout', () => {
    const { tools } = setup();
    const group = tools.toolGroups().find((g) => g.tools.length > 1)!;
    const second = group.tools[1];
    tools.railFlyout.set(group.name);
    expect(tools.openRailGroup()?.name).toBe(group.name);
    tools.pickRailTool(group.name, second.kind);
    expect(tools.tool()).toBe(second.kind);
    expect(tools.railTool(group)).toBe(second);
    expect(tools.railGroupActive(group)).toBe(true);
    expect(tools.railFlyout()).toBeNull();
    tools.selectTool(second.kind); // the same tool again disarms it
    expect(tools.tool()).toBeNull();
  });

  it('starring a tool does not arm it', () => {
    const { tools, favorites } = setup();
    const ev = { stopPropagation: vi.fn() } as unknown as Event;
    tools.toggleFavoriteTool('trend-line', ev);
    expect(favorites.toggle).toHaveBeenCalledWith('trend-line');
    expect(tools.tool()).toBeNull();
  });
});
