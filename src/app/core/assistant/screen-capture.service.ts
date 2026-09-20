import { Injectable, signal } from '@angular/core';

/**
 * Lets the assistant see what the operator sees.
 *
 * <p>Two ways to get pixels, and which one is the default matters more than it looks:</p>
 *
 * <dl>
 *   <dt><b>page</b> (default)</dt>
 *   <dd>Re-renders the live DOM to a canvas in-process. No permission, no picker, no
 *       browser sharing banner, no capture session — the operator turns the eye on and it
 *       is on. This is what a console assistant should cost.</dd>
 *   <dt><b>screen</b></dt>
 *   <dd>`getDisplayMedia`, the real compositor output. Kept for the cases the page render
 *       cannot reach at all: another tab, another application, a native dialog.</dd>
 * </dl>
 *
 * <p>Page mode used to be dismissed here as "lossy". Measured against this app it is not:
 * the chart canvases are copied pixel-for-pixel via `toDataURL`, the web font is embedded,
 * and a warm render of the chart page takes ~490 ms. What it genuinely cannot reproduce is
 * `backdrop-filter` blur and anything outside the document — hence screen mode staying.</p>
 *
 * <p>Page mode is also BETTER framed. The dock is a fixed overlay covering roughly the right
 * third of the chart, including the price axis. Screen mode had to hide it, wait two painted
 * frames and put it back, which the operator sees as a flicker. Here the dock is simply
 * omitted from the clone: nothing on screen moves, and the frame shows what the dock was
 * covering.</p>
 */

/** Longest edge of a captured frame. Bigger buys no detail the model can use. */
const MAX_EDGE = 1600;

/** JPEG quality. 0.72 keeps chart candles legible at roughly a quarter of the bytes of PNG. */
const JPEG_QUALITY = 0.72;

/** Refuse to send anything larger; a frame this big means something went wrong. */
const MAX_BYTES = 4_000_000;

/** Remembered across sessions so the operator does not re-pick screen mode every morning. */
const MODE_KEY = 'lascodia.assistant.visionMode';

/**
 * Wait for two painted frames.
 *
 * <p>One is not enough: `requestAnimationFrame` fires BEFORE paint, so a single wait can
 * still encode the pre-hide composition. Two puts a completed paint between the style change
 * and the capture. Only screen mode needs this — page mode never mutates the document.</p>
 */
function twoFrames(): Promise<void> {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))),
  );
}

export interface CapturedFrame {
  /** Bare base64, no data: prefix — the wire format the engine expects. */
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

/** Where the pixels come from. */
export type VisionMode = 'page' | 'screen';

@Injectable({ providedIn: 'root' })
export class ScreenCaptureService {
  /** True while the assistant is allowed to see anything. */
  readonly enabled = signal(false);
  /** Which source is in use. Page unless the operator asked for the whole screen. */
  readonly mode = signal<VisionMode>(readMode());
  /** True only in screen mode, while a capture track is open. Drives the "live" styling. */
  readonly sharing = signal(false);
  /** Why the last attempt failed, for the operator. Null when fine. */
  readonly error = signal<string | null>(null);

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  /** Page rendering works anywhere there is a DOM, so vision is always available. */
  get supported(): boolean {
    return typeof document !== 'undefined';
  }

  /** Whether the whole-screen path is available in this browser. */
  get screenSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  }

  /**
   * Turn vision on, in `mode` if given.
   *
   * <p>Page mode resolves immediately with nothing asked of the operator. Screen mode still
   * goes through the browser's picker — that prompt is required by the `getDisplayMedia`
   * spec and cannot be waived by the page, which is the whole reason page mode is the
   * default.</p>
   *
   * <p>Idempotent: enabling while already enabled in the same mode is a no-op rather than a
   * second prompt.</p>
   */
  async enable(mode: VisionMode = this.mode()): Promise<boolean> {
    this.error.set(null);
    if (this.enabled() && this.mode() === mode) return true;

    if (mode === 'page') {
      // Leaving a capture track running behind the browser's indicator after the operator
      // switched away from screen mode would be the worst kind of surprise.
      this.releaseStream();
      this.setMode('page');
      this.enabled.set(true);
      return true;
    }

    if (!this.screenSupported) {
      this.error.set('This browser cannot share a screen.');
      return false;
    }
    const ok = await this.startStream();
    if (ok) {
      this.setMode('screen');
      this.enabled.set(true);
    }
    return ok;
  }

  /** Turn vision off and release anything held. */
  disable(): void {
    this.releaseStream();
    this.enabled.set(false);
  }

  /**
   * Grab one frame, or null when vision is off.
   *
   * <p>`hideSelectors` name what must not be in the frame. In page mode they are filtered
   * out of the clone; in screen mode they are hidden on the real page for the duration of
   * the shot. Either way the assistant's own dock stays out of the picture: photographing
   * the panel asking the question is not useful, photographing what it hides is.</p>
   */
  async grab(hideSelectors: readonly string[] = []): Promise<CapturedFrame | null> {
    if (!this.enabled()) return null;
    return this.mode() === 'page' ? this.grabPage(hideSelectors) : this.grabScreen(hideSelectors);
  }

  // ── page mode ────────────────────────────────────────────────────────────

  private async grabPage(hideSelectors: readonly string[]): Promise<CapturedFrame | null> {
    const root = document.documentElement;
    const width = root.clientWidth;
    const height = root.clientHeight;
    if (width === 0 || height === 0) return null;

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    try {
      // Loaded on first use, not at startup: the renderer is ~25 kB that most sessions
      // never turn on, and it has no business in the initial bundle of a trading console.
      const { domToCanvas } = await import('modern-screenshot');
      const canvas = await domToCanvas(root, {
        scale,
        // JPEG has no alpha, so an unset background encodes as black. Take the real page
        // background instead, which is what keeps dark mode looking like dark mode.
        backgroundColor: pageBackground(),
        filter: (node) => !matchesAny(node, hideSelectors),
        // The frame is for a model to read, not for the operator to stare at; skipping the
        // slow paths that only affect appearance keeps a send responsive.
        fetch: { requestInit: { cache: 'force-cache' } },
      });
      return this.encodeCanvas(canvas);
    } catch (err) {
      // A failed render must not take the operator's question down with it — the message is
      // still worth sending without a picture.
      this.error.set(
        `Could not render the page: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // ── screen mode ──────────────────────────────────────────────────────────

  private async startStream(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // `preferCurrentTab` is Chromium-only and simply ignored elsewhere; where it is
        // honoured it spares the operator hunting for the right tab in the picker.
        video: { displaySurface: 'browser' },
        preferCurrentTab: true,
        audio: false,
      } as DisplayMediaStreamOptions);

      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        this.error.set('No video track was shared.');
        return false;
      }

      // The operator can stop sharing from the browser's own indicator at any time. That
      // path does not come back through this service, so listen for it — otherwise the
      // toggle keeps claiming to share a track that has ended.
      track.addEventListener('ended', () => this.disable());

      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      // A track reports 0×0 until the first frame arrives; grabbing immediately yields a
      // blank image.
      await new Promise<void>((resolve) => {
        if (video.videoWidth > 0) return resolve();
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        setTimeout(resolve, 1500);
      });

      this.stream = stream;
      this.video = video;
      this.sharing.set(true);
      return true;
    } catch (err) {
      // A denied prompt is a decision, not a fault — say so plainly rather than as an error.
      const name = err instanceof DOMException ? err.name : '';
      this.error.set(
        name === 'NotAllowedError'
          ? 'Screen sharing was declined.'
          : `Could not start screen sharing: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async grabScreen(hideSelectors: readonly string[]): Promise<CapturedFrame | null> {
    const video = this.video;
    if (!video || video.videoWidth === 0) return null;

    const hidden = this.hide(hideSelectors);
    try {
      // The track runs at ~30fps and the compositor is a frame or two behind the DOM, so
      // grabbing immediately after hiding still catches the panel. Wait for two painted
      // frames plus a margin — without this the whole exercise silently does nothing.
      if (hidden.length > 0) await twoFrames();
      const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return this.encodeCanvas(canvas);
    } finally {
      for (const entry of hidden) entry.restore();
    }
  }

  /** Hide elements for a capture, returning how to put each one back. */
  private hide(selectors: readonly string[]): Array<{ restore: () => void }> {
    const out: Array<{ restore: () => void }> = [];
    for (const selector of selectors) {
      let nodes: NodeListOf<HTMLElement>;
      try {
        nodes = document.querySelectorAll<HTMLElement>(selector);
      } catch {
        continue; // a bad selector must not cost the frame
      }
      for (const node of Array.from(nodes)) {
        const previous = node.style.visibility;
        // `visibility`, not `display`: display:none reflows the page, so the chart would
        // resize for the shot and the operator would see it jump.
        node.style.visibility = 'hidden';
        out.push({
          restore: () => {
            node.style.visibility = previous;
          },
        });
      }
    }
    return out;
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.sharing.set(false);
  }

  private setMode(mode: VisionMode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* a locked-down profile is not a reason to fail the capture */
    }
  }

  private encodeCanvas(canvas: HTMLCanvasElement): CapturedFrame | null {
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    } catch {
      // Tainting cannot happen with a display-media frame, and page mode would have thrown
      // earlier — but a failure here must not take the operator's question down with it.
      return null;
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > MAX_BYTES) {
      this.error.set('The captured frame was too large to send.');
      return null;
    }
    return {
      base64,
      mediaType: 'image/jpeg',
      width: canvas.width,
      height: canvas.height,
      bytes,
    };
  }
}

/** True when `node` is an element matching any of `selectors`. */
function matchesAny(node: Node, selectors: readonly string[]): boolean {
  if (selectors.length === 0 || !(node instanceof Element)) return false;
  for (const selector of selectors) {
    try {
      if (node.matches(selector)) return true;
    } catch {
      continue; // a bad selector must not cost the frame
    }
  }
  return false;
}

/** The page's own background colour, so a JPEG of dark mode is not a JPEG of black. */
function pageBackground(): string {
  try {
    const body = getComputedStyle(document.body).backgroundColor;
    if (body && body !== 'transparent' && !body.startsWith('rgba(0, 0, 0, 0')) return body;
    const root = getComputedStyle(document.documentElement).backgroundColor;
    if (root && root !== 'transparent' && !root.startsWith('rgba(0, 0, 0, 0')) return root;
  } catch {
    /* fall through */
  }
  return '#ffffff';
}

function readMode(): VisionMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'screen' ? 'screen' : 'page';
  } catch {
    return 'page';
  }
}
