// SPDX-License-Identifier: MIT
/**
 * Acceptance contract for consumers of the packed id-agents dependency.
 *
 * Keep the imports below aligned with the production dashboard-core imports at
 * the tui-electron tip. Type-only imports are checked with TypeScript because
 * interfaces do not exist at runtime; value imports and package/file
 * resolution are exercised by a real, temporary ESM consumer.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with status ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return result.stdout;
}

describe('packed external-consumer contract', () => {
  it('installs into an empty ESM project and exposes the complete desktop dependency surface', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'id-agents-packed-consumer-'));
    const packDir = join(tempRoot, 'pack');
    const consumerDir = join(tempRoot, 'consumer');
    const env = {
      ...process.env,
      npm_config_cache: join(tempRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
    };

    try {
      mkdirSync(packDir);
      mkdirSync(consumerDir);

      run('npm', ['pack', '--pack-destination', packDir], packageRoot, env);
      const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
      expect(tarballs).toHaveLength(1);
      const tarball = join(packDir, tarballs[0]);

      writeFileSync(
        join(consumerDir, 'package.json'),
        `${JSON.stringify({ name: 'id-agents-contract-consumer', private: true, type: 'module' }, null, 2)}\n`,
      );

      run(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--no-package-lock',
          '--omit=optional',
          tarball,
        ],
        consumerDir,
        env,
      );

      writeFileSync(
        join(consumerDir, 'contract.mjs'),
        `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  ManagerClient,
  abbrevEffort,
  abbrevModel,
  abbrevRuntime,
  cadenceLabel,
  catalogEntriesByTier,
  commandConfirmPreview,
  completeBuffer,
  confirmationLevel,
  isRemoteAgent,
  lookupPolicy,
  newsAgeBucket,
  newsParty,
  newsPartyLabel,
  nextFireSec,
  parseCommandLine,
} from 'id-agents/dashboard-core';

const desktopValues = {
  ManagerClient,
  abbrevEffort,
  abbrevModel,
  abbrevRuntime,
  cadenceLabel,
  catalogEntriesByTier,
  commandConfirmPreview,
  completeBuffer,
  confirmationLevel,
  isRemoteAgent,
  lookupPolicy,
  newsAgeBucket,
  newsParty,
  newsPartyLabel,
  nextFireSec,
  parseCommandLine,
};

for (const [name, value] of Object.entries(desktopValues)) {
  assert.notEqual(value, undefined, \`id-agents/dashboard-core must export \${name}\`);
}

const require = createRequire(import.meta.url);
const managerEntry = require.resolve('id-agents/manager-entry');
const packageJson = require.resolve('id-agents/package.json');
const dependencyRoot = dirname(packageJson);

assert.equal(existsSync(managerEntry), true, 'resolved manager entry must exist');
for (const relativePath of [
  'QUICKSTART.md',
  'skills/idagents-admin-control/SKILL.md',
  'configs/default.yaml',
]) {
  assert.equal(
    existsSync(join(dependencyRoot, relativePath)),
    true,
    \`packed id-agents must contain \${relativePath}\`,
  );
}
`,
      );

      writeFileSync(
        join(consumerDir, 'contract-types.ts'),
        `import type {
  Agent,
  ConfirmationLevel,
  ConfirmPreviewContext,
  LibraryAgentDetailResponse,
  LibraryAgentListResponse,
  LibrarySkillDetailResponse,
  LibrarySkillListResponse,
  LibraryTeamDetailResponse,
  LibraryTeamListResponse,
  NewsAgeBucket,
  NewsItem,
  RiskTier,
  Schedule,
  Task,
  Team,
} from 'id-agents/dashboard-core';

export type DesktopDashboardCoreTypes = [
  Agent,
  ConfirmationLevel,
  ConfirmPreviewContext,
  LibraryAgentDetailResponse,
  LibraryAgentListResponse,
  LibrarySkillDetailResponse,
  LibrarySkillListResponse,
  LibraryTeamDetailResponse,
  LibraryTeamListResponse,
  NewsAgeBucket,
  NewsItem,
  RiskTier,
  Schedule,
  Task,
  Team,
];
`,
      );

      run(process.execPath, [join(consumerDir, 'contract.mjs')], consumerDir, env);
      run(
        process.execPath,
        [
          join(packageRoot, 'node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2022',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          join(consumerDir, 'contract-types.ts'),
        ],
        consumerDir,
        env,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 300_000);
});
