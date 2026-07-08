// SPDX-License-Identifier: MIT

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface ReleaseSchemaValidationInput {
  packageJson: unknown;
  changelogText: string;
  commitSubject: string;
  tagsAtHead: string[];
}

export interface ReleaseSchemaCheck {
  name: 'package-version' | 'changelog-heading' | 'commit-subject' | 'release-tag';
  ok: boolean;
  message: string;
}

export interface ReleaseSchemaValidationResult {
  ok: boolean;
  version: string | null;
  expectedTag: string | null;
  checks: ReleaseSchemaCheck[];
}

const STRICT_VERSION_RE = /^\d+\.\d+\.\d+$/;

export function validateReleaseSchema(input: ReleaseSchemaValidationInput): ReleaseSchemaValidationResult {
  const version = readVersion(input.packageJson);
  const versionOk = typeof version === 'string' && STRICT_VERSION_RE.test(version);
  const expectedTag = versionOk ? `v${version}` : null;
  const checks: ReleaseSchemaCheck[] = [
    {
      name: 'package-version',
      ok: versionOk,
      message: versionOk
        ? `package.json version is ${version}`
        : 'package.json version must be a strict X.Y.Z value',
    },
  ];

  if (!versionOk || !expectedTag || !version) {
    checks.push(
      {
        name: 'changelog-heading',
        ok: false,
        message: 'CHANGELOG.md cannot be checked until package.json has a strict X.Y.Z version',
      },
      {
        name: 'commit-subject',
        ok: false,
        message: 'HEAD commit subject cannot be checked until package.json has a strict X.Y.Z version',
      },
      {
        name: 'release-tag',
        ok: false,
        message: 'release tag cannot be checked until package.json has a strict X.Y.Z version',
      },
    );
    return result(version, expectedTag, checks);
  }

  const headingRe = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s|$)`, 'm');
  checks.push({
    name: 'changelog-heading',
    ok: headingRe.test(input.changelogText),
    message: headingRe.test(input.changelogText)
      ? `CHANGELOG.md contains ## [${version}]`
      : `CHANGELOG.md must contain a ## [${version}] heading`,
  });

  checks.push({
    name: 'commit-subject',
    ok: input.commitSubject.startsWith(`${expectedTag}: `),
    message: input.commitSubject.startsWith(`${expectedTag}: `)
      ? `HEAD subject starts with ${expectedTag}:`
      : `HEAD subject must start with "${expectedTag}: "`,
  });

  checks.push({
    name: 'release-tag',
    ok: input.tagsAtHead.includes(expectedTag),
    message: input.tagsAtHead.includes(expectedTag)
      ? `HEAD is tagged ${expectedTag}`
      : `HEAD must be tagged ${expectedTag}`,
  });

  return result(version, expectedTag, checks);
}

export function validateReleaseSchemaFromRepo(rootDir: string): ReleaseSchemaValidationResult {
  const packageJsonPath = path.join(rootDir, 'package.json');
  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const changelogText = fs.readFileSync(changelogPath, 'utf8');
  const commitSubject = git(rootDir, ['log', '-1', '--pretty=%s']);
  const tagsAtHead = git(rootDir, ['tag', '--points-at', 'HEAD'])
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);

  return validateReleaseSchema({
    packageJson,
    changelogText,
    commitSubject,
    tagsAtHead,
  });
}

export function formatReleaseSchemaResult(validation: ReleaseSchemaValidationResult): string {
  const lines = [
    validation.ok
      ? `Release schema validation passed for ${validation.expectedTag}.`
      : `Release schema validation failed${validation.expectedTag ? ` for ${validation.expectedTag}` : ''}.`,
  ];

  for (const check of validation.checks) {
    lines.push(`[${check.ok ? 'pass' : 'fail'}] ${check.name}: ${check.message}`);
  }

  return lines.join('\n');
}

function readVersion(packageJson: unknown): string | null {
  if (!packageJson || typeof packageJson !== 'object') return null;
  const version = (packageJson as { version?: unknown }).version;
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

function result(
  version: string | null,
  expectedTag: string | null,
  checks: ReleaseSchemaCheck[],
): ReleaseSchemaValidationResult {
  return {
    ok: checks.every((check) => check.ok),
    version,
    expectedTag,
    checks,
  };
}

function git(rootDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
