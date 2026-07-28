---
name: catalog
description: Read and update the agent's advertised role, expertise, availability, cost tier, and routing constraints through its runtime-local catalog.
allowed-tools: Bash
---

# Agent catalog

The Manager advertises each agent's catalog to teammates. IDACC supplies the
agent's local service port through `ID_AGENT_PORT`; never assume a fixed port.

## Read the current catalog

```bash
curl -fsS "http://127.0.0.1:$ID_AGENT_PORT/catalog" \
  -H "X-Id-Team: $ID_TEAM" -H "X-Id-Agent: $ID_AGENT_ID" \
  -H "Authorization: Bearer $IDACC_MANAGER_AGENT_TOKEN"
```

## Update routing metadata

```bash
curl -fsS -X PATCH "http://127.0.0.1:$ID_AGENT_PORT/catalog" \
  -H "X-Id-Team: $ID_TEAM" -H "X-Id-Agent: $ID_AGENT_ID" \
  -H "Authorization: Bearer $IDACC_MANAGER_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description":"I validate implementation evidence and focused code changes.",
    "role":"engineer",
    "expertise":["implementation","review","testing"],
    "status":"available",
    "currentTask":null,
    "costTier":"medium",
    "notSuitableFor":["production deployment","credential changes"]
  }'
```

Catalog fields describe routing intent:

| Field | Meaning |
|---|---|
| `description` | A concise statement of the agent's responsibility. |
| `role` | A neutral functional role such as `lead`, `engineer`, or `researcher`. |
| `expertise` | Specific capabilities that help a coordinator choose this agent. |
| `status` | Current availability, normally `available`, `busy`, or `offline`. |
| `currentTask` | A short current assignment label, or `null`. |
| `costTier` | Relative routing cost: `low`, `medium`, or `high`. |
| `notSuitableFor` | Work this agent should not receive because of authority, risk, or capability limits. |

The Manager already knows the selected runtime, model, and profile-owned working
directory. Do not duplicate or guess those values in the catalog.

Set `status` to `busy` when beginning an assignment and back to `available` when
the assignment reaches a terminal state. Never advertise authority or
capabilities the agent does not actually have.
