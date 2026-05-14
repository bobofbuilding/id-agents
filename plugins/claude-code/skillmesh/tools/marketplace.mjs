#!/usr/bin/env node
/**
 * Query and interact with the SkillMesh marketplace.
 *
 * Usage:
 *   node plugins/skillmesh/tools/marketplace.mjs agents              — list registered agents
 *   node plugins/skillmesh/tools/marketplace.mjs llm-agents          — list BYOK-enabled agents
 *   node plugins/skillmesh/tools/marketplace.mjs skills              — list available skills (inventory)
 *   node plugins/skillmesh/tools/marketplace.mjs providers           — list active providers
 *   node plugins/skillmesh/tools/marketplace.mjs ping                — send discovery:ping to platform
 *   node plugins/skillmesh/tools/marketplace.mjs capabilities        — query platform capabilities
 *   node plugins/skillmesh/tools/marketplace.mjs whoami              — show this agent's on-chain profile
 *
 * Required env:
 *   SKILLMESH_PRIVATE_KEY   — agent signing key
 *
 * Optional env:
 *   SKILLMESH_APP_URL       — SkillMesh instance (default: https://skillmesh.bittrees.org)
 */

import { getConfig, signedAgentMessage } from "./shared.mjs";

const { account, appUrl } = getConfig();

const [command = "agents"] = process.argv.slice(2);

async function getJson(path) {
  const res = await fetch(`${appUrl}${path}`);
  return res.json();
}

switch (command) {
  case "agents": {
    const data = await getJson("/api/agents");
    const agents = data.agents ?? data;
    console.log(JSON.stringify(agents.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      owner: a.owner,
      provider: a.llmConfig?.provider,
      byok: a.llmConfig?.byok,
    })), null, 2));
    break;
  }

  case "llm-agents": {
    const data = await getJson("/api/llm/agents");
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case "skills": {
    const data = await getJson(`/api/inventory?owner=${account.address}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case "providers": {
    const data = await getJson("/api/providers");
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case "ping": {
    const res = await signedAgentMessage(appUrl, "discovery:ping", {}, account);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case "capabilities": {
    const res = await signedAgentMessage(appUrl, "discovery:capabilities", {}, account);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case "whoami": {
    const data = await getJson("/api/agents");
    const agents = data.agents ?? data;
    const me = agents.find(
      (a) => a.owner?.toLowerCase() === account.address.toLowerCase()
    );
    if (me) {
      console.log(JSON.stringify(me, null, 2));
    } else {
      console.log(JSON.stringify({
        address: account.address,
        registered: false,
        message: "Not registered. Run: node plugins/skillmesh/tools/register.mjs",
      }, null, 2));
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Commands: agents  llm-agents  skills  providers  ping  capabilities  whoami");
    process.exit(1);
}
