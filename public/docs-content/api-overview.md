# API overview

> [!SUMMARY]
> The engine's **API** (application programming interface) is how programs talk to Lascodia over the web. The console, the MetaTrader 5 EAs and the data feed programs all use it, and your own scripts can too.
> This page covers the address, how a script signs in, the answer format every call returns, permissions, organisations and rate limits. The [API reference](/docs/api) lists every endpoint.

```flow
Your script | Sends a request with its token | square-terminal
Sign-in check | Is the token valid and not expired? | key-round
Organisation and permission | Which organisation, and may this caller do this? | shield-check
Rate limit | Too many calls this minute? | gauge
The engine's answer | Always the same wrapper: data, status, message, code | braces
@caption Every request goes through these checks in this order. A refusal at any step still comes back in the same wrapper.
```

## The address

Every endpoint lives under one base address:

```bash
https://<your-engine-host>/api/v1/lascodia-trading-engine
```

An endpoint such as `order/list` is therefore called at `…/api/v1/lascodia-trading-engine/order/list`.

## Signing in

Who you are decides how you sign in:

| Caller | How it signs in |
| --- | --- |
| A person in the console | The console's session cookie, set when you sign in through the identity provider. Requests that change something also carry an `X-CSRF-Token` header. |
| A script acting as a person | `Authorization: Bearer lsc_pat_…`: a **personal access token**, limited to the permissions chosen when it was made |
| An EA or a feed program | Its machine credential, traded at `POST machine/token` for a token that lasts 15 minutes |

### Make a personal access token

A **token** is a long secret string your script sends instead of a password. Make one on **Administration → Access tokens** (`/account/tokens`):

1. Name it after what will use it ((1)).
2. Choose how long it lasts ((2)): 7, 30, 90, 180 or 365 days.
3. Tick only the permissions the script needs ((3)). You can only choose permissions you hold yourself.
4. Click {{Create token}} at the bottom of the list, confirm with your second factor, and copy the token. It is shown once.

![Access tokens: ((1)) name, ((2)) lifetime, ((3)) permissions](api-tokens "/account/tokens")

> [!NOTE]
> Tokens only work when the platform has turned them on. A token works in the organisation it was made in, and it can never do more than you can: if you lose a permission, so does the token.

### Your first call

```bash
curl -s -X POST "https://<your-engine-host>/api/v1/lascodia-trading-engine/order/list" \
  -H "Authorization: Bearer lsc_pat_..." \
  -H "Content-Type: application/json" \
  -d '{"currentPage": 1, "itemCountPerPage": 20, "filter": {"status": "Filled"}}'
```

> [!DANGER]
> Keep tokens out of code you share or commit. Load them from an environment variable or a secrets store. If one leaks, revoke it on **Access tokens** at once.

## The response envelope

Every JSON answer is wrapped in the same **envelope**:

```json
{ "data": { }, "status": true, "message": "Successful", "responseCode": "00" }
```

- `data` holds the result (or `null`).
- `status` is `true` only for success.
- `message` says what happened, in words.
- `responseCode` says it as a short code.

> [!WARNING] Read the code, not just the HTTP status
> Check `status` and `responseCode` on every answer. For example, a call that needs a second person's approval comes back `202` with code `-202-approval`: it is waiting, not failed and not done.

| Code | HTTP | Meaning | What to do |
| --- | --- | --- | --- |
| `00` | 200 | Success | Use `data` |
| `-11` | 400 | Something in the request is wrong | `message` says what; fix it |
| `-12` | 400 | The request is the wrong shape (for example a list filter sent flat) | See [Lists, paging and filters](/docs/api-overview#lists-paging-and-filters) |
| `-14` | 404 | Not found. Also returned for another organisation's ids | Check the id and the organisation |
| `-401` | 401 | Sign-in failed: token missing, wrong, expired or revoked | Make or use a valid token |
| `-401-stepup` | 401 | This action needs a fresh second-factor check | Sign in again with your second factor, then retry |
| `-403` | 403 | Refused: the missing permission is named | Use a token that carries it |
| `-403-csrf` | 403 | A console request without its CSRF header | Send `X-CSRF-Token` (console sessions only) |
| `-403-quota` | 403 | Your plan's limit is reached; `data` names the quota, limit and use | Free something up, or change plan |
| `-403-entitlement` | 403 | Your organisation is not entitled to that market-data feed | Ask platform staff for the feed |
| `-202-approval` | 202 | A second person must approve; `data.approvalId` says which approval | Wait for the approval |
| `-409` | 409 | Conflicts with the current state | Re-read the item and try again |
| `-429` | 429 | Too many requests | Wait for the `Retry-After` seconds, then retry |
| `-503` | 503 | Temporarily unavailable | Retry later, with a growing pause |

## Lists, paging and filters

List endpoints return one page at a time. Send the page you want, the page size, the sort, and your search criteria **inside** a `filter` object:

```json
{
  "currentPage": 1,
  "itemCountPerPage": 20,
  "sortBy": "createdAt",
  "sortDirection": "desc",
  "filter": { "status": "Filled", "search": "EURUSD" }
}
```

> [!DANGER] Filters must be nested
> A filter field sent at the top level (next to `currentPage`) is refused with `-12`. Without that check it would be silently ignored, and you would get every row instead of the ones you asked for.

`sortBy` must be a column the endpoint allows; anything else falls back to the endpoint's normal order. `sortDirection` is `asc` or `desc`.

## Organisations

Every request acts in exactly one organisation: the one of your session, or the one your token was made in.

- People who belong to several organisations choose with the `X-Tenant` header (the organisation's id or handle).
- Asking for another organisation's item answers **not found** (`-14`), never "forbidden". This way a caller cannot even learn that the item exists.

## Permissions

Each endpoint declares who may call it: a permission key (such as `orders.read` or `accounts.connect`), no sign-in at all, or only the caller's own session. The [API reference](/docs/api) shows which, endpoint by endpoint.

![The API reference searched for order/list: ((1)) search, ((2)) filter by permission, ((3)) the permission this endpoint needs](api-reference "/docs/api")

`GET admin/permissions/catalog` lists every permission key with three flags:

| Flag | Meaning |
| --- | --- |
| `stepUp` | Needs a recent second-factor check (`-401-stepup` otherwise) |
| `twoPerson` | A second person must approve (`-202-approval`) |
| `scopeable` | Can be given for some accounts only, not the whole organisation |

## Rate limits

Calls are counted per minute. Over the limit, the answer is `-429` with a `Retry-After` header saying how many seconds to wait.

| Policy | Budget | Used by |
| --- | --- | --- |
| `auth` | 30 a minute per address (300 from trusted networks) | Sign-in, sign-up, machine enrolment |
| `ea` | 10,000 a minute per account, person or feed program | The EA's frequent endpoints |
| `demo` | 240 a minute per address | The public demo (`demo/*`) |
| `metrics` | 60 a minute per address | `/metrics` |

> [!TIP]
> On `-429` or `-503`, wait and retry with a growing pause (for example 1, 2, 4, 8 seconds). Never retry in a tight loop.

## Real-time updates

For live updates, the engine uses **SignalR** (a web-socket library) instead of repeated calls:

| Hub | Pushes |
| --- | --- |
| `/api/hubs/trading` | Orders, positions, signals and alerts |
| `/api/hubs/marketdata` | Ticks and order books, per source |

A console session connects with a single-use ticket from `POST /bff/ws-ticket`.

## If something goes wrong

```decide
Does every call come back with -401?
Yes: The token is missing, mistyped, expired or revoked, or tokens are turned off on this platform. Check the Authorization header is exactly "Bearer " plus the token.
No: Read responseCode. -403 names the permission the token lacks; -14 often means the wrong organisation.
```

?? My list call is refused with -12.
   The search fields were sent at the top level. Move them inside `"filter": { … }` and send the call again.

?? I get "not found" for an id I can see in the console.
   The console may be acting in a different organisation from your token. Send the `X-Tenant` header, or make the token in the organisation that owns the item.

?? A call returns 202 and nothing happens.
   The action needs a second person's approval (`-202-approval`). Someone with the right permission approves it on **Organisation → Approvals**.

?? I keep getting -429.
   You are over the per-minute budget. Honour `Retry-After`, and use the real-time hubs instead of polling.

## Where to next

```cards
book-open | API reference | Every endpoint and the permission it needs | /docs/api
satellite | Data feeds and integrations | Webhooks, tokens and feed programs | /docs/integrations
server | Platform operator guide | Organisations, plans and data | /docs/platform-guide
building | Running your organisation | Roles, approvals and security | /docs/admin-guide
```
