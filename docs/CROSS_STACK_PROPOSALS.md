# Cross-stack upgrade proposals

Three items in the current upgrade batch require coordinated engine + UI work.
Each is scaffolded UI-side where that's possible; the engine spec lives here so
the contract is clear before either side starts.

---

## 1. Chart annotations

### Context

The drawdown chart, performance chart, and P&L chart have no way to record
"something happened here." Operators post-morteming an incident currently have
to cross-reference the audit trail manually. An annotation layer on the charts
would anchor context to a timestamp.

### Engine changes

**New entity `ChartAnnotation`:**

```sql
CREATE TABLE ChartAnnotation (
    Id BIGINT PRIMARY KEY,
    Target VARCHAR(50) NOT NULL,      -- 'drawdown' | 'performance' | 'pnl' | 'execution-quality'
    Symbol VARCHAR(12) NULL,           -- nullable — global annotations not tied to a pair
    AnnotatedAt TIMESTAMP NOT NULL,    -- when the annotation applies to, not when it was created
    Body VARCHAR(500) NOT NULL,
    CreatedBy BIGINT NOT NULL REFERENCES TradingAccount(Id),
    CreatedAt TIMESTAMP NOT NULL,
    UpdatedAt TIMESTAMP NULL,
    IsDeleted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX ix_ChartAnnotation_Target_AnnotatedAt ON ChartAnnotation (Target, AnnotatedAt);
```

**Endpoints** (all under `/api/v1/lascodia-trading-engine/chart-annotations`):

| Method | Route    | Policy   | Returns                         |
| ------ | -------- | -------- | ------------------------------- |
| POST   | `/list`  | `Viewer` | `PagedData<ChartAnnotationDto>` |
| POST   | (create) | `Trader` | `ResponseData<long>`            |
| PUT    | `/{id}`  | `Trader` | `ResponseData<string>`          |
| DELETE | `/{id}`  | `Trader` | `ResponseData<string>`          |

Filter shape: `{ target, symbol?, from?, to? }`. Keep it cheap — no fulltext.

### UI changes

Once the endpoints exist, every chart-card that subscribes to a `target` fetches
the relevant annotations on load and renders them as ECharts `markPoint`
entries. A per-chart toolbar gets a "Add annotation" button that opens a
modal (reuse `ConfirmDialogComponent`-shaped modal pattern).

Effort: ~2 days engine + ~1 day UI.

---

## 2. Operator presence

### Context

Two operators editing the same strategy or toggling the same kill switch is a
real risk with more than one person on the platform. A lightweight presence
signal on SignalR — "Alice is viewing this page" — prevents conflicts without
heavyweight locking.

### Engine changes

**Extend `TradingEngineRealtimeHub`:**

```csharp
// Called by the browser on route entry.
public async Task EnterRoom(string routeKey)
{
    var accountId = long.Parse(Context.User!.FindFirst("tradingAccountId")!.Value);
    await Groups.AddToGroupAsync(Context.ConnectionId, $"room:{routeKey}");
    await Clients.Group($"room:{routeKey}")
        .SendAsync("presenceJoined", new { accountId, routeKey });
}

public async Task LeaveRoom(string routeKey)
{
    /* mirror of above; emit `presenceLeft`. */
}
```

Rooms are keyed by route path — `orders`, `strategies/42`, `kill-switches`.
No persistence; presence is ephemeral per connection.

**Add two events to `REALTIME_EVENTS` on the UI side:** `presenceJoined`,
`presenceLeft`. Payload carries `{ accountId, routeKey }`.

### UI changes

A `PresenceService` tracks `Map<routeKey, Set<accountId>>`. Each feature page
calls `service.enter(routeKey)` in its constructor; a presence badge component
reads the set and renders "N other operators viewing." `leave` fires on route
change via a `RouterGuard`.

Effort: ~2 days engine + ~2 days UI.

---

## 3. Cookie-based session (HttpOnly)

### Context

PRD §14 rules out `localStorage` for JWTs — we comply — but `sessionStorage`
is still XSS-readable. An HttpOnly cookie is the standard production
hardening.

### Engine changes

**`POST /auth/login` sets a `Set-Cookie`:**

```
Set-Cookie: lascodia-auth=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/
```

**`POST /auth/logout` clears it.**

The body of `/auth/login` stays useful (carries the account summary) but the
`token` field can be omitted once cookie auth is the only supported path.

**JWT validation reads the cookie when no `Authorization` header is present:**

```csharp
options.Events.OnMessageReceived = ctx =>
{
    if (string.IsNullOrEmpty(ctx.Token)
        && ctx.Request.Cookies.TryGetValue("lascodia-auth", out var cookieToken))
    {
        ctx.Token = cookieToken;
    }
    return Task.CompletedTask;
};
```

**CORS needs `AllowCredentials()` and the UI origin in `WithOrigins(...)` —
can't use `AllowAnyOrigin()` together with credentials.**

### UI changes

`ApiService` gains `withCredentials: true` on every request. `AuthService`
stops reading / writing to `sessionStorage` entirely — the cookie is the
source of truth. `isAuthenticated` flips to a `GET /auth/whoami` probe at
boot (cached for 60s) because the UI can no longer inspect the cookie.

The SignalR `accessTokenFactory` becomes problematic because cookies don't
ride query-string paths. Two options:

1. Keep a short-lived bearer token alongside the cookie for the SignalR
   handshake only — issued by `GET /auth/ws-ticket` that reads the cookie.
2. Use SignalR's long-polling fallback (which does send cookies) when the
   WebSocket upgrade doesn't accept them.

Option 1 is cleaner.

Effort: ~2 days engine + ~2 days UI + integration-test pass.

---

## Sequencing

These three are independent. Pick whichever matters most:

- **Cookie auth** if the threat model is your top concern — closes the biggest
  remaining XSS surface.
- **Operator presence** if the team is growing and edit conflicts are real.
- **Chart annotations** if post-mortems are painful.

Nothing blocks any of them on each other.
