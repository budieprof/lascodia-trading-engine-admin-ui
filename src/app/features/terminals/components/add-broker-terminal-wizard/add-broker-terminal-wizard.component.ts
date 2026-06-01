import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TerminalsService } from '@core/services/terminals.service';
import type { DaemonCloneMt5Response, DaemonInstallDto } from '@core/api/api.types';

/**
 * 3-stage wizard for "add a broker terminal" via the admin UI.
 *
 * Stage 1 — slug entry → clone-mt5 (daemon copies the bundle).
 * Stage 2 — operator does the manual MT5 first-launch + broker login
 *           on the host (interactive broker credentials; not automatable).
 * Stage 3 — register-install (daemon writes supervisor.yaml + reloads).
 *
 * The wizard owns no global state.  Inputs: daemon id + a flag that
 * opens/closes the modal.  Outputs: a single `closed` event whose
 * payload is the registered install (or null on cancel) so the parent
 * can refresh its daemon list.
 *
 * UI uses the native <dialog> element with `showModal()` for the
 * top-layer overlay — same pattern as ea-trade-chart-modal.
 */
@Component({
  selector: 'app-add-broker-terminal-wizard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <dialog #dlg class="wizard">
      <header class="head">
        <h3>Add broker terminal</h3>
        <button type="button" class="icon-btn" (click)="cancel()">×</button>
      </header>

      <ol class="steps">
        <li
          [attr.data-active]="stage() === 1"
          [attr.data-done]="stage() > 1"
          [attr.data-reachable]="canJumpTo(1)"
          (click)="jumpTo(1)"
        >
          1 · Clone bundle
        </li>
        <li
          [attr.data-active]="stage() === 2"
          [attr.data-done]="stage() > 2"
          [attr.data-reachable]="canJumpTo(2)"
          (click)="jumpTo(2)"
        >
          2 · Manual MT5 setup
        </li>
        <li
          [attr.data-active]="stage() === 3"
          [attr.data-reachable]="canJumpTo(3)"
          (click)="jumpTo(3)"
        >
          3 · Register install
        </li>
      </ol>

      @if (stage() === 1) {
        <section class="stage">
          <p class="lead">
            Clones <code>/Applications/MetaTrader 5.app</code> on <strong>{{ daemonName() }}</strong
            >'s host with a unique CFBundleIdentifier so macOS provisions an isolated Wine prefix.
            Takes ~10–30 s for the cp + codesign.
          </p>
          <label class="field">
            <span class="label">Broker slug</span>
            <input
              type="text"
              [(ngModel)]="brokerSlug"
              placeholder="icmarkets, oanda-live, fxcm, …"
              [disabled]="busy()"
              autofocus
            />
            <span class="hint small muted">
              Lower-cased + hyphenated. Used in the bundle name ("MetaTrader 5 - &lt;slug&gt;.app"),
              the Wine prefix directory, and as the default install_id.
            </span>
          </label>

          @if (cloneErr()) {
            <p class="err">{{ cloneErr() }}</p>
          }

          <div class="actions">
            <button type="button" class="btn btn-secondary" (click)="cancel()" [disabled]="busy()">
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary"
              (click)="doClone()"
              [disabled]="!brokerSlug.trim() || busy()"
            >
              @if (busy()) {
                Cloning…
              } @else {
                Clone bundle
              }
            </button>
          </div>
        </section>
      }

      @if (stage() === 2) {
        <section class="stage">
          <p class="lead">
            Bundle cloned to <code class="mono small">{{ cloneResult()?.bundlePath }}</code
            >. Now do these on the daemon's host — these steps need a human because broker
            credentials are interactive:
          </p>
          <ol class="manual-steps">
            @for (step of manualSteps(); track $index) {
              <li class="mono small">{{ step }}</li>
            }
          </ol>
          <p class="hint small muted">
            When the manual steps are done (Wine prefix provisioned, broker logged in, EA on a
            chart, WebRequest URL allowlisted, MT5 closed), click below — stage 3 will register the
            install with the daemon for you.
          </p>
          <div class="actions">
            <button type="button" class="btn btn-secondary" (click)="cancel()" [disabled]="busy()">
              Cancel
            </button>
            <button type="button" class="btn btn-primary" (click)="advanceToRegister()">
              I've completed these steps
            </button>
          </div>
        </section>
      }

      @if (stage() === 3) {
        <section class="stage">
          @if (busy()) {
            <p class="lead">Registering install with daemon…</p>
          } @else if (registerErr()) {
            <p class="err">{{ registerErr() }}</p>
            <p class="hint small muted">
              The bundle was cloned successfully. Either retry, or register manually later via the
              CLI:
              <code class="mono small block">
                ./install.sh --add-install '{{ cloneResult()?.expectedExecutable }}' --install-id
                '{{ cloneResult()?.brokerSlug }}'
              </code>
            </p>
            <div class="actions">
              <button type="button" class="btn btn-secondary" (click)="cancel()">Close</button>
              <button type="button" class="btn btn-primary" (click)="doRegister()">
                Retry register
              </button>
            </div>
          } @else if (registered()) {
            <p class="lead ok">
              ✓ Registered <code class="mono">{{ registered()?.installId }}</code> · broker
              <strong>{{ registered()?.brokerName || '?' }}</strong> · account
              <strong>{{ registered()?.accountLogin || '?' }}</strong>
            </p>
            <p class="hint small muted">
              The daemon's next heartbeat will advertise this install to the engine — refresh the
              Terminals page to see it in the Launch dropdown.
            </p>
            <div class="actions">
              <button type="button" class="btn btn-primary" (click)="finish()">Done</button>
            </div>
          }
        </section>
      }
    </dialog>
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .wizard {
        /* Browser default centring for native <dialog> opened via
           showModal() relies on auto-margin against the offset-parent
           box.  A global stylesheet reset can clobber that.  Force
           explicit centering with fixed-position + inset 0 + auto
           margin so we are independent of any reset.  Width is fluid
           within min/max so the modal stays readable across narrow
           side-bars and wide screens. */
        position: fixed;
        inset: 0;
        margin: auto;
        border: none;
        border-radius: 12px;
        padding: 0;
        width: max-content;
        min-width: 520px;
        max-width: 720px;
        max-height: calc(100vh - 64px);
        overflow: auto;
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
      }
      .wizard::backdrop {
        background: rgba(0, 0, 0, 0.35);
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-primary);
      }
      .head h3 {
        margin: 0;
        font-size: 16px;
      }
      .icon-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 22px;
        line-height: 1;
        color: var(--text-secondary);
      }
      .steps {
        list-style: none;
        padding: 12px 20px;
        margin: 0;
        display: flex;
        gap: 16px;
        border-bottom: 1px solid var(--border-primary);
        font-size: 12px;
        color: var(--text-secondary);
      }
      .steps li {
        padding: 4px 8px;
        border-radius: 4px;
        cursor: not-allowed; /* default: not reachable */
        user-select: none;
        transition: background 120ms ease;
      }
      .steps li[data-reachable='true'] {
        cursor: pointer;
      }
      .steps li[data-reachable='true']:hover {
        background: color-mix(in srgb, var(--text-primary) 8%, transparent);
      }
      .steps li[data-active='true'] {
        background: color-mix(in srgb, #0a84ff 18%, transparent);
        color: var(--text-primary);
        cursor: default;
      }
      .steps li[data-done='true'] {
        color: #1d8a3e;
      }
      .stage {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .lead {
        margin: 0;
      }
      .lead.ok {
        color: #1d8a3e;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .field .label {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary);
      }
      .field input {
        padding: 8px 10px;
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        font-family: var(--font-mono, monospace);
        font-size: 13px;
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      .field input:focus {
        outline: 2px solid #0a84ff;
        outline-offset: -2px;
      }
      .hint {
        display: block;
      }
      .err {
        color: #c93631;
        margin: 0;
        padding: 8px 12px;
        background: color-mix(in srgb, #ff453a 8%, transparent);
        border-radius: 6px;
      }
      .manual-steps {
        padding-left: 20px;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .manual-steps li {
        line-height: 1.5;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .small {
        font-size: 12px;
      }
      .muted {
        color: var(--text-secondary);
      }
      .block {
        display: block;
        margin-top: 6px;
        padding: 6px 10px;
        background: var(--bg-tertiary);
        border-radius: 4px;
      }
      .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 8px;
      }
      .btn {
        padding: 8px 14px;
        border-radius: 6px;
        border: 1px solid var(--border-primary);
        cursor: pointer;
        font-size: 13px;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: #0a84ff;
        color: white;
        border-color: #0a84ff;
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
    `,
  ],
})
export class AddBrokerTerminalWizardComponent {
  @ViewChild('dlg', { static: true })
  private dlgRef!: ElementRef<HTMLDialogElement>;

  readonly daemonId = input.required<number>();
  readonly daemonName = input<string>('');
  readonly open = input<boolean>(false);
  readonly closed = output<DaemonInstallDto | null>();

  private readonly terminals = inject(TerminalsService);

  protected readonly stage = signal<1 | 2 | 3>(1);
  protected readonly busy = signal<boolean>(false);
  protected readonly cloneResult = signal<DaemonCloneMt5Response | null>(null);
  // Strip the daemon's last next_steps entry — the "call POST
  // /admin/installs/register …" line.  That's CLI-flow instruction
  // for operators using curl; UI wizard users invoke the same call
  // automatically when they click "Register install" on stage 3.
  // Showing it in stage 2 confuses operators into running curl by
  // hand.  Heuristic: drop any line that begins with "call POST".
  protected readonly manualSteps = computed<string[]>(() => {
    const raw = this.cloneResult()?.nextSteps ?? [];
    return raw.filter((s) => !/^\s*call\s+POST\b/i.test(s));
  });
  protected readonly cloneErr = signal<string | null>(null);
  protected readonly registerErr = signal<string | null>(null);
  protected readonly registered = signal<DaemonInstallDto | null>(null);
  protected brokerSlug = '';

  constructor() {
    // Open/close the native dialog based on the `open` input.
    effect(() => {
      const isOpen = this.open();
      const el = this.dlgRef?.nativeElement;
      if (!el) return;
      if (isOpen && !el.open) {
        this.reset();
        el.showModal();
      } else if (!isOpen && el.open) {
        el.close();
      }
    });
  }

  private reset(): void {
    this.stage.set(1);
    this.busy.set(false);
    this.cloneResult.set(null);
    this.cloneErr.set(null);
    this.registerErr.set(null);
    this.registered.set(null);
    this.brokerSlug = '';
  }

  /**
   * Step-indicator click handler.  Allows back-navigation freely
   * (going back is always safe) and forward-navigation only when
   * the target stage's prerequisites are met:
   *   * Stage 2 (manual MT5 setup) needs a successful clone.
   *   * Stage 3 (register install) needs the clone result so it knows
   *     which executable path to register.
   * Forward jumps that bypass prereqs would land the operator on a
   * stage that has no data to render, so we silently no-op them and
   * rely on data-reachable=false to grey out the indicator.
   */
  protected canJumpTo(target: 1 | 2 | 3): boolean {
    if (this.busy()) return false;
    if (target <= this.stage()) return true;
    if (target === 2) return this.cloneResult() !== null;
    if (target === 3) return this.cloneResult() !== null;
    return false;
  }

  protected jumpTo(target: 1 | 2 | 3): void {
    if (!this.canJumpTo(target)) return;
    if (target === this.stage()) return;
    // Going back to stage 1 keeps the cloneResult so the operator can
    // see where the bundle landed if they want to re-register later.
    // Forward jump to stage 3 (re-trigger register) clears prior
    // register error/success so the new attempt's state is clean.
    if (target === 3 && this.stage() !== 3) {
      this.registerErr.set(null);
      this.registered.set(null);
      this.stage.set(3);
      this.doRegister();
      return;
    }
    this.stage.set(target);
  }

  protected doClone(): void {
    const slug = this.brokerSlug.trim();
    if (!slug) return;
    this.busy.set(true);
    this.cloneErr.set(null);
    this.terminals.cloneMt5OnDaemon(this.daemonId(), { brokerSlug: slug }).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (!res.status || !res.data) {
          this.cloneErr.set(res.message || 'clone failed');
          return;
        }
        this.cloneResult.set(res.data);
        this.stage.set(2);
      },
      error: (err) => {
        this.busy.set(false);
        this.cloneErr.set(String(err?.error?.message ?? err?.message ?? err));
      },
    });
  }

  protected advanceToRegister(): void {
    this.stage.set(3);
    this.doRegister();
  }

  protected doRegister(): void {
    const r = this.cloneResult();
    if (!r) return;
    this.busy.set(true);
    this.registerErr.set(null);
    this.terminals
      .registerInstallOnDaemon(this.daemonId(), {
        installId: r.brokerSlug,
        executable: r.expectedExecutable,
        useWine: true,
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          if (!res.status || !res.data) {
            this.registerErr.set(res.message || 'register failed');
            return;
          }
          this.registered.set(res.data);
        },
        error: (err) => {
          this.busy.set(false);
          this.registerErr.set(String(err?.error?.message ?? err?.message ?? err));
        },
      });
  }

  protected finish(): void {
    const result = this.registered();
    this.dlgRef.nativeElement.close();
    this.closed.emit(result);
  }

  protected cancel(): void {
    this.dlgRef.nativeElement.close();
    this.closed.emit(null);
  }
}
