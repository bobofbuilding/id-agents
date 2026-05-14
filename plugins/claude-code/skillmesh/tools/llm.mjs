#!/usr/bin/env node
/**
 * Call the SkillMesh BYOK LLM gateway.
 *
 * Usage:
 *   node plugins/skillmesh/tools/llm.mjs "Your prompt here"
 *   node plugins/skillmesh/tools/llm.mjs "Your prompt" --model claude-sonnet-4-6
 *   echo '{"messages":[{"role":"user","content":"hello"}]}' | node plugins/skillmesh/tools/llm.mjs
 *
 * Required env:
 *   SKILLMESH_PRIVATE_KEY   — agent signing key
 *
 * Optional env:
 *   SKILLMESH_APP_URL       — SkillMesh instance (default: https://skillmesh.bittrees.org)
 *
 * Outputs JSON: { content, model, usage }
 */

import { getConfig, signedPost } from "./shared.mjs";

const { account, appUrl } = getConfig();

const args = process.argv.slice(2);
const argMap = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i]?.startsWith("--")) {
    argMap[args[i].slice(2)] = args[i + 1];
    i++;
  } else {
    positional.push(args[i]);
  }
}

let body;
if (!process.stdin.isTTY) {
  const stdin = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
  body = JSON.parse(stdin);
} else if (positional.length > 0) {
  body = { messages: [{ role: "user", content: positional.join(" ") }] };
} else {
  console.error("Usage: node llm.mjs <prompt>  OR  echo <json> | node llm.mjs");
  process.exit(1);
}

if (argMap.model) body.model = argMap.model;
if (argMap.system) body.systemPrompt = argMap.system;

const res = await signedPost(appUrl, "/api/llm", body, account);
const data = await res.json();

if (!res.ok) {
  console.error(JSON.stringify({ error: data.error, status: res.status }));
  process.exit(1);
}

console.log(JSON.stringify({
  content: data.output?.content,
  model: data.telemetry?.model,
  usage: data.telemetry?.tokenUsage,
}));
