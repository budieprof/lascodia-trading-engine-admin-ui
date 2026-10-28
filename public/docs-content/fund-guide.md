# Funds and investors

> [!SUMMARY]
> This guide is for funds and the people who look after them. It covers four things: making important actions need two people, performance statements for your investors, evidence that your trades were carried out well, and exports for compliance checks.
> Two-person approvals come with every plan. The other pages need the **fund module** in your plan; each page tells you when it is not.

```flow
Two-person approvals | A second person checks important actions | users
Performance statements | Returns and risk, as PDF or CSV | chart-line
Investors | They see their statements, nothing else | eye
Best execution | How well each live trade was filled | badge-check
Compliance exports | Audit records, signed and checkable | file-text
@caption The fund pages. Each section below covers one.
```

## Two-person approvals

Some actions are too important for one person alone: releasing a kill switch, loosening a risk limit, a large live order. An **approval policy** makes such an action wait until other people approve it. This is often called the *four-eyes* rule.

```stack
Someone asks for the action | For example: release the kill switch | user
-> it waits on the Approvals page
Approvers decide | People who hold the right role | users
-> when the last approver approves
Lascodia carries it out | Exactly as asked, checked again at that moment | circle-check-big
@caption With no policy, an action works straight away, as before.
```

### Set up a policy

Open **Organisation → Approval policies**.

![Approval policies: each action that can need approval, and its current policy](fund-policies "/organisation/approval-policies")

1. Find the action in the list and click {{Set up}} (or {{Change}} if it already has a policy).
2. Tick **Enabled**.
3. Set **Approvers needed (besides the requester)**: from 1 to 5. The person who asked never counts.
4. Optional: list **Approver roles**, separated by commas. Leave it empty to allow anyone who holds the action's own permission.
5. For live manual orders only: **Applies at or above notional**. *Notional* means the order's full value in the account's currency. Leave it empty to apply to every order.
6. Optional: **Requests expire after** a number of minutes (5 to 1440). Empty means 24 hours.
7. Optional: a **Description**, so others know why the policy exists.
8. Click {{Save}}.

![The policy editor](fund-policy-editor "/organisation/approval-policies")

Actions a policy can cover:

| Action | Example |
| --- | --- |
| Configuration changes | Changing a setting on the Settings page |
| Kill-switch releases | Letting trading start again after an emergency stop |
| Live manual orders | A person placing a real-money order by hand |
| Role grants | Giving someone a role |
| Payout approvals | Approving a payout (prop-firm module) |
| Changes to these policies | Editing or removing an approval policy |

> [!NOTE]
> Market-data licence grants are governed by the platform team, not by your policies.

> [!WARNING] Making a policy weaker is itself checked
> Turning a policy off, asking for fewer approvers, allowing more roles or raising the notional threshold all make it demand less. Each needs a **reason**. If you have a policy for "Changes to these policies", the change also waits for its approvers.

> [!TIP]
> Set up "Changes to these policies" first. Otherwise one person could switch the other policies off alone.

### Approve or reject a request

Held actions wait on **Organisation → Approvals**, with their progress, for example "1 of 2 approvals".

![Approvals: actions waiting for a second person](fund-approvals "/iam/approvals")

1. Read what was asked and who asked.
2. Optional: type a **Reason (shown to the requester)**.
3. Click {{Approve}} or {{Reject}}.

- The requester can never approve their own request, and nobody approves twice.
- Anyone allowed to decide can reject. One rejection ends the request.
- The requester can withdraw their own request with {{Reject}}.
- When the last approver approves, Lascodia carries out exactly what was asked, checking everything again at that moment.

```decide
Is the action I asked for still waiting?
Yes: It needs more approvals. Ask an approver to open Organisation → Approvals.
No, it was rejected: Read the reason, fix what was wrong, and ask again.
No, it expired: Nobody decided in time. Ask again.
```

## Performance statements

A **performance statement** shows how one account, or one **portfolio** (an account group), did over a period. Open **Fund → Performance statements**.

![A performance statement for one demo account](fund-performance "/fund/performance")

1. Under **Account or portfolio**, choose one account or a portfolio.
2. Set **From (UTC)** and **To (UTC, exclusive)**. *Exclusive* means the To day itself is not included.
3. Optional: a **Risk-free rate (% a year)**, the return of a safe investment such as a government bill. Sharpe and Sortino measure the return above it. Leave 0 if unsure.
4. Click {{Show}}.
5. Click {{PDF}} or {{CSV}} to download it.

What the statement shows, in plain words:

| Figure | What it means |
| --- | --- |
| **Time-weighted return** | How much the account grew, with deposits and withdrawals taken out, so only trading counts |
| **Annualised return** | The same, scaled to one year. Shown only for periods of a year or more |
| **Volatility** | How much returns jump around from day to day. Higher means bumpier |
| **Sharpe and Sortino** | Return earned for each unit of risk taken. Higher is better. Sortino counts only the downward moves |
| **Maximum drawdown** | The biggest fall from a high point to a low point, with the dates of the peak, the trough and the recovery |
| **Monthly returns** | A table of each month's return |

Each statement explains its method, so investors can see how the numbers were worked out. The figures are Lascodia's own calculation from its records; they are not audited.

### Record deposits and withdrawals

Money moving in or out is not trading performance. Record it so the return stays honest.

1. Show the account's statement, then scroll to **Recorded deposits and withdrawals**.
2. Fill in **When (UTC)**, the **Kind** (Deposit, Withdrawal, Fee or Adjustment), the **Amount** and a **Note**.
3. Click {{Record}}, then confirm.

**External cash flows** above it lists every flow taken out of the return in the period, whether you recorded it or Lascodia inferred it. **Data notes and methodology** at the bottom explains exactly how each figure was worked out.

> [!WARNING] Record every deposit
> A deposit you do not record is only recognised on a day the account held no position. On any other day it would count as **profit**, and the return would look better than it was.

Recording cash flows needs the permission to manage accounts.

### Give investors their statements

An investor should see their own statements and nothing else. The **Investor** role does exactly that.

1. Open **Organisation → Access grants**.
2. Grant the **Investor** role to the person.
3. Limit it to their account, or to the account group (portfolio) they invested in.

The investor then sees the performance statements of those accounts only. See [Running your organisation](/docs/admin-guide#access-grants) for granting roles.

## Best execution

**Best execution** means getting a fair price when a trade is carried out. This page measures each live **fill** (a trade the broker carried out) against the market around it. Open **Fund → Best execution**.

![Best execution: choose the account, symbol and period, then Show](fund-best-execution "/fund/best-execution")

1. Choose the **Account**, or every account you may see. Optional: type a **Symbol** (a market, for example EURUSD).
2. Set **From (UTC)** and **To (UTC, exclusive)**.
3. Click {{Show}}. Download with {{PDF}} or {{CSV}}.

| Measure | In plain words |
| --- | --- |
| **Slippage against the mid** | How far the fill was from the middle price when the order was created |
| **Slippage against the requested price** | How far the fill was from the price you asked for |
| **Spread paid** | The gap between buying and selling prices at the time |
| **Fill latency** | How long the broker took, as a median and a slow-case (95th percentile) figure in milliseconds |
| **Markouts** | How the market moved 1 second to 5 minutes after the fill. Positive means it moved in the account's favour |

Figures are grouped by broker, account and symbol. In the tables, a positive number of pips is a **cost**. A *pip* is the smallest usual price step of a market.

> [!NOTE]
> This is evidence for your own best-execution policy and reviews. It is not a ready-made regulatory report.

## Compliance exports

A **compliance export** is a download of your organisation's records for a period, for an auditor or regulator. Open **Fund → Compliance exports**.

![Compliance exports: choose the period, the records and the format](fund-compliance "/fund/compliance")

1. Set **From (UTC)** and **To (UTC, exclusive)**.
2. Tick the records you need: the audit log, the orders (every step of every order's life) and the approvals. All three are ticked at first.
3. Choose the **Format**: **JSON (one document)** or **CSV (zip)**.
4. Click {{Download}}.

> [!SUCCESS]
> The page shows the file's **SHA-256**, a fingerprint of the exact file. When the platform has a signing key, it also shows a **signature**. Every download is kept in the register.

### Check a copy later

Anyone can check that a copy has not been changed since it was downloaded.

1. Work out the copy's SHA-256. On a Mac or Linux, run `shasum -a 256 <file>`. On Windows, run `certutil -hashfile <file> SHA256`.
2. Paste it under **Check a copy** and click {{Check}}.

| Result | Meaning |
| --- | --- |
| :ok[Issued by the engine] | This exact file came from Lascodia |
| :bad[Signature mismatch] | The fingerprint is known but the signature does not match. Treat the copy as altered |
| :warn[Not issued] | Lascodia never issued a file with this fingerprint. The copy has been changed, or it is from somewhere else |

## If something goes wrong

?? A fund page says "Not in your plan".
   Your organisation's plan does not include the fund module. Approval policies still work. Ask the platform team about adding the fund module.

?? My action is stuck on "Waiting for approval".
   It needs more people to approve it. Ask someone who holds an approver role to open **Organisation → Approvals**. You cannot approve your own request.

?? I cannot save a weaker approval policy.
   Making a policy demand less needs a reason. If you have a policy for "Changes to these policies", the change also waits for its approvers.

?? The return looks too good after a deposit.
   The deposit was probably counted as profit. Record it as a cash flow on the statement page, with the right date.

?? An investor sees nothing.
   Check their **Investor** grant on **Organisation → Access grants**. It must cover the account or account group whose statements they should see.

?? Best execution shows "No fills".
   Only live fills in the chosen period and symbol are measured. Widen the period or clear the symbol.

## Where to next

```cards
building | Running your organisation | People, roles, approvals and safety switches | /docs/admin-guide
shopping-cart | Placing trades | How orders and fills work | /docs/trading-guide
book-open | Words explained | Drawdown, slippage, pips and more | /docs/glossary
plug | Connect MetaTrader 5 | Link a trading account | /docs/ea-install
```
