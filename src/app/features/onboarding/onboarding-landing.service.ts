import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, firstValueFrom, take } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { OnboardingApiService } from './onboarding-api.service';

/** Where a sign-in lands when nothing else was asked for. */
const DEFAULT_LANDINGS = new Set(['/', '/dashboard']);

/**
 * After sign-in, a new self-served organisation with onboarding steps left opens its checklist instead of the
 * dashboard (engine multi-tenancy Phase 7, LC.1, `GET /tenant/onboarding` → `landOnSignIn`). Once per console
 * load, only from the default landing (a person who followed a link to a page stays there), and never in the
 * way: any failure leaves the person where they are.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingLandingService {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly api = inject(OnboardingApiService);
  private checked = false;

  async maybeLand(): Promise<boolean> {
    if (this.checked) return false;
    this.checked = true;
    if (!this.auth.isAuthenticated() || !this.auth.hasPermission(Permission.TenantUsageRead))
      return false;

    if (!this.router.navigated) {
      await firstValueFrom(
        this.router.events.pipe(
          filter((e) => e instanceof NavigationEnd),
          take(1),
        ),
      );
    }
    if (!DEFAULT_LANDINGS.has(this.router.url.split(/[?#]/)[0])) return false;
    try {
      const checklist = await firstValueFrom(this.api.onboarding());
      if (!checklist.landOnSignIn || !DEFAULT_LANDINGS.has(this.router.url.split(/[?#]/)[0]))
        return false;
      return await this.router.navigateByUrl('/onboarding');
    } catch {
      return false;
    }
  }
}
