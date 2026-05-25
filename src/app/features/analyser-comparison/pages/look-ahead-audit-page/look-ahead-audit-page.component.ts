import { Component, ChangeDetectionStrategy } from '@angular/core';

/**
 * Placeholder — replaced by the real audit runner in Phase 1e/3. Lazy-loaded
 * via the `/analyser-comparison/audit` route declared in the feature's
 * routes; the stub keeps the route registration valid until the real page
 * lands in the next commit.
 */
@Component({
  selector: 'app-look-ahead-audit-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template:
    '<div style="padding:1rem;opacity:.6">Look-ahead audit runner — coming in Phase 1e/3.</div>',
})
export class LookAheadAuditPageComponent {}
