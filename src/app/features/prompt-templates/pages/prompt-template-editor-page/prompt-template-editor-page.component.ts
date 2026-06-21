import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import {
  ForkPromptTemplateRequest,
  PromptTemplate,
  PromptTemplateService,
  PromptTemplateSummary,
  UpdatePromptTemplateRequest,
} from '@core/services/prompt-template.service';
import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

interface EditorFormValue {
  systemPrompt: string;
  notes: string | null;
}

/**
 * Editor for a single {@link PromptTemplate} row. Layout:
 *
 *  1. Metadata card — Name/Version, Active/Archived pills, audit metadata
 *     (CreatedBy, CreatedAt, PromotedAt, ArchivedAt, ForkedFromId).
 *  2. State banner — green/red strip when the row is Active or Archived
 *     reminding the operator they must fork before editing.
 *  3. Notes + SystemPrompt textareas — read-only on Active/Archived,
 *     editable on Draft (gated additionally by `prompttemplate.edit`).
 *  4. Action bar — Save (Draft+edit only), Fork, Promote (Draft+promote
 *     only), Archive (Draft+edit only), Diff vs other version (always).
 *
 * Dirty-state tracking uses a `signal()` driven by the form's valueChanges;
 * Save disables when not dirty, and "Discard changes" appears in the action
 * bar.
 */
@Component({
  selector: 'app-prompt-template-editor-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    ReactiveFormsModule,
    RouterLink,
    PageHeaderComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="row()?.name ? row()!.name + ' / ' + row()!.version : 'Prompt template'"
        subtitle="Version-controlled LLM system prompt"
      >
        <a routerLink="/prompt-templates" class="btn-secondary">‹ Back to list</a>
      </app-page-header>

      @if (loading() && !row()) {
        <section class="card empty">Loading template…</section>
      } @else if (!row()) {
        <section class="card empty error">Template not found.</section>
      } @else if (row(); as r) {
        <!-- State banner ------------------------------------------------- -->
        @if (r.isActive) {
          <div class="banner banner--active">
            <strong>Active live template.</strong>
            To edit, <strong>fork</strong> it to a new version first; then promote the fork to
            demote this one to Archived.
          </div>
        } @else if (r.isArchived) {
          <div class="banner banner--archived">
            <strong>Archived.</strong>
            Fork from this row to start a new line. Editing and promotion are disabled.
          </div>
        }

        <!-- Metadata card ------------------------------------------------- -->
        <section class="card meta-card">
          <div class="meta-row">
            <div class="kv">
              <span class="label">Name</span>
              <span class="mono">{{ r.name }}</span>
            </div>
            <div class="kv">
              <span class="label">Version</span>
              <span class="mono">{{ r.version }}</span>
            </div>
            <div class="kv">
              <span class="label">Status</span>
              <span
                class="pill"
                [class.pill--active]="r.isActive"
                [class.pill--archived]="r.isArchived"
                [class.pill--draft]="isDraft(r)"
              >
                {{ statusLabel(r) }}
              </span>
            </div>
            <div class="kv">
              <span class="label">Created by</span>
              <span>{{ r.createdBy }}</span>
            </div>
            <div class="kv">
              <span class="label">Created</span>
              <span>{{ r.createdAt | date: 'medium' }}</span>
            </div>
            <div class="kv">
              <span class="label">Promoted</span>
              <span>{{ r.promotedAt ? (r.promotedAt | date: 'medium') : '—' }}</span>
            </div>
            <div class="kv">
              <span class="label">Archived</span>
              <span>{{ r.archivedAt ? (r.archivedAt | date: 'medium') : '—' }}</span>
            </div>
            <div class="kv">
              <span class="label">Forked from</span>
              @if (r.forkedFromId !== null) {
                <a class="mono" [routerLink]="['/prompt-templates', r.forkedFromId]"
                  >#{{ r.forkedFromId }}</a
                >
              } @else {
                <span>—</span>
              }
            </div>
          </div>
        </section>

        <!-- Editable form ------------------------------------------------- -->
        <form class="card form-card" [formGroup]="form">
          <label class="field">
            <span>Notes</span>
            <textarea
              formControlName="notes"
              rows="2"
              [readonly]="!canEditBody()"
              placeholder="What was the goal of this version?"
            ></textarea>
          </label>

          <label class="field">
            <span>
              System prompt
              <small class="muted">
                ({{ promptLength() }} chars
                @if (dirty()) {
                  · <em>unsaved changes</em>
                }
                )
              </small>
            </span>
            <textarea
              formControlName="systemPrompt"
              class="prompt-editor"
              rows="40"
              [readonly]="!canEditBody()"
              spellcheck="false"
              wrap="off"
            ></textarea>
          </label>
        </form>

        <!-- Action bar ---------------------------------------------------- -->
        <section class="card action-card">
          @if (canEditBody()) {
            <button
              type="button"
              class="btn-primary"
              (click)="save()"
              [disabled]="!dirty() || saving()"
            >
              @if (saving()) {
                Saving…
              } @else {
                Save changes
              }
            </button>
            @if (dirty()) {
              <button
                type="button"
                class="btn-secondary"
                (click)="discardChanges()"
                [disabled]="saving()"
              >
                Discard changes
              </button>
            }
          }

          <button
            type="button"
            class="btn-secondary"
            (click)="openForkModal()"
            [disabled]="!canEdit()"
            [title]="canEdit() ? 'Fork this version' : 'Requires prompttemplate.edit permission'"
          >
            Fork
          </button>

          @if (isDraft(r)) {
            <button
              type="button"
              class="btn-primary"
              (click)="openPromoteModal()"
              [disabled]="!canPromote() || saving()"
              [title]="
                canPromote()
                  ? 'Promote this draft to active'
                  : 'Requires prompttemplate.promote permission'
              "
            >
              Promote
            </button>
            <button
              type="button"
              class="btn-danger"
              (click)="openArchiveModal()"
              [disabled]="!canEdit() || saving()"
            >
              Archive
            </button>
          }

          <button type="button" class="btn-secondary" (click)="openDiffPicker()">
            Diff vs other version
          </button>
        </section>
      }

      <!-- Fork modal ----------------------------------------------------- -->
      @if (forkOpen() && row(); as r) {
        <div class="modal-scrim" (click)="closeForkModal()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <h2>Fork {{ r.name }} / {{ r.version }}</h2>
            </div>
            <div class="modal-body">
              <label class="field">
                <span>New version slug</span>
                <input
                  type="text"
                  [(ngModel)]="forkVersion"
                  [ngModelOptions]="{ standalone: true }"
                  maxlength="64"
                  autofocus
                />
              </label>
              <label class="field">
                <span>Notes <small>(optional)</small></span>
                <textarea
                  [(ngModel)]="forkNotes"
                  [ngModelOptions]="{ standalone: true }"
                  rows="3"
                ></textarea>
              </label>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-secondary" (click)="closeForkModal()">Cancel</button>
              <button
                type="button"
                class="btn-primary"
                (click)="submitFork()"
                [disabled]="!forkVersion.trim() || saving()"
              >
                @if (saving()) {
                  Forking…
                } @else {
                  Create fork
                }
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Promote modal ------------------------------------------------- -->
      @if (promoteOpen() && row(); as r) {
        <div class="modal-scrim" (click)="closePromoteModal()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header"><h2>Promote to active?</h2></div>
            <div class="modal-body">
              <p>
                Promoting <strong class="mono">{{ r.name }} / {{ r.version }}</strong> will demote
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
                [disabled]="saving()"
              >
                @if (saving()) {
                  Promoting…
                } @else {
                  Yes, promote
                }
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Archive modal -------------------------------------------------- -->
      @if (archiveOpen() && row(); as r) {
        <div class="modal-scrim" (click)="closeArchiveModal()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header"><h2>Archive draft?</h2></div>
            <div class="modal-body">
              <p>
                Archiving <strong class="mono">{{ r.name }} / {{ r.version }}</strong>
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
                [disabled]="saving()"
              >
                @if (saving()) {
                  Archiving…
                } @else {
                  Yes, archive
                }
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Diff picker modal --------------------------------------------- -->
      @if (diffPickerOpen()) {
        <div class="modal-scrim" (click)="closeDiffPicker()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header"><h2>Diff against which version?</h2></div>
            <div class="modal-body">
              @if (diffCandidates().length === 0) {
                <p class="muted">
                  No other versions of <strong>{{ row()?.name }}</strong> available.
                </p>
              } @else {
                <ul class="diff-picker-list">
                  @for (cand of diffCandidates(); track cand.id) {
                    <li>
                      <button type="button" class="diff-pick-btn" (click)="navigateToDiff(cand.id)">
                        <span class="mono">#{{ cand.id }} · {{ cand.version }}</span>
                        <span
                          class="pill pill--small"
                          [class.pill--active]="cand.isActive"
                          [class.pill--archived]="cand.isArchived"
                          [class.pill--draft]="isDraftSummary(cand)"
                        >
                          {{ statusLabelSummary(cand) }}
                        </span>
                        <small class="muted">{{ cand.createdAt | date: 'short' }}</small>
                      </button>
                    </li>
                  }
                </ul>
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-secondary" (click)="closeDiffPicker()">Close</button>
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
        gap: var(--space-4);
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 0.55rem 1rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
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
        padding: 0.5rem 0.95rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        text-decoration: none;
        cursor: pointer;
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
        padding: 0.55rem 1rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
      }
      .btn-danger:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      .btn-danger:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .empty {
        text-align: center;
        color: var(--text-secondary);
      }
      .empty.error {
        color: #c4290a;
      }
      .banner {
        padding: 0.75rem 1rem;
        border-radius: var(--radius-md);
        font-size: 0.9rem;
        border: 1px solid;
      }
      .banner--active {
        background: rgba(48, 209, 88, 0.12);
        color: #1f8a3d;
        border-color: rgba(48, 209, 88, 0.3);
      }
      .banner--archived {
        background: rgba(142, 142, 147, 0.16);
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .meta-card {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 1.5rem;
      }
      .kv {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .kv .label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        font-weight: 600;
      }
      .form-card {
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
      }
      .field input,
      .field textarea {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.5rem 0.65rem;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .field textarea {
        resize: vertical;
      }
      .field textarea[readonly] {
        background: var(--bg-tertiary);
        cursor: not-allowed;
      }
      .prompt-editor {
        font-family: var(--font-mono, monospace);
        font-size: 0.82rem;
        line-height: 1.45;
        white-space: pre;
        min-height: 480px;
      }
      .muted {
        color: var(--text-secondary);
      }
      .action-card {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
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
      .pill--small {
        font-size: 0.65rem;
        padding: 0.1rem 0.4rem;
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
      .mono {
        font-family: var(--font-mono, monospace);
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
        width: min(560px, 100%);
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
      .diff-picker-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        max-height: 320px;
        overflow-y: auto;
      }
      .diff-pick-btn {
        width: 100%;
        text-align: left;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        color: var(--text-primary);
        padding: 0.5rem 0.75rem;
        border-radius: var(--radius-sm);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        font-size: 0.85rem;
      }
      .diff-pick-btn:hover {
        background: var(--bg-tertiary);
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
export class PromptTemplateEditorPageComponent implements OnInit {
  private readonly svc = inject(PromptTemplateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly notifications = inject(NotificationService);
  private readonly auth = inject(AuthService);

  // ── State ──────────────────────────────────────────────────────────────
  readonly id = signal<number | null>(null);
  readonly row = signal<PromptTemplate | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly dirty = signal(false);

  // Original server-side values used for the dirty-check + "discard" reset.
  private originalPrompt = '';
  private originalNotes: string | null = null;

  // ── Modal state ────────────────────────────────────────────────────────
  readonly forkOpen = signal(false);
  forkVersion = '';
  forkNotes = '';

  readonly promoteOpen = signal(false);
  readonly archiveOpen = signal(false);

  readonly diffPickerOpen = signal(false);
  readonly diffCandidates = signal<PromptTemplateSummary[]>([]);

  // ── Permissions ────────────────────────────────────────────────────────
  readonly canEdit = computed(() => this.auth.hasPermission('prompttemplate.edit'));
  readonly canPromote = computed(() => this.auth.hasPermission('prompttemplate.promote'));
  /** True when the body / notes textareas should be editable. */
  readonly canEditBody = computed(() => {
    const r = this.row();
    if (!r) return false;
    if (!this.canEdit()) return false;
    return this.isDraft(r);
  });

  readonly promptLength = computed(() => {
    const v = (this.form?.value as Partial<EditorFormValue>)?.systemPrompt;
    return v?.length ?? 0;
  });

  // ── Form ──────────────────────────────────────────────────────────────
  readonly form: FormGroup;
  readonly promptControl: FormControl<string>;
  readonly notesControl: FormControl<string | null>;

  constructor() {
    this.promptControl = new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    });
    this.notesControl = new FormControl<string | null>(null);
    this.form = this.fb.group({
      systemPrompt: this.promptControl,
      notes: this.notesControl,
    });

    this.form.valueChanges.subscribe(() => {
      this.recomputeDirty();
    });
  }

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isFinite(id) || id <= 0) {
      this.notifications.error('Invalid prompt template id.');
      this.router.navigate(['/prompt-templates']);
      return;
    }
    this.id.set(id);
    this.fetchRow();
  }

  private fetchRow(): void {
    const id = this.id();
    if (id == null) return;
    this.loading.set(true);
    this.svc
      .get(id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.row.set(res.data);
          this.originalPrompt = res.data.systemPrompt;
          this.originalNotes = res.data.notes;
          this.form.setValue(
            {
              systemPrompt: res.data.systemPrompt,
              notes: res.data.notes,
            },
            { emitEvent: false },
          );
          this.dirty.set(false);
          // Lock the form for active/archived rows (matches `canEditBody`
          // visual but actually disables the control too).
          if (!this.canEditBody()) {
            this.form.disable({ emitEvent: false });
          } else {
            this.form.enable({ emitEvent: false });
          }
        } else if (res) {
          this.notifications.error(res.message ?? 'Failed to load template.');
        }
      });
  }

  private recomputeDirty(): void {
    const v = this.form.value as EditorFormValue;
    const same =
      (v.systemPrompt ?? '') === (this.originalPrompt ?? '') &&
      (v.notes ?? null) === (this.originalNotes ?? null);
    this.dirty.set(!same);
  }

  discardChanges(): void {
    this.form.setValue(
      { systemPrompt: this.originalPrompt, notes: this.originalNotes },
      { emitEvent: false },
    );
    this.dirty.set(false);
  }

  save(): void {
    const r = this.row();
    if (!r || !this.canEditBody() || !this.dirty()) return;
    const v = this.form.value as EditorFormValue;
    const body: UpdatePromptTemplateRequest = {
      systemPrompt: v.systemPrompt,
      notes: v.notes?.trim() || null,
    };
    this.saving.set(true);
    this.svc
      .update(r.id, body)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.saving.set(false);
        if (res?.status) {
          this.notifications.success('Saved.');
          this.originalPrompt = body.systemPrompt;
          this.originalNotes = body.notes ?? null;
          this.dirty.set(false);
        } else {
          this.notifications.error(res?.message ?? 'Save failed.');
        }
      });
  }

  // ── Status helpers ─────────────────────────────────────────────────────
  isDraft(r: PromptTemplate): boolean {
    return !r.isActive && !r.isArchived;
  }

  isDraftSummary(r: PromptTemplateSummary): boolean {
    return !r.isActive && !r.isArchived;
  }

  statusLabel(r: PromptTemplate): string {
    if (r.isActive) return 'Active';
    if (r.isArchived) return 'Archived';
    return 'Draft';
  }

  statusLabelSummary(r: PromptTemplateSummary): string {
    if (r.isActive) return 'Active';
    if (r.isArchived) return 'Archived';
    return 'Draft';
  }

  // ── Fork modal ─────────────────────────────────────────────────────────
  openForkModal(): void {
    const r = this.row();
    if (!r) return;
    this.forkVersion = `${r.version}-fork`;
    this.forkNotes = '';
    this.forkOpen.set(true);
  }

  closeForkModal(): void {
    this.forkOpen.set(false);
  }

  submitFork(): void {
    const r = this.row();
    if (!r) return;
    const newVersion = this.forkVersion?.trim();
    if (!newVersion) return;
    const req: ForkPromptTemplateRequest = {
      fromId: r.id,
      newVersion,
      notes: this.forkNotes?.trim() || null,
    };
    this.saving.set(true);
    this.svc
      .fork(req)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.saving.set(false);
        if (res?.status && res.data) {
          this.notifications.success(`Forked → new draft #${res.data}.`);
          this.closeForkModal();
          this.router.navigate(['/prompt-templates', res.data]);
        } else {
          this.notifications.error(res?.message ?? 'Fork failed.');
        }
      });
  }

  // ── Promote modal ─────────────────────────────────────────────────────
  openPromoteModal(): void {
    this.promoteOpen.set(true);
  }

  closePromoteModal(): void {
    this.promoteOpen.set(false);
  }

  submitPromote(): void {
    const r = this.row();
    if (!r) return;
    this.saving.set(true);
    this.svc
      .promote(r.id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.saving.set(false);
        if (res?.status) {
          this.notifications.success(`Promoted #${r.id} to active.`);
          this.closePromoteModal();
          this.fetchRow();
        } else {
          this.notifications.error(res?.message ?? 'Promote failed.');
        }
      });
  }

  // ── Archive modal ─────────────────────────────────────────────────────
  openArchiveModal(): void {
    this.archiveOpen.set(true);
  }

  closeArchiveModal(): void {
    this.archiveOpen.set(false);
  }

  submitArchive(): void {
    const r = this.row();
    if (!r) return;
    this.saving.set(true);
    this.svc
      .archive(r.id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.saving.set(false);
        if (res?.status) {
          this.notifications.success(`Archived #${r.id}.`);
          this.closeArchiveModal();
          this.fetchRow();
        } else {
          this.notifications.error(res?.message ?? 'Archive failed.');
        }
      });
  }

  // ── Diff picker ──────────────────────────────────────────────────────
  openDiffPicker(): void {
    const r = this.row();
    if (!r) return;
    // Fetch all rows for this Name (including archived so the picker is
    // exhaustive) and filter out self.
    this.svc
      .list({
        currentPage: 1,
        itemCountPerPage: 50,
        name: r.name,
        includeArchived: true,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.status && res.data) {
          const others = (res.data.data ?? []).filter((x) => x.id !== r.id);
          this.diffCandidates.set(others);
        } else {
          this.diffCandidates.set([]);
        }
        this.diffPickerOpen.set(true);
      });
  }

  closeDiffPicker(): void {
    this.diffPickerOpen.set(false);
  }

  navigateToDiff(otherId: number): void {
    const r = this.row();
    if (!r) return;
    this.closeDiffPicker();
    this.router.navigate(['/prompt-templates', 'diff'], {
      queryParams: { left: r.id, right: otherId },
    });
  }
}
