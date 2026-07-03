// SPDX-License-Identifier: MIT
/**
 * Kiro CLI Harness
 *
 * Wraps `kiro-cli chat` for local agents that use the user's logged-in Kiro
 * subscription. Kiro supports non-interactive chat, model selection, effort, and
 * session resume. We still hand the full task through a private prompt file so
 * large or sensitive agent prompts are not exposed through argv.
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
  const dir = path.join(os.tmpdir(), 'id-agents-kiro-prompts');
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

export class KiroCliHarness implements AgentHarness {
  readonly type: HarnessType = 'kiro-cli' as HarnessType;

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();
    const promptFile = writePrivatePromptFile(prompt);

    console.log('[Kiro CLI] Starting harness');
    console.log(`[Kiro CLI] Working directory: ${workingDir}`);
    if (options.model && options.model !== 'default') console.log(`[Kiro CLI] Model: ${options.model}`);

    const launchPrompt = [
      'Read the full ID Agents task from this private local file, then complete it in the current working directory:',
      promptFile,
      'Do not print the file path unless it is needed for debugging.',
    ].join('\n');

    const args: string[] = [
      'chat',
      '--no-interactive',
      '--wrap', 'never',
    ];

    const skipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    if (skipPermissions) {
      args.push('--trust-all-tools');
    } else {
      args.push('--trust-tools=');
    }
    console.log(`[Kiro CLI] Permission mode: ${skipPermissions ? '--trust-all-tools (default)' : '--trust-tools= (config opt-out)'}`);

    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }

    if (options.resume) {
      args.push('--resume-id', options.resume);
    }

    const effortRaw = process.env.ID_AGENT_EFFORT;
    if (effortRaw && /^(low|medium|high|xhigh|max)$/.test(effortRaw)) {
      args.push('--effort', effortRaw);
      console.log(`[Kiro CLI] Effort: ${effortRaw}`);
    }

    args.push(launchPrompt);

    const mergedEnv = { ...process.env, ...(options.env || {}) } as NodeJS.ProcessEnv;
    const kiroPath = process.env.KIRO_CLI_PATH || 'kiro-cli';
    console.log(`[Kiro CLI] Full command: ${kiroPath} ${args.map((a) => a === launchPrompt ? '<task-file-prompt>' : a).join(' ')}`);

    this.cancelled = false;

    const proc = spawn(kiroPath, args, {
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
      console.error(`[Kiro CLI] Process error: ${err.message}`);
      spawnError.value = err;
    });
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutText += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString(); });

    console.log(`[Kiro CLI] Process spawned, PID: ${proc.pid}`);

    const completionPromise = new Promise<void>((resolve) => {
      proc.on('exit', (code) => {
        exitCode = code;
        console.log(`[Kiro CLI] Process exited with code ${code}`);
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
      yield { type: 'error', content: 'kiro-cli exited successfully but returned no output' };
    } else {
      yield { type: 'error', content: trimmedError(stdoutText, stderrText, `kiro-cli exited with code ${exitCode}`) };
    }

    this.currentProcess = null;
  }

  cancel(): boolean {
    if (this.currentProcess && !this.currentProcess.killed) {
      const pid = this.currentProcess.pid;
      console.log(`[Kiro CLI] Cancelling process PID: ${pid}`);
      this.cancelled = true;
      this.currentProcess.kill('SIGTERM');
      const proc = this.currentProcess;
      setTimeout(() => {
        if (proc && !proc.killed) {
          console.log(`[Kiro CLI] Force killing process PID: ${pid}`);
          proc.kill('SIGKILL');
        }
      }, 2000);
      return true;
    }
    return false;
  }
}
