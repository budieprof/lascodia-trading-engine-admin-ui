import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { ScreenCaptureService } from './screen-capture.service';

/**
 * The parts worth pinning are the ones that decide whether a frame is sent at all.
 *
 * Capturing pixels needs a real compositor, so the drawing path is not testable here — but
 * "never claims to be sharing when it is not" is, and that is the property that keeps the
 * assistant from being handed a blank or stale frame and describing it confidently.
 */
describe('ScreenCaptureService', () => {
  let svc: ScreenCaptureService;

  beforeEach(() => {
    svc = new ScreenCaptureService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports unsupported when the browser has no getDisplayMedia', () => {
    vi.stubGlobal('navigator', {});
    expect(svc.supported).toBe(false);
  });

  it('does not claim to be sharing before anything is started', () => {
    expect(svc.sharing()).toBe(false);
  });

  it('grabs nothing while not sharing', async () => {
    expect(await svc.grab()).toBeNull();
  });

  it('refuses to start on a browser that cannot share, with a reason', async () => {
    vi.stubGlobal('navigator', {});
    expect(await svc.start()).toBe(false);
    expect(svc.sharing()).toBe(false);
    expect(svc.error()).toMatch(/cannot share/i);
  });

  it('reports a declined prompt as a decision, not a crash', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      },
    });
    expect(await svc.start()).toBe(false);
    expect(svc.sharing()).toBe(false);
    // Wording matters: this is the operator saying no, and an "error" would read as a bug.
    expect(svc.error()).toBe('Screen sharing was declined.');
  });

  it('surfaces any other failure with its message', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: () => Promise.reject(new Error('no display')) },
    });
    expect(await svc.start()).toBe(false);
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
    expect(await svc.start()).toBe(false);
    // A stream we are not going to use must not be left running behind the browser's
    // sharing indicator.
    expect(stopped).toEqual(['a']);
  });

  it('stop() is safe when nothing was ever started', () => {
    expect(() => svc.stop()).not.toThrow();
    expect(svc.sharing()).toBe(false);
  });
});
