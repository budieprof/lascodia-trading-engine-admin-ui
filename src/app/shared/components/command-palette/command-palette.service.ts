import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/**
 * How anything outside the palette asks it to open.
 *
 * The header used to `inject(CommandPaletteComponent, { optional: true })`, but the palette is the
 * header's SIBLING in the layout, not an ancestor, so element injection never found it: the
 * injection was always null and the header's search box did nothing when clicked (only ⌘K, which
 * the palette listens for itself, worked). A root service reaches the palette wherever it sits.
 */
@Injectable({ providedIn: 'root' })
export class CommandPaletteService {
  private readonly openRequests = new Subject<void>();

  /** Emits each time something asks the palette to open. */
  readonly openRequested$: Observable<void> = this.openRequests.asObservable();

  open(): void {
    this.openRequests.next();
  }
}
