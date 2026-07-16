import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeContributorAttestation, buildContributorAttestation } from '../src/eas.mjs';
import { decryptApplication, deriveEncKeypair, encryptApplication } from '../src/contributor-crypto.mjs';
import { decodeEscrowAction, encodeEscrowAction } from '../src/escrow.mjs';
import { assertTestChain } from '../src/chain-guard.mjs';

const signature = `0x${'11'.repeat(65)}`;
const schemaUid = `0x${'22'.repeat(32)}`;
const address = '0x0000000000000000000000000000000000000001';

test('deriveEncKeypair is deterministic and encrypted application round-trips', () => {
  const keypair = deriveEncKeypair(signature);
  assert.deepEqual(keypair, deriveEncKeypair(signature));
  const application = { role: 'research', nested: { b: 2, a: 1 } };
  const envelope = encryptApplication(application, keypair.publicKey, {
    ephemeralPrivateKey: `0x${'33'.repeat(32)}`,
    nonce: `0x${'44'.repeat(12)}`,
  });
  assert.deepEqual(decryptApplication(envelope, keypair.privateKey), application);
  assert.equal(envelope.applicationHash.length, 66);
});

test('EAS attestation calldata decodes to its encrypted payload commitments', () => {
  const keypair = deriveEncKeypair(signature);
  const envelope = encryptApplication({ role: 'governance' }, keypair.publicKey, {
    ephemeralPrivateKey: `0x${'55'.repeat(32)}`,
    nonce: `0x${'66'.repeat(12)}`,
  });
  const built = buildContributorAttestation({ schemaUid, recipient: address, envelope });
  const decoded = decodeContributorAttestation(built.calldata);
  assert.equal(decoded.functionName, 'attest');
  assert.equal(decoded.request.schema, schemaUid);
  assert.equal(decoded.payload.applicationHash, envelope.applicationHash);
  assert.equal(decoded.payload.encryptionPublicKey, keypair.publicKey);
  assert.equal(decoded.payload.encryptedApplicationHash, built.encryptedApplicationHash);
});

for (const action of ['release', 'refund']) {
  test(`${action} calldata round-trips`, () => {
    const calldata = encodeEscrowAction(action, { escrowId: 7, milestoneId: 3 });
    const decoded = decodeEscrowAction(calldata);
    assert.equal(decoded.functionName, action);
    assert.deepEqual(decoded.args, [7n, 3]);
  });
}

test('dispute calldata round-trips', () => {
  const reasonHash = `0x${'77'.repeat(32)}`;
  const evidenceHash = `0x${'88'.repeat(32)}`;
  const calldata = encodeEscrowAction('dispute', { escrowId: 9, milestoneId: 1, reasonHash, evidenceHash });
  const decoded = decodeEscrowAction(calldata);
  assert.equal(decoded.functionName, 'raiseDispute');
  assert.deepEqual(decoded.args, [9n, 1, reasonHash, evidenceHash]);
});

test('chain guard rejects production and unknown chains', () => {
  assert.equal(assertTestChain(84532), 84532);
  assert.equal(assertTestChain(31337), 31337);
  assert.throws(() => assertTestChain(1), /forbidden/);
  assert.throws(() => assertTestChain(8453), /forbidden/);
  assert.throws(() => assertTestChain(10), /not allowlisted/);
});
