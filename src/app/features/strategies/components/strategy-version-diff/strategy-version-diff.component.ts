import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';

import type { StrategyVersionDto } from '@core/api/api.types';
import type {
  ScriptInputDto,
  ScriptInputValues,
  StrategyVersionScriptFields,
} from '@core/api/scripting.types';
import { effectiveOverrides } from '@features/scripting/pine/pine-inputs';
import { ScriptDiffComponent } from '@features/scripting/shared/script-diff.component';
import { DiffKind, formatDiffValue } from '../../util/json-diff';
import {
  StrategyVersionFields,
  diffScriptVersion,
  diffStrategyVersion,
  versionScriptFields,
} from '../../util/version-diff';

/**
 * What changed between a captured strategy version and the current form
 * values — one row per changed path, full values, grouped by field. Replaces
 * the old two-column view that cut every field at 80 characters, which made a
 * DSL edit unreadable (both sides showed the same first 80 characters). A
 * script strategy's Pine source and input overrides are compared side by side
 * (PE-02): "Roll back" swaps the script, so the diff must show it.
 */
@Component({
  selector: 'app-strategy-version-diff',
  standalone: true,
  imports: [DatePipe, ScriptDiffComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="vd">
      <div class="vd-head">
        <strong>v{{ version().versionNumber }} → current</strong>
        <span class="muted">
          captured {{ version().capturedAt | date: 'yyyy-MM-dd HH:mm' }}
          @if (version().createdBy; as author) {
            by {{ author }}
          }
        </span>
        @if (rowCount() > 0) {
          <span class="vd-counts">
            <span class="vd-added">+{{ counts().added }}</span>
            <span class="vd-removed">−{{ counts().removed }}</span>
            <span class="vd-changed">~{{ counts().changed }}</span>
          </span>
        }
        <span class="vd-spacer"></span>
        <button type="button" class="vd-close" (click)="closed.emit()">close</button>
      </div>

      @if (script(); as sc) {
        <section class="vd-group">
          <div class="vd-field">
            Pine script
            @if (sc.sourceChanged) {
              <span class="vd-counts">
                <span class="vd-removed">−{{ sc.removed }}</span>
                <span class="vd-added">+{{ sc.added }}</span>
                lines
              </span>
            }
          </div>
          <app-script-diff
            [before]="sc.before"
            [after]="sc.after"
            [beforeLabel]="'v' + version().versionNumber"
            afterLabel="Current"
            [beforeInputs]="normalizedVersionInputs()"
            [afterInputs]="normalizedCurrentInputs()"
            maxHeight="360px"
          />
        </section>
      }

      @if (groups().length === 0 && !script()) {
        <p class="muted">
          No differences — the current values match v{{ version().versionNumber }}.
        </p>
      } @else {
        @for (g of groups(); track g.field) {
          <section class="vd-group">
            <div class="vd-field">{{ g.label }}</div>
            <table class="vd-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Path</th>
                  <th>v{{ version().versionNumber }}</th>
                  <th>Current</th>
                </tr>
              </thead>
              <tbody>
                @for (r of g.rows; track $index) {
                  <tr [class]="'vd-row vd-' + r.kind">
                    <td class="vd-kind" [title]="r.kind">{{ kindSymbol(r.kind) }}</td>
                    <td class="vd-path">{{ r.relPath || '(whole field)' }}</td>
                    <td>
                      @if (r.kind !== 'added') {
                        <pre>{{ fmt(r.before) }}</pre>
                      }
                    </td>
                    <td>
                      @if (r.kind !== 'removed') {
                        <pre>{{ fmt(r.after) }}</pre>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }
    </div>
  `,
  styles: [
    `
      .vd {
        margin-top: 10px;
        padding: 8px 10px;
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 4px;
        font-size: 12px;
      }
      .vd-head {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 6px;
      }
      .vd-spacer {
        flex: 1;
      }
      .vd-close {
        background: none;
        border: none;
        color: var(--accent, #0071e3);
        cursor: pointer;
        font-size: 12px;
      }
      .muted {
        color: var(--text-tertiary, #8e8e93);
      }
      .vd-counts {
        display: inline-flex;
        gap: 6px;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
      }
      .vd-added {
        color: var(--profit, #248a3d);
      }
      .vd-removed {
        color: var(--loss, #d70015);
      }
      .vd-changed {
        color: #c93400;
      }
      .vd-group {
        margin-top: 8px;
      }
      .vd-field {
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary, #636366);
        margin-bottom: 2px;
      }
      .vd-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .vd-table th {
        text-align: left;
        font-weight: 500;
        font-size: 11px;
        color: var(--text-secondary, #636366);
        padding: 2px 6px;
      }
      .vd-table th:first-child {
        width: 18px;
      }
      .vd-table th:nth-child(2) {
        width: 38%;
      }
      .vd-table td {
        vertical-align: top;
        padding: 3px 6px;
        border-top: 1px solid var(--border-subtle, #eef0f3);
      }
      .vd-path {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        overflow-wrap: anywhere;
      }
      .vd-table pre {
        margin: 0;
        font-size: 11px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 240px;
        overflow: auto;
      }
      .vd-kind {
        font-weight: 700;
        text-align: center;
      }
      .vd-added .vd-kind {
        color: var(--profit, #248a3d);
      }
      .vd-removed .vd-kind {
        color: var(--loss, #d70015);
      }
      .vd-changed .vd-kind {
        color: #c93400;
      }
      .vd-added td:last-child {
        background: rgba(52, 199, 89, 0.08);
      }
      .vd-removed td:nth-child(3) {
        background: rgba(255, 59, 48, 0.07);
      }
      .vd-changed td:nth-child(3) {
        background: rgba(255, 59, 48, 0.05);
      }
      .vd-changed td:last-child {
        background: rgba(52, 199, 89, 0.06);
      }
    `,
  ],
})
export class StrategyVersionDiffComponent {
  version = input.required<StrategyVersionDto & StrategyVersionScriptFields>();
  /** The values the version is compared with — the edit form's current state. */
  current = input.required<StrategyVersionFields>();
  /**
   * The inputs the current script declares, when known: both sides' overrides are compared as
   * they run (an override equal to its default and none are the same).
   */
  inputDefs = input<readonly ScriptInputDto[] | null>(null);
  closed = output<void>();

  private readonly normalize = (v: Readonly<Record<string, unknown>>) =>
    this.inputDefs() ? effectiveOverrides(this.inputDefs(), v as ScriptInputValues) : v;

  /** PE-02: the script and its inputs — a script-only change is a difference too. */
  readonly script = computed(() =>
    diffScriptVersion(versionScriptFields(this.version()), this.current(), this.normalize),
  );
  readonly normalizedVersionInputs = computed(() =>
    this.normalize(versionScriptFields(this.version()).scriptInputs ?? {}),
  );
  readonly normalizedCurrentInputs = computed(() =>
    this.normalize(this.current().scriptInputs ?? {}),
  );

  readonly groups = computed(() => {
    const v = this.version();
    return diffStrategyVersion(
      {
        name: v.name,
        description: v.description,
        parametersJson: v.parametersJson,
        riskProfileId: v.riskProfileId,
        riskOverridesJson: v.riskOverridesJson,
        sizingConfigJson: v.sizingConfigJson,
        sessionFilterJson: v.sessionFilterJson,
        regimeGateJson: v.regimeGateJson,
        multiTimeframeGateJson: v.multiTimeframeGateJson,
      },
      this.current(),
    );
  });

  readonly counts = computed(() => {
    const c = { added: 0, removed: 0, changed: 0 };
    for (const g of this.groups()) for (const r of g.rows) c[r.kind]++;
    return c;
  });

  readonly rowCount = computed(() => this.groups().reduce((n, g) => n + g.rows.length, 0));

  kindSymbol(kind: DiffKind): string {
    return kind === 'added' ? '+' : kind === 'removed' ? '−' : '~';
  }

  fmt(v: unknown): string {
    return formatDiffValue(v);
  }
}
