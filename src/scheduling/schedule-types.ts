// SPDX-License-Identifier: MIT

import type { ScheduleDeliveryMode } from '../config-parser.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

/**
 * A logical run produced by the schedule evaluator.
 * Represents one due execution of a schedule for one or more agents.
 */
export interface DueRun {
  scheduleId: string;
  scheduledKey: string;     // e.g. "interval:1711737600" or "calendar:2026-04-01@32400"
  scheduledAt: number;       // unix seconds — logical scheduled instant
  kind: 'heartbeat' | 'calendar';
}

/**
 * Result of attempting to dispatch a schedule run to a single agent.
 */
export interface DispatchResult {
  scheduleId: string;
  agentId: string;
  scheduledKey: string;
  success: boolean;
  error?: string;
}

/**
 * Linked task summary included in calendar schedule payloads.
 */
export interface LinkedTaskSummary {
  name: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  owner: string | null;
  team: string | null;
}

/**
 * Schedule payload sent to agents via /talk endpoint.
 *
 * The `schedule.manual` flag is set ONLY when an operator triggers a
 * one-off fire via `/heartbeat fire`. The receiving agent uses it to
 * distinguish operator-fired wakes from scheduler-driven ticks; the
 * scheduler path never sets it (it's strictly absent on real beats).
 */
export interface SchedulePayload {
  from: string;
  mode: ScheduleDeliveryMode;
  schedule: {
    id: string;
    kind: 'heartbeat' | 'calendar';
    title: string;
    scheduledKey: string;
    manual?: true;
  };
  message: string;
  linkedTasks?: LinkedTaskSummary[];
  brain_context?: {
    cited?: {
      entity_ids?: string[];
      fact_ids?: number[];
      text_unit_ids?: number[];
      canonical_source_ids?: string[];
      source_origins?: Record<string, string[]>;
    };
    timelineEventId?: number;
    bundles?: unknown[];
  };
}

/**
 * Options accepted by `buildSchedulePayload`. Kept intentionally narrow
 * so the helper stays the single source of truth for what's allowed to
 * vary between the scheduled-fire path and the manual-fire path.
 */
export interface BuildSchedulePayloadOpts {
  /** Calendar schedule linked tasks (only emitted for calendar kinds in real fires). */
  linkedTasks?: LinkedTaskSummary[];
  /**
   * Manual operator fire. When true, the payload's `schedule.manual`
   * field is set to `true` and the receiving agent can branch on it.
   * The scheduler tick path NEVER sets this — manual fires are the
   * only path that flips the flag.
   */
  manual?: boolean;
}

/**
 * Build a SchedulePayload from a schedule definition + scheduled-key.
 *
 * This is the single source of truth for the payload shape; both the
 * scheduler tick (`ScheduleDispatcher.dispatch`) and the operator-fired
 * path (`SchedulerService.fireManual`) call it. The cto-approved hard
 * risk note for `/heartbeat fire` requires that the manual wake payload
 * be byte-identical to the scheduled wake payload except for the
 * scheduled-key timestamp, the `schedule.manual` flag, and any
 * caller-supplied mode label — funnelling both callers through one
 * helper enforces that contract by construction so the slice-3 parity
 * test can compare outputs directly.
 */
export function buildSchedulePayload(
  def: ScheduleDefinitionRow,
  scheduledKey: string,
  opts: BuildSchedulePayloadOpts = {},
): SchedulePayload {
  const payload: SchedulePayload = {
    from: def.sender || 'schedule',
    mode: def.delivery_mode,
    schedule: {
      id: def.id,
      kind: def.kind,
      title: def.title,
      scheduledKey,
      ...(opts.manual ? { manual: true as const } : {}),
    },
    message: def.message,
  };
  if (opts.linkedTasks && opts.linkedTasks.length > 0) {
    payload.linkedTasks = opts.linkedTasks;
  }
  return payload;
}

/**
 * Minimal agent info needed for dispatch (avoids importing full AgentRow).
 */
export interface DispatchTarget {
  id: string;
  name: string;
  endpoint: string;
  talkPath: string;
  schedulePath?: string | null;
  status: string;
  /** Manager-to-worker generation-bound headers in managed desktop mode. */
  requestHeaders?: Record<string, string>;
}
