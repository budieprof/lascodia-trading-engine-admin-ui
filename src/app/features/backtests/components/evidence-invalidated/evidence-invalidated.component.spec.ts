import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { EvidenceInvalidatedComponent } from './evidence-invalidated.component';

declareSignalIo(EvidenceInvalidatedComponent, { inputs: ['run', 'mode'] });

function render(run: unknown, mode?: 'badge' | 'notice'): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [EvidenceInvalidatedComponent] });
  const fixture = TestBed.createComponent(EvidenceInvalidatedComponent);
  fixture.componentRef.setInput('run', run);
  if (mode) fixture.componentRef.setInput('mode', mode);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('EvidenceInvalidatedComponent', () => {
  it('renders nothing for a valid run or an engine build without the field', () => {
    expect(render({ id: 1 }).textContent!.trim()).toBe('');
    expect(render(null, 'notice').textContent!.trim()).toBe('');
  });

  it('shows a badge with the reason in its tooltip', () => {
    const el = render({ evidenceInvalidatedReason: 'Money converted at rate 1' });
    const badge = el.querySelector('[data-testid="evidence-invalidated-badge"]')!;
    expect(badge.textContent).toContain('Excluded from evidence');
    expect(badge.getAttribute('title')).toContain('Money converted at rate 1');
  });

  it('shows the full note with the reason and the date', () => {
    const el = render(
      {
        evidenceInvalidatedReason: 'Money converted at rate 1',
        evidenceInvalidatedAtUtc: '2026-11-07T12:30:00Z',
      },
      'notice',
    );
    const notice = el.querySelector('[data-testid="evidence-invalidated-notice"]')!;
    expect(notice.textContent).toContain('Money converted at rate 1');
    expect(notice.textContent).toContain('no longer uses this run for promotion gates');
    expect(notice.textContent).toContain('2026-11-07 12:30 UTC');
  });
});
