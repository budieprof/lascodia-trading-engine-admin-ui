import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ScriptCompileResult } from '@core/api/scripting.types';
import { countDiagnostics } from '../../pine/pine-diagnostics';

export type CompileState = 'idle' | 'compiling' | 'done' | 'failed';

/** Pine's limits: 64 plot slots, 40 `request.*` calls. */
export const PINE_MAX_PLOT_SLOTS = 64;
export const PINE_MAX_REQUESTS = 40;

/**
 * The strip under the editor: compile state, the declaration (kind and title), plot-slot and
 * request usage against Pine's limits, and the cursor position.
 */
@Component({
  selector: 'app-script-status-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="status" role="status" aria-live="polite">
      <span class="state" [attr.data-state]="stateKey()">
        @switch (stateKey()) {
          @case ('compiling') {
            <span class="dot"></span> Compiling…
          }
          @case ('failed') {
            <span class="dot"></span> {{ failureMessage() || 'Compile unavailable' }}
          }
          @case ('errors') {
            <span class="dot"></span> {{ counts().errors }} error{{ counts().errors === 1 ? '' : 's' }}
            @if (counts().warnings) {
              · {{ counts().warnings }} warning{{ counts().warnings === 1 ? '' : 's' }}
            }
          }
          @case ('ok') {
            <span class="dot"></span> Compiled
            @if (counts().warnings) {
              · {{ counts().warnings }} warning{{ counts().warnings === 1 ? '' : 's' }}
            }
          }
          @default {
            <span class="dot"></span> Not compiled
          }
        }
        @if (stale() && stateKey() !== 'compiling') {
          <span class="stale" title="The source changed since this compile">· edited</span>
        }
      </span>
      @if (result()?.declaration; as d) {
        <span class="decl" [title]="d.title">
          <span class="kind">{{ d.kind }}</span>
          <span class="decl-title">{{ d.shortTitle || d.title }}</span>
        </span>
      }
      <span class="spacer"></span>
      @if (result(); as r) {
        @if (r.plotSlots !== undefined && r.plotSlots !== null) {
          <span class="meter" [class.is-high]="r.plotSlots > maxPlots * 0.9" title="Plot slots used">
            Plots {{ r.plotSlots }}/{{ maxPlots }}
          </span>
        }
        @if (r.requestCount !== undefined && r.requestCount !== null) {
          <span
            class="meter"
            [class.is-high]="r.requestCount > maxRequests * 0.9"
            title="request.* calls"
          >
            Requests {{ r.requestCount }}/{{ maxRequests }}
          </span>
        }
      }
      @if (cursor(); as c) {
        <span class="meter">Ln {{ c.line }}, Col {{ c.column }}</span>
      }
      <span class="meter lang">Pine v{{ result()?.declaration?.languageVersion ?? 6 }}</span>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .status {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px 12px;
        padding: 4px 10px;
        min-height: 26px;
        font-size: 11.5px;
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
      }
      .state {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      .state[data-state='ok'] .dot {
        background: var(--profit);
      }
      .state[data-state='errors'] {
        color: var(--loss);
      }
      .state[data-state='errors'] .dot {
        background: var(--loss);
      }
      .state[data-state='failed'] .dot {
        background: var(--warning);
      }
      .state[data-state='compiling'] .dot {
        background: var(--accent);
        animation: pulse 1s ease-in-out infinite;
      }
      @keyframes pulse {
        50% {
          opacity: 0.3;
        }
      }
      .stale {
        font-weight: 400;
        color: var(--text-tertiary);
      }
      .decl {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .kind {
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
        font-weight: 600;
      }
      .decl-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 280px;
        color: var(--text-primary);
      }
      .spacer {
        flex: 1;
      }
      .meter {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        white-space: nowrap;
      }
      .meter.is-high {
        color: var(--warning);
      }
      .lang {
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class ScriptStatusBarComponent {
  readonly result = input<ScriptCompileResult | null>(null);
  readonly state = input<CompileState>('idle');
  readonly failureMessage = input<string | null>(null);
  /** The source changed after the result was computed. */
  readonly stale = input(false);
  readonly cursor = input<{ line: number; column: number } | null>(null);

  readonly maxPlots = PINE_MAX_PLOT_SLOTS;
  readonly maxRequests = PINE_MAX_REQUESTS;

  readonly counts = computed(() => countDiagnostics(this.result()?.diagnostics ?? []));
  readonly stateKey = computed(() => {
    const s = this.state();
    if (s === 'compiling') return 'compiling';
    if (s === 'failed') return 'failed';
    const r = this.result();
    if (!r) return 'idle';
    return this.counts().errors > 0 ? 'errors' : 'ok';
  });
}
