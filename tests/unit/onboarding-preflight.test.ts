// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();

function readRepositoryFile(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('onboarding and CI preflight contract', () => {
  it('checks in a reproducible pull-request preflight', () => {
    const workflow = parse(readRepositoryFile('.github/workflows/ci-preflight.yml')) as {
      name?: string;
      on?: { pull_request?: unknown; push?: { branches?: string[] } };
      permissions?: { contents?: string };
      jobs?: {
        preflight?: {
          'runs-on'?: string;
          steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, string> }>;
        };
      };
    };

    expect(workflow.name).toBe('CI preflight');
    expect(workflow.on?.pull_request).not.toBeUndefined();
    expect(workflow.on?.push?.branches).toContain('main');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs?.preflight?.['runs-on']).toBe('ubuntu-latest');

    const steps = workflow.jobs?.preflight?.steps ?? [];
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ uses: 'actions/checkout@v4' }),
      expect.objectContaining({
        uses: 'actions/setup-node@v4',
        with: expect.objectContaining({ 'node-version': '22', cache: 'npm' }),
      }),
      expect.objectContaining({ run: 'npm ci' }),
      expect.objectContaining({ run: 'npm run ci:preflight' }),
    ]));

    const packageJson = JSON.parse(readRepositoryFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['ci:preflight']).toBe('npm run lint && npm run typecheck && npm test');
  });

  it('keeps clean-machine and contributor workflow guidance discoverable', () => {
    const installGuide = readRepositoryFile('docs/guides/cross-platform-install.md');
    const contributorGuide = readRepositoryFile('docs/guides/contributor-workflows.md');
    const contributingGuide = readRepositoryFile('CONTRIBUTING.md');
    const docsIndex = readRepositoryFile('docs/README.md');

    expect(installGuide).toContain('# Cross-Platform Install, Update, and Troubleshooting');
    expect(installGuide).toContain('### macOS');
    expect(installGuide).toContain('### Linux');
    expect(installGuide).toContain('### Windows WSL');
    expect(installGuide).toContain('## 5. Safe Update Procedure');
    expect(installGuide).toContain('## Troubleshooting');
    expect(installGuide).toContain('npm ci');
    expect(installGuide).toContain('npm run ci:preflight');
    expect(installGuide).toContain('./scripts/detect-runtimes.sh');

    expect(contributorGuide).toContain('# Contributor Workflows Index');
    expect(contributorGuide).toContain('## Search this documentation');
    expect(contributorGuide).toContain('task lifecycle');
    expect(contributorGuide).toContain('npm run ci:preflight');
    expect(contributingGuide).toContain('docs/guides/contributor-workflows.md');
    expect(contributingGuide).toContain('npm run ci:preflight');
    expect(docsIndex).toContain('./guides/cross-platform-install.md');
    expect(docsIndex).toContain('./guides/contributor-workflows.md');
  });
});
