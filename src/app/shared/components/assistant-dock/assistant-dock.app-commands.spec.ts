import { describe, expect, it } from 'vitest';
import type { Routes } from '@angular/router';
import { consolePages, isConsolePath } from './assistant-dock.component';

const config: Routes = [
  { path: 'login' },
  {
    path: '',
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      { path: 'dashboard', data: { breadcrumb: 'Dashboard' } },
      { path: 'monitors', data: { breadcrumb: 'Monitors' } },
      { path: 'positions' },
      { path: '**', redirectTo: 'dashboard' },
    ],
  },
];

describe('consolePages', () => {
  it('lists the pages under the authenticated shell, titled by their breadcrumb', () => {
    expect(consolePages(config)).toEqual([
      { path: '/dashboard', title: 'Dashboard' },
      { path: '/monitors', title: 'Monitors' },
      { path: '/positions', title: 'positions' },
    ]);
  });
});

describe('isConsolePath', () => {
  const pages = consolePages(config);

  it('accepts a page and anything beneath it, with a query or fragment', () => {
    expect(isConsolePath('/monitors', pages)).toBe(true);
    expect(isConsolePath('/monitors/646', pages)).toBe(true);
    expect(isConsolePath('/positions?status=Open', pages)).toBe(true);
    expect(isConsolePath('/dashboard#fleet', pages)).toBe(true);
  });

  it('refuses what is not a console page — including off-site and relative targets', () => {
    expect(isConsolePath('/login', pages)).toBe(false);
    expect(isConsolePath('/nowhere', pages)).toBe(false);
    expect(isConsolePath('monitors', pages)).toBe(false);
    expect(isConsolePath('//evil.example.com', pages)).toBe(false);
    expect(isConsolePath('https://evil.example.com', pages)).toBe(false);
  });
});
