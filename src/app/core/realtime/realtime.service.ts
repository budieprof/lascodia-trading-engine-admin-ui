import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { Observable, Subject, filter, map, share, takeUntil } from 'rxjs';

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
] as const;
export type RealtimeEventName = (typeof REALTIME_EVENTS)[number];

export interface RealtimeMessage<T = unknown> {
  name: RealtimeEventName;
  payload: T;
  receivedAt: number;
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

  constructor() {
    // When the auth token disappears (logout/idle-timeout) we tear the
    // connection down — otherwise SignalR would keep reconnecting against
    // a server that no longer trusts us and the engine would refuse the
    // upgrade with a 401 loop.
    this.destroyRef.onDestroy(() => this.disconnect());
  }

  /**
   * Connect if the user is authenticated. Idempotent — calling while already
   * connected (or connecting) resolves immediately. Safe to call from
   * multiple features; the shared singleton dedupes.
   */
  async connect(): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) return;

    const token = this.auth.getToken();
    if (!token) return;

    const base = this.runtime.apiBaseUrl.replace(/\/$/, '');
    const url = `${base}/api/hubs/trading`;

    const connection = new HubConnectionBuilder()
      .withUrl(url, { accessTokenFactory: () => token })
      .withAutomaticReconnect()
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
    connection.onreconnected(() => this.state.set(HubConnectionState.Connected));
    connection.onclose(() => this.state.set(HubConnectionState.Disconnected));

    this.connection = connection;
    try {
      await connection.start();
      this.state.set(connection.state);
    } catch {
      // Let `withAutomaticReconnect` handle transient failures. Persistent
      // failures surface via the state signal — the UI can show a banner.
      this.state.set(HubConnectionState.Disconnected);
    }
  }

  async disconnect(): Promise<void> {
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
}
