# Claude Code CLI Subscription Rate-Limit Failover

> **Status:** Live as of 2026-07-04. Committed to `id-agents/main`. Rebuild+restart confirmed. Remaining gap: gate #4 live-fire 429 test.

## Overview

When a Claude Code CLI agent hits its subscription session limit, the id-agents manager automatically detects the signal, cools the exhausted credential lane, picks an available metered-API lane, and respawns the agent with the original pending query redelivered — with no manual intervention required.

---

## Detection

### Primary path: structured JSON output

The Claude Code CLI emits NDJSON (newline-delimited JSON) to stdout during normal operation and on error. The detector (`src/harness/rate-limit.ts:detectClaudeCliRateLimit`) scans every JSON line on stdout for any of these signals, in priority order:

| Field(s) checked | Trigger value | Notes |
|---|---|---|
| `api_error_status` or `apiErrorStatus` or `status` or `statusCode` | `429` | HTTP status from the Anthropic API |
| `error` (string) or `error.type` (nested object) | `rate_limit`, `rate_limit_error`, `overloaded_error` | Error type from Anthropic's error envelope |
| HTTP status | `529` | Anthropic API overloaded (treated separately from subscription cap) |

**Example JSON line that triggers detection:**

```json
{
  "is_error": true,
  "api_error_status": 429,
  "result": "You've hit your session limit · resets 10:40am (Europe/Lisbon)"
}
```

**Example stream event (mid-run):**

```json
{
  "type": "error",
  "error": "rate_limit",
  "apiErrorStatus": 429,
  "message": "You've hit your session limit · resets 10:40am (Europe/Lisbon)"
}
```

Both forms produce a `RuntimeRateLimitSignal` with `source: "cli-json-result"` or `source: "cli-stream-event"` respectively.

### Retry-after parsing

If the JSON includes `retry_after`, `retryAfter`, `retry_after_seconds`, or `retryAfterSeconds`, the numeric value is parsed as seconds and stored in `retryAfterSeconds` on the signal. The cooldown window uses this value; if absent, the manager applies exponential backoff.

### Reset time extraction

The `result` or `message` field is scanned for text matching `/resets? ([^\n\r.]+)/i`. If found, the matched string (e.g. `"10:40am (Europe/Lisbon)"`) is stored as `resetText` for observability.

### Fallback: plain text

If no JSON line matches, the detector falls back to a substring check:

```
/You've hit your session limit/i
```

This matches raw stderr or stdout when the CLI does not emit structured JSON. Source is tagged `"text-fallback"`.

### What does NOT trigger this failover

| Signal | Why it does not trigger |
|---|---|
| Raw `anthropic-ratelimit-*` HTTP headers | Not reliable on the CLI subscription path; these come from direct API calls, not the CC CLI wrapper |
| Bare `rate_limit` text in stderr (e.g. `rate_limit: something failed`) | Only structured JSON events and the confirmed session-limit phrase trigger; generic text is ignored |
| Generic process failures (`exitCode: 1` with no matching payload) | Non-zero exit alone is not a rate-limit signal |
| **Codex / ChatGPT usage-limit messages** | Completely different signature — see below |

---

## Codex / ChatGPT Usage-Limit: A Different Signal

Codex-backed agents (running OpenAI's Codex CLI) emit a distinct message when their ChatGPT plan usage cap is reached:

```
You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
to purchase more credits or try again at 9:41 AM.
```

This is detected by the shared rate-limit path even though its evidence differs
from Claude Code:

| Dimension | Claude Code CLI | Codex CLI |
|---|---|---|
| Trigger phrase | `"You've hit your session limit"` | `"You've hit your usage limit"` |
| Reset signal | `retry-after` header or `resets <time>` text | Embedded wall-clock time (`try again at HH:MM AM`) |
| Link | Anthropic console | `chatgpt.com/codex/settings/usage` |
| Status field | `api_error_status: 429` | None (plain text only) |

The Manager records the Codex lane cooldown, parses the retry time when one is
present, and selects an eligible configured runtime or model fallback. It
replays the exact query through that lane and restores the preferred lane after
the cooldown and replay are complete. If no eligible fallback is active, the
agent remains safely cooled until retry rather than silently bypassing the
limit.

---

## Failover Orchestration

### Credential lane model

The manager maintains a pool of `RuntimeCredentialLane` entries, each with:

```yaml
runtimeCredentialPool:
  lanes:
    - id: cc-subscription-primary
      runtime: claude-code-cli
      kind: subscription       # exhausts per session/day/week/month
    - id: cc-metered-overflow
      runtime: claude-code-cli
      kind: metered-api        # billed per token via ANTHROPIC_API_KEY
      env:
        ANTHROPIC_API_KEY: <metered-key>
```

`kind: subscription` lanes are used by default. When one exhausts, the manager looks for the next available `metered-api` lane.

Lane IDs must be unique within one canonical runtime. Distinct canonical
runtimes may reuse a raw ID (for example, `codex` and `claude-code-cli`);
runtime aliases that share a canonical runtime may not
(`claude-code-local` and `claude-code-cli` share the latter namespace).

### Cooldown persistence

Exhausted lanes are recorded in the `runtime_lane_cooldowns` SQLite/Postgres table:

```sql
CREATE TABLE runtime_lane_cooldowns (
  lane_id          TEXT NOT NULL,
  runtime          TEXT NOT NULL,
  runtime_namespace TEXT NOT NULL,
  team_id          TEXT NOT NULL,
  kind             TEXT NOT NULL,
  cooling_until_ms INTEGER NOT NULL,
  ...
  reset_text      TEXT,
  message         TEXT,
  PRIMARY KEY (team_id, runtime_namespace, lane_id)
);
CREATE INDEX runtime_lane_cooldowns_until_idx ON runtime_lane_cooldowns(cooling_until_ms);
```

On startup, the manager prunes expired rows and reloads active cooldowns
(`coolingUntilMs > now`) into a map keyed by the same team, canonical runtime,
and raw lane ID tuple. The table survives restarts.

### Failover sequence (`POST /runtime/rate-limit`)

The CC CLI harness posts a detected rate-limit signal to the manager at:

```
POST http://<manager-host>/runtime/rate-limit
Content-Type: application/json

{
  "rateLimit": { "isRateLimit": true, "status": 429, "reason": "subscription_session_cap_unknown_window", ... },
  "laneId": "cc-subscription-primary",
  "queryId": "<original-query-id>"
}
```

The manager (`handleRuntimeRateLimitFailover`):

1. Records the lane cooldown (upsert into `runtime_lane_cooldowns`).
2. Calls `chooseRuntimeCredentialLane(runtime, currentLaneId, teamId, excludeCurrentLane=true)` — picks the next non-cooling lane.
3. If a metered lane is available:
   - Respawns the agent process with `ID_AGENT_CLAUDE_BARE=1` (maps to `--bare` in `claude-code-cli.ts`) and `ANTHROPIC_API_KEY=<lane key>`.
   - Redelivers the original pending query to the new process, tracking the link via `runtimeFailoverRetryOf` (in-memory map + `queries` table).
4. When the retry query resolves, the result is forwarded back to the original `queryId` caller so the requester sees a transparent response.

### The `--bare` flag

`ID_AGENT_CLAUDE_BARE=1` causes the Claude Code CLI spawn to pass `--bare`, which suppresses the interactive TUI shell and forces machine-readable JSON output. This is required for the metered-API path because the subscription session used by the normal interactive mode is what ran out.

### Lane selection logic

```
chooseRuntimeCredentialLane(runtime, currentLaneId, teamId, excludeCurrentLane):
  lanes = runtimeCredentialLanes(runtime, teamId)        // env override → team config → default
  available = lanes where coolingUntilMs <= now
              and (not excludeCurrentLane OR id != currentLaneId)
  return available[0]   // first available, typically subscription → metered order
```

If no lane is available (all cooling), the failover returns `{ attempted: false }` and the caller must handle backoff.

---

## Reason Classification

The `reason` field on `RuntimeRateLimitSignal` distinguishes between limit types:

| `reason` | Trigger condition |
|---|---|
| `subscription_session_cap_unknown_window` | Message contains `"session limit"` |
| `subscription_daily_cap` | Message contains `"daily"` |
| `subscription_weekly_cap` | Message contains `"weekly"` |
| `subscription_monthly_cap` | Message contains `"monthly"` |
| `api_rate_limit` | `status == 429` and message does not match session/weekly keywords |
| `api_overloaded` | `status == 529` or `errorType == "overloaded_error"` |
| `unknown_rate_limit` | None of the above |

The manager uses `reason` to determine cooldown duration heuristics (session caps cool until the reset time; API rate limits use `retryAfterSeconds`).

---

## Configuration Reference

### Environment variable (runtime override)

```bash
ID_RUNTIME_CREDENTIAL_POOL='[{"id":"cc-sub","runtime":"claude-code-cli","kind":"subscription"},{"id":"cc-api","runtime":"claude-code-cli","kind":"metered-api","env":{"ANTHROPIC_API_KEY":"sk-ant-..."}}]'
```

JSON array; each entry is a `RuntimeCredentialLane`. Takes precedence over team YAML config.

### Team YAML form

```yaml
runtimeCredentialPool:
  lanes:
    - id: cc-subscription-primary
      runtime: claude-code-cli
      kind: subscription
    - id: cc-metered-overflow
      runtime: claude-code-cli
      kind: metered-api
      env:
        ANTHROPIC_API_KEY: ${METERED_ANTHROPIC_API_KEY}
```

Loader order: env override → team config → default (single subscription lane).

---

## Observability

- **Active cooldowns:** `GET /runtime/cooldowns` returns all lanes with `coolingUntilMs > now`.
- **Failover result:** `POST /runtime/rate-limit` response includes `{ ok, cooldown, failover }` — `failover.attempted` indicates whether a respawn was launched.
- **Query linkage:** `runtimeFailoverRetryOf` tracks `retryQueryId → originalQueryId`; the `queries` table stores the link durably.
- **Reset text:** `resetText` (e.g. `"10:40am (Europe/Lisbon)"`) is logged and stored on the cooldown row for ops visibility.

---

## Test Coverage

`tests/unit/rate-limit-detector.test.ts` (14 tests, 2 files — green as of 2026-07-04):

- JSON result with `api_error_status: 429` → session cap detection
- Stream event with `apiErrorStatus: 429` and `error: "rate_limit"` → stream-event detection
- Nested `error.type: "rate_limit_error"` body → API rate limit classification
- Nested `error.type: "overloaded_error"` with HTTP 529 → overload classification
- `retry_after` field parsing → `retryAfterSeconds` on signal
- Plain text `"You've hit your session limit"` in stderr → text-fallback detection
- Bare `rate_limit:` text in stderr → no match (negative)
- Generic process failure (`exitCode: 1`) → no match (negative)
- HTTP 429 + Anthropic reset header → `anthropic-api-headers` source
- `retry-after` seconds take precedence over Anthropic reset headers
- HTTP 529 status alone → overload detection
- HTTP 429 without reset headers → no match (negative)

---

## Troubleshooting

### Expected log and behavior signatures

**Agent subprocess (stdout/stderr):**
```
[Error] You've hit your session limit · resets 10:40am (Europe/Lisbon)
[Claude CLI] Error: api_error_status 429 rate_limit
```

**Manager news feed** (event `type: runtime.rate_limit`):
```json
{
  "type": "runtime.rate_limit",
  "laneId": "cc-subscription-primary",
  "reason": "subscription_session_cap_unknown_window",
  "coolingUntilMs": 1720123456789,
  "resetText": "10:40am (Europe/Lisbon)",
  "queryId": "q_abc123"
}
```

**Manager console:**
```
Runtime lane cc-subscription-primary is cooling until 2026-07-04T10:40:00.000Z (subscription_session_cap_unknown_window)
```

**Successful failover (manager console):**
```
[failover] Rebuilt agent <name> on lane cc-metered-overflow; re-dispatching query q_abc123 → q_xyz789
```

### Check active cooldowns

```bash
curl http://127.0.0.1:4100/runtime/cooldowns
```

Returns `{ cooldowns: [] }` when no lanes are cooling. If a lane appears here, it will not be selected for new runs until `coolingUntilMs` passes.

### Verify metered key is wired

```bash
# Check env var path
echo $ID_AGENT_OVERFLOW_ANTHROPIC_API_KEY

# Or check team config
grep -A8 runtimeCredentialPool configs/default.yaml
```

If no metered key is configured, failover attempts will fail silently — `POST /runtime/rate-limit` will return `{ failover: { attempted: false } }` because `chooseRuntimeCredentialLane` finds no available lane.

### Verify `--bare` is passed on metered runs

```bash
ps aux | grep 'claude --bare'
```

If `--bare` is absent on a `metered-api` lane run, check that `ID_AGENT_CLAUDE_BARE=1` is set in the child env (set by `buildLocalAgentEnv` when `useMeteredOverflow=true`).

### Failover not triggering

| Symptom | Likely cause | Fix |
|---|---|---|
| `failover.attempted: false` | No metered lane in pool or all lanes cooling | Add `metered-api` lane to `runtimeCredentialPool`, or wait for cooldown expiry |
| Agent respawned but still 429 | Metered key invalid or quota exceeded | Rotate `ANTHROPIC_API_KEY` in lane config |
| Detection miss | CC output format changed | Run `tests/unit/rate-limit-detector.test.ts` against latest CC output; update regex in `src/harness/rate-limit.ts` |
| Agent wedged after respawn | `rebuildLocalClaudeAgent` left process in bad state | Check `GET /agents` for agent status; hit `:PORT/health` directly; escalate to operator if it's the primary lead |
| Codex agent limit not failing over | No eligible fallback runtime/model is active | Refresh the configured runtime/model catalog and make at least one fallback lane available; confirmed usage-limit and model-capacity responses are detected and replayed through the shared failover path |

---

## Open Items

| # | Item | Status |
|---|---|---|
| Gate #4 | Deterministic 429/cap detection, cooldown, rebuild, replay, and restoration coverage | Complete; a real-provider live-fire remains an optional credentialed acceptance check |
| Codex lane failover | Detect usage-limit/reset and model-capacity responses, then replay through an eligible runtime/model lane | Complete |
