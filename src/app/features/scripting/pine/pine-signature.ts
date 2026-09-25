import type { PineCatalogOverload, ScriptExportDto } from '@core/api/scripting.types';
import { resolvePinePath, type PineResolveEnv, type PineResolved } from './pine-resolve';
import {
  findCallContext,
  splitTopLevel,
  type PineFunctionSymbol,
  type PineParam,
} from './pine-scan';

export interface SignatureParamView {
  name: string;
  type?: string;
  optional?: boolean;
  defaultText?: string;
  doc?: string;
}

export interface SignatureOverloadView {
  /** What the call reads as: `ta.ema`, `arr.push`, `Point.new`. */
  label: string;
  params: SignatureParamView[];
  returns?: string;
  variadic?: boolean;
}

export interface SignatureHelpInfo {
  callee: string;
  overloads: SignatureOverloadView[];
  /** Index of the overload that fits the arguments written so far. */
  activeOverload: number;
  /** Index into the active overload's params; -1 when the cursor is past them. */
  activeParam: number;
  argIndex: number;
  namedArg: string | null;
  doc: string | null;
  /** `openParen` offset of the call — tooltips anchor there. */
  openParen: number;
}

function fromCatalogOverload(
  label: string,
  o: PineCatalogOverload,
  dropReceiver: boolean,
): SignatureOverloadView {
  const params = (dropReceiver ? o.params.slice(1) : o.params).map((p) => ({
    name: p.name,
    ...(p.type ? { type: p.type } : {}),
    ...(p.optional ? { optional: true } : {}),
    ...(p.defaultText ? { defaultText: p.defaultText } : {}),
    ...(p.doc ? { doc: p.doc } : {}),
  }));
  return {
    label,
    params,
    ...(o.returns ? { returns: o.returns } : {}),
    ...(o.variadic ? { variadic: true } : {}),
  };
}

function fromUserFunction(
  label: string,
  fn: PineFunctionSymbol,
  dropReceiver: boolean,
): SignatureOverloadView {
  const params = (dropReceiver ? fn.params.slice(1) : fn.params).map((p: PineParam) => ({
    name: p.name,
    ...(p.type ? { type: p.type } : {}),
    ...(p.defaultText ? { defaultText: p.defaultText, optional: true } : {}),
    ...(fn.paramDocs?.[p.name] ? { doc: fn.paramDocs[p.name] } : {}),
  }));
  return { label, params };
}

/** Parses a library export's display signature, e.g. `midpoint(float a, float b) → float`. */
export function parseExportSignature(
  exp: ScriptExportDto,
  label: string,
): SignatureOverloadView | null {
  const sig = exp.signature ?? '';
  const open = sig.indexOf('(');
  const close = sig.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const inner = sig.slice(open + 1, close);
  const params = inner.trim()
    ? splitTopLevel(inner).map(({ text }) => {
        const [decl, def] = text.split('=').map((s) => s.trim());
        const parts = decl.split(/\s+/);
        const name = parts.pop() ?? decl;
        const type = parts.join(' ');
        return {
          name,
          ...(type ? { type } : {}),
          ...(def ? { defaultText: def, optional: true } : {}),
        };
      })
    : [];
  const ret = /(?:→|->)\s*(.+)$/.exec(sig.slice(close + 1));
  return { label, params, ...(ret ? { returns: ret[1].trim() } : {}) };
}

/** The overload views for a resolved callee. */
export function overloadsFor(
  resolved: PineResolved,
  calleeText: string,
): { overloads: SignatureOverloadView[]; doc: string | null } {
  switch (resolved.kind) {
    case 'builtin-function':
      return {
        overloads: resolved.fn.overloads.map((o) => fromCatalogOverload(resolved.path, o, false)),
        doc: resolved.fn.doc ?? null,
      };
    case 'builtin-method': {
      const overloads: SignatureOverloadView[] = [];
      for (const fn of resolved.fns) {
        for (const o of fn.overloads) {
          if (o.method === false) continue;
          overloads.push(fromCatalogOverload(calleeText, o, true));
        }
      }
      return { overloads, doc: resolved.fns[0]?.doc ?? null };
    }
    case 'user-function':
      return {
        overloads: [fromUserFunction(resolved.fn.name, resolved.fn, false)],
        doc: resolved.fn.doc ?? null,
      };
    case 'user-method':
      return {
        overloads: resolved.methods.map((m) => fromUserFunction(calleeText, m, true)),
        doc: resolved.methods[0]?.doc ?? null,
      };
    case 'user-type':
      if (resolved.ctor === 'new') {
        return {
          overloads: [
            {
              label: `${resolved.type.name}.new`,
              params: resolved.type.fields.map((f) => ({
                name: f.name,
                ...(f.type ? { type: f.type } : {}),
                optional: true,
                ...(f.defaultText ? { defaultText: f.defaultText } : {}),
                ...(f.doc ? { doc: f.doc } : {}),
              })),
              returns: resolved.type.name,
            },
          ],
          doc: resolved.type.doc ?? null,
        };
      }
      return { overloads: [], doc: null };
    case 'library-export': {
      const view = parseExportSignature(resolved.exported, calleeText);
      return { overloads: view ? [view] : [], doc: resolved.exported.doc ?? null };
    }
    default:
      return { overloads: [], doc: null };
  }
}

/**
 * Signature help for the call around `offset`: every overload of the callee, the one that fits
 * the arguments written so far, and the parameter the cursor is on (by position, or by name for
 * `name = value` arguments).
 */
export function signatureHelpAt(
  env: Omit<PineResolveEnv, 'line'>,
  masked: string,
  offset: number,
  line: number,
): SignatureHelpInfo | null {
  const ctx = findCallContext(masked, offset);
  if (!ctx) return null;
  const resolved = resolvePinePath(ctx.callee, { ...env, line }, true);
  if (!resolved) return null;
  const { overloads, doc } = overloadsFor(resolved, ctx.callee);
  if (overloads.length === 0) return null;

  let activeOverload = 0;
  let activeParam = -1;
  if (ctx.namedArg) {
    const i = overloads.findIndex((o) => o.params.some((p) => p.name === ctx.namedArg));
    if (i >= 0) {
      activeOverload = i;
      activeParam = overloads[i].params.findIndex((p) => p.name === ctx.namedArg);
    }
  } else {
    const fits = (o: SignatureOverloadView) =>
      (o.variadic || o.params.length > ctx.argIndex) &&
      ctx.usedNamedArgs.every((n) => o.params.some((p) => p.name === n));
    const i = overloads.findIndex(fits);
    activeOverload = i >= 0 ? i : 0;
    const o = overloads[activeOverload];
    activeParam =
      ctx.argIndex < o.params.length ? ctx.argIndex : o.variadic ? o.params.length - 1 : -1;
  }
  return {
    callee: ctx.callee,
    overloads,
    activeOverload,
    activeParam,
    argIndex: ctx.argIndex,
    namedArg: ctx.namedArg,
    doc,
    openParen: ctx.openParen,
  };
}

/** `ta.ema(source, length) → series float` */
export function formatOverload(o: SignatureOverloadView): string {
  const params = o.params.map((p) => p.name).join(', ');
  return `${o.label}(${params}${o.variadic ? ', …' : ''})${o.returns ? ` → ${o.returns}` : ''}`;
}
