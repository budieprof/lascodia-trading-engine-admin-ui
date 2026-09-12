/**
 * Resolving an approval card WITH WORDS — and, where the card allows it, with an edit.
 *
 * A rejection used to reach the agent as the single word "rejected": the one thing it most needed
 * (what was wrong) was the one thing it never got. The engine now takes an optional body on
 * `POST market-data/analyze/follow-up/{id}/resolve?confirm=…`:
 *
 *     { "reason": string, "amendedArgs": { route?, query?, body? } }
 *
 * `reason` is stored on the card, posted into the thread as the operator's own User turn, and handed
 * to the agent as an instruction. `amendedArgs` is approve-with-an-edit and is accepted only on an
 * algo-engineer platform card — one whose `toolArgsJson` carries `operationId` + `routeTemplate` and
 * the bound `args` object. Only VALUES may differ: the engine refuses a different operation, route,
 * key set or trading account outright.
 *
 * Everything here is pure so the rules that decide what may be edited, what a valid edit is, and what
 * goes on the wire can be tested without a TestBed. Every parser is defensive: the payload is written
 * by the engine's platform-call path and by the host service, and both have changed shape before.
 */
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';

/** Engine-side cap on the operator's words (`Trimmed` in the resolve handler). Mirrored here. */
export const MAX_REASON_LENGTH = 2000;

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
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ── The request body ──────────────────────────────────────────────────────────────────────────

/** What the operator is sending with a decision. Both halves optional. */
export interface ResolveApprovalOptions {
  /** The operator's words. Empty / whitespace-only is the same as saying nothing. */
  reason?: string | null;
  /** Approve-with-an-edit, `{route?, query?, body?}`. Never sent with a rejection. */
  amendedArgs?: Record<string, unknown> | null;
}

/**
 * The resolve request body.
 *
 * An empty object rather than a body of nulls: the engine reads a missing `reason` as "nothing was
 * said", and a literal `null` would travel into the card and the thread as an empty operator turn.
 * The reason is trimmed and capped to the same 2000 chars the engine enforces, so the operator sees
 * the clip in the composer rather than discovering it in the thread.
 */
export function resolveApprovalBody(opts?: ResolveApprovalOptions | null): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const reason = (opts?.reason ?? '').trim();
  if (reason) body['reason'] = reason.slice(0, MAX_REASON_LENGTH);
  if (opts?.amendedArgs && Object.keys(opts.amendedArgs).length > 0)
    body['amendedArgs'] = opts.amendedArgs;
  return body;
}

// ── What the card would do, as editable values ────────────────────────────────────────────────

/** The scalar kinds a bound argument can hold. Decides the input and how an edit is re-typed. */
export type AmendKind = 'string' | 'number' | 'boolean' | 'null';

/** One value on the card an operator may change. */
export interface AmendField {
  /** Dotted path, exactly as the engine reports it back in `amendment.changes` — `body.lots`. */
  path: string;
  /** Which section of the bound args it lives in. `route` is never amendable and never listed. */
  section: 'query' | 'body';
  /** What the field is called on screen — the path without its section prefix. */
  label: string;
  /** The card's value, rendered for a text input. */
  value: string;
  kind: AmendKind;
}

/** The card's bound arguments: `{route, query, body}` as the engine stored them. */
interface BoundArgs {
  route: Record<string, unknown> | null;
  query: Record<string, unknown> | null;
  body: unknown;
  hasBody: boolean;
}

function boundArgs(turn: SpotAnalysisFollowUpTurnDto): BoundArgs | null {
  const card = parseObject(turn.toolArgsJson);
  if (!card) return null;
  // An amendment binds to an ENGINE OPERATION. A host-gated verb (apply_config_change, …) carries
  // no operation to re-bind, and the engine refuses the amendment — so it must not be offered.
  if (!str(card['operationId']) || !str(card['routeTemplate'])) return null;
  const args = obj(card['args']);
  if (!args) return null;
  const hasBody = args['body'] !== undefined && args['body'] !== null;
  return {
    route: obj(args['route']),
    query: obj(args['query']),
    body: hasBody ? args['body'] : null,
    hasBody,
  };
}

function scalarKind(v: unknown): AmendKind | null {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number' && Number.isFinite(v)) return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return null;
}

function scalarText(v: unknown): string {
  if (v === null) return '';
  return typeof v === 'string' ? v : String(v);
}

/** Depth bound, mirroring the engine's own walk — a pathological payload must not hang the tab. */
const MAX_DEPTH = 12;

function walk(
  value: unknown,
  path: string,
  section: 'query' | 'body',
  out: AmendField[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, section, out, depth + 1));
    return;
  }
  const o = obj(value);
  if (o) {
    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, section, out, depth + 1);
    return;
  }
  const kind = scalarKind(value);
  // A path with no key (`body` holding a bare scalar) is not addressable as a field, and the engine
  // would read a rebuilt body as a shape change. Leave it to a reject-and-repropose.
  if (!kind || path === section) return;
  out.push({
    path,
    section,
    label: path.slice(section.length + 1),
    value: scalarText(value),
    kind,
  });
}

/**
 * Every value on this card an operator may change, in the order the card carries them — query first,
 * then body, because that is how the preview reads.
 *
 * Empty for any card that is not an amendable platform call: the option is then not offered at all,
 * which is the honest rendering — a card whose amendment the engine would refuse must not grow an
 * edit affordance that always fails.
 */
export function amendableFields(turn: SpotAnalysisFollowUpTurnDto): AmendField[] {
  const bound = boundArgs(turn);
  if (!bound) return [];
  const out: AmendField[] = [];
  if (bound.query) walk(bound.query, 'query', 'query', out, 0);
  if (bound.hasBody) walk(bound.body, 'body', 'body', out, 0);
  return out;
}

/** True when this card carries values an operator could approve-with-an-edit. */
export function isAmendable(turn: SpotAnalysisFollowUpTurnDto): boolean {
  return amendableFields(turn).length > 0;
}

// ── Validating and composing an edit ──────────────────────────────────────────────────────────

/** The operator's edits, keyed by `AmendField.path`. A path absent from the map is untouched. */
export type AmendEdits = Readonly<Record<string, string>>;

/**
 * True when an edit actually moves the value.
 *
 * Numbers and booleans are compared as the values they will become, not as the text typed: `0.90`
 * for `0.9`, or a trailing space, is not a change, and sending it would earn the engine's "identical
 * to the arguments already on the card" refusal for an edit the operator never made.
 */
function moved(f: AmendField, next: string | undefined): boolean {
  if (next === undefined) return false;
  if (f.kind === 'number') {
    const a = Number(next.trim());
    return !Number.isFinite(a) || a !== Number(f.value);
  }
  if (f.kind === 'boolean') return next.trim().toLowerCase() !== f.value.trim().toLowerCase();
  return next !== f.value;
}

/** The fields whose value differs from the card's, in card order. */
export function changedFields(fields: readonly AmendField[], edits: AmendEdits): AmendField[] {
  return fields.filter((f) => moved(f, edits[f.path]));
}

/**
 * The same rules the engine applies, checked as the operator types — an amendment that will be
 * refused should be refused in the form, not by a round-trip that loses the composer's contents.
 *
 * Null means the edit is sendable. A number that no longer parses and a boolean that is not
 * true/false are the two ways an operator can break the binding by typing; everything structural
 * (new keys, a changed route, a different account) is impossible by construction here, because the
 * form only ever offers the scalars the card already carries.
 */
export function validateAmendEdits(
  fields: readonly AmendField[],
  edits: AmendEdits,
): string | null {
  for (const f of fields) {
    const next = edits[f.path];
    if (!moved(f, next) || next === undefined) continue;
    const t = next.trim();
    if (f.kind === 'number') {
      if (t === '' || !Number.isFinite(Number(t)))
        return `${f.label} must be a number — the card carries a number there.`;
    } else if (f.kind === 'boolean') {
      const lower = t.toLowerCase();
      if (lower !== 'true' && lower !== 'false') return `${f.label} must be true or false.`;
    }
  }
  if (changedFields(fields, edits).length === 0)
    return 'Nothing is changed yet — edit a value, or approve the card as it stands.';
  return null;
}

/** Re-type one edited value the way the card carried it. */
function typedValue(field: AmendField, text: string): unknown {
  const t = text.trim();
  switch (field.kind) {
    case 'number':
      return Number(t);
    case 'boolean':
      return t.toLowerCase() === 'true';
    case 'null':
      // The card held null. An emptied field stays null; anything typed becomes a string — the
      // engine allows a scalar to change kind, only the SHAPE is fixed.
      return t === '' ? null : text;
    default:
      return text;
  }
}

/** Path steps: `body.items[0].lots` → ['body', 'items', 0, 'lots']. */
function steps(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return [];
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].match(/\d+/g) ?? []) out.push(Number(idx));
  }
  return out;
}

function clone<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Write one value into a cloned tree at a dotted/indexed path. Silent when the path is not there. */
function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = steps(path);
  if (parts.length < 2) return;
  let cursor: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (Array.isArray(cursor) && typeof key === 'number') cursor = cursor[key];
    else if (obj(cursor) && typeof key === 'string')
      cursor = (cursor as Record<string, unknown>)[key];
    else return;
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cursor) && typeof last === 'number') cursor[last] = value;
  else if (obj(cursor) && typeof last === 'string')
    (cursor as Record<string, unknown>)[last] = value;
}

/**
 * The `amendedArgs` body for an approve-with-an-edit: the card's own `{route, query, body}` with the
 * operator's values written into it.
 *
 * The WHOLE bound object is sent, not just the changed leaves. The engine compares shapes key by key
 * and reads a missing key as a shape change — the amendment is a replacement for what the card binds
 * to, so it has to arrive whole. `route` rides along unchanged so the engine can confirm the target
 * did not move; it is never editable here.
 *
 * Returns null when there is nothing valid to send, so a caller can fall back to a plain approval.
 */
export function buildAmendedArgs(
  turn: SpotAnalysisFollowUpTurnDto,
  fields: readonly AmendField[],
  edits: AmendEdits,
): Record<string, unknown> | null {
  const bound = boundArgs(turn);
  if (!bound) return null;
  const changed = changedFields(fields, edits);
  if (changed.length === 0 || validateAmendEdits(fields, edits) !== null) return null;

  const out: Record<string, unknown> = {
    route: clone(bound.route ?? {}),
    query: clone(bound.query ?? {}),
  };
  if (bound.hasBody) out['body'] = clone(bound.body);
  for (const f of changed) setAt(out, f.path, typedValue(f, edits[f.path]));
  return out;
}

// ── What a resolved card says ─────────────────────────────────────────────────────────────────

/** One value the operator moved, as the engine records it on the card. */
export interface AmendmentChange {
  path: string;
  from: string | null;
  to: string | null;
}

/** The decision on a card, read off `toolResultJson`. */
export interface ParsedResolution {
  decision: 'approved' | 'rejected' | null;
  /** The operator's words, or null when they said nothing. */
  reason: string | null;
  resolvedByUserId: string | null;
  resolvedAtUtc: string | null;
  /** True when the call was approved with edited values. */
  amended: boolean;
  amendedByUserId: string | null;
  changes: AmendmentChange[];
  /** The card is recorded but still Pending: one more operator has to approve it. */
  awaitingSecondApprover: boolean;
}

const EMPTY_RESOLUTION: ParsedResolution = {
  decision: null,
  reason: null,
  resolvedByUserId: null,
  resolvedAtUtc: null,
  amended: false,
  amendedByUserId: null,
  changes: [],
  awaitingSecondApprover: false,
};

/**
 * The decision recorded on a card.
 *
 * `reason` is read whatever the outcome, including the half-state where an approval is recorded but a
 * second approver is still required — that is exactly when an operator most needs to see what the
 * first one said.
 */
export function parseResolution(turn: SpotAnalysisFollowUpTurnDto): ParsedResolution {
  const r = parseObject(turn.toolResultJson);
  if (!r) return EMPTY_RESOLUTION;
  const decisionRaw = (str(r['decision']) ?? '').toLowerCase();
  const amendment = obj(r['amendment']);
  const changes = Array.isArray(amendment?.['changes'])
    ? (amendment['changes'] as unknown[])
        .map((c) => obj(c))
        .filter((c): c is Record<string, unknown> => c !== null)
        .map((c) => ({
          path: str(c['path']) ?? '',
          from: typeof c['from'] === 'string' ? (c['from'] as string) : null,
          to: typeof c['to'] === 'string' ? (c['to'] as string) : null,
        }))
    : [];
  const amendedBy = str(r['amendedByUserId']);
  return {
    decision:
      decisionRaw === 'approved' ? 'approved' : decisionRaw === 'rejected' ? 'rejected' : null,
    reason: str(r['reason']),
    resolvedByUserId: str(r['resolvedByUserId']),
    resolvedAtUtc: str(r['resolvedAtUtc']),
    amended: changes.length > 0 || amendedBy !== null,
    amendedByUserId: amendedBy,
    changes,
    awaitingSecondApprover: r['awaitingSecondApprover'] === true,
  };
}

/** `lots 0.5 → 0.92` — one amended value, in a line. */
export function describeChange(c: AmendmentChange): string {
  const label = c.path.includes('.') ? c.path.slice(c.path.indexOf('.') + 1) : c.path;
  return `${label} ${c.from ?? '∅'} → ${c.to ?? '∅'}`;
}

/**
 * How a resolved card heads its note: who decided, and whether they edited it on the way through.
 * The user id is shown only when the engine recorded one — an unattributed decision must not be
 * rendered as if somebody signed it.
 */
export function resolutionByline(res: ParsedResolution): string {
  const who = res.resolvedByUserId ?? res.amendedByUserId;
  const verb = res.awaitingSecondApprover
    ? 'Approved (one of two)'
    : res.decision === 'approved'
      ? 'Approved'
      : res.decision === 'rejected'
        ? 'Rejected'
        : 'Resolved';
  const edited = res.amended ? ' with an edit' : '';
  return who ? `${verb}${edited} by ${who}` : `${verb}${edited}`;
}

// ── The engine's operator turn ────────────────────────────────────────────────────────────────

/**
 * The engine writes the operator's words into the thread as a User turn reading
 * `**Rejected.** <reason>`, so the conversation reads the way it happened. The CARD is where the
 * words belong though — a reason only means anything next to the proposal it answers — so the card
 * renders them in full and this recognises the engine's echo, which then renders as a one-line
 * system marker instead of a second copy of the same paragraph.
 *
 * Returns null for an ordinary operator message, which renders as the bubble it has always been.
 */
export interface DecisionEcho {
  /** `Rejected`, `Approved`, `Approved (one of two)` — as the engine wrote it. */
  decision: string;
  /** The words that follow it, which the card is already showing. */
  text: string;
}

const ECHO = /^\*\*(Approved|Rejected)([^*]{0,40}?)\.\*\*\s*([\s\S]*)$/;

export function parseDecisionEcho(turn: SpotAnalysisFollowUpTurnDto): DecisionEcho | null {
  if (turn.role !== 'User') return null;
  const m = ECHO.exec((turn.content ?? '').trim());
  if (!m) return null;
  const text = m[3].trim();
  if (!text) return null;
  return { decision: `${m[1]}${m[2]}`.trim(), text };
}

/** The one line an echoed decision renders as. The words themselves stay on the card. */
export function decisionEchoLine(echo: DecisionEcho): string {
  return `You ${echo.decision.toLowerCase()} this — your note is on the card`;
}
