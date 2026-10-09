import { Injectable, inject, signal } from '@angular/core';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import type { AlertFiredPayload } from '@core/api/alerts.types';
import { RealtimeService } from '@core/realtime/realtime.service';

/** One alert pop-up on screen. */
export interface AlertPopup {
  key: string;
  payload: AlertFiredPayload;
  /** Where "Open" goes; null for a channel test. */
  link: { route: unknown[]; params: Record<string, string> } | null;
  receivedAt: number;
}

/** Most pop-ups on screen at once (the oldest goes first). */
export const MAX_POPUPS = 5;
/** How long a pop-up stays up unless dismissed. */
export const POPUP_MS = 20_000;

const SOUND_KEY = 'lascodia.alerts.sound';
const BROWSER_KEY = 'lascodia.alerts.browserNotifications';

/**
 * In-app alert delivery on the page (contract C2): every `alertFired` push becomes a pop-up, with an optional sound and
 * an opt-in browser notification — both remembered per browser. The push is a broadcast with no operator identity, so a
 * chart alert is shown only after `GET chart-alert/{id}` (owner-scoped) confirms it is this operator's, and a saved
 * screen's alert only after `GET scripting/screens/{id}` (owner-scoped) does; script alerts and channel tests are
 * everyone's.
 */
@Injectable({ providedIn: 'root' })
export class AlertPopupsService {
  private readonly realtime = inject(RealtimeService);
  private readonly api = inject(ApiService);

  readonly popups = signal<AlertPopup[]>([]);
  readonly soundOn = signal(readFlag(SOUND_KEY, true));
  readonly browserOn = signal(
    readFlag(BROWSER_KEY, false) && notificationPermission() === 'granted',
  );
  /** Why browser notifications could not be switched on, if they could not. */
  readonly browserProblem = signal<string | null>(null);

  private started = false;
  private seq = 0;

  /** Starts listening (idempotent; the notification bell calls it). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.realtime.on<AlertFiredPayload>('alertFired').subscribe((p) => this.receive(p));
  }

  /** Handles one push: chart and screen alerts only when they are this operator's. */
  receive(payload: AlertFiredPayload | null | undefined): void {
    if (!payload || typeof payload.title !== 'string') return;
    const ownerCheck = AlertPopupsService.ownerCheckPath(payload);
    if (ownerCheck) {
      this.api.get<ResponseData<unknown>>(ownerCheck, { silent: true }).subscribe({
        next: (res) => {
          if (res?.status) this.show(payload);
        },
        error: () => undefined,
      });
      return;
    }
    this.show(payload);
  }

  dismiss(key: string): void {
    this.popups.update((list) => list.filter((p) => p.key !== key));
  }

  setSound(on: boolean): void {
    this.soundOn.set(on);
    writeFlag(SOUND_KEY, on);
    if (on) this.playSound();
  }

  /** Switches browser notifications on (asking the browser's permission) or off. */
  async setBrowser(on: boolean): Promise<void> {
    this.browserProblem.set(null);
    if (!on) {
      this.browserOn.set(false);
      writeFlag(BROWSER_KEY, false);
      return;
    }
    if (typeof Notification === 'undefined') {
      this.browserProblem.set('This browser does not support notifications.');
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = 'denied';
      }
    }
    if (permission !== 'granted') {
      this.browserProblem.set(
        'The browser blocked notifications for this site — allow them in its site settings.',
      );
      this.browserOn.set(false);
      writeFlag(BROWSER_KEY, false);
      return;
    }
    this.browserOn.set(true);
    writeFlag(BROWSER_KEY, true);
  }

  /** The owner-scoped read that confirms an alert is this operator's; null when it is everyone's. */
  static ownerCheckPath(p: AlertFiredPayload): string | null {
    if (p.source === 'price' || p.source === 'drawing') return `/chart-alert/${p.alertId}`;
    if (p.source === 'screen') return `/scripting/screens/${p.alertId}`;
    return null;
  }

  /** Where a fired alert's "Open" goes. */
  static linkFor(p: AlertFiredPayload): AlertPopup['link'] {
    if (p.source === 'price' || p.source === 'drawing') {
      const params: Record<string, string> = { alert: String(p.alertId) };
      if (p.timeframe) params['tf'] = p.timeframe;
      return { route: ['/chart-analysis', p.symbol], params };
    }
    if (p.source === 'script' && p.strategyId)
      return { route: ['/strategies', p.strategyId], params: {} };
    if (p.source === 'screen' && p.alertId)
      return { route: ['/pine-screener'], params: { screen: String(p.alertId) } };
    return null;
  }

  private show(payload: AlertFiredPayload): void {
    const key = `${payload.source}:${payload.fireId ?? payload.alertId}:${payload.firedAtUtc}:${this.seq++}`;
    const popup: AlertPopup = {
      key,
      payload,
      link: AlertPopupsService.linkFor(payload),
      receivedAt: Date.now(),
    };
    this.popups.update((list) => [popup, ...list].slice(0, MAX_POPUPS));
    setTimeout(() => this.dismiss(key), POPUP_MS);
    if (this.soundOn()) this.playSound();
    if (this.browserOn()) this.notifyBrowser(payload);
  }

  private notifyBrowser(p: AlertFiredPayload): void {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      new Notification(p.title, {
        body: p.message,
        tag: `lascodia-alert-${p.source}-${p.alertId}`,
      });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }

  /** A short two-tone chime (Web Audio — nothing to download). */
  private playSound(): void {
    try {
      const Ctx =
        (
          window as unknown as {
            AudioContext?: typeof AudioContext;
            webkitAudioContext?: typeof AudioContext;
          }
        ).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const t = ctx.currentTime;
      [880, 1320].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + i * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.12, t + i * 0.14 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.14 + 0.13);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + i * 0.14);
        osc.stop(t + i * 0.14 + 0.14);
      });
      setTimeout(() => void ctx.close().catch(() => undefined), 600);
    } catch {
      /* audio is a nicety */
    }
  }
}

function notificationPermission(): NotificationPermission | 'unsupported' {
  try {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  } catch {
    return 'unsupported';
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode: the choice lasts this session */
  }
}
