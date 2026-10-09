import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ScriptDialogService } from '../shared/script-dialog.service';
import { SavedScreensPanelComponent } from './saved-screens-panel.component';

declareSignalIo(SavedScreensPanelComponent, {
  inputs: ['activeId', 'refreshKey', 'canWrite', 'canRun'],
  outputs: ['opened', 'ran', 'removed', 'changed'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function screen(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Screen ${id}`,
    sourceKind: 'ChartScript',
    sourceId: 9,
    sourceName: 'RSI mine',
    symbols: ['EURUSD', 'GBPUSD', 'USDJPY'],
    timeframe: '60',
    extraTimeframes: ['240'],
    matched: ['EURUSD'],
    scheduleEnabled: false,
    statusReason: null,
    scheduleNote: null,
    nextRunAtUtc: null,
    lastRunAt: null,
    lastRunError: null,
    ...over,
  };
}

describe('SavedScreensPanelComponent (SS-I6)', () => {
  let fixture: ComponentFixture<SavedScreensPanelComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  const confirm = vi.fn(async () => true);

  beforeEach(async () => {
    confirm.mockClear();
    TestBed.configureTestingModule({
      imports: [SavedScreensPanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ScriptDialogService, useValue: { confirm } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SavedScreensPanelComponent);
    fixture.componentRef.setInput('activeId', 7);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    http.expectOne(`${BASE}/scripting/screens`).flush(
      ok([
        screen(7, { scheduleEnabled: true, nextRunAtUtc: '2026-10-09T13:00:00Z' }),
        screen(8, {
          lastRunAt: '2026-10-09T12:00:00Z',
          lastRunError: 'The script no longer compiles.',
        }),
      ]),
    );
    await settle();
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('lists the screens with their universe, matches and schedule', () => {
    const first = el.querySelector('tr[data-screen="7"]')!;
    expect(first.classList).toContain('active');
    expect(first.textContent).toContain('My script · RSI mine');
    expect(first.textContent).toContain('3 symbols · H1 + H4');
    expect(first.textContent).toContain('On — next run 2026-10-09 13:00 UTC');
    expect(el.querySelector('tr[data-screen="8"]')!.textContent).toContain('failed');
  });

  it('opens a screen when its name is chosen', () => {
    let opened: number | null = null;
    fixture.componentInstance.opened.subscribe((id) => (opened = id));
    (el.querySelector('tr[data-screen="8"] .link') as HTMLButtonElement).click();
    expect(opened).toBe(8);
  });

  it('switches a schedule on, and puts the box back when the engine refuses', async () => {
    let changed: unknown = null;
    fixture.componentInstance.changed.subscribe((d) => (changed = d));
    const box = el.querySelector<HTMLInputElement>('tr[data-screen="8"] input[type="checkbox"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    const put = http.expectOne(`${BASE}/scripting/screens/8/schedule`);
    expect(put.request.body).toEqual({ enabled: true });
    put.flush({
      data: null,
      status: false,
      message: 'At most 50 screens can run on a schedule (ScriptScreens:MaxScheduled).',
      responseCode: '-11',
    });
    await settle();
    fixture.detectChanges();
    expect(box.checked).toBe(false);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('At most 50 screens');
    expect(changed).toBeNull();

    box.checked = true;
    box.dispatchEvent(new Event('change'));
    http
      .expectOne(`${BASE}/scripting/screens/8/schedule`)
      .flush(ok(screen(8, { scheduleEnabled: true })));
    await settle();
    expect((changed as { id: number }).id).toBe(8);
  });

  it('deletes a screen only after the operator confirms', async () => {
    let removed: number | null = null;
    fixture.componentInstance.removed.subscribe((id) => (removed = id));
    const del = () =>
      [...el.querySelectorAll<HTMLButtonElement>('tr[data-screen="7"] button')]
        .find((b) => b.textContent!.includes('Delete'))!
        .click();

    confirm.mockResolvedValueOnce(false);
    del();
    await settle();
    http.expectNone(`${BASE}/scripting/screens/7`);

    del();
    await settle();
    expect(confirm).toHaveBeenCalledTimes(2);
    http
      .expectOne((r) => r.method === 'DELETE' && r.url === `${BASE}/scripting/screens/7`)
      .flush(ok(true));
    await settle();
    fixture.detectChanges();
    expect(removed).toBe(7);
    expect(el.querySelector('tr[data-screen="7"]')).toBeNull();
  });
});
