import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import type { Observable } from 'rxjs';

import { ChartScriptAlertFormComponent } from './chart-script-alert-form.component';
import { ChartScriptAlertsService } from './chart-script-alerts.service';
import {
  describeScriptAlert,
  scriptAlertStatusText,
  type ChartScriptAlertDto,
  type ChartScriptAlertFireDto,
} from './chart-script-alerts.types';

/**
 * The alert manager's "Script alerts" tab (SS-I1): the operator's alerts on chart scripts — for this symbol or all —
 * with what the engine does with each (watching, waiting for a session, not compiling …, and how fresh that report
 * is), "the script changed — re-arm" when its chart script moved on, pause / resume / edit / delete, and each alert's
 * fires with what happened on every channel.
 */
@Component({
  selector: 'app-chart-script-alerts-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartScriptAlertFormComponent, DatePipe],
  template: `
    @if (editing(); as ed) {
      <div class="sat-editor">
        <app-chart-script-alert-form [edit]="ed" (saved)="editing.set(null)" (cancelled)="editing.set(null)" />
      </div>
    }
    @if (error(); as e) {
      <p class="sat-error" role="alert">{{ e }}</p>
    }
    @if (alerts.error(); as e) {
      <p class="sat-error" role="alert">{{ e }}</p>
    }
    <ul class="sat-list" data-testid="sat-list">
      @for (a of visible(); track a.id) {
        @let st = status(a);
        <li class="sat-row" [class.focus]="a.id === focusId()" [attr.data-script-alert-id]="a.id">
          <div class="sat-main">
            <span class="sat-dot" [class]="'s-' + a.status.toLowerCase()" [class.stale]="st.stale"></span>
            <div class="sat-text">
              <div class="sat-title">{{ a.displayName }}</div>
              <div class="sat-sub">{{ describe(a) }}</div>
              <div class="sat-status" [class.stale]="st.stale" data-testid="sat-status">{{ st.text }}</div>
              @if (a.scriptChanged) {
                <div class="sat-banner" data-testid="sat-changed">
                  “{{ a.scriptName }}” changed since this alert was armed — it still runs the version it was armed with.
                  <button type="button" (click)="rearm(a)">Re-arm</button>
                </div>
              } @else if (a.scriptMissing) {
                <div class="sat-banner">“{{ a.scriptName }}” was deleted — the alert keeps running its own copy.</div>
              }
              @if (a.lastFiredAt) {
                <div class="sat-sub">fired {{ a.lastFiredAt | date: 'MMM d, HH:mm' }} ({{ a.fireCount }})</div>
              }
              @if (a.lastDeliveryError) {
                <div class="sat-sub warn">{{ a.lastDeliveryError }}</div>
              }
            </div>
          </div>
          <div class="sat-actions">
            @if (a.isEnabled) {
              <button type="button" (click)="pause(a)">Pause</button>
            } @else {
              <button type="button" (click)="resume(a)" title="Arm it again">Resume</button>
            }
            <button type="button" (click)="editing.set(a)" title="Edit (re-arms it)">Edit</button>
            <button type="button" (click)="toggleFires(a)" [class.on]="openFires() === a.id">Log</button>
            <button type="button" class="danger" (click)="askDelete(a)">Delete</button>
          </div>
          @if (openFires() === a.id) {
            <div class="sat-fires">
              @for (f of fires(); track f.id) {
                <div class="sat-fire">
                  <div class="sat-fire-title">{{ f.symbol }} · {{ f.message }}</div>
                  <div class="sat-sub">{{ f.firedAtUtc | date: 'MMM d, HH:mm:ss' }}</div>
                  <div class="sat-deliveries">
                    @for (d of f.deliveries; track d.channel) {
                      <span class="sat-chip" [class]="'d-' + d.status.toLowerCase()" [title]="d.lastError ?? d.status">
                        {{ d.channel === 'InApp' ? 'In app' : d.channel }}: {{ deliveryLabel(d.status) }}
                      </span>
                    }
                  </div>
                </div>
              } @empty {
                <p class="sat-empty">{{ firesLoading() ? 'Loading…' : 'It has not fired yet.' }}</p>
              }
            </div>
          }
        </li>
      } @empty {
        <li class="sat-empty">
          {{
            alerts.loading()
              ? 'Loading…'
              : allSymbols()
                ? 'No alerts on chart scripts yet — use the bell on a script chip to create one.'
                : 'No script alerts watch ' + symbol() + ' yet.'
          }}
        </li>
      }
    </ul>

    <dialog #confirm class="sat-dialog" (close)="pendingDelete.set(null)">
      @if (pendingDelete(); as del) {
        <form method="dialog">
          <p>Delete the alert “{{ del.displayName }}”? Its fire log is kept.</p>
          <div class="sat-dialog-actions">
            <button value="cancel">Cancel</button>
            <button value="delete" class="danger" (click)="confirmDelete($event)">Delete</button>
          </div>
        </form>
      }
    </dialog>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
      }
      .sat-editor {
        border-bottom: 1px solid var(--tv-line, #ddd);
      }
      .sat-error {
        margin: 6px 10px;
        padding: 6px 8px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--tv-down, #ef5350) 14%, transparent);
      }
      .sat-list {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow-y: auto;
        flex: 1;
      }
      .sat-row {
        padding: 8px 10px;
        border-bottom: 1px solid var(--tv-line, #eee);
      }
      .sat-row.focus {
        background: color-mix(in srgb, var(--tv-blue, #2962ff) 10%, transparent);
      }
      .sat-main {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .sat-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-top: 4px;
        flex: none;
        background: #9e9e9e;
      }
      .sat-dot.s-active {
        background: var(--tv-up, #26a69a);
      }
      .sat-dot.s-active.stale,
      .sat-dot.s-disabled {
        background: #f59e0b;
      }
      .sat-text {
        min-width: 0;
      }
      .sat-title {
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .sat-sub,
      .sat-status,
      .sat-empty {
        color: var(--tv-muted, #888);
      }
      .sat-status.stale,
      .warn {
        color: #b26a00;
      }
      .sat-banner {
        margin-top: 4px;
        padding: 4px 6px;
        border-radius: 4px;
        background: color-mix(in srgb, #f59e0b 16%, transparent);
      }
      .sat-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
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
      .sat-fires {
        padding: 6px 0 0 16px;
      }
      .sat-fire {
        padding: 6px 0;
        border-top: 1px dashed var(--tv-line, #eee);
      }
      .sat-fire-title {
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .sat-deliveries {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .sat-chip {
        padding: 1px 6px;
        border-radius: 10px;
        border: 1px solid var(--tv-line, #ddd);
      }
      .sat-chip.d-delivered {
        border-color: var(--tv-up, #26a69a);
      }
      .sat-chip.d-failed,
      .sat-chip.d-expired {
        border-color: var(--tv-down, #ef5350);
      }
      .sat-chip.d-skipped {
        border-style: dashed;
      }
      .sat-empty {
        padding: 12px 10px;
        margin: 0;
      }
      .sat-dialog {
        border: 1px solid var(--tv-line, #ddd);
        border-radius: 8px;
        background: var(--tv-bg, #fff);
        color: var(--tv-ink, inherit);
        max-width: 320px;
      }
      .sat-dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      @media (pointer: coarse) {
        button {
          min-height: 40px;
          min-width: 40px;
        }
      }
    `,
  ],
})
export class ChartScriptAlertsTabComponent {
  protected readonly alerts = inject(ChartScriptAlertsService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly symbol = input.required<string>();
  /** All symbols (the manager's scope), else the alerts watching `symbol`. */
  readonly allSymbols = input(false);
  /** An alert to show (the bell's link): listed, highlighted and its log opened. */
  readonly focusId = input<number | null>(null);

  readonly editing = signal<ChartScriptAlertDto | null>(null);
  readonly openFires = signal<number | null>(null);
  readonly fires = signal<ChartScriptAlertFireDto[]>([]);
  readonly firesLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly pendingDelete = signal<ChartScriptAlertDto | null>(null);
  private readonly now = signal(Date.now());
  private readonly confirmDialog = viewChild<ElementRef<HTMLDialogElement>>('confirm');

  readonly visible = computed(() => {
    const focus = this.focusId();
    const list = this.allSymbols() ? this.alerts.alerts() : this.alerts.forSymbol(this.symbol());
    // The bell's alert is listed whatever the scope.
    const focused = focus !== null && !list.some((a) => a.id === focus) ? this.alerts.alerts().find((a) => a.id === focus) : null;
    return focused ? [focused, ...list] : list;
  });

  private handledFocus: number | null = null;

  constructor() {
    this.alerts.ensureLoaded();
    // Status notes age: the staleness check reads the clock once a minute; the list is re-read with it.
    const timer = setInterval(() => {
      this.now.set(Date.now());
      if (!document.hidden) this.alerts.refresh();
    }, 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      const id = this.focusId();
      const list = this.alerts.alerts();
      if (id === null) {
        this.handledFocus = null;
        return;
      }
      if (id === this.handledFocus || !list.some((a) => a.id === id)) return;
      this.handledFocus = id;
      untracked(() => this.loadFires(id));
      queueMicrotask(() =>
        (this.host.nativeElement as HTMLElement)
          .querySelector(`[data-script-alert-id="${id}"]`)
          ?.scrollIntoView({ block: 'nearest' }),
      );
    });
  }

  protected status(a: ChartScriptAlertDto): { text: string; stale: boolean } {
    return scriptAlertStatusText(a, this.now());
  }

  protected describe(a: ChartScriptAlertDto): string {
    return describeScriptAlert(a);
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

  pause(a: ChartScriptAlertDto): void {
    this.run(this.alerts.pause(a.id));
  }

  resume(a: ChartScriptAlertDto): void {
    this.run(this.alerts.resume(a.id));
  }

  /** Re-arm with the chart script's current version, keeping everything else as it is. */
  rearm(a: ChartScriptAlertDto): void {
    this.run(
      this.alerts.update(a.id, {
        rearm: true,
        name: a.name,
        alertKey: a.alertKey,
        timeframe: a.timeframe,
        frequency: a.frequency,
        channels: [...a.channels],
        webhookUrl: a.webhookUrl,
        messageTemplate: a.messageTemplate,
        expiresAtUtc: a.expiresAtUtc,
        ...(a.watchlistId !== null ? { watchlistId: a.watchlistId } : { symbols: a.symbols }),
      }),
    );
  }

  toggleFires(a: ChartScriptAlertDto): void {
    if (this.openFires() === a.id) {
      this.openFires.set(null);
      return;
    }
    this.loadFires(a.id);
  }

  askDelete(a: ChartScriptAlertDto): void {
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
