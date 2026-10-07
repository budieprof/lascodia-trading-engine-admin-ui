import { beforeEach, describe, expect, it } from 'vitest';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, UrlSegment, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { CHART_ANALYSIS_ROUTES, chartAnalysisUrl } from '../../chart-analysis.routes';

// The chart page's routes as the app mounts them, with the real router: the page component and its
// workspace resolver are stand-ins (the page itself needs the engine), everything else — the URL
// matcher and when the resolver runs — is the shipped configuration.

@Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
class StandInPageComponent {
  readonly route = inject(ActivatedRoute);
}

@Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
class OtherPageComponent {}

let resolved = 0;
const routes: Routes = [
  {
    path: 'chart-analysis',
    children: CHART_ANALYSIS_ROUTES.map((r) => ({
      ...r,
      component: StandInPageComponent,
      resolve: { workspace: () => ++resolved },
    })),
  },
  { path: 'positions', component: OtherPageComponent },
];

describe('chart page routes', () => {
  beforeEach(() => {
    resolved = 0;
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
  });

  it('keep the page through symbol switches, from a bare /chart-analysis too', async () => {
    const harness = await RouterTestingHarness.create();
    const opened = await harness.navigateByUrl('/chart-analysis', StandInPageComponent);
    expect(opened.route.snapshot.paramMap.get('symbol')).toBeNull();

    // The page's own switch: it navigates to the symbol's URL.
    const switched = await harness.navigateByUrl(
      '/chart-analysis/USDJPY?tf=60',
      StandInPageComponent,
    );
    expect(switched).toBe(opened); // the same page, not a rebuilt one
    expect(switched.route.snapshot.paramMap.get('symbol')).toBe('USDJPY');

    const back = await harness.navigateByUrl('/chart-analysis/EURUSD?tf=60', StandInPageComponent);
    expect(back).toBe(opened);
    expect(back.route.snapshot.paramMap.get('symbol')).toBe('EURUSD');
  });

  it('settle the workspace once per visit, not once per symbol switch', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/chart-analysis/EURUSD', StandInPageComponent);
    await harness.navigateByUrl('/chart-analysis/USDJPY', StandInPageComponent);
    await harness.navigateByUrl('/chart-analysis/GBPUSD?tf=240', StandInPageComponent);
    expect(resolved).toBe(1);

    // Leaving and coming back is a new visit: the layout is read again then.
    await harness.navigateByUrl('/positions', OtherPageComponent);
    await harness.navigateByUrl('/chart-analysis/GBPUSD', StandInPageComponent);
    expect(resolved).toBe(2);
  });

  it('match the bare page and one symbol, nothing deeper', () => {
    const seg = (path: string) => new UrlSegment(path, {});
    expect(chartAnalysisUrl([])).toEqual({ consumed: [] });
    const one = chartAnalysisUrl([seg('EURUSD')]);
    expect(one?.consumed.map((s) => s.path)).toEqual(['EURUSD']);
    expect(one?.posParams?.['symbol'].path).toBe('EURUSD');
    expect(chartAnalysisUrl([seg('EURUSD'), seg('extra')])).toBeNull();
  });
});
