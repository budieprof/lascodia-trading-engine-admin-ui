import { describe, expect, it } from 'vitest';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { GlobalSearchService } from '@core/search/global-search.service';

import { CommandPaletteComponent } from './command-palette.component';
import { CommandPaletteService } from './command-palette.service';

/**
 * The layout renders the header and the palette as SIBLINGS. The header's search box once
 * injected the palette component directly, which only resolves for an ancestor, so it was always
 * null and a click did nothing. This host mirrors that layout: a sibling button, not a parent.
 */
@Component({
  selector: 'app-palette-host',
  imports: [CommandPaletteComponent],
  template: `
    <button type="button" class="sibling-search" (click)="palette.open()">Search…</button>
    <app-command-palette />
  `,
})
class PaletteHostComponent {
  readonly palette = inject(CommandPaletteService);
}

describe('CommandPaletteComponent', () => {
  function render() {
    TestBed.configureTestingModule({
      imports: [PaletteHostComponent],
      providers: [
        provideRouter([]),
        { provide: GlobalSearchService, useValue: { search: () => of([]) } },
      ],
    });
    const fixture = TestBed.createComponent(PaletteHostComponent);
    fixture.detectChanges();
    const palette = fixture.debugElement.children
      .map((c) => c.componentInstance)
      .find((c): c is CommandPaletteComponent => c instanceof CommandPaletteComponent)!;
    return { fixture, palette, el: fixture.nativeElement as HTMLElement };
  }

  it('opens when a sibling (the header search box) asks through the service', () => {
    const { fixture, palette, el } = render();
    expect(palette.open()).toBe(false);

    el.querySelector<HTMLButtonElement>('.sibling-search')!.click();
    fixture.detectChanges();

    expect(palette.open()).toBe(true);
    expect(el.querySelector('app-command-palette input')).not.toBeNull();
  });

  it('opens fresh each time it is asked, clearing the last query', () => {
    const { fixture, palette, el } = render();
    el.querySelector<HTMLButtonElement>('.sibling-search')!.click();
    palette.onQuery('eurusd');
    palette.close();

    el.querySelector<HTMLButtonElement>('.sibling-search')!.click();
    fixture.detectChanges();

    expect(palette.open()).toBe(true);
    expect(palette.query()).toBe('');
  });
});
