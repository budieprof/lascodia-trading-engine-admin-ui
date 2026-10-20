import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { TableSkeletonComponent } from '@shared/components/feedback/table-skeleton.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

import { AuditLogService } from '../../audit-log.service';
import {
  AUDIT_ACTION_AREAS,
  AUDIT_TIME_RANGES,
  DEFAULT_AUDIT_FILTERS,
  type AuditFilters,
  actorLabel,
  aggregateCount,
  activeAuditFilterCount,
  auditJsonDiff,
  auditQueryParams,
  outcomeTone,
  resourceLabel,
  validateAuditFilters,
  verificationBadge,
} from '../../audit-log.filters';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  type AuditChainVerification,
  type AuditEventDto,
} from '../../audit-log.types';

/** Events re-hashed by the automatic check when the page opens. */
const RECENT_VERIFY_ROWS = 5000;

/**
 * `/admin/audit` — the unified audit log (multi-tenancy Phase 1, F1.5). Read-only: filter, page back
 * through history newest first, open an event to see who/where/what with the before/after diff, export
 * the filtered events as JSON Lines, and check the hash chain. Route and sidebar entry are gated by
 * `audit.read`; the engine enforces the same key.
 */
@Component({
  selector: 'app-audit-log-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DatePipe,
    DecimalPipe,
    JsonPipe,
    PageHeaderComponent,
    RefreshButtonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    TableSkeletonComponent,
    ModalA11yDirective,
  ],
  templateUrl: './audit-log-page.component.html',
  styleUrl: './audit-log-page.component.scss',
})
export class AuditLogPageComponent {
  private readonly audit = inject(AuditLogService);
  private readonly notify = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly timeRanges = AUDIT_TIME_RANGES;
  protected readonly actionAreas = AUDIT_ACTION_AREAS;
  protected readonly actorTypes = AUDIT_ACTOR_TYPES;
  protected readonly categories = AUDIT_CATEGORIES;
  protected readonly outcomes = AUDIT_OUTCOMES;
  protected readonly actorLabel = actorLabel;
  protected readonly resourceLabel = resourceLabel;
  protected readonly outcomeTone = outcomeTone;
  protected readonly aggregateCount = aggregateCount;

  /** The form being edited; applied on submit. */
  protected draft: AuditFilters = { ...DEFAULT_AUDIT_FILTERS };
  protected readonly applied = signal<AuditFilters>({ ...DEFAULT_AUDIT_FILTERS });
  protected readonly filterProblem = signal<string | null>(null);
  protected readonly activeFilters = computed(() => activeAuditFilterCount(this.applied()));

  protected readonly items = signal<AuditEventDto[]>([]);
  protected readonly nextBeforeId = signal<number | null>(null);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly loadError = signal<string | null>(null);

  protected readonly selected = signal<AuditEventDto | null>(null);
  protected readonly showRaw = signal(false);
  protected readonly diffRows = computed(() => {
    const e = this.selected();
    return e ? auditJsonDiff(e.before, e.after) : [];
  });

  protected readonly verification = signal<AuditChainVerification | null>(null);
  protected readonly verifyScope = signal('the newest events');
  protected readonly verifying = signal(false);
  protected readonly verifyProgress = signal(0);
  protected readonly badge = computed(() =>
    verificationBadge(this.verification(), this.verifyScope(), this.verifying()),
  );

  protected readonly exporting = signal(false);

  /** Guards against a slow earlier load overwriting a newer one. */
  private loadSeq = 0;
  /** The query of the rows on screen, so "Load older" pages the same filters at the same instant. */
  private shownParams: Record<string, string> = {};

  constructor() {
    this.reload();
    void this.verifyRecent();
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  protected apply(): void {
    const problem = validateAuditFilters(this.draft);
    this.filterProblem.set(problem);
    if (problem) return;
    this.applied.set({ ...this.draft });
    this.reload();
  }

  protected reset(): void {
    this.draft = { ...DEFAULT_AUDIT_FILTERS };
    this.filterProblem.set(null);
    this.applied.set({ ...DEFAULT_AUDIT_FILTERS });
    this.reload();
  }

  /** Clicking an actor, action or resource in the drawer narrows the list to it. */
  protected filterBy(field: 'actor' | 'action' | 'resource', e: AuditEventDto): void {
    if (field === 'actor') this.draft = { ...this.draft, actor: e.actorId };
    if (field === 'action') this.draft = { ...this.draft, action: e.action };
    if (field === 'resource') {
      this.draft = { ...this.draft, resourceType: e.resourceType ?? '', resourceId: e.resourceId ?? '' };
    }
    this.close();
    this.apply();
  }

  // ── List ─────────────────────────────────────────────────────────────────

  protected reload(): void {
    const seq = ++this.loadSeq;
    this.shownParams = auditQueryParams(this.applied(), new Date());
    this.loading.set(true);
    this.loadError.set(null);
    this.audit
      .list(this.shownParams)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          if (seq !== this.loadSeq) return;
          this.items.set(page.items);
          this.nextBeforeId.set(page.nextBeforeId);
          this.hasMore.set(page.hasMore);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          if (seq !== this.loadSeq) return;
          this.loadError.set(messageOf(err, 'The audit log could not be loaded.'));
          this.loading.set(false);
        },
      });
  }

  protected loadOlder(): void {
    const cursor = this.nextBeforeId();
    if (cursor === null || this.loadingMore()) return;
    const seq = this.loadSeq;
    this.loadingMore.set(true);
    this.audit
      .list(this.shownParams, cursor)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          this.loadingMore.set(false);
          if (seq !== this.loadSeq) return;
          this.items.update((rows) => [...rows, ...page.items]);
          this.nextBeforeId.set(page.nextBeforeId);
          this.hasMore.set(page.hasMore);
        },
        error: (err: unknown) => {
          this.loadingMore.set(false);
          this.notify.error(messageOf(err, 'Older events could not be loaded.'));
        },
      });
  }

  // ── Detail drawer ────────────────────────────────────────────────────────

  protected open(e: AuditEventDto): void {
    this.showRaw.set(false);
    this.selected.set(e);
  }

  protected close(): void {
    this.selected.set(null);
  }

  /** A click on the dimmed backdrop (not inside the drawer) closes it. */
  protected onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }

  // ── Export ───────────────────────────────────────────────────────────────

  protected async exportCurrent(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      const file = await firstValueFrom(this.audit.export(auditQueryParams(this.applied(), new Date())));
      saveFile(file.blob, file.fileName);
      const lines = await countLines(file.blob);
      if (file.limit !== null && lines >= file.limit) {
        this.notify.warning(
          `Exported the first ${file.limit.toLocaleString('en-US')} events (the most one export holds). Narrow the time range for the rest.`,
        );
      } else {
        this.notify.success(`Exported ${lines.toLocaleString('en-US')} events.`);
      }
    } catch (err: unknown) {
      this.notify.error(messageOf(err, 'The export failed.'));
    } finally {
      this.exporting.set(false);
    }
  }

  // ── Chain verification ───────────────────────────────────────────────────

  /** On open: re-hash the newest events (cheap, and the part most worth checking often). */
  private async verifyRecent(): Promise<void> {
    this.verifying.set(true);
    this.verifyScope.set(`the newest ${RECENT_VERIFY_ROWS.toLocaleString('en-US')} events`);
    try {
      const newest = await firstValueFrom(this.audit.list({}, null, 1));
      const newestId = newest.items[0]?.id ?? null;
      const fromId = newestId === null ? null : Math.max(1, newestId - RECENT_VERIFY_ROWS + 1);
      this.verification.set(await firstValueFrom(this.audit.verify(fromId, null, RECENT_VERIFY_ROWS)));
    } catch {
      // The badge stays "Not verified"; the operator can run the full check.
      this.verification.set(null);
    } finally {
      this.verifying.set(false);
    }
  }

  /** The whole log, in slices, until it ends or a link breaks. */
  protected async verifyAll(): Promise<void> {
    if (this.verifying()) return;
    this.verifying.set(true);
    this.verifyScope.set('the whole log');
    this.verifyProgress.set(0);
    let fromId: number | null = null;
    let checked = 0;
    let sealed = 0;
    try {
      for (;;) {
        const slice: AuditChainVerification = await firstValueFrom(this.audit.verify(fromId));
        checked += slice.rowsChecked;
        sealed += slice.sealedRowsVerified;
        this.verifyProgress.set(checked);
        if (!slice.intact || !slice.truncated || slice.nextFromId === null) {
          this.verification.set({ ...slice, rowsChecked: checked, sealedRowsVerified: sealed });
          break;
        }
        fromId = slice.nextFromId;
      }
    } catch (err: unknown) {
      this.notify.error(messageOf(err, 'Chain verification could not run.'));
    } finally {
      this.verifying.set(false);
    }
  }
}

function messageOf(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const message = (err as { message: string }).message;
    return message.startsWith('Http failure') ? fallback : message;
  }
  return fallback;
}

function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function countLines(blob: Blob): Promise<number> {
  const text = await blob.text();
  return text.split('\n').filter((line) => line.trim() !== '').length;
}
