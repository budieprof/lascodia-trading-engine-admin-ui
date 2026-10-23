# Administrator guide

For the people who run an organisation (Owner, Admin, RiskManager, Billing). Every page acts in the organisation you
are signed in to; switch organisation from the header. Pages and buttons appear only when you hold their permission.

## People and access

- **Members** (`/iam/members`): suspend (refused like a non-member until reactivated) or remove someone. Their console
  sessions in your organisation end at once. The last Owner can never be removed.
- **Invitations** (`/iam/invitations`): invite by e-mail with the grants they will receive. You can only grant what you
  hold yourself. The person accepts from the e-mail, or from a single-use link valid for 7 days.
- **Roles** (`/iam/roles`): system roles (Viewer, Trader, Analyst, Operator, Admin, Owner, RiskManager, Billing) and your
  own roles built from permission keys. **Access grants** shows who holds what and where (organisation-wide, an account
  group, one account, one strategy); **Why can they?** explains a decision.
- **Teams** and **Account groups** grant to many people or many accounts at once.
- **Security policy** (`/iam/security`): require a second factor, set idle (5–1440 min) and absolute (1–720 h) session
  limits, restrict sign-in to your networks (CIDR allow-list — the page refuses a list that would lock you out).
- **Single sign-on**: connect your own identity provider (OIDC or SAML) for your e-mail domains; **SCIM** tokens let it
  provision people.
- **Approvals**: a two-person action (releasing a kill switch, loosening a risk limit) waits here for a second person who
  holds the same permission.
- **Access review**: who has what, when it was last used, and bulk revocation.

Some actions need a **recent second-factor sign-in** (step-up). The console asks you to sign in again and then offers to
finish the action.

## Terminals

**Connect a terminal** (`/organisation/terminals`) lists enrollment tokens and machine credentials (one per EA instance
or supervisor daemon) with their last use. **Guided connection** walks one terminal from token to first heartbeat — see
the [EA install guide](/docs/ea-install). Revoke a credential to cut a terminal off within 30 seconds.

## Risk and kill switches

**Risk & kill switches** (`/organisation/risk`):

- **Kill switches** at organisation and account level. Engaging one stops new orders at once and tells the EAs of the
  affected accounts to halt (positions are kept). Releasing one needs `engine.killswitch.release`, a step-up sign-in and
  a second person.
- **Emergency flatten** (typed confirmation) engages the switch first, then cancels working orders and closes positions
  of the organisation or one account.
- **Organisation-wide limits** (`TenantRisk:*`): open positions, total lots, daily loss %, orders per minute — across all
  your accounts. Each is the tighter of the platform's and yours; raising one is a governed change (cooling-off).

## Settings

**Settings** (`/organisation/settings`) shows every setting your organisation may change, its value, which layer it
comes from (account → organisation → platform → default) and what it inherits. Some keys may only be tightened; a change
that loosens a risk key needs a reason and runs through the cooling-off period.

## Strategies

**Strategy subscriptions** (`/organisation/strategies`): an account receives a strategy's signals only through a
subscription your organisation created. Platform strategies and your own (private) strategies are listed apart.

## Alerts

**Alert channels** (`/organisation/alerts`): your own e-mail, Telegram and webhook channels. Secrets are write-only. A
webhook is signed: `X-Lascodia-Timestamp` and `X-Lascodia-Signature: v1=<hex HMAC-SHA256(secret, ts + "." + body)>`,
verified within 5 minutes; the signing secret is shown once with receiver samples. **Send test** delivers a test alert.

## LLM usage and your key

**LLM usage & key**: this month's calls and cost against your budget, and an optional provider key of your own (stored
encrypted, never shown again).

## Plan and usage

**Plan & usage** (`/iam/plan`): your plan's limits (accounts, terminals, members, research jobs, strategies, scripts) and
what is used. A creation past a limit is refused with the limit named.

## Branding, export, closing

- **Branding**: display name, colour, logo and favicon (PNG/JPEG/WebP; SVG refused). The sign-in page stays Lascodia.
- **Export your data** (Owner, step-up): a zip of every table your organisation owns as JSON Lines plus its own audit
  trail, built in the background, downloadable once through a 10-minute link, kept 7 days. Secrets are left out.
- **Close the organisation** (Owner, step-up; a second Owner approves when there is more than one): refused while
  positions or working orders are open. It engages your kill switch, revokes every machine credential, token and
  invitation, and ends sessions. Platform staff can reopen it during the 30-day grace period; after that, deletion.

## Audit log

**Audit Log** (`/admin/audit`): every security and administration event of your organisation (sign-ins, grants,
configuration changes, refusals), append-only and hash-chained.
