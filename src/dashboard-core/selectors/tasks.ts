// SPDX-License-Identifier: MIT
/** Pure task selection seams. */

import type { Task } from '../api/types.js';

/** Tasks in the selected team, or every task when no team is selected. */
export function filterTasksByTeam(tasks: Task[], selectedTeam: string | null): Task[] {
  return selectedTeam === null ? tasks : tasks.filter((t) => t.teamName === selectedTeam);
}
