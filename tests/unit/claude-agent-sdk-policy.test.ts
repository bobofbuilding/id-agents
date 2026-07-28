// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  buildClaudeSdkOptions,
  ClaudeAgentSdkHarness,
  claudeSdkToolPolicy,
} from '../../src/harness/claude-agent-sdk.js';

describe('Claude Agent SDK harness policy', () => {
  const filesystemMcp = {
    name: 'filesystem',
    command: 'node',
    args: ['server.js'],
  };

  it('removes every built-in tool for external text-only conversations', async () => {
    const policy = claudeSdkToolPolicy({
      executionPolicy: 'external-text-only',
      allowedTools: [],
    });
    expect(policy).toMatchObject({
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
    });
    expect(await policy.canUseTool?.(
      'Read',
      {},
      { signal: new AbortController().signal, toolUseID: 'external-read' },
    )).toMatchObject({ behavior: 'deny' });
  });

  it('disables settings, persistence, resume, plugins, and MCP in the isolated cwd', () => {
    const realWorkspace = '/consumer/projects/private-agent';
    const isolatedWorkspace = '/consumer/profile/manager/external-text-only/agents/id/workspace';
    const effective = buildClaudeSdkOptions({
      executionPolicy: 'external-text-only',
      allowedTools: ['Read', 'Bash'],
      workingDirectory: isolatedWorkspace,
      resume: 'owned-runtime-session',
      plugins: [{ name: 'private-plugin', path: realWorkspace }],
      mcpServers: [{ name: 'filesystem', command: 'node', args: ['server.js'] }],
    }, 'claude-test-model');

    expect(effective).toMatchObject({
      model: 'claude-test-model',
      cwd: isolatedWorkspace,
      tools: [],
      allowedTools: [],
      settingSources: [],
      persistSession: false,
    });
    expect(effective).not.toHaveProperty('resume');
    expect(effective).not.toHaveProperty('plugins');
    expect(effective).not.toHaveProperty('mcpServers');
    expect(JSON.stringify(effective)).not.toContain(realWorkspace);
  });

  it('fails closed instead of falling back to the process cwd when isolation is absent', () => {
    expect(() => buildClaudeSdkOptions({
      executionPolicy: 'external-text-only',
      allowedTools: [],
    }, 'claude-test-model')).toThrow(/requires an isolated working directory/i);
  });

  it('keeps normal session persistence and configured workspace behavior', () => {
    expect(buildClaudeSdkOptions({
      executionPolicy: 'default',
      workingDirectory: '/consumer/projects/agent',
      resume: 'owned-runtime-session',
    }, 'claude-test-model')).toMatchObject({
      cwd: '/consumer/projects/agent',
      resume: 'owned-runtime-session',
      persistSession: true,
    });
  });

  it('aborts the exact active SDK execution during timeout cleanup', () => {
    const harness = new ClaudeAgentSdkHarness();
    const abortController = new AbortController();
    (harness as any).abortController = abortController;

    expect(harness.cancel()).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(harness.cancel()).toBe(false);
  });

  it('uses configured tools as the normal exposure and auto-allow boundary', async () => {
    const policy = claudeSdkToolPolicy({
      executionPolicy: 'default',
      allowedTools: ['Read', 'Bash'],
    });
    expect(policy).toMatchObject({
      tools: ['Read', 'Bash'],
      allowedTools: ['Read', 'Bash'],
      permissionMode: 'dontAsk',
    });
    expect(await policy.canUseTool?.(
      'Read',
      {},
      { signal: new AbortController().signal, toolUseID: 'allowed-read' },
    )).toEqual({ behavior: 'allow' });
    expect(await policy.canUseTool?.(
      'Write',
      {},
      { signal: new AbortController().signal, toolUseID: 'denied-write' },
    )).toMatchObject({ behavior: 'deny' });
  });

  it('rejects parameterized permission expressions instead of treating them as tool names', () => {
    for (const entry of ['Bash(git:*)', 'Read(/tmp/reviewed/**)']) {
      expect(() => claudeSdkToolPolicy({
        executionPolicy: 'default',
        allowedTools: [entry],
      })).toThrow(/whole tool names/i);
    }
  });

  it('distinguishes an omitted boundary from an explicit empty boundary', () => {
    expect(claudeSdkToolPolicy({
      executionPolicy: 'default',
    })).toEqual({});
    expect(claudeSdkToolPolicy({
      executionPolicy: 'default',
      allowedTools: [],
    })).toMatchObject({
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
    });
  });

  it('does not attach configured MCP for a built-in-only allowlist', async () => {
    const effective = buildClaudeSdkOptions({
      allowedTools: ['Read'],
      mcpServers: [filesystemMcp],
    }, 'claude-test-model');

    expect(effective.tools).toEqual(['Read']);
    expect(effective).not.toHaveProperty('mcpServers');
    expect(await effective.canUseTool?.(
      'mcp__filesystem__read_file',
      {},
      { signal: new AbortController().signal, toolUseID: 'denied-mcp' },
    )).toMatchObject({ behavior: 'deny' });
  });

  it('attaches only the server for an explicitly named MCP tool and denies its siblings', async () => {
    const allowedMcpTool = 'mcp__filesystem__read_file';
    const effective = buildClaudeSdkOptions({
      allowedTools: ['Read', allowedMcpTool],
      mcpServers: [
        filesystemMcp,
        { name: 'database', command: 'node', args: ['database.js'] },
      ],
    }, 'claude-test-model');

    expect(effective.tools).toEqual(['Read']);
    expect(effective.allowedTools).toEqual(['Read', allowedMcpTool]);
    expect(effective.mcpServers).toMatchObject({
      filesystem: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: expect.any(Object),
      },
    });
    expect(await effective.canUseTool?.(
      allowedMcpTool,
      {},
      { signal: new AbortController().signal, toolUseID: 'allowed-mcp' },
    )).toEqual({ behavior: 'allow' });
    expect(await effective.canUseTool?.(
      'mcp__filesystem__write_file',
      {},
      { signal: new AbortController().signal, toolUseID: 'denied-sibling' },
    )).toMatchObject({ behavior: 'deny' });
  });

  it('attaches no MCP for an explicit empty boundary', () => {
    const effective = buildClaudeSdkOptions({
      allowedTools: [],
      mcpServers: [filesystemMcp],
    }, 'claude-test-model');

    expect(effective.tools).toEqual([]);
    expect(effective).not.toHaveProperty('mcpServers');
    expect(effective.permissionMode).toBe('dontAsk');
  });

  it('preserves configured MCP defaults when allowedTools is absent', () => {
    const effective = buildClaudeSdkOptions({
      mcpServers: [filesystemMcp],
    }, 'claude-test-model');

    expect(effective.mcpServers).toHaveProperty('filesystem');
    expect(effective).not.toHaveProperty('canUseTool');
    expect(effective).not.toHaveProperty('permissionMode');
  });
});
