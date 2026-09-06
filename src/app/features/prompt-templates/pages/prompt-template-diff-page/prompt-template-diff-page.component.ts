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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, forkJoin, of } from 'rxjs';

import {
  PromptTemplate,
  PromptTemplateService,
  PromptTemplateSummary,
} from '@core/services/prompt-template.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { lineDiff, LineDiffResult } from '../../utils/line-diff.util';

/**
 * Side-by-side diff page comparing two {@link PromptTemplate} rows. URL:
 * `/prompt-templates/diff?left={id}&right={id}`. Both ids are required;
 * missing or invalid params surface an explicit error rather than
 * defaulting to "diff against active" — the operator launches the diff
 * intentionally from the editor and we want the URL to be unambiguous.
 *
 * Rendering choice: a unified diff (single column) rather than two-pane.
 * For prompt bodies that often run several hundred lines, the unified
 * view fits more context per screen and matches how operators read
 * `git diff` output. Lines unchanged are rendered grey, removed-from-left
 * red (`-` prefix), added-on-right green (`+` prefix). Monospace font;
 * the LCS algorithm lives in `utils/line-diff.util.ts` (no NPM dep).
 */
@Component({
  selector: 'app-prompt-template-diff-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, FormsModule, RouterLink, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Diff prompt templates"
        subtitle="Unified line-level diff of two SystemPrompt bodies"
      >
        <a routerLink="/prompt-templates" class="btn-secondary">‹ Back to list</a>
      </app-page-header>

      <!-- Picker: direct navigation without ?left=&right= used to render a
           red developer message. Now the operator chooses both sides here
           (defaults: active version vs. the most recent other version). -->
      @if (needsPick()) {
        <section class="card picker">
          <h3 class="picker-title">Choose two versions to compare</h3>
          @if (pickerLoading()) {
            <p class="muted">Loading versions…</p>
          } @else if (pickerRows().length < 2) {
            <p class="muted">
              Fewer than two versions exist for <span class="mono">{{ pickerName }}</span> — fork
              one from the list first.
            </p>
          } @else {
            <div class="picker-grid">
              <label class="picker-field">
                <span class="side-label" style="color:#c4290a">Baseline (left)</span>
                <select [(ngModel)]="pickLeft">
                  @for (t of pickerRows(); track t.id) {
                    <option [ngValue]="t.id">
                      #{{ t.id }} · {{ t.version }} · {{ statusLabelSummary(t) }}
                    </option>
                  }
                </select>
              </label>
              <label class="picker-field">
                <span class="side-label" style="color:#1f8a3d">Candidate (right)</span>
                <select [(ngModel)]="pickRight">
                  @for (t of pickerRows(); track t.id) {
                    <option [ngValue]="t.id">
                      #{{ t.id }} · {{ t.version }} · {{ statusLabelSummary(t) }}
                    </option>
                  }
                </select>
              </label>
            </div>
            @if (pickLeft !== null && pickLeft === pickRight) {
              <p class="muted">Pick two different versions.</p>
            }
            <div class="picker-actions">
              <button
                type="button"
                class="btn-primary"
                [disabled]="pickLeft === null || pickRight === null || pickLeft === pickRight"
                (click)="applyPick()"
              >
                Compare
              </button>
            </div>
          }
        </section>
      } @else if (loading()) {
        <section class="card empty">Loading both prompts…</section>
      } @else if (errorMessage(); as err) {
        <section class="card empty error">
          {{ err }}
          <div class="picker-actions">
            <button type="button" class="btn-secondary" (click)="needsPick.set(true)">
              Choose versions
            </button>
          </div>
        </section>
      } @else if (left() && right()) {
        <!-- Header: side-by-side metadata --------------------------------- -->
        <section class="card header-card">
          @if (left(); as l) {
            <div class="side side--left">
              <div class="side-label">Baseline (left)</div>
              <div class="side-title">
                <a [routerLink]="['/prompt-templates', l.id]" class="mono">
                  {{ l.name }} / {{ l.version }}
                </a>
                <span
                  class="pill"
                  [class.pill--active]="l.isActive"
                  [class.pill--archived]="l.isArchived"
                  [class.pill--draft]="isDraft(l)"
                >
                  {{ statusLabel(l) }}
                </span>
              </div>
              <div class="side-meta">
                <span>By {{ l.createdBy }}</span>
                <span>{{ l.createdAt | date: 'short' }}</span>
                @if (l.forkedFromId !== null) {
                  <a [routerLink]="['/prompt-templates', l.forkedFromId]">
                    ← from #{{ l.forkedFromId }}
                  </a>
                }
              </div>
            </div>
          }

          @if (right(); as r) {
            <div class="side side--right">
              <div class="side-label">Candidate (right)</div>
              <div class="side-title">
                <a [routerLink]="['/prompt-templates', r.id]" class="mono">
                  {{ r.name }} / {{ r.version }}
                </a>
                <span
                  class="pill"
                  [class.pill--active]="r.isActive"
                  [class.pill--archived]="r.isArchived"
                  [class.pill--draft]="isDraft(r)"
                >
                  {{ statusLabel(r) }}
                </span>
              </div>
              <div class="side-meta">
                <span>By {{ r.createdBy }}</span>
                <span>{{ r.createdAt | date: 'short' }}</span>
                @if (r.forkedFromId !== null) {
                  <a [routerLink]="['/prompt-templates', r.forkedFromId]">
                    ← from #{{ r.forkedFromId }}
                  </a>
                }
              </div>
            </div>
          }
        </section>

        <!-- Diff stats --------------------------------------------------- -->
        @if (diff(); as d) {
          <div class="stats-row">
            <span class="stat-pill stat-pill--add">+{{ d.stats.added }} added</span>
            <span class="stat-pill stat-pill--remove">−{{ d.stats.removed }} removed</span>
            <span class="stat-pill stat-pill--equal">={{ d.stats.unchanged }} unchanged</span>
          </div>

          <section class="card diff-card">
            <div class="diff-scroll">
              <table class="diff-table">
                <tbody>
                  @for (row of d.rows; track $index) {
                    <tr
                      [class.row--equal]="row.kind === 'equal'"
                      [class.row--add]="row.kind === 'add'"
                      [class.row--remove]="row.kind === 'remove'"
                    >
                      <td class="line-num left">
                        {{ row.leftLineNumber ?? '' }}
                      </td>
                      <td class="line-num right">
                        {{ row.rightLineNumber ?? '' }}
                      </td>
                      <td class="prefix">
                        @switch (row.kind) {
                          @case ('add') {
                            +
                          }
                          @case ('remove') {
                            -
                          }
                          @default {
                            &nbsp;
                          }
                        }
                      </td>
                      <td class="line-text">{{ row.text }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
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
      .btn-secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border);
        padding: 0.45rem 0.85rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        text-decoration: none;
        cursor: pointer;
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
      .empty.error {
        color: #c4290a;
      }
      .picker-title {
        margin: 0 0 var(--space-3);
        font-size: 1rem;
      }
      .picker-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      @media (max-width: 800px) {
        .picker-grid {
          grid-template-columns: 1fr;
        }
      }
      .picker-field {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .picker-field select {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.5rem 0.65rem;
        font: inherit;
      }
      .picker-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: var(--space-3);
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border: 1px solid var(--accent);
        padding: 0.45rem 0.85rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
      }
      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .muted {
        color: var(--text-secondary);
        font-size: 0.85rem;
      }
      .header-card {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      @media (max-width: 800px) {
        .header-card {
          grid-template-columns: 1fr;
        }
      }
      .side {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .side-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: 700;
        color: var(--text-secondary);
      }
      .side--left .side-label {
        color: #c4290a;
      }
      .side--right .side-label {
        color: #1f8a3d;
      }
      .side-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .side-title a {
        color: var(--text-primary);
        text-decoration: none;
        font-weight: 600;
      }
      .side-title a:hover {
        text-decoration: underline;
      }
      .side-meta {
        display: flex;
        gap: 1rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
        flex-wrap: wrap;
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
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .stats-row {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .stat-pill {
        display: inline-block;
        padding: 0.25rem 0.75rem;
        border-radius: 999px;
        font-size: 0.78rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .stat-pill--add {
        background: rgba(48, 209, 88, 0.16);
        color: #1f8a3d;
      }
      .stat-pill--remove {
        background: rgba(196, 41, 10, 0.16);
        color: #c4290a;
      }
      .stat-pill--equal {
        background: rgba(142, 142, 147, 0.18);
        color: var(--text-secondary);
      }

      .diff-card {
        padding: 0;
      }
      .diff-scroll {
        overflow-x: auto;
        max-height: 75vh;
        overflow-y: auto;
      }
      .diff-table {
        width: 100%;
        border-collapse: collapse;
        font-family: var(--font-mono, monospace);
        font-size: 0.78rem;
        line-height: 1.45;
      }
      .diff-table td {
        padding: 0 0.5rem;
        white-space: pre;
        vertical-align: top;
      }
      .line-num {
        width: 3.25rem;
        text-align: right;
        color: var(--text-tertiary, var(--text-secondary));
        user-select: none;
        background: var(--bg-tertiary);
        padding-right: 0.55rem !important;
        padding-left: 0.55rem !important;
        border-right: 1px solid var(--border);
        font-size: 0.7rem;
      }
      .prefix {
        width: 1rem;
        text-align: center;
        font-weight: 700;
        user-select: none;
        opacity: 0.7;
      }
      .line-text {
        font-family: inherit;
      }
      .row--equal td {
        color: var(--text-primary);
      }
      .row--equal .line-text {
        opacity: 0.85;
      }
      .row--add {
        background: rgba(48, 209, 88, 0.1);
      }
      .row--add .prefix,
      .row--add .line-text {
        color: #1f8a3d;
      }
      .row--remove {
        background: rgba(196, 41, 10, 0.1);
      }
      .row--remove .prefix,
      .row--remove .line-text {
        color: #c4290a;
      }
    `,
  ],
})
export class PromptTemplateDiffPageComponent implements OnInit {
  private readonly svc = inject(PromptTemplateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);

  readonly left = signal<PromptTemplate | null>(null);
  readonly right = signal<PromptTemplate | null>(null);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);

  /** Memoised diff computation. Recomputes whenever either side changes —
   *  small LCS over a 1-3k-line input takes single-digit ms in V8 so we
   *  don't memo against the raw strings explicitly. */
  readonly diff = computed<LineDiffResult | null>(() => {
    const l = this.left();
    const r = this.right();
    if (!l || !r) return null;
    return lineDiff(l.systemPrompt, r.systemPrompt);
  });

  // ── Version picker (shown when the URL carries no valid pair) ─────────
  readonly needsPick = signal(false);
  readonly pickerLoading = signal(false);
  readonly pickerRows = signal<PromptTemplateSummary[]>([]);
  /** Logical prompt group to list; `?name=` overrides the default. */
  pickerName = 'spot-analysis';
  pickLeft: number | null = null;
  pickRight: number | null = null;

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    const leftRaw = q.get('left');
    const rightRaw = q.get('right');
    const leftId = Number(leftRaw);
    const rightId = Number(rightRaw);
    if (!Number.isFinite(leftId) || !Number.isFinite(rightId) || leftId <= 0 || rightId <= 0) {
      this.pickerName = q.get('name') ?? this.pickerName;
      this.openPicker();
      return;
    }
    if (leftId === rightId) {
      this.errorMessage.set('Cannot diff a template against itself.');
      return;
    }
    this.fetchBoth(leftId, rightId);
  }

  private openPicker(): void {
    this.needsPick.set(true);
    this.pickerLoading.set(true);
    this.svc
      .list({ currentPage: 1, itemCountPerPage: 100, name: this.pickerName, includeArchived: true })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.pickerLoading.set(false);
        const rows = [...(res?.data?.data ?? [])].sort((a, b) => b.id - a.id);
        this.pickerRows.set(rows);
        // Sensible default: the live version on the left, newest other version on the right.
        const active = rows.find((r) => r.isActive) ?? rows[1] ?? null;
        const other = rows.find((r) => r.id !== active?.id) ?? null;
        this.pickLeft = active?.id ?? null;
        this.pickRight = other?.id ?? null;
      });
  }

  applyPick(): void {
    if (this.pickLeft === null || this.pickRight === null || this.pickLeft === this.pickRight)
      return;
    this.needsPick.set(false);
    this.errorMessage.set(null);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { left: this.pickLeft, right: this.pickRight },
      replaceUrl: true,
    });
    this.fetchBoth(this.pickLeft, this.pickRight);
  }

  statusLabelSummary(r: PromptTemplateSummary): string {
    if (r.isActive) return 'Active';
    if (r.isArchived) return 'Archived';
    return 'Draft';
  }

  private fetchBoth(leftId: number, rightId: number): void {
    this.loading.set(true);
    forkJoin({
      l: this.svc.get(leftId).pipe(catchError(() => of(null))),
      r: this.svc.get(rightId).pipe(catchError(() => of(null))),
    }).subscribe(({ l, r }) => {
      this.loading.set(false);
      const okLeft = l?.status && l.data;
      const okRight = r?.status && r.data;
      if (!okLeft && !okRight) {
        this.errorMessage.set('404 — neither prompt template was found.');
        return;
      }
      if (!okLeft) {
        this.errorMessage.set(`404 — left template (#${leftId}) not found.`);
        return;
      }
      if (!okRight) {
        this.errorMessage.set(`404 — right template (#${rightId}) not found.`);
        return;
      }
      this.left.set(l!.data!);
      this.right.set(r!.data!);
    });
  }

  isDraft(r: PromptTemplate): boolean {
    return !r.isActive && !r.isArchived;
  }

  statusLabel(r: PromptTemplate): string {
    if (r.isActive) return 'Active';
    if (r.isArchived) return 'Archived';
    return 'Draft';
  }
}
