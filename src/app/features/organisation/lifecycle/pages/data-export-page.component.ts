import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';

import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { catchError, of } from 'rxjs';
import { RouterLink } from '@angular/router';
import { ago } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { PlansApiService } from '@features/platform/plans-api.service';
import type { TenantUsage } from '@features/platform/plans.types';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { LifecycleApiService, NAVIGATE_TO } from '../lifecycle-api.service';
import { exportInProgress, exportStatusLabel, exportTone, formatBytes } from '../lifecycle.logic';
import type { TenantDataExport } from '../lifecycle.types';

/** While an export is being prepared the list is read again this often. */
export const EXPORT_POLL_MS = 15_000;

/**
 * Taking the organisation's data out (engine multi-tenancy Phase 7, LC.2, `/tenant/exports`,
 * `tenant.data.export` — Owner, step-up): everything it owns — its records, its own strategies and its
 * audit trail, never secrets — as a zip of JSON Lines prepared in the background and kept for 7 days.
 * Each download link works once and for a few minutes; "Download" makes one and starts the download.
 */
@Component({
  selector: 'app-organisation-data-export-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    PageHeaderComponent,
    ConfirmDialogComponent,
    MfaHintComponent,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrls: ['../../../iam/shared/iam-page.scss'],
  styles: [
    `
      .steps {
        margin: 0;
        padding-left: var(--space-5);
        list-style: decimal;
        display: grid;
        gap: var(--space-2);
      }

      .split {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(300px, 2fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .split {
          grid-template-columns: 1fr;
        }
      }
      .main-col,
      .side {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Export your data"
        subtitle="Everything your organisation owns, as a download you can keep. Secrets are never included."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="exports.reload()"
          [disabled]="exports.loading()"
        >
          {{ exports.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Export summary" />

      <div class="split">
        <div class="main-col">
          <section class="card">
            <header class="card-head">
              <h3>New export</h3>
              <span class="spacer"></span>
              <app-mfa-hint [permission]="P.TenantDataExport" />
            </header>
            <div class="card-body">
              <p>
                The export holds your trading accounts, orders, positions, strategies and scripts,
                settings, alerts, LLM conversations and every other record of your organisation,
                with its audit trail — one file per kind of record (JSON Lines) and a manifest, in a
                zip. Passwords, API keys, bot tokens, webhook URLs and signing secrets are left out.
                Platform strategies and market data are not yours, so they are not in it.
              </p>
              <p class="note">
                It is prepared in the background (usually a few minutes) and can be downloaded for 7
                days. One export at a time, at most three a day.
              </p>
              <div class="actions-row">
                <button
                  type="button"
                  class="btn btn-primary"
                  [disabled]="busy() || !!inProgress()"
                  (click)="confirming.set(true)"
                >
                  {{ inProgress() ? 'An export is being prepared…' : 'Export everything' }}
                </button>
              </div>
            </div>
          </section>

          <section class="card">
            <header class="card-head"><h3>Your exports</h3></header>
            @if (exports.error(); as err) {
              <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
            }
            @if (exports.value().length === 0 && exports.loaded() && !exports.error()) {
              <p class="pad small muted">
                No export has been made. Export everything above to get a zip you can keep; it
                appears here while it is prepared and stays downloadable for 7 days.
              </p>
            }
            @if (exports.value().length) {
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Asked for</th>
                      <th scope="col">Status</th>
                      <th scope="col">Size</th>
                      <th scope="col">Records</th>
                      <th scope="col">Downloads</th>
                      <th scope="col"><span class="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (e of exports.value(); track e.id) {
                      <tr>
                        <td>
                          {{ e.requestedAtUtc | date: 'medium' }}
                          <div class="sub">#{{ e.id }} · {{ e.requestedBy }}</div>
                        </td>
                        <td>
                          <span class="chip" [class]="'chip ' + tone(e)">{{ label(e) }}</span>
                          @if (e.failureReason) {
                            <div class="sub">{{ e.failureReason }}</div>
                          }
                        </td>
                        <td>{{ size(e.sizeBytes) }}</td>
                        <td>
                          @if (e.rowCount !== null) {
                            {{ e.rowCount.toLocaleString() }} in {{ e.tableCount }} table(s)
                          } @else {
                            —
                          }
                        </td>
                        <td>{{ e.downloadCount }}</td>
                        <td>
                          @if (e.canDownload) {
                            <button
                              type="button"
                              class="btn btn-secondary btn-sm"
                              [disabled]="busy()"
                              (click)="download(e)"
                            >
                              Download
                            </button>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        </div>
        <aside class="side">
          @if (usage.value(); as u) {
            <section class="card">
              <header class="card-head">
                <h3>Some of what an export would hold today</h3>
                <span class="spacer"></span>
                <a class="small" routerLink="/iam/plan">Plan & usage</a>
              </header>
              <div class="table-wrap">
                <table class="grid">
                  <tbody>
                    @for (i of u.items; track i.key) {
                      <tr>
                        <td>{{ i.label }}</td>
                        <td>
                          <strong>{{ i.used }}</strong>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="pad small muted">
                Counts the plan tracks; the export also carries every order, position, signal,
                setting, alert, conversation and the organisation's own audit events — every table
                the organisation owns.
              </p>
            </section>
          }
          <section class="card">
            <header class="card-head"><h3>How the download works</h3></header>
            <div class="card-body small">
              <ol class="steps">
                <li>Export everything (an Owner, with a fresh second-factor sign-in).</li>
                <li>
                  The engine builds the zip in the background, off the trading path — usually
                  minutes.
                </li>
                <li>
                  When it is ready, <strong>Download</strong> makes a single-use link; it works
                  once.
                </li>
                <li>
                  The zip's manifest lists each file's SHA-256 so you can check the copy you keep.
                </li>
                <li>
                  Left out on purpose: passwords, API keys, bot tokens, webhook URLs and signing
                  secrets.
                </li>
              </ol>
            </div>
          </section>
        </aside>
      </div>

      <app-confirm-dialog
        [open]="confirming()"
        title="Export all of your organisation's data?"
        message="An export of everything your organisation owns is prepared in the background. It is recorded in your organisation's audit log."
        confirmLabel="Export"
        [loading]="busy()"
        (confirm)="request()"
        (cancelled)="confirming.set(false)"
      />

      <app-audit-trail
        heading="Export activity"
        [actions]="['tenant.export.', 'tenant.data.export']"
        empty="No export has been requested, prepared or downloaded yet. Each request, completion, download link and download is recorded here."
      />
    </div>
  `,
})
export class DataExportPageComponent {
  private readonly api = inject(LifecycleApiService);
  private readonly notify = inject(NotificationService);
  private readonly navigate = inject(NAVIGATE_TO);

  protected readonly P = Permission;
  protected readonly label = exportStatusLabel;
  protected readonly tone = exportTone;
  protected readonly size = formatBytes;

  readonly exports = iamResource<TenantDataExport[]>(
    () => this.api.exports(),
    [],
    'Could not load your exports.',
  );
  readonly inProgress = computed(() => exportInProgress(this.exports.value()));
  private readonly plans = inject(PlansApiService);
  readonly usage = iamResource<TenantUsage | null>(
    () => this.plans.myUsage().pipe(catchError(() => of(null))),
    null,
  );
  readonly tiles = computed<StatTile[]>(() => {
    const ex = this.exports.value();
    const latest = ex[0] ?? null;
    const ready = ex.filter((e) => e.canDownload).length;
    const today = ex.filter((e) => Date.now() - Date.parse(e.requestedAtUtc) < 86_400_000).length;
    return [
      {
        label: 'Exports',
        value: this.exports.loaded() ? String(ex.length) : '…',
        caption: latest ? `latest ${ago(latest.requestedAtUtc)}` : 'none made yet',
      },
      {
        label: 'Ready to download',
        value: this.exports.loaded() ? String(ready) : '…',
        caption: 'kept 7 days, single-use links',
        tone: ready ? 'good' : null,
      },
      {
        label: 'Requests left today',
        value: this.exports.loaded() ? String(Math.max(0, 3 - today)) : '…',
        caption: 'at most three a day, one at a time',
      },
      {
        label: 'Latest size',
        value: latest?.sizeBytes ? formatBytes(latest.sizeBytes) : '—',
        caption: latest?.tableCount
          ? `${latest.tableCount} tables · ${latest.rowCount ?? 0} rows`
          : 'no finished export',
      },
    ];
  });
  readonly busy = signal(false);
  readonly confirming = signal(false);

  constructor() {
    this.exports.reload();
    this.usage.reload();
    // While one is being prepared, look again now and then (and stop when the page goes).
    const timer = setInterval(() => {
      if (this.inProgress() && !this.exports.loading()) this.exports.reload();
    }, EXPORT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  request(): void {
    this.busy.set(true);
    this.api.requestExport().subscribe({
      next: (row) => {
        this.busy.set(false);
        this.confirming.set(false);
        this.exports.value.set([row, ...this.exports.value()]);
        this.notify.success('Export asked for: it is usually ready within a few minutes.');
      },
      error: (e) => {
        this.busy.set(false);
        this.confirming.set(false);
        this.notify.error(errorText(e, 'Could not ask for an export.'));
      },
    });
  }

  download(e: TenantDataExport): void {
    this.busy.set(true);
    this.api.downloadLink(e.id).subscribe({
      next: (link) => {
        this.busy.set(false);
        // A browser download (the file is served as an attachment): the single-use link is the credential.
        this.navigate(this.api.absolute(link.url));
        this.exports.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.notify.error(errorText(err, 'Could not start the download.'));
      },
    });
  }
}
