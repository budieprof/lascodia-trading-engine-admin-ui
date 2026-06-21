---
name: spot-review
description: Review all spot-analysis LLM signals over a chosen time window, document findings + recurring failure modes, and apply prompt + engine-guard improvements to AnalyzeMarketCommand.cs. Multi-agent workflow (parallel per-signal reviewers → synthesis → prompt-diff → engine-guards → applied edits + build verification). Pairs with /loop for periodic LLM tuning (`/loop spot-review every 7d`).
---

# /spot-review — review spot-analysis signals and improve the LLM analysis

You are running one **end-to-end** improvement pass on the Lascodia engine's spot-analysis LLM. The pass reviews all `SpotAnalysis`-source TradeSignals generated in a chosen window, identifies cross-cutting failure modes, then **applies** matching changes to the LLM prompt and the engine viability gate.

The engine runs locally at `http://localhost:5081`, Postgres is in docker container `lascodia-trading-engine-postgres-1` (database `LascodiaTradingEngineDb`, user `postgres`). Both must be up — abort early with a clear message if either is unreachable.

## Input

Parse the user's args (whitespace-delimited tokens after the skill name):

- `today` (default) — signals generated today (UTC). Note this is bounded by `current_date` in Postgres.
- `yesterday` — yesterday (UTC).
- `<N>d` (e.g. `3d`, `7d`) — last N days.
- `<N>h` (e.g. `12h`, `48h`) — last N hours.
- `YYYY-MM-DD` (e.g. `2026-06-19`) — that calendar day in UTC.
- `from=YYYY-MM-DD to=YYYY-MM-DD` — explicit range (inclusive of both ends).
- `dry-run` — perform the review + propose edits, but DO NOT apply changes to AnalyzeMarketCommand.cs. Writes the findings doc only.
- `max=<N>` — cap reviewers at N (default 100; protects against runaway batches).

Examples: `spot-review today`, `spot-review 3d`, `spot-review 2026-06-19`, `spot-review from=2026-06-15 to=2026-06-19 dry-run`.

If args are empty, default to `today`.

## What "good" means

A successful pass:

1. Reviews **every** SpotAnalysis signal in the window (or the first `max=N`, logged) and produces structured per-signal verdicts.
2. Writes a findings doc at `docs/spot-signals-review-<window>.md` in the engine repo.
3. Applies prompt-side edits to `AnalyzeMarketCommand.cs` AND engine-side guards to `FilterViableForSignals`.
4. The engine still compiles cleanly (0 errors); pre-existing unrelated test failures are tolerated.

If `dry-run` is set, steps 1+2 still happen but step 3 is skipped.

## Workflow

### 1. Preflight

Run in parallel — abort the skill on any failure:

```bash
curl -sf -o /dev/null -w "engine: %{http_code}\n" http://localhost:5081/health
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -tAc "SELECT 1;"
```

Resolve the date range from the arg into `RANGE_START_UTC` and `RANGE_END_UTC` (timestamptz). Default `today` → `[date_trunc('day', now()), now()]`.

### 2. Scope the work

Query the signal list — order **DESCENDING by GeneratedAt** so the most recent signals are first (handy for `max` truncation):

```sql
SELECT "Id", "Symbol", "Direction", "EntryPrice", "StopLoss", "TakeProfit",
       "Confidence", "Status", "GeneratedAt", "LlmInvocationId", "OriginalTakeProfit"
FROM "TradeSignal"
WHERE "Source" = 'SpotAnalysis'
  AND "GeneratedAt" >= '<RANGE_START_UTC>'
  AND "GeneratedAt" <  '<RANGE_END_UTC>'
ORDER BY "GeneratedAt" DESC
LIMIT <max | default 100>;
```

If the result is empty, print `No spot-analysis signals in window — nothing to review.` and exit cleanly.

If the result is `> 30 signals`, briefly tell the user the scope and the approximate token cost (each reviewer is ~10–20k tokens), then proceed — do not block on a confirmation. If `> 100`, hard-cap at 100 and tell the user (or honour their explicit `max=N`).

### 3. Launch the multi-agent workflow

Write the workflow script to a temp file (so iteration via Workflow `scriptPath` works) and invoke it.

**Script structure** — four phases:

```javascript
export const meta = {
  name: 'spot-review-batch',
  description:
    'Review SpotAnalysis signals in the chosen window and propose prompt + engine improvements',
  phases: [
    { title: 'Review', detail: 'parallel per-signal reviewers' },
    { title: 'Synthesise', detail: 'aggregate failure modes' },
    { title: 'Prompt diff', detail: 'propose AnalyzeMarketCommand prompt edits' },
    { title: 'Engine guards', detail: 'propose deterministic guards' },
  ],
};

// Inline SIGNALS array from the query above — { id, symbol, direction, entry, sl, tp, conf, status, generated, llm }
const SIGNALS = [
  /* one literal per row */
];

const REVIEW_SCHEMA = {
  /* see below */
};
const SYNTHESIS_SCHEMA = {
  /* see below */
};
const PROMPT_DIFF_SCHEMA = {
  /* see below */
};
const GUARDS_SCHEMA = {
  /* see below */
};

phase('Review');
const reviews = (
  await parallel(
    SIGNALS.map(
      (sig) => () =>
        agent(buildReviewerPrompt(sig), {
          label: `${sig.id}:${sig.symbol}:${sig.direction}`,
          schema: REVIEW_SCHEMA,
          phase: 'Review',
        }),
    ),
  )
).filter(Boolean);

log(`Collected ${reviews.length} / ${SIGNALS.length} reviews`);

phase('Synthesise');
const synthesis = await agent(buildSynthesisPrompt(reviews), {
  schema: SYNTHESIS_SCHEMA,
  phase: 'Synthesise',
});

phase('Prompt diff');
const promptDiff = await agent(buildPromptDiffPrompt(synthesis), {
  schema: PROMPT_DIFF_SCHEMA,
  phase: 'Prompt diff',
});

phase('Engine guards');
const guards = await agent(buildGuardsPrompt(synthesis), {
  schema: GUARDS_SCHEMA,
  phase: 'Engine guards',
});

return { reviews, synthesis, promptDiff, guards };
```

#### REVIEW_SCHEMA (per-signal)

Required fields: `signal_id`, `symbol`, `direction`, `actual_outcome_summary`, `rationale_quote`, `rr`, `entry_vs_mid_at_signal` (above|at|below), `verdict` (agree|partial_agree|disagree), `flaws[]` (≤6), `observed_failure_modes[]` from the enum below, `alternate_recommendation` ({ action: Buy|Sell|Hold, order_type: Market|BuyStop|SellStop|BuyLimit|SellLimit|NA, entry?, sl?, tp?, rationale }).

`observed_failure_modes` enum (extend if a new mode emerges):

- `breakout_label_with_limit_entry`, `limit_label_with_market_entry`
- `tp_beyond_first_resistance_support`, `tp_too_ambitious_for_ttl`
- `low_rr`, `sl_too_tight`, `sl_too_wide`
- `ignored_cross_asset_disagreement`, `ignored_econ_event`, `session_mismatch`
- `overconfident_for_data`, `wrong_direction`
- `good_call`, `no_flaws`, `other`

#### Reviewer prompt template

Each agent receives a self-contained prompt (no inherited context). It must:

1. Fetch the LLM rationale: `SELECT "ResponseBody" FROM "LlmInvocation" WHERE "Id" = <llm>;`
2. Fetch H1 candles in `[generated - 24h, generated + 6h]`.
3. Identify live mid at signal time (open of the bar containing the timestamp, or the explicit mid quoted in the LLM rationale if present).
4. Compute (pip = 0.01 for JPY-quoted pairs, 0.0001 otherwise):
   - R:R = `|TP − entry| / |entry − SL|`
   - MFE post-signal (Buy: max(High)−entry; Sell: entry−min(Low))
   - MAE post-signal (mirror)
   - Final outcome: HitTP / HitSL / Expired (TTL ≈ 6h)
   - Entry vs live-mid placement; flag rationale-verb / order-type mismatch
   - TP vs nearest resistance/support; SL vs nearest magnet
5. Verdict + alternate recommendation. If Hold, set `order_type: NA` and omit prices.

#### SYNTHESIS_SCHEMA

`executive_summary` (3–5 paragraphs), `verdict_counts`, `failure_mode_counts` (object), `outcome_hits` (hit_tp, hit_sl, expired_positive, expired_negative, expired_flat, rejected), `top_patterns[]` (each: pattern, count, example_ids[1–4], description, why_it_matters, fix_target ∈ {prompt, engine, both}), `recurring_quotes[]`.

The synthesis agent receives the full per-signal review JSON and must aggregate honestly (cite signal IDs, do not invent patterns).

#### PROMPT_DIFF_SCHEMA

`target_file` (the AnalyzeMarketCommand.cs absolute path), `background_summary` (what was read), `prompt_section_edits[]` (each: edit_name, addresses_pattern, section_anchor, edit_type ∈ {insert, replace, append}, text, expected_effect), `recommendation_format_changes[]` (any changes to the `<<<RECOMMENDATIONS_JSON>>>` contract — e.g. new fields).

The agent must Read `AnalyzeMarketCommand.cs` before proposing edits so anchors are real.

#### GUARDS_SCHEMA

`background` (where in the codebase the guards fire), `guards[]` (each: name, check_summary, check_pseudocode in C#-ish, action_on_fail ∈ {reject, auto-correct, flag-low-confidence, log-only}, addresses_pattern, recommended_call_site).

The agent must Read `FilterViableForSignals` and surrounding code before proposing.

### 4. Wait for the workflow

Workflow runs in the background. You will receive a `<task-notification>` when it completes; do not poll. The result lives at `result.{reviews, synthesis, promptDiff, guards}` in the workflow output file.

### 5. Write the findings document

Read `result.synthesis` + a compact per-signal slice (id, symbol, dir, verdict, rr, entry_vs_mid, outcome, alt action). Write to:

```
/Users/olabodeolaleye/Developments/Software Projects/personal/Lascodia Trading Engine/lascodia-trading-engine/docs/spot-signals-review-<window-label>.md
```

`<window-label>` = the date or range used (e.g. `2026-06-19`, `last-3d-2026-06-19`).

Doc structure (use the existing [docs/spot-signals-review-2026-06-19.md](../../../../lascodia-trading-engine/docs/spot-signals-review-2026-06-19.md) as the canonical template):

- At-a-glance metrics table
- Executive summary (from synthesis)
- Failure-mode counts table
- Top recurring patterns (with examples)
- Recurring rhetorical tells
- Per-signal verdicts table
- Prompt-side recommendations table
- Engine-side guards table
- Expected impact estimate
- Implementation status section (filled in after step 6)
- Source-of-truth pointer to the workflow output file

### 6. Apply edits (skip if `dry-run`)

Delegate to a `general-purpose` subagent with a comprehensive instruction:

- Pass the prompt-diff and guards JSON via temp files (`/tmp/spot-review-promptdiff.json`, `/tmp/spot-review-guards.json`).
- Have the subagent Read `AnalyzeMarketCommand.cs` to anchor the changes, then apply edits in groups:
  - **Group A**: Pure SystemPrompt string-literal text edits (lowest risk).
  - **Group B**: Recommendation-contract change + acknowledged-warning section + DTO field additions (must be `nullable`).
  - **Group C**: New `AppendEventWindowBudget` helper + call site between `AppendVolatilityScale` and `AppendBarPositionGuidance`.
  - **Group D**: Engine guards inside `FilterViableForSignals` — extend signature with optional params (`upcomingEvents`, `timeframe`, `volumeProfile`, `liquidityHeatmap`, `footprint`, `candleList`), then update the production call site (around line 913).
- Build verification after every group: `dotnet build LascodiaTradingEngine.Application/LascodiaTradingEngine.Application.csproj -nologo --no-restore`.
- Final verification: `dotnet build LascodiaTradingEngine.UnitTest/LascodiaTradingEngine.UnitTest.csproj` — AnalyzeMarket-related tests must pass; pre-existing unrelated failures are tolerated.

The subagent must NOT:

- Rename existing reason codes or DTO fields.
- Remove the high-confidence bypass (new HARD reach cap supersedes it for the soft TargetUnreachable case only).
- Modify the EXIT_INSTRUCTIONS contract.
- Touch files outside `AnalyzeMarketCommand.cs` except where the DTO definition lives (find via grep).

### 7. Update memory

If the workflow surfaced any _new_ failure modes (i.e., codes not in the canonical enum above), or recurring rhetorical phrases that didn't appear in prior runs, save them as a `project` memory under the auto-memory directory so future passes can use them as priors. Update [project_spot_analysis_failure_modes.md](../../../../../.claude/projects/-Users-olabodeolaleye-Developments-Software-Projects-personal-Lascodia-Trading-Engine-lascodia-trading-engine-admin-ui/memory/project_spot_analysis_failure_modes.md) (create on first run; add `MEMORY.md` pointer then).

Memory body should be terse:

- New failure modes observed (with definition + example signal IDs)
- New W-codes added to ACKNOWLEDGED-WARNING DISCIPLINE (if any)
- New reason codes added to FilterViableForSignals (if any)

Do NOT save: per-signal counts (those change every run), specific signal IDs as historical state (they're in the docs/), or generic descriptions of what the skill does.

### 8. Final user-facing summary

End with a short report (≤ 5 sentences):

```
Reviewed N signals in <window>. Verdicts: A agree / P partial / D disagree. Outcomes: TP/SL/Expired/Rejected.
Top failure modes: pattern1 (Nx), pattern2 (Nx), pattern3 (Nx).
Findings: docs/spot-signals-review-<window>.md
Applied: K prompt edits + M engine guards. Build: clean.
Workflow run: <runId>.
```

If `dry-run`, replace the "Applied" line with `Dry-run — no engine edits applied. Re-run without dry-run to apply.`.

## Pairing with /loop

`/loop spot-review every 7d` for weekly periodic improvement (cloud schedule recommended at this cadence). `/loop spot-review every 24h` for tighter feedback during active LLM tuning.

The skill itself is **one pass and stops** — never recurse internally. `/loop` owns the cadence. Each pass is idempotent: running twice over the same window writes the doc twice (with the same name → overwrites) and proposes a fresh set of edits (the second pass should produce far fewer edits if the first one actually fixed the patterns).

## Hard rules

- **Never** apply prompt or guard edits without first writing the findings document — the doc is the record of what motivated each edit. If the doc-write fails, abort before touching code.
- **Never** delete or rename existing reason codes; only ADD new ones. Old reason codes are part of the analytics surface.
- **Never** weaken existing gates. The skill only adds; the existing soft/hard gates stay intact.
- **Always** make new DTO fields nullable so existing callers/tests compile.
- **Always** verify the build before declaring success. A non-compiling engine is worse than no improvement.
- **Always** keep the workflow scope to one pass. If the workflow result somehow returns 0 reviews (e.g. all subagents died), report the failure and exit — do not retry inside the skill.

## On failure modes

- Workflow runs out of token budget mid-review → report partial count; the subagent applies edits based on what completed; note the truncation in the findings doc.
- DTO parse extension fails → roll back the contract change in the prompt to preserve forward-compat with existing prod signals; keep the other prompt edits.
- A guard's `recommended_call_site` references code that no longer exists (refactor since last pass) → flag in the report, apply the rest, leave the missing guard as a TODO comment in the findings doc.
- Build fails after edits → the subagent must report the error and revert the offending file changes via `git checkout HEAD -- <file>`. Do NOT leave the engine in a non-compiling state. Then report which group of edits failed and stop; the user can re-run with `dry-run` to inspect proposals.

## What this skill builds on

- The first end-to-end run on 2026-06-19 produced [docs/spot-signals-review-2026-06-19.md](../../../../lascodia-trading-engine/docs/spot-signals-review-2026-06-19.md) and the 8 prompt edits + 8 engine guards already in `AnalyzeMarketCommand.cs`. Reference that doc as the template for output formatting and the 8 + 8 set as the canonical "first wave" of fixes.
- Each subsequent pass should produce SHORTER findings docs (the dominant patterns from the prior pass should be gone or weakened). If a pattern persists in count across passes, the existing fix is not working — flag it explicitly in the executive summary so the user knows to investigate.

## Quick reference: minimal manual invocation

```bash
# 1. Confirm preflight
curl -sf -o /dev/null -w "engine: %{http_code}\n" http://localhost:5081/health
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -tAc "SELECT 1;"

# 2. Scope query (example: today)
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -c "
SELECT \"Id\", \"Symbol\", \"Direction\", \"EntryPrice\", \"StopLoss\", \"TakeProfit\",
       \"Confidence\", \"Status\", \"GeneratedAt\", \"LlmInvocationId\"
FROM \"TradeSignal\"
WHERE \"Source\" = 'SpotAnalysis'
  AND \"GeneratedAt\"::date = current_date
ORDER BY \"GeneratedAt\" DESC;"

# 3. Build verify after edits
cd "/Users/olabodeolaleye/Developments/Software Projects/personal/Lascodia Trading Engine/lascodia-trading-engine" && \
  dotnet build LascodiaTradingEngine.Application/LascodiaTradingEngine.Application.csproj -nologo --no-restore 2>&1 | tail -4
```
