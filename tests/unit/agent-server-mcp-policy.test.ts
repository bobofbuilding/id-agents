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
  });

  it('keeps MCP available for normal delegated task work', () => {
    expect(shouldSuppressMcpForPrompt(`[Message from the manager (your owner/operator) | Query ID: q4]
[Respond directly and helpfully — this is the person who manages you.]

Resume and complete task #60c39e90: Inventory MCP servers, plugins, connectors, integrations.`)).toBe(false);

    expect(shouldSuppressMcpForPrompt('Implement a filesystem-backed MCP integration and cite the changed files.')).toBe(false);
  });
});
