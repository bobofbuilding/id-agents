#!/usr/bin/env node
/**
 * Shared SkillMesh auth utilities — used by all plugin tools.
 * Replicates @skillmesh/sdk signing without requiring the monorepo.
 */

import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function getConfig() {
  const privateKey = process.env.SKILLMESH_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("SKILLMESH_PRIVATE_KEY is not set. Add it to your .env file.");
  }
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    appUrl: process.env.SKILLMESH_APP_URL ?? "https://skillmesh.bittrees.org",
    rpcUrl: process.env.SKILLMESH_RPC_URL ?? "https://sepolia.drpc.org",
    agentRegistry: process.env.SKILLMESH_AGENT_REGISTRY ?? "0x4d24B60F02A745C7109c2C9aD67B3b324Df9Fd2d",
  };
}

export function createRequestHash(payload, agent, timestamp, nonce) {
  const canonical = JSON.stringify({
    payload,
    agent: agent.toLowerCase(),
    timestamp,
    nonce,
  });
  return keccak256(toHex(canonical));
}

export function generateNonce() {
  return crypto.randomUUID();
}

export function createAuthHeaders(agent, timestamp, nonce, signature) {
  return {
    "X-SkillMesh-Agent": agent,
    "X-SkillMesh-Timestamp": String(timestamp),
    "X-SkillMesh-Nonce": nonce,
    "X-SkillMesh-Signature": signature,
  };
}

/**
 * Sign a payload and POST it to a SkillMesh API endpoint.
 */
export async function signedPost(appUrl, path, body, account) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateNonce();
  const requestHash = createRequestHash(body, account.address, timestamp, nonce);
  const signature = await account.signMessage({ message: { raw: requestHash } });
  const authHeaders = createAuthHeaders(account.address, timestamp, nonce, signature);

  return fetch(`${appUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
}

/**
 * Sign and send a fully-formed A2A message to /api/agent-messages.
 */
export async function signedAgentMessage(appUrl, topic, payload, account, type = "request") {
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateNonce();

  const messagePayload = {
    id: messageId,
    type,
    from: account.address,
    to: account.address,
    topic,
    payload,
    createdAt: timestamp * 1000,
    ttl: 300,
  };

  const requestHash = createRequestHash(messagePayload, account.address, timestamp, nonce);
  const signature = await account.signMessage({ message: { raw: requestHash } });
  const authHeaders = createAuthHeaders(account.address, timestamp, nonce, signature);

  return fetch(`${appUrl}/api/agent-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ ...messagePayload, nonce, signature }),
  });
}
