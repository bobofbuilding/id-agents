// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parentPidFromEnv,
  startParentDeathWatchdog,
} from '../../src/lib/parent-watchdog.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parent process watchdog', () => {
  it('accepts only a positive non-self managed parent pid', () => {
    expect(parentPidFromEnv({ IDACC_PARENT_PID: '12345' })).toBe(12345);
    expect(parentPidFromEnv({ IDACC_PARENT_PID: '0' })).toBeNull();
    expect(parentPidFromEnv({ IDACC_PARENT_PID: 'not-a-pid' })).toBeNull();
    expect(parentPidFromEnv({ IDACC_PARENT_PID: String(process.pid) })).toBeNull();
  });

  it('fires exactly once when the managed parent disappears', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn(async () => {});
    const isAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const stop = startParentDeathWatchdog(onExit, {
      parentPid: 45678,
      intervalMs: 50,
      isAlive,
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(onExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(onExit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(onExit).toHaveBeenCalledOnce();
    stop();
  });

  it('is inert for standalone processes', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const isAlive = vi.fn();
    const stop = startParentDeathWatchdog(onExit, {
      parentPid: null,
      intervalMs: 50,
      isAlive,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(isAlive).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    stop();
  });
});
