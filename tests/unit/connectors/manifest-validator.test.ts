// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { hashManifest, validateConnectorManifest } from '../../../src/connectors/catalog/manifest-validator.js';
import { GMAIL_V1_MANIFEST } from '../../../src/connectors/providers/gmail/gmail-manifest.js';
import type { ConnectorManifest } from '../../../src/connectors/types.js';

describe('validateConnectorManifest', () => {
  it('accepts the Gmail v1 manifest as-is', () => {
    const result = validateConnectorManifest(GMAIL_V1_MANIFEST);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a non-semver version', () => {
    const manifest: ConnectorManifest = { ...GMAIL_V1_MANIFEST, version: 'v1' };
    const result = validateConnectorManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('semver'))).toBe(true);
  });

  it('rejects duplicate capability ids', () => {
    const manifest: ConnectorManifest = {
      ...GMAIL_V1_MANIFEST,
      capabilities: [GMAIL_V1_MANIFEST.capabilities[0], GMAIL_V1_MANIFEST.capabilities[0]],
    };
    const result = validateConnectorManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate capability id'))).toBe(true);
  });

  it('rejects external-write/destructive capabilities with approval "auto"', () => {
    const manifest: ConnectorManifest = {
      ...GMAIL_V1_MANIFEST,
      capabilities: [
        {
          id: 'gmail.messages.send',
          operation: 'send',
          resource: 'messages',
          risk: 'external-write',
          sideEffect: 'send',
          approval: 'auto',
        },
      ],
    };
    const result = validateConnectorManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('must require confirm/always/deny'))).toBe(true);
  });

  it('rejects a manifest whose serialized text references a secret-shaped field', () => {
    const manifest: ConnectorManifest = {
      ...GMAIL_V1_MANIFEST,
      capabilities: [
        {
          id: 'gmail.messages.search',
          operation: 'search',
          resource: 'messages',
          risk: 'read',
          sideEffect: 'none',
          approval: 'auto',
          notes: 'uses api_key xyz',
        },
      ],
    };
    const result = validateConnectorManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('secret/token/api key'))).toBe(true);
  });

  it('rejects hardDeny capabilities whose approval is not "deny"', () => {
    const manifest: ConnectorManifest = {
      ...GMAIL_V1_MANIFEST,
      capabilities: [
        {
          id: 'gmail.messages.trash',
          operation: 'trash',
          resource: 'messages',
          risk: 'destructive',
          sideEffect: 'delete',
          approval: 'always',
          hardDeny: true,
        },
      ],
    };
    const result = validateConnectorManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('hardDeny but approval'))).toBe(true);
  });
});

describe('hashManifest', () => {
  it('is stable across key-order permutations of the same logical manifest', () => {
    const a: ConnectorManifest = { ...GMAIL_V1_MANIFEST };
    const b: ConnectorManifest = {
      version: GMAIL_V1_MANIFEST.version,
      connectorId: GMAIL_V1_MANIFEST.connectorId,
      capabilities: GMAIL_V1_MANIFEST.capabilities,
      backend: { binding: GMAIL_V1_MANIFEST.backend.binding, kind: GMAIL_V1_MANIFEST.backend.kind, provider: GMAIL_V1_MANIFEST.backend.provider },
    };
    expect(hashManifest(a)).toEqual(hashManifest(b));
  });

  it('changes when a capability changes', () => {
    const mutated: ConnectorManifest = {
      ...GMAIL_V1_MANIFEST,
      capabilities: [...GMAIL_V1_MANIFEST.capabilities.slice(1)],
    };
    expect(hashManifest(mutated)).not.toEqual(hashManifest(GMAIL_V1_MANIFEST));
  });
});
