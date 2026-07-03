// SPDX-License-Identifier: MIT
/**
 * Grok Build CLI Harness
 *
 * Wraps `grok` for local agents that use the user's logged-in Grok Build
 * subscription. Grok exposes a proper headless prompt-file path, so the full
 * agent task stays off argv while model, effort, and resume options remain
 * selectable from IDACC.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';

function safeAgentKey(): string {
  const team = process.env.ID_AGENT_TEAM || process.env.ID_TEAM || 'default';
  const name = process.env.ID_AGENT_NAME || process.env.ID_AGENT_ALIAS || 'agent';
  return `${team}__${name}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function writePrivatePromptFile(prompt: string): string {
  const dir = path.join(os.tmpdir(), 'id-agents-grok-prompts');
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

export class GrokHarness implements AgentHarness {
  readonly type: HarnessType = 'grok' as HarnessType;

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();
    const promptFile = writePrivatePromptFile(prompt);

    console.log('[Grok] Starting harness');
    console.log(`[Grok] Working directory: ${workingDir}`);
    if (options.model && options.model !== 'default') console.log(`[Grok] Model: ${options.model}`);

    const args: string[] = [
      '--cwd', workingDir,
      '--prompt-file', promptFile,
      '--output-format', 'plain',
      '--no-alt-screen',
    ];

    const skipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    if (skipPermissions) {
      args.push('--always-approve', '--permission-mode', 'bypassPermissions');
    } else {
      args.push('--permission-mode', 'default');
    }
    console.log(`[Grok] Permission mode: ${skipPermissions ? 'bypassPermissions + always approve (default)' : 'default (config opt-out)'}`);

    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }

    if (options.resume) {
      args.push('--resume', options.resume);
    }

    const effortRaw = process.env.ID_AGENT_EFFORT;
    if (effortRaw && /^(low|medium|high|xhigh|max)$/.test(effortRaw)) {
      args.push('--effort', effortRaw);
      console.log(`[Grok] Effort: ${effortRaw}`);
    }

    const mergedEnv = { ...process.env, ...(options.env || {}) } as NodeJS.ProcessEnv;
    const grokPath = process.env.GROK_CLI_PATH || 'grok';
    console.log(`[Grok] Full command: ${grokPath} ${args.map((a) => a === promptFile ? '<private-prompt-file>' : a).join(' ')}`);

    this.cancelled = false;

    const proc = spawn(grokPath, args, {
      cwd: workingDir,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.currentProcess = proc;

    const spawnError: { value?: Error } = {};
    let stdoutText = '';
    let stderrText = '';
    let exitCode: number | null = null;

    proc.on('error', (err) => {
      console.error(`[Grok] Process error: ${err.message}`);
      spawnError.value = err;
    });
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutText += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString(); });

    console.log(`[Grok] Process spawned, PID: ${proc.pid}`);

    const completionPromise = new Promise<void>((resolve) => {
      proc.on('exit', (code) => {
        exitCode = code;
        console.log(`[Grok] Process exited with code ${code}`);
        resolve();
      });
    });

    let done = false;
    completionPromise.then(() => { done = true; });

    while (!done) {
      await new Promise((r) => setTimeout(r, 100));
      if (this.cancelled) {
        proc.kill('SIGTERM');
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
      yield { type: 'error', content: 'grok exited successfully but returned no output' };
    } else {
      yield { type: 'error', content: trimmedError(stdoutText, stderrText, `grok exited with code ${exitCode}`) };
    }

    this.currentProcess = null;
  }

  cancel(): boolean {
    if (this.currentProcess && !this.currentProcess.killed) {
      const pid = this.currentProcess.pid;
      console.log(`[Grok] Cancelling process PID: ${pid}`);
      this.cancelled = true;
      this.currentProcess.kill('SIGTERM');
      const proc = this.currentProcess;
      setTimeout(() => {
        if (proc && !proc.killed) {
          console.log(`[Grok] Force killing process PID: ${pid}`);
          proc.kill('SIGKILL');
        }
      }, 2000);
      return true;
    }
    return false;
  }
}
