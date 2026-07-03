// SPDX-License-Identifier: MIT

import type { ChildProcess } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

import { terminateChildProcessTree } from '../../src/harness/claude-code-cli.js';

describe('Claude Code CLI harness cancellation', () => {
  it('signals the spawned process group and wrapper process', () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation((() => true) as any);
    const childKill = vi.fn(() => true);
    const proc = {
      pid: 12345,
      kill: childKill,
    } as unknown as ChildProcess;

    const signalled = terminateChildProcessTree(proc, 'SIGTERM');

    expect(signalled).toBe(true);
    if (process.platform !== 'win32') {
      expect(processKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    }
    expect(childKill).toHaveBeenCalledWith('SIGTERM');

    processKill.mockRestore();
  });
});
