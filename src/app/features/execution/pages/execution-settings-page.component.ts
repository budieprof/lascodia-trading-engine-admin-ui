import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ConfigService, isQueuedForCoolingOff } from '@core/services/config.service';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { ExecutionApiService } from '../execution-api.service';
import {
  ROUTER_MODES,
  controlKind,
  dataTypeName,
  effective,
  keyGroup,
  keyLabel,
  relative,
  routerSuggested,
  valueProblem,
} from '../execution.logic';
import type { ExecutionKey, ExecutionSettings, RouterDecisionPage } from '../execution.types';

/**
 * Execution settings (gaps program, execution; console operability): typed controls for every
 * `Execution:Algo|SmartRouter|Allocation:*` key with value, default and last change, saved through `PUT config`
 * (audited, governed) by `platform.engine.manage`; the algorithm worker's last run / result / next run; and the smart
 * router's decisions — in Suggest mode, what Auto WOULD have done — so the operator can judge before switching.
 */
@Component({
  selector: 'app-execution-settings-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, PageHeaderComponent, ConfirmDialogComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './execution-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Execution settings"
        subtitle="Execution algorithms, the smart router and block allocation — every switch off or record-only by default."
      />

      @if (settings.value(); as s) {
        <section class="card">
          <div class="card-head"><h3>Algorithm worker</h3><span class="hint">api (money-path) process</span></div>
          <div class="jobs">
            <div>
              <strong>{{ s.worker.lastOutcome ?? 'no run recorded yet' }}</strong>
              · last run {{ ago(s.worker.lastFinishedAtUtc) }}
              @if (s.worker.lastDurationMs !== null) {
                in {{ (s.worker.lastDurationMs / 1000).toFixed(2) }} s
              }
              · next {{ ago(s.worker.nextRunAtUtc) }}
              @if (s.worker.consecutiveFailures > 1) {
                <span class="bad">· {{ s.worker.consecutiveFailures }} failures in a row</span>
              }
            </div>
            @if (s.worker.lastMessage) {
              <div class="muted">{{ s.worker.lastMessage }}</div>
            }
            <div class="muted">
              {{ s.workingParents }} working · {{ s.pausedParents }} paused · {{ s.openBlocks }} open block(s).
              Runs every few seconds: there is no run-now.
            </div>
          </div>
          <ul class="notes">
            @for (n of s.operatorNotes; track n) {
              <li>{{ n }}</li>
            }
          </ul>
        </section>

        @if (!s.canEdit) {
          <p class="hint-line">
            Engine-wide settings: changing them needs <code>platform.engine.manage</code> (platform staff). You can read every value.
          </p>
        }
        @if (saved()) {
          <p class="ok-line" role="status">{{ saved() }}</p>
        }
        @if (saveError()) {
          <p class="alert" role="alert">{{ saveError() }}</p>
        }

        @for (g of groups; track g) {
          <section class="card">
            <div class="card-head"><h3>{{ g }}</h3></div>
            <div class="keys">
              @for (k of keysOf(g); track k.key) {
                <div class="key">
                  <div>
                    <strong>{{ name(k.key) }}</strong>
                    <code class="k-key">{{ k.key }}</code>
                  </div>
                  <div class="k-control">
                    @switch (kind(k)) {
                      @case ('bool') {
                        <label class="check">
                          <input type="checkbox" [name]="k.key" [disabled]="!s.canEdit"
                            [ngModel]="draft(k) === 'true'" (ngModelChange)="setDraft(k, $event ? 'true' : 'false')" />
                          {{ draft(k) === 'true' ? 'on' : 'off' }}
                        </label>
                      }
                      @case ('mode') {
                        <select class="input" [name]="k.key" [disabled]="!s.canEdit" [ngModel]="draft(k)" (ngModelChange)="setDraft(k, $event)">
                          @for (m of modes; track m) {
                            <option [value]="m">{{ m }}</option>
                          }
                        </select>
                      }
                      @default {
                        <input class="input num" [name]="k.key" inputmode="numeric" [disabled]="!s.canEdit"
                          [attr.aria-invalid]="problem(k) ? 'true' : null" [ngModel]="draft(k)" (ngModelChange)="setDraft(k, $event)" />
                      }
                    }
                    @if (dirty(k)) {
                      <button type="button" class="btn btn-sm btn-primary" [disabled]="!!problem(k) || busy()" (click)="ask(k)">Save</button>
                      <button type="button" class="btn btn-sm btn-ghost" (click)="reset(k)">Undo</button>
                    }
                  </div>
                  <div class="k-desc">{{ k.description }}</div>
                  <div class="k-meta">
                    default {{ k.default }} · {{ k.value === null ? 'no row — default applies' : 'set to ' + k.value }}
                    @if (k.lastChangedAtUtc) {
                      · changed {{ ago(k.lastChangedAtUtc) }}{{ k.lastChangedBy ? ' by ' + k.lastChangedBy : '' }}
                    }
                    @if (problem(k); as p) {
                      <span class="bad">· {{ p }}</span>
                    }
                  </div>
                </div>
              }
            </div>
          </section>
        }
      } @else if (settings.error()) {
        <p class="alert" role="alert">{{ settings.error() }}</p>
      } @else {
        <p class="muted">Loading the settings…</p>
      }

      <section class="card">
        <div class="card-head">
          <h3>Smart-router decisions</h3>
          <label class="check"><input type="checkbox" [ngModel]="nonDirectOnly()" (ngModelChange)="nonDirectOnly.set($event); decisions.reload()" /> only where it would use an algorithm</label>
        </div>
        <p class="hint-line">
          Suggest mode records, for each fresh Direct signal, the algorithm the router would choose — nothing changes. Auto applies
          a non-Direct choice to signals no account has claimed yet. Manual tickets and script strategies are never re-routed.
        </p>
        @if (decisions.value(); as d) {
          @if (d.items.length) {
            <table class="table">
              <thead><tr><th>When (UTC)</th><th>Signal</th><th>Decision</th><th>Router</th><th>Detail</th></tr></thead>
              <tbody>
                @for (e of d.items; track e.id) {
                  <tr>
                    <td>{{ e.occurredAtUtc | date: 'MMM d HH:mm:ss' : 'UTC' }}</td>
                    <td>{{ e.tradeSignalId }}</td>
                    <td>{{ e.kind === 'RouterApplied' ? 'Applied' : 'Suggested' }}</td>
                    <td>{{ suggested(e) ?? '—' }}</td>
                    <td>{{ e.message }}</td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="hint-line">{{ d.total }} decision(s) recorded.</p>
          } @else {
            <p class="muted" style="padding: 12px 16px">
              No decision recorded{{ nonDirectOnly() ? ' where the router would use an algorithm' : '' }}. With the router Off nothing is
              evaluated; in Suggest or Auto each approved Direct signal of the last 15 minutes is evaluated once.
            </p>
          }
        } @else if (decisions.error(); as err) {
          <p class="alert" role="alert">{{ err }}</p>
        }
      </section>

      <app-confirm-dialog
        [open]="!!pending()"
        title="Change an engine-wide execution setting?"
        [message]="confirmText()"
        confirmLabel="Save"
        [loading]="busy()"
        (confirm)="save()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
})
export class ExecutionSettingsPageComponent {
  private readonly api = inject(ExecutionApiService);
  private readonly configs = inject(ConfigService);

  protected readonly modes = ROUTER_MODES;
  protected readonly groups = ['Algorithms', 'Smart router', 'Block allocation'] as const;
  protected readonly kind = controlKind;
  protected readonly name = keyLabel;
  protected readonly suggested = routerSuggested;

  readonly settings = iamResource<ExecutionSettings | null>(() => this.api.settings(), null, 'Could not load the settings.');
  readonly nonDirectOnly = signal(false);
  readonly decisions = iamResource<RouterDecisionPage | null>(
    () => this.api.routerDecisions(this.nonDirectOnly(), 100),
    null,
    'Could not load the router decisions.',
  );
  readonly drafts = signal<Record<string, string>>({});
  readonly pending = signal<ExecutionKey | null>(null);
  readonly busy = signal(false);
  readonly saved = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);

  readonly confirmText = computed(() => {
    const k = this.pending();
    if (!k) return '';
    const warn =
      k.key === 'Execution:Algo:Enabled' && this.draft(k) === 'true'
        ? ' Strategies set to an algorithm will then execute as parents with child orders — the fleet must run the EA build with command ExecuteOrder.'
        : k.key === 'Execution:SmartRouter:Mode' && this.draft(k) === 'Auto'
          ? ' Auto re-routes unclaimed Direct signals to the algorithm the router picks.'
          : k.key === 'Execution:Allocation:Enabled' && this.draft(k) === 'true'
            ? ' Accounts in an active allocation group will then size each order from the group’s block allocation.'
            : '';
    return `${k.key}: ${effective(k)} → ${this.draft(k)}. It applies engine-wide within seconds and is recorded in the configuration history and the audit log.${warn}`;
  });

  constructor() {
    this.settings.reload();
    this.decisions.reload();
  }

  keysOf(group: string): ExecutionKey[] {
    return (this.settings.value()?.keys ?? []).filter((k) => keyGroup(k.key) === group);
  }

  draft(k: ExecutionKey): string {
    return this.drafts()[k.key] ?? effective(k);
  }

  setDraft(k: ExecutionKey, v: string): void {
    this.drafts.update((d) => ({ ...d, [k.key]: String(v) }));
  }

  dirty(k: ExecutionKey): boolean {
    const d = this.drafts()[k.key];
    return d !== undefined && d.trim() !== effective(k);
  }

  problem(k: ExecutionKey): string | null {
    const d = this.drafts()[k.key];
    return d === undefined ? null : valueProblem(k, d);
  }

  reset(k: ExecutionKey): void {
    this.drafts.update((d) => {
      const copy = { ...d };
      delete copy[k.key];
      return copy;
    });
  }

  ask(k: ExecutionKey): void {
    if (!this.problem(k)) this.pending.set(k);
  }

  ago(iso: string | null): string {
    return relative(iso, new Date());
  }

  save(): void {
    const k = this.pending();
    if (!k) return;
    this.busy.set(true);
    this.saveError.set(null);
    this.saved.set(null);
    this.configs
      .upsert({
        key: k.key,
        value: this.draft(k).trim(),
        dataType: dataTypeName(k),
        description: k.description,
        isHotReloadable: true,
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.pending.set(null);
          if (!res.status) {
            if (res.responseCode === '-202-approval') this.saved.set(`${k.key}: sent for approval.`);
            else this.saveError.set(res.message || 'The change was refused.');
            return;
          }
          this.saved.set(isQueuedForCoolingOff(res) ? `${k.key}: queued for the cooling-off period.` : `${k.key} saved.`);
          this.reset(k);
          this.settings.reload();
        },
        error: (e) => {
          this.busy.set(false);
          this.pending.set(null);
          this.saveError.set(errorText(e, 'The change was not saved.'));
        },
      });
  }
}
