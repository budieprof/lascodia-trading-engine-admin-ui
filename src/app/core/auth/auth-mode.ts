import type { RuntimeConfig } from '@core/config/runtime-config';

/**
 * How the console signs people in.
 *
 * - `legacy` — today's sign-in: the Admin / Operator forms post credentials to the engine and the
 *   returned JWT is kept in `sessionStorage` and sent as a bearer token.
 * - `bff` — sign-in goes through the engine's backend-for-frontend (`/bff/*`, ADR-0030 §3,
 *   contract C3.1): Keycloak, a server-side session and one HttpOnly cookie. The browser never
 *   holds a token.
 */
export type AuthMode = 'legacy' | 'bff';

/** Feature flag in `config.json` → `featureFlags.bffAuth`. */
export const BFF_AUTH_FLAG = 'bffAuth';

/**
 * Reads the mode from the runtime config. Only an explicit `true` or `{ "enabled": true }` turns the
 * BFF on — the flag decides how a person signs in, so it cannot depend on who they are: the role
 * and percent knobs other flags have are ignored here. Anything else (absent, false, malformed)
 * keeps today's sign-in.
 */
export function authModeFrom(config: Pick<RuntimeConfig, 'featureFlags'>): AuthMode {
  const rule = config.featureFlags?.[BFF_AUTH_FLAG];
  if (rule === true) return 'bff';
  if (rule && typeof rule === 'object' && (rule as { enabled?: unknown }).enabled === true) return 'bff';
  return 'legacy';
}
