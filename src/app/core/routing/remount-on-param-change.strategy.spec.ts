import { describe, expect, it } from 'vitest';
import { ActivatedRouteSnapshot, Route } from '@angular/router';
import {
  RemountOnParamChangeStrategy,
  REMOUNT_ON_PARAM_CHANGE,
} from './remount-on-param-change.strategy';

function snap(routeConfig: Route | null, params: Record<string, string>): ActivatedRouteSnapshot {
  return { routeConfig, params } as unknown as ActivatedRouteSnapshot;
}

describe('RemountOnParamChangeStrategy', () => {
  const s = new RemountOnParamChangeStrategy();
  const flagged: Route = { path: ':id', data: { [REMOUNT_ON_PARAM_CHANGE]: true } };
  const plain: Route = { path: ':symbol' };

  it('remounts a flagged route when its id changes', () => {
    expect(s.shouldReuseRoute(snap(flagged, { id: '2' }), snap(flagged, { id: '1' }))).toBe(false);
  });

  it('reuses a flagged route when the params are the same', () => {
    expect(s.shouldReuseRoute(snap(flagged, { id: '1' }), snap(flagged, { id: '1' }))).toBe(true);
  });

  it('keeps the default reuse for unflagged routes', () => {
    expect(
      s.shouldReuseRoute(snap(plain, { symbol: 'GBPUSD' }), snap(plain, { symbol: 'EURUSD' })),
    ).toBe(true);
  });

  it('never reuses across different route configs', () => {
    expect(s.shouldReuseRoute(snap(flagged, { id: '1' }), snap(plain, { id: '1' }))).toBe(false);
  });
});
