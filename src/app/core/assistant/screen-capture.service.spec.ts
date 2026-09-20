import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { ScreenCaptureService } from './screen-capture.service';

/**
 * The parts worth pinning are the ones that decide whether a frame is sent at all, and which
 * source it comes from.
 *
 * Rendering pixels needs a real layout engine, so the drawing path is not testable here — but
 * "never claims to see when it cannot" is, and so is "page mode never reaches for
 * getDisplayMedia", which is the property the operator actually asked for: no prompt, no
 * sharing bar.
 */
describe('ScreenCaptureService', () => {
  let svc: ScreenCaptureService;

  beforeEach(() => {
    localStorage.clear();
    svc = new ScreenCaptureService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('defaults to page mode, which needs no browser permission', () => {
    expect(svc.mode()).toBe('page');
    expect(svc.enabled()).toBe(false);
  });

  it('enables page vision without touching getDisplayMedia', async () => {
    const getDisplayMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });

    expect(await svc.enable()).toBe(true);
    expect(svc.enabled()).toBe(true);
    // The whole point: no picker, so no prompt and no sharing banner.
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(svc.sharing()).toBe(false);
  });

  it('is supported wherever there is a document, even with no screen-capture API', () => {
    vi.stubGlobal('navigator', {});
    expect(svc.supported).toBe(true);
    expect(svc.screenSupported).toBe(false);
  });

  it('does not claim to see anything before it is enabled', () => {
    expect(svc.enabled()).toBe(false);
  });

  it('grabs nothing while disabled', async () => {
    expect(await svc.grab()).toBeNull();
  });

  it('remembers screen mode across instances, so it is not re-picked every morning', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () =>
          Promise.resolve({
            getVideoTracks: () => [{ addEventListener: () => {} }],
            getTracks: () => [{ stop: () => {} }],
          }),
      },
    });
    // jsdom has no media pipeline, so play() is the failure point, not the decision we care
    // about; assert on what was persisted rather than on the stream coming up.
    await svc.enable('screen').catch(() => undefined);
    expect(localStorage.getItem('lascodia.assistant.visionMode')).toBe('screen');
    expect(new ScreenCaptureService().mode()).toBe('screen');
  });

  it('refuses screen mode on a browser that cannot share, with a reason', async () => {
    vi.stubGlobal('navigator', {});
    expect(await svc.enable('screen')).toBe(false);
    expect(svc.enabled()).toBe(false);
    expect(svc.error()).toMatch(/cannot share/i);
  });

  it('reports a declined prompt as a decision, not a crash', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      },
    });
    expect(await svc.enable('screen')).toBe(false);
    expect(svc.sharing()).toBe(false);
    // Wording matters: this is the operator saying no, and an "error" would read as a bug.
    expect(svc.error()).toBe('Screen sharing was declined.');
  });

  it('surfaces any other failure with its message', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: () => Promise.reject(new Error('no display')) },
    });
    expect(await svc.enable('screen')).toBe(false);
    expect(svc.error()).toMatch(/no display/);
  });

  it('refuses a stream that carries no video track, and releases it', async () => {
    const stopped: string[] = [];
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () =>
          Promise.resolve({
            getVideoTracks: () => [],
            getTracks: () => [{ stop: () => stopped.push('a') }],
          }),
      },
    });
    expect(await svc.enable('screen')).toBe(false);
    // A stream we are not going to use must not be left running behind the browser's
    // sharing indicator.
    expect(stopped).toEqual(['a']);
  });

  it('switching back to page mode releases the capture track', async () => {
    const stopped: string[] = [];
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () =>
          Promise.resolve({
            getVideoTracks: () => [{ addEventListener: () => {} }],
            getTracks: () => [{ stop: () => stopped.push('track') }],
          }),
      },
    });
    await svc.enable('screen').catch(() => undefined);
    await svc.enable('page');
    expect(svc.mode()).toBe('page');
    // Leaving the track live behind the browser's indicator after the operator switched
    // away is the surprise worth preventing.
    expect(stopped).toEqual(['track']);
    expect(svc.sharing()).toBe(false);
  });

  it('disable() is safe when nothing was ever enabled', () => {
    expect(() => svc.disable()).not.toThrow();
    expect(svc.enabled()).toBe(false);
  });
});
