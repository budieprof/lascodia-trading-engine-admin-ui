import { Injectable, signal } from '@angular/core';

/**
 * Lets the assistant see what the operator sees.
 *
 * <p>Uses `getDisplayMedia`, which reads the real compositor output — so the frame is
 * exactly what is on screen, including canvas charts, CSS filters and anything a
 * DOM-rendering library would approximate. A re-render would have been friction-free but
 * lossy, and an assistant that confidently reports layout which is not really there is worse
 * than one that cannot see at all.</p>
 *
 * <p>The cost of honest pixels is a permission prompt, and that cost is paid ONCE per
 * sharing session rather than per question: the track is held open and frames are grabbed
 * from it. The browser shows its own sharing indicator the whole time, so there is no state
 * in which this captures without the operator knowing.</p>
 */

/** Longest edge of a captured frame. Bigger buys no detail the model can use. */
const MAX_EDGE = 1600;

/** JPEG quality. 0.72 keeps chart candles legible at roughly a quarter of the bytes of PNG. */
const JPEG_QUALITY = 0.72;

/** Refuse to send anything larger; a frame this big means something went wrong. */
const MAX_BYTES = 4_000_000;

/**
 * Wait for two painted frames.
 *
 * <p>One is not enough: `requestAnimationFrame` fires BEFORE paint, so a single wait can
 * still encode the pre-hide composition. Two puts a completed paint between the style change
 * and the capture.</p>
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

@Injectable({ providedIn: 'root' })
export class ScreenCaptureService {
  /** True while a sharing session is open and frames can be grabbed. */
  readonly sharing = signal(false);
  /** Why the last attempt failed, for the operator. Null when fine. */
  readonly error = signal<string | null>(null);

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  /** Whether this browser can do it at all. */
  get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  }

  /**
   * Ask the operator to share a surface. Resolves true once frames can be grabbed.
   *
   * <p>Idempotent: calling it while already sharing is a no-op rather than a second prompt.</p>
   */
  async start(): Promise<boolean> {
    if (this.sharing()) return true;
    this.error.set(null);
    if (!this.supported) {
      this.error.set('This browser cannot share a screen.');
      return false;
    }
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
      track.addEventListener('ended', () => this.stop());

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

  /** End the sharing session and release the track. */
  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.sharing.set(false);
  }

  /**
   * Grab one frame, or null when nothing is being shared.
   *
   * <p>Downscaled to {@link MAX_EDGE} and JPEG-encoded. The scale is applied on the longest
   * edge so an ultrawide monitor does not arrive as an unreadable strip.</p>
   *
   * <p>`hideSelectors` are hidden for the duration of the capture. The assistant's own dock
   * is docked right and covers roughly a third of the page — on a chart that is the price
   * axis and the newest bars, which is the part worth looking at. Photographing the panel
   * asking the question is not useful; photographing what it hides is.</p>
   */
  async grab(hideSelectors: readonly string[] = []): Promise<CapturedFrame | null> {
    const video = this.video;
    if (!this.sharing() || !video || video.videoWidth === 0) return null;

    const hidden = this.hide(hideSelectors);
    try {
      // The track runs at ~30fps and the compositor is a frame or two behind the DOM, so
      // grabbing immediately after hiding still catches the panel. Wait for two painted
      // frames plus a margin — without this the whole exercise silently does nothing.
      if (hidden.length > 0) await twoFrames();
      return this.encode(video);
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

  private encode(video: HTMLVideoElement): CapturedFrame | null {
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);

    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    } catch {
      // A tainted canvas cannot happen with a display-media frame, but a failure here must
      // not take the operator's question down with it.
      return null;
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > MAX_BYTES) {
      this.error.set('The captured frame was too large to send.');
      return null;
    }
    return { base64, mediaType: 'image/jpeg', width, height, bytes };
  }
}
