#!/usr/bin/env node
import { getAddress } from 'viem';
import { decodeEscrowAction, encodeEscrowAction } from '../src/escrow.mjs';
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
  console.log(json(decodeEscrowAction(options.data)));
  process.exit(0);
}
if (!['encode', 'simulate'].includes(command)) {
  throw new Error('Usage: escrow-calldata.mjs <encode|simulate|decode> <release|refund|dispute> [options]');
}
const action = options._[1];
const calldata = encodeEscrowAction(action, {
  escrowId: options['escrow-id'],
  milestoneId: options['milestone-id'],
  reasonHash: options['reason-hash'],
  evidenceHash: options['evidence-hash'],
});
const output = { action, calldata, decoded: decodeEscrowAction(calldata) };
if (command === 'simulate') {
  output.simulation = await simulateCall({
    rpcUrl: options['rpc-url'],
    account: getAddress(options.from),
    target: getAddress(options.target),
    calldata,
  });
}
console.log(json(output));
