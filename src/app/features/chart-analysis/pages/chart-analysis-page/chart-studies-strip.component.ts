import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { ScriptChipComponent, type ScriptChip } from '../../scripts/script-chip.component';
import type { ActiveIndicator } from '../../chart/chart-host.component';
import { studyKind, studyLabel, studyMeta } from '../../studies';
import { indicatorById, indicatorLabel } from '../../indicators/registry';
import { sourceGroups, type SourceGroup } from '../../indicators/study-settings';

/** A study input changed in the strip: the page parses and applies it (`setParam`). */
export interface StudyParamChange {
  uid: string;
  key: string;
  value: string;
}

/**
 * The active-studies strip under the chart: each Pine script's chip and each indicator with its inline inputs.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. US02b: it takes the studies and script chips as inputs (the script error and the tester as two-way
 * models) and reports every action as an output the page binds to its existing handlers — no page slice. A study's
 * label, inputs, sources and time label are pure functions of the study; its note is the page's (`studyNote`).
 * Eager change detection as before: it is checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-studies-strip',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent, ScriptChipComponent],
  templateUrl: './chart-studies-strip.component.html',
  styleUrl: './chart-studies-strip.component.scss',
})
export class ChartStudiesStripComponent {
  readonly active = input.required<readonly ActiveIndicator[]>();
  readonly scriptChips = input.required<readonly ScriptChip[]>();
  readonly scriptError = model.required<string | null>();
  readonly testerOpen = model.required<boolean>();
  /** The chart can take a click for a time input. */
  readonly canPickOnChart = input.required<boolean>();
  /** What a study's row notes (volume kind, exchange sessions, an external pane's note): the page's. */
  readonly studyNote = input.required<(item: ActiveIndicator) => string | null>();

  readonly scriptVisibility = output<string>();
  readonly scriptSettings = output<string>();
  readonly scriptSource = output<string>();
  readonly scriptLogs = output<string>();
  readonly scriptAlert = output<string>();
  readonly scriptRemove = output<string>();
  readonly scriptOpenAt = output<{ key: string; where: { line: number; column: number } }>();
  readonly indicatorToggle = output<string>();
  readonly indicatorRemove = output<string>();
  readonly paramChange = output<StudyParamChange>();
  readonly timePick = output<{ uid: string; key: string }>();
  readonly scorecard = output<void>();
  readonly studySettings = output<string>();

  protected labelFor(item: ActiveIndicator): string {
    return studyLabel(item.defId, item.params);
  }

  /** A candlestick- or chart-pattern study (its row offers the scorecard, DR-I8). */
  protected isPatternStudy(item: ActiveIndicator): boolean {
    const k = studyKind(item.defId);
    return k === 'candle-pattern' || k === 'chart-pattern';
  }

  protected inputsFor(item: ActiveIndicator) {
    return studyMeta(item.defId)?.inputs ?? [];
  }

  /** The Source dropdown's choices for a study (DR-16 / DR-I5). */
  protected sourceGroupsFor(item: ActiveIndicator): SourceGroup[] {
    return sourceGroups(item, this.active(), (s) => {
      const def = indicatorById(s.defId);
      return def ? { label: indicatorLabel(def, s.params), plots: def.plots } : null;
    });
  }

  /** A time input's value on the studies bar: the picked bar (UTC), or what to do. */
  protected studyTimeLabel(v: number | string | undefined): string {
    const ms = Number(v);
    return Number.isFinite(ms) && ms > 0
      ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
      : 'Pick on chart';
  }

  protected setParam(uid: string, key: string, value: string): void {
    this.paramChange.emit({ uid, key, value });
  }
}
