import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { AnalyserComparisonService } from '@core/services/analyser-comparison.service';
import { LookAheadAuditReport, Timeframe } from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

/**
 * Look-ahead Audit Runner — operator-runnable T1–T5 suite proving the
 * SyntheticAnalyser feature pipeline did not read past its decision time.
 * Form: (symbol, timeframe, optional sampleAt) → server runs the suite →
 * page renders pass/fail per test plus diagnostics for failing tests.
 *
 * Gated by the Operator policy on the server; this page is the UI surface
 * for that endpoint. Recommended pre-flight before promoting any synthetic-
 * source signal into live trading scope.
 */
@Component({
  selector: 'app-look-ahead-audit-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, FormsModule, RouterLink, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Look-ahead Audit"
        subtitle="T1–T5 suite proving the SyntheticAnalyser feature pipeline did not read past its decision time"
      >
        <a class="back-link" [routerLink]="['/analyser-comparison']"> ← Back to comparison </a>
      </app-page-header>

      <form class="form" (ngSubmit)="run()">
        <label class="field">
          <span>Symbol</span>
          <input
            type="text"
            maxlength="12"
            placeholder="EURUSD"
            required
            [(ngModel)]="symbol"
            name="symbol"
          />
        </label>
        <label class="field">
          <span>Timeframe</span>
          <select [(ngModel)]="timeframe" name="timeframe">
            @for (tf of timeframes; track tf) {
              <option [value]="tf">{{ tf }}</option>
            }
          </select>
        </label>
        <label class="field field--wide">
          <span>Sample at (UTC, optional)</span>
          <input type="datetime-local" [(ngModel)]="sampleAtLocal" name="sampleAt" />
        </label>
        <button type="submit" class="run-btn" [disabled]="running() || !symbol().trim()">
          {{ running() ? 'Running…' : 'Run audit' }}
        </button>
      </form>

      @if (errorMessage()) {
        <div class="status error">{{ errorMessage() }}</div>
      }

      @if (report()) {
        <section class="report-meta">
          <span>
            {{ report()!.symbol }} / {{ report()!.timeframe }} @
            {{ report()!.sampleAt | date: 'medium' }} —
            <strong
              [class.pass-strong]="report()!.failedCount === 0"
              [class.fail-strong]="report()!.failedCount > 0"
            >
              {{ report()!.passedCount }} passed, {{ report()!.failedCount }} failed,
              {{ report()!.skippedCount }} skipped
            </strong>
            ({{ report()!.durationMs | number }}ms)
          </span>
        </section>

        <ul class="test-list">
          @for (t of report()!.tests; track t.testName) {
            <li
              class="test"
              [class.test--passed]="t.status === 'Passed'"
              [class.test--failed]="t.status === 'Failed'"
              [class.test--skipped]="t.status === 'Skipped'"
            >
              <header>
                <span class="status-pill">{{ t.status }}</span>
                <h3>{{ t.testName }}</h3>
              </header>
              <p class="detail">{{ t.detail }}</p>
              @if (t.diagnostics && t.diagnostics.length > 0) {
                <details>
                  <summary>{{ t.diagnostics.length }} diagnostic(s)</summary>
                  <ul class="diagnostics">
                    @for (d of t.diagnostics; track d) {
                      <li>{{ d }}</li>
                    }
                  </ul>
                </details>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .back-link {
        color: var(--accent, #4f8cff);
        text-decoration: none;
        font-size: 0.9rem;
      }
      .back-link:hover {
        text-decoration: underline;
      }
      .form {
        display: flex;
        gap: 1rem;
        align-items: flex-end;
        flex-wrap: wrap;
        background: var(--card-bg, #1a1f2b);
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 8px;
        padding: 1rem;
      }
      .field {
        display: inline-flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.85rem;
      }
      .field--wide {
        min-width: 200px;
      }
      .field input,
      .field select {
        padding: 0.35rem 0.5rem;
        background: transparent;
        color: inherit;
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 4px;
        min-width: 120px;
      }
      .run-btn {
        background: var(--accent, #4f8cff);
        color: #fff;
        border: none;
        padding: 0.45rem 1rem;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
      }
      .run-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .status.error {
        color: #f66;
        padding: 0.5rem;
      }
      .report-meta {
        font-size: 0.9rem;
      }
      .pass-strong {
        color: #4fd1c5;
      }
      .fail-strong {
        color: #ff7a7a;
      }
      .test-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .test {
        background: var(--card-bg, #1a1f2b);
        border: 1px solid var(--border, #2a2f3a);
        border-left-width: 4px;
        border-radius: 6px;
        padding: 0.75rem 1rem;
      }
      .test--passed {
        border-left-color: #4fd1c5;
      }
      .test--failed {
        border-left-color: #ff7a7a;
      }
      .test--skipped {
        border-left-color: #888;
      }
      .test header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.25rem;
      }
      .test h3 {
        margin: 0;
        font-size: 1rem;
      }
      .status-pill {
        font-size: 0.7rem;
        text-transform: uppercase;
        padding: 0.1rem 0.45rem;
        border-radius: 4px;
        letter-spacing: 0.04em;
        font-weight: 700;
      }
      .test--passed .status-pill {
        background: rgba(79, 209, 197, 0.2);
        color: #4fd1c5;
      }
      .test--failed .status-pill {
        background: rgba(255, 122, 122, 0.2);
        color: #ff7a7a;
      }
      .test--skipped .status-pill {
        background: rgba(136, 136, 136, 0.2);
        color: #aaa;
      }
      .detail {
        margin: 0.25rem 0 0;
        opacity: 0.85;
        font-size: 0.9rem;
      }
      details summary {
        cursor: pointer;
        font-size: 0.85rem;
        opacity: 0.7;
        margin-top: 0.5rem;
      }
      .diagnostics {
        font-family: ui-monospace, monospace;
        font-size: 0.8rem;
        padding-left: 1rem;
      }
      .diagnostics li {
        padding: 0.1rem 0;
      }
    `,
  ],
})
export class LookAheadAuditPageComponent {
  private readonly svc = inject(AnalyserComparisonService);

  readonly timeframes = TIMEFRAMES;
  readonly symbol = signal('EURUSD');
  readonly timeframe = signal<Timeframe>('H1');
  readonly sampleAtLocal = signal('');

  readonly running = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly report = signal<LookAheadAuditReport | null>(null);

  run() {
    if (this.running()) return;
    const sym = this.symbol().trim();
    if (!sym) return;
    this.running.set(true);
    this.errorMessage.set(null);
    this.report.set(null);

    // Convert datetime-local (local timezone) to UTC ISO string when present.
    let sampleAtIso: string | undefined;
    const raw = this.sampleAtLocal();
    if (raw) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) sampleAtIso = d.toISOString();
    }

    this.svc
      .runAudit({
        symbol: sym,
        timeframe: this.timeframe(),
        sampleAt: sampleAtIso,
      })
      .pipe(
        catchError((err) => {
          this.errorMessage.set(err?.message ?? 'Audit request failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.running.set(false);
        if (res?.status && res.data) this.report.set(res.data);
        else if (res && !res.status)
          this.errorMessage.set(res.message ?? 'Audit returned failure.');
      });
  }
}
