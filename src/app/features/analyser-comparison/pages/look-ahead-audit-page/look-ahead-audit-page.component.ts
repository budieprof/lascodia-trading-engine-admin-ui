import { Component, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, concatMap, from, map, of, toArray } from 'rxjs';

import { AnalyserComparisonService } from '@core/services/analyser-comparison.service';
import { LookAheadAuditReport, Timeframe } from '@core/api/api.types';
import { ConfigService } from '@core/services/config.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';

import {
  AUDIT_TESTS,
  VERDICT_LABEL,
  parsePairs,
  testStatus,
  verdictOf,
  type AuditPair,
} from './look-ahead-audit.logic';

const PAIRS_KEY = 'Workers:SyntheticAnalyserWorker:Pairs';
const ENABLED_KEY = 'Workers:SyntheticAnalyserWorker:Enabled';
const DISPATCH_KEY = 'Workers:SyntheticAnalyserWorker:LiveDispatchEnabled';

interface ConfigLite {
  value: string;
  lastUpdatedAt: string | null;
}

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
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    FeatureStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Look-ahead Audit"
        subtitle="T1–T5 suite proving the SyntheticAnalyser feature pipeline did not read past its decision time"
      >
        <a class="back-link" [routerLink]="['/analyser-comparison']"> ← Back to comparison </a>
      </app-page-header>

      @if (analyser(); as a) {
        <app-feature-state
          title="SyntheticAnalyser"
          summary="The SyntheticAnalyser is the engine's own rule-and-model analyst: it records a buy / sell / hold decision for each covered pair on every bar. This audit proves its features never read data from after the decision — the evidence asked for before its signals may trade live."
          [kind]="a.kind"
          [stateLabel]="a.label"
          [switchKey]="enabledKey"
          [detail]="a.detail"
          [requirements]="a.requirements"
          [links]="links"
        />
      }

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
        @if (pairs().length) {
          <button
            type="button"
            class="sweep-btn"
            [disabled]="sweeping()"
            (click)="sweep()"
            title="Runs the five checks for every pair the analyser covers, one after another"
          >
            {{
              sweeping()
                ? 'Auditing ' + sweepDone() + ' / ' + pairs().length + '…'
                : 'Audit all ' + pairs().length + ' covered pairs'
            }}
          </button>
        }
      </form>

      @if (sweepRows().length || sweeping()) {
        <section class="card">
          <header class="card-head">
            <h3>Every covered pair</h3>
            <span class="sub">
              @if (sweepAt(); as at) {
                Audited at {{ at | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC ·
              }
              {{ cleanCount() }} all passed · {{ partialCount() }} passed with skips ·
              {{ failedPairs() }} failed — click a row for its details
            </span>
          </header>
          <div class="table-wrap">
            <table class="matrix">
              <thead>
                <tr>
                  <th>Pair</th>
                  @for (t of tests; track t.key) {
                    <th [title]="t.what">{{ t.key.slice(0, 2) }}</th>
                  }
                  <th>Result</th>
                  <th class="num">Took</th>
                </tr>
              </thead>
              <tbody>
                @for (r of sweepRows(); track r.symbol + r.timeframe) {
                  <tr
                    class="row"
                    [class.selected]="report() === r"
                    (click)="report.set(r)"
                    tabindex="0"
                    (keydown.enter)="report.set(r)"
                  >
                    <td class="pair">{{ r.symbol }} · {{ r.timeframe }}</td>
                    @for (t of tests; track t.key) {
                      <td>
                        <span class="cell" [attr.data-status]="cell(r, t.key)">{{
                          cell(r, t.key) ?? '—'
                        }}</span>
                      </td>
                    }
                    <td>
                      <span class="verdict" [attr.data-verdict]="verdict(r)">{{
                        verdictLabel[verdict(r)]
                      }}</span>
                    </td>
                    <td class="num">{{ r.durationMs | number }} ms</td>
                  </tr>
                }
                @if (sweeping()) {
                  <tr>
                    <td [attr.colspan]="tests.length + 3" class="muted">Running the next pair…</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (errorMessage()) {
        <div class="status error">{{ errorMessage() }}</div>
      }

      @if (report()) {
        <section class="report-meta">
          <span>
            {{ report()!.symbol }} / {{ report()!.timeframe }} @
            {{ report()!.sampleAt | date: 'yyyy-MM-dd HH:mm:ss' : 'UTC' }} UTC —
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

      <section class="card">
        <header class="card-head">
          <h3>What the five checks prove</h3>
          <span class="sub"
            >A skipped check had nothing to inspect (e.g. no stored decision for the pair in the
            last 24 h) — it is not a failure.</span
          >
        </header>
        <dl class="tests-explained">
          @for (t of tests; track t.key) {
            <div>
              <dt>{{ t.name }}</dt>
              <dd>{{ t.what }}</dd>
            </div>
          }
        </dl>
      </section>
    </div>
  `,
  styles: [
    `
      /* The layout shell provides the gutter; page-level padding pushed this
         route's content 16px right of every other page. */
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .back-link {
        color: var(--accent, #4f8cff);
        text-decoration: none;
        font-size: 0.9rem;
      }
      .back-link:hover {
        text-decoration: underline;
      }
      /* Theme tokens throughout: --card-bg does not exist, so the #1a1f2b fallback
         painted a dark-navy slab with unreadable labels on the light theme. */
      .form {
        display: flex;
        gap: 1rem;
        align-items: flex-end;
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
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
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: 4px;
        min-width: 120px;
      }
      .run-btn {
        background: var(--accent);
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
        color: var(--loss);
        padding: 0.5rem;
      }
      .report-meta {
        font-size: 0.9rem;
      }
      .pass-strong {
        color: var(--profit);
      }
      .fail-strong {
        color: var(--loss);
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
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left-width: 4px;
        border-radius: 6px;
        padding: 0.75rem 1rem;
      }
      .test--passed {
        border-left-color: var(--profit);
      }
      .test--failed {
        border-left-color: var(--loss);
      }
      .test--skipped {
        border-left-color: var(--text-tertiary);
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
        background: color-mix(in srgb, var(--profit) 20%, transparent);
        color: var(--profit);
      }
      .test--failed .status-pill {
        background: color-mix(in srgb, var(--loss) 20%, transparent);
        color: var(--loss);
      }
      .test--skipped .status-pill {
        background: color-mix(in srgb, var(--text-tertiary) 20%, transparent);
        color: var(--text-secondary);
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
      .sweep-btn {
        background: var(--bg-primary);
        color: var(--accent);
        border: 1px solid var(--border);
        padding: 0.45rem 1rem;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
      }
      .sweep-btn:disabled {
        opacity: 0.6;
        cursor: progress;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 1rem 1.25rem;
      }
      .card-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.75rem;
        margin-bottom: 0.75rem;
      }
      .card-head h3 {
        margin: 0;
        font-size: 1rem;
      }
      .card-head .sub {
        font-size: 0.8rem;
        color: var(--text-secondary);
      }
      .table-wrap {
        overflow-x: auto;
      }
      .matrix {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
      }
      .matrix th,
      .matrix td {
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        text-align: left;
      }
      .matrix th {
        font-size: 0.75rem;
        color: var(--text-secondary);
        font-weight: 500;
      }
      .matrix .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .matrix tr.row {
        cursor: pointer;
      }
      .matrix tr.row:hover,
      .matrix tr.selected {
        background: var(--bg-primary);
      }
      .pair {
        font-weight: 600;
        white-space: nowrap;
      }
      .cell,
      .verdict {
        font-size: 0.75rem;
        font-weight: 600;
        white-space: nowrap;
        color: var(--text-secondary);
      }
      .cell[data-status='Passed'],
      .verdict[data-verdict='clean'] {
        color: var(--profit);
      }
      .cell[data-status='Failed'],
      .verdict[data-verdict='failed'] {
        color: var(--loss);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .tests-explained {
        margin: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
        gap: 0.75rem 1.5rem;
      }
      .tests-explained dt {
        font-weight: 600;
        font-size: 0.875rem;
      }
      .tests-explained dd {
        margin: 0.15rem 0 0;
        font-size: 0.85rem;
        color: var(--text-secondary);
      }
    `,
  ],
})
export class LookAheadAuditPageComponent {
  private readonly svc = inject(AnalyserComparisonService);
  private readonly config = inject(ConfigService);

  readonly tests = AUDIT_TESTS;
  readonly verdictLabel = VERDICT_LABEL;
  readonly enabledKey = ENABLED_KEY;
  readonly links = [
    { label: 'Analyser comparison', route: '/analyser-comparison' },
    {
      label: 'Engine config (SyntheticAnalyser)',
      route: '/engine-config',
      query: { search: 'SyntheticAnalyser' },
    },
  ];

  /** The analyser's settings, read from the engine; null until they answer. */
  private readonly settings = signal<Record<string, ConfigLite | null> | null>(null);
  readonly pairs = computed<AuditPair[]>(() => parsePairs(this.settings()?.[PAIRS_KEY]?.value));

  readonly analyser = computed(() => {
    const s = this.settings();
    if (!s) return null;
    const on = parseFlag(s[ENABLED_KEY]?.value);
    const dispatch = parseFlag(s[DISPATCH_KEY]?.value);
    const pairs = this.pairs();
    const requirements: FeatureRequirement[] = [
      {
        label: 'Analyser worker switched on',
        ok: on,
        detail: s[ENABLED_KEY]
          ? `${ENABLED_KEY} = ${s[ENABLED_KEY]!.value}`
          : 'no setting — code default applies',
        route: '/engine-config',
        query: { search: 'SyntheticAnalyserWorker' },
      },
      {
        label: 'Pairs it covers',
        ok: pairs.length > 0,
        detail: pairs.length
          ? pairs.map((p) => `${p.symbol} ${p.timeframe}`).join(', ')
          : `${PAIRS_KEY} is empty — nothing is analysed`,
      },
      {
        label: 'Signals sent to live trading',
        ok: dispatch,
        detail:
          dispatch === false
            ? `off (${DISPATCH_KEY} = false${s[DISPATCH_KEY]?.lastUpdatedAt ? ' since ' + s[DISPATCH_KEY]!.lastUpdatedAt!.slice(0, 10) : ''}) — decisions are recorded and scored, never traded. Operator's choice.`
            : dispatch
              ? 'on — keep this audit clean'
              : 'no setting',
      },
    ];
    return {
      kind: on === false ? ('off' as const) : ('on' as const),
      label: on === false ? 'Off' : dispatch ? 'On · trading live' : 'On · recording only',
      detail:
        pairs.length > 0
          ? `The audit below ran on open for all ${pairs.length} covered pairs; any symbol and timeframe can be audited with the form.`
          : 'No pair is configured, so the audit has nothing recorded to inspect; T2–T4 still run for any symbol.',
      requirements,
    };
  });

  readonly sweeping = signal(false);
  readonly sweepRows = signal<LookAheadAuditReport[]>([]);
  readonly sweepAt = signal<string | null>(null);
  readonly sweepDone = computed(() => this.sweepRows().length);
  readonly cleanCount = computed(
    () => this.sweepRows().filter((r) => verdictOf(r) === 'clean').length,
  );
  readonly partialCount = computed(
    () => this.sweepRows().filter((r) => verdictOf(r) === 'partial').length,
  );
  readonly failedPairs = computed(
    () => this.sweepRows().filter((r) => verdictOf(r) === 'failed').length,
  );

  constructor() {
    const keys = [PAIRS_KEY, ENABLED_KEY, DISPATCH_KEY];
    from(keys)
      .pipe(
        concatMap((k) =>
          this.config.getByKey(k, { silent: true }).pipe(
            map((r) =>
              r.status && r.data
                ? ({
                    value: r.data.value ?? '',
                    lastUpdatedAt: r.data.lastUpdatedAt ?? null,
                  } as ConfigLite)
                : null,
            ),
            catchError(() => of(null)),
          ),
        ),
        toArray(),
      )
      .subscribe((rows) => {
        const rec: Record<string, ConfigLite | null> = {};
        keys.forEach((k, i) => (rec[k] = rows[i]));
        this.settings.set(rec);
        const first = this.pairs()[0];
        if (first) {
          this.symbol.set(first.symbol);
          this.timeframe.set(first.timeframe);
          this.sweep();
        }
      });
  }

  /** Runs the audit (read-only on the engine, ~1 s each) for every covered pair, one at a time. */
  sweep(): void {
    const pairs = this.pairs();
    if (this.sweeping() || pairs.length === 0) return;
    this.sweeping.set(true);
    this.sweepRows.set([]);
    this.sweepAt.set(new Date().toISOString());
    from(pairs)
      .pipe(
        concatMap((p) =>
          this.svc.runAudit({ symbol: p.symbol, timeframe: p.timeframe }).pipe(
            map((r) => (r.status && r.data ? r.data : null)),
            catchError(() => of(null)),
          ),
        ),
      )
      .subscribe({
        next: (r) => {
          if (!r) return;
          this.sweepRows.update((rows) => [...rows, r]);
          if (!this.report()) this.report.set(r);
        },
        complete: () => this.sweeping.set(false),
      });
  }

  cell(r: LookAheadAuditReport, key: string): string | null {
    return testStatus(r, key);
  }
  verdict(r: LookAheadAuditReport) {
    return verdictOf(r);
  }

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

    // The field is labelled "UTC", so read it as UTC. `new Date(raw)` parses a
    // zone-less datetime-local value as BROWSER-local time — an operator in WAT who
    // typed 10:00 (UTC, as asked) audited 09:00 UTC, a different bar.
    let sampleAtIso: string | undefined;
    const raw = this.sampleAtLocal();
    if (raw) {
      const d = new Date(`${raw.length === 16 ? raw + ':00' : raw}Z`);
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

function parseFlag(v: string | null | undefined): boolean | null {
  const t = (v ?? '').trim().toLowerCase();
  return t === 'true' ? true : t === 'false' ? false : null;
}
