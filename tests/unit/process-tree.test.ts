// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';

import {
  signalOwnedProcessTree,
  terminateOwnedProcessTree,
  verifiedOwnedProcess,
  windowsTaskkillInvocation,
} from '../../src/lib/process-tree.js';

describe('owned process-tree termination', () => {
  it('refuses invalid, unverified, and Manager-self PIDs', () => {
    expect(verifiedOwnedProcess(0, true, 100)).toBeNull();
    expect(verifiedOwnedProcess(-5, true, 100)).toBeNull();
    expect(verifiedOwnedProcess(101.5, true, 100)).toBeNull();
    expect(verifiedOwnedProcess(101, false, 100)).toBeNull();
    expect(verifiedOwnedProcess(100, true, 100)).toBeNull();
    expect(verifiedOwnedProcess(101, true, 100)).toEqual({ pid: 101, verified: true });
  });

  it('builds a shell-free exact-PID Windows tree command without force by default', () => {
    const target = verifiedOwnedProcess(4242, true, 100)!;
    expect(windowsTaskkillInvocation(target, false, {
      SystemRoot: 'C:\\Windows',
    })).toEqual({
      command: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '4242', '/T'],
    });

    const execFileSync = vi.fn();
    expect(signalOwnedProcessTree(target, 'SIGTERM', {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      execFileSync,
    })).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '4242', '/T'],
      { stdio: 'ignore', windowsHide: true },
    );
  });

  it('uses /F only after the grace period and a second ownership check', async () => {
    const invocations: Array<{ command: string; args: string[] }> = [];
    const waits: number[] = [];
    const verifyOwnership = vi.fn(() => true);

    const result = await terminateOwnedProcessTree(5252, {
      platform: 'win32',
      currentPid: 100,
      env: { SystemRoot: 'C:\\Windows' },
      execFileSync: (command, args) => {
        invocations.push({ command, args: [...args] });
      },
      verifyOwnership,
      isAlive: () => true,
      graceMs: 250,
      pollIntervalMs: 100,
      wait: async (ms) => { waits.push(ms); },
    });

    expect(waits).toEqual([100, 100, 50]);
    expect(verifyOwnership).toHaveBeenCalledTimes(2);
    expect(invocations).toEqual([
      {
        command: 'C:\\Windows\\System32\\taskkill.exe',
        args: ['/PID', '5252', '/T'],
      },
      {
        command: 'C:\\Windows\\System32\\taskkill.exe',
        args: ['/PID', '5252', '/T', '/F'],
      },
    ]);
    expect(result).toMatchObject({
      accepted: true,
      gracefulSignalled: true,
      forcedSignalled: true,
      ownershipLost: false,
    });
  });

  it('never force-kills when exact ownership is lost during the grace period', async () => {
    const invocations: string[][] = [];
    let verification = 0;

    const result = await terminateOwnedProcessTree(6262, {
      platform: 'win32',
      currentPid: 100,
      execFileSync: (_command, args) => { invocations.push([...args]); },
      verifyOwnership: () => {
        verification += 1;
        return verification === 1;
      },
      isAlive: () => true,
      graceMs: 10,
      pollIntervalMs: 10,
      wait: async () => {},
    });

    expect(invocations).toEqual([['/PID', '6262', '/T']]);
    expect(result).toMatchObject({
      accepted: true,
      gracefulSignalled: true,
      forcedSignalled: false,
      exited: false,
      ownershipLost: true,
    });
  });

  it('fails closed when ownership verification throws', async () => {
    const execFileSync = vi.fn();
    const result = await terminateOwnedProcessTree(6868, {
      platform: 'win32',
      currentPid: 100,
      execFileSync,
      verifyOwnership: () => { throw new Error('inspection unavailable'); },
    });

    expect(execFileSync).not.toHaveBeenCalled();
    expect(result).toEqual({
      accepted: false,
      gracefulSignalled: false,
      forcedSignalled: false,
      exited: false,
      ownershipLost: true,
    });
  });

  it('does not wait or force during a coordinated graceful-only shutdown pass', async () => {
    const invocations: string[][] = [];
    const wait = vi.fn(async () => {});

    const result = await terminateOwnedProcessTree(7272, {
      platform: 'win32',
      currentPid: 100,
      execFileSync: (_command, args) => { invocations.push([...args]); },
      verifyOwnership: () => true,
      isAlive: () => true,
      forceAfterGrace: false,
      wait,
    });

    expect(invocations).toEqual([['/PID', '7272', '/T']]);
    expect(wait).not.toHaveBeenCalled();
    expect(result.forcedSignalled).toBe(false);
  });
});
