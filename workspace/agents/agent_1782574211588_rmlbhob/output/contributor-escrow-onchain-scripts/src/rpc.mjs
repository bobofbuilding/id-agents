import { createPublicClient, http } from 'viem';
import { assertTestChain } from './chain-guard.mjs';

export async function simulateCall({ rpcUrl, account, target, calldata, value = 0n }) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = assertTestChain(await client.getChainId());
  const gas = await client.estimateGas({ account, to: target, data: calldata, value });
  const result = await client.call({ account, to: target, data: calldata, value });
  return { chainId, gas, result: result.data ?? '0x' };
}
