import { describe, expect, it, beforeEach } from 'vitest';
import type { DestroyRef } from '@angular/core';
import { UiCommandService } from './ui-command.service';
import type { UiCommand } from './ui-command.types';

/**
 * The registry is the security boundary for everything the assistant does to the browser.
 *
 * A page command never reaches `AssistantAccess.Classify` — that classifier guards engine
 * endpoints, and a command that changes a chart study has no endpoint to guard — so these
 * checks are the whole of the gate.
 */

/** A DestroyRef whose destruction this test can actually trigger. */
function fakeDestroyRef(): DestroyRef & { destroy(): void } {
  const callbacks: Array<() => void> = [];
  return {
    onDestroy(fn: () => void) {
      callbacks.push(fn);
      return () => void 0;
    },
    destroy() {
      for (const fn of callbacks.splice(0)) fn();
    },
  } as DestroyRef & { destroy(): void };
}

describe('UiCommandService', () => {
  let svc: UiCommandService;
  let ref: ReturnType<typeof fakeDestroyRef>;
  let ran: Array<Record<string, unknown>>;

  const cmd = (over: Partial<UiCommand> = {}): UiCommand => ({
    id: 'test.echo',
    description: 'echo',
    run: (args) => {
      ran.push(args);
      return { ok: true, message: 'ran' };
    },
    ...over,
  });

  beforeEach(() => {
    ran = [];
    svc = new UiCommandService();
    ref = fakeDestroyRef();
  });

  it('refuses a command no page registered', async () => {
    const r = await svc.execute('chart.setTimeframe', { timeframe: '240' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('No command');
    expect(ran).toHaveLength(0);
  });

  it('runs a registered command', async () => {
    svc.register([cmd()], ref);
    expect((await svc.execute('test.echo', {})).ok).toBe(true);
    expect(ran).toHaveLength(1);
  });

  it('rejects a duplicate id rather than shadowing one handler with another', () => {
    svc.register([cmd()], ref);
    expect(() => svc.register([cmd()], ref)).toThrow(/already registered/);
  });

  it('publishes specs without handlers', () => {
    svc.register([cmd({ params: [{ name: 'x', type: 'number', description: 'x' }] })], ref);
    const specs = svc.specs();
    expect(specs).toHaveLength(1);
    expect(specs[0]).not.toHaveProperty('run');
    expect(specs[0].params?.[0].name).toBe('x');
  });

  describe('argument checking', () => {
    beforeEach(() => {
      svc.register(
        [
          cmd({
            params: [
              { name: 'n', type: 'number', description: 'n', required: true },
              { name: 'flag', type: 'boolean', description: 'flag' },
              { name: 'mode', type: 'enum', values: ['normal', 'log'], description: 'mode' },
            ],
          }),
        ],
        ref,
      );
    });

    it('refuses a missing required argument', async () => {
      const r = await svc.execute('test.echo', {});
      expect(r.ok).toBe(false);
      expect(r.message).toContain('required');
      expect(ran).toHaveLength(0);
    });

    it('coerces the string forms a model actually emits', async () => {
      expect((await svc.execute('test.echo', { n: '21', flag: 'true' })).ok).toBe(true);
      expect(ran[0]['n']).toBe(21);
      expect(ran[0]['flag']).toBe(true);
    });

    it('refuses a number that is not one', async () => {
      expect((await svc.execute('test.echo', { n: 'twenty' })).ok).toBe(false);
      expect(ran).toHaveLength(0);
    });

    it('snaps an enum to its declared spelling', async () => {
      await svc.execute('test.echo', { n: 1, mode: 'LOG' });
      expect(ran[0]['mode']).toBe('log');
    });

    it('refuses a value outside the enum instead of picking a neighbour', async () => {
      const r = await svc.execute('test.echo', { n: 1, mode: 'logarithmic' });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('must be one of');
      expect(ran).toHaveLength(0);
    });

    it('ignores an optional argument that was left out', async () => {
      expect((await svc.execute('test.echo', { n: 5 })).ok).toBe(true);
    });
  });

  it('turns a throwing handler into a refusal, not an exception', async () => {
    svc.register(
      [
        cmd({
          run: () => {
            throw new Error('boom');
          },
        }),
      ],
      ref,
    );
    const r = await svc.execute('test.echo', {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('boom');
  });

  it('accepts an async handler', async () => {
    svc.register([cmd({ run: async () => ({ ok: true, message: 'later' }) })], ref);
    expect((await svc.execute('test.echo', {})).message).toBe('later');
  });

  it('stops offering a command once its page is destroyed', async () => {
    svc.register([cmd()], ref);
    expect(svc.has('test.echo')).toBe(true);

    ref.destroy();

    // The chart's removeIndicator means nothing once the chart is gone, and running it
    // against a destroyed component is a console error the operator cannot explain.
    expect(svc.has('test.echo')).toBe(false);
    expect(svc.specs()).toHaveLength(0);
    expect((await svc.execute('test.echo', {})).ok).toBe(false);
  });

  it('leaves another page’s commands alone when one page is destroyed', () => {
    const other = fakeDestroyRef();
    svc.register([cmd({ id: 'a' })], ref);
    svc.register([cmd({ id: 'b' })], other);
    ref.destroy();
    expect(svc.has('a')).toBe(false);
    expect(svc.has('b')).toBe(true);
  });

  it('knows which commands need a click', () => {
    svc.register([cmd({ id: 'safe' }), cmd({ id: 'destructive', confirm: true })], ref);
    expect(svc.requiresConfirmation('safe')).toBe(false);
    expect(svc.requiresConfirmation('destructive')).toBe(true);
    // An unknown command is not runnable, so it is not "confirmable" either.
    expect(svc.requiresConfirmation('nope')).toBe(false);
  });
});
