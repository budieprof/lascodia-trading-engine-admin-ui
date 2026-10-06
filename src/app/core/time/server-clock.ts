import { Injectable, inject } from '@angular/core';
import { HttpEventType, type HttpInterceptorFn } from '@angular/common/http';
import { tap } from 'rxjs';

const SAMPLES = 7;

/**
 * The engine's clock, as seen through the `Date` header of its responses. A countdown to a bar
 * close must use the server's time: a client clock a few seconds off would roll bars over early
 * or late. `Date` has 1 s resolution, so each sample is the header + 0.5 s against the request's
 * midpoint; the median of the last {@link SAMPLES} absorbs network jitter. With no sample yet (or
 * a proxy stripping the header) it is the client clock.
 */
@Injectable({ providedIn: 'root' })
export class ServerClock {
  private readonly offsets: number[] = [];
  private offset = 0;

  /** Server time now, in UTC ms. */
  now(): number {
    return Date.now() + this.offset;
  }

  /** Estimated server − client, in ms (0 until a sample arrives). */
  skewMs(): number {
    return this.offset;
  }

  /** One response: its `Date` header and when the request was sent / answered (client ms). */
  sample(dateHeader: string | null, sentMs: number, receivedMs: number): void {
    const server = dateHeader ? Date.parse(dateHeader) : NaN;
    if (!Number.isFinite(server) || receivedMs < sentMs || receivedMs - sentMs > 10_000) return;
    this.offsets.push(server + 500 - (sentMs + receivedMs) / 2);
    if (this.offsets.length > SAMPLES) this.offsets.shift();
    this.offset = median(this.offsets);
  }
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Samples the `Date` header of every response into {@link ServerClock}. */
export const serverClockInterceptor: HttpInterceptorFn = (req, next) => {
  const clock = inject(ServerClock);
  const sent = Date.now();
  return next(req).pipe(
    tap((ev) => {
      if (ev.type === HttpEventType.Response)
        clock.sample(ev.headers.get('Date'), sent, Date.now());
    }),
  );
};
