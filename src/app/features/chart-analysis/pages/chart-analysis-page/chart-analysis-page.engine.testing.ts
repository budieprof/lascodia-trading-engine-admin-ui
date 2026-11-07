import { ChartScriptEngine, type ScriptEngineHost, type ScriptEngineState } from './chart-script-engine';

/**
 * The script-run engine (U13 fu-ui: `ChartScriptEngine`) for the page specs that build the page from its prototype
 * (`Object.create(ChartAnalysisPageComponent.prototype)`: class fields — the engine and its aliases — are not
 * initialised there). The page object is the engine's host (it carries every member the host reads, by the page's own
 * names), and the run state the spec put on it — its scheduler (often one whose quiet re-runs are a spy), runs in
 * flight, failures, pending / waiting scripts, warm sessions — is handed to the engine, so `p.scriptFailures()`,
 * `p.runScheduler`, … are the engine's state as before. Call it after the page's state is assigned.
 */
export function attachScriptEngine<P extends object>(p: P): P & { engine: ChartScriptEngine } {
  const engine = new ChartScriptEngine(
    p as unknown as ScriptEngineHost,
    p as unknown as Partial<ScriptEngineState>,
  );
  return Object.assign(p, { engine });
}
