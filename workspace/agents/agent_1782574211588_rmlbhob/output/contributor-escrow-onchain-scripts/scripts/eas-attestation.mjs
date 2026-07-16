#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import { deriveEncKeypair, encryptApplication } from '../src/contributor-crypto.mjs';
import { buildContributorAttestation, decodeContributorAttestation } from '../src/eas.mjs';
import { simulateCall } from '../src/rpc.mjs';

function argsToObject(args) {
  const result = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) result._.push(args[i]);
    else result[args[i].slice(2)] = args[i + 1], i += 1;
  }
  return result;
}

function json(value) {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
}

const options = argsToObject(process.argv.slice(2));
const command = options._[0];

if (command === 'decode') {
  console.log(json(decodeContributorAttestation(options.data)));
  process.exit(0);
}

if (command !== 'build' && command !== 'simulate') {
  throw new Error('Usage: eas-attestation.mjs <build|simulate|decode> [options]');
}

if (!process.env.WALLET_SIGNATURE) {
  throw new Error('WALLET_SIGNATURE is required in the environment; never pass it as a CLI argument');
}
const application = JSON.parse(await readFile(options.application, 'utf8'));
const keypair = deriveEncKeypair(process.env.WALLET_SIGNATURE);
const recipientPublicKey = options['encryption-public-key'] ?? keypair.publicKey;
const envelope = encryptApplication(application, recipientPublicKey);
const built = buildContributorAttestation({
  schemaUid: options['schema-uid'],
  recipient: getAddress(options.recipient),
  envelope,
});

const safeOutput = {
  easAddress: built.easAddress,
  schema: built.schema,
  request: built.request,
  calldata: built.calldata,
  encryptedApplicationHash: built.encryptedApplicationHash,
  derivedEncryptionPublicKey: keypair.publicKey,
};

if (command === 'simulate') {
  safeOutput.simulation = await simulateCall({
    rpcUrl: options['rpc-url'],
    account: getAddress(options.from),
    target: getAddress(options['eas-address'] ?? built.easAddress),
    calldata: built.calldata,
  });
}
console.log(json(safeOutput));
