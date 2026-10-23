/**
 * Browser side of the WebGL heatmap benchmark (`run-bench.mjs` bundles this with esbuild and drives it in Chromium).
 * It runs the PRODUCTION code path of the event-level heatmap — BookTimeline → HeatFolder (fold every book event into
 * the time × price texture) → HeatSurface (WebGL2 upload + shader draw) → drawImage onto a visible 2D canvas — and
 * times each animation frame while the view pans and live events are appended, as on a chart at the live edge.
 */
import { BookTimeline } from '../../src/app/core/realtime/md-book';
import type { MdBookEventWire } from '../../src/app/core/realtime/marketdata.types';
import { createWebGlHeatSurface } from '../../src/app/features/chart-analysis/orderflow/gl/heat-gl';
import { heatQuads } from '../../src/app/features/chart-analysis/orderflow/gl/heat-layout';
import {
  HeatFolder,
  bookLevelStep,
  bookPriceRange,
  heatSpecFor,
} from '../../src/app/features/chart-analysis/orderflow/gl/heat-texture';

interface BenchInput {
  events: MdBookEventWire[];
  width: number;
  height: number;
  dpr: number;
  frames: number;
  /** Events appended per frame at the live edge (0: a static view). */
  liveEventsPerFrame: number;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: s[s.length - 1],
  };
}

async function run(input: BenchInput) {
  const { events, width, height, dpr } = input;
  const split = input.liveEventsPerFrame > 0 ? Math.floor(events.length * 0.9) : events.length;
  const history = events.slice(0, split);
  const live = events.slice(split);
  const t0 = performance.now();
  const timeline = new BookTimeline();
  timeline.appendAll(history);
  const tTimeline = performance.now() - t0;
  const range = bookPriceRange(timeline)!;
  const from = events[0].t;
  const to = events[events.length - 1].t + 1;
  const spec = heatSpecFor({
    fromUtc: from,
    toUtc: to,
    widthPx: width,
    pLow: range.lo,
    pHigh: range.hi,
    levelStep: bookLevelStep(history, 0.00001),
    pricePerPx: ((range.hi - range.lo) * 2) / height,
  })!;
  const t1 = performance.now();
  const folder = new HeatFolder(spec, timeline);
  folder.advanceTo(history[history.length - 1].t + 1);
  const tFold = performance.now() - t1;
  const t2 = performance.now();
  const robustMax = folder.robustMax();
  const tRobust = performance.now() - t2;

  const surface = createWebGlHeatSurface();
  if (!surface) return { error: 'WebGL2 not available' };
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  // Upload once (as the first frame does), timed separately.
  const t3 = performance.now();
  surface.sync(folder);
  const gl = (surface.canvas as HTMLCanvasElement).getContext('webgl2')!;
  gl.finish();
  const tUpload = performance.now() - t3;

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg
    ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);

  const pxPerMs = width / (to - from);
  const frameCpu: number[] = [];
  const frameGpuSync: number[] = [];
  const intervals: number[] = [];
  let li = 0;
  let last = performance.now();
  await new Promise<void>((resolve) => {
    let n = 0;
    const tick = () => {
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      const a = performance.now();
      // Live: append this frame's events and fold them.
      for (let k = 0; k < input.liveEventsPerFrame && li < live.length; k++, li++)
        timeline.append(live[li]);
      if (input.liveEventsPerFrame > 0) folder.advanceTo(li < live.length ? live[li].t : to);
      // Pan a little every frame (projection changes, texture does not).
      const pan = (n % 120) - 60;
      const xAt = (t: number) => (t - from) * pxPerMs + pan;
      const yAt = (p: number) =>
        height / 2 - (p - (range.lo + range.hi) / 2) / (((range.hi - range.lo) * 2) / height);
      const quads = heatQuads(spec, [{ t0: from, t1: to }], xAt, yAt, width, height);
      surface.sync(folder);
      surface.draw({
        width,
        height,
        pixelWidth: width * dpr,
        pixelHeight: height * dpr,
        quads,
        robustMax,
        opacity: 0.6,
      });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(surface.canvas as CanvasImageSource, 0, 0, canvas.width, canvas.height);
      frameCpu.push(performance.now() - a);
      // Every 10th frame, wait for the GPU too (what a frame really costs end to end).
      if (n % 10 === 0) {
        gl.finish();
        frameGpuSync.push(performance.now() - a);
      }
      n++;
      if (n < input.frames) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  intervals.shift();
  surface.dispose();
  return {
    renderer,
    events: events.length,
    spanMinutes: (to - from) / 60_000,
    grid: {
      cols: spec.cols,
      rows: spec.rows,
      colMs: spec.colMs,
      rowStep: spec.rowStep,
      textureMB: (spec.cols * spec.rows * 4) / 1e6,
    },
    setupMs: { timeline: tTimeline, fold: tFold, robustMax: tRobust, firstUpload: tUpload },
    frameMs: stats(frameCpu),
    frameWithGpuFinishMs: stats(frameGpuSync),
    rafIntervalMs: stats(intervals),
    liveEventsAppended: li,
  };
}

(window as unknown as { runBench: typeof run }).runBench = run;
