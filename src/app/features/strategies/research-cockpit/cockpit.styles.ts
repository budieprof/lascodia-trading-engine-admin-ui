/** Shared look of the research cockpit's cards (scoped per component — no global selectors). */
export const COCKPIT_CARD_STYLES = `
  :host {
    display: block;
  }
  .card {
    padding: var(--space-4) var(--space-5);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
  }
  .spacer {
    flex: 1;
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--text-secondary);
  }
  .small {
    font-size: var(--text-xs);
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .error-box {
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: rgba(255, 59, 48, 0.1);
    color: var(--loss);
    font-size: var(--text-sm);
  }
  .note {
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    font-size: var(--text-sm);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  th,
  td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    font-weight: normal;
    vertical-align: top;
  }
  thead th {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: var(--text-xs);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .chip[data-tone='done'],
  .chip[data-tone='ok'] {
    background: rgba(52, 199, 89, 0.14);
    color: var(--profit);
  }
  .chip[data-tone='failed'],
  .chip[data-tone='bad'] {
    background: rgba(255, 59, 48, 0.12);
    color: var(--loss);
  }
  .chip[data-tone='running'],
  .chip[data-tone='warn'] {
    background: rgba(255, 149, 0, 0.14);
    color: var(--warning, #b25000);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .table-wrap {
    overflow-x: auto;
  }
`;
