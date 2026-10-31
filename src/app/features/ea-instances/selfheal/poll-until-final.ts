import { Observable, type Subscription } from 'rxjs';

export interface PollUntilFinalOptions {
  /** Poll cadence while the action is young (default 2 s). */
  fastMs?: number;
  /** Cadence after `fastForMs` (default 5 s). */
  slowMs?: number;
  /** How long to poll fast (default 30 s). */
  fastForMs?: number;
  /** Stop asking after this long; the last value is reported with `gaveUp` (default 15 min). */
  giveUpMs?: number;
  /** Consecutive fetch errors / empty answers tolerated before giving up (default 6). */
  maxErrors?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface PollTick<T> {
  value: T | null;
  /** The value's status is final (Succeeded / Failed / Expired). */
  final: boolean;
  /** Polling stopped before a final status: timeout or repeated errors. */
  gaveUp: boolean;
  /** The last fetch error, when it was the reason for giving up. */
  error?: unknown;
}

/**
 * Polls `fetch` until `isFinal(value)`, emitting every answer. Fast at first
 * (an EA command is usually acknowledged within its 2-second poll), then
 * slower, and it gives up after `giveUpMs` so a dead EA never leaves a
 * request loop running. Unsubscribing stops it at once.
 *
 * Written with plain timers (not `timer`/`expand`) so the cadence change and
 * the give-up are easy to follow and to drive with fake timers in tests.
 */
export function pollUntilFinal<T>(
  fetch: () => Observable<T | null>,
  isFinal: (value: T) => boolean,
  opts: PollUntilFinalOptions = {},
): Observable<PollTick<T>> {
  const fastMs = opts.fastMs ?? 2000;
  const slowMs = opts.slowMs ?? 5000;
  const fastForMs = opts.fastForMs ?? 30_000;
  const giveUpMs = opts.giveUpMs ?? 15 * 60_000;
  const maxErrors = opts.maxErrors ?? 6;
  const now = opts.now ?? (() => Date.now());

  return new Observable<PollTick<T>>((subscriber) => {
    const started = now();
    let last: T | null = null;
    let errors = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let inflight: Subscription | null = null;
    let closed = false;

    const finish = (tick: PollTick<T>) => {
      if (closed) return;
      closed = true;
      subscriber.next(tick);
      subscriber.complete();
    };

    const schedule = () => {
      if (closed) return;
      const elapsed = now() - started;
      if (elapsed >= giveUpMs) {
        finish({ value: last, final: false, gaveUp: true });
        return;
      }
      timeout = setTimeout(run, elapsed < fastForMs ? fastMs : slowMs);
    };

    const run = () => {
      timeout = null;
      if (closed) return;
      let answered = false;
      inflight = fetch().subscribe({
        next: (value) => {
          answered = true;
          if (value == null) {
            errors++;
            if (errors >= maxErrors) finish({ value: last, final: false, gaveUp: true });
            return;
          }
          errors = 0;
          last = value;
          if (isFinal(value)) finish({ value, final: true, gaveUp: false });
          else subscriber.next({ value, final: false, gaveUp: false });
        },
        error: (err) => {
          errors++;
          if (errors >= maxErrors) finish({ value: last, final: false, gaveUp: true, error: err });
          else schedule();
        },
        complete: () => {
          if (!answered) {
            errors++;
            if (errors >= maxErrors) {
              finish({ value: last, final: false, gaveUp: true });
              return;
            }
          }
          schedule();
        },
      });
    };

    run();

    return () => {
      closed = true;
      if (timeout) clearTimeout(timeout);
      inflight?.unsubscribe();
    };
  });
}
