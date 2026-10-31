/**
 * Styles shared by the self-heal panels on the EA detail page (health card,
 * terminal card, results tray, history, timeline, diagnostics, host logs).
 * Component styles are encapsulated, so each panel includes this string.
 */
export const SELFHEAL_PANEL_STYLES = `
  :host { display: block; }
  .panel {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--card-padding);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .panel-head h3 { margin: 0; font-size: var(--text-sm); font-weight: var(--font-semibold); }
  .meta { font-size: var(--text-xs); color: var(--text-tertiary); }
  .muted { color: var(--text-tertiary); }
  .small { font-size: var(--text-xs); }
  .mono { font-family: var(--font-mono); }
  .empty { margin: 0; font-size: var(--text-sm); color: var(--text-tertiary); }
  .error-line { margin: 0; font-size: var(--text-sm); color: var(--tone-red); }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    font-weight: var(--font-semibold);
    white-space: nowrap;
    background: rgba(120, 120, 128, 0.14);
    color: var(--text-secondary);
  }
  .pill[data-tone='ok'] { background: rgba(52, 199, 89, 0.14); color: var(--tone-green); }
  .pill[data-tone='warn'] { background: rgba(255, 149, 0, 0.14); color: var(--tone-amber); }
  .pill[data-tone='bad'] { background: rgba(255, 59, 48, 0.14); color: var(--tone-red); }
  .pill[data-tone='pending'] { background: rgba(0, 113, 227, 0.12); color: var(--tone-blue); }
  .dot {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
    background: var(--text-tertiary);
  }
  .dot[data-tone='ok'] { background: var(--tone-green); }
  .dot[data-tone='warn'] { background: var(--tone-amber); }
  .dot[data-tone='bad'] { background: var(--tone-red); }
  .dot[data-tone='pending'] { background: var(--tone-blue); }
  .tone-ok { color: var(--tone-green); }
  .tone-warn { color: var(--tone-amber); }
  .tone-bad { color: var(--tone-red); }
  .tone-pending { color: var(--tone-blue); }
  .kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
  }
  .kv dt {
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding-top: 2px;
  }
  .kv dd { margin: 0; color: var(--text-primary); min-width: 0; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
  .btn-sm { padding: 4px 12px; font-size: var(--text-xs); }
  .btn-danger {
    background: var(--tone-red, #ff3b30);
    color: #fff;
    border: 1px solid transparent;
  }
  .link-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--accent); font-size: inherit;
  }
  .link-btn:disabled { color: var(--text-tertiary); cursor: not-allowed; }
  table.rows { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
  table.rows th {
    text-align: left; font-size: var(--text-xs); font-weight: var(--font-semibold);
    color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.04em;
    padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap;
  }
  table.rows td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  table.rows tr:last-child td { border-bottom: none; }
  .table-scroll { overflow-x: auto; }
  .pager { display: flex; gap: var(--space-2); align-items: center; justify-content: flex-end; font-size: var(--text-xs); }
`;
