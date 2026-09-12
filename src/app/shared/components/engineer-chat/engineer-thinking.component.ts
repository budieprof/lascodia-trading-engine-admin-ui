import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import { EngineerTurnComponent } from './engineer-turn.component';
import {
  latestThoughtLine,
  thinkingBlockSummary,
  thinkingDefaultOpen,
  thinkingSummaryLabel,
  type ThinkingItem,
} from './engineer-turns';

/**
 * The agent thinking out loud — one block per stretch of narration.
 *
 * This is the operator's window into a run that takes minutes: the host service patches a
 * `thought` turn every ~1s as tokens arrive, so the text below GROWS in place and reads like
 * typing. It is deliberately secondary to everything else in the thread — muted, italic, one step
 * down in size — because it is the agent's reasoning, not its answer. The answer arrives as the
 * same turn patched to `{"final":true}`, which the thread then renders as a normal message.
 *
 * Three states:
 *   · live + newest  → open, pulsing, showing the narration as it is written
 *   · live + newest, but the operator collapsed it → one-line preview of the newest passage
 *   · anything older → collapsed to "12 thoughts · 3 tool calls", one click from being read
 *
 * Tool calls made mid-narration render inside the block, in order, through the same
 * `<app-engineer-turn>` strip they use everywhere else — folding them in is what keeps one train
 * of thought from being cut into several "Thinking" headers.
 *
 * A child component rather than more markup in the chat so its styles live in their own budget.
 */
@Component({
  selector: 'app-engineer-thinking',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EngineerTurnComponent],
  template: `
    @let it = item();
    @let streaming = isStreaming();
    <div class="think" [class.live]="streaming" [attr.data-open]="open()">
      <button
        type="button"
        class="head"
        [attr.aria-expanded]="open()"
        [title]="open() ? 'Hide the agent’s thinking' : 'Show the agent’s thinking'"
        (click)="toggle()"
      >
        <span class="caret" aria-hidden="true"></span>
        @if (streaming) {
          <span class="dot" aria-hidden="true"></span>
        }
        <span class="label">{{ headline() }}</span>
        @if (streaming) {
          <span class="count">{{ summary() }}</span>
        }
      </button>

      @if (open()) {
        <div class="entries">
          @for (e of it.entries; track e.key) {
            @if (e.type === 'thought') {
              <p class="thought">{{ e.turn.content }}</p>
            } @else {
              <app-engineer-turn [item]="e" />
            }
          }
          @if (streaming) {
            <span class="caretbar" aria-hidden="true"></span>
          }
        </div>
      } @else if (streaming && preview()) {
        <p class="preview">{{ preview() }}</p>
      } @else if (digest()) {
        <!-- A closed block still says what happened in it: which tools ran, what failed, where it
             landed. Derived from the block's own turns — see thinkingBlockSummary. -->
        <p class="digest" [title]="digest()">{{ digest() }}</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        flex: 1;
        min-width: 0;
      }
      .think {
        max-width: 96%;
        border-left: 2px solid var(--border);
        padding: 1px 0 1px 10px;
      }
      .think.live {
        border-left-color: color-mix(in srgb, var(--accent) 55%, var(--border));
      }
      .head {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        padding: 2px 0;
        border: none;
        background: none;
        font: inherit;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-align: left;
        cursor: pointer;
      }
      .head:hover {
        color: var(--text-secondary);
      }
      .caret {
        flex: none;
        width: 0;
        height: 0;
        border-left: 4px solid currentColor;
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
        transition: transform var(--dur-fast, 0.15s);
      }
      .think[data-open='true'] .caret {
        transform: rotate(90deg);
      }
      .dot {
        flex: none;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--accent);
        animation: think-pulse 1.4s ease-in-out infinite;
      }
      @keyframes think-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.3;
        }
      }
      .label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .think.live .label {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .count {
        margin-left: auto;
        flex: none;
        font-size: 10px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .entries {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 3px 0 4px;
      }
      /* The narration itself: prose the agent wrote, not a bubble. Pre-wrap keeps its own line
         breaks without a markdown pass — a passage that is still streaming is frequently
         half-written (an unclosed fence, a dangling list marker) and would reflow on every patch
         if it were parsed. */
      .thought,
      .preview {
        margin: 0;
        font-size: var(--text-xs);
        line-height: 1.55;
        font-style: italic;
        color: var(--text-secondary);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      /* The closed block's one-line account of itself. Not italic: it is a fact about the block,
         not the agent's prose. */
      .digest {
        margin: 0 0 3px;
        font-size: 10px;
        line-height: 1.5;
        color: var(--text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .preview {
        padding-bottom: 3px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      /* Typing caret, parked after the newest passage. */
      .caretbar {
        width: 6px;
        height: 12px;
        margin-top: -4px;
        background: var(--accent);
        opacity: 0.7;
        animation: think-blink 1.1s step-end infinite;
      }
      @keyframes think-blink {
        50% {
          opacity: 0;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .dot,
        .caretbar {
          animation: none;
        }
        .caret {
          transition: none;
        }
      }
    `,
  ],
})
export class EngineerThinkingComponent {
  readonly item = input.required<ThinkingItem>();
  /** True when the run holding this conversation is alive (Working / WaitingForOperator / Watching). */
  readonly live = input<boolean>(false);
  /** True for the newest thinking block in the thread — the only one that can be the live one. */
  readonly latest = input<boolean>(false);
  /** The run bar's presence line ("Thinking…", "Running pnl_sim…"), shown as the live headline. */
  readonly presence = input<string>('Thinking…');

  /** Open state. Follows the default until the operator takes it over. */
  protected readonly open = signal(false);
  private touched = false;

  /** The one block being written into right now — the only one that pulses. */
  protected readonly isStreaming = computed(() => this.live() && this.latest());

  protected readonly summary = computed(() => {
    const it = this.item();
    return thinkingSummaryLabel(it.thoughtCount, it.toolCount, it.failed);
  });

  protected readonly headline = computed(() =>
    this.isStreaming() ? this.presence() : this.summary(),
  );

  protected readonly preview = computed(() => latestThoughtLine(this.item()));

  /** What happened inside the block — shown while it is closed, so folding loses nothing. */
  protected readonly digest = computed(() => thinkingBlockSummary(this.item()));

  constructor() {
    effect(() => {
      const wanted = thinkingDefaultOpen(this.latest(), this.live());
      if (!this.touched) this.open.set(wanted);
    });
  }

  protected toggle(): void {
    // Once the operator has an opinion, the run ending (or another block becoming the newest)
    // no longer overrides it — a block they opened to read stays open.
    this.touched = true;
    this.open.update((v) => !v);
  }
}
