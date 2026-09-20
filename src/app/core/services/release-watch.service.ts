import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

/**
 * Notices when a new UI release has been published under an open tab.
 *
 * <p>The console is a single-page app: publishing swaps the files on disk, but a tab that is
 * already open keeps running the JavaScript it loaded and never asks for index.html again.
 * So an operator can sit in front of a fixed bug indefinitely, and — worse — report that the
 * fix does not work, because from where they are sitting it does not.</p>
 *
 * <p>That is not hypothetical: it cost a round trip during the screen-capture work, where a
 * tab three releases behind kept reporting the exact fault that had just been fixed.</p>
 *
 * <p>`config.json` is stamped with a unique `releaseId` per publish and served `no-cache`,
 * so polling it is a cheap and exact way to ask "is what I am running still what is
 * deployed?". Nothing reloads on its own — an operator watching a live trading console
 * should never have the page yanked out from under them mid-sentence.</p>
 */
@Injectable({ providedIn: 'root' })
export class ReleaseWatchService {
  private readonly runtime = inject(RUNTIME_CONFIG);
  private readonly destroyRef = inject(DestroyRef);

  /** The releaseId now being served, when it differs from the one this tab loaded. */
  readonly pending = signal<string | null>(null);

  /** What this tab is actually running. */
  readonly current = this.runtime.releaseId ?? null;

  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start polling. Idempotent, and a no-op when the build carries no releaseId — a dev
   * server has none, and a watcher that fires constantly there would train the operator to
   * ignore it.
   */
  start(intervalMs = 120_000): void {
    if (this.timer !== null || !this.current) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.destroyRef.onDestroy(() => this.stop());
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async check(): Promise<void> {
    if (!this.current) return;
    try {
      // Cache-bust explicitly rather than trusting the no-cache header: an intermediate
      // proxy that ignores it would make this watcher quietly useless, which is the same
      // failure it exists to prevent.
      const res = await fetch(`/config.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { releaseId?: string };
      const served = body.releaseId ?? null;
      this.pending.set(served && served !== this.current ? served : null);
    } catch {
      // Offline, or the console is being redeployed this very second. Staying quiet is
      // right: an "update available" banner that appears because the network blinked is
      // worse than one that appears a poll late.
    }
  }
}
