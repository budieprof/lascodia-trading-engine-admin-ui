import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { Observable, Subject, filter, firstValueFrom, map, share, takeUntil } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

// Canonical event-name table. These match the method names the engine-side
// relay handlers push (see `RealtimeRelayHandlers.cs` in the API project).
// Anything else is dropped so malformed payloads don't reach the UI.
export const REALTIME_EVENTS = [
  'orderCreated',
  'orderFilled',
  'positionOpened',
  'positionClosed',
  'tradeSignalCreated',
  'mlModelActivated',
  'vaRBreach',
  'emergencyFlatten',
  'optimizationCompleted',
  'backtestCompleted',
  'sentimentSnapshotCreated',
  'auditDecisionLogged',
  'strategyActivated',
  'strategyHealthSnapshotCreated',
  'strategyAllocationRebalanced',
  'strategyCapacityProfileUpdated',
  'strategyVariantPromoted',
  'optimizationApproved',
  // ── Emitted by the engine all along, but absent from this allowlist until
  //    2026-09-09 — and the allowlist is what `connection.on(...)` is built
  //    from, so every one of these was pushed by the engine and dropped on the
  //    floor by the client. Verified against the `NotifyAsync` call sites in
  //    the API project. ──
  'strategyUpdated',
  'strategyRetired',
  'mlModelRetired',
  'mlDriftRecoveryTriggered',
  'compositeMLCatalogueDriftDropAlert',
  'lifecycleRationaleEmitted',
  'promotionReviewCompleted',
  'governanceDwellAlarm',
  'reflectionEntryResolved',
  'spotSweepProgress',
  'patientTraderChanged',
  // ── Position lifecycle (PRD-V2 FR-5.8) ──
  // Pushed directly by the 5 position-management command handlers
  // (Open / Close / ReceivePositionDelta / ReceivePositionSnapshot /
  // OrderFilledEventHandler) after their SaveChanges. Bypasses the
  // integration-event bus because this is admin-UI telemetry rather
  // than a cross-instance domain event.
  'positionLifecycleEvent',
  // ── Presence (hub-invoked, not bus-relayed) ──
  'presenceJoined',
  'presenceLeft',
  // ── Notification bell (NotificationDispatcherWorker tickles every client
  //    when the unified feed's source-table max-timestamp advances) ──
  'notificationsChanged',
  // ── Conversations chat page (analysis command handlers + follow-up turn
  //    writers + AnalysisMonitorWorker push a { llmInvocationId } tickle when a
  //    conversation is created or its thread changes — see
  //    AnalysisChatRealtimeBroadcaster). Drives live left-rail + chat thread. ──
  'analysisConversationChanged',
  // ── Analysis-monitor lifecycle (AnalysisMonitorWorker). `Fired` carries the
  //    verdict + any generated signal ids and is what the chat strip renders as a
  //    turn; `Changed` is the broader tickle covering EVERY transition — expiry,
  //    invalidation, error escalation, forced fire — which previously happened
  //    with no outward sign at all. Drives the /analysis-monitors cockpit. ──
  'analysisMonitorFired',
  'analysisMonitorInvalidated',
  'analysisMonitorChanged',
  // A fire nobody acknowledged in time. Without this in the allowlist the client
  // silently drops it, which is the one event where silence is the failure.
  'analysisMonitorEscalated',
  // ── Live price stream, room-scoped to `price:{SYMBOL}` (PriceUpdatedRealtimeRelay,
  //    throttled ~1 Hz). Only reaches clients that called SubscribePrice — used by
  //    the spot-rec chart's live-price marker. ──
  'priceUpdated',
] as const;
export type RealtimeEventName = (typeof REALTIME_EVENTS)[number];

export interface RealtimeMessage<T = unknown> {
  name: RealtimeEventName;
  payload: T;
  receivedAt: number;
}

/** Longest gap between reconnection attempts. */
export const MAX_RETRY_MS = 30_000;

/**
 * How long to wait before attempt number `attempt` (0-based).
 *
 * <p>Exponential to 30s and then flat — it never returns null, which is how SignalR is told to
 * stop. The default policy stops after four tries, and a console that gives up after 42 seconds is
 * a console that is offline every time the operator was away from their desk.</p>
 *
 * <p>Jittered so that a fleet of tabs reconnecting after an engine redeploy arrives spread out
 * rather than as one synchronised burst against a server that has just started.</p>
 */
export function backoffMs(attempt: number): number {
  const base = Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(attempt, 5));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * Owns the single SignalR connection to `/api/hubs/trading` for the whole
 * tab. Consumer services subscribe to `events$` and filter by name; the
 * connection is lazy-started on the first subscription and kept alive until
 * the authoritative auth token goes away.
 *
 * JWT is passed via the query-string `access_token` because browsers can't
 * send `Authorization` headers on WebSocket upgrades — the engine's
 * `OnMessageReceived` hook only honours that on `/api/hubs` paths (E1 in
 * DESIGN_DOCS.md).
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly runtime = inject(RUNTIME_CONFIG);

  private connection: HubConnection | null = null;
  private readonly messages = new Subject<RealtimeMessage>();
  private readonly stop = new Subject<void>();

  readonly events$: Observable<RealtimeMessage> = this.messages.pipe(share());

  /** Current connection state, mirrored into a signal for UI status badges. */
  readonly state = signal<HubConnectionState>(HubConnectionState.Disconnected);
  readonly isConnected = computed(() => this.state() === HubConnectionState.Connected);

  /** Pending restart, so the outer retry loop never stacks two timers. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** How many times the OUTER loop has retried; reset on every successful connect. */
  private restartAttempt = 0;

  /** True only when the operator signed out or the app is being torn down. */
  private manualStop = false;

  constructor() {
    // When the auth token disappears (logout/idle-timeout) we tear the
    // connection down — otherwise SignalR would keep reconnecting against
    // a server that no longer trusts us and the engine would refuse the
    // upgrade with a 401 loop.
    this.destroyRef.onDestroy(() => this.disconnect());

    // A dropped connection usually outlives its cause: the laptop wakes, the wifi returns, the
    // operator comes back to the tab. Waiting out a 30s backoff in those moments is needless —
    // the console should be live by the time they have finished looking at it.
    if (typeof window !== 'undefined') {
      const wake = () => this.retryNow();
      window.addEventListener('online', wake);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') wake();
      });
      this.destroyRef.onDestroy(() => window.removeEventListener('online', wake));
    }
  }

  /**
   * Connect if the user is authenticated. Idempotent — calling while already
   * connected (or connecting) resolves immediately. Safe to call from
   * multiple features; the shared singleton dedupes.
   */
  async connect(): Promise<void> {
    this.manualStop = false;
    if (!this.auth.isAuthenticated()) return;
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) return;

    // Cookie-backed sessions store a sentinel in `_token` — we have no real
    // JWT here, so swap the cookie for a short-lived ticket on each
    // (re)connect. Legacy bearer-token sessions return the real token and
    // skip the round trip.
    const token = await this.freshToken();
    if (!token) return;

    const base = this.runtime.apiBaseUrl.replace(/\/$/, '');
    const url = `${base}/api/hubs/trading`;

    const connection = new HubConnectionBuilder()
      // Per ATTEMPT, not per connect. A cookie session's ticket is short-lived by design, and
      // closing over one meant every reconnect after it expired re-presented the same dead
      // ticket and was refused — so a connection that dropped after the ticket aged out could
      // never come back, however many times it tried.
      .withUrl(url, { accessTokenFactory: () => this.freshToken() })
      // The DEFAULT policy gives up after four attempts (0s, 2s, 10s, 30s) and closes for good.
      // A trading console is meant to stay connected: a laptop that sleeps through lunch, or an
      // engine redeployed while the tab is open, both outlast 42 seconds, and what the operator
      // gets is a stale page wearing an "offline" banner that never clears.
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) => backoffMs(ctx.previousRetryCount),
      })
      .configureLogging(LogLevel.Warning)
      .build();

    // Register a handler per canonical event name. SignalR dispatches by
    // method name; anything the server sends outside this list never reaches
    // the UI stream.
    for (const name of REALTIME_EVENTS) {
      connection.on(name, (payload: unknown) => {
        this.messages.next({ name, payload, receivedAt: Date.now() });
      });
    }

    connection.onreconnecting(() => this.state.set(HubConnectionState.Reconnecting));
    connection.onreconnected(() => {
      this.state.set(HubConnectionState.Connected);
      // The hub drops a connection's groups when it drops the connection, so a
      // reconnect starts in no rooms at all. Without this the page stays on
      // screen looking live and silently receives nothing ever again.
      void this.replayStanding();
    });
    // SignalR's own retry loop can still end — a close during the handshake, or a server that
    // refuses outright, closes without ever entering Reconnecting. This is the outer loop that
    // makes "connected" the steady state rather than a phase the page passes through once.
    connection.onclose(() => {
      this.state.set(HubConnectionState.Disconnected);
      this.scheduleRestart();
    });

    this.connection = connection;
    try {
      await connection.start();
      this.state.set(connection.state);
      this.restartAttempt = 0;
      await this.replayStanding();
    } catch {
      // A failed FIRST start never reaches withAutomaticReconnect — that only covers a
      // connection that was established and then lost. Without its own retry, opening the
      // console a moment before the engine is ready left it offline until a manual reload.
      this.state.set(HubConnectionState.Disconnected);
      this.scheduleRestart();
    }
  }

  /**
   * A token for THIS attempt.
   *
   * <p>Cookie sessions carry a sentinel rather than a JWT and have to swap it for a short-lived
   * ticket; doing that once per <c>connect()</c> rather than once per attempt is what made a long
   * outage unrecoverable.</p>
   */
  private async freshToken(): Promise<string> {
    const token = this.auth.getToken();
    if (!token) return '';
    if (token !== 'cookie-session') return token;
    try {
      return (await firstValueFrom(this.auth.fetchWsTicket())) ?? '';
    } catch {
      // No ticket this time — the retry loop will ask again.
      return '';
    }
  }

  /**
   * Try again later, for as long as the operator is signed in.
   *
   * <p>Never gives up on its own. The only things that stop it are signing out and the service
   * being destroyed, both of which set {@link manualStop} — an idle console must be reconnected
   * when the operator comes back to it, not waiting to be reloaded.</p>
   */
  private scheduleRestart(): void {
    if (this.manualStop || this.reconnectTimer !== null) return;
    if (!this.auth.isAuthenticated()) return;

    // Reconnecting, not Disconnected: a retry is scheduled, so the console should say it is
    // coming back rather than that it has stopped. "Offline" is reserved for a connection with
    // nothing behind it — which, now, only means signed out. The operator read the old wording
    // as final, and under the four-attempt default policy it was.
    this.state.set(HubConnectionState.Reconnecting);

    const delay = backoffMs(this.restartAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Drop the dead instance so `connect()` builds a new one rather than seeing a stale
      // non-Disconnected state and returning immediately.
      this.connection = null;
      void this.connect();
    }, delay);
  }

  /** Come back immediately when the machine does, instead of waiting out the backoff. */
  private retryNow(): void {
    if (this.manualStop || this.isConnected()) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.restartAttempt = 0;
    this.connection = null;
    void this.connect();
  }

  async disconnect(): Promise<void> {
    // Signing out is the one close that must NOT be retried: the server no longer trusts this
    // session, and an outer loop would sit there being refused.
    this.manualStop = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.restartAttempt = 0;
    this.stop.next();
    if (this.connection) {
      try {
        await this.connection.stop();
      } catch {
        /* best-effort */
      }
      this.connection = null;
    }
    this.state.set(HubConnectionState.Disconnected);
  }

  /**
   * Room joins that must survive a slow start and a reconnect.
   *
   * <p>`invoke` is a soft no-op while the connection is not yet up, which is correct for presence
   * but silently wrong for a subscription: the caller believes it is in the room and waits forever
   * for events the server was never asked to send. On localhost the hub is connected within
   * milliseconds so the join always landed; through the Cloudflare tunnel the negotiate, upgrade
   * and auth take long enough that the chart's `SubscribePrice` ran FIRST and did nothing — the
   * page then sat there live-looking and price-less, which is exactly how it was reported.</p>
   *
   * <p>Keyed by room so a repeated join is idempotent and a leave can remove it.</p>
   */
  private readonly standing = new Map<string, { method: string; args: unknown[] }>();

  /**
   * Join a hub room now if possible, and again on every future connection.
   *
   * <p>Records the intent first, so a join issued before the connection is up is applied the
   * moment it comes up rather than dropped.</p>
   */
  async join(room: string, method: string, ...args: unknown[]): Promise<void> {
    this.standing.set(room, { method, args });
    await this.invoke(method, ...args);
  }

  /** Leave a room and stop re-applying it. */
  async leave(room: string, method: string, ...args: unknown[]): Promise<void> {
    this.standing.delete(room);
    await this.invoke(method, ...args);
  }

  /** Re-issue every standing join. Best-effort: one bad room must not cost the others. */
  private async replayStanding(): Promise<void> {
    for (const { method, args } of [...this.standing.values()]) {
      await this.invoke(method, ...args);
    }
  }

  /**
   * Typed subscription for a single event name. Emits payloads only; callers
   * that care about message metadata can use `events$` directly.
   */
  on<T = unknown>(name: RealtimeEventName): Observable<T> {
    return this.events$.pipe(
      takeUntil(this.stop),
      filter((m): m is RealtimeMessage<T> => m.name === name),
      map((m) => m.payload),
    );
  }

  /**
   * Invoke a hub method by name. Used by `PresenceService` for
   * `EnterRoom` / `LeaveRoom`; quietly resolves to `undefined` when the
   * connection is down so callers don't have to guard state externally.
   */
  async invoke<TResult = void>(
    methodName: string,
    ...args: unknown[]
  ): Promise<TResult | undefined> {
    if (!this.connection || this.connection.state !== HubConnectionState.Connected) {
      return undefined;
    }
    try {
      return (await this.connection.invoke(methodName, ...args)) as TResult;
    } catch {
      // Swallow — presence failures must not crash the page. The caller
      // treats these as soft no-ops.
      return undefined;
    }
  }
}
