# Bittrees contributor + escrow onchain helpers

Task: `implement-contributor-escrow-onchain-scripts` (#1a947b77)

This package builds and decodes calldata for two testnet-only flows:

1. `deriveEncKeypair` -> `encryptApplication` -> EAS `attest` on Base Sepolia.
2. Bittrees escrow `release`, `refund`, and `raiseDispute` calls from the local `escrow-interface.md` design.

There is deliberately no send/broadcast command. Simulation uses `eth_estimateGas` and `eth_call`. The chain guard accepts only Base Sepolia (`84532`), Sepolia (`11155111`), and local Anvil (`31337`); Ethereum and Base mainnet fail closed.

## Install and verify

```bash
npm install
npm test
npm run proof:local
```

The local proof starts Anvil, installs stateless mock runtime bytecode using the Anvil-only `anvil_setCode` method, and simulates all four call shapes. It sends zero transactions and uses no private key.

## Contributor attestation

The default schema string is:

```text
bytes encryptedApplication,bytes32 applicationHash,bytes32 encryptionPublicKey
```

Register/review the schema separately and pass its testnet UID. The script never registers a schema and never broadcasts. It uses the official Base Sepolia EAS predeploy address `0x4200000000000000000000000000000000000021`.

Keep the wallet signature out of shell arguments and logs:

```bash
export WALLET_SIGNATURE='0x...'
node scripts/eas-attestation.mjs build \
  --application fixtures/application.json \
  --schema-uid 0x... \
  --recipient 0x...
```

By default the application is encrypted to the X25519 public key deterministically derived from `WALLET_SIGNATURE`. To encrypt to an intake/reviewer key instead, add `--encryption-public-key 0x...`. Output includes only the public key, encrypted envelope, hashes, and calldata; it never includes the derived private key or wallet signature.

Simulate without sending:

```bash
node scripts/eas-attestation.mjs simulate \
  --application fixtures/application.json \
  --schema-uid 0x... \
  --recipient 0x... \
  --from 0x... \
  --rpc-url https://sepolia.base.org
```

Decode calldata:

```bash
node scripts/eas-attestation.mjs decode --data 0x...
```

Encryption is X25519 + HKDF-SHA256 + ChaCha20-Poly1305 with a fresh ephemeral key and nonce. The wallet signature is secret derivation material; obtain it only after a transparent, domain-separated message preview and never persist it. The current design reference was not present in this workspace, so the exact signing message/domain remains a required integration decision before UI wiring.

## Escrow calldata

```bash
node scripts/escrow-calldata.mjs encode release --escrow-id 1 --milestone-id 0
node scripts/escrow-calldata.mjs encode refund --escrow-id 1 --milestone-id 0
node scripts/escrow-calldata.mjs encode dispute \
  --escrow-id 1 --milestone-id 0 \
  --reason-hash 0x... --evidence-hash 0x...
node scripts/escrow-calldata.mjs decode --data 0x...
```

To simulate, replace `encode` with `simulate` and add `--target`, `--from`, and `--rpc-url`. The helper consumes the exact design surface in `../escrow-interface.md`; no deployed Bittrees escrow address is claimed.

## Safe handoff

`safe/scoped-module.stub.json` is intentionally a stub. Wallet-engineer must choose/pin an audited Safe module, fill testnet addresses, convert signatures to selectors, add deny-path tests, and finalize nonce/session/revocation/quorum controls. It grants no allowance, ownership, admin role, or production authority.

## Abort conditions

- Any chain ID outside `84532`, `11155111`, or `31337`.
- Missing/replaced schema UID, EAS target, escrow target, sender, or exact ABI review.
- Nonzero native value, token approval, production authority, real funds, or a request to broadcast.
- A simulation revert, unexpected selector, or mismatch between decoded and intended arguments.
