import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { MLModelsService } from '@core/services/ml-models.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import type {
  SymbolicFeatureDecaySnapshotDto,
  SymbolicFeatureDto,
  SymbolicFeatureStatus,
} from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type ActionKind = 'promote' | 'retire';

interface PendingAction {
  kind: ActionKind;
  feature: SymbolicFeatureDto;
}

// ── Expression rendering ─────────────────────────────────────────────────────
// The engine names features by their ROOT node only ("Multiply(…, …)"), so a
// page of candidates is a page of identical names. The full tree is in
// expressionJson — System.Text.Json polymorphic output: a lowercase `kind`
// discriminator (field / const / ind / bin / una / win / xfield) and
// PascalCase members with numeric enums, mirroring
// LascodiaTradingEngine.Application/MLModels/SymbolicFeatures/Expressions/SymbolicExpression.cs.
// Rendering it here gives every row a formula an operator can actually read.

const CANDLE_FIELDS = ['Open', 'High', 'Low', 'Close', 'Volume'];
const INDICATORS = ['SMA', 'RSI', 'ATR', 'Mom'];
const BINARY_OPS = ['+', '−', '×', '÷', 'min', 'max'];
const UNARY_OPS = ['neg', 'abs', 'ssqrt', 'slog', 'tanh'];
const WINDOW_AGGS = ['mean', 'std', 'min', 'max', 'sum'];

type ExprNode = Record<string, unknown>;

function member(node: ExprNode, name: string): unknown {
  return node[name] ?? node[name.charAt(0).toLowerCase() + name.slice(1)];
}

function num(node: ExprNode, name: string): number {
  const v = member(node, name);
  return typeof v === 'number' ? v : Number(v ?? NaN);
}

function lagSuffix(node: ExprNode): string {
  const lag = num(node, 'Lag');
  return lag > 0 ? `[-${lag}]` : '';
}

function renderNode(raw: unknown, depth: number): string {
  if (!raw || typeof raw !== 'object') return '?';
  const node = raw as ExprNode;
  // The discriminator is always lowercase `kind`; IndicatorNode ALSO has a
  // PascalCase `Kind` member (SMA/RSI/…), so the two must not be conflated.
  switch (node['kind']) {
    case 'field':
      return `${CANDLE_FIELDS[num(node, 'Field')] ?? 'field'}${lagSuffix(node)}`;
    case 'xfield':
      return `${String(member(node, 'Symbol') ?? '?')}.${CANDLE_FIELDS[num(node, 'Field')] ?? 'field'}${lagSuffix(node)}`;
    case 'const': {
      const v = num(node, 'Value');
      return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toPrecision(3)) : '?';
    }
    case 'ind': {
      const kind = typeof node['Kind'] === 'number' ? node['Kind'] : NaN;
      return `${INDICATORS[kind] ?? 'ind'}(${num(node, 'Period')})${lagSuffix(node)}`;
    }
    case 'bin': {
      const op = num(node, 'Op');
      const left = renderNode(member(node, 'Left'), depth + 1);
      const right = renderNode(member(node, 'Right'), depth + 1);
      if (op >= 4) return `${BINARY_OPS[op]}(${left}, ${right})`;
      const infix = `${left} ${BINARY_OPS[op] ?? '?'} ${right}`;
      return depth === 0 ? infix : `(${infix})`;
    }
    case 'una': {
      const op = num(node, 'Op');
      const inner = renderNode(member(node, 'Operand'), depth + 1);
      return op === 0 ? `−(${inner})` : `${UNARY_OPS[op] ?? 'f'}(${inner})`;
    }
    case 'win':
      return `${WINDOW_AGGS[num(node, 'Agg')] ?? 'agg'}${num(node, 'Window')}(${renderNode(member(node, 'Operand'), depth + 1)})`;
    default:
      return '?';
  }
}

/** Readable formula for a mined feature, or null when the JSON is not a tree we understand. */
export function renderExpression(json: string): string | null {
  try {
    const text = renderNode(JSON.parse(json), 0);
    return text.includes('?') ? null : text;
  } catch {
    return null;
  }
}

@Component({
  selector: 'app-symbolic-features-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="ML — Symbolic Features"
        subtitle="Genetic-programming mined feature expressions; promote drives V8 pipeline pickup"
      >
        <a routerLink="/ml-models" class="btn btn-secondary">← ML Models</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      <section class="controls">
        <div class="control-group">
          <span class="control-label">Status</span>
          <div class="status-tabs">
            @for (s of STATUS_OPTIONS; track s) {
              <button
                type="button"
                [class.active]="statusFilter() === s"
                (click)="statusFilter.set(s)"
              >
                {{ s }}
              </button>
            }
          </div>
        </div>

        <div class="control-group">
          <span class="control-label">Symbol</span>
          <input
            type="search"
            placeholder="e.g. EURUSD"
            [ngModel]="symbolFilter()"
            (ngModelChange)="symbolFilter.set($event)"
          />
        </div>

        <span class="result-count">
          {{ filteredFeatures().length }} of {{ features().length }} loaded
        </span>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load symbolic features"
          message="Engine returned an error. The symbolic-feature miner worker may not be running — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <!-- Tiles read from an unfiltered census so a "Candidate" filter cannot
             zero the Promoted / Retired counts. The census shares the page's
             200-row cap, and the caption says so when the cap is hit. -->
        <section class="kpis">
          <app-metric-card
            label="Matching filter"
            [value]="filteredFeatures().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Candidates"
            [value]="censusCount('Candidate')"
            format="number"
            dotColor="#FF9500"
          />
          <app-metric-card
            label="Promoted"
            [value]="censusCount('Promoted')"
            format="number"
            [dotColor]="censusCount('Promoted') > 0 ? '#34C759' : '#8E8E93'"
          />
          <app-metric-card
            label="Retired / Rejected"
            [value]="censusCount('Retired') + censusCount('Rejected')"
            format="number"
            dotColor="#8E8E93"
          />
        </section>
        @if (censusCapped()) {
          <p class="muted small census-note">
            Status counts cover the latest {{ CENSUS_LIMIT }} mined features{{
              symbolFilter().trim() ? ' for ' + symbolFilter().trim().toUpperCase() : ''
            }}; older rows are not counted.
          </p>
        }

        @if (filteredFeatures().length === 0) {
          <app-empty-state
            title="No symbolic features match"
            description="No features match the current filters. Try a different status or clear the symbol filter."
          />
        } @else {
          <section class="card">
            <table class="features-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Pair</th>
                  <th
                    class="num"
                    title="Information coefficient on the training / validation split"
                  >
                    IC (train / val)
                  </th>
                  <th class="num" title="Expression tree size: node count · depth">
                    Tree (nodes · depth)
                  </th>
                  <th class="num" title="Bars with a defined value: training / validation">
                    Coverage (train / val)
                  </th>
                  <th>Status</th>
                  <th>Mined</th>
                  <th class="actions-head">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (f of filteredFeatures(); track f.id) {
                  <tr [class.expanded]="expandedId() === f.id">
                    <td>
                      <span class="feat-id mono small">#{{ f.id }}</span>
                      <div class="feat-name mono" [title]="f.name">
                        {{ formula(f) ?? f.name }}
                      </div>
                    </td>
                    <td>
                      <span class="symbol mono">{{ f.symbol }}</span>
                      <span class="tf muted small"> · {{ f.timeframe }}</span>
                    </td>
                    <td class="num mono">
                      {{ f.trainingIc | number: '1.0-3' }}
                      <span class="muted small">/ {{ f.validationIc | number: '1.0-3' }}</span>
                    </td>
                    <td class="num mono small">{{ f.nodeCount }} · {{ f.depth }}</td>
                    <td class="num mono">
                      {{ f.trainingCoverage | number }}
                      <span class="muted small">/ {{ f.validationCoverage | number }}</span>
                    </td>
                    <td>
                      <span class="status-pill" [attr.data-status]="f.status">
                        {{ f.status }}
                      </span>
                    </td>
                    <td class="time" [title]="f.minedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ f.minedAt | relativeTime }}
                    </td>
                    <td class="actions-cell">
                      <!-- flex lives on an inner div: a display:flex <td> drops
                           out of the table's column grid and misaligns the row -->
                      <div class="actions">
                        <button type="button" class="link" (click)="toggleExpand(f.id)">
                          {{ expandedId() === f.id ? 'Hide' : 'Inspect' }}
                        </button>
                        @if (f.status === 'Candidate') {
                          <button type="button" class="action ok" (click)="ask('promote', f)">
                            Promote
                          </button>
                        }
                        @if (f.status === 'Promoted') {
                          <button type="button" class="action warn" (click)="ask('retire', f)">
                            Retire
                          </button>
                        }
                      </div>
                    </td>
                  </tr>
                  @if (expandedId() === f.id) {
                    <tr class="detail-row">
                      <td colspan="8">
                        <div class="detail-grid">
                          <div>
                            <h4>Expression</h4>
                            <p class="formula mono">{{ formula(f) ?? f.name }}</p>
                            <details class="json-details">
                              <summary class="small">Raw expression JSON</summary>
                              <pre class="json">{{ formatJson(f.expressionJson) }}</pre>
                            </details>
                          </div>
                          <div>
                            <h4>Lifecycle</h4>
                            <dl>
                              <dt>Forward horizon</dt>
                              <dd>{{ f.forwardReturnHorizonBars }} bars</dd>
                              <dt>Mined</dt>
                              <dd>{{ f.minedAt | date: 'yyyy-MM-dd HH:mm UTC' }}</dd>
                              @if (f.promotedAt) {
                                <dt>Promoted</dt>
                                <dd>{{ f.promotedAt | date: 'yyyy-MM-dd HH:mm UTC' }}</dd>
                              }
                              @if (f.retiredAt) {
                                <dt>Retired</dt>
                                <dd>{{ f.retiredAt | date: 'yyyy-MM-dd HH:mm UTC' }}</dd>
                              }
                              @if (f.retirementReason) {
                                <dt>Retirement reason</dt>
                                <dd>{{ f.retirementReason }}</dd>
                              }
                            </dl>
                            @if (decayLoaded() === f.id) {
                              <h4>Decay history</h4>
                              @if (decayPoints().length === 0) {
                                <p class="muted small">No decay snapshots recorded.</p>
                              } @else {
                                <table class="decay-mini">
                                  <thead>
                                    <tr>
                                      <th>When</th>
                                      <th class="num">Live IC</th>
                                      <th class="num">Coverage</th>
                                      <th>Outcome</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    @for (p of decayPoints(); track p.id) {
                                      <tr>
                                        <td
                                          class="time mono small"
                                          [title]="p.evaluatedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'"
                                        >
                                          {{ p.evaluatedAt | relativeTime }}
                                        </td>
                                        <td class="num mono">{{ p.liveIc | number: '1.0-3' }}</td>
                                        <td class="num mono">{{ p.liveCoverage }}</td>
                                        <td class="small">{{ p.outcome }}</td>
                                      </tr>
                                    }
                                  </tbody>
                                </table>
                              }
                            } @else {
                              <button
                                type="button"
                                class="link"
                                (click)="loadDecay(f.id)"
                                [disabled]="decayLoading()"
                              >
                                {{ decayLoading() ? 'Loading…' : 'Load decay history' }}
                              </button>
                            }
                          </div>
                        </div>
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </section>
        }
      }

      @if (pending(); as p) {
        <div class="modal-overlay" (click)="cancel()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>{{ p.kind === 'promote' ? 'Promote feature' : 'Retire feature' }}</h2>
              <button type="button" class="close-btn" (click)="cancel()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              <span class="mono">#{{ p.feature.id }} · {{ p.feature.name }}</span>
            </p>
            <p class="modal-desc">
              @if (p.kind === 'promote') {
                Candidate features are not loaded by V8 — promotion makes this feature available to
                the next training run. Optional rationale below feeds the audit trail.
              } @else {
                Retired features stop being available to V8. This is reversible only by promoting
                again from Candidate; an explicit reason is required.
              }
            </p>
            <label class="reason-field">
              <span>
                Reason
                @if (p.kind === 'retire') {
                  (required)
                } @else {
                  (optional)
                }
              </span>
              <textarea
                rows="3"
                [(ngModel)]="reasonText"
                [placeholder]="
                  p.kind === 'promote'
                    ? 'Why is this candidate worth promoting?'
                    : 'Why is this feature being retired?'
                "
              ></textarea>
            </label>
            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancel()">Cancel</button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="confirm()"
                [disabled]="!canSubmit()"
              >
                {{ submitting() ? 'Saving…' : p.kind === 'promote' ? 'Promote' : 'Retire' }}
              </button>
            </footer>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .controls {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .control-group {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .control-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .status-tabs {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-secondary);
        padding: 4px;
        border-radius: var(--radius-md);
      }
      .status-tabs button {
        background: transparent;
        border: none;
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .status-tabs button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .control-group input {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 140px;
      }
      .result-count {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin-left: auto;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 720px) {
        .kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .census-note {
        margin: calc(-1 * var(--space-2)) 0 0;
      }
      /* Pill buttons — same chrome as the Training Queue header so the three
         ML sub-pages share one back-link + Refresh treatment. */
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        line-height: 1;
        text-decoration: none;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-quaternary, var(--bg-tertiary));
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .features-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .features-table th,
      .features-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .features-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .features-table td.num,
      .features-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .features-table tr.expanded {
        background: var(--bg-primary);
      }
      .features-table tr.detail-row td {
        background: var(--bg-primary);
        padding: var(--space-3) var(--space-4);
      }
      .feat-id {
        color: var(--text-tertiary);
      }
      .feat-name {
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        margin-top: 2px;
        word-break: break-word;
        max-width: 420px;
        line-height: 1.45;
      }
      .formula {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        line-height: 1.5;
        word-break: break-word;
        color: var(--text-primary);
      }
      .json-details summary {
        cursor: pointer;
        color: var(--text-secondary);
        margin-bottom: var(--space-2);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .symbol {
        font-weight: var(--font-semibold);
      }
      .status-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
      }
      .status-pill[data-status='Candidate'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .status-pill[data-status='Promoted'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .status-pill[data-status='Retired'] {
        background: rgba(142, 142, 147, 0.16);
        color: #636366;
      }
      .status-pill[data-status='Rejected'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .actions-head,
      .actions-cell {
        text-align: right;
        white-space: nowrap;
      }
      .actions {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        justify-content: flex-end;
      }
      .link {
        background: none;
        border: none;
        color: var(--accent);
        cursor: pointer;
        font-size: var(--text-xs);
        padding: 4px 6px;
        font-weight: var(--font-medium);
      }
      .link:hover:not(:disabled) {
        text-decoration: underline;
      }
      .action {
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .action.ok {
        color: #248a3d;
      }
      .action.ok:hover {
        background: #34c759;
        color: #fff;
      }
      .action.warn {
        color: #c93400;
      }
      .action.warn:hover {
        background: #c93400;
        color: #fff;
      }
      .detail-grid {
        display: grid;
        grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr);
        gap: var(--space-4);
      }
      .detail-grid h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .json {
        background: var(--bg-secondary);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-family: var(--font-mono);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 280px;
        overflow: auto;
        color: var(--text-secondary);
      }
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px var(--space-3);
        margin: 0 0 var(--space-3);
        font-size: var(--text-xs);
      }
      dt {
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      dd {
        margin: 0;
        color: var(--text-primary);
      }
      .decay-mini {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .decay-mini th,
      .decay-mini td {
        padding: 4px 6px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .decay-mini th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.45));
        display: grid;
        place-items: center;
        z-index: 1000;
      }
      .modal {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-width: 520px;
        width: 90%;
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .modal-head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary);
        cursor: pointer;
        line-height: 1;
      }
      .modal-target {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .reason-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .reason-field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .reason-field textarea {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: var(--font-sans);
        resize: vertical;
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
    `,
  ],
})
export class SymbolicFeaturesPageComponent {
  private readonly ml = inject(MLModelsService);
  private readonly auditTrail = inject(AuditTrailService);

  protected readonly STATUS_OPTIONS: readonly (SymbolicFeatureStatus | 'All')[] = [
    'All',
    'Candidate',
    'Promoted',
    'Retired',
    'Rejected',
  ] as const;

  protected readonly statusFilter = signal<SymbolicFeatureStatus | 'All'>('Candidate');
  protected readonly symbolFilter = signal<string>('');
  protected readonly CENSUS_LIMIT = 200;

  protected readonly resource = createPolledResource(
    () => {
      const status = this.statusFilter();
      return this.ml
        .listSymbolicFeatures({
          status: status === 'All' ? null : status,
          symbol: this.symbolFilter().trim() || null,
          limit: this.CENSUS_LIMIT,
        })
        .pipe(
          map((res) => res.data ?? []),
          catchError(() => of<SymbolicFeatureDto[]>([])),
        );
    },
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['mlModelActivated', 'mlModelRetired', 'mlDriftRecoveryTriggered'],
    },
  );

  /**
   * Status census, deliberately NOT filtered by status: the KPI tiles used to
   * be computed from the filtered list, so with the default "Candidate" filter
   * Promoted and Retired could only ever read 0. Follows the symbol filter so
   * the tiles still describe the pair the operator is looking at.
   */
  protected readonly census = createPolledResource(
    () =>
      this.ml
        .listSymbolicFeatures({
          status: null,
          symbol: this.symbolFilter().trim() || null,
          limit: this.CENSUS_LIMIT,
        })
        .pipe(
          map((res) => res.data ?? []),
          catchError(() => of<SymbolicFeatureDto[]>([])),
        ),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['mlModelActivated', 'mlModelRetired', 'mlDriftRecoveryTriggered'],
    },
  );

  constructor() {
    effect(() => {
      this.statusFilter();
      this.symbolFilter();
      this.resource.refresh();
    });
    effect(() => {
      this.symbolFilter();
      this.census.refresh();
    });
  }

  protected readonly features = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.features().length === 0,
  );
  protected readonly filteredFeatures = computed(() => this.features());
  protected readonly censusCapped = computed(
    () => (this.census.value()?.length ?? 0) >= this.CENSUS_LIMIT,
  );

  protected censusCount(status: SymbolicFeatureStatus): number {
    return (this.census.value() ?? []).filter((f) => f.status === status).length;
  }

  private readonly formulaCache = new Map<number, string | null>();
  /** Readable formula rendered from the expression tree; memoised per feature id. */
  protected formula(f: SymbolicFeatureDto): string | null {
    let text = this.formulaCache.get(f.id);
    if (text === undefined) {
      text = renderExpression(f.expressionJson);
      this.formulaCache.set(f.id, text);
    }
    return text;
  }

  // Detail expansion + decay history --------------------------------------
  protected readonly expandedId = signal<number | null>(null);
  protected readonly decayLoaded = signal<number | null>(null);
  protected readonly decayLoading = signal(false);
  protected readonly decayPoints = signal<SymbolicFeatureDecaySnapshotDto[]>([]);

  protected toggleExpand(id: number): void {
    const next = this.expandedId() === id ? null : id;
    this.expandedId.set(next);
    if (next === null) {
      this.decayLoaded.set(null);
      this.decayPoints.set([]);
    }
  }

  protected loadDecay(id: number): void {
    this.decayLoading.set(true);
    this.ml
      .getSymbolicFeatureDecayHistory(id)
      .pipe(
        map((res) => res.data ?? []),
        catchError(() => of<SymbolicFeatureDecaySnapshotDto[]>([])),
        finalize(() => this.decayLoading.set(false)),
      )
      .subscribe((rows) => {
        this.decayPoints.set(rows);
        this.decayLoaded.set(id);
      });
  }

  protected formatJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  // Promote / retire modal -------------------------------------------------
  protected readonly pending = signal<PendingAction | null>(null);
  protected reasonText = '';
  protected readonly submitting = signal(false);

  protected ask(kind: ActionKind, feature: SymbolicFeatureDto): void {
    this.reasonText = '';
    this.pending.set({ kind, feature });
  }

  protected cancel(): void {
    if (this.submitting()) return;
    this.pending.set(null);
  }

  protected canSubmit = (): boolean => {
    if (this.submitting()) return false;
    const p = this.pending();
    if (!p) return false;
    // Retirement requires a reason; promotion is optional.
    if (p.kind === 'retire') return this.reasonText.trim().length >= 4;
    return true;
  };

  protected confirm(): void {
    const p = this.pending();
    if (!p || !this.canSubmit()) return;
    this.submitting.set(true);
    const reason = this.reasonText.trim();
    const obs =
      p.kind === 'promote'
        ? this.ml.promoteSymbolicFeature(p.feature.id, { reason: reason || null })
        : this.ml.retireSymbolicFeature(p.feature.id, { reason });
    obs
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.pending.set(null);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.auditTrail
              .create({
                entityType: 'MLSymbolicFeature',
                entityId: p.feature.id,
                decisionType:
                  p.kind === 'promote' ? 'SymbolicFeaturePromoted' : 'SymbolicFeatureRetired',
                outcome: p.kind === 'promote' ? 'Promoted' : 'Retired',
                reason: reason || null,
                contextJson: JSON.stringify({ name: p.feature.name, symbol: p.feature.symbol }),
                source: 'AdminUI',
              })
              .subscribe({
                error: () => {
                  /* best-effort */
                },
              });
          }
        },
        error: () => {
          /* polled-resource will retry on next interval */
        },
      });
  }
}
