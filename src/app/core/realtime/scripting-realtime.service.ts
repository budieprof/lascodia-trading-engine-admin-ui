import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { Observable, Subject, filter, firstValueFrom, share } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { ScriptSessionFrame, ScriptSessionSubscription } from '@core/api/scripting.types';
import { backoffMs } from './realtime.service';

/** The event the scripting hub pushes (SS-I3): a warm chart session's changes, at most one a second per session. */
export const SCRIPT_FRAME_EVENT = 'scriptFrame';

/**
 * The console's connection to the engine's SCRIPTING hub (`/api/hubs/scripting`, scripting API §3c) — separate from the
 * trading hub (`RealtimeService`, `/api/hubs/trading`) because the engine may serve `scripting/*` from another process
 * (SS-I4): a warm chart session lives in the process that ran it, and its frames come from there.
 *
 * <p>Lazy: nothing connects until a session is subscribed, and the connection is let go when the last one leaves.
 * Subscriptions are standing — re-issued on every (re)connect — and `reconnected$` tells subscribers to resync
 * (`GET scripting/sessions/{id}/frame?sinceSeq=`): frames pushed while the connection was down are not replayed.</p>
 */
@Injectable({ providedIn: 'root' })
export class ScriptingRealtimeService {
  private readonly auth = inject(AuthService);
  private readonly runtime = inject(RUNTIME_CONFIG);

  private connection: HubConnection | null = null;
  private starting: Promise<void> | null = null;
  private readonly frames = new Subject<ScriptSessionFrame>();
  private readonly reconnects = new Subject<void>();
  private readonly standing = new Set<string>();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  /** Until when warm sessions are not worth asking for: the hub could not be reached (client ms). */
  private unusableUntil = 0;

  /** How long a hub that could not be reached is left alone before warm sessions are asked for again. */
  static readonly RETRY_AFTER_MS = 5 * 60_000;

  readonly state = signal<HubConnectionState>(HubConnectionState.Disconnected);
  readonly isConnected = computed(() => this.state() === HubConnectionState.Connected);

  /** Every frame of every subscribed session. */
  readonly frames$: Observable<ScriptSessionFrame> = this.frames.pipe(share());
  /** The connection came back: frames may have been missed — resync every session. */
  readonly reconnected$: Observable<void> = this.reconnects.pipe(share());

  constructor() {
    inject(DestroyRef).onDestroy(() => void this.stop());
  }

  /**
   * Whether a run should ask the engine to keep it warm: false for a while after the hub could not be reached (a
   * session nobody can follow is engine memory for nothing — the chart then re-runs per tick as before).
   */
  usable(): boolean {
    return Date.now() >= this.unusableUntil;
  }

  /** Frames of one session. */
  framesOf(sessionId: string): Observable<ScriptSessionFrame> {
    return this.frames$.pipe(filter((f) => f.sessionId === sessionId));
  }

  /**
   * Joins `script:{sessionId}` now (connecting first) and on every later connection. Resolves with where the session
   * stands, or null when the engine does not know it (ended, another process, not connected yet — the standing join
   * is retried on connect).
   */
  async subscribe(sessionId: string): Promise<ScriptSessionSubscription | null> {
    this.standing.add(sessionId);
    await this.ensureConnected();
    return this.invoke<ScriptSessionSubscription | null>('SubscribeScriptSession', sessionId);
  }

  /** Leaves the room and stops re-joining it; the last one out closes the connection. */
  async unsubscribe(sessionId: string): Promise<void> {
    if (!this.standing.delete(sessionId)) return;
    await this.invoke('UnsubscribeScriptSession', sessionId);
    if (this.standing.size === 0) await this.stop();
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection && this.connection.state === HubConnectionState.Connected) return;
    this.starting ??= this.start().finally(() => (this.starting = null));
    await this.starting;
  }

  private async start(): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) return;
    const base = this.runtime.apiBaseUrl.replace(/\/$/, '');
    const connection = new HubConnectionBuilder()
      .withUrl(`${base}/api/hubs/scripting`, { accessTokenFactory: () => this.freshToken() })
      .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => backoffMs(ctx.previousRetryCount) })
      .configureLogging(LogLevel.Warning)
      .build();
    connection.on(SCRIPT_FRAME_EVENT, (payload: unknown) => {
      if (isFrame(payload)) this.frames.next(payload);
    });
    connection.onreconnecting(() => this.state.set(HubConnectionState.Reconnecting));
    connection.onreconnected(() => {
      this.state.set(HubConnectionState.Connected);
      void this.rejoin().then(() => this.reconnects.next());
    });
    connection.onclose(() => {
      this.state.set(HubConnectionState.Disconnected);
      this.scheduleRestart();
    });
    this.connection = connection;
    try {
      await connection.start();
      this.state.set(connection.state);
      this.restartAttempt = 0;
      this.unusableUntil = 0;
      await this.rejoin();
    } catch {
      this.state.set(HubConnectionState.Disconnected);
      this.unusableUntil = Date.now() + ScriptingRealtimeService.RETRY_AFTER_MS;
      this.scheduleRestart();
    }
  }

  /** Only while someone is subscribed: a page without warm sessions holds no connection. */
  private scheduleRestart(): void {
    if (this.restartTimer !== null || this.standing.size === 0 || !this.auth.isAuthenticated()) return;
    this.state.set(HubConnectionState.Reconnecting);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.connection = null;
      void this.start().then(() => {
        if (this.isConnected()) this.reconnects.next();
      });
    }, backoffMs(this.restartAttempt++));
  }

  private async rejoin(): Promise<void> {
    for (const id of [...this.standing]) await this.invoke('SubscribeScriptSession', id);
  }

  private async stop(): Promise<void> {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const c = this.connection;
    this.connection = null;
    this.state.set(HubConnectionState.Disconnected);
    if (c) {
      try {
        await c.stop();
      } catch {
        /* best effort */
      }
    }
  }

  private async invoke<T = void>(method: string, ...args: unknown[]): Promise<T | null> {
    const c = this.connection;
    if (!c || c.state !== HubConnectionState.Connected) return null;
    try {
      return ((await c.invoke(method, ...args)) as T) ?? null;
    } catch {
      return null;
    }
  }

  /** As the trading hub does it: a cookie session swaps its sentinel for a short-lived ticket per attempt. */
  private async freshToken(): Promise<string> {
    const token = this.auth.getToken();
    if (!token) return '';
    if (token !== 'cookie-session') return token;
    try {
      return (await firstValueFrom(this.auth.fetchWsTicket())) ?? '';
    } catch {
      return '';
    }
  }
}

function isFrame(p: unknown): p is ScriptSessionFrame {
  const f = p as Partial<ScriptSessionFrame> | null;
  return !!f && typeof f.sessionId === 'string' && typeof f.seq === 'number';
}
