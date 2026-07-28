// SPDX-License-Identifier: MIT
/**
 * Fire-and-forget per-turn token-usage reporter, shared by the subscription
 * harnesses (Claude Code CLI, Codex) and the local Ollama harness. Posts to the
 * manager's /usage/record with the agent identity (from env) and the originating
 * query_id, so the manager can attribute each turn's tokens to the task that query
 * was working. Wrapped so it can NEVER throw into or delay the agent's reply path —
 * on any failure it silently no-ops.
 */
import { managerWorkerRequestHeaders } from '../manager-worker-auth.js';

export function reportTurnUsage(u: {
  runtime: string;
  model: string;
  input: number | null;
  output: number | null;
  genMs: number;
  queryId?: string | null;
}): void {
  try {
    const input = typeof u.input === 'number' && u.input >= 0 ? u.input : null;
    const output = typeof u.output === 'number' && u.output >= 0 ? u.output : null;
    if (input == null && output == null) return; // nothing measured
    const managerUrl = (process.env.MANAGER_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '');
    const tps = output && u.genMs > 0 ? +(output / (u.genMs / 1000)).toFixed(2) : null;
    const payload = {
      runtime: u.runtime,
      model: u.model || u.runtime,
      agent: process.env.ID_AGENT_NAME || process.env.ID_AGENT_ALIAS || 'local',
      team: process.env.ID_AGENT_TEAM || process.env.ID_TEAM || 'default',
      input,
      output,
      genMs: u.genMs,
      tps,
      query_id: u.queryId || undefined,
    };
    void fetch(`${managerUrl}/usage/record`, {
      method: 'POST',
      headers: managerWorkerRequestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    }).catch(() => { /* best-effort; ignore */ });
  } catch { /* never throw */ }
}
