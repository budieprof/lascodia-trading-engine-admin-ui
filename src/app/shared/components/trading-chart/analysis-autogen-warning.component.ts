import { ChangeDetectionStrategy, Component, output } from '@angular/core';

/**
 * Shown when an analysis returned viable setups while auto-gen was off, so no signal was persisted.
 * "Turn on" asks the chart to switch auto-gen on (the chart owns the confirmation and the config write).
 */
@Component({
  selector: 'app-analysis-autogen-warning',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './analysis-autogen-warning.component.scss',
  template: `
    <section class="rec-autogen-warn" role="status">
      <span class="warn-icon" aria-hidden="true">⚠</span>
      <div class="warn-body">
        <strong>Auto-gen was off — no signal was created.</strong>
        <span class="warn-muted">
          Toggle <em>Auto-gen signals</em> on the toolbar to have the engine persist viable setups
          automatically next time, or use <em>Create Signal</em> below to file this one manually.
        </span>
      </div>
      <button type="button" class="warn-action" (click)="turnOn.emit()">Turn on</button>
    </section>
  `,
})
export class AnalysisAutogenWarningComponent {
  readonly turnOn = output<void>();
}
