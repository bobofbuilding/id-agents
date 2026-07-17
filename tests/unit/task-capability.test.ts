// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { resolveAgentTaskWriteCapability } from '../../src/task-capability.js';

describe('resolveAgentTaskWriteCapability', () => {
  it('defaults an agent with no capabilities metadata to full HTTP access', () => {
    const result = resolveAgentTaskWriteCapability({ metadata: null });
    expect(result).toEqual({ capable: true, route: 'http' });
  });

  it('defaults an agent whose metadata omits capabilities to full HTTP access', () => {
    const result = resolveAgentTaskWriteCapability({ metadata: { alias: 'foo' } });
    expect(result).toEqual({ capable: true, route: 'http' });
  });

  it('treats an agent with shell access as capable via http', () => {
    const result = resolveAgentTaskWriteCapability({
      metadata: { capabilities: { shell: true, http: false } },
    });
    expect(result).toEqual({ capable: true, route: 'http' });
  });

  it('treats an agent with http access as capable via http', () => {
    const result = resolveAgentTaskWriteCapability({
      metadata: { capabilities: { shell: false, http: true } },
    });
    expect(result).toEqual({ capable: true, route: 'http' });
  });

  it('routes an agent with no shell/http but a wired task-lifecycle MCP server to mcp', () => {
    const result = resolveAgentTaskWriteCapability({
      metadata: { capabilities: { shell: false, http: false, taskLifecycleMcp: true } },
    });
    expect(result).toEqual({ capable: true, route: 'mcp' });
  });

  it('fails clearly with missing_required_capability: task_write when no route exists', () => {
    const result = resolveAgentTaskWriteCapability({
      metadata: { capabilities: { shell: false, http: false } },
    });
    expect(result.capable).toBe(false);
    expect(result.route).toBe('none');
    expect(result.missing_required_capability).toBe('task_write');
    expect(result.reason).toBeTruthy();
  });

  it('fails when taskLifecycleMcp is explicitly false', () => {
    const result = resolveAgentTaskWriteCapability({
      metadata: { capabilities: { shell: false, http: false, taskLifecycleMcp: false } },
    });
    expect(result.capable).toBe(false);
    expect(result.missing_required_capability).toBe('task_write');
  });
});
