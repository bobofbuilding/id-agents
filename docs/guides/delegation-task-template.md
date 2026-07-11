# Delegation Task-Brief Template

Copy-paste-ready template for creating a child `/task` under a team-lead
objective. Companion to [`delegation-runbook.md`](./delegation-runbook.md)
(see its Section 2 for the full field-by-field rationale) — this file exists
so the exact brief shape doesn't have to be re-derived from prose each time.

## Why a strict 7-field brief

`POST /tasks` runs the description through a dispatch-readiness parser.
Missing or mis-labeled fields fail with `task_brief_not_dispatch_ready`.
Use the exact capitalized labels below.

## Template

```bash
curl -s -X POST "$MANAGER_URL/tasks" \
  -H "Content-Type: application/json" -H "X-Id-Team: <your-team>" \
  -d '{
    "title": "<human-readable title>",
    "name": "<kebab-case-unique-name>",
    "from": "<your-lead-agent-id>",
    "description": "Goal ID: <goal_id>\nExpected output: <exact artifact path + what it must contain>\nAcceptance criteria: <checkable, falsifiable conditions — not vague adjectives>\nValidation path: Owning lead reviews the completion; default coder and researcher validate substantial cross-team work.\nOut of scope: <explicit exclusions>\nBacklog policy: <what non-required follow-ups become instead of live work>\nBittrees relevance: <rank>: <one-line reason>"
  }'
```

Field notes:
- `Goal ID:` (not `goal_id` as a JSON key, and not `Goal:`) is the label the
  parser reads.
- `Validation path:` — reuse the exact wording above unless the work is
  genuinely lead-only/self-contained; custom wording has failed parsing.
- `Bittrees relevance:` must carry a rank prefix — `high:` / `medium:` /
  `low:` — omitting it can surface as a missing-field rejection.
- If this is the **second or later child** under the same parent, reference
  the parent with `Related to: #<parentShortId>` rather than a literal
  `Parent task: #<id>` line — a second literal `Parent task:` pointing at an
  already-linked parent has triggered a `duplicate_validator_child_task`
  rejection.
- Avoid repeating a literal filename/path from an unrelated existing task in
  the description — the dedup guard derives a `target` token from plain
  filenames and can produce false-positive `duplicate_scope: goal+target`
  collisions across genuinely unrelated work.

## Worked example

```bash
curl -s -X POST "$MANAGER_URL/tasks" \
  -H "Content-Type: application/json" -H "X-Id-Team: ops-team" \
  -d '{
    "title": "Commit delegation runbook doc to id-agents docs/guides",
    "name": "commit-delegation-runbook-doc",
    "from": "ops-lead",
    "description": "Related to: #0acecef4\nGoal ID: goal_plan_1fgpnd5\nExpected output: docs/guides/delegation-runbook.md added and committed on origin/main.\nAcceptance criteria: New file exists in docs/guides/ on origin/main with a real commit hash; pre-existing unrelated dirty files remain untouched; no push to the upstream remote.\nValidation path: Owning lead reviews the completion; default coder and researcher validate substantial cross-team work.\nOut of scope: Editing the runbook content, touching unrelated dirty files, pushing upstream.\nBacklog policy: Non-required follow-ups become backlog candidates instead of live delegated work.\nBittrees relevance: medium: makes the delegation process durable and discoverable."
  }'
```

This is the actual brief used to produce `delegation-runbook.md` itself
(task `#bfb4417b`, owner `git-manager`, completed and verified live on
`origin/main` via a direct `raw.githubusercontent.com` fetch — not just a
local `git log` check).

## Claim / done flow

```bash
# member claims (flips status todo -> doing, sets ownerName)
curl -s -X POST "$MANAGER_URL/tasks/<name>/claim" \
  -H "Content-Type: application/json" -H "X-Id-Team: <team>" \
  -d '{"agent_id":"<member-agent-id>"}'

# member closes (flips status doing -> done)
curl -s -X POST "$MANAGER_URL/tasks/<name>/done" \
  -H "Content-Type: application/json" -H "X-Id-Team: <team>" \
  -d '{"agent_id":"<member-agent-id>","acceptance_coverage":"<what shipped vs. acceptance criteria>"}'
```

Note: creating a task via `POST /tasks` as a team lead auto-assigns it to
the lead itself by default (`default_owner_routing: configured_team_lead`)
— it does **not** land in `todo` for a member to self-claim. To get a task
genuinely owned by a specific member, either dispatch it via `/talk-to`
with a `task:{title,name}` auto-attach payload (Section 3 of the runbook),
or have the member create-and-self-claim their own task row for the scope
you've handed them.

## Parent close

```bash
curl -s -X POST "$MANAGER_URL/tasks/%23<parentShortId>/done" \
  -H "Content-Type: application/json" -H "X-Id-Team: <team>" \
  -d '{
    "agent_id": "<lead-agent-id>",
    "child_task_refs": ["<done-member-owned-child-1>", "<team>/<cross-team-child>", "#<globally-unique-short-id>"],
    "acceptance_coverage": "<what was delivered against the parent acceptance criteria, citing child evidence>"
  }'
```

`child_task_refs` entries must be `done` **and** owned by a real distinct
team member — an entry owned by the lead itself is rejected even if it is
same-team and genuinely completed work. Legacy `delegated_task_names` and
`child_task_names` payload fields remain accepted for compatibility.
