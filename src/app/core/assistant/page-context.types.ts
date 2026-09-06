/**
 * What the assistant is told about where the operator is standing.
 *
 * <p>Structured facts only — never rendered DOM text or a screenshot. A page decides what is
 * worth saying about itself; the shape below is the contract for saying it.</p>
 */

/** What a page chooses to publish about its current state. Every field is optional. */
export interface PageFacts {
  /** One line: what this page is showing right now. "Backtest #480, AUDUSD H4, 11 trades." */
  headline?: string;

  /** The single record on screen, when the page is a detail view. */
  record?: { kind: string; id: string | number; label?: string };

  /** Filters as the operator set them — the assistant cannot see the controls. */
  filters?: Record<string, unknown>;

  /** Key figures, already formatted the way the page shows them. */
  figures?: Record<string, string | number | null>;

  /** Ids on screen the assistant may reasonably act on or look up. */
  ids?: Record<string, Array<string | number>>;
}

/** The full payload sent with each assistant message. */
export interface PageContext {
  /** Current URL including query string. */
  url: string;
  /** Route pattern where known, e.g. /backtests/:id. */
  routePath: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Human page name and group, from the shared page catalogue. */
  pageLabel: string | null;
  pageGroup: string | null;
  /** What the page is for, in operator vocabulary. */
  pageKeywords?: string;
  breadcrumbs: string[];
  /** Which account(s) the console is scoped to — most figures on screen depend on this. */
  scope: { selected: string; accountIds: string; accountName: string | null };
  facts: PageFacts | null;
  capturedAtUtc: string;
}
