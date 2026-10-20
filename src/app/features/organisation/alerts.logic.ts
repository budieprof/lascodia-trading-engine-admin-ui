import type {
  AlertChannelName,
  AlertChannelSettings,
  AlertChannelTestResult,
  SaveAlertChannelBody,
} from './organisation.types';

// Alert channels (T7.5; engine AlertChannelsController, docs/api/alert-webhooks.md): where the
// organisation's alerts go on e-mail, Telegram and a signed webhook. Validation mirrors the engine's
// AlertChannelRules so a person hears about a mistake before saving; the engine still decides.

export const CHANNELS: readonly AlertChannelName[] = ['Email', 'Webhook', 'Telegram'];
export const MAX_RECIPIENTS = 5;
export const MIN_SECRET = 32;
export const MAX_SECRET = 256;
export const MAX_TEST_MESSAGE = 500;
const MAX_URL = 2048;

const BOT_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;
const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const EMAIL = /^[^@\s,;"<>]+@[^@\s,;"<>]+\.[^@\s,;"<>]+$/;

export function channelTitle(c: string): string {
  return c === 'Email' ? 'E-mail' : c;
}

/** Where this channel's settings come from, in words. */
export function sourceText(s: AlertChannelSettings | undefined): string {
  switch (s?.source) {
    case 'organisation':
      return s.enabled
        ? "The organisation's own channel"
        : "The organisation's own channel (switched off)";
    case 'platform-default':
      return "The platform's channel (House, until it sets up its own)";
    default:
      return 'Not set up: alerts are not sent on this channel';
  }
}

/** House without its own channel: saving one moves House's alerts on it off the platform channel. */
export function houseTakeoverNotice(s: AlertChannelSettings | undefined): string | null {
  return s?.source === 'platform-default'
    ? "House's alerts on this channel go to the platform channel set in Engine Config. Setting up the organisation's own channel here sends them here instead, and only here."
    : null;
}

export interface ChannelDraft {
  enabled: boolean;
  emailTo: string;
  chatId: string;
  /** Write-only: empty keeps the stored token. */
  botToken: string;
  /** Write-only: empty keeps the stored URL. */
  url: string;
  /** Write-only: empty keeps the stored secret (or generates one for a new webhook). */
  secret: string;
  legacyHeader: boolean;
}

/** The form for a channel: the organisation's own non-secret values; never a secret, never the platform's. */
export function draftFor(s: AlertChannelSettings | undefined): ChannelDraft {
  const own = s?.source === 'organisation';
  return {
    enabled: own ? s!.enabled : true,
    emailTo: own ? (s!.emailTo ?? '') : '',
    chatId: own ? (s!.telegramChatId ?? '') : '',
    botToken: '',
    url: '',
    secret: '',
    legacyHeader: own ? s!.webhookLegacySecretHeader : false,
  };
}

export function recipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;]/).map((p) => p.trim())) {
    if (!part || seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    out.push(part);
  }
  return out;
}

function webhookUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'The webhook must be an https URL.';
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || url.length > MAX_URL) {
    return 'The webhook must be an https URL without a user name or password (at most 2,048 characters).';
  }
  return null;
}

/** Why the draft cannot be saved, or nothing. */
export function channelErrors(
  channel: AlertChannelName,
  d: ChannelDraft,
  s: AlertChannelSettings | undefined,
): string[] {
  const own = s?.source === 'organisation';
  const errors: string[] = [];
  switch (channel) {
    case 'Email': {
      const list = recipients(d.emailTo);
      if (!list.length) errors.push('Enter at least one e-mail address.');
      else if (list.length > MAX_RECIPIENTS)
        errors.push(`At most ${MAX_RECIPIENTS} e-mail addresses.`);
      for (const a of list) {
        if (a.length > 254 || !EMAIL.test(a)) errors.push(`'${a}' is not an e-mail address.`);
      }
      break;
    }
    case 'Telegram': {
      if (!CHAT_ID.test(d.chatId.trim())) {
        errors.push(
          'Enter the chat id (e.g. -1001234567890) or the channel name (e.g. @my_alerts).',
        );
      }
      const token = d.botToken.trim();
      if (token && !BOT_TOKEN.test(token)) {
        errors.push(
          'That is not a Telegram bot token (it looks like 123456789:AA…, as @BotFather issued it).',
        );
      }
      if (!token && !(own && s!.telegramBotTokenSet))
        errors.push('Enter the bot token @BotFather issued.');
      break;
    }
    case 'Webhook': {
      const url = d.url.trim();
      if (url) {
        const p = webhookUrlProblem(url);
        if (p) errors.push(p);
      } else if (!(own && s!.webhookUrl)) {
        errors.push('Enter the webhook URL.');
      }
      const secret = d.secret.trim();
      if (secret && (secret.length < MIN_SECRET || secret.length > MAX_SECRET)) {
        errors.push(
          `The signing secret must be ${MIN_SECRET}–${MAX_SECRET} characters. Leave it empty and one is generated.`,
        );
      }
      break;
    }
  }
  return errors;
}

/** The request body: secrets only when typed (empty = keep the stored one). */
export function saveBody(channel: AlertChannelName, d: ChannelDraft): SaveAlertChannelBody {
  switch (channel) {
    case 'Email':
      return { enabled: d.enabled, emailTo: recipients(d.emailTo).join(', ') };
    case 'Telegram':
      return {
        enabled: d.enabled,
        telegramChatId: d.chatId.trim(),
        ...(d.botToken.trim() ? { telegramBotToken: d.botToken.trim() } : {}),
      };
    default:
      return {
        enabled: d.enabled,
        ...(d.url.trim() ? { webhookUrl: d.url.trim() } : {}),
        ...(d.secret.trim() ? { webhookSecret: d.secret.trim() } : {}),
        webhookLegacySecretHeader: d.legacyHeader,
      };
  }
}

/** A test's outcome in one sentence. */
export function testText(r: AlertChannelTestResult): string {
  return r.delivered
    ? `Test alert sent to ${r.destination || 'the channel'}.`
    : `Not sent: ${r.reason ?? 'the channel did not accept it'}.`;
}

// ── Receiving signed webhooks (docs/api/alert-webhooks.md) ─────────────

export const SIGNATURE_HEADERS = `X-Lascodia-Timestamp: <unix seconds>
X-Lascodia-Signature: v1=<lower-case hex HMAC-SHA256(secret, timestamp + "." + raw body)>`;

export const RECEIVER_PYTHON = `import hmac, hashlib, time

def verify(secret: str, timestamp: str, signature_header: str, raw_body: bytes, tolerance=300) -> bool:
    if not timestamp or not signature_header or not timestamp.isdigit():
        return False
    if abs(time.time() - int(timestamp)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, part.strip()[3:])
               for part in signature_header.split(",") if part.strip().startswith("v1="))`;

export const RECEIVER_NODE = `const crypto = require("crypto");
function verify(secret, timestamp, signatureHeader, rawBody /* Buffer */, toleranceSec = 300) {
  if (!/^\\d+$/.test(timestamp || "") || !signatureHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(timestamp + "."), rawBody])).digest();
  return signatureHeader.split(",").map(s => s.trim()).filter(s => s.startsWith("v1="))
    .some(s => { const got = Buffer.from(s.slice(3), "hex");
                 return got.length === expected.length && crypto.timingSafeEqual(got, expected); });
}`;
