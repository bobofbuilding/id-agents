// SPDX-License-Identifier: MIT

import {
  buildSchedulePayload,
  type DispatchResult,
  type DispatchTarget,
  type LinkedTaskSummary,
} from './schedule-types.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

/**
 * Optional inputs accepted by `ScheduleDispatcher.dispatch`. Kept narrow
 * so the manual-fire path goes through the same code path as the
 * scheduler tick — the only allowed deviations from a real beat are
 * the `manual` flag and the scheduled-key timestamp.
 */
export interface DispatchOptions {
  linkedTasks?: LinkedTaskSummary[];
  /**
   * Manual operator fire (`/heartbeat fire <agent>`). When true, the
   * outgoing payload carries `schedule.manual: true` so the receiving
   * agent can branch on operator-fired vs scheduler-fired wakes.
   */
  manual?: boolean;
}

/**
 * Delivers scheduled payloads to agent /talk or /schedule endpoints.
 */
export class ScheduleDispatcher {
  /**
   * Send a schedule payload to a single agent.
   * Returns a DispatchResult indicating success or failure.
   */
  async dispatch(
    def: ScheduleDefinitionRow,
    target: DispatchTarget,
    scheduledKey: string,
    optsOrLinkedTasks?: DispatchOptions | LinkedTaskSummary[],
  ): Promise<DispatchResult> {
    // Backwards-compatible signature: callers can still pass the
    // legacy `linkedTasks?: LinkedTaskSummary[]` positional argument.
    const opts: DispatchOptions = Array.isArray(optsOrLinkedTasks)
      ? { linkedTasks: optsOrLinkedTasks }
      : (optsOrLinkedTasks ?? {});

    const result: DispatchResult = {
      scheduleId: def.id,
      agentId: target.id,
      scheduledKey,
      success: false,
    };

    if (target.status !== 'running') {
      result.error = `Agent ${target.name} not running (status: ${target.status})`;
      return result;
    }

    if (!target.endpoint) {
      result.error = `Agent ${target.name} has no endpoint`;
      return result;
    }

    const payload = buildSchedulePayload(def, scheduledKey, {
      linkedTasks: opts.linkedTasks,
      manual: opts.manual,
    });

    const path = def.delivery_mode === 'internal' ? target.schedulePath : target.talkPath;
    if (def.delivery_mode === 'internal' && !path) {
      result.error = `Agent ${target.name} does not advertise /schedule`;
      return result;
    }

    try {
      const response = await fetch(`${target.endpoint}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        result.success = true;
      } else {
        result.error = `HTTP ${response.status}`;
      }
    } catch (err: any) {
      result.error = err.message || String(err);
    }

    return result;
  }
}
