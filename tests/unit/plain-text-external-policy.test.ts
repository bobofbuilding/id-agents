// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_TEXT_ONLY_MAX_TOKENS,
  plainTextExecutionBoundary,
} from '../../src/harness/external-text-policy.js';

describe('plain-text external execution policy', () => {
  it('removes MCP and local cwd while imposing a small completion-token cap', () => {
    expect(plainTextExecutionBoundary({
      executionPolicy: 'external-text-only',
      workingDirectory: '/private/agent/workspace',
      mcpServers: [{ name: 'filesystem', command: 'node', args: ['server.js'] }],
    }, -1)).toEqual({
      externalTextOnly: true,
      mcpServers: undefined,
      workingDirectory: undefined,
      maxTokens: EXTERNAL_TEXT_ONLY_MAX_TOKENS,
    });
  });

  it('preserves normal configured context and token behavior', () => {
    const mcpServers = [{ name: 'review', command: 'node', args: ['review.js'] }];
    expect(plainTextExecutionBoundary({
      executionPolicy: 'default',
      workingDirectory: '/agent/workspace',
      mcpServers,
    }, 4096)).toEqual({
      externalTextOnly: false,
      mcpServers,
      workingDirectory: '/agent/workspace',
      maxTokens: 4096,
    });
  });
});
