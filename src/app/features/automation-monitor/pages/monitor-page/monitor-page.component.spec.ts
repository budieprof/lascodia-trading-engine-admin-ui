import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { AutomationMonitorPageComponent } from './monitor-page.component';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

describe('AutomationMonitorPageComponent', () => {
  let cmp: AutomationMonitorPageComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AutomationMonitorPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    const fixture = TestBed.createComponent(AutomationMonitorPageComponent);
    cmp = fixture.componentInstance;
  });

  describe('statusClass', () => {
    it('classifies completed/created/approved as success', () => {
      expect(cmp.statusClass('Completed')).toBe('success');
      expect(cmp.statusClass('CREATED')).toBe('success');
      expect(cmp.statusClass('approved')).toBe('success');
    });

    it('classifies failure-shaped statuses as fail', () => {
      expect(cmp.statusClass('Failed')).toBe('fail');
      expect(cmp.statusClass('Cancelled')).toBe('fail');
      expect(cmp.statusClass('Abandoned')).toBe('fail');
    });

    it('classifies in-flight statuses as info', () => {
      expect(cmp.statusClass('Queued')).toBe('info');
      expect(cmp.statusClass('Running')).toBe('info');
      expect(cmp.statusClass('Claimed')).toBe('info');
    });

    it('classifies deferred/pending as warn', () => {
      expect(cmp.statusClass('Deferred')).toBe('warn');
      expect(cmp.statusClass('Pending')).toBe('warn');
    });

    it('falls back to neutral for unknown statuses', () => {
      expect(cmp.statusClass('Whatever')).toBe('neutral');
    });
  });

  describe('kindLabel', () => {
    it('produces a human label for each kind', () => {
      expect(cmp.kindLabel('strategy')).toBe('Strategy');
      expect(cmp.kindLabel('opt')).toBe('Optimize');
      expect(cmp.kindLabel('bt')).toBe('Backtest');
      expect(cmp.kindLabel('ml')).toBe('ML train');
    });
  });

  describe('paused state', () => {
    it('starts unpaused and toggles', () => {
      expect(cmp.paused()).toBe(false);
      cmp.togglePause();
      expect(cmp.paused()).toBe(true);
      cmp.togglePause();
      expect(cmp.paused()).toBe(false);
    });
  });
});
