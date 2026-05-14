#!/usr/bin/env node
/**
 * Publish the SkillMesh flagship bundle skills on-chain.
 *
 * Uploads each skill definition to IPFS via the SkillMesh app, computes
 * the definition hash, then submits publishSkillWithDefinitionHash to the
 * SkillToken contract on Sepolia. Already-published skills (same name) are
 * skipped automatically.
 *
 * Usage:
 *   node plugins/claude-code/skillmesh/tools/publish-skills.mjs
 *   node plugins/claude-code/skillmesh/tools/publish-skills.mjs --bundle research-stack
 *   node plugins/claude-code/skillmesh/tools/publish-skills.mjs --dry-run
 *
 * Required env:
 *   SKILLMESH_PRIVATE_KEY  — signing key for the publishing agent
 *   SKILLMESH_APP_URL      — SkillMesh app URL (default: https://skillmesh.bittrees.org)
 *
 * Optional env:
 *   SKILLMESH_RPC_URL      — Sepolia RPC (default: https://sepolia.drpc.org)
 *   SKILLMESH_SKILL_TOKEN  — SkillToken contract address
 */

import { createPublicClient, createWalletClient, http, keccak256, toHex } from "viem";
import { sepolia } from "viem/chains";
import { getConfig } from "./shared.mjs";

const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i]?.startsWith("--")) argMap[args[i].slice(2)] = args[i + 1] ?? true;
}

const DRY_RUN = argMap["dry-run"] === true || argMap["dry-run"] === "true";
const BUNDLE_FILTER = typeof argMap["bundle"] === "string" ? argMap["bundle"] : null;

const SKILL_TOKEN = process.env.SKILLMESH_SKILL_TOKEN ?? "0xa8a1a43CE1DCDf0C88cA90857287875280575eCD";

const skillTokenAbi = [
  {
    type: "function",
    name: "skillTypes",
    inputs: [{ type: "uint256", name: "id" }],
    outputs: [
      { type: "string", name: "name" },
      { type: "string", name: "description" },
      { type: "string", name: "ipfsCid" },
      { type: "bytes32", name: "definitionHash" },
      { type: "uint8", name: "rarity" },
      { type: "uint256", name: "maxSupply" },
      { type: "uint256", name: "totalMinted" },
      { type: "uint256", name: "computeCost" },
      { type: "bool", name: "chainable" },
      { type: "address", name: "creator" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextSkillId",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "publishSkillWithDefinitionHash",
    inputs: [
      { type: "string", name: "name" },
      { type: "string", name: "description" },
      { type: "string", name: "ipfsCid" },
      { type: "bytes32", name: "definitionHash" },
      { type: "uint8", name: "rarity" },
      { type: "uint256", name: "maxSupply" },
      { type: "uint256", name: "computeCost" },
      { type: "bool", name: "chainable" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "SkillPublished",
    inputs: [
      { type: "uint256", indexed: true, name: "skillId" },
      { type: "address", indexed: true, name: "creator" },
      { type: "string", name: "name" },
    ],
  },
];

// ── Bundle definitions ────────────────────────────────────────────────────────

const bundles = {
  "research-stack": [
    {
      name: "Market Parser",
      description: "Parses market headlines and structured price data from raw text inputs, returning normalized JSON for downstream analysis workflows.",
      toolDescription: "Parse market data and headlines into structured JSON output.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 50,
      chainable: true,
      permissions: ["read:market-data"],
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      outputSchema: { type: "object", properties: { entities: { type: "array" }, sentiment: { type: "string" } } },
    },
    {
      name: "Entity Extractor",
      description: "Extracts named entities (addresses, tokens, protocols, people) from unstructured text and returns typed arrays with confidence scores.",
      toolDescription: "Extract named entities from text: addresses, tokens, protocols, and people.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 50,
      chainable: true,
      permissions: ["read:text"],
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      outputSchema: { type: "object", properties: { entities: { type: "array" }, types: { type: "array" } } },
    },
    {
      name: "Summary Formatter",
      description: "Condenses long-form content into structured summaries at configurable depth levels, optimized for both human readers and downstream agent consumption.",
      toolDescription: "Condense content into structured summaries for humans and agents.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 75,
      chainable: true,
      permissions: ["read:content"],
      inputSchema: { type: "object", properties: { content: { type: "string" }, depth: { type: "string", enum: ["brief", "standard", "detailed"] } }, required: ["content"] },
      outputSchema: { type: "object", properties: { summary: { type: "string" }, keyPoints: { type: "array" } } },
    },
    {
      name: "Alert Router",
      description: "Classifies signals by severity and routes them to configured destinations: webhook, A2A message, or structured log output.",
      toolDescription: "Classify signals by severity and route alerts to configured destinations.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 30,
      chainable: false,
      permissions: ["write:notifications"],
      inputSchema: { type: "object", properties: { signal: { type: "string" }, severity: { type: "string" }, destination: { type: "string" } }, required: ["signal"] },
      outputSchema: { type: "object", properties: { routed: { type: "boolean" }, destination: { type: "string" } } },
    },
  ],
  "content-ops-stack": [
    {
      name: "Content Moderator",
      description: "Classifies inbound content for safety, compliance, and quality signals. Returns a moderation verdict with category labels and confidence scores.",
      toolDescription: "Classify content for safety and compliance, returning verdict with category labels.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 40,
      chainable: true,
      permissions: ["read:content"],
      inputSchema: { type: "object", properties: { content: { type: "string" }, context: { type: "string" } }, required: ["content"] },
      outputSchema: { type: "object", properties: { verdict: { type: "string" }, categories: { type: "array" }, confidence: { type: "number" } } },
    },
    {
      name: "Rewrite Assistant",
      description: "Rewrites content for tone, clarity, and style while preserving factual accuracy. Supports tone targets: professional, casual, technical, and concise.",
      toolDescription: "Rewrite content for tone and clarity while preserving factual accuracy.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 100,
      chainable: true,
      permissions: ["read:content", "write:content"],
      inputSchema: { type: "object", properties: { content: { type: "string" }, tone: { type: "string" } }, required: ["content"] },
      outputSchema: { type: "object", properties: { rewritten: { type: "string" }, changes: { type: "array" } } },
    },
    {
      name: "Metadata Generator",
      description: "Generates structured metadata from content: title, description, tags, category, and SEO signals. Output is schema-compatible with standard content management systems.",
      toolDescription: "Generate structured metadata from content including title, tags, and SEO signals.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 60,
      chainable: true,
      permissions: ["read:content"],
      inputSchema: { type: "object", properties: { content: { type: "string" }, format: { type: "string" } }, required: ["content"] },
      outputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, tags: { type: "array" } } },
    },
    {
      name: "Channel Formatter",
      description: "Transforms structured content payloads into channel-specific formats: Markdown, HTML, plain text, JSON feed, or platform-native schemas.",
      toolDescription: "Transform content into channel-specific formats: Markdown, HTML, JSON, or plain text.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 30,
      chainable: false,
      permissions: ["read:content"],
      inputSchema: { type: "object", properties: { content: { type: "string" }, channel: { type: "string", enum: ["markdown", "html", "plain", "json"] } }, required: ["content", "channel"] },
      outputSchema: { type: "object", properties: { formatted: { type: "string" }, channel: { type: "string" } } },
    },
  ],
  "protocol-monitoring-stack": [
    {
      name: "Event Watcher",
      description: "Monitors on-chain event streams for specified contract addresses and event signatures. Emits structured payloads on each matched event.",
      toolDescription: "Monitor on-chain event streams and emit structured payloads on matched events.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 40,
      chainable: true,
      permissions: ["read:chain-events"],
      inputSchema: { type: "object", properties: { contractAddress: { type: "string" }, eventSignature: { type: "string" }, fromBlock: { type: "number" } }, required: ["contractAddress", "eventSignature"] },
      outputSchema: { type: "object", properties: { events: { type: "array" }, latestBlock: { type: "number" } } },
    },
    {
      name: "Anomaly Classifier",
      description: "Classifies observed chain activity against baseline patterns and flags anomalies by type, severity, and affected protocol components.",
      toolDescription: "Classify chain activity against baselines and flag anomalies by type and severity.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 75,
      chainable: true,
      permissions: ["read:chain-events"],
      inputSchema: { type: "object", properties: { events: { type: "array" }, baseline: { type: "object" } }, required: ["events"] },
      outputSchema: { type: "object", properties: { anomalies: { type: "array" }, severity: { type: "string" } } },
    },
    {
      name: "Incident Summarizer",
      description: "Aggregates anomaly signals into a human-readable incident report with timeline, affected systems, root cause hypothesis, and recommended actions.",
      toolDescription: "Aggregate anomaly signals into a structured incident report with root cause and actions.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 100,
      chainable: true,
      permissions: ["read:chain-events"],
      inputSchema: { type: "object", properties: { anomalies: { type: "array" }, context: { type: "string" } }, required: ["anomalies"] },
      outputSchema: { type: "object", properties: { summary: { type: "string" }, timeline: { type: "array" }, recommendations: { type: "array" } } },
    },
    {
      name: "Notification Dispatcher",
      description: "Dispatches incident reports and alerts to configured operator endpoints via webhook, A2A message, or structured log. Supports deduplication and rate limiting.",
      toolDescription: "Dispatch incident reports and alerts to operator endpoints with deduplication.",
      rarity: 1,
      maxSupply: 10000,
      computeCost: 25,
      chainable: false,
      permissions: ["write:notifications"],
      inputSchema: { type: "object", properties: { message: { type: "string" }, destination: { type: "string" }, severity: { type: "string" } }, required: ["message", "destination"] },
      outputSchema: { type: "object", properties: { dispatched: { type: "boolean" }, id: { type: "string" } } },
    },
  ],
};

// ── Main ──────────────────────────────────────────────────────────────────────

const { account, appUrl, rpcUrl } = getConfig();

const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

console.log(`Publisher : ${account.address}`);
console.log(`App URL   : ${appUrl}`);
console.log(`Dry run   : ${DRY_RUN}`);
if (BUNDLE_FILTER) console.log(`Bundle    : ${BUNDLE_FILTER}`);
console.log();

// Load existing skill names to skip already-published ones
const nextId = await publicClient.readContract({ address: SKILL_TOKEN, abi: skillTokenAbi, functionName: "nextSkillId" });
const existingNames = new Set();
for (let i = 1n; i < nextId; i++) {
  try {
    const skill = await publicClient.readContract({ address: SKILL_TOKEN, abi: skillTokenAbi, functionName: "skillTypes", args: [i] });
    existingNames.add(skill[0].toLowerCase());
  } catch { /* skip */ }
}
console.log(`Existing skills on-chain: ${existingNames.size}`);
if (existingNames.size > 0) console.log(`  ${[...existingNames].join(", ")}`);
console.log();

const bundlesToRun = BUNDLE_FILTER
  ? Object.entries(bundles).filter(([key]) => key === BUNDLE_FILTER)
  : Object.entries(bundles);

let published = 0;
let skipped = 0;

for (const [bundleKey, skills] of bundlesToRun) {
  console.log(`── Bundle: ${bundleKey} ──`);
  for (const skill of skills) {
    if (existingNames.has(skill.name.toLowerCase())) {
      console.log(`  SKIP  ${skill.name} (already on-chain)`);
      skipped++;
      continue;
    }

    console.log(`  PUBLISH ${skill.name}...`);

    // Build the full skill definition payload
    const definition = {
      name: skill.name,
      version: "1.0.0",
      description: skill.description,
      type: "api",
      runtime: { entrypoint: `${skill.name.toLowerCase().replace(/\s+/g, "-")}.handler` },
      toolSpec: {
        description: skill.toolDescription,
        inputSchema: skill.inputSchema,
        outputSchema: skill.outputSchema,
      },
      chainable: skill.chainable,
      computeCost: skill.computeCost,
      timeout: 30000,
      permissions: skill.permissions,
      commercial: {
        licenseType: "MIT",
        usageCategory: "execution",
        qualityTier: "verified",
        versionPolicy: "semver",
      },
    };

    // Upload to IPFS via SkillMesh app
    let ipfsCid = `placeholder/${skill.name.toLowerCase().replace(/\s+/g, "-")}-1.0.0`;
    if (!DRY_RUN) {
      const ipfsRes = await fetch(`${appUrl}/api/ipfs/skill-definition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: definition }),
      });
      if (ipfsRes.ok) {
        const ipfsData = await ipfsRes.json();
        ipfsCid = ipfsData.normalizedCid;
        console.log(`    IPFS CID: ${ipfsCid}`);
      } else {
        const err = await ipfsRes.text();
        console.warn(`    IPFS upload failed (${ipfsRes.status}): ${err} — using placeholder CID`);
      }
    } else {
      console.log(`    [dry-run] would upload to IPFS`);
    }

    // Compute definition hash: keccak256(toHex(JSON.stringify(definition)))
    const definitionHash = keccak256(toHex(JSON.stringify(definition)));
    console.log(`    Hash: ${definitionHash}`);

    if (DRY_RUN) {
      console.log(`    [dry-run] would call publishSkillWithDefinitionHash`);
      published++;
      continue;
    }

    // Submit on-chain
    const hash = await walletClient.writeContract({
      address: SKILL_TOKEN,
      abi: skillTokenAbi,
      functionName: "publishSkillWithDefinitionHash",
      args: [
        skill.name,
        skill.description,
        ipfsCid,
        definitionHash,
        skill.rarity,
        BigInt(skill.maxSupply),
        BigInt(skill.computeCost),
        skill.chainable,
      ],
    });
    console.log(`    TX: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = receipt.logs.filter((l) => l.address.toLowerCase() === SKILL_TOKEN.toLowerCase());
    console.log(`    Confirmed in block ${receipt.blockNumber} (${logs.length} event${logs.length === 1 ? "" : "s"})`);
    published++;
  }
  console.log();
}

console.log(`Done. Published: ${published}  Skipped: ${skipped}`);
if (published > 0 && !DRY_RUN) {
  console.log(`\nView at: ${appUrl}/skills?tab=agents`);
}
