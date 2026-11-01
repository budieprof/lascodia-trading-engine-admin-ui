import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatDistanceToNow } from 'date-fns';

import { ConfigService, isQueuedForCoolingOff } from '@core/services/config.service';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import {
  GATE_MODES,
  fxChangeWarning,
  fxControlKind,
  fxEffective,
  fxKeyLabel,
  fxValueProblem,
  prerequisitesOn,
  routeSummary,
  sessionTone,
} from '../fx-routing.logic';
import { VenuesApiService } from '../venues-api.service';
import type { FxConfigKey, FxRoutingStatus } from '../venues.types';

/**
 * FX routing beyond MT5 (gaps program, routing; engine ADR-0040; console operability): the route switches and the
 * EA-parity gate mode with typed controls (value, default, last change; saved through `PUT config` by
 * `platform.engine.manage` holders, audited and governed), the prerequisite switches, each FX venue kind (environment,
 * endpoint, accounts, live sessions), the FIX gateway's sessions (state, sequence numbers, gap fills), symbol-mapping
 * coverage, the gate decisions (Enforce refusals and Observe would-refusals) and the operator-only steps verbatim.
 */
@Component({
  selector: 'app-fx-routing-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, RouterLink, PageHeaderComponent, ConfirmDialogComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './venue-page.scss'],
  styles: [
    `
      .keys {
        display: grid;
        gap: 0.75rem;
      }
      .key {
        display: grid;
        grid-template-columns: minmax(12rem, 1fr) minmax(12rem, 1fr);
        gap: 0.25rem 1rem;
        align-items: center;
      }
      .k-key {
        display: block;
        font-size: 0.75rem;
        opacity: 0.7;
      }
      .k-control {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }
      .k-meta {
        grid-column: 1 / -1;
        font-size: 0.8rem;
        opacity: 0.75;
      }
      .k-desc {
        grid-column: 1 / -1;
        font-size: 0.8rem;
      }
      .tone-ok {
        color: var(--color-success, #1a7f37);
      }
      .tone-warn {
        color: var(--color-warning, #9a6700);
      }
      .tone-bad {
        color: var(--color-danger, #cf222e);
      }
      .num {
        max-width: 7rem;
      }
      table.grid {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      table.grid th,
      table.grid td {
        text-align: left;
        padding: 0.35rem 0.5rem;
        border-bottom: 1px solid var(--color-border, #d0d7de);
        vertical-align: top;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="FX routing"
        subtitle="FX routes beyond MT5 — OANDA, cTrader Open API and FIX 4.4 (through the FIX gateway). Every route is off until you switch it on; MT5 stays the default route."
      >
        <a class="btn btn-secondary" routerLink="/connections">Connections</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="data.reload()"
          [disabled]="data.loading()"
        >
          {{ data.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <p class="note">
        These routes have been tested against venue simulators only. A real route needs your broker
        / venue account, its API credential or FIX session, and (for FIX) the venue's certification
        — see “What only an operator can do” below. Every routed order still goes through Tier 1,
        Tier 2, the kill switches and — here — the news blackout and order-rate gates the Expert
        Advisor applies on MT5.
      </p>

      @if (data.error(); as err) {
        <p class="alert" role="alert">{{ err }}</p>
      }
      @if (saved()) {
        <p class="ok-line" role="status">{{ saved() }}</p>
      }
      @if (saveError()) {
        <p class="alert" role="alert">{{ saveError() }}</p>
      }

      @if (data.value(); as d) {
        @if (!d.canManage) {
          <p class="hint-line">
            These are platform settings: changing them needs <code>platform.engine.manage</code>.
            You can read every value here.
          </p>
        }

        <section class="card" aria-label="Route switches">
          <header class="card-head">
            <h3>Routes and gates</h3>
            <span class="hint">new entries only — exits of open positions always work</span>
          </header>
          <div class="keys card-body">
            @for (k of routeKeys(); track k.key) {
              <ng-container *ngTemplateOutlet="control; context: { $implicit: k }" />
            }
          </div>
        </section>

        <section class="card" aria-label="Prerequisites">
          <header class="card-head">
            <h3>Prerequisites</h3>
            <span class="hint">{{
              prereqOn()
                ? 'router, entries and multi-asset risk are on'
                : 'a route routes nothing until these are on'
            }}</span>
          </header>
          <div class="keys card-body">
            @for (k of prereqKeys(); track k.key) {
              <ng-container *ngTemplateOutlet="control; context: { $implicit: k }" />
            }
          </div>
        </section>

        <section class="card" aria-label="FX venues">
          <header class="card-head"><h3>Venues</h3></header>
          <div class="card-body">
            <table class="grid">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>State</th>
                  <th>Environment</th>
                  <th>Endpoint</th>
                  <th>Accounts</th>
                  <th>Sessions (this process)</th>
                  <th>Credential fields</th>
                </tr>
              </thead>
              <tbody>
                @for (v of d.venues; track v.kind) {
                  <tr>
                    <td>
                      <strong>{{ v.kind }}</strong>
                    </td>
                    <td>{{ summary(v) }}</td>
                    <td [class.tone-warn]="v.environment === 'Live'">{{ v.environment }}</td>
                    <td class="mono">
                      {{ v.endpoint || '—' }}
                      @if (v.gatewayTokenSet !== null) {
                        <div>token {{ v.gatewayTokenSet ? 'set' : 'NOT set' }}</div>
                      }
                    </td>
                    <td>{{ v.activeAccounts }} active / {{ v.accounts }}</td>
                    <td>
                      @for (s of v.sessions; track s.executionAccountId) {
                        <div [class]="'tone-' + tone(s)">
                          #{{ s.executionAccountId }}
                          {{ s.connected ? 'connected' : 'not connected' }} · {{ s.requests }} req ·
                          {{ s.errors }} err
                          @if (s.lastError) {
                            <div class="small">{{ s.lastError }} ({{ ago(s.lastErrorUtc) }})</div>
                          }
                        </div>
                      } @empty {
                        <span class="muted">none yet</span>
                      }
                    </td>
                    <td class="mono">{{ v.credentialFields.join(', ') }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card" aria-label="FIX gateway">
          <header class="card-head">
            <h3>FIX gateway</h3>
            <span
              class="pill"
              [class.on]="d.gateway.state === 'ok'"
              [class.bad]="d.gateway.state === 'unreachable'"
              >{{ gatewayLabel(d.gateway.state) }}</span
            >
            <span class="hint mono">{{ d.gateway.url ?? '' }}</span>
          </header>
          <div class="card-body">
            @if (d.gateway.error) {
              <p class="alert" role="alert">{{ d.gateway.error }}</p>
            }
            @if (d.gateway.sessions.length) {
              <table class="grid">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Profile</th>
                    <th>State</th>
                    <th>Seq out / in</th>
                    <th>Logons</th>
                    <th>Gap fills / resend requests</th>
                    <th>Orders / fills</th>
                    <th>Last error</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of d.gateway.sessions; track s.sessionKey) {
                    <tr>
                      <td class="mono">{{ s.sessionKey }}</td>
                      <td>
                        {{ s.profile }} · {{ s.environment }}
                        @if (s.unverified.length) {
                          <div class="small tone-warn" [title]="s.unverified.join('\\n')">
                            {{ s.unverified.length }} profile value(s) unverified
                          </div>
                        }
                      </td>
                      <td [class]="'tone-' + tone(s)">
                        {{ s.state }}
                        @if (s.loggedOnAtUtc) {
                          <div class="small">since {{ ago(s.loggedOnAtUtc) }}</div>
                        }
                      </td>
                      <td class="mono">{{ s.nextSenderSeqNum }} / {{ s.nextTargetSeqNum }}</td>
                      <td>{{ s.logons }}</td>
                      <td>{{ s.gapFillsReceived }} / {{ s.resendRequestsSent }}</td>
                      <td>{{ s.openOrders }} / {{ s.fills }}</td>
                      <td>{{ s.lastError ?? '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted">
                {{
                  d.gateway.state === 'not-configured'
                    ? 'The engine has no FIX gateway token (Execution__Fx__fix44__GatewayToken): the fix44 route cannot reach a gateway.'
                    : d.gateway.state === 'ok'
                      ? 'The gateway runs no session for your accounts yet (a session starts when a fix44 account is verified).'
                      : 'The gateway did not answer. Is the fix-gateway service running (compose profile venues)?'
                }}
              </p>
            }
          </div>
        </section>

        <section class="card" aria-label="Symbol mappings">
          <header class="card-head">
            <h3>Symbol mappings</h3>
            <span class="hint">an FX venue account trades only mapped symbols</span>
          </header>
          <div class="card-body">
            <div class="switches">
              @for (m of d.mappings; track m.venue) {
                <div class="switch">
                  <span class="switch-name">{{ m.venue }}</span>
                  <span class="dot" [class.ok]="m.activeMappings > 0">{{ m.activeMappings }}</span>
                </div>
              }
            </div>
            @if (noMappings()) {
              <p class="note">
                No FX venue mapping yet: switch on Instruments:ReferenceSync:Enabled and
                Instruments:ReferenceSync:Source:fx-venues:Enabled (above) — the next reference sync
                writes them.
              </p>
            }
          </div>
        </section>

        <section class="card" aria-label="Gate decisions">
          <header class="card-head">
            <h3>Pre-trade gate decisions</h3>
            <span class="hint"
              >news blackout and orders-per-minute on FX venue entries — the latest 100</span
            >
          </header>
          <div class="card-body">
            @if (d.decisions.length) {
              <table class="grid">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Signal</th>
                    <th>Gate</th>
                    <th>Outcome</th>
                    <th>Symbol</th>
                    <th>Account</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  @for (x of d.decisions; track x.id) {
                    <tr>
                      <td>{{ ago(x.createdAtUtc) }}</td>
                      <td class="mono">#{{ x.tradeSignalId }}</td>
                      <td>{{ x.gate ?? '—' }}</td>
                      <td
                        [class.tone-bad]="x.outcome === 'Refused'"
                        [class.tone-warn]="x.outcome === 'WouldRefuse'"
                      >
                        {{ x.outcome === 'WouldRefuse' ? 'Would refuse (Observe)' : x.outcome }}
                      </td>
                      <td>{{ x.symbol ?? '—' }}</td>
                      <td>{{ x.executionAccountId ? '#' + x.executionAccountId : '—' }}</td>
                      <td>{{ x.reason }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted">
                No FX venue entry has been refused (or would have been, in Observe mode). Decisions
                appear here as soon as a routed entry meets a news blackout or the order-rate limit.
              </p>
            }
          </div>
        </section>

        <section class="card" aria-label="Operator steps">
          <header class="card-head"><h3>What only an operator can do</h3></header>
          <ol class="card-body">
            @for (s of d.operatorSteps; track s) {
              <li>{{ s }}</li>
            }
          </ol>
        </section>
      } @else if (!data.error()) {
        <p class="muted">Loading FX routing…</p>
      }

      <ng-template #control let-k>
        <div class="key">
          <div class="k-name">
            <strong>{{ label(k.key) }}</strong>
            <code class="k-key">{{ k.key }}</code>
          </div>
          <div class="k-control">
            @switch (kind(k)) {
              @case ('bool') {
                <label class="check">
                  <input
                    type="checkbox"
                    [name]="k.key"
                    [attr.aria-label]="k.key"
                    [disabled]="!data.value()?.canManage"
                    [ngModel]="draft(k) === 'true'"
                    (ngModelChange)="setDraft(k, $event ? 'true' : 'false')"
                  />
                  {{ draft(k) === 'true' ? 'on' : 'off' }}
                </label>
              }
              @case ('mode') {
                <select
                  class="input"
                  [name]="k.key"
                  [attr.aria-label]="k.key"
                  [disabled]="!data.value()?.canManage"
                  [ngModel]="draft(k)"
                  (ngModelChange)="setDraft(k, $event)"
                >
                  @for (m of modes; track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
              }
              @default {
                <input
                  class="input num"
                  [name]="k.key"
                  [attr.aria-label]="k.key"
                  inputmode="numeric"
                  [disabled]="!data.value()?.canManage"
                  [attr.aria-invalid]="problem(k) ? 'true' : null"
                  [ngModel]="draft(k)"
                  (ngModelChange)="setDraft(k, $event)"
                />
              }
            }
            @if (dirty(k)) {
              <button
                type="button"
                class="btn btn-sm btn-primary"
                [disabled]="!!problem(k) || busy()"
                (click)="ask(k)"
              >
                Save
              </button>
              <button type="button" class="btn btn-sm btn-ghost" (click)="reset(k)">Undo</button>
            }
          </div>
          <div class="k-desc">{{ k.description }}</div>
          <div class="k-meta">
            default {{ k.default }} · {{ k.value === null ? 'no row — default applies' : 'set' }}
            @if (k.lastChangedAtUtc) {
              · changed {{ ago(k.lastChangedAtUtc)
              }}{{ k.lastChangedBy ? ' by ' + k.lastChangedBy : '' }}
            }
            @if (problem(k); as p) {
              <span class="tone-bad">· {{ p }}</span>
            }
          </div>
        </div>
      </ng-template>

      <app-confirm-dialog
        [open]="!!pending()"
        title="Change a platform routing setting?"
        [message]="confirmText()"
        confirmLabel="Save"
        [loading]="busy()"
        (confirm)="save()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
})
export class FxRoutingPageComponent {
  private readonly api = inject(VenuesApiService);
  private readonly configs = inject(ConfigService);

  protected readonly modes = GATE_MODES;
  protected readonly kind = fxControlKind;
  protected readonly label = fxKeyLabel;
  protected readonly tone = sessionTone;

  readonly data = iamResource<FxRoutingStatus | null>(
    () => this.api.fxRouting(),
    null,
    'Could not load FX routing.',
  );
  readonly drafts = signal<Record<string, string>>({});
  readonly pending = signal<FxConfigKey | null>(null);
  readonly busy = signal(false);
  readonly saved = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);

  readonly routeKeys = computed(() =>
    (this.data.value()?.keys ?? []).filter((k) => k.group === 'route'),
  );
  readonly prereqKeys = computed(() =>
    (this.data.value()?.keys ?? []).filter((k) => k.group !== 'route'),
  );
  readonly prereqOn = computed(() => prerequisitesOn(this.data.value()?.keys ?? []));
  readonly noMappings = computed(() =>
    (this.data.value()?.mappings ?? []).every((m) => m.activeMappings === 0),
  );
  readonly confirmText = computed(() => {
    const k = this.pending();
    if (!k) return '';
    const next = this.draft(k);
    return `${k.key}: ${fxEffective(k)} → ${next}. ${fxChangeWarning(k, next)}`;
  });

  constructor() {
    this.data.reload();
  }

  summary(v: FxRoutingStatus['venues'][number]): string {
    return routeSummary(v, this.prereqOn());
  }

  gatewayLabel(state: string): string {
    return state === 'ok'
      ? 'Reachable'
      : state === 'unreachable'
        ? 'Unreachable'
        : 'Not configured';
  }

  ago(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : formatDistanceToNow(d, { addSuffix: true });
  }

  draft(k: FxConfigKey): string {
    return this.drafts()[k.key] ?? fxEffective(k);
  }

  setDraft(k: FxConfigKey, v: string): void {
    this.drafts.update((d) => ({ ...d, [k.key]: String(v) }));
  }

  dirty(k: FxConfigKey): boolean {
    const d = this.drafts()[k.key];
    return d !== undefined && d.trim() !== fxEffective(k);
  }

  problem(k: FxConfigKey): string | null {
    const d = this.drafts()[k.key];
    return d === undefined ? null : fxValueProblem(k, d);
  }

  reset(k: FxConfigKey): void {
    this.drafts.update((d) => {
      const copy = { ...d };
      delete copy[k.key];
      return copy;
    });
  }

  ask(k: FxConfigKey): void {
    if (!this.problem(k)) this.pending.set(k);
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
        dataType: k.dataType,
        description: k.description,
        isHotReloadable: true,
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.pending.set(null);
          if (!res.status) {
            if (res.responseCode === '-202-approval')
              this.saved.set(`${k.key}: sent for approval.`);
            else this.saveError.set(res.message || 'The change was refused.');
            return;
          }
          this.saved.set(
            isQueuedForCoolingOff(res)
              ? `${k.key}: queued for the cooling-off period.`
              : `${k.key} saved.`,
          );
          this.reset(k);
          this.data.reload();
        },
        error: (e) => {
          this.busy.set(false);
          this.pending.set(null);
          if (/-202-approval/.test(JSON.stringify(e ?? {})))
            this.saved.set(`${k.key}: sent for approval.`);
          else this.saveError.set(errorText(e, 'The change was not saved.'));
        },
      });
  }
}
