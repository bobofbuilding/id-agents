# Contributor Workflows Index

Use this index to find the documented path for a contribution without reading
every guide first. Each workflow has a stable heading and a set of search
keywords that can be found with `rg`.

## Search this documentation

From the repository root, search headings, keywords, and linked guides:

```bash
rg -ni --glob '*.md' \
  'onboard|setup|install|update|troubleshoot|CI|accessib|task lifecycle|claim|done|handoff|delegat|test|pull request|release|agent library' \
  CONTRIBUTING.md docs/guides docs/README.md
```

To search this index only, use `rg -ni '<keyword>' docs/guides/contributor-workflows.md`.

## Workflow map

| Workflow | Search keywords | Start here | Outcome |
| --- | --- | --- | --- |
| Install a clean development host | `onboard`, `setup`, `install`, `macOS`, `Linux`, `WSL` | [Cross-platform prerequisites](./cross-platform-install.md#1-install-host-prerequisites) | A working local environment |
| Update or troubleshoot a checkout | `update`, `upgrade`, `troubleshoot`, `runtime`, `port`, `SQLite` | [Safe update procedure](./cross-platform-install.md#5-safe-update-procedure) and [troubleshooting](./cross-platform-install.md#troubleshooting) | A current, diagnosed checkout |
| Pick up and complete assigned work | `task lifecycle`, `claim`, `doing`, `done`, `task` | [Task tracking](./tasks.md) | An auditable task transition |
| Delegate or hand off a work slice | `delegate`, `handoff`, `brief`, `checkin`, `validation` | [Delegation runbook](./delegation-runbook.md) | A clear, supervised ownership transfer |
| Prepare a dispatch-ready task brief | `task brief`, `acceptance criteria`, `validation path`, `scope` | [Task-brief template](./delegation-task-template.md) | A task another contributor can claim |
| Run the pull-request CI gate | `CI`, `preflight`, `lint`, `typecheck`, `test`, `build` | [CI workflow](../../.github/workflows/ci-preflight.yml) and [local preflight](../../CONTRIBUTING.md#development-setup) | The same quality gate locally and in CI |
| Review mobile accessibility | `accessibility`, `a11y`, `screen reader`, `label`, `hint`, `touch target` | [Accessibility verification](#mobile-accessibility-verification) | Accessible mobile interaction changes |
| Add an agent or reusable skill | `agent library`, `skill`, `configs`, `license`, `notice` | [Agent library contributions](../../CONTRIBUTING.md#contributing-agent-library-entries) | A properly attributed library entry |
| Share a generated artifact | `output`, `artifact`, `report`, `analysis` | [Agent outputs](./agent-outputs.md) | A retrievable artifact in `./output/` |
| Reconcile a running team after config changes | `sync`, `deploy`, `workspace`, `agent config` | [Sync command](./sync-command.md) | A running team aligned with config |
| Report a defect | `bug`, `issue`, `reproduce`, `logs` | [Reporting issues](../../CONTRIBUTING.md#reporting-issues) | An actionable bug report |

## Install, update, and troubleshoot a local checkout

**Keywords:** `onboard`, `setup`, `install`, `update`, `upgrade`, `troubleshoot`,
`environment`, `build`, `test`, `macOS`, `Linux`, `WSL`.

1. For a clean host, follow the [cross-platform install guide](./cross-platform-install.md),
   including the platform-specific macOS, Linux, or Windows WSL prerequisites.
2. For an existing checkout, use the [safe update procedure](./cross-platform-install.md#5-safe-update-procedure)
   before changing dependencies or reconciling a running team.
3. Diagnose dependency, runtime, port, authentication, WSL, permission, and
   local SQLite failures through [Troubleshooting](./cross-platform-install.md#troubleshooting).
4. Run the commands in [Development setup](../../CONTRIBUTING.md#development-setup)
   to build, develop, use the CLI, and test.
5. Read [Project structure](../../CONTRIBUTING.md#project-structure) before making
   a change so implementation, tests, docs, and library entries land in the
   expected locations.

## Task lifecycle: claim, work, and close

**Keywords:** `task lifecycle`, `todo`, `claim`, `doing`, `done`, `owner`,
`acceptance`.

1. For assigned work, use the task name and claim/done URLs supplied in the
   dispatch brief; do not create a duplicate task.
2. Claim the task before starting work. The state becomes `doing` and identifies
   the owner.
3. Keep the implementation within the stated acceptance criteria, then verify
   it with the relevant test, build, or documentation search.
4. Mark the task `done` with a concise evidence packet: paths changed, commands
   run, and any remaining risk.

The [Task tracking guide](./tasks.md) explains task states and query patterns.
The [Task discipline skill](../../skills/task-discipline/SKILL.md) defines the
required lifecycle for multi-step contributor work.

## Delegation and contributor handoff

**Keywords:** `delegate`, `handoff`, `task brief`, `claim URL`, `done URL`,
`checkin`, `validation`.

When splitting work, create one bounded child task per independent outcome,
include explicit acceptance criteria and claim/done URLs, then supervise it with
the documented check-in flow. Use the [Delegation runbook](./delegation-runbook.md)
for the lead workflow and the [task-brief template](./delegation-task-template.md)
for the required field labels.

For normal asynchronous updates, use the [News feed guide](./news-feed.md).
When work produces a report, analysis, or generated artifact, follow the
[agent output convention](./agent-outputs.md).

## Change, test, review, and release

**Keywords:** `code`, `preflight`, `test`, `build`, `commit`, `pull request`,
`release`, `version`, `changelog`.

1. Make focused TypeScript changes that follow existing code patterns.
2. Add or update tests, then run `npm run ci:preflight` to reproduce the
   checked-in pull-request gate locally; run a build when the change can affect
   types or packaging.
3. Use a clear present-tense commit message and open a pull request with a
   concise description.
4. For a release, follow the version, changelog, release-commit, and tag
   requirements in [Versioning and publishing](../../CONTRIBUTING.md#versioning-and-publishing).

The canonical contribution requirements are in
[Making changes](../../CONTRIBUTING.md#making-changes).

## Mobile accessibility verification

**Keywords:** `accessibility`, `a11y`, `screen reader`, `VoiceOver`, `TalkBack`,
`label`, `hint`, `state`, `action`, `touch target`.

For mobile interaction changes, keep form controls and actions understandable
without relying on visual context. Verify accessible labels, hints, roles,
disabled/selected/busy state, explicit accessibility actions, and at least
44-point touch targets where applicable. The current reference surfaces are:

- [Command input](../../mobile/src/components/CommandInput.tsx) for labeled input,
  send-button state, and touch-target sizing.
- [Server connection](../../mobile/src/screens/ScanScreen.tsx) for labeled fields,
  permission actions, manual-entry actions, and busy state.
- [Saved servers](../../mobile/src/screens/SettingsScreen.tsx) for selected state,
  accessible activate/delete actions, and the add-server action.

Search the implementation before review with
`rg -n 'accessibility(Label|Hint|Role|State|Actions)|onAccessibilityAction|minHeight' mobile/src`.
Exercise the changed flow with VoiceOver or TalkBack when device or simulator
access is available, and record that manual result alongside automated checks.

## Agent-library and skill contributions

**Keywords:** `agent library`, `agent`, `skill`, `configs`, `license`, `notice`,
`attribution`.

Put agent entries and standalone skills in the documented `configs/` locations,
keep `agent:` and `skills:` examples as peer fields, preserve upstream licenses,
and update `NOTICE` when importing redistributable material. See
[Contributing agent library entries](../../CONTRIBUTING.md#contributing-agent-library-entries)
for the supported layouts and attribution requirements.

## Related indexes

- [Documentation home](../README.md) — architecture, guide, protocol, and reference entry point.
- [Contributing guide](../../CONTRIBUTING.md) — project-level contribution requirements.
- [Skills overview](../../skills/README.md) — reusable contributor capabilities.
