// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { MODEL_ALIASES, resolveModelAlias } from '../../src/agent-manager-db.js';
import { modelDisplayName } from '../../src/claude-agent.js';
import { abbrevModel } from '../../src/tui/util/models.js';

describe('model alias resolution', () => {
  it('resolves the new fable/mythos aliases to canonical model ids', () => {
    expect(resolveModelAlias('fable')).toBe('claude-fable-5');
    expect(resolveModelAlias('fable-5')).toBe('claude-fable-5');
    expect(resolveModelAlias('mythos')).toBe('claude-mythos-5');
    expect(resolveModelAlias('mythos-5')).toBe('claude-mythos-5');
  });

  it('is case-insensitive', () => {
    expect(resolveModelAlias('Fable')).toBe('claude-fable-5');
    expect(resolveModelAlias('FABLE-5')).toBe('claude-fable-5');
    expect(resolveModelAlias('Mythos')).toBe('claude-mythos-5');
    expect(resolveModelAlias('MYTHOS-5')).toBe('claude-mythos-5');
    expect(resolveModelAlias('OPUS')).toBe('claude-opus-4-5-20250514');
  });

  it('preserves existing aliases (regression)', () => {
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5-20251001');
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5');
    expect(resolveModelAlias('sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(resolveModelAlias('sonnet-4.6')).toBe('claude-sonnet-4-6');
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-5-20250514');
    expect(resolveModelAlias('opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveModelAlias('opus-4.8')).toBe('claude-opus-4-8');
  });

  it('passes unknown / already-canonical model strings through unchanged', () => {
    expect(resolveModelAlias('claude-fable-5')).toBe('claude-fable-5');
    expect(resolveModelAlias('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(resolveModelAlias('gpt-5.4')).toBe('gpt-5.4');
    expect(resolveModelAlias('some-unknown-model')).toBe('some-unknown-model');
  });

  it('keeps the alias table and resolver in sync', () => {
    for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
      expect(resolveModelAlias(alias)).toBe(canonical);
    }
  });
});

describe('model display labels', () => {
  it('labels fable and mythos models', () => {
    expect(modelDisplayName('claude-fable-5')).toBe('Fable 5');
    expect(modelDisplayName('fable')).toBe('Fable 5');
    expect(modelDisplayName('anthropic/claude-fable-5-project')).toBe('Fable 5');
    expect(modelDisplayName('claude-mythos-5')).toBe('Mythos 5');
    expect(modelDisplayName('mythos')).toBe('Mythos 5');
    expect(modelDisplayName('anthropic/claude-mythos-5-project')).toBe('Mythos 5');
  });

  it('preserves existing model labels (regression)', () => {
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5 (Cheap)');
    expect(modelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4 (Balanced)');
    expect(modelDisplayName('claude-opus-4-20250514')).toBe('Opus 4 (Premium)');
  });

  it('falls back to the raw model string when unrecognized', () => {
    expect(modelDisplayName('gpt-5.4')).toBe('gpt-5.4');
  });
});

describe('TUI model abbreviations', () => {
  it('abbreviates fable and mythos model ids', () => {
    expect(abbrevModel('claude-fable-5')).toBe('fable-5');
    expect(abbrevModel('claude-mythos-5')).toBe('myth-5');
  });
});
