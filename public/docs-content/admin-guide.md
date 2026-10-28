# Running your organisation

> [!SUMMARY]
> This guide is for the people who run an organisation in Lascodia: Owners, Admins, risk managers and the finance contact. It covers who can get in and what they may do, how to keep trading safe, where alerts go, what your plan allows, and how to leave.
> Every page acts on the organisation you are signed in to. You only see the pages and buttons your role allows.

```flow
People and access | Invite, give roles, review | users
Keeping safe | Sign-in rules, kill switches, limits | shield-check
Alerts | E-mail, Telegram, webhook | bell
Money and plan | Limits, usage, invoices | coins
Leaving | Export your data, close | door-open
@caption The five jobs in this guide. Each has its own section.
```

You find every page in this guide under **Organisation** in the sidebar. If you belong to more than one organisation, switch with the **Org** picker at the top of the screen.

> [!NOTE] Some actions ask you to sign in again
> Sensitive actions, such as releasing a kill switch, need a **recent second-factor sign-in** (a code from your authenticator app within the last few minutes). The console then asks you to sign in again and offers to finish what you started. A green **Second factor confirmed** chip shows you are ready.

## People and access

```stack
Members | The people in your organisation | users
-> each holds one or more
Roles | Bundles of permissions: what a person may do | key-round
-> given through
Access grants | A role for a person or team, over everything or a narrower scope | key-square
@caption Who is in, what they may do, and where.
```

### Members

**Organisation → Members** lists everyone in your organisation, their roles, their status and their last sign-in.

![Members: everyone in the organisation](admin-members "/iam/members")

- {{Invite someone}} opens the Invitations page.
- {{Suspend}} stops a person signing in until you click {{Reactivate}}. Their sessions in your organisation end at once.
- {{Remove}} takes the person out of the organisation. Their sessions end at once.
- {{Sessions}} shows where the person is signed in. {{Sign out everywhere}} ends all of them.
- A **No MFA** chip means the person has not set up a second factor yet.

> [!WARNING]
> The last Owner can never be removed. Make sure your organisation always has at least two Owners, in case one leaves or loses their phone.

### Invitations

New people join by invitation. **Organisation → Invitations**:

1. Type their **E-mail address** ((1)).
2. Choose their **Role** ((2)), and under **Applies to** where it applies (the whole organisation, or narrower). Click {{Add another role}} ((3)) if they need more than one.
3. Click {{Send invitation}} ((4)).

![Invite someone: ((1)) e-mail, ((2)) role, ((3)) more roles, ((4)) send](admin-invite "/iam/invitations")

- The person accepts from the e-mail. You may also be shown a single-use **invitation link** to send them yourself.
- An invitation is valid for **7 days**. **Pending and recent invitations** lists them; {{Revoke}} cancels one.
- You can only give roles whose permissions you hold yourself.

### Roles

A **role** is a named bundle of **permissions**. A permission is one thing a person may do, such as "place orders" or "manage alert channels". **Organisation → Roles** shows what each role allows.

![Roles: the system roles and your own, and ((1)) New role](admin-roles "/iam/roles")

The system roles are fixed:

| Role | Good for | They can |
| --- | --- | --- |
| **Viewer** | Anyone who only needs to look | See dashboards, lists and charts. Change nothing |
| **Trader** | People who place trades | Place, change and cancel orders; approve signals |
| **Analyst** | People who research | Run backtests and training |
| **RiskManager** | Whoever looks after risk | See everything; set risk limits, use kill switches, close positions |
| **Operator** | Day-to-day running | Settings, kill switches, risk, accounts, terminals, alert channels |
| **Admin** | Team leads | Everything an Operator can, plus people, roles, approvals and security |
| **Owner** | The organisation's owners | Everything, including exporting all data and closing the organisation |
| **Billing** | Your finance contact | Plan, usage and invoices. No trading data |
| **Investor** | Investors in a fund | Read-only performance statements of the accounts you share |

**Custom roles** are yours to build:

1. Click {{New role}} ((1)).
2. Give it a **Name** and a **Description**.
3. Tick the permissions it should hold.
4. Click {{Create role}}.

Change a custom role later with {{Save changes}}, or delete it with {{Delete role}}.

> [!TIP] Give the smallest role that does the job
> It is easy to give more later. A custom role is the way to give exactly what a person needs and no more.

### Access grants

An **access grant** gives a role to a person, a team or a service account (a sign-in for a program). It can cover the whole organisation or a narrower **scope**: one account group, one account, or one strategy. **Organisation → Access grants**:

![Access grants: ((1)) grant a role, ((2)) every grant, ((3)) why can they?](admin-grants "/iam/grants")

1. Under **Grant a role**, choose **To** (a person, team or service account) and who exactly.
2. Choose the **Role** and where it applies.
3. Optional: an **Expires** date, for temporary access.
4. Type a **Reason (recorded in the audit log)**.
5. Click {{Grant role}}.

**Why can they?** answers "why can this person do that?". Choose **Who** and a **Permission**, then click {{Check}}. Lascodia lists the grants that give it, or says what is missing.

### Teams and account groups

- A **team** (**Organisation → Teams**) is a group of people. Grant a role to the team once, and everyone in it holds it.
- An **account group** (**Organisation → Account groups**) is a group of trading accounts. Grant a role over the group, and it covers every account in it. A fund's **portfolio** is an account group.

![Teams: click New team, name it, then add people](admin-teams "/iam/teams")

Click {{New team}} (or {{New account group}}), type a **Name** and **Description**, click {{Save}}, then {{Add}} members.

### Access review

People change jobs; their access often stays. **Organisation → Access review** shows who holds what, when they last used it, and what nobody needs any more.

![Access review: the quarterly review at the top, unused grants below](admin-access-review "/iam/access-review")

**Quarterly access reviews** takes a snapshot of every person, grant, terminal credential and access token each quarter, and lists findings such as "Unused grant" or "No sign-in for 90 days". *Stale* means not used for 90 days.

1. Choose the **Quarter**.
2. Read the findings. Open **People**, **Terminal credentials**, **API tokens** and **Service accounts** for the detail.
3. Revoke what nobody needs (below), then click {{Retake snapshot}} so the review records the result.
4. Write a **Reviewer statement**: what you checked, what you revoked and what you kept, and why.
5. Click the **Sign off** button for that quarter. A signed-off review cannot be changed.

{{Export CSV}} and {{Export JSON}} download the review as evidence.

To revoke unused grants:

1. Tick **Unused only** to see grants nobody used for 90 days.
2. Click {{Select all unused}}, or tick single rows.
3. Click {{Revoke selected}} and confirm.

> [!TIP]
> Do this every quarter. It is the easiest way to stop old access piling up.

## Keeping safe

### Security policy

**Organisation → Security policy** sets how members sign in.

![Security policy: ((1)) require a second factor, ((2)) allowed networks, ((3)) save](admin-security "/iam/security")

- **Require a second factor** ((1)): everyone must use an authenticator app or security key. People without one are asked to set it up at their next sign-in.
- **Sign out after this many idle minutes**: from 5 to 1,440 (one day). The default is 60.
- **End every session after this many hours**: from 1 to 720 (30 days). The default is 12.
- **Allowed networks** ((2)): only these internet addresses may sign in, one per line, written as network ranges (for example `203.0.113.0/24`). Leave it empty to allow any network.

Click {{Save policy}} ((3)) and confirm.

> [!DANGER] Do not lock yourself out
> If you set **Allowed networks**, the network you are on now must be one of them. Otherwise you are signed out and refused. The page warns you and refuses a list that would lock you out.

### Single sign-on

**Single sign-on** lets your people sign in with your company's own login (your *identity provider*, for example Microsoft Entra ID, Okta or Google Workspace) instead of a separate Lascodia password. **Organisation → Single sign-on**:

![Single sign-on: your identity provider and directory provisioning](admin-sso "/iam/sso")

1. Choose **OpenID Connect** or **SAML 2.0**: your identity provider's documentation says which it uses.
2. Fill in the **Name on the sign-in page**, the **Issuer URL** (or **Metadata URL** for SAML), the **Client id** and the **Client secret**.
3. List the **E-mail domains that sign in here**, one per line.
4. Tick **Send people with these e-mail domains to this identity provider** when you are ready.
5. Click {{Save}} and confirm.

**Directory provisioning (SCIM)** lets your company directory add, update and remove members for you. Type a **Token name** (for example the directory's name), choose how long the token lasts, and click {{Create token}}. Paste the token into your directory: it is shown once. {{Revoke}} stops a token.

### Approvals

Some actions can need a second person: releasing a kill switch, loosening a risk limit, a large live order, giving a role. Such actions wait on **Organisation → Approvals** until someone else approves.

![Approvals: actions waiting for a second person](admin-approvals "/iam/approvals")

Click {{Approve}} or {{Reject}}, optionally with a reason. You cannot approve your own request. Which actions need approval, and from whom, is set under **Organisation → Approval policies**: see [Funds and investors](/docs/fund-guide#two-person-approvals).

### Risk and kill switches

**Organisation → Risk & kill switches** is where you stop trading in an emergency and set limits that cover every account.

![Risk & kill switches: ((1)) the organisation's kill switch, ((2)) each account's switch, ((3)) emergency flatten, ((4)) organisation-wide limits](admin-risk "/organisation/risk")

A **kill switch** is an emergency stop for new trades. There are three levels, and an account trades only when **all three** are released:

```stack
Platform switch | Run by the platform team. Stops everyone | server
-> and
Organisation switch | Stops every account of your organisation | building
-> and
Account switch | Stops one trading account | landmark
@caption Any one switch engaged is enough to stop new trades below it.
```

| Chip | Meaning |
| --- | --- |
| :ok[Trading] | Nothing stops this account or organisation |
| :bad[Engaged] | This switch is on. No new orders |
| :warn[Halted by the organisation] | This account's own switch is off, but the organisation's is on |
| :warn[Halted by the platform] | The platform team's switch is on. Only they can release it |

**To engage a kill switch:**

1. Click {{Engage…}} next to the organisation, or next to one account.
2. Type a **Reason (required)**. It is kept in the audit log and shown with the switch.
3. Click {{Engage}}.

![Engaging asks for a reason](admin-kill-engage "/organisation/risk")

> [!DANGER] What a kill switch does, and does not do
> Engaged, **no new orders** are placed, and the EAs of the affected accounts are told to halt. **Open positions stay open**, still exposed to the market. To close them too, use the emergency flatten below.

**To release a kill switch:** click {{Release…}}, give a reason and click {{Release}}. Releasing needs a second-factor sign-in within the last five minutes. Where an approval policy applies, it waits for another person, and the switch stays engaged until they approve.

#### Emergency flatten

**Flatten** means close everything. Use it when you must be out of the market now.

1. Click {{Flatten the organisation…}}, or {{Flatten…}} next to one account.
2. Read what will happen.
3. Type a **Reason (required)**.
4. Type the confirmation word shown: your organisation's name, or the account's login.
5. Click {{Flatten now}}.

![The flatten confirmation lists exactly what will happen](admin-flatten "/organisation/risk")

> [!DANGER] Flatten cannot be undone
> In this order it: engages the kill switch; cancels every pending order, at the broker too; closes every open position **at market** (at whatever price is available now, which can be poor in a fast market); and, for the whole organisation, pauses your own strategies. Trading starts again only when someone releases the kill switch.

#### Organisation-wide limits

These limits count every account of your organisation together:

| Limit | What it caps |
| --- | --- |
| **Open positions** | How many trades may be open at once |
| **Open lots** | The total size of all open trades. A *lot* is a standard trade size |
| **Daily loss (% of start-of-day equity)** | How much you may lose in a day before new trades stop |
| **Orders per minute** | How fast orders may be sent |

The page shows the value **In effect** and the **Platform's** value. The stricter of the two always applies, and 0 means no limit. Click {{Change}} to set your own, or {{Remove}} to go back to the platform's.

> [!WARNING] Loosening is slowed down on purpose
> You may only set a limit **stricter** than the platform's. Raising or removing your own limit is a *loosening*: it needs a reason and the permission to loosen risk, may need a second person, and waits out a **cooling-off period** before it takes effect.

### Settings

**Organisation → Settings** shows every setting your organisation may change, its value, and where that value comes from.

![Settings: each value and the layer it comes from](admin-settings "/organisation/settings")

A value comes from the most specific layer that sets it: the **account**, then the **organisation**, then the **platform**, then the built-in **default**. {{Layers}} shows all of them for one setting.

| Chip | Meaning |
| --- | --- |
| :warn[Tighten-only] | May only be set stricter than the value it inherits |
| :bad[Risk] | Loosening it is governed: reason, cooling-off, maybe a second person |
| :muted[Secret] | Never shown. Write a new value to replace it |

Click {{Change}} to set a value, or {{Remove}} to inherit again. A change waiting out its cooling-off period can be withdrawn with {{Cancel change}}.

### Audit log

**Administration → Audit Log** records every security and administration event in your organisation: sign-ins, grants, setting changes, refusals. Entries can only be added, never changed, and each is chained to the one before, so tampering shows.

![The audit log](admin-audit "/admin/audit")

## Alerts

**Organisation → Alert channels** decides where your organisation's alerts go. There are three channels, and you can use any of them.

![Alert channels: e-mail, webhook and Telegram](admin-alerts "/organisation/alerts")

| Channel | You need | Good for |
| --- | --- | --- |
| **E-mail** | 1 to 5 addresses, separated by commas | A shared desk or risk mailbox |
| **Telegram** | A bot token and a chat id or channel name | Alerts on your phone |
| **Webhook** | A public `https` address | Sending alerts into your own systems |

Each channel shows whether it is your organisation's own channel, switched off, or not set up.

**E-mail:**

1. Tick **Send alerts on this channel**.
2. Type the **Recipients**, separated by commas.
3. Click {{Set up}} (or {{Save}}).

**Telegram:** Telegram is a messaging app. A *bot* is an automatic account that posts messages.

1. In Telegram, create a bot with **@BotFather** and copy its **bot token**.
2. Add the bot to your group or channel.
3. Back here, tick **Send alerts on this channel**, and fill in the **Chat id or channel name** (for example `@my_alerts`) and the **Bot token**.
4. Click {{Set up}}.

**Webhook:** a *webhook* is an address on your own server that Lascodia calls with each alert.

1. Tick **Send alerts on this channel**.
2. Type the **URL** (it must be `https` on a public host).
3. Optional: type a **Signing secret** of 32 to 256 characters. Leave it empty and Lascodia makes one.
4. Click {{Set up}}. The signing secret is shown **once**: copy it into your receiver.

> [!NOTE] Signed webhooks
> Every delivery carries two headers: `X-Lascodia-Timestamp` and `X-Lascodia-Signature: v1=<hex>`. The signature is an HMAC-SHA256 of the timestamp, a dot and the body, made with your signing secret. Your receiver should check it and refuse deliveries more than 5 minutes old. {{Rotate signing secret…}} replaces the secret; the old one stops signing at once.

> [!TIP]
> Secrets you typed (bot tokens, webhook addresses, signing secrets) are never shown again. Leave a field empty to keep the stored value.

## Money and plan

### Plan & usage

**Organisation → Plan & usage** shows what your plan allows and how much is in use: accounts, terminals, members, research jobs, strategies and scripts.

![Plan & usage: each limit and how much is used](admin-plan "/iam/plan")

Adding something over a limit is refused, with a message naming the limit. Nothing already in use is removed when a plan changes. To move to a larger plan, contact the platform team.

### Usage & billing

**Organisation → Usage & billing** shows metered usage per day, this month's estimated charges and your invoices.

![Usage & billing](admin-billing "/organisation/billing")

Invoices appear once the platform has reviewed and finalised them. Click {{View}} to open one. The **Billing** role sees this page without seeing any trading data.

### LLM usage and your own key

Some Lascodia features use an **LLM**, a large language model: the AI behind the assistant and the written analyses. **Organisation → LLM usage & key** shows this month's LLM use against your budget.

![LLM usage & key: spend against your caps, and your own provider key](admin-llm "/organisation/llm")

- Calls stop once spending reaches the page's stated share of a cap.
- Optional: store your organisation's **own provider key** (Anthropic, OpenAI, Google or DeepSeek). Choose the provider, paste the **API key** and click {{Store key}}.
- Your key is used only when the organisation's setting `Llm:Tenant:PaidBy` is `OwnKey` (on **Organisation → Settings**). Otherwise the platform pays.
- Keys are stored encrypted and never shown again; the page shows only the last four characters. {{Remove}} deletes a key.

### Branding

**Organisation → Branding** changes how the console looks for your members once they have signed in.

![Branding: name, colour, logo and favicon](admin-branding "/organisation/branding")

- Set a display **name** and a **Primary colour**, then click {{Save name and colour}}.
- Click {{Upload…}} for a **logo** (PNG, JPEG or WebP, up to 256 KB) or a **favicon**, the small browser-tab icon (PNG or ICO, up to 64 KB). SVG files are refused.
- {{Go back to the platform look}} removes all branding.

The sign-in page always shows Lascodia.

## Leaving

### Export your data

**Organisation → Export your data** (Owners only) makes one download of everything your organisation owns.

![Export your data](admin-export "/organisation/data-export")

1. Click {{Export everything}} and confirm. You may be asked to sign in again with your second factor.
2. Wait a few minutes while it is prepared in the background.
3. Click {{Download}}.

- The file is a zip: one file per kind of record (JSON Lines), a manifest, and your audit trail.
- Passwords, API keys, bot tokens, webhook addresses and signing secrets are **left out**. Platform strategies and market data are not yours, so they are not included.
- A download can be fetched for **7 days**. One export at a time, at most three a day.

### Close the organisation

**Organisation → Close the organisation** (Owners only) stops your organisation using Lascodia.

![Close the organisation: what will happen](admin-close "/organisation/close")

```flow
Close | Sign-ins stop, terminals disconnect | door-open
Grace period | Platform staff can still reopen it | hourglass
Deleted | Data is removed for good | x
@caption Closing, then the grace period shown on the page, then deletion.
```

1. Make sure no positions or working orders are open. Closing is refused while any are.
2. Export your data first: once closed, nobody can sign in to download it.
3. Click {{Close …}}, type your organisation's **handle** to confirm, and click {{Close the organisation}}.

> [!DANGER] Closing stops everything at once
> Every member is signed out and refused. Personal access tokens stop. Your kill switch engages, and every machine credential, enrollment token and invitation is revoked. If your organisation has more than one Owner, another Owner must approve the closing on the Approvals page.

During the grace period, platform staff can reopen the organisation. Its kill switch then stays engaged until an Owner releases it, and terminals must be connected again. After the grace period, the data is deleted.

## If something goes wrong

```decide
Is trading stopped when it should not be?
Yes: Open Organisation → Risk & kill switches. Look for Engaged or Halted chips at the organisation or account. Release the switch that is on, if it is safe.
No, but a person cannot do something: Open Organisation → Access grants and use Why can they? to see which permission is missing.
Not sure: Check the Audit Log for the latest changes and who made them.
```

?? Someone lost their phone and cannot sign in.
   The console has no button to reset another person's second factor. Contact the platform team to reset it. Meanwhile you can {{Suspend}} the person on **Organisation → Members** if you worry someone else has the phone.

?? I cannot give someone a role.
   You can only give roles whose permissions you hold yourself. Ask an Owner.

?? I released the kill switch but trading has not started.
   Check three things: the account's own switch, the organisation's switch, and the chip **Halted by the platform**. An approval policy may also be holding the release until another person approves it on **Organisation → Approvals**.

?? I changed a limit but the old value still applies.
   Loosening waits out a cooling-off period, and may wait for an approver. The **Settings** page shows the queued change.

?? Alerts stopped arriving on Telegram.
   Check the bot is still in the group or channel, and that the chat id is right. If you replaced the bot, store its new token.

?? My webhook receiver refuses deliveries.
   Check the receiver uses the current signing secret (after a rotation, the old one no longer signs), and that its clock is right: deliveries more than 5 minutes old should be refused.

?? Closing the organisation is refused.
   Positions or working orders are still open. Close them, or use the emergency flatten, then try again.

## Where to next

```cards
plug | Connect MetaTrader 5 | Link a trading account through the Lascodia EA | /docs/ea-install
cable | Connect a broker or exchange | Futures, crypto and stock brokers | /docs/connections-guide
landmark | Funds and investors | Approval policies, statements and compliance exports | /docs/fund-guide
book-open | Words explained | Lots, margin, drawdown and more | /docs/glossary
```
