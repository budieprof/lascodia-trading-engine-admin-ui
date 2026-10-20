import { HttpContextToken } from '@angular/common/http';

/**
 * Set on requests whose 401 is an answer, not a dead session — the boot-time `GET /bff/session`
 * probe (401 = nobody signed in) and the sign-out call. The error interceptor leaves them alone.
 */
export const SKIP_SESSION_HANDLING = new HttpContextToken<boolean>(() => false);

/** Marks the one retry of a request the engine refused for a stale CSRF token. */
export const CSRF_RETRIED = new HttpContextToken<boolean>(() => false);

/** Marks a request replayed after a step-up sign-in, so a second challenge does not loop. */
export const STEP_UP_REPLAY = new HttpContextToken<boolean>(() => false);
