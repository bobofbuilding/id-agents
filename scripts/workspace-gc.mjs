#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(p) {
  let total = 0;
  async function walk(cur) {
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      const s = await stat(cur).catch(() => null);
      if (s) total += s.size;
      return;
    }
    for (const entry of entries) {
      const next = path.join(cur, entry.name);
      if (entry.isDirectory()) await walk(next);
      else {
        const s = await stat(next).catch(() => null);
        if (s) total += s.size;
      }
    }
  }
  await walk(p);
  return total;
}

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

async function addCandidate(candidates, p, reason, now, olderThanMs = 0) {
  const s = await stat(p).catch(() => null);
  if (!s) return;
  if (olderThanMs > 0 && now - s.mtimeMs < olderThanMs) return;
  candidates.push({ path: p, reason, mtimeMs: s.mtimeMs, bytes: await dirSize(p) });
}

async function listDirs(root) {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function collectRebuildableDirs(root, olderThanMs, now) {
  const found = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target);
      const parent = path.dirname(target);
      const rebuildable =
        entry.name === 'node_modules' ||
        entry.name === '.parcel-cache' ||
        entry.name === '.turbo' ||
        relative.endsWith(path.join('.next', 'cache')) ||
        relative.endsWith(path.join('.vercel', 'output')) ||
        (entry.name === 'target' && await exists(path.join(parent, 'Cargo.toml'))) ||
        (entry.name === 'release' && await exists(path.join(parent, 'package.json')));

      if (rebuildable) {
        const targetStat = await stat(target).catch(() => null);
        if (targetStat && now - targetStat.mtimeMs >= olderThanMs) found.push(target);
        continue;
      }
      await walk(target);
    }
  }

  await walk(root);
  return found;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workspaceRoot = path.resolve(argValue('--workspace', path.join(repoRoot, 'workspace')));
  const publishRoot = path.resolve(argValue('--publish-root', path.join(repoRoot, '..', '.iacc-publish')));
  const olderThanDays = Math.max(1, Number.parseInt(argValue('--older-than-days', '7'), 10) || 7);
  const keepPublish = Math.max(0, Number.parseInt(argValue('--keep-publish', '1'), 10) || 1);
  const apply = hasArg('--apply');
  const includeNodeModules = hasArg('--include-node-modules');
  const includeAgentOutputs = hasArg('--include-agent-outputs');
  const includePublishSnapshots = hasArg('--include-publish-snapshots');
  const now = Date.now();
  const olderThanMs = olderThanDays * DAY_MS;
  const candidates = [];

  for (const agentDir of await listDirs(path.join(workspaceRoot, 'agents'))) {
    for (const outputDir of await listDirs(path.join(agentDir, 'output'))) {
      if (includeAgentOutputs) {
        await addCandidate(candidates, outputDir, `agent output older than ${olderThanDays}d`, now, olderThanMs);
        continue;
      }
      for (const rebuildable of await collectRebuildableDirs(outputDir, olderThanMs, now)) {
        await addCandidate(candidates, rebuildable, `old rebuildable agent artifact`, now, 0);
      }
    }
  }

  if (includePublishSnapshots) {
    const publishDirs = await Promise.all((await listDirs(publishRoot)).map(async (p) => ({ path: p, stat: await stat(p) })));
    publishDirs
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(keepPublish)
      .forEach((entry) => candidates.push({ path: entry.path, reason: `old publish staging snapshot; keeping newest ${keepPublish}`, mtimeMs: entry.stat.mtimeMs, bytes: 0 }));
  }

  for (const projectDir of await listDirs(path.join(workspaceRoot, 'projects'))) {
    const rebuildable = [
      '.next/cache',
      '.vercel/output',
      'release',
      'dist-tauri/target',
      'apps/web/.next/cache',
      'apps/web/src-tauri/target/release',
    ];
    if (includeNodeModules) rebuildable.push('node_modules');
    for (const rel of rebuildable) {
      await addCandidate(candidates, path.join(projectDir, rel), `rebuildable project artifact older than ${olderThanDays}d: ${rel}`, now, olderThanMs);
    }
  }

  const unique = new Map();
  for (const candidate of candidates) {
    if (!isWithin(workspaceRoot, candidate.path) && !isWithin(publishRoot, candidate.path)) {
      throw new Error(`refusing candidate outside guarded roots: ${candidate.path}`);
    }
    unique.set(candidate.path, candidate);
  }
  candidates.length = 0;
  candidates.push(...unique.values());

  let total = 0;
  for (const candidate of candidates) {
    if (!candidate.bytes) candidate.bytes = await dirSize(candidate.path).catch(() => 0);
    total += candidate.bytes;
  }

  console.log(`${apply ? 'Applying' : 'Dry run'} workspace GC for ${workspaceRoot}`);
  console.log(`Candidates: ${candidates.length}; reclaimable: ${fmt(total)}`);
  for (const candidate of candidates.sort((a, b) => b.bytes - a.bytes)) {
    console.log(`${fmt(candidate.bytes).padStart(6)}  ${candidate.reason}  ${candidate.path}`);
  }

  if (!apply) {
    console.log('\nNo files deleted. Re-run with --apply to remove these candidates.');
    if (!includeAgentOutputs) {
      console.log('Whole agent outputs are retained. Use --include-agent-outputs only for an intentional archival purge.');
    }
    return;
  }

  for (const candidate of candidates) {
    await rm(candidate.path, { recursive: true, force: true });
  }
  console.log(`Deleted ${candidates.length} candidates; reclaimed approximately ${fmt(total)}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
