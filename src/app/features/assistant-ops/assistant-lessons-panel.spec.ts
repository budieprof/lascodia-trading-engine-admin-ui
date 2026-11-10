import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';

import { AssistantOpsApiService } from './assistant-ops-api.service';
import { lessonActions } from './assistant-ops.logic';
import type { AssistantLesson } from './assistant-ops.types';
import { AssistantLessonsPanelComponent } from './components/assistant-lessons-panel.component';

ensureTestBed();

const candidate: AssistantLesson = {
  id: 7,
  status: 'Candidate',
  source: 'card_rejection',
  scopeKind: 'global',
  scopeValue: null,
  text: 'Never arm an OCO whose legs are market orders.',
  evidence: null,
  sourceConversationIds: [45861],
  sourceTurnId: null,
  sourceRef: null,
  createdBy: null,
  reviewedBy: null,
  reviewNote: null,
  createdAtUtc: '2026-11-10T08:00:00Z',
  reviewedAtUtc: null,
  injectedCount: 0,
  lastInjectedAtUtc: null,
};

let api: {
  lessons: ReturnType<typeof vi.fn>;
  review: ReturnType<typeof vi.fn>;
};
let notify: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = {
    lessons: vi.fn(() => of([candidate])),
    review: vi.fn((id: number, action: string) =>
      of({ ...candidate, status: action === 'approve' ? 'Approved' : 'Rejected' }),
    ),
  };
  notify = { success: vi.fn(), error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: AssistantOpsApiService, useValue: api },
      { provide: NotificationService, useValue: notify },
    ],
  });
});

afterEach(() => TestBed.resetTestingModule());

const panel = () => TestBed.runInInjectionContext(() => new AssistantLessonsPanelComponent());
const action = (kind: string) => lessonActions('Candidate').find((a) => a.kind === kind)!;

describe('AssistantLessonsPanelComponent', () => {
  it('opens on the review queue', () => {
    const p = panel();
    expect(api.lessons).toHaveBeenCalledWith('Candidate', null, 200);
    expect(p.lessons()).toEqual([candidate]);
    expect(p.loading()).toBe(false);
  });

  it('"All" asks for every status, and a source filter is passed through', () => {
    const p = panel();
    p.setStatus('');
    expect(api.lessons).toHaveBeenLastCalledWith(null, null, 200);
    p.setSource('correction');
    expect(api.lessons).toHaveBeenLastCalledWith(null, 'correction', 200);
  });

  it('reject will not send without a reason, then sends only the reason and reloads', () => {
    const p = panel();
    p.open(candidate, action('reject'));
    p.submit();
    expect(api.review).not.toHaveBeenCalled();
    expect(p.shownProblem()).toMatch(/why/i);

    p.patch({ note: 'Market legs are allowed for this broker' });
    p.submit();
    expect(api.review).toHaveBeenCalledWith(7, 'reject', {
      note: 'Market legs are allowed for this broker',
    });
    expect(p.review()).toBeNull();
    expect(notify.success).toHaveBeenCalledWith('Lesson #7 rejected.');
    expect(api.lessons).toHaveBeenCalledTimes(2);
  });

  it('approve with an edited text sends the edit', () => {
    const p = panel();
    p.open(candidate, action('approve'));
    p.patch({ text: 'Never arm an OCO with market-order legs.' });
    p.submit();
    expect(api.review).toHaveBeenCalledWith(7, 'approve', {
      text: 'Never arm an OCO with market-order legs.',
    });
    expect(notify.success.mock.calls[0][0]).toMatch(/approved/);
  });

  it('an engine refusal stays in the dialog, with the engine’s words', () => {
    api.review.mockReturnValueOnce(
      throwError(
        () =>
          new ApiError(
            '-16',
            'Only a candidate can be rejected (lesson #7 is Approved); retire an approved one.',
            {
              status: false,
              data: null,
              message: null,
              responseCode: '-16',
            },
          ),
      ),
    );
    const p = panel();
    p.open(candidate, action('reject'));
    p.patch({ note: 'stale' });
    p.submit();
    expect(p.review()).not.toBeNull();
    expect(p.busy()).toBe(false);
    expect(p.shownProblem()).toContain('Only a candidate can be rejected');
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('a failed load shows an error, not an empty queue', () => {
    api.lessons.mockReturnValueOnce(throwError(() => new Error('boom')));
    const p = panel();
    expect(p.loadError()).toBe('boom');
    expect(p.loading()).toBe(false);
  });
});
