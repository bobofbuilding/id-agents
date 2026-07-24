// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentManagerDb } from '../../src/agent-manager-db.js';

function makeManager() {
  return new AgentManagerDb('/tmp/id-agents-brain-context-budget-test', {} as any, { libraryRoot: null }) as any;
}

describe('Brain context prompt appendix budget', () => {
  let originalInstructionChars: string | undefined;
  let originalCanonicalLimit: string | undefined;

  beforeEach(() => {
    originalInstructionChars = process.env.BRAIN_CONTEXT_INSTRUCTION_CHARS;
    originalCanonicalLimit = process.env.BRAIN_CONTEXT_CANONICAL_SOURCE_LIMIT;
    process.env.BRAIN_CONTEXT_INSTRUCTION_CHARS = '32';
    process.env.BRAIN_CONTEXT_CANONICAL_SOURCE_LIMIT = '2';
  });

  afterEach(() => {
    if (originalInstructionChars === undefined) delete process.env.BRAIN_CONTEXT_INSTRUCTION_CHARS;
    else process.env.BRAIN_CONTEXT_INSTRUCTION_CHARS = originalInstructionChars;
    if (originalCanonicalLimit === undefined) delete process.env.BRAIN_CONTEXT_CANONICAL_SOURCE_LIMIT;
    else process.env.BRAIN_CONTEXT_CANONICAL_SOURCE_LIMIT = originalCanonicalLimit;
  });

  it('caps long instructions and summarizes extra source ids in the inline prompt', () => {
    const manager = makeManager();
    const message = manager.withBrainContextAppendix('Do the work.', {
      bundles: [],
      instructions: [
        {
          source_id: 'memory:1',
          memory_id: 1,
          key: 'long-rule',
          content: 'This is a very long team instruction that should not be injected in full.',
          scope: {},
        },
      ],
      cited: {
        canonical_source_ids: ['memory:1', 'fact:2', 'text:3', 'entity:4'],
      },
    });

    expect(message).toContain('This is a very long team inst...');
    expect(message).toContain('[memory:1]');
    expect(message).not.toContain('should not be injected in full');
    expect(message).toContain('Cite used Brain sources as used_source_ids: memory:1, fact:2 (+2 more)');
  });

  it('adds a Brain workflow directive for required submission/knowledge/skill work even without volunteered sources', () => {
    const manager = makeManager();
    const message = manager.withBrainContextAppendix('Review this submission.', null, 'submission');

    expect(message).toContain('Brain workflow required for submission work:');
    expect(message).toContain('use the brain skill / Brain endpoints');
    expect(message).toContain('save it back to Brain/shared memory');
  });

  it('includes tiered memories in the agent context appendix', () => {
    const manager = makeManager();
    const message = manager.withBrainContextAppendix('Continue.', {
      bundles: [{
        query: 'delegation policy',
        memories: [{
          id: 9,
          content: 'The default lead delegates execution to team leads.',
          memory_tier: 'core',
        }],
      }],
      cited: { canonical_source_ids: ['memory:9'] },
    });

    expect(message).toContain('Memory (core): The default lead delegates execution to team leads. [memory:9]');
  });
});
