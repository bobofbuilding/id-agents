// SPDX-License-Identifier: MIT

import { execFileSync as nodeExecFileSync } from 'node:child_process';
import path from 'node:path';

export interface VerifiedOwnedProcess {
  readonly pid: number;
  readonly verified: true;
}

export interface WindowsTaskkillInvocation {
  command: string;
  args: string[];
}

type ExecFileSyncLike = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true },
) => unknown;

type KillLike = (pid: number, signal: NodeJS.Signals | number) => boolean;

interface SignalOwnedProcessTreeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFileSync?: ExecFileSyncLike;
  kill?: KillLike;
  detachedProcessGroup?: boolean;
  onError?: (message: string, error: unknown) => void;
}

export interface TerminateOwnedProcessTreeOptions extends SignalOwnedProcessTreeOptions {
  currentPid?: number;
  verifyOwnership: (pid: number) => boolean | Promise<boolean>;
  isAlive?: (pid: number) => boolean;
  graceMs?: number;
  pollIntervalMs?: number;
  forceAfterGrace?: boolean;
  wait?: (ms: number) => Promise<void>;
}

export interface TerminateOwnedProcessTreeResult {
  accepted: boolean;
  gracefulSignalled: boolean;
  forcedSignalled: boolean;
  exited: boolean;
  ownershipLost: boolean;
}

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MAX_GRACE_MS = 30_000;

/**
 * Create an exact-PID ownership token. Process-tree signalling APIs accept only
 * this token so call sites must complete their own identity/ownership check
 * before any signal is sent. The Manager process itself is always excluded.
 */
export function verifiedOwnedProcess(
  pid: number,
  ownershipVerified: boolean,
  currentPid: number = process.pid,
): VerifiedOwnedProcess | null {
  if (!ownershipVerified) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === currentPid) return null;
  return { pid, verified: true };
}

export function windowsTaskkillInvocation(
  target: VerifiedOwnedProcess,
  force: boolean,
  env: NodeJS.ProcessEnv = process.env,
): WindowsTaskkillInvocation {
  const systemRoot = env.SystemRoot || env.WINDIR;
  const command = systemRoot && path.win32.isAbsolute(systemRoot)
    ? path.win32.join(systemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
  return {
    command,
    args: ['/PID', String(target.pid), '/T', ...(force ? ['/F'] : [])],
  };
}

/**
 * Signal one already-verified process tree without a shell. On Windows this
 * uses taskkill's exact /PID target and /T tree flag. /F is reserved for the
 * SIGKILL call made only after the bounded grace period below.
 */
export function signalOwnedProcessTree(
  target: VerifiedOwnedProcess,
  signal: NodeJS.Signals,
  options: SignalOwnedProcessTreeOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const onError = options.onError ?? (() => {});

  if (platform === 'win32') {
    const invocation = windowsTaskkillInvocation(target, signal === 'SIGKILL', options.env);
    try {
      const execFileSync = options.execFileSync ?? nodeExecFileSync;
      execFileSync(invocation.command, invocation.args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      return true;
    } catch (error) {
      onError(`Failed to terminate Windows process tree ${target.pid}`, error);
      return false;
    }
  }

  const kill = options.kill ?? ((pid, requestedSignal) => process.kill(pid, requestedSignal));
  let signalled = false;
  if (options.detachedProcessGroup) {
    try {
      kill(-target.pid, signal);
      signalled = true;
    } catch (error) {
      onError(`Failed to signal process group ${target.pid}`, error);
    }
  }
  try {
    kill(target.pid, signal);
    signalled = true;
  } catch (error) {
    onError(`Failed to signal process ${target.pid}`, error);
  }
  return signalled;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Request graceful tree termination, allow a bounded grace period, then
 * re-verify ownership before forcefully terminating the same exact PID tree.
 */
export async function terminateOwnedProcessTree(
  pid: number,
  options: TerminateOwnedProcessTreeOptions,
): Promise<TerminateOwnedProcessTreeResult> {
  const platform = options.platform ?? process.platform;
  const currentPid = options.currentPid ?? process.pid;
  const ownershipVerified = await Promise.resolve()
    .then(() => options.verifyOwnership(pid))
    .catch(() => false);
  const target = verifiedOwnedProcess(pid, ownershipVerified, currentPid);
  if (!target) {
    return {
      accepted: false,
      gracefulSignalled: false,
      forcedSignalled: false,
      exited: false,
      ownershipLost: !ownershipVerified,
    };
  }

  const signalOptions: SignalOwnedProcessTreeOptions = {
    platform,
    env: options.env,
    execFileSync: options.execFileSync,
    kill: options.kill,
    detachedProcessGroup: options.detachedProcessGroup,
    onError: options.onError,
  };
  const gracefulSignalled = signalOwnedProcessTree(target, 'SIGTERM', signalOptions);
  const isAlive = options.isAlive ?? defaultIsAlive;
  const aliveAfterGracefulAttempt = isAlive(pid);
  if (
    !gracefulSignalled
    && (
      !aliveAfterGracefulAttempt
      || platform !== 'win32'
      || options.forceAfterGrace === false
    )
  ) {
    return {
      accepted: true,
      gracefulSignalled: false,
      forcedSignalled: false,
      exited: !aliveAfterGracefulAttempt,
      ownershipLost: false,
    };
  }
  if (options.forceAfterGrace === false) {
    return {
      accepted: true,
      gracefulSignalled,
      forcedSignalled: false,
      exited: !aliveAfterGracefulAttempt,
      ownershipLost: false,
    };
  }

  const graceMsRaw = options.graceMs ?? DEFAULT_GRACE_MS;
  const graceMs = Number.isFinite(graceMsRaw)
    ? Math.min(MAX_GRACE_MS, Math.max(1, Math.floor(graceMsRaw)))
    : DEFAULT_GRACE_MS;
  const pollRaw = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollIntervalMs = Number.isFinite(pollRaw)
    ? Math.min(graceMs, Math.max(1, Math.floor(pollRaw)))
    : Math.min(graceMs, DEFAULT_POLL_INTERVAL_MS);
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));

  let elapsed = 0;
  while (elapsed < graceMs && isAlive(pid)) {
    const interval = Math.min(pollIntervalMs, graceMs - elapsed);
    await wait(interval);
    elapsed += interval;
  }
  if (!isAlive(pid)) {
    return {
      accepted: true,
      gracefulSignalled,
      forcedSignalled: false,
      exited: true,
      ownershipLost: false,
    };
  }

  const stillOwned = await Promise.resolve()
    .then(() => options.verifyOwnership(pid))
    .catch(() => false);
  const forceTarget = verifiedOwnedProcess(pid, stillOwned, currentPid);
  if (!forceTarget) {
    return {
      accepted: true,
      gracefulSignalled,
      forcedSignalled: false,
      exited: false,
      ownershipLost: true,
    };
  }

  const forcedSignalled = signalOwnedProcessTree(forceTarget, 'SIGKILL', signalOptions);
  return {
    accepted: true,
    gracefulSignalled,
    forcedSignalled,
    exited: !isAlive(pid),
    ownershipLost: false,
  };
}
