// SPDX-License-Identifier: MIT
/** Pure schedule selection seams (schedule MATH lives in ../schedule.ts). */

import type { Schedule } from '../api/types.js';

/**
 * Calendar view excludes heartbeat-kind schedules (and legacy `Heartbeat: …`
 * titled entries), which already appear on the Heartbeats page — duplicating
 * them on the calendar just adds noise.
 */
export function filterCalendarSchedules(schedules: Schedule[]): Schedule[] {
  return schedules.filter((s) => s.kind !== 'heartbeat' && !/^Heartbeat:\s/i.test(s.title));
}
