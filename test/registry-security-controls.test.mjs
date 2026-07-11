import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  HEARTBEAT_SCHEMA_VERSION,
  MemoryRegistryStore,
  RegistryControlPlane,
  signHeartbeat,
} from '../src/registry-control-plane.mjs';
import {
  RegistrySecurityControls,
  RegistryRejectedError,
  createRegistryCredential,
} from '../src/registry-security-controls.mjs';

const NOW = Date.parse('2026-01-01T00:00:10.000Z');
const controllerCredential = createRegistryCredential('controller', 'test-controller');
const readerCredential = createRegistryCredential('reader', 'test-reader');

function makeKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
}

async function makeSecurity({ maxCalls = 32, windowMs = 60_000 } = {}) {
  const keys = makeKeys();
  const core = new RegistryControlPlane({ store: new MemoryRegistryStore(), clock: () => NOW });
  await core.bootstrapAgent({
    agentId: 'agent-alpha',
    controllerId: 'controller-alpha',
    controllerPublicKey: keys.publicKey,
  });
  const security = new RegistrySecurityControls({
    controlPlane: core,
    maxCalls,
    windowMs,
    clock: () => NOW,
  });
  return { core, security, keys };
}

function heartbeat(keys, sequence, overrides = {}) {
  const base = {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    agentId: 'agent-alpha',
    controllerId: 'controller-alpha',
    nonce: `nonce-${sequence}`,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:10:00.000Z',
    sequence,
    payload: { status: 'active', health: 'healthy', metadata: { sequence } },
    ...overrides,
  };
  base.signature = signHeartbeat(base, keys.privateKey);
  return base;
}

test('rate limiting rejects calls over the controller budget', async () => {
  const { security, keys } = await makeSecurity({ maxCalls: 2 });
  await security.ingestHeartbeat(heartbeat(keys, 1), controllerCredential);
  await security.ingestHeartbeat(heartbeat(keys, 2), controllerCredential);
  await assert.rejects(
    security.ingestHeartbeat(heartbeat(keys, 3), controllerCredential),
    (error) => error instanceof RegistryRejectedError && error.code === 'rate_limited',
  );
});

test('wrapper serialization preserves every concurrent update', async () => {
  const { security, keys } = await makeSecurity({ maxCalls: 16 });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    security.ingestHeartbeat(heartbeat(keys, index + 1), controllerCredential)
  )));
  assert.equal(results.filter((result) => result.status === 'accepted').length, 8);
  const record = await security.getRecord('agent-alpha', readerCredential);
  assert.equal(record.sequence, 8);
  assert.equal((await security.auditEvents(readerCredential)).filter((event) => event.event_type === 'heartbeat.accepted').length, 8);
});

test('reader credentials cannot mutate while controller credentials can', async () => {
  const { security, keys } = await makeSecurity();
  await assert.rejects(
    security.ingestHeartbeat(heartbeat(keys, 1), readerCredential),
    (error) => error.code === 'insufficient_privilege',
  );
  await assert.rejects(
    security.revokeAgent('agent-alpha', { reason: 'reader must not revoke', credential: readerCredential }),
    (error) => error.code === 'insufficient_privilege',
  );
  await security.ingestHeartbeat(heartbeat(keys, 1), controllerCredential);
  await security.revokeAgent('agent-alpha', { reason: 'controller safety stop' }, controllerCredential);
});

test('emergency pause fails closed for writes while reads remain available', async () => {
  const { security, keys } = await makeSecurity();
  security.setEmergencyPause(true);
  await assert.rejects(
    security.ingestHeartbeat({ malformed: true }, controllerCredential),
    (error) => error.code === 'paused',
  );
  const record = await security.getRecord('agent-alpha', readerCredential);
  assert.equal(record.sequence, 0);
  const emitted = await security.emitRecord('agent-alpha', readerCredential);
  assert.equal(emitted.paused, true);
  assert.equal(emitted.authorityState.paused, true);
  security.setEmergencyPause(false);
  await security.ingestHeartbeat(heartbeat(keys, 1), controllerCredential);
});

test('recovery drill exits cleanly', () => {
  const result = spawnSync(process.execPath, ['scripts/registry-recovery-drill.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS registry recovery drill/);
});
