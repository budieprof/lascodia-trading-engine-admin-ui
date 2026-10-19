import { describe, it, expect, afterEach } from 'vitest';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { ModalA11yDirective } from './modal-a11y.directive';

// Named *.component.spec.ts so it runs under the TestBed config. JIT cannot drive signal
// inputs/outputs through a host template here (see card-skeleton.component.spec.ts): the input
// stays at its default and the spec subscribes to `dismiss` on the directive instance.
@Component({
  standalone: true,
  imports: [ModalA11yDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button id="trigger" type="button">open</button>
    @if (open()) {
      <div id="dlg" role="dialog" appModalA11y>
        <button id="first" type="button">first</button>
        <button id="safe" type="button" data-autofocus>cancel</button>
        <button id="last" type="button">confirm</button>
      </div>
    }
    @if (inner()) {
      <div id="inner" role="dialog" appModalA11y>
        <button id="inner-btn" type="button">ok</button>
      </div>
    }
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly inner = signal(false);
  dismissed = 0;
  innerDismissed = 0;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Wire the directive on `#id` the way `(dismiss)="…"` would: count, and close it. */
function wire(fixture: ComponentFixture<HostComponent>, id: 'dlg' | 'inner'): void {
  const de = fixture.debugElement.query(By.css(`#${id}`));
  const dir = de.injector.get(ModalA11yDirective);
  const host = fixture.componentInstance;
  dir.dismiss.subscribe(() => {
    if (id === 'dlg') {
      host.dismissed++;
      host.open.set(false);
    } else {
      host.innerDismissed++;
      host.inner.set(false);
    }
  });
}
const press = (target: EventTarget, key: string, shiftKey = false) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  );

describe('ModalA11yDirective', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function openDialog() {
    const fixture = TestBed.configureTestingModule({ imports: [HostComponent] }).createComponent(
      HostComponent,
    );
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('#trigger') as HTMLButtonElement).focus();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    wire(fixture, 'dlg');
    await tick();
    return { fixture, el };
  }

  it('moves focus to the [data-autofocus] element when it opens', async () => {
    const { el } = await openDialog();
    expect(document.activeElement).toBe(el.querySelector('#safe'));
  });

  it('dismisses on Escape even when focus is outside the dialog, exactly once', async () => {
    const { fixture, el } = await openDialog();
    (el.querySelector('#trigger') as HTMLButtonElement).focus();
    press(document.body, 'Escape');
    expect(fixture.componentInstance.dismissed).toBe(1);
  });

  it('dismisses once when Escape is pressed inside (host + document listeners)', async () => {
    const { fixture, el } = await openDialog();
    press(el.querySelector('#safe')!, 'Escape');
    expect(fixture.componentInstance.dismissed).toBe(1);
  });

  it('returns focus to the trigger when it closes', async () => {
    const { fixture, el } = await openDialog();
    press(el.querySelector('#safe')!, 'Escape');
    fixture.detectChanges();
    expect(el.querySelector('#dlg')).toBeNull();
    expect(document.activeElement).toBe(el.querySelector('#trigger'));
  });

  it('only the topmost dialog answers Escape', async () => {
    const { fixture, el } = await openDialog();
    fixture.componentInstance.inner.set(true);
    fixture.detectChanges();
    wire(fixture, 'inner');
    await tick();
    press(el.querySelector('#inner-btn')!, 'Escape');
    fixture.detectChanges();
    expect(el.querySelector('#inner')).toBeNull();
    expect(fixture.componentInstance.innerDismissed).toBe(1);
    expect(fixture.componentInstance.dismissed).toBe(0);
    expect(el.querySelector('#dlg')).not.toBeNull();
  });
});
