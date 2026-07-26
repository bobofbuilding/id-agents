// SPDX-License-Identifier: MIT

import { createRequire } from 'node:module';

type SpawnFunction = typeof import('node:child_process').spawn;
type SpawnSyncFunction = typeof import('node:child_process').spawnSync;

interface CrossSpawn extends SpawnFunction {
  sync: SpawnSyncFunction;
}

// cross-spawn preserves spawn's argv boundary while resolving Windows .cmd
// shims and applying the command-interpreter escaping they require.
const crossSpawn = createRequire(import.meta.url)('cross-spawn') as CrossSpawn;

export const portableSpawn: SpawnFunction = crossSpawn;
export const portableSpawnSync: SpawnSyncFunction = crossSpawn.sync;
