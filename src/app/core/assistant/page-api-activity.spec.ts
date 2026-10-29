import { describe, expect, it, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { HttpHeaders, HttpParams, HttpRequest } from '@angular/common/http';
import { NavigationEnd, Router, type Event } from '@angular/router';
import { Subject } from 'rxjs';

import { PageApiActivity, engineCall } from './page-api-activity';

const BASE = 'http://localhost:8080/api/v1/lascodia-trading-engine';

function get(path: string, params?: Record<string, string>): HttpRequest<unknown> {
  return new HttpRequest('GET', BASE + path, {
    params: new HttpParams({ fromObject: params ?? {} }),
  });
}
function post(path: string, body: unknown): HttpRequest<unknown> {
  return new HttpRequest('POST', BASE + path, body, { headers: new HttpHeaders() });
}

describe('engineCall', () => {
  it('splits an engine URL into path and query', () => {
    expect(engineCall(`${BASE}/strategy/12/footprint?days=30&tf=H1`)).toEqual({
      path: '/strategy/12/footprint',
      query: { days: '30', tf: 'H1' },
    });
  });
  it('ignores anything that is not the engine API', () => {
    expect(engineCall('http://localhost:8080/assets/i18n/en.json')).toBeNull();
  });
});

describe('PageApiActivity', () => {
  let activity: PageApiActivity;
  let events: Subject<Event>;
  let navigate: (url: string) => void;

  beforeEach(() => {
    events = new Subject<Event>();
    const router = { url: '/a', events };
    const injector = Injector.create({
      providers: [
        { provide: Router, useValue: router },
        { provide: PageApiActivity, useClass: PageApiActivity },
      ],
    });
    activity = runInInjectionContext(injector, () => injector.get(PageApiActivity));
    let id = 0;
    navigate = (url) => {
      router.url = url;
      events.next(new NavigationEnd(++id, url, url));
    };
  });

  it('records each engine call once, counting repeats', () => {
    activity.record(get('/position/open', { accountIds: '23' }), 200);
    activity.record(get('/position/open', { accountIds: '23' }), 200);
    const [only] = activity.list();
    expect(activity.list()).toHaveLength(1);
    expect(only).toMatchObject({ method: 'GET', path: '/position/open', calls: 2, status: 200 });
    expect(only.query).toEqual({ accountIds: '23' });
  });

  it('keeps the filter body of a paged list but never the body of a write', () => {
    activity.record(post('/strategy/list', { currentPage: 1, filter: { status: 'Active' } }), 200);
    activity.record(post('/strategy/12/pause', { reason: 'operator typed this' }), 200);
    const byPath = Object.fromEntries(activity.list().map((s) => [s.path, s]));
    expect(byPath['/strategy/list'].body).toContain('Active');
    expect(byPath['/strategy/12/pause'].body).toBeUndefined();
  });

  it('never records credential surfaces, not even their path', () => {
    activity.record(post('/trading-account/5/password', { password: 'hunter2' }), 200);
    activity.record(post('/admin/auth/login', { password: 'hunter2' }), 200);
    activity.record(get('/machine/token'), 200);
    expect(activity.list()).toEqual([]);
  });

  it("ignores the assistant dock's own traffic", () => {
    activity.record(post('/market-data/assistant/session', {}), 200);
    activity.record(post('/market-data/analyze/9/follow-up', { question: 'x' }), 200);
    expect(activity.list()).toEqual([]);
  });

  it('starts empty on a new page but keeps calls across a filter change', () => {
    navigate('/a');
    activity.record(get('/alert/list'), 200);
    navigate('/a?status=open');
    expect(activity.list()).toHaveLength(1);
    navigate('/b');
    expect(activity.list()).toEqual([]);
  });
});
