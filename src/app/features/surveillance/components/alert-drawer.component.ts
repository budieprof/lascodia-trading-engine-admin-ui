import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { errorText } from '@features/iam/iam.logic';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

import { SurveillanceApiService } from '../surveillance-api.service';
import {
  MIN_CLOSE_NOTE,
  RESOLUTIONS,
  metricText,
  resolutionLabel,
  severityTone,
  statusLabel,
  transitionProblem,
} from '../surveillance.logic';
import type {
  SurveillanceAlertDetail,
  SurveillanceResolution,
  SurveillanceStatus,
} from '../surveillance.types';

/**
 * One surveillance alert: what was seen, the evidence the detector stored (orders, fills, positions,
 * quotes, metrics against thresholds, timeline) and its review. Review actions need
 * `surveillance.review`; every one is written to the alert's timeline and the audit log by the engine.
 */
@Component({
  selector: 'app-surveillance-alert-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModalA11yDirective],
  styleUrls: ['./alert-drawer.component.scss'],
  template: `
    <div class="backdrop" (click)="closed.emit()" aria-hidden="true"></div>
    <aside
      class="drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="surv-drawer-title"
      appModalA11y
      (dismiss)="closed.emit()"
    >
      @if (detail(); as d) {
        <header class="d-head">
          <div>
            <div class="pills">
              <span class="pill" [class]="'pill ' + tone(d.alert.severity)">{{ d.alert.severity }}</span>
              <span class="pill">{{ d.alert.detectorName }}</span>
              <span class="pill info">{{ label(d.alert.status) }}</span>
              @if (d.alert.resolution) {
                <span class="pill">{{ resolution(d.alert.resolution) }}</span>
              }
            </div>
            <h3 id="surv-drawer-title">{{ d.alert.title }}</h3>
            <p class="sub">
              #{{ d.alert.id }} · detected {{ d.alert.detectedAtUtc.slice(0, 16).replace('T', ' ') }} UTC
              @if (d.alert.account) {
                · {{ d.alert.account }}
              }
              @if (d.alert.assignedToDisplay || d.alert.assignedTo) {
                · with {{ d.alert.assignedToDisplay || d.alert.assignedTo }}
              }
            </p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-autofocus (click)="closed.emit()">
            Close
          </button>
        </header>

        <section class="block">
          <p>{{ d.summary }}</p>
          <p class="muted small">{{ d.detectorDescription }}</p>
        </section>

        @if (metrics().length || thresholds().length) {
          <section class="block">
            <h4>Measured against the thresholds</h4>
            <table class="kv">
              <tbody>
                @for (m of metrics(); track m[0]) {
                  <tr>
                    <th>{{ m[0] }}</th>
                    <td>{{ m[1] }}</td>
                  </tr>
                }
                @for (t of thresholds(); track t[0]) {
                  <tr class="limit">
                    <th>limit · {{ t[0] }}</th>
                    <td>{{ t[1] }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        @if (d.evidence.orders?.length) {
          <section class="block">
            <h4>Orders and fills ({{ d.evidence.orders!.length }})</h4>
            <div class="table-wrap">
              <table class="grid small">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Account</th>
                    <th>Side</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Placed</th>
                    <th>Filled / cancelled</th>
                  </tr>
                </thead>
                <tbody>
                  @for (o of d.evidence.orders; track o.id) {
                    <tr>
                      <td class="mono">#{{ o.id }}</td>
                      <td>#{{ o.accountId }}</td>
                      <td>{{ o.side }}</td>
                      <td>{{ o.executionType }}</td>
                      <td>{{ o.status }}</td>
                      <td>{{ o.fillQuantity }}</td>
                      <td>{{ o.filledPrice ?? o.price }}</td>
                      <td class="nowrap">{{ time(o.createdAtUtc) }}</td>
                      <td class="nowrap">{{ time(o.filledAtUtc ?? o.cancelledAtUtc) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (d.evidence.ordersOmitted) {
              <p class="muted small">{{ d.evidence.ordersOmitted }} more order(s) not stored in the evidence.</p>
            }
          </section>
        }

        @if (d.evidence.positions?.length) {
          <section class="block">
            <h4>Positions ({{ d.evidence.positions!.length }})</h4>
            <div class="table-wrap">
              <table class="grid small">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Account</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Lots</th>
                    <th>Opened</th>
                    <th>Closed</th>
                    <th>Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of d.evidence.positions; track p.id) {
                    <tr>
                      <td class="mono">#{{ p.id }}</td>
                      <td>#{{ p.accountId }}</td>
                      <td>{{ p.symbol }}</td>
                      <td>{{ p.isLong ? 'Long' : 'Short' }}</td>
                      <td>{{ p.lots }}</td>
                      <td class="nowrap">{{ time(p.openedAtUtc) }}</td>
                      <td class="nowrap">{{ p.isOpen ? 'open' : time(p.closedAtUtc) }}</td>
                      <td>{{ p.netPnl ?? '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        @if (d.evidence.quotes?.length) {
          <section class="block">
            <h4>Reference quotes</h4>
            <ul class="plain">
              @for (q of d.evidence.quotes; track q.label) {
                <li>
                  {{ q.label }}: {{ q.symbol }} {{ q.bid }} / {{ q.ask }}
                  <span class="muted">at {{ time(q.atUtc) }}</span>
                </li>
              }
            </ul>
          </section>
        }

        @if (d.evidence.timeline?.length) {
          <section class="block">
            <h4>What happened</h4>
            <ol class="timeline">
              @for (t of d.evidence.timeline; track $index) {
                <li>
                  <span class="t">{{ time(t.atUtc) }}</span> {{ t.text }}
                </li>
              }
            </ol>
          </section>
        }

        <section class="block review">
          <h4>Review</h4>
          @if (canReview()) {
            @if (d.alert.status !== 'Closed') {
              <div class="actions">
                @if (!d.alert.assignedTo) {
                  <button type="button" class="btn btn-sm btn-secondary" [disabled]="busy()" (click)="takeIt()">
                    Take it
                  </button>
                }
                @if (d.nextStatuses.includes('UnderReview')) {
                  <button type="button" class="btn btn-sm btn-secondary" [disabled]="busy()" (click)="move('UnderReview')">
                    Start review
                  </button>
                }
                @if (d.nextStatuses.includes('Open')) {
                  <button type="button" class="btn btn-sm btn-ghost" [disabled]="busy()" (click)="move('Open')">
                    Back to the queue
                  </button>
                }
              </div>
              <div class="close-form">
                <span class="label">Close as</span>
                <div class="seg" role="radiogroup" aria-label="Resolution">
                  @for (r of resolutions; track r) {
                    <button
                      type="button"
                      role="radio"
                      [class.on]="resolutionPick() === r"
                      [attr.aria-checked]="resolutionPick() === r"
                      (click)="resolutionPick.set(r)"
                    >
                      {{ resolution(r) }}
                    </button>
                  }
                </div>
              </div>
            }
            <label class="field">
              <span class="label">Note {{ d.alert.status !== 'Closed' ? '(why — needed to close, at least ' + minNote + ' characters)' : '' }}</span>
              <textarea class="input" rows="3" name="note" [ngModel]="note()" (ngModelChange)="note.set($event)"></textarea>
            </label>
            <div class="actions">
              <button type="button" class="btn btn-sm btn-secondary" [disabled]="busy() || !note().trim()" (click)="addNote()">
                Add note
              </button>
              @if (d.alert.status !== 'Closed') {
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  [disabled]="busy() || !!closeProblem()"
                  [title]="closeProblem() ?? ''"
                  (click)="move('Closed')"
                >
                  Close alert
                </button>
              }
            </div>
            @if (closeProblem() && d.alert.status !== 'Closed') {
              <p class="muted small">{{ closeProblem() }}</p>
            }
          } @else {
            <p class="muted small">Reviewing alerts needs the <code>surveillance.review</code> permission.</p>
          }
          @if (error()) {
            <p class="alert" role="alert">{{ error() }}</p>
          }
        </section>

        <section class="block">
          <h4>Timeline</h4>
          <ol class="timeline">
            @for (e of d.events; track e.id) {
              <li>
                <span class="t">{{ time(e.occurredAtUtc) }}</span>
                <strong>{{ eventTitle(e.kind, e.toStatus, e.resolution) }}</strong>
                — {{ e.actorDisplay || e.actor }}
                @if (e.note) {
                  <div class="note">{{ e.note }}</div>
                }
              </li>
            }
          </ol>
        </section>
        <p class="notice">{{ d.notice }}</p>
      } @else if (loadError()) {
        <p class="alert" role="alert">{{ loadError() }}</p>
        <button type="button" class="btn btn-sm btn-ghost" data-autofocus (click)="closed.emit()">Close</button>
      } @else {
        <p class="muted">Loading the alert…</p>
        <button type="button" class="btn btn-sm btn-ghost" data-autofocus (click)="closed.emit()">Close</button>
      }
    </aside>
  `,
})
export class SurveillanceAlertDrawerComponent implements OnInit {
  private readonly api = inject(SurveillanceApiService);
  private readonly auth = inject(AuthService);

  readonly alertId = input.required<number>();
  readonly closed = output<void>();
  /** Emitted after a review change so the list refreshes. */
  readonly changed = output<void>();

  protected readonly resolutions = RESOLUTIONS;
  protected readonly minNote = MIN_CLOSE_NOTE;
  protected readonly label = statusLabel;
  protected readonly resolution = resolutionLabel;
  protected readonly tone = severityTone;

  readonly detail = signal<SurveillanceAlertDetail | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly note = signal('');
  readonly resolutionPick = signal<SurveillanceResolution | null>(null);
  readonly canReview = computed(() => this.auth.hasPermission(Permission.SurveillanceReview));

  readonly metrics = computed(() =>
    Object.entries(this.detail()?.evidence.metrics ?? {}).map(([k, v]) => [k, metricText(v)] as const),
  );
  readonly thresholds = computed(() =>
    Object.entries(this.detail()?.evidence.thresholds ?? {}).map(([k, v]) => [k, metricText(v)] as const),
  );
  readonly closeProblem = computed(() => {
    const d = this.detail();
    return d ? transitionProblem(d.alert.status, 'Closed', this.resolutionPick(), this.note()) : null;
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.api.alert(this.alertId()).subscribe({
      next: (d) => this.detail.set(d),
      error: (e) => this.loadError.set(errorText(e, 'Could not load the alert.')),
    });
  }

  time(iso: string | null | undefined): string {
    return iso ? iso.slice(0, 19).replace('T', ' ') : '—';
  }

  eventTitle(kind: string, to: SurveillanceStatus | null, r: SurveillanceResolution | null): string {
    if (kind === 'StatusChanged' && to)
      return `→ ${statusLabel(to)}${r ? ' (' + resolutionLabel(r) + ')' : ''}`;
    return kind === 'Notified' ? 'Notified' : kind === 'Updated' ? 'Seen again' : kind;
  }

  private apply(call: ReturnType<SurveillanceApiService['alert']>, clearNote: boolean): void {
    this.busy.set(true);
    this.error.set(null);
    call.subscribe({
      next: (d) => {
        this.busy.set(false);
        this.detail.set(d);
        if (clearNote) this.note.set('');
        this.changed.emit();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorText(e, 'The change was not saved.'));
      },
    });
  }

  move(to: SurveillanceStatus): void {
    const d = this.detail();
    if (!d) return;
    const resolution = to === 'Closed' ? this.resolutionPick() : null;
    const problem = transitionProblem(d.alert.status, to, resolution, this.note());
    if (problem) {
      this.error.set(problem);
      return;
    }
    this.apply(
      this.api.transition(d.alert.id, { status: to, resolution, note: this.note().trim() || null }),
      true,
    );
  }

  takeIt(): void {
    const d = this.detail();
    if (d) this.apply(this.api.assign(d.alert.id, {}), false);
  }

  addNote(): void {
    const d = this.detail();
    if (d && this.note().trim()) this.apply(this.api.note(d.alert.id, this.note().trim()), true);
  }
}
