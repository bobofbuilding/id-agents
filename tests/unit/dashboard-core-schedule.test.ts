// SPDX-License-Identifier: MIT
/**
 * Unit tests for the renderer-neutral schedule math extracted to
 * src/dashboard-core/schedule.ts in commit 3. Imports from the new location
 * (the TUI keeps importing the same functions through its compatibility shim).
 */

import { describe, expect, it } from 'vitest';
import {
  cadenceLabel,
  formatInterval,
  formatLocalTime,
  formatNextFire,
  nextFireSec,
} from '../../src/dashboard-core/schedule.js';
import type { Schedule } from '../../src/dashboard-core/api/types.js';

const base: Schedule = {
  id: 's',
  title: 't',
  kind: 'heartbeat',
  active: true,
  targets: ['coder'],
  intervalSeconds: 3600,
  timezone: null,
  localTimeSeconds: null,
  localDate: null,
  daysOfWeek: null,
  createdAt: 1000,
};

describe('schedule.formatInterval', () => {
  it('bands seconds/minutes/hours/days with fractional labels', () => {
    expect(formatInterval(30)).toBe('30s');
    expect(formatInterval(90)).toBe('2m');
    expect(formatInterval(3600)).toBe('1h');
    expect(formatInterval(5400)).toBe('1.5h');
    expect(formatInterval(86_400)).toBe('1d');
    expect(formatInterval(129_600)).toBe('1.5d');
  });
});

describe('schedule.cadenceLabel', () => {
  it('describes heartbeat and calendar schedules', () => {
    expect(cadenceLabel({ ...base, kind: 'heartbeat', intervalSeconds: 3600 })).toBe('every 1h');
    expect(
      cadenceLabel({
        ...base,
        kind: 'calendar',
        intervalSeconds: null,
        timezone: 'UTC',
        localTimeSeconds: 32_400,
        daysOfWeek: 'mon,tue,wed,thu,fri,sat,sun',
      }),
    ).toBe('daily 09:00');
    expect(
      cadenceLabel({
        ...base,
        kind: 'calendar',
        intervalSeconds: null,
        timezone: 'UTC',
        localTimeSeconds: 3600,
        localDate: '2030-01-01',
      }),
    ).toBe('2030-01-01 01:00');
  });
});

describe('schedule.formatLocalTime', () => {
  it('renders HH:MM from seconds-of-day', () => {
    expect(formatLocalTime(0)).toBe('00:00');
    expect(formatLocalTime(32_400)).toBe('09:00');
    expect(formatLocalTime(3661)).toBe('01:01');
  });
});

describe('schedule.nextFireSec', () => {
  it('advances a heartbeat by one interval past its anchor', () => {
    expect(nextFireSec({ ...base, kind: 'heartbeat', intervalSeconds: 3600, createdAt: 1000 }, 1000)).toBe(4600);
    expect(nextFireSec({ ...base, active: false }, 1000)).toBeNull();
  });

  it('resolves a calendar fire at the correct UTC instant, within the 35-day window', () => {
    const cal: Schedule = {
      ...base,
      kind: 'calendar',
      intervalSeconds: null,
      timezone: 'UTC',
      localTimeSeconds: 3600,
      localDate: '2030-01-01',
    };
    const fire = Math.floor(Date.UTC(2030, 0, 1, 1, 0, 0) / 1000);
    expect(nextFireSec(cal, fire - 2 * 86_400)).toBe(fire);
    expect(nextFireSec(cal, 1_000_000)).toBeNull(); // beyond 35-day look-ahead
  });
});

describe('schedule.formatNextFire', () => {
  it('produces a fixed 11-char countdown + HH:MM cell', () => {
    const now = Math.floor(Date.UTC(2027, 5, 15, 12, 0, 0) / 1000);
    const past = formatNextFire(now - 10, now);
    expect(past.length).toBe(11);
    expect(past.startsWith('  now ')).toBe(true);
    const soon = formatNextFire(now + 120, now);
    expect(soon.length).toBe(11);
    expect(soon.startsWith('   2m ')).toBe(true);
  });
});
