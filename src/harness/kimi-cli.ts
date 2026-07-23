// SPDX-License-Identifier: MIT
/**
 * Kimi Code CLI Harness
 *
 * Runs Kimi's documented non-interactive prompt mode using the user's local
 * OAuth membership. The full task lives in a 0600 prompt file so operational
 * context is not exposed through argv.
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
  const dir = path.join(os.tmpdir(), 'id-agents-kimi-prompts');
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

export class KimiCliHarness implements AgentHarness {
  readonly type: HarnessType = 'kimi-cli';

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();
    const promptFile = writePrivatePromptFile(prompt);
    const launchPrompt = [
      'Read the full ID Agents task from this private local file, then complete it in the current working directory:',
      promptFile,
      'Do not print the file path unless it is needed for debugging.',
    ].join('\n');
    const args = ['-p', launchPrompt, '--output-format', 'text'];
    if (options.model && options.model !== 'default') args.push('-m', options.model);

    const mergedEnv = { ...process.env, ...(options.env || {}) } as NodeJS.ProcessEnv;
    const kimiPath = process.env.KIMI_CLI_PATH || 'kimi';
    console.log('[Kimi CLI] Starting harness');
    console.log(`[Kimi CLI] Working directory: ${workingDir}`);
    console.log(`[Kimi CLI] Model: ${options.model || 'configured default'}`);
    console.log('[Kimi CLI] Permission mode: print-mode auto policy with vendor static denies');

    this.cancelled = false;
    const proc = spawn(kimiPath, args, {
      cwd: workingDir,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentProcess = proc;

    const spawnError: { value?: Error } = {};
    let stdoutText = '';
    let stderrText = '';
    let exitCode: number | null = null;
    proc.on('error', (error) => { spawnError.value = error; });
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutText += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString(); });

    const completionPromise = new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        exitCode = code;
        resolve();
      });
    });
    let done = false;
    completionPromise.then(() => { done = true; });

    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    } else if (this.cancelled) {
      yield { type: 'error', content: 'Query was cancelled' };
    } else {
      const stdout = stdoutText.trim();
      if (exitCode === 0 && stdout) {
        yield { type: 'result', result: stdout, content: stdout };
      } else if (exitCode === 0) {
        yield { type: 'error', content: 'kimi exited successfully but returned no output' };
      } else {
        yield { type: 'error', content: trimmedError(stdoutText, stderrText, `kimi exited with code ${exitCode}`) };
      }
    }
    this.currentProcess = null;
  }

  cancel(): boolean {
    if (!this.currentProcess || this.currentProcess.killed) return false;
    this.cancelled = true;
    const proc = this.currentProcess;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 2000);
    return true;
  }
}
