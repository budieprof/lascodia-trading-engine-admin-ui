import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { when } from '@features/iam/iam.logic';
import { limitText, usagePercent, usageText, usageTone, usdText } from '../plans.logic';
import type { TenantUsage, UsageItem } from '../plans.types';

/**
 * What an organisation's plan allows and how much of it is in use (engine Phase 7, P7.3). Shared by
 * the organisation's own "Plan & usage" page and the platform Organisations page. Presentational:
 * the caller loads the usage.
 */
@Component({
  selector: 'app-plan-usage-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../../iam/shared/iam-page.scss'],
  styles: [
    `
      .meter {
        position: relative;
        height: 6px;
        min-width: 120px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .meter > span {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: inherit;
        background: var(--profit, #1f9d55);
      }
      .meter.warn > span {
        background: #ff9500;
      }
      .meter.bad > span {
        background: var(--loss);
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-3);
      }
      .fact .label {
        display: block;
        margin-bottom: 2px;
      }
    `,
  ],
  template: `
    @let u = usage();
    <div class="card-body">
      <div class="row">
        <strong>{{ u.plan?.name ?? 'No plan' }}</strong>
        @if (u.unlimited) {
          <span class="chip info">Unlimited</span>
        } @else if (u.plan?.viaDefault) {
          <span class="chip">Default plan</span>
        }
        @if (overCount() > 0) {
          <span class="chip bad">{{ overCount() }} over the limit</span>
        }
        <span class="muted small">as of {{ when(u.generatedAtUtc) }}</span>
      </div>
      @if (u.plan?.description; as description) {
        <p class="muted small" style="margin: 0">{{ description }}</p>
      }
      @if (!u.plan && !u.unlimited) {
        <p class="note warn">
          This organisation has no plan, so nothing new can be added. Platform staff assign one.
        </p>
      }

      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th>What</th>
              <th>In use</th>
              <th><span class="sr-only">Share of the limit</span></th>
              <th>Room left</th>
            </tr>
          </thead>
          <tbody>
            @for (item of u.items; track item.key) {
              <tr>
                <td>{{ item.label }}</td>
                <td class="small">{{ text(item) }}</td>
                <td>
                  @if (percent(item); as p) {
                    <div
                      class="meter"
                      [class.warn]="tone(item) === 'warn'"
                      [class.bad]="tone(item) === 'bad'"
                      role="meter"
                      [attr.aria-valuenow]="p"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      [attr.aria-label]="item.label + ' in use'"
                    >
                      <span [style.width.%]="p"></span>
                    </div>
                  } @else if (item.limit === null) {
                    <span class="muted small">Unlimited</span>
                  } @else {
                    <div
                      class="meter"
                      role="meter"
                      aria-valuenow="0"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      [attr.aria-label]="item.label + ' in use'"
                    >
                      <span style="width: 0"></span>
                    </div>
                  }
                </td>
                <td class="small">
                  @if (item.overLimit) {
                    <span class="chip bad"
                      >Over the limit by {{ item.used - (item.limit ?? 0) }}</span
                    >
                  } @else if (item.limit !== null && item.remaining === 0) {
                    <span class="chip bad">Full</span>
                  } @else {
                    {{ item.remaining === null ? '—' : item.remaining }}
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="facts">
        <div class="fact">
          <span class="label">Features</span>
          <span class="chip" [class.ok]="u.features.sso"
            >Single sign-on {{ u.features.sso ? 'included' : 'not included' }}</span
          >
          <span class="chip" [class.ok]="u.features.scim"
            >SCIM {{ u.features.scim ? 'included' : 'not included' }}</span
          >
          <span class="chip" [class.ok]="u.features.personalAccessTokens"
            >Access tokens {{ u.features.personalAccessTokens ? 'included' : 'not included' }}</span
          >
          <span class="chip" [class.ok]="u.features.fundModule"
            >Fund module {{ u.features.fundModule ? 'included' : 'not included' }}</span
          >
        </div>
        <div class="fact">
          <span class="label">LLM budget per month</span>
          <span>{{ usd(u.llm.monthlyLimitUsd) }}</span>
          @if (!u.llm.available) {
            <p class="note">{{ u.llm.note || 'Spend is not measured per organisation yet.' }}</p>
          } @else {
            <span class="muted small"> · {{ usd(u.llm.monthToDateUsd) }} used this month</span>
          }
        </div>
        <div class="fact">
          <span class="label">Log retention</span>
          <span>{{
            u.logRetention.days === null ? "Platform's retention" : u.logRetention.days + ' days'
          }}</span>
          @if (!u.logRetention.applied && u.logRetention.days !== null) {
            <p class="note">{{ u.logRetention.note }}</p>
          }
        </div>
      </div>
    </div>
  `,
})
export class PlanUsagePanelComponent {
  readonly usage = input.required<TenantUsage>();

  protected readonly when = when;
  protected readonly limit = limitText;
  protected readonly usd = usdText;

  readonly overCount = computed(() => this.usage().items.filter((i) => i.overLimit).length);

  percent(item: UsageItem): number | null {
    // A meter needs a positive share to draw; 0 % is drawn as an empty bar by the template.
    const p = usagePercent(item);
    return p === null || p === 0 ? null : p;
  }

  tone(item: UsageItem) {
    return usageTone(item);
  }

  text(item: UsageItem): string {
    return usageText(item);
  }
}
