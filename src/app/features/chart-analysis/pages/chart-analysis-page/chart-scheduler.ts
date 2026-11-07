/**
 * US06: the chart page's periodic work on ONE timer that knows whether the tab is visible. It used to run five
 * `setInterval`s of its own (the 1 s clock, the 30 s headline age and market-status clocks, the minute script re-runs
 * and the minute forming-bar resync), every one of them firing — and two of them calling the engine — in a hidden tab.
 *
 * - One base timer (1 s); each job runs when its period is due.
 * - While the tab is hidden nothing runs and the base timer stops; when it shows again every job whose period passed
 *   meanwhile runs at once (the clock is right, the forming bar is re-read), then keeps its period from there.
 *
 * Plain TypeScript with the browser behind {@link SchedulerEnv}, so it is tested with a fake clock.
 */
export interface SchedulerEnv {
  now(): number;
  hidden(): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibility(fn: () => void): () => void;
}

export const BASE_TICK_MS = 1_000;

interface Job {
  everyMs: number;
  nextAt: number;
  run: () => void;
}

export function browserSchedulerEnv(): SchedulerEnv {
  return {
    now: () => Date.now(),
    hidden: () => typeof document !== 'undefined' && document.hidden,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    onVisibility: (fn) => {
      if (typeof document === 'undefined') return () => undefined;
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
  };
}

export class ChartScheduler {
  private readonly jobs = new Map<string, Job>();
  private handle: unknown = null;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly env: SchedulerEnv) {
    this.unsubscribe = env.onVisibility(() => this.onVisibility());
  }

  /** Run `run` every `everyMs` while the tab is visible (first after one period). Returns the cancel. */
  every(id: string, everyMs: number, run: () => void): () => void {
    this.jobs.set(id, { everyMs, nextAt: this.env.now() + everyMs, run });
    this.sync();
    return () => {
      this.jobs.delete(id);
      this.sync();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.jobs.clear();
    this.sync();
    this.unsubscribe();
  }

  /** The base timer runs while there are jobs and the tab shows. */
  private sync(): void {
    const want = !this.disposed && this.jobs.size > 0 && !this.env.hidden();
    if (want && this.handle === null) this.handle = this.env.setInterval(() => this.tick(), BASE_TICK_MS);
    else if (!want && this.handle !== null) {
      this.env.clearInterval(this.handle);
      this.handle = null;
    }
  }

  private onVisibility(): void {
    if (!this.env.hidden()) this.tick();
    this.sync();
  }

  /** Every job that is due runs once, and is next due a period from now. */
  private tick(): void {
    if (this.env.hidden()) return;
    const now = this.env.now();
    for (const job of [...this.jobs.values()]) {
      if (now < job.nextAt) continue;
      job.nextAt = now + job.everyMs;
      job.run();
    }
  }
}
