// SPDX-License-Identifier: MIT
/**
 * Optional SkillMesh provider HD key derivation for id-agents.
 *
 * This helper is intentionally inert unless the SkillMesh provider/plugin is
 * attached or explicitly enabled. Neutral agents do not receive these keys.
 *
 * The master key is accepted only from the explicit SKILLMESH_MASTER_KEY
 * process environment. Consumer installs never search workspaces, repositories,
 * or .env files for signing material.
 */

import { HDKey } from '@scure/bip32';
import { privateKeyToAccount } from 'viem/accounts';

export interface SkillmeshKeyInfo {
  address: string;
  keyIndex: number;
  derivationPath: string;
  privateKey: string;
}

/** Load an explicitly configured master private key without ever logging it. */
export function loadMasterKey(_workspaceDir?: string): string | null {
  const fromEnv = process.env.SKILLMESH_MASTER_KEY?.trim();
  if (!fromEnv) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(fromEnv)) {
    throw new Error('SKILLMESH_MASTER_KEY must be an explicit 32-byte hex private key');
  }
  return fromEnv;
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
