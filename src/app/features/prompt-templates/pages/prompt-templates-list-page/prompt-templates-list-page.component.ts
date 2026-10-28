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
import { Subscription, catchError, of } from 'rxjs';

import {
  ForkPromptTemplateRequest,
  PromptTemplateService,
  PromptTemplateSummary,
} from '@core/services/prompt-template.service';
import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import {
  FeatureRequirement,
  FeatureStateComponent,
} from '@shared/components/feedback/feature-state.component';
import { PromptTemplateStatus } from '@core/services/prompt-template.service';
import { defaultDiffPair, templateCounts, versionEvents } from '../../utils/prompt-templates.logic';

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
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    RefreshButtonComponent,
    ModalA11yDirective,
    MetricCardComponent,
    FeatureStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Prompt templates"
        subtitle="Versioned LLM system prompts — fork, promote, and diff against the live spot-analysis path."
      >
        @if (diffPair(); as d) {
          <a
            class="btn-secondary"
            routerLink="/prompt-templates/diff"
            [queryParams]="{ left: d.left, right: d.right }"
            >Diff active vs previous</a
          >
        }
      </app-page-header>

      <div class="kpi-strip">
        <app-metric-card
          label="Live prompt comes from"
          [value]="null"
          [displayValue]="liveSourceText()"
          [dotColor]="status()?.liveSource === 'database' ? '#34C759' : '#FF9500'"
        />
        <app-metric-card
          label="Active version"
          [value]="null"
          [displayValue]="counts().active ? '#' + counts().active!.id : 'none'"
          dotColor="#0071E3"
        />
        <app-metric-card
          label="Versions · drafts · archived"
          [value]="null"
          [displayValue]="counts().versions + ' · ' + counts().drafts + ' · ' + counts().archived"
          dotColor="#5AC8FA"
        />
        <app-metric-card
          label="Spot-analysis calls (7d · 30d)"
          [value]="null"
          [displayValue]="
            status() ? status()!.callsLast7Days + ' · ' + status()!.callsLast30Days : '—'
          "
          dotColor="#AF52DE"
        />
        <app-metric-card
          label="Last live call"
          [value]="null"
          [displayValue]="lastCallText()"
          dotColor="#8E8E93"
        />
      </div>

      <app-feature-state
        title="Database-backed prompt"
        summary="This table versions the system prompt sent with every spot analysis. It only becomes the LIVE prompt when the switch below is on — otherwise the engine sends the prompt built into its code, and the table is a reviewed reference copy you can fork, diff and backtest."
        [kind]="status()?.useDbBackedPromptTemplate ? 'on' : 'off'"
        [stateLabel]="
          status()
            ? status()!.useDbBackedPromptTemplate
              ? 'Live from table'
              : 'Reference only'
            : null
        "
        switchKey="Llm:UseDbBackedPromptTemplate"
        [detail]="stateDetail()"
        [requirements]="requirements()"
        [links]="[
          { label: 'LLM settings', route: '/llm/settings' },
          { label: 'LLM backtests (try a version)', route: '/llm-backtest/new' },
          { label: 'Spot analysis report', route: '/spot-analysis' },
        ]"
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
        <!-- The old plain button gave no sign a click did anything: an unchanged list
             re-rendered identically. The shared button stays busy until the fetch lands. -->
        <app-refresh-button variant="outline" [refreshing]="loading()" (refresh)="refresh()" />
      </div>

      <div class="layout">
        <section class="card">
          @if (loading() && rows().length === 0) {
            <div class="empty">Loading templates…</div>
          } @else if (loadError() && rows().length === 0) {
            <div class="empty load-error" role="alert">{{ loadError() }}</div>
          } @else if (rows().length === 0) {
            <div class="empty">
              No templates for <strong>{{ nameFilter }}</strong>
              @if (!showArchived) {
                <small class="muted">(toggle "Show archived" to include archived rows)</small>
              }
            </div>
          } @else {
            @if (loadError(); as err) {
              <p class="load-error inline" role="alert">
                {{ err }} — showing the last list that loaded.
              </p>
            }
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
                      <td class="mono nowrap">{{ row.name }}</td>
                      <td class="mono version" [title]="row.version">{{ row.version }}</td>
                      <td>
                        <span
                          class="pill"
                          [class.pill--active]="row.isActive && !isNotLive(row)"
                          [class.pill--not-live]="row.isActive && isNotLive(row)"
                          [class.pill--archived]="row.isArchived"
                          [class.pill--draft]="!row.isActive && !row.isArchived"
                          [title]="
                            isNotLive(row)
                              ? 'Active in the DB, but not the live prompt while UseDbBackedPromptTemplate = false'
                              : ''
                          "
                        >
                          {{ statusLabel(row) }}
                        </span>
                      </td>
                      <td class="notes" [title]="row.notes ?? ''">
                        {{ row.notes ? truncate(row.notes, 80) : '—' }}
                      </td>
                      <td class="nowrap">{{ row.createdBy }}</td>
                      <td class="nowrap">{{ row.createdAt | date: 'yyyy-MM-dd HH:mm' }}</td>
                      <td class="nowrap">
                        {{ row.promotedAt ? (row.promotedAt | date: 'yyyy-MM-dd HH:mm') : '—' }}
                      </td>
                      <td class="nowrap">
                        {{ row.archivedAt ? (row.archivedAt | date: 'yyyy-MM-dd HH:mm') : '—' }}
                      </td>
                      <td class="num nowrap">
                        {{ row.systemPromptLength | number }}
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
                        <div class="actions-inner">
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
                        </div>
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

        <aside class="card history">
          <header class="history-head">
            <h3>Version history</h3>
            <span class="muted">{{ events().length }} change(s)</span>
          </header>
          @if (events().length === 0) {
            <p class="muted history-empty">No versions recorded for {{ nameFilter }}.</p>
          } @else {
            <ol class="history-list">
              @for (e of events(); track $index) {
                <li [attr.data-kind]="e.kind">
                  <span class="h-dot" aria-hidden="true"></span>
                  <div>
                    <a [routerLink]="['/prompt-templates', e.id]" class="mono">#{{ e.id }}</a>
                    <span class="h-text">{{ e.text }}</span>
                    <div class="muted h-meta" [title]="e.version">
                      {{ e.at | date: 'MMM d y, HH:mm' }} · {{ e.version }}
                    </div>
                  </div>
                </li>
              }
            </ol>
          }
        </aside>
      </div>

      <!-- Fork modal ------------------------------------------------------- -->
      @if (forkTarget(); as src) {
        <div class="modal-scrim" (click)="closeForkModal()">
          <div
            class="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fork-title"
            appModalA11y
            (dismiss)="closeForkModal()"
            (click)="$event.stopPropagation()"
          >
            <div class="modal-header">
              <h2 id="fork-title">
                Fork <span class="mono">{{ src.name }}</span> /
                <span class="mono">{{ src.version }}</span>
              </h2>
              <button
                type="button"
                class="modal-close"
                (click)="closeForkModal()"
                aria-label="Close"
              >
                ×
              </button>
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
          <div
            class="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="promote-title"
            appModalA11y
            (dismiss)="closePromoteModal()"
            (click)="$event.stopPropagation()"
          >
            <div class="modal-header"><h2 id="promote-title">Promote to active?</h2></div>
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
              <button
                type="button"
                class="btn-secondary"
                (click)="closePromoteModal()"
                data-autofocus
              >
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
          <div
            class="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-title"
            appModalA11y
            (dismiss)="closeArchiveModal()"
            (click)="$event.stopPropagation()"
          >
            <div class="modal-header"><h2 id="archive-title">Archive draft?</h2></div>
            <div class="modal-body">
              <p>
                Archiving <strong class="mono">{{ a.name }} / {{ a.version }}</strong>
                moves it to the terminal state — it can't be promoted or edited again. Fork it first
                if you want to keep iterating.
              </p>
            </div>
            <div class="modal-footer">
              <button
                type="button"
                class="btn-secondary"
                (click)="closeArchiveModal()"
                data-autofocus
              >
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
      .load-error {
        color: var(--loss);
      }
      .load-error.inline {
        margin: 0 0 var(--space-3);
        font-size: 0.85rem;
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
        white-space: nowrap;
      }
      .data-table .nowrap {
        white-space: nowrap;
      }
      /* Version slugs run long ("spot-analysis-v4-survivability-…"): one line,
         ellipsis, full value in the title tooltip. */
      .data-table .version {
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
      /* Not the pinned action cell: a translucent sticky cell lets the columns
         scrolling underneath show through it. */
      .tpl-row--archived td:not(.actions-cell) {
        opacity: 0.55;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .notes {
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pill {
        display: inline-block;
        white-space: nowrap;
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
      /* Active row whose notes flag it as not consulted by the live path:
         neither the green of "live" nor the blue of "draft". */
      .pill--not-live {
        background: rgba(255, 149, 0, 0.16);
        color: var(--warning, #b3640a);
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
      /* Eleven columns outgrow the card at 1440px (the "ACTIVE (NOT LIVE)" pill
         wrapped to three lines and the View / Fork buttons sat past the right edge
         of the scroller). Keep the actions pinned to the visible right edge. The
         flex box lives on an inner div: display:flex on the <td> took it out of
         table layout. */
      .actions-cell,
      .data-table th:last-child {
        position: sticky;
        right: 0;
        background: var(--bg-secondary);
      }
      .actions-cell {
        box-shadow: -10px 0 10px -10px rgba(0, 0, 0, 0.45);
      }
      .actions-inner {
        display: flex;
        flex-wrap: nowrap;
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
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border);
      }
      .modal-header h2 {
        margin: 0;
        font-size: 1.05rem;
        overflow-wrap: anywhere;
      }
      .modal-close {
        flex: none;
        background: transparent;
        border: 0;
        font-size: 1.4rem;
        line-height: 1;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 0 0.25rem;
      }
      .modal-close:hover {
        color: var(--text-primary);
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
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: var(--space-3, 0.75rem);
      }
      @media (max-width: 1100px) {
        .kpi-strip {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 320px;
        gap: 1rem;
        align-items: start;
      }
      @media (max-width: 1100px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
      .history {
        padding: 0;
      }
      .history-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--border);
      }
      .history-head h3 {
        margin: 0;
        font-size: 0.95rem;
      }
      .history-empty {
        padding: 0.75rem 1rem;
        margin: 0;
      }
      .history-list {
        list-style: none;
        margin: 0;
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
        font-size: 0.85rem;
      }
      .history-list li {
        display: grid;
        grid-template-columns: 10px minmax(0, 1fr);
        gap: 0.5rem;
      }
      .h-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-top: 5px;
        background: var(--text-tertiary);
      }
      li[data-kind='promoted'] .h-dot {
        background: var(--profit);
      }
      li[data-kind='archived'] .h-dot {
        background: var(--loss);
      }
      li[data-kind='forked'] .h-dot {
        background: var(--accent);
      }
      .h-text {
        margin-left: 0.35rem;
      }
      .h-meta {
        font-size: 0.75rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .history-list a {
        color: var(--accent);
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
  /** On by default: with one active row and the rest archived, hiding archived showed a one-row table. */
  showArchived = true;
  readonly page = signal(1);
  readonly pageSize = DEFAULT_PAGE_SIZE;
  readonly rows = signal<PromptTemplateSummary[]>([]);
  readonly totalItems = signal(0);
  readonly loading = signal(false);
  /** Why the latest list call failed (null = it succeeded). */
  readonly loadError = signal<string | null>(null);
  private listSub: Subscription | null = null;

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

  /** Every version of the selected name (archived included) — feeds the tiles and the history. */
  readonly allRows = signal<PromptTemplateSummary[]>([]);
  readonly status = signal<PromptTemplateStatus | null>(null);
  readonly counts = computed(() => templateCounts(this.allRows()));
  readonly events = computed(() => versionEvents(this.allRows()));
  readonly diffPair = computed(() => defaultDiffPair(this.allRows()));

  readonly liveSourceText = computed(() => {
    const st = this.status();
    if (st) return st.liveSource === 'database' ? `table (#${st.activeId})` : 'built-in code';
    // Older engine: all that is known is the active row's own "NOT LIVE" note.
    const a = this.counts().active;
    return a && this.isNotLive(a) ? 'built-in code (per note)' : 'unknown';
  });

  readonly lastCallText = computed(() => {
    const at = this.status()?.lastCallAt;
    if (!at) return this.status() ? 'never' : '—';
    const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
    return days <= 0 ? 'today' : `${days} day(s) ago`;
  });

  readonly stateDetail = computed(() => {
    const st = this.status();
    if (!st) return null;
    const parts = [
      st.useDbBackedPromptTemplate
        ? `The active row (#${st.activeId}, ${st.activeVersion}) is sent with every spot analysis.`
        : 'Editing or promoting a row changes nothing live until the switch is turned on; prompt changes ship through code review and a deploy.',
      `${st.callsAllTime.toLocaleString()} live spot-analysis call(s) so far` +
        (st.lastCallAt
          ? `, the last on ${new Date(st.lastCallAt).toUTCString().slice(5, 16)}`
          : '') +
        `; ${st.backtestCallsAllTime.toLocaleString()} backtest call(s) — backtests can try any version.`,
    ];
    if (st.callsLast7Days === 0)
      parts.push(
        'No live spot analysis ran this week: the scheduled worker and SpotSweep are deliberately off, so only analyses started by hand use this prompt.',
      );
    return parts.join(' ');
  });

  readonly requirements = computed<FeatureRequirement[]>(() => {
    const st = this.status();
    const c = this.counts();
    return [
      {
        label: 'An active version exists',
        ok: c.active != null,
        detail: c.active
          ? `#${c.active.id} ${c.active.version}`
          : 'promote a draft to make one active',
      },
      {
        label: 'Llm:UseDbBackedPromptTemplate is on',
        ok: st ? st.useDbBackedPromptTemplate : null,
        detail: st
          ? st.useDbBackedPromptTemplate
            ? 'the table is the live prompt'
            : 'off — operator decision 2026-09-02: prompt changes go through code review + deploy'
          : 'not reported by this engine build',
        route: '/llm/settings',
      },
    ];
  });

  private loadOverview(): void {
    this.svc
      .list({ currentPage: 1, itemCountPerPage: 50, name: this.nameFilter, includeArchived: true })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => this.allRows.set(res?.status ? (res.data?.data ?? []) : []));
    this.svc
      .status(this.nameFilter)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => this.status.set(res?.status ? res.data : null));
  }

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalItems() / this.pageSize)));

  ngOnInit(): void {
    this.refresh();
    this.loadOverview();
  }

  refresh(): void {
    // A newer request (filter, page, Refresh) supersedes one still in flight, so a slow
    // earlier reply can never land last and repaint the wrong page.
    this.listSub?.unsubscribe();
    this.loading.set(true);
    this.listSub = this.svc
      .list({
        currentPage: this.page(),
        itemCountPerPage: this.pageSize,
        name: this.nameFilter,
        includeArchived: this.showArchived,
      })
      .subscribe({
        next: (res) => {
          this.loading.set(false);
          if (res?.status && res.data) {
            this.rows.set(res.data.data ?? []);
            this.totalItems.set(res.data.pager?.totalItemCount ?? 0);
            this.loadError.set(null);
          } else {
            // The engine answered and refused: there is no current list to show.
            this.rows.set([]);
            this.totalItems.set(0);
            this.loadError.set(res?.message || 'The engine refused the template list.');
          }
        },
        error: (err: { status?: number; error?: { message?: string } } | null) => {
          this.loading.set(false);
          // A transport failure used to clear the table and read "No templates for
          // spot-analysis" over rows that exist. Keep the last list and say why.
          this.loadError.set(
            err?.error?.message ??
              (err?.status === 0
                ? 'The engine could not be reached.'
                : `Could not load templates (HTTP ${err?.status ?? '?'}).`),
          );
        },
      });
  }

  onFilterChange(): void {
    this.page.set(1);
    this.refresh();
    this.loadOverview();
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

  /**
   * The engine only consults this table while `UseDbBackedPromptTemplate` is
   * on; operators mark rows accordingly in the notes ("NOT LIVE — …"). An
   * "Active" pill next to that note contradicts it, so the row is labelled
   * "Active (not live)" instead.
   */
  isNotLive(row: PromptTemplateSummary): boolean {
    return row.isActive && /^\s*NOT LIVE/i.test(row.notes ?? '');
  }

  statusLabel(row: PromptTemplateSummary): string {
    if (row.isActive) return this.isNotLive(row) ? 'Active (not live)' : 'Active';
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

  // Escape / backdrop route here too (appModalA11y): never hide a write in flight.
  closeForkModal(): void {
    if (this.submitting()) return;
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
    if (this.submitting()) return;
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
    if (this.submitting()) return;
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
