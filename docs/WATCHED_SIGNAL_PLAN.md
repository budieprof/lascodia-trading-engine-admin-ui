# Watched Signals — Park-Revalidate-Arm for Far Limit Entries

> Status: draft. Engine pieces (new `Watched` lifecycle state, price-watch,
> revalidation) live in the engine repo and are specced here. UI surface
> (status badge, detail panel, sweep-cockpit section, config knobs) is built in
> this repo against the API contract in §4.

## 1. Concept

When the LLM produces a **limit-entry** signal whose entry sits **far from live
price**, placing the limit immediately bets that the thesis written _now_ will
still hold whenever price eventually drifts to the entry — often hours later,
through news and regime shifts. We instead **park** the signal as `Watched`, and
only **arm** it when price actually reaches the entry, gated by a fresh LLM
**revalidation**. If the setup still checks out, we fire — as a tight limit at
live price with a market fallback. If not, it expires unfilled.

This turns a static resting limit into a **just-in-time, thesis-revalidated**
entry. It directly attacks the "stale limit fills on a dead thesis" failure mode.

Short name: **Watch**. UI surface lives inside the existing `spot-sweep` cockpit
and the `trade-signals` detail page.

Decisions locked with the product owner:

- **Hold threshold:** ATR-relative — park if `|entry − live| > k × ATR(period)`.
  One tunable knob `k` (default ~1.25), auto-scales per symbol/volatility.
- **Trigger:** revalidate on **first touch** of the entry (not trade-through),
  paired with a **gap buffer** so a spike past entry expires instead of arming.
- **Fill on confirm:** **tight limit at/near live price + market fallback** if
  unfilled within a short window. Controls slippage at a fast-moving level.
- **TTL:** **tied to the signal's timeframe** (N bars), plus invalidate-early if
  the stop-equivalent level is hit before entry.

## 2. Architecture split

| Layer                               | Owner        | Responsibility                                                       |
| ----------------------------------- | ------------ | -------------------------------------------------------------------- |
| Park decision (at signal creation)  | Engine       | compute ATR distance, branch immediate-place vs `Watched`            |
| `WatchedSignalMonitor` (hosted svc) | Engine       | per-watched price-watch, touch/gap/stop detection, TTL expiry        |
| Revalidation                        | Engine       | re-run analyze with fresh context + original thesis → confirm/reject |
| Arm + place                         | Engine       | tight-limit-at-live + market fallback; reuse approve/order path      |
| `TradeSignal` schema + status       | Engine       | new `Watched` status + watch metadata columns                        |
| Config (watch knobs)                | Engine       | persisted alongside sweep / analysis config                          |
| Status badge, detail panel, cockpit | This UI repo | surface watched state, live distance, TTL countdown, overrides       |

**Why engine-owned:** the price-watch must run continuously regardless of any UI
being open, and the touch/arm transition must be race-safe and idempotent at
order time — same rationale as the Spot Sweep worker.

## 3. Lifecycle (engine)

New status `Watched` inserted **before** `Approved`. Immediate (near-entry)
signals are unchanged.

```
LLM signal (limit entry)
   │
   ├─ |entry − live| ≤ k·ATR ──────────────► Pending  (existing flow, place now)
   │
   └─ |entry − live| > k·ATR ──────────────► Watched  (park; persist watch meta)
                                                │
        ┌───────────────────────────────────────┼───────────────────────────────┐
        │ price touches entry                    │ TTL (N bars) elapses           │
        ▼                                        ▼                                │
   gap past entry > buffer?                   Expired ("watch TTL")               │
        │ yes ─► Expired ("gapped through")                                       │
        │ no                                  stop-equiv level hit before entry ──┘
        ▼                                        └─► Expired ("invalidated pre-entry")
   REVALIDATE (fresh analyze + original thesis)
        │
        ├─ confirm ─► Approved ─► tight limit @ live (+ market fallback) ─► Executed
        └─ reject  ─► Expired ("revalidation rejected")
```

### Park decision (at creation)

1. Only applies to **limit-style** entries (pullback/reversion). Stop/breakout
   entries and market signals are placed as today.
2. Compute `ATR(watchAtrPeriod)` on the signal's timeframe and
   `distance = |entryPrice − livePrice|`.
3. `distance ≤ k·ATR` → existing immediate flow.
4. `distance > k·ATR` → persist as `Watched` with: `armEntryPrice`, arm side,
   `watchDistanceAtr` snapshot, `watchedUntil = now + watchTtlBars × bar(tf)`,
   and the original thesis blob needed for revalidation.

### WatchedSignalMonitor

- Subscribes to quotes for every distinct watched symbol (shared stream, not one
  per signal). Cheap; no LLM cost until a trigger fires.
- **Touch:** price reaches `armEntryPrice` on the correct side → revalidate.
- **Gap buffer:** if first observation is already past entry by
  `> watchGapBufferAtr × ATR`, expire `gapped through` (don't chase).
- **Stop-first invalidation:** if the stop-equivalent level prints before entry,
  expire `invalidated pre-entry` (the move went the wrong way first).
- **TTL:** `now ≥ watchedUntil` with no touch → expire `watch TTL`.

### Revalidation

- Re-run `analyzeMarket(symbol, tf)` with **fresh candles** plus the original
  thesis, prompted to confirm/reject the _still-standing_ setup (v1 is
  two-outcome; re-quote of entry/stop deferred to v2).
- **Confirm** → `Approved`; place a **tight limit** at `live ± limitOffsetAtr·ATR`
  with a `fillWindowSeconds` timer; on timeout, fall back to **market**. Reuse the
  existing approve→order path and the same Tier-1 risk re-check.
- **Reject** → `Expired ("revalidation rejected")`. Increment `revalidationCount`.

**Idempotency:** the touch→arm transition is a single guarded state flip; a
restart re-reads `Watched` rows and resumes watching. One arm per signal.

## 4. API contract (engine to implement, UI consumes)

`TradeSignalStatus` gains `'Watched'`. `TradeSignalDto` gains:

| Field                | Type             | Meaning                                             |
| -------------------- | ---------------- | --------------------------------------------------- |
| `armEntryPrice`      | `number \| null` | the level price must reach to trigger revalidation  |
| `watchDistanceAtr`   | `number \| null` | distance at park time, in ATR units (why it parked) |
| `watchedUntil`       | `string \| null` | ISO TTL expiry                                      |
| `revalidationCount`  | `number`         | times this signal has been revalidated              |
| `lastRevalidationAt` | `string \| null` | ISO of most recent revalidation                     |

Manual overrides (operator cockpit):

- `PUT /trade-signal/{id}/arm` — force revalidate-now regardless of touch.
- `PUT /trade-signal/{id}/cancel-watch` — expire a watched signal (`operator cancel`).

List/filter: `/trade-signal/list` accepts `Watched` in the status filter.

Config knobs (persisted; mirror in `SpotSweepConfig` or a sibling analysis config):

| Knob                 | Default | Notes                                       |
| -------------------- | ------- | ------------------------------------------- |
| `watchEnabled`       | `false` | master switch (ship dark, enable per owner) |
| `watchAtrPeriod`     | `14`    | ATR lookback                                |
| `watchAtrMultiple` k | `1.25`  | park threshold in ATR units                 |
| `watchGapBufferAtr`  | `0.25`  | expire if first touch overshoots by this    |
| `watchTtlBars`       | `3`     | TTL = N bars of the signal timeframe        |
| `limitOffsetAtr`     | `0.05`  | tight-limit offset from live on arm         |
| `fillWindowSeconds`  | `30`    | limit fill window before market fallback    |

## 5. Safety model

- **Dark by default** (`watchEnabled = false`); no behavioural change until the
  owner flips it. Off → every signal places immediately as today.
- **Tier-1 risk re-check runs at arm time**, not park time — account state /
  margin / exposure / spread are evaluated against the moment of execution.
- **Dedupe at arm:** before arming, re-check the symbol exclusion set (open
  position / pending order / pending signal) exactly like the sweep does today, so
  a parked signal can't arm into a double position.
- **Market fallback is bounded** by `fillWindowSeconds` and the same risk caps;
  it cannot fire outside an approved, re-checked order.
- **Cost:** one extra LLM call per _armed_ signal only (parked-but-never-touched
  signals cost nothing beyond the quote stream).

## 6. UI work (this repo)

1. **Status surface** — add `'Watched'` to `TradeSignalStatus`, a badge + filter
   chip + colour (distinct from Pending), in the signals list and detail page.
2. **Signal detail — Watched card:** entry vs live price, **distance in ATR**,
   `watchedUntil` countdown, arm trigger level, revalidation history, and
   **Arm now / Cancel watch** buttons wired to the new endpoints.
3. **Sweep cockpit — Watched section:** a list like `holdCooldowns`, one row per
   parked signal with symbol/tf, live distance to entry, TTL countdown, and
   per-row arm/cancel overrides. Feed from the watched-status signal list.
4. **Config panel:** the §4 knobs grouped under a "Watched limit entries"
   section, gated behind `watchEnabled`.
5. **History:** reuse the Spot Analysis report; add a "park→arm" outcome facet so
   confirm-rate and park-rate are visible.

## 7. Phased delivery

- **Phase 0 (engine, dark):** `Watched` status + columns + park decision +
  monitor + revalidation + arm. `watchEnabled = false`. Validate on paper.
- **Phase 1 (this repo):** status badge + detail Watched card + cockpit Watched
  section + config knobs. Mock-backed against §4 ahead of engine, same pattern as
  Spot Sweep.
- **Phase 2:** enable on paper, instrument park-rate / touch-rate / confirm-rate,
  tune `k`, `watchTtlBars`, `watchGapBufferAtr`.
- **Phase 3 (v2):** revalidation **re-quote** (adjust entry/stop when thesis holds
  but levels shifted) instead of confirm/reject only.

## 8. Open questions (engine + UI to align)

- Is "limit-style entry" a clean flag on the signal, or inferred from
  `entry vs live` side? (Park decision needs an unambiguous signal type.)
- ATR source: computed engine-side at park time, or read from the analyze
  payload the LLM already saw?
- Does a parked `Watched` signal count against `excludePendingSignal` in the
  sweep eligibility set? (Recommend **yes** — it's live intent on that symbol.)
- Quote-stream source for the monitor — reuse the EA price feed, or a broker
  market-data subscription?
- Should `watchTtlBars` clamp to the existing `signalExpirationSeconds` ceiling
  (24 h) so watch TTL never outlives the standard signal TTL?
