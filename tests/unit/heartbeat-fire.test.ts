// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  buildSchedulePayload,
  type DispatchTarget,
} from '../../src/scheduling/schedule-types.js';
import { ScheduleDispatcher } from '../../src/scheduling/schedule-dispatcher.js';
import {
  SchedulerService,
  synthesizeForceHeartbeat,
} from '../../src/scheduling/scheduler-service.js';
import { HEARTBEAT_GENERIC_MESSAGE } from '../../src/scheduling/schedule-config.js';
import type {
  Db,
} from '../../src/db/db-service.js';
import type { ScheduleDefinitionRow } from '../../src/db/types.js';

const originalBrainContextDisabled = process.env.BRAIN_CONTEXT_DISABLED;

beforeEach(() => {
  process.env.BRAIN_CONTEXT_DISABLED = 'true';
});

afterEach(() => {
  if (originalBrainContextDisabled === undefined) {
    delete process.env.BRAIN_CONTEXT_DISABLED;
  } else {
    process.env.BRAIN_CONTEXT_DISABLED = originalBrainContextDisabled;
  }
});

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function makeHeartbeatDef(overrides: Partial<ScheduleDefinitionRow> = {}): ScheduleDefinitionRow {
  return {
    id: 'hb_agent_123',
    kind: 'heartbeat',
    title: 'Heartbeat: coder',
    description: null,
    active: true,
    message: 'wake up and check things',
    sender: 'heartbeat',
    delivery_mode: 'internal',
    timezone: null,
    catch_up_policy: 'fire_once',
    dedupe_window_seconds: 90,
    interval_seconds: 300,
    anchor_at: 1_700_000_000,
    max_runs: null,
    expires_at: null,
    local_time_seconds: null,
    local_date: null,
    days_of_week: null,
    source_type: 'yaml',
    source_key: 'heartbeat:agent_123',
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

function makeTarget(overrides: Partial<DispatchTarget> = {}): DispatchTarget {
  return {
    id: 'agent_123',
    name: 'coder',
    endpoint: 'http://localhost:4135',
    talkPath: '/talk',
    schedulePath: '/schedule',
    status: 'running',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  buildSchedulePayload                                               */
/* ------------------------------------------------------------------ */

describe('buildSchedulePayload', () => {
  it('produces the documented payload shape with no manual flag by default', () => {
    const def = makeHeartbeatDef();
    const payload = buildSchedulePayload(def, 'interval:1700000300');

    expect(payload).toEqual({
      from: 'heartbeat',
      mode: 'internal',
      schedule: {
        id: 'hb_agent_123',
        kind: 'heartbeat',
        title: 'Heartbeat: coder',
        scheduledKey: 'interval:1700000300',
      },
      message: 'wake up and check things',
    });
    // Manual flag MUST be absent on a normal fire — receiving agents
    // branch on its presence, so an accidental `manual: false` would
    // still trigger the manual branch.
    expect(payload.schedule).not.toHaveProperty('manual');
  });

  it('adds schedule.manual=true when opts.manual is true', () => {
    const def = makeHeartbeatDef();
    const payload = buildSchedulePayload(def, 'interval:1700000300', { manual: true });
    expect(payload.schedule.manual).toBe(true);
  });

  it('falls back to from="schedule" when def.sender is empty', () => {
    const def = makeHeartbeatDef({ sender: '' });
    const payload = buildSchedulePayload(def, 'interval:1700000300');
    expect(payload.from).toBe('schedule');
  });

  it('omits linkedTasks when none provided; includes them when non-empty', () => {
    const def = makeHeartbeatDef({ kind: 'calendar', delivery_mode: 'talk', sender: 'schedule' });
    const empty = buildSchedulePayload(def, 'calendar:2026-05-12@32400');
    expect(empty.linkedTasks).toBeUndefined();

    const withTasks = buildSchedulePayload(def, 'calendar:2026-05-12@32400', {
      linkedTasks: [
        { name: 't', title: 'do thing', status: 'todo', owner: null, team: null },
      ],
    });
    expect(withTasks.linkedTasks).toHaveLength(1);
  });

  it('does NOT add schedule.manual when opts.manual is false / undefined', () => {
    const def = makeHeartbeatDef();
    const p1 = buildSchedulePayload(def, 'interval:1', { manual: false });
    const p2 = buildSchedulePayload(def, 'interval:1', {});
    expect(p1.schedule).not.toHaveProperty('manual');
    expect(p2.schedule).not.toHaveProperty('manual');
  });
});

/* ------------------------------------------------------------------ */
/*  Payload parity: manual fire vs scheduled fire                      */
/*  (the hard-risk-note contract from cto)                             */
/* ------------------------------------------------------------------ */

describe('manual vs scheduled payload parity', () => {
  it('payloads differ ONLY by schedule.manual and schedule.scheduledKey', () => {
    const def = makeHeartbeatDef();

    const scheduled = buildSchedulePayload(def, 'interval:1700000300');
    const manual = buildSchedulePayload(def, 'interval:1700000999', { manual: true });

    // Strip the two allowed deviations and compare.
    const normalize = (p: ReturnType<typeof buildSchedulePayload>) => ({
      ...p,
      schedule: {
        id: p.schedule.id,
        kind: p.schedule.kind,
        title: p.schedule.title,
        // scheduledKey and manual intentionally stripped — they're the
        // documented allowed deviations.
      },
    });

    expect(normalize(scheduled)).toEqual(normalize(manual));
    expect(manual.schedule.manual).toBe(true);
    expect(scheduled.schedule).not.toHaveProperty('manual');
  });
});

/* ------------------------------------------------------------------ */
/*  ScheduleDispatcher: routes opts.manual into the payload            */
/* ------------------------------------------------------------------ */

describe('ScheduleDispatcher.dispatch with manual opt', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends payload with schedule.manual=true when opts.manual is set', async () => {
    const dispatcher = new ScheduleDispatcher();
    const def = makeHeartbeatDef();
    const target = makeTarget();

    const result = await dispatcher.dispatch(def, target, 'interval:1700000400', { manual: true });
    expect(result.success).toBe(true);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4135/schedule');
    const sentPayload = JSON.parse(init.body as string);
    expect(sentPayload.schedule.manual).toBe(true);
    expect(sentPayload.schedule.scheduledKey).toBe('interval:1700000400');
  });

  it('omits schedule.manual when opts not set (legacy / scheduler tick path)', async () => {
    const dispatcher = new ScheduleDispatcher();
    const def = makeHeartbeatDef();
    const target = makeTarget();

    await dispatcher.dispatch(def, target, 'interval:1700000400');

    const sentPayload = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sentPayload.schedule).not.toHaveProperty('manual');
  });

  it('does not attach Brain context to heartbeat dispatches even when Brain is enabled', async () => {
    delete process.env.BRAIN_CONTEXT_DISABLED;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/context/volunteer')) {
        return new Response(JSON.stringify({
          data: {
            bundles: [{ query: 'heartbeat', textUnits: [{ id: 1, title: 'context', content: 'large context' }] }],
            cited: { canonical_source_ids: ['text:1'] },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 200 });
    });

    const dispatcher = new ScheduleDispatcher();
    const def = makeHeartbeatDef();
    const target = makeTarget();

    await dispatcher.dispatch(def, target, 'interval:1700000400');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4135/schedule');
    const sentPayload = JSON.parse(init.body as string);
    expect(sentPayload.message).toBe(def.message);
    expect(sentPayload.brain_context).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('does not attach Brain context to task assignment sweep schedules', async () => {
    delete process.env.BRAIN_CONTEXT_DISABLED;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/context/volunteer')) {
        return new Response(JSON.stringify({
          data: {
            bundles: [{ query: 'assignment', textUnits: [{ id: 2, title: 'context', content: 'large context' }] }],
            cited: { canonical_source_ids: ['text:2'] },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 200 });
    });

    const dispatcher = new ScheduleDispatcher();
    const def = makeHeartbeatDef({
      kind: 'calendar',
      delivery_mode: 'talk',
      message: 'Task assignment sweep: inspect unassigned todo tasks across all teams.',
    });
    const target = makeTarget();

    await dispatcher.dispatch(def, target, 'calendar:2026-07-04@0');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4135/talk');
    const sentPayload = JSON.parse(init.body as string);
    expect(sentPayload.message).toBe(def.message);
    expect(sentPayload.brain_context).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('does not attach Brain context to task delegation schedules', async () => {
    delete process.env.BRAIN_CONTEXT_DISABLED;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/context/volunteer')) {
        return new Response(JSON.stringify({
          data: {
            bundles: [{ query: 'delegation', textUnits: [{ id: 3, title: 'context', content: 'large context' }] }],
            cited: { canonical_source_ids: ['text:3'] },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 200 });
    });

    const dispatcher = new ScheduleDispatcher();
    const def = makeHeartbeatDef({
      kind: 'calendar',
      delivery_mode: 'talk',
      message: 'TASK DELEGATION from manager: You are assigned task #12345678 ("Bounded task").',
    });
    const target = makeTarget();

    await dispatcher.dispatch(def, target, 'calendar:2026-07-04@1');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4135/talk');
    const sentPayload = JSON.parse(init.body as string);
    expect(sentPayload.message).toBe(def.message);
    expect(sentPayload.brain_context).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('accepts the legacy positional linkedTasks array (backward compatibility)', async () => {
    const dispatcher = new ScheduleDispatcher();
    const def = makeHeartbeatDef({ kind: 'calendar', delivery_mode: 'talk' });
    const target = makeTarget();

    await dispatcher.dispatch(def, target, 'calendar:k', [
      { name: 't', title: 'x', status: 'todo', owner: null, team: null },
    ]);

    const sentPayload = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sentPayload.linkedTasks).toHaveLength(1);
    // Legacy callers didn't set manual, so it must remain absent.
    expect(sentPayload.schedule).not.toHaveProperty('manual');
  });

  it('returns failure without firing when target is not running', async () => {
    const dispatcher = new ScheduleDispatcher();
    const def = makeHeartbeatDef();
    const target = makeTarget({ status: 'stopped' });

    const result = await dispatcher.dispatch(def, target, 'interval:1', { manual: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not running/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  SchedulerService.fireManual: no DB writes, sets manual flag        */
/* ------------------------------------------------------------------ */

describe('SchedulerService.fireManual', () => {
  it('does NOT mutate the schedules DB and emits schedule.manual=true', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    // Wire a Db proxy that throws on every schedules.* method except
    // pure read calls a tick would do. fireManual must touch NONE of
    // them: no insertRun, no updateRunStatus, no countRuns, no
    // upsertDefinition.
    const forbidden = new Set([
      'insertRun',
      'updateRunStatus',
      'countRuns',
      'upsertDefinition',
      'replaceTargets',
      'listTargets',
      'listActiveDefinitions',
      'deleteBySource',
    ]);
    const schedulesGuard = new Proxy({}, {
      get(_t, prop: string) {
        if (forbidden.has(prop)) {
          return () => {
            throw new Error(`fireManual touched forbidden DB method: schedules.${prop}`);
          };
        }
        return undefined;
      },
    });
    const dbStub = { schedules: schedulesGuard } as unknown as Db;

    const service = new SchedulerService(dbStub, async () => null);
    const def = makeHeartbeatDef();
    const target = makeTarget();

    const result = await service.fireManual(def, target);
    expect(result.success).toBe(true);

    const sentPayload = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sentPayload.schedule.manual).toBe(true);
    // scheduledKey is `interval:<now>` for a heartbeat definition.
    expect(sentPayload.schedule.scheduledKey).toMatch(/^interval:\d+$/);

    fetchSpy.mockRestore();
  });
});

describe('SchedulerService.tick', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips stopped targets before recording or dispatching due runs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_301_000);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const def = makeHeartbeatDef({
      anchor_at: 1_700_000_000,
      interval_seconds: 300,
      max_runs: null,
    });
    const schedules = {
      listActiveDefinitions: vi.fn(async () => [def]),
      listTargets: vi.fn(async () => ['agent_123']),
      countRuns: vi.fn(async () => 0),
      insertRun: vi.fn(async () => true),
      updateRunStatus: vi.fn(async () => undefined),
    };
    const dbStub = { schedules } as unknown as Db;
    const service = new SchedulerService(dbStub, async () => makeTarget({ status: 'stopped' }));

    await service.tick();

    expect(schedules.listActiveDefinitions).toHaveBeenCalledOnce();
    expect(schedules.listTargets).toHaveBeenCalledWith(def.id);
    expect(schedules.countRuns).not.toHaveBeenCalled();
    expect(schedules.insertRun).not.toHaveBeenCalled();
    expect(schedules.updateRunStatus).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips busy targets before recording automatic due runs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_301_000);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const def = makeHeartbeatDef({
      anchor_at: 1_700_000_000,
      interval_seconds: 300,
      max_runs: null,
    });
    const schedules = {
      listActiveDefinitions: vi.fn(async () => [def]),
      listTargets: vi.fn(async () => ['agent_123']),
      countRuns: vi.fn(async () => 0),
      insertRun: vi.fn(async () => true),
      updateRunStatus: vi.fn(async () => undefined),
    };
    const dbStub = { schedules } as unknown as Db;
    const guard = vi.fn(async () => false);
    const service = new SchedulerService(
      dbStub,
      async () => makeTarget(),
      { shouldDispatch: guard },
    );

    await service.tick();

    expect(guard).toHaveBeenCalledOnce();
    expect(schedules.countRuns).not.toHaveBeenCalled();
    expect(schedules.insertRun).not.toHaveBeenCalled();
    expect(schedules.updateRunStatus).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets manager-owned schedules record runs without posting agent prompts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_301_000);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const def = makeHeartbeatDef({
      anchor_at: 1_700_000_000,
      interval_seconds: 300,
      max_runs: null,
      delivery_mode: 'talk',
      message: 'Task assignment sweep: inspect unassigned todo tasks across all teams.',
    });
    const schedules = {
      listActiveDefinitions: vi.fn(async () => [def]),
      listTargets: vi.fn(async () => ['agent_123']),
      countRuns: vi.fn(async () => 0),
      insertRun: vi.fn(async () => true),
      updateRunStatus: vi.fn(async () => undefined),
    };
    const managedDispatch = vi.fn(async (_target: DispatchTarget, row: ScheduleDefinitionRow, run: { scheduledKey: string }) => ({
      scheduleId: row.id,
      agentId: 'agent_123',
      scheduledKey: run.scheduledKey,
      success: true,
    }));
    const dbStub = { schedules } as unknown as Db;
    const service = new SchedulerService(
      dbStub,
      async () => makeTarget({ schedulePath: null }),
      { managedDispatch },
    );

    await service.tick();

    expect(managedDispatch).toHaveBeenCalledOnce();
    expect(schedules.insertRun).toHaveBeenCalledOnce();
    expect(schedules.updateRunStatus).toHaveBeenCalledWith(def.id, 'agent_123', expect.any(String), 'sent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bounds automatic per-schedule dispatch concurrency', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_301_000);
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeFetches -= 1;
      return new Response(null, { status: 200 });
    });
    const def = makeHeartbeatDef({
      anchor_at: 1_700_000_000,
      interval_seconds: 300,
      max_runs: null,
    });
    const agentIds = ['agent_1', 'agent_2', 'agent_3', 'agent_4', 'agent_5'];
    const schedules = {
      listActiveDefinitions: vi.fn(async () => [def]),
      listTargets: vi.fn(async () => agentIds),
      countRuns: vi.fn(async () => 0),
      insertRun: vi.fn(async () => true),
      updateRunStatus: vi.fn(async () => undefined),
    };
    const dbStub = { schedules } as unknown as Db;
    const service = new SchedulerService(
      dbStub,
      async (agentId) => makeTarget({ id: agentId, name: agentId, endpoint: `http://localhost/${agentId}` }),
      { dispatchConcurrency: 2 },
    );

    await service.tick();

    expect(fetchSpy).toHaveBeenCalledTimes(agentIds.length);
    expect(maxActiveFetches).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/*  synthesizeForceHeartbeat                                           */
/* ------------------------------------------------------------------ */

describe('synthesizeForceHeartbeat', () => {
  it('produces an in-memory heartbeat definition compatible with the dispatcher', () => {
    const def = synthesizeForceHeartbeat('agent_999', 'guinea-pig', 1_700_000_000);

    expect(def.kind).toBe('heartbeat');
    expect(def.source_type).toBe('yaml');
    expect(def.source_key).toBe('heartbeat:agent_999');
    expect(def.message).toBe(HEARTBEAT_GENERIC_MESSAGE);
    expect(def.sender).toBe('heartbeat');
    expect(def.delivery_mode).toBe('internal');
    expect(def.interval_seconds).toBe(60); // min allowed; placeholder since unpersisted
    expect(def.id.startsWith('force_hb_')).toBe(true); // distinguishable from real rows
  });

  it('builds a payload via the helper that sets schedule.manual=true', () => {
    const def = synthesizeForceHeartbeat('agent_999', 'guinea-pig', 1_700_000_000);
    const payload = buildSchedulePayload(def, 'interval:1700000001', { manual: true });
    expect(payload.schedule.id).toBe('force_hb_agent_999');
    expect(payload.schedule.manual).toBe(true);
    expect(payload.message).toBe(HEARTBEAT_GENERIC_MESSAGE);
  });
});

/* ================================================================== */
/*  Slice 3: HARD test coverage (operator risk note)                   */
/*                                                                     */
/*  These tests intentionally drive both the scheduler-tick dispatch   */
/*  path and the manual-fire path through real method calls (no        */
/*  module-internal mocks) and compare the *actual bytes the agent     */
/*  receives* via a spy on globalThis.fetch. This is the parity        */
/*  guarantee that operator-fired wakes are indistinguishable from     */
/*  scheduled wakes except in the documented fields.                   */
/* ================================================================== */

/**
 * Build a forbidden-method Proxy that throws if any DB method that
 * could mutate scheduler cadence or consume `max_runs` is invoked.
 * Used to enforce the "no DB writes, no maxBeats consumption" contract
 * end-to-end without needing a real Db.
 */
function makeNoMutationDbStub(): Db {
  const forbidden = new Set([
    'insertRun',
    'updateRunStatus',
    'countRuns',
    'upsertDefinition',
    'replaceTargets',
    'listTargets',
    'listActiveDefinitions',
    'deleteBySource',
  ]);
  const schedulesGuard = new Proxy({}, {
    get(_t, prop: string) {
      if (forbidden.has(prop)) {
        return () => {
          throw new Error(`slice-3 guard: forbidden DB method invoked: schedules.${prop}`);
        };
      }
      return undefined;
    },
  });
  return { schedules: schedulesGuard } as unknown as Db;
}

describe('slice-3: HARD payload parity (scheduled vs manual)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('scheduled-tick payload and manual-fire payload differ ONLY in scheduledKey, manual flag, and mode label', async () => {
    const def = makeHeartbeatDef();
    const target = makeTarget();

    // ── Scheduled-tick path ───────────────────────────────────────
    // The scheduler tick invokes `dispatcher.dispatch(def, target,
    // scheduledKey, linkedTasks)` (scheduler-service.ts:114). We call
    // the same method here with no opts, which is the exact byte path
    // a real beat takes.
    const dispatcher = new ScheduleDispatcher();
    const scheduledRes = await dispatcher.dispatch(def, target, 'interval:1700000300');
    expect(scheduledRes.success).toBe(true);

    const scheduledFetchInit = fetchSpy.mock.calls[0]![1] as RequestInit;
    const scheduledUrl = fetchSpy.mock.calls[0]![0] as string;
    const scheduledPayload = JSON.parse(scheduledFetchInit.body as string);

    fetchSpy.mockClear();

    // ── Manual-fire path ─────────────────────────────────────────
    // Drive the real SchedulerService.fireManual code path. It uses
    // the same dispatcher internally, but the entry point is the one
    // the CLI `/heartbeat fire` subcommand calls.
    const service = new SchedulerService(makeNoMutationDbStub(), async () => null);
    const manualRes = await service.fireManual(def, target);
    expect(manualRes.success).toBe(true);

    const manualFetchInit = fetchSpy.mock.calls[0]![1] as RequestInit;
    const manualUrl = fetchSpy.mock.calls[0]![0] as string;
    const manualPayload = JSON.parse(manualFetchInit.body as string);

    // ── Hard parity assertion ────────────────────────────────────
    // The same agent endpoint is hit by both paths.
    expect(manualUrl).toBe(scheduledUrl);
    // HTTP method + content-type identical.
    expect(manualFetchInit.method).toBe(scheduledFetchInit.method);
    expect((manualFetchInit.headers as Record<string, string>)['Content-Type'])
      .toBe((scheduledFetchInit.headers as Record<string, string>)['Content-Type']);

    // Strip the three documented allowed deviations from each payload
    // and assert structural equality on what remains.
    const stripAllowedDeviations = (p: Record<string, any>) => {
      const { mode, ...rest } = p;
      const { scheduledKey, manual, ...scheduleRest } = rest.schedule;
      // Reference-touch to satisfy noUnusedLocals; the values are
      // discarded on purpose — those are the allowed-to-differ fields.
      void mode;
      void scheduledKey;
      void manual;
      return { ...rest, schedule: scheduleRest };
    };

    expect(stripAllowedDeviations(manualPayload))
      .toEqual(stripAllowedDeviations(scheduledPayload));

    // Sanity: the allowed-difference fields are exactly what we expect.
    //   - schedule.manual is `true` for manual, absent for scheduled
    //   - schedule.scheduledKey is whatever each path chose
    //   - mode label is permitted to differ but in this impl it does not
    expect(manualPayload.schedule.manual).toBe(true);
    expect(scheduledPayload.schedule).not.toHaveProperty('manual');
    expect(manualPayload.schedule.scheduledKey).not.toBe(scheduledPayload.schedule.scheduledKey);

    // ── Negative parity assertions ───────────────────────────────
    // Any drift in fields the cto did NOT list as allowed-to-differ
    // would silently produce divergent agent behavior, so spell out
    // each load-bearing field individually.
    expect(manualPayload.from).toBe(scheduledPayload.from);
    expect(manualPayload.message).toBe(scheduledPayload.message);
    expect(manualPayload.schedule.id).toBe(scheduledPayload.schedule.id);
    expect(manualPayload.schedule.kind).toBe(scheduledPayload.schedule.kind);
    expect(manualPayload.schedule.title).toBe(scheduledPayload.schedule.title);
  });

  it('parity holds for calendar schedules with linkedTasks too', async () => {
    // The dispatcher tick path passes linkedTasks; the manual path
    // never sets them. Parity here is asserted only over fields that
    // are present in both — linkedTasks is implicitly an allowed
    // deviation when one side wouldn't carry it, but we still want to
    // verify the shared shape stays identical.
    const def = makeHeartbeatDef({
      kind: 'calendar',
      delivery_mode: 'talk',
      sender: 'schedule',
    });
    const target = makeTarget();

    const dispatcher = new ScheduleDispatcher();
    await dispatcher.dispatch(def, target, 'calendar:2026-05-12@32400', [
      { name: 't', title: 'do thing', status: 'todo', owner: null, team: null },
    ]);
    const scheduledPayload = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );

    fetchSpy.mockClear();

    const service = new SchedulerService(makeNoMutationDbStub(), async () => null);
    await service.fireManual(def, target);
    const manualPayload = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );

    // Same agent endpoint resolved from delivery_mode='talk' (talkPath).
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain('/talk');

    // Core schedule identity preserved across the two paths.
    expect(manualPayload.schedule.id).toBe(scheduledPayload.schedule.id);
    expect(manualPayload.schedule.kind).toBe(scheduledPayload.schedule.kind);
    expect(manualPayload.schedule.title).toBe(scheduledPayload.schedule.title);
    expect(manualPayload.from).toBe(scheduledPayload.from);
    expect(manualPayload.message).toBe(scheduledPayload.message);
  });
});

describe('slice-3: manual fire does NOT consume max_runs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('fires N times against a def with max_runs:1 without ever invoking countRuns', async () => {
    // The Proxy guard throws on `countRuns`. If the scheduler-tick
    // max_runs check ever leaked into the manual path, this would
    // raise instead of silently passing.
    const service = new SchedulerService(makeNoMutationDbStub(), async () => null);
    const def = makeHeartbeatDef({ max_runs: 1 });
    const target = makeTarget();

    for (let i = 0; i < 5; i++) {
      const r = await service.fireManual(def, target);
      expect(r.success).toBe(true);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});

describe('slice-3: --force end-to-end via synthesizeForceHeartbeat -> fireManual', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('feeds a synthesized definition into the real fire path and emits a manual payload', async () => {
    // Simulates the CLI `/heartbeat fire <agent> --force` flow for an
    // agent that has no heartbeat schedule on record.
    const def = synthesizeForceHeartbeat('agent_fresh', 'fresh-victim');
    const service = new SchedulerService(makeNoMutationDbStub(), async () => null);
    const target = makeTarget({ id: 'agent_fresh', name: 'fresh-victim' });

    const result = await service.fireManual(def, target);
    expect(result.success).toBe(true);

    const url = fetchSpy.mock.calls[0]![0] as string;
    const payload = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );

    // Synthesized definition lands on the agent's /schedule endpoint
    // (delivery_mode='internal').
    expect(url).toMatch(/\/schedule$/);
    // The payload carries the generic heartbeat message + manual flag.
    expect(payload.message).toBe(HEARTBEAT_GENERIC_MESSAGE);
    expect(payload.schedule.manual).toBe(true);
    expect(payload.schedule.id).toBe('force_hb_agent_fresh');
    expect(payload.schedule.kind).toBe('heartbeat');
    expect(payload.schedule.scheduledKey).toMatch(/^interval:\d+$/);
  });
});
