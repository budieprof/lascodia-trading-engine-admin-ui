/**
 * What an approval card would ACTUALLY do, read off the card itself.
 *
 * The card as written says "apply_config_change · `SpotSweep:MaxPerSymbol = 4` · Writes a live
 * EngineConfig value". That is the agent's description of the change, and an operator approving it
 * is trusting the description. These functions extract the machine-readable shape of the call so the
 * card can show the change instead: the value that is there now against the one being written, the
 * request that will be sent, the two models being swapped.
 *
 * Everything is pure and defensive — the payload is written by the host service and by the engine's
 * platform-call path, and both have changed shape before. Anything unrecognised falls through to
 * `none`, which renders the card exactly as it renders today.
 */
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';

/** A live EngineConfig write. `value` is the new value, as written. */
export interface ConfigChangePlan {
  kind: 'config';
  key: string;
  value: string;
}

/** One platform operation, already bound to a concrete method + path. */
export interface PlatformCallPlan {
  kind: 'platform';
  operationId: string | null;
  method: string;
  path: string;
  /** Pretty-printed request body, or null when the call carries none. */
  body: string | null;
  /** Pretty-printed query string args, or null when there are none. */
  query: string | null;
}

/** A champion swap — the model coming in, and (when the card names it) the one going out. */
export interface ModelSwapPlan {
  kind: 'models';
  verb: string;
  incomingId: number | null;
  outgoingId: number | null;
  /** "EURUSD H1" when the card names the pair rather than the models. */
  scope: string | null;
}

export type ApprovalPlan = ConfigChangePlan | PlatformCallPlan | ModelSwapPlan | { kind: 'none' };

const NONE = { kind: 'none' } as const;

function parseObject(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function targetsOf(args: Record<string, unknown>): string[] {
  return Array.isArray(args['targets'])
    ? (args['targets'] as unknown[]).filter((x) => x != null).map((x) => String(x))
    : [];
}

/**
 * First `#`-prefixed id in a string — `model #918` → 918.
 *
 * The `#` is required: a rollback target is `EURUSD H1`, and reading the timeframe's digit as a
 * model id would send the card off to fetch model #1 and show the operator a model that has nothing
 * to do with the change.
 */
function idIn(text: string | null): number | null {
  const m = text ? /#(\d{1,12})\b/.exec(text) : null;
  return m ? Number(m[1]) : null;
}

/** First of `keys` present on `args` as a positive integer. */
function idFrom(args: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = args[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return null;
}

/**
 * Pretty-print a JSON-ish value for display: 2-space indented when it parses, verbatim when it does
 * not. A body the operator cannot read is worse than no preview, but a body we cannot parse is still
 * the body that will be sent — so it is shown as-is rather than dropped.
 */
export function prettyJson(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return t;
    }
  }
  try {
    const out = JSON.stringify(value, null, 2);
    return out && out !== '{}' && out !== 'null' ? out : null;
  } catch {
    return null;
  }
}

/** Split an `apply_config_change` target — the card writes them as `Key = value`. */
export function splitConfigTarget(
  target: string | null | undefined,
): { key: string; value: string } | null {
  const t = (target ?? '').trim();
  const at = t.indexOf('=');
  if (at <= 0) return null;
  const key = t.slice(0, at).trim();
  const value = t.slice(at + 1).trim();
  return key ? { key, value } : null;
}

/**
 * What this approval card would do.
 *
 * ASSUMPTION (verified against the host + engine as deployed 2026-09-12): the card's `toolArgsJson`
 * always carries `verb`, `targets`, `sideEffect` and `live`; a platform call additionally carries
 * `operationId` / `method` / `path` / `argsCanonical`, written by the engine. The host's own gated
 * verbs (`apply_config_change`, `ml_activate_model`, …) currently put the substance ONLY in
 * `targets` — `key = value`, `model #918` — so both routes are read: named args first, the target
 * text as the fallback. That way this keeps working if the host starts sending the args too.
 */
export function planFromApproval(turn: SpotAnalysisFollowUpTurnDto): ApprovalPlan {
  const args = parseObject(turn.toolArgsJson);
  if (!args) return NONE;
  const verb = (str(args['verb']) ?? '').trim();
  const targets = targetsOf(args);

  if (verb === 'apply_config_change') {
    const key = str(args['key']) ?? splitConfigTarget(targets[0])?.key ?? null;
    if (!key) return NONE;
    const value = str(args['value']) ?? splitConfigTarget(targets[0])?.value ?? '';
    return { kind: 'config', key, value };
  }

  if (verb === 'platform_call') {
    const canonical = parseObject(str(args['argsCanonical']));
    const method = (str(args['method']) ?? str(canonical?.['method']) ?? 'POST').toUpperCase();
    const path = str(args['path']) ?? str(canonical?.['routeTemplate']) ?? '';
    if (!path) return NONE;
    return {
      kind: 'platform',
      operationId: str(args['operationId']),
      method,
      path,
      body: prettyJson(canonical?.['body'] ?? args['body'] ?? null),
      query: prettyJson(canonical?.['query'] ?? null),
    };
  }

  if (verb === 'ml_activate_model' || verb === 'ml_rollback_model') {
    const incomingId =
      idFrom(args, ['id', 'modelId', 'toModelId', 'challengerModelId', 'newModelId']) ??
      idIn(targets[0] ?? null);
    const outgoingId = idFrom(args, [
      'fromModelId',
      'currentModelId',
      'previousModelId',
      'championModelId',
    ]);
    // A rollback names the pair, not the models ("EURUSD H1") — nothing to fetch, but worth saying.
    const scope = incomingId === null ? (targets[0] ?? null) : null;
    if (incomingId === null && outgoingId === null && !scope) return NONE;
    return { kind: 'models', verb, incomingId, outgoingId, scope };
  }

  return NONE;
}

/** True when the plan needs data the card does not carry — i.e. a fetch is worth making. */
export function planNeedsFetch(plan: ApprovalPlan): boolean {
  if (plan.kind === 'config') return true;
  if (plan.kind === 'models') return plan.incomingId !== null || plan.outgoingId !== null;
  return false;
}

/** The model ids a `models` plan wants, in display order (incoming first). Deduped. */
export function modelIdsOf(plan: ApprovalPlan): number[] {
  if (plan.kind !== 'models') return [];
  return [plan.incomingId, plan.outgoingId].filter(
    (id, i, all): id is number => id !== null && all.indexOf(id) === i,
  );
}

// ── Model comparison ──────────────────────────────────────────────────────────────────────────

/**
 * The metrics an operator decides a champion swap on.
 *
 * `netPnlSharpe` is read off the payload rather than the generated DTO: the engine's ml-model rows
 * have carried it since the P&L-weighted evaluation landed, but `MLModelDto` does not name it, and
 * inventing a field here would be worse than reading the one that is actually on the wire.
 */
export interface ModelMetricRow {
  label: string;
  /** Formatted for display; '—' when the model does not carry the metric. */
  values: string[];
  /** Index of the best value, or null when they cannot be compared. Higher is better throughout. */
  best: number | null;
}

export interface ModelLike {
  id: number;
  symbol?: string | null;
  timeframe?: string | null;
  modelVersion?: string | null;
  status?: string | null;
  isActive?: boolean;
  directionAccuracy?: number | null;
  sharpeRatio?: number | null;
  netPnlSharpe?: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmt(v: number | null, digits: number, suffix = ''): string {
  return v === null ? '—' : `${v.toFixed(digits)}${suffix}`;
}

/** Index of the single largest value, or null when there is no clear winner (tie, or < 2 numbers). */
function bestOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length < 2) return null;
  const max = Math.max(...present);
  if (values.filter((v) => v === max).length > 1) return null;
  return values.indexOf(max);
}

/**
 * The side-by-side rows for a champion swap — only the metrics that decide it, in the order an
 * operator reads them. Works for one model as well as two, so a card that names only the incoming
 * model still shows what it is promoting.
 */
export function modelComparisonRows(models: readonly ModelLike[]): ModelMetricRow[] {
  if (models.length === 0) return [];
  const acc = models.map((m) => num(m.directionAccuracy));
  const net = models.map((m) => num(m.netPnlSharpe));
  const sharpe = models.map((m) => num(m.sharpeRatio));
  const rows: ModelMetricRow[] = [
    {
      label: 'Direction accuracy',
      values: acc.map((v) => fmt(v === null ? null : v * 100, 1, '%')),
      best: bestOf(acc),
    },
    { label: 'Net-P&L Sharpe', values: net.map((v) => fmt(v, 2)), best: bestOf(net) },
    { label: 'Sharpe ratio', values: sharpe.map((v) => fmt(v, 2)), best: bestOf(sharpe) },
    {
      label: 'Status',
      values: models.map((m) => `${m.status ?? '—'}${m.isActive ? ' · live' : ''}`),
      best: null,
    },
  ];
  // A metric no model reports says nothing — drop the row rather than print a line of dashes.
  return rows.filter((r) => r.values.some((v) => v !== '—'));
}

/** `#918 · EURUSD H1 v3` — how one model column is headed. */
export function modelLabel(m: ModelLike): string {
  const parts = [
    [m.symbol, m.timeframe].filter(Boolean).join(' '),
    m.modelVersion ? `v${m.modelVersion}` : '',
  ].filter(Boolean);
  return parts.length ? `#${m.id} · ${parts.join(' ')}` : `#${m.id}`;
}
