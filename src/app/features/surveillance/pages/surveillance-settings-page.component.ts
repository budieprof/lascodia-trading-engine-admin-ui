import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ConfigService, isQueuedForCoolingOff } from '@core/services/config.service';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { JobStatusComponent } from '../components/job-status.component';
import { SurveillanceApiService } from '../surveillance-api.service';
import {
  SEVERITIES,
  controlKind,
  detectorKeys,
  effective,
  globalKeys,
  keyLabel,
  relative,
  valueProblem,
} from '../surveillance.logic';
import type { SurveillanceConfiguration, SurveillanceKey, SurveillanceOperations } from '../surveillance.types';

/**
 * Surveillance settings and operations (gaps program; console operability): typed controls for every
 * `Surveillance:*` key — scan schedule, notification severity, each detector's switch, severity and
 * thresholds — with value, default and last change; saved through `PUT config` (audited, governed) by
 * `platform.engine.manage` holders. The scan's and the audit anchor publisher's last run / result /
 * next run with a confirmed "run now", and the anchor targets' health and (read-only) settings.
 */
@Component({
  selector: 'app-surveillance-settings-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, PageHeaderComponent, JobStatusComponent, ConfirmDialogComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './surveillance-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Surveillance settings"
        subtitle="Scan schedule, notification severity, detectors and thresholds — and the audit anchor targets."
      />

      <section class="card">
        <div class="card-head"><h3>Jobs</h3></div>
        <div class="jobs">
          <app-surveillance-job-status
            title="Surveillance scan"
            [status]="ops.value()?.scan ?? null"
            [canRun]="ops.value()?.canManage ?? false"
            runLabel="Scan now"
            job="scan"
            (requested)="ops.reload()"
          />
          @if (ops.value()?.anchors; as a) {
            <app-surveillance-job-status
              title="Audit anchor publisher"
              [status]="a.status"
              [canRun]="a.configured && !a.problems.length"
              runLabel="Publish now"
              job="anchors"
              (requested)="ops.reload()"
            />
          }
        </div>
        @if (ops.error(); as err) {
          <p class="alert" role="alert">{{ err }}</p>
        }
      </section>

      @if (config.value(); as c) {
        @if (!c.canEdit) {
          <p class="hint-line">
            These are engine-wide settings: changing them needs <code>platform.engine.manage</code>
            (platform staff). You can read every value here.
          </p>
        }
        @if (saved()) {
          <p class="ok-line" role="status">{{ saved() }}</p>
        }
        @if (saveError()) {
          <p class="alert" role="alert">{{ saveError() }}</p>
        }

        <section class="card">
          <div class="card-head"><h3>Scan and notifications</h3></div>
          <div class="keys">
            @for (k of globals(); track k.key) {
              <ng-container *ngTemplateOutlet="control; context: { $implicit: k }" />
            }
          </div>
        </section>

        @for (d of c.detectors; track d.key) {
          <section class="card">
            <div class="card-head">
              <h3>{{ d.name }}</h3>
              <span class="pill" [class.on]="d.enabled">{{ d.enabled ? 'On' : 'Off' }}</span>
              <span class="hint">{{ d.description }}</span>
            </div>
            <div class="keys">
              @for (k of keysOf(d.key); track k.key) {
                <ng-container *ngTemplateOutlet="control; context: { $implicit: k }" />
              }
            </div>
          </section>
        }
      } @else if (config.error()) {
        <p class="alert" role="alert">{{ config.error() }}</p>
      } @else {
        <p class="muted">Loading the settings…</p>
      }

      <ng-template #control let-k>
        <div class="key">
          <div class="k-name">
            <strong>{{ name(k.key) }}</strong>
            <code class="k-key">{{ k.key }}</code>
          </div>
          <div class="k-control">
            @switch (kind(k)) {
              @case ('bool') {
                <label class="check">
                  <input
                    type="checkbox"
                    [name]="k.key"
                    [disabled]="!config.value()?.canEdit"
                    [ngModel]="draft(k) === 'true'"
                    (ngModelChange)="setDraft(k, $event ? 'true' : 'false')"
                  />
                  {{ draft(k) === 'true' ? 'on' : 'off' }}
                </label>
              }
              @case ('severity') {
                <select class="input" [name]="k.key" [disabled]="!config.value()?.canEdit" [ngModel]="draft(k)" (ngModelChange)="setDraft(k, $event)">
                  @for (s of severities; track s) {
                    <option [value]="s">{{ s }}</option>
                  }
                </select>
              }
              @default {
                <input
                  class="input num"
                  [name]="k.key"
                  inputmode="decimal"
                  [disabled]="!config.value()?.canEdit"
                  [attr.aria-invalid]="problem(k) ? 'true' : null"
                  [ngModel]="draft(k)"
                  (ngModelChange)="setDraft(k, $event)"
                />
              }
            }
            @if (dirty(k)) {
              <button type="button" class="btn btn-sm btn-primary" [disabled]="!!problem(k) || busy()" (click)="ask(k)">Save</button>
              <button type="button" class="btn btn-sm btn-ghost" (click)="reset(k)">Undo</button>
            }
          </div>
          <div class="k-meta">
            default {{ k.default }}
            · {{ k.value === null ? 'no row — default applies' : 'set' }}
            @if (k.lastChangedAtUtc) {
              · changed {{ ago(k.lastChangedAtUtc) }}{{ k.lastChangedBy ? ' by ' + k.lastChangedBy : '' }}
            }
            @if (problem(k); as p) {
              <span class="bad">· {{ p }}</span>
            }
          </div>
        </div>
      </ng-template>

      @if (ops.value()?.anchors; as a) {
        <section class="card">
          <div class="card-head">
            <h3>Audit anchor targets</h3>
            <span class="pill" [class.on]="a.configured && !a.problems.length">
              {{ !a.configured ? 'Not configured' : a.problems.length ? 'Configuration problem' : 'Publishing' }}
            </span>
            <span class="hint">every {{ a.intervalHours }} h · MAC key {{ a.macKeySet ? 'set' : 'unset' }}</span>
          </div>
          @for (p of a.problems; track p) {
            <p class="alert" role="alert">{{ p }}</p>
          }
          @if (a.status.detail; as det) {
            <div class="anchor-health">
              @if (det.lastAnchor; as la) {
                <div>
                  <span class="label">Last anchor</span>
                  row {{ la.eventId }} · {{ la.publishedAtUtc.slice(0, 19).replace('T', ' ') }} UTC ·
                  <span class="mono">{{ la.hash.slice(0, 16) }}…</span> · {{ la.signed ? 'signed' : 'unsigned' }}
                </div>
              }
              <div>
                <span class="label">Previous head check</span>
                <span [class.bad]="det.previousHeadCheck === 'MISMATCH'">{{ det.previousHeadCheck ?? '—' }}</span>
              </div>
              @if (det.targets?.length) {
                <div>
                  <span class="label">Targets</span>
                  @for (t of det.targets; track t.target) {
                    <span class="pill" [class.on]="t.ok" [class.bad]="!t.ok">{{ t.target }} {{ t.ok ? '✓' : '✗' }}</span>
                  }
                </div>
              }
            </div>
          }
          <table class="kv">
            <tbody>
              <tr><th>Append-only file</th><td>{{ a.filePath ?? 'not set' }}</td></tr>
              <tr><th>Webhook</th><td>{{ a.webhookHost ?? 'not set' }}</td></tr>
              @if (a.s3; as s) {
                <tr><th>S3 Object Lock bucket</th><td>{{ s.bucket }} · {{ s.region }} · {{ s.endpoint }}{{ s.pathStyle ? ' (path style)' : '' }}</td></tr>
                <tr><th>Prefix</th><td class="mono">{{ s.prefix }}</td></tr>
                <tr><th>Retention</th><td>{{ s.lockMode }} for {{ s.retentionDays }} days</td></tr>
                <tr><th>Access key</th><td class="mono">{{ s.accessKeyId }} · secret {{ s.secretAccessKeySet ? 'set' : 'UNSET' }}{{ s.sessionTokenSet ? ' · session token set' : '' }}</td></tr>
              } @else {
                <tr><th>S3 Object Lock bucket</th><td>not set (no WORM copy)</td></tr>
              }
            </tbody>
          </table>
          <details class="steps">
            <summary>How to change these</summary>
            <ol>
              @for (s of a.operatorSteps; track s) {
                <li>{{ s }}</li>
              }
            </ol>
          </details>
        </section>
      }

      <app-confirm-dialog
        [open]="!!pending()"
        title="Change an engine-wide setting?"
        [message]="confirmText()"
        confirmLabel="Save"
        [loading]="busy()"
        (confirm)="save()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
})
export class SurveillanceSettingsPageComponent {
  private readonly api = inject(SurveillanceApiService);
  private readonly configs = inject(ConfigService);

  protected readonly severities = SEVERITIES;
  protected readonly kind = controlKind;
  protected readonly name = keyLabel;

  readonly config = iamResource<SurveillanceConfiguration | null>(() => this.api.configuration(), null, 'Could not load the settings.');
  readonly ops = iamResource<SurveillanceOperations | null>(() => this.api.operations(), null, 'Could not load the job status.');
  readonly drafts = signal<Record<string, string>>({});
  readonly pending = signal<SurveillanceKey | null>(null);
  readonly busy = signal(false);
  readonly saved = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);

  readonly globals = computed(() => {
    const c = this.config.value();
    return c ? globalKeys(c.keys, c.detectors) : [];
  });
  readonly confirmText = computed(() => {
    const k = this.pending();
    if (!k) return '';
    return `${k.key}: ${effective(k)} → ${this.draft(k)}. It applies to every organisation's surveillance at the next scan and is recorded in the configuration history and the audit log.`;
  });

  constructor() {
    this.config.reload();
    this.ops.reload();
  }

  keysOf(detector: string): SurveillanceKey[] {
    const c = this.config.value();
    return c ? detectorKeys(c.keys, detector) : [];
  }

  draft(k: SurveillanceKey): string {
    return this.drafts()[k.key] ?? effective(k);
  }

  setDraft(k: SurveillanceKey, v: string): void {
    this.drafts.update((d) => ({ ...d, [k.key]: String(v) }));
  }

  dirty(k: SurveillanceKey): boolean {
    const d = this.drafts()[k.key];
    return d !== undefined && d.trim() !== effective(k);
  }

  problem(k: SurveillanceKey): string | null {
    const d = this.drafts()[k.key];
    return d === undefined ? null : valueProblem(k, d, this.config.value()?.detectors ?? []);
  }

  reset(k: SurveillanceKey): void {
    this.drafts.update((d) => {
      const copy = { ...d };
      delete copy[k.key];
      return copy;
    });
  }

  ago(iso: string): string {
    return relative(iso, new Date());
  }

  ask(k: SurveillanceKey): void {
    if (!this.problem(k)) this.pending.set(k);
  }

  save(): void {
    const k = this.pending();
    if (!k) return;
    this.busy.set(true);
    this.saveError.set(null);
    this.saved.set(null);
    this.configs
      .upsert({ key: k.key, value: this.draft(k).trim(), dataType: k.dataType, description: k.description, isHotReloadable: true })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.pending.set(null);
          if (!res.status) {
            // A two-person policy parks the change: that is not a failure.
            if (res.responseCode === '-202-approval') this.saved.set(`${k.key}: sent for approval.`);
            else this.saveError.set(res.message || 'The change was refused.');
            return;
          }
          this.saved.set(isQueuedForCoolingOff(res) ? `${k.key}: queued for the cooling-off period.` : `${k.key} saved.`);
          this.reset(k);
          this.config.reload();
        },
        error: (e) => {
          this.busy.set(false);
          this.pending.set(null);
          const text = errorText(e, 'The change was not saved.');
          if (/-202-approval/.test(JSON.stringify(e ?? {}))) this.saved.set(`${k.key}: sent for approval.`);
          else this.saveError.set(text);
        },
      });
  }
}
