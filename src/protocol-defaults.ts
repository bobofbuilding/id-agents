// SPDX-License-Identifier: MIT
/**
 * Framework protocol defaults injected into every agent's CLAUDE.md at spawn time.
 *
 * These rules make an id-agents worker different from a plain Claude Code session:
 * scheduling awareness, task-discipline lifecycle, and the output convention.
 * Users never edit these in YAML — they are managed by the framework.
 */

export const PROTOCOL_DEFAULTS = `## Scheduling

This system has a manager-owned scheduler.

Scheduled work may arrive as:
- \`from: "schedule"\` on \`/talk\`
- \`from: "schedule"\` with \`mode: "internal"\` on \`/schedule\`

Treat \`/schedule\` as an internal wake-up / self-directed task trigger, not as a normal external conversation.

When scheduled work arrives:
- inspect the \`schedule\` object for \`id\`, \`kind\`, \`title\`, and \`scheduledKey\`
- treat \`mode: "internal"\` as autonomous work you should begin without framing it as a user request
- do not assume a reply is expected just because scheduled work was triggered
- use the schedule metadata in your reasoning and logs when it is relevant

## Shell And Resource Discipline

Keep shell work bounded to the current agent workspace, \`./memory\`, \`./output\`,
or an explicit project root named in the task brief.

- Prefer \`rg\` and \`rg --files\` over \`find\`, \`grep -R\`, or broad directory walks.
- Do not scan \`/\`, \`/Users\`, \`$HOME\`, parent workspace trees, caches, or app
  support directories to discover files.
- Avoid \`find ... | sort | head\` over broad roots; use a known root, \`-maxdepth\`,
  \`-prune\`, or \`rg --files <root> | head\` instead.
- If needed context is outside your workspace or the task's named project root,
  ask the manager/team for the artifact, memory, or route rather than crawling
  the host filesystem.
- Stop early when a command is not producing task-specific signal. Long scans
  delay replies and can block other agents.

## Task Discipline

Every non-trivial unit of work MUST go through the task lifecycle.

### When a task is required
- Any multi-step work (implement, audit, report, verify, refactor)
- Anything that produces an artifact in \`./output/\`
- Anything taking more than one round of tool use

### When a task is NOT required
- Single-line answers, greetings, simple look-ups
- Work that is already part of an existing task you claimed

### Assigned vs self-initiated work
- **Assigned**: the dispatch brief contains \`task: <name>\` and explicit
  claim/done URLs. The manager has already created the task. Use the
  brief's URLs verbatim — do NOT create a parallel task.
- **Self-initiated**: you discovered the work yourself. Run the full
  lifecycle below (create → claim → do → done).

Creating a parallel task under a different name leaves the dispatcher's
checkin firing against a phantom row. Use the runtime-native installed skill
paths: Codex uses \`.agents/skills/task-discipline/SKILL.md\` and
\`.agents/skills/inter-agent/SKILL.md\`; Claude Code uses the corresponding
\`.claude/skills/...\` paths. The inter-agent skill's "Dispatch brief template"
section contains the full guidance.

### Lifecycle
1. **Create**: \`POST $MANAGER_URL/tasks\` with \`{ title, name, from: "<your-name>" }\`
2. **Claim**: \`POST $MANAGER_URL/tasks/<name>/claim\` with \`{ agent_id: "<your-name>" }\`
   Status flips to \`doing\`.
3. **Work**: Do the work. Write artifacts to \`./output/\`.
4. **Done**: \`POST $MANAGER_URL/tasks/<name>/done\` with \`{ agent_id: "<your-name>" }\`

Every Manager request from a worker must include \`X-Id-Team: $ID_TEAM\`,
\`X-Id-Agent: $ID_AGENT_ID\`, and
\`Authorization: Bearer $IDACC_MANAGER_AGENT_TOKEN\`. The token is private to
this exact worker process; never print, persist, or forward it.
   Status flips to \`done\`.
   If the claim response included \`brain_context\`, include \`used_source_ids\` with any
   Brain source IDs you relied on.
   If \`brain_context.instructions\` was present, include \`used_instruction_ids\`,
   \`ignored_instruction_ids\`, or \`harmful_instruction_ids\` with the relevant
   \`memory:<id>\` instruction IDs; include \`injected_instruction_ids\` when reporting
   ignored instructions so Brain can distinguish "not seen" from "not useful".
5. **Reply**: Include the task name in your response, e.g.
   \`Done. Task: implement-x. Output: ./output/report.md\`

### Failure handling
Mark the task done with a failure note. Never leave a task in \`doing\`.
Other agents reading the task stream need to see a terminal state.

### Naming
Use kebab-case: \`audit-contracts-apr\`, \`review-pr-42\`, \`write-report-q2\`.
Avoid reserved command verbs (delete, deploy, sync, etc.).

### Why this matters
A verifier walking the task stream can see every unit of work, every
artifact, every completion or failure — but only if every agent uses
the system. Your discipline makes the team auditable.

### Orphan cleanup notes
If a cleanup pass closes a checkin or task that should not block
acceptance because another agent's task covers the same work, write
the close note in this exact format:

\`\`\`
closed-by-cleanup: see <implementer-task-name> (uuid <short>)
\`\`\`

## Output Convention

Write any generated files (reports, analysis, code artifacts) to \`./output/\` in your working directory. Other agents can read these artifacts via \`/artifact\`.

## Memory

You have a persistent, file-based memory system at \`./memory/\`. This directory already exists — write to it directly (do not run mkdir or check existence).

Build up this memory over time so future sessions have context about your role, ongoing work, decisions made, and patterns to repeat or avoid.

### Memory horizons (pick one per file)
- **core** — identity, authority, safety constraints, durable user preferences, and operating policy
- **long_term** — validated reusable knowledge, stable decisions, proven skills, and durable outcomes
- **medium_term** — active goals, projects, plans, and coordination context
- **short_term** — task, session, turn, and transient working context

Core constraints outrank the other horizons. Promote information upward only
after it has evidence, validation, and a stable owner. Never promote task-local
chatter, current runtime state, or an unverified observation.

### Memory content types (pick one per file)
- **user** — people you work with, their preferences and roles
- **feedback** — guidance on how to approach work; what to avoid or keep doing
- **project** — active goals, in-flight work, bugs, decisions, deadlines
- **reference** — pointers to external resources, endpoints, contracts

### How to save
Write each memory to its own \`.md\` file in \`./memory/\` with frontmatter:

\`\`\`markdown
---
name: short-kebab-slug
description: one-line summary (used to decide relevance)
metadata:
  type: user | feedback | project | reference
  horizon: core | long_term | medium_term | short_term
  source_ids: []
  reviewed_at: ISO-8601 timestamp or null
---
<body>
\`\`\`

Then add a one-line pointer to \`./memory/MEMORY.md\` (the index).

### When to save
Save when you learn something non-obvious that should persist: a user preference,
a project decision, a constraint, or a confirmed approach. Use short-term only
when working context must survive a session boundary. Do not preserve ordinary
progress chatter or things derivable from the code.

### When to read
Load relevant memories at the start of any non-trivial task. Verify file paths and symbols in memories are still current before acting on them.`;
