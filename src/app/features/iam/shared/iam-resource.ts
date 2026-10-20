import { signal, type WritableSignal } from '@angular/core';
import type { Observable } from 'rxjs';

import { errorText } from '../iam.logic';

/** A list or object a page loads on open and on Refresh. */
export interface IamResource<T> {
  readonly value: WritableSignal<T>;
  readonly loading: WritableSignal<boolean>;
  /** Plain message for an inline error state; null when the last load worked. */
  readonly error: WritableSignal<string | null>;
  /** True once a load has finished (either way). */
  readonly loaded: WritableSignal<boolean>;
  reload(): void;
}

/**
 * Loads `fetch()` into signals. A failed refresh keeps the last good value (the page shows the error
 * beside it rather than blanking); the first failure leaves `initial` with the error set.
 */
export function iamResource<T>(fetch: () => Observable<T>, initial: T, failure = 'Could not load this.'): IamResource<T> {
  const value = signal<T>(initial);
  const loading = signal(false);
  const error = signal<string | null>(null);
  const loaded = signal(false);
  let generation = 0;
  return {
    value,
    loading,
    error,
    loaded,
    reload() {
      const mine = ++generation;
      loading.set(true);
      fetch().subscribe({
        next: (v) => {
          if (mine !== generation) return;
          value.set(v);
          error.set(null);
        },
        error: (e) => {
          if (mine !== generation) return;
          error.set(errorText(e, failure));
          loading.set(false);
          loaded.set(true);
        },
        complete: () => {
          if (mine !== generation) return;
          loading.set(false);
          loaded.set(true);
        },
      });
    },
  };
}
