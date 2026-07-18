// SPDX-License-Identifier: MIT
/**
 * Persist an agent's profile fields (bio, handles) back into the team config
 * YAML so they survive restarts and `/sync` (the YAML is the redeploy floor).
 *
 * Uses the `yaml` Document API for a surgical edit: only the target agent
 * entry's `bio`/`handles` keys change; comments, ordering, and formatting in
 * the rest of the file are preserved. The write is atomic (tmp + rename).
 *
 * The config path comes ONLY from manager-recorded team state (the last
 * successfully deployed/synced config) — never from a caller — so this path
 * cannot be used for traversal or arbitrary file writes.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { isMap, isSeq, parseDocument } from 'yaml';
import type { AgentHandles } from '../config-parser.js';

export interface ProfileConfigWriteResult {
  ok: boolean;
  /** Human-readable reason when ok=false. */
  reason?: string;
}

/**
 * Update `bio`/`handles` for the named agent inside the config file.
 * `undefined` leaves a field untouched; `null` deletes it from the entry.
 */
export function writeProfileToConfig(
  configPath: string,
  agentName: string,
  profile: { bio?: string | null; handles?: AgentHandles | null },
): ProfileConfigWriteResult {
  if (!existsSync(configPath)) {
    return { ok: false, reason: `config file not found: ${configPath}` };
  }

  let source: string;
  try {
    source = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return { ok: false, reason: `config not readable: ${(e as Error).message}` };
  }

  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return { ok: false, reason: `config has YAML errors: ${doc.errors[0]!.message}` };
  }

  const agents = doc.get('agents');
  if (!isSeq(agents)) {
    return { ok: false, reason: 'config has no agents list' };
  }

  const entry = agents.items.find(
    (item) => isMap(item) && item.get('name') === agentName,
  );
  if (!entry || !isMap(entry)) {
    return { ok: false, reason: `agent "${agentName}" not found in config` };
  }

  if (profile.bio !== undefined) {
    if (profile.bio === null) entry.delete('bio');
    else entry.set('bio', profile.bio);
  }
  if (profile.handles !== undefined) {
    if (profile.handles === null) entry.delete('handles');
    else entry.set('handles', doc.createNode(profile.handles));
  }

  try {
    const tmpPath = `${configPath}.profile-write.tmp`;
    writeFileSync(tmpPath, doc.toString(), 'utf-8');
    renameSync(tmpPath, configPath);
  } catch (e) {
    return { ok: false, reason: `config not writable: ${(e as Error).message}` };
  }
  return { ok: true };
}
