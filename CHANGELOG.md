# Changelog

## [0.1.170]

- Verify Claude's structured authentication state during runtime preflight,
  rather than accepting a version-only CLI check that can pass with an expired
  OAuth session.
- Return a stable `claude_auth_missing` recovery hint that directs operators to
  IDACC's managed Claude account flow before an agent is assigned or rebuilt.

## [0.1.169]

- Keep duplicate detection project-scoped and use indexed open/recent-complete
  task reads so unrelated projects and large task histories do not interfere
  with new delegation.
- Carry task and project context into cross-team validation, and record every
  validation verdict as an explicit lifecycle event so requested revisions are
  visible instead of appearing as unexplained reopened work.
- Retry short-lived busy/rate-limit delivery failures for synchronous and
  asynchronous handoffs, and tighten inter-agent task contracts around exact
  project roots, acceptance evidence, and one live task per assignee.
- Refresh vulnerable transitive dependency locks for js-yaml and nanoid.

## [0.1.168]

- Recover missing-material task blocks through a durable, bounded ladder:
  creator or parent owner, owning lead, task-master, and only explicitly
  declared source/domain teams, before parking unchanged work.
- Requeue parked work when its contract, sources, evidence, or parent material
  changes, adopt legacy missing-material blocks, and surface genuine external
  decisions in the owning team's Inbox.
- Record explicit material and domain ownership in workflow contracts so
  cross-team recovery remains authorized and deterministic.

## [0.1.167]

- Coalesce canonical and retired legacy Brain goal rows before autopilot work is
  created, so one logical goal cannot produce duplicate task batches.
- Enforce the configured per-cycle task cap for scheduled and manual goal syncs.

## [0.1.166]

- Create only the configured SQLite database parent directory, preventing a
  profile-scoped IDACC Manager from recreating the retired legacy
  `~/.id-agents` directory on startup.

## [0.1.165]

- Refresh every managed worker workspace before startup and Manager restart
  recovery so migrated agents cannot keep stale Manager authentication or
  hard-coded Brain endpoint guidance.
- Project configured skills across Claude, Codex, and Cursor runtime roots so
  a later harness change cannot reactivate an obsolete skill copy.
- Preserve a real existing optional skill when its library source is no longer
  bundled, allowing security-critical framework skills to refresh without
  silently adopting or deleting the unavailable capability.

## [0.1.164]

- Add an authenticated, compare-and-set agent configuration endpoint so IDACC can apply runtime, model, effort, speed, and lifecycle changes atomically with rollback.
- Keep exact MCP connection material process-local while persisting only safe registry references, and park the unstable BrowserMCP adapter.
- Preserve operator-selected runtime and model settings across Manager restarts and reject standalone control of authenticated managed workers.

## [0.1.163]

- Authenticate Manager goal-driver writes to the bundled Brain with the same
  profile-scoped bearer used by every other managed Brain request, preventing
  healthy Brain services from being misreported as unavailable.

## [0.1.162]

- Refresh the production dependency lock to `fast-uri` 3.1.5 and Hono 4.12.34,
  clearing the newly published host-confusion and CORS ReDoS advisories before
  the leadership-first Manager is bundled into an IDACC review build.

## [0.1.161]

- Restore the primary lead, non-default team leads, and default validators
  before the managed control plane reports ready, while the remaining worker
  fleet continues its bounded verified recovery afterward.
- Treat an explicit `/ask` as authorization to start its selected local agent,
  so team leads can delegate to stopped teammates without dispatching into a
  dead endpoint.
- Serialize start-on-dispatch with Manager lifecycle recovery to prevent a
  simultaneous restore and delegation from respawning the same worker.

## [0.1.160]

- Make explicit local-agent stops deterministic on macOS, Linux, and Windows:
  request graceful process-tree shutdown first, then re-verify ownership before
  a bounded force fallback when the verified worker does not exit.
- Keep whole-Manager shutdown graceful-only until its existing coordinated
  force pass, and prove restored workers are the exact processes stopped by the
  packaged lifecycle smoke.
- Expose worker-restoration progress separately from control-plane readiness so
  the desktop stays usable during recovery while lifecycle-sensitive callers
  can wait for a settled fleet.

## [0.1.159]

- Report the initialized Manager control plane healthy while the bounded
  previously-running worker restoration pass continues, so large persistent
  fleets no longer force IDACC back into startup recovery on every restart.
- Keep schedules, check-ins, and other automated dispatch gated until verified
  worker restoration finishes.

## [0.1.158]

- Keep idle agents running by default. Automatic idle parking now requires an
  explicit `ID_IDLE_PARK_ENABLED=true` operator opt-in, while manual parking
  continues to require `/agents park-idle --confirm`.
- Add lifecycle regression coverage proving the background sweep cannot stop
  agents under the default consumer configuration.

## [0.1.157]

- Update the MCP SDK and its Node adapter override to patched releases so the
  bundled production tree no longer includes the Windows encoded-backslash
  static-file path traversal advisory.

## [0.1.156]

- Recover pre-receipt consumer workspaces by archiving conflicting historical
  managed files byte-for-byte before publishing the current runtime overlay.
- Migrate the legacy nested framework/organization marker form while retaining
  every byte of surrounding user-authored instructions.
- Keep the migration one-time and restore strict receipt-backed drift protection
  immediately afterward, with non-mutating preflight and regression coverage.

## [0.1.155]

- On Windows, continue from a rejected graceful `taskkill /T` attempt to the
  bounded grace period, exact ownership recheck, and existing `/T /F` fallback
  instead of leaving a verified managed worker running after an explicit stop.
- Preserve fail-closed ownership loss and graceful-only shutdown behavior, with
  regression coverage for every initial `taskkill` failure branch.

## [0.1.154]

- Align the packaged local-agent lifecycle smoke with the managed worker privacy
  boundary: anonymous health proves liveness only, the desktop admin bearer is
  rejected at the worker boundary, and identity/PID attestation requires the
  exact team-, agent-, and process-generation-bound Manager credential.

## [0.1.153]

- Align the full Manager regression suite with verified child registration,
  generation-bound worker credentials, and the fail-closed pending lifecycle;
  tests no longer promote a worker to running before health attestation.
- Exercise Manager-reminted target credentials and task receipts without
  weakening wrapper authentication, and distinguish public transaction hashes
  from actual private-key leakage.
- Make cross-platform worker-environment fixtures portable and eliminate stale
  child-exit mocks that caused long test timeouts and unhandled errors.

## [0.1.152]

- Add a managed-desktop HTTP privacy boundary while preserving the standalone
  Manager contract when managed mode is not enabled.
- Keep anonymous managed access to minimal readiness and REST-AP discovery,
  require the existing loopback admin credential for administration, and give
  Brain a separate read-only service credential restricted to teams, agents,
  and events.
- Give every Manager-owned worker a team-, agent-, and process-generation-bound
  credential derived from a Manager-only root; enforce a strict callback and
  same-team coordination allowlist with durable identity and reply-provenance
  checks.
- Keep supervisor and Brain service secrets out of worker environments, add
  authenticated worker callbacks, and direct workers to their own loopback news
  feed for late replies instead of the Manager-wide query endpoint.

## [0.1.149]

- Remove organization-named task and catalog compatibility branches from the shipped Manager while retaining old consumer data through neutral, deterministic namespaced relevance and responsibility-lane matching.
- Accept arbitrary namespaced relevance fields, labels, and CLI flags without embedding any organization identity, while continuing to emit the canonical `work_relevance` contract.
- Add regression coverage for generic imported relevance metadata and generic primary/secondary catalog lanes.

## [0.1.148]

- Apply each managed Claude Code agent's standard or fast output-speed preference through Claude Code's documented process-local `--settings` contract instead of leaving Fast as an inert UI choice.
- Pin standard mode explicitly for managed Claude workers so a persistent user-level fast preference cannot silently change an agent's model or cost, while withholding the setting from unsupported runtimes.
- Add regression coverage for launch arguments, invalid values, the legacy Claude runtime identifier, resumed sessions, and cross-runtime isolation.

## [0.1.147]

- Normalize direct-entrypoint detection as a file URL so packaged local agents and the legacy CLI start correctly from consumer application paths containing spaces or escaped characters.
- Add regression coverage for absolute and relative application paths containing spaces, `#`, `%`, and Unicode.

## [0.1.146]

- Give every team-scoped Manager event feed a stable stream identity and expose its unfiltered latest retained sequence on normal and tail reads.
- Detect profile cursors ahead of empty or restored event logs and return an explicit replay reset target before the earliest retained event, independent of topic filters and without long-poll delay.
- Add regression coverage for stream identity stability, empty and non-empty reset behavior, filtered reads, and the expanded event-feed response contract.
- Pin the officially patched Hono 1.19.15 backport used by the supported MCP runtime dependency range.

## [0.1.145]

- Add parent-supervised, cross-platform local-agent lifecycle management with exact readiness identity, collision-safe loopback ports, private bounded logs, graceful Manager restart restoration, and explicit preservation of agents the person stopped.
- Require exact persisted agent identity and process evidence before terminating a worker, and terminate only verified process trees across macOS, Linux, and Windows.
- Keep every worker on the Manager's selected workspace and database, including profile-owned SQLite in the unified desktop and deliberate PostgreSQL in standalone deployments.
- Resolve every managed CLI through portable PATH/PATHEXT rules, settle missing executables without hanging, terminate cancelled CLI process trees, keep Claude and Codex prompts on standard input, and support packaged Electron workers without shell quoting or predictable prompt files.
- Update the task-discipline guidance to use the Manager's duplicate-task guard and current asynchronous delegation contract.

## [0.1.144]

- Refresh the production dependency lock to remove all high-severity npm advisories from the shipped Manager tree.
- Correct package provenance and consumer-facing metadata to the public Manager repository.

## [0.1.143]

- Ship a provider-neutral starter fleet and consumer-safe core skill set without embedded organization routes, wallets, signing material, provider URLs, or local workspace assumptions.
- Add versioned service identity attestation, a space-safe bundled Brain MCP launch contract, exact MCP attachment compare-and-swap, redacted Brain relay responses, and version-checked control-state deletion.
- Replace organization-specific work relevance with a neutral task contract while retaining read-only compatibility for existing records, and harden listener, task-workflow, and inter-agent execution boundaries.

## [0.1.142]

- Require the supervisor-only bearer credential for Manager administration while retaining loopback and explicit admin-header checks, and remove that credential from the environment inherited by agents.

## [0.1.141]

- Harden goal autopilot cadence with persisted run state, overlap protection, bounded fan-out, missed-tick coalescing, and manager-owned execution through the same control state IDACC edits.
- Read and update active goals through the Brain API with a local database fallback, and deduplicate legacy goal instruction copies so agents receive one canonical goal context.
- Preserve exact canonical Claude model identifiers while supporting explicit Sonnet 4.6 aliases instead of silently redirecting them to another model.

## [0.1.140]

- Deliver persisted completion evidence directly to validators, rotate immediately across available default validators when a runtime is busy or rejects dispatch, and preserve bounded capacity limits.
- Keep live validation queries attached to completed tasks until a verdict is applied, and recover orphaned validator assignments immediately instead of waiting for a stale future deadline.
- Fetch current release metadata before checking source cleanliness and replace raw Git status output with an actionable preservation message explaining that stopping agents does not clean modified source.

## [0.1.139]

- Automatically consume both Waiting lanes by routing `triage_required` and `blocked` tasks to their owning live team lead, with task-manager fallback only when no lead is available.
- Bound waiting-task recovery by per-lead query capacity, retry deadlines, prompt deduplication, cross-team fairness, and a configurable per-sweep budget so reconciliation improves throughput without triggering another fan-out spike.
- Apply blocked and reroute control replies to the canonical workflow state even for legacy tasks without a workflow contract, preventing false Under Review or Holding labels.
- Include waiting-task recovery in `/task reconcile` and the always-on stalled-task sweep.

## [0.1.138]

- Route completion evidence through the live `default/coder` and `default/researcher` validator pool before coordinator fallbacks, preventing Holding Pattern tasks from exhausting an incomplete validator set.

## [0.1.137]

- Apply the archived-validation age guard before retry deadlines, allowing reconciliation to retire out-of-window recovery rows immediately without waiting for a stale validator lease.

## [0.1.136]

- Honor `/task reconcile --force` explicitly instead of forcing every reconciliation, allowing automatic and maintenance passes to retain stalled-owner deduplication while the UI can still request an immediate manual nudge.

## [0.1.135]

- Measure failed-validation recovery age from immutable completion evidence rather than refreshed lifecycle activity, so reopened archived rows are retired at the 24-hour boundary.

## [0.1.134]

- Make `/task reconcile` immediately process existing validation-pending rows as well as newly recovered failures, with the same bounded batch, age window, and validator-capacity guards used by the automatic sweeper.

## [0.1.133]

- Prioritize recent failed validations during reconciliation and limit automatic recovery to a configurable 24-hour window, preventing archived task history from consuming current validator capacity.
- Return reopened archived validation to a terminal failed state without dispatching another validator, preserving its evidence and preventing retry loops.

## [0.1.132]

- Recover completed tasks whose validator fallback was exhausted by routing their persisted completion evidence to an untried live validator; never rerun the completed task, and allow only one bounded recovery cycle.
- Rotate validation fallback across distinct validators instead of repeatedly selecting the default lead, and expose `/task reconcile` for an immediate deterministic pass over failed validation, stalled owners, and unowned queued work.
- Run failed-validation recovery automatically in the manager stalled-task sweep so Holding Pattern work progresses without depending on the Control Center button.
- Add core, long-term, medium-term, and short-term memory horizons to agent guidance and Brain context, with guarded promotion and tier-aware persistence.

## [0.1.131]

- Keep task-linked active queries in execution instead of falsely moving them into Holding, and bound Holding recovery to six hours or twelve hours of total task age before preserving the blocker and assignment history in actionable triage.
- Reconcile explicit completed-task artifacts without requiring agents to reach a guessed localhost manager endpoint, and attach canonical task context to direct manager delegations.
- Allow the Control Center to submit idempotent Brain learning tasks through the manager relay.
- Add the Kimi Code CLI OAuth runtime, model compatibility, private prompt-file handling, preflight checks, and regression coverage.

## [0.1.130]

- Resume a persisted stalled task as soon as its owner recovery query is accepted, clearing stale blocker metadata while preserving the normal timeout path if work goes quiet again.

## [0.1.129]

- Balance task admission and recovery by reducing the default per-team Doing ceiling from 30 to 12 while increasing each fleet-wide stalled sweep from 2 to 8 interventions.
- Interleave stalled recovery candidates across teams and allow only one recovery dispatch attempt per recipient in a sweep so saturated teams and agents cannot monopolize supervision.
- Persist rejected supervision dispatches with bounded retry metadata, preserving the real task activity timestamp while preventing control-plane retry loops.
- Keep conflicting cross-team reassignments in their source team when the destination already contains the same task name, preventing repeated reconciliation failures.

## [0.1.128]

- Make `/sync` non-destructive by default: omitted agents require a reviewed dry run and an explicit `--allow-remove` retry before they can be removed.
- Require local-admin authorization and exact team-name confirmation for team deletion, and preserve a durable deletion tombstone in the protected default-team audit scope.
- Back up the configured SQLite fleet before manager activation, retain a bounded recovery set, detect missing teams after restart, and recover a current-but-offline managed service through the normal guarded activation path.

## [0.1.127]

- Recover pre-assigned todo tasks atomically inside the manager instead of asking remote model sandboxes to call the host-only manager loopback API.
- Preserve a successful canonical claim when a stale remote reply reports that `127.0.0.1:4100` was unreachable, preventing false blocked and unassigned task state.
- Resume recovered work through the normal worker delegation or team-lead decomposition path, with regression coverage for both state transitions.

## [0.1.126]

- Preserve source actor, task, validation assignment, and project-root context across cross-team manager dispatches.
- Reject workspace-sensitive validation before model execution when its task or project root cannot be resolved, preventing validators from inspecting their persistent agent checkout by mistake.
- Retain approved project scope fields through query-context hardening and inject the exact repository root into validator briefs.
- Point generated protocol guidance at runtime-native Codex and Claude skill locations, with updated cross-team dispatch examples and regression coverage.

## [0.1.125]

- Purge obsolete assignment IDs and delegation lineage from already-queued legacy tasks during lifecycle reconciliation.
- Preserve queued task activity timestamps while completing the one-time metadata repair, with regression coverage for migrated rows.

## [0.1.124]

- Keep canonical task status, workflow lane, owner, assignment ID, and delegation lineage synchronized across claim, route, park, release, and backlog-requeue transitions.
- Repair queued tasks that already have active owners into executing work, and return executing tasks without canonical ownership to a clean queued state without falsifying task activity time.
- Give legacy tasks the same assignment lineage guarantees as versioned workflow tasks so Dashboard and Work surfaces cannot report contradictory task state.
- Cover control-reply claims, routed work, automatic assignment, ownerless repair, and lifecycle reconciliation with regression tests across SQLite and PostgreSQL repositories.

## [0.1.123]

- Reconcile completed query evidence before stalled-task triage so finished work cannot remain falsely displayed in Doing or be restarted.
- Recover validation queues deterministically by resolving missing validators, expiring abandoned validation leases, and returning revision requests to executable work.
- Record failed closures truthfully, wake owners after requested revisions, and preserve bounded retry and escalation behavior across SQLite and PostgreSQL.
- Cover stale completion, validation recovery, revision wakeup, capacity, and task-state transitions with focused regression tests.

## [0.1.122]

- Exclude the optional SkillMesh provider plugin from the standard fresh-install catalog and direct plugin-detail API.
- Preserve deliberate legacy use through `ID_AGENTS_OPTIONAL_PLUGINS=skillmesh` or the existing SkillMesh provider-enable flag.
- Document the opt-in boundary and cover standard, explicit, and wildcard inventory behavior with regression tests.

## [0.1.121]

- Add a side-effect-free runtime preflight endpoint that resolves the exact runtime/model pair used by agent spawn and validates it on the manager host.
- Advertise the runtime preflight contract through Control Center API v5 so compatible clients can block outdated managers before partial team creation.
- Cover the versioned capability contract while retaining the runtime/default pairing regression coverage from v0.1.120.

## [0.1.120]

- Keep configured default models paired with their configured runtime so an explicit alternate runtime never inherits an incompatible provider model during agent creation.
- Let blank Claude Code model selections use the signed-in subscription's current default instead of pinning a dated model identifier.
- Return actionable `400 runtime_preflight_failed` responses for invalid spawn selections before creating any agent workspace or database state.
- Cover fresh default-team runtime/model selection and explicit model overrides with regression tests.

## [0.1.119]

- Enforce versioned task dispatch contracts with atomic owner, assignment, team, and delegation lineage so incomplete work enters triage instead of execution.
- Add first-class blocked, stalled, validation, supersession, retirement, and recovery transitions with validator deadlines, bounded fallback, capacity-aware routing, and workflow telemetry.
- Promote task learning to reusable Brain knowledge only after evidence-backed validation, confidence checks, provenance preservation, and lifecycle governance.
- Gate skill intake on provenance, permissions, compatibility, health, ownership, rollback, and re-evaluation metadata; harden persisted query context with redaction and tamper-evident audit lineage.
- Document the workflow contract and cover migrations, repository behavior, lifecycle recovery, capacity limits, knowledge promotion, capability intake, and query context with regression tests.

## [0.1.118]

- Keep `manager:update -- --dry-run` side-effect free when a release is already built and awaiting activation, so preview mode can never restart the manager service.

## [0.1.117]

- Let the updater read the default SQLite queue in read-only mode when upgrading a manager too old to report active-query count, completing the automatic migration without treating unknown state as idle.
- Keep PostgreSQL and unavailable queue state fail-closed, and cover the compatibility query count with a smoke test.

## [0.1.116]

- Defer manager update activation when the running service is unavailable or does not expose an aggregate active-query count, preventing a first-upgrade compatibility gap from being mistaken for an idle manager.

## [0.1.115]

- Add a guarded manager release updater that accepts only tagged release-schema commits, preserves untracked local files, refuses tracked edits or divergent history, and builds before activation.
- Defer automatic manager service restarts while any team has pending or processing queries, then activate the staged release once work drains.
- Report aggregate active-query count from manager health so IDACC can coordinate updates without interrupting committed work.

## [0.1.114]

- Keep the manager HTTP event loop responsive during SQLite write contention by limiting each synchronous busy wait to 250 ms while preserving the existing bounded asynchronous retry window.
- Add status/time indexes for stale-query expiry and recent-completion supervision scans so manager maintenance no longer performs full query-table scans every 30 seconds.
- Cover the live query-sweep index migration and SQLite busy-timeout guard with regression tests.

## [0.1.113]

- Preserve Brain data, memory, reports, source trees, uploads, and agent task artifacts during routine workspace cleanup; whole-output and publish-snapshot deletion now require explicit opt-in flags.
- Reclaim only old rebuildable agent dependency trees and project build caches by default, with guarded root containment, age checks, and deduplicated candidates.
- Include the workspace collector in the published package and add a smoke test proving cleanup removes stale dependencies without deleting durable task results.

## [0.1.112]

- Treat byte-identical control-state writes as no-ops in SQLite and Postgres so polling and repeated work passes do not increment versions or flood the durable event log.
- Return unchanged control-state writes without emitting `control:state-updated`, while preserving optimistic concurrency conflicts for stale writers.

## [0.1.111]

- Add an authenticated, allowlisted, idempotent Manager relay for all IDACC Brain reads and writes, with secret redaction and bounded payloads.
- Persist versioned Dashboard control state in SQLite or Postgres with atomic optimistic concurrency, keeping IDACC project, organization, and task-overlay state recoverable.
- Emit durable control/config and task-created events for agent, team, deployment, identity, and capability mutations.
- Preserve project and plan lineage on task rows so Brain can learn project-to-plan-to-task-to-agent relationships.

## [0.1.110]

- Route confirmed subscription session, daily, weekly, and monthly caps to the next healthy authenticated subscription runtime before considering metered or local fallback.
- Replay interrupted queries with their existing session context and restore the preferred runtime and model when its cooldown ends.
- Skip cooling or failed-preflight subscription lanes and reject synthetic metered-overflow lanes when no metered credential is configured.

## [0.1.109]

- Prevent manager event-loop stalls during retention by adding covering query/news indexes and bounding SQLite event, query, and news cleanup to 500 rows per pass.
- Make macOS manager restarts launchd-aware: request graceful replacement, wait up to 30 seconds, never kill a newly spawned replacement, coalesce concurrent restart requests, and apply a restart cooldown.
- Add configurable SQLite slow-query diagnostics through `ID_SQLITE_SLOW_QUERY_MS` and regression coverage for manager restart PID guards.
- Restore the `lint`, `typecheck`, and self-contained build-first `ci:preflight` package scripts required by the checked-in release workflow and contributing guide.

## [0.1.108]

- Harden Claude CLI rate-limit handling: require trusted structured/status/reset evidence, preserve confirmed daily/weekly subscription-cap fallback, keep session/monthly/API/unknown limits off Ollama, and cover Codex model-capacity fallback/replay/restore behavior.

## [0.1.107]

- Keep manager parent-reconciliation prompts on delegation policy after sender-envelope wrapping. Query priority, MCP/tool access, and execution timeout are now derived from the canonical unwrapped prompt, while wrapped supervision prompts are also recognized directly for parity. This prevents completed-child parent reconciliation from being restricted to read-only tools and terminated after two 90-second attempts instead of receiving the intended 12-minute delegation window.

## [0.1.106]

- Recover interrupted rate-limited work automatically: prefer another healthy subscription lane, fall back to an installed role-matched Ollama model before metered overflow, replay the original query, use bounded probe cooldowns for unclassified limits, and restore the exact preferred subscription runtime/model after cooldown. Successful retries now repair the original failed query on SQLite.
- Harden task throughput and delegation: deduplicate goal-target and goal-less title fanout, route ownerless task creation to configured team leads, repair ownerless `doing` tasks, compact excess lead-owned parents, reroute failed stalled-owner supervision, and reset exhausted probe budgets after a cool-off window.
- Persist completed task and query outcomes into Brain memory, attach Brain context to knowledge/capability work, route explicit `ASK-USER` decisions into the manager inbox, and prevent recursive Learn passes from repeating the same source/question lens.
- Preserve live catalog fields when YAML seeds are reapplied during deploy or sync, while still filling missing seed values.
- Gate GPT-5.6 Codex execution against the installed Codex CLI/model cache and fall back compatibly when an older executor cannot run the requested model.
- Add audited Alchemy, Allium, OpenSea, agentic gateway, and Foundry fuzzing skills; update workspace/library inventory coverage for the expanded Foundry bundle.
- Make manager-shadow SQLite cleanup rerunnable so rollback helpers and older clients cannot leave legacy manager agent rows or foreign-key references behind.
- Add delegation guidance and a reusable task-brief template.

## [0.1.105]

- Prevent stale local-fallback metadata from restoring an agent to an older subscription runtime after the agent has already left Ollama. The restore sweep now only performs an automatic restore when the agent is actually still on the local fallback runtime, and cleans the stale failover marker otherwise.

## [0.1.104]

- Restrict automatic local-model failover to subscription daily/weekly caps only. Generic API limits, overloads, session caps, and monthly usage caps no longer pivot agents such as the primary lead to Ollama; eligible local fallback still records the previous subscription runtime/model and the restore sweeper returns the agent when the original lane cooldown clears.

## [0.1.103]

- Increase SQLite busy waiting and add bounded retry/backoff for transient `SQLITE_BUSY`/`SQLITE_LOCKED` write contention so successful agent replies are not marked failed when concurrent manager or local-agent DB writes briefly lock the shared state database.

## [0.1.102]

- Treat read-only shell/HTTP tool limitations in manager supervision replies as manager-applied task closures when the embedded reconciliation evidence is complete, preventing fake BLOCKED activity rows from leaving completed parent tasks looking stuck.

## [0.1.101]

- Release manager hardening updates for IDACC: bounded active-goal autopilot fanout, Brain/manager task-claim context sync, runtime fallback guards, resource limits, release-schema validation, provider/runtime routing fixes, specialist routing, and workspace cleanup tooling.

## 0.1.100-beta

### Fixes

- **Apply the agent's configured model in the Claude Code CLI harness.** `src/harness/claude-code-cli.ts` now passes each agent's configured model (alias-resolved) as `--model` when spawning `claude`. Previously the CLI harness omitted `--model` entirely and only honored `CLAUDE_CLI_MODEL`, so every `claude-code-cli` agent ran Claude Code's account/subscription default regardless of its YAML `model:` field. `CLAUDE_CLI_MODEL` remains a global override; with neither set, Claude Code falls back to its own default.
- **Kick off lead delegation immediately.** Lead-owned parent objectives now receive the delegation kickoff as soon as they are assigned/claimed instead of waiting through a fresh-task grace period. The 10-minute delegation audit grace still prevents false backlog alarms while the lead creates member-owned child tasks, and `ID_LEAD_DELEGATION_KICKOFF_GRACE_MS` remains available for deployments that deliberately want a short startup delay.
- **Uncap configured lead query sessions by default.** Team leads and the primary lead no longer inherit the worker active-query cap, so multiple operator/delegation sessions can run concurrently with separate context windows. Set `ID_AGENT_LEAD_QUERY_CONCURRENCY` or `ID_MAX_ACTIVE_QUERIES_PER_LEAD` to a positive number only when an explicit lead cap is desired.
- **Ignore stale worker query caps on leads.** Generic per-agent metadata such as `maxActiveQueries` or `queryConcurrency` now applies only to non-lead workers. Lead-like agents use only lead-specific metadata keys (`leadMaxActiveQueries` / `leadQueryConcurrency`) or lead-specific environment variables, preventing old DB metadata from bringing back the visible `limit 3` lead dispatch failure.

### Changes

- **`sonnet` alias now resolves to Claude Sonnet 5.** `MODEL_ALIASES` repoints bare `sonnet` to `claude-sonnet-5` and adds `sonnet-5` / `sonnet5` shorthands (`src/core/model-aliases.ts`).
- **TUI model abbreviations for Sonnet 5.** Added `claude-sonnet-5` → `sonn-5` and the raw `fable` alias → `fable-5` to the agents-table abbreviations (`src/tui/util/models.ts`).

## 0.1.99-beta

### Fixes

- **Resolve model aliases before spawning Claude agents.** Agent spawn env builders now canonicalize config-supplied model aliases before setting `CLAUDE_MODEL`, so aliases like `fable`, `mythos`, `haiku`, and `opus-4.8` reach Claude Code as full model IDs instead of falling back to the CLI default. Operator-provided `process.env.CLAUDE_MODEL` passthroughs remain unchanged.

## 0.1.98-beta

### Features

- **Fable 5 and Mythos 5 model aliases.** New shorthand aliases `fable`, `fable-5`, `mythos`, and `mythos-5` resolve to `claude-fable-5` and `claude-mythos-5`. Claude runtime validation, CLI display labels, harness constants, and TUI model abbreviations now recognize the new model IDs.

## 0.1.97-beta

### Features

- **Opus 4.8 model nickname.** New shorthand aliases `opus-4-8` and `opus-4.8` resolve to `claude-opus-4-8` (`src/agent-manager-db.ts` MODEL_ALIASES). TUI agents table shows the short label `opus-4.8` for the new model (`src/tui/util/models.ts`).

### Docs

- **Heartbeats (new model — agent reads `HEARTBEAT.md`).** New section in `skills/idagents-admin-control/SKILL.md` documenting the manager's heartbeat scheduler: how `heartbeat: <seconds>` in a team YAML triggers a generic wake message, how the agent reads `HEARTBEAT.md` from its working directory on every beat, the shared-working-directory footgun, the `/heartbeat <agent>` state shape, the recipe for a heartbeat-driven loop, and anti-patterns.

### Fixes

- **`/heartbeat <agent>` `maxRuns` readback.** Previously the response fell back to the literal `20` when no cap was set, even though the scheduler treats `null` as unbounded. Both readback fallbacks now return `null` (in `src/agent-manager-db.ts`), so the JSON honestly reflects scheduler behavior. New-model heartbeats remain uncapped by default; legacy `HEARTBEAT.yaml` with `maxBeats: N` continues to opt into a real cap.

## 0.1.96-beta

### Features

- **Team-templates library** in the TUI, parallel to the existing agent and skill libraries. Team templates live under `configs/teams/<template>/team.yaml` and are immutable; the install pipeline (`POST /library/install`) copies the template to `configs/<dest>.yaml` (mutable, deploy target), rewrites the top-level `team:` key when the operator picks a different destination name, and refuses to overwrite an existing config without `force: true`. The TUI surfaces this through the `m` keybind (`library / teams`), a `LibraryTeamsTable` view, a `LibraryTeamDetail` view with an inline install panel (idle → prompt → running → success/error), and a `/library install team <template> [as <dest>]` command bar entry. Two seed templates ship in this release: `starter-pair` (minimal lead + dev, no library refs) and `solidity-pair` (Foundry builder backed by `foundry-dev` plus an adversarial reviewer).
- **`/heartbeat fire <agent>`** for manual heartbeat firing. Synthesizes the same wake payload the scheduler emits on a real beat, dispatches through the existing `/talk-to` path, records a `manual: true` beat event, and returns the spawned `queryId` so the operator can poll for the agent's reply. Supports `--force` to fire even when no heartbeat is configured (synthesizes a generic schedule in memory; never persisted). Manual fires do NOT update `lastFireAt` and do NOT consume `maxBeats`/`max_runs`, so testing never perturbs the scheduled cadence or budgets. Backed by a hard parity test: drives both the real scheduler dispatch and the manual-fire path through `fetch` spies, asserts the two payloads differ only in `schedule.scheduledKey`, `schedule.manual`, and `mode`. Every other field is asserted equal individually. The TUI binds `f` on a selected heartbeat row as a one-key fire trigger.

### Fixes

- **Task-discipline divergence**: agents delegated work by another agent (typically a CTO dispatching to a coder) used to follow the `task-discipline` skill literally and CREATE a new task with a name they invented, instead of CLAIMING the task the dispatcher had already created. This left dispatchers' task rows stuck in `doing`, broke checkin supervision (the supervisor probed for tasks that returned `not_found`), and split the work across two parallel namespaces. The `task-discipline` skill (`skills/task-discipline/SKILL.md`) and the same content injected via `defaults.claudeMd` now distinguish **assigned work** (claim the task your dispatcher gave you, do not create) from **self-initiated work** (create + claim, the original flow). The fix shipped via controlled rebuild across all teams. Verification dispatch (`test-claim-not-create`) proves the new behavior holds end-to-end. Documented `closed-by-cleanup: see <task-name> (uuid <short>)` note format for closing orphan rows when a janitor pass discovers them.

### UX

- TUI help view picks up three new bindings: `m` for library/teams, `i` to install a library team from the detail view, `F` to toggle force on the install prompt, `f` to fire a heartbeat from the heartbeats view.

## 0.1.95-beta

### Features

- Operator `/cancel <agent>` now writes a "Cancelled by operator" marker into both the team news feed (manager-inbox owned) and the target agent's own inbox (agent owned) before sending the kill, so the cancellation is visible in the TUI even when the agent's own `/cancel` handler races the process kill. Manager-inbox surfaces it on the team-level `GET /news` for operator-side tooling. Agent-owned surfaces it via the TUI's per-agent NewsView path, which fetches the agent's local `/news`.
- `/task delete` is now an alias for `/task remove` and both accept bulk forms. `/task delete *` removes every task in the active team. `/task delete --team <name>` removes every task in the named team.
- New `/task status <task-ref> <todo|doing|done>` sets a task's status directly, including rolling a doing task back to todo. Owner field is intentionally not touched. Use `/task assign` to change ownership.

### Fixes

- TUI tasks view now fetches the union of all teams' tasks in parallel via `fetchTasksAllTeams`, mirroring the agents view. Task counts in the `TeamsPanel` stay stable when the operator switches the selected team. Previously the fetcher always defaulted to the `default` team and the client filter then stripped everything when the selected team was anything else.

### UX

- TUI command bar drops `/clear` from the registry and the help menu.
- TUI `/task` bar narrows to `assign | status | done | remove | delete`. `create` and `claim` are intentionally not surfaced. Agents create and claim their own tasks via the inter-agent skill, and the manager dispatch path handles operator-initiated task creation.
- Single-task `/task delete <ref>` confirms with Y/N. Bulk delete (`*` or `--team <name>`) keeps the retype gate so the operator has to retype the full line.
- Help view replaces the Safe, Powerful, and Destructive sections with one flat alphabetical command list rendered in a single neutral color. Per-command safety still runs at dispatch via `shouldConfirm` and `shouldRetype`.

## 0.1.94-beta

### Refactors

- Decouple manager from team membership. The `manager` identity is no longer modeled as an `agents` row inside each team. The schema for `queries` and `news_items` carries `owner_kind` (`agent` or `manager`) plus `owner_id`, so the manager inbox is first-class without pretending to be a team member. Listings and counts on `/agents`, `/agents/status`, `/teams`, `/team`, and `/remote /status` exclude `interactive` and `virtual` rows, so manager rows no longer leak through the roster. `GET /agents/by-name/manager` and `/agents/resolve/manager` return plain `404`. Inter-agent routing special-cases `to:'manager'` and routes directly to the manager inbox endpoints rather than going through `/agents` lookup. Client-side filtering in CLI and TUI is removed since the server contract is honest. Reversible down-migrations exist for both SQLite and Postgres.

- Rename in-team automator role from `manager` to `lead-automator`. The reserved word `manager` is now exclusively the control-plane identity. Configs that try to name an agent `manager` for any role are rejected at parse time with a hard error directing the user to a non-reserved name.

- Single source of truth for the inter-agent skill. `src/inter-agent-skill.ts` and `skills/inter-agent/SKILL.md` are no longer maintained as parallel copies that drift, with a build-time check that fails if they diverge.

### Features

- Agent catalogs as a load-bearing routing surface. Every agent advertises `role`, `description`, `expertise`, `costTier` (`low`, `medium`, `high`), `notSuitableFor`, and `status` via its `/catalog` endpoint. Catalog seeds are read from `configs/<team>.yaml` at deploy time and passed to the spawned agent process via env, so the runtime endpoint reflects the seed without any post-deploy PATCH. Long catalog descriptions can live in a separate markdown file via `catalogFile: <path>.md`, with YAML frontmatter for the structured fields and the body becoming the description. The `inter-agent` skill teaches a four-step catalog-aware delegation flow: list peers, fetch each catalog, filter by status and `notSuitableFor`, rank by expertise overlap and `costTier`.

### Fixes

- Reserved-identity validation now applies on rename and update paths, not only on creation. `PATCH /agents/:id/metadata` and the remote `/update --name` handler both run names through `validateName(newName, 'agent')` before persisting, so a client cannot turn a real agent into `manager` after the fact.

### Docs

- New top-level `MANAGER-POLLING.md` documents how clients should wait for query completion. `GET /query/:id?wait=<seconds>` is the supported long-poll. QUICKSTART step 5 shows this pattern instead of burst-polling `/news`.

## 0.1.93-beta

### Refactors

- Manager collapse. The daemon at `:4100` now owns the manager identity and inbox. The interactive CLI no longer binds `:4000`, no longer registers as a peer agent, and no longer persists `workspace/manager/interactive-agent-identity.json`. Single process, single port, single mental model. New daemon endpoints: `GET /.well-known/restap.json` (manager catalog at the daemon root) and `GET /manager/inbox/pending` + `POST /manager/inbox/respond` (CLI client APIs). Full design at `docs/design/manager-collapse.md`. Verified end-to-end: `:4000` empty during a CLI session, peer agents reach `manager` via the daemon inbox, no local identity file is regenerated, full test suite (557 tests) green.

### Fixes

- Silence `[REST-AP] Could not fetch catalog from http://localhost:0` warning that appeared after the manager-collapse refactor. Interactive agent rows (`manager-<team>`) have `port=0` and `endpoint=''`, and a few caller paths fell back to `http://localhost:${port}`. `discoverRestAPEndpoints` now short-circuits on empty or `:0`-port URLs and returns REST-AP defaults silently. New unit and integration regression tests cover both the function-level guard and the `/news` handler against virtual or no-port agent rows.

## 0.1.92-beta

### Fixes

- TUI: keep the `TeamsPanel` visible on `All` and `public` selections. Remote agents render with extra `DOMAIN`/`DMZ` columns; on terminals narrower than the full row width, the row and header used to wrap onto a second line, which scrolled the top menu off-screen. Added `wrap="truncate-end"` to `AgentRow` (local + remote branches), `AgentRowHeader`, and the `StatusStrip` content so the rendered height of the agents block always equals `windowSize + chrome`. The rightmost columns clip on narrow terminals, but the menu stays put.

## 0.1.91-beta

### Features

- TUI: pin the `public` team chip immediately after `All` in the `TeamsPanel`, regardless of the order the manager returns teams. Tab/Shift+Tab cycling matches the visual order, so moving off `All` always lands on `public` first. Other teams keep their original order.

## 0.1.90-beta

### Features

- TUI `TeamsPanel` now windows the team chips when the team list grows beyond 5. The window centers on the selected team (Tab / Shift+Tab still cycle selection and wrap at the ends), and `←N` / `N→` indicators show how many teams are hidden on either side. The `All` chip is always visible at the start.



### Fixes

- Drop the heuristic fallback in `src/tui/util/models.ts`. Model abbreviation is now table-only: an explicit `MODEL_ABBREVIATIONS` map decides every short name, and any model not in the map renders as its raw string (overflowing the 10-char column, which makes missing entries obvious). Added `claude-haiku-4-5-20251001` → `haiku-4-5` to the table while we were in there.

## 0.1.88-beta

### Features

- Compact `MODEL` column in the TUI agents table. Model strings are now abbreviated via `src/tui/util/models.ts`: explicit entries (`claude-opus-4-7` → `opus-4-7`, `claude-sonnet-4-6` → `sonn-4-6`, `composer-2` → `comp-2`, etc.) plus a heuristic fallback for unknown `claude-*` names (strip prefix, drop trailing date stamps, truncate the first word to 4 chars). Column width shrinks from 18 to 10. Add new explicit entries to the table as new models appear; the fallback handles the gap until you do.

## 0.1.87-beta

### Features

- TUI agents table now shows a `MODEL` column between `RUNTIME` and `STATUS`. Width 18 (fits `claude-sonnet-4-6` plus padding); longer model strings are truncated with the standard overflow glyph. Header and remote-agent rows updated to match. No other columns changed.

## 0.1.86-beta

### Documentation

- `QUICKSTART.md` Step 0 now requires Claude to ask the user before running `git pull` on an existing checkout. Previously it instructed an unconditional `git pull --ff-only`, which violated the design intent of "do not pull silently". The step now inspects branch, dirty tree, and local-vs-`origin/main` version, then presents the relevant prompt for the user to approve, decline, or address (uncommitted changes / non-main branch). The upgrade command runs only on explicit approval. Step 1 (Install / Rebuild) is now explicitly skippable when Step 0 already covered it.

## 0.1.85-beta

### Fixes

- Make `npm run build` rebuild both the core TypeScript output and the TUI bundle so a normal pull-then-build leaves `dist/` fully consistent.

### Documentation

- Rewrite `QUICKSTART.md` as an idempotent flow: add a find-or-refresh Step 0, make the install step explicitly safe to rerun after `git pull`, and replace the one-shot skill copy with an in-place `rsync` refresh for `idagents-admin-control`.
- Change the canonical bootstrap prompt to `Find https://github.com/idchain-world/id-agents.git then read and follow the QUICKSTART.md file in the repo.` across the README and linked app/docs surfaces so the prompt no longer pre-decides clone vs update.

## 0.1.84-beta

### Features

- Add a TUI help modal. Press `?` from any view to open a popup listing every keybinding grouped by Views / Navigate / Global. `?` or `Esc` closes it. The footer is trimmed to a one-liner (`↑↓ nav · ← back · ? help · q quit`) so per-view hint strings no longer push the dashboard chrome out of frame.

## 0.1.83-beta

### Fixes

- **Stop probe from truncating /query/:id responses to 200 chars before parsing.** The original probe sliced the agent's `/query/:id` response body to the first 200 characters before `JSON.parse`, which silently corrupted any response carrying `result.messages[]`, `sessionId`, or full timestamps. `parseJson` returned `null`, the probe never saw `status: 'completed'` or `'failed'`, and every probe timed out even on healthy agents. The probe now parses the full body and only truncates when surfacing it in an error string.
- Surface the new probe commands in the interactive CLI. `/help` now lists `/agents probe` and `/agent <name> probe`, the usage strings for `/agents` and `/agent <name>` include `probe`, and each command forwards the request to `/remote` and prints a structured pass/fail summary.
- Bump `PER_AGENT_TIMEOUT_MS` for the probe from 10s to 30s. Real claude-code-cli dispatch round-trips for a one-token reply land around 12-15s; 10s caused premature timeouts even when the underlying query completed successfully.

## 0.1.82-beta

### Features

- **Operator-driven dispatch probe**. `/remote /agents probe` and `/remote /agent <name> probe` now verify dispatch end-to-end instead of only checking that an agent is HTTP-listening. Each probe POSTs a minimal `reply with OK` message to the agent's local `/talk` endpoint, captures the returned `query_id`, then waits up to 10 seconds for `/query/:id` to reach `completed` or `failed`. Results are reported in the exact `{ team, probed, passed, failed, results:[{ name, status, duration_ms, error? }] }` shape, with concurrency capped at 8. This surfaces auth-class harness failures and other spawn-succeeds-but-LLM-fails cases immediately after `/sync` or manager restarts, without wiring the check into `/sync` itself.

## 0.1.81-beta

### Fixes

- Surface schedule message text in `/schedule list`. The list projection previously omitted `message`, so operators auditing scheduled work had to drill into each row with `/schedule show <id>` to see what each schedule was actually saying to the agent. Now `message` is included alongside `title`, `kind`, `targets`, and the timing fields, making schedule-message drift visible at a glance.

## 0.1.80-beta

### Features

- Bring the check-in primitive fully online. The manager now boots `CheckinService`, wakes the owner on every due fire, auto-attaches live check-ins from `POST /talk-to` task handoffs, deduplicates wake-path inbox writes with `skip_persist: true`, and shuts the service down cleanly on `SIGTERM` / `SIGINT`.

### Fixes

- Wake every due fire regardless of priority. Priority is now metadata on the wake payload, not a gate that can suppress the owner's LLM wake-up.
- Reject `POST /checkins` for terminal linked tasks with `409 linked_task_terminal` instead of creating rows that immediately auto-close without ever firing.
- Normalize check-in owner shape across `POST /checkins`, `GET /checkins`, and snooze/close responses so callers get the same `owner`/`ownerId` envelope everywhere.
- Honor `skip_persist: true` and fall back to top-level `in_reply_to` in the manager `/news` handler, so wake/reply fanout resolves waiters without writing duplicate inbox rows.
- Hoist `in_reply_to` on agent reply broadcasts and seed receiver-side `query_id` from replies so `/talk-to` waiter routing and `/news?query_id=` lookups stay aligned.
- Mark `reply.error` replies as failed instead of delivered. The manager now routes failures through `QueriesRepository.markFailed(...)` and emits `query:failed`, while leaving successful replies on the existing `query:delivered` path.
- Stop `CheckinService` during manager shutdown so the daemon exits without leaving the due-service tick behind.

### Tooling

- Add the `id-agents-dashboard` package bin for the TUI entrypoint.

### Documentation

- Expand the `inter-agent` skill with the operator-facing check-in probe ladder and related supervision guidance, and add the `task-discipline` see-also pointer to that section.
- Refresh `idagents-admin-control`, `SYSTEM_ITEMS.md`, and `Logs.md` for the current check-in, tooling, and inventory surfaces.

## 0.1.79-beta

### Fixes

- Fix `/agent rebuild` stale-process cleanup for daemon-spawned local agents. The manager process guard now protects only the manager PID or manager entrypoint signatures, so rebuild can terminate an old `local-agent-server.js` child before spawning the replacement on the same port.

## 0.1.78-beta

### Fixes

- Make `/sync` deterministic for library-backed `skills:` diffs so repeated syncs against an unchanged team config no longer report every agent as `changed: skills` or trigger unnecessary respawns. Regression coverage now includes a live `/sync` fixture that asserts the second run is a no-op plus a targeted diff test proving that adding one skill updates only the affected agent.

## 0.1.77-beta

### Fixes

- Harden manager-side agent port cleanup so `/deploy` and `/sync` no longer risk killing the daemon itself when an existing listener resolves to the manager PID, one of its descendants, or a command matching the manager entrypoint (`start-agent-manager.js`). `killAgentProcess` now inspects candidate processes before sending `SIGTERM`, and a regression unit test covers the self-PID skip path.

## 0.1.76-beta

### Features

- Wallet opt-in for team configs. Add `wallet: true|false` to an agent entry (or `defaults.wallet` to apply across the team) to control whether `/deploy` and `/sync` provision an OWS wallet for that agent. Default is **off**: deploy/sync no longer call `ows wallet create`, do not write `metadata.ows_wallet` / `metadata.ows_address`, and the spawned child env never receives `OWS_WALLET`. Existing teams that depend on a wallet keep working by setting `wallet: true` in `defaults` or per-agent. Onchain registration still auto-provisions a wallet for remote agents only when `metadata.wallet === true` (or unset for legacy compatibility); explicit `wallet: false` is honored end-to-end.
- On-demand wallet provisioning. New CLI command `/agent <name> wallet provision` (also exposed via the `/remote` `/agent <name> wallet provision` command) calls the OWS provisioner once for a single agent, persists `metadata.ows_wallet` / `metadata.ows_address`, flips `metadata.wallet` to `true`, and is idempotent on re-run.

## 0.1.75-beta

### Fixes

- After `/sync` or `/deploy` adds a new agent, the running interactive CLI now reacts immediately. The daemon emits a new WebSocket message type `agents_changed` after every registry mutation (`/sync`, `/deploy`, `/agents/spawn`, `/delete`, `DELETE /agents/:id`, `DELETE /agents/by-name/:name`), and the CLI clears stale per-agent session state for any name that was removed or rebuilt and prints a one-line `🔄 registry: …` hint.
- `/deploy` and `/sync` in the CLI now wait up to 8s for each newly spawned agent's `/.well-known/restap.json` to return 200 before returning to the prompt. This closes a window where an immediate `/ask <new-agent>` would post into a port that was not yet listening and hang forever waiting for a reply that never came.
- Manager-inbox resolution is now hardened end-to-end. `findInteractive` selects the newest interactive row deterministically (`ORDER BY created_at DESC`) in both the SQLite and Postgres repos, eliminating cases where reply routing landed on a stale CLI row after `/sync` re-targeted a team. POST `/talk`, POST `/news`, POST `/schedule`, GET `/news`, and the `/remote news` handler all now go through a shared `resolveManagerInboxId` helper that auto-provisions a stub interactive row (`manager-<team>`) when neither a CLI nor a named "manager" agent is registered. Replies to a freshly-synced team that hasn't yet seen its CLI register no longer silently blackhole.
- The CLI now treats `/sync` and `/deploy` as identity-affecting events. The `/remote` `sync` and `deploy` responses echo the effective `team`/`teamId`, and the CLI re-registers its interactive row against that team (awaiting registration on `/deploy`, switching `activeTeam` and re-registering after `/sync`) before returning to the prompt. Previously `/deploy` fire-and-forgot the re-register, racing subsequent `/ask` calls against an interactive row in the old team.

## 0.1.74-beta

### Demos

- Replace the four editorial + solidity-security demo configs with a single `demo` team (`/deploy demo`): `cto` persona-only plus `developer` backed by the `fullstack-nextjs` library entry. Reverts an accidental copywriter add to the default team.

## 0.1.73-beta

### Documentation

- Add an "Agent Library & Team Configuration" section to the `idagents-admin-control` skill: how to list `/library/agents`, add an agent to a team YAML by referencing a library entry via the `agent:` field, run `/sync`, verify, and the anti-patterns around editing shared library entries or skipping `/sync`.

## 0.1.72-beta

### Documentation

- Sweep docs for the v0.1.69 through v0.1.71 library and sync surfaces: clarify that `agent:` selects a library entry under `configs/agents/<name>/`, `skills:` remains a peer field, and `configs/` is the canonical root.
- Rewrite the `/sync` guide as the canonical operator doc for the v3 engine, including two-step additive deploy, per-runtime mapping, the 4-case ownership rule, receipt location at `<workspace>/.id-agents/receipt.json`, memory-file fallback, `id-agents unsync`, `/library/agents`, `/library/skills`, and the TUI library browsers (`l`, `s`).
- Update root operator docs (`AGENTS.md`, `CONTRIBUTING.md`, architecture reference) to reflect the v3 library layout, receipt-driven sync model, library inventory endpoints, and NOTICE-based license preservation rules for imported content.

## 0.1.71-beta

### TUI

- Drop the `p` pause hotkey and the paused indicator. The feature toggled all polling intervals at once (an internal-debug-style escape hatch). It cluttered every footer hint string and rarely got used in practice. Agents view, tasks, calendar, heartbeats, news, library views all updated to drop `· p pause` from their hint lines, and the `paused` state machinery is removed from `App.tsx`. If you genuinely need to freeze polling, kill the TUI process — it'll come back where you left off.

## 0.1.70-beta

### TUI

- Library · Agents table trimmed: removed `RDME`, `LIC`, and `SUBFOLDERS` columns. The list view now shows only `NAME` and `SHAPE`. The dropped columns were noisy in a list and frequently misleading (e.g. `LIC: no` for entries that have per-skill `LICENSE` files but no top-level one). Detail view (`→`) still shows all of that information.

## 0.1.69-beta

### Features

- **Agent config v3 system** — full implementation across 8 slices (`0d86099` through `60338b6`):
  - Library at `configs/agents/<name>/` accepts two native shapes (Claude `<name>/CLAUDE.md` and AGENTS.md `<name>.md` + `<name>/`)
  - Standalone skill library at `configs/skills/<name>/`
  - New peer fields on team-config agent entries: `agent: <string>` and `skills: [<string>...]`
  - Sync engine (`src/cli/workspace-sync.ts`): SHA-256 + 4-case ownership logic + atomic receipt at `<workspace>/.id-agents/receipt.json`
  - Per-runtime mapping for Claude / Codex / Cursor (CLAUDE.md → AGENTS.md, skills → `.agents/skills/` or `.cursor/skills/`)
  - Memory-file fallback: existing `CLAUDE.md` → sidecar at `.claude/rules/agent-<name>.md`; existing `AGENTS.md` for Codex/Cursor → marker-fenced append (preserves user edits)
  - `id-agents sync <config>` and `id-agents unsync <config>` one-shot CLIs
  - Manager `/library/agents` and `/library/skills` read-only inventory endpoints
  - TUI library browsers: `l` for agents, `s` for skills, `→` for detail, with README preview cap
- **Library content imported** (`564b8b1`): 9 agent entries (`copywriter`, `devops`, `editor`, `foundry-dev`, `frontend`, `frontend-react`, `fullstack-nextjs`, `security` — CC-BY-SA-4.0, `solidity-security`) and 8 demo team configs at `configs/demos/`. `NOTICE` at the repo root credits all upstream skill authors.
- **`s` library-skills hotkey** now reachable from agents/tasks/calendar/heartbeats views, not just from library-agents.

### Fixes

- **v3 deploy persona overwrite** (`7e7a314`, `658efcc`, `7b962b9`): library entry's `CLAUDE.md` no longer clobbered by the framework personality writer. Sidecar approach for Claude (lands at `.claude/rules/agent-<name>.md`); marker-fenced append into root `AGENTS.md` for Codex/Cursor preserves user edits.
- **Library root resolution unified** (`7e7a314`): `copyLibraryAgentOverlay` now honors `ID_LIBRARY_ROOT` env var the same way the slice-7 manager endpoints do, so library entries can live in any clone of the public-agents content.
- **Symlinked library entries** (`7e7a314`): `cpSync` now uses `dereference: true` so symlinked entries copy their target's contents.
- **TUI `from:` label missing on inbound notify** (`d359733`): `extractParty` in `NewsView.tsx` now matches `notify` and `message` types in the inbound branch.
- **Refuse-with-error exit code** (`3e8858f`): `id-agents sync` exits non-zero (was 0) when refusing to deploy onto a workspace with a pre-existing `AGENTS.md` not in our receipt.

### Tests

- 377 passing / 82 skipped: per-slice integration coverage for sync (4-case ownership), unsync, library enumeration (both shapes), per-runtime mapping, memory-file fallback (Claude sidecar + Codex/Cursor append), drift detection, idempotency.

## 0.1.68-beta

### Features

- **Default `trigger: true` on replies with `in_reply_to`**: when an agent posts a reply to `/news` with `in_reply_to` set, the receiver is now auto-woken by default instead of the reply sitting passively in the inbox. Closes the gap where a long-running pair-program loop (lead dispatches to worker, worker exceeds lead's poll window) required an external kick to resume. New helper `resolveNewsTrigger({in_reply_to, trigger})` in `src/core/messaging-service.ts`; applied in both `src/claude-agent-server.ts` (worker `POST /news`) and `src/agent-manager-db.ts` (manager `POST /news`). Callers can still opt out with `trigger: false`.
- Loop safety double-gated: the existing triggered-branch passes `noAutoReply: true` to `startQuery`, and `craftNewsTriggerPrompt` instructs the LLM not to reply to the sender.

### Fixes

- **TUI multi-team blindness**: `fetchAgentNews` and `fetchAgentsLatestNewsTs` in `src/tui/api/manager.ts` now accept an optional `teamName` and pass it as `x-id-team` header. `src/tui/App.tsx` threads the selected agent's `teamName` through. Previously, news and news-timestamp requests were header-less and resolved against the daemon default team, which made the News view empty and the freshness dot gray for any agent not in the default team.

### Tests

- 311 passing / 82 skipped: 5 new `news-trigger-default` unit cases + 3 new `news-reply-triggers-receiver` integration cases.

## 0.1.67-beta

### TUI

- News view now shows a sender/recipient column between Type and Message: `from: <sender>` for inbound items, `to: <recipient>` for outbound items, blank for self-status events. `to:` is indented two spaces so the colons align with `from:`. Protocol-level `remote` is rewritten to `manager` to match message bodies.

## 0.1.66-beta

### Fixes

- **Parent Claude Code session env leak** (P0): when the manager was launched from a shell that was itself a child of a Claude Code session (`!<cmd>` inside claude, IDE integrated terminal, tmux pane from inside claude), the blanket `startsWith('CLAUDE')` filter in `spawnLocalAgentProcess` forwarded session-handoff vars (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_AGENT_SDK_VERSION`) into child agents. Child `claude` CLIs honored the leaked OAuth token ahead of their own keychain/login, leading to 401 on every dispatch while `/health` stayed green. Replaced with an explicit deny-list (`SESSION_HANDOFF_VARS`) in new `src/lib/env-hygiene.ts`; non-session `CLAUDE_*` config vars still forward. Boot now warns if the manager itself is running under a parent Claude session.
- **Silent-stop forensic trail** (P0, partial): added top-level `unhandledRejection` + `uncaughtException` handlers in `src/lib/fatal-handlers.ts`. Log with `[FATAL]` prefix and `process.exit(1)` so supervisors (systemd, launchd, nohup wrappers) can restart cleanly instead of the process limping along with a dead tick loop.
- **XMTP dependency declared** (P1): `@xmtp/node-sdk` is now an explicit `dependencies` entry (was resolving through `@xmtp/agent-sdk` hoisting only). Fresh installs no longer fail with `Cannot find module '@xmtp/node-sdk'`.

### Tests

- 299 passing / 82 skipped: 7 new env-hygiene cases, fatal-handlers coverage, +existing.

## 0.1.65-beta

### Features

- **Cursor CLI runtime**: new `runtime: cursor-cli` alongside `claude-code-cli` and `codex`. Ships `CursorCliHarness` (stdin prompt, stream-json parsing, `-f` force-trust, `--resume` + `--model`), profile in `src/runtime/registry.ts` with preflight auth check, `scripts/detect-runtimes.sh` advisory update, `configs/cursor-smoke.yaml`. CTO-approved with dedicated `.cursor/` paths and auth-missing-as-warning constraints.
- **Cursor stream-json parser** (bugfix): `CursorCliHarness` now recognizes cursor-agent's real event schema (`system/init`, `user`, `thinking/delta`, `thinking/completed`, `assistant`, `result{success|error}`), extracts the assistant reply, and synthesizes a result if the process exits cleanly without a terminal event. Fixes hang-forever behavior on every `/ask` to a cursor agent. 6 new parser unit tests.

### Changed

- **Task-endpoint team resolution**: `/tasks`, `/tasks/:ref/claim`, `/tasks/:ref/done` now resolve the caller's team from body `agent_id`/`from` when no `X-Id-Team` header is supplied (via new `resolveAcrossTeams(ref)` in the agents repo). Fixes `id-agents-app` (team `idchain`) being rejected as 404 because the default CLAUDE.md boilerplate omits the team header. **Note:** CTO flagged that this weakens cross-team isolation since body identity isn't authenticated — accepted as designed for this single-tenant local system where any caller already has full shell access. Explicit `X-Id-Team` headers still short-circuit the fallback and enforce the team they specify.

### Tests

- 286 pass, 82 skip: 6 new cursor parser tests + 2 new team-isolation integration tests.

### Docs

- admin-control skill: reword "Talk to the Human Manager" section to reflect the daemon-owned inbox — `/talk` persists regardless of whether a human is at the REPL.

## 0.1.63-beta

### Features

- **Long-poll on `GET /query/:id`**: optional `?wait=<0-30>` blocks until state change or timeout via an in-process waiter map keyed by `teamId:queryId`. Wakes fire from `POST /news` terminal transitions and `cancelPendingQueriesForAgent`. Default `wait=0` preserves existing behavior. Typical latency improvement: short-poll 5.8s → long-poll 4.1s for an `echo` dispatch.
- **Daemon `POST /schedule`**: scheduling endpoint mirrors the CLI surface so clients can schedule directly against `:4100` without depending on the REPL being up.

### Changed

- **Shared-DB query writes across all runtimes**: dropped the `DATABASE_URL` gate in `src/local-agent-server.ts` so SQLite agents now open and migrate the shared DB by default. Same fix extended to `src/start-agent-manager.ts` (worker role). Agents persist `pending`/`processing`/terminal rows so `:4100/query/<id>` is authoritative for both claude and codex runtimes. Memory-only fallback preserved with a warning.
- **`/talk` pre-writes `pending`**: agent `/talk` handler writes the query row before returning the `queryId`, eliminating the race where concurrent pollers saw 404 for a freshly-dispatched query.
- **Manager inbox moved to daemon**: `POST :4100/talk`, `POST :4100/schedule`, `GET :4100/news` are now authoritative for the `interactive_manager` inbox. The CLI REPL reads the same DB-backed view; inbox survives CLI outages.

### Removed

- **CLI `/remote` endpoint**: `POST http://127.0.0.1:4000/remote` removed. Dispatch lives exclusively on `POST http://127.0.0.1:4100/remote` with response shape `{ok, result:{queryId,status,agent}, error?}`. `MANAGER_URL` default in the admin-control skill flips from `:4000` to `:4100`.
- **Deprecated CLI write endpoints**: `POST :4000/talk`, `POST :4000/schedule`, `POST :4000/news` return `410 Gone` with `Location: http://127.0.0.1:4100/...`. `:4000/talk` for `server.respond()` remains.

### Tests

- `scripts/test-longpoll.sh`: new durable regression matrix (10 cases) covering single-agent claude and codex, backward-compat, concurrent parallel dispatch, kill-mid-flight, planted-stale-row, already-terminal, nonexistent-id, cancel-via-stop, and manager-restart mid-flight.

## 0.1.58-beta

### Features

- **TUI Tasks view**: new top-level page listing `/task` records, grouped by team with status color coding (done gray, todo yellow, doing green), per-row drill-in via `→` opening a full-page Task Detail view with title, description, owner, timestamps, and linked events.
- **TUI Calendar view**: new top-level page showing upcoming scheduled items sorted by next occurrence. Heartbeat-kind items are filtered out so they don't duplicate the Heartbeats view.
- **TUI Heartbeats view**: new top-level page listing agents with active heartbeats, showing interval, last fire, next fire, with per-row drill-in via `→` loading the agent's full `HEARTBEAT.md` in a scrollable body.
- **Per-agent news freshness indicator**: new `N` column on the Agents table showing a colored dot whose color reflects the age of the agent's most recent news item (greenBright < 1m → green < 5m → yellow < 15m → gray). Batched fetch per 2s poll cycle, bucketed against the 10s cooldown epoch so the dot only re-renders on band crossings.

### Changed

- **TUI navigation refactor**: Tasks is now a drill-down from Agents (press `t` to open, `←` to return) rather than a peer top-level view. Calendar and Heartbeats are peer top-level views reached via `c` / `h`. The `← back` hint is moved to the end of every footer so it reads as an exit action, and removed from top-level views where `←` has nowhere to go back to.

### Fixed

- **`idagents-admin-control` skill not loading**: added the missing YAML frontmatter (`name` + `description`) to `SKILL.md`. Without it Claude Code's skill loader silently skipped the skill, so new admin sessions couldn't pick it up.
- **Three polling onboarding gotchas in the admin-control skill**:
  - Wrong endpoint: introduced `MANAGER_DAEMON_URL` (default `http://127.0.0.1:4100`) for polling and reserves `MANAGER_URL` (port 4000) for dispatch. The old skill example pointed polling at port 4000 which has no `/query/:id` route.
  - IPv6 vs IPv4 collision: all examples and shell scripts now use `127.0.0.1` instead of `localhost` so polling doesn't silently hit a different dev server listening on `[::1]:4000`.
  - QueryId extraction: the `/remote /ask` response returns `result` as a human-readable string (not a structured `queryId` field). Documented the `query_[0-9a-z_]+` regex extraction explicitly with a structured-field fallback.
- **Calendar + Heartbeats scroll-drawing artifacts**: the `TeamsPanel` chips bar has variable height that made fixed `*_CHROME_ROWS` constants unreliable, causing the list to overflow the terminal by 2-3 rows on narrow widths and scroll the previous frame up on every redraw (leaking chrome fragments). Calendar drops the chips bar entirely; Heartbeats stabilizes the chrome calculation so it no longer overflows.

### Removed

- **`feature/tui-dashboard` worktree and branch**: the worktree was useful during initial TUI development but all TUI work has been merged back to main. The tui agent now works on the main checkout directly alongside `agents` and `cto`. Local worktree removed, local + origin branches deleted.

## 0.1.57-beta

### Changed

- **QUICKSTART.md consolidated Launch section**: a single `## 8. Launch a User Surface (Optional)` block now documents the three ways to interact with a running team (Claude Code as manager via the `idagents-admin-control` skill, the TUI dashboard via `npm run tui:dev` / `npm run tui`, and the interactive CLI via `npm run id-agents`) with copy-pasteable start commands. Removes the older piecemeal mentions that were scattered across Step 6 and a separate TUI step.

## 0.1.56-beta

### Features

- **`/news-to` trigger passthrough**: the agent-local `/news-to` helper now accepts an optional `trigger: true` field and passes it through to the target's `/news` endpoint. Enables async delegation (recipient processes the message, no sync reply) as a third pattern alongside `/talk-to` (sync delegation) and plain `/news-to` (passive notification).

### Fixed

- **Manager inbox write-path routing**: the `/agents` catalog was returning the interactive CLI's port (4000) as the URL for the manager identity, so `/news-to manager` calls from agent wrappers died at a dead port. Fixed by storing the daemon's `managementPort` on the manager instance and returning `http://localhost:<managementPort>` for interactive-type agents in `agentToResponse`. Wrappers re-fetch `/agents` on every `/news-to` call, so no fleet rebuild is required.
- **Manager inbox read-path routing**: the `/remote /news <agent>` command computed `baseEndpoint` directly from the DB row, bypassing `agentToResponse` entirely. For interactive agents this still resolved to port 4000. Fixed by short-circuiting the read path for `type === 'interactive'` to read directly from `news_items` via the DB, using the same `findInteractive` lookup that `POST /news` uses for writes.

### Changed

- **`inter-agent` skill promotes trigger examples to the top**: the three canonical usage patterns (`/talk-to`, `/news-to` plain, `/news-to` + `trigger:true`) are now the first thing agents see in the skill, each as a fully-formed copy-pasteable curl block. Added a prominent warning that `trigger:true` must be a literal boolean in the JSON body — omitting it is a silent delivery failure. Added a decision helper: when in doubt between `/news-to` + `trigger:true` and `/talk-to`, use `/talk-to`. Changes lifted to the top of the skill so they're the nearest reference material when an LLM is constructing a curl call.

## 0.1.55-beta

### Features

- **`GET /query/<id>` on the manager daemon**: new queryId-based polling primitive. Returns `{ query_id, status, result?, error?, agent, created_at, completed_at? }` with lifecycle `pending | processing | delivered | failed | expired`. Replaces the fragile timestamp-filter polling pattern used by the admin-control skill. Composes cleanly with the inbox redesign: `POST /talk manager` creates a query record; `GET /query/<id>` is the deterministic wait mechanism.
- **`/news-to` on agent's local wrapper**: mirror of `/talk-to` for fire-and-forget notifications. Payload `{ to, message, data? }`. Looks up target via the manager catalog, POSTs directly to target's `/news`, returns 202 immediately. Two-verb model: `/talk-to` when you want a reply, `/news-to` when you don't.
- **Manager daemon serves `/talk` and `/news` for the `manager` identity**: the manager inbox no longer depends on the interactive CLI being online. Agent-to-manager escalations land in a durable DB-backed inbox regardless of whether any human surface is connected.
- **`/news ?since_id=<n>&limit=N` cursor**: server-side monotonic cursor on `/news` on both agent and manager endpoints. Replaces the timestamp-filter race-prone pattern. Timestamp `?since=<ms>` still accepted for one release with a deprecation header.
- **Stuck-query sweeper**: background task marks queries older than a timeout as `failed` or `expired`, so crashed agents no longer leave queries stuck in `pending` forever.
- **`kind` and `reply_expected` metadata on news items**: structured fields layered on top of existing typed events (`query.received`, `outbound.reply`, etc.) so downstream UIs can filter by semantic intent rather than guessing from event type.
- **Task short UUIDs**: every task record now carries a random short UUID. Manager commands accept either `name` or `#shortid` (first 8 chars) as a reference. Unambiguous even when names collide across teams or contexts.

### Changed

- **`inter-agent` skill rewritten for two-verb model**: `/talk-to` (reply expected) and `/news-to` (fire-and-forget). Drops `/message` from agent-facing examples. Zero flags. Teaches the long-running-work pattern (quick `/talk-to` ACK followed by delayed `/news-to` from the worker when results are ready).
- **`idagents-admin-control` skill rewritten for queryId polling**: primary wait pattern is now `GET /query/<id>` until status is terminal. Timestamp-filter polling moved to a legacy footnote. Polls documented as background-only (`run_in_background: true`) with sensible defaults.

### Deprecated

- **`POST /message` on the manager daemon**: returns a deprecation warning in the response header and logs. Functional for one release, will be removed in a subsequent version. Callers should switch to `/news-to` (fire-and-forget) or `/talk-to` (sync) on the agent's local wrapper.

### Fixed

- **`--dangerously-skip-permissions` default behavior**: agent spawn now defaults to skip-permissions for both claude-code-cli and codex runtimes when the YAML `dangerouslySkipPermissions` field is unset. Explicit `false` is honored. The codex equivalent (`--dangerously-bypass-approvals-and-sandbox`) is wired for codex-runtime agents.
- **Permissions documentation**: QUICKSTART and README softened from "forced" to "default-with-override," clarifying that agents run with bypass by default but the user can set explicit `false` in config.
- **TUI documentation shipped across the repo**: new `docs/guides/tui.md`, Quick Start subsection in README, new step in QUICKSTART, link in `docs/README.md`.

## 0.1.54-beta

### Features

- **TUI monitoring dashboard**: New real-time terminal dashboard at `src/tui/`, invoked with `npm run tui:dev` (source) or `npm run tui` (built). Three-page stack (agents list → news list → news detail) navigated via `←`/`→`; `↑`/`↓` for row selection and scrolling; `Tab`/`Shift+Tab` to cycle team filter. Includes a compact status strip showing one glyph per agent across the full fleet, per-type news item colors, and an age-colored cooldown indicator fading bright green → green → yellow → gray at 15 minutes. Built on `ink` + React. Flicker-free on iTerm2 via a stdout transform that rewrites ink's erase-and-redraw escape sequences to cursor-home overwrites, combined with fixed-height padded layouts on both pages.
- **`tui` agent in `idchain` config**: New team member with `workingDirectory` set to a git worktree (`feature/tui-dashboard`) so dashboard development does not block work on `main`. Demonstrates the worktree-based agent pattern.

### Changed

- **Skill rename**: `admin-control` → `idagents-admin-control` across the skills directory, docs, and references. Disambiguates the skill when loaded alongside other admin tools.
- **QUICKSTART.md Step 6**: Now instructs Claude to offer to continue as the team manager via `/remote` after deploy completes, instead of handing the user off to a separate interactive CLI terminal.
- **README.md Quick Start**: Leads with the agent-driven quickstart (paste the skill, ask Claude to run QUICKSTART.md). Manual install demoted to a secondary subsection.
- **Polling guidance in `idagents-admin-control`**: Dispatch and poll are now documented as two distinct steps. Poll is marked background-only with `run_in_background: true` and max wait bumped from 2 minutes to 10 minutes. A new Anti-patterns subsection warns against combined dispatch+poll blocks and foreground polling.

### Fixed

- **`/ask manager` self-trap at the CLI**: The interactive CLI now rejects `/ask manager` with a friendly hint pointing to `/talk`. `manager` is reserved in `name-validation.ts`. Agent-to-manager escalation via `inter-agent-tools` is preserved because that path is legitimate.
- **Missing API key produces a hint, not a stack trace**: Spawning a claude-runtime agent without `ANTHROPIC_API_KEY`, or a codex agent without `OPENAI_API_KEY`, now prints a single-line setup hint at spawn time. Manager startup is unaffected.
- **`/team` and `/teams` empty states**: When no teams exist, the commands print a friendly message pointing to `/team <name>` or `/deploy <config>` instead of showing a stale `default` header.
- **Hide `manager` row from `/agents` CLI listing**: The interactive CLI filters out `type === 'interactive'` rows when printing the agents table. `GET /agents` still returns the row for admin tooling and `/remote` dispatchers.

### Removed

- **Root `HEARTBEAT.yaml`**: Retired in favor of per-agent `HEARTBEAT.md` (introduced in 0.1.52). The untracked `HEARTBEAT.md` at the repo root is now gitignored.

## 0.1.53-beta

### Features

- **Runtime-aware agent paths**: Template loader, skill deployer, directory overlay, and personality file write are now all runtime-aware. Claude agents use `.claude/agents/`, `.claude/skills/`, and `.claude/CLAUDE.md`. Codex agents use `.agents/`, `.agents/skills/`, and `AGENTS.md` (at project root).
- **`getRuntimePaths(runtime)`**: New function in `runtime/registry.ts` returns `{ templateDir, overlayTarget, skillsDir, personalityFile, personalityFilename }` for any runtime. Adding a third runtime later requires one new case in this function.
- **Codex template support**: `loadSubAgentTemplate()` checks `.agents/{name}/AGENTS.md` (directory) or `.agents/{name}.md` (file) for Codex agents. `processConfig()` passes `agent.runtime` through for correct lookup.

### Changed

- `loadSubAgentTemplate()`, `copyAgentDirOverlay()`, `copyHeartbeatMd()` all accept an optional `runtime` parameter.
- `deploySkillsToAgent()` accepts `runtime` in its options and writes to the runtime-appropriate skills directory.
- All 4 spawn sites (spawn endpoint, sync-changed, sync-added, remote-deploy) use `getRuntimePaths(effectiveRuntime)` for personality file path.

## 0.1.52-beta

### Features

- **Agent-driven heartbeats via HEARTBEAT.md**: Heartbeat messages move out of YAML config and into a `HEARTBEAT.md` checklist file in the agent's template directory. The scheduler sends a generic wake-up; the agent reads its own checklist and decides what to do.
- **Simplified heartbeat config**: `heartbeat:` in YAML now accepts a plain number (seconds) for the new model. Legacy `heartbeat: {interval, message}` objects still work for backward compatibility.
- **HEARTBEAT.md copy at spawn**: At spawn time, if the agent template directory contains a `HEARTBEAT.md`, it is copied to `{workingDirectory}/HEARTBEAT.md` for the agent to read at runtime.
- **Silent HEARTBEAT_OK**: When an agent responds with exactly `HEARTBEAT_OK`, the response is suppressed from the news feed and logged at debug level only. Keeps the news feed clean when nothing needs attention.

### Removed

- **HEARTBEAT.yaml write at spawn**: The manager no longer writes `HEARTBEAT.yaml` files to agent working directories at spawn time. The new model uses `HEARTBEAT.md` from the agent template directory instead.

### Changed

- `heartbeatToSchedule()` now accepts `number | HeartbeatConfig` — sends the generic wake-up message for number config, custom message for legacy objects.
- `readHeartbeatConfig()` checks both `HEARTBEAT.yaml` (legacy) and `HEARTBEAT.md` (new model).
- `idchain.yaml` heartbeat entries simplified from `{interval, message}` objects to plain numbers.

## 0.1.51-beta

### Features

- **Directory overlay on spawn**: When an agent has a directory-based template at `.claude/agents/<name>/`, the entire directory is recursively copied into `{workingDir}/.claude/` as an overlay at spawn time. This copies skills, hooks, settings, MEMORY.md, and any other agent-specific files alongside the CLAUDE.md instructions. Uses `fs.cpSync` with `{ recursive: true, force: true }`.
- **Spawn order guarantee**: All four spawn paths (deploy, sync-changed, sync-added, remote-deploy) now follow the same order: (1) deploy team skills, (2) overlay agent directory template, (3) write CLAUDE.md with protocol defaults + role body. This ensures agent-specific files overlay team skills, and CLAUDE.md is always written last.
- **`agentTemplate` field**: The `agent` config field is now passed through as `agentTemplate` in spawn payloads, allowing the overlay to use a different template directory than the agent's own name.

## 0.1.50-beta

### Breaking Changes

- **Removed `claudeMd` and `claudeMdFile`** from YAML config (`AgentSpec` and `DeployConfig.defaults`). Agent instructions now come from exactly two sources: framework protocol defaults (injected automatically) and agent role files (`.claude/agents/<name>.md`). YAML config is infrastructure only.

### Features

- **Protocol defaults** (`src/protocol-defaults.ts`): Scheduling, task-discipline, and output convention rules are now a framework-managed constant, prepended to every agent's `CLAUDE.md` at spawn time. Previously these lived as inline YAML in `defaults.claudeMd`.
- **Agent role files**: The `.claude/agents/<name>.md` template body (from 0.1.49) is now the sole source of user-controlled agent instructions. Exposed as `roleBody` on `AgentSpec`.

### Removed

- `defaults.claudeMd` / `defaults.claudeMdFile` config fields
- `agents[].claudeMd` / `agents[].claudeMdFile` config fields
- `resolveClaudeMdFile()` function from config-parser
- `claudeMd` merge logic from `mergeDefaults()`
- `claudeMd` from sync diff fields (protocol defaults are always written)

## 0.1.49-beta

### Features

- **Sub-agent templates**: Agents can now load personality and context from `.claude/agents/<name>.md` files in their `workingDirectory`. The markdown body is prepended to the agent's `claudeMd` at deploy/sync time. Frontmatter `description` is used as a fallback when the config doesn't set one. Use the `agent` field in config to load a template with a different filename (e.g., `agent: security-audit` loads `security-audit.md` instead of the agent's own name).

### New config field

- `agents[].agent` — optional string, loads `.claude/agents/<agent>.md` instead of `.claude/agents/<name>.md`.

## 0.1.48-beta

### Features

- **Always-on task discipline**: Embedded the full task lifecycle rules directly into `defaults.claudeMd` in `configs/idchain.yaml`. Claude Code skills are lazy-loaded (body only enters context on invocation), so the skill file alone was dormant. The rules are now always in context for every idchain agent, matching how the output convention and scheduling sections already work.

### Documentation

- Added a note to `skills/task-discipline/SKILL.md` clarifying that idchain agents get the rules via `defaults.claudeMd` and the skill file is kept as reference.

## 0.1.47-beta

### Features

- **`task-discipline` skill**: New skill that enforces the task lifecycle (create/claim/done) for any multi-step work or work producing artifacts. Agents with this skill automatically use the `/tasks` system and include task names in replies.
- **idchain defaults**: Added `task-discipline` to the default skills list in `configs/idchain.yaml`, so all agents in the idchain team inherit it.

### Documentation

- Updated `docs/guides/tasks.md` with a "Making it required" section explaining how to enable/disable the skill per agent via config.

## 0.1.46-beta

### Safety

- **Empty-team requirement on `/team delete`**: Refuses to delete a team that still has agents. Operator must run `/delete --team <name>` first to empty the team, then `/team delete <name>` to remove the team record. Three explicit actions required to fully wipe a team.
- **Name validation for teams and agents**: At creation time, team and agent names are rejected if they match reserved command verbs (delete, deploy, sync, etc.), contain shell wildcards (`*`, `?`, `[`, `]`), start with `-` or `--`, contain whitespace or control characters, are empty, or exceed 64 characters. Existing teams and agents are grandfathered.

## 0.1.45-beta

### Features

- **Bulk delete**: `/delete *` deletes all agents in the current team. `/delete --team <name>` targets a specific team. Confirmation required in interactive CLI. Working directories are never touched.
- **Agent output convention**: Agents now write artifacts to `./output/` by convention (injected into CLAUDE.md at deploy time).
- **`/output <agent>`**: Lists files in an agent's output directory with filename, size, and modification time.
- **`/artifact <agent> <path>`**: Reads a file from an agent's output directory. Rejects directory traversal and files over 1MB.

### Documentation

- Added `/task` usage guide (`docs/guides/tasks.md`) covering the handoff pattern and stale task verifier.
- Added `/news` clarification guide (`docs/guides/news-feed.md`) distinguishing news from task tracking and artifact sharing.
- Added agent outputs guide (`docs/guides/agent-outputs.md`).

## 0.1.44-beta

### Bug Fixes

- **`defaults.register` propagation**: `register: false` in config defaults now correctly propagates to agents that don't set `register` explicitly. Previously only agent-level `register` was respected.
- **`getDeployerAddress()` null safety**: Returns `null` instead of throwing when no OWS wallet or private key is configured. Deploys with `register: false` no longer require wallet configuration.

## 0.1.43-beta

### Features

- **`/sync` command**: New config reconciliation command that updates running teams without full teardown. Diffs agents into new/removed/changed/unchanged categories and applies minimal changes.
- **Orphan process fix**: `/deploy` now kills old agent processes before deleting DB records, preventing port leaks.

### Documentation

- Added `/sync` command guide and updated all deployment docs with `/sync` vs `/deploy` distinction.
