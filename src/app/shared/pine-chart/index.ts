/**
 * Pine chart — renders a Pine v6 script run (ADR-0027 §3 run results, §5 Bar Replay) on
 * Lightweight Charts, with the Pine Logs, trace ("why didn't it fire?") and profiler panes.
 *
 * Hosting:
 *   <app-pine-chart [result]="run" (barClick)="…" />            chart only
 *   <app-pine-logs-pane [logs]="run.outputs.logs" … />           panes, each standalone
 *   <app-pine-preview [result]="run" [request]="req" …/>          chart + dock + replay (features/scripting)
 */
export { PineChartComponent, type PineBarRef } from './components/pine-chart.component';
export { PineDataWindowComponent } from './components/pine-data-window.component';
export { PineTableOverlayComponent } from './components/pine-table-overlay.component';
export { PineLogsPaneComponent, type PineLineJump } from './panes/pine-logs-pane.component';
export { PineTracePaneComponent } from './panes/pine-trace-pane.component';
export { PineProfilerPaneComponent } from './panes/pine-profiler-pane.component';
export { PineReplayComponent } from './replay/pine-replay.component';
export { ReplaySession, type ReplayApi, type ReplayStatus } from './replay/replay-session';
export { ScriptingRunApiService } from './api/scripting-run-api.service';
export { toPineChartData, type PineChartData } from './model/chart-data';
export { normalizeRunResult, normalizeOutputs } from './model/normalize';
export { mergeOutputs } from './model/merge-outputs';
export { buildRenderModel } from './render/build-render-model';
export type * from './model/pine-outputs.types';
