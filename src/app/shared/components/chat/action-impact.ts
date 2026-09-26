/** How much care an operator should take before confirming a proposed call. */
export type ActionSeverity = 'info' | 'warn' | 'danger' | 'unknown';

/** A proposed call, described in terms of what it does rather than which route it hits. */
export interface ActionImpact {
  verb: string;
  subject: string;
  severity: ActionSeverity;
}

/**
 * Route prefixes whose effect is worth stating plainly, most specific first.
 *
 * <p>This is deliberately a short, hand-written list rather than an attempt to cover 500
 * operations. Anything not on it is reported as unrecognised — see {@link describeAction}.</p>
 */
const KNOWN: ReadonlyArray<{
  match: RegExp;
  methods?: string[];
  verb: string;
  subject: string;
  severity: ActionSeverity;
}> = [
  {
    match: /\/kill-switch|\/admin\/kill-switch/i,
    verb: 'Engage a kill switch',
    subject: 'halts trading for everything in its scope until it is released',
    severity: 'danger',
  },
  {
    match: /\/flatten|\/emergency/i,
    verb: 'Flatten positions',
    subject: 'closes live positions at market',
    severity: 'danger',
  },
  {
    match: /\/safety-stop/i,
    verb: 'Trip the safety stop',
    subject: 'stops the affected instances from trading',
    severity: 'danger',
  },
  {
    match: /\/position\/.*\/close|\/position\/close/i,
    verb: 'Close a position',
    subject: 'realises its profit or loss at market',
    severity: 'danger',
  },
  {
    match: /\/order\b/i,
    methods: ['POST', 'PUT', 'PATCH'],
    verb: 'Place or change an order',
    subject: 'sends a live instruction to the broker',
    severity: 'danger',
  },
  {
    match: /\/ea\/.*\/restart|\/terminals\/.*\/(restart|launch|stop)/i,
    verb: 'Restart an EA or terminal',
    subject: 'disconnects it briefly; open positions are untouched but unmanaged meanwhile',
    severity: 'warn',
  },
  {
    match: /\/engine-config|\/config\b/i,
    verb: 'Change engine configuration',
    subject: 'takes effect fleet-wide on the next worker cycle',
    severity: 'warn',
  },
  {
    match: /\/risk-profile|\/viability-gates|\/drawdown-recovery/i,
    verb: 'Change a risk control',
    subject: 'alters what the engine is allowed to trade',
    severity: 'warn',
  },
  // Pine / rule-based script strategies (ADR-0027) — before the generic strategy rules.
  {
    match: /\/strategy\/\d+\/account-bindings/i,
    verb: 'Change which accounts a strategy trades',
    subject:
      'a script trades only on its bound accounts — check every REAL account and lot multiplier',
    severity: 'danger',
  },
  {
    match: /\/strategy\/\d+\/execution-policy/i,
    verb: "Change a strategy's execution policy",
    subject: 'Direct skips the signal gates; Standard applies every one',
    severity: 'warn',
  },
  {
    match: /\/strategy\/\d+\/script\b(?!\/alerts)/i,
    methods: ['PUT'],
    verb: "Replace a strategy's Pine script",
    subject: 'saves a new version and restarts its live session; open positions are left to you',
    severity: 'warn',
  },
  {
    match: /\/strategy\/\d+\/script\/alerts/i,
    verb: "Change a script's alert routing",
    subject: 'where its alerts are delivered — it does not trade',
    severity: 'info',
  },
  {
    match: /\/strategy\/import\b/i,
    verb: 'Create a strategy from a script',
    subject: 'lands Paused as a Draft; nothing trades until it is promoted',
    severity: 'info',
  },
  {
    match: /\/strategy\/\d+\/(start|stop)-paper-trading/i,
    verb: 'Start or stop paper trading',
    subject: 'paper executions only — nothing is sent to an account',
    severity: 'info',
  },
  {
    match: /\/strategy\/\d+\/submit-for-approval/i,
    verb: 'Run the promotion gates',
    subject: 'a pass leaves it Approved + Paused, which the promotion worker may auto-activate',
    severity: 'warn',
  },
  {
    match: /\/scripting\/(replay|libraries)/i,
    methods: ['POST', 'PUT'],
    verb: 'Run a replay or publish a Pine library',
    subject: 'does not trade; a library update reaches every strategy that imports it',
    severity: 'info',
  },
  {
    match:
      /\/strategy\/.*(bulk-action|activate|pause|status)|Strategy\s*·\s*(Bulk|Update|Activate|Pause)/i,
    verb: 'Change strategy status',
    subject: 'affects whether and how those strategies generate signals',
    severity: 'warn',
  },
  {
    match: /\/strategy\b|Strategy\s*·/i,
    methods: ['POST', 'PUT', 'PATCH'],
    verb: 'Change a strategy',
    subject: 'affects whether and how it generates signals',
    severity: 'warn',
  },
  {
    match: /\/trade-signal\/.*\/(approve|reject|cancel)/i,
    verb: 'Decide a trade signal',
    subject: 'approving one lets accounts act on it',
    severity: 'warn',
  },
  {
    match: /\/alert\b|\/chart-annotations|\/analysis-monitors|\/monitors/i,
    verb: 'Create or change a note, alert or monitor',
    subject: 'observational only — it does not trade',
    severity: 'info',
  },
  {
    match: /\/backtest|\/walk-forward|\/optimization|\/experiment/i,
    verb: 'Queue a research run',
    subject: 'uses compute; it does not touch live trading',
    severity: 'info',
  },
];

/**
 * Describes a proposed call in the operator's terms.
 *
 * <p>An unrecognised route is reported as unrecognised. Inventing a friendly description for a
 * path this table has never seen would be worse than showing nothing: it would give the
 * operator confidence in a sentence the code made up.</p>
 */
export function describeAction(method: string, path: string): ActionImpact {
  const m = (method || '').toUpperCase();
  const p = path || '';

  if (m === 'DELETE') {
    return {
      verb: 'Delete a record',
      subject: 'removes it; check whether anything still references it',
      severity: 'danger',
    };
  }

  for (const rule of KNOWN) {
    if (!rule.match.test(p)) continue;
    if (rule.methods && !rule.methods.includes(m)) continue;
    return { verb: rule.verb, subject: rule.subject, severity: rule.severity };
  }

  return {
    verb: 'Run this call',
    subject: 'not a call this console recognises — read it carefully below before confirming',
    severity: 'unknown',
  };
}

/** Flattens a request body into label/value rows so the card can show what changes. */
export function humaniseBody(body: unknown): Array<{ label: string; value: string }> {
  if (body == null || typeof body !== 'object') return [];
  const rows: Array<{ label: string; value: string }> = [];

  const walk = (obj: Record<string, unknown>, prefix = '') => {
    for (const [key, value] of Object.entries(obj)) {
      if (rows.length >= 12) return;
      const label = prefix ? `${prefix} · ${sentenceCase(key)}` : sentenceCase(key);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, label);
      } else if (isLongText(value)) {
        // A whole Pine script in one row buried the rest of the card; it gets its own block.
        rows.push({ label, value: `${lineCount(value)} lines of text — shown in full below` });
      } else {
        rows.push({ label, value: Array.isArray(value) ? value.join(', ') : String(value) });
      }
    }
  };

  walk(body as Record<string, unknown>);
  return rows;
}

/**
 * Multi-line or long string fields of a request body (a script, a template), unescaped, so
 * the operator can read the exact text they are approving rather than a JSON string of \n.
 */
export function longTextFields(
  body: unknown,
): Array<{ label: string; text: string; lines: number }> {
  if (body == null || typeof body !== 'object') return [];
  const out: Array<{ label: string; text: string; lines: number }> = [];

  const walk = (obj: Record<string, unknown>, prefix = '') => {
    for (const [key, value] of Object.entries(obj)) {
      const label = prefix ? `${prefix} · ${sentenceCase(key)}` : sentenceCase(key);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, label);
      } else if (isLongText(value)) {
        out.push({ label, text: value, lines: lineCount(value) });
      }
    }
  };

  walk(body as Record<string, unknown>);
  return out;
}

function isLongText(value: unknown): value is string {
  return typeof value === 'string' && (value.includes('\n') || value.length > 200);
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

function sentenceCase(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
