import type { TradingAccountDto } from '@core/api/api.types';
import type {
  AccountRef,
  CreateEnrollmentTokenBody,
  CredentialOrigin,
  EnrollmentTokenCreated,
  MachineCredential,
  MachineKind,
} from './organisation.types';

// Connect a terminal (T7.1): enrollment tokens and machine credentials (engine MachineController,
// EA ADR-0017). Pure decisions, so the page stays a thin shell.

/** Limits the engine validates (`CreateEnrollmentTokenCommandValidator`). */
export const LABEL_MAX = 128;
export const LOGIN_MAX = 100;
export const SERVER_MAX = 200;
/** `RevokeMachineCredentialCommandValidator`. */
export const REVOKE_REASON_MAX = 256;

/** The first EA build that understands enrollment tokens. */
export const MIN_EA_VERSION = '8.47.253';

/** What an EA token is tied to. */
export type BindingMode = 'any' | 'account' | 'login';

export interface EnrollmentDraft {
  kind: MachineKind;
  label: string;
  binding: BindingMode;
  tradingAccountId: number | null;
  accountLogin: string;
  brokerServer: string;
}

export function emptyEnrollmentDraft(kind: MachineKind = 'EaTerminal'): EnrollmentDraft {
  return {
    kind,
    label: '',
    binding: 'any',
    tradingAccountId: null,
    accountLogin: '',
    brokerServer: '',
  };
}

/** Plain reasons the draft cannot be sent; empty when it can. */
export function enrollmentErrors(d: EnrollmentDraft): string[] {
  const errors: string[] = [];
  const label = d.label.trim();
  if (!label) errors.push('Give the token a label, e.g. the host and chart it is for.');
  else if (label.length > LABEL_MAX) errors.push(`The label is at most ${LABEL_MAX} characters.`);
  if (d.kind === 'EaTerminal') {
    if (d.binding === 'account' && !(d.tradingAccountId && d.tradingAccountId > 0)) {
      errors.push('Choose the account the terminal trades.');
    }
    if (d.binding === 'login') {
      const login = d.accountLogin.trim();
      const server = d.brokerServer.trim();
      if (!login || !server) errors.push('Enter both the broker login and the broker server.');
      if (login.length > LOGIN_MAX) errors.push(`The login is at most ${LOGIN_MAX} characters.`);
      if (server.length > SERVER_MAX) errors.push(`The server is at most ${SERVER_MAX} characters.`);
    }
  }
  return errors;
}

/** The request body for a valid draft. A daemon token is never bound to an account. */
export function enrollmentBody(d: EnrollmentDraft): CreateEnrollmentTokenBody {
  const body: CreateEnrollmentTokenBody = { kind: d.kind, label: d.label.trim() };
  if (d.kind !== 'EaTerminal') return body;
  if (d.binding === 'account' && d.tradingAccountId) body.tradingAccountId = d.tradingAccountId;
  if (d.binding === 'login') {
    body.accountLogin = d.accountLogin.trim();
    body.brokerServer = d.brokerServer.trim();
  }
  return body;
}

// ── Accounts ──────────────────────────────────────────────────────────

export function accountRefs(accounts: readonly TradingAccountDto[]): AccountRef[] {
  return accounts
    .map((a) => ({
      id: a.id,
      login: a.accountId,
      name: a.accountName,
      brokerServer: a.brokerServer,
      accountType: a.accountType,
      isPaper: a.isPaper,
    }))
    .sort((a, b) => a.id - b.id);
}

/** "Main · 12345 @ Exness-MT5Real (Demo)", or "Account #7" when the account is not known here. */
export function accountLabel(a: AccountRef | null | undefined, id?: number | null): string {
  if (!a) return id ? `Account #${id}` : 'Unknown account';
  const where = [a.login, a.brokerServer].filter(Boolean).join(' @ ');
  const name = a.name?.trim();
  const head = name && where ? `${name} · ${where}` : name || where || `Account #${a.id}`;
  return `${head} (${a.isPaper ? 'Paper' : a.accountType})`;
}

/** What a token is tied to, in words. */
export function boundTo(
  t: {
    kind: string;
    tradingAccountId: number | null;
    accountLogin: string | null;
    brokerServer: string | null;
  },
  accounts: ReadonlyMap<number, AccountRef>,
): string {
  if (t.kind === 'Daemon') return 'A supervisor daemon';
  if (t.tradingAccountId) return accountLabel(accounts.get(t.tradingAccountId), t.tradingAccountId);
  if (t.accountLogin) return `Login ${t.accountLogin} @ ${t.brokerServer ?? '?'}`;
  return 'Any account of this organisation';
}

// ── Credentials ───────────────────────────────────────────────────────

export interface CredentialGroup {
  key: string;
  title: string;
  account: AccountRef | null;
  credentials: MachineCredential[];
}

/**
 * Credentials per account (the organisation's accounts in id order, then accounts not listed here),
 * then the supervisor daemons. Newest credential first inside a group.
 */
export function groupCredentials(
  credentials: readonly MachineCredential[],
  accounts: readonly AccountRef[],
): CredentialGroup[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const groups = new Map<string, CredentialGroup>();
  for (const c of credentials) {
    const daemon = c.kind === 'Daemon' || c.tradingAccountId === null;
    const key = daemon ? 'daemons' : `account:${c.tradingAccountId}`;
    let g = groups.get(key);
    if (!g) {
      const account = daemon ? null : (byId.get(c.tradingAccountId!) ?? null);
      g = {
        key,
        title: daemon ? 'Supervisor daemons' : accountLabel(account, c.tradingAccountId),
        account,
        credentials: [],
      };
      groups.set(key, g);
    }
    g.credentials.push(c);
  }
  const rank = (g: CredentialGroup): number => {
    if (g.key === 'daemons') return Number.MAX_SAFE_INTEGER;
    const id = Number(g.key.slice('account:'.length));
    // Known accounts in id order, then unknown ones (still by id).
    return byId.has(id) ? id : 1e12 + id;
  };
  const out = [...groups.values()].sort((a, b) => rank(a) - rank(b));
  for (const g of out) g.credentials.sort((a, b) => b.id - a.id);
  return out;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | '';

/** The credential's state as a chip. */
export function credentialState(c: MachineCredential): { label: string; tone: Tone } {
  if (c.revokedAtUtc) {
    return c.revokedReason === 'replaced'
      ? { label: 'Replaced', tone: '' }
      : { label: 'Revoked', tone: 'bad' };
  }
  if (c.rotationPending) return { label: 'New secret handed out', tone: 'info' };
  if (c.rotationRequestedAtUtc) return { label: 'Rotation requested', tone: 'info' };
  if (!c.lastUsedAtUtc) return { label: 'Not used yet', tone: 'warn' };
  return { label: 'Active', tone: 'ok' };
}

export function originLabel(origin: CredentialOrigin): string {
  switch (origin) {
    case 'Enrollment':
      return 'Enrollment token';
    case 'LegacyUpgrade':
      return 'Moved from the account API key';
    case 'Child':
      return 'Sibling instance on the same terminal';
    default:
      return origin;
  }
}

export function kindLabel(kind: string): string {
  return kind === 'Daemon' ? 'Supervisor daemon' : kind === 'EaTerminal' ? 'EA on a chart' : kind;
}

/** "never", "just now", "4 min ago", "3 h ago", "2 days ago". */
export function sinceText(utc: string | null | undefined, now = Date.now()): string {
  if (!utc) return 'never';
  const t = new Date(utc).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ── Instructions ──────────────────────────────────────────────────────

export interface Instruction {
  text: string;
  /** Something to paste or run, shown as code. */
  code?: string;
}

/** Where to put a freshly created token, step by step, for the kind of machine it is for. */
export function enrollmentSteps(
  created: Pick<EnrollmentTokenCreated, 'kind' | 'token' | 'expiresAtUtc'>,
  boundText: string | null = null,
): Instruction[] {
  const expires = new Date(created.expiresAtUtc);
  const until = Number.isNaN(expires.getTime()) ? 'in 24 hours' : `at ${expires.toLocaleString()}`;
  if (created.kind === 'Daemon') {
    return [
      {
        text: "On the supervisor's host, open its supervisor.yaml and add this line:",
        code: `enrollment_token: "${created.token}"`,
      },
      {
        text: 'Restart the supervisor. On macOS:',
        code: 'launchctl kickstart -k gui/$(id -u)/com.lascodia.supervisor',
      },
      {
        text: "Its log then says “daemon <id> enrolled”, and the credential is kept next to supervisor.yaml (machine_credential.json). It appears under Machine credentials below.",
      },
      { text: 'Remove enrollment_token from supervisor.yaml: it is spent.' },
      {
        text: 'From then on, a terminal the supervisor launches for an account without a credential enrolls itself — no token needed.',
      },
      { text: `The token works once and expires ${until}.` },
    ];
  }
  const steps: Instruction[] = [
    {
      text: `In MetaTrader 5, open the chart running the Lascodia EA (version ${MIN_EA_VERSION} or later) and press F7 to open its properties, then the Inputs tab.`,
    },
    { text: 'Paste the token above into InpEnrollmentToken and press OK.' },
    {
      text: 'The EA exchanges the token for its own credential when it starts (re-attach it if it was already running). It then appears under Machine credentials below.',
    },
  ];
  if (boundText) steps.push({ text: `This token only connects ${boundText}.` });
  steps.push({ text: `The token works once and expires ${until}.` });
  return steps;
}
