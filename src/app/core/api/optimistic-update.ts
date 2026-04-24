import { WritableSignal } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

/**
 * Apply an optimistic change to a signal-backed state, run the operation, roll back on error.
 *
 * Usage (strategy activation):
 *
 *   runOptimistic({
 *     state: this.strategies,
 *     apply: (list) => list.map(s => s.id === id ? { ...s, status: 'Active' } : s),
 *     operation: () => this.strategiesService.activate(id),
 *   }).subscribe();
 *
 * If `commit` is provided, it runs on success to apply server-confirmed state.
 */
export interface OptimisticOptions<TState, TResult> {
  state: WritableSignal<TState>;
  apply: (current: TState) => TState;
  commit?: (current: TState, result: TResult) => TState;
  operation: () => Observable<TResult>;
  /** Side-effect when the operation fails and state is rolled back (e.g. toast). */
  onError?: (err: unknown) => void;
}

export function runOptimistic<TState, TResult>(
  opts: OptimisticOptions<TState, TResult>,
): Observable<TResult> {
  const snapshot = opts.state();
  opts.state.set(opts.apply(snapshot));
  return opts.operation().pipe(
    tap((result) => {
      if (opts.commit) opts.state.set(opts.commit(opts.state(), result));
    }),
    catchError((err) => {
      opts.state.set(snapshot);
      opts.onError?.(err);
      return throwError(() => err);
    }),
  );
}
