import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';

import { HealthService } from '@core/services/health.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { HealthStatusDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Persistent app-shell footer pill exposing UI build metadata + engine
 * reachability (PRD §6.4 / Phase 8 hardening item). UI build SHA + buildTime
 * come from runtime config (populated at container start via the entrypoint
 * substituting env vars into public/config.json — same channel as API_BASE_URL).
 * Engine status polls /health/status every 60s; "engine offline" surfaces in
 * red so operators notice without needing to open System Health.
 */
@Component({
  selector: 'app-footer-version-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RelativeTimePipe],
  template: `
    <footer class="pill" role="contentinfo" aria-label="Build and engine status">
      <div class="cluster ui">
        <span class="label">UI</span>
        @if (uiVersion()) {
          <span class="value">{{ uiVersion() }}</span>
        }
        @if (uiSha()) {
          <span class="mono small sha" [title]="'Build SHA: ' + fullSha()">
            {{ shortSha() }}
          </span>
        }
        @if (uiBuildTime(); as bt) {
          <span class="muted small" [title]="bt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
            built {{ bt | relativeTime }}
          </span>
        }
        @if (uiEnvironment(); as env) {
          <span class="env-pill" [attr.data-env]="env.toLowerCase()">{{ env }}</span>
        }
        @if (!uiSha() && !uiVersion() && !uiBuildTime()) {
          <span class="muted small">dev</span>
        }
      </div>

      <span class="divider" aria-hidden="true">·</span>

      <div class="cluster engine">
        <span class="label">Engine</span>
        @if (engineStatus(); as st) {
          @if (st.isRunning) {
            <span class="status-dot ok" title="Engine is running"></span>
            <span class="value">running</span>
            <span class="muted small">
              · {{ st.activeStrategies }} active · {{ st.openPositions }} open
            </span>
            @if (st.paperMode === 'true') {
              <span class="paper-pill">paper</span>
            }
          } @else {
            <span class="status-dot bad" title="Engine reports not running"></span>
            <span class="value bad">offline</span>
          }
          <span class="muted small ago" [title]="st.checkedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
            {{ st.checkedAt | relativeTime }}
          </span>
        } @else if (engineError()) {
          <span class="status-dot bad" title="Could not reach engine"></span>
          <span class="value bad">unreachable</span>
        } @else {
          <span class="status-dot loading" title="Loading"></span>
          <span class="muted small">…</span>
        }
      </div>

      <span class="divider" aria-hidden="true">·</span>

      <div class="cluster api">
        <span class="label">API</span>
        <span class="mono small base" [title]="apiBaseUrl()">{{ apiBaseLabel() }}</span>
      </div>
    </footer>
  `,
  styles: [
    `
      .pill {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
        padding: 6px var(--space-4);
        background: var(--bg-secondary);
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .cluster {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .label {
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .value {
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .sha {
        color: var(--accent);
        padding: 1px 6px;
        background: var(--bg-primary);
        border-radius: var(--radius-sm);
      }
      .env-pill {
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: rgba(142, 142, 147, 0.16);
        color: #636366;
      }
      .env-pill[data-env='production'] {
        background: rgba(255, 59, 48, 0.16);
        color: #d70015;
      }
      .env-pill[data-env='staging'] {
        background: rgba(255, 149, 0, 0.16);
        color: #c93400;
      }
      .env-pill[data-env='development'],
      .env-pill[data-env='dev'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .divider {
        color: var(--text-tertiary);
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .status-dot.ok {
        background: #34c759;
      }
      .status-dot.bad {
        background: #ff3b30;
      }
      .status-dot.loading {
        background: var(--text-tertiary);
        opacity: 0.5;
      }
      .bad {
        color: #d70015;
      }
      .paper-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: rgba(175, 82, 222, 0.12);
        color: #8e44ad;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ago {
        margin-left: 4px;
      }
      .base {
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class FooterVersionPillComponent {
  private readonly health = inject(HealthService);
  private readonly runtime = inject(RUNTIME_CONFIG);

  protected readonly uiVersion = computed(() => this.runtime.appVersion ?? null);
  protected readonly uiSha = computed(() => this.runtime.buildSha ?? null);
  protected readonly fullSha = computed(() => this.runtime.buildSha ?? '');
  protected readonly shortSha = computed(() => {
    const sha = this.runtime.buildSha;
    return sha && sha.length > 7 ? sha.slice(0, 7) : (sha ?? '');
  });
  protected readonly uiBuildTime = computed(() => this.runtime.buildTime ?? null);
  protected readonly uiEnvironment = computed(() => this.runtime.environmentLabel ?? null);
  protected readonly apiBaseUrl = computed(() => this.runtime.apiBaseUrl);
  protected readonly apiBaseLabel = computed(() => {
    const url = this.runtime.apiBaseUrl;
    try {
      const u = new URL(url);
      return u.host;
    } catch {
      return url;
    }
  });

  protected readonly healthResource = createPolledResource(
    () =>
      this.health.getStatus().pipe(
        map((res) => (res.status ? (res.data ?? null) : null)),
        catchError(() => of<HealthStatusDto | null>(null)),
      ),
    { intervalMs: 60_000 },
  );

  protected readonly engineStatus = computed(() => this.healthResource.value());
  protected readonly engineError = computed(
    () => !!this.healthResource.error() && !this.healthResource.value(),
  );
}
