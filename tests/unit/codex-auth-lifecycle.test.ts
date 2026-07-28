// SPDX-License-Identifier: MIT

import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexHarness } from '../../src/harness/codex.js';
import { atomicWritePrivateFile } from '../../src/lib/profile-storage.js';

class FakeCodexProcess extends EventEmitter {
  readonly pid: number;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private finished = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.finished) return;
    this.finished = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

interface SpawnRecord {
  process: FakeCodexProcess;
  args: readonly string[];
  home: string;
}

const roots: string[] = [];
const originalCodexBin = process.env.ID_AGENT_CODEX_BIN;

function fixture(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `id-agents-codex-lifecycle-${label}-`));
  roots.push(root);
  const profile = path.join(root, 'profile');
  const providerHome = path.join(root, 'provider');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(profile);
  fs.mkdirSync(providerHome);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(providerHome, 'auth.json'), '{"provider":"launch"}\n');
  return {
    profile,
    providerHome,
    workspace,
    env: {
      IDACC_MANAGED_SERVICE: '1',
      IDACC_DATA_DIR: profile,
      ID_AGENT_ID: `agent-${label}`,
      ID_AGENT_NAME: `Agent ${label}`,
      CODEX_HOME: providerHome,
    },
  };
}

function replaceRunAuth(home: string, value: string): void {
  atomicWritePrivateFile(
    path.dirname(home),
    path.join(home, 'auth.json'),
    `${JSON.stringify({ provider: value })}\n`,
  );
}

function updateSharedRunAuthInPlace(home: string, value: string): void {
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    `${JSON.stringify({ provider: value })}\n`,
  );
}

function fakeHarness(
  onSpawn: (record: SpawnRecord) => void,
  onTerminate?: (record: SpawnRecord, signal: NodeJS.Signals) => void,
) {
  let nextPid = 70_000;
  const records: SpawnRecord[] = [];
  const spawn = ((
    _command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    const child = new FakeCodexProcess(nextPid++);
    const home = String(options.env?.CODEX_HOME || '');
    const record = { process: child, args, home };
    records.push(record);
    queueMicrotask(() => onSpawn(record));
    return child as unknown as ChildProcess;
  }) as typeof nodeSpawn;
  const terminate = vi.fn((child: ChildProcess, signal: NodeJS.Signals) => {
    const record = records.find(({ process: candidate }) => (
      candidate === child as unknown as FakeCodexProcess
    ));
    if (!record) throw new Error('unknown fake Codex child');
    if (onTerminate) onTerminate(record, signal);
    else queueMicrotask(() => record.process.finish(null, signal));
  });
  return {
    harness: new CodexHarness({ spawn, terminate }),
    records,
    spawn,
    terminate,
  };
}

async function collect(harness: CodexHarness, options: Parameters<CodexHarness['run']>[1]) {
  const messages = [];
  for await (const message of harness.run('lifecycle regression', options)) {
    messages.push(message);
  }
  return messages;
}

afterEach(() => {
  if (originalCodexBin === undefined) delete process.env.ID_AGENT_CODEX_BIN;
  else process.env.ID_AGENT_CODEX_BIN = originalCodexBin;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Codex post-process auth lifecycle', () => {
  it('rejects external text-only work before spawning Codex', async () => {
    process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
    const setup = fixture('external-text-only');
    const fake = fakeHarness(() => {
      throw new Error('Codex must not spawn for an unsupported text-only policy');
    });

    await expect(collect(fake.harness, {
      workingDirectory: setup.workspace,
      env: setup.env,
      executionPolicy: 'external-text-only',
    })).rejects.toThrow(/cannot guarantee a zero-local-tool text-only execution policy/i);

    expect(fake.records).toHaveLength(0);
  });

  it('preserves existing provider auth when a run replaces its isolated auth path', async () => {
    process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
    const setup = fixture('normal');
    const fake = fakeHarness(({ process: child, home }) => {
      replaceRunAuth(home, 'normal-refresh');
      child.finish(0);
    });

    await collect(fake.harness, {
      workingDirectory: setup.workspace,
      env: setup.env,
      mcpServers: [{ name: 'private', command: 'mcp', env: { TOKEN: 'secret' } }],
    });

    expect(fs.readFileSync(path.join(setup.providerHome, 'auth.json'), 'utf8'))
      .toContain('launch');
    expect(fake.records).toHaveLength(1);
    expect(fs.existsSync(fake.records[0].home)).toBe(false);

    const observer = fakeHarness(({ process: child, home }) => {
      expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).toContain('launch');
      child.finish(0);
    });
    await collect(observer.harness, {
      workingDirectory: setup.workspace,
      env: { ...setup.env, ID_AGENT_ID: 'agent-normal-b' },
    });
  });

  it('finalizes and cleans after an asynchronous spawn error', async () => {
    process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
    const setup = fixture('spawn-error');
    const fake = fakeHarness(({ process: child }) => {
      child.emit('error', new Error('synthetic spawn error'));
      child.finish(null);
    });

    const messages = await collect(fake.harness, {
      workingDirectory: setup.workspace,
      env: setup.env,
      mcpServers: [{ name: 'private', command: 'mcp', env: { TOKEN: 'secret' } }],
    });

    expect(messages.some((message) => (
      message.type === 'error' && /synthetic spawn error/i.test(message.content || '')
    ))).toBe(true);
    expect(fs.existsSync(fake.records[0].home)).toBe(false);
  });

  it('does not resurrect provider logout that occurs while the child is running', async () => {
    process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
    const setup = fixture('provider-logout');
    const fake = fakeHarness(({ process: child, home }) => {
      fs.unlinkSync(path.join(setup.providerHome, 'auth.json'));
      replaceRunAuth(home, 'stale-refresh-after-provider-logout');
      child.finish(0);
    });

    await collect(fake.harness, {
      workingDirectory: setup.workspace,
      env: setup.env,
    });

    expect(fs.existsSync(path.join(setup.providerHome, 'auth.json'))).toBe(false);
    expect(fs.existsSync(fake.records[0].home)).toBe(false);
  });

  it('keeps remote MCP header secrets in the private config and out of argv/logs', async () => {
    process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
    const setup = fixture('remote-header');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(' '));
    });
    const fake = fakeHarness(({ process: child, args, home }) => {
      expect(args.join(' ')).not.toContain('private-header-secret');
      expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'))
        .toContain('private-header-secret');
      child.finish(0);
    });

    await collect(fake.harness, {
      workingDirectory: setup.workspace,
      env: setup.env,
      mcpServers: [{
        name: 'remote',
        transport: 'http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer private-header-secret' },
      }],
    });

    expect(logs.join('\n')).not.toContain('private-header-secret');
    expect(fs.existsSync(fake.records[0].home)).toBe(false);
  });

  it.each(['return', 'throw', 'cancel'] as const)(
    'waits for child quiescence before auth reconciliation on generator %s',
    async (mode) => {
      process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
      const setup = fixture(mode);
      const fake = fakeHarness(
        ({ process: child }) => {
          child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: `thread-${mode}` })}\n`);
        },
        ({ process: child, home }, signal) => {
          queueMicrotask(() => {
            updateSharedRunAuthInPlace(home, `${mode}-refresh-after-termination`);
            child.finish(null, signal);
          });
        },
      );
      const iterator = fake.harness.run('early lifecycle', {
        workingDirectory: setup.workspace,
        env: setup.env,
        mcpServers: [{ name: 'private', command: 'mcp', env: { TOKEN: `${mode}-secret` } }],
      });
      expect((await iterator.next()).value?.type).toBe('system');

      if (mode === 'return') {
        await iterator.return(undefined);
      } else if (mode === 'throw') {
        await expect(iterator.throw(new Error('consumer stopped iteration')))
          .rejects.toThrow(/consumer stopped iteration/);
      } else {
        expect(fake.harness.cancel()).toBe(true);
        for await (const _message of { [Symbol.asyncIterator]: () => iterator }) {
          // Drain cancellation so the generator's finally block completes.
        }
      }

      expect(fake.terminate).toHaveBeenCalled();
      expect(fs.readFileSync(path.join(setup.providerHome, 'auth.json'), 'utf8'))
        .toContain(`${mode}-refresh-after-termination`);
      expect(fs.existsSync(fake.records[0].home)).toBe(false);
    },
  );

  it('hands an unresponsive cancellation to the bounded lifecycle finalizer', async () => {
    process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
    const setup = fixture('cancel-finalizer');
    let terminationCount = 0;
    const fake = fakeHarness(
      ({ process: child }) => {
        child.stdout.write(`${JSON.stringify({
          type: 'thread.started',
          thread_id: 'thread-cancel-finalizer',
        })}\n`);
      },
      ({ process: child }, signal) => {
        terminationCount += 1;
        // cancel() and the parser loop both request termination. Simulate a
        // stubborn child that closes only when the lifecycle finalizer retries.
        if (terminationCount >= 3) {
          queueMicrotask(() => child.finish(null, signal));
        }
      },
    );
    const iterator = fake.harness.run('cancel lifecycle', {
      workingDirectory: setup.workspace,
      env: setup.env,
    });
    expect((await iterator.next()).value?.type).toBe('system');
    expect(fake.harness.cancel()).toBe(true);

    const drained = [];
    for await (const message of { [Symbol.asyncIterator]: () => iterator }) {
      drained.push(message);
    }

    expect(drained.some((message) => (
      message.type === 'error' && message.content === 'Cancelled'
    ))).toBe(true);
    expect(terminationCount).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(fake.records[0].home)).toBe(false);
  });

  it('keeps concurrent normal and control-plane homes and configs disjoint', async () => {
    process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
    const setup = fixture('concurrent');
    const fake = fakeHarness(
      ({ process: child }) => {
        child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: String(child.pid) })}\n`);
      },
      ({ process: child }, signal) => queueMicrotask(() => child.finish(null, signal)),
    );
    const normal = fake.harness.run('normal', {
      workingDirectory: setup.workspace,
      env: setup.env,
      mcpServers: [{
        name: 'normal',
        command: 'normal-mcp',
        env: { TOKEN: 'normal-secret' },
      }],
    });
    const controlHarness = new CodexHarness({
      spawn: fake.spawn,
      terminate: fake.terminate,
    });
    const control = controlHarness.run('control', {
      workingDirectory: setup.workspace,
      env: setup.env,
      executionPolicy: 'control-plane-readonly',
      mcpServers: [],
    });

    await Promise.all([normal.next(), control.next()]);
    expect(fake.records).toHaveLength(2);
    const [normalRun, controlRun] = fake.records;
    expect(normalRun.home).not.toBe(controlRun.home);
    expect(fs.readFileSync(path.join(normalRun.home, 'config.toml'), 'utf8'))
      .toContain('normal-secret');
    expect(fs.readFileSync(path.join(controlRun.home, 'config.toml'), 'utf8')).toBe('');
    expect(controlRun.args).toContain('sandbox_mode="read-only"');

    await Promise.all([normal.return(undefined), control.return(undefined)]);
    expect(fs.existsSync(normalRun.home)).toBe(false);
    expect(fs.existsSync(controlRun.home)).toBe(false);
  });

  it('serializes concurrent resumes of the same profile-owned conversation', async () => {
    process.env.ID_AGENT_CODEX_BIN = '/fake/codex';
    const setup = fixture('resume-lock');
    const fake = fakeHarness(
      ({ process: child }) => {
        child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'same-thread' })}\n`);
      },
      ({ process: child }, signal) => queueMicrotask(() => child.finish(null, signal)),
    );
    const first = fake.harness.run('first', {
      workingDirectory: setup.workspace,
      env: setup.env,
      resume: 'same-thread',
    });
    const secondHarness = new CodexHarness({
      spawn: fake.spawn,
      terminate: fake.terminate,
    });
    const second = secondHarness.run('second', {
      workingDirectory: setup.workspace,
      env: setup.env,
      resume: 'same-thread',
    });

    await first.next();
    let secondSettled = false;
    const secondStarted = second.next().then((value) => {
      secondSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondSettled).toBe(false);
    expect(fake.records).toHaveLength(1);

    await first.return(undefined);
    expect((await secondStarted).value?.type).toBe('system');
    expect(fake.records).toHaveLength(2);
    await second.return(undefined);
  });
});
