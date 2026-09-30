// Component-test setup — wires Angular's TestBed against the jsdom environment
// so `*.component.spec.ts` files can render templates. The JIT compiler import
// must come first because @angular/core/testing resolves partial-compiled
// factories at TestBed.initTestEnvironment time.

import '@angular/compiler';
import 'zone.js';
import 'zone.js/testing';

import { NgModule, provideZoneChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';

// Since Angular 21 TestBed is zoneless unless a zone provider is supplied. The
// app bootstraps with provideZoneChangeDetection(), so the tests keep ZoneJS
// change detection too. This is what the v21 `bootstrap-options-migration`
// emits for initTestEnvironment; it never saw this file because angular.json
// has no test target, so it is applied here by hand.
@NgModule({ providers: [provideZoneChangeDetection()] })
export class ZoneChangeDetectionModule {}

// Initialise once per test worker. Subsequent specs reuse the same testing
// environment — TestBed.resetTestingModule() between tests keeps their state
// isolated.
getTestBed().initTestEnvironment(
  [ZoneChangeDetectionModule, BrowserDynamicTestingModule],
  platformBrowserDynamicTesting(),
  {
    teardown: { destroyAfterEach: true },
  },
);
