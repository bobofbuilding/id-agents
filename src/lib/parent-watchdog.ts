// SPDX-License-Identifier: MIT

export interface ParentWatchdogOptions {
  parentPid?: number | null;
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
}

export function parentPidFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const pid = Number(env.IDACC_PARENT_PID);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid ? pid : null;
}

export function processPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but this user cannot signal it.
    return error?.code === 'EPERM';
  }
}

/**
 * Invoke `onParentExit` once when an explicitly managed parent disappears.
 * Standalone processes have no IDACC_PARENT_PID and therefore no watchdog.
 */
export function startParentDeathWatchdog(
  onParentExit: () => void | Promise<void>,
  options: ParentWatchdogOptions = {},
): () => void {
  const parentPid = options.parentPid === undefined
    ? parentPidFromEnv()
    : options.parentPid;
  if (!parentPid || parentPid === process.pid) return () => {};

  const isAlive = options.isAlive || processPidIsAlive;
  const intervalMs = Math.max(50, Math.floor(options.intervalMs ?? 1_000));
  let fired = false;
  const timer = setInterval(() => {
    if (fired || isAlive(parentPid)) return;
    fired = true;
    clearInterval(timer);
    void Promise.resolve(onParentExit()).catch((error) => {
      console.error('[Manager] Parent-death shutdown failed:', error);
    });
  }, intervalMs);
  timer.unref?.();
  return () => {
    fired = true;
    clearInterval(timer);
  };
}
