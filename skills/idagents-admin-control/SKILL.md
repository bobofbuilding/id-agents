---
name: idagents-admin-control
description: Respect the production boundary between agent coordination and privileged Manager administration in the unified IDACC application.
source_kind: bundled
license: MIT
---

# Manager administration boundary

IDACC owns the Manager process, its private administration credential, runtime
ports, profile directories, and recovery policy. Agent processes intentionally
do not receive that credential.

Use the dedicated `inter-agent`, `task-discipline`, `catalog`, and
`team-coordinator` skills for ordinary team work. Those skills describe the
scoped APIs available to an agent through its runtime-provided environment.

Privileged changes must go through the IDACC application:

- installing, removing, or replacing a team;
- changing models, runtimes, skills, or working directories;
- starting, stopping, rebuilding, or resetting agents;
- changing Manager or Brain configuration;
- registering public agents or changing wallet-backed identity;
- deleting data or applying another destructive operation.

When asked for one of those changes:

1. Explain the requested change and its likely impact.
2. Ask for confirmation when the target, scope, or destructive effect is
   unclear.
3. Direct the operator to the matching Manager or Settings control in IDACC.
4. Wait for the application to report the resulting state before claiming the
   change succeeded.

Do not call raw Manager command surfaces, synthesize administrator headers,
search for administrator credentials, edit bundled team YAML, launch a second
Manager, kill processes, or assume a service port or source-checkout path. A
failed health check is application-owned recovery work, not permission for an
agent to take over process supervision.

Read-only status exposed by an agent's normal coordination tools may be used to
describe current state. It is not authority to perform an administrative
mutation.
