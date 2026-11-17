import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

/** Route `data` flag: a fresh component instance for every distinct set of route params. */
export const REMOUNT_ON_PARAM_CHANGE = 'remountOnParamChange';

/**
 * Angular reuses a routed component when only its params change (`/orders/1` → `/orders/2`). A detail
 * page that reads its id from `route.snapshot` once then keeps showing — and acting on — the first
 * record while the URL names another (review 2026-11-17: Cancel/Modify hit the wrong order). Routes
 * flagged with {@link REMOUNT_ON_PARAM_CHANGE} get a new instance instead, so every piece of the old
 * record's state goes with it. Unflagged routes keep the default behaviour (charts, tabs in the path).
 */
@Injectable()
export class RemountOnParamChangeStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    if (future.routeConfig !== curr.routeConfig) return false;
    if (!future.routeConfig?.data?.[REMOUNT_ON_PARAM_CHANGE]) return true;
    return sameParams(future.params, curr.params);
  }
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
