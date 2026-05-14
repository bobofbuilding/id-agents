#!/usr/bin/env node
/**
 * Register this agent on SkillMesh's AgentRegistry (Sepolia).
 *
 * Usage:
 *   node plugins/skillmesh/tools/register.mjs
 *   node plugins/skillmesh/tools/register.mjs --name "My Agent" --provider anthropic --model claude-haiku-4-5-20251001
 *
 * Required env:
 *   SKILLMESH_PRIVATE_KEY     — agent signing key (0x...)
 *
 * Optional env:
 *   SKILLMESH_RPC_URL         — Sepolia RPC (default: https://sepolia.drpc.org)
 *   SKILLMESH_AGENT_REGISTRY  — AgentRegistry address
 *   SKILLMESH_AGENT_NAME      — display name
 *   SKILLMESH_LLM_PROVIDER    — openai | anthropic (default: anthropic)
 *   SKILLMESH_LLM_MODEL       — model name (default: claude-haiku-4-5-20251001)
 *   SKILLMESH_COMPUTE_BUDGET  — AST budget ceiling (default: 5000)
 *   SKILLMESH_INTEROP_ENDPOINT — public HTTP endpoint for A2A messages
 */

import { createPublicClient, createWalletClient, http } from "viem";
import { sepolia } from "viem/chains";
import { getConfig } from "./shared.mjs";

const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i += 2) {
  if (args[i]?.startsWith("--")) argMap[args[i].slice(2)] = args[i + 1];
}

const { account, rpcUrl, agentRegistry } = getConfig();

const name = argMap.name ?? process.env.SKILLMESH_AGENT_NAME ?? "SkillMesh Agent";
const provider = argMap.provider ?? process.env.SKILLMESH_LLM_PROVIDER ?? "anthropic";
const model = argMap.model ?? process.env.SKILLMESH_LLM_MODEL ?? "claude-haiku-4-5-20251001";
const computeBudget = BigInt(process.env.SKILLMESH_COMPUTE_BUDGET ?? "5000");
const interopEndpoint = process.env.SKILLMESH_INTEROP_ENDPOINT ?? "";

const registryAbi = [
  {
    type: "function",
    name: "agentIdByOwner",
    inputs: [{ type: "address", name: "owner" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "registerAgent",
    inputs: [{ type: "string", name: "name" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setLLMConfig",
    inputs: [
      { type: "string", name: "provider" },
      { type: "string", name: "model" },
      { type: "bool", name: "byok" },
      { type: "uint256", name: "computeBudget" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setAgentInterop",
    inputs: [
      { type: "string", name: "protocol" },
      { type: "string", name: "endpoint" },
      { type: "string", name: "manifestUri" },
      { type: "string", name: "authScheme" },
      { type: "string", name: "signingKey" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

console.log(`Agent address : ${account.address}`);
console.log(`Registry      : ${agentRegistry}`);
console.log(`Name          : ${name}`);
console.log(`Provider      : ${provider} / ${model}`);

// Check if already registered
const existingId = await publicClient.readContract({
  address: agentRegistry,
  abi: registryAbi,
  functionName: "agentIdByOwner",
  args: [account.address],
});

if (existingId > 0n) {
  console.log(`\nAlready registered — agentId: ${existingId}`);
  console.log("Updating LLM config...");
} else {
  console.log("\nRegistering agent on-chain...");
  const regHash = await walletClient.writeContract({
    address: agentRegistry,
    abi: registryAbi,
    functionName: "registerAgent",
    args: [name],
  });
  await publicClient.waitForTransactionReceipt({ hash: regHash });
  const newId = await publicClient.readContract({
    address: agentRegistry,
    abi: registryAbi,
    functionName: "agentIdByOwner",
    args: [account.address],
  });
  console.log(`Registered — agentId: ${newId}  tx: ${regHash}`);
}

// Set LLM config (byok=true so the SKILLMESH_APP_URL gateway provides the API key)
const llmHash = await walletClient.writeContract({
  address: agentRegistry,
  abi: registryAbi,
  functionName: "setLLMConfig",
  args: [provider, model, true, computeBudget],
});
await publicClient.waitForTransactionReceipt({ hash: llmHash });
console.log(`LLM config set  tx: ${llmHash}`);

// Set interop metadata if endpoint is provided
if (interopEndpoint) {
  const interopHash = await walletClient.writeContract({
    address: agentRegistry,
    abi: registryAbi,
    functionName: "setAgentInterop",
    args: ["http", interopEndpoint, "", "SkillMesh", account.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: interopHash });
  console.log(`Interop set     tx: ${interopHash}`);
}

console.log(`\nDone. Agent ${account.address} is registered on SkillMesh.`);
console.log(`View at: ${process.env.SKILLMESH_APP_URL ?? "https://skillmesh.bittrees.org"}/agents`);
