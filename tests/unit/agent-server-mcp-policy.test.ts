import { describe, expect, it } from 'vitest';
import { shouldSuppressMcpForPrompt } from '../../src/claude-agent-server.js';

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
});
