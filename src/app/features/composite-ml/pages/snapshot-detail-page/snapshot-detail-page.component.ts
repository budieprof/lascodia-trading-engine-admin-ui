import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of, switchMap } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import type { CompositeMLPolicySnapshotStatus, PolicyLineageDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type LineageResult =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'loaded'; data: PolicyLineageDto };

@Component({
  selector: 'app-snapshot-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    PageHeaderComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'CompositeML — Snapshot #' + (snapshotId() ?? '?')"
        subtitle="Ancestry chain — newest at top, walking back via priorSnapshotId"
      >
        <a routerLink="/composite-ml" class="btn btn-secondary">← Active Policies</a>
      </app-page-header>

      @switch (result()?.state) {
        @case ('loading') {
          <app-card-skeleton [lines]="8" />
        }
        @case ('error') {
          <app-error-state
            title="Could not load lineage"
            [message]="result()!.state === 'error' ? errorMessage() : ''"
            (retry)="refresh()"
          />
        }
        @case ('loaded') {
          @if (loadedData()) {
            <section class="meta-row">
              <span class="meta">
                <strong>{{ loadedData()!.chainLength }}</strong> node{{
                  loadedData()!.chainLength === 1 ? '' : 's'
                }}
                in chain
              </span>
              @if (loadedData()!.truncatedByDepth) {
                <span class="warn-pill">Truncated by depth — call with larger maxDepth</span>
              }
            </section>

            <ol class="timeline">
              @for (node of loadedData()!.chain; track node.id) {
                <li class="node" [class.focus]="node.depth === 0">
                  <span class="node-dot" [attr.data-status]="statusKey(node.status)"></span>
                  <article class="node-body">
                    <header class="node-head">
                      <span class="node-id">
                        @if (node.depth === 0) {
                          <strong>#{{ node.id }}</strong>
                          <span class="badge focus-badge">this snapshot</span>
                        } @else {
                          <a [routerLink]="['/composite-ml/snapshot', node.id]">#{{ node.id }}</a>
                          <span class="badge depth-badge">depth {{ node.depth }}</span>
                        }
                        <span class="status-pill" [attr.data-status]="statusKey(node.status)">
                          {{ node.status }}
                        </span>
                      </span>
                      @if (node.depth !== 0 && snapshotId() !== null) {
                        <a
                          class="diff-action"
                          [routerLink]="['/composite-ml/diff']"
                          [queryParams]="{ fromId: node.id, toId: snapshotId() }"
                          [title]="'Diff #' + node.id + ' → #' + snapshotId()"
                        >
                          Diff vs focus →
                        </a>
                      }
                    </header>

                    <dl class="node-grid">
                      <div>
                        <dt>Trainer</dt>
                        <dd>
                          @if (node.trainer) {
                            <span class="mono">{{ node.trainer }}</span>
                          } @else {
                            <span class="muted">—</span>
                          }
                        </dd>
                      </div>
                      <div>
                        <dt>Outcome</dt>
                        <dd class="mono small">{{ node.evaluationOutcome }}</dd>
                      </div>
                      <div>
                        <dt>Activated</dt>
                        <dd>
                          @if (node.activatedAtUtc) {
                            <span [title]="node.activatedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                              {{ node.activatedAtUtc | relativeTime }}
                            </span>
                          } @else {
                            <span class="muted">never activated</span>
                          }
                        </dd>
                      </div>
                      <div>
                        <dt>Retired</dt>
                        <dd>
                          @if (node.retiredAtUtc) {
                            <span [title]="node.retiredAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                              {{ node.retiredAtUtc | relativeTime }}
                            </span>
                          } @else {
                            <span class="muted">still active</span>
                          }
                        </dd>
                      </div>
                    </dl>

                    @if (node.policyKnobDeltaJson) {
                      <details>
                        <summary>Delta JSON</summary>
                        <pre class="delta-json">{{ formatJson(node.policyKnobDeltaJson) }}</pre>
                      </details>
                    }
                  </article>
                </li>
              }
            </ol>
          } @else {
            <app-empty-state
              title="Snapshot not found"
              description="The snapshot id was not found, or its lineage is empty."
            />
          }
        }
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .meta-row {
        display: flex;
        gap: var(--space-3);
        align-items: center;
      }
      .meta {
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .meta strong {
        color: var(--text-primary);
      }
      .warn-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 4px 10px;
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
        border-radius: var(--radius-full);
      }
      .timeline {
        list-style: none;
        padding: 0;
        margin: 0;
        position: relative;
      }
      .timeline::before {
        content: '';
        position: absolute;
        top: 12px;
        bottom: 12px;
        left: 7px;
        width: 2px;
        background: var(--border);
      }
      .node {
        display: grid;
        grid-template-columns: 16px 1fr;
        gap: var(--space-4);
        padding-bottom: var(--space-4);
        position: relative;
      }
      .node-dot {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--bg-primary);
        border: 3px solid var(--border);
        margin-top: 6px;
        z-index: 1;
      }
      .node.focus .node-dot {
        border-color: var(--accent);
        background: var(--accent);
      }
      .node-dot[data-status='active'] {
        border-color: #34c759;
      }
      .node-dot[data-status='retired'] {
        border-color: #8e8e93;
      }
      .node-dot[data-status='candidate'] {
        border-color: #0071e3;
      }
      .node-dot[data-status='rejected'] {
        border-color: #ff3b30;
      }
      .node-body {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .node.focus .node-body {
        border-color: var(--accent);
        box-shadow: var(--shadow-md);
      }
      .node-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
        flex-wrap: wrap;
      }
      .node-id {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: var(--text-base);
      }
      .node-id strong,
      .node-id a {
        font-family: var(--font-mono);
        font-weight: var(--font-semibold);
      }
      .node-id a {
        color: var(--accent);
        text-decoration: none;
      }
      .node-id a:hover {
        text-decoration: underline;
      }
      .badge {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        padding: 2px 8px;
        border-radius: var(--radius-full);
      }
      .focus-badge {
        background: var(--accent);
        color: #fff;
      }
      .depth-badge {
        background: var(--bg-primary);
        color: var(--text-secondary);
      }
      .status-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .status-pill[data-status='active'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .status-pill[data-status='retired'] {
        background: rgba(142, 142, 147, 0.16);
        color: #636366;
      }
      .status-pill[data-status='candidate'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .status-pill[data-status='rejected'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .diff-action {
        font-size: var(--text-sm);
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-medium);
      }
      .diff-action:hover {
        text-decoration: underline;
      }
      .node-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .node-grid > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .node-grid dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .node-grid dd {
        margin: 0;
        font-size: var(--text-sm);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .mono.small {
        font-size: 0.9em;
      }
      .muted {
        color: var(--text-tertiary);
      }
      details {
        margin-top: var(--space-3);
      }
      summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        user-select: none;
      }
      summary:hover {
        color: var(--text-primary);
      }
      .delta-json {
        background: var(--bg-primary);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-family: var(--font-mono);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 320px;
        overflow: auto;
        color: var(--text-secondary);
        margin-top: var(--space-2);
      }
    `,
  ],
})
export class SnapshotDetailPageComponent {
  private readonly compositeMl = inject(CompositeMLService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly snapshotId = toSignal(
    this.route.paramMap.pipe(map((p) => parseId(p.get('id')))),
    { initialValue: null },
  );

  private readonly _refreshTick = signal(0);

  protected readonly result = toSignal(
    this.route.paramMap.pipe(
      switchMap((p): ReturnType<typeof this.fetchFor> => {
        // Trip when refresh signal changes too; switchMap re-fires on paramMap
        // only, so we read _refreshTick inside.
        this._refreshTick();
        const id = parseId(p.get('id'));
        return this.fetchFor(id);
      }),
    ),
    { initialValue: { state: 'loading' } as LineageResult },
  );

  protected readonly loadedData = computed(() => {
    const r = this.result();
    return r?.state === 'loaded' ? r.data : null;
  });

  protected readonly errorMessage = computed(() => {
    const r = this.result();
    return r?.state === 'error' ? r.message : '';
  });

  refresh(): void {
    this._refreshTick.update((n) => n + 1);
    // Re-trigger paramMap by re-navigating to the same URL with a noop
    // queryParam toggle. Simpler: just reload current route.
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { _r: Date.now() },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected statusKey(s: CompositeMLPolicySnapshotStatus): string {
    return s.toLowerCase();
  }

  protected formatJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  private fetchFor(id: number | null) {
    if (id === null) {
      return of<LineageResult>({ state: 'error', message: 'Invalid snapshot id' });
    }
    return this.compositeMl.getPolicyLineage(id).pipe(
      map((res): LineageResult => {
        if (!res.status || !res.data) {
          return { state: 'error', message: res.message ?? 'Snapshot not found' };
        }
        return { state: 'loaded', data: res.data };
      }),
      catchError(() =>
        of<LineageResult>({
          state: 'error',
          message: 'Engine returned an error fetching lineage.',
        }),
      ),
    );
  }
}

function parseId(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
