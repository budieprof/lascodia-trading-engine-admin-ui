import { DestroyRef, Injectable, signal } from '@angular/core';
import type { UiCommand, UiCommandParam, UiCommandResult, UiCommandSpec } from './ui-command.types';

/**
 * The registry of commands the assistant may run in the browser.
 *
 * <p>Mirrors {@link PageContextService}: a page says what it can do while it is mounted, and
 * the declaration dies with the component. A command from a page the operator has navigated
 * away from must not still be callable — the chart's `removeIndicator` means nothing once
 * the chart is gone, and running it against a destroyed component is how a stale closure
 * turns into a console error the operator cannot explain.</p>
 */
@Injectable({ providedIn: 'root' })
export class UiCommandService {
  private readonly commands = signal<readonly UiCommand[]>([]);

  /**
   * Register this page's commands for as long as the component lives.
   *
   * <p>Pass the component's `DestroyRef` — registration is automatically withdrawn when it
   * is destroyed, so no page can leak commands into the next one.</p>
   */
  register(commands: readonly UiCommand[], destroyRef: DestroyRef): void {
    const duplicate = commands.find((c) => this.commands().some((e) => e.id === c.id));
    if (duplicate) {
      // Two live commands under one id makes which handler runs a matter of array order.
      throw new Error(`ui command "${duplicate.id}" is already registered`);
    }
    this.commands.update((list) => [...list, ...commands]);
    destroyRef.onDestroy(() => {
      const ids = new Set(commands.map((c) => c.id));
      this.commands.update((list) => list.filter((c) => !ids.has(c.id)));
    });
  }

  /** What the model is told it can do here. Handlers are deliberately not included. */
  specs(): UiCommandSpec[] {
    return this.commands().map(({ id, description, params, confirm }) => ({
      id,
      description,
      ...(params?.length ? { params } : {}),
      ...(confirm ? { confirm: true } : {}),
    }));
  }

  /** True when the named command exists AND is registered by a page that is still mounted. */
  has(id: string): boolean {
    return this.commands().some((c) => c.id === id);
  }

  /** Whether the operator must click before this one runs. Unknown commands are not runnable. */
  requiresConfirmation(id: string): boolean {
    return this.commands().find((c) => c.id === id)?.confirm === true;
  }

  /**
   * Run a command by name.
   *
   * <p>Never throws: every failure — unknown command, bad arguments, a handler that blew up
   * — comes back as `ok: false` with a reason, because the caller is a chat turn and an
   * exception there reads to the operator as the assistant breaking rather than the command
   * being refused.</p>
   */
  async execute(id: string, rawArgs: unknown): Promise<UiCommandResult> {
    const command = this.commands().find((c) => c.id === id);
    if (!command) {
      // The registry IS the allow-list. Anything not registered by a mounted page is
      // refused here, whatever the model asked for.
      return {
        commandId: id,
        ok: false,
        message: `No command "${id}" is available on this page.`,
      };
    }

    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
    const problem = validate(command.params ?? [], args);
    if (problem) return { commandId: id, ok: false, message: problem };

    try {
      const outcome = await command.run(args);
      return { commandId: id, ...outcome };
    } catch (err) {
      return {
        commandId: id,
        ok: false,
        message: `"${id}" failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/**
 * Check arguments against the declared parameters. Returns a reason, or null when fine.
 *
 * <p>Coercion is deliberate on numbers and booleans: a model emits `"20"` and `"true"` about
 * as often as `20` and `true`, and refusing those would be pedantry that reads to the
 * operator as the assistant being unable to work the chart. An enum is NOT coerced — a value
 * outside the declared set is a real mistake and silently picking a neighbour would apply a
 * setting nobody asked for.</p>
 */
function validate(params: readonly UiCommandParam[], args: Record<string, unknown>): string | null {
  for (const p of params) {
    const present = args[p.name] !== undefined && args[p.name] !== null && args[p.name] !== '';
    if (!present) {
      if (p.required) return `"${p.name}" is required.`;
      continue;
    }
    const value = args[p.name];

    if (p.type === 'number') {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) return `"${p.name}" must be a number, got ${JSON.stringify(value)}.`;
      args[p.name] = n;
    } else if (p.type === 'boolean') {
      if (typeof value === 'boolean') continue;
      const s = String(value).trim().toLowerCase();
      if (s === 'true' || s === 'on' || s === 'yes' || s === '1') args[p.name] = true;
      else if (s === 'false' || s === 'off' || s === 'no' || s === '0') args[p.name] = false;
      else return `"${p.name}" must be true or false, got ${JSON.stringify(value)}.`;
    } else if (p.type === 'enum') {
      const s = String(value);
      const allowed = p.values ?? [];
      // Case-insensitive match, then snap to the DECLARED spelling so the handler only ever
      // sees canonical values.
      const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
      if (!hit) return `"${p.name}" must be one of: ${allowed.join(', ')}. Got "${s}".`;
      args[p.name] = hit;
    } else {
      args[p.name] = String(value);
    }
  }
  return null;
}
