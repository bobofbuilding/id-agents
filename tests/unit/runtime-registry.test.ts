// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  getDefaultModelForRuntime,
  getDefaultRuntime,
  getRuntimeDisplayName,
  getRuntimeProfile,
  getRuntimeProviderName,
  resolveRuntime,
  supportsSessionResume,
  usesCliLogin,
  validateRuntimeModelCompatibility,
} from '../../src/runtime/registry.js';

describe('runtime registry', () => {
  it('returns the shared default runtime', () => {
    expect(getDefaultRuntime()).toBe('claude-agent-sdk');
  });

  it('resolves unknown runtimes to the shared default', () => {
    expect(resolveRuntime(undefined)).toBe('claude-agent-sdk');
    expect(resolveRuntime('not-a-runtime')).toBe('claude-agent-sdk');
  });

  it('maps codex-cli to the codex runtime profile', () => {
    expect(resolveRuntime('codex-cli')).toBe('codex');
    expect(getRuntimeProfile('codex-cli').canonicalId).toBe('codex');
    expect(getRuntimeDisplayName('codex-cli')).toBe('Codex');
  });

  it('maps claude-code-local to the Claude Code profile while preserving id', () => {
    const profile = getRuntimeProfile('claude-code-local');
    expect(profile.id).toBe('claude-code-local');
    expect(profile.canonicalId).toBe('claude-code-cli');
    expect(profile.displayName).toBe('Claude Code');
  });

  it('returns runtime display and provider labels', () => {
    expect(getRuntimeDisplayName('codex')).toBe('Codex');
    expect(getRuntimeProviderName('codex')).toBe('Codex CLI');
    expect(getRuntimeDisplayName('claude-agent-sdk')).toBe('Claude');
  });

  it('returns runtime-specific default models', () => {
    // Codex intentionally has no built-in default — the Codex CLI picks a model
    // based on the logged-in account, and agents override it per-agent in YAML.
    expect(getDefaultModelForRuntime('codex')).toBe('');
    expect(getDefaultModelForRuntime('claude-agent-sdk')).toBe('claude-haiku-4-5-20251001');
  });

  it('honors explicit configured defaults when provided', () => {
    expect(getDefaultModelForRuntime('codex', 'gpt-5.5-preview')).toBe('gpt-5.5-preview');
  });

  it('tracks auth and session behavior by runtime', () => {
    expect(usesCliLogin('codex')).toBe(true);
    expect(usesCliLogin('claude-code-cli')).toBe(true);
    expect(usesCliLogin('claude-agent-sdk')).toBe(false);

    expect(supportsSessionResume('codex')).toBe(true);
    expect(supportsSessionResume('claude-code-cli')).toBe(true);
  });

  it('flags incompatible runtime/model combinations', () => {
    expect(validateRuntimeModelCompatibility('codex', 'claude-haiku-4-5-20251001')).toEqual([
      {
        code: 'runtime_model_mismatch',
        message: 'runtime "codex" is incompatible with Claude model "claude-haiku-4-5-20251001"',
      },
    ]);

    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'gpt-5.4')).toEqual([
      {
        code: 'runtime_model_mismatch',
        message: 'runtime "claude-agent-sdk" is incompatible with OpenAI model "gpt-5.4"',
      },
    ]);
  });

  it('accepts models from the matching provider family', () => {
    expect(validateRuntimeModelCompatibility('codex', 'gpt-5.4')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-sonnet-4-20250514')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'haiku')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'fable')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'fable-5')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'mythos')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'mythos-5')).toEqual([]);
  });

  it('treats fable/mythos short names as the Claude family', () => {
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'fable')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'mythos')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-fable-5')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-mythos-5')).toEqual([]);
    // ...and therefore incompatible with the codex (OpenAI) runtime
    expect(validateRuntimeModelCompatibility('codex', 'fable')).toEqual([
      {
        code: 'runtime_model_mismatch',
        message: 'runtime "codex" is incompatible with Claude model "fable"',
      },
    ]);
  });

  it('exposes the cursor-cli runtime profile', () => {
    const profile = getRuntimeProfile('cursor-cli');
    expect(profile.id).toBe('cursor-cli');
    expect(profile.canonicalId).toBe('cursor-cli');
    expect(profile.displayName).toBe('Cursor');
    expect(profile.auth.mode).toBe('cli-login');
    expect(profile.capabilities.supportsResume).toBe(true);
    expect(getDefaultModelForRuntime('cursor-cli')).toBe('sonnet-4');
  });

  it('accepts both OpenAI and Claude model families for cursor-cli', () => {
    expect(validateRuntimeModelCompatibility('cursor-cli', 'gpt-5')).toEqual([]);
    expect(validateRuntimeModelCompatibility('cursor-cli', 'sonnet-4')).toEqual([]);
    expect(validateRuntimeModelCompatibility('cursor-cli', 'claude-opus-4-20250514')).toEqual([]);
  });

  it('exposes the ollama runtime profile', () => {
    const profile = getRuntimeProfile('ollama');
    expect(profile.id).toBe('ollama');
    expect(profile.canonicalId).toBe('ollama');
    expect(profile.displayName).toBe('Ollama (Local)');
    expect(profile.auth.mode).toBe('api-key');
    expect(profile.capabilities.supportsResume).toBe(false);
    expect(getDefaultModelForRuntime('ollama')).toBe('qwen3:4b');
  });

  it('accepts any model string for ollama (no cross-family checks)', () => {
    expect(validateRuntimeModelCompatibility('ollama', 'qwen3:4b')).toEqual([]);
    expect(validateRuntimeModelCompatibility('ollama', 'gpt-5')).toEqual([]);
    expect(validateRuntimeModelCompatibility('ollama', 'claude-opus-4-20250514')).toEqual([]);
  });
});
