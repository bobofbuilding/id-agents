---
name: task-discipline
description: Required lifecycle for non-trivial work. Create a task, claim it, do the work, mark done. Include the task name in your reply.
---

# Task Discipline

You treat every non-trivial request as a first-class task in the manager's /tasks system.
The task lifecycle is mandatory for any multi-step work or work that produces an artifact.

## When a task is required

- Implementing a feature, writing a report, running an analysis, verifying a change
- Anything taking more than one round of work
- Anything that produces an artifact in ./output/

## When a task is NOT required

- Single-line answers, greetings, simple look-ups
- Work that is already part of an existing task you claimed

## Assigned work vs self-initiated work

There are **two** ways a task lifecycle starts. Treat them differently — the
single most common discipline failure is creating a duplicate task when one
has already been dispatched to you.

### Assigned work (someone delegated to you)

If you received a dispatch brief that names a task — i.e. the message
contains `task: <name>` plus explicit claim/done URLs (see the
`inter-agent` skill's asynchronous delegation flow) — the manager
**already created the task**. Do **not** create a new task.

Use the brief's URLs verbatim:

1. `POST <claim URL>` with `{"agent_id": "<your-name>"}` — flips to `doing`.
2. Do the work.
3. `POST <done URL>` with `{"agent_id": "<your-name>"}` — flips to `done`.
4. Reply citing the assigned task name.

If you create a parallel task under a slightly different name, the
dispatcher's checkin keeps firing against the original (now-phantom)
row, the dispatcher cannot tell the work landed, and acceptance does
not roll up. Use the assigned name **verbatim**.

### Self-initiated work (you discovered it)

If you found work that needs doing during a heartbeat, review, or
ordinary flow — and nobody dispatched a brief — follow the full
lifecycle below: create → claim → do → done.

## The lifecycle

1. Create: `POST $MANAGER_URL/tasks` with `{title, name, from: <your-name> }`
2. Claim: `POST $MANAGER_URL/tasks/<name>/claim` with `{agent_id: <your-name> }` (status flips to `doing`)
3. Do the work. Write artifacts to `./output/` in your working directory.
4. Complete: `POST $MANAGER_URL/tasks/<name>/done` with `{agent_id: <your-name> }` (status flips to `done`)
5. Reply to the requester or team lead with a completion packet:
   - `Task:` the assigned task name, verbatim
   - `Summary:` what changed or what you learned
   - `Evidence:` files, commands, tests, citations, or output paths
   - `Goal fit:` how the result supports the active primary goal first, then any secondary goal
   - `Blocked/risks:` anything unresolved, uncertain, or needing validator review

Example: `Done. Task: implement-x. Summary: added the guarded write path. Evidence: src/foo.ts, npm test. Goal fit: supports the current reliability goal. Blocked/risks: needs validator review for rollout wording.`

## If work fails

Mark the task done with a failure note in the reply. Do not leave it in `doing`.
Other agents reading the task stream need to see the terminal state, even if it is failure.

## Naming

Use kebab-case for task names: `implement-feature-x`, `audit-contracts-sept`, `review-pr-42`.
Avoid reserved command verbs (delete, deploy, sync, etc.) which will be rejected by the validator.

## Why this matters

A verifier agent walking the task stream can see every unit of work, every artifact, every completion or failure, but only if every agent uses the system. Your discipline is what makes the team auditable. Your completion packet is also what lets a team lead refine your work into an accomplishment packet for default/coder and default/researcher validation before default/lead treats substantial work as final.

## Orphan cleanup notes

If you're running a cleanup pass and need to close a checkin or task
that should not block acceptance because a different agent's task
already covers the same work, write the close note in this **exact**
format:

```
closed-by-cleanup: see <implementer-task-name> (uuid <short>)
```

Where `<short>` is the implementer's `shortId` (e.g. `#7b03a518`). The
format is greppable from the task stream so the next pass can
reconstruct which row absorbed the closed work without having to walk
event logs.

## Duplicate-task guard

The Manager rejects task creation when the request matches an existing
logical unit of work for the same team. It compares goal, target, and
title signals; matching open tasks and recently completed tasks produce
`existing_task_found` with the existing task, status, match scope, and a
`status-check` recommendation.

When the guard fires:

1. Do not rename the task and retry.
2. Status-check the reported task, then claim or continue it when it owns the work.
3. If the work is genuinely different, make that difference explicit in the goal,
   target, title, and brief before creating a new task.
4. Keep using an assigned task name and its lifecycle URLs verbatim.

## See also

The `inter-agent` skill describes Manager-supervised asynchronous delegation.
When you delegate work with a named `task` object, the Manager creates the task
and supervises it through a terminal state. Load that skill whenever you delegate;
use this skill for your own task lifecycle.
