// SPDX-License-Identifier: MIT

import type { ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentHarness, HarnessMessage } from '../../src/harness/types.js';
import { AntigravityHarness } from '../../src/harness/antigravity.js';
import { CodexHarness } from '../../src/harness/codex.js';
import { CopilotCliHarness } from '../../src/harness/copilot-cli.js';
import { CursorCliHarness } from '../../src/harness/cursor-cli.js';
import { GrokHarness } from '../../src/harness/grok.js';
import { KimiCliHarness } from '../../src/harness/kimi-cli.js';
import { KiroCliHarness } from '../../src/harness/kiro-cli.js';

const CLI_ENV_KEYS = [
  'ID_AGENT_CODEX_BIN',
  'CURSOR_AGENT_PATH',
  'GROK_CLI_PATH',
  'COPILOT_CLI_PATH',
  'ANTIGRAVITY_CLI_PATH',
  'KIRO_CLI_PATH',
  'KIMI_CLI_PATH',
] as const;

const originalEnv = new Map<string, string | undefined>(
  CLI_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of CLI_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function collectWithDeadline(harness: AgentHarness): Promise<HarnessMessage[]> {
  const collect = (async () => {
    const messages: HarnessMessage[] = [];
    for await (const message of harness.run('bounded missing executable regression', {
      workingDirectory: os.tmpdir(),
      model: 'default',
    })) {
      messages.push(message);
    }
    return messages;
  })();
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('portable CLI harness did not settle after spawn failure')), 2_000);
    timer.unref?.();
  });
  return Promise.race([collect, deadline]);
}

describe('portable CLI lifecycle', () => {
  const missingPath = path.join(
    os.tmpdir(),
    `idacc-definitely-missing-cli-${process.pid}-${Date.now()}`,
    process.platform === 'win32' ? 'missing.cmd' : 'missing',
  );
  const cases: Array<{
    label: string;
    env: (typeof CLI_ENV_KEYS)[number];
    create: () => AgentHarness;
  }> = [
    { label: 'Codex', env: 'ID_AGENT_CODEX_BIN', create: () => new CodexHarness() },
    { label: 'Cursor', env: 'CURSOR_AGENT_PATH', create: () => new CursorCliHarness() },
    { label: 'Grok', env: 'GROK_CLI_PATH', create: () => new GrokHarness() },
    { label: 'Copilot', env: 'COPILOT_CLI_PATH', create: () => new CopilotCliHarness() },
    { label: 'Antigravity', env: 'ANTIGRAVITY_CLI_PATH', create: () => new AntigravityHarness() },
    { label: 'Kiro', env: 'KIRO_CLI_PATH', create: () => new KiroCliHarness() },
    { label: 'Kimi', env: 'KIMI_CLI_PATH', create: () => new KimiCliHarness() },
  ];

  it.each(cases)('$label settles with a clear error when its configured executable disappears', async ({ env, create }) => {
    process.env[env] = missingPath;

    const messages = await collectWithDeadline(create());

    expect(messages.some((message) => (
      message.type === 'error'
      && /spawn|enoent|not found|no such file/i.test(message.content || '')
    ))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('cancellation ignores ChildProcess.killed and force-signals a still-live tree', async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation((() => true) as any);
    const childKill = vi.fn(() => true);
    const proc = {
      pid: 54321,
      killed: true,
      exitCode: null,
      signalCode: null,
      kill: childKill,
    } as unknown as ChildProcess;
    const harness = new KimiCliHarness() as any;
    harness.currentProcess = proc;

    expect(harness.cancel()).toBe(true);
    expect(processKill).toHaveBeenCalledWith(-54321, 'SIGTERM');
    expect(childKill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(2_001);
    expect(processKill).toHaveBeenCalledWith(-54321, 'SIGKILL');
    expect(childKill).toHaveBeenCalledWith('SIGKILL');
  });
});
