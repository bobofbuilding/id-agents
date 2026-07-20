#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(path.join(os.tmpdir(), 'idagents-workspace-gc-'));
const workspace = path.join(root, 'workspace');
const output = path.join(workspace, 'agents', 'agent-1', 'output', 'completed-task');
const dependency = path.join(output, 'repo', 'node_modules');
const report = path.join(output, 'report.md');
await mkdir(dependency, { recursive: true });
await writeFile(path.join(dependency, 'package.js'), 'rebuildable');
await writeFile(report, 'durable result');
const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
await utimes(dependency, old, old);
await utimes(output, old, old);

const script = path.resolve('scripts/workspace-gc.mjs');
const result = spawnSync(process.execPath, [script, '--apply', '--workspace', workspace, '--publish-root', path.join(root, 'publish'), '--older-than-days', '7'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.equal(await stat(dependency).then(() => true, () => false), false, 'old dependency tree should be removed');
assert.equal(await readFile(report, 'utf8'), 'durable result', 'durable output must be retained');
console.log('workspace GC smoke passed');
