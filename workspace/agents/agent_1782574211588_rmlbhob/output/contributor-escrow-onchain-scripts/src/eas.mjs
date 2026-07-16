import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToHex,
} from 'viem';

export const BASE_EAS_ADDRESS = '0x4200000000000000000000000000000000000021';
export const CONTRIBUTOR_SCHEMA = 'bytes encryptedApplication,bytes32 applicationHash,bytes32 encryptionPublicKey';

export const easAbi = parseAbi([
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)',
]);

export function buildContributorAttestation({
  schemaUid,
  recipient,
  envelope,
  expirationTime = 0n,
  revocable = false,
  refUid = `0x${'00'.repeat(32)}`,
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(schemaUid)) throw new Error('Schema UID must be bytes32 hex');
  if (!isAddress(recipient, { strict: true })) throw new Error('Recipient must be a checksummed or lowercase EVM address');
  const encryptedApplication = stringToHex(JSON.stringify(envelope));
  const data = encodeAbiParameters(
    parseAbiParameters('bytes encryptedApplication, bytes32 applicationHash, bytes32 encryptionPublicKey'),
    [encryptedApplication, envelope.applicationHash, envelope.recipientPublicKey],
  );
  const request = {
    schema: schemaUid,
    data: {
      recipient,
      expirationTime,
      revocable,
      refUID: refUid,
      data,
      value: 0n,
    },
  };
  return {
    easAddress: BASE_EAS_ADDRESS,
    schema: CONTRIBUTOR_SCHEMA,
    request,
    calldata: encodeFunctionData({ abi: easAbi, functionName: 'attest', args: [request] }),
    encryptedApplicationHash: keccak256(encryptedApplication),
  };
}

export function decodeContributorAttestation(calldata) {
  const decoded = decodeFunctionData({ abi: easAbi, data: calldata });
  const request = decoded.args[0];
  const [encryptedApplication, applicationHash, encryptionPublicKey] = decodeAbiParameters(
    parseAbiParameters('bytes encryptedApplication, bytes32 applicationHash, bytes32 encryptionPublicKey'),
    request.data.data,
  );
  return {
    functionName: decoded.functionName,
    request,
    payload: {
      encryptedApplication,
      applicationHash,
      encryptionPublicKey,
      encryptedApplicationHash: keccak256(encryptedApplication),
    },
  };
}
