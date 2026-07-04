// SPDX-License-Identifier: MIT

import {
  buildSchedulePayload,
  type DispatchResult,
  type DispatchTarget,
  type LinkedTaskSummary,
} from './schedule-types.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

type BrainVolunteerContext = {
  bundles?: Array<{
    query?: string;
    entities?: Array<{ id?: string; name?: string; type?: string }>;
    facts?: Array<{ id?: number; entity_id?: string; field?: string; value?: unknown }>;
    textUnits?: Array<{ id?: number; title?: string; content?: string; source_id?: string }>;
  }>;
  cited?: {
    entity_ids?: string[];
    fact_ids?: number[];
    text_unit_ids?: number[];
    canonical_source_ids?: string[];
  };
  timelineEventId?: number;
};

function brainUrl(): string {
  return (process.env.BRAIN_URL || 'http://127.0.0.1:4200').replace(/\/+$/, '');
}

function brainHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.BRAIN_TOKEN) headers.Authorization = `Bearer ${process.env.BRAIN_TOKEN}`;
  return headers;
}

function formatBrainContextAppendix(context: BrainVolunteerContext | null): string {
  if (!context?.bundles?.length) return '';
  const lines = ['Brain context:'];
  for (const bundle of context.bundles.slice(0, 3)) {
    lines.push(bundle.query ? `- Query: ${bundle.query}` : '- Related context');
    for (const entity of (bundle.entities || []).slice(0, 3)) {
      if (entity?.id) lines.push(`  Entity: ${entity.name || entity.id} [entity:${entity.id}]`);
    }
    for (const fact of (bundle.facts || []).slice(0, 4)) {
      if (fact?.id) lines.push(`  Fact: ${fact.entity_id}.${fact.field} = ${JSON.stringify(fact.value)} [fact:${fact.id}]`);
    }
    for (const unit of (bundle.textUnits || []).slice(0, 2)) {
      if (!unit?.id) continue;
      const excerpt = String(unit.content || '').replace(/\s+/g, ' ').slice(0, 240);
      lines.push(`  Source: ${unit.title || unit.source_id || 'text unit'} [text:${unit.id}] ${excerpt}`);
    }
  }
  const canonical = context.cited?.canonical_source_ids || [];
  if (canonical.length) lines.push(`Cite used Brain sources as used_source_ids: ${canonical.join(', ')}`);
  return lines.join('\n');
}

function shouldAttachBrainContext(def: ScheduleDefinitionRow, message: string): boolean {
  if (def.kind === 'heartbeat') return false;
  const text = String(message || '').trimStart();
  if (!text) return false;
  return ![
    /^Heartbeat:/,
    /^Supervision:/,
    /^Supervision probe on task\b/,
    /^Backlog guard:/,
    /^Task assignment sweep:/,
    /^Assignment sweep complete\b/,
    /^No approved recommendation routed\b/,
    /^Already handled\.\s+Task\b/,
    /^You have \d+ stalled doing tasks\b/,
  ].some((pattern) => pattern.test(text));
}

async function volunteerBrainContext(input: {
  agentId: string;
  text: string;
  scheduleId: string;
  scheduledKey: string;
}): Promise<BrainVolunteerContext | null> {
  if (process.env.BRAIN_CONTEXT_DISABLED === 'true') return null;
  try {
    const res = await fetch(`${brainUrl()}/context/volunteer`, {
      method: 'POST',
      headers: brainHeaders(),
      body: JSON.stringify({
        agent_id: input.agentId,
        text: input.text,
        limit: 3,
        metadata: {
          source: 'id-agents-scheduler',
          schedule_id: input.scheduleId,
          scheduled_key: input.scheduledKey,
        },
      }),
      signal: AbortSignal.timeout(Number(process.env.BRAIN_CONTEXT_TIMEOUT_MS || 1200)),
    });
    if (!res.ok) return null;
    const json = await res.json() as { data?: BrainVolunteerContext };
    return json.data || null;
  } catch {
    return null;
  }
}

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

    const linkedTaskText = (opts.linkedTasks || [])
      .map((task) => `${task.title} (${task.status}${task.owner ? `, owner=${task.owner}` : ''})`)
      .join('\n');
    const messageText = [def.message, linkedTaskText].filter(Boolean).join('\n\n');
    const brainContext = shouldAttachBrainContext(def, def.message)
      ? await volunteerBrainContext({
          agentId: target.id,
          text: messageText,
          scheduleId: def.id,
          scheduledKey,
        })
      : null;
    const appendix = formatBrainContextAppendix(brainContext);
    const payload = buildSchedulePayload(def, scheduledKey, {
      linkedTasks: opts.linkedTasks,
      manual: opts.manual,
    });
    payload.message = appendix ? `${def.message}\n\n${appendix}` : def.message;
    if (brainContext) {
      payload.brain_context = {
        cited: brainContext.cited,
        timelineEventId: brainContext.timelineEventId,
        bundles: brainContext.bundles || [],
      };
    }

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
