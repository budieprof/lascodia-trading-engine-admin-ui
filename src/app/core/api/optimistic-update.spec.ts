import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';

import { runOptimistic } from './optimistic-update';

describe('runOptimistic', () => {
  it('applies the optimistic mutation before the operation resolves', async () => {
    const state = signal([{ id: 1, status: 'Paused' }]);
    let observedDuringOp: { id: number; status: string }[] | null = null;

    await firstValueFrom(
      runOptimistic({
        state,
        apply: (list) => list.map((s) => (s.id === 1 ? { ...s, status: 'Active' } : s)),
        operation: () => {
          observedDuringOp = state();
          return of(null);
        },
      }),
    );

    expect(observedDuringOp).toEqual([{ id: 1, status: 'Active' }]);
    expect(state()).toEqual([{ id: 1, status: 'Active' }]);
  });

  it('rolls back on operation failure and calls onError', async () => {
    const state = signal<{ id: number; status: string }[]>([{ id: 1, status: 'Paused' }]);
    const onError = vi.fn();
    const err = new Error('boom');

    await expect(
      firstValueFrom(
        runOptimistic({
          state,
          apply: (list) => list.map((s) => ({ ...s, status: 'Active' })),
          operation: () => throwError(() => err),
          onError,
        }),
      ),
    ).rejects.toBe(err);

    expect(state()).toEqual([{ id: 1, status: 'Paused' }]);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('runs commit() on success when provided', async () => {
    const state = signal<{ id: number; confirmed: boolean }[]>([{ id: 1, confirmed: false }]);

    await firstValueFrom(
      runOptimistic({
        state,
        apply: (list) => list.map((s) => ({ ...s, confirmed: true })),
        commit: (list, result: string) => list.map((s) => ({ ...s, confirmed: result === 'ok' })),
        operation: () => of('ok'),
      }),
    );

    expect(state()).toEqual([{ id: 1, confirmed: true }]);
  });
});
