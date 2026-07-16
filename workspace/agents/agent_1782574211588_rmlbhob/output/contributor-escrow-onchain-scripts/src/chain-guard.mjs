export const ALLOWED_CHAIN_IDS = new Set([84532, 11155111, 31337]);
export const FORBIDDEN_CHAIN_IDS = new Set([1, 8453]);

export function assertTestChain(chainId) {
  const normalized = Number(chainId);
  if (!Number.isSafeInteger(normalized)) {
    throw new Error(`Invalid chain id: ${chainId}`);
  }
  if (FORBIDDEN_CHAIN_IDS.has(normalized)) {
    throw new Error(`Production chain ${normalized} is forbidden`);
  }
  if (!ALLOWED_CHAIN_IDS.has(normalized)) {
    throw new Error(
      `Chain ${normalized} is not allowlisted; expected Base Sepolia (84532), Sepolia (11155111), or local Anvil (31337)`,
    );
  }
  return normalized;
}
