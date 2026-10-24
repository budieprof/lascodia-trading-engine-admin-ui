# Fund module guide

For funds and their investors: performance statements, best-execution evidence, compliance exports and four-eyes
approvals. The fund pages need the **fund module** in your organisation's plan (the page tells you when it is not);
four-eyes approval policies are part of every plan.

## Four-eyes approvals

**Approval policies** (`/organisation/approval-policies`) decide which actions need more than one person. For each action
you set how many people other than the requester must approve (1–5), which roles they must hold, and — for live manual
orders — from which notional the policy applies. With no policy an action works exactly as before.

- Governed actions: configuration changes, kill-switch releases, live manual orders, role grants, payout approvals, and
  changes to the policies themselves. Market-data entitlement grants are governed by the platform operator.
- A held action appears on **Approvals** (`/iam/approvals`) with its progress ("1 of 2 approvals"). When the last
  approver approves, the engine carries out exactly what was asked — checking everything again at that moment.
- The requester can never approve, and nobody approves twice. Anyone allowed to decide can reject.
- Making a policy demand less (off, fewer approvers, wider roles, a higher threshold) needs a reason, and waits for the
  approvers of the "Changes to these policies" policy when you have one.

## Performance statements

**Performance statements** (`/fund/performance`) cover one account or one account group (a portfolio): time-weighted
return, annualised return (periods of a year or more), volatility, Sharpe and Sortino, maximum drawdown with its dates,
and a monthly returns table, downloadable as PDF or CSV. Each statement explains its method.

- **Record deposits and withdrawals** on the statement page (needs account management). They are taken out of the
  return. A deposit you do not record is only recognised on a day the account held no position; otherwise it would be
  counted as performance — record them.
- **Investors**: grant the **Investor** role on an account or an account group (Access grants). The investor then sees
  the statements of those accounts and nothing else.

## Best execution

**Best execution** (`/fund/best-execution`) measures each live fill against the market around it: slippage against the
mid price when the order was created and against the price requested, spread paid, fill latency, and markouts 1 s to
5 min after the fill — per broker, account and symbol, as PDF or CSV. It is evidence for your own best-execution policy
and review, not a regulatory report template.

## Compliance exports

**Compliance exports** (`/fund/compliance`) download your organisation's audit log, order lifecycle and approvals for a
period, as JSON or a zip of CSV files. Each download shows its SHA-256 (and a signature when the platform has a signing
key) and is kept in the register. To check a copy later, compute its SHA-256 (`shasum -a 256 <file>`) and paste it under
**Check a copy**.
