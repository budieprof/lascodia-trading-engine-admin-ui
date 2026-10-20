import { HttpTransportType, type IHttpConnectionOptions } from '@microsoft/signalr';
import { firstValueFrom } from 'rxjs';

import type { AuthService } from '@core/auth/auth.service';

/** How to open one hub connection under the current auth mode. */
export interface HubConnectPlan {
  url: string;
  options: IHttpConnectionOptions;
  /**
   * Whether SignalR's own reconnect loop may be used. Not with a ticket: a ticket is single use, and
   * SignalR would re-present the spent one on every attempt — the services' outer restart loop builds
   * a new connection, with a new ticket, instead.
   */
  autoReconnect: boolean;
}

/**
 * - `bffAuth` on (contract C3.1): a single-use, 30-second ticket from `POST /bff/ws-ticket`, sent as
 *   `?ticket=` on a WebSockets-only connection with negotiation skipped — the ticket is spent by the
 *   first request that presents it, so there must be exactly one. Null when no ticket could be had
 *   (signed out, engine unreachable): the caller retries later.
 * - Legacy: unchanged — the bearer token (or a legacy cookie session's short-lived ticket) per
 *   attempt through `accessTokenFactory`.
 */
export async function hubConnectPlan(auth: AuthService, hubUrl: string): Promise<HubConnectPlan | null> {
  if (auth.mode === 'bff') {
    const ticket = await auth.realtimeTicket();
    if (!ticket) return null;
    const sep = hubUrl.includes('?') ? '&' : '?';
    return {
      url: `${hubUrl}${sep}ticket=${encodeURIComponent(ticket)}`,
      options: { skipNegotiation: true, transport: HttpTransportType.WebSockets },
      autoReconnect: false,
    };
  }
  return {
    url: hubUrl,
    options: { accessTokenFactory: () => legacyHubToken(auth) },
    autoReconnect: true,
  };
}

/**
 * A token for THIS attempt (legacy).
 *
 * <p>Cookie sessions carry a sentinel rather than a JWT and have to swap it for a short-lived
 * ticket; doing that once per <c>connect()</c> rather than once per attempt is what made a long
 * outage unrecoverable.</p>
 */
export async function legacyHubToken(auth: AuthService): Promise<string> {
  const token = auth.getToken();
  if (!token) return '';
  if (token !== 'cookie-session') return token;
  try {
    return (await firstValueFrom(auth.fetchWsTicket())) ?? '';
  } catch {
    // No ticket this time — the retry loop will ask again.
    return '';
  }
}
