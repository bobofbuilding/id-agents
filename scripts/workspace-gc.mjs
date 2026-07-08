#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const workspaceRoot = path.resolve(argValue('--workspace', path.join(repoRoot, 'workspace')));
  const publishRoot = path.resolve(argValue('--publish-root', path.join(repoRoot, '..', '.iacc-publish')));
  const olderThanDays = Math.max(1, Number.parseInt(argValue('--older-than-days', '7'), 10) || 7);
  const keepPublish = Math.max(0, Number.parseInt(argValue('--keep-publish', '1'), 10) || 1);
  const apply = hasArg('--apply');
  const includeNodeModules = hasArg('--include-node-modules');
  const now = Date.now();
  const olderThanMs = olderThanDays * DAY_MS;
  const candidates = [];

  for (const agentDir of await listDirs(path.join(workspaceRoot, 'agents'))) {
    for (const outputDir of await listDirs(path.join(agentDir, 'output'))) {
      await addCandidate(candidates, outputDir, `agent output older than ${olderThanDays}d`, now, olderThanMs);
    }
  }

  const publishDirs = await Promise.all((await listDirs(publishRoot)).map(async (p) => ({ path: p, stat: await stat(p) })));
  publishDirs
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(keepPublish)
    .forEach((entry) => candidates.push({ path: entry.path, reason: `old publish staging snapshot; keeping newest ${keepPublish}`, mtimeMs: entry.stat.mtimeMs, bytes: 0 }));

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
      await addCandidate(candidates, path.join(projectDir, rel), `rebuildable project artifact: ${rel}`, now, 0);
    }
  }

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
