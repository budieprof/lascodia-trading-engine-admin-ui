import { inject, isDevMode } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';

import { FeatureFlagsService } from './feature-flags.service';

/**
 * Guards a page that is on in development builds (`ng serve`, specs) and, in a release, only for
 * whoever its runtime feature flag admits — `config.json` → `featureFlags[name]`, e.g.
 * `{ "enabled": true, "roles": ["Admin"] }`. Anyone else lands on the dashboard.
 */
export function devModeOrFeatureFlag(name: string): CanActivateFn {
  return () => {
    if (isDevMode() || inject(FeatureFlagsService).isOn(name)) return true;
    return inject(Router).createUrlTree(['/dashboard']);
  };
}
