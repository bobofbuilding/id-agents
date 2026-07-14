// SPDX-License-Identifier: MIT

export function normalizeOriginalManagerPids(values: Array<string | number>, selfPid: number): number[] {
  return [...new Set(values
    .map(value => typeof value === 'number' ? value : parseInt(value, 10))
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== selfPid))];
}

export function liveOriginalManagerPids(
  originalPids: readonly number[],
  isAlive: (pid: number) => boolean,
): number[] {
  return originalPids.filter(pid => isAlive(pid));
}
