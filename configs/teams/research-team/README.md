# research-team

A coordinated research squad — **plan → gather → analyze → verify → write** — built to
answer a research question end to end and return a well‑sourced report.

## Roster

- **research-lead** ⭑ — the coordinator. Decomposes the question, delegates to the
  specialists via the inter‑agent skill, and synthesizes their findings into one answer.
  *(skills: defaults + `team-coordinator`, `brain`)*
- **web-researcher** — finds authoritative, recent sources (built‑in WebSearch/WebFetch)
  and returns sourced notes with URLs and dates.
- **analyst** — deep analysis: compares, evaluates, reasons about trade‑offs, rates
  confidence, surfaces gaps and open questions.
- **fact-checker** — independently verifies the analyst's claims against the cited
  sources and rates each (supported / weak / unsupported). *(skills: defaults + `brain`)*
- **writer** — turns verified findings into a structured, cited report for the requester.

## Shape

- **Inline agents** — persona via `description:` (no `configs/agents/` references). Web
  access comes from the agents' built‑in WebSearch/WebFetch tools, so no special skill is
  needed.
- **Default skills** (`identity`, `inter-agent`, `catalog`, `task-discipline`) are inherited
  by every agent; per‑agent `skills:` **merge** with the defaults (the lead adds
  `team-coordinator` + `brain`; the fact‑checker adds `brain`).
- **Runtime** defaults to `codex` with the account's default model. Change the runtime, or
  set per‑agent runtime/model, in the control center's **Build** flow — or edit `team.yaml`
  before installing.

## Install

From the control center: **HR Manager → Build → "+ From template" → research-team**, then
name your team.

Or from the manager directly:

```
POST /library/install
{ "from": "team:research-team", "to": "team:<your-team>" }
```

The destination is written to `<libraryRoot>/<your-team>.yaml` and gets a provenance header
(`# Installed from configs/teams/research-team/team.yaml on YYYY-MM-DD`). The source template
under `configs/teams/research-team/` is never overwritten; re‑installing requires `force:true`.

## After install

1. Deploy with `/sync <your-team>`.
2. In **HR Manager → Structure**, click an agent to tune its **goals/instructions** (try
   **✦ AI draft**), and make **research-lead** the team coordinator (and the primary lead if
   you run several teams).
3. Adjust cross‑team delegation under **Route** if this team should hand work to others.

## Run it

Message **research-lead** in Chat with your question and the depth you want, e.g.:

> Research the current landscape of on‑device LLM inference runtimes — compare the top four
> by speed, model support, and license, and give me a sourced brief with a recommendation.

The lead decomposes it, delegates gathering → analysis → fact‑check → write‑up to the
specialists, and returns a synthesized, cited answer.
