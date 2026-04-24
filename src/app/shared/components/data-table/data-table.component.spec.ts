import { describe, it } from 'vitest';

// The DataTable is our most input-heavy component (required fetch callback,
// column defs, optional bulk-actions template, row-click output). Every
// scenario worth covering needs input variation, which NG0950s under Angular
// 19.2 JIT. Leaving the suite entirely under `describe.skip` so the intent is
// visible in coverage reports but CI stays green. See
// `card-skeleton.component.spec.ts` for the full blocker writeup.

describe.skip('DataTableComponent (blocked by Angular 19.2 JIT + signal inputs)', () => {
  it('renders the provided column headers', () => {
    /* after Angular 20 upgrade */
  });
  it('calls the fetchData callback on load', () => {
    /* after Angular 20 upgrade */
  });
  it('emits rowClick when a row is clicked', () => {
    /* after Angular 20 upgrade */
  });
  it('shows the bulk-actions toolbar when rows are selected', () => {
    /* after Angular 20 upgrade */
  });
  it('persists state to sessionStorage under stateKey', () => {
    /* after Angular 20 upgrade */
  });
  it('restores persisted pagination and search on mount', () => {
    /* after Angular 20 upgrade */
  });
  it('re-fetches when the pager emits a change', () => {
    /* after Angular 20 upgrade */
  });
});

it.todo('DataTable tests ship once the Angular 20 upgrade unblocks Analog vite-plugin-angular');
