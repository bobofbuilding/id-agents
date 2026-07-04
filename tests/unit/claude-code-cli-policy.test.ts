import { describe, expect, it } from 'vitest';

import { claudeCliToolArgs } from '../../src/harness/claude-code-cli.js';

describe('Claude Code CLI harness policy', () => {
  it('restricts available tools for control-plane prompts', () => {
    expect(claudeCliToolArgs({
      executionPolicy: 'control-plane-readonly',
      allowedTools: ['Read', 'Glob', 'Grep'],
    })).toEqual([
      '--tools',
      'Read,Glob,Grep',
      '--allowedTools',
      'Read,Glob,Grep',
    ]);
  });

  it('keeps existing auto-allow behavior for normal work', () => {
    expect(claudeCliToolArgs({
      allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    })).toEqual([
      '--allowedTools',
      'Read,Write,Edit,Bash',
    ]);
  });
});
