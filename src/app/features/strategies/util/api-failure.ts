import { HttpErrorResponse } from '@angular/common/http';

/**
 * The reasons the engine gave for refusing a write, in operator-readable form.
 *
 * The engine answers a refused write in three shapes, and the strategy pages
 * used to report all of them as "Failed to update strategy" — or, for the
 * first, as success:
 *
 *  1. HTTP 200 with `ResponseData { status: false, message, responseCode }` —
 *     handler rejections such as a duplicate, an immutable field or invalid DSL.
 *  2. HTTP 400 with the same envelope — FluentValidation failures (messages
 *     joined into one string).
 *  3. HTTP 400 with `{ title, errors: { Field: [messages] } }` — the MVC
 *     exception filter's shape.
 */
export function failureMessages(err: unknown, fallback: string): string[] {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return ['The engine could not be reached — check the connection.'];
    const fromBody = messagesFromBody(err.error);
    if (fromBody.length > 0) return fromBody;
    if (err.status === 403) return ['You do not have permission to do this.'];
    return [fallback];
  }
  const fromBody = messagesFromBody(err);
  return fromBody.length > 0 ? fromBody : [fallback];
}

export function failureMessage(err: unknown, fallback: string): string {
  return failureMessages(err, fallback).join(' · ');
}

/** True for an envelope that reports success. */
export function isOk(res: { status?: boolean } | null | undefined): boolean {
  return !!res && res.status === true;
}

function messagesFromBody(body: unknown): string[] {
  if (typeof body === 'string') return body.trim() ? [body.trim()] : [];
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const out: string[] = [];

  const errors = b['errors'];
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (typeof e === 'string') out.push(e);
      else if (e && typeof e === 'object') {
        const msg = (e as Record<string, unknown>)['message'];
        const path = (e as Record<string, unknown>)['path'];
        if (typeof msg === 'string')
          out.push(typeof path === 'string' && path ? `${path}: ${msg}` : msg);
      }
    }
  } else if (errors && typeof errors === 'object') {
    for (const [field, msgs] of Object.entries(errors as Record<string, unknown>)) {
      const list = Array.isArray(msgs) ? msgs : [msgs];
      for (const m of list) if (typeof m === 'string') out.push(field ? `${field}: ${m}` : m);
    }
  }
  if (out.length > 0) return out;

  const message = b['message'] ?? b['detail'] ?? b['title'];
  if (typeof message === 'string' && message.trim()) out.push(message.trim());
  return out;
}
