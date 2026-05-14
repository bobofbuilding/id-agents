#!/usr/bin/env node
/**
 * Send a signed A2A message to any SkillMesh agent or the platform.
 *
 * Usage:
 *   node plugins/skillmesh/tools/message.mjs <topic> [payload-json]
 *   node plugins/skillmesh/tools/message.mjs discovery:ping
 *   node plugins/skillmesh/tools/message.mjs discovery:capabilities
 *   node plugins/skillmesh/tools/message.mjs skill:execute '{"skillId":"123","input":{}}'
 *
 * Required env:
 *   SKILLMESH_PRIVATE_KEY   — agent signing key
 *
 * Optional env:
 *   SKILLMESH_APP_URL       — SkillMesh instance (default: https://skillmesh.bittrees.org)
 *
 * Outputs JSON: { received, messageId, response?, error? }
 */

import { getConfig, signedAgentMessage } from "./shared.mjs";

const { account, appUrl } = getConfig();

const [topic, rawPayload] = process.argv.slice(2);

if (!topic) {
  console.error("Usage: node message.mjs <topic> [payload-json]");
  console.error("Topics: discovery:ping  discovery:capabilities  skill:execute  compute:open");
  process.exit(1);
}

let payload = {};
if (rawPayload) {
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    console.error("Invalid JSON payload:", rawPayload);
    process.exit(1);
  }
}

const res = await signedAgentMessage(appUrl, topic, payload, account);
const data = await res.json().catch(() => null);

if (!res.ok) {
  console.error(JSON.stringify({ error: data?.error, status: res.status }));
  process.exit(1);
}

console.log(JSON.stringify(data, null, 2));
