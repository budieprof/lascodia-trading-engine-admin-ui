import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { PromotionGatesDto } from '@core/api/api.types';

interface ParsedDiagnostic {
  raw: string;
  /** Inferred gate label, e.g. `Adversarial`, `Edge posterior`, `CPCV`, etc. */
  gate: string;
  /** Pass / Fail / Skipped / Bypassed / Info — purely visual classification. */
  tone: 'pass' | 'fail' | 'skip' | 'bypass' | 'info' | 'warn';
  /** Human-readable detail (everything after the gate prefix). */
  detail: string;
  /** Optional structured key-value pairs we extracted (`Key=Value`) for tabular display. */
  values: Array<{ k: string; v: string }>;
}

@Component({
  selector: 'app-promotion-readiness-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-label="Promotion readiness">
      <header class="card-header">
        <div class="title">
          <h3>Promotion readiness</h3>
          <p class="subtitle">
            Live evaluation of every gate the engine runs on
            <code>PUT /strategy/{{ strategyId() }}/activate</code>.
          </p>
        </div>
        <div class="header-actions">
          <label
            class="bypass-toggle"
            title="Skip the paper-execution duration / count gate. Substantive gates always run regardless."
          >
            <input type="checkbox" [checked]="bypassPaper()" (change)="onToggleBypass($event)" />
            <span>Bypass paper-trade gate</span>
          </label>
          <button class="btn-refresh" (click)="reload()" [disabled]="loading()" type="button">
            ↻ Refresh
          </button>
        </div>
      </header>

      @if (loading()) {
        <div class="skeleton">Evaluating gates…</div>
      } @else if (errorMessage()) {
        <div class="banner error">{{ errorMessage() }}</div>
      } @else if (gates(); as g) {
        <div [class]="'verdict ' + (g.passed ? 'pass' : 'fail')">
          <div class="verdict-icon">{{ g.passed ? '✓' : '✗' }}</div>
          <div class="verdict-text">
            <strong>{{ g.passed ? 'All gates passed' : 'Promotion gates failed' }}</strong>
            @if (!g.passed && g.failureSummary) {
              <p class="failure">{{ g.failureSummary }}</p>
            }
            @if (g.passed) {
              <p class="muted">Strategy is ready for activation.</p>
            }
          </div>
          <button
            class="btn-activate"
            [class.disabled]="!g.passed"
            [disabled]="!g.passed || activating()"
            (click)="onActivate()"
            type="button"
          >
            {{
              activating() ? 'Activating…' : g.passed ? 'Activate strategy' : 'Activation blocked'
            }}
          </button>
        </div>

        <table class="diagnostics" aria-label="Per-gate diagnostics">
          <thead>
            <tr>
              <th class="g">Gate</th>
              <th class="t">Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            @for (row of parsedDiagnostics(); track row.raw) {
              <tr [class]="'tone-' + row.tone">
                <td class="g">{{ row.gate }}</td>
                <td class="t">
                  <span [class]="'pill pill-' + row.tone">{{ toneLabel(row.tone) }}</span>
                </td>
                <td>
                  @if (row.values.length > 0) {
                    <div class="kv">
                      @for (kv of row.values; track kv.k) {
                        <span class="kv-pair"
                          ><span class="k">{{ kv.k }}</span
                          ><span class="v">{{ kv.v }}</span></span
                        >
                      }
                    </div>
                  } @else {
                    <span class="raw">{{ row.detail }}</span>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <div class="muted">No data yet.</div>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding, var(--space-5));
        box-shadow: var(--shadow-sm);
      }
      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
        margin-bottom: var(--space-4);
      }
      .title h3 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .subtitle {
        margin: var(--space-1) 0 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .subtitle code {
        font-size: 0.95em;
        padding: 1px 4px;
        background: var(--bg-tertiary);
        border-radius: 3px;
      }
      .header-actions {
        display: flex;
        gap: var(--space-3);
        align-items: center;
      }
      .bypass-toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        cursor: pointer;
        user-select: none;
      }
      .btn-refresh {
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 4px 10px;
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .btn-refresh[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .skeleton {
        padding: var(--space-6);
        text-align: center;
        color: var(--text-secondary);
      }
      .banner {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
      }
      .banner.error {
        background: rgba(239, 68, 68, 0.1);
        color: #b91c1c;
        border: 1px solid rgba(239, 68, 68, 0.3);
      }
      .verdict {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: var(--space-4);
        align-items: center;
        padding: var(--space-4);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-4);
      }
      .verdict.pass {
        background: rgba(34, 197, 94, 0.08);
        border: 1px solid rgba(34, 197, 94, 0.3);
      }
      .verdict.fail {
        background: rgba(239, 68, 68, 0.06);
        border: 1px solid rgba(239, 68, 68, 0.25);
      }
      .verdict-icon {
        font-size: 28px;
        font-weight: bold;
        line-height: 1;
      }
      .verdict.pass .verdict-icon {
        color: #15803d;
      }
      .verdict.fail .verdict-icon {
        color: #b91c1c;
      }
      .verdict-text strong {
        font-size: var(--text-base);
        color: var(--text-primary);
      }
      .verdict-text .failure {
        margin: var(--space-1) 0 0;
        color: #b91c1c;
        font-size: var(--text-sm);
        line-height: 1.4;
      }
      .verdict-text .muted {
        margin: var(--space-1) 0 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .btn-activate {
        background: #15803d;
        color: white;
        border: none;
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-5);
        cursor: pointer;
        font-size: var(--text-sm);
        font-weight: 600;
      }
      .btn-activate.disabled,
      .btn-activate[disabled] {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        cursor: not-allowed;
      }
      table.diagnostics {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      table.diagnostics th,
      table.diagnostics td {
        padding: var(--space-2) var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      table.diagnostics th {
        background: var(--bg-tertiary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      table.diagnostics .g {
        width: 180px;
        font-weight: var(--font-medium);
      }
      table.diagnostics .t {
        width: 110px;
      }
      .pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: var(--text-xs);
        font-weight: 600;
      }
      .pill-pass {
        background: rgba(34, 197, 94, 0.15);
        color: #15803d;
      }
      .pill-fail {
        background: rgba(239, 68, 68, 0.15);
        color: #b91c1c;
      }
      .pill-skip {
        background: rgba(120, 120, 128, 0.15);
        color: #71717a;
      }
      .pill-bypass {
        background: rgba(245, 158, 11, 0.15);
        color: #b45309;
      }
      .pill-info {
        background: rgba(59, 130, 246, 0.15);
        color: #1d4ed8;
      }
      .pill-warn {
        background: rgba(245, 158, 11, 0.15);
        color: #b45309;
      }
      .kv {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        font-variant-numeric: tabular-nums;
      }
      .kv-pair {
        display: inline-flex;
        gap: 4px;
        padding: 1px 6px;
        background: var(--bg-tertiary);
        border-radius: 3px;
        font-size: var(--text-xs);
      }
      .kv-pair .k {
        color: var(--text-secondary);
      }
      .kv-pair .v {
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      tr.tone-fail {
        background: rgba(239, 68, 68, 0.04);
      }
      .raw {
        color: var(--text-secondary);
        font-family: var(--font-mono, monospace);
        font-size: 0.95em;
      }
      .muted {
        color: var(--text-secondary);
      }
    `,
  ],
})
export class PromotionReadinessCardComponent {
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  // Captured at construction time so the takeUntilDestroyed() calls inside
  // methods (loadGates / onActivate) have a valid context to bind to.
  // Calling takeUntilDestroyed() without an arg from inside a method throws
  // NG0203 — the no-arg form requires an active injection context.
  private readonly destroyRef = inject(DestroyRef);

  readonly strategyId = input.required<number>();
  readonly activated = output<void>();

  readonly bypassPaper = signal(false);
  readonly loading = signal(false);
  readonly activating = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly gates = signal<PromotionGatesDto | null>(null);

  readonly parsedDiagnostics = computed<ParsedDiagnostic[]>(() => {
    const g = this.gates();
    if (!g) return [];
    return g.diagnostics.map((d) => parseDiagnostic(d));
  });

  constructor() {
    // Fetch on first render and on every strategyId / bypassPaper change.
    effect(() => {
      const sid = this.strategyId();
      const bypass = this.bypassPaper();
      if (!sid) return;
      this.loadGates(sid, bypass);
    });
  }

  reload(): void {
    this.loadGates(this.strategyId(), this.bypassPaper());
  }

  onToggleBypass(ev: Event): void {
    this.bypassPaper.set((ev.target as HTMLInputElement).checked);
  }

  onActivate(): void {
    if (this.activating()) return;
    this.activating.set(true);
    this.strategiesService
      .activate(this.strategyId(), this.bypassPaper())
      .pipe(
        catchError((err) => {
          this.notifications.error(
            `Activation failed: ${(err?.error?.message as string | undefined) ?? err?.message ?? err}`,
          );
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.activating.set(false);
        if (res?.status) {
          this.notifications.success('Strategy activated');
          this.activated.emit();
          this.reload();
        } else if (res) {
          this.notifications.error(res.message ?? 'Activation refused');
          this.reload();
        }
      });
  }

  toneLabel(tone: ParsedDiagnostic['tone']): string {
    switch (tone) {
      case 'pass':
        return 'Pass';
      case 'fail':
        return 'Fail';
      case 'skip':
        return 'Skipped';
      case 'bypass':
        return 'Bypassed';
      case 'warn':
        return 'Warn';
      default:
        return 'Info';
    }
  }

  private loadGates(sid: number, bypass: boolean): void {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.strategiesService
      .getPromotionGates(sid, bypass)
      .pipe(
        catchError((err) => {
          this.errorMessage.set(
            `Failed to load promotion gates: ${(err?.error?.message as string | undefined) ?? err?.message ?? err}`,
          );
          this.loading.set(false);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.gates.set(res.data);
        } else if (res) {
          this.errorMessage.set(res.message ?? 'Empty response');
        }
      });
  }
}

/**
 * Best-effort parse of a diagnostic line into (gate, tone, detail, structured values).
 * The validator emits free-form strings (e.g. `"PaperFills=0, earliest=none, days=0.0"`,
 * `"EdgePosterior: μ=0.170 σ=0.129 P(edge>0)=0.907"`); we sniff common shapes for
 * tabular display, falling back to "Info" + raw text.
 */
function parseDiagnostic(raw: string): ParsedDiagnostic {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  // Tone classification — keyword sniff against known phrases.
  let tone: ParsedDiagnostic['tone'] = 'info';
  if (lower.includes('bypassed') || lower.includes('grandfathered')) tone = 'bypass';
  else if (lower.includes('auto-skipped') || lower.includes('skip')) tone = 'skip';
  else if (
    lower.includes('failed') ||
    lower.includes('< min') ||
    lower.includes('> max') ||
    lower.includes('fragile')
  )
    tone = 'fail';
  else if (lower.includes('warn') || lower.includes('cold-start')) tone = 'warn';

  // Gate label — first phrase before colon / "=" / "(" / specific known words.
  let gate = 'Diagnostic';
  let detail = trimmed;

  // Pattern: "Some gate label: rest of message"
  const colonMatch = trimmed.match(/^([A-Z][A-Za-z0-9 \-+/_]+):\s*(.*)$/);
  if (colonMatch) {
    gate = colonMatch[1].trim();
    detail = colonMatch[2].trim();
  } else if (lower.startsWith('paper gate ')) {
    gate = 'Paper gate';
    detail = trimmed.replace(/^paper gate\s*/i, '');
  } else if (lower.includes('paperfills')) {
    gate = 'Paper gate';
    detail = trimmed;
  } else if (lower.includes('tca-adjusted')) {
    gate = 'TCA-adjusted EV';
    detail = trimmed.replace(/^TCA-adjusted\s*/i, '');
  } else if (lower.includes('cpcv')) {
    gate = 'CPCV';
    detail = trimmed.replace(/^CPCV\s*\([^)]+\):\s*/i, '');
  } else if (lower.includes('edgeposterior')) {
    gate = 'Edge posterior';
    detail = trimmed.replace(/^EdgePosterior:\s*/i, '');
  } else if (lower.includes('correlation')) {
    gate = 'Correlation';
  } else if (lower.includes('backtestcoverage')) {
    gate = 'Backtest coverage';
  } else if (
    lower.match(
      /^(baseline|worst-case|degradation|slippagespike|spreadblowout|newsshock|regimeflip)/i,
    )
  ) {
    gate = 'Adversarial';
  } else if (lower.includes('dsr')) {
    gate = 'DSR';
  } else if (lower.includes('pbo')) {
    gate = 'PBO';
  }

  // Extract `Key=Value` pairs (numbers, percents, dates) for tabular display.
  // Strip leading bullets / spaces. We accept μ/σ/P(...) too.
  const values: Array<{ k: string; v: string }> = [];
  const pairRe = /([A-Za-zμσμσ()<>=+\-_·][A-Za-zμσμσ()<>=+\-_·0-9 ]*?)=([^\s,;|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(detail)) !== null) {
    const k = m[1].trim();
    const v = m[2].trim();
    if (k && v) values.push({ k, v });
  }

  return { raw, gate, tone, detail, values };
}
