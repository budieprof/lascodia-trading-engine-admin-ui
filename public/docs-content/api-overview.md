# API overview

The engine's HTTP API is what the console, the EAs and the sidecars use. The [API reference](/docs/api) lists every
endpoint, generated from the engine's OpenAPI document together with the permission each one needs.

## Base URL

```
https://<your-engine-host>/api/v1/lascodia-trading-engine
```

## Signing in

| Caller | How |
|---|---|
| A person in the console | Console session cookie (sign-in through the identity provider); unsafe requests carry `X-CSRF-Token` |
| A script acting as a person | `Authorization: Bearer lsc_pat_…` (personal access token), bounded by its permissions |
| An EA or a sidecar | Machine credential → `POST machine/token` → 15-minute bearer token |

## The response envelope

Every JSON answer is wrapped:

```
{ "data": …, "status": true, "message": "Successful", "responseCode": "00" }
```

Read `status` and `responseCode`, not only the HTTP status:

| Code | HTTP | Meaning |
|---|---|---|
| `00` | 200 | Success |
| `-11` | 400 | Validation — `message` says what is wrong |
| `-14` | 404 | Not found (also another organisation's id) |
| `-403` | 403 | Refused — the missing permission is named |
| `-403-quota` | 403 | Your plan's limit (`data` names the quota, limit and use) |
| `-403-entitlement` | 403 | Your organisation is not entitled to that market-data feed |
| `-401-stepup` | 401 | Sign in again with a second factor, then retry |
| `-202-approval` | 202 | A second person must approve (`data.approvalId`) — not a failure |
| `-409` | 409 | Conflict with the current state |
| `-429` | 429 | Rate limited — honour `Retry-After` |
| `-503` | 503 | Temporarily unavailable |

Paged list endpoints take criteria in a **nested `filter` object** plus `sortBy` / `sortDirection`; a filter field sent
at the top level is refused (`-12`).

## Organisations

Every request acts in one organisation: the session's (or the token's). People in several organisations choose with
the `X-Tenant` header (id or handle). Another organisation's ids answer "not found".

## Permissions

Every endpoint declares who may call it: a permission key (e.g. `orders.read`, `accounts.connect`), no sign-in, or the
caller's own session only. The reference shows which. `GET admin/permissions/catalog` lists every key with its flags
(`stepUp`, `twoPerson`, `scopeable`).

## Rate limits

| Policy | Budget | Used by |
|---|---|---|
| `auth` | 30/min per address (300 from trusted networks) | Sign-in, sign-up, machine enrollment |
| `ea` | 10 000/min per account / person / daemon | EA high-frequency endpoints |
| `demo` | 240/min per address | The public demo (`demo/*`) |
| `metrics` | 60/min per address | `/metrics` |

## Real-time

SignalR hubs at `/api/hubs/trading` (orders, positions, signals, alerts) and `/api/hubs/marketdata` (ticks and books
per source); a console session connects with a single-use ticket from `POST /bff/ws-ticket`.
