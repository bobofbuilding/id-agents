// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  getAvailableRuntimes,
  getDefaultModelForRuntime,
  getDefaultRuntime,
  getRuntimeDisplayName,
  getRuntimeInterfaceProfile,
  getRuntimeProfile,
  getRuntimeProviderName,
  resolveRuntime,
  resolveSpawnRuntimeModel,
  supportsMcpTools,
  supportsPluginSkillFallback,
  supportsSessionResume,
  supportsSkillFiles,
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
    expect(getDefaultModelForRuntime('claude-code-cli')).toBe('');
    expect(getDefaultModelForRuntime('claude-agent-sdk')).toBe('claude-haiku-4-5-20251001');
  });

  it('keeps configured defaults paired with their configured runtime at spawn', () => {
    const defaults = { runtime: 'codex', model: 'gpt-5.4-mini' };

    expect(resolveSpawnRuntimeModel(undefined, undefined, defaults)).toEqual({
      runtime: 'codex',
      model: 'gpt-5.4-mini',
    });
    expect(resolveSpawnRuntimeModel('claude-code-cli', undefined, defaults)).toEqual({
      runtime: 'claude-code-cli',
      model: '',
    });
    expect(resolveSpawnRuntimeModel('claude-code-cli', 'sonnet', defaults)).toEqual({
      runtime: 'claude-code-cli',
      model: 'sonnet',
    });
  });

  it('honors explicit configured defaults when provided', () => {
    expect(getDefaultModelForRuntime('codex', 'gpt-5.5-preview')).toBe('gpt-5.5-preview');
  });

  it('tracks auth and session behavior by runtime', () => {
    expect(usesCliLogin('codex')).toBe(true);
    expect(usesCliLogin('claude-code-cli')).toBe(true);
    expect(usesCliLogin('grok')).toBe(true);
    expect(usesCliLogin('antigravity')).toBe(true);
    expect(usesCliLogin('copilot')).toBe(true);
    expect(usesCliLogin('kiro-cli')).toBe(true);
    expect(usesCliLogin('claude-agent-sdk')).toBe(false);

    expect(supportsSessionResume('codex')).toBe(true);
    expect(supportsSessionResume('claude-code-cli')).toBe(true);
    expect(supportsSessionResume('grok')).toBe(true);
    expect(supportsSessionResume('antigravity')).toBe(true);
    expect(supportsSessionResume('copilot')).toBe(false);
    expect(supportsSessionResume('kiro-cli')).toBe(true);
  });

  it('exposes one runtime-neutral interface contract for every runtime', () => {
    for (const runtime of getAvailableRuntimes()) {
      const profile = getRuntimeProfile(runtime);
      const contract = getRuntimeInterfaceProfile(runtime);

      expect(contract.version).toBe('id-agents-runtime-v1');
      expect(contract.protocol).toBe('rest-ap');
      expect(contract.protocolVersion).toBe('1.0');
      expect(contract.adapterContract).toBe('id-agents-harness-v1');
      expect(contract.runtime).toBe(profile.id);
      expect(contract.sessionPolicy).toBe(profile.sessionPolicy);
      expect(contract.deploymentShape).toBe(profile.deploymentShape);
      expect(contract.capabilities).toEqual(profile.capabilities);
      expect(contract.requiredEndpoints).toMatchObject({
        discovery: '/.well-known/restap.json',
        talk: '/talk',
        news: '/news',
        newsPost: '/news',
        catalog: '/catalog',
      });
      expect(contract.driver).toMatchObject({
        interface: 'AgentHarness',
        input: 'prompt:string + HarnessOptions',
        output: 'AsyncGenerator<HarnessMessage>',
      });
      expect(contract.driver.eventTypes).toEqual(['system', 'tool_use', 'result', 'error', 'progress', 'thinking']);
    }
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

  it('exposes the GitHub Copilot runtime profile', () => {
    const profile = getRuntimeProfile('copilot');
    expect(profile.id).toBe('copilot');
    expect(profile.canonicalId).toBe('copilot');
    expect(profile.displayName).toBe('GitHub Copilot');
    expect(profile.auth.mode).toBe('cli-login');
    expect(profile.capabilities.supportsResume).toBe(false);
    expect(getDefaultModelForRuntime('copilot')).toBe('default');
  });

  it('accepts provider-owned model strings for copilot', () => {
    expect(validateRuntimeModelCompatibility('copilot', 'default')).toEqual([]);
    expect(validateRuntimeModelCompatibility('copilot', 'gpt-5.4')).toEqual([]);
    expect(validateRuntimeModelCompatibility('copilot', 'claude-sonnet-5')).toEqual([]);
  });

  it('exposes the Grok Build runtime profile', () => {
    const profile = getRuntimeProfile('grok');
    expect(profile.id).toBe('grok');
    expect(profile.canonicalId).toBe('grok');
    expect(profile.displayName).toBe('Grok Build');
    expect(profile.auth.mode).toBe('cli-login');
    expect(profile.capabilities.supportsResume).toBe(true);
    expect(getDefaultModelForRuntime('grok')).toBe('grok-composer-2.5-fast');
  });

  it('accepts provider-owned model strings for grok', () => {
    expect(validateRuntimeModelCompatibility('grok', 'grok-composer-2.5-fast')).toEqual([]);
    expect(validateRuntimeModelCompatibility('grok', 'grok-build')).toEqual([]);
    expect(validateRuntimeModelCompatibility('grok', 'claude-sonnet-5')).toEqual([]);
  });

  it('exposes the Google Antigravity runtime profile', () => {
    const profile = getRuntimeProfile('antigravity');
    expect(profile.id).toBe('antigravity');
    expect(profile.canonicalId).toBe('antigravity');
    expect(profile.displayName).toBe('Google Antigravity');
    expect(profile.auth.mode).toBe('cli-login');
    expect(profile.capabilities.supportsResume).toBe(true);
    expect(getDefaultModelForRuntime('antigravity')).toBe('Gemini 3.5 Flash (Medium)');
  });

  it('accepts provider-owned model strings for antigravity', () => {
    expect(validateRuntimeModelCompatibility('antigravity', 'Gemini 3.5 Flash (Medium)')).toEqual([]);
    expect(validateRuntimeModelCompatibility('antigravity', 'Claude Sonnet 4.6 (Thinking)')).toEqual([]);
    expect(validateRuntimeModelCompatibility('antigravity', 'GPT-OSS 120B (Medium)')).toEqual([]);
  });

  it('exposes the Kiro runtime profile', () => {
    const profile = getRuntimeProfile('kiro-cli');
    expect(profile.id).toBe('kiro-cli');
    expect(profile.canonicalId).toBe('kiro-cli');
    expect(profile.displayName).toBe('Kiro');
    expect(profile.auth.mode).toBe('cli-login');
    expect(profile.capabilities.supportsResume).toBe(true);
    expect(getDefaultModelForRuntime('kiro-cli')).toBe('auto');
  });

  it('accepts provider-owned model strings for kiro-cli', () => {
    expect(validateRuntimeModelCompatibility('kiro-cli', 'auto')).toEqual([]);
    expect(validateRuntimeModelCompatibility('kiro-cli', 'claude-sonnet-4.5')).toEqual([]);
    expect(validateRuntimeModelCompatibility('kiro-cli', 'qwen3-coder-next')).toEqual([]);
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

  it('maps provider lane specifiers to the generic provider-api harness', () => {
    expect(resolveRuntime('provider:openrouter')).toBe('provider-api');
    expect(getRuntimeDisplayName('provider:NVIDIABuild-Autogen-73')).toBe('API Provider');
    expect(getRuntimeProviderName('provider:openrouter')).toBe('OpenAI-compatible API');
    expect(validateRuntimeModelCompatibility('provider:openrouter', 'anthropic/claude-sonnet-4.6')).toEqual([]);
    expect(validateRuntimeModelCompatibility('provider:openrouter', 'qwen/qwen3.5-397b-a17b')).toEqual([]);
  });

  it('centralizes portable capability support across runtimes', () => {
    expect(supportsMcpTools('claude-code-cli')).toBe(true);
    expect(supportsMcpTools('codex')).toBe(true);
    expect(supportsMcpTools('ollama')).toBe(true);
    expect(supportsMcpTools('provider:openrouter')).toBe(true);
    expect(supportsMcpTools('cursor-cli')).toBe(false);

    for (const runtime of ['claude-agent-sdk', 'claude-code-cli', 'codex', 'cursor-cli', 'grok', 'antigravity', 'copilot', 'kiro-cli', 'ollama', 'provider-api']) {
      expect(supportsSkillFiles(runtime)).toBe(true);
      expect(supportsPluginSkillFallback(runtime)).toBe(true);
    }

    expect(supportsSkillFiles('public-agent-remote')).toBe(false);
    expect(supportsPluginSkillFallback('public-agent-remote')).toBe(false);
  });
});
