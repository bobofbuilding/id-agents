// SPDX-License-Identifier: MIT
/**
 * Google Antigravity CLI Harness
 *
 * Wraps the Antigravity CLI for local agents that use the user's logged-in Antigravity
 * subscription. Antigravity has headless print mode but no prompt-file flag, so
 * the full agent task is written to a private local file and argv receives only
 * a short instruction to read that file.
 */

import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';
import { resolveExecutable } from '../lib/executable-resolution.js';
import { portableSpawn } from '../lib/portable-spawn.js';
import { terminateChildProcessTree } from './claude-code-cli.js';

function safeAgentKey(): string {
  const team = process.env.ID_AGENT_TEAM || process.env.ID_TEAM || 'default';
  const name = process.env.ID_AGENT_NAME || process.env.ID_AGENT_ALIAS || 'agent';
  return `${team}__${name}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function writePrivatePromptFile(prompt: string): string {
  const dir = path.join(os.tmpdir(), 'id-agents-antigravity-prompts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const file = path.join(dir, `${safeAgentKey()}-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

function trimmedError(stdout: string, stderr: string, fallback: string): string {
  const combined = `${stderr}\n${stdout}`.trim();
  return (combined || fallback).replace(/\s+\n/g, '\n').slice(0, 2000);
}

function resolveAntigravityCli(env: NodeJS.ProcessEnv): string {
  if (env.ANTIGRAVITY_CLI_PATH) {
    return resolveExecutable(env.ANTIGRAVITY_CLI_PATH, { env }) || env.ANTIGRAVITY_CLI_PATH;
  }
  for (const bin of ['agy', 'antigravity']) {
    const executable = resolveExecutable(bin, { env });
    if (executable) return executable;
  }
  return 'agy';
}

export class AntigravityHarness implements AgentHarness {
  readonly type: HarnessType = 'antigravity' as HarnessType;

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();
    const promptFile = writePrivatePromptFile(prompt);

    console.log('[Antigravity] Starting harness');
    console.log(`[Antigravity] Working directory: ${workingDir}`);
    if (options.model && options.model !== 'default') console.log(`[Antigravity] Model: ${options.model}`);

    const launchPrompt = [
      'This wrapper message is not the task.',
      'Read the full ID Agents task from this private local file and treat that file as the only user request:',
      promptFile,
      'Do not investigate or explain Antigravity CLI behavior unless the task file explicitly asks for that.',
      'Do not print the file path unless it is needed for debugging. Complete the task from the file in the current working directory.',
    ].join('\n');

    const args: string[] = [
      '--print',
      '--print-timeout', process.env.ANTIGRAVITY_PRINT_TIMEOUT || '5m0s',
      '--add-dir', workingDir,
    ];

    const skipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--sandbox');
    }
    console.log(`[Antigravity] Permission mode: ${skipPermissions ? '--dangerously-skip-permissions (default)' : '--sandbox (config opt-out)'}`);

    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }

    if (options.resume) {
      args.push('--conversation', options.resume);
    }

    args.push(launchPrompt);

    const mergedEnv = { ...process.env, ...(options.env || {}) } as NodeJS.ProcessEnv;
    const agyPath = resolveAntigravityCli(mergedEnv);
    console.log(`[Antigravity] Full command: ${agyPath} ${args.map((a) => a === launchPrompt ? '<task-file-prompt>' : a).join(' ')}`);

    this.cancelled = false;

    const proc = portableSpawn(agyPath, args, {
      cwd: workingDir,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    this.currentProcess = proc;

    const spawnError: { value?: Error } = {};
    let stdoutText = '';
    let stderrText = '';
    let exitCode: number | null = null;

    proc.on('error', (err) => {
      console.error(`[Antigravity] Process error: ${err.message}`);
      spawnError.value = err;
    });
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutText += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString(); });

    console.log(`[Antigravity] Process spawned, PID: ${proc.pid}`);

    const completionPromise = new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        exitCode = code;
        console.log(`[Antigravity] Process closed with code ${code}`);
        resolve();
      });
    });

    let done = false;
    completionPromise.then(() => { done = true; });

    while (!done) {
      await new Promise((r) => setTimeout(r, 100));
      if (this.cancelled) {
        try { fs.rmSync(promptFile, { force: true }); } catch { /* best effort */ }
        this.currentProcess = null;
        yield { type: 'error', content: 'Query was cancelled' };
        return;
      }
    }

    await completionPromise;

    try { fs.rmSync(promptFile, { force: true }); } catch { /* best effort */ }

    if (spawnError.value) {
      yield { type: 'error', content: `Process spawn error: ${spawnError.value.message}` };
      this.currentProcess = null;
      return;
    }

    if (this.cancelled) {
      yield { type: 'error', content: 'Query was cancelled' };
      this.currentProcess = null;
      return;
    }

    const stdout = stdoutText.trim();
    if (exitCode === 0 && stdout) {
      yield { type: 'result', result: stdout, content: stdout };
    } else if (exitCode === 0) {
      yield { type: 'error', content: 'agy exited successfully but returned no output' };
    } else {
      yield { type: 'error', content: trimmedError(stdoutText, stderrText, `agy exited with code ${exitCode}`) };
    }

    this.currentProcess = null;
  }

  cancel(): boolean {
    if (this.currentProcess && this.currentProcess.exitCode === null && this.currentProcess.signalCode === null) {
      const proc = this.currentProcess;
      const pid = proc.pid;
      console.log(`[Antigravity] Cancelling process PID: ${pid}`);
      this.cancelled = true;
      terminateChildProcessTree(proc, 'SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          console.log(`[Antigravity] Force killing process PID: ${pid}`);
          terminateChildProcessTree(proc, 'SIGKILL');
        }
      }, 2000).unref?.();
      return true;
    }
    return false;
  }
}
