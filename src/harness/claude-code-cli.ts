// SPDX-License-Identifier: MIT
/**
 * Claude Code CLI Harness
 *
 * Wraps the Claude Code CLI (`claude`) for local agents that use the user's
 * logged-in Claude Code session instead of API keys.
 *
 * This harness spawns `claude -p --output-format json` and sends each request
 * over stdin.
 * Unlike the SDK-based ClaudeCodeHarness, this uses whatever authentication
 * method the user has configured in their local Claude Code installation.
 *
 * Session support:
 * - Uses --resume <session_id> to continue existing sessions
 * - Each agent maintains its own session for context continuity
 */

import { ChildProcess } from 'child_process';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';
import { resolveModelAlias } from '../core/model-aliases.js';
import { toMcpServerRecord } from './mcp.js';
import { reportTurnUsage } from './usage-report.js';
import { detectClaudeCliRateLimit } from './rate-limit.js';
import { resolveExecutable } from '../lib/executable-resolution.js';
import { portableSpawn } from '../lib/portable-spawn.js';
import {
  signalOwnedProcessTree,
  verifiedOwnedProcess,
} from '../lib/process-tree.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Fire-and-forget report of one activity step (a tool call / file edit) to the
 * manager's /activity/record, so the control center can stream "what the agent
 * is working on" into chat. Wrapped so it can NEVER throw into or delay the
 * agent's reply path — on any failure it silently no-ops (same policy as the
 * ollama usage reporter).
 */
function reportActivity(kind: string, tool: string | undefined, summary: string, queryId?: string): void {
  try {
    if (!summary) return;
    const managerUrl = (process.env.MANAGER_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '');
    const payload = {
      agent: process.env.ID_AGENT_NAME || process.env.ID_AGENT_ALIAS || 'agent',
      team: process.env.ID_AGENT_TEAM || process.env.ID_TEAM || 'default',
      kind,
      tool,
      summary: summary.slice(0, 240),
      // The originating dispatch's query id (when known), so the control center
      // can attribute steps to the exact query even when two dispatches hit the
      // same agent concurrently. Omitted when unknown — older managers ignore it.
      queryId: queryId || undefined,
    };
    void fetch(`${managerUrl}/activity/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    }).catch(() => { /* best-effort; ignore */ });
  } catch { /* never throw */ }
}

/** Turn a Claude tool_use block into a short, human-readable activity line. */
function summarizeTool(name: string, input: any): { kind: string; summary: string } {
  const s = (k: string): string => (input && typeof input[k] === 'string' ? input[k] : '');
  const tail = (fp: string): string => { const t = fp.split('/').filter(Boolean); return t.length > 2 ? '…/' + t.slice(-2).join('/') : fp; };
  switch (name) {
    case 'Write': return { kind: 'file', summary: `created ${tail(s('file_path'))}` };
    case 'Edit': case 'MultiEdit': return { kind: 'file', summary: `edited ${tail(s('file_path'))}` };
    case 'NotebookEdit': return { kind: 'file', summary: `edited ${tail(s('notebook_path'))}` };
    case 'Read': return { kind: 'read', summary: `read ${tail(s('file_path'))}` };
    case 'Bash': return { kind: 'run', summary: `ran: ${s('command').slice(0, 90)}` };
    case 'Grep': return { kind: 'search', summary: `searched "${s('pattern').slice(0, 50)}"` };
    case 'Glob': return { kind: 'search', summary: `listed ${s('pattern')}` };
    case 'Task': return { kind: 'delegate', summary: `delegated: ${(s('description') || s('prompt') || 'a subtask').slice(0, 80)}` };
    case 'WebFetch': return { kind: 'web', summary: `fetched ${s('url').slice(0, 80)}` };
    case 'WebSearch': return { kind: 'web', summary: `web search: ${s('query').slice(0, 60)}` };
    case 'TodoWrite': return { kind: 'plan', summary: 'updated its task list' };
    default: return { kind: 'tool', summary: name };
  }
}

export function claudeCliToolArgs(options: Pick<HarnessOptions, 'allowedTools' | 'executionPolicy'>): string[] {
  const tools = (options.allowedTools || [])
    .map((tool) => String(tool || '').trim())
    .filter(Boolean);
  if (tools.length === 0) return [];

  const toolList = tools.join(',');
  if (options.executionPolicy === 'control-plane-readonly') {
    // Claude CLI's --allowedTools means "auto-approve", not "only expose".
    // Use --tools for control-plane prompts so Bash/Edit/Write are unavailable.
    return ['--tools', toolList, '--allowedTools', toolList];
  }
  return ['--allowedTools', toolList];
}

export interface ClaudeCliStdinInvocation {
  command: string;
  args: string[];
  stdin: string;
}

/**
 * Translate IDACC's per-agent output-speed preference into Claude Code's
 * documented launch-settings contract. Supplying an explicit false value for
 * "default" prevents a user's persistent global fast-mode preference from
 * silently changing the cost or model used by a Manager-launched agent.
 */
export function claudeCliSpeedSettingsArgs(speed: string | undefined): string[] {
  if (speed !== 'default' && speed !== 'fast') return [];
  return ['--settings', JSON.stringify({ fastMode: speed === 'fast' })];
}

/**
 * Keep the complete prompt off argv and shared temp storage. Claude's print
 * mode reads text input from stdin when `-p` has no positional prompt value.
 */
export function claudeCliStdinInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ClaudeCliStdinInvocation {
  const promptIndex = args.indexOf('-p');
  const prompt = promptIndex >= 0 ? String(args[promptIndex + 1] ?? '') : '';
  const spawnArgs = promptIndex >= 0
    ? args.filter((_, index) => index !== promptIndex + 1)
    : [...args];
  const configuredCommand = env.CLAUDE_PATH || 'claude';
  const command = resolveExecutable(configuredCommand, { env, platform }) || configuredCommand;
  return {
    command,
    args: spawnArgs,
    stdin: prompt,
  };
}

export class ClaudeCodeCliHarness implements AgentHarness {
  readonly type: HarnessType = 'claude-code-cli' as HarnessType;

  // Track the current running process for cancellation
  private currentProcess: ChildProcess | null = null;
  private cancelled = false;
  // The query id of the run currently in flight, so streamed activity steps can
  // be attributed to the originating dispatch. Runs are serial per harness
  // instance (one currentProcess at a time), so a single field is race-free.
  private currentQueryId?: string;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();
    this.currentQueryId = options.queryId;

    console.log(`[Claude CLI] Starting harness`);
    console.log(`[Claude CLI] Working directory: ${workingDir}`);
    if (options.model) console.log(`[Claude CLI] Model: ${options.model} (will use alias if available)`);
    if (options.resume) console.log(`[Claude CLI] Resuming session: ${options.resume}`);

    // Build arguments for claude CLI
    // Use stream-json for real-time visibility into what the agent is doing
    const verbose = process.env.ID_AGENT_VERBOSE === 'true';
    // Default to --dangerously-skip-permissions because background agents have
    // no interactive shell to approve prompts. The agent's
    // `dangerouslySkipPermissions: false` config can opt out; the spawn site
    // sets ID_AGENT_SKIP_PERMISSIONS=false in that case.
    const skipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    const args: string[] = [
      '-p', prompt,
      ...(process.env.ID_AGENT_CLAUDE_BARE === '1' ? ['--bare'] : []),
      ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
      '--output-format', verbose ? 'stream-json' : 'json',
      ...(verbose ? ['--verbose'] : [])
    ];
    console.log(`[Claude CLI] Permission mode: ${skipPermissions ? '--dangerously-skip-permissions (default)' : 'interactive (config opt-out)'}`);

    // Apply the agent's configured model. Operator-friendly aliases (e.g.
    // `fable`, `sonnet`) are resolved to the canonical Claude model id the CLI
    // expects. CLAUDE_CLI_MODEL remains a global override; when neither is set
    // Claude Code falls back to its own default (the logged-in subscription
    // default), which keeps Max users off API-metered billing.
    // Note: premium models (e.g. claude-fable-5) may bill API credits rather
    // than the subscription depending on the account's plan.
    const cliModel = process.env.CLAUDE_CLI_MODEL
      || (options.model ? resolveModelAlias(options.model) : undefined);
    if (cliModel) {
      args.push('--model', cliModel);
    }

    // Reasoning effort (set per-agent in the Control Center) — fewer reasoning tokens at
    // lower effort. Claude Code accepts low|medium|high|xhigh (map minimal→low).
    const effortRaw = process.env.ID_AGENT_EFFORT;
    if (effortRaw && /^(minimal|low|medium|high|xhigh)$/.test(effortRaw)) {
      args.push('--effort', effortRaw === 'minimal' ? 'low' : effortRaw);
      console.log(`[Claude CLI] Reasoning effort: ${effortRaw}`);
    }

    // Output speed (set per-agent in the Control Center). Claude Code documents
    // fastMode as a settings key and accepts additional settings JSON through
    // --settings, including in non-interactive print mode. Keep the preference
    // process-local instead of mutating the user's persistent settings file.
    const speedRaw = process.env.ID_AGENT_SPEED;
    const speedArgs = claudeCliSpeedSettingsArgs(speedRaw);
    if (speedArgs.length > 0) {
      args.push(...speedArgs);
      console.log(speedRaw === 'fast'
        ? '[Claude CLI] Output speed: fast (eligible Opus model; higher per-token cost is billed from usage credits)'
        : '[Claude CLI] Output speed: standard');
    }

    // Add session resume if provided
    if (options.resume) {
      args.push('--resume', options.resume);
    }

    // Add allowed tools if specified
    args.push(...claudeCliToolArgs(options));

    // Add MCP servers if specified. The claude CLI consumes them from a
    // .mcp.json-style file via --mcp-config; --strict-mcp-config makes it use
    // ONLY this file (ignoring any project/user .mcp.json). Written to a temp
    // file and removed in the finally below.
    let mcpConfigFile: string | undefined;
    if (options.mcpServers && options.mcpServers.length > 0) {
      const mcpServers = toMcpServerRecord(options.mcpServers);
      if (Object.keys(mcpServers).length > 0) {
        mcpConfigFile = path.join(os.tmpdir(), `claude-mcp-${process.pid}-${Date.now()}.json`);
        // MCP env/headers can carry tokens; write owner-only and fail closed on
        // a pre-existing name ('wx') to avoid clobber/symlink races in shared /tmp.
        const fd = fs.openSync(mcpConfigFile, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ mcpServers }));
        } finally {
          fs.closeSync(fd);
        }
        args.push('--mcp-config', mcpConfigFile, '--strict-mcp-config');
        console.log(`[Claude CLI] MCP: ${Object.keys(mcpServers).join(', ')} via ${mcpConfigFile}`);
      }
    }

    // Build environment - inherit user's env for auth
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      // Override working directory for Claude
      PWD: workingDir
    };

    // Add any additional env vars from options
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
    }

    try {
      // Reset cancelled flag at start of new run
      this.cancelled = false;

      const result = await this.spawnClaude(args, workingDir, env);

      // Check if cancelled during execution
      if (this.cancelled) {
        yield {
          type: 'error',
          content: 'Query was cancelled'
        };
        return;
      }

      // Parse output - handle both json and stream-json formats
      if (result.stdout.trim()) {
        try {
          let jsonResult: any;

          if (verbose) {
            // stream-json: multiple JSON objects, one per line - take the LAST
            // result line (a run can legitimately emit more than one).
            const lines = result.stdout.trim().split('\n');
            for (const line of lines) {
              try {
                const msg = JSON.parse(line);
                if (msg.type === 'result') {
                  jsonResult = msg;
                }
              } catch {
                // Skip non-JSON lines
              }
            }
          } else {
            // json: single JSON object
            jsonResult = JSON.parse(result.stdout.trim());
          }

          if (jsonResult) {
            // Per-turn token usage → manager (attributed to this query's task). Claude Code's
            // result message carries usage.{input_tokens, output_tokens, cache_*}; sum cache into
            // input so the displayed "input" reflects everything billed.
            try {
              const u = jsonResult.usage || {};
              // Count only NEW input. Claude's input_tokens is already the non-cached new input;
              // cache_read/cache_creation are the (cheap, often huge) cached context — including
              // them made the per-task figure balloon to millions that aren't real spend.
              const input = Number(u.input_tokens) || 0;
              const output = Number(u.output_tokens) || 0;
              reportTurnUsage({
                runtime: 'claude-code-cli',
                model: options.model || process.env.CLAUDE_CLI_MODEL || 'claude',
                input: input || null,
                output: output || null,
                genMs: Number(jsonResult.duration_ms) || 0,
                queryId: this.currentQueryId,
              });
            } catch { /* never block the reply */ }
            // Yield the result
            yield {
              type: 'result',
              subtype: jsonResult.is_error ? 'error' : 'success',
              content: jsonResult.result || '',
              result: jsonResult.result || '',
              session_id: jsonResult.session_id,
              duration_ms: jsonResult.duration_ms,
              cost_usd: jsonResult.total_cost_usd
            };
          } else {
            // Verbose stream-json with no parseable {type:'result'} line: salvage
            // the raw stdout as the reply, exactly as the non-verbose path does on
            // a JSON parse failure. Without this, a result-line-less but exit-0 run
            // would yield nothing → a spurious "produced an empty result" failure.
            yield {
              type: 'result',
              subtype: 'success',
              content: result.stdout.trim(),
              result: result.stdout.trim()
            };
          }
        } catch (parseErr) {
          // If not valid JSON, treat as plain text result
          yield {
            type: 'result',
            subtype: 'success',
            content: result.stdout.trim(),
            result: result.stdout.trim()
          };
        }
      }

      // Check for errors
      if (result.exitCode !== 0) {
        const rateLimit = detectClaudeCliRateLimit(result);
        const errorMsg = result.stderr || `Claude CLI exited with code ${result.exitCode}`;
        console.error(`[Claude CLI] Error: ${errorMsg}`);
        yield {
          type: 'error',
          content: rateLimit?.message || errorMsg,
          ...(rateLimit ? { rateLimit } : {})
        };
      }
    } catch (err: any) {
      console.error(`[Claude CLI] Exception: ${err.message}`);
      yield {
        type: 'error',
        content: err.message
      };
    } finally {
      if (mcpConfigFile) {
        try { fs.rmSync(mcpConfigFile, { force: true }); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Log a streaming message from Claude CLI in a readable format
   */
  private logStreamMessage(msg: any): void {
    const timestamp = new Date().toLocaleTimeString();

    switch (msg.type) {
      case 'assistant':
        // Assistant is thinking/responding
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              console.log(`[${timestamp}] 💭 Assistant: ${block.text.slice(0, 200)}${block.text.length > 200 ? '...' : ''}`);
            } else if (block.type === 'tool_use') {
              console.log(`[${timestamp}] 🔧 Tool: ${block.name}`);
              if (block.input) {
                const inputStr = JSON.stringify(block.input).slice(0, 150);
                console.log(`[${timestamp}]    Input: ${inputStr}${inputStr.length >= 150 ? '...' : ''}`);
              }
              // Stream a human-readable step to the control center.
              const { kind, summary } = summarizeTool(block.name, block.input);
              reportActivity(kind, block.name, summary, this.currentQueryId);
            }
          }
        }
        break;

      case 'user':
        // Tool results
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result') {
              const status = block.is_error ? '❌' : '✅';
              console.log(`[${timestamp}] ${status} Tool result for ${block.tool_use_id?.slice(0, 20)}...`);
              if (block.is_error) reportActivity('error', undefined, 'a tool call failed', this.currentQueryId);
            }
          }
        }
        break;

      case 'result':
        // Final result
        console.log(`[${timestamp}] 🏁 Completed (${msg.subtype})`);
        if (msg.duration_ms) {
          console.log(`[${timestamp}]    Duration: ${(msg.duration_ms / 1000).toFixed(1)}s`);
        }
        if (msg.total_cost_usd) {
          console.log(`[${timestamp}]    Cost: $${msg.total_cost_usd.toFixed(4)}`);
        }
        break;

      case 'system':
        // System messages
        if (msg.message) {
          console.log(`[${timestamp}] ℹ️  System: ${msg.message}`);
        }
        break;
    }
  }

  /**
   * Spawn the claude CLI and capture output
   */
  private spawnClaude(
    args: string[],
    cwd: string,
    env: Record<string, string>
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const invocation = claudeCliStdinInvocation(args, env);
      console.log(`[Claude CLI] Spawning directly: ${invocation.command} ${invocation.args.slice(0, 3).join(' ')}...`);
      console.log(`[Claude CLI] Working directory: ${cwd}`);
      console.log(`[Claude CLI] PATH: ${env.PATH?.slice(0, 100)}...`);
      console.log(`[Claude CLI] Prompt transport: stdin (${invocation.stdin.length} chars)`);

      const proc = portableSpawn(invocation.command, invocation.args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Store process reference for cancellation
      this.currentProcess = proc;

      // Deliver the complete prompt without exposing it through argv or a
      // predictable file in the host's shared temp directory.
      proc.stdin?.end(invocation.stdin);

      console.log(`[Claude CLI] Process spawned, PID: ${proc.pid}`);

      const verbose = process.env.ID_AGENT_VERBOSE === 'true';

      let lineBuf = ''; // accumulate across chunks so a JSON line split by a chunk boundary isn't lost
      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        // In verbose mode, parse and log streaming JSON messages (one per line).
        if (verbose) {
          lineBuf += chunk;
          const parts = lineBuf.split('\n');
          lineBuf = parts.pop() || ''; // keep the trailing partial line for the next chunk
          for (const line of parts) {
            if (!line.trim()) continue;
            try {
              this.logStreamMessage(JSON.parse(line));
            } catch {
              // Not valid JSON (partial/noise) - ignore
            }
          }
        } else {
          // Log progress for long-running processes
          if (stdout.length % 1000 < chunk.length) {
            console.log(`[Claude CLI] Received ${stdout.length} bytes of stdout...`);
          }
        }
      });

      proc.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        // Log stderr in real-time for debugging
        if (chunk.trim()) {
          console.log(`[Claude CLI] stderr: ${chunk.trim()}`);
        }
      });

      proc.on('error', (err) => {
        console.error(`[Claude CLI] Spawn error: ${err.message}`);
        reject(err);
      });

      proc.on('close', (code) => {
        // Clear process reference
        if (this.currentProcess === proc) this.currentProcess = null;

        // Flush any trailing partial line (no terminal newline) so the last
        // streamed step (often the final tool call) isn't missed.
        if (verbose && lineBuf.trim()) {
          try { this.logStreamMessage(JSON.parse(lineBuf)); } catch { /* not JSON */ }
          lineBuf = '';
        }

        console.log(`[Claude CLI] Process exited with code ${code}`);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1
        });
      });
    });
  }

  /**
   * Cancel the currently running query.
   * Kills the underlying process if one is running.
   * @returns true if a process was cancelled, false if nothing was running
   */
  cancel(): boolean {
    if (this.currentProcess && !this.currentProcess.killed) {
      const pid = this.currentProcess.pid;
      console.log(`[Claude CLI] Cancelling process PID: ${pid}`);
      this.cancelled = true;

      // Kill the whole detached process group so any Claude child processes
      // are also stopped after a manager-side cancel.
      terminateChildProcessTree(this.currentProcess, 'SIGTERM');

      // Force kill after 2 seconds if still running
      const proc = this.currentProcess;
      setTimeout(() => {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          console.log(`[Claude CLI] Force killing process PID: ${pid}`);
          terminateChildProcessTree(proc, 'SIGKILL');
        }
      }, 2000).unref?.();

      return true;
    }
    return false;
  }
}

export function terminateChildProcessTree(proc: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = proc.pid;
  if (!pid) return false;

  if (process.platform === 'win32') {
    const target = verifiedOwnedProcess(
      pid,
      proc.pid === pid && proc.exitCode == null && proc.signalCode == null,
    );
    if (!target) return false;
    return signalOwnedProcessTree(target, signal, {
      onError: (message, error) => {
        console.warn(`[Claude CLI] ${message}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
  }

  let signalled = false;

  try {
    // The CLI is spawned as a detached process group leader. Signalling the
    // negative pid reaches the shell wrapper and its Claude child process.
    process.kill(-pid, signal);
    signalled = true;
  } catch (err: any) {
    if (err?.code !== 'ESRCH') {
      console.warn(`[Claude CLI] Failed to signal process group ${pid}: ${err?.message || err}`);
    }
  }

  try {
    proc.kill(signal);
    signalled = true;
  } catch (err: any) {
    if (err?.code !== 'ESRCH') {
      console.warn(`[Claude CLI] Failed to signal process ${pid}: ${err?.message || err}`);
    }
  }

  return signalled;
}
