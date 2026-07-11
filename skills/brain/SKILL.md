---
name: brain
description: Access the ID Agents Brain knowledge graph and your persistent agent memory. Use to search skills by name/domain/tag, traverse skill relationships, store facts between sessions, and recall past context. SkillMesh data is present only when the optional SkillMesh provider is configured. Manage Brain from the [ID Agents Control Center](https://github.com/bobofbuilding/id-agent-control-center).
allowed-tools: Bash
---

# Brain — Knowledge Graph & Agent Memory

Brain runs at `http://127.0.0.1:4200`. All calls are plain `curl`. Your agent ID for memory is your agent name (e.g. `$ID_AGENT_NAME`).

## Skill Graph

### Search skills
```bash
# FTS full-text (ranked by relevance)
curl -s "http://127.0.0.1:4200/graph/nodes?q=gas+estimation&limit=5"

# Filter by domain (oracle|defi|wallet|identity|tokens|compute|infrastructure|security|governance|frontend|zk|cross-chain|knowledge|skills)
curl -s "http://127.0.0.1:4200/graph/nodes?domain=security&limit=10"

# Filter by tag
curl -s "http://127.0.0.1:4200/graph/nodes?tag=audit&limit=10"

# Combine filters
curl -s "http://127.0.0.1:4200/graph/nodes?domain=security&tag=solidity&limit=5"

# Most used skills
curl -s "http://127.0.0.1:4200/graph/nodes?sort=popular&limit=10"

# All domains with counts
curl -s "http://127.0.0.1:4200/graph/domains"
```

### Get a skill by ID (includes neighbor list)
```bash
curl -s "http://127.0.0.1:4200/graph/nodes/42"
# → { node: { skillId, name, ..., neighbors: [{skillId, kind, weight}] } }
```

### Find related skills
```bash
curl -s "http://127.0.0.1:4200/graph/nodes/22/neighbors?kind=related"
```

### Track skill usage (increments popularity counter)
```bash
curl -s -X POST http://127.0.0.1:4200/graph/nodes/42/use
```

### Stats — most connected and most used skills
```bash
curl -s http://127.0.0.1:4200/graph/stats
# → { nodes, edges, memories, domains, topUsed, topLinked, topAgents }
```

### Per-skill execution stats (avg duration, settle rate, recent runs)
```bash
curl -s "http://127.0.0.1:4200/graph/nodes/42/stats"
# → { executions, settleRate, avgDurationMs, avgPayoutWei, recent[] }
```
Check this before chaining a skill — slow or low-settle-rate skills should be deprioritized.

### Find shortest path between two skills
```bash
# Useful for understanding how two skill domains connect
curl -s "http://127.0.0.1:4200/graph/path?from=22&to=82"
# → { path: [{skillId, name, ...}, ...], found: true, length: 3 }
```

### Get ranked skill recommendations for a task
```bash
# Scores by FTS match + tag overlap + neighbor expansion + usage popularity
curl -s -X POST http://127.0.0.1:4200/graph/recommend \
  -H "Content-Type: application/json" \
  -d '{
    "q": "gas price estimation and transaction timing",
    "tags": ["gas", "oracle"],
    "agentId": "'"$ID_AGENT_NAME"'",
    "domain": "compute",
    "limit": 8
  }'
# → { skills: [{skillId, name, score, ...}] }
```

### Track that you used a skill (improves future recommendations)
```bash
curl -s -X POST http://127.0.0.1:4200/graph/nodes/$SKILL_ID/use

# Also store in your memory for neighbor-boost signal
curl -s -X POST "http://127.0.0.1:4200/memory/$ID_AGENT_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"used-skill-$SKILL_ID\",\"content\":\"used skill $SKILL_ID\",\"tags\":[\"usage\"]}"
```

### Add or update a skill (bulk / atomic with edges)
```bash
# Atomic node + related edges
curl -s -X POST http://127.0.0.1:4200/graph/sync \
  -H "Content-Type: application/json" \
  -d '{"skillId":94,"name":"New Skill","description":"...","domain":"compute","tags":["example"],"computeCost":10,"chainable":true,"related":[60,61]}'
```

## Agent Memory

Persistent across sessions. Supports keyed (updatable), unkeyed (journal), shared (cross-agent), and TTL-expiring memories.

### Store a memory
```bash
# Keyed — overwrites on same key
curl -s -X POST "http://127.0.0.1:4200/memory/$ID_AGENT_NAME" \
  -H "Content-Type: application/json" \
  -d '{"key":"last-audit","content":"Audited skills 59-93. All pass.","tags":["audit"]}'

# Unkeyed journal entry
curl -s -X POST "http://127.0.0.1:4200/memory/$ID_AGENT_NAME" \
  -H "Content-Type: application/json" \
  -d '{"content":"Gas spike at 14:22 UTC. Alerted gas-oracle.","tags":["gas","observation"]}'

# Shared — readable by all agents via /memory/shared
curl -s -X POST "http://127.0.0.1:4200/memory/$ID_AGENT_NAME" \
  -H "Content-Type: application/json" \
  -d '{"key":"gas-alert","content":"Gas at 120 gwei","tags":["gas"],"shared":true}'

# Ephemeral — auto-deleted after ttl seconds
curl -s -X POST "http://127.0.0.1:4200/memory/$ID_AGENT_NAME" \
  -H "Content-Type: application/json" \
  -d '{"key":"rate-limit","content":"paused until 15:00","tags":["ops"],"ttl":600}'
```

### Recall memories
```bash
# Recent (paginated)
curl -s "http://127.0.0.1:4200/memory/$ID_AGENT_NAME?limit=10&offset=0"

# By tag
curl -s "http://127.0.0.1:4200/memory/$ID_AGENT_NAME?tag=audit"

# Full-text search (content + key + tags)
curl -s "http://127.0.0.1:4200/memory/$ID_AGENT_NAME/search?q=gas+spike"

# Direct key lookup
curl -s "http://127.0.0.1:4200/memory/$ID_AGENT_NAME/last-audit"

# Cross-agent shared memories
curl -s "http://127.0.0.1:4200/memory/shared?tag=gas"
curl -s "http://127.0.0.1:4200/memory/shared?q=alert"
```

### Delete a keyed memory
```bash
curl -s -X DELETE "http://127.0.0.1:4200/memory/$ID_AGENT_NAME/last-audit"
```

## Health check
```bash
curl -s http://127.0.0.1:4200/health
# → {"ok":true,"nodes":93,"edges":336,"memories":N,"fts":true}
```

### Compose an ordered skill execution chain for a goal
```bash
curl -s -X POST http://127.0.0.1:4200/graph/compose \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "audit smart contract for vulnerabilities",
    "agentId": "'"$ID_AGENT_NAME"'",
    "maxSteps": 6,
    "maxCost": 400,
    "mustInclude": [82],
    "domain": "security"
  }'
# → { chain: [{step,skillId,name,computeCost,chainable},...], totalCost, valid, warnings }
```

### Summarize old journal memories (call when > 100 unkeyed entries)
```bash
# Dry-run: see how many would be summarized
curl -s -X POST "http://127.0.0.1:4200/memory/$ID_AGENT_NAME/summarize" \
  -H "Content-Type: application/json" \
  -d '{"olderThanDays":7,"dryRun":true}'

# Get content to summarize (deletes the old entries)
SUMMARY_DATA=$(curl -s -X POST "http://127.0.0.1:4200/memory/$ID_AGENT_NAME/summarize" \
  -H "Content-Type: application/json" \
  -d '{"olderThanDays":7,"keepCount":20}')
# Then: summarize $SUMMARY_DATA.content with your LLM and POST back as keyed memory

# Prune without summarizing (delete entries older than 30 days)
curl -s -X DELETE "http://127.0.0.1:4200/memory/$ID_AGENT_NAME/_old?olderThanDays=30"
```

## Shared memory — fleet-wide standard keys

Several agents publish their core output as shared memory so other agents can read instead of re-fetching. **Always check shared memory before doing external fetches.**

### Standard producers (you write these if you're this agent)

| Producer | Key | Content | TTL |
|---|---|---|---|
| `market-parser` | `market:ETH-USD` | Latest ETH/USD price + 24h delta | 300s |
| `gas-oracle` | `gas:current` | Sepolia gas price + recommended wait window | 60s |
| `alchemy-agent` | `prices:<TOKEN>` | Per-token spot prices | 300s |
| `protocol-monitor` | `protocol:status` | Contract liveness + last block | 600s |
| `settlement-watcher` | `escrow:stalled` | List of stalled session IDs | 300s |
| `wallet-guardian` | `wallets:low` | Agents below 0.005 ETH threshold | 3600s |
| `api-monitor` | `health:skillmesh` | API endpoint status summary | 120s |
| `event-watcher` | `events:recent` | Last 10 on-chain events (skillmesh contracts) | 120s |
| `chain-analyst` | `analysis:<txHash>` | Decoded calldata + interpretation | 86400s |

**If you produce one of these signals as part of your work, write it to shared memory:**

```bash
curl -s -X POST "http://127.0.0.1:4200/memory/$ID_AGENT_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"market:ETH-USD\",\"content\":\"$ETH_PRICE_USD\",\"tags\":[\"market\",\"price\"],\"shared\":true,\"ttl\":300}"
```

### Standard consumers (check shared memory before fetching)

```bash
# Before fetching ETH price externally, check shared memory:
PRICE=$(curl -s "http://127.0.0.1:4200/memory/shared?tag=market&limit=5" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); [print(m['content']) for m in d['memories'] if 'ETH-USD' in (m.get('mem_key') or '')]" | head -1)

# Before re-checking gas, see if there's a recent quote:
GAS=$(curl -s "http://127.0.0.1:4200/memory/shared?tag=gas" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['memories'][0]['content'] if d['memories'] else '')")

# Freshness check: if shared memory exists, skip external fetch
[ -n "$GAS" ] && echo "using shared gas: $GAS" || echo "fetching fresh gas..."
```

### Reading specific producer keys directly
```bash
# Faster than /memory/shared scan when you know the exact key:
curl -s "http://127.0.0.1:4200/memory/gas-oracle/gas:current"
curl -s "http://127.0.0.1:4200/memory/market-parser/market:ETH-USD"
```

### Why this matters
- 27+ agents on the team. Without shared memory, each one independently hits Alchemy/Etherscan for the same data.
- TTL controls freshness — gas data is stale at 60s, market prices at 5min, wallet balances at 1h.
- Brain timeline records every shared write — you can audit which agent produced which signal.

## Task completion provenance

When you claim a task, the manager automatically attaches `brain_context`. Read it from your own task before starting work:

```bash
curl -s "$MANAGER_URL/tasks/<ref>"
# → { task: { brain_context: { cited: { canonical_source_ids: [...] }, instructions: [...] } } }
```

When marking the task done, cite only the Brain context you actually relied on. Use source, fact, and memory IDs from `brain_context.cited.canonical_source_ids` in `used_source_ids`; use applied `memory:<id>` entries from `brain_context.instructions` in `used_instruction_ids`. Include `ignored_instruction_ids` or `harmful_instruction_ids` when applicable.

```bash
curl -s -X POST "$MANAGER_URL/tasks/<ref>/done" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "'"$ID_AGENT_NAME"'",
    "used_source_ids": ["fact:123", "memory:456"],
    "used_instruction_ids": ["memory:456"],
    "ignored_instruction_ids": ["memory:789"],
    "harmful_instruction_ids": []
  }'
```

## When to use brain

- **Required for submissions and contribution intake** — before accepting, rejecting, routing, or summarizing a submission/proposal/contribution, recall related Brain context and store durable outcomes back to Brain.
- **Required for knowledge/material calls** — when asked what is known, what was learned, what sources say, or how material maps to active goals, query Brain first and cite `used_source_ids`.
- **Required for skills/capability calls** — before recommending, composing, auditing, or invoking skills/tools/MCP/plugins/capabilities, use `/graph/recommend`, `/graph/nodes`, `/graph/compose`, or related graph endpoints and track selected skill usage.
- **Before starting a task** — search skills by keyword/domain/tag to find what's available.
- **After completing a task** — store what you learned (key="last-X") so you don't repeat work.
- **When building a multi-skill workflow** — use neighbors to find complementary skills.
- **When you need cross-agent context** — read `/memory/shared` for signals other agents published.
- **For ephemeral rate-limit / lock state** — store with `ttl` so it auto-clears.

## Memory routing — Brain vs local memory

Two persistent memory systems exist. Route to the right one:

| Situation | Store |
|---|---|
| Knowledge other agents may reuse (facts, research, signals, sourced findings) | **Brain** (`POST /memory/$ID_AGENT_NAME`) |
| Cross-agent real-time signal (price, gas, liveness) | **Brain shared** (same endpoint + `"shared": true`) |
| Agent-private behavioral context (preferences, durable operating rules, long-term personal context) | **Local `./memory/` files** (Claude Code `Write` tool) |
| Task noise, ephemeral state, secrets | **Neither** — do not persist |

**When to pick Brain:** the knowledge is sourced from research or tooling, another agent might need the same fact, or it should survive team restructuring.

**When to pick local memory:** private to this agent's behavior only — no other agent needs it, and it is not source-grounded data.

**Avoid duplicate writes:** search shared memory (`GET /memory/shared?q=…`) before posting a new fact another agent may have already published. Same signal under a different key is still a duplicate.
