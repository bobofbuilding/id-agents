// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  formatReleaseSchemaResult,
  validateReleaseSchema,
  type ReleaseSchemaValidationInput,
} from '../../src/release-schema.js';

function validInput(overrides: Partial<ReleaseSchemaValidationInput> = {}): ReleaseSchemaValidationInput {
  return {
    packageJson: { version: '0.1.17' },
    changelogText: '# Changelog\n\n## [0.1.17]\n\n- Ship release guard.\n',
    commitSubject: 'v0.1.17: Capabilities: remove skills',
    tagsAtHead: ['v0.1.17'],
    ...overrides,
  };
}

function checkMap(input: ReleaseSchemaValidationInput) {
  return Object.fromEntries(
    validateReleaseSchema(input).checks.map((check) => [check.name, check]),
  );
}

describe('validateReleaseSchema', () => {
  it('accepts the IDACC release-version schema', () => {
    const result = validateReleaseSchema(validInput());

    expect(result.ok).toBe(true);
    expect(result.version).toBe('0.1.17');
    expect(result.expectedTag).toBe('v0.1.17');
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it('requires a strict X.Y.Z package version', () => {
    const checks = checkMap(validInput({ packageJson: { version: '0.1.17-beta' } }));

    expect(checks['package-version'].ok).toBe(false);
    expect(checks['package-version'].message).toContain('strict X.Y.Z');
    expect(checks['changelog-heading'].ok).toBe(false);
    expect(checks['commit-subject'].ok).toBe(false);
    expect(checks['release-tag'].ok).toBe(false);
  });

  it('requires the bracketed changelog heading for the package version', () => {
    const checks = checkMap(validInput({
      changelogText: '# Changelog\n\n## 0.1.17\n\n- Missing brackets.\n',
    }));

    expect(checks['changelog-heading'].ok).toBe(false);
    expect(checks['changelog-heading'].message).toContain('## [0.1.17]');
  });

  it('requires the HEAD subject to start with the release tag prefix', () => {
    const checks = checkMap(validInput({
      commitSubject: 'fix(release): add guard',
    }));

    expect(checks['commit-subject'].ok).toBe(false);
    expect(checks['commit-subject'].message).toContain('v0.1.17:');
  });

  it('requires the release tag on HEAD', () => {
    const checks = checkMap(validInput({
      tagsAtHead: ['v0.1.16'],
    }));

    expect(checks['release-tag'].ok).toBe(false);
    expect(checks['release-tag'].message).toContain('v0.1.17');
  });

  it('formats a failed result for publish-time output', () => {
    const result = validateReleaseSchema(validInput({ tagsAtHead: [] }));
    const formatted = formatReleaseSchemaResult(result);

    expect(formatted).toContain('Release schema validation failed for v0.1.17');
    expect(formatted).toContain('[fail] release-tag');
  });
});
