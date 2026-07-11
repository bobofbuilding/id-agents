import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  EMITTED_RECORD_SCHEMA_VERSION,
  HEARTBEAT_SCHEMA_VERSION,
  JsonFileRegistryStore,
  MemoryRegistryStore,
  RegistryControlPlane,
  RegistryRejectedError,
  signControllerRotation,
  signHeartbeat,
} from '../src/registry-control-plane.mjs';

const NOW = Date.parse('2026-01-01T00:00:10.000Z');

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
}

async function controlPlane({ now = NOW, store = new MemoryRegistryStore() } = {}) {
  const controller = keys();
  const control = new RegistryControlPlane({ store, clock: () => now });
  await control.bootstrapAgent({
    agentId: 'agent-alpha',
    controllerId: 'controller-alpha',
    controllerPublicKey: controller.publicKey,
  });
  return { control, controller };
}

function heartbeat(controller, overrides = {}) {
  const base = {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    agentId: 'agent-alpha',
    controllerId: 'controller-alpha',
    nonce: `nonce-${overrides.sequence ?? 1}`,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:10:00.000Z',
    sequence: 1,
    payload: {
      status: 'active',
      health: 'healthy',
      displayName: 'Alpha',
      metadata: { region: 'test' },
    },
    ...overrides,
  };
  base.signature = signHeartbeat(base, controller.privateKey);
  return base;
}

function rotation(agentId, newControllerPublicKey, currentController) {
  const request = { agentId, newControllerPublicKey };
  request.signature = signControllerRotation(request, currentController.privateKey);
  return request;
}

test('valid signed refresh accepts camelCase input and emits validated public state', async () => {
  const { control, controller } = await controlPlane();
  const result = await control.ingestHeartbeat(heartbeat(controller));

  assert.equal(result.status, 'accepted');
  assert.equal(result.sequence, 1);
  const record = await control.getRecord('agent-alpha');
  assert.equal(record.sequence, 1);
  assert.equal(record.last_seen, '2026-01-01T00:00:00.000Z');
  assert.equal(record.authority_state.execution_allowed, false);

  const emitted = await control.emitRecord('agent-alpha');
  assert.equal(emitted.schemaVersion, EMITTED_RECORD_SCHEMA_VERSION);
  assert.equal(emitted.agentId, 'agent-alpha');
  assert.equal(emitted.lastSeen, '2026-01-01T00:00:00.000Z');
  assert.equal(emitted.authorityState.authorityChangesAllowed, false);
  assert.equal(emitted.authorityState.spendAllowed, false);
  assert.equal(emitted.authorityState.executionAllowed, false);
});

test('exact retry is idempotent while nonce reuse with a different message is quarantined as replay', async () => {
  const { control, controller } = await controlPlane();
  const first = heartbeat(controller);
  assert.equal((await control.ingestHeartbeat(first)).status, 'accepted');
  assert.equal((await control.ingestHeartbeat(first)).status, 'idempotent');

  const replay = heartbeat(controller, {
    sequence: 2,
    nonce: first.nonce,
    payload: { status: 'active', health: 'degraded' },
  });
  await assert.rejects(control.ingestHeartbeat(replay), (error) => {
    assert.ok(error instanceof RegistryRejectedError);
    assert.equal(error.code, 'replay');
    return true;
  });
  const quarantine = await control.quarantineRecords();
  assert.equal(quarantine.at(-1).reason_code, 'replay');
});

test('expired and future-issued heartbeats are rejected and quarantined', async () => {
  const { control, controller } = await controlPlane();
  const expired = heartbeat(controller, {
    expiresAt: '2026-01-01T00:00:05.000Z',
  });
  await assert.rejects(control.ingestHeartbeat(expired), (error) => error.code === 'expired');

  const future = heartbeat(controller, {
    sequence: 2,
    nonce: 'future-nonce',
    issuedAt: '2026-01-01T00:20:00.000Z',
    expiresAt: '2026-01-01T00:30:00.000Z',
  });
  await assert.rejects(control.ingestHeartbeat(future), (error) => error.code === 'issued_at_in_future');
  assert.equal((await control.quarantineRecords()).length, 2);
});

test('controller binding and authority mutation fail closed', async () => {
  const { control, controller } = await controlPlane();
  const wrongController = heartbeat(controller, { controllerId: 'controller-other' });
  await assert.rejects(control.ingestHeartbeat(wrongController), (error) => error.code === 'controller_binding_mismatch');

  const authorityChange = heartbeat(controller, {
    sequence: 2,
    nonce: 'authority-nonce',
    payload: { authority: { role: 'operator' }, spendLimit: 1000 },
  });
  await assert.rejects(control.ingestHeartbeat(authorityChange), (error) => error.code === 'authority_mutation');
  const record = await control.getRecord('agent-alpha');
  assert.equal(record.sequence, 0);
  assert.equal(record.authority_state.spend_allowed, false);
});

test('invalid signature is quarantined without retaining raw signatures or secrets', async () => {
  const { control, controller } = await controlPlane();
  const invalid = heartbeat(controller, {
    payload: { status: 'active', privateKey: '-----BEGIN PRIVATE KEY-----secret' },
  });
  invalid.signature = 'not-a-valid-signature';
  await assert.rejects(control.ingestHeartbeat(invalid), (error) => error.code === 'invalid_signature');
  const serialized = JSON.stringify(await control.snapshot());
  assert.doesNotMatch(serialized, /BEGIN PRIVATE KEY|not-a-valid-signature|super-secret/);
  assert.match(serialized, /\[REDACTED\]/);
});

test('concurrent signed refreshes serialize atomically and preserve monotonic sequence', async () => {
  const { control, controller } = await controlPlane();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => control.ingestHeartbeat(heartbeat(controller, {
    sequence: index + 1,
    nonce: `concurrent-${index + 1}`,
    payload: { status: 'active', health: index % 2 ? 'healthy' : 'degraded' },
  }))));
  assert.equal(results.filter((result) => result.status === 'accepted').length, 8);
  const record = await control.getRecord('agent-alpha');
  assert.equal(record.sequence, 8);
  const accepted = (await control.auditEvents()).filter((event) => event.event_type === 'heartbeat.accepted');
  assert.equal(accepted.length, 8);
});

test('metadata is redacted at storage and emission boundaries, and revocation blocks later refresh', async () => {
  const { control, controller } = await controlPlane();
  await control.ingestHeartbeat(heartbeat(controller, {
    payload: {
      status: 'active',
      metadata: { publicNote: 'ok', apiToken: 'super-secret', privateKey: 'private-material' },
    },
  }));
  const emitted = await control.emitRecord('agent-alpha');
  assert.equal(emitted.metadata.publicNote, 'ok');
  assert.equal(emitted.metadata.apiToken, '[REDACTED]');
  assert.equal(emitted.metadata.privateKey, '[REDACTED]');

  await control.revokeAgent('agent-alpha', { reason: 'test safety stop' });
  await assert.rejects(control.ingestHeartbeat(heartbeat(controller, {
    sequence: 2,
    nonce: 'revoked-nonce',
  })), (error) => error.code === 'revoked');
});

test('controller rotation preserves heartbeat history while replacing the signing key', async () => {
  const { control, controller } = await controlPlane();
  const replacement = keys();
  await control.ingestHeartbeat(heartbeat(controller));

  const result = await control.rotateController(
    'agent-alpha',
    rotation('agent-alpha', replacement.publicKey, controller),
  );
  assert.deepEqual(result, { status: 'rotated', agentId: 'agent-alpha' });
  assert.deepEqual((await control.auditEvents()).at(-1), {
    event_type: 'controller.rotated',
    agent_id: 'agent-alpha',
    recorded_at: '2026-01-01T00:00:10.000Z',
  });

  await assert.rejects(control.ingestHeartbeat(heartbeat(controller, {
    sequence: 2,
    nonce: 'old-key-nonce',
  })), (error) => error.code === 'invalid_signature');

  const accepted = await control.ingestHeartbeat(heartbeat(replacement, {
    sequence: 2,
    nonce: 'new-key-nonce',
  }));
  assert.deepEqual(accepted, { status: 'accepted', sequence: 2 });
  const record = await control.getRecord('agent-alpha');
  assert.equal(record.sequence, 2);
  assert.deepEqual(record.authority_state, {
    execution_allowed: false,
    spend_allowed: false,
    authority_changes_allowed: false,
  });
});

test('rotation signed by a non-bound controller is quarantined', async () => {
  const { control, controller } = await controlPlane();
  const attacker = keys();
  const replacement = keys();
  await assert.rejects(
    control.rotateController('agent-alpha', rotation('agent-alpha', replacement.publicKey, attacker)),
    (error) => error instanceof RegistryRejectedError && error.code === 'invalid_rotation_signature',
  );
  assert.equal((await control.quarantineRecords()).at(-1).reason_code, 'invalid_rotation_signature');

  // The failed proof cannot change the bound key.
  assert.equal((await control.ingestHeartbeat(heartbeat(controller))).status, 'accepted');
});

test('rotation of a revoked agent is rejected', async () => {
  const { control, controller } = await controlPlane();
  const replacement = keys();
  await control.revokeAgent('agent-alpha', { reason: 'test safety stop' });

  await assert.rejects(
    control.rotateController('agent-alpha', rotation('agent-alpha', replacement.publicKey, controller)),
    (error) => error instanceof RegistryRejectedError && error.code === 'revoked',
  );
  assert.equal((await control.quarantineRecords()).at(-1).reason_code, 'revoked');
});

test('file store writes versioned state atomically and reloads it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-registry-'));
  const filePath = join(directory, 'registry.json');
  try {
    const store = new JsonFileRegistryStore(filePath);
    const { control, controller } = await controlPlane({ store });
    await control.ingestHeartbeat(heartbeat(controller));
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(raw.schema_version, 'agent.registry.state.v1');
    assert.ok(raw.version >= 2);
    const reloaded = new RegistryControlPlane({ store, clock: () => NOW });
    assert.equal((await reloaded.getRecord('agent-alpha')).sequence, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
