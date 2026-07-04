import { describe, expect, it } from 'vitest';
import { allowedToolsForPrompt, queryExecutionTimeoutMsForPrompt, shouldSuppressMcpForPrompt } from '../../src/claude-agent-server.js';

describe('agent server MCP prompt policy', () => {
  it('suppresses MCP for manager supervision and heartbeat control-plane prompts', () => {
    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: q1]
[Respond directly and helpfully — this is the person who manages you.]

Supervision: task #12345678 has been in progress 48m with no completion.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: q2]
[Respond directly and helpfully — this is the person who manages you.]

Backlog guard: task #12345678 has been active 60m with no progress update.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: q3]
[Respond directly and helpfully — this is the person who manages you.]

Heartbeat: review your checklist and act on anything that needs attention.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt('Heartbeat: review your checklist and act on anything that needs attention.')).toBe(true);
    expect(shouldSuppressMcpForPrompt('Backlog guard: task #12345678 has been active 60m with no progress update.')).toBe(true);
    expect(shouldSuppressMcpForPrompt('Backlog guard alert: task #12345678 has stalled and needs owner triage.')).toBe(true);
    expect(shouldSuppressMcpForPrompt('Urgent: task #12345678 has been stalled 88+ minutes on ops-team with no progress.')).toBe(true);
    expect(shouldSuppressMcpForPrompt('Status check on task #12345678. Reply in one sentence.')).toBe(true);
    expect(shouldSuppressMcpForPrompt('Lead delegation kickoff: task #12345678 is assigned to you as the team coordinator.')).toBe(true);
    expect(shouldSuppressMcpForPrompt('Team objective: Decompose this objective into member-owned work.')).toBe(true);
  });

  it('suppresses MCP for incoming-reply processing loops', () => {
    expect(shouldSuppressMcpForPrompt(`[Message from agent "researcher" | Query ID: news_123]
[Note: researcher will poll for your reply for ~2 minutes.]

[Incoming Reply from "researcher"]

{"validation_status":"blocked"}

IMPORTANT INSTRUCTIONS:
DO NOT send a message or reply back to "researcher"`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from agent "ops-lead" | Query ID: news_456]
[Note: ops-lead will poll for your reply for ~2 minutes.]

[Incoming Message from "ops-lead"]

Onchain-execution triage needed. Restart/wake the onchain-execution team and triage the stalled backlog.

---

    IMPORTANT INSTRUCTIONS:
1. You have received a message from agent "ops-lead".
2. DO NOT send a message or reply back to "ops-lead" - this would create an infinite loop.`)).toBe(true);
  });

  it('suppresses MCP for check-in service wakes', () => {
    expect(shouldSuppressMcpForPrompt(`[Incoming Message from "checkin-service"]

Checkin due for linked task #12345678. Reply with a brief update or complete the task.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from agent "checkin-service" | Query ID: news_123]
[Note: checkin-service will poll for your reply for ~2 minutes.]

[Incoming Message from "checkin-service"]

Checkin due for linked task #12345678. Reply with a brief update or complete the task.`)).toBe(true);
  });

  it('suppresses MCP for inter-agent control-plane status relays', () => {
    expect(shouldSuppressMcpForPrompt(`[Message from agent "task-master" | Query ID: query_1]
[Note: task-master will poll for your reply for ~2 minutes.]

Assignment sweep complete (Jul 4). Assigned: 0. All 6 online agents across 3 teams blocked by stalled task backlogs.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from agent "lead" | Query ID: query_2]
[Note: lead will poll for your reply for ~2 minutes.]

No approved recommendation routed. The completed result was REVISE.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from agent "lead" | Query ID: query_3]
[Note: lead will poll for your reply for ~2 minutes.]

Already handled. Task #abc12345 is done with no active delegation.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: query_4]
[Respond directly and helpfully — this is the person who manages you.]

Task assignment sweep: inspect unassigned todo tasks across all teams and assign a bounded batch.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: query_5]
[Respond directly and helpfully — this is the person who manages you.]

You have 2 stalled doing tasks from before a team outage that need to be closed.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from agent "web-researcher" | Query ID: query_6]
[Note: web-researcher will poll for your reply for ~2 minutes.]

Backlog guard alert: task #88a70c23 ("Discover and evaluate candidate tools") has been active 142m+ with no progress update.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: query_7]
[Respond directly and helpfully — this is the person who manages you.]

Urgent: task #0abb791f has been stalled 88+ minutes on ops-team with no progress.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from agent "research-assistant" | Query ID: query_8]
[Note: research-assistant will poll for your reply for ~2 minutes.]

Status check on task #73b71406. You are the owner. Reply in one sentence.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: query_9]
[Respond directly and helpfully — this is the person who manages you.]

Lead delegation kickoff: task #f0b7515a is assigned to you as the team coordinator.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: query_10]
[Respond directly and helpfully — this is the person who manages you.]

Team objective: Decompose this objective into member-owned work.`)).toBe(true);

    expect(shouldSuppressMcpForPrompt(`[Message from agent "task-master" | Query ID: query_11]
[Note: task-master will poll for your reply for ~2 minutes.]

Validation request for run-baseline-cycle (#784ff464), goal goal_mr4khc5x_lf68y. Read the artifact and reply PASS or FAIL.`)).toBe(true);
  });

  it('keeps MCP available for normal delegated task work', () => {
    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: q4]
[Respond directly and helpfully — this is the person who manages you.]

Resume and complete task #60c39e90: Inventory MCP servers, plugins, connectors, integrations.`)).toBe(false);

    expect(shouldSuppressMcpForPrompt(`[Message from agent "researcher" | Query ID: q5]
[Note: researcher will poll for your reply for ~2 minutes.]

Please inspect the repository, edit the integration, and run the test suite.`)).toBe(false);

    expect(shouldSuppressMcpForPrompt('Implement a filesystem-backed MCP integration and cite the changed files.')).toBe(false);
  });

  it('restricts control-plane prompts to read-only local tools', () => {
    const configured = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

    expect(allowedToolsForPrompt('Supervision: task #12345678 has been in progress 48m.', configured))
      .toEqual(['Read', 'Glob', 'Grep']);
    expect(allowedToolsForPrompt('Please validate output/legal-routing-policy-8da84377.md against task #8da84377.', configured))
      .toEqual(['Read', 'Glob', 'Grep']);
    expect(allowedToolsForPrompt('Validation request for run-baseline-cycle (#784ff464), goal goal_mr4khc5x_lf68y. Read the artifact and reply PASS or FAIL.', configured))
      .toEqual(['Read', 'Glob', 'Grep']);
    expect(allowedToolsForPrompt('[Incoming Message from "checkin-service"]\n\nCheckin due for linked task #12345678.', configured))
      .toEqual(['Read', 'Glob', 'Grep']);
    expect(allowedToolsForPrompt('Lead delegation kickoff: task #12345678 is assigned to you as the team coordinator.', configured))
      .toEqual(['Read', 'Bash', 'Glob', 'Grep']);
    expect(allowedToolsForPrompt('Team objective: Decompose this objective into member-owned work.', configured))
      .toEqual(['Read', 'Bash', 'Glob', 'Grep']);
    expect(allowedToolsForPrompt('Implement a filesystem-backed MCP integration and cite the changed files.', configured))
      .toEqual(configured);
  });

  it('bounds control-plane and delegation query runtime while leaving normal work unbounded', () => {
    const priorControl = process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS;
    const priorValidation = process.env.ID_AGENT_VALIDATION_CONTROL_QUERY_TIMEOUT_MS;
    const priorDelegation = process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS;
    delete process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS;
    delete process.env.ID_AGENT_VALIDATION_CONTROL_QUERY_TIMEOUT_MS;
    delete process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS;

    try {
      expect(queryExecutionTimeoutMsForPrompt('Backlog guard: task #12345678 has been active 60m with no progress update.'))
        .toBe(90_000);
      expect(queryExecutionTimeoutMsForPrompt('Validation request for run-baseline-cycle (#784ff464), goal goal_1. Read the artifact and reply PASS or FAIL.'))
        .toBe(180_000);
      expect(queryExecutionTimeoutMsForPrompt('TASK DELEGATION from manager: You are assigned task #12345678 ("Bounded work").'))
        .toBe(720_000);
      expect(queryExecutionTimeoutMsForPrompt('Lead delegation kickoff: task #12345678 is assigned to you as the team coordinator.'))
        .toBe(720_000);
      expect(queryExecutionTimeoutMsForPrompt('Team objective: Decompose this objective into member-owned work.'))
        .toBe(720_000);
      expect(queryExecutionTimeoutMsForPrompt('Implement a filesystem-backed MCP integration and cite the changed files.'))
        .toBeUndefined();
    } finally {
      if (priorControl === undefined) delete process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS;
      else process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS = priorControl;
      if (priorValidation === undefined) delete process.env.ID_AGENT_VALIDATION_CONTROL_QUERY_TIMEOUT_MS;
      else process.env.ID_AGENT_VALIDATION_CONTROL_QUERY_TIMEOUT_MS = priorValidation;
      if (priorDelegation === undefined) delete process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS;
      else process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS = priorDelegation;
    }
  });

  it('clamps configured control-plane query timeouts', () => {
    const priorControl = process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS;
    process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS = '1000';

    try {
      expect(queryExecutionTimeoutMsForPrompt('Status check on task #12345678. Reply in one sentence.'))
        .toBe(15_000);

      process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS = '9999999';
      expect(queryExecutionTimeoutMsForPrompt('Status check on task #12345678. Reply in one sentence.'))
        .toBe(600_000);
    } finally {
      if (priorControl === undefined) delete process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS;
      else process.env.ID_AGENT_CONTROL_QUERY_TIMEOUT_MS = priorControl;
    }
  });

  it('clamps configured delegation query timeouts', () => {
    const priorDelegation = process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS;
    process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS = '1000';

    try {
      expect(queryExecutionTimeoutMsForPrompt('TASK DELEGATION from manager: You are assigned task #12345678 ("Bounded work").'))
        .toBe(60_000);

      process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS = '999999999';
      expect(queryExecutionTimeoutMsForPrompt('TASK DELEGATION from manager: You are assigned task #12345678 ("Bounded work").'))
        .toBe(3_600_000);
    } finally {
      if (priorDelegation === undefined) delete process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS;
      else process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS = priorDelegation;
    }
  });
});
