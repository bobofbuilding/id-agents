import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HEARTBEAT_SCHEMA_VERSION,
  JsonFileRegistryStore,
  RegistryControlPlane,
  signHeartbeat,
} from '../src/registry-control-plane.mjs';

const NOW = Date.parse('2026-01-01T00:00:10.000Z');

function makeKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
}

function makeHeartbeat(keys, overrides = {}) {
  const heartbeat = {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    agentId: 'agent-recovery',
    controllerId: 'controller-recovery',
    nonce: `recovery-${overrides.sequence ?? 1}`,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:10:00.000Z',
    sequence: 1,
    payload: {
      status: 'active',
      health: 'healthy',
      metadata: { drill: true },
    },
    ...overrides,
  };
  heartbeat.signature = signHeartbeat(heartbeat, keys.privateKey);
  return heartbeat;
}

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'registry-recovery-drill-'));
  const filePath = join(directory, 'registry.json');
  try {
    const keys = makeKeys();
    const store = new JsonFileRegistryStore(filePath);
    const control = new RegistryControlPlane({ store, clock: () => NOW });
    await control.bootstrapAgent({
      agentId: 'agent-recovery',
      controllerId: 'controller-recovery',
      controllerPublicKey: keys.publicKey,
    });

    const invalid = makeHeartbeat(keys);
    invalid.signature = 'definitely-not-a-signature';
    await assert.rejects(control.ingestHeartbeat(invalid), (error) => error.code === 'invalid_signature');
    const quarantine = await control.quarantineRecords();
    assert.ok(quarantine.some((entry) => entry.reason_code === 'invalid_signature'));

    // The corrected message reuses the same nonce after the failed attempt;
    // quarantine does not poison a later, valid correction.
    const corrected = makeHeartbeat(keys);
    const accepted = await control.ingestHeartbeat(corrected);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.sequence, 1);

    const preRebuild = await control.getRecord('agent-recovery');
    const preRebuildAudit = await control.auditEvents();
    assert.equal(preRebuild.sequence, 1);
    assert.equal(preRebuild.authority_state.execution_allowed, false);
    assert.equal(preRebuild.authority_state.spend_allowed, false);
    assert.equal(preRebuild.authority_state.authority_changes_allowed, false);

    // Rebuild only from the durable file, then confirm the append-only audit
    // view and the public record agree with the pre-rebuild instance.
    const rebuiltStore = new JsonFileRegistryStore(filePath);
    const rebuilt = new RegistryControlPlane({ store: rebuiltStore, clock: () => NOW });
    const rebuiltAudit = await rebuilt.auditEvents();
    const rebuiltRecord = await rebuilt.getRecord('agent-recovery');
    assert.deepEqual(rebuiltAudit, preRebuildAudit);
    assert.equal(rebuiltRecord.sequence, preRebuild.sequence);
    assert.deepEqual(rebuiltRecord.authority_state, preRebuild.authority_state);

    console.log('PASS registry recovery drill: quarantine correction + durable rebuild (sequence=1, authority locked)');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (error) {
  console.error(`FAIL registry recovery drill: ${error?.stack ?? error}`);
  process.exitCode = 1;
}
