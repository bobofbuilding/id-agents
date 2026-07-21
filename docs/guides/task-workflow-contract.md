# Task Workflow Contract

The manager preserves the legacy `todo`, `doing`, and `done` board statuses while attaching a versioned `task-workflow.v1` envelope to new tasks. The envelope is the operational contract for `Discover -> Qualify -> Execute -> Validate -> Promote -> Measure -> Improve`.

## Dispatch requirements

A dispatch-ready task carries a goal ID, team and owner, inputs, expected output, acceptance criteria, source IDs, scope exclusions, backlog policy, Bittrees relevance, validation route, deadline, timeout, retry time, and fallback route. Incomplete work is persisted as `triage_required`; it is not dispatched until `POST /tasks/:ref/workflow` repairs the missing fields.

Assignment ID and delegation lineage are written in the same database statement that claims a task. This prevents a visible owner from diverging from the recorded route during concurrent claims.

## Lifecycle

The workflow lifecycle is:

`triage_required | ready | queued | executing | blocked | stalled | validation_pending | validated | failed | superseded | retired`

The board status remains backward-compatible. Use the workflow state for routing and recovery decisions.

| Route | Purpose |
|---|---|
| `POST /tasks/:ref/workflow` | Repair or replace the dispatch contract |
| `POST /tasks/:ref/block` | Persist reason, recovery owner, retry time, deadline, and fallback |
| `POST /tasks/:ref/recover` | Retry, reassign, park, or retire blocked work |
| `POST /tasks/:ref/validate` | Record a validator verdict with evidence and artifacts |
| `POST /tasks/:ref/lifecycle` | Supersede or retire work |
| `GET /tasks-workflow/metrics` | Inspect cycle time, validation, recovery, and promotion outcomes |

Stalled work is marked without changing its activity timestamp. This keeps the sweeper honest and prevents lifecycle bookkeeping from making an inactive task look fresh. Inferred completion enters `validation_pending`; expired validation is routed to a live team lead or task manager and fails after a bounded fallback budget.

## Knowledge promotion

A completion is a private Brain promotion candidate by default. It becomes shared reusable knowledge only when its `knowledge-promotion.v1` record has validated status, evidence, confidence at or above the threshold, a reviewer, namespace, expiry, and any supersession or contradiction references. Production does not imply promotion.

## Capability intake

Skill installs preserve a `capability-intake.v1` record in agent metadata: source and SHA-256 provenance, permissions, cost, health, runtime compatibility, owner, rollback, and a 90-day re-evaluation time. Blocked intake records are not installed.

## Compatibility

Legacy tasks without `task-workflow.v1` keep their existing lifecycle semantics. New tasks use the contract automatically, allowing rolling upgrades without rewriting historical rows.
