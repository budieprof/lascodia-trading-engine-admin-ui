/**
 * Controls shared by the scripting components (buttons, chips, small form controls), in the
 * console's own vocabulary — pill buttons, the design tokens, 13px text. Included per component
 * because component styles are encapsulated.
 */
export const SCRIPTING_UI_STYLES = `
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    padding: 0 var(--space-4);
    border: none;
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    transition: background 0.15s ease, opacity 0.15s ease;
  }
  .btn:hover:not(:disabled) { filter: brightness(0.97); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); filter: none; }
  .btn-danger { background: rgba(255, 59, 48, 0.12); color: var(--loss); }
  .btn-ghost { background: transparent; color: var(--text-secondary); }
  .btn-ghost:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
  .btn-sm { height: 26px; padding: 0 10px; font-size: 12px; }
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: sx-spin 0.7s linear infinite;
  }
  @keyframes sx-spin { to { transform: rotate(360deg); } }
  .muted { color: var(--text-secondary); }
  .small { font-size: 12px; }
  .mono { font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--radius-full);
    font-size: 11px;
    font-weight: var(--font-medium);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .chip-accent { background: rgba(0, 113, 227, 0.12); color: var(--accent); }
  .chip-ok { background: rgba(52, 199, 89, 0.14); color: #1f8a3b; }
  .chip-warn { background: rgba(255, 149, 0, 0.16); color: #b25e00; }
  .chip-error { background: rgba(255, 59, 48, 0.14); color: #c4241a; }
  .field-input {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    min-width: 0;
    box-sizing: border-box;
  }
  .field-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12); }
  .field-input:disabled { opacity: 0.55; }
  .error-box {
    padding: 8px 12px;
    border-radius: 8px;
    background: rgba(255, 59, 48, 0.08);
    border: 1px solid rgba(255, 59, 48, 0.28);
    color: #b3261e;
    font-size: 12px;
    white-space: pre-line;
  }
  :host-context([data-theme='dark']) .error-box { color: #ff8a80; }
  :host-context([data-theme='dark']) .chip-ok { color: #6ee58e; }
  :host-context([data-theme='dark']) .chip-warn { color: #ffb74d; }
  :host-context([data-theme='dark']) .chip-error { color: #ff8a80; }
`;
