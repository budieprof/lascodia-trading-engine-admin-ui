import { HttpErrorResponse } from '@angular/common/http';

import { ApiError, type ResponseData } from '@core/api/api.types';

/**
 * The most useful sentence in a failed engine call, for an inline error line.
 *
 * Handles every way a refusal reaches the console: a `ResponseData` with `status: false`
 * (HTTP 200, the engine's usual refusal), an `ApiError` thrown by an envelope unwrap, an
 * `HttpErrorResponse` whose body is itself an envelope or an ASP.NET problem-details object, and
 * plain `Error`s. Falls back to `fallback` so the operator never sees "[object Object]".
 */
export function describeFailure(source: unknown, fallback: string): string {
  if (source instanceof ApiError) return source.message || fallback;
  if (source instanceof HttpErrorResponse) {
    const body = source.error as unknown;
    const fromBody = messageFromBody(body);
    if (fromBody) return fromBody;
    if (source.status === 0) return 'The engine could not be reached.';
    if (source.status === 403) return 'You do not have permission to do this.';
    return source.message ? `${fallback} (HTTP ${source.status})` : fallback;
  }
  const fromBody = messageFromBody(source);
  if (fromBody) return fromBody;
  if (source instanceof Error && source.message) return source.message;
  return fallback;
}

function messageFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' && body.trim() && body.length < 400 ? body.trim() : null;
  }
  const o = body as Record<string, unknown>;
  const message = typeof o['message'] === 'string' ? (o['message'] as string).trim() : '';
  // ASP.NET validation problem-details: { title, errors: { Field: ["…"] } }.
  const errors = o['errors'];
  if (errors && typeof errors === 'object' && !Array.isArray(errors)) {
    const first = Object.values(errors as Record<string, unknown>)
      .flat()
      .find((e): e is string => typeof e === 'string' && e.trim().length > 0);
    if (first) return first;
  }
  if (message && message.toLowerCase() !== 'successful') return message;
  const title = typeof o['title'] === 'string' ? (o['title'] as string).trim() : '';
  return title || null;
}

/**
 * True when an envelope reports success (the engine answers refusals with HTTP 200). The guard
 * narrows to the success shape only, so the `false` branch still sees an envelope it can read
 * `message` / `responseCode` from.
 */
export function isOk<T>(
  res: ResponseData<T> | null | undefined,
): res is ResponseData<T> & { status: true } {
  return !!res && res.status === true;
}
