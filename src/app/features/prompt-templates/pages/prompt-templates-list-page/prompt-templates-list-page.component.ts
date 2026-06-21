import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import {
  ForkPromptTemplateRequest,
  PromptTemplateService,
  PromptTemplateSummary,
} from '@core/services/prompt-template.service';
import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

/**
 * Seeded prompt-template `Name` values. Phase 3 only ships
 * `spot-analysis`, but the dropdown is data-driven so future names get a
 * row added without code changes. Order: most-active first.
 */
const KNOWN_NAMES: string[] = ['spot-analysis'];

/** Default page size for the listing. Kept generous so the operator usually
 *  sees all versions of a single Name on the first page. */
const DEFAULT_PAGE_SIZE = 25;

/**
 * Listing of every {@link PromptTemplate} row, grouped implicitly by `name`
 * via the dropdown filter. Each row exposes view + fork actions; promote
 * and archive are gated on the row's Draft state plus the operator's
 * `prompttemplate.edit` / `.promote` permissions.
 *
 * Active rows render a green left-border accent so the operator's eye
 * lands on "what's live" without reading the IsActive pill.
 */
@Component({
  selector: 'app-prompt-templates-list-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, FormsModule, RouterLink, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Prompt templates"
        subtitle="Versioned LLM system prompts — fork, promote, and diff against the live spot-analysis path."
      />

      <div class="filters">
        <label class="field">
          <span>Name</span>
          <select [(ngModel)]="nameFilter" (ngModelChange)="onFilterChange()">
            @for (n of knownNames; track n) {
              <option [ngValue]="n">{{ n }}</option>
            }
          </select>
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="showArchived" (ngModelChange)="onFilterChange()" />
          <span>Show archived</span>
        </label>
        <button type="button" class="btn-secondary" (click)="refresh()">Refresh</button>
      </div>

      <section class="card">
        @if (loading() && rows().length === 0) {
          <div class="empty">Loading templates…</div>
        } @else if (rows().length === 0) {
          <div class="empty">
            No templates for <strong>{{ nameFilter }}</strong>
            @if (!showArchived) {
              <small class="muted">(toggle "Show archived" to include archived rows)</small>
            }
          </div>
        } @else {
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Created by</th>
                  <th>Created</th>
                  <th>Promoted</th>
                  <th>Archived</th>
                  <th class="num">Length</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.id) {
                  <tr
                    class="tpl-row"
                    [class.tpl-row--active]="row.isActive"
                    [class.tpl-row--archived]="row.isArchived"
                  >
                    <td class="mono">#{{ row.id }}</td>
                    <td class="mono">{{ row.name }}</td>
                    <td class="mono">{{ row.version }}</td>
                    <td>
                      <span
                        class="pill"
                        [class.pill--active]="row.isActive"
                        [class.pill--archived]="row.isArchived"
                        [class.pill--draft]="!row.isActive && !row.isArchived"
                      >
                        {{ statusLabel(row) }}
                      </span>
                    </td>
                    <td class="notes" [title]="row.notes ?? ''">
                      {{ row.notes ? truncate(row.notes, 80) : '—' }}
                    </td>
                    <td>{{ row.createdBy }}</td>
                    <td>{{ row.createdAt | date: 'short' }}</td>
                    <td>
                      {{ row.promotedAt ? (row.promotedAt | date: 'short') : '—' }}
                    </td>
                    <td>
                      {{ row.archivedAt ? (row.archivedAt | date: 'short') : '—' }}
                    </td>
                    <td class="num">
                      {{ row.systemPromptLength }}
                      <button
                        type="button"
                        class="copy-btn"
                        (click)="copyVersionSlug(row, $event)"
                        title="Copy version slug to clipboard"
                        aria-label="Copy version slug"
                      >
                        📋
                      </button>
                    </td>
                    <td class="actions-cell">
                      <a
                        class="btn-secondary btn-small"
                        [routerLink]="['/prompt-templates', row.id]"
                      >
                        View
                      </a>
                      @if (canEdit()) {
                        <button
                          type="button"
                          class="btn-secondary btn-small"
                          (click)="openForkModal(row)"
                        >
                          Fork
                        </button>
                      }
                      @if (canPromote() && isDraft(row)) {
                        <button
                          type="button"
                          class="btn-primary btn-small"
                          (click)="openPromoteModal(row)"
                        >
                          Promote
                        </button>
                      }
                      @if (canEdit() && isDraft(row)) {
                        <button
                          type="button"
                          class="btn-danger btn-small"
                          (click)="openArchiveModal(row)"
                        >
                          Archive
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <div class="pager">
            <button
              type="button"
              class="btn-secondary"
              (click)="prevPage()"
              [disabled]="page() <= 1 || loading()"
            >
              ‹ Prev
            </button>
            <span class="pager-info">
              Page {{ page() }} of {{ totalPages() }} — {{ totalItems() }} row(s)
            </span>
            <button
              type="button"
              class="btn-secondary"
              (click)="nextPage()"
              [disabled]="page() >= totalPages() || loading()"
            >
              Next ›
            </button>
          </div>
        }
      </section>

      <!-- Fork modal ------------------------------------------------------- -->
      @if (forkTarget(); as src) {
        <div class="modal-scrim" (click)="closeForkModal()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <h2>Fork {{ src.name }} / {{ src.version }}</h2>
            </div>
            <div class="modal-body">
              <label class="field">
                <span>New version slug</span>
                <input
                  type="text"
                  [(ngModel)]="forkVersion"
                  placeholder="e.g. {{ src.version }}-v2"
                  maxlength="64"
                  autofocus
                />
              </label>
              <label class="field">
                <span>Notes <small>(optional)</small></span>
                <textarea
                  [(ngModel)]="forkNotes"
                  rows="3"
                  placeholder="What's this fork testing?"
                ></textarea>
              </label>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-secondary" (click)="closeForkModal()">Cancel</button>
              <button
                type="button"
                class="btn-primary"
                (click)="submitFork()"
                [disabled]="!forkVersion.trim() || submitting()"
              >
                @if (submitting()) {
                  Forking…
                } @else {
                  Create fork
                }
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Promote modal --------------------------------------------------- -->
      @if (promoteTarget(); as p) {
        <div class="modal-scrim" (click)="closePromoteModal()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header"><h2>Promote to active?</h2></div>
            <div class="modal-body">
              <p>
                Promoting <strong class="mono">{{ p.name }} / {{ p.version }}</strong> will demote
                the currently-active version to <strong>Archived</strong> and make this one
                <strong>Active</strong>.
              </p>
              <p class="warn">
                Live behaviour will change immediately if <code>UseDbBackedPromptTemplate</code>
                is enabled in engine config.
              </p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-secondary" (click)="closePromoteModal()">
                Cancel
              </button>
              <button
                type="button"
                class="btn-primary"
                (click)="submitPromote()"
                [disabled]="submitting()"
              >
                @if (submitting()) {
                  Promoting…
                } @else {
                  Yes, promote
                }
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Archive modal --------------------------------------------------- -->
      @if (archiveTarget(); as a) {
        <div class="modal-scrim" (click)="closeArchiveModal()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header"><h2>Archive draft?</h2></div>
            <div class="modal-body">
              <p>
                Archiving <strong class="mono">{{ a.name }} / {{ a.version }}</strong>
                moves it to the terminal state — it can't be promoted or edited again. Fork it first
                if you want to keep iterating.
              </p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-secondary" (click)="closeArchiveModal()">
                Cancel
              </button>
              <button
                type="button"
                class="btn-danger"
                (click)="submitArchive()"
                [disabled]="submitting()"
              >
                @if (submitting()) {
                  Archiving…
                } @else {
                  Yes, archive
                }
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-6);
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .filters {
        display: flex;
        gap: 1rem;
        align-items: end;
        flex-wrap: wrap;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
      }
      .field input,
      .field select,
      .field textarea {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.45rem 0.65rem;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .field textarea {
        resize: vertical;
      }
      .chk {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
        cursor: pointer;
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 0.5rem 0.95rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }
      .btn-primary:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      .btn-primary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border);
        padding: 0.4rem 0.8rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        text-decoration: none;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn-secondary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-danger {
        background: #c4290a;
        color: #fff;
        border: none;
        padding: 0.5rem 0.95rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
      }
      .btn-danger:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      .btn-small {
        padding: 0.25rem 0.6rem;
        font-size: 0.78rem;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .empty {
        padding: var(--space-4);
        text-align: center;
        color: var(--text-secondary);
      }
      .empty small {
        display: block;
        margin-top: 0.25rem;
      }
      .muted {
        color: var(--text-secondary);
        font-size: 0.78rem;
      }
      .table-scroll {
        overflow-x: auto;
      }
      .data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .data-table th,
      .data-table td {
        padding: 0.45rem 0.6rem;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .data-table th {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: 600;
      }
      .data-table td.num,
      .data-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .tpl-row {
        position: relative;
      }
      .tpl-row--active td:first-child {
        position: relative;
      }
      .tpl-row--active td:first-child::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        background: #1f8a3d;
        border-radius: 2px;
      }
      .tpl-row--archived td {
        opacity: 0.55;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .notes {
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pill {
        display: inline-block;
        padding: 0.15rem 0.55rem;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .pill--active {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .pill--draft {
        background: rgba(0, 113, 227, 0.16);
        color: #0071e3;
      }
      .pill--archived {
        background: rgba(142, 142, 147, 0.2);
        color: var(--text-secondary);
      }
      .copy-btn {
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 0 0.25rem;
        font-size: 0.85rem;
        margin-left: 0.3rem;
      }
      .copy-btn:hover {
        opacity: 0.7;
      }
      .actions-cell {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        align-items: center;
      }
      .pager {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        padding-top: var(--space-3);
      }
      .pager-info {
        font-size: 0.8rem;
        color: var(--text-secondary);
      }
      .modal-scrim {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: 2rem;
      }
      .modal-card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: min(520px, 100%);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      }
      .modal-header {
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border);
      }
      .modal-header h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      .modal-body {
        padding: 1rem 1.25rem;
        font-size: 0.9rem;
        color: var(--text-secondary);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .modal-body p {
        margin: 0;
      }
      .modal-body .warn {
        color: #b3640a;
        font-size: 0.85rem;
      }
      .modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.75rem 1.25rem;
        border-top: 1px solid var(--border);
      }
      code {
        background: var(--bg-tertiary);
        padding: 0.1rem 0.3rem;
        border-radius: 3px;
        font-size: 0.85em;
      }
    `,
  ],
})
export class PromptTemplatesListPageComponent implements OnInit {
  readonly knownNames = KNOWN_NAMES;

  private readonly svc = inject(PromptTemplateService);
  private readonly notifications = inject(NotificationService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  // ── Filter + paging state ──────────────────────────────────────────────
  nameFilter = KNOWN_NAMES[0];
  showArchived = false;
  readonly page = signal(1);
  readonly pageSize = DEFAULT_PAGE_SIZE;
  readonly rows = signal<PromptTemplateSummary[]>([]);
  readonly totalItems = signal(0);
  readonly loading = signal(false);

  // ── Modal state ────────────────────────────────────────────────────────
  readonly forkTarget = signal<PromptTemplateSummary | null>(null);
  forkVersion = '';
  forkNotes = '';

  readonly promoteTarget = signal<PromptTemplateSummary | null>(null);
  readonly archiveTarget = signal<PromptTemplateSummary | null>(null);
  readonly submitting = signal(false);

  // ── Permission gates (frontend mirror of the backend HasPermission filters) ─
  readonly canEdit = computed(() => this.auth.hasPermission('prompttemplate.edit'));
  readonly canPromote = computed(() => this.auth.hasPermission('prompttemplate.promote'));

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalItems() / this.pageSize)));

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.svc
      .list({
        currentPage: this.page(),
        itemCountPerPage: this.pageSize,
        name: this.nameFilter,
        includeArchived: this.showArchived,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.rows.set(res.data.data ?? []);
          this.totalItems.set(res.data.pager?.totalItemCount ?? 0);
        } else {
          this.rows.set([]);
          this.totalItems.set(0);
          if (res && res.message) {
            this.notifications.error(res.message);
          }
        }
      });
  }

  onFilterChange(): void {
    this.page.set(1);
    this.refresh();
  }

  prevPage(): void {
    if (this.page() > 1) {
      this.page.update((p) => p - 1);
      this.refresh();
    }
  }

  nextPage(): void {
    if (this.page() < this.totalPages()) {
      this.page.update((p) => p + 1);
      this.refresh();
    }
  }

  // ── Status helpers ──────────────────────────────────────────────────────
  isDraft(row: PromptTemplateSummary): boolean {
    return !row.isActive && !row.isArchived;
  }

  statusLabel(row: PromptTemplateSummary): string {
    if (row.isActive) return 'Active';
    if (row.isArchived) return 'Archived';
    return 'Draft';
  }

  truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '…';
  }

  /** Copy the row's `{name}/{version}` slug to the clipboard — handy for
   *  pasting into a backtest `promptVersionOverride` field. */
  copyVersionSlug(row: PromptTemplateSummary, ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    const slug = `${row.name}/${row.version}`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(slug).then(
        () => this.notifications.success(`Copied: ${slug}`),
        () => this.notifications.error('Clipboard copy failed.'),
      );
    } else {
      this.notifications.error('Clipboard API not available.');
    }
  }

  // ── Fork modal ──────────────────────────────────────────────────────────
  openForkModal(row: PromptTemplateSummary): void {
    this.forkTarget.set(row);
    this.forkVersion = `${row.version}-fork`;
    this.forkNotes = '';
  }

  closeForkModal(): void {
    this.forkTarget.set(null);
    this.forkVersion = '';
    this.forkNotes = '';
  }

  submitFork(): void {
    const src = this.forkTarget();
    if (!src) return;
    const newVersion = this.forkVersion?.trim();
    if (!newVersion) return;
    const req: ForkPromptTemplateRequest = {
      fromId: src.id,
      newVersion,
      notes: this.forkNotes?.trim() || null,
    };
    this.submitting.set(true);
    this.svc
      .fork(req)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.submitting.set(false);
        if (res?.status && res.data) {
          this.notifications.success(`Forked → new draft #${res.data}.`);
          this.closeForkModal();
          this.router.navigate(['/prompt-templates', res.data]);
        } else {
          this.notifications.error(res?.message ?? 'Failed to fork template.');
        }
      });
  }

  // ── Promote modal ──────────────────────────────────────────────────────
  openPromoteModal(row: PromptTemplateSummary): void {
    this.promoteTarget.set(row);
  }

  closePromoteModal(): void {
    this.promoteTarget.set(null);
  }

  submitPromote(): void {
    const target = this.promoteTarget();
    if (!target) return;
    this.submitting.set(true);
    this.svc
      .promote(target.id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.submitting.set(false);
        if (res?.status) {
          this.notifications.success(`Promoted #${target.id} to active.`);
          this.closePromoteModal();
          this.refresh();
        } else {
          this.notifications.error(res?.message ?? 'Failed to promote.');
        }
      });
  }

  // ── Archive modal ──────────────────────────────────────────────────────
  openArchiveModal(row: PromptTemplateSummary): void {
    this.archiveTarget.set(row);
  }

  closeArchiveModal(): void {
    this.archiveTarget.set(null);
  }

  submitArchive(): void {
    const target = this.archiveTarget();
    if (!target) return;
    this.submitting.set(true);
    this.svc
      .archive(target.id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.submitting.set(false);
        if (res?.status) {
          this.notifications.success(`Archived #${target.id}.`);
          this.closeArchiveModal();
          this.refresh();
        } else {
          this.notifications.error(res?.message ?? 'Failed to archive.');
        }
      });
  }
}
