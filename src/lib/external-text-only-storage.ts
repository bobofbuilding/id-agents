// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  assertNoLinkEscape,
  ensurePrivateDirectory,
  stableProfileOwnerKey,
} from './profile-storage.js';

export interface ExternalTextOnlyStorageInput {
  stableAgentId?: string;
  displayFallback: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Return an empty, owner-only working directory for an external text-only
 * dispatch. Managed workers require their immutable id and profile root.
 *
 * The directory is deliberately separate from the agent workspace, Codex
 * state, XMTP databases, and durable conversation sessions. Refuse to use it
 * if anything has been planted there instead of silently loading project
 * instructions or other ambient context.
 */
export function resolveExternalTextOnlyWorkingDirectory(
  input: ExternalTextOnlyStorageInput,
): string | undefined {
  const env = input.env ?? process.env;
  const profileRootValue = env.IDACC_DATA_DIR?.trim();
  const managed = env.IDACC_MANAGED_SERVICE === '1';
  if (!profileRootValue) {
    if (managed) {
      throw new Error('external text-only execution requires IDACC_DATA_DIR in managed mode');
    }
    return undefined;
  }

  const profileRoot = path.resolve(profileRootValue);
  assertNoLinkEscape(profileRoot, profileRoot);
  const owner = stableProfileOwnerKey(
    input.stableAgentId,
    input.displayFallback,
    managed,
  );
  const workspace = ensurePrivateDirectory(
    profileRoot,
    path.join(
      profileRoot,
      'manager',
      'external-text-only',
      'agents',
      owner,
      'workspace',
    ),
  );
  if (fs.readdirSync(workspace).length !== 0) {
    throw new Error('external text-only working directory is not empty');
  }
  try { fs.chmodSync(workspace, 0o700); } catch { /* best effort outside POSIX */ }
  return workspace;
}
