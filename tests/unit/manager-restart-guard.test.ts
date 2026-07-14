// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { liveOriginalManagerPids, normalizeOriginalManagerPids } from '../../src/lib/manager-restart-guard.js';

describe('manager restart PID guard', () => {
  it('normalizes and de-duplicates only the original manager PID set', () => {
    expect(normalizeOriginalManagerPids(['101', '101', 'bad', 202, 0, -1, '303'], 202)).toEqual([101, 303]);
  });

  it('never promotes a replacement port owner into the force-kill set', () => {
    const originalPids = normalizeOriginalManagerPids(['101'], 999);
    const currentPortOwners = [404];
    const alive = new Set([101, ...currentPortOwners]);

    expect(liveOriginalManagerPids(originalPids, pid => alive.has(pid))).toEqual([101]);
    expect(liveOriginalManagerPids(originalPids, pid => alive.has(pid))).not.toContain(404);
  });
});
