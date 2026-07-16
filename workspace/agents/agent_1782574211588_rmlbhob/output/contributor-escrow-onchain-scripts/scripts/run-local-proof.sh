#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${ANVIL_PORT:-18545}"
RPC_URL="http://127.0.0.1:${PORT}"
FROM="0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
EAS="0x4200000000000000000000000000000000000021"
ESCROW="0x000000000000000000000000000000000000ec50"
SCHEMA_UID="0x$(printf '22%.0s' {1..32})"
REASON_HASH="0x$(printf '77%.0s' {1..32})"
EVIDENCE_HASH="0x$(printf '88%.0s' {1..32})"

anvil --silent --port "$PORT" >"${TMPDIR:-/tmp}/bittrees-onchain-anvil.log" 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT

for _ in {1..30}; do
  cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
  sleep 0.1
done
cast chain-id --rpc-url "$RPC_URL" >/dev/null

forge build >/dev/null
EAS_CODE="$(forge inspect MockEAS deployedBytecode)"
ESCROW_CODE="$(forge inspect MockEscrow deployedBytecode)"
cast rpc --rpc-url "$RPC_URL" anvil_setCode "$EAS" "$EAS_CODE" >/dev/null
cast rpc --rpc-url "$RPC_URL" anvil_setCode "$ESCROW" "$ESCROW_CODE" >/dev/null

export WALLET_SIGNATURE="0x$(printf '11%.0s' {1..65})"
node scripts/eas-attestation.mjs simulate \
  --application fixtures/application.json \
  --schema-uid "$SCHEMA_UID" \
  --recipient "$FROM" \
  --from "$FROM" \
  --eas-address "$EAS" \
  --rpc-url "$RPC_URL" >/dev/null

node scripts/escrow-calldata.mjs simulate release --escrow-id 1 --milestone-id 0 \
  --target "$ESCROW" --from "$FROM" --rpc-url "$RPC_URL" >/dev/null
node scripts/escrow-calldata.mjs simulate refund --escrow-id 1 --milestone-id 0 \
  --target "$ESCROW" --from "$FROM" --rpc-url "$RPC_URL" >/dev/null
node scripts/escrow-calldata.mjs simulate dispute --escrow-id 1 --milestone-id 0 \
  --reason-hash "$REASON_HASH" --evidence-hash "$EVIDENCE_HASH" \
  --target "$ESCROW" --from "$FROM" --rpc-url "$RPC_URL" >/dev/null

printf '%s\n' "local-proof=pass chainId=31337 transactions=0 eas=simulated release=simulated refund=simulated dispute=simulated"
