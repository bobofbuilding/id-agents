// SPDX-License-Identifier: MIT
/**
 * Optional SkillMesh provider HD key derivation for id-agents.
 *
 * This helper is intentionally inert unless the SkillMesh provider/plugin is
 * attached or explicitly enabled. Neutral agents do not receive these keys.
 *
 * Master key resolution order:
 *   1. SKILLMESH_MASTER_KEY env var (preferred)
 *   2. ${workspaceDir}/packages/skill-master/.env → SKILL_MASTER_PRIVATE_KEY
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { HDKey } from '@scure/bip32';
import { privateKeyToAccount } from 'viem/accounts';

export interface SkillmeshKeyInfo {
  address: string;
  keyIndex: number;
  derivationPath: string;
  privateKey: string;
}

/** Load the master private key without ever logging it. */
export function loadMasterKey(workspaceDir: string): string | null {
  const fromEnv = process.env.SKILLMESH_MASTER_KEY;
  if (fromEnv?.startsWith('0x')) return fromEnv;

  const cwd = process.cwd();
  const candidates = [
    path.join(workspaceDir, 'packages', 'skill-master', '.env'),
    path.join(workspaceDir, 'projects', 'skillmesh', 'packages', 'skill-master', '.env'),
    path.join(cwd, 'packages', 'skill-master', '.env'),
    path.join(cwd, 'projects', 'skillmesh', 'packages', 'skill-master', '.env'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const match = readFileSync(p, 'utf8').match(/^SKILL_MASTER_PRIVATE_KEY=(\S+)/m);
    if (match?.[1]?.startsWith('0x')) return match[1];
  }
  return null;
}

/** Derive a key at the given BIP44 index from a raw 32-byte hex private key seed. */
export function deriveKeyAtIndex(masterKey: string, index: number): SkillmeshKeyInfo {
  const seed = Buffer.from(masterKey.slice(2), 'hex');
  const root = HDKey.fromMasterSeed(seed);
  const derivationPath = `m/44'/60'/0'/0/${index}`;
  const child = root.derive(derivationPath);
  if (!child.privateKey) throw new Error(`BIP32 derive failed at ${derivationPath}`);
  const privateKey = ('0x' + Buffer.from(child.privateKey).toString('hex')) as `0x${string}`;
  const address = privateKeyToAccount(privateKey).address;
  return { address, keyIndex: index, derivationPath, privateKey };
}
