import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem';

export const escrowAbi = parseAbi([
  'function release(uint256 escrowId, uint32 milestoneId)',
  'function refund(uint256 escrowId, uint32 milestoneId)',
  'function raiseDispute(uint256 escrowId, uint32 milestoneId, bytes32 reasonHash, bytes32 evidenceHash)',
]);

function asUint(value, label, max) {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > max) throw new Error(`${label} is out of range`);
  return parsed;
}

function asBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be bytes32 hex`);
  return value;
}

export function encodeEscrowAction(action, options) {
  const escrowId = asUint(options.escrowId, 'Escrow id', (1n << 256n) - 1n);
  const milestoneId = Number(asUint(options.milestoneId, 'Milestone id', (1n << 32n) - 1n));
  if (action === 'release' || action === 'refund') {
    return encodeFunctionData({ abi: escrowAbi, functionName: action, args: [escrowId, milestoneId] });
  }
  if (action === 'dispute') {
    return encodeFunctionData({
      abi: escrowAbi,
      functionName: 'raiseDispute',
      args: [
        escrowId,
        milestoneId,
        asBytes32(options.reasonHash, 'Reason hash'),
        asBytes32(options.evidenceHash, 'Evidence hash'),
      ],
    });
  }
  throw new Error(`Unknown escrow action: ${action}`);
}

export function decodeEscrowAction(calldata) {
  const decoded = decodeFunctionData({ abi: escrowAbi, data: calldata });
  return { functionName: decoded.functionName, args: decoded.args };
}
