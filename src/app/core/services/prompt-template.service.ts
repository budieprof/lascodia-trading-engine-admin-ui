import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { PagedData, ResponseData } from '@core/api/api.types';

// ──────────────────────────────────────────────────────────────────────────
// Wire-format DTOs — mirror the C# DTOs under
// `LascodiaTradingEngine.Application.PromptTemplates.*`. Field casing is
// camelCase to match the engine's JsonSerializer config (PascalCase on the
// server side, lowercase-first on the wire).
//
// All long timestamps are ISO-8601 UTC strings (engine emits DateTime values
// in `O` format) — the UI parses them with `new Date()` / `DatePipe` rather
// than carrying a Date through the typed layer.
// ──────────────────────────────────────────────────────────────────────────

/** Full prompt template — used by the editor + diff surfaces. Carries the
 *  full `systemPrompt` body which can be 20-60KB. */
export interface PromptTemplate {
  id: number;
  /** Logical group (e.g. `spot-analysis`). */
  name: string;
  /** Operator-supplied version label (free-form; unique within `name`). */
  version: string;
  /** Full system prompt body. */
  systemPrompt: string;
  /** Active flag — at most one per `name`. */
  isActive: boolean;
  /** Archived flag — terminal state for demoted versions. */
  isArchived: boolean;
  notes: string | null;
  /** Operator username who created the row. */
  createdBy: string;
  /** ISO UTC. */
  createdAt: string;
  /** ISO UTC, null until promoted. */
  promotedAt: string | null;
  /** ISO UTC, null until archived. */
  archivedAt: string | null;
  /** Id of the ancestor row this was forked from. */
  forkedFromId: number | null;
}

/** Listing-page row — strips the `systemPrompt` body for payload size and
 *  replaces it with `systemPromptLength` (chars). */
export interface PromptTemplateSummary {
  id: number;
  name: string;
  version: string;
  systemPromptLength: number;
  isActive: boolean;
  isArchived: boolean;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  promotedAt: string | null;
  archivedAt: string | null;
  forkedFromId: number | null;
}

/** Body for `POST /prompt-template/list`. */
export interface PromptTemplatesListRequest {
  currentPage?: number;
  itemCountPerPage?: number;
  /** Exact match, case-insensitive. */
  name?: string | null;
  /** When false (default) hides archived rows. */
  includeArchived?: boolean;
}

/** Body for `POST /prompt-template/fork`. */
export interface ForkPromptTemplateRequest {
  fromId: number;
  /** Free-form, unique within the source row's `name`. */
  newVersion: string;
  notes?: string | null;
}

/** Body for `POST /prompt-template/{id}` (update). */
export interface UpdatePromptTemplateRequest {
  /** Full replacement system prompt body. */
  systemPrompt: string;
  notes?: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────

/**
 * Data-access client for `/prompt-template/*`. Mirrors the
 * `HttpClient.post<ResponseData<T>>(...)` + raw-envelope pattern used by
 * `llm-backtest.service.ts` — callers branch on `res.status` / `res.message`
 * rather than relying on a global envelope-unwrap interceptor.
 *
 * Backs three pages:
 *  - prompt-templates-list-page (list + fork + promote + archive)
 *  - prompt-template-editor-page (get + update + fork + promote + archive)
 *  - prompt-template-diff-page (two `get` calls for the diff sides)
 */
@Injectable({ providedIn: 'root' })
export class PromptTemplateService {
  private readonly api = inject(ApiService);

  /** Single row by id — drives the editor + diff pages. */
  get(id: number): Observable<ResponseData<PromptTemplate>> {
    return this.api.get(`/prompt-template/${id}`);
  }

  /** Paged list of rows. */
  list(
    req: PromptTemplatesListRequest,
  ): Observable<ResponseData<PagedData<PromptTemplateSummary>>> {
    return this.api.post(`/prompt-template/list`, req);
  }

  /** Resolve the currently-live row for a `name`. */
  getActive(name: string): Observable<ResponseData<PromptTemplate>> {
    return this.api.get(`/prompt-template/active?name=${encodeURIComponent(name)}`);
  }

  /** Fork a row into a new draft. Returns the new row's id. */
  fork(req: ForkPromptTemplateRequest): Observable<ResponseData<number>> {
    return this.api.post(`/prompt-template/fork`, req);
  }

  /** Update the editable fields of a draft row. Server returns `true` on success. */
  update(id: number, body: UpdatePromptTemplateRequest): Observable<ResponseData<boolean>> {
    return this.api.post(`/prompt-template/${id}`, body);
  }

  /** Promote a draft row to live; auto-archives the previously-active row. */
  promote(id: number): Observable<ResponseData<boolean>> {
    return this.api.post(`/prompt-template/${id}/promote`, {});
  }

  /** Soft-archive a draft row. */
  archive(id: number): Observable<ResponseData<boolean>> {
    return this.api.post(`/prompt-template/${id}/archive`, {});
  }
}
