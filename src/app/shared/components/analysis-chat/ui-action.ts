/**
 * Reading a page-command card off an `ActionProposal` turn.
 *
 * <p>The engine never executes one of these — a command that changes the chart has no engine
 * endpoint to call — so it relays `{command, args}` verbatim and the browser runs it. That
 * makes this parser the first thing standing between model output and a command call, which
 * is why it is pure, defensive, and tested on its own.</p>
 */

/** `toolName` on a turn carrying a page command. Mirrors the engine's `UiActionToolName`. */
export const UI_ACTION_TOOL = 'ui_action';

export interface UiActionCall {
  command: string;
  args: Record<string, unknown>;
}

/**
 * Parse the card's args, or null when it is not a usable page command.
 *
 * <p>Null rather than a throw or a default: the caller's only sane response to an unreadable
 * card is to say so on the card, and a `{command: ''}` fallback would reach the registry as a
 * lookup miss whose message blamed the wrong thing.</p>
 */
export function parseUiAction(argsJson: string | null | undefined): UiActionCall | null {
  if (!argsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const root = parsed as Record<string, unknown>;
  const command = typeof root['command'] === 'string' ? root['command'].trim() : '';
  if (!command) return null;

  // `args` absent is legitimate — several commands take none — but a non-object `args` is a
  // malformed call, not an empty one, and must not be silently read as {}.
  const rawArgs = root['args'];
  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return null;
    return { command, args: { ...(rawArgs as Record<string, unknown>) } };
  }
  return { command, args: {} };
}

/** One line describing the card, for the thread. */
export function describeUiAction(call: UiActionCall): string {
  const entries = Object.entries(call.args);
  if (entries.length === 0) return call.command;
  return `${call.command} ${entries.map(([k, v]) => `${k}=${String(v)}`).join(' ')}`;
}
