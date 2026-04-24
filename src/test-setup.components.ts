// Component-test setup — wires Angular's TestBed against the jsdom environment
// so `*.component.spec.ts` files can render templates. The JIT compiler import
// must come first because @angular/core/testing resolves partial-compiled
// factories at TestBed.initTestEnvironment time.

import '@angular/compiler';
import 'zone.js';
import 'zone.js/testing';

import { getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';

// Initialise once per test worker. Subsequent specs reuse the same testing
// environment — TestBed.resetTestingModule() between tests keeps their state
// isolated.
getTestBed().initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
  teardown: { destroyAfterEach: true },
});
