// SPDX-License-Identifier: MIT
/**
 * Codex CLI Harness
 *
 * Wraps the OpenAI Codex CLI (`codex exec`) for agents.
 * Supports both API key auth (OPENAI_API_KEY) and OAuth login (codex login).
 *
 * Spawns `codex exec "<prompt>" --json --cd <dir>` for each request.
 * Parses JSONL output and yields HarnessMessage objects.
 *
 * Session support:
 * - Runs each request as a fresh `codex exec` invocation
 * - Ignores resume IDs because the installed Codex CLI does not support
 *   combining `resume` with the non-interactive flags used here
 */

import { spawn, ChildProcess } from 'child_process';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType, McpServerSpec } from './types.js';
import { reportTurnUsage } from './usage-report.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** TOML-encode a string scalar. */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/** Bare TOML key (no quoting needed). */
function bareKey(k: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(k);
}

/**
 * Render attached MCP servers (Modules view → metadata.mcpServers, delivered via
 * ID_MCP_SERVERS) as a TOML `[mcp_servers.*]` block for codex's config.toml.
 *
 * SECURITY: this is written to a 0600 config FILE (see prepareCodexHome), never
 * passed as `-c …env={…}` on the command line. A codex agent's argv is visible to
 * any local `ps`, so putting a server's secret env (e.g. GITHUB_PERSONAL_ACCESS_TOKEN)
 * there leaked the operator's tokens system-wide. Config-file delivery is verified
 * on codex 0.130 (the spawned stdio server receives its env from the file).
 */
function renderMcpServersToml(servers: McpServerSpec[] | undefined): string {
  if (!servers?.length) return '';
  const blocks: string[] = [];
  for (const s of servers) {
    if (!s?.name) continue;
    const key = bareKey(s.name) ? s.name : tomlStr(s.name);
    const lines: string[] = [`[mcp_servers.${key}]`];
    if (s.command) {
      lines.push(`command = ${tomlStr(s.command)}`);
      if (s.args?.length) lines.push(`args = [${s.args.map(tomlStr).join(', ')}]`);
      if (s.env && Object.keys(s.env).length) {
        lines.push(`[mcp_servers.${key}.env]`);
        for (const [k, v] of Object.entries(s.env)) {
          lines.push(`${bareKey(k) ? k : tomlStr(k)} = ${tomlStr(String(v))}`);
        }
      }
    } else if (s.url) {
      lines.push(`url = ${tomlStr(s.url)}`); // remote (http/sse) MCP server
    } else {
      continue;
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Build a per-agent CODEX_HOME so attached MCP servers can be configured via a
 * PRIVATE config.toml (0600) instead of the command line. Auth and sessions are
 * SHARED with the operator's real ~/.codex via symlinks, so ChatGPT OAuth login
 * and `codex exec resume <id>` keep working exactly as before — only config.toml
 * is per-agent (and is the sole place secret MCP env lives).
 *
 * Returns the home dir path, or undefined if it can't be prepared (caller then
 * falls back to the default home with no MCP servers — never to argv secrets).
 */
function prepareCodexHome(servers: McpServerSpec[], agentKey: string): string | undefined {
  try {
    const realHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const safeKey = (agentKey || 'agent').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const home = path.join(os.homedir(), '.codex-idagents', safeKey);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(home, 0o700); } catch { /* best effort */ }

    // Mirror every real-home entry EXCEPT config.toml as a symlink → auth.json,
    // sessions/, caches, skills/, memories/ are all shared with the real codex.
    let entries: string[] = [];
    try { entries = fs.readdirSync(realHome); } catch { /* real home not created yet */ }
    for (const name of entries) {
      if (name === 'config.toml') continue;
      const link = path.join(home, name);
      const target = path.join(realHome, name);
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink()) {
          if (fs.readlinkSync(link) === target) continue; // already correct
          fs.rmSync(link, { force: true });
        } else {
          // codex wrote a real file over our symlink (e.g. an OAuth token refresh
          // of auth.json). Push it back to the shared home, then restore the link
          // so every agent keeps using one auth source.
          if (name === 'auth.json') { try { fs.copyFileSync(link, target); } catch { /* best effort */ } }
          fs.rmSync(link, { recursive: true, force: true });
        }
      } catch { /* link absent — create below */ }
      try { fs.symlinkSync(target, link); } catch { /* ignore individual link failures */ }
    }

    // Private config = operator's config.toml (trust levels, plugins, …) + the
    // MCP server tables. 0600 so only this user can read the secret env.
    let base = '';
    try { base = fs.readFileSync(path.join(realHome, 'config.toml'), 'utf8'); } catch { /* none yet */ }
    const mcp = renderMcpServersToml(servers);
    const cfgPath = path.join(home, 'config.toml');
    fs.writeFileSync(cfgPath, `${base.trimEnd()}\n\n${mcp}\n`, { mode: 0o600 });
    try { fs.chmodSync(cfgPath, 0o600); } catch { /* best effort */ }
    return home;
  } catch (e) {
    console.error(`[Codex] prepareCodexHome failed (${(e as Error).message}) — running without attached MCP servers rather than risk leaking secrets on argv`);
    return undefined;
  }
}

// Fail-closed safeguard: a codex agent's argv is world-readable via `ps`, so a
// credential must NEVER appear there. If a secret-shaped token is found in the
// args we refuse to spawn (a regression should surface loudly, not leak silently).
// MCP secrets travel via the 0600 config file (prepareCodexHome); these patterns
// are specific enough that a normal command line won't trip them.
const SECRET_ARGV_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,            // GitHub PAT / OAuth / refresh tokens
  /github_pat_[A-Za-z0-9_]{20,}/,          // GitHub fine-grained PAT
  /sk-(ant-)?[A-Za-z0-9_-]{20,}/,          // OpenAI / Anthropic API keys
  /AKIA[0-9A-Z]{16}/,                      // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/,          // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,    // PEM private keys
];
function assertNoSecretsInArgv(args: string[]): void {
  const joined = args.join(' ');
  for (const re of SECRET_ARGV_PATTERNS) {
    if (re.test(joined)) {
      throw new Error('refusing to spawn codex: a credential-shaped value was found on the command line — MCP secrets must be passed via the isolated config file, not argv');
    }
  }
}
/** Redact secret-shaped substrings before logging a command line. */
function redactForLog(s: string): string {
  return s
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{4})[A-Za-z0-9]{16,}/g, '$1…')
    .replace(/\b(github_pat_[A-Za-z0-9]{4})[A-Za-z0-9_]{16,}/g, '$1…')
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9]{4})[A-Za-z0-9_-]{16,}/g, '$1…')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA…')
    .replace(/\b(xox[baprs]-[A-Za-z0-9]{4})[A-Za-z0-9-]{6,}/g, '$1…')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY (redacted)-----');
}

export class CodexHarness implements AgentHarness {
  readonly type: HarnessType = 'codex' as HarnessType;

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;
  private currentQueryId: string | undefined;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();
    this.currentQueryId = options.queryId;

    console.log(`[Codex] Starting harness`);
    console.log(`[Codex] Working directory: ${workingDir}`);
    if (options.model) console.log(`[Codex] Model: ${options.model}`);

    const skipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    // A prior thread id (from a previous turn of THIS conversation) → resume it so
    // context carries over. `codex exec resume <id>` is verified on codex-cli 0.130;
    // it needs an explicit -m model (it otherwise defaults to a stale model and 400s)
    // and does NOT accept --cd / --full-auto, so we rely on the spawn cwd and, for the
    // non-bypass case, the resumed session's own recorded sandbox policy.
    const resumeId = options.resume && options.resume.trim() ? options.resume.trim() : undefined;

    // Build arguments for codex exec.
    const args: string[] = ['exec'];
    if (resumeId) {
      args.push('resume', resumeId);
    } else {
      // Working directory (only on a fresh exec; the resume subcommand has no --cd).
      args.push('--cd', workingDir);
    }

    // JSON output for parsing
    args.push('--json');

    // Model override — REQUIRED on resume (see above); harmless on fresh exec.
    if (options.model) {
      args.push('--model', options.model);
    }

    // Default to --dangerously-bypass-approvals-and-sandbox so background
    // agents can act without an interactive shell. The agent's
    // `dangerouslySkipPermissions: false` config opts back into --full-auto
    // (which keeps the workspace-write sandbox and on-request approval policy).
    if (skipPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (!resumeId) {
      args.push('--full-auto');
    }
    console.log(`[Codex] Permission mode: ${skipPermissions ? '--dangerously-bypass-approvals-and-sandbox (default)' : (resumeId ? 'resumed session policy (resume has no --full-auto)' : '--full-auto (config opt-out)')}`);

    // Skip git repo check in case working dir isn't a git repo
    args.push('--skip-git-repo-check');

    // Reasoning effort (set per-agent in the Control Center) — fewer reasoning tokens at
    // lower effort. Non-secret config, so a `-c` override on argv is fine. codex accepts
    // minimal|low|medium|high; map xhigh→high.
    const effortRaw = process.env.ID_AGENT_EFFORT;
    if (effortRaw && /^(minimal|low|medium|high|xhigh)$/.test(effortRaw)) {
      const eff = effortRaw === 'xhigh' ? 'high' : effortRaw;
      args.push('-c', `model_reasoning_effort="${eff}"`);
      console.log(`[Codex] Reasoning effort: ${eff}`);
    }

    // Output speed (set per-agent in the Control Center). `codex --help`
    // currently shows no launch-time --fast flag or speed config key. Do not
    // invent one; log this so operators know the requested setting could not be
    // applied.
    const speedRaw = process.env.ID_AGENT_SPEED;
    if (speedRaw === 'fast') {
      console.log('[Codex] TODO: speed=fast requested, but no Codex launch-time fast flag or speed config key is available.');
    }

    // Attach external MCP servers (Modules view) via a PRIVATE, per-agent config
    // file — NOT `-c …env={…}` on argv (which is world-readable via `ps` and leaked
    // the operator's tokens). prepareCodexHome shares auth + sessions with the real
    // ~/.codex so OAuth and resume are unaffected; only config.toml is per-agent.
    let codexHome: string | undefined;
    if (options.mcpServers?.length) {
      const agentKey = `${process.env.ID_AGENT_TEAM || 'default'}__${process.env.ID_AGENT_NAME || path.basename(workingDir)}`;
      codexHome = prepareCodexHome(options.mcpServers, agentKey);
      if (codexHome) {
        console.log(`[Codex] Attached ${options.mcpServers.length} MCP server(s) via private config (CODEX_HOME=${codexHome})`);
      }
    }

    // Write prompt to temp file to avoid shell escaping issues
    const promptFile = path.join(os.tmpdir(), `codex-prompt-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt);
    console.log(`[Codex] Prompt written to temp file: ${promptFile} (${prompt.length} chars)`);

    if (resumeId) {
      console.log(`[Codex] Resuming thread ${resumeId} for conversation continuity`);
    }

    // Read prompt from stdin
    args.push('-');

    // Fail-closed: never spawn with a credential on the command line.
    assertNoSecretsInArgv(args);
    console.log(`[Codex] Full command: codex ${redactForLog(args.join(' '))}`);

    this.cancelled = false;

    // Issue 4: Merge options.env WITH process.env instead of replacing
    const mergedEnv = { ...process.env, ...(options.env || {}) } as NodeJS.ProcessEnv;
    // Point codex at the per-agent home (private config.toml with the MCP servers).
    if (codexHome) mergedEnv.CODEX_HOME = codexHome;

    const proc = spawn('codex', args, {
      cwd: workingDir,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.currentProcess = proc;

    // Issue 4: Handle spawn errors
    let spawnError: Error | null = null;
    proc.on('error', (err) => {
      console.error(`[Codex] Process error: ${err.message}`);
      spawnError = err;
    });

    console.log(`[Codex] Process spawned, PID: ${proc.pid}`);

    // Write prompt to stdin and close
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    // Clean up temp file
    try { fs.unlinkSync(promptFile); } catch {}

    let lastResult = '';
    let sessionId: string | undefined;
    let turnStartMs = Date.now();
    let buffer = '';

    // Issue 4: Guard stdout/stderr with null checks
    const stdout = proc.stdout;
    const stderr = proc.stderr;

    // Collect stderr for error reporting
    let stderrText = '';
    if (stderr) {
      stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString();
      });
    }

    // Issue 3: Track both stdout end and process exit with a counter
    let completionCount = 0;
    const targetCompletions = 2; // stdout end + process exit
    let exitCode: number | null = null;

    const completionPromise = new Promise<void>((resolve) => {
      const checkDone = () => {
        completionCount++;
        if (completionCount >= targetCompletions) {
          resolve();
        }
      };

      if (stdout) {
        stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n');
          buffer = parts.pop() || '';
          for (const line of parts) {
            if (line.trim()) lines.push(line.trim());
          }
        });
        stdout.on('end', () => {
          if (buffer.trim()) lines.push(buffer.trim());
          checkDone();
        });
      } else {
        checkDone(); // No stdout — count it as done
      }

      proc.on('exit', (code) => {
        console.log(`[Codex] Process exited with code ${code}`);
        exitCode = code;
        checkDone();
      });
    });

    // Process lines as they arrive
    const lines: string[] = [];
    const processedLines = new Set<number>();
    let done = false;

    completionPromise.then(() => { done = true; });

    // Yield messages as lines arrive
    while (!done || processedLines.size < lines.length) {
      await new Promise(r => setTimeout(r, 100));

      for (let i = processedLines.size; i < lines.length; i++) {
        processedLines.add(i);
        const line = lines[i];

        try {
          const event = JSON.parse(line);

          switch (event.type) {
            case 'thread.started': {
              sessionId = event.thread_id;
              yield {
                type: 'system',
                subtype: 'init',
                session_id: sessionId,
              };
              break;
            }

            // Issue 2: session_configured event
            case 'session_configured': {
              yield {
                type: 'system',
                subtype: 'configured',
                session_id: sessionId,
              };
              break;
            }

            case 'turn.started': {
              turnStartMs = Date.now();
              yield {
                type: 'progress',
                content: 'Processing...',
              };
              break;
            }

            case 'item.completed': {
              const item = event.item;
              if (!item) break;

              switch (item.type) {
                case 'agent_message': {
                  // Issue 5: Track last result but yield as progress, not result
                  lastResult = item.text || '';
                  yield {
                    type: 'progress',
                    subtype: 'agent_message',
                    content: lastResult,
                  };
                  break;
                }

                case 'reasoning': {
                  yield {
                    type: 'thinking',
                    content: item.text || '',
                  };
                  break;
                }

                case 'command_execution': {
                  const status = item.status === 'completed' ? 'completed' : 'running';
                  yield {
                    type: 'tool_use',
                    tool_name: 'bash',
                    subtype: status,
                    content: item.command || '',
                    output: item.aggregated_output?.slice(0, 500) || '',
                    exit_code: item.exit_code,
                  };
                  break;
                }

                case 'file_edit':
                case 'file_create':
                case 'file_read': {
                  yield {
                    type: 'tool_use',
                    tool_name: item.type,
                    content: item.path || item.file || '',
                  };
                  break;
                }

                default: {
                  // Unknown item type — yield as progress
                  if (item.text) {
                    yield {
                      type: 'progress',
                      content: item.text,
                    };
                  }
                  break;
                }
              }
              break;
            }

            case 'item.started': {
              const item = event.item;
              if (item?.type === 'command_execution') {
                yield {
                  type: 'tool_use',
                  tool_name: 'bash',
                  subtype: 'started',
                  content: item.command || '',
                };
              }
              break;
            }

            // Issue 2: exec_command_begin
            case 'exec_command_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'bash',
                subtype: 'started',
                content: event.command || '',
              };
              break;
            }

            // Issue 2: exec_command_output_delta
            case 'exec_command_output_delta': {
              yield {
                type: 'progress',
                subtype: 'command_output',
                content: event.delta || event.output || '',
              };
              break;
            }

            // Issue 2: exec_command_end
            case 'exec_command_end': {
              yield {
                type: 'tool_use',
                tool_name: 'bash',
                subtype: 'completed',
                content: event.command || '',
                exit_code: event.exit_code,
              };
              break;
            }

            // Issue 2: agent_message_delta — streaming text
            case 'agent_message_delta': {
              yield {
                type: 'progress',
                subtype: 'message_delta',
                content: event.delta || event.text || '',
              };
              break;
            }

            // Issue 2: agent_reasoning
            case 'agent_reasoning': {
              yield {
                type: 'thinking',
                content: event.text || event.reasoning || '',
              };
              break;
            }

            // Issue 2: web_search_begin/end
            case 'web_search_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'web_search',
                subtype: 'started',
                content: event.query || '',
              };
              break;
            }
            case 'web_search_end': {
              yield {
                type: 'tool_use',
                tool_name: 'web_search',
                subtype: 'completed',
                content: event.query || '',
              };
              break;
            }

            // Issue 2: patch_apply_begin/end
            case 'patch_apply_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'patch',
                subtype: 'started',
                content: event.path || event.file || '',
              };
              break;
            }
            case 'patch_apply_end': {
              yield {
                type: 'tool_use',
                tool_name: 'patch',
                subtype: 'completed',
                content: event.path || event.file || '',
              };
              break;
            }

            case 'turn.completed': {
              // Per-turn token usage → manager (attributed to this query's task). Codex's
              // turn.completed carries usage.{input_tokens, cached_input_tokens, output_tokens}.
              try {
                const u = event.usage || {};
                // Codex's input_tokens is the FULL prompt and ALREADY includes the cached
                // portion; cached_input_tokens is the re-read session history (often millions
                // of tokens). Count only NEW (non-cached) input so the per-task figure reflects
                // real spend, not the cached context re-counted every turn.
                const input = Math.max(0, (Number(u.input_tokens) || 0) - (Number(u.cached_input_tokens) || 0));
                const output = Number(u.output_tokens) || 0;
                reportTurnUsage({
                  runtime: 'codex',
                  model: options.model || process.env.CODEX_MODEL || 'codex',
                  input: input || null,
                  output: output || null,
                  genMs: Date.now() - turnStartMs,
                  queryId: this.currentQueryId,
                });
              } catch { /* never block the reply */ }
              // Issue 5: Only emit type:result here, on turn.completed
              if (lastResult) {
                yield {
                  type: 'result',
                  result: lastResult,
                  session_id: sessionId,
                };
              }
              break;
            }

            case 'error': {
              yield {
                type: 'error',
                content: event.message || event.error || 'Unknown error',
              };
              break;
            }

            default: {
              // Issue 6: Log unknown event types at debug level
              console.log(`[Codex] Unknown event type: ${event.type}`);
              break;
            }
          }
        } catch {
          // Not valid JSON — skip
        }
      }

      if (this.cancelled) {
        proc.kill('SIGTERM');
        yield { type: 'error', content: 'Cancelled' };
        break;
      }
    }

    // Issue 3: Wait for both stdout end AND process exit
    await completionPromise;

    // Issue 4: If spawn failed, yield error
    if (spawnError) {
      yield {
        type: 'error',
        content: `Process spawn error: ${(spawnError as Error).message}`,
      };
    }

    // If no result was captured, check stderr
    if (!lastResult && stderrText) {
      yield {
        type: 'error',
        content: stderrText.trim().slice(0, 500),
      };
    }

    this.currentProcess = null;
  }

  cancel(): boolean {
    if (this.currentProcess) {
      this.cancelled = true;
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
      return true;
    }
    return false;
  }
}
