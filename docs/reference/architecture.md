# Architecture

## Overview

ID Agents has three layers:

```
Interactive CLI → Manager → Agent Processes
```

### 1. Manager (`src/agent-manager-db.ts`)

The central process running on port 4100 (configurable via `--port` or `MANAGER_PORT`).

**Responsibilities:**
- Stores agent state in the database (SQLite or PostgreSQL)
- Handles the `/remote` API for programmatic access. Historical standalone mode
  remains loopback/header based; managed IDACC requires the supervisor
  administrator credential.
- Serves read-only library inventory via `/library/agents` and `/library/skills`
- Routes fire-and-forget messages between agents via `/message`
- Spawns and stops agent processes
- Manages onchain ENS registration via id-cli
- Runs health checks every 30 seconds (marks agents online/offline)
- Serves the `/agents` list with health status
- Owns the scheduling system (heartbeat + calendar)

**Key endpoints:**
- `GET /health` — Manager health check
- `GET /agents` — List all agents with health status
- `GET /library/agents` — List library agent entries from `configs/agents/`
- `GET /library/skills` — List standalone skill entries from `configs/skills/`
- `POST /remote` — Execute CLI commands programmatically (administrator-only in managed mode)
- `POST /message` — Fire-and-forget agent-to-agent messaging (administrator-only in managed mode)

### 2. Agent Processes (`src/local-agent-server.ts` + `src/agent-rest-server.ts`)

Each agent runs as a separate Node.js process with its own Express server on a dynamically assigned port (4101+, sequential).

**Responsibilities:**
- Hosts REST-AP endpoints (`/talk`, `/talk-to`, `/news`, `/health`)
- When a message arrives on `/talk`, spawns an LLM session to process it
- Stores replies in an in-memory news feed (backed by database)
- Serves `/.well-known/restap.json` for discovery

**REST-AP endpoints per agent:**
- `POST /talk` — Send a message (triggers LLM processing)
- `POST /talk-to` — Synchronous agent-to-agent communication (blocks until reply, localhost only)
- `POST /schedule` — Receive manager-owned scheduled work (internal, with `noAutoReply`)
- `GET /news` — Poll for replies (free, no LLM cost)
- `GET /health` — Agent health check
- `GET /.well-known/restap.json` — Service discovery catalog
- `PATCH /catalog` — Update agent catalog metadata
- `PATCH /identity` — Update agent's onchain identity (called by manager)

### 3. Interactive CLI (`src/interactive-agent-cli.ts`)

The user-facing terminal interface.

**Responsibilities:**
- Connects to the manager on startup (auto-starts it if not running)
- Provides commands: `/ask`, `/deploy`, `/sync`, `/agents`, `/status`, `/register`, etc.
- Polls agent news feeds for replies
- Manages agent lifecycle (deploy, sync, rebuild, delete)
- `/deploy` for clean/first-time deploys; [`/sync`](../guides/sync-command.md) for updating running teams (preserves sessions)
- Supports `--dry-run` on both `/deploy` and `/sync` for preflight without creating agents

## Message Flow

```
User types: /ask coder hello

1. CLI resolves "coder" → finds agent on port 4101
2. CLI → POST http://localhost:4101/talk {"message": "hello"}
3. Agent queues the request and returns 202 with query_id
4. Agent spawns an LLM session through the configured runtime harness (`claude-agent-sdk`, `claude-code-cli`, `claude-code-local`, `codex`, or `cursor-cli`)
5. LLM processes the message, generates a reply
6. Reply stored in agent's news feed
7. Agent auto-sends reply to the CLI's /news endpoint
8. Reply displayed to user
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `teams` | Team isolation (default: default) |
| `agents` | Agent state — name, port, status, registry (ENS domain), metadata |
| `news_items` | Async message feed per agent (with timestamps for polling) |
| `queries` | Query tracking for reply routing between agents |
| `wallets` | Deprecated legacy table; managed wallet keys live in the OWS vault, never in per-agent env |

## Key Source Files

| File | Purpose |
|------|---------|
| `src/agent-manager-db.ts` | Manager — routes, DB, spawning, registration, health checks |
| `src/agent-rest-server.ts` | Preferred runtime-neutral entry point for the per-agent REST server |
| `src/agent-rest-server.ts` | Runtime-neutral per-agent REST server export used by manager and local workers |
| `src/claude-agent-server.ts` | Compatibility export layer for older imports of the agent REST server |
| `src/local-agent-server.ts` | Agent process bootstrap and CLI arg parsing |
| `src/interactive-agent-cli.ts` | User-facing CLI |
| `src/config-parser.ts` | YAML config parsing, parameter substitution, runtime-aware template loading |
| `src/runtime/registry.ts` | Runtime registry: defaults, labels, auth/preflight, session policy, `getRuntimePaths()` |
| `src/protocol-defaults.ts` | Framework protocol defaults prepended to every agent's personality file |
| `src/onchain/idchain-register.ts` | ENS registration via id-cli |
| `src/core/agent-identifier.ts` | ENS name parsing and display |
| `src/db.ts` | PostgreSQL schema, migrations, connection pool |
| `src/inter-agent-skill.ts` | Inter-agent communication skill injection |
| `src/xmtp/xmtp-messaging.ts` | XMTP encrypted messaging — allowlist, ENS resolution, approval callbacks |
| `src/xmtp/ows-signer.ts` | OWS-backed XMTP signer — key never leaves vault |
| `src/harness/claude-code-cli.ts` | Claude Code CLI harness for spawning LLM sessions |
| `src/harness/codex.ts` | Codex CLI harness for spawning Codex sessions |
| `src/harness/cursor-cli.ts` | Cursor Agent CLI harness for spawning Cursor sessions |

## Agent Instructions: Two Sources

Every agent's personality file is composed from exactly two sources:

1. **Protocol defaults** (`src/protocol-defaults.ts`) — framework-managed rules injected into every agent automatically: scheduling awareness, task-discipline lifecycle, output convention.
2. **Agent role file** — role-specific personality editable by the user. Located in the runtime-appropriate template directory.

The YAML config provides infrastructure only: name, workingDirectory, model, runtime, heartbeat, skills. No `claudeMd` field.

### Runtime-Aware Paths

All template and skill operations use `getRuntimePaths(runtime)` from `src/runtime/registry.ts`:

| Runtime | Template Directory | Personality File | Skills Directory |
|---------|-------------------|-----------------|-----------------|
| `claude-code-cli` | `.claude/agents/` | `.claude/CLAUDE.md` | `.claude/skills/` |
| `claude-agent-sdk` | `.claude/agents/` | `.claude/CLAUDE.md` | `.claude/skills/` |
| `codex` | `.agents/` | `AGENTS.md` (project root) | `.agents/skills/` |
| `cursor-cli` | `.cursor/agents/` | `AGENTS.md` (project root) | `.cursor/skills/` |

### Spawn Order

All four spawn paths (deploy, sync-changed, sync-added, remote-deploy) follow the same order:

1. Deploy team-level skills to the runtime-aware skills directory
2. Overlay agent directory template (if it exists) to the runtime-aware config directory
3. Write personality file with protocol defaults + role body to the runtime-aware path

This ensures agent-specific files overlay team skills, and the personality file is always written last.

## Onchain Identity

Each agent can register on ID Chain for a verifiable ENS name:

1. `/register <agent>` calls `id-cli register` → gets `agent-N.xid.eth`
2. Automatically creates a subname: `<alias>.agent-N.xid.eth`
3. The `tokenId` is the bytes32 namehash of the full ENS name
4. Identity persisted in YAML config (`domain`, `tokenId`, `address` fields)

## Health Monitoring

The manager pings each agent's `/health` endpoint every 30 seconds:
- **online** — agent responded within 3 seconds
- **offline** — agent did not respond
- **unknown** — not yet checked

Health status is visible in `/agents` response and `/status` CLI command.

## Inter-Agent Communication

**`/talk-to` (primary, synchronous):** Agents call `/talk-to` on their own port (`localhost:$ID_AGENT_PORT/talk-to`) to send a message and block until a reply arrives. This is the primary inter-agent endpoint. Agents must use `curl` via the Bash tool — not SendMessage or built-in Claude Code tools.

**`/message` (fire-and-forget):** One-way notification routed through the manager. No reply is returned. Use for FYI messages only.

### Loop Prevention

Triggered messages (from schedules, heartbeats) include a `noAutoReply` flag. When set, the agent's response is stored in its own news feed rather than auto-replying to the sender. This prevents infinite loops.

## XMTP Messaging Subsystem

Each agent can optionally run an XMTP client for end-to-end encrypted messaging with external agents and users.

### Components

| File | Purpose |
|------|---------|
| `src/xmtp/xmtp-messaging.ts` | Core messaging class — inbound/outbound handling, sender allowlist, ENS resolution, approval callbacks |
| `src/xmtp/ows-signer.ts` | OWS-backed XMTP signer — delegates all signing to `ows sign message`, private key never leaves vault |
| `src/agent-rest-server.ts` | Per-agent XMTP lifecycle entry point, `/xmtp/send` and `/xmtp/status` endpoints |
| `skills/xmtp/SKILL.md` | Agent skill for sending XMTP messages via curl |

### Architecture

```
┌─────────────────────────────────────────┐
│             Agent Process               │
│                                         │
│  ┌──────────────┐   ┌───────────────┐   │
│  │  Express API  │   │ XmtpMessaging │   │
│  │              │   │               │   │
│  │ /xmtp/send ──┼──▶│ sendMessage() │   │
│  │ /xmtp/status │   │               │   │
│  │              │   │ handleInbound()│──▶│──▶ startQuery() ──▶ LLM
│  └──────────────┘   │               │   │
│                     │  OWS Signer   │   │
│                     │  Allowlist    │   │
│                     └───────┬───────┘   │
│                             │           │
└─────────────────────────────┼───────────┘
                              │
                    ┌─────────▼─────────┐
                    │   XMTP Network    │
                    │  (MLS encrypted)  │
                    └───────────────────┘
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/xmtp/send` | POST | Send encrypted message to ENS name or wallet address |
| `/xmtp/status` | GET | Check if XMTP is enabled, get agent's wallet address |

### Startup

XMTP starts automatically during agent boot when an OWS wallet is available (`OWS_WALLET` env var). The startup sequence:

1. Dynamic `import()` of `xmtp-messaging.ts` (avoids loading native bindings when XMTP not configured)
2. Create `XmtpMessaging` instance with OWS wallet signer
3. Resolve stable storage from the immutable agent ID: the selected IDACC
   profile for managed workers, or the historical HOME location for standalone
   use
4. Load persisted allowlist from `allowlist.yaml`
5. Load or auto-generate DB encryption key (`db.key`)
6. Set message handler that routes inbound messages through `startQuery()` with `noAutoReply: true`
7. Start XMTP agent and begin listening

Startup and shutdown are serialized. A worker that stops while the SDK or its
dynamic import is still starting waits for that exact attempt to settle and
stops the resulting client, so redeploys cannot leave an unowned XMTP stream.
At most eight inbound XMTP turns may be active or queued at once; excess
messages are dropped before allocating another model turn. Payloads larger
than 24 KiB of UTF-8 text are rejected before prompt construction. A
one-minute sliding window admits at most four turns from one sender and 16
turns globally per agent, with bounded sender-history retention; capacity
recovers automatically as admissions leave the window. Every admitted
external turn has a prompt-independent four-minute execution deadline, is
cancelled without retry when that deadline expires, and releases its queue and
XMTP admission slots through terminal cleanup.

### Data Storage

Managed IDACC keeps XMTP data under the selected application profile, separated
by immutable agent ID and signer address. Standalone Manager retains
`~/.xmtp/{address}/`. Both locations are outside project repositories and the
immutable application/runtime bundle:

| File | Purpose |
|------|---------|
| `{env}.db3` | Encrypted MLS database (message history, conversation keys, identity) |
| `db.key` | Auto-generated DB encryption key (mode 0600), persists across restarts |
| `allowlist.yaml` | Sender allowlist with addresses and optional ENS names |

Existing HOME-owned OWS state is copied through a bounded, no-follow migration
on first managed use; the source is retained for rollback. Legacy raw-key SDK
databases are migrated only when the exact inbox database and its encryption
mode can be identified coherently. Ambiguous, linked, or incomplete sources
fail closed rather than creating a new identity silently.

### Runtime Session Continuity

Conversation ownership is not stored in the application bundle, a source
checkout, or the consumer's HOME. Managed workers retain a bounded
conversation-to-runtime-session ledger at:

`<profile>/manager/runtime-sessions/agents/<immutable-agent-key>/conversation-sessions.json`

The optional agent-only `identityKey` is the declarative anchor used to select
that immutable database owner during deploy and sync. Keeping the key unchanged
allows a YAML `name` rename without replacing the row or detaching its history;
duplicate, ambiguous, or key/name-colliding matches fail before reconciliation.

The ledger is owner-only, bounded to 500 conversations, and rewritten
atomically without following links. A restart reloads it before accepting work.
On the first upgrade from a memory-only release, Manager seeds only completed
session IDs from query rows belonging to the exact team and immutable agent ID;
historical external XMTP sessions are excluded. The profile ledger then remains
authoritative even after query retention. Unknown caller-supplied runtime IDs
are never passed to a provider.

Turns that resolve to the same conversation or provider session run serially.
Different conversations can still use a lead's configured parallel capacity.
`POST /clear` durably writes an empty ledger, and a content-filter failure
durably removes only the affected conversation.

### Managed Codex Storage

Managed Codex workers never execute directly from the consumer's global
`CODEX_HOME`. The global home is an authentication source only. IDACC creates
private, dispatch-scoped configuration containing exactly the modules approved
for that query, and retains resumable session data in stable per-agent profile
storage. Global Codex modules, goals, memories, instructions, and unrelated
session trees are not imported. This prevents a consumer's local configuration
from becoming a hidden application dependency and keeps read-only control
queries from inheriting mutating modules.

### Security Model

**Managed loopback control plane:** `IDACC_ADMIN_TOKEN` enables managed mode and
requires a distinct strong `IDACC_MANAGER_SERVICE_TOKEN`. Manager captures and
removes both roots before any worker spawn. Anonymous callers receive only
REST-AP discovery and minimal readiness/attestation from `/health`; the latter
does not include teams, profiles, agents, queries, or counts.

The IDACC administrator retains the existing loopback, `X-Id-Admin: 1`, and
admin-bearer checks. Brain uses the separate service bearer with
`X-Id-Service: brain` and can only read exact `/teams`, `/agents`, and `/events`
routes. Every Manager-owned worker instead receives an HMAC-derived credential
bound to its durable team ID, immutable agent ID, and current process
generation. Manager verifies that generation from current database metadata
before admitting a callback. Workers can discover their same-team peers,
assert or update only their own startup metadata, publish talk/news,
usage/activity/rate-limit callbacks, and create/claim/complete tasks. All other
Manager routes—including profile-wide query, news, event, library, log, team,
and administrative reads—fail closed. Path and body identities are replaced
with or checked against the authenticated worker, and only the exact durable
query recipient may publish its reply lifecycle.

When `IDACC_ADMIN_TOKEN` is absent, the standalone HTTP contract remains
unchanged.

**Sender allowlist (3-tier):**
- **Trusted** — on the allowlist, auto-accepted, bypasses approval callback
- **Unknown** — not on the allowlist; goes through approval callback (or dropped if closed mode)
- **Blocked** — not on allowlist when in closed mode; silently dropped before content reaches agent LLM

**Closed by default:** agents reject messages from unknown senders unless `openMode: true` is set in config.

**Inbound message isolation:** XMTP messages are treated as untrusted by source,
regardless of their prompt text or `openMode`. They receive no plugins, MCP
servers, or local tools and run only through a provider path that can prove a
text-only capability boundary. Runtimes that cannot enforce that boundary fail
closed with a fixed safety response instead of launching. Claude Agent SDK
turns run in a separate, empty, owner-only directory inside the selected
profile with `settingSources: []`, `persistSession: false`, and an empty tool
set; they cannot load the real workspace, project instructions, prior
sessions, plugins, or MCP servers. Claude CLI variants fail closed because
supported consumer versions do not share one capability-stable isolation
contract. Plain-text Provider API and Ollama turns receive no working-directory
context, enforce the same MCP removal inside each harness, and request no more
than 1,024 completion tokens. `noAutoReply: true` prevents inter-agent reply
loops; the XMTP handler returns only the exact terminal result registered for
that inbound query.

### ENS Resolution

Outbound messages resolve ENS names in two steps:
1. `id-cli info` for `.xid.eth` names (CCIP-Read gateway)
2. `web3.bio` fallback for all other ENS names

## Per-Agent Environment

The manager sets these environment variables for every spawned agent:

| Variable | Description |
|----------|-------------|
| `ID_AGENT_PORT` | Agent's own REST-AP port |
| `ID_AGENT_NAME` | Full agent identity (the onchain domain after registration) |
| `ID_AGENT_ALIAS` | Declarative local alias from the team config |
| `ID_AGENT_ID` | Immutable database identity used to own profile state across rename, port change, and redeploy |
| `ID_TEAM` | Team name |
| `IDACC_DATA_DIR` | Selected writable consumer profile root for generated Manager, session, Codex, and XMTP state |
| `MANAGER_URL` | Manager base URL |
| `ID_AGENT_PROCESS_GENERATION` | Unique identifier for this exact Manager-owned launch |
| `IDACC_MANAGER_AGENT_TOKEN` | Managed mode only: private team-, agent-, and generation-bound Manager callback credential |

Application-specific variables can be declared with the agent's top-level
`env` map. The older `resources.env` location remains supported for compatible
team configs. Values must be strings and keys that control the Manager,
identity, profile, runtime, plugins, MCP, wallets, or XMTP are rejected; the
Manager-owned launch envelope is always authoritative. Per-agent private-key
files are not loaded by the managed consumer runtime.

## Port Map

| Component | Port | Description |
|-----------|------|-------------|
| Interactive CLI | none | Pure client terminal UI; no local HTTP listener |
| Manager | 4100 | Main API, `/remote` endpoint, agent registry |
| Agents | 4101+ | Dynamic per-team range (25 ports per team) |
