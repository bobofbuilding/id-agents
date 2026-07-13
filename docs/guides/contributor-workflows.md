# Contributor Workflows Index

Use this index to find the documented path for a contribution without reading
every guide first. Each workflow has a stable heading and a set of search
keywords that can be found with `rg`.

## Search this documentation

From the repository root, search headings, keywords, and linked guides:

```bash
rg -ni --glob '*.md' \
  'onboard|setup|task lifecycle|claim|done|handoff|delegat|test|pull request|release|agent library' \
  CONTRIBUTING.md docs/guides docs/README.md
```

To search this index only, use `rg -ni '<keyword>' docs/guides/contributor-workflows.md`.

## Workflow map

| Workflow | Search keywords | Start here | Outcome |
| --- | --- | --- | --- |
| Onboard and set up a local checkout | `onboard`, `setup`, `install`, `build`, `test` | [Development setup](../../CONTRIBUTING.md#development-setup) | A working local environment |
| Pick up and complete assigned work | `task lifecycle`, `claim`, `doing`, `done`, `task` | [Task tracking](./tasks.md) | An auditable task transition |
| Delegate or hand off a work slice | `delegate`, `handoff`, `brief`, `checkin`, `validation` | [Delegation runbook](./delegation-runbook.md) | A clear, supervised ownership transfer |
| Prepare a dispatch-ready task brief | `task brief`, `acceptance criteria`, `validation path`, `scope` | [Task-brief template](./delegation-task-template.md) | A task another contributor can claim |
| Implement, test, and submit a change | `code`, `test`, `build`, `commit`, `pull request` | [Making changes](../../CONTRIBUTING.md#making-changes) | A reviewable pull request |
| Add an agent or reusable skill | `agent library`, `skill`, `configs`, `license`, `notice` | [Agent library contributions](../../CONTRIBUTING.md#contributing-agent-library-entries) | A properly attributed library entry |
| Share a generated artifact | `output`, `artifact`, `report`, `analysis` | [Agent outputs](./agent-outputs.md) | A retrievable artifact in `./output/` |
| Reconcile a running team after config changes | `sync`, `deploy`, `workspace`, `agent config` | [Sync command](./sync-command.md) | A running team aligned with config |
| Report a defect | `bug`, `issue`, `reproduce`, `logs` | [Reporting issues](../../CONTRIBUTING.md#reporting-issues) | An actionable bug report |

## Onboarding and local development

**Keywords:** `onboard`, `setup`, `install`, `environment`, `build`, `test`.

1. Follow [Getting started](../../CONTRIBUTING.md#getting-started): fork, clone,
   install dependencies, and create your local environment file.
2. Run the commands in [Development setup](../../CONTRIBUTING.md#development-setup)
   to build, develop, use the CLI, and test.
3. Read [Project structure](../../CONTRIBUTING.md#project-structure) before making
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

**Keywords:** `code`, `test`, `build`, `commit`, `pull request`, `release`,
`version`, `changelog`.

1. Make focused TypeScript changes that follow existing code patterns.
2. Add or update tests and run the applicable test command; run a build when
   the change can affect types or packaging.
3. Use a clear present-tense commit message and open a pull request with a
   concise description.
4. For a release, follow the version, changelog, release-commit, and tag
   requirements in [Versioning and publishing](../../CONTRIBUTING.md#versioning-and-publishing).

The canonical contribution requirements are in
[Making changes](../../CONTRIBUTING.md#making-changes).

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
