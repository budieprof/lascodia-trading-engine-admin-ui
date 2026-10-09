import { DestroyRef, inject } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';

import { ScriptDialogService, confirmDiscard } from './script-dialog.service';

/** A routed page that can hold edits not yet saved (PE-06). */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
  /** What is unsaved, for the question ("The script has unsaved changes"). */
  unsavedChangesNote?(): string;
}

/**
 * `canDeactivate` for pages holding a Pine edit: leaving with unsaved changes asks first. A page
 * whose save is in flight, or that has nothing unsaved, leaves at once.
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component?.hasUnsavedChanges?.()) return true;
  const dialogs = inject(ScriptDialogService);
  return confirmDiscard(
    dialogs,
    component.unsavedChangesNote?.() ?? 'The script has unsaved changes',
  );
};

/**
 * Closing or reloading the browser tab while `dirty()` holds asks the browser's own "Leave site?"
 * question. Call in an injection context; the listener goes with the component.
 */
export function warnBeforeUnload(dirty: () => boolean, destroyRef = inject(DestroyRef)): void {
  if (typeof window === 'undefined') return;
  const handler = (event: BeforeUnloadEvent) => {
    if (!dirty()) return;
    event.preventDefault();
    // Older browsers read returnValue; the text itself is never shown.
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', handler);
  destroyRef.onDestroy(() => window.removeEventListener('beforeunload', handler));
}
