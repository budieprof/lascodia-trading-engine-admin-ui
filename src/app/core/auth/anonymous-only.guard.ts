import { inject } from '@angular/core';
import type { CanMatchFn } from '@angular/router';

import { AuthService } from './auth.service';

/**
 * Matches only for a visitor who is not signed in. The public landing page uses it at `/`: a visitor sees the
 * landing page, a signed-in person falls through to the console (and its redirect to the dashboard) exactly as
 * before. A match failure is not a redirect, so the console's own guards still decide everything after.
 */
export const anonymousOnlyGuard: CanMatchFn = () => !inject(AuthService).isAuthenticated();
