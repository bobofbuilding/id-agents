// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import { nodeOptionsForAgent, nodeOptionsForManager, withDesktopResourceLimits } from '../../src/lib/resource-limits.js';

describe('desktop resource limits', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('adds bounded node heap options without duplicating existing flags', () => {
    expect(nodeOptionsForAgent('')).toContain('--max-old-space-size=768');
    expect(nodeOptionsForManager('')).toContain('--max-old-space-size=1024');
    expect(nodeOptionsForAgent('--max-old-space-size=2048 --trace-warnings')).toBe('--max-old-space-size=2048 --trace-warnings');
  });

  it('sets conservative local-model defaults for spawned agent environments', () => {
    const env = withDesktopResourceLimits({ PATH: '/usr/bin' });

    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=768');
    expect(env.OLLAMA_MAX_LOADED_MODELS).toBe('1');
    expect(env.OLLAMA_NUM_PARALLEL).toBe('1');
    expect(env.OLLAMA_MAX_QUEUE).toBe('4');
    expect(env.OLLAMA_KEEP_ALIVE).toBe('45s');
    expect(env.OLLAMA_MAX_CONCURRENT).toBe('1');
  });

  it('lets operators override local-model caps', () => {
    process.env.ID_OLLAMA_MAX_LOADED_MODELS = '2';
    process.env.ID_OLLAMA_KEEP_ALIVE = '2m';
    process.env.ID_AGENT_NODE_MAX_OLD_SPACE_MB = '512';

    const env = withDesktopResourceLimits({});

    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=512');
    expect(env.OLLAMA_MAX_LOADED_MODELS).toBe('2');
    expect(env.OLLAMA_KEEP_ALIVE).toBe('2m');
  });
});

