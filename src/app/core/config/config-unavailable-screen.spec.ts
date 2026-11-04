// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderConfigUnavailableScreen } from './config-unavailable-screen';

describe('renderConfigUnavailableScreen', () => {
  it('replaces the app with an explanation and no sign-in form', () => {
    document.body.innerHTML = '<app-root><p>old</p></app-root>';
    renderConfigUnavailableScreen(document, () => {}, 0);
    const root = document.querySelector('app-root')!;
    expect(root.textContent).toContain('The console could not load');
    expect(root.querySelector('input, form')).toBeNull();
    expect(root.textContent).not.toContain('old');
  });

  it('reloads on the button and by itself after the pause', () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<app-root></app-root>';
      const reload = vi.fn();
      renderConfigUnavailableScreen(document, reload, 20_000);
      document.querySelector('button')!.click();
      expect(reload).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(20_000);
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
