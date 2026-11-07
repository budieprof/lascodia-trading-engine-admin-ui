import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { NewsIntelService } from '@core/services/news-intel.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { createPolledResource } from '@core/polling/polled-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  EvalMetrics,
  draftCaveat,
  evalRunActive,
  fmt,
  parseEvalMetrics,
  pct,
} from '../news-intel.logic';
import {
  NEWS_CATEGORIES,
  NEWS_CERTAINTIES,
  NEWS_DIRECTIONS,
  NEWS_STANCES,
  NewsEvalRunView,
  NewsGoldEditRequest,
  NewsGoldLabelView,
  NewsGoldProvenance,
} from '../news-intel.types';

const PAGE = 50;

type Pending = { kind: 'seed' } | { kind: 'run' };

/**
 * Gold set & evals — the labelling queue the classifier is judged against (agent drafts → operator
 * confirmed / edited) and the evaluation runs that judge it (per-field accuracy / F1, run-to-run
 * agreement, triage precision / recall).
 *
 * The shipped seed is AGENT-labelled from headline + summary; every draft says so and every score
 * graded against drafts carries that caveat. Confirm / edit / seed / run need `platform.data.manage`.
 */
@Component({
  selector: 'app-news-evals-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NewsIntelNavComponent, ConfirmDialogComponent, FeatureStateComponent],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header>
        <h1>Gold set &amp; evaluations</h1>
        <p class="muted small">
          A labelled sample the classifier is scored against. Prompt or model changes are judged by
          re-running the evaluation, not by eye.
        </p>
      </header>
      <app-news-intel-nav
        [showRefresh]="true"
        [refreshing]="runs.refreshing()"
        (refresh)="runs.refresh(); loadGold()"
      />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }

      <!-- ── Evaluation runs ── -->
      <section class="card">
        <div class="card-head">
          <div>
            <h2>Evaluation runs</h2>
            <p class="muted xsmall">
              A run classifies the gold articles with the CURRENT configuration (one model call per
              batch per pass — the classification provider's quota, shared with spot analysis) and
              scores it. One run at a time.
            </p>
          </div>
          @if (canManage()) {
            <div class="filters">
              <label class="small"
                >Passes
                <select class="sel" (change)="repeats.set(+$any($event.target).value)">
                  <option value="1">1</option>
                  <option value="2" selected>2 (agreement)</option>
                </select></label
              >
              <label class="small"
                ><input
                  type="checkbox"
                  [checked]="reviewedOnly()"
                  (change)="reviewedOnly.set(!reviewedOnly())"
                />
                reviewed labels only</label
              >
              <button
                type="button"
                class="btn primary"
                [disabled]="busy() || anyRunning()"
                (click)="pending.set({ kind: 'run' })"
              >
                {{ anyRunning() ? 'A run is in progress' : 'Run evaluation' }}
              </button>
            </div>
          }
        </div>
        @if (runs.value(); as list) {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Started (UTC)</th>
                  <th>Status</th>
                  <th>Model / prompt</th>
                  <th>Triage</th>
                  <th class="num">Articles</th>
                  <th class="num">Relevance F1</th>
                  <th class="num">Category F1</th>
                  <th class="num">Direction F1</th>
                  <th class="num">Agreement</th>
                </tr>
              </thead>
              <tbody>
                @for (r of list; track r.id) {
                  <tr
                    class="clickable"
                    (click)="openRun(r)"
                    [class.sel-row]="detail()?.id === r.id"
                  >
                    <td class="mono">{{ r.id }}</td>
                    <td class="xsmall">{{ r.startedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</td>
                    <td>
                      <span
                        class="pill"
                        [class.ok]="r.status === 'Completed'"
                        [class.bad]="r.status === 'Failed' || r.status === 'Abandoned'"
                        [class.info]="r.status === 'Running'"
                        >{{ r.status }}</span
                      >
                    </td>
                    <td class="xsmall mono">
                      {{ r.classifierModel ?? '—' }}<br /><span class="muted">{{
                        r.promptVersion ?? ''
                      }}</span>
                    </td>
                    <td class="xsmall">{{ r.triageMode ?? '—' }}</td>
                    <td class="num">
                      {{ r.articleCount }}
                      @if (r.draftLabelCount) {
                        <span class="muted xsmall" title="labels that are unreviewed agent drafts"
                          >({{ r.draftLabelCount }} draft)</span
                        >
                      }
                    </td>
                    <td class="num">{{ f(r.relevanceF1) }}</td>
                    <td class="num">{{ f(r.categoryMacroF1) }}</td>
                    <td class="num">{{ f(r.directionMacroF1) }}</td>
                    <td class="num">{{ p(r.runToRunAgreement) }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="10" class="empty">
                      No evaluation has run yet. Seed the gold set, then run one to record the
                      baseline.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (detail(); as d) {
          <div class="run-detail">
            <h3>Run #{{ d.id }}</h3>
            @if (d.error) {
              <div class="banner error">{{ d.error }}</div>
            }
            @if (metrics(); as m) {
              @if (caveat(); as c) {
                <div class="banner warn">{{ c }}</div>
              }
              <p class="muted xsmall">
                Tracked keys: {{ m.trackedKeys.join(', ') || '—' }} ·
                {{ m.reviewedOnly ? 'reviewed labels only' : 'all labels' }}
              </p>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pass</th>
                      <th class="num">Verdicts</th>
                      <th class="num">Relevance P / R / F1</th>
                      <th class="num">Exposure pairs P / R</th>
                      <th class="num">Category acc / F1</th>
                      <th class="num">Direction acc / F1</th>
                      <th class="num">Certainty acc / F1</th>
                      <th class="num">Relevance MAE</th>
                      <th class="num">Stance acc</th>
                      <th class="num">Same-event P / R</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (ps of m.passes; track $index) {
                      <tr>
                        <td>{{ $index + 1 }}</td>
                        <td class="num">{{ ps.articlesWithVerdict }} / {{ ps.articles }}</td>
                        <td class="num">
                          {{ f(ps.relevance?.precision) }} / {{ f(ps.relevance?.recall) }} /
                          {{ f(ps.relevance?.f1) }}
                        </td>
                        <td class="num">
                          {{ f(ps.exposurePairs?.precision) }} / {{ f(ps.exposurePairs?.recall) }}
                        </td>
                        <td class="num">
                          {{ f(ps.category?.accuracy) }} / {{ f(ps.category?.macroF1) }}
                        </td>
                        <td class="num">
                          {{ f(ps.direction?.accuracy) }} / {{ f(ps.direction?.macroF1) }}
                        </td>
                        <td class="num">
                          {{ f(ps.certainty?.accuracy) }} / {{ f(ps.certainty?.macroF1) }}
                        </td>
                        <td class="num">{{ f(ps.relevanceMae) }}</td>
                        <td class="num">{{ f(ps.stanceAccuracy) }}</td>
                        <td class="num">
                          {{ f(ps.sameEventPairs?.precision) }} /
                          {{ f(ps.sameEventPairs?.recall) }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (m.agreement; as a) {
                <p class="small">
                  Run-to-run agreement over {{ a.articles }} articles: overall {{ p(a.overall) }} ·
                  relevance {{ p(a.relevance) }} · exposure set {{ p(a.exposureSet) }} · category +
                  direction {{ p(a.categoryAndDirection) }}
                </p>
              }
              @if (m.triage; as t) {
                <p class="small">
                  Triage ({{ t.mode }}): precision {{ f(t.precision) }}, recall {{ f(t.recall) }},
                  {{ t.screenedOut }} screened out. Leave triage Off until recall ≥ ~0.97.
                </p>
              }
              @if (m.passes[0]?.category; as cat) {
                <details>
                  <summary class="small">Per-category F1 (pass 1)</summary>
                  <div class="legs">
                    @for (c of perClass(cat.perClassF1); track c.k) {
                      <span class="pill">{{ c.k }} {{ f(c.v, 2) }}</span>
                    }
                  </div>
                </details>
              }
            } @else if (d.status === 'Running') {
              <p class="muted small">Running… the page checks every 15 seconds.</p>
            } @else if (!d.error) {
              <p class="muted small">No metrics recorded for this run.</p>
            }
          </div>
        }
      </section>

      <!-- ── Gold labels ── -->
      <section class="card">
        <div class="card-head">
          <div>
            <h2>Gold labels</h2>
            <p class="muted xsmall">
              @for (c of provenanceCounts(); track c.k) {
                {{ c.k }}: {{ c.v }} ·
              }
              agent drafts were labelled by an agent from headline + summary and need an operator's
              confirmation or edit.
            </p>
          </div>
          <div class="filters">
            <select
              class="sel"
              aria-label="Provenance"
              (change)="setProvenance($any($event.target).value)"
            >
              <option value="AgentDraft" selected>Awaiting review (agent drafts)</option>
              <option value="OperatorConfirmed">Confirmed</option>
              <option value="OperatorEdited">Edited</option>
              <option value="">All</option>
            </select>
            <input
              class="inp mono"
              placeholder="Exposure key"
              aria-label="Exposure key"
              (change)="setExposure($any($event.target).value)"
            />
            @if (canManage()) {
              <button
                type="button"
                class="btn"
                [disabled]="busy()"
                (click)="pending.set({ kind: 'seed' })"
              >
                Seed from fixture
              </button>
            }
          </div>
        </div>

        @if (gold(); as g) {
          @if (g.total === 0 && !provenance() && !exposure()) {
            <app-feature-state
              kind="off"
              title="The gold set is empty"
              summary="Seed it from the shipped fixture (299 articles, agent-drafted from headline + summary). Seeding is idempotent and never overwrites a review."
              [requirements]="[{ label: 'platform.data.manage to seed', ok: canManage() }]"
            />
          }
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Article</th>
                  <th>Key</th>
                  <th>Relevant</th>
                  <th>Category</th>
                  <th>Direction</th>
                  <th>Certainty</th>
                  <th class="num">Relevance</th>
                  <th>Stance / event</th>
                  <th>Provenance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (l of g.items; track l.id) {
                  @if (editing()?.id === l.id) {
                    <tr class="row-detail">
                      <td>
                        <div class="small">{{ l.title }}</div>
                        <div class="muted xsmall">{{ l.sourceName }}</div>
                      </td>
                      <td class="mono">{{ l.exposureKey }}</td>
                      <td>
                        <select
                          class="sel"
                          (change)="patch({ relevant: $any($event.target).value === 'true' })"
                        >
                          <option value="true" [selected]="l.relevant">yes</option>
                          <option value="false" [selected]="!l.relevant">no</option>
                        </select>
                      </td>
                      <td>
                        <select
                          class="sel"
                          (change)="patch({ category: $any($event.target).value })"
                        >
                          @for (c of categories; track c) {
                            <option [value]="c" [selected]="c === l.category">{{ c }}</option>
                          }
                        </select>
                      </td>
                      <td>
                        <select
                          class="sel"
                          (change)="patch({ direction: $any($event.target).value })"
                        >
                          @for (c of directions; track c) {
                            <option [value]="c" [selected]="c === l.direction">{{ c }}</option>
                          }
                        </select>
                      </td>
                      <td>
                        <select
                          class="sel"
                          (change)="patch({ certainty: $any($event.target).value })"
                        >
                          @for (c of certainties; track c) {
                            <option [value]="c" [selected]="c === l.certainty">{{ c }}</option>
                          }
                        </select>
                      </td>
                      <td class="num">
                        <input
                          class="inp num-in"
                          type="number"
                          min="0"
                          max="1"
                          step="0.05"
                          [value]="l.relevance"
                          (change)="patch({ relevance: +$any($event.target).value })"
                        />
                      </td>
                      <td>
                        <select class="sel" (change)="patch({ stance: $any($event.target).value })">
                          @for (c of stances; track c) {
                            <option [value]="c" [selected]="c === l.stance">{{ c }}</option>
                          }
                        </select>
                        <input
                          class="inp mono"
                          placeholder="event key"
                          [value]="l.eventKey ?? ''"
                          (change)="patch({ eventKey: $any($event.target).value })"
                        />
                      </td>
                      <td colspan="2">
                        <input
                          class="inp"
                          placeholder="note (optional)"
                          [value]="l.note ?? ''"
                          (change)="patch({ note: $any($event.target).value })"
                        />
                        <div class="filters">
                          <button
                            type="button"
                            class="btn primary"
                            [disabled]="busy()"
                            (click)="saveEdit(l)"
                          >
                            Save
                          </button>
                          <button type="button" class="btn subtle" (click)="editing.set(null)">
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td>
                        <div class="small">{{ l.title }}</div>
                        <div class="muted xsmall">
                          #{{ l.articleId }} · {{ l.sourceName }} ·
                          {{ l.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}
                        </div>
                      </td>
                      <td class="mono">{{ l.exposureKey }}</td>
                      <td>{{ l.relevant ? 'yes' : 'no' }}</td>
                      <td>{{ l.category }}</td>
                      <td>{{ l.direction }}</td>
                      <td>{{ l.certainty }}</td>
                      <td class="num">{{ f(l.relevance, 2) }}</td>
                      <td class="xsmall">
                        {{ l.stance }}
                        @if (l.eventKey) {
                          <div class="mono muted">{{ l.eventKey }}</div>
                        }
                      </td>
                      <td>
                        <span
                          class="pill"
                          [class.warn]="l.provenance === 'AgentDraft'"
                          [class.ok]="l.provenance !== 'AgentDraft'"
                          [title]="
                            l.labeller + ' · ' + (l.labelledAtUtc | date: 'MMM d HH:mm' : 'UTC')
                          "
                          >{{ provLabel(l.provenance) }}</span
                        >
                      </td>
                      <td>
                        @if (canManage()) {
                          <div class="filters">
                            @if (l.provenance === 'AgentDraft') {
                              <button
                                type="button"
                                class="btn"
                                [disabled]="busy()"
                                (click)="confirm(l)"
                              >
                                Confirm
                              </button>
                            }
                            <button type="button" class="btn subtle" (click)="startEdit(l)">
                              Edit
                            </button>
                          </div>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr>
                    <td colspan="10" class="empty">
                      {{
                        provenance() === 'AgentDraft'
                          ? 'Every draft has been reviewed.'
                          : 'No gold label matches.'
                      }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (g.total > pageSize) {
            <div class="filters">
              <button type="button" class="btn subtle" [disabled]="skip() === 0" (click)="page(-1)">
                ‹ Prev
              </button>
              <span class="small muted"
                >{{ skip() + 1 }}–{{ min(skip() + pageSize, g.total) }} of {{ g.total }}</span
              >
              <button
                type="button"
                class="btn subtle"
                [disabled]="skip() + pageSize >= g.total"
                (click)="page(1)"
              >
                Next ›
              </button>
            </div>
          }
        } @else {
          <p class="muted small">Loading…</p>
        }
      </section>

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="pending()?.kind === 'seed' ? 'Seed the gold set?' : 'Run an evaluation?'"
        [message]="pendingText()"
        [confirmLabel]="pending()?.kind === 'seed' ? 'Seed' : 'Run'"
        [loading]="busy()"
        (confirm)="doPending()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
  styles: [
    `
      .run-detail {
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .sel-row td {
        background: var(--bg-tertiary);
      }
      .num-in {
        width: 70px;
      }
    `,
  ],
})
export class NewsEvalsPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly categories = NEWS_CATEGORIES;
  protected readonly directions = NEWS_DIRECTIONS;
  protected readonly certainties = NEWS_CERTAINTIES;
  protected readonly stances = NEWS_STANCES;
  protected readonly pageSize = PAGE;
  protected readonly min = Math.min;

  readonly canManage = computed(() => this.auth.hasPermission(Permission.PlatformDataManage));

  readonly runs = createPolledResource(() => this.svc.getEvalRuns(20), { intervalMs: 15_000 });
  readonly anyRunning = computed(() => (this.runs.value() ?? []).some((r) => evalRunActive(r)));
  readonly detail = signal<NewsEvalRunView | null>(null);
  readonly metrics = computed<EvalMetrics | null>(() =>
    parseEvalMetrics(this.detail()?.metricsJson),
  );
  readonly caveat = computed(() => {
    const d = this.detail();
    return d ? draftCaveat(d, this.metrics()?.draftShare ?? null) : null;
  });

  readonly provenance = signal<NewsGoldProvenance | null>('AgentDraft');
  readonly exposure = signal('');
  readonly skip = signal(0);
  readonly gold = signal<{
    total: number;
    items: NewsGoldLabelView[];
    countsByProvenance: Record<string, number>;
  } | null>(null);
  readonly provenanceCounts = computed(() =>
    Object.entries(this.gold()?.countsByProvenance ?? {}).map(([k, v]) => ({
      k: this.provLabel(k),
      v,
    })),
  );
  readonly editing = signal<NewsGoldLabelView | null>(null);
  readonly edits = signal<NewsGoldEditRequest>({});

  readonly repeats = signal(2);
  readonly reviewedOnly = signal(false);
  readonly pending = signal<Pending | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  readonly pendingText = computed(() =>
    this.pending()?.kind === 'seed'
      ? 'Applies the shipped agent-drafted fixture to articles still in the store (matched by content). Idempotent: existing rows, including every review, are kept.'
      : `Classifies the gold articles ${this.repeats()} time(s) with the current configuration${this.reviewedOnly() ? ' (reviewed labels only)' : ''}. Costs model calls on the classification provider, which spot analysis shares; bounded by NewsIntel:Eval:MaxArticles.`,
  );

  constructor() {
    this.loadGold();
    // The list is polled; an open run that changed status there (Running → Completed) is re-read
    // so its metrics appear without a click.
    effect(() => {
      const list = this.runs.value() ?? [];
      untracked(() => {
        const d = this.detail();
        const fresh = d ? list.find((r) => r.id === d.id) : undefined;
        if (d && fresh && fresh.status !== d.status) {
          this.svc
            .getEvalRun(d.id)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({ next: (full) => this.detail.set(full), error: () => undefined });
        }
      });
    });
  }

  loadGold(): void {
    this.svc
      .getGold({
        provenance: this.provenance(),
        exposure: this.exposure() || undefined,
        skip: this.skip(),
        take: PAGE,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (g) => this.gold.set(g),
        error: (e) => {
          this.gold.set({ total: 0, items: [], countsByProvenance: {} });
          this.error.set(errorText(e, 'Could not load the gold set.'));
        },
      });
  }

  setProvenance(v: string): void {
    this.provenance.set(v ? (v as NewsGoldProvenance) : null);
    this.skip.set(0);
    this.loadGold();
  }

  setExposure(v: string): void {
    this.exposure.set(v.trim().toUpperCase());
    this.skip.set(0);
    this.loadGold();
  }

  page(dir: number): void {
    this.skip.set(Math.max(0, this.skip() + dir * PAGE));
    this.loadGold();
  }

  provLabel(p: string): string {
    return p === 'AgentDraft'
      ? 'Agent draft'
      : p === 'OperatorConfirmed'
        ? 'Confirmed'
        : p === 'OperatorEdited'
          ? 'Edited'
          : p;
  }

  openRun(r: NewsEvalRunView): void {
    if (this.detail()?.id === r.id) {
      this.detail.set(null);
      return;
    }
    this.detail.set(r);
    this.svc
      .getEvalRun(r.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (full) => this.detail.set(full), error: () => undefined });
  }

  confirm(l: NewsGoldLabelView): void {
    this.busy.set(true);
    this.svc.confirmGold(l.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set(`Label #${l.id} confirmed.`);
        this.loadGold();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorText(e, 'Could not confirm the label.'));
      },
    });
  }

  startEdit(l: NewsGoldLabelView): void {
    this.editing.set(l);
    this.edits.set({});
  }

  patch(p: NewsGoldEditRequest): void {
    this.edits.update((e) => ({ ...e, ...p }));
  }

  saveEdit(l: NewsGoldLabelView): void {
    this.busy.set(true);
    this.svc.editGold(l.id, this.edits()).subscribe({
      next: (prov) => {
        this.busy.set(false);
        this.editing.set(null);
        this.notice.set(`Label #${l.id} saved as ${this.provLabel(prov)}.`);
        this.loadGold();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorText(e, 'Could not save the label.'));
      },
    });
  }

  doPending(): void {
    const p = this.pending();
    if (!p) return;
    this.busy.set(true);
    this.error.set(null);
    if (p.kind === 'seed') {
      this.svc.seedGold().subscribe({
        next: (r) => {
          this.busy.set(false);
          this.pending.set(null);
          this.notice.set(`Seeded: ${JSON.stringify(r)}`);
          this.loadGold();
        },
        error: (e) => {
          this.busy.set(false);
          this.pending.set(null);
          this.error.set(errorText(e, 'Seeding failed.'));
        },
      });
      return;
    }
    this.svc.runEval({ repeats: this.repeats(), reviewedOnly: this.reviewedOnly() }).subscribe({
      next: (run) => {
        this.busy.set(false);
        this.pending.set(null);
        this.notice.set(`Evaluation run #${run.id} started.`);
        this.detail.set(run);
        this.runs.refresh();
      },
      error: (e) => {
        this.busy.set(false);
        this.pending.set(null);
        this.error.set(errorText(e, 'The evaluation was not started.'));
      },
    });
  }

  f(v: number | null | undefined, d = 3): string {
    return fmt(v, d);
  }

  p(v: number | null | undefined): string {
    return pct(v);
  }

  perClass(m: Record<string, number>): { k: string; v: number }[] {
    return Object.entries(m)
      .map(([k, v]) => ({ k, v }))
      .sort((a, b) => a.v - b.v);
  }
}
