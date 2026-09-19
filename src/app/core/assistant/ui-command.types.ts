/**
 * Commands a page lets the assistant run in the BROWSER.
 *
 * <p>The assistant's existing reach is the engine API: it proposes an operation by
 * operationId and the server carries it out. That covers everything the engine owns and
 * nothing the client owns — chart style, timeframe, which studies are loaded, which
 * drawing tool is armed. None of those exist server-side, so none of them were reachable,
 * and the assistant's only honest answer about the chart was "that is client-side state I
 * cannot touch".</p>
 *
 * <p>This is the missing half: a page declares what it can be asked to do, the declarations
 * ride along with the page context, and the assistant names one. The page keeps ownership
 * of what the command means — the engine only relays a name and arguments.</p>
 *
 * <p><b>The registry is the security boundary.</b> A command that no page registered cannot
 * run, whatever the model emits, and arguments are checked against the declared parameters
 * before the handler sees them. That matters because a UI command bypasses
 * `AssistantAccess.Classify` entirely — the classifier guards engine endpoints, and there is
 * no engine endpoint here to guard.</p>
 */

export type UiCommandParamType = 'string' | 'number' | 'boolean' | 'enum';

export interface UiCommandParam {
  name: string;
  type: UiCommandParamType;
  /** What it means, in operator vocabulary. This is prompt text — write it for a reader. */
  description: string;
  required?: boolean;
  /** Allowed values for `type: 'enum'`. Rejected at execution if the value is not one of these. */
  values?: readonly string[];
}

/** The part of a command that is sent to the model. No handler, no closures. */
export interface UiCommandSpec {
  /** Stable, namespaced: `chart.setTimeframe`. */
  id: string;
  /** One line, imperative: "Switch the chart timeframe". */
  description: string;
  params?: readonly UiCommandParam[];
  /**
   * Whether the operator must click before this runs.
   *
   * <p>Default is false, and that is deliberate: most view changes are instant and
   * trivially reversible, and making "show me the 4h" a two-step approval would make the
   * assistant slower than the toolbar it is meant to save. Set it for anything that
   * DESTROYS work — clearing drawings is the live example, because drawings persist
   * server-side and there is no undo once the delete reaches the engine.</p>
   */
  confirm?: boolean;
}

export interface UiCommand extends UiCommandSpec {
  /**
   * Carry out the command. Return what actually happened — the message is shown to the
   * operator and fed back to the model, so "Removed RSI 14" beats "ok".
   *
   * <p>Throwing is fine; the runner converts it into a failed result rather than letting it
   * escape into the chat.</p>
   */
  run: (args: Record<string, unknown>) => UiCommandOutcome | Promise<UiCommandOutcome>;
}

export interface UiCommandOutcome {
  ok: boolean;
  /** What happened, in one line. Shown to the operator and returned to the model. */
  message: string;
  /** Optional structured detail for the model — e.g. the list a read-style command produced. */
  data?: unknown;
}

export interface UiCommandResult extends UiCommandOutcome {
  commandId: string;
}
