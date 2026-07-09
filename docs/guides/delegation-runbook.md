# Primary-Lead / Team-Lead Delegation Runbook

Repeatable process for decomposing remaining work, creating child tasks,
collecting validation packets, and closing parent tasks with delegated
child task names. Written for goal `goal_plan_1fgpnd5`, generalizes to any
team-lead-owned objective in this fleet. Grounded in live-verified manager
API behavior — see `primary-lead-delegation-audit.md` for the underlying
evidence and bottlenecks found while producing this runbook.

## 0. Roles this runbook assumes

- **Primary lead** (`default/lead`) — receives scoped objectives from the
  operator, delegates ONLY to team leads (`ops-lead`, `engineering-lead`,
  `general-counsel`, `skillmesh-ops-lead`, `research-lead`,
  `security-router`). Never hands execution to its own default-team
  `coder`/`researcher` — those are validators, not executors.
- **Team lead** (e.g. `ops-lead`) — decomposes its objective into
  member-owned child tasks, delegates in parallel, coordinates, validates,
  and closes with `child_task_names`/`delegated_task_names`.
- **Team member** (e.g. `task-master`, `deployer`, `git-manager`,
  `content-moderator`, `content-ops`) — claims and executes one child
  task's concrete scope.
- **Default-team validators** (`default/coder`, `default/researcher`) —
  receive every completed cross-team packet, validate implementation vs.
  evidence/policy fit, combine, and relay up to the primary lead. Rework
  goes back to the owning team lead, not straight to the primary lead.

## 1. Decompose the remaining work

Before creating any task, split the objective into **independent** slices
with distinct outputs. A slice is independent if it can be claimed and
finished without waiting on another slice's output.

- Write one line per slice: **what artifact**, **who is the best-fit
  owner**, **what "done" looks like**.
- Do not create a slice that duplicates the parent's own scope under a
  different name — this was an observed bottleneck (Section 5 of the
  audit): a lead re-auditing/re-packaging the same objective as its own
  "child" task instead of delegating distinct work outward. If a slice's
  owner would be the lead itself, it should usually just be lead's own
  direct closing work, not a separate task row.
- Prefer 2+ genuinely independent slices so they can be dispatched in
  parallel (Section 2) rather than serialized.

## 2. Create child `/task` rows for active teammates — before execution

For every slice, `POST` a task with the full 7-field brief. This is
parser-enforced — missing a label risks `task_brief_not_dispatch_ready`:

```bash
curl -s -X POST $MANAGER_URL/tasks \
  -H "Content-Type: application/json" -H "X-Id-Team: ops-team" \
  -d '{
    "title": "<human title>",
    "name": "<kebab-case-name>",
    "from": "ops-lead",
    "description": "Goal ID: goal_plan_1fgpnd5\nExpected output: <path + contents>\nAcceptance criteria: <checkable conditions>\nValidation path: Owning lead reviews the completion; default coder and researcher validate substantial cross-team work.\nOut of scope: <exclusions>\nBacklog policy: <what becomes backlog>\nBittrees relevance: medium: <one-line reason>"
  }'
```

Field notes (verified, see audit Section 2):
- Use the label `Goal ID:` inside `description` — JSON key `goal_id` is
  not parsed.
- Use the exact `Validation path:` wording above unless the work is
  genuinely lead-only; custom wording has failed parsing before.
- `Bittrees relevance:` must carry the rank prefix (`high:`/`medium:`/`low:`).

**Before claiming anything for yourself**, check whether you (the lead)
already own a `doing` task with zero linked children — the manager blocks
new claims in that state (`lead_delegation_backlog`). Clear it first by
finishing or reassigning the stale task.

## 3. Dispatch independent work in parallel

Per team instructions (`memory:30`, `memory:82`): fan out independent
slices with async `/news-to ... trigger:true` **in a single batch**, not
serially. Use `/talk-to` only for a step that must block on another's
output first.

```bash
# fire all independent slices at once
curl -s -X POST $MANAGER_URL/talk-to -H "Content-Type: application/json" -H "X-Id-Team: ops-team" \
  -d '{"to":"deployer","from":"ops-lead","message":"<scope>","task":{"title":"...","name":"slice-a"}}'
curl -s -X POST $MANAGER_URL/talk-to -H "Content-Type: application/json" -H "X-Id-Team: ops-team" \
  -d '{"to":"content-moderator","from":"ops-lead","message":"<scope>","task":{"title":"...","name":"slice-b"}}'
```

Include the exact `task: {title, name}` in the dispatch brief plus
verbatim `claim URL:`/`done URL:` lines — implementers must reuse the
assigned name so the manager's checkin doesn't fire against a phantom row.

`task: {...}` auto-attach only works on `$MANAGER_URL/talk-to` directly
(not the local `localhost:<port>/talk-to` wrapper, which silently strips
it) and it auto-creates a checkin owned by the dispatcher (default 600s).

## 4. Supervise with the checkin probe ladder — don't assume progress

A claimed task can go silently inert: `claim` succeeds and sets
`ownerName` even if the owning agent's process never actually runs an LLM
cycle on it (observed live this session — Section 3/5 of the audit; three
child tasks sat "doing" for 20+ minutes with the owning agents' own
`/news` feeds showing no matching activity, some stale by days).

When a checkin fires (or when you manually suspect stall), walk the
ladder cheapest-first before pinging anyone:
1. Re-`GET` the task — has `updatedAt` moved since the last check?
2. Check the owner's `/news?since_id=0&limit=15` — any activity in the
   claim window?
3. Health-probe the owner's REST-AP port.
4. Only then `/talk-to` for a one-line status check (costs the delegate a
   turn) — and expect a `429 agent_busy` if they're mid-turn on something
   else, which itself is a live/not-wedged signal.

If steps 1–3 show no activity and the agent isn't simply busy elsewhere:
`/news-to` a non-blocking nudge once, citing the stale task name and
elapsed time. If it still doesn't move, proceed without that slice if you
already have sufficient evidence/coverage from other completed children,
and flag the stalled task explicitly in your closing packet rather than
silently dropping it.

## 5. Collect validation packets

For substantial or cross-team work, the owning team lead relays completed
child work to **both** default-team validators — never straight to the
primary lead, and never bypassed:

- `default/coder` — implementation, technical, operational, code-quality
  fit.
- `default/researcher` — evidence quality, reasoning, sourcing, policy
  fit, completeness.

If either validator returns "needs revision," the work goes back to the
owning team lead for another delegation/refinement cycle — it does not
get force-closed or escalated past the validators.

For lead-internal audit/status work with a narrow, verifiable scope (e.g.
this runbook itself), "Owning lead reviews the completion" is an
acceptable validation path per the task's own brief — but do not use that
narrower path to avoid dispatching genuinely cross-team or high-risk work
to the validators.

## 6. Close the parent with delegated child task names

`POST $MANAGER_URL/tasks/<parent>/done` (or the `#<shortId>`-prefixed
resolver form, which is the reliable one for supervised/manager-originated
tasks — bare hex/name has been seen to 404) requires, for a lead-owned
objective:

1. `child_task_names` (or `delegated_task_names`) listing at least one
   **completed, member-owned, same-team** child. A cross-team validator
   task does not count even if it is the genuine validation for this work
   — spin off one small, real, same-team re-check if that's all you have.
2. A completion packet: `acceptance_coverage` (what was delivered against
   the acceptance criteria) and/or `failure_note` (why some scope could
   not land). A field named `acceptance_coverage_or_failure_note` is not
   recognized — use the real field names.

```bash
curl -s -X POST "$MANAGER_URL/tasks/%23caee67c8/done" \
  -H "Content-Type: application/json" -H "X-Id-Team: ops-team" \
  -d '{
    "agent_id": "ops-lead",
    "delegated_task_names": ["draft-delegation-runbook-content", "screen-delegation-rules-policy-fit-d0cfd5a4"],
    "acceptance_coverage": "Runbook + audit published to ./output/; two same-team children (deployer draft, content-moderator policy screen) completed and folded in; stalled git-manager/maintainer children nudged and documented as an open follow-up, not silently dropped."
  }'
```

Then relay the consolidated, validated result up the chain — team leads
relay to the two default-team validators (Section 5); the primary lead
relays only what the validators have approved up to the operator. Never
relay raw, unvalidated subordinate output upward.

## 7. Failure handling

If a slice cannot be completed (owner unresponsive, scope blocked,
dependency missing), do not leave it in `doing` forever and do not force
a false "done." Either:
- Reassign it to a fresh, proven owner (per `task-master`-hub pattern for
  unclaimed/stuck ops-team work), or
- Close it `done` with an honest `failure_note`, or
- Leave it open but explicitly call it out as a documented blocker in the
  parent's closing packet — do not close the parent silently around it.

## Quick-reference checklist

- [ ] Decomposed into independent slices with named owners and outputs
- [ ] Every child task created with the full 7-field brief
- [ ] Independent slices fired in parallel via `/talk-to` with `task:{}` auto-attach (not serialized)
- [ ] Progress checked via the probe ladder, not assumed
- [ ] Stalled/wedged children nudged once, documented, not silently dropped
- [ ] Substantial/cross-team completions relayed to `default/coder` + `default/researcher`
- [ ] Parent closed with real `delegated_task_names` + `acceptance_coverage`/`failure_note`
- [ ] Result relayed upward only after validation, never raw

## Sources

`used_source_ids`: entity:tracking:contribution:2026-W28:6de7e0043540,
entity:goal:goal_plan_1fgpnd5, entity:task:6df1d70a-c5f2-444e-8531-954433189b24,
entity:tracking:contribution:2026-W28:23fa9ac36c79, fact:10283, fact:10284,
fact:10285, fact:10286, text:22598, text:22599, memory:30, memory:45,
memory:14, memory:82. Also: live manager API responses captured in
`primary-lead-delegation-audit.md`, and local memory
`manager-delegation-gate-mechanics`, `manager-task-completion-fields`,
`manager-task-assign-syntax-2026-07-06`, `task-done-text-vs-api-gap`,
`idagents-trigger-coalesce-supervision`.
