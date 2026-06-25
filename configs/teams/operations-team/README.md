# operations-team

The crew that runs your day‑to‑day operations — **git & projects, releases, monitoring,
and maintenance** — with a dedicated **git‑manager** that keeps the control center's
**Projects** page current.

## Roster

- **ops-lead** ⭑ — the coordinator. Triages ops requests, delegates to the specialists,
  reports one clear status, and escalates anything risky (production pushes, mainnet,
  deletes) to you. *(skills: defaults + `team-coordinator`, `brain`)*
- **git-manager** — owns the git repos under your **projects root**
  (`id-agents/workspace/projects/` — brain, chat, the `bittrees-*` apps, the control
  center, etc.). It runs `git status`, commits meaningful changes with clear messages,
  keeps branches tidy, and keeps the working tree clean so the **Projects page's scan
  shows accurate, current state** (branch, ahead/behind, dirty files, last commit).
  *(skills: defaults + `brain`)*
- **deployer** — build / CI / release: builds + tests, cuts versioned releases and tags,
  deploys (with a confirm before any production deploy), rolls back on failure.
- **monitor** — reliability: health probes, log tails, incident flags with next steps.
- **maintainer** — routine upkeep: dependency updates, cleanup, scheduled chores, small
  scripts — proposed as commits for the git‑manager to land.

## How the git‑manager keeps the Projects page up to date

The Projects page reflects the **git state of the repos under your projects root**. The
git‑manager keeps those repos committed, pushed (when you ask), and clean, so what the
page scans is real and current. Ask it things like:

> git‑manager: give me a status of every project — branch, ahead/behind, and uncommitted
> changes — then commit the safe ones with good messages and tell me which need a push.

### Guardrails (baked into the git‑manager)

- **Commits freely; pushes carefully.** It pushes only when you ask or to a non‑production
  branch, **never force‑pushes**, and **never pushes a branch that auto‑deploys to
  production** (e.g. `chat`/chirpy → `main`) without your confirmation.
- Treats repos you flag as read‑only (e.g. upstream `id-agents`) as **off‑limits for
  writes**.

## Build it

From the control center: **HR Manager → Build → "+ From template" → operations-team**,
name your team, and **pick the runtime/model per agent** when you build (the template
defaults to `codex`, which gives the git‑manager and deployer real shell access).

Or from the manager directly:

```
POST /library/install
{ "from": "team:operations-team", "to": "team:<your-team>" }
```

Then deploy with `/sync <your-team>` and, in **HR Manager → Structure**, make **ops-lead**
the team coordinator and tune any agent's goals with **✦ AI draft**.

## Run it

Message **ops-lead** (or the **git-manager** directly) in Chat, e.g.:

> Keep my projects in shape: status every repo under the projects root, commit anything
> safe with clear messages, and list what's ahead of its remote so I can review pushes.
