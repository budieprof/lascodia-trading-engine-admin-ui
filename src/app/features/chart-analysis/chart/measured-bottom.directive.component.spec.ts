import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ElementRef } from '@angular/core';

import { MeasuredBottomDirective } from './measured-bottom.directive';

// Run in an injection context with the element it measures (JIT cannot bind a child directive's outputs).

describe('MeasuredBottomDirective (legend size for the chart)', () => {
  const original = globalThis.ResizeObserver;
  afterEach(() => {
    globalThis.ResizeObserver = original;
  });

  it('reports the element’s bottom in its offset parent when it resizes, once per change', () => {
    let fire: () => void = () => undefined;
    const disconnect = vi.fn();
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe(): void {}
      disconnect = disconnect;
    } as unknown as typeof ResizeObserver;
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetTop', { value: 8, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: 54, configurable: true, writable: true });
    TestBed.configureTestingModule({ providers: [{ provide: ElementRef, useValue: new ElementRef(el) }] });
    const d = TestBed.runInInjectionContext(() => new MeasuredBottomDirective());
    const seen: number[] = [];
    d.bottomChange.subscribe((b) => seen.push(b));
    fire();
    fire();
    Object.defineProperty(el, 'offsetHeight', { value: 72 });
    fire();
    expect(seen).toEqual([62, 80]);
    // Its injector going away stops the observing.
    TestBed.resetTestingModule();
    expect(disconnect).toHaveBeenCalled();
  });
});
