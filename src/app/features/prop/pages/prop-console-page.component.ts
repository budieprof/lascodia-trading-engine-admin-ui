import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PropGateComponent, PROP_DIALOG_STYLES } from '../components/prop-gate.component';
import { PropApiService } from '../prop-api.service';
import { lastId, mergeFeed, money, pct, ruleLabel, stateClass } from '../prop.logic';
import type { PropBreach, PropLeaderboardRow, PropProgram } from '../prop.types';

/** Seconds between breach-feed polls while the tab is visible. */
export const FEED_POLL_SECONDS = 15;

/**
 * The firm console (`prop.read`): the live breach feed — every breach and warning as the evaluation
 * engine records it, polled every 15 s while the page is visible — and the leaderboard of running
 * and passed enrolments, by program.
 */
@Component({
  selector: 'app-prop-console-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, PropGateComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [PROP_DIALOG_STYLES],
  template: `
    <div class="page">
      <app-page-header
        title="Prop firm"
        subtitle="Live breach feed and leaderboard of the organisation's challenge programs."
      />
      <app-prop-gate (ready)="start()">
        <section class="card">
          <header class="card-head">
            <h3>Live breach feed</h3>
            <span class="muted small">Refreshes every {{ pollSeconds }} s</span>
            <span class="spacer"></span>
            @if (feedError(); as err) {
              <span class="chip bad" role="alert">{{ err }}</span>
            }
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>When</th>
                  <th></th>
                  <th>Rule</th>
                  <th>Trader / account</th>
                  <th>What happened</th>
                </tr>
              </thead>
              <tbody>
                @for (b of feed(); track b.id) {
                  <tr>
                    <td class="small">{{ when(b.occurredAtUtc) }}</td>
                    <td>
                      <span
                        class="chip"
                        [class.bad]="b.severity === 'Breach'"
                        [class.warn]="b.severity === 'Warning'"
                        >{{ b.severity }}</span
                      >
                    </td>
                    <td>{{ ruleLabel(b.rule) }}</td>
                    <td>
                      <a [routerLink]="['/prop/enrollments', b.enrollmentId]">{{ b.traderName }}</a>
                      <span class="sub">{{ b.accountLabel }}</span>
                    </td>
                    <td class="small">{{ b.detail }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="muted">No breach or warning yet.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Leaderboard</h3>
            <span class="spacer"></span>
            <label class="row small">
              Program
              <select
                class="select"
                name="program"
                [ngModel]="programId()"
                (ngModelChange)="pickProgram($event)"
              >
                <option [ngValue]="null">All programs</option>
                @for (p of programs.value(); track p.id) {
                  <option [ngValue]="p.id">{{ p.name }}</option>
                }
              </select>
            </label>
          </header>
          @if (board.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Trader</th>
                  <th>Program · phase</th>
                  <th>State</th>
                  <th class="num">Profit</th>
                  <th class="num">Drawdown used</th>
                  <th class="num">Days</th>
                </tr>
              </thead>
              <tbody>
                @for (r of board.value(); track r.enrollmentId) {
                  <tr>
                    <td>{{ r.rank }}</td>
                    <td>
                      <a [routerLink]="['/prop/enrollments', r.enrollmentId]">{{ r.traderName }}</a>
                      <span class="sub">{{ r.accountLabel }}</span>
                    </td>
                    <td>{{ r.programName }} · {{ r.phaseName }}</td>
                    <td>
                      <span class="chip" [class]="'chip ' + stateClass(r.state)">{{
                        r.state
                      }}</span>
                    </td>
                    <td class="num" [class.pos]="r.profitPct > 0" [class.neg]="r.profitPct < 0">
                      {{ pct(r.profitPct) }}
                      @if (r.profitTargetPct !== null) {
                        <span class="sub">of {{ pct(r.profitTargetPct, 1) }}</span>
                      }
                    </td>
                    <td class="num">{{ pct(r.drawdownUsedPct, 1) }}</td>
                    <td class="num">{{ r.tradingDays }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="7" class="muted">No running or passed enrolment.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </app-prop-gate>
    </div>
  `,
})
export class PropConsolePageComponent {
  private readonly api = inject(PropApiService);

  protected readonly when = when;
  protected readonly money = money;
  protected readonly pct = pct;
  protected readonly ruleLabel = ruleLabel;
  protected readonly stateClass = stateClass;
  protected readonly pollSeconds = FEED_POLL_SECONDS;

  readonly feed = signal<PropBreach[]>([]);
  readonly feedError = signal<string | null>(null);
  readonly programId = signal<number | null>(null);
  readonly programs = iamResource<PropProgram[]>(
    () => this.api.programs(true),
    [],
    'Could not load the programs.',
  );
  readonly board = iamResource<PropLeaderboardRow[]>(
    () => this.api.leaderboard(this.programId()),
    [],
    'Could not load the leaderboard.',
  );

  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearInterval(this.timer);
    });
  }

  /** The module is available: load once, then poll the feed while the tab is visible. */
  start(): void {
    this.programs.reload();
    this.board.reload();
    this.pollFeed();
    this.timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible')
        this.pollFeed();
    }, FEED_POLL_SECONDS * 1000);
  }

  pickProgram(id: number | null): void {
    this.programId.set(id);
    this.board.reload();
  }

  pollFeed(): void {
    if (this.polling) return;
    this.polling = true;
    this.api.breaches(lastId(this.feed())).subscribe({
      next: (rows) => {
        this.polling = false;
        this.feedError.set(null);
        if (rows.length) {
          const first = this.feed().length === 0;
          this.feed.update((f) => mergeFeed(f, rows));
          if (!first) this.board.reload(); // a new breach moves an enrolment off the board
        }
      },
      error: (e) => {
        this.polling = false;
        this.feedError.set(errorText(e, 'The feed could not be refreshed.'));
      },
    });
  }
}
