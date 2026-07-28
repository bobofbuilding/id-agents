# Manager Polling

How to wait for a `/remote` query (or any in-flight agent work) to complete, the right way and the wrong way.

> **Access boundary:** the raw examples in this document are for a standalone
> Manager or an explicitly authenticated IDACC administrator client. Managed
> workers cannot read Manager `/query`, `/events`, or `/news`; they poll their
> own loopback
> `http://127.0.0.1:$ID_AGENT_PORT/news?query_id=<id>&since_id=0`.
> Brain may read only `/teams`, `/agents`, and `/events` with its separate
> service credential. Use IDACC for managed operator polling; never copy the
> administrator or Brain credential into a worker.

## TL;DR

After dispatching a query via `POST /remote { command: "/ask <agent> ..." }`, the daemon returns `{ queryId, status: "processing" }`. To wait for completion, hit:

```bash
curl -s -H "X-Id-Team: <team>" "http://localhost:4100/query/<queryId>?wait=30"
```

One call. Server holds the connection open until the query reaches a terminal state (`delivered`, `failed`, `cancelled`, `expired`) or the wait timeout elapses. Returns the full result inline including the agent's reply text. No `/news` scraping, no regex on JSON, no burst polling.

## Endpoints

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /query/:id?wait=<seconds>` | Long-poll a single query's status + result | Standalone historical contract; managed administrator only |
| `GET /events?topics=...&since=...` | Stream wakeup-service events (heartbeats, schedules, query state) | Managed administrator, or read-only Brain service |
| `POST /news` | Append-only inbox writes; not for waiting | Managed administrator or authenticated worker callback |
| `GET /news` | Read Manager inbox events (the `cursor` field paginates) | Managed administrator only |

### `GET /query/:id?wait=<seconds>`

Implementation anchor: search `src/agent-manager-db.ts` for
`app.get('/query/:id'`.

- `wait` is clamped to `[0, 30]`. `0` (the default) returns whatever the DB says right now without blocking.
- If the row is non-terminal AND `wait > 0`, the handler registers a single-shot waker against the in-process `queryStatusWaiters` map and races it against a setTimeout. When `completeQueryDelivery` fires (success or failure path) it wakes every registered waiter for that `(team, queryId)` pair, the handler re-reads the DB, and returns.
- Status mapping is external-vocabulary: DB rows are `pending | processing | completed | cancelled | failed | expired`; the response uses `pending | processing | delivered | failed | expired`.

Response shape on success:

```json
{
  "query_id": "query_1777895417695_dygna3g",
  "status": "delivered",
  "agent": "cto",
  "created_at": 1777895417695,
  "completed_at": 1777895775976,
  "result": {
    "result": "<the agent's reply text>",
    "sessionId": "...",
    "messages": ["[Progress] ...", "[Tool] bash", ...]
  }
}
```

`result.result` is the agent's textual reply. `result.messages` is the agent's progress/tool-call trace (useful for debugging, often verbose).

For queries that take longer than 30s, chain calls:

```bash
while :; do
  resp=$(curl -s -H "X-Id-Team: idchain" "http://localhost:4100/query/$QID?wait=30")
  status=$(echo "$resp" | jq -r '.status')
  case "$status" in
    delivered|failed|expired|cancelled) echo "$resp"; break ;;
  esac
done
```

Each iteration is one TCP connection that hangs for up to 30s. No spam. No TIME_WAIT pressure on macOS.

### `GET /events?since=<seq>`

Implementation anchor: search `src/agent-manager-db.ts` for
`WAKEUP SERVICE: GET /events`. Every team-scoped state change carries a
monotonic `seq` so a client can replay from a cursor. Use this when you are
watching multiple queries / tasks / agents at once and want a single call to
surface everything new since the last check.

```bash
LAST_SEQ=0
while :; do
  resp=$(curl -s -H "X-Id-Team: idchain" \
    "http://localhost:4100/events?since=$LAST_SEQ&limit=100")
  echo "$resp" | jq '.events[] | {seq, topic, subject, data}'
  LAST_SEQ=$(echo "$resp" | jq -r '.next_seq')
  sleep 30
done
```

Response shape:

```json
{
  "stream_id": "team_…",
  "events": [
    {
      "seq": 322,
      "team": "idchain",
      "topic": "checkin:due",
      "occurred_at": 1777414948136,
      "actor": "schedule",
      "subject": { "kind": "checkin", "id": "chk_…" },
      "data": {
        "checkin_id": "chk_…",
        "owner": "manager-idchain",
        "linked_task": { "id": "task_…", "name": "fix-…", "status": "doing", "assignee": "cto" },
        "interval_seconds": 600,
        "iteration_count": 117,
        "next_fire_at": 1777415548136,
        "actions": { "inspect": "…", "nudge": "…", "snooze": "…", "close": "…" }
      }
    }
  ],
  "next_seq": 322,
  "latest_available_seq": 322,
  "cursor_reset": false,
  "replay_truncated": false,
  "earliest_available_seq": 1
}
```

`stream_id` is the stable internal team ID. Persist it with `next_seq`: a
different stream ID means the cursor belongs to another team. If a supplied
cursor is ahead of this team's current log, the endpoint returns HTTP 200 with
an empty `events` array, `cursor_reset: true`,
`cursor_reset_reason: "ahead_of_log"`, and `next_seq` rewound to immediately
before the earliest retained event (or `0` when the log is empty). Use that
`next_seq` on the next request. `latest_available_seq` is the unfiltered team
tail, so topic filters do not change cursor-reset detection.

Useful topics:

- `query:received`, `query:delivered`, `query:failed` — agent dispatch lifecycle
- `task:created`, `task:claimed`, `task:done`, `task:removed` — task lifecycle
- `checkin:due` — supervision pings firing on linked tasks
- `agent:started`, `agent:stopped`, `agent:rebuild` — agent lifecycle
  (`agent:lifecycle` is the server-side filter alias for these concrete topics)

Filter with `?topics=task:done,task:claimed` to narrow.

The endpoint returns JSON batches, not `text/event-stream`. For waiting on a
single query, prefer `GET /query/:id?wait=` — it's purpose-built and simpler.

## What NOT to do

### Don't burst-poll `/news` with grep

```bash
# WRONG
for i in $(seq 1 60); do
  sleep 60
  resp=$(curl -s -X POST http://localhost:4100/remote ... -d '{"command":"/news cto"}')
  if echo "$resp" | grep -qE 'in_reply_to.*outbound\.reply'; then break; fi
done
```

Three failure modes:

1. **Brittle regex.** JSON key ordering is not guaranteed across serializers. The grep above looks for `in_reply_to` *before* `outbound.reply`, but the daemon serializes `type:"outbound.reply"` first inside the item object — so this regex never matches and polls always time out.
2. **TIME_WAIT exhaustion.** Each curl is a fresh TCP connection. macOS has ~16k ephemeral ports; a tight burst-poll loop (or many in parallel) can saturate them. The daemon looks down but isn't.
3. **Polling derived state.** `/news` is the inbox event stream; query completion is one event among many. The canonical state is the `queries` table, surfaced by `GET /query/:id`.

### Don't loop on raw SQLite reads from a client

```bash
# Also wrong — fast and direct, but no waiter wakeup, so it has to spin
while ! sqlite3 ~/.id-agents/id-agents.db "SELECT 1 FROM queries WHERE query_id='X' AND status='completed'" | grep -q 1; do
  sleep 5
done
```

This works but spins on the DB regardless of whether anything has changed. The long-poll endpoint already does the right thing: register a waiter, sleep, wake on event. Use the endpoint.

### Don't rely on `/remote /news` per-query

The `/remote` `/news <agent>` command is for browsing an agent's inbox by hand. It's not designed for query-completion waiting. Use `GET /query/:id?wait=`.

## Common patterns

### Dispatch + wait, single query

```bash
QID=$(curl -s -X POST http://localhost:4100/remote \
  -H "X-Id-Team: idchain" -H "Content-Type: application/json" \
  -d '{"command":"/ask cto your prompt here"}' \
  | jq -r '.result.queryId')

curl -s -H "X-Id-Team: idchain" "http://localhost:4100/query/$QID?wait=30" \
  | jq -r '.result.result'
```

For prompts that take longer than 30s, wrap the wait call in a loop that re-issues the long-poll until status is terminal (snippet above).

### Dispatch many queries, gather results

For a fan-out, dispatch each `/ask`, collect the queryIds, then wait on each in sequence (or in parallel via background subshells). Each waiter is one connection; the daemon serves them all without TIME_WAIT pressure because each connection is long-lived.

### Watch all agents' activity (debugging only)

`GET /events?topics=query:delivered,query:failed` for an aggregate view. Suitable for a dashboard, not for waiting on a specific query.

## Maintenance notes

This doc should stay synced with:

- `src/agent-manager-db.ts` route definitions (anchor: search for `app.get('/query/:id'` and `// WAKEUP SERVICE: GET /events`)
- The status vocabulary mapping in the same handler
- Any new wait endpoints added in future slices

When adding a new long-poll surface (e.g., `GET /task/:name?wait=`), update the endpoints table above and call out the difference from `/query/:id?wait=`.

If this doc drifts from the code, the doc is wrong. Cite a durable route or
symbol anchor when fixing it; line numbers become obsolete as the daemon
changes.
