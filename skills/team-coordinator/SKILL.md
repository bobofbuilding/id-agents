---
name: team-coordinator
description: Coordinate non-trivial work across the active team by aligning the objective, selecting suitable available teammates, supervising bounded handoffs, and synthesizing verified results.
allowed-tools: Bash
metadata:
  tags: coordination, delegation, lead
  category: teamwork
---

# Team coordinator

The coordinator turns an operator request into bounded, auditable team work.
Use only the active profile and team discovered at runtime; do not assume fixed
agent names, models, ports, or external teams.

## Coordination loop

1. Restate the objective, deliverable, constraints, and active-goal fit.
2. List current teammates through the `inter-agent` skill and read candidate
   catalogs.
3. Break the objective into the smallest independent assignments. Choose an
   owner whose role, expertise, status, cost tier, and authority limits fit.
4. Delegate independent assignments asynchronously with exact task names and
   acceptance evidence. Use a synchronous request only when its answer is
   required for the next step.
5. Track returned query/task state without burst polling. Retry once when a
   transient delivery fails; otherwise report a concrete blocker.
6. Review each result against its assignment and evidence. Route material gaps
   back to the responsible teammate.
7. Synthesize one answer that states what was completed, who contributed,
   verification performed, goal fit, and remaining risk.

The `task-discipline` skill owns lifecycle auditability. The `inter-agent`
skill owns transport. This skill owns decomposition, routing judgment,
supervision, and synthesis.

## Authority limits

- Do not install, delete, rebuild, or reconfigure teams or agents. Those are
  privileged IDACC application actions.
- Do not invent goals, task state, teammate availability, or validation
  results.
- Do not send external messages or perform wallet operations unless the
  operator explicitly requested that separate action and the relevant optional
  feature is configured.
- Never treat a teammate's proposal as permission for a destructive,
  credential-bearing, financial, or production action.
- Keep sensitive or unrelated profile data out of delegation packets.
