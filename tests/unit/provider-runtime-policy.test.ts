// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  normalizeProviderBaseUrl,
  normalizeProviderCredentialEnv,
  normalizeProviderRuntimePolicy,
} from '../../src/provider-runtime-policy.js';

describe('provider runtime credential policy', () => {
  it('allows reviewed provider credential names and rejects Manager/internal names', () => {
    expect(normalizeProviderCredentialEnv('OPENAI_API_KEY')).toBe('OPENAI_API_KEY');
    expect(normalizeProviderCredentialEnv('OPENROUTER_API_KEY')).toBe('OPENROUTER_API_KEY');
    for (const hostile of [
      'BRAIN_TOKEN',
      'DATABASE_URL',
      'IDACC_ADMIN_TOKEN',
      'PRIVATE_KEY',
      'SKILLMESH_PRIVATE_KEY',
      'openai_api_key',
      ' OPENAI_API_KEY',
      'OPENAI_API_KEY ',
      'IDCTL_EVM_MAINNET_API_KEY',
    ]) {
      expect(() => normalizeProviderCredentialEnv(hostile)).toThrow(/approved model-provider/i);
    }
  });

  it('allows HTTPS and exact loopback HTTP while rejecting credential-exfiltration URLs', () => {
    expect(normalizeProviderBaseUrl('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(normalizeProviderBaseUrl('http://127.0.0.1:1234/v1/')).toBe(
      'http://127.0.0.1:1234/v1',
    );
    expect(normalizeProviderBaseUrl('http://localhost:11434/v1')).toBe(
      'http://localhost:11434/v1',
    );
    for (const hostile of [
      'http://attacker.example/v1',
      'ftp://attacker.example/v1',
      'https://user:secret@attacker.example/v1',
      'https://attacker.example/v1?token=secret',
      'https://attacker.example/v1#fragment',
      'http://192.168.1.5:1234/v1',
      'http://provider.local:1234/v1',
    ]) {
      expect(() => normalizeProviderBaseUrl(hostile)).toThrow(/provider runtime baseUrl/i);
    }
  });

  it('never accepts an inline key from persisted metadata', () => {
    const input = {
      lane: 'provider:openrouter',
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      keyEnv: 'OPENROUTER_API_KEY',
      apiKey: 'process-local-secret',
    };
    expect(() => normalizeProviderRuntimePolicy(input)).toThrow(/apiKey is not permitted/i);
    expect(normalizeProviderRuntimePolicy(input, { allowInlineApiKey: true })).toEqual(input);
  });
});
