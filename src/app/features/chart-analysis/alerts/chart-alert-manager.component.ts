import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import type { Observable } from 'rxjs';

import { ChartAlertFormComponent } from './chart-alert-form.component';
import { ChartScriptAlertsTabComponent } from './chart-script-alerts-tab.component';
import { describeAlert, statusLabel } from './chart-alert-rules';
import { ChartAlertsService } from './chart-alerts.service';
import type { ChartAlertDto, ChartAlertFireDto } from './chart-alerts.types';

type Scope = 'symbol' | 'all';
type Tab = 'alerts' | 'log' | 'scripts';

/**
 * The alert manager (alerts v2, SP-I2): the operator's chart alerts for this symbol or all symbols — pause, resume,
 * edit, clone, delete — and the fire log with what happened on every channel (delivered, skipped and why, failed); and
 * (SS-I1) the alerts on chart scripts, in their own tab.
 */
@Component({
  selector: 'app-chart-alert-manager',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartAlertFormComponent, ChartScriptAlertsTabComponent, DatePipe, NgTemplateOutlet],
  template: `
    <section class="cam" aria-label="Alerts">
      <header class="cam-head">
        <strong>Alerts</strong>
        <div class="cam-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            [class.on]="tab() === 'alerts'"
            (click)="tab.set('alerts')"
          >
            List
          </button>
          <button type="button" role="tab" [class.on]="tab() === 'log'" (click)="openLog()">
            Log
          </button>
          <button
            type="button"
            role="tab"
            [class.on]="tab() === 'scripts'"
            (click)="tab.set('scripts')"
            data-testid="cam-scripts-tab"
            title="Alerts on Pine scripts on the chart"
          >
            Script alerts
          </button>
        </div>
        <span class="cam-spacer"></span>
        <button type="button" class="cam-icon" title="Close" (click)="closed.emit()">✕</button>
      </header>

      <div class="cam-bar">
        <div class="cam-scope">
          <button type="button" [class.on]="scope() === 'symbol'" (click)="setScope('symbol')">
            {{ symbol() }}
          </button>
          <button type="button" [class.on]="scope() === 'all'" (click)="setScope('all')">
            All symbols
          </button>
        </div>
        @if (tab() === 'alerts') {
          <button type="button" class="cam-new" (click)="startNew()" data-testid="cam-new">
            + New alert
          </button>
        }
      </div>

      @if (editing(); as ed) {
        <div class="cam-editor">
          <app-chart-alert-form
            [symbol]="ed.alert?.symbol ?? symbol()"
            [timeframe]="timeframe()"
            [precision]="precision()"
            [lastClose]="lastClose()"
            [edit]="ed.alert"
            [copy]="ed.copy"
            (saved)="editing.set(null)"
            (cancelled)="editing.set(null)"
          />
        </div>
      }

      @if (error(); as e) {
        <p class="cam-error" role="alert">{{ e }}</p>
      }

      @if (tab() === 'scripts') {
        <app-chart-script-alerts-tab
          [symbol]="symbol()"
          [allSymbols]="scope() === 'all'"
          [focusId]="scriptAlertFocusId()"
        />
      } @else if (tab() === 'alerts') {
        <ul class="cam-list" data-testid="cam-list">
          @for (a of visible(); track a.id) {
            <li class="cam-row" [class.focus]="a.id === focusId()" [attr.data-alert-id]="a.id">
              <div class="cam-main">
                <span
                  class="cam-dot"
                  [class]="'s-' + a.status.toLowerCase()"
                  [title]="a.statusReason ?? statusText(a)"
                ></span>
                <div class="cam-text">
                  <div class="cam-title">
                    @if (scope() === 'all') {
                      <span class="cam-sym">{{ a.symbol }}</span>
                    }
                    {{ a.name || describe(a) }}
                  </div>
                  <div class="cam-sub">
                    {{ statusText(a) }}
                    @if (a.name) {
                      · {{ describe(a) }}
                    }
                    @if (a.lastFiredAt) {
                      · fired {{ a.lastFiredAt | date: 'MMM d, HH:mm' }} ({{ a.fireCount }})
                    }
                  </div>
                  @if (a.statusReason && a.status !== 'Active') {
                    <div class="cam-reason">{{ a.statusReason }}</div>
                  }
                </div>
              </div>
              <div class="cam-actions">
                @if (a.status === 'Active') {
                  <button type="button" (click)="pause(a)" title="Pause">Pause</button>
                } @else {
                  <button type="button" (click)="resume(a)" title="Arm it again">Resume</button>
                }
                <button type="button" (click)="startEdit(a)" title="Edit (re-arms it)">Edit</button>
                <button type="button" (click)="startClone(a)" title="Create a copy">Clone</button>
                <button
                  type="button"
                  (click)="toggleFires(a)"
                  [class.on]="openFires() === a.id"
                  title="Fires"
                >
                  Log
                </button>
                <button type="button" class="danger" (click)="askDelete(a)" title="Delete">
                  Delete
                </button>
              </div>
              @if (openFires() === a.id) {
                <div class="cam-fires">
                  @for (f of fires(); track f.id) {
                    <ng-container
                      [ngTemplateOutlet]="fireRow"
                      [ngTemplateOutletContext]="{ $implicit: f }"
                    ></ng-container>
                  } @empty {
                    <p class="cam-empty">
                      {{ firesLoading() ? 'Loading…' : 'It has not fired yet.' }}
                    </p>
                  }
                </div>
              }
            </li>
          } @empty {
            <li class="cam-empty">
              {{
                alerts.loading()
                  ? 'Loading…'
                  : scope() === 'symbol'
                    ? 'No alerts on ' + symbol() + ' yet.'
                    : 'No alerts yet.'
              }}
            </li>
          }
        </ul>
      } @else {
        <div class="cam-fires cam-log" data-testid="cam-log">
          @for (f of fires(); track f.id) {
            <ng-container
              [ngTemplateOutlet]="fireRow"
              [ngTemplateOutletContext]="{ $implicit: f }"
            ></ng-container>
          } @empty {
            <p class="cam-empty">{{ firesLoading() ? 'Loading…' : 'No alert has fired yet.' }}</p>
          }
        </div>
      }

      <ng-template #fireRow let-f>
        <div class="cam-fire">
          <div class="cam-fire-title">{{ f.title }}</div>
          <div class="cam-sub">
            {{ f.firedAtUtc | date: 'MMM d, HH:mm:ss' }} · {{ f.side.toLowerCase() }} {{ f.price }}
          </div>
          <div class="cam-deliveries">
            @for (d of f.deliveries; track d.channel) {
              <span
                class="cam-chip"
                [class]="'d-' + d.status.toLowerCase()"
                [title]="d.lastError ?? d.status"
              >
                {{ channelLabel(d.channel) }}: {{ deliveryLabel(d.status) }}
              </span>
            }
          </div>
        </div>
      </ng-template>

      <dialog #confirm class="cam-dialog" (close)="pendingDelete.set(null)">
        @if (pendingDelete(); as del) {
          <form method="dialog">
            <p>
              Delete the alert “{{ del.name || describe(del) }}” on {{ del.symbol }}? Its fire log
              is kept.
            </p>
            <div class="cam-dialog-actions">
              <button value="cancel">Cancel</button>
              <button value="delete" class="danger" (click)="confirmDelete($event)">Delete</button>
            </div>
          </form>
        }
      </dialog>
    </section>
  `,
  styles: [
    `
      :host {
        position: absolute;
        top: 0;
        bottom: 0;
        right: 50px;
        z-index: 21;
        width: 360px;
        max-width: calc(100% - 60px);
      }
      .cam {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--tv-bg, #fff);
        color: var(--tv-ink, inherit);
        border-left: 1px solid var(--tv-line, #ddd);
        box-shadow: var(--tv-menu-shadow, 0 2px 8px rgba(0, 0, 0, 0.15));
        font-size: 12px;
      }
      .cam-head,
      .cam-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--tv-line, #ddd);
      }
      .cam-spacer {
        flex: 1;
      }
      .cam-tabs,
      .cam-scope {
        display: flex;
        gap: 2px;
      }
      button {
        font: inherit;
        color: inherit;
        background: transparent;
        border: 1px solid var(--tv-line, #ddd);
        border-radius: 4px;
        padding: 2px 8px;
        cursor: pointer;
      }
      button.on {
        background: var(--tv-active-bg, #e3effd);
        border-color: var(--tv-blue, #2962ff);
      }
      button.danger {
        color: var(--tv-down, #ef5350);
      }
      .cam-icon {
        border: 0;
      }
      .cam-new {
        margin-left: auto;
        border-color: var(--tv-blue, #2962ff);
        color: var(--tv-blue, #2962ff);
      }
      .cam-editor {
        border-bottom: 1px solid var(--tv-line, #ddd);
      }
      .cam-error {
        margin: 6px 10px;
        padding: 6px 8px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--tv-down, #ef5350) 14%, transparent);
      }
      .cam-list {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow-y: auto;
        flex: 1;
      }
      .cam-row {
        padding: 8px 10px;
        border-bottom: 1px solid var(--tv-line, #eee);
      }
      .cam-row.focus {
        background: color-mix(in srgb, var(--tv-blue, #2962ff) 10%, transparent);
      }
      .cam-main {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .cam-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-top: 4px;
        flex: none;
        background: #9e9e9e;
      }
      .cam-dot.s-active {
        background: var(--tv-up, #26a69a);
      }
      .cam-dot.s-triggered {
        background: var(--tv-blue, #2962ff);
      }
      .cam-dot.s-expired {
        background: #616161;
      }
      .cam-text {
        min-width: 0;
      }
      .cam-title {
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .cam-sym {
        margin-right: 4px;
        color: var(--tv-muted, #888);
      }
      .cam-sub,
      .cam-reason,
      .cam-empty {
        color: var(--tv-muted, #888);
      }
      .cam-reason {
        margin-top: 2px;
      }
      .cam-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }
      .cam-fires {
        padding: 6px 0 0 16px;
      }
      .cam-log {
        padding: 6px 10px;
        overflow-y: auto;
        flex: 1;
      }
      .cam-fire {
        padding: 6px 0;
        border-top: 1px dashed var(--tv-line, #eee);
      }
      .cam-fire-title {
        font-weight: 600;
      }
      .cam-deliveries {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .cam-chip {
        padding: 1px 6px;
        border-radius: 10px;
        border: 1px solid var(--tv-line, #ddd);
      }
      .cam-chip.d-delivered {
        border-color: var(--tv-up, #26a69a);
      }
      .cam-chip.d-failed,
      .cam-chip.d-expired {
        border-color: var(--tv-down, #ef5350);
      }
      .cam-chip.d-skipped {
        border-style: dashed;
      }
      .cam-empty {
        padding: 12px 10px;
        margin: 0;
      }
      .cam-dialog {
        border: 1px solid var(--tv-line, #ddd);
        border-radius: 8px;
        background: var(--tv-bg, #fff);
        color: var(--tv-ink, inherit);
        max-width: 320px;
      }
      .cam-dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
    `,
  ],
})
export class ChartAlertManagerComponent {
  protected readonly alerts = inject(ChartAlertsService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly symbol = input.required<string>();
  readonly timeframe = input<string>('60');
  readonly precision = input<number>(5);
  readonly lastClose = input<number>(0);
  /** An alert to show (the bell's link): listed, highlighted and its log opened. */
  readonly focusId = input<number | null>(null);
  /** An alert on a chart script to show (the bell's `scriptAlert` link): its tab opens on it (SS-I1). */
  readonly scriptAlertFocusId = input<number | null>(null);

  readonly closed = output<void>();

  readonly tab = signal<Tab>('alerts');
  readonly scope = signal<Scope>('symbol');
  readonly editing = signal<{ alert: ChartAlertDto | null; copy: boolean } | null>(null);
  readonly openFires = signal<number | null>(null);
  readonly fires = signal<ChartAlertFireDto[]>([]);
  readonly firesLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly pendingDelete = signal<ChartAlertDto | null>(null);

  private readonly confirmDialog = viewChild<ElementRef<HTMLDialogElement>>('confirm');

  readonly visible = computed(() =>
    this.scope() === 'all' ? this.alerts.alerts() : this.alerts.forSymbol(this.symbol()),
  );

  /** The focus request already acted on — acted on ONCE, so closing its log or switching tabs afterwards sticks. */
  private handledFocus: number | null = null;

  constructor() {
    this.alerts.ensureLoaded();
    // The bell's link to an alert on a chart script opens its tab.
    effect(() => {
      if (this.scriptAlertFocusId() !== null) untracked(() => this.tab.set('scripts'));
    });
    // The bell's link: show that alert — whatever the scope — with its log open. Waits for the list when it is still
    // loading; tracks only the focus id and the list, never the state it sets.
    effect(() => {
      const id = this.focusId();
      const list = this.alerts.alerts();
      if (id === null) {
        this.handledFocus = null;
        return;
      }
      if (id === this.handledFocus) return;
      const alert = list.find((a) => a.id === id);
      if (!alert) return;
      this.handledFocus = id;
      untracked(() => {
        if (alert.symbol.toUpperCase() !== this.symbol().toUpperCase()) this.scope.set('all');
        this.tab.set('alerts');
        this.loadFires(id);
      });
      queueMicrotask(() =>
        (this.host.nativeElement as HTMLElement)
          .querySelector(`[data-alert-id="${id}"]`)
          ?.scrollIntoView({ block: 'nearest' }),
      );
    });
  }

  protected describe(a: ChartAlertDto): string {
    return describeAlert(a, this.precision());
  }

  protected statusText(a: ChartAlertDto): string {
    return statusLabel(a.status);
  }

  protected channelLabel(channel: string): string {
    return channel === 'InApp' ? 'In app' : channel;
  }

  protected deliveryLabel(status: string): string {
    switch (status) {
      case 'Delivered':
        return 'sent';
      case 'Skipped':
        return 'not sent';
      case 'Pending':
        return 'sending';
      default:
        return status.toLowerCase();
    }
  }

  setScope(scope: Scope): void {
    this.scope.set(scope);
    if (this.tab() === 'log') this.loadLog();
  }

  startNew(): void {
    this.editing.set({ alert: null, copy: false });
  }

  startEdit(a: ChartAlertDto): void {
    this.editing.set({ alert: a, copy: false });
  }

  startClone(a: ChartAlertDto): void {
    this.editing.set({ alert: a, copy: true });
  }

  pause(a: ChartAlertDto): void {
    this.run(this.alerts.pause(a.id));
  }

  resume(a: ChartAlertDto): void {
    this.run(this.alerts.resume(a.id));
  }

  toggleFires(a: ChartAlertDto): void {
    if (this.openFires() === a.id) {
      this.openFires.set(null);
      return;
    }
    this.loadFires(a.id);
  }

  openLog(): void {
    this.tab.set('log');
    this.openFires.set(null);
    this.loadLog();
  }

  askDelete(a: ChartAlertDto): void {
    this.pendingDelete.set(a);
    this.confirmDialog()?.nativeElement.showModal();
  }

  confirmDelete(ev: Event): void {
    ev.preventDefault();
    const del = this.pendingDelete();
    this.confirmDialog()?.nativeElement.close();
    if (del) this.run(this.alerts.delete(del.id));
  }

  private loadFires(id: number): void {
    this.openFires.set(id);
    this.firesLoading.set(true);
    this.fires.set([]);
    this.alerts.fires(id).subscribe({
      next: (res) => {
        this.firesLoading.set(false);
        if (this.openFires() === id) this.fires.set(res?.status && res.data ? res.data : []);
      },
      error: () => this.firesLoading.set(false),
    });
  }

  private loadLog(): void {
    this.firesLoading.set(true);
    this.fires.set([]);
    this.alerts.allFires(this.scope() === 'all' ? null : this.symbol()).subscribe({
      next: (res) => {
        this.firesLoading.set(false);
        this.fires.set(res?.status && res.data ? res.data : []);
      },
      error: () => this.firesLoading.set(false),
    });
  }

  private run(call: Observable<{ status: boolean; message?: string | null }>): void {
    this.error.set(null);
    call.subscribe({
      next: (res) => {
        if (!res?.status) this.error.set(res?.message || 'The change was refused.');
      },
      error: () => this.error.set('The engine did not answer.'),
    });
  }
}
