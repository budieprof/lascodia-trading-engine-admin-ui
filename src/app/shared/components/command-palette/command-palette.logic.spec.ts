import { describe, expect, it } from 'vitest';

import { navIcon } from '../../../layout/sidebar/nav-icons';
import {
  groupCommands,
  highlightSegments,
  iconForRoute,
  queryTokens,
  rankCommands,
  routeTrail,
  type PaletteCommand,
} from './command-palette.logic';

const cmd = (group: string, label: string, route: string, keywords?: string): PaletteCommand => ({
  group,
  label,
  route,
  keywords,
});

describe('command palette logic', () => {
  it('ranks a page named by the query above one that only mentions it', () => {
    const pages = [
      cmd('Trading', 'Dashboard', '/dashboard', 'open positions equity'),
      cmd('Trading', 'Orders', '/orders'),
      cmd('Trading', 'Event Exposure', '/positions/event-exposure'),
      cmd('Trading', 'Positions', '/positions'),
      cmd('Trading', 'Position Deltas', '/positions/deltas'),
    ];
    expect(rankCommands(pages, queryTokens('pos')).map((c) => c.label)).toEqual([
      'Positions',
      'Position Deltas',
      'Event Exposure',
      'Dashboard',
    ]);
  });

  it('needs every word of the query to match', () => {
    const pages = [cmd('ML', 'Model Registry', '/ml'), cmd('ML', 'Model Drift', '/ml/drift')];
    expect(rankCommands(pages, queryTokens('model drift')).map((c) => c.label)).toEqual([
      'Model Drift',
    ]);
  });

  it('groups rows under headings in first-seen order, with flat start indexes', () => {
    const sections = groupCommands([
      cmd('A', 'a1', '/a1'),
      cmd('B', 'b1', '/b1'),
      cmd('A', 'a2', '/a2'),
    ]);
    expect(sections.map((s) => [s.group, s.start, s.items.map((i) => i.label)])).toEqual([
      ['A', 0, ['a1', 'a2']],
      ['B', 2, ['b1']],
    ]);
  });

  it('marks every occurrence of every query word, case-insensitively', () => {
    expect(highlightSegments('Position Deltas', ['pos', 'del'])).toEqual([
      { text: 'Pos', hit: true },
      { text: 'ition ', hit: false },
      { text: 'Del', hit: true },
      { text: 'tas', hit: false },
    ]);
    expect(highlightSegments('Orders', [])).toEqual([{ text: 'Orders', hit: false }]);
  });

  it("draws a page with the sidebar's icon, and a detail page with its parent's", () => {
    expect(iconForRoute('/dashboard')).toBe(navIcon.LayoutDashboard);
    expect(iconForRoute('/orders/42?tab=fills')).toBe(iconForRoute('/orders'));
    expect(iconForRoute('/no-such-page')).toBe(navIcon.FileText);
  });

  it('reads a route as a trail', () => {
    expect(routeTrail('/positions/event-exposure')).toBe('positions › event exposure');
  });
});
