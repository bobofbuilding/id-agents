// SPDX-License-Identifier: MIT
/**
 * Agent Manager (DB-backed)
 *
 * Persistent manager that stores agents/metadata in Postgres with multi-network scoping.
 * Runtime (live HTTP servers) still live in-memory, but all durable state is in the DB.
 *
 * Wallet management: agents no longer have individual wallets stored in the DB.
 * Onchain operations use either an OWS wallet (OWS_REGISTRAR_WALLET) or raw key (PRIVATE_KEY).
 * Per-agent keys can be provided via .env.<agent_id> files in the repo root.
 */

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, openSync, closeSync } from 'fs';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import yaml from 'js-yaml';
import { AgentRestServer } from './agent-rest-server.js';
import { registerOnIdChain, createSubnameOnIdChain, setMultiChainAddresses } from './onchain/idchain-register.js';
import { defaultDeliverFn, redactSshTarget, type DeliverFn } from './lib/ssh-deliver.js';
import { probeRemoteAgent, defaultHealthProbeFn, type HealthProbeFn } from './lib/remote-heartbeat.js';
import { filterClaudeEnvVars } from './lib/env-hygiene.js';
import { LocalModelGate, isLocalModelRuntime } from './lib/local-model-gate.js';
import { ccCapabilities } from './control-center/manifest.js';
import { loadMasterKey, deriveKeyAtIndex } from './lib/skillmesh-key-manager.js';
import { type Db } from './db/db-service.js';
import type { AgentRow, QueryRow, ScheduleDefinitionRow, TaskRow } from './db/types.js';
import fetch from 'node-fetch';
import type { PluginConfig, DeployConfig, HeartbeatConfig, CalendarSpec, ScheduleDeliveryMode, OrgConfig, RuntimeCredentialPoolConfig } from './config-parser.js';
import {
  processConfig,
  copyAgentDirOverlay,
  copyHeartbeatMd,
  copyLibraryAgentOverlay,
  appendLibraryPersonaToAgentsMd,
  writePersonalityFile,
  INSTRUCTIONS_SIDECAR,
} from './config-parser.js';
import {
  createLibrarySkill,
  deleteLibrarySkill,
  getLibraryAgent,
  getLibraryPlugin,
  getLibrarySkill,
  getLibraryTeam,
  listLibraryAgents,
  listLibraryPlugins,
  listLibrarySkills,
  listLibraryTeams,
  resolveDefaultLibraryRoot,
} from './lib/library-inventory.js';
import { inferEntityEdges } from './lib/entity-edge-inference.js';
import {
  installLibraryTeam,
  parseSelector,
} from './lib/library-install.js';
import { getLibraryPaths } from './lib/agent-library.js';
import { PROTOCOL_DEFAULTS } from './protocol-defaults.js';
import { computeSyncPlan, formatSyncSummary, formatSyncVerbose } from './sync.js';
import { validateName } from './name-validation.js';
import {
  detectDefaultCoderRuntimeDrift,
  stripDefaultCoderRuntimeMetadata,
} from './default-coder-drift.js';
import {
  appendTaskBriefFieldsToDescription,
  getBittreesContributorPriority,
  getTaskBriefValidationMode,
  shouldBlockTaskBrief,
  shouldBlockTaskCompletion,
  validateTaskBrief,
  validateTaskCompletionPacket,
  type TaskBriefValidationInput,
  type TaskBriefValidationResult,
  type TaskCompletionValidationResult,
} from './task-brief-validation.js';
import {
  emitQueryDelivered,
  emitQueryExpired,
  emitQueryFailed,
  emitTaskClaimed,
  emitTaskCompleted,
  emitTaskRefreshed,
  emitTaskTriaged,
  recordCheckinCreated,
} from './wakeup-service/event-producer.js';
import { RetentionService } from './wakeup-service/retention.js';
import { CheckinService } from './checkins/checkin-service.js';
import {
  DEFAULT_CLOSE_WHEN,
  DEFAULT_INTERVAL_SECONDS,
  buildCheckinResponse,
  clampNote,
  generateCheckinId,
  isValidPriority,
  parseDurationSeconds,
  parseStatusFilter,
} from './checkins/checkin-api-helpers.js';
import { closeLinkedCheckinsForTerminalTask } from './checkins/checkin-autoclose.js';
import type { CheckinRow } from './db/types.js';
import { parseAgentRef, normalizeAlias, buildAmbiguityWarning, type AgentMatch } from './core/agent-identifier.js';
import { resolveNewsTrigger } from './core/messaging-service.js';
import {
  extractLearningLoopCapture,
  normalizeLearningLoopCapture,
  type LearningLoopCapture,
} from './core/learning-loop-capture.js';
import type { HarnessType } from './harness/types.js';
import { SchedulerService } from './scheduling/scheduler-service.js';
import { heartbeatToSchedule, calendarToSchedule, validateIntervalSeconds, HEARTBEAT_GENERIC_MESSAGE } from './scheduling/schedule-config.js';
import {
  getAvailableRuntimes,
  getDefaultModelForRuntime,
  getDefaultRuntime,
  getRuntimePaths,
  isRemoteEndpointRuntime,
  isProviderRuntimeSpecifier,
  isRuntimeId,
  isSupportedRuntimeSpecifier,
  resolveRuntime,
  runtimeIssueHint,
  validateRuntimePreflight,
} from './runtime/registry.js';
import { resolveModelAlias } from './core/model-aliases.js';
export { MODEL_ALIASES, resolveModelAlias } from './core/model-aliases.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MAX_DOING_TASKS = 30;
const DEFAULT_STALLED_TASK_MAX_PROBES = 3;

interface StalledProbeState {
  lastAt: number;
  attempts: number;
  escalatedAt: number | null;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    if (match[1] !== undefined || match[2] !== undefined) {
      // Quoted span: full backslash-unescape (mirrors the qArg producer in idctl,
      // so backslashes/quotes in content round-trip instead of compounding).
      tokens.push((match[1] ?? match[2]).replace(/\\(.)/g, '$1'));
    } else {
      tokens.push((match[3] ?? '').replace(/\\(["'])/g, '$1'));
    }
  }
  return tokens;
}

function normalizeConfigSkills(skills: unknown): string[] | undefined {
  if (!Array.isArray(skills)) return undefined;

  const normalized = Array.from(
    new Set(
      skills
        .filter((skill): skill is string => typeof skill === 'string')
        .map(skill => skill.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    ),
  );

  return normalized.length > 0 ? normalized : undefined;
}

// REST-AP catalog types
interface RestAPCatalog {
  restap_version?: string;
  agent?: {
    name?: string;
    description?: string;
  };
  endpoints?: {
    talk?: string;
    news?: string;
    news_post?: string;
    schedule?: string;
  } | Array<{
    path?: string;
    method?: string;
  }>;
  capabilities?: Array<{
    id: string;
    method: string;
    endpoint: string;
  }>;
}


/**
 * Wakeup-service topic aliases. The `GET /events` route accepts both
 * concrete topics (e.g. `query:delivered`) and the aliases below, which
 * expand server-side into their concrete topic set. Source of truth:
 * output/wakeup-service-design.md → "Topic set for v1" / "Alias expansions".
 */
const TOPIC_ALIASES: Record<string, readonly string[]> = {
  'query:terminal': ['query:delivered', 'query:failed', 'query:expired'],
  'task:status': ['task:created', 'task:claimed', 'task:completed', 'task:refreshed', 'task:triaged'],
  'agent:lifecycle': ['agent:started', 'agent:stopped', 'agent:rebuild'],
};

function expandTopicAliases(topics: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of topics) {
    const expansion = TOPIC_ALIASES[t];
    if (expansion) {
      for (const concrete of expansion) out.add(concrete);
    } else {
      out.add(t);
    }
  }
  return Array.from(out);
}

/**
 * /talk-to auto-attach default cadence: 10 minutes. Tighter than the
 * generic checkin default (15m) because delegated work justifies more
 * frequent inspection on the dispatcher's side.
 */
const AUTO_ATTACH_DEFAULT_INTERVAL_SECONDS = 600;

interface AutoAttachFlagsResult {
  disabled: boolean;
  intervalSeconds: number | null;
  maxIterations: number | null;
  error?: string;
}

/**
 * Parse the three /talk-to auto-attach flags from the request body:
 *   - `no_checkin: true`           (--no-checkin)
 *   - `checkin: <duration|seconds>` (--checkin 30m / --checkin 1800)
 *   - `checkin_iters: <N>`          (--checkin-iters 5)
 *
 * Returns either a fully-resolved spec or an `error` code the route handler
 * can return as a 400 body. The returned `intervalSeconds` is null when
 * the caller did not override the default.
 */
function parseAutoAttachFlags(body: Record<string, unknown>): AutoAttachFlagsResult {
  const result: AutoAttachFlagsResult = {
    disabled: body.no_checkin === true,
    intervalSeconds: null,
    maxIterations: null,
  };

  if (body.checkin !== undefined && body.checkin !== null) {
    const parsed = parseDurationSeconds(body.checkin as unknown);
    if (parsed === null) {
      result.error = 'invalid_checkin_duration';
      return result;
    }
    result.intervalSeconds = parsed;
  }

  if (body.checkin_iters !== undefined && body.checkin_iters !== null) {
    const n = Number(body.checkin_iters);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      result.error = 'invalid_checkin_iters';
      return result;
    }
    result.maxIterations = n;
  }

  return result;
}

function makeAutoAttachError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): Error & { status: number; code: string; details?: Record<string, unknown> } {
  const err = new Error(code) as Error & { status: number; code: string; details?: Record<string, unknown> };
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

function getCatalogEndpoint(catalog: RestAPCatalog, key: 'talk' | 'news' | 'schedule'): string | null {
  if (catalog.endpoints && !Array.isArray(catalog.endpoints)) {
    return catalog.endpoints[key] || null;
  }
  if (Array.isArray(catalog.endpoints)) {
    const path = `/${key}`;
    const match = catalog.endpoints.find((entry) => entry.path === path);
    return match?.path || null;
  }
  return null;
}

// Cache for REST-AP catalogs (endpoint -> catalog)
const restapCatalogCache = new Map<string, { catalog: RestAPCatalog; fetchedAt: number }>();
const CATALOG_CACHE_TTL = 60000; // 1 minute cache

// Ephemeral in-memory ring of agent activity (tool/file steps), fed by agents'
// fire-and-forget POST /activity/record and read back via GET /activity. Lost on
// restart by design — it only matters while a dispatch is live.
interface ActivityItem { seq: number; at: number; agent: string; team: string; kind: string; tool?: string; summary: string; queryId?: string }
const ACTIVITY_CAP = 3000;
const ACTIVITY_RING: { items: ActivityItem[]; seq: number } = { items: [], seq: 0 };

/**
 * Discover REST-AP endpoints from an agent's catalog
 * @param baseEndpoint The agent's base endpoint (e.g., http://localhost:4101)
 * @returns The discovered endpoints or defaults if catalog unavailable
 */
export async function discoverRestAPEndpoints(baseEndpoint: string): Promise<{ talk: string; news: string; schedule?: string | null }> {
  // After the manager-collapse refactor, "interactive" agents (e.g. manager-<team> rows)
  // have endpoint='' and port=0. A few caller paths fall back to `http://localhost:${port}`
  // which produces `http://localhost:0`, then catalog discovery fails noisily. Those rows
  // never had a per-agent HTTP server, so silently return defaults instead of fetching.
  if (!baseEndpoint || /:0(\/|$)/.test(baseEndpoint)) {
    return { talk: '/talk', news: '/news', schedule: null };
  }

  const now = Date.now();
  const cached = restapCatalogCache.get(baseEndpoint);

  // Return cached catalog if still valid
  if (cached && (now - cached.fetchedAt) < CATALOG_CACHE_TTL) {
    return {
      talk: getCatalogEndpoint(cached.catalog, 'talk') || '/talk',
      news: getCatalogEndpoint(cached.catalog, 'news') || '/news',
      schedule: getCatalogEndpoint(cached.catalog, 'schedule') || null
    };
  }

  try {
    const catalogUrl = `${baseEndpoint.replace(/\/+$/, '')}/.well-known/restap.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(catalogUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const catalog = await response.json() as RestAPCatalog;
      restapCatalogCache.set(baseEndpoint, { catalog, fetchedAt: now });

      return {
        talk: getCatalogEndpoint(catalog, 'talk') || '/talk',
        news: getCatalogEndpoint(catalog, 'news') || '/news',
        schedule: getCatalogEndpoint(catalog, 'schedule') || null
      };
    }
  } catch (err) {
    // Catalog fetch failed, use defaults
    console.log(`[REST-AP] Could not fetch catalog from ${baseEndpoint}: ${(err as Error).message}`);
  }

  // Default REST-AP endpoints
  return { talk: '/talk', news: '/news', schedule: null };
}

type AgentRegistryId = {
  chainId: number;
  registryAddress: string;
};

type AgentMetadata = Record<string, any> & {
  name?: string;
  service_type?: string;  // e.g., "REST-AP", "MCP", "A2A"
  service?: string;       // The service URL (e.g., https://idbot.live/{id})
  agent_account?: string;
  primaryLead?: boolean;
};

function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function envFlagDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(String(value || '').trim());
}

function pluginLooksLikeSkillmesh(plugin: unknown): boolean {
  if (!plugin || typeof plugin !== 'object') return false;
  const record = plugin as Record<string, unknown>;
  return [record.name, record.path]
    .filter((value): value is string => typeof value === 'string')
    .some(value => /(^|[/_.-])skillmesh([/_.-]|$)/i.test(value));
}

// WebSocket client tracking
interface WSClient {
  ws: WebSocket;
  teamId: string;
  teamName: string;
  authenticated: boolean;
}

// Pending waiter for /talk-to replies - persists until reply arrives
interface QueryWaiter {
  resolve: (result: { from: string; message: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

interface BrainVolunteerContext {
  bundles: Array<{
    query?: string;
    entities?: Array<{ id?: string; name?: string; type?: string }>;
    facts?: Array<{ id?: number; entity_id?: string; field?: string; value?: unknown; source?: string }>;
    textUnits?: Array<{ id?: number; title?: string; content?: string; source_kind?: string; source_id?: string }>;
  }>;
  cited?: {
    entity_ids?: string[];
    fact_ids?: number[];
    text_unit_ids?: number[];
    canonical_source_ids?: string[];
    source_origins?: Record<string, string[]>;
  };
  timelineEventId?: number;
  context_package_id?: number | null;
  contextPackageId?: number | null;
  task_id?: string | null;
  instructions?: BrainInstruction[];
}

interface BrainInstruction {
  source_id: string;
  memory_id: number;
  key: string;
  content: string;
  scope: {
    project?: string;
    task_id?: string;
    session_id?: string;
    user_id?: string;
    turn_id?: string;
  };
}

interface ProcessInspection {
  pid: number;
  ppid: number | null;
  argv0: string;
  commandLine: string;
}

type RuntimeLaneKind = 'subscription' | 'metered-api';

interface RuntimeCredentialLane {
  id: string;
  runtime: HarnessType;
  kind: RuntimeLaneKind;
  env?: Record<string, string>;
}

interface ProviderRuntimeAssignment {
  lane: string;
  name: string;
  kind?: string;
  baseUrl: string;
  keyEnv?: string;
  apiKey?: string;
}

function providerRuntimeErrorStatus(message: string): number {
  return /provider runtime lane|requires baseUrl/i.test(message) ? 400 : 500;
}

interface RuntimeLaneCooldown {
  laneId: string;
  runtime: HarnessType;
  kind: RuntimeLaneKind;
  coolingUntilMs: number;
  observedAtMs: number;
  reason: string;
  teamId?: string;
  agentId?: string;
  agentName?: string;
  queryId?: string;
  resetText?: string;
  message?: string;
}

interface ValidatorRecommendationLoopConfig {
  enabled: boolean;
  owners: string[];
  lead: string;
  objective: string;
  trigger: 'validation_task_completed';
  updatedAt: number | null;
}

const DEFAULT_VALIDATOR_RECOMMENDATION_OBJECTIVE =
  `Default-team coder and researcher own the post-validation recommendation loop. ` +
  `When either validator completes validation of work produced by another team, they must produce a concise next-step recommendation packet for lead. ` +
  `The packet must keep approval separate from follow-up work: approval closes the validated task, while recommendations become new tracked objectives. ` +
  `Lead reviews approved recommendations and relays each objective to the ideal team lead, who decomposes the objective into tasks for that team's dependent members.`;
const VALIDATOR_RECOMMENDATION_LOOP_TRIGGERED = 'validator:recommendation-loop';

const DEFAULT_VALIDATOR_RECOMMENDATION_LOOP: ValidatorRecommendationLoopConfig = {
  enabled: false,
  owners: ['coder', 'researcher'],
  lead: 'lead',
  objective: DEFAULT_VALIDATOR_RECOMMENDATION_OBJECTIVE,
  trigger: 'validation_task_completed',
  updatedAt: null,
};

export class AgentManagerDb {
  private managementApp: express.Application;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private wsClients: Set<WSClient> = new Set();
  private baseWorkDir: string;
  private db: Db;
  private runningServers: Map<string, AgentRestServer> = new Map(); // key: `${teamId}:${agentId}`
  private agentRole: 'manager' | 'worker' = 'manager';
  private defaultConfig: DeployConfig['defaults'] | null = null;
  private defaultDeploymentConfig: DeployConfig | null = null;
  private schedulerService: SchedulerService | null = null;
  private queryWaiters: Map<string, QueryWaiter> = new Map(); // key: query_id
  private queryBrainContext: Map<string, BrainVolunteerContext> = new Map(); // key: query_id
  // Long-poll waiters for GET /query/:id?wait=<seconds>. Wakes when a daemon-side
  // query write (news.in_reply_to completion, agent-stop cancel) transitions
  // the row. Sweeper-expired rows rely on the request's wait-timeout re-read.
  private queryStatusWaiters: Map<string, Set<() => void>> = new Map(); // key: `${teamId}:${queryId}`
  private healthStatus: Map<string, { status: 'online' | 'offline' | 'unknown'; lastCheck: number }> = new Map(); // key: `${teamId}:${agentId}`
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private remoteProbeInterval: NodeJS.Timeout | null = null;
  private querySweeperInterval: NodeJS.Timeout | null = null;
  private stalledSweepInterval: NodeJS.Timeout | null = null;
  private runtimeLaneCooldowns: Map<string, RuntimeLaneCooldown> = new Map();
  private runtimeCredentialPoolByTeam: Map<string, RuntimeCredentialPoolConfig> = new Map();
  private defaultRuntimeCredentialPool: RuntimeCredentialPoolConfig | null = null;
  private providerRuntimeAssignments: Map<string, ProviderRuntimeAssignment> = new Map();
  private runtimeFailoverRetryOf: Map<string, string> = new Map();
  private agentLifecycleLocks: Map<string, Promise<void>> = new Map();
  private validatorRecommendationLoopLocks: Map<string, Promise<void>> = new Map();
  private stalledNudges = new Map<string, StalledProbeState>(); // probe key -> throttle/count state
  private retentionService: RetentionService | null = null;
  private checkinService: CheckinService | null = null;
  /**
   * Stuck-query sweeper timeout, in minutes. Queries whose status is still
   * pending/processing this long after their `created` timestamp are assumed
   * to belong to a crashed agent and are marked 'expired'.
   * Coordinated/long tasks (a lead delegating to teammates) can legitimately
   * run for many minutes, so the default is generous (120m); override with
   * ID_QUERY_EXPIRY_MINUTES. (Crashed queries just linger this long, harmless.)
   */
  private readonly QUERY_EXPIRY_MINUTES = (() => {
    const n = Number(process.env.ID_QUERY_EXPIRY_MINUTES);
    return Number.isFinite(n) && n > 0 ? n : 120;
  })();
  private logBuffer: Array<{ ts: number; msg: string }> = [];
  private readonly LOG_BUFFER_SIZE = 500;
  private managementPort: number = 4100;
  /** Injectable SSH delivery function — override in tests. */
  private deliverFn: DeliverFn = defaultDeliverFn;
  /** Injectable onchain registration function — override in tests. */
  private registerOnIdChainFn: typeof registerOnIdChain = registerOnIdChain;
  /** Injectable HTTP probe function — override in tests to mock remote health checks. */
  private healthProbeFn: HealthProbeFn = defaultHealthProbeFn;
  /**
   * Library root used by the read-only `/library/*` endpoints. Captured at
   * construction so tests can override without touching process.env. Null
   * means "no library configured" — listings return empty, detail returns 404.
   */
  private libraryRoot: string | null;

  /** Log a manager activity message to the ring buffer (not stdout) */
  private managerLog(msg: string) {
    this.logBuffer.push({ ts: Date.now(), msg });
    if (this.logBuffer.length > this.LOG_BUFFER_SIZE) {
      this.logBuffer.shift();
    }
  }

  private getMaxDoingTasks(): number {
    const raw = process.env.ID_MAX_DOING_TASKS;
    const parsed = raw ? Number(raw) : DEFAULT_MAX_DOING_TASKS;
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_DOING_TASKS;
  }

  private getMaxStalledTaskProbes(): number {
    const raw = process.env.STALL_MAX_PROBES;
    const parsed = raw ? Number(raw) : DEFAULT_STALLED_TASK_MAX_PROBES;
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_STALLED_TASK_MAX_PROBES;
  }

  private canRunStalledProbe(key: string, nowMs: number, renudgeMs: number, maxProbes: number): boolean {
    const state = this.stalledNudges.get(key);
    if (!state) return true;
    if (state.attempts >= maxProbes) return false;
    return nowMs - state.lastAt >= renudgeMs;
  }

  private markStalledProbe(key: string, nowMs: number): number {
    const prev = this.stalledNudges.get(key);
    const next: StalledProbeState = {
      lastAt: nowMs,
      attempts: (prev?.attempts ?? 0) + 1,
      escalatedAt: prev?.escalatedAt ?? null,
    };
    this.stalledNudges.set(key, next);
    return next.attempts;
  }

  private canEscalateStalledProbe(key: string, maxProbes: number): boolean {
    const state = this.stalledNudges.get(key);
    return !!state && state.attempts >= maxProbes && state.escalatedAt === null;
  }

  private markStalledProbeEscalated(key: string, nowMs: number): void {
    const prev = this.stalledNudges.get(key);
    this.stalledNudges.set(key, {
      lastAt: prev?.lastAt ?? nowMs,
      attempts: prev?.attempts ?? 0,
      escalatedAt: nowMs,
    });
  }

  private async countDoingTasks(teamId: string): Promise<number> {
    const doing = await this.db.tasks.list({ status: 'doing', teamId });
    return doing.length;
  }

  private async hasDoingTaskRoom(teamId: string): Promise<boolean> {
    return (await this.countDoingTasks(teamId)) < this.getMaxDoingTasks();
  }

  private async doingTaskLimitMessage(teamId: string): Promise<string> {
    const limit = this.getMaxDoingTasks();
    const count = await this.countDoingTasks(teamId);
    return `Doing column is full (${count}/${limit}); task remains in todo until a doing slot opens`;
  }

  private validateIncomingTaskBrief(
    input: TaskBriefValidationInput,
    options: { immediateExecution?: boolean } = {},
  ): { validation: TaskBriefValidationResult; blocked: boolean } {
    const validation = validateTaskBrief(input, getTaskBriefValidationMode());
    const priority = getBittreesContributorPriority(input, this.taskBriefGuardText(input));
    if (options.immediateExecution && (priority === 'low/backlog' || priority === 'reject')) {
      const reasonCode = priority === 'reject'
        ? 'rejected_bittrees_relevance_live_dispatch'
        : 'low_bittrees_relevance_live_dispatch';
      return {
        validation: {
          ...validation,
          ok: false,
          decision: 'goal_triage_required',
          route: 'goal-triage',
          dispatch_ready: false,
          invalid: [...new Set([...validation.invalid, 'bittrees_relevance'])],
          message: 'Low/backlog or rejected Bittrees contributor relevance must be routed to backlog, not live delegated work.',
          reason_codes: [...new Set([...validation.reason_codes, reasonCode])],
        },
        blocked: true,
      };
    }
    return {
      validation,
      blocked: shouldBlockTaskBrief(validation, options),
    };
  }

  private validateCompletionPayload(payload: Record<string, unknown>): {
    validation: TaskCompletionValidationResult;
    blocked: boolean;
  } {
    const validation = validateTaskCompletionPacket(payload, getTaskBriefValidationMode());
    return {
      validation,
      blocked: shouldBlockTaskCompletion(validation),
    };
  }

  private taskBriefInputFromTask(task: TaskRow): TaskBriefValidationInput {
    return {
      title: task.title,
      description: task.description,
    };
  }

  private taskBriefGuardText(input: TaskBriefValidationInput | Record<string, unknown>): string {
    return [
      input.title,
      input.description,
      (input as any).message,
      (input as any).bittrees_relevance,
      (input as any).bittreesRelevance,
      (input as any).bittrees_contributor_relevance,
      (input as any).bittreesContributorRelevance,
      (input as any).relevance,
      (input as any).validation_purpose,
      (input as any).validationPurpose,
      (input as any).parent_task,
      (input as any).parentTask,
      (input as any).parent_task_name,
      (input as any).parentTaskName,
      (input as any).parent_ref,
      (input as any).parentRef,
    ]
      .map((value) => typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value) : '')
      .filter(Boolean)
      .join('\n');
  }

  private firstBriefString(input: TaskBriefValidationInput | Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = (input as any)[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private briefLabel(text: string, label: string): string | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^\\n]+)`, 'i'));
    return match?.[1]?.trim() || null;
  }

  private normalizeGuardKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9#]+/g, '-').replace(/^-+|-+$/g, '');
  }

  private defaultValidatorName(agent: AgentRow | null | undefined): string | null {
    if (!agent) return null;
    const alias = typeof (agent.metadata as any)?.alias === 'string' ? (agent.metadata as any).alias : '';
    const names = [agent.name, alias].map((s) => s.toLowerCase());
    if (names.includes('coder')) return 'coder';
    if (names.includes('researcher')) return 'researcher';
    return null;
  }

  private validationChildKey(
    input: TaskBriefValidationInput | Record<string, unknown>,
    validatorName?: string | null,
  ): { parentRef: string; purpose: string } | null {
    const text = this.taskBriefGuardText(input);
    if (!/\b(validat(e|ion|or)|review|approval|approve)\b/i.test(text)) return null;
    const parent = this.firstBriefString(input, [
      'parent_task',
      'parentTask',
      'parent_task_name',
      'parentTaskName',
      'parent_ref',
      'parentRef',
      'validates_task',
      'validatesTask',
    ])
      || this.briefLabel(text, 'Parent task')
      || this.briefLabel(text, 'Validation parent')
      || this.briefLabel(text, 'Validates task');
    if (!parent) return null;
    const purpose = this.firstBriefString(input, ['validation_purpose', 'validationPurpose'])
      || this.briefLabel(text, 'Validation purpose')
      || (validatorName ? `${validatorName}-validation` : 'validation');
    return {
      parentRef: this.normalizeGuardKey(parent),
      purpose: this.normalizeGuardKey(purpose),
    };
  }

  private async validateValidatorChildTaskCreation(params: {
    teamId: string;
    input: TaskBriefValidationInput | Record<string, unknown>;
    fromAgent?: AgentRow | null;
    targetAgent?: AgentRow | null;
  }): Promise<{ status: number; code: string; message: string; existingTask?: string } | null> {
    const key = this.validationChildKey(params.input, this.defaultValidatorName(params.targetAgent));
    if (!key) return null;

    if (this.defaultValidatorName(params.fromAgent)) {
      return {
        status: 409,
        code: 'validator_task_recursion_blocked',
        message: 'Validator tasks must not create validator tasks.',
      };
    }

    const tasks = await this.db.tasks.list({ teamId: params.teamId }).catch(() => [] as TaskRow[]);
    for (const candidate of tasks) {
      if (candidate.status === 'done') continue;
      const owner = candidate.owner ? await this.db.agents.getById(candidate.owner).catch(() => null) : null;
      const candidateKey = this.validationChildKey(this.taskBriefInputFromTask(candidate), this.defaultValidatorName(owner));
      if (!candidateKey) continue;
      if (candidateKey.parentRef === key.parentRef && candidateKey.purpose === key.purpose) {
        return {
          status: 409,
          code: 'duplicate_validator_child_task',
          message: `Duplicate validator child task for parent "${key.parentRef}" and purpose "${key.purpose}" already exists: ${candidate.name}.`,
          existingTask: candidate.name,
        };
      }
    }

    return null;
  }

  private taskCompletionDelegationExemption(payload?: Record<string, unknown>): { exempt: boolean; reason?: string } {
    if (!payload) return { exempt: false };
    const noDelegationReason = typeof payload.no_delegation_reason === 'string' && payload.no_delegation_reason.trim()
      ? payload.no_delegation_reason.trim()
      : typeof payload.noDelegationReason === 'string' && payload.noDelegationReason.trim()
        ? payload.noDelegationReason.trim()
        : null;
    if (noDelegationReason) return { exempt: true, reason: noDelegationReason };
    if (payload.advisory_query === true || payload.advisoryQuery === true) {
      return { exempt: true, reason: 'advisory_query' };
    }
    return { exempt: false };
  }

  private canClaimMalformedBriefForRepair(teamName: string, agent: AgentRow, task: TaskRow): boolean {
    if (task.created_by && task.created_by === agent.id) return true;
    if (this.isConfiguredTeamLead(teamName, agent)) return true;
    const name = agent.name.toLowerCase();
    return name.includes('manager') || name.includes('triage') || name.includes('lead') || name.includes('coordinator');
  }

  private normalizeValidatorRecommendationLoopConfig(raw: unknown): ValidatorRecommendationLoopConfig {
    const cfg = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const owners = Array.isArray(cfg.owners)
      ? cfg.owners.map(String).map((s) => s.trim()).filter(Boolean)
      : DEFAULT_VALIDATOR_RECOMMENDATION_LOOP.owners;
    const lead = typeof cfg.lead === 'string' && cfg.lead.trim()
      ? cfg.lead.trim()
      : DEFAULT_VALIDATOR_RECOMMENDATION_LOOP.lead;
    const objective = typeof cfg.objective === 'string' && cfg.objective.trim()
      ? cfg.objective.trim()
      : DEFAULT_VALIDATOR_RECOMMENDATION_LOOP.objective;
    const updatedAt = typeof cfg.updatedAt === 'number' && Number.isFinite(cfg.updatedAt)
      ? cfg.updatedAt
      : null;
    return {
      enabled: cfg.enabled === true,
      owners: owners.length ? owners : DEFAULT_VALIDATOR_RECOMMENDATION_LOOP.owners,
      lead,
      objective,
      trigger: 'validation_task_completed',
      updatedAt,
    };
  }

  private async getValidatorRecommendationLoopConfig(teamId: string): Promise<ValidatorRecommendationLoopConfig> {
    const cfg = await this.db.teams.getConfig(teamId).catch(() => ({} as Record<string, unknown>));
    return this.normalizeValidatorRecommendationLoopConfig(cfg.validatorRecommendationLoop);
  }

  private validatorRecommendationLoopKey(teamId: string, taskUuid: string, ownerAgentId: string): string {
    return `${teamId}:${taskUuid}:${ownerAgentId}`;
  }

  private async withValidatorRecommendationLoopLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.validatorRecommendationLoopLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const gate = previous.catch(() => {}).then(() => current);
    this.validatorRecommendationLoopLocks.set(key, gate);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.validatorRecommendationLoopLocks.get(key) === gate) {
        this.validatorRecommendationLoopLocks.delete(key);
      }
    }
  }

  private async hasValidatorRecommendationLoopTriggered(teamId: string, taskUuid: string, ownerAgentId: string): Promise<boolean> {
    const { rows } = await this.db.adapter.query<{ seq: number | string }>(
      `SELECT seq
         FROM event_log
        WHERE team_id = $1
          AND topic = $2
          AND subject_kind = 'task'
          AND subject_id = $3
          AND actor_agent_id = $4
        ORDER BY seq ASC
        LIMIT 1`,
      [teamId, VALIDATOR_RECOMMENDATION_LOOP_TRIGGERED, taskUuid, ownerAgentId],
    );
    return rows.length > 0;
  }

  private async recordValidatorRecommendationLoopTriggered(params: {
    teamId: string;
    task: TaskRow;
    owner: AgentRow;
    leadName: string;
    completionNote?: string;
    occurredAt: number;
  }): Promise<void> {
    await this.db.events.insert({
      team_id: params.teamId,
      topic: VALIDATOR_RECOMMENDATION_LOOP_TRIGGERED,
      actor_agent_id: params.owner.id,
      subject_kind: 'task',
      subject_id: params.task.uuid,
      occurred_at: params.occurredAt,
      data: {
        task_name: params.task.name,
        task_uuid: params.task.uuid,
        validator: params.owner.name,
        lead: params.leadName,
        trigger: 'validation_task_completed',
        ...(params.task.title ? { title_preview: params.task.title.slice(0, 280) } : {}),
        ...(params.completionNote ? { completion_note_preview: params.completionNote.slice(0, 280) } : {}),
      },
    });
  }

  private isValidationTask(task: TaskRow): boolean {
    const text = `${task.name}\n${task.title}\n${task.description || ''}`.toLowerCase();
    return /\b(validat(e|ion|or)|review|approve|approval)\b/.test(text);
  }

  private isValidatorRecommendationTask(task: TaskRow): boolean {
    const text = `${task.name}\n${task.title}\n${task.description || ''}`.toLowerCase();
    return /\b(validator[-_\s])?recommendation\b/.test(text)
      || /\brecommend-next-steps\b/.test(text)
      || /\bnext-step recommendation\b/.test(text);
  }

  private readonly configuredTeamLeadNames: Record<string, string[]> = {
    'engineering-team': ['engineering-lead'],
    legal: ['general-counsel'],
    'onchain-execution': ['onchain-lead'],
    'ops-team': ['ops-lead'],
    research: ['research-lead'],
    'technology-security': ['security-router'],
  };

  private readonly teamLeadDelegationGraceSeconds = 10 * 60;

  private isConfiguredTeamLead(teamName: string, owner: AgentRow | null | undefined): boolean {
    if (!owner) return false;
    const configured = this.configuredTeamLeadNames[teamName] || [];
    if (configured.includes(owner.name)) return true;
    const role = String((owner.metadata as any)?.role || (owner.metadata as any)?.catalog?.role || '').toLowerCase();
    return /\b(lead|coordinator|router)\b/.test(role) && /\b(lead|counsel|router)\b/.test(owner.name);
  }

  private taskRefsFromCompletionPayload(payload: Record<string, unknown> | undefined): string[] {
    if (!payload) return [];
    const raw = payload.delegated_task_names
      ?? payload.delegatedTaskNames
      ?? payload.child_task_names
      ?? payload.childTaskNames
      ?? payload.child_tasks
      ?? payload.childTasks;
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }

  private async validateTeamLeadDelegationBeforeDone(params: {
    teamId: string;
    teamName: string;
    task: TaskRow;
    payload?: Record<string, unknown>;
  }): Promise<string | null> {
    const owner = params.task.owner
      ? await this.db.agents.getById(params.task.owner).catch(() => null)
      : null;
    if (!this.isConfiguredTeamLead(params.teamName, owner)) return null;
    const exemption = this.taskCompletionDelegationExemption(params.payload);
    if (exemption.exempt) return null;

    const childRefs = this.taskRefsFromCompletionPayload(params.payload);
    if (childRefs.length === 0) {
      return `Team lead objectives require delegated_task_names (or child_task_names) naming at least one completed member-owned child task before completion`;
    }

    for (const childRef of childRefs) {
      const { task: childTask, error } = await this.resolveTaskRef(childRef, params.teamId);
      if (!childTask) {
        return `Delegated child task "${childRef}" not found in ${params.teamName} team${error ? `: ${error}` : ''}`;
      }
      if (childTask.id === params.task.id) {
        return `Delegated child task "${childRef}" cannot be the parent team-lead objective`;
      }
      if (childTask.team_id && childTask.team_id !== params.teamId) {
        return `Delegated child task "${childRef}" is not in the ${params.teamName} team`;
      }
      if (!childTask.owner) {
        return `Delegated child task "${childRef}" must be claimed by a ${params.teamName} member`;
      }
      if (owner && childTask.owner === owner.id) {
        return `Delegated child task "${childRef}" must be owned by a ${params.teamName} member, not ${owner.name}`;
      }
      if (childTask.status !== 'done') {
        return `Delegated child task "${childRef}" must be done before the team-lead objective can be completed`;
      }
    }

    return null;
  }

  private taskMatchesParentRef(candidate: TaskRow, parent: TaskRow): boolean {
    const shortId = parent.uuid ? parent.uuid.replace(/-/g, '').slice(0, 8).toLowerCase() : '';
    const text = `${candidate.name}\n${candidate.title}\n${candidate.description || ''}`.toLowerCase();
    return Boolean(
      text.includes(parent.name.toLowerCase())
      || (shortId && text.includes(shortId))
      || (parent.uuid && text.includes(parent.uuid.toLowerCase())),
    );
  }

  private async findDelegatedChildTasks(task: TaskRow, teamId: string, owner: AgentRow | null): Promise<TaskRow[]> {
    const allTasks = await this.db.tasks.list({ teamId });
    return allTasks.filter((candidate) => {
      if (candidate.id === task.id || !candidate.owner || candidate.owner === owner?.id) return false;
      if (candidate.team_id && candidate.team_id !== teamId) return false;
      if (candidate.created_at < task.created_at) return false;
      if (candidate.status !== 'done' && candidate.status !== 'doing' && candidate.status !== 'todo') return false;
      return candidate.created_by === owner?.id || this.taskMatchesParentRef(candidate, task);
    });
  }

  private async buildDelegationAudit(task: TaskRow, teamId: string, teamName: string | null, owner: AgentRow | null): Promise<Record<string, unknown> | null> {
    if (!teamName || !this.isConfiguredTeamLead(teamName, owner)) return null;
    if (task.status !== 'doing') return null;
    const now = Math.floor(Date.now() / 1000);
    const ageSeconds = Math.max(0, now - task.updated_at);
    const childTasks = await this.findDelegatedChildTasks(task, teamId, owner);
    const childTaskRefs = childTasks.map((child) => child.uuid ? `#${child.uuid.replace(/-/g, '').slice(0, 8)}` : child.name);
    if (childTaskRefs.length > 0) {
      return {
        status: 'ok',
        ownerRole: 'team-lead',
        ageSeconds,
        graceSeconds: this.teamLeadDelegationGraceSeconds,
        childTaskRefs,
      };
    }
    if (ageSeconds < this.teamLeadDelegationGraceSeconds) {
      return {
        status: 'pending-delegation',
        ownerRole: 'team-lead',
        reason: `Lead-owned doing task is within the ${Math.round(this.teamLeadDelegationGraceSeconds / 60)} minute delegation grace window`,
        ageSeconds,
        graceSeconds: this.teamLeadDelegationGraceSeconds,
        childTaskRefs,
      };
    }
    return {
      status: 'needs-delegation',
      ownerRole: 'team-lead',
      reason: `Lead-owned doing task has no detected member-owned child tasks after ${Math.round(this.teamLeadDelegationGraceSeconds / 60)} minutes`,
      ageSeconds,
      graceSeconds: this.teamLeadDelegationGraceSeconds,
      childTaskRefs,
    };
  }

  private async buildLeadDelegationNudge(
    task: TaskRow,
    teamId: string,
    teamName: string,
    owner: AgentRow | null,
    ref: string,
    attempt: number,
    maxProbes: number,
    stalledMinutes: number,
  ): Promise<string | null> {
    const audit = await this.buildDelegationAudit(task, teamId, teamName, owner);
    if (!audit || audit.status !== 'needs-delegation') return null;
    return `Supervision: team-lead task ${ref} ("${task.title}") has no detected member-owned child tasks after ${Math.round(Number(audit.ageSeconds || 0) / 60)}m (delegation probe ${attempt}/${maxProbes}). Create member-owned child tasks with \`/task create ... --owner <teammate>\`, reassign/split the work, or if this is truly advisory close it with \`/task done ${ref} --no-delegation-reason "..." --failure-note "..."\`. Current stalled time: ${stalledMinutes}m.`;
  }

  private async sendInternalNewsTo(teamName: string, to: string, message: string, from: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.managementPort}/news-to`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-id-team': teamName,
        'x-id-admin': '1',
      },
      body: JSON.stringify({ to, from, message }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`/news-to ${to} failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  private validatorRecommendationPrompt(params: {
    task: TaskRow;
    validatorName: string;
    leadName: string;
    objective: string;
    completionNote?: string;
  }): string {
    const ref = `#${params.task.uuid.slice(0, 8)}`;
    return `Event-driven validator recommendation loop triggered.

You are one of the default-team validators and you own the next-step recommendation objective for the validation you just completed.

Loop objective:
${params.objective}

Completed validation task:
- ref: ${ref}
- name: ${params.task.name}
- title: ${params.task.title}
${params.task.description ? `- description: ${params.task.description}\n` : ''}${params.completionNote ? `- completion note: ${params.completionNote}\n` : ''}
Required response:
Create a concise recommendation packet for ${params.leadName}. Keep current-task approval separate from future work. If validation failed, set validation_status to needs-revision or blocked and include required fixes for the applicable team lead. If validation passed, include next_step_recommendations as separate follow-up objectives for lead to relay to the ideal team leads. Team leads then break those objectives into tasks for their own dependent team members.

Validation-loop guardrails:
- Do not create or request validator tasks from this validator task.
- Use one validator pass per parent task and at most one rework cycle.
- If a validator stayed processing after bounded polling and one retry, treat that stalled validation as terminal evidence and close it with a failure note instead of redispatching a replacement automatically.
- Low/backlog or generic recommendations must be routed to backlog, not live child tasks.
- Every live follow-up recommendation must include goal_id, expected_output, acceptance_criteria, validation_path, out_of_scope, backlog_policy, and Bittrees contributor relevance.

Return this JSON shape:
{
  "validation_status": "approved | needs-revision | blocked",
  "summary": "...",
  "validation_budget": {
    "validator_passes_allowed": 1,
    "rework_cycles_allowed": 1,
    "validator_tasks_may_create_validator_tasks": false
  },
  "validator_findings": {
    "${params.validatorName}": "..."
  },
  "next_step_recommendations": [
    {
      "title": "...",
      "owner_team": "engineering-team | legal | onchain-execution | ops-team | research | technology-security | installed optional provider team",
      "priority": "high | medium | low/backlog | reject",
      "goal_id": "goal_...",
      "bittrees_relevance": "high | medium | low/backlog | reject - one sentence",
      "rationale": "...",
      "expected_output": "...",
      "dependencies": ["..."],
      "acceptance_criteria": ["..."],
      "validation_path": "coder and researcher",
      "out_of_scope": ["..."],
      "backlog_policy": "..."
    }
  ],
  "lead_routing_instruction": "Lead should dispatch only high/medium approved recommendation objectives with dispatch-ready briefs; low/backlog or generic objectives stay in backlog."
}`;
  }

  private async maybeTriggerValidatorRecommendationLoop(params: {
    teamId: string;
    teamName: string;
    task: TaskRow;
    completionPayload?: Record<string, unknown>;
  }): Promise<void> {
    // This loop is strictly post-completion. Some command paths pass through here
    // after assignment/status changes; do not let those create premature
    // recommendation traffic or stale lead drafts.
    if (params.task.status !== 'done' || !params.task.completed_at) return;
    const cfg = await this.getValidatorRecommendationLoopConfig(params.teamId);
    if (!cfg.enabled) return;
    if (!params.task.owner) return;

    const owner = await this.db.agents.getById(params.task.owner).catch(() => null);
    if (!owner || !cfg.owners.includes(owner.name)) return;
    if (!this.isValidationTask(params.task)) return;
    if (this.isValidatorRecommendationTask(params.task)) return;

    const completionNote = typeof params.completionPayload?.note === 'string'
      ? params.completionPayload.note
      : typeof params.completionPayload?.message === 'string'
        ? params.completionPayload.message
        : undefined;

    const key = this.validatorRecommendationLoopKey(params.teamId, params.task.uuid, owner.id);
    await this.withValidatorRecommendationLoopLock(key, async () => {
      try {
        if (await this.hasValidatorRecommendationLoopTriggered(params.teamId, params.task.uuid, owner.id)) {
          this.managerLog(`validator recommendation loop already triggered for task ${params.task.name} and validator ${owner.name}; skipping duplicate completion event`);
          return;
        }

        const message = this.validatorRecommendationPrompt({
          task: params.task,
          validatorName: owner.name,
          leadName: cfg.lead,
          objective: cfg.objective,
          completionNote,
        });

        await this.recordValidatorRecommendationLoopTriggered({
          teamId: params.teamId,
          task: params.task,
          owner,
          leadName: cfg.lead,
          completionNote,
          occurredAt: Date.now(),
        });
        await this.sendInternalNewsTo(params.teamName, owner.name, message, cfg.lead);
        this.managerLog(`validator recommendation loop asked ${owner.name} for task ${params.task.name}; lead ${cfg.lead} will route only if the validator returns approved follow-up recommendations`);
      } catch (err: any) {
        this.managerLog(`validator recommendation loop trigger failed for task ${params.task.name}: ${err?.message || err}`);
      }
    });
  }

  constructor(
    baseWorkDir: string = '/workspace',
    db: Db,
    opts?: {
      /** Override SSH delivery function (for tests). */
      deliverFn?: DeliverFn;
      /** Override onchain registration function (for tests). */
      registerOnIdChainFn?: typeof registerOnIdChain;
      /** Override remote health probe function (for tests). */
      healthProbeFn?: HealthProbeFn;
      /**
       * Override library root for the `/library/*` endpoints. Pass an
       * absolute path to serve a specific library, or `null` to force
       * empty-library behavior. When undefined, resolution falls back to
       * the default (`ID_LIBRARY_ROOT` env, else `<cwd>/configs`, else null).
       */
      libraryRoot?: string | null;
    },
  ) {
    this.baseWorkDir = baseWorkDir;
    this.db = db;
    if (opts?.deliverFn) this.deliverFn = opts.deliverFn;
    if (opts?.registerOnIdChainFn) this.registerOnIdChainFn = opts.registerOnIdChainFn;
    if (opts?.healthProbeFn) this.healthProbeFn = opts.healthProbeFn;
    this.libraryRoot =
      opts && Object.prototype.hasOwnProperty.call(opts, 'libraryRoot')
        ? (opts.libraryRoot ?? null)
        : resolveDefaultLibraryRoot();
    this.agentRole = (process.env.AGENT_ROLE as 'manager' | 'worker') || 'manager';

    // Load default deployment config
    this.loadDefaultConfig();

    this.managementApp = express();
    // Local control-center traffic is high-churn and latency is negligible.
    // Closing HTTP sockets after each response prevents Electron/agent clients
    // from accumulating large keep-alive pools that can pin manager CPU.
    this.managementApp.use((_req, res, next) => {
      res.setHeader('Connection', 'close');
      next();
    });
    // Agent results can be large (git diffs, file contents, long replies). The
    // default 100kb limit rejected those with PayloadTooLargeError, surfacing as a
    // "failed" / "Claude Code produced an empty result" in chat. Match the agent
    // server's generous limit (overridable via ID_MANAGER_BODY_LIMIT).
    this.managementApp.use(express.json({ limit: process.env.ID_MANAGER_BODY_LIMIT || '50mb' }));

    // Ensure teams + manager dirs exist in the mounted workspace
    const teamsDir = `${baseWorkDir}/teams`;
    if (!existsSync(teamsDir)) mkdirSync(teamsDir, { recursive: true });
    const managerDir = `${baseWorkDir}/manager`;
    if (!existsSync(managerDir)) mkdirSync(managerDir, { recursive: true });

    this.setupRoutes();
  }

  /**
   * Load default deployment configuration from configs/default.yaml
   */
  private loadDefaultConfig(): void {
    // Try multiple possible locations for the default config
    const configPaths = [
      path.join(process.cwd(), 'configs/default.yaml'),  // Local development
      path.join(__dirname, '../configs/default.yaml')    // Relative to dist
    ];

    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, 'utf-8');
          const config = yaml.load(content) as DeployConfig;
          this.defaultDeploymentConfig = config || null;
          this.defaultConfig = config?.defaults || null;
          this.defaultRuntimeCredentialPool = config?.runtimeCredentialPool || null;
          console.log(`[AgentManager] Loaded default config from ${configPath}`);
          if (this.defaultConfig?.plugins) {
            console.log(`[AgentManager] Default plugins: ${this.defaultConfig.plugins.map(p => p.name).join(', ')}`);
          }
          return;
        } catch (error) {
          console.warn(`[AgentManager] Failed to load config from ${configPath}:`, error);
        }
      }
    }

    console.warn('[AgentManager] No default config found, agents will have no default plugins');
  }

  /**
   * Get default plugins from config (or empty array if none)
   */
  private getDefaultPlugins(): PluginConfig[] {
    return this.defaultConfig?.plugins || [];
  }

  /**
   * Get default model from config (or fallback)
   */
  private getDefaultModel(): string {
    return getDefaultModelForRuntime(getDefaultRuntime(), this.defaultConfig?.model);
  }

  private ensureRuntimeReady(runtime: HarnessType | string | undefined, model?: string): void {
    const issues = validateRuntimePreflight(runtime, model);
    if (issues.length > 0) {
      throw new Error(issues.map(issue => runtimeIssueHint(issue.code) || issue.message).join('; '));
    }
  }

  private async buildDeployPreflightSummary(
    teamId: string,
    teamName: string,
    absolutePath: string,
    deployArgs: string[]
  ): Promise<{
    agents: Array<{
      name: string;
      type: string;
      runtime: string;
      model: string;
      local: boolean;
      workingDirectory: string;
    }>;
    configPath: string;
    teamName: string;
    calendarCount: number;
  }> {
    const { agents, calendar, errors, teamName: configTeam } = processConfig(absolutePath, this.baseWorkDir, deployArgs);

    let effectiveTeamId = teamId;
    let effectiveTeamName = teamName;
    if (configTeam && configTeam !== teamName) {
      effectiveTeamId = await this.db.teams.getOrCreateTeamId(configTeam);
      effectiveTeamName = configTeam;
    }

    if (errors.length > 0) {
      throw new Error(`Config errors: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
    }

    if (agents.length === 0) {
      throw new Error('No agents defined in config');
    }

    const summarizedAgents = agents.map((agentConfig, index) => {
      const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
      const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
      this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

      const previewId = `preview_${Date.now()}_${index}`;
      const workingDirectory = agentConfig.workingDirectory && path.isAbsolute(agentConfig.workingDirectory)
        ? agentConfig.workingDirectory
        : `${this.baseWorkDir}/agents/${previewId}`;

      return {
        name: agentConfig.name,
        type: agentConfig.type || 'claude',
        runtime: effectiveRuntime,
        model: effectiveModel,
        local: agentConfig.local === true,
        workingDirectory,
      };
    });

    return {
      agents: summarizedAgents,
      configPath: absolutePath,
      teamName: effectiveTeamName,
      calendarCount: calendar.length,
    };
  }

  /**
   * Build environment variables for worker agent
   */
  private buildWorkerEnv(teamId: string, teamName: string, agent: AgentRow): Record<string, string> {
    const plugins = agent.metadata?.plugins || [];
    // After registration, agent.name is the ENS domain; the original local
    // alias is stored in metadata.alias.  Use that for ID_AGENT_ALIAS so
    // normalizeAlias() doesn't mangle the ENS domain.
    const agentAlias = (agent.metadata as any)?.alias || agent.name;
    const domain = (agent.metadata as any)?.idchain_domain;
    // After registration, name is the ENS domain; before registration, just the local alias
    const fullName = domain || agentAlias;
    const env: Record<string, string> = {
      ID_AGENT_NAME: fullName,
      ID_AGENT_ALIAS: agentAlias,
      ID_AGENT_TOKEN_ID: agent.token_id || '',
      ID_AGENT_PORT: String(agent.port || ''),
      ID_TEAM: teamName,
      ID_PROJECT: teamName, // deprecated, use ID_TEAM
      ID_SHARED_DIR: `${this.baseWorkDir}/teams/${teamName}`,
      ID_DB_TEAM_ID: teamId,
      ID_DB_AGENT_ID: agent.id,
      ID_HARNESS: resolveRuntime((agent.runtime || agent.metadata?.runtime) as string | undefined),
      ID_PLUGINS: JSON.stringify(plugins)
    };

    // Add talkTimeout setting from metadata (default timeout for /talk-to requests)
    if (agent.metadata?.talkTimeout) {
      env.ID_TALK_TIMEOUT = String(agent.metadata.talkTimeout);
    }

    // SkillMesh is an optional provider. Only expose signing material to agents
    // that explicitly carry the provider/plugin wiring.
    const skillmeshProviderEnabled = this.isSkillmeshProviderEnabled(teamName, agent.metadata as AgentMetadata);
    const skillmeshKey = skillmeshProviderEnabled ? (agent.metadata as any)?.skillmesh_private_key : undefined;
    if (skillmeshKey) {
      env.SKILLMESH_PRIVATE_KEY = skillmeshKey;
      env.SKILLMESH_APP_URL = process.env.SKILLMESH_APP_URL || 'https://skillmesh.bittrees.org';
      env.SKILLMESH_RPC_URL = process.env.SKILLMESH_RPC_URL || 'https://sepolia.drpc.org';
    }
    // Inject creator key for agents that need to publish skills on-chain
    const skillmeshCreatorKey = skillmeshProviderEnabled ? (agent.metadata as any)?.skillmesh_creator_key : undefined;
    if (skillmeshCreatorKey) {
      env.SKILLMESH_CREATOR_PRIVATE_KEY = skillmeshCreatorKey;
    }

    return env;
  }

  /**
   * Copy a plugin to an agent's working directory
   * Returns the new local path for the plugin
   */
  private copyPluginToAgent(plugin: PluginConfig, agentWorkDir: string): string {
    const pluginsDir = path.join(agentWorkDir, 'plugins');
    const targetDir = path.join(pluginsDir, plugin.name);

    // Create plugins directory if it doesn't exist
    if (!existsSync(pluginsDir)) {
      mkdirSync(pluginsDir, { recursive: true });
    }

    // Resolve source path (handle both absolute and relative paths)
    let sourcePath = plugin.path;
    if (!path.isAbsolute(sourcePath)) {
      // Try multiple possible locations
      const possiblePaths = [
        path.join('/app', sourcePath),
        path.join(process.cwd(), sourcePath),
        path.join(__dirname, '..', sourcePath)
      ];
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          sourcePath = p;
          break;
        }
      }
    }

    if (!existsSync(sourcePath)) {
      console.warn(`[AgentManager] Plugin source not found: ${plugin.path}`);
      return plugin.path; // Return original path if source not found
    }

    // Copy plugin directory recursively
    this.copyDirRecursive(sourcePath, targetDir);
    console.log(`[AgentManager] Copied plugin ${plugin.name} to ${targetDir}`);

    return targetDir;
  }

  /**
   * Recursively copy a directory
   */
  private copyDirRecursive(src: string, dest: string): void {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    const entries = readdirSync(src);
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);

      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Copy plugins to agent's working directory and return updated plugin configs with local paths
   */
  private copyPluginsToAgent(plugins: PluginConfig[], agentWorkDir: string): PluginConfig[] {
    return plugins.map(plugin => ({
      name: plugin.name,
      path: this.copyPluginToAgent(plugin, agentWorkDir)
    }));
  }

  private getTeamName(req: express.Request): string {
    // New headers/params (preferred)
    const header = req.headers['x-id-team'];
    const headerName = Array.isArray(header) ? header[0] : header;
    const queryName = typeof req.query.team === 'string' ? req.query.team : undefined;
    // Backwards compatibility: also accept the previous "project" naming.
    const oldProjectHeader = req.headers['x-id-project'];
    const oldProjectHeaderName = Array.isArray(oldProjectHeader) ? oldProjectHeader[0] : oldProjectHeader;
    const oldProjectQueryName = typeof req.query.project === 'string' ? req.query.project : undefined;
    const resolved = (
      headerName ||
      queryName ||
      oldProjectHeaderName ||
      oldProjectQueryName ||
      process.env.ID_TEAM ||
      process.env.ID_PROJECT ||
      'default'
    ).toString();
    // Validate team name to prevent path traversal
    if (!/^[a-zA-Z0-9_.-]+$/.test(resolved)) {
      throw new Error(`Invalid team name: "${resolved}". Only letters, numbers, hyphens, dots, and underscores allowed.`);
    }
    return resolved;
  }

  /**
   * Whether the request explicitly specified a team via header or query.
   * Used by task endpoints to decide if it's safe to fall back to the
   * caller's own team when the caller isn't found in the default team —
   * a team header always wins, so cross-team guards still hold.
   */
  private isTeamExplicit(req: express.Request): boolean {
    return !!(
      req.headers['x-id-team'] ||
      req.headers['x-id-project'] ||
      (typeof req.query.team === 'string' && req.query.team) ||
      (typeof req.query.project === 'string' && req.query.project)
    );
  }

  /**
   * Resolve a caller agent globally when the request omitted the team
   * header. Returns the matching agent row and its team only when the
   * lookup is unambiguous across teams.
   */
  private async resolveCallerAcrossTeams(ref: string): Promise<{ agent: AgentRow; teamId: string } | undefined> {
    const matches = await this.db.agents.resolveAcrossTeams(ref);
    if (matches.length !== 1) return undefined;
    return { agent: matches[0], teamId: matches[0].team_id };
  }

  private async getTeam(req: express.Request): Promise<{ name: string; id: string }> {
    // If the middleware has already resolved the context, use it directly
    const ctx = (req as any).ctx;
    if (ctx?.teamId && ctx?.teamName) {
      return { name: ctx.teamName, id: ctx.teamId };
    }
    // Fallback: resolve inline (used for paths that bypass middleware)
    const name = this.getTeamName(req);
    const id = await this.db.teams.getOrCreateTeamId(name);
    // Ensure per-team directory exists (no cross-team shared files).
    const teamDir = `${this.baseWorkDir}/teams/${name}`;
    if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
    return { name, id };
  }

  private key(teamId: string, agentId: string) {
    return `${teamId}:${agentId}`;
  }

  /**
   * Resolve the logical manager inbox owner for a team.
   * Writes persist only `owner_kind` / `owner_id`; `inboxApiId` is the stable
   * external handle (`manager-<team>`) returned on HTTP surfaces.
   */
  private getManagerInboxRef(teamId: string, teamName: string): {
    inboxApiId: string;
    ownerKind: 'manager';
    ownerId: string;
  } {
    return {
      inboxApiId: `manager-${teamName}`,
      ownerKind: 'manager',
      ownerId: teamId,
    };
  }

  /**
   * Canonical "deliver this query" lifecycle. Single source of truth for the
   * success path of a manager-side query completion: writes the completed
   * status to the queries table, emits `query:delivered` to the wakeup-service
   * event log, wakes any long-poll `GET /query/:id?wait=` blockers, and
   * resolves any in-memory `/talk-to` waiter still parked on the query id.
   *
   * Both POST /news (in_reply_to success branch) and POST /manager/inbox/respond
   * route through this helper so the lifecycle has exactly one implementation
   * — adding a second path would let the two drift on event emission, waiter
   * wakeup, or status semantics. Failure (`reply.error`) uses
   * `queries.markFailed` + `emitQueryFailed` and shares only the waiter
   * wakeup primitives below (which apply to any terminal transition).
   *
   * Idempotent at the DB level: `queries.complete` is gated on `status =
   * 'pending'`, so repeated calls for the same query are no-ops on the row.
   * The event/waiter side effects still fire, mirroring the existing POST
   * /news behavior (see audit finding context above).
   */
  private async completeQueryDelivery(params: {
    teamId: string;
    queryId: string;
    occurredAt: number;
    resultPayload: Record<string, unknown>;
    waiterReply: { from: string; message: string };
    messagePreview: string | null;
  }): Promise<void> {
    const { teamId, queryId, occurredAt, resultPayload, waiterReply, messagePreview } = params;

    const rawUsedSourceIds = Array.isArray((resultPayload as any).used_source_ids)
      ? (resultPayload as any).used_source_ids.map(String)
      : Array.isArray((resultPayload as any).usedSourceIds)
        ? (resultPayload as any).usedSourceIds.map(String)
        : [];
    const pendingBrainContext = this.queryBrainContext.get(queryId)
      || ((resultPayload as any).brain_context as BrainVolunteerContext | undefined)
      || ((resultPayload as any).brainContext as BrainVolunteerContext | undefined)
      || null;
    const rawVolunteeredSourceIds = Array.isArray((resultPayload as any).volunteered_source_ids)
      ? (resultPayload as any).volunteered_source_ids.map(String)
      : Array.isArray((resultPayload as any).volunteeredSourceIds)
        ? (resultPayload as any).volunteeredSourceIds.map(String)
        : Array.isArray(pendingBrainContext?.cited?.canonical_source_ids)
          ? pendingBrainContext.cited.canonical_source_ids.map(String)
          : [];
    const queryLearningLoopInput = extractLearningLoopCapture(resultPayload);
    const queryTeamName = queryLearningLoopInput
      ? (await this.db.teams.getTeam(teamId))?.name || teamId
      : teamId;
    const queryLearningLoop = queryLearningLoopInput
      ? normalizeLearningLoopCapture({
        payload: resultPayload,
        subject: {
          kind: 'query',
          ref: `query:${queryId}`,
          route: 'manager.dispatch',
        },
        teamName: queryTeamName,
        usedSourceIds: rawUsedSourceIds,
        volunteeredSourceIds: rawVolunteeredSourceIds,
        occurredAt,
      })
      : null;
    const completionPayload = queryLearningLoop
      ? { ...resultPayload, learning_loop: queryLearningLoop }
      : resultPayload;

    await this.db.queries.complete(teamId, queryId, occurredAt, completionPayload);

    const completedRow = await this.db.queries
      .getByQueryIdForTeam(teamId, queryId)
      .catch(() => null);
    if (completedRow && completedRow.status === 'completed') {
      const brainContext = this.queryBrainContext.get(queryId)
        || ((completedRow.metadata as any)?.brain_context as BrainVolunteerContext | undefined)
        || null;
      const usedSourceIds = Array.isArray((completionPayload as any).used_source_ids)
        ? (completionPayload as any).used_source_ids.map(String)
        : Array.isArray((completionPayload as any).usedSourceIds)
          ? (completionPayload as any).usedSourceIds.map(String)
          : [];
      const metadataTaskId = typeof (brainContext as any)?.task_id === 'string'
        ? (brainContext as any).task_id
        : typeof ((completedRow.metadata as any)?.brain_context?.task_id) === 'string'
          ? (completedRow.metadata as any).brain_context.task_id
          : null;
      const taskId = typeof (completionPayload as any).task_id === 'string'
        ? (completionPayload as any).task_id
        : typeof (completionPayload as any).taskId === 'string'
          ? (completionPayload as any).taskId
          : metadataTaskId;
      await this.postBrainInstructionFeedback({
        taskId,
        queryId,
        agentId: completedRow.owner_kind === 'manager' ? null : completedRow.agent_id,
        context: brainContext,
        payload: completionPayload,
      });
      await this.postBrainEvalCapture({
        queryText: completedRow.prompt || messagePreview || '',
        route: 'manager.dispatch',
        agentId: completedRow.owner_kind === 'manager' ? null : completedRow.agent_id,
        taskId,
        queryId,
        context: brainContext,
        usedSourceIds,
        learningLoop: queryLearningLoop,
      });
      await emitQueryDelivered(this.db.events, {
        teamId,
        queryId,
        agentId:
          completedRow.owner_kind === 'manager'
            ? null
            : completedRow.agent_id,
        occurredAt,
        messagePreview,
        taskId,
        usedSourceIds,
        volunteeredSourceIds: brainContext?.cited?.canonical_source_ids || [],
        learningLoop: queryLearningLoop,
      });
    }

    this.wakeQueryWaiters(teamId, queryId, waiterReply);
    this.releaseLocalGate(queryId); // #7: free the local-model slot on success
  }

  /** Append-only JSONL log of local-model token usage (Health page). */
  private usageLogPath(): string {
    return path.join(this.baseWorkDir, 'manager', 'token-usage.jsonl');
  }

  /** Read + parse the usage log, soft-capping its size to stay bounded. */
  private readUsageRecords(): Array<{ ts: number; runtime: string; model: string; agent: string; team: string; input: number | null; output: number | null; genMs: number | null; tps: number | null; query_id?: string }> {
    const p = this.usageLogPath();
    if (!existsSync(p)) return [];
    let raw = '';
    try { raw = readFileSync(p, 'utf-8'); } catch { return []; }
    const lines = raw.split('\n').filter(Boolean);
    // Soft cap: keep the newest 10k records once the file passes 20k lines.
    const capped = lines.length > 20000 ? lines.slice(lines.length - 10000) : lines;
    if (capped.length < lines.length) {
      try { writeFileSync(p, capped.join('\n') + '\n'); } catch { /* best-effort */ }
    }
    const out: Array<any> = [];
    for (const ln of capped) {
      try {
        const r = JSON.parse(ln);
        if (r && typeof r.ts === 'number') out.push(r);
      } catch { /* skip malformed line */ }
    }
    return out;
  }

  private wantsCsv(req: express.Request): boolean {
    const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : '';
    if (format === 'csv') return true;
    const accept = String(req.headers.accept || '').toLowerCase();
    return accept.split(',').some((part) => part.trim().startsWith('text/csv'));
  }

  private csvCell(value: unknown): string {
    if (value == null) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  private sendCsv(res: express.Response, filename: string, rows: Array<Record<string, unknown>>): void {
    const headers = rows.length
      ? Object.keys(rows[0])
      : ['empty'];
    const lines = [
      headers.map((h) => this.csvCell(h)).join(','),
      ...rows.map((row) => headers.map((h) => this.csvCell(row[h])).join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n') + '\n');
  }

  /**
   * Wake the long-poll `GET /query/:id?wait=` blockers and resolve any
   * `/talk-to` waiter parked on this query id. Shared between
   * `completeQueryDelivery` (success) and the failure branch in POST /news so
   * neither path duplicates waiter logic.
   */
  private wakeQueryWaiters(
    teamId: string,
    queryId: string,
    waiterReply: { from: string; message: string },
  ): void {
    this.notifyQueryStatusWaiters(teamId, queryId);

    const waiter = this.queryWaiters.get(queryId);
    if (waiter) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      this.queryWaiters.delete(queryId);
      waiter.resolve(waiterReply);
      this.managerLog(`Resolved waiter for query ${queryId}`);
    }
  }

  /**
   * Redact sensitive fields from an agentToResponse result for non-admin callers.
   *
   * Top-level fields removed: ssh_target, internal_endpoint_url.
   * metadata keys removed: any key in SENSITIVE_META_KEYS list, plus any key
   * matching /private_?key/i or /secret/i as a safety net.
   */
  private static readonly SENSITIVE_META_KEYS = new Set([
    'auth_key_ref',
    'ows_wallet_seed',
    'ssh_private_key',
    'ssh_target',
    'internal_endpoint_url',
    'runtimeCredentialPool',
  ]);

  private static readonly SENSITIVE_META_REGEX = /private_?key|secret/i;

  private redactForNonAdmin<T extends Record<string, any>>(resp: T): T {
    // Remove top-level sensitive fields
    const out: any = { ...resp };
    delete out.ssh_target;
    delete out.internal_endpoint_url;

    // Deep-copy and strip sensitive metadata keys
    if (out.metadata && typeof out.metadata === 'object') {
      const meta: any = { ...out.metadata };
      for (const key of Object.keys(meta)) {
        if (
          AgentManagerDb.SENSITIVE_META_KEYS.has(key) ||
          AgentManagerDb.SENSITIVE_META_REGEX.test(key)
        ) {
          delete meta[key];
        }
      }
      // MCP server definitions can carry secrets in nested `env` (stdio) and
      // `headers` (http/sse) — the key-name scan above never sees them. Keep
      // the server list visible (name/transport/command/url) but drop creds.
      if (Array.isArray(meta.mcpServers)) {
        meta.mcpServers = meta.mcpServers.map((srv: any) => {
          if (!srv || typeof srv !== 'object') return srv;
          const { env, headers, ...rest } = srv;
          return rest;
        });
      }
      out.metadata = meta;
    }

    return out as T;
  }

  /**
   * Convert an AgentRow to an API response object with identifier fields.
   * Pass opts.isAdmin = true for admin callers to receive the full unredacted record.
   */
  private agentToResponse(a: AgentRow, opts?: { isAdmin?: boolean }) {
    // Interactive CLI agents are reachable via the daemon's management port —
    // the daemon owns /talk and /news for them (see e3b30b9). The CLI's own
    // port (stored in a.endpoint) may not be listening, so wrapper lookups
    // that hit a.endpoint would silently fail. The daemon URL always works:
    // POST /news lands under the manager-inbox agent_id and GET /news reads
    // from the same row. Virtual agents keep their declared endpoint.
    const isRemote = isRemoteEndpointRuntime(a.runtime);
    const url = isRemote
      ? null
      : a.type === 'interactive'
        ? `http://localhost:${this.managementPort}`
        : a.type === 'virtual'
          ? a.endpoint
          : `http://localhost:${a.port}`;

    // After registration, a.name IS the ENS domain and the original local alias
    // is preserved in metadata.alias.
    const alias = (a.metadata as any)?.alias || normalizeAlias(a.name);
    const domain = a.domain || (a.metadata as any)?.idchain_domain;
    const displayId = domain || alias;

    // Lift metadata.pid to the top level so clients (TUI, health probes)
    // don't have to reach into metadata to batch per-agent RSS lookups.
    const localRunning = a.status === 'running';
    const metadata = { ...((a.metadata as Record<string, unknown> | null | undefined) ?? {}) };
    const metaPid = metadata.pid;
    const metaPidNumber = typeof metaPid === 'number' ? metaPid : Number(metaPid);
    const pid = localRunning && Number.isFinite(metaPidNumber) && metaPidNumber > 0 ? metaPidNumber : null;
    if (!localRunning) delete metadata.pid;

    // Remote-endpoint agents have no local port or pid; health is derived from probe columns.
    const remoteFields = isRemote ? {
      port: null,
      pid: null,
      deploymentShape: 'remote-endpoint' as const,
      health: this.deriveRemoteHealth(a),
      customer_domain: a.customer_domain,
      public_endpoint_url: a.public_endpoint_url,
      internal_endpoint_url: a.internal_endpoint_url,
      ssh_target: a.ssh_target,
      last_seen: a.last_seen ?? null,
      last_probed_at: a.last_probed_at ?? null,
      last_error: a.last_error ?? null,
      consecutive_failures: a.consecutive_failures ?? 0,
    } : {
      deploymentShape: 'local-process' as const,
    };

    const runtimeDisplay = a.runtime === 'provider-api' && typeof (a.metadata as any)?.runtime === 'string'
      ? (a.metadata as any).runtime
      : a.runtime;

    const full = {
      id: a.id,
      // name is the displayId (e.g., "agent-5.xid.eth") for inter-agent communication
      // alias is the base name (e.g., "agent") for backwards compatibility
      name: displayId,
      alias,
      model: a.model,
      port: a.port,
      pid,
      status: a.status,
      workingDirectory: a.working_directory,
      createdAt: a.created_at,
      type: a.type,
      runtime: runtimeDisplay,
      url,
      metadata,
      // Identity fields
      tokenId: a.token_id,
      domain,
      displayId,
      // Health monitoring (overridden for remote agents above)
      ...this.getHealthForAgent(a),
      // Runtime shape — remote-endpoint agents override port/pid/health
      ...remoteFields,
    };

    return opts?.isAdmin === true ? full : this.redactForNonAdmin(full);
  }

  private async dbQueryAgentById(teamId: string, id: string): Promise<AgentRow | null> {
    const a = await this.db.agents.getById(id);
    if (!a) return null;
    if (a.team_id !== teamId) return null; // cross-team lookups invisible
    return a;
  }

  private async dbQueryAgentByNameMostRecent(teamId: string, name: string): Promise<AgentRow | null> {
    return this.db.agents.getByName(teamId, name);
  }

  private async dbListAgents(teamId: string, includeAutomator: boolean = false): Promise<AgentRow[]> {
    return this.db.agents.list(teamId, includeAutomator);
  }

  private async rebuildLocalClaudeAgent(
    teamId: string,
    teamName: string,
    agent: AgentRow,
  ): Promise<{ success: boolean; pid?: number; logFile?: string; error?: string }> {
    await this.killAgentProcess(agent.port);
    await new Promise(r => setTimeout(r, 1000));
    const spawnResult = await this.spawnLocalAgentProcess(teamId, teamName, {
      name: agent.name, id: agent.id, port: agent.port,
      model: agent.model, workingDirectory: agent.working_directory ?? undefined,
      tokenId: agent.token_id ?? undefined
    });
    if (spawnResult.success) {
      await this.db.agents.updateStatus(agent.id, 'running');
    }
    return spawnResult;
  }

  private async handleRuntimeRateLimitFailover(
    teamId: string,
    teamName: string,
    cooldown: RuntimeLaneCooldown,
  ): Promise<{ attempted: boolean; success?: boolean; pid?: number; retryQueryId?: string; laneId?: string; error?: string }> {
    if (!cooldown.agentId) return { attempted: false };
    const agent = await this.dbQueryAgentById(teamId, cooldown.agentId).catch(() => null);
    const runtime = resolveRuntime(agent?.runtime || cooldown.runtime);
    if (!agent || (runtime !== 'claude-code-cli' && runtime !== 'claude-code-local')) return { attempted: false };

    const nextLane = this.chooseRuntimeCredentialLane(runtime, cooldown.laneId, teamId, true);
    const metadata = (agent.metadata as Record<string, unknown>) || {};
    await this.db.agents.updateMetadata(agent.id, {
      ...metadata,
      runtimeCredentialLane: nextLane.id,
      runtimeRateLimitFailover: {
        fromLaneId: cooldown.laneId,
        toLaneId: nextLane.id,
        queryId: cooldown.queryId,
        observedAtMs: Date.now(),
      },
    });

    const spawnResult = await this.rebuildLocalClaudeAgent(teamId, teamName, {
      ...agent,
      metadata: { ...metadata, runtimeCredentialLane: nextLane.id },
    });
    if (!spawnResult.success) {
      return { attempted: true, success: false, pid: spawnResult.pid, laneId: nextLane.id, error: spawnResult.error };
    }

    if (!cooldown.queryId) {
      return { attempted: true, success: true, pid: spawnResult.pid, laneId: nextLane.id };
    }

    const query = await this.db.queries.getByQueryIdForTeam(teamId, cooldown.queryId).catch(() => null);
    if (!query || !query.prompt) {
      return { attempted: true, success: true, pid: spawnResult.pid, laneId: nextLane.id, error: 'original query not found for failover replay' };
    }

    const targetUrl = `http://localhost:${agent.port}`;
    const result = await this.forwardToAgent(targetUrl, query.prompt, 'manager', query.session_id ?? undefined);
    if (!result.ok) {
      return { attempted: true, success: false, pid: spawnResult.pid, laneId: nextLane.id, error: result.error };
    }

    const retryQueryId = result.data?.query_id;
    if (retryQueryId) {
      this.runtimeFailoverRetryOf.set(String(retryQueryId), cooldown.queryId);
      await this.db.queries.create(
        teamId,
        String(retryQueryId),
        agent.id,
        query.prompt,
        Date.now(),
        query.session_id ?? undefined,
        undefined,
        {
          ...(query.metadata || {}),
          retry_of: cooldown.queryId,
          runtimeCredentialLane: nextLane.id,
          failedRuntimeCredentialLane: cooldown.laneId,
        },
      );
    }

    return { attempted: true, success: true, pid: spawnResult.pid, retryQueryId: retryQueryId ? String(retryQueryId) : undefined, laneId: nextLane.id };
  }

  /**
   * Resolve agents matching an identifier pattern
   * Returns all matches for ambiguity detection
   */
  private async dbResolveAgents(teamId: string, ref: string): Promise<AgentRow[]> {
    return this.db.agents.resolve(teamId, ref);
  }

  private async dbDeleteAgentRow(teamId: string, agentId: string): Promise<boolean> {
    const result = await this.db.adapter.query(
      `DELETE FROM agents WHERE team_id = $1 AND id = $2`,
      [teamId, agentId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async dbNextPort(_teamId?: string): Promise<number> {
    return this.db.agents.nextPort();
  }

  /**
   * Get the shared deployer address.
   * Uses OWS wallet if OWS_REGISTRAR_WALLET is set, otherwise derives from PRIVATE_KEY.
   */
  private explicitSkillmeshProviderState(metadata: AgentMetadata | null | undefined): boolean | null {
    if (!metadata || typeof metadata !== 'object') return null;

    if (metadata.skillmesh_provider !== undefined) return metadata.skillmesh_provider === true;
    if (metadata.skillmeshProvider !== undefined) return metadata.skillmeshProvider === true;

    const providers = metadata.providers;
    if (providers && typeof providers === 'object') {
      const skillmesh = (providers as Record<string, unknown>).skillmesh;
      if (skillmesh === true) return true;
      if (skillmesh === false) return false;
      if (skillmesh && typeof skillmesh === 'object' && 'enabled' in skillmesh) {
        return (skillmesh as Record<string, unknown>).enabled === true;
      }
    }

    const skillmesh = metadata.skillmesh;
    if (skillmesh === true) return true;
    if (skillmesh === false) return false;
    if (skillmesh && typeof skillmesh === 'object' && 'enabled' in skillmesh) {
      return (skillmesh as Record<string, unknown>).enabled === true;
    }

    return null;
  }

  private isSkillmeshProviderEnabled(_teamName: string, metadata: AgentMetadata | null | undefined): boolean {
    const explicit = this.explicitSkillmeshProviderState(metadata);
    if (explicit !== null) return explicit;
    if (envFlagDisabled(process.env.ID_AGENTS_SKILLMESH_AUTO_KEYS)) return false;
    if (
      envFlagEnabled(process.env.ID_AGENTS_SKILLMESH_AUTO_KEYS) ||
      envFlagEnabled(process.env.ID_AGENTS_SKILLMESH_PROVIDER_ENABLED)
    ) {
      return true;
    }
    const plugins = Array.isArray(metadata?.plugins) ? metadata.plugins : [];
    return plugins.some(pluginLooksLikeSkillmesh);
  }

  /** Return the next available SkillMesh key index above all pre-provisioned agent slots (0-33). */
  private async getNextSkillmeshKeyIndex(): Promise<number> {
    try {
      const { rows } = await this.db.adapter.query<{ max_idx: number | null }>(
        `SELECT MAX(CAST(json_extract(metadata, '$.skillmesh_key_index') AS INTEGER)) AS max_idx
         FROM agents WHERE deleted_at IS NULL`,
      );
      const max = rows[0]?.max_idx ?? null;
      return max !== null ? max + 1 : 34;
    } catch {
      return 34;
    }
  }

  /** Derive and persist a SkillMesh key only when the optional provider is enabled. */
  private async maybeAssignSkillmeshKey(agentId: string, teamName: string, currentMeta: AgentMetadata): Promise<AgentMetadata> {
    if (!this.isSkillmeshProviderEnabled(teamName, currentMeta)) return currentMeta;
    // If the spawn request already supplied a pre-provisioned key, use it as-is
    if ((currentMeta as any).skillmesh_address && (currentMeta as any).skillmesh_private_key) {
      await this.db.agents.updateMetadata(agentId, currentMeta);
      return currentMeta;
    }
    const masterKey = loadMasterKey(process.env.ID_WORKSPACE_DIR || this.baseWorkDir);
    if (!masterKey) return currentMeta;
    try {
      const index = await this.getNextSkillmeshKeyIndex();
      const keyInfo = deriveKeyAtIndex(masterKey, index);
      const updated: AgentMetadata = {
        ...currentMeta,
        skillmesh_address: keyInfo.address,
        skillmesh_key_index: keyInfo.keyIndex,
        skillmesh_key_path: keyInfo.derivationPath,
        skillmesh_private_key: keyInfo.privateKey,
      };
      await this.db.agents.updateMetadata(agentId, updated);
      return updated;
    } catch (err) {
      console.warn(`[SkillmeshKeys] Key assignment failed for ${agentId}:`, err);
      return currentMeta;
    }
  }

  private getDeployerAddress(): string | null {
    const owsWallet = process.env.OWS_REGISTRAR_WALLET;
    if (owsWallet) {
      try {
        const output = execFileSync('ows', ['wallet', 'list'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
        let inWallet = false;
        for (const line of output.split('\n')) {
          if (line.includes('Name:') && line.includes(owsWallet)) { inWallet = true; continue; }
          if (inWallet && line.includes('Name:')) break;
          if (inWallet) {
            const match = line.trim().match(/^eip155:1\s.*→\s*(0x[0-9a-fA-F]+)/);
            if (match) return match[1];
          }
        }
        return null;
      } catch {
        return null;
      }
    }
    const pk = process.env.AGENT_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!pk) return null;
    const account = privateKeyToAccount(pk as Hex);
    return account.address;
  }

  private async getDefaultRegistry(teamId: string): Promise<AgentRegistryId> {
    const cfg = await this.db.teams.getConfig(teamId);
    const chainId = parseInt(String(cfg.default_chain_id || process.env.ID_DEFAULT_CHAIN_ID || '8453'));
    const registryAddress =
      (cfg.default_registry_address ||
        process.env.AGENT_REGISTRY_ADDRESS ||
        process.env.ID_DEFAULT_REGISTRY_ADDRESS ||
        '0x2b39585cc5004712c938480cd7ff5b97d2bbf433') as string;
    return { chainId, registryAddress };
  }

  private async getRegistrarAddress(teamId: string): Promise<Address> {
    const cfg = await this.db.teams.getConfig(teamId);
    const registrarAddressEnv = process.env.AGENT_REGISTRAR_ADDRESS || process.env.ID_REGISTRAR_ADDRESS;
    const addr = (cfg.registrar_address || cfg.sepolia_registrar_address || registrarAddressEnv) as string | undefined;
    if (!addr) throw new Error('Missing registrar address (set config.registrar_address or env AGENT_REGISTRAR_ADDRESS)');
    return addr as Address;
  }

  private async setRegistrarAddress(teamId: string, registrarAddress: string): Promise<void> {
    await this.db.teams.setRegistrarAddress(teamId, String(registrarAddress));
  }

  private async setDefaultRegistry(teamId: string, chainId: number, registryAddress: string): Promise<void> {
    await this.db.teams.setDefaultRegistry(teamId, String(chainId), String(registryAddress));
  }

  private async registerOnchainAndUpdateAgent(teamId: string, agent: AgentRow): Promise<{ txHash: string; tokenId: string; domain: string }> {
    const isRemote = isRemoteEndpointRuntime(agent.runtime);

    // ── Phase 4: wallet provisioning for remote agents ──────────────────────
    // For public-agent-remote, provision an OWS wallet before registration so
    // multi-chain address records can be set.  For local agents the wallet is
    // already attached via the normal deploy path.
    //
    if (isRemote && !(agent.metadata as any)?.ows_wallet && this.isWalletProvisioningEnabled(agent.metadata)) {
      const refreshed = await this.provisionAgentWalletForRow(teamId, 'public', agent);
      if (refreshed) {
        agent = refreshed;
      } else {
        console.warn(`[Register] OWS not installed or wallet creation failed for remote agent "${agent.name}". Proceeding without wallet.`);
      }
    }

    // Support OWS wallet or raw private key for signing
    const owsRegistrarWallet = process.env.OWS_REGISTRAR_WALLET;
    const pk = !owsRegistrarWallet ? (process.env.ID_REGISTRAR_PRIVATE_KEY || process.env.PRIVATE_KEY) : undefined;
    if (!owsRegistrarWallet && !pk) throw new Error('Missing signer. Set OWS_REGISTRAR_WALLET or PRIVATE_KEY.');
    const signerOpts = owsRegistrarWallet ? { wallet: owsRegistrarWallet } : { privateKey: pk! };

    const defaultReg = await this.getDefaultRegistry(teamId);
    const chainId = defaultReg.chainId;
    const registryAddress = defaultReg.registryAddress as Address;

    // Build text records for registration
    const textRecords: Record<string, string> = {};
    textRecords['description'] = `${agent.name} agent`;

    // Determine the agent's endpoint for the ENSIP-26 records.
    // Remote agents advertise their public HTTPS endpoint; local agents use the
    // manager-local URL or the PUBLIC_BASE_URL override.
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    const agentEndpoint = isRemote
      ? (agent.public_endpoint_url || `https://${agent.customer_domain}`)
      : (publicBaseUrl
          ? `${publicBaseUrl.replace(/\/+$/, '')}`
          : (agent.type === 'virtual'
              ? (agent.endpoint as string)
              : ((agent.metadata as any)?.service || `http://localhost:${agent.port}`)));

    console.log(`[Register] Registering "${agent.name}" on ID Chain (Base)...`);

    // Register via id-cli with sublabel (Base only)
    // e.g., --sublabel x → x.agent-8.xid.eth in one transaction
    const originalAlias = ((agent.metadata as any)?.alias || agent.name);
    const result = await this.registerOnIdChainFn({
      sublabel: originalAlias,
      textRecords,
      ...signerOpts,
    });

    // ENSIP-26 agent endpoints can be set later via:
    //   id-cli set-agent-endpoints <domain> --a2a <url>
    // Skipped by default for private/local systems.

    // Use the label as tokenId for backward compat; domain is the primary identifier
    const tokenId = result.label;

    // Update metadata – preserve the original local alias so the agent
    // can still be found by its pre-registration name after `name` is
    // changed to the full ENS domain.
    let metadata = (agent.metadata || {}) as AgentMetadata;
    const newName = result.domain; // Already includes sublabel (e.g., x.agent-8.xid.eth)
    metadata = {
      ...metadata,
      idchain_domain: newName,
      service_type: 'REST-AP',
      alias: originalAlias,
    };

    // ── Phase 4: security metadata flags for remote agents ───────────────────
    if (isRemote) {
      metadata = {
        ...metadata,
        mesh_member: false,
        mesh_reachable: false,
        public_endpoint: true,
        dmz: true,
        allowed_inbound: ['public_http'],
        allowed_outbound: ['openrouter'],
      };
    }

    // Keep the agent's internal endpoint for manager-to-agent communication
    const isLocalAgent = (metadata as any).local === true;
    const dbEndpoint = isRemote
      ? (agent.endpoint || agentEndpoint)
      : (isLocalAgent ? (agent.endpoint || `http://localhost:${agent.port}`) : agentEndpoint);

    // Set multi-chain address records if agent has an OWS wallet
    const owsWalletName = (metadata as any).ows_wallet;
    if (owsWalletName) {
      try {
        const addrResult = await setMultiChainAddresses({
          name: newName,
          walletName: owsWalletName,
          ...signerOpts,
        });
        if (addrResult.set.length > 0) {
          console.log(`[Register] Set ${addrResult.set.length} address records: ${addrResult.set.join(', ')}`);
        }
      } catch (addrErr: any) {
        console.warn(`[Register] Multi-chain address setting failed: ${addrErr.message}`);
      }
    }

    await this.db.agents.updateIdentity(agent.id, {
      name: newName,
      token_id: tokenId,
      domain: newName,
      endpoint: dbEndpoint,
      metadata,
    });

    if (isRemote) {
      // ── Phase 4: push identity.json to the remote VPS ─────────────────────
      // Write to staging dir first, then attempt SCP delivery.
      await this.stageAndDeliverRemoteIdentity(agent, newName, tokenId, metadata);
    } else {
      // ── Local agent identity push ──────────────────────────────────────────
      // Update running server identity
      const server = this.runningServers.get(this.key(teamId, agent.id));
      if (server) {
        server.setIdentity({ name: newName, metadata, tokenId, domain: newName });
      }

      // Push identity to running agent process
      if (agent.type === 'claude' && agent.port && !server) {
        try {
          const agentUrl = isLocalAgent
            ? (agent.endpoint || `http://localhost:${agent.port}`)
            : `http://id-agent-${agent.id}:4100`;
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          const identityRes = await fetch(`${agentUrl}/identity`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ tokenId, domain: newName })
          });
          if (identityRes.ok) {
            console.log(`✅ Updated identity for ${originalAlias}: ${newName}`);
          } else {
            console.warn(`⚠️ Failed to update identity for ${originalAlias}: ${identityRes.status}`);
          }
        } catch (err: any) {
          console.warn(`⚠️ Could not update identity for ${originalAlias}: ${err.message}`);
        }
      }
    }

    console.log(`✅ Registered ${originalAlias} as ${newName} (tx: ${result.txHash})`);
    return { txHash: result.txHash, tokenId, domain: newName };
  }

  /**
   * Write identity.json to the local staging directory and (if ssh_target is
   * set) deliver it to the remote VPS over SCP.
   *
   * On SSH delivery failure the on-chain state is still authoritative; the
   * manager logs a warning and returns successfully.
   */
  private async stageAndDeliverRemoteIdentity(
    agent: AgentRow,
    idchainDomain: string,
    tokenId: string,
    metadata: AgentMetadata,
  ): Promise<void> {
    // Build the identity object per § 8 schema
    const identity = {
      name: idchainDomain,
      ows_address: (metadata as any).ows_address || '',
      idchain_domain: idchainDomain,
      token_id: tokenId,
      service_endpoint: agent.public_endpoint_url || `https://${agent.customer_domain}` || '',
      registered_at: new Date().toISOString(),
    };

    // Staging path: <baseWorkDir>/public-agents/<agent.id>/staging/identity.json
    const stagingDir = path.join(this.baseWorkDir, 'public-agents', agent.id, 'staging');
    mkdirSync(stagingDir, { recursive: true });
    const localPath = path.join(stagingDir, 'identity.json');
    writeFileSync(localPath, JSON.stringify(identity, null, 2), 'utf8');
    console.log(`[Register] Staged identity file at ${localPath}`);

    // Deliver over SSH if ssh_target is configured
    if (agent.ssh_target) {
      const remotePath = (agent.metadata as any)?.identity_remote_path || '/opt/public-agent/identity.json';
      const deliverResult = await this.deliverFn(agent.ssh_target, localPath, remotePath);
      // Never log the full ssh_target (raw `user@host`); the user portion is
      // operator PII. Full target is still available via admin API responses.
      const redactedTarget = redactSshTarget(agent.ssh_target);
      if (deliverResult.ok) {
        console.log(`[Register] Delivered identity.json to ${redactedTarget}:${remotePath}`);
      } else {
        console.warn(
          `[Register] SSH delivery failed for agent ${agent.id} (${redactedTarget}): ` +
          `error=${deliverResult.error} stderr=${deliverResult.stderr ?? ''}`,
        );
        // Do NOT throw — on-chain state is authoritative regardless.
      }
    }
  }

  /**
   * Resolve a target agent by name/id, return its info and endpoint URL.
   * Shared by /talk-to and /message endpoints.
   */
  private async resolveTargetAgent(teamId: string, agent: string): Promise<{
    targetAgent: any;
    targetUrl: string;
    targetDisplayId: string;
  } | { error: string; status: number }> {
    // Handle name lookup - supports ENS domains and local names
    let baseName = agent;
    let tokenId: string | null = null;

    const dotIndex = agent.lastIndexOf('.');
    if (dotIndex !== -1) {
      const afterDot = agent.slice(dotIndex + 1);
      if (/^\d+$/.test(afterDot)) {
        baseName = agent.slice(0, dotIndex);
        tokenId = afterDot;
      }
    }

    // After registration, agent.name becomes the ENS domain and the original
    // local alias is in metadata->>'alias'.  Queries must check both.
    const targetAgent = await this.db.agents.getForRouting(teamId, agent, tokenId ?? undefined);

    if (!targetAgent) {
      return { error: `Agent "${agent}" not found`, status: 404 };
    }

    const isLocalAgent = targetAgent.metadata?.local === true;
    const targetUrl = isLocalAgent
      ? (targetAgent.endpoint || `http://localhost:${targetAgent.port}`)
      : targetAgent.type === 'claude'
        ? `http://id-agent-${targetAgent.id}:4100`
        : ((targetAgent.metadata?.internal_url as string | undefined) || targetAgent.endpoint);

    if (!targetUrl) {
      return { error: `Agent "${agent}" has no endpoint`, status: 400 };
    }

    // Prefer ENS domain as display ID, fall back to local name
    const targetDomain = targetAgent.metadata?.idchain_domain as string | undefined;
    const targetDisplayId = targetDomain || targetAgent.name;

    return { targetAgent, targetUrl, targetDisplayId };
  }

  /**
   * Forward a message to an agent's /talk endpoint.
   * Returns the parsed response or an error.
   */
  // ── Local-model serialization (#7) ───────────────────────────────────
  // One local-model (Ollama / local Claude) query runs at a time; API-backed
  // agents (Claude CLI/SDK, Codex, Cursor) are unaffected. Acquire before
  // dispatch, release when the query reaches a terminal state. The gate
  // auto-releases after a timeout, so a missed release can never deadlock
  // dispatch. See lib/local-model-gate.ts.
  private readonly localModelGate = new LocalModelGate(Number(process.env.LOCAL_MODEL_CONCURRENCY) || 1);
  private readonly localGateByQuery = new Map<string, { token: string; agent?: string }>();
  private readonly localGateByAgent = new Map<string, string>();

  /** Acquire a local-model slot before dispatching to `runtime`. Returns a token or undefined. */
  private async acquireLocalGate(runtime?: string | null): Promise<string | undefined> {
    if (!isLocalModelRuntime(runtime)) return undefined;
    const token = `lmg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.localModelGate.acquire(token);
    return token;
  }
  /** Bind a token to its queryId so completion releases it; release immediately if no query. */
  private bindLocalGate(token: string | undefined, queryId?: string, agent?: string): void {
    if (!token) return;
    if (queryId) {
      this.localGateByQuery.set(queryId, { token, agent });
      if (agent) this.localGateByAgent.set(agent, queryId);
    } else {
      this.localModelGate.release(token);
    }
  }
  /** Release the local-model slot a query held, when it reaches a terminal state. */
  private releaseLocalGate(queryId: string): void {
    const entry = this.localGateByQuery.get(queryId);
    if (entry === undefined) return;
    this.localModelGate.release(entry.token);
    this.localGateByQuery.delete(queryId);
    if (entry.agent && this.localGateByAgent.get(entry.agent) === queryId) this.localGateByAgent.delete(entry.agent);
  }

  private async forwardToAgent(targetUrl: string, message: string, from: string, session_id?: string): Promise<{
    ok: true;
    data: any;
  } | { ok: false; status: number; error: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const talkRes = await fetch(`${targetUrl}/talk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, from, session_id }),
      signal: AbortSignal.timeout(30000)
    });

    if (!talkRes.ok) {
      const errorText = await talkRes.text().catch(() => talkRes.statusText);
      return { ok: false, status: talkRes.status, error: errorText };
    }

    const data: any = await talkRes.json();
    return { ok: true, data };
  }

  private releaseLocalGateForAgent(agent?: string | null): void {
    if (!agent) return;
    const qid = this.localGateByAgent.get(agent);
    if (qid) this.releaseLocalGate(qid);
  }

  private brainUrl(): string {
    return (process.env.BRAIN_URL || 'http://127.0.0.1:4200').replace(/\/+$/, '');
  }

  private brainHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.BRAIN_TOKEN) headers.Authorization = `Bearer ${process.env.BRAIN_TOKEN}`;
    return headers;
  }

  private normalizeProviderRuntimeAssignment(runtime: string, raw: unknown): ProviderRuntimeAssignment {
    const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const lane = runtime.startsWith('provider:') ? runtime : String(body.lane || body.id || '').trim();
    if (!isProviderRuntimeSpecifier(lane)) throw new Error('provider runtime lane must be provider:<name>');
    const decoded = decodeURIComponent(lane.slice('provider:'.length));
    const name = String(body.name || decoded || 'provider').trim();
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) throw new Error('provider runtime lane requires baseUrl');
    const keyEnv = typeof body.keyEnv === 'string' && body.keyEnv.trim() ? body.keyEnv.trim() : undefined;
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined;
    return {
      lane,
      name,
      kind: typeof body.kind === 'string' ? body.kind : undefined,
      baseUrl,
      keyEnv,
      apiKey,
    };
  }

  private providerRuntimeMetadata(a: ProviderRuntimeAssignment): Record<string, unknown> {
    return {
      lane: a.lane,
      name: a.name,
      kind: a.kind,
      baseUrl: a.baseUrl,
      keyEnv: a.keyEnv,
      assignedAt: Date.now(),
    };
  }

  private providerRuntimeForAgent(agent: AgentRow | null, metadata: AgentMetadata): ProviderRuntimeAssignment | null {
    if (!agent) return null;
    const runtime = agent.runtime || (metadata as any)?.runtime;
    if (resolveRuntime(runtime as string | undefined) !== 'provider-api') return null;
    const remembered = this.providerRuntimeAssignments.get(agent.id);
    const safe = (metadata as any)?.providerRuntime;
    if (remembered) {
      return { ...remembered, ...(safe && typeof safe === 'object' ? safe : {}) };
    }
    if (!safe || typeof safe !== 'object') return null;
    const lane = typeof safe.lane === 'string' ? safe.lane : typeof (metadata as any)?.runtime === 'string' ? (metadata as any).runtime : '';
    const name = typeof safe.name === 'string' ? safe.name : lane.startsWith('provider:') ? decodeURIComponent(lane.slice('provider:'.length)) : 'provider';
    const baseUrl = typeof safe.baseUrl === 'string' ? safe.baseUrl : '';
    const keyEnv = typeof safe.keyEnv === 'string' ? safe.keyEnv : undefined;
    if (!lane || !baseUrl) return null;
    return { lane, name, kind: typeof safe.kind === 'string' ? safe.kind : undefined, baseUrl, keyEnv };
  }

  private parseRuntimeCredentialPool(raw: unknown, runtime: HarnessType | string | undefined): RuntimeCredentialLane[] {
    const resolved = resolveRuntime(runtime) as HarnessType;
    const lanesRaw = Array.isArray(raw) ? raw : (raw as any)?.lanes || (raw as any)?.runtimeCredentialPool?.lanes;
    if (!Array.isArray(lanesRaw)) return [];
    return lanesRaw
      .map((lane: any): RuntimeCredentialLane | null => {
        const laneRuntime = resolveRuntime(lane?.runtime || resolved) as HarnessType;
        if (laneRuntime !== resolved) return null;
        if (lane?.kind !== 'subscription' && lane?.kind !== 'metered-api') return null;
        if (typeof lane?.id !== 'string' || !lane.id.trim()) return null;
        return {
          id: lane.id,
          runtime: laneRuntime,
          kind: lane.kind,
          env: lane.env && typeof lane.env === 'object' ? lane.env : undefined,
        };
      })
      .filter((lane): lane is RuntimeCredentialLane => Boolean(lane));
  }

  private runtimeCredentialLanes(runtime: HarnessType | string | undefined, teamId?: string): RuntimeCredentialLane[] {
    const resolved = resolveRuntime(runtime) as HarnessType;
    const configured = process.env.ID_RUNTIME_CREDENTIAL_POOL;
    if (configured) {
      try {
        const lanes = this.parseRuntimeCredentialPool(JSON.parse(configured), resolved);
        if (lanes.length) return lanes;
      } catch (err: any) {
        this.managerLog(`Ignoring invalid ID_RUNTIME_CREDENTIAL_POOL JSON: ${err?.message || err}`);
      }
    }

    const teamPool = teamId ? this.runtimeCredentialPoolByTeam.get(teamId) : undefined;
    const configuredPool = teamPool || this.defaultRuntimeCredentialPool;
    const configuredLanes = configuredPool ? this.parseRuntimeCredentialPool(configuredPool, resolved) : [];
    if (configuredLanes.length) return configuredLanes;

    return [{ id: `${resolved}:default`, runtime: resolved, kind: 'subscription' }];
  }

  private chooseRuntimeCredentialLane(runtime: HarnessType | string | undefined, currentLaneId?: string, teamId?: string, excludeCurrentLane: boolean = false): RuntimeCredentialLane {
    const resolved = resolveRuntime(runtime) as HarnessType;
    const lanes = this.runtimeCredentialLanes(resolved, teamId);
    const now = Date.now();
    const healthy = lanes.filter((lane) => {
      if (excludeCurrentLane && currentLaneId && lane.id === currentLaneId) return false;
      const cooldown = this.runtimeLaneCooldowns.get(lane.id);
      return !cooldown || cooldown.coolingUntilMs <= now;
    });
    const current = currentLaneId && !excludeCurrentLane ? healthy.find((lane) => lane.id === currentLaneId) : undefined;
    if (current) return current;
    const subscription = healthy.find((lane) => lane.kind === 'subscription');
    if (subscription) return subscription;
    const configuredMetered = healthy.find((lane) => lane.kind === 'metered-api');
    if (configuredMetered) return configuredMetered;
    return { id: `${resolved}:metered-overflow`, runtime: resolved, kind: 'metered-api' };
  }

  private parseCooldownUntilMs(rateLimit: any): number {
    if (typeof rateLimit?.retryAfterSeconds === 'number' && Number.isFinite(rateLimit.retryAfterSeconds)) {
      return Date.now() + Math.max(0, rateLimit.retryAfterSeconds) * 1000;
    }
    if (typeof rateLimit?.resetAt === 'string') {
      const parsed = Date.parse(rateLimit.resetAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now() + 5 * 60 * 60 * 1000;
  }

  private async recordRuntimeRateLimit(teamId: string, input: {
    agentId?: string;
    agentName?: string;
    runtime?: string;
    laneId?: string;
    queryId?: string;
    rateLimit?: any;
  }): Promise<RuntimeLaneCooldown> {
    const runtime = resolveRuntime(input.runtime) as HarnessType;
    const laneId = input.laneId || `${runtime}:default`;
    const lane = this.runtimeCredentialLanes(runtime, teamId).find((candidate) => candidate.id === laneId);
    const cooldown: RuntimeLaneCooldown = {
      laneId,
      runtime,
      kind: lane?.kind || 'subscription',
      coolingUntilMs: this.parseCooldownUntilMs(input.rateLimit),
      observedAtMs: Date.now(),
      reason: String(input.rateLimit?.reason || 'unknown_rate_limit'),
      teamId,
      agentId: input.agentId,
      agentName: input.agentName,
      queryId: input.queryId,
      resetText: typeof input.rateLimit?.resetText === 'string' ? input.rateLimit.resetText : undefined,
      message: typeof input.rateLimit?.message === 'string' ? input.rateLimit.message : undefined,
    };
    this.runtimeLaneCooldowns.set(laneId, cooldown);
    await this.db.runtimeLaneCooldowns.upsert({
      lane_id: cooldown.laneId,
      runtime: cooldown.runtime,
      kind: cooldown.kind,
      cooling_until_ms: cooldown.coolingUntilMs,
      observed_at_ms: cooldown.observedAtMs,
      reason: cooldown.reason,
      team_id: cooldown.teamId || null,
      agent_id: cooldown.agentId || null,
      agent_name: cooldown.agentName || null,
      query_id: cooldown.queryId || null,
      reset_text: cooldown.resetText || null,
      message: cooldown.message || null,
    });
    await this.db.runtimeLaneCooldowns.pruneExpired(Date.now());

    if (input.agentId) {
      const agent = await this.dbQueryAgentById(teamId, input.agentId).catch(() => null);
      if (agent) {
        const metadata = (agent.metadata as Record<string, unknown>) || {};
        await this.db.agents.updateMetadata(agent.id, {
          ...metadata,
          runtimeRateLimit: {
            laneId,
            coolingUntilMs: cooldown.coolingUntilMs,
            reason: cooldown.reason,
            observedAtMs: cooldown.observedAtMs,
            queryId: cooldown.queryId,
          },
        });
      }
    }

    return cooldown;
  }

  private async hydrateRuntimeStateFromTeams(): Promise<void> {
    const now = Date.now();
    const teams = await this.db.teams.listTeamsWithConfig();
    for (const team of teams) {
      const pool = (team.config as any)?.runtimeCredentialPool;
      if (pool && typeof pool === 'object' && Array.isArray(pool.lanes)) {
        this.runtimeCredentialPoolByTeam.set(team.id, pool as RuntimeCredentialPoolConfig);
      }
    }
    await this.db.runtimeLaneCooldowns.pruneExpired(now);
    const activeCooldowns = await this.db.runtimeLaneCooldowns.listActive(now);
    for (const row of activeCooldowns) {
      this.runtimeLaneCooldowns.set(row.lane_id, {
        laneId: row.lane_id,
        runtime: resolveRuntime(row.runtime) as HarnessType,
        kind: row.kind === 'metered-api' ? 'metered-api' : 'subscription',
        coolingUntilMs: Number(row.cooling_until_ms),
        observedAtMs: Number(row.observed_at_ms),
        reason: row.reason || 'unknown_rate_limit',
        teamId: row.team_id || undefined,
        agentId: row.agent_id || undefined,
        agentName: row.agent_name || undefined,
        queryId: row.query_id || undefined,
        resetText: row.reset_text || undefined,
        message: row.message || undefined,
      });
    }
  }

  private async reconcileDefaultCoderRuntimeFromConfig(): Promise<void> {
    const config = this.defaultDeploymentConfig;
    if (!config?.agents || config.agents.length === 0) return;

    const defaultTeam = await this.db.teams.getTeamByName('default');
    if (!defaultTeam) return;

    const coderSpec = config.agents.find((agent) => agent.name === 'coder');
    if (!coderSpec) return;

    const coderRow = await this.db.agents.getByName(defaultTeam.id, 'coder');
    if (!coderRow || coderRow.deleted_at !== null) return;

    const drift = detectDefaultCoderRuntimeDrift(coderSpec, coderRow, this.defaultConfig?.model);
    if (!drift) return;

    const nextMetadata: Record<string, unknown> = {
      ...stripDefaultCoderRuntimeMetadata((coderRow.metadata || {}) as Record<string, unknown>),
      runtime: drift.runtime,
    };
    delete nextMetadata.pid;
    const nextStatus = coderRow.status === 'running' ? 'starting' : 'pending';

    console.warn(
      `[Manager] default/coder drift detected: runtime ${coderRow.runtime} -> ${drift.runtime}, model ${coderRow.model} -> ${drift.model}`,
    );

    await this.db.agents.updateStatus(coderRow.id, nextStatus, {
      runtime: drift.runtime,
      model: drift.model,
      metadata: nextMetadata,
    });

    this.providerRuntimeAssignments.delete(coderRow.id);

    if (coderRow.status !== 'running') {
      await this.clearAgentPid(coderRow.id);
      return;
    }

    const refreshed = await this.db.agents.getById(coderRow.id);
    if (!refreshed) return;

    const spawnResult = await this.rebuildLocalClaudeAgent(defaultTeam.id, defaultTeam.name, refreshed);
    if (!spawnResult.success) {
      await this.db.agents.updateStatus(coderRow.id, 'error').catch(() => {});
      await this.clearAgentPid(coderRow.id);
      console.error(`[Manager] Failed to resync default/coder at startup: ${spawnResult.error}`);
      return;
    }

    console.log(
      `[Manager] Resynced default/coder at startup to runtime ${drift.runtime} and model ${drift.model}`,
    );
  }

  private async volunteerBrainContext(input: {
    taskId?: string | null;
    agentId?: string | null;
    text: string;
    project?: string | null;
    sessionId?: string | null;
    userId?: string | null;
  }): Promise<BrainVolunteerContext | null> {
    if (process.env.BRAIN_CONTEXT_DISABLED === 'true') return null;
    const dispatchContext = {
      task_id: input.taskId || undefined,
      agent_id: input.agentId || undefined,
      project: input.project || undefined,
      session_id: input.sessionId || undefined,
      user_id: input.userId || undefined,
      text: input.text,
      risk_level: 'normal',
      max_sources: 24,
      max_chars: 24000,
    };
    try {
      await this.validateBrainLearningContract({
        subject: input.taskId || input.agentId || 'manager.dispatch',
        dispatch_context: dispatchContext,
      });
      const res = await fetch(`${this.brainUrl()}/context/volunteer`, {
        method: 'POST',
        headers: this.brainHeaders(),
        body: JSON.stringify({ ...dispatchContext, limit: 3 }),
        signal: AbortSignal.timeout(Number(process.env.BRAIN_CONTEXT_TIMEOUT_MS || 1200)),
      });
      if (!res.ok) return null;
      const json = await res.json() as { data?: BrainVolunteerContext };
      const context = json.data || null;
      const instructions = await this.fetchBrainInstructions({
        brainUrl: this.brainUrl(),
        headers: this.brainHeaders(),
        project: input.project,
        taskId: input.taskId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        userId: input.userId,
      });
      if (!context && instructions.length === 0) return null;
      return { ...(context || { bundles: [] }), task_id: input.taskId || undefined, instructions };
    } catch {
      return null;
    }
  }

  private async postBrain(pathname: string, body: Record<string, unknown>): Promise<void> {
    if (process.env.BRAIN_CONTEXT_DISABLED === 'true') return;
    try {
      await fetch(`${this.brainUrl()}${pathname}`, {
        method: 'POST',
        headers: this.brainHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.BRAIN_CONTEXT_TIMEOUT_MS || 1200)),
      });
    } catch {}
  }

  private async validateBrainLearningContract(body: Record<string, unknown>): Promise<void> {
    await this.postBrain('/manager/learning-contract/validate', {
      strict: false,
      record: true,
      source: 'id-agents-manager',
      ...body,
    });
  }

  private contextPackageId(context?: BrainVolunteerContext | null): number | null {
    const value = context?.context_package_id ?? context?.contextPackageId ?? null;
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private async fetchBrainInstructions(input: {
    brainUrl: string;
    headers: Record<string, string>;
    project?: string | null;
    taskId?: string | null;
    agentId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
  }): Promise<BrainInstruction[]> {
    const params = new URLSearchParams();
    params.set('tag', 'team-instruction');
    params.set('limit', String(Number(process.env.BRAIN_INSTRUCTION_LIMIT || 5)));
    if (input.project) params.set('project', input.project);
    if (input.taskId) params.set('task_id', input.taskId);
    if (input.sessionId) params.set('session_id', input.sessionId);
    if (input.userId) params.set('user_id', input.userId);
    try {
      const res = await fetch(`${input.brainUrl}/memory/shared?${params.toString()}`, {
        method: 'GET',
        headers: input.headers,
        signal: AbortSignal.timeout(Number(process.env.BRAIN_CONTEXT_TIMEOUT_MS || 1200)),
      });
      if (!res.ok) return [];
      const json = await res.json() as { memories?: Array<Record<string, unknown>> };
      return (json.memories || []).filter((memory) => memory.agent_id === 'team-instructions').map((memory) => ({
        source_id: `memory:${Number(memory.id)}`,
        memory_id: Number(memory.id),
        key: String(memory.mem_key || ''),
        content: String(memory.content || ''),
        scope: {
          project: String(memory.project || ''),
          task_id: String(memory.task_id || ''),
          session_id: String(memory.session_id || ''),
          user_id: String(memory.user_id || ''),
          turn_id: String(memory.turn_id || ''),
        },
      })).filter((instruction) => Number.isInteger(instruction.memory_id) && instruction.content.trim().length > 0);
    } catch {
      return [];
    }
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  }

  private async latestTaskClaimBrainContext(teamId: string, taskUuid: string): Promise<BrainVolunteerContext | null> {
    if (!taskUuid) return null;
    const rows = await this.db.events.query({
      teamId,
      topics: ['task:claimed'],
      limit: 200,
    });
    const event = rows
      .slice()
      .reverse()
      .find((row) => row.subject_id === taskUuid && row.subject_kind === 'task');
    const brainContext = event?.data?.brain_context as Record<string, any> | undefined;
    if (!brainContext || typeof brainContext !== 'object') return null;
    const cited = brainContext.cited && typeof brainContext.cited === 'object'
      ? brainContext.cited
      : undefined;
    return {
      bundles: [],
      cited: cited ? {
        entity_ids: Array.isArray(cited.entity_ids) ? cited.entity_ids.map(String) : undefined,
        fact_ids: Array.isArray(cited.fact_ids) ? cited.fact_ids.map(Number).filter(Number.isInteger) : undefined,
        text_unit_ids: Array.isArray(cited.text_unit_ids) ? cited.text_unit_ids.map(Number).filter(Number.isInteger) : undefined,
        canonical_source_ids: Array.isArray(cited.canonical_source_ids) ? cited.canonical_source_ids.map(String) : undefined,
        source_origins: cited.source_origins && typeof cited.source_origins === 'object' ? cited.source_origins as Record<string, string[]> : undefined,
      } : undefined,
      timelineEventId: Number.isInteger(brainContext.timelineEventId)
        ? brainContext.timelineEventId
        : Number.isInteger(brainContext.timeline_event_id)
          ? brainContext.timeline_event_id
          : null,
      context_package_id: Number.isInteger(brainContext.context_package_id)
        ? brainContext.context_package_id
        : Number.isInteger(brainContext.contextPackageId)
          ? brainContext.contextPackageId
          : null,
      task_id: `task:${taskUuid}`,
    };
  }

  private async postBrainInstructionFeedback(input: {
    taskId?: string | null;
    queryId?: string | null;
    agentId?: string | null;
    context?: BrainVolunteerContext | null;
    payload?: Record<string, unknown> | null;
  }): Promise<void> {
    const instructionIds = (input.context?.instructions || []).map((item) => item.source_id);
    const used = this.stringArray((input.payload as any)?.used_instruction_ids || (input.payload as any)?.usedInstructionIds);
    const harmful = this.stringArray((input.payload as any)?.harmful_instruction_ids || (input.payload as any)?.harmfulInstructionIds);
    const explicitIgnored = this.stringArray((input.payload as any)?.ignored_instruction_ids || (input.payload as any)?.ignoredInstructionIds);
    const ignored = explicitIgnored.length ? explicitIgnored : instructionIds.filter((sourceId) => !used.includes(sourceId) && !harmful.includes(sourceId));
    if (!used.length && !ignored.length && !harmful.length) return;
    const feedbackPayload = {
      task_id: input.taskId || undefined,
      query_id: input.queryId || undefined,
      agent_id: input.agentId || undefined,
      used_instruction_ids: used,
      ignored_instruction_ids: ignored,
      harmful_instruction_ids: harmful,
      metadata: { source: 'id-agents-manager' },
    };
    await this.validateBrainLearningContract({
      subject: input.taskId || input.queryId || 'manager.instructions',
      instruction_feedback: feedbackPayload,
    });
    await this.postBrain('/instructions/feedback', feedbackPayload);
    await this.postBrainContextEdges(input.context);
  }

  private async postBrainContextEdges(context?: BrainVolunteerContext | null): Promise<void> {
    const entities = (context?.bundles || [])
      .flatMap((bundle) => bundle.entities || [])
      .filter((entity): entity is { id: string; name?: string; type?: string } => typeof entity?.id === 'string' && entity.id.length > 0)
      .map((entity) => ({ id: entity.id, name: entity.name, type: entity.type }));
    if (entities.length < 2) return;
    const textUnits = (context?.bundles || []).flatMap((bundle) => bundle.textUnits || []);
    const texts = (context?.instructions || []).map((instruction) => instruction.content).filter(Boolean);
    const edges = inferEntityEdges({ entities, textUnits, texts });
    if (!edges.length) return;
    await this.postBrain('/entity-edges/bulk', { edges });
  }

  private async postBrainEvalCapture(input: {
    queryText: string;
    route: string;
    agentId?: string | null;
    taskId?: string | null;
    queryId?: string | null;
    context?: BrainVolunteerContext | null;
    usedSourceIds?: string[];
    volunteeredSourceIds?: string[];
    injectedInstructionIds?: string[];
    latencyMs?: number | null;
    learningLoop?: LearningLoopCapture | null;
  }): Promise<void> {
    const volunteeredSourceIds = input.volunteeredSourceIds?.length ? input.volunteeredSourceIds : input.context?.cited?.canonical_source_ids || [];
    const payload = {
      query_text: input.queryText,
      route: input.route,
      agent_id: input.agentId || undefined,
      task_id: input.taskId || undefined,
      accepted_ids: input.usedSourceIds || [],
      volunteered_source_ids: volunteeredSourceIds,
      context_package_id: this.contextPackageId(input.context),
      latency_ms: input.latencyMs ?? undefined,
      metadata: {
        source: 'id-agents-manager',
        query_id: input.queryId || undefined,
        brain_context_timeline_event_id: input.context?.timelineEventId,
        source_origins: input.context?.cited?.source_origins || {},
        injected_instruction_ids: input.injectedInstructionIds || [],
        ...(input.learningLoop ? { learning_loop: input.learningLoop } : {}),
      },
    };
    await this.validateBrainLearningContract({
      subject: input.taskId || input.queryId || 'manager.eval',
      eval_feedback: payload,
    });
    if (input.learningLoop) {
      await this.validateBrainLearningContract({
        subject: input.taskId || input.queryId || 'manager.learning_loop',
        learned_artifact: input.learningLoop,
      });
    }
    await this.postBrain('/eval/capture', payload);
    if (volunteeredSourceIds.length && !(input.usedSourceIds || []).length) {
      await this.postBrain('/context/feedback-missing', {
        task_id: input.taskId || undefined,
        query_id: input.queryId || undefined,
        agent_id: input.agentId || undefined,
        query_text: input.queryText,
        route: input.route,
        brain_context: input.context || undefined,
        volunteered_source_ids: volunteeredSourceIds,
      });
    }
  }

  private withBrainContextAppendix(message: string, context: BrainVolunteerContext | null): string {
    if (!context?.bundles?.length && !context?.instructions?.length) return message;
    const lines = ['Brain context:'];
    if (context.instructions?.length) {
      lines.push('Team instructions:');
      for (const instruction of context.instructions.slice(0, 5)) {
        lines.push(`- ${instruction.content} [${instruction.source_id}]`);
      }
      lines.push('Report instruction usefulness as used_instruction_ids, ignored_instruction_ids, or harmful_instruction_ids.');
    }
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
        const excerpt = String(unit.content || '').replace(/\\s+/g, ' ').slice(0, 240);
        lines.push(`  Source: ${unit.title || unit.source_id || 'text unit'} [text:${unit.id}] ${excerpt}`);
      }
    }
    const canonical = context.cited?.canonical_source_ids || [];
    if (canonical.length) lines.push(`Cite used Brain sources as used_source_ids: ${canonical.join(', ')}`);
    return `${message}\n\n${lines.join('\n')}`;
  }

  /**
   * Unified message handler for both /message and /talk-to.
   * Default: fire-and-forget. With wait:true or timeout: waits for reply.
   */
  private async handleMessage(req: express.Request, res: express.Response) {
    try {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const { agent: agentField, to: toField, message, from, session_id, wait, timeout: requestTimeout } = req.body || {};
      const agent = toField || agentField;

      if (!agent || !message) {
        return res.status(400).json({ error: 'Missing "to" (agent name) or "message"' });
      }

      // Determine if we should wait for a reply
      const shouldWait = wait === true || requestTimeout !== undefined;

      // Parse timeout (only relevant when waiting)
      const DEFAULT_TIMEOUT = 24 * 60 * 60 * 1000;
      const MAX_TIMEOUT = 24 * 60 * 60 * 1000;
      const timeout = shouldWait
        ? Math.min(Math.max(parseInt(requestTimeout) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT)
        : 0;

      if (String(agent).toLowerCase() === 'manager') {
        const { name: teamName } = await this.getTeam(req);
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const ts = Date.now();

        if (!shouldWait) {
          await this.db.news.add(teamId, null, {
            timestamp: ts,
            type: 'message',
            message: message,
            data: { from: from || 'manager', message },
            kind: 'notify',
            reply_expected: false,
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
          return res.json({
            success: true,
            delivered_to: 'manager',
            status: 'delivered',
          });
        }

        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;
        await this.db.queries.create(
          teamId,
          queryId,
          null,
          `[From: ${from || 'manager'}] ${message}`,
          ts,
          session_id || undefined,
          { owner_kind: managerInbox.ownerKind, owner_id: managerInbox.ownerId },
        );
        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.received',
          message: `Query from ${from || 'manager'}: ${String(message).slice(0, 100)}${String(message).length > 100 ? '...' : ''}`,
          data: { from: from || 'manager', message, session_id, query_id: queryId },
          query_id: queryId,
          kind: 'talk',
          reply_expected: true,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        this.managerLog(`Queued reserved-route message to manager, query_id: ${queryId}`);

        let timeoutHandle: NodeJS.Timeout | null = null;
        let httpTimedOut = false;
        const replyPromise = new Promise<{ from: string; message: string }>((resolve) => {
          this.queryWaiters.set(queryId, {
            resolve,
            reject: () => {},
            timeout: null as any,
          });
          if (timeout < 24 * 60 * 60 * 1000) {
            timeoutHandle = setTimeout(() => {
              httpTimedOut = true;
              resolve({ from: '', message: '' });
            }, timeout);
          }
        });
        const replyResult = await replyPromise;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (httpTimedOut) {
          return res.json({
            success: false,
            from: 'manager',
            query_id: queryId,
            message: `Request timed out after ${timeout}ms - reply will be delivered when it arrives`,
            status: 'pending',
          });
        }
        return res.json({
          success: true,
          from: replyResult.from || 'manager',
          reply: replyResult.message,
          query_id: queryId,
        });
      }

      // Resolve the target agent
      const resolved = await this.resolveTargetAgent(teamId, agent);
      if ('error' in resolved) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      const { targetAgent, targetUrl, targetDisplayId } = resolved;

      // Mesh-membership gate: only mesh members can receive inter-agent messages.
      // mesh_member defaults to true for backward compat (pre-Phase-4 agents have no flag).
      // Admin callers may bypass via ?admin=true for diagnostic purposes — EXCEPT
      // when the target is a public-agent-remote runtime. Public remote agents
      // live in the DMZ; routing manager-proxied traffic to them through an admin
      // escape hatch would rebuild the proxy path the DMZ design explicitly
      // forbids. Public conversations must use direct HTTPS; operator plane must
      // use SSH. No admin override here.
      const meshMember = (targetAgent.metadata as any)?.mesh_member !== false;
      const isPublicRemote = targetAgent.runtime === 'public-agent-remote';
      const adminBypass = this.isAdminRequest(req) && req.query.admin === 'true' && !isPublicRemote;
      if (!meshMember && !adminBypass) {
        return res.status(403).json({
          error: 'not_mesh_reachable',
          message: isPublicRemote
            ? 'Target is a public-agent-remote runtime. Reach it via direct HTTPS (/talk) or SSH (operator plane); no manager-proxied admin bypass.'
            : 'Target agent is not part of the inter-agent mesh.'
        });
      }

      this.managerLog(`${shouldWait ? 'Forwarding' : 'Sending async'} message to ${targetDisplayId} at ${targetUrl}`);
      const autoAttach = (req as any)._autoAttach as { task?: TaskRow } | undefined;
      const taskIdForBrain = autoAttach?.task?.uuid ? `task:${autoAttach.task.uuid}` : null;
      const brainContext = await this.volunteerBrainContext({
        taskId: taskIdForBrain,
        agentId: targetAgent.id,
        text: String(message),
        project: teamName,
        sessionId: session_id || null,
      });
      const outgoingMessage = this.withBrainContextAppendix(String(message), brainContext);

      if (shouldWait && from && String(from).toLowerCase() !== 'manager') {
        this.releaseLocalGateForAgent(String(from));
      }

      // Serialize local-model dispatch (#7): wait for a slot if this target runs
      // a local model; API-backed targets pass through immediately.
      const lmgToken = await this.acquireLocalGate(targetAgent.runtime);

      // Forward the message to the agent's /talk endpoint
      const result = await this.forwardToAgent(targetUrl, outgoingMessage, from || 'manager', session_id);
      if (!result.ok) {
        this.bindLocalGate(lmgToken); // dispatch failed → release the slot now
        console.error(`[Manager] Failed to deliver message to ${targetDisplayId}: ${result.status}`);
        return res.status(result.status).json({ error: result.error });
      }

      const queryId = result.data.query_id;
      this.bindLocalGate(lmgToken, queryId, targetAgent.name); // released when the query completes/fails

      // Store the query so replies can be routed correctly
      if (queryId) {
        await this.db.queries.create(
          teamId,
          queryId,
          targetAgent.id,
          outgoingMessage,
          Date.now(),
          undefined,
          undefined,
          brainContext ? { brain_context: brainContext } : null,
        );
        if (brainContext) this.queryBrainContext.set(queryId, brainContext);
      }

      // Fire-and-forget: return immediately
      if (!shouldWait) {
        this.managerLog(`Message delivered to ${targetDisplayId}, query_id: ${queryId} (fire-and-forget)`);
        return res.json({
          success: true,
          query_id: queryId,
          delivered_to: targetDisplayId,
          status: 'delivered',
          ...(brainContext ? { brain_context: { cited: brainContext.cited, timelineEventId: brainContext.timelineEventId, context_package_id: brainContext.context_package_id ?? brainContext.contextPackageId, instructions: brainContext.instructions || [] } } : {}),
        });
      }

      // Wait mode: block until reply arrives or timeout
      this.managerLog(`Waiting up to ${timeout}ms for reply from ${targetDisplayId}, query_id: ${queryId}`);

      if (!queryId) {
        return res.json(result.data);
      }

      let timeoutHandle: NodeJS.Timeout | null = null;
      let httpTimedOut = false;

      const replyPromise = new Promise<{ from: string; message: string }>((resolve) => {
        this.queryWaiters.set(queryId, {
          resolve,
          reject: () => {},
          timeout: null as any
        });

        if (timeout < 24 * 60 * 60 * 1000) {
          timeoutHandle = setTimeout(() => {
            httpTimedOut = true;
            resolve({ from: '', message: '' });
          }, timeout);
        }
      });

      const replyResult = await replyPromise;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (httpTimedOut) {
        this.managerLog(`HTTP timeout waiting for ${targetDisplayId} (${timeout}ms) - waiter persists`);
        return res.json({
          success: false,
          from: targetDisplayId,
          query_id: queryId,
          message: `Request timed out after ${timeout}ms - reply will be delivered when it arrives`,
          status: 'pending'
        });
      }

      this.managerLog(`Received reply from ${targetDisplayId} for query ${queryId}`);
      return res.json({
        success: true,
        from: replyResult.from || targetDisplayId,
        reply: replyResult.message,
        query_id: queryId
      });
    } catch (err: any) {
      console.error('[Manager] Error in POST /message:', err);
      res.status(500).json({ error: err?.message || 'Internal server error' });
    }
  }

  /**
   * /talk-to auto-attach hook. Inspects the request body and, if a task
   * delegation is requested, creates the task + (unless opted out) an
   * active checkin watched by the dispatcher. Throws an Error with
   * `status` and `code` properties on validation failures so the caller
   * can return a 4xx response with a stable error code.
   *
   * Returns null when the body has no `task` field (legacy /talk-to path).
   */
  private async maybeAutoAttachForTalkTo(
    req: express.Request,
  ): Promise<{ task: TaskRow; checkin: CheckinRow | null } | null> {
    const body = req.body || {};
    if (!body.task || typeof body.task !== 'object') return null;

    const { id: teamId } = await this.getTeam(req);
    const taskSpec = body.task as { title?: unknown; name?: unknown; description?: unknown } & TaskBriefValidationInput;
    if (!taskSpec.title || typeof taskSpec.title !== 'string') {
      throw makeAutoAttachError(400, 'invalid_task_title');
    }

    const targetRef = body.to ?? body.agent;
    if (!targetRef || typeof targetRef !== 'string') {
      throw makeAutoAttachError(400, 'invalid_target_agent');
    }
    const targetResolved = await this.resolveSingleAgentForCommand(teamId, targetRef);
    if (!targetResolved.agent) {
      throw makeAutoAttachError(404, 'target_agent_not_found');
    }
    const targetAgent = targetResolved.agent;
    if (!(await this.hasDoingTaskRoom(teamId))) {
      throw makeAutoAttachError(409, 'doing_task_limit_reached');
    }

    const fromRef = body.from;
    let fromAgent: AgentRow | undefined;
    if (fromRef && typeof fromRef === 'string') {
      const r = await this.resolveSingleAgentForCommand(teamId, fromRef);
      fromAgent = r.agent;
    }

    const flagsResult = parseAutoAttachFlags(body);
    if (flagsResult.error) {
      throw makeAutoAttachError(400, flagsResult.error);
    }

    const description = appendTaskBriefFieldsToDescription(taskSpec.description, {
      ...body,
      ...taskSpec,
      title: taskSpec.title,
      description: taskSpec.description,
    });
    const brief = this.validateIncomingTaskBrief({
      ...body,
      ...taskSpec,
      title: taskSpec.title,
      description,
    }, { immediateExecution: true });
    if (brief.blocked) {
      throw makeAutoAttachError(422, 'task_brief_not_dispatch_ready', { brief_validation: brief.validation });
    }

    const validatorGuard = await this.validateValidatorChildTaskCreation({
      teamId,
      input: {
        ...body,
        ...taskSpec,
        title: taskSpec.title,
        description,
      },
      fromAgent,
      targetAgent,
    });
    if (validatorGuard) {
      throw makeAutoAttachError(validatorGuard.status, validatorGuard.code, {
        message: validatorGuard.message,
        ...(validatorGuard.existingTask ? { existing_task: validatorGuard.existingTask } : {}),
      });
    }

    const requestedName = typeof taskSpec.name === 'string' && taskSpec.name.length > 0
      ? normalizeAlias(taskSpec.name)
      : null;
    const baseName = requestedName || normalizeAlias(taskSpec.title);
    let name = baseName;
    if (requestedName) {
      if (await this.db.tasks.getByNameForTeam(name, teamId)) {
        throw makeAutoAttachError(409, 'task_name_conflict');
      }
    } else {
      let suffix = 1;
      while (await this.db.tasks.getByNameForTeam(name, teamId)) {
        name = `${baseName}-${suffix++}`;
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const taskRow: TaskRow = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name,
      uuid: crypto.randomUUID(),
      team_id: teamId,
      title: taskSpec.title,
      description,
      status: 'doing',
      created_by: fromAgent?.id ?? null,
      owner: targetAgent.id,
      created_at: nowSec,
      updated_at: nowSec,
      completed_at: null,
    };
    await this.db.tasks.create(taskRow);

    if (flagsResult.disabled) {
      return { task: taskRow, checkin: null };
    }

    const nowMs = Date.now();
    const intervalSeconds = flagsResult.intervalSeconds ?? AUTO_ATTACH_DEFAULT_INTERVAL_SECONDS;
    const maxIterations = flagsResult.maxIterations ?? null;

    const checkinRow: CheckinRow = {
      id: generateCheckinId(nowMs),
      team_id: teamId,
      // Auto-attached check-ins supervise the linked task, so the dispatchable
      // owner must match the task owner even when the sender is the manager.
      owner_agent_id: targetAgent.id,
      created_by_agent_id: fromAgent?.id ?? null,
      linked_task_id: taskRow.id,
      interval_seconds: intervalSeconds,
      priority: 'normal',
      status: 'active',
      close_when: DEFAULT_CLOSE_WHEN,
      max_iterations: maxIterations,
      iteration_count: 0,
      next_fire_at: nowMs + intervalSeconds * 1000,
      snooze_until: null,
      ttl_expires_at: null,
      last_fire_at: null,
      last_event_seq: null,
      note: null,
      created_at: nowMs,
      updated_at: nowMs,
      closed_at: null,
      closed_reason: null,
    };
    await this.db.checkins.create(checkinRow);

    try {
      await recordCheckinCreated(this.db.events, this.db.checkins, {
        teamId,
        checkinId: checkinRow.id,
        ownerAgentId: checkinRow.owner_agent_id,
        createdByAgentId: checkinRow.created_by_agent_id,
        linkedTaskId: checkinRow.linked_task_id,
        priority: checkinRow.priority,
        intervalSeconds: checkinRow.interval_seconds,
        maxIterations: checkinRow.max_iterations,
        nextFireAt: checkinRow.next_fire_at,
        ttlExpiresAt: checkinRow.ttl_expires_at,
        occurredAt: nowMs,
      });
    } catch (err) {
      console.error('[Manager] Failed to emit checkin:created on auto-attach:', err);
    }

    return { task: taskRow, checkin: checkinRow };
  }

  /**
   * Resolve whether a request is from an admin principal.
   * Admin = loopback IP + X-Id-Admin: 1 header.
   */
  private isAdminRequest(req: express.Request): boolean {
    const ip = req.ip || '';
    const isLoopback =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const hasAdminHeader = req.headers['x-id-admin'] === '1';
    return isLoopback && hasAdminHeader;
  }

  /**
   * Team/principal context middleware.
   * Resolves once per request and attaches:
   *   (req as any).ctx = { principal, teamName, teamId }
   *
   * principal:
   *   'admin'  — loopback IP + X-Id-Admin: 1
   *   'agent'  — X-Id-Agent: <id> present and the agent belongs to the resolved team
   *   'anon'   — all other callers
   *
   * teamId resolution:
   *   - admin principals: getOrCreate (same as legacy behaviour)
   *   - non-admin: getTeamByName only; 404 if team does not exist
   */
  private teamContextMiddleware(): express.RequestHandler {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const teamName = this.getTeamName(req);
        const principal = this.isAdminRequest(req) ? 'admin' : 'anon';

        let teamId: string;
        if (principal === 'admin') {
          // Admin principals may create teams on the fly (legacy behaviour)
          teamId = await this.db.teams.getOrCreateTeamId(teamName);
          // Ensure per-team directory exists
          const teamDir = `${this.baseWorkDir}/teams/${teamName}`;
          if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        } else {
          // Non-admin: team must already exist
          const teamRow = await this.db.teams.getTeamByName(teamName);
          if (!teamRow) {
            res.status(404).json({ error: 'team_not_found' });
            return;
          }
          teamId = teamRow.id;
          // Ensure per-team directory exists
          const teamDir = `${this.baseWorkDir}/teams/${teamName}`;
          if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        }

        // Check agent principal claim
        let resolvedPrincipal: 'admin' | 'agent' | 'anon' = principal === 'admin' ? 'admin' : 'anon';
        const agentHeader = req.headers['x-id-agent'];
        if (agentHeader && typeof agentHeader === 'string' && resolvedPrincipal !== 'admin') {
          const agentRow = await this.db.agents.getById(agentHeader);
          if (agentRow && agentRow.team_id === teamId) {
            resolvedPrincipal = 'agent';
          } else if (agentRow && agentRow.team_id !== teamId) {
            // Agent exists but belongs to a different team — reject
            res.status(403).json({ error: 'agent_team_mismatch' });
            return;
          }
          // If agent doesn't exist at all, fall through as 'anon'
        }

        (req as any).ctx = { principal: resolvedPrincipal, teamName, teamId };
        next();
      } catch (err: any) {
        // Invalid team name or other error
        res.status(400).json({ error: err?.message || 'Invalid request context' });
      }
    };
  }

  private setupRoutes() {
    // REST-AP discovery — daemon root advertises itself as the manager so
    // peers can locate the team orchestration and inbox surface directly.
    // Shape mirrors the per-agent catalogs published by claude-agent-server /
    // interactive-agent-server (restap_version + agent + endpoints + capabilities).
    // This route must stay outside team scoping: discovery at the daemon root
    // should not depend on a team already existing or a caller sending a team header.
    this.managementApp.get('/.well-known/restap.json', (_req, res) => {
      res.json({
        restap_version: '1.0',
        agent: {
          name: 'manager',
          description:
            'Manager daemon — team orchestration, inbox, scheduling, registry, and event fan-out for the id-agents control plane.',
        },
        provider: {
          name: 'id-agents',
          version: '1.0',
        },
        endpoints: {
          talk: '/talk',
          schedule: '/schedule',
          news: '/news',
          news_post: '/news',
        },
        capabilities: [
          {
            id: 'talk',
            title: 'Send a message or question to the manager',
            method: 'POST',
            endpoint: '/talk',
            description:
              'Post a message or question to the manager inbox. Persists to the manager DB; replies arrive via /news.',
            input_schema: {
              message: 'string (required)',
              from: 'string (optional) - sender agent name or id',
              session_id: 'string (optional) - prior session id for context continuity',
            },
          },
          {
            id: 'schedule',
            title: 'Enqueue scheduled work for the manager',
            method: 'POST',
            endpoint: '/schedule',
            description:
              'Submit a manager-owned scheduled event. Internal mode enqueues work without auto-reply.',
            input_schema: {
              message: 'string (required)',
              schedule:
                'object (required) - schedule metadata including id, kind, title, scheduledKey',
              mode: 'string (optional) - "internal" for autonomous wake-ups',
            },
          },
          {
            id: 'news',
            title: 'Poll manager news feed',
            method: 'GET',
            endpoint: '/news',
            description:
              'Poll for manager inbox updates and replies. Supports since (timestamp), limit, query_id, chars_start/chars_end.',
            input_schema: {
              since: 'number (optional) - timestamp to filter items after',
              limit: 'number (optional) - maximum number of items to return',
              query_id: 'string (optional) - filter items by specific query_id',
              chars_start: 'number (optional) - start position in character range (0 = newest)',
              chars_end: 'number (optional) - end position in character range (must be > chars_start)',
            },
          },
          {
            id: 'news_receive',
            title: 'Deliver a message or reply to the manager',
            method: 'POST',
            endpoint: '/news',
            description:
              'Receive messages or replies addressed to the manager inbox. Does not trigger LLM processing.',
            input_schema: {
              type: 'string (optional) - message type, e.g. "reply" or "message"',
              from: 'string (optional) - sender agent name',
              message: 'string (required) - the message content',
              in_reply_to: 'string (optional) - query_id this is replying to',
            },
          },
        ],
        extensions: {
          remote: '/remote',
          query: '/query/:id',
          tasks: '/tasks',
          agents: '/agents',
          events: '/events',
          ws: '/ws',
        },
      });
    });

    // Install team/principal context middleware for all remaining routes
    this.managementApp.use(this.teamContextMiddleware());

    this.managementApp.get('/health', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const count = await this.db.agents.count(teamId);
      res.json({ status: 'ok', team: teamName, agents: parseInt(count || '0'), timestamp: Date.now() });
    });

    // Slice 7: read-only library inventory. Library root is captured at
    // manager construction from `opts.libraryRoot` (tests) or from
    // resolveDefaultLibraryRoot() (prod: ID_LIBRARY_ROOT env, else
    // <cwd>/configs, else null). When null, listings return an empty
    // collection and detail routes return 404 — "no library configured"
    // is a first-class state, not an error.
    this.managementApp.get('/library/agents', (_req, res) => {
      res.json(listLibraryAgents(this.libraryRoot));
    });

    this.managementApp.get('/library/agents/:name', (req, res) => {
      const detail = getLibraryAgent(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-agent', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    this.managementApp.get('/library/skills', (_req, res) => {
      res.json(listLibrarySkills(this.libraryRoot));
    });

    this.managementApp.get('/library/skills/:name', (req, res) => {
      const detail = getLibrarySkill(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-skill', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    // Team-template inventory (slice 1). Mirrors /library/agents and
    // /library/skills. Empty list / 404 when no library is configured.
    this.managementApp.get('/library/teams', (_req, res) => {
      res.json(listLibraryTeams(this.libraryRoot));
    });

    this.managementApp.get('/library/teams/:name', (req, res) => {
      const detail = getLibraryTeam(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-team', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    // POST /library/install — installs a library entry into the manager's
    // library root. Slice 1: only `team:<template>` -> `team:<dest>` is
    // implemented; agent/skill installs return 400 with `unsupported_kind`
    // so future slices can add them without a breaking change.
    this.managementApp.post('/library/install', (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const fromSel = parseSelector((body as Record<string, unknown>).from);
      const toSel = parseSelector((body as Record<string, unknown>).to);
      const force = (body as Record<string, unknown>).force === true;
      const paramsRaw = (body as Record<string, unknown>).params;
      const params: Record<string, unknown> = (paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw))
        ? (paramsRaw as Record<string, unknown>)
        : {};

      if (!fromSel) {
        res.status(400).json({ error: 'bad_selector', field: 'from', value: (body as Record<string, unknown>).from ?? null });
        return;
      }
      if (!toSel) {
        res.status(400).json({ error: 'bad_selector', field: 'to', value: (body as Record<string, unknown>).to ?? null });
        return;
      }
      if (fromSel.kind !== toSel.kind) {
        res.status(400).json({ error: 'kind_mismatch', fromKind: fromSel.kind, toKind: toSel.kind });
        return;
      }
      if (fromSel.kind !== 'team') {
        res.status(400).json({ error: 'unsupported_kind', kind: fromSel.kind });
        return;
      }
      if (paramsRaw !== undefined && (paramsRaw === null || typeof paramsRaw !== 'object' || Array.isArray(paramsRaw))) {
        res.status(400).json({ error: 'bad_params', message: 'params must be an object' });
        return;
      }

      const result = installLibraryTeam(this.libraryRoot, {
        template: fromSel.name,
        dest: toSel.name,
        force,
      });
      if (!result.ok) {
        const { ok: _ok, status, ...rest } = result;
        res.status(status).json(rest);
        return;
      }
      res.json(result);
    });

    // Installable plugins (plugins/claude-code). Read-only inventory, mirrors
    // the skills routes. Returns an empty list when no plugins root exists.
    this.managementApp.get('/library/plugins', (_req, res) => {
      res.json(listLibraryPlugins(this.libraryRoot));
    });

    this.managementApp.get('/library/plugins/:name', (req, res) => {
      const detail = getLibraryPlugin(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-plugin', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    // Install a library skill onto an agent: persist it to metadata.skills
    // (so a future rebuild re-deploys it) and copy SKILL.md into the live
    // workdir for immediate effect. Admin-gated (loopback + X-Id-Admin).
    this.managementApp.post('/library/skills/install', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) {
          return res.status(403).json({ error: 'admin_required' });
        }
        const { skill, agent: agentRef } = req.body || {};
        if (!skill || typeof skill !== 'string') {
          return res.status(400).json({ error: 'Missing skill in request body' });
        }
        // Strict skill-name charset — `skill` flows into path.join below, so
        // reject any traversal / separators before touching the filesystem.
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skill)) {
          return res.status(400).json({ error: 'invalid skill name' });
        }
        if (!agentRef || typeof agentRef !== 'string') {
          return res.status(400).json({ error: 'Missing agent in request body' });
        }
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, agentRef)
          ?? await this.dbQueryAgentByNameMostRecent(teamId, agentRef);
        if (!agent) return res.status(404).json({ error: 'Agent not found', name: agentRef });

        // Resolve the skill source from the SAME root the listing uses
        // (getLibraryPaths(libraryRoot).skills), so "what you can install" ==
        // "what /library/skills lists"; fall back to the bundled skills/.
        const skillsRoot = this.libraryRoot
          ? getLibraryPaths(this.libraryRoot).skills
          : path.resolve(__dirname, '..', 'skills');
        if (!existsSync(path.join(skillsRoot, skill, 'SKILL.md'))) {
          return res.status(404).json({ error: 'not_found', resource: 'library-skill', name: skill });
        }

        const workingDirectory = agent.working_directory
          || (agent.metadata as any)?.workingDirectory
          || path.join(this.baseWorkDir, 'agents', agent.name);
        const hasWallet = !!(agent.metadata as any)?.ows_wallet || !!(agent.metadata as any)?.wallet;
        this.deploySkillsToAgent(workingDirectory, [skill], {
          DISPLAY_NAME: agent.domain || agent.name,
          TEAM: teamName,
          ONCHAIN_IDENTITY: agent.domain ? `Your onchain identity is your ENS domain: **${agent.domain}**` : '',
          ORG_CONTEXT: '',
        }, { hasWallet, runtime: agent.runtime || undefined, skillsRoot });

        // Persist to metadata.skills (deduped) so the skill survives rebuilds.
        const cur = (agent.metadata as Record<string, unknown>) || {};
        const existing = Array.isArray((cur as any).skills) ? ((cur as any).skills as string[]) : [];
        const skills = existing.includes(skill) ? existing : [...existing, skill];
        await this.db.agents.updateMetadata(agent.id, { ...cur, skills });

        res.json({ installed: skill, agent: agent.name, skills });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // Create a new library skill as an agentskills.io-compliant folder
    // (<skillsDir>/<name>/SKILL.md). Admin-gated (loopback + X-Id-Admin).
    // Validation + filesystem writes live in createLibrarySkill(); it refuses
    // path traversal and (by default) refuses to overwrite an existing skill.
    this.managementApp.post('/library/skills/create', (req, res) => {
      if (!this.isAdminRequest(req)) {
        return res.status(403).json({ error: 'admin_required' });
      }
      const result = createLibrarySkill(this.libraryRoot, req.body || {});
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      return res.status(result.status).json(result.entry);
    });

    // Delete a library skill folder. Admin-gated. Validation + symlink/containment
    // guards live in deleteLibrarySkill(). Does NOT touch agents already carrying
    // the skill — use /library/skills/uninstall for that.
    this.managementApp.delete('/library/skills/:name', (req, res) => {
      if (!this.isAdminRequest(req)) {
        return res.status(403).json({ error: 'admin_required' });
      }
      const result = deleteLibrarySkill(this.libraryRoot, req.params.name);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      return res.status(result.status).json({ removed: result.removed });
    });

    // Uninstall a skill from an agent: drop it from metadata.skills and remove
    // the deployed SKILL.md from the live workdir. Admin-gated. Inverse of
    // POST /library/skills/install.
    this.managementApp.post('/library/skills/uninstall', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) {
          return res.status(403).json({ error: 'admin_required' });
        }
        const { skill, agent: agentRef } = req.body || {};
        if (!skill || typeof skill !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(skill)) {
          return res.status(400).json({ error: 'invalid skill name' });
        }
        if (!agentRef || typeof agentRef !== 'string') {
          return res.status(400).json({ error: 'Missing agent in request body' });
        }
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, agentRef)
          ?? await this.dbQueryAgentByNameMostRecent(teamId, agentRef);
        if (!agent) return res.status(404).json({ error: 'Agent not found', name: agentRef });

        // Remove the deployed skill dir from both runtime layouts (whichever exists).
        const workingDirectory = agent.working_directory
          || (agent.metadata as any)?.workingDirectory
          || path.join(this.baseWorkDir, 'agents', agent.name);
        for (const rel of ['.claude/skills', '.agents/skills']) {
          const p = path.join(workingDirectory, rel, skill);
          if (existsSync(p)) {
            try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        }

        // Persist metadata.skills without the removed skill.
        const cur = (agent.metadata as Record<string, unknown>) || {};
        const existing = Array.isArray((cur as any).skills) ? ((cur as any).skills as string[]) : [];
        const skills = existing.filter((s) => s !== skill);
        await this.db.agents.updateMetadata(agent.id, { ...cur, skills });

        res.json({ uninstalled: skill, agent: agent.name, skills });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // ---- Local-model token usage (Ollama) -------------------------------
    // Agents running local models fire-and-forget POST /usage/record after each
    // generation; GET /usage aggregates it into 24h/7d summaries + a live
    // throughput reading for the Health page. Stored as an append-only JSONL log
    // under <baseWorkDir>/manager — no schema change, and fully decoupled from
    // the dispatch / query / news lifecycle (a bad report can never affect a reply).
    this.managementApp.post('/usage/record', (req, res) => {
      const ip = req.ip || '';
      const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!loopback) return res.status(403).json({ error: 'loopback_required' });
      try {
        const b = req.body || {};
        const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
        const str = (v: unknown, max = 64): string => (typeof v === 'string' ? v.slice(0, max) : '');
        const rec = {
          ts: Date.now(),
          runtime: str(b.runtime) || 'ollama',
          model: str(b.model, 80),
          agent: str(b.agent),
          team: str(b.team),
          input: num(b.input),
          output: num(b.output),
          genMs: num(b.genMs),
          tps: num(b.tps),
          query_id: str(b.query_id, 80) || undefined, // attribute the turn to the task this query worked
        };
        if (rec.input == null && rec.output == null) {
          return res.status(400).json({ error: 'no_tokens' });
        }
        writeFileSync(this.usageLogPath(), JSON.stringify(rec) + '\n', { flag: 'a' });
        return res.json({ ok: true });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // Control Center capability discovery: lets the GUI feature-detect which CC-only routes this
    // manager supports (vs stock upstream) and degrade gracefully. See src/control-center/manifest.ts.
    this.managementApp.get('/capabilities', (_req, res) => {
      res.json(ccCapabilities());
    });

    this.managementApp.get('/usage', (req, res) => {
      try {
        const now = Date.now();
        const records = this.readUsageRecords();
        // A single turn's NEW input can't exceed the model's context window; records far larger
        // are stale cache-inflated reports from agents still on the pre-fix harness — drop them so
        // the fleet totals reflect real (non-cached) spend, not the cached context re-counted.
        const MAX_TURN_INPUT = 1_000_000;
        const summarize = (windowMs: number) => {
          const since = now - windowMs;
          const rows = records.filter((r) => r.ts >= since && (r.input || 0) <= MAX_TURN_INPUT);
          let input = 0, output = 0, genMs = 0;
          // Track input AND output per agent/model so the per-row "total tokens" reconciles
          // with the window total (input+output) — not output-only.
          const byAgent = new Map<string, { count: number; input: number; output: number; genMs: number }>();
          const byModel = new Map<string, { count: number; input: number; output: number; genMs: number }>();
          for (const r of rows) {
            input += r.input || 0;
            output += r.output || 0;
            genMs += r.genMs || 0;
            const a = byAgent.get(r.agent) || { count: 0, input: 0, output: 0, genMs: 0 };
            a.count++; a.input += r.input || 0; a.output += r.output || 0; a.genMs += r.genMs || 0;
            byAgent.set(r.agent, a);
            const mk = r.model || 'unknown';
            const m = byModel.get(mk) || { count: 0, input: 0, output: 0, genMs: 0 };
            m.count++; m.input += r.input || 0; m.output += r.output || 0; m.genMs += r.genMs || 0;
            byModel.set(mk, m);
          }
          const genSec = genMs / 1000;
          const tps = (out: number, ms: number) => (ms > 0 ? +(out / (ms / 1000)).toFixed(1) : 0);
          return {
            count: rows.length,
            input, output, total: input + output,
            avgPerQuery: rows.length ? Math.round((input + output) / rows.length) : 0,
            avgTps: tps(output, genMs),
            agents: [...byAgent.entries()].map(([agent, a]) => ({
              agent, count: a.count, input: a.input, output: a.output, total: a.input + a.output,
              avgTps: tps(a.output, a.genMs),
            })).sort((x, y) => y.total - x.total),
            models: [...byModel.entries()].map(([model, m]) => ({
              model, count: m.count, input: m.input, output: m.output, total: m.input + m.output,
              avgTps: tps(m.output, m.genMs),
            })).sort((x, y) => y.total - x.total),
          };
        };
        const last = records.length ? records[records.length - 1] : null;
        const payload = {
          now,
          day: summarize(24 * 3600_000),
          week: summarize(7 * 24 * 3600_000),
          recent: last ? { tps: last.tps, output: last.output, model: last.model, agent: last.agent, at: last.ts } : null,
        };
        if (this.wantsCsv(req)) {
          const rows: Array<Record<string, unknown>> = [];
          const addSummary = (window: 'day' | 'week', summary: typeof payload.day) => {
            rows.push({
              window,
              kind: 'summary',
              key: 'all',
              count: summary.count,
              input: summary.input,
              output: summary.output,
              total: summary.total,
              avg_per_query: summary.avgPerQuery,
              avg_tps: summary.avgTps,
              generated_at: now,
            });
            for (const agent of summary.agents) {
              rows.push({
                window,
                kind: 'agent',
                key: agent.agent,
                count: agent.count,
                input: agent.input,
                output: agent.output,
                total: agent.total,
                avg_per_query: '',
                avg_tps: agent.avgTps,
                generated_at: now,
              });
            }
            for (const model of summary.models) {
              rows.push({
                window,
                kind: 'model',
                key: model.model,
                count: model.count,
                input: model.input,
                output: model.output,
                total: model.total,
                avg_per_query: '',
                avg_tps: model.avgTps,
                generated_at: now,
              });
            }
          };
          addSummary('day', payload.day);
          addSummary('week', payload.week);
          if (payload.recent) {
            rows.push({
              window: 'recent',
              kind: 'last_turn',
              key: payload.recent.agent,
              count: 1,
              input: '',
              output: payload.recent.output ?? '',
              total: payload.recent.output ?? '',
              avg_per_query: '',
              avg_tps: payload.recent.tps ?? '',
              generated_at: now,
              model: payload.recent.model,
              at: payload.recent.at,
            });
          }
          return this.sendCsv(res, 'usage.csv', rows);
        }
        return res.json(payload);
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // Per-task token spend: attribute each usage record to the task its query worked.
    // Cloud harnesses report a query_id → exact attribution; records without one fall back
    // to time-window matching (same agent, ts inside the query's [created, completed] window).
    // Keyed by the task's shortId ("#" + dashless-uuid[:8]) so the control center can match cards.
    this.managementApp.get('/usage/by-task', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const records = this.readUsageRecords();
        const { rows } = await this.db.adapter.query<{ query_id: string; agent_id: string | null; created: number; completed: number | null; prompt: string | null; metadata: unknown }>(
          `SELECT query_id, agent_id, created, completed, prompt, metadata FROM queries WHERE team_id = $1`,
          [teamId],
        );
        // Resolve a task shortId ("#abc12345") for a query: the dispatch prompt always names the
        // task it's working (WORK_PROMPT / redispatch), so the prompt ref is the primary signal;
        // fall back to a structured brain_context.task_id (task:<uuid>) when present.
        const refOfQuery = (prompt: string | null, md: any): string | null => {
          const m = typeof prompt === 'string' ? prompt.match(/#[0-9a-f]{8}\b/) : null;
          if (m) return m[0];
          const tid = md?.brain_context?.task_id ?? md?.task_id;
          if (typeof tid === 'string' && tid.startsWith('task:')) return `#${tid.slice(5).replace(/-/g, '').slice(0, 8)}`;
          return null;
        };
        // Owner map: a turn's tokens only count toward the task its agent OWNS. Without this, ANY
        // agent that merely MENTIONS a task ref in its prompt (reports, supervision nudges, dispatch
        // lists, brain context) had its tokens mis-attributed to that task — e.g. inflated codex turns
        // from several agents piling onto one ollama-owned task (the 70M+ phantom).
        const agentNameById = new Map<string, string>();
        for (const a of await this.db.agents.list(teamId).catch(() => [])) agentNameById.set(a.id, a.name);
        const ownerOf = new Map<string, string>(); // task ref → owner agent name
        for (const t of await this.db.tasks.list({ teamId }).catch(() => [])) {
          if (t.owner && t.uuid) { const nm = agentNameById.get(t.owner); if (nm) ownerOf.set(`#${t.uuid.replace(/-/g, '').slice(0, 8)}`, nm); }
        }
        const byQuery = new Map<string, string>(); // query_id → task ref (OWNER's queries only)
        const windows: Array<{ agent: string; from: number; to: number; ref: string }> = [];
        for (const r of rows) {
          let md: any = r.metadata;
          if (typeof md === 'string') { try { md = JSON.parse(md); } catch { md = null; } }
          const ref = refOfQuery(r.prompt, md);
          if (!ref) continue;
          const qAgent = agentNameById.get(r.agent_id || '') || '';
          if (ownerOf.get(ref) !== qAgent) continue; // only the task's OWNER's turns count toward it
          if (r.query_id) byQuery.set(r.query_id, ref);
          windows.push({ agent: qAgent, from: r.created, to: r.completed ?? Date.now(), ref });
        }
        // A single turn's NEW input can't exceed the model's context window; anything far larger is a
        // stale cache-inflated record from an agent still on the pre-fix harness — drop it.
        const MAX_TURN_INPUT = 1_000_000;
        const agg = new Map<string, { input: number; output: number; ms: number; turns: number }>();
        for (const rec of records) {
          if ((rec.input || 0) > MAX_TURN_INPUT) continue;
          let ref = rec.query_id ? byQuery.get(rec.query_id) : undefined;
          if (!ref) {
            const w = windows.find((w) => w.agent === rec.agent && rec.ts >= w.from && rec.ts <= w.to + 2000);
            ref = w?.ref;
          }
          if (!ref) continue;
          const a = agg.get(ref) || { input: 0, output: 0, ms: 0, turns: 0 };
          a.input += rec.input || 0; a.output += rec.output || 0; a.ms += rec.genMs || 0; a.turns += 1;
          agg.set(ref, a);
        }
        const tasks: Record<string, { tokens: number; input: number; output: number; ms: number; turns: number }> = {};
        for (const [ref, a] of agg) {
          tasks[ref] = { tokens: a.input + a.output, input: a.input, output: a.output, ms: a.ms, turns: a.turns };
        }
        if (this.wantsCsv(req)) {
          const csvRows = Object.entries(tasks)
            .map(([task, a]) => ({ task, tokens: a.tokens, input: a.input, output: a.output, ms: a.ms, turns: a.turns }))
            .sort((a, b) => b.tokens - a.tokens);
          return this.sendCsv(res, 'usage-by-task.csv', csvRows);
        }
        return res.json({ tasks });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // ---- Live agent activity (tool/file steps) --------------------------
    // Agents fire-and-forget POST /activity/record as they work (each tool call
    // → a human-readable line, esp. file create/modify). Kept in a small
    // in-memory ring (ephemeral — only useful while a dispatch is live) and read
    // back via GET /activity?agent=&since= so the chat can stream "what they're
    // working on" inline. Fully decoupled from the reply path.
    this.managementApp.post('/activity/record', (req, res) => {
      const ip = req.ip || '';
      const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!loopback) return res.status(403).json({ error: 'loopback_required' });
      try {
        const b = req.body || {};
        const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
        const agent = str(b.agent, 80);
        const summary = str(b.summary, 240);
        if (!agent || !summary) return res.status(400).json({ error: 'agent_and_summary_required' });
        const item = {
          seq: ++ACTIVITY_RING.seq,
          at: Date.now(),
          agent,
          team: str(b.team, 80) || 'default',
          kind: str(b.kind, 24) || 'tool',
          tool: str(b.tool, 60) || undefined,
          summary,
          // Originating dispatch id (when the agent reports one), so GET /activity
          // can filter to a single query when two dispatches hit the same agent.
          queryId: str(b.queryId, 80) || undefined,
        };
        ACTIVITY_RING.items.push(item);
        if (ACTIVITY_RING.items.length > ACTIVITY_CAP) ACTIVITY_RING.items.splice(0, ACTIVITY_RING.items.length - ACTIVITY_CAP);
        return res.json({ ok: true, seq: item.seq });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.get('/activity', (req, res) => {
      try {
        const since = Math.max(0, Number(req.query.since) || 0);
        const agent = typeof req.query.agent === 'string' ? req.query.agent : '';
        const team = typeof req.query.team === 'string' ? req.query.team : '';
        const queryId = typeof req.query.queryId === 'string' ? req.query.queryId : '';
        let items = ACTIVITY_RING.items.filter((i) => i.seq > since);
        if (agent) items = items.filter((i) => i.agent === agent);
        if (team) items = items.filter((i) => i.team === team);
        // Exact per-dispatch attribution: when a queryId is given, only steps the
        // agent tagged with that query match (steps without one are excluded).
        if (queryId) items = items.filter((i) => i.queryId === queryId);
        if (items.length > 200) items = items.slice(-200);
        return res.json({ items, next_seq: ACTIVITY_RING.seq });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // Attach external MCP servers to an agent (Modules view). Persists a
    // validated McpServerSpec[] to metadata.mcpServers; takes effect on the
    // agent's next (re)build, when buildLocalAgentEnv injects ID_MCP_SERVERS.
    this.managementApp.post('/agents/:id/mcp', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) {
          return res.status(403).json({ error: 'admin_required' });
        }
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id)
          ?? await this.dbQueryAgentByNameMostRecent(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const raw = (req.body || {}).servers;
        if (!Array.isArray(raw)) {
          return res.status(400).json({ error: 'Missing servers array in request body' });
        }
        const servers: any[] = [];
        for (const s of raw) {
          if (!s || typeof s.name !== 'string' || !s.name.trim()) {
            return res.status(400).json({ error: 'Each server needs a non-empty name' });
          }
          const transport = s.transport || 'stdio';
          if (transport === 'stdio') {
            if (typeof s.command !== 'string' || !s.command.trim()) {
              return res.status(400).json({ error: `stdio server "${s.name}" needs a command` });
            }
          } else if (transport === 'http' || transport === 'sse') {
            if (typeof s.url !== 'string' || !s.url.trim()) {
              return res.status(400).json({ error: `${transport} server "${s.name}" needs a url` });
            }
          } else {
            return res.status(400).json({ error: `server "${s.name}" has unknown transport "${transport}"` });
          }
          // args must be a string[]; env/headers must be string→string maps.
          if (s.args !== undefined && (!Array.isArray(s.args) || !s.args.every((a: unknown) => typeof a === 'string'))) {
            return res.status(400).json({ error: `server "${s.name}" args must be an array of strings` });
          }
          const allStringValues = (o: unknown) =>
            o != null && typeof o === 'object' && Object.values(o as Record<string, unknown>).every((v) => typeof v === 'string');
          if (s.env !== undefined && !allStringValues(s.env)) {
            return res.status(400).json({ error: `server "${s.name}" env must be a string map` });
          }
          if (s.headers !== undefined && !allStringValues(s.headers)) {
            return res.status(400).json({ error: `server "${s.name}" headers must be a string map` });
          }
          servers.push({
            name: s.name.trim(),
            transport,
            ...(s.command && { command: s.command }),
            ...(Array.isArray(s.args) && { args: s.args }),
            ...(s.env && typeof s.env === 'object' && { env: s.env }),
            ...(s.url && { url: s.url }),
            ...(s.headers && typeof s.headers === 'object' && { headers: s.headers }),
          });
        }

        const cur = (agent.metadata as Record<string, unknown>) || {};
        await this.db.agents.updateMetadata(agent.id, { ...cur, mcpServers: servers });
        res.json({ agent: agent.name, mcpServers: servers, needsRebuild: true });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // GET/POST /agents/:id/instructions — a persistent per-agent system-prompt
    // addendum (e.g. "act as the team coordinator and delegate to teammates").
    // Stored as a <workingDir>/.id-instructions.md sidecar that writePersonalityFile
    // appends to CLAUDE.md / the AGENTS.md framework block, so it survives rebuilds.
    // Admin-gated; takes effect on the agent's next (re)build.
    this.managementApp.get('/agents/:id/instructions', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id) ?? await this.dbQueryAgentByNameMostRecent(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        const wd = agent.working_directory;
        let instructions = '';
        try { const f = wd ? path.join(wd, INSTRUCTIONS_SIDECAR) : ''; if (f && existsSync(f)) instructions = readFileSync(f, 'utf-8'); } catch { /* none */ }
        return res.json({ agent: agent.name, instructions });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/agents/:id/instructions', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) return res.status(403).json({ error: 'admin_required' });
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id) ?? await this.dbQueryAgentByNameMostRecent(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        const wd = agent.working_directory;
        if (!wd) return res.status(400).json({ error: 'agent has no working directory' });
        const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
        const sidecar = path.join(wd, INSTRUCTIONS_SIDECAR);
        if (instructions) writeFileSync(sidecar, instructions + '\n');
        else { try { rmSync(sidecar, { force: true }); } catch { /* */ } }
        return res.json({ agent: agent.name, instructions, needsRebuild: true });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /agents/:id/delegates — per-agent cross-team relay override.
    // Body: { delegates: string[] | "*" | null }. Overrides the team policy for
    // THIS agent; null removes the override (inherit team). Admin-gated. Takes
    // effect immediately (checked at delegation time — no rebuild needed).
    this.managementApp.post('/agents/:id/delegates', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) return res.status(403).json({ error: 'admin_required' });
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id)
          ?? await this.dbQueryAgentByNameMostRecent(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        const body = req.body || {};
        let delegates: string[] | null;
        if (body.delegates === null || body.delegates === undefined) {
          delegates = null;
        } else if (body.delegates === '*') {
          delegates = ['*'];
        } else if (Array.isArray(body.delegates) && body.delegates.every((d: unknown) => typeof d === 'string')) {
          delegates = body.delegates as string[];
        } else {
          return res.status(400).json({ error: 'delegates must be an array of team names, "*", or null' });
        }
        const cur = (agent.metadata as Record<string, unknown>) || {};
        const next = { ...cur };
        if (delegates === null) delete (next as any).delegates_to;
        else (next as any).delegates_to = delegates;
        await this.db.agents.updateMetadata(agent.id, next);
        res.json({ agent: agent.name, delegates_to: delegates });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // GET /agents/status - check health of all agents (server-side ping)
    this.managementApp.get('/agents/status', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const includeAll = req.query.all === 'true' || req.query.all === '1';
      const agents = await this.dbListAgents(teamId, includeAll);
      const isAdmin = this.isAdminRequest(req);

      const results = await Promise.allSettled(
        agents.map(async (agent) => {
          const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
          const isInteractive = agent.type === 'interactive';
          let isResponding = false;
          let newsItems: any[] = [];

          if (isInteractive) {
            isResponding = true;
          } else {
            try {
              const catalogResp = await fetch(`${agentUrl}/.well-known/restap.json`, {
                signal: AbortSignal.timeout(3000)
              });
              isResponding = catalogResp.ok;
            } catch { /* not responding */ }
          }

          if (isResponding && !isInteractive) {
            try {
              const newsResp = await fetch(`${agentUrl}/news?since=0&limit=50`, {
                signal: AbortSignal.timeout(2000)
              });
              if (newsResp.ok) {
                const newsData: any = await newsResp.json();
                newsItems = newsData.items || [];
              }
            } catch { /* news fetch failed */ }
          }

          // Check for active heartbeat schedules
          let hasActiveHeartbeat = false;
          if (this.schedulerService) {
            const schedules = await this.db.schedules.listSchedulesForAgent(agent.id);
            hasActiveHeartbeat = schedules.some(s => s.kind === 'heartbeat' && s.active);
          }

          return {
            ...this.agentToResponse(agent, { isAdmin }),
            isResponding,
            newsItems,
            hasActiveHeartbeat
          };
        })
      );

      const agentStatuses = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return { ...this.agentToResponse(agents[i], { isAdmin }), isResponding: false, newsItems: [], hasActiveHeartbeat: false };
      });

      res.json({ agents: agentStatuses });
    });

    // GET /agents/:name/news - proxy news feed from a specific agent (for remote CLI)
    this.managementApp.get('/agents/:name/news', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agentName = req.params.name;
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);

        if (!agent) {
          return res.status(404).json({ error: `Agent "${agentName}" not found` });
        }

        const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
        const since = req.query.since || '0';
        const limit = req.query.limit || '50';

        const newsResp = await fetch(`${agentUrl}/news?since=${since}&limit=${limit}`, {
          signal: AbortSignal.timeout(5000)
        });

        if (!newsResp.ok) {
          return res.status(newsResp.status).json({ error: `Agent news fetch failed: ${newsResp.statusText}` });
        }

        const newsData = await newsResp.json();
        res.json(newsData);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to fetch agent news' });
      }
    });

    // POST /agents/:name/cancel - proxy cancel request to a specific agent (for remote CLI)
    this.managementApp.post('/agents/:name/cancel', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agentName = req.params.name;
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);

        if (!agent) {
          return res.status(404).json({ error: `Agent "${agentName}" not found` });
        }

        const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
        const cancelResp = await fetch(`${agentUrl}/cancel`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' }
        });

        if (!cancelResp.ok) {
          const errData = await cancelResp.json().catch(() => ({ error: cancelResp.statusText }));
          return res.status(cancelResp.status).json(errData);
        }

        const result = await cancelResp.json();
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to cancel agent query' });
      }
    });

    // GET /logs - retrieve recent manager activity logs
    this.managementApp.get('/logs', async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, this.LOG_BUFFER_SIZE);
      const logs = this.logBuffer.slice(-limit);
      res.json({ logs, total: this.logBuffer.length });
    });

    // REST-AP /talk endpoint - receive queries for the manager inbox
    this.managementApp.post('/talk', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const { message, session_id, from } = req.body || {};

        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }

        const ts = Date.now();
        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const senderName = from || 'external';

        // Store the query in the queries table. Dual-write window: every
        // manager-inbox row carries both legacy agent_id (= manager-<team>)
        // and the new owner_kind/owner_id columns explicitly so a downstream
        // backfill/cutover never has to infer ownership from the agent_id
        // prefix heuristic.
        await this.db.queries.create(
          teamId,
          queryId,
          null,
          `[From: ${senderName}] ${message}`,
          ts,
          session_id || undefined,
          { owner_kind: managerInbox.ownerKind, owner_id: managerInbox.ownerId },
        );

        // Also store as a news item so the CLI can see incoming queries
        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.received',
          message: `Query from ${senderName}: ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
          data: { from: senderName, message, session_id, query_id: queryId },
          query_id: queryId,
          kind: 'talk',
          reply_expected: true,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        this.managerLog(`Received query ${queryId} from ${senderName}: ${message.slice(0, 50)}...`);

        res.status(202).json({
          query_id: queryId,
          status: 'pending',
          message: 'Query received. Poll /news?query_id=' + queryId + ' for response.'
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /talk:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /schedule - enqueue manager-owned internal scheduled work
    this.managementApp.post('/schedule', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const { message, schedule, mode, linkedTasks } = req.body || {};

        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }
        if (!schedule || typeof schedule !== 'object') {
          return res.status(400).json({ error: 'Schedule metadata is required' });
        }
        if (mode && mode !== 'internal') {
          return res.status(400).json({ error: 'Invalid schedule mode' });
        }

        const messageStr = typeof message === 'string' ? message : String(message);
        const ts = Date.now();
        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;

        const managerInbox = this.getManagerInboxRef(teamId, teamName);

        const queryResult: Record<string, unknown> = { schedule, message: messageStr, mode: 'internal' };
        if (Array.isArray(linkedTasks) && linkedTasks.length > 0) {
          queryResult.linkedTasks = linkedTasks;
        }

        await this.db.queries.upsert(teamId, null, {
          query_id: queryId,
          status: 'pending',
          prompt: messageStr,
          created: ts,
          completed: null,
          result: queryResult,
          error: null,
          session_id: null,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        const newsData: Record<string, unknown> = {
          query_id: queryId,
          message: messageStr,
          schedule,
          status: 'awaiting_response',
        };
        if (Array.isArray(linkedTasks) && linkedTasks.length > 0) {
          newsData.linkedTasks = linkedTasks;
        }

        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'schedule.received',
          message: `Scheduled query ${queryId} received`,
          data: newsData,
          query_id: queryId,
          reply_expected: false,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        this.managerLog(`Received scheduled query ${queryId}: ${messageStr.slice(0, 50)}...`);

        res.status(202).json({
          query_id: queryId,
          status: 'pending',
          message: `Scheduled work has been queued for the manager inbox.`,
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /schedule:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /message - DEPRECATED unified endpoint for sending messages to agents.
    // Prefer POST /talk-to (synchronous reply) or POST /news-to (fire-and-forget).
    // Emits an X-Deprecated response header and a manager log line; still
    // functionally equivalent to /talk-to with fire-and-forget defaults.
    this.managementApp.post('/message', (req, res, next) => {
      res.setHeader(
        'X-Deprecated',
        '/message is deprecated; use /talk-to for synchronous replies or /news-to for fire-and-forget notifications',
      );
      const fromHint = (req.body && typeof req.body.from === 'string') ? req.body.from : 'unknown';
      this.managerLog(`[DEPRECATED] /message called (from=${fromHint}); prefer /talk-to or /news-to`);
      this.handleMessage(req, res).catch(next);
    });

    // /talk-to - backwards-compatible alias for /message with wait:true.
    // When the body carries a `task` object the dispatch is treated as a
    // task delegation: the manager creates the task (owner = target agent,
    // status = 'doing') and auto-attaches an active checkin owned by the
    // dispatcher. The auto-attach is governed by these flags on the body:
    //   - no_checkin: true            disables auto-attach for this dispatch
    //   - checkin: <duration|seconds> overrides interval (default 10m)
    //   - checkin_iters: <N>          sets max_iterations (default null)
    // If no `task` object is supplied, /talk-to behaves exactly as before.
    this.managementApp.post('/talk-to', async (req, res, next) => {
      // Inject wait:true if not explicitly set
      if (req.body && req.body.wait === undefined && req.body.timeout === undefined) {
        req.body.wait = true;
      }
      try {
        const result = await this.maybeAutoAttachForTalkTo(req);
        if (result) (req as any)._autoAttach = result;
      } catch (err: any) {
        return res.status(err?.status || 400).json({
          error: err?.code || err?.message || 'auto_attach_failed',
          ...(err?.details || {}),
        });
      }
      this.handleMessage(req, res).catch(next);
    });

    // /news-to - fire-and-forget notification to another agent (no reply wait).
    // Mesh-membership gate applies identically to /talk-to (handled inside handleMessage).
    this.managementApp.post('/news-to', (req, res, next) => {
      // Ensure wait is explicitly false (fire-and-forget)
      if (req.body) {
        req.body.wait = false;
      }
      this.handleMessage(req, res).catch(next);
    });

    this.managementApp.get('/runtime/cooldowns', async (req, res) => {
      const now = Date.now();
      const cooldowns = [...this.runtimeLaneCooldowns.values()]
        .filter((cooldown) => cooldown.coolingUntilMs > now)
        .sort((a, b) => a.laneId.localeCompare(b.laneId));
      res.json({ cooldowns });
    });

    this.managementApp.post('/runtime/rate-limit', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const body = req.body || {};
      const rateLimit = body.rateLimit || body.rate_limit || {};
      if (!rateLimit?.isRateLimit) {
        return res.status(400).json({ error: 'rateLimit.isRateLimit is required' });
      }

      const cooldown = await this.recordRuntimeRateLimit(teamId, {
        agentId: typeof body.agent_id === 'string' ? body.agent_id : undefined,
        agentName: typeof body.agent_name === 'string' ? body.agent_name : undefined,
        runtime: typeof body.runtime === 'string' ? body.runtime : undefined,
        laneId: typeof body.lane_id === 'string' ? body.lane_id : undefined,
        queryId: typeof body.query_id === 'string' ? body.query_id : undefined,
        rateLimit,
      });

      const message = `Runtime lane ${cooldown.laneId} is cooling until ${new Date(cooldown.coolingUntilMs).toISOString()} (${cooldown.reason})`;
      const ts = Date.now();
      const managerInbox = this.getManagerInboxRef(teamId, teamName);
      await this.db.news.add(teamId, null, {
        timestamp: ts,
        type: 'runtime.rate_limit',
        message,
        data: { cooldown, rateLimit },
        query_id: cooldown.queryId,
        kind: 'notify',
        reply_expected: false,
        owner_kind: managerInbox.ownerKind,
        owner_id: managerInbox.ownerId,
      });
      this.broadcastNews(teamId, {
        type: 'runtime.rate_limit',
        from: cooldown.agentName || cooldown.agentId || 'runtime',
        message,
        data: { cooldown, rateLimit },
        timestamp: ts,
      });
      this.postBrain('/memory/manager', {
        key: `runtime-cooldown:${cooldown.laneId}`,
        content: JSON.stringify(cooldown),
        shared: true,
        project: teamName,
      }).catch(() => {});

      const failover = await this.handleRuntimeRateLimitFailover(teamId, teamName, cooldown);

      res.json({ ok: true, cooldown, failover });
    });

    // REST-AP /news endpoint - receive replies from agents
    this.managementApp.post('/news', async (req, res) => {
      try {
        let { id: teamId, name: teamName } = await this.getTeam(req);
        const { type, from, message, data } = req.body || {};
        // `in_reply_to` is the query_id this row is replying to. Some clients
        // put it at the top level; agent-server `broadcastToManager` started
        // doing so deliberately, but older paths (and the original message
        // shape) only carried it inside `data`. Fall back so either works.
        const in_reply_to: string | undefined = req.body?.in_reply_to ?? data?.in_reply_to ?? undefined;
        // Replies (in_reply_to present) default to trigger=true so the
        // forwarded receiver wakes up when its /talk-to wait has already
        // timed out. Caller can opt out with trigger:false explicitly.
        const trigger = resolveNewsTrigger({ in_reply_to, trigger: req.body?.trigger });
        // skip_persist:true: caller already persisted the canonical row
        // under the actual receiver's inbox (e.g. `broadcastToManager` from
        // the originating agent's /news handler). Skip the manager-inbox
        // insert to avoid duplicate visible rows; still run waiter
        // resolution + queries.complete + emitQueryDelivered below so the
        // synchronous /talk-to caller actually unblocks.
        const skipPersist = req.body?.skip_persist === true;

        if (!message && !data) {
          return res.status(400).json({ error: 'Missing message or data' });
        }

        // If this is a reply to a query, look up the original query's team.
        // Design-doc delta (Phase 1): the queries table does not track which agent
        // endpoint received the original query, so we cannot verify the reply path
        // fully. Instead we apply a lighter constraint: only admin principals are
        // allowed to swing teams via in_reply_to. Non-admin callers (agents, anon)
        // may reply to queries within their own team only. If the query belongs to
        // a different team and the caller is not admin, we still deliver the news
        // to the caller's own team (the reply will be visible there) but we do NOT
        // follow the query across the team boundary.
        if (in_reply_to) {
          const queryTeamId = await this.db.queries.findTeam(in_reply_to);
          const principal = (req as any).ctx?.principal || 'anon';
          if (queryTeamId && queryTeamId !== teamId) {
            if (principal === 'admin') {
              // Admin may cross teams
              teamId = queryTeamId;
              this.managerLog(`Reply to ${in_reply_to} - admin team override to ${teamId}`);
            } else {
              // Non-admin: stay in own team; log that we skipped the cross-team swing
              this.managerLog(`Reply to ${in_reply_to} - non-admin caller; keeping team ${teamId} (query team ${queryTeamId})`);
            }
          } else if (queryTeamId && queryTeamId === teamId) {
            this.managerLog(`Reply to ${in_reply_to} - using query's team ${teamId}`);
          }
        }

        const newsType = type || (in_reply_to ? 'reply' : 'message');
        const newsMessage = message || data?.message || `${newsType} from ${from || 'unknown'}`;
        const ts = Date.now();

        // Store in news_items under the logical manager owner. The legacy
        // agent_id column is still populated for rollback compatibility, but
        // reads no longer depend on an agents-row stub existing.
        const teamRow = teamId
          ? await this.db.teams.getTeam(teamId).catch(() => null)
          : null;
        const resolvedTeamName = teamRow?.name ?? teamName ?? 'unknown';
        const managerInbox = this.getManagerInboxRef(teamId, resolvedTeamName);

        // Replies carry notify semantics (no further reply expected);
        // unsolicited inbound messages default to notify too. Dual-write
        // window: tag the row with owner_kind='manager'/owner_id=teamId so
        // the new ownership columns stay populated alongside the legacy
        // agent_id (= manager-<team>) without depending on the agent-id
        // prefix heuristic in the repo helper.
        if (!skipPersist) {
          await this.db.news.add(teamId, null, {
            timestamp: ts,
            type: newsType,
            message: newsMessage,
            data: { from, in_reply_to, message, ...data },
            query_id: in_reply_to || undefined,
            kind: 'notify',
            reply_expected: false,
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
        }

        // If this is a reply to a query, update the query status and resolve any waiting /talk-to.
        // Distinguish success ('reply') from agent-side failure ('reply.error') —
        // the latter is what claude-agent-server.ts sends from its /talk catch
        // block (see src/claude-agent-server.ts → sendReplyToSender, success=false).
        // We mark the row 'failed' instead of 'completed' and emit `query:failed`
        // instead of `query:delivered` so the wakeup-service event log carries
        // the real lifecycle transition. Audit finding #9
        // (output/security-review-wakeup-service.md).
        const isQueryFailure = newsType === 'reply.error' || type === 'reply.error';
        if (in_reply_to) {
          const queryRow = await this.db.queries.getByQueryIdForTeam(teamId, in_reply_to).catch(() => null);
          const retryOf = this.runtimeFailoverRetryOf.get(in_reply_to)
            || (typeof (queryRow?.metadata as any)?.retry_of === 'string' ? (queryRow?.metadata as any).retry_of : undefined);
          if (isQueryFailure) {
            const errorText =
              typeof message === 'string' && message.length > 0
                ? message
                : typeof data?.error === 'string'
                  ? data.error
                  : null;
            const transitioned = await this.db.queries.markFailed(teamId, in_reply_to, ts, errorText);
            if (transitioned) {
              const failedRow = await this.db.queries.getByQueryIdForTeam(teamId, in_reply_to).catch(() => null);
              await emitQueryFailed(this.db.events, {
                teamId,
                queryId: in_reply_to,
                agentId:
                  failedRow?.owner_kind === 'manager'
                    ? null
                    : failedRow?.agent_id ?? null,
                occurredAt: ts,
                reason: errorText,
              });
            }
            // Failure path still needs to wake long-poll and /talk-to waiters
            // so blocked callers don't hang waiting for a transition that
            // already happened.
            this.wakeQueryWaiters(teamId, in_reply_to, {
              from: from || 'unknown',
              message: message || '',
            });
            this.releaseLocalGate(in_reply_to); // #7: free the local-model slot on failure
            if (retryOf && retryOf !== in_reply_to) {
              const transitionedOriginal = await this.db.queries.markFailed(teamId, retryOf, ts, errorText);
              if (transitionedOriginal) {
                const failedOriginal = await this.db.queries.getByQueryIdForTeam(teamId, retryOf).catch(() => null);
                await emitQueryFailed(this.db.events, {
                  teamId,
                  queryId: retryOf,
                  agentId:
                    failedOriginal?.owner_kind === 'manager'
                      ? null
                      : failedOriginal?.agent_id ?? null,
                  occurredAt: ts,
                  reason: errorText,
                });
              }
              this.wakeQueryWaiters(teamId, retryOf, {
                from: from || 'unknown',
                message: message || '',
              });
              this.runtimeFailoverRetryOf.delete(in_reply_to);
            }
          } else {
            // Single canonical completion lifecycle (queries.complete +
            // delivered event + waiter wakeups). Shared with POST
            // /manager/inbox/respond so both paths cannot drift.
            await this.completeQueryDelivery({
              teamId,
              queryId: in_reply_to,
              occurredAt: ts,
              resultPayload: { from, message, ...data },
              waiterReply: { from: from || 'unknown', message: message || '' },
              messagePreview: typeof message === 'string' ? message : null,
            });
            if (retryOf && retryOf !== in_reply_to) {
              await this.completeQueryDelivery({
                teamId,
                queryId: retryOf,
                occurredAt: ts,
                resultPayload: { from, message, ...data, failover_retry_query_id: in_reply_to },
                waiterReply: { from: from || 'unknown', message: message || '' },
                messagePreview: typeof message === 'string' ? message : null,
              });
              this.runtimeFailoverRetryOf.delete(in_reply_to);
            }
          }
        }

        this.managerLog(`Received ${newsType}${from ? ` from ${from}` : ''}${in_reply_to ? ` (reply to ${in_reply_to})` : ''}`);

        // Broadcast to WebSocket clients (real-time delivery)
        this.broadcastNews(teamId, {
          type: newsType,
          from,
          message,
          in_reply_to,
          data: { ...data, sessionId: data?.sessionId },
          timestamp: ts
        });

        // Try to forward to CLI if it can receive direct messages
        // Look up the CLI (interactive agent) to check if it's reachable
        const recipientAgent = await this.db.agents.findInteractive(teamId);

        if (recipientAgent) {
          const recipient = recipientAgent;
          const canReceive = recipient.metadata?.canReceiveDirectMessages === true;

          if (canReceive && recipient.endpoint) {
            // Forward message to CLI's /news endpoint
            try {
              const forwardRes = await fetch(`${recipient.endpoint}/news`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: newsType,
                  from,
                  message,
                  in_reply_to,
                  trigger,
                  session_id: data?.sessionId,
                  ...data
                }),
                signal: AbortSignal.timeout(5000)
              });
              if (forwardRes.ok) {
                this.managerLog(`Forwarded ${newsType} to CLI at ${recipient.endpoint}`);
              } else {
                this.managerLog(`Failed to forward to CLI: ${forwardRes.status}`);
              }
            } catch (fwdErr: any) {
              this.managerLog(`Could not forward to CLI: ${fwdErr.message}`);
            }
          }
        }

        res.status(201).json({
          success: true,
          type: newsType,
          timestamp: ts
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /news:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // REST-AP /news endpoint - poll for updates
    // Preferred cursor: since_id=<monotonic id>&limit=N (server-side, ascending id).
    // Deprecated cursor: since=<ms-timestamp> — still accepted for one release,
    // with an X-Deprecated response header.
    this.managementApp.get('/news', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const hasSinceId = typeof req.query.since_id === 'string' && req.query.since_id !== '';
        const sinceId = hasSinceId ? parseInt(req.query.since_id as string) || 0 : 0;
        const since = parseInt(req.query.since as string) || 0;
        const limit = parseInt(req.query.limit as string) || 100;
        const query_id = req.query.query_id as string | undefined;

        if (!hasSinceId && typeof req.query.since === 'string') {
          res.setHeader(
            'X-Deprecated',
            'since=<ms> is deprecated; use since_id=<int> with the id field on each news item',
          );
        }

        const managerInbox = this.getManagerInboxRef(teamId, teamName);

        const newsRows = hasSinceId
          ? await this.db.news.pollSinceIdByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, sinceId, { limit, queryId: query_id })
          : await this.db.news.pollByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, since, { limit, queryId: query_id });

        const items = newsRows.map((r: any) => ({
          id: Number(r.id),
          type: r.type,
          timestamp: Number(r.timestamp),
          message: r.message || undefined,
          data: r.data || undefined
        }));

        const nextSinceId = hasSinceId && items.length > 0
          ? items[items.length - 1].id
          : undefined;

        res.json({
          items,
          timestamp: Date.now(),
          total: items.length,
          ...(nextSinceId !== undefined ? { next_since_id: nextSinceId } : {}),
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /news:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // Archive old news items to files and delete from database
    this.managementApp.post('/news/archive', async (req, res) => {
      try {
        const { name: teamName, id: teamId } = await this.getTeam(req);
        const days = parseInt(req.body?.days) || 30;
        const cutoffTimestamp = Date.now() - (days * 24 * 60 * 60 * 1000);

        // Get all news items older than cutoff
        const items = await this.db.news.fetchForArchive(teamId, cutoffTimestamp);
        if (items.length === 0) {
          return res.json({ archived: 0, message: 'No items to archive' });
        }

        // Create archives directory
        const archiveDir = `${this.baseWorkDir}/teams/${teamName}/archives`;
        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

        // Write to file with timestamp
        const filename = `news-archive-${new Date().toISOString().split('T')[0]}-${Date.now()}.json`;
        const filepath = `${archiveDir}/${filename}`;
        const archiveData = {
          archivedAt: new Date().toISOString(),
          teamName,
          cutoffDays: days,
          cutoffTimestamp,
          itemCount: items.length,
          items: items.map((r: any) => ({
            type: r.type,
            timestamp: Number(r.timestamp),
            message: r.message || undefined,
            data: r.data || undefined,
            agentId: r.agent_id || undefined,
            queryId: r.query_id || undefined
          }))
        };
        writeFileSync(filepath, JSON.stringify(archiveData, null, 2));

        // Delete archived items from database
        await this.db.news.deleteArchived(teamId, cutoffTimestamp);

        console.log(`[Manager] Archived ${items.length} news items to ${filepath}`);
        res.json({
          archived: items.length,
          file: filepath,
          cutoffDays: days,
          cutoffDate: new Date(cutoffTimestamp).toISOString()
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /news/archive:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // Step 2 of the manager-collapse migration (docs/design/manager-collapse.md):
    // daemon-owned manager inbox APIs. Lets a CLI (or any team-scoped client)
    // read pending manager queries and post the manager's reply without
    // running its own InteractiveAgentServer process. Reuses the existing
    // queries.complete + emitQueryDelivered + waiter wakeup pipeline used
    // by POST /news so completion semantics stay identical.

    // GET /manager/inbox/pending — returns pending manager queries and
    // scheduled work for the active team. Source of truth is the daemon DB
    // (queries table under the resolved manager-inbox identity), not CLI
    // memory.
    this.managementApp.get('/manager/inbox/pending', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const rows = await this.db.queries.getPendingByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId);
        const pending = rows
          .map((row: any) => {
            const result = (row.result || {}) as Record<string, unknown>;
            return {
              query_id: row.query_id,
              prompt: row.prompt ?? null,
              message: row.prompt || (result.message as string | undefined) || '',
              timestamp: Number(row.created),
              status: row.status,
              session_id: row.session_id ?? null,
              from: (result.from as string | undefined) ?? null,
              reply_endpoint: (result.reply_endpoint as string | undefined) ?? null,
              schedule: (result.schedule as Record<string, unknown> | undefined) ?? null,
              mode: (result.mode as string | undefined) ?? null,
            };
          })
          .sort((a, b) => a.timestamp - b.timestamp);

        res.json({
          ok: true,
          team: teamName,
          inbox_id: managerInbox.inboxApiId,
          count: pending.length,
          pending,
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /manager/inbox/pending:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /manager/inbox/respond — body: { query_id, message, session_id? }.
    // Preserves the visible response semantics that InteractiveAgentServer.respond
    // emits today: a news row of type `query.completed` with
    // `data: { query_id, result: { result: message } }`, and a queries-table
    // result of `{ result: message }`. The actual completion lifecycle
    // (queries.complete + query:delivered + waiter wakeups) routes through
    // `completeQueryDelivery` so it is the single shared implementation with
    // the POST /news in-reply-to path.
    this.managementApp.post('/manager/inbox/respond', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const body = (req.body || {}) as {
          query_id?: unknown;
          message?: unknown;
          session_id?: unknown;
        };

        const queryId = typeof body.query_id === 'string' ? body.query_id : '';
        const message = typeof body.message === 'string' ? body.message : '';
        const sessionId =
          typeof body.session_id === 'string' && body.session_id.length > 0
            ? body.session_id
            : null;

        if (!queryId) {
          return res.status(400).json({ error: 'Missing query_id' });
        }
        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }

        const row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
        if (!row) {
          return res.status(404).json({ error: 'query_not_found', query_id: queryId });
        }
        if (row.status !== 'pending' && row.status !== 'processing') {
          return res.status(409).json({
            error: 'query_not_pending',
            query_id: queryId,
            status: row.status,
          });
        }

        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        if (row.owner_kind !== managerInbox.ownerKind || row.owner_id !== managerInbox.ownerId) {
          // Pending row exists but isn't owned by the manager inbox — refuse
          // rather than silently completing some other agent's query.
          return res.status(403).json({
            error: 'not_manager_inbox_query',
            query_id: queryId,
          });
        }

        const ts = Date.now();
        // Same shape InteractiveAgentServer.respond writes: queries row stores
        // `{ result: <response text> }`, news row carries
        // `data: { query_id, result: { result: <response text> } }`, type
        // `query.completed`. session_id is folded into both when supplied so
        // resumed CLI sessions continue to work.
        const innerResult: Record<string, unknown> = { result: message };
        if (sessionId) innerResult.session_id = sessionId;
        const newsData: Record<string, unknown> = {
          query_id: queryId,
          result: { result: message },
        };
        if (sessionId) newsData.session_id = sessionId;

        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.completed',
          data: newsData,
          query_id: queryId,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        // Canonical completion lifecycle. Drives queries.complete +
        // query:delivered emission + long-poll/talk-to waiter wakeups so the
        // wakeup-service event log and any blocked callers see the same
        // transition the POST /news reply path produces.
        await this.completeQueryDelivery({
          teamId,
          queryId,
          occurredAt: ts,
          resultPayload: innerResult,
          waiterReply: { from: 'manager', message },
          messagePreview: message,
        });

        // Fan out to WebSocket subscribers using the same `query.completed`
        // shape the persisted news row carries.
        this.broadcastNews(teamId, {
          type: 'query.completed',
          message,
          in_reply_to: queryId,
          data: newsData,
          timestamp: ts,
        });

        this.managerLog(`/manager/inbox/respond completed query ${queryId}`);

        res.status(200).json({
          ok: true,
          query_id: queryId,
          status: 'completed',
          timestamp: ts,
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /manager/inbox/respond:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // GET /query/:id - one-row lookup for a query's status/result
    // Team-scoped via the team header. Status is mapped to the external
    // vocabulary: { pending, processing, delivered, failed, expired }.
    //
    // Optional `?wait=<seconds>` (0–30, default 0) enables long-poll: if the
    // row is still pending/processing, the handler blocks until a waiter is
    // fired (daemon-side terminal transition) or the wait timeout elapses,
    // then re-reads and returns whatever the DB says.
    this.managementApp.get('/query/:id', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const queryId = req.params.id;

        const waitRaw = req.query.wait;
        let waitSec = 0;
        if (typeof waitRaw === 'string' && waitRaw.length > 0) {
          const parsed = Number.parseInt(waitRaw, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            waitSec = Math.min(parsed, 30);
          }
        }

        const statusMap: Record<string, string> = {
          pending: 'pending',
          processing: 'processing',
          completed: 'delivered',
          cancelled: 'failed',
          failed: 'failed',
          expired: 'expired',
        };
        const isTerminal = (s: string) =>
          s === 'completed' || s === 'delivered' || s === 'failed' || s === 'cancelled' || s === 'expired';

        let row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
        if (!row) return res.status(404).json({ error: `Query "${queryId}" not found` });

        if (waitSec > 0 && !isTerminal(row.status)) {
          const deadline = Date.now() + waitSec * 1000;
          // Register a single-shot waker and race it against the wait-deadline.
          let wake: () => void = () => {};
          const woke: Promise<void> = new Promise((resolve) => {
            wake = () => resolve();
            this.addQueryStatusWaiter(teamId, queryId, wake);
          });
          try {
            const remaining = deadline - Date.now();
            if (remaining > 0) {
              let timer: NodeJS.Timeout | null = null;
              const timeoutPromise = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, remaining);
              });
              await Promise.race([woke, timeoutPromise]);
              if (timer) clearTimeout(timer);
            }
          } finally {
            this.removeQueryStatusWaiter(teamId, queryId, wake);
          }
          row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
          if (!row) return res.status(404).json({ error: `Query "${queryId}" not found` });
        }

        const status = statusMap[row.status] || row.status;

        let agentName = 'manager';
        if (row.owner_kind !== 'manager' && row.agent_id) {
          agentName = row.agent_id;
          try {
            const agent = await this.db.agents.getById(row.agent_id);
            if (agent) {
              agentName = (agent.metadata as any)?.alias || agent.name || row.agent_id;
            }
          } catch { /* best-effort */ }
        }

        const response: Record<string, unknown> = {
          query_id: row.query_id,
          status,
          agent: agentName,
          created_at: Number(row.created),
        };
        if (row.completed !== null && row.completed !== undefined) {
          response.completed_at = Number(row.completed);
        }
        if (row.result !== null && row.result !== undefined) {
          response.result = row.result;
        }
        if (row.error) {
          response.error = row.error;
        }

        res.json(response);
      } catch (err: any) {
        console.error('[Manager] Error in GET /query/:id:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/registry/default', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      res.json({ registry: await this.getDefaultRegistry(teamId) });
    });

    this.managementApp.post('/registry/default', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const { chainId, registryAddress } = req.body || {};
      const parsedChainId = parseInt(String(chainId));
      if (!parsedChainId || !registryAddress) {
        return res.status(400).json({ error: 'Missing chainId or registryAddress' });
      }
      await this.setDefaultRegistry(teamId, parsedChainId, registryAddress);
      res.json({ registry: await this.getDefaultRegistry(teamId) });
    });

    this.managementApp.get('/registry/registrar', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      try {
        const registrarAddress = await this.getRegistrarAddress(teamId);
        res.json({ registrarAddress });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/registry/registrar', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const { registrarAddress } = req.body || {};
      if (!registrarAddress) return res.status(400).json({ error: 'Missing registrarAddress' });
      await this.setRegistrarAddress(teamId, String(registrarAddress));
      res.json({ registrarAddress: String(registrarAddress) });
    });

    this.managementApp.get('/agents', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      // ?all=true includes automator agents (normally hidden)
      const includeAll = req.query.all === 'true' || req.query.all === '1';
      const agents = await this.dbListAgents(teamId, includeAll);
      const isAdmin = this.isAdminRequest(req);
      res.json({
        agents: agents.map(a => this.agentToResponse(a, { isAdmin }))
      });
    });

    // Resolve agent by identifier pattern (alias, ENS domain, tokenId@registry, etc.)
    // Returns warning if multiple agents match
    // NOTE: Must be defined BEFORE /agents/:id to avoid "resolve" matching as an id
    this.managementApp.get('/agents/resolve/:ref', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const ref = decodeURIComponent(req.params.ref);
      const isAdmin = this.isAdminRequest(req);

      if (ref.toLowerCase() === 'manager') {
        return res.status(404).json({ error: `No agent matches "${ref}"` });
      }

      try {
        const matches = await this.dbResolveAgents(teamId, ref);

        if (matches.length === 0) {
          return res.status(404).json({ error: `No agent matches "${ref}"` });
        }

        if (matches.length === 1) {
          return res.json({
            agent: this.agentToResponse(matches[0], { isAdmin }),
            ambiguous: false
          });
        }

        // Multiple matches - build ambiguity warning
        const agentMatches: AgentMatch[] = matches.map(a => ({
          id: a.id,
          alias: normalizeAlias(a.name),
          tokenId: a.token_id || undefined,
          domain: a.domain || undefined,
          port: a.port,
          status: a.status
        }));

        const warning = buildAmbiguityWarning(ref, agentMatches);

        return res.json({
          agents: matches.map(a => this.agentToResponse(a, { isAdmin })),
          ambiguous: true,
          warning
        });
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'Invalid identifier format' });
      }
    });

    // Get agent by name (most recent)
    // NOTE: Must be defined BEFORE /agents/:id to avoid "by-name" matching as an id
    this.managementApp.get('/agents/by-name/:name', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      if (req.params.name.toLowerCase() === 'manager') {
        return res.status(404).json({ error: 'Agent not found' });
      }
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }));
    });

    this.managementApp.get('/agents/:id', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }));
    });

    // List all teams from database
    this.managementApp.get('/teams', async (req, res) => {
      const teams = await this.db.teams.listTeams();

      const teamList = await Promise.all(
        teams.map(async (team) => {
          const agentCount = await this.db.agents.count(team.id);
          return {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0'),
            createdAt: team.created_at
          };
        })
      );

      res.json({ teams: teamList });
    });

    // Create a new team
    this.managementApp.post('/teams', async (req, res) => {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Missing team name' });
      const nameCheck = validateName(name, 'team');
      if (!nameCheck.valid) return res.status(400).json({ error: nameCheck.error });
      try {
        const teamId = await this.db.teams.getOrCreateTeamId(name);

        // Create team directory
        const teamDir = `${this.baseWorkDir}/teams/${name}`;
        if (!existsSync(teamDir)) {
          mkdirSync(teamDir, { recursive: true });
        }

        const team = await this.db.teams.getTeam(teamId);
        if (!team) {
          return res.status(500).json({ error: 'Failed to create team' });
        }
        res.json({
          id: team.id,
          name: team.name,
          createdAt: team.created_at
        });
      } catch (error: any) {
        console.error('Error creating team:', error);
        res.status(500).json({ error: error.message || 'Failed to create team' });
      }
    });

    // Update team settings (port ranges removed — ports are now globally sequential)
    this.managementApp.patch('/teams/:name', async (req, res) => {
      const { name } = req.params;

      try {
        const team = await this.db.teams.getTeamByName(name);
        if (!team) {
          return res.status(404).json({ error: `Team "${name}" not found` });
        }

        res.json({ name: team.name, message: 'Port ranges are no longer used. Ports are allocated globally.' });
      } catch (error: any) {
        res.status(500).json({ error: error.message || 'Failed to update team' });
      }
    });

    // GET /teams/:name/config — relay/delegation policy for a team. Returns
    // delegates_to: an array of team names ("*" = all), or null = permissive.
    this.managementApp.get('/teams/:name/config', async (req, res) => {
      try {
        const team = await this.db.teams.getTeamByName(req.params.name);
        if (!team) return res.status(404).json({ error: `Team "${req.params.name}" not found` });
        const cfg = await this.db.teams.getConfig(team.id).catch(() => ({} as Record<string, unknown>));
        const raw = cfg.delegates_to;
        const delegates_to = Array.isArray(raw) ? (raw as string[]) : null;
        res.json({ name: team.name, delegates_to });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // Event-driven loop: default-team validators produce recommendation packets
    // when their validation tasks complete. This is deliberately not a schedule.
    this.managementApp.get('/teams/:name/validator-recommendation-loop', async (req, res) => {
      try {
        const team = await this.db.teams.getTeamByName(req.params.name);
        if (!team) return res.status(404).json({ error: `Team "${req.params.name}" not found` });
        const loop = await this.getValidatorRecommendationLoopConfig(team.id);
        res.json({ name: team.name, loop });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/teams/:name/validator-recommendation-loop', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) return res.status(403).json({ error: 'admin_required' });
        const team = await this.db.teams.getTeamByName(req.params.name);
        if (!team) return res.status(404).json({ error: `Team "${req.params.name}" not found` });
        const current = await this.getValidatorRecommendationLoopConfig(team.id);
        const body = req.body || {};
        const next = this.normalizeValidatorRecommendationLoopConfig({
          ...current,
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(Array.isArray(body.owners) ? { owners: body.owners } : {}),
          ...(typeof body.lead === 'string' ? { lead: body.lead } : {}),
          ...(typeof body.objective === 'string' ? { objective: body.objective } : {}),
          updatedAt: Date.now(),
        });
        await this.db.teams.setValidatorRecommendationLoop(team.id, next as unknown as Record<string, unknown>);
        res.json({ name: team.name, loop: next });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.delete('/teams/:name/validator-recommendation-loop', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) return res.status(403).json({ error: 'admin_required' });
        const team = await this.db.teams.getTeamByName(req.params.name);
        if (!team) return res.status(404).json({ error: `Team "${req.params.name}" not found` });
        const disabled = this.normalizeValidatorRecommendationLoopConfig({
          ...DEFAULT_VALIDATOR_RECOMMENDATION_LOOP,
          enabled: false,
          updatedAt: Date.now(),
        });
        await this.db.teams.setValidatorRecommendationLoop(team.id, disabled as unknown as Record<string, unknown>);
        res.json({ name: team.name, loop: disabled });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /teams/:name/delegates — set the cross-team relay allow-list.
    // Body: { delegates: string[] | "*" | null }. "*" → ["*"] (allow all),
    // [] → block all, null → permissive default. Admin-gated.
    this.managementApp.post('/teams/:name/delegates', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) return res.status(403).json({ error: 'admin_required' });
        const team = await this.db.teams.getTeamByName(req.params.name);
        if (!team) return res.status(404).json({ error: `Team "${req.params.name}" not found` });
        const body = req.body || {};
        let delegates: string[] | null;
        if (body.delegates === null || body.delegates === undefined) {
          delegates = null;
        } else if (body.delegates === '*') {
          delegates = ['*'];
        } else if (Array.isArray(body.delegates) && body.delegates.every((d: unknown) => typeof d === 'string')) {
          delegates = body.delegates as string[];
        } else {
          return res.status(400).json({ error: 'delegates must be an array of team names, "*", or null' });
        }
        await this.db.teams.setDelegatesTo(team.id, delegates);
        res.json({ name: team.name, delegates_to: delegates });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // Delete a team
    this.managementApp.delete('/teams/:name', async (req, res) => {
      const { name } = req.params;
      if (!name) {
        return res.status(400).json({ error: 'Missing team name' });
      }

      try {
        const result = await this.deleteEmptyTeamByName(name);
        if (!result.ok) {
          return res.status(result.status).json({ error: result.error });
        }
        res.json(result.result);
      } catch (error: any) {
        console.error('Error deleting team:', error);
        res.status(500).json({ error: error.message || 'Failed to delete team' });
      }
    });

    // Backwards compatibility: /projects endpoints
    this.managementApp.get('/projects', async (req, res) => {
      const teams = await this.db.teams.listTeamsWithConfig();

      const projectList = await Promise.all(
        teams.map(async (team) => {
          // Count agents in this team
          const agentCount = await this.db.agents.count(team.id);

          // Get registry info from config
          const config = team.config || {};
          const registryInfo = {
            chainId: (config as any).default_chain_id,
            registryAddress: (config as any).default_registry_address,
            registrarAddress: (config as any).registrar_address || (config as any).sepolia_registrar_address
          };

          return {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0'),
            registry: registryInfo,
            createdAt: team.created_at
          };
        })
      );

      res.json({ projects: projectList });
    });

    // Backwards compatibility: create project
    this.managementApp.post('/projects', async (req, res) => {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Missing project name' });
      const projNameCheck = validateName(name, 'team');
      if (!projNameCheck.valid) return res.status(400).json({ error: projNameCheck.error });

      try {
        // Create team in database (will auto-assign port range)
        const teamId = await this.db.teams.getOrCreateTeamId(name);

        // Get the created team details
        const team = await this.db.teams.getTeam(teamId);

        if (!team) {
          return res.status(500).json({ error: 'Failed to create project' });
        }

        res.json({
          id: team.id,
          name: team.name,
          createdAt: team.created_at
        });
      } catch (error: any) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: error.message || 'Failed to create project' });
      }
    });

    this.managementApp.post('/agents/spawn', async (req, res) => {
      let teamId = '';
      let teamName = '';
      let id = '';
      try {
        const team = await this.getTeam(req);
        teamId = team.id;
        teamName = team.name;

        const { name, type: agentType, model, runtime, allowedTools, pluginPath, plugins, skills, metadata: reqMetadata, local, agent, roleBody, heartbeat, openMode, workingDirectory: configWorkDir, verbose, dangerouslySkipPermissions, domain, tokenId, address, start } = req.body || {};
        const agentOverlay = agent;
        if (!name) return res.status(400).json({ error: 'Missing name' });
        const agentNameCheck = validateName(name, 'agent');
        if (!agentNameCheck.valid) return res.status(400).json({ error: agentNameCheck.error });

        // Local agent: runs locally using the selected runtime's auth flow
        const isLocalAgent = local === true || local === 'true';
        if (local !== undefined) {
          console.log(`[AgentManager] Spawn request: name=${name}, local=${local} (type: ${typeof local}), isLocalAgent=${isLocalAgent}`);
        }

        // Note: Duplicate names are allowed - agents are uniquely identified by their token ID (e.g., agent.42)

        // Runtime defaults to the shared runtime registry default
        if (runtime !== undefined && !isRuntimeId(runtime)) {
          return res.status(400).json({
            error: `Unknown runtime "${runtime}". Expected one of: ${getAvailableRuntimes().join(', ')}`
          });
        }

        // Remote-endpoint runtimes are registry-only — they are never spawned locally.
        if (runtime !== undefined && isRemoteEndpointRuntime(runtime)) {
          return res.status(400).json({
            error: 'runtime_not_spawnable',
            message: 'public-agent-remote is a remote endpoint runtime. Use POST /agents/register with customer_domain to register an externally-deployed agent.',
          });
        }

        const effectiveRuntime = resolveRuntime(runtime);

        id = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        // Use config-specified working directory if provided, otherwise use workspace
        const workingDirectory = configWorkDir || `${this.baseWorkDir}/agents/${id}`;

        // Get default plugins from config
        const defaultPlugins = this.getDefaultPlugins();

        // Merge user plugins with defaults (user plugins take precedence for same name)
        const userPlugins = plugins || [];
        const userPluginNames = new Set(userPlugins.map((p: any) => p.name));
        const mergedPlugins = [
          ...userPlugins,
          ...defaultPlugins.filter(p => !userPluginNames.has(p.name))
        ];

        // Use default model from config if not specified
        const effectiveModel = model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
        this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

        // Create workspace directory first (needed for plugin copy)
        mkdirSync(workingDirectory, { recursive: true });

        // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
        if (agentOverlay) {
          copyLibraryAgentOverlay(workingDirectory, agentOverlay, effectiveRuntime);
        }

        // 2. Deploy team-level skills (runtime-aware: .claude/skills/ or .agents/skills/)
        if (skills && Array.isArray(skills) && skills.length > 0) {
          this.deploySkillsToAgent(workingDirectory, skills, {
            DISPLAY_NAME: domain || name,
            TEAM: teamName,
            ONCHAIN_IDENTITY: domain
              ? `Your onchain identity is your ENS domain: **${domain}**`
              : '',
            ORG_CONTEXT: '',
          }, { hasWallet: false, runtime: effectiveRuntime });
        }

        // 3. Overlay working-directory template files (runtime-aware)
        copyAgentDirOverlay(workingDirectory, name, effectiveRuntime);
        // Copy HEARTBEAT.md from template to working directory root
        copyHeartbeatMd(workingDirectory, name, effectiveRuntime);

        // 4. Write personality file: protocol defaults + agent role body.
        // For Codex/Cursor this is a marker-fenced framework block inside
        // workspace-root AGENTS.md so user edits and the agent persona block
        // (step 5) survive deploy/sync/rebuild refreshes.
        {
          const parts = [PROTOCOL_DEFAULTS];
          if (roleBody) parts.push(roleBody);
          writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
        }

        // 5. For Codex/Cursor, append the library persona to AGENTS.md
        // between marker fences (no-op for Claude; persona lives in
        // .claude/rules/ sidecar). Runs AFTER the framework write so the
        // marker block sits below the framework section.
        if (agentOverlay) {
          appendLibraryPersonaToAgentsMd(workingDirectory, agentOverlay, effectiveRuntime);
        }

        // Copy plugins to agent's working directory (agent owns its plugins)
        const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

        // Determine effective agent type (default to 'claude')
        const effectiveAgentType = agentType || 'claude';
        const isAutomator = effectiveAgentType === 'automator';
        const normalizedSkills = normalizeConfigSkills(skills);

        const metadata: AgentMetadata = {
          name,
          // Automators don't have REST-AP endpoints
          ...(isAutomator ? {} : { service_type: 'REST-AP', endpoint: '' }),
          runtime: effectiveRuntime,  // Store runtime for display/querying
          // Store config in metadata for later reference
          ...(reqMetadata?.description && { description: reqMetadata.description }),
          // Catalog seed (role/expertise/etc.) — surfaced to peers via /catalog.
          ...(reqMetadata?.catalog && typeof reqMetadata.catalog === 'object' && { catalog: reqMetadata.catalog }),
          plugins: localPlugins, // Use local paths (agent owns its plugins)
          ...(agentOverlay && { agent: agentOverlay }),
          ...(normalizedSkills && { skills: normalizedSkills }),
          ...(allowedTools && { allowed_tools: allowedTools }),
          ...(isAutomator && { isAutomator: true }),
          // Flag that heartbeat is enabled (actual config read from HEARTBEAT.yaml)
          ...(heartbeat && { heartbeat: true }),
          ...(openMode !== undefined && { openMode: openMode === true || openMode === 'true' }),
          ...(dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: dangerouslySkipPermissions === true || dangerouslySkipPermissions === 'true' }),
          // Pass through optional provider public metadata. Provider-specific
          // secrets still require an enabled provider before env injection.
          ...((reqMetadata as any)?.provider_wallet_address && {
            provider_wallet_address: (reqMetadata as any).provider_wallet_address,
          }),
          ...((reqMetadata as any)?.providerWalletAddress && {
            providerWalletAddress: (reqMetadata as any).providerWalletAddress,
          }),
          ...((reqMetadata as any)?.providers && typeof (reqMetadata as any).providers === 'object' && {
            providers: (reqMetadata as any).providers,
          }),
          // Pass through pre-provisioned SkillMesh plugin fields; the provider
          // still has to be enabled before keys are derived or injected.
          ...((reqMetadata as any)?.skillmesh_address && {
            skillmesh_address: (reqMetadata as any).skillmesh_address,
            skillmesh_private_key: (reqMetadata as any).skillmesh_private_key,
            skillmesh_key_index: (reqMetadata as any).skillmesh_key_index,
            skillmesh_key_path: (reqMetadata as any).skillmesh_key_path,
          }),
        };

        await this.db.agents.create({
          team_id: teamId,
          id,
          name,
          type: effectiveAgentType,
          model: effectiveModel,
          port: 0,
          endpoint: null,
          working_directory: workingDirectory,
          status: 'starting',
          created_at: Date.now(),
          metadata,
          api_key: null,
          token_id: tokenId || null,
          domain: domain || null,
          runtime: effectiveRuntime,
        });

        // Derive agent_account from request address, or fall back to shared deployer key
        const deployerAddress = this.getDeployerAddress();
        const agentAccount = address || deployerAddress;
        const updatedMeta = { ...metadata, ...(agentAccount && { agent_account: agentAccount }) };
        await this.db.agents.updateMetadata(id, updatedMeta);

        // All agents run locally
        const allocatedPort = await this.dbNextPort(teamId);
        const url = `http://localhost:${allocatedPort}`;
        const finalMeta: AgentMetadata = {
          ...updatedMeta,
          service_type: 'REST-AP',
          endpoint: url,
          local: true,
          runtime: effectiveRuntime
        };
        // SkillMesh stays a bundled optional provider. Neutral agents do not get
        // SkillMesh keys just because a master key exists in the environment.
        const providerMeta = await this.maybeAssignSkillmeshKey(id, teamName, finalMeta);
        // Strip private key before sending in API response (stays in DB for worker env injection)
        const { skillmesh_private_key: _smKey, ...providerMetaPublic } = providerMeta as any;
        await this.db.agents.updateStatus(id, 'pending', {
          port: allocatedPort,
          endpoint: url,
          metadata: providerMeta,
        });

        // Use host paths for local agents
        // If configWorkDir is an absolute path, use it directly (project repo)
        const hostWorkspaceDir = process.env.ID_WORKSPACE_DIR || this.baseWorkDir;
        const hostWorkingDirectory = configWorkDir && path.isAbsolute(configWorkDir) ? configWorkDir : `${hostWorkspaceDir}/agents/${id}`;
        const hostSharedDirectory = `${hostWorkspaceDir}/teams/${teamName}`;

        // Seed heartbeat schedule if enabled
        if (heartbeat && this.schedulerService) {
          const { definition, agentIds } = heartbeatToSchedule(id, name, heartbeat);
          await this.schedulerService.seedSchedule(definition, agentIds);
        }

        // Start the local process now when requested (the GUI "Add agent" flow).
        // Without this, /agents/spawn only creates the row and leaves the CLI to
        // spawn the worker; with start:true the manager spawns it itself.
        if (start === true || start === 'true') {
          await this.spawnLocalAgentProcess(teamId, teamName, {
            name,
            id,
            port: allocatedPort,
            model: effectiveModel,
            workingDirectory: hostWorkingDirectory,
            tokenId: tokenId || undefined,
            address: address || undefined,
          });
        }

        res.status(201).json({
          id,
          name,
          model: effectiveModel,
          runtime: effectiveRuntime,
          port: allocatedPort,
          status: 'pending',  // Will become 'running' when local process starts
          type: 'claude',
          local: true,
          url,
          restap: `${url}/.well-known/restap.json`,
          metadata: providerMetaPublic,
          // Info for CLI to spawn local agent process
          teamId,
          teamName,
          workingDirectory: hostWorkingDirectory,
          sharedDirectory: hostSharedDirectory
        });
        this.broadcastAgentsChanged(teamId, { reason: 'spawn', added: [name] });
      } catch (error: any) {
        // Ensure we never return Express's default HTML error page (CLI expects JSON).
        try {
          if (teamId && id) {
            await this.db.agents.updateStatus(id, 'error');
          }
        } catch {
          // ignore
        }

        res.status(500).json({ error: error?.message || String(error) });
      }
    });

    this.managementApp.post('/agents/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);

      // Branch: public-agent-remote registration (Phase 2)
      // A request with runtime==='public-agent-remote' registers an externally-deployed
      // agent as a registry entry. No port allocation, no process spawn, no well-known
      // fetch, no on-chain registration (those are Phase 3–5).
      if ((req.body as any)?.runtime === 'public-agent-remote') {
        const {
          name: remoteName,
          customer_domain,
          public_endpoint_url,
          internal_endpoint_url,
          ssh_target,
          wallet,
        } = req.body as any;

        // Required fields
        if (!remoteName) return res.status(400).json({ error: 'missing_field', message: 'name is required' });
        if (!customer_domain) return res.status(400).json({ error: 'missing_field', message: 'customer_domain is required' });
        if (!public_endpoint_url) return res.status(400).json({ error: 'missing_field', message: 'public_endpoint_url is required' });

        // Name validation
        const remoteNameCheck = validateName(remoteName, 'agent');
        if (!remoteNameCheck.valid) return res.status(400).json({ error: 'invalid_name', message: remoteNameCheck.error });

        // URL validation
        try { new URL(public_endpoint_url); } catch {
          return res.status(400).json({ error: 'invalid_url', message: 'public_endpoint_url must be a valid URL' });
        }
        if (internal_endpoint_url) {
          try { new URL(internal_endpoint_url); } catch {
            return res.status(400).json({ error: 'invalid_url', message: 'internal_endpoint_url must be a valid URL' });
          }
        }

        // Reject if name already exists in team
        const existing = await this.dbQueryAgentByNameMostRecent(teamId, remoteName);
        if (existing) {
          return res.status(409).json({ error: 'name_conflict', message: `Agent "${remoteName}" already exists in this team` });
        }

        const remoteId = `remote_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const now = Date.now();

        const remoteWalletOptIn = wallet === true;

        await this.db.agents.create({
          team_id: teamId,
          id: remoteId,
          name: remoteName,
          type: 'virtual',
          model: 'unknown',
          port: 0,
          endpoint: null,
          working_directory: null,
          status: 'registered',
          created_at: now,
          runtime: 'public-agent-remote',
          customer_domain: customer_domain,
          public_endpoint_url: public_endpoint_url,
          internal_endpoint_url: internal_endpoint_url ?? null,
          ssh_target: ssh_target ?? null,
          metadata: { wallet: remoteWalletOptIn },
        });

        return res.status(201).json({
          id: remoteId,
          name: remoteName,
          runtime: 'public-agent-remote',
          deploymentShape: 'remote-endpoint',
          status: 'registered',
          port: null,
          url: null,
          customer_domain,
          public_endpoint_url,
          internal_endpoint_url: internal_endpoint_url ?? null,
          ssh_target: ssh_target ?? null,
          metadata: { wallet: remoteWalletOptIn },
          health: 'unknown',
        });
      }

      const { id: requestedIdRaw, name, endpoint, metadata, type: requestedTypeRaw } = req.body || {};
      if (!name || !endpoint) return res.status(400).json({ error: 'Missing name or endpoint' });
      const regNameCheck = validateName(name, 'agent');
      if (!regNameCheck.valid) return res.status(400).json({ error: regNameCheck.error });

      const requestedId = typeof requestedIdRaw === 'string' ? requestedIdRaw.trim() : undefined;
      if (requestedId && !/^[a-zA-Z0-9_:-]{1,200}$/.test(requestedId)) {
        return res.status(400).json({ error: 'Invalid id format' });
      }

      const requestedType =
        typeof requestedTypeRaw === 'string' ? requestedTypeRaw.trim().toLowerCase() : undefined;
      // Allow 'claude' type for local agents, 'interactive' for CLI users, 'virtual' for external
      const type = requestedType === 'interactive' ? 'interactive'
        : requestedType === 'claude' ? 'claude'
        : 'virtual';

      // Generate stable ID based on agent type
      const idPrefix = type === 'claude' ? 'local_' : 'virtual_';
      const stableId =
        idPrefix +
        name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 60);

      const id = requestedId || stableId;

      // Backwards-compat: if client didn't provide an id, keep the old "dedupe by name" behavior.
      // If client provides an id, treat id as canonical and do not delete other agents that happen to share the same name.
      if (!requestedId) {
        await this.db.agents.softDelete(teamId, name, id, Date.now());
      }

      // Self-registration lands after spawnLocalAgentProcess already persisted
      // `pid` onto the row's metadata. Merge over the existing row so the pid
      // (and anything else a spawn-time path set) survives registration.
      const priorRow = await this.db.agents.getById(id).catch(() => null);
      const priorMeta = (priorRow?.metadata as Record<string, unknown>) || {};
      const meta: AgentMetadata = {
        ...priorMeta,
        name,
        service_type: (metadata && metadata.service_type) || 'REST-AP',
        endpoint,
        ...(metadata || {}),
        ...(typeof (priorMeta as { pid?: unknown }).pid === 'number'
          ? { pid: (priorMeta as { pid: number }).pid }
          : {}),
      };

      // Extract domain from request body if provided
      const reqDomain = (req.body as any).domain || null;

      await this.db.agents.upsert({
        team_id: teamId,
        id,
        name,
        type,
        model: 'external',
        port: 0,
        endpoint,
        working_directory: '',
        status: 'running',
        created_at: Date.now(),
        metadata: meta,
        domain: reqDomain,
      });

      // Set agent_account from shared deployer key for display/identity purposes
      let nextMeta = meta;
      if (!nextMeta.agent_account) {
        const deployerAddress = this.getDeployerAddress();
        if (deployerAddress) {
          nextMeta = { ...nextMeta, agent_account: deployerAddress };
          await this.db.agents.updateMetadata(id, nextMeta);
        }
      }

      res.status(201).json({
        id,
        name,
        type,
        status: 'running',
        url: endpoint,
        restap: `${endpoint}/.well-known/restap.json`,
        domain: reqDomain,
        metadata: nextMeta
      });
    });

    this.managementApp.post('/agents/:id/metadata', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const { metadata } = req.body || {};
      const nextMetadata = metadata ? { ...(agent.metadata || {}), ...(metadata || {}) } : agent.metadata;

      await this.db.agents.updateMetadata(agent.id, nextMetadata);

      // Agent self-publishing a pid is proof of life — flip status to running.
      // Without this, SQLite-mode deploys leave agents stuck on 'pending'
      // (the db-direct updateStatus path only runs when DATABASE_URL is set).
      const incomingPid = (metadata as { pid?: unknown } | undefined)?.pid;
      if (typeof incomingPid === 'number' && agent.status !== 'running') {
        await this.db.agents.updateStatus(agent.id, 'running');
      }

      const server = this.runningServers.get(this.key(teamId, agent.id));
      if (server && agent.type === 'claude') {
        server.setIdentity({
          name: agent.name,
          metadata: nextMetadata,
          tokenId: agent.token_id || undefined,
          domain: agent.domain || undefined
        });
      }

      res.json({ id: agent.id, name: agent.name, metadata: nextMetadata });
    });

    this.managementApp.post('/agents/by-name/:name/metadata', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const { metadata } = req.body || {};
      const nextMetadata = metadata ? { ...(agent.metadata || {}), ...(metadata || {}) } : agent.metadata;

      await this.db.agents.updateMetadata(agent.id, nextMetadata);

      const server = this.runningServers.get(this.key(teamId, agent.id));
      if (server && agent.type === 'claude') {
        server.setIdentity({
          name: agent.name,
          metadata: nextMetadata,
          tokenId: agent.token_id || undefined,
          domain: agent.domain || undefined
        });
      }

      res.json({ id: agent.id, name: agent.name, metadata: nextMetadata });
    });

    // Note: Agent catalogs are managed by agents themselves via their /catalog endpoint
    // This follows REST-AP where each agent owns its own /.well-known/restap.json
    // To view an agent's catalog, fetch their restap.json: GET {agent.url}/.well-known/restap.json

    this.managementApp.post('/agents/:id/onchain/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // ?redeliver=1 — re-push identity.json to remote VPS without re-running
      // the on-chain registration step (only meaningful for remote agents that
      // are already registered).
      const redeliver = req.query.redeliver === '1' || req.body?.redeliver === true;
      if (redeliver && isRemoteEndpointRuntime(agent.runtime)) {
        const idchainDomain = (agent.metadata as any)?.idchain_domain || agent.domain;
        if (!idchainDomain) {
          return res.status(400).json({ error: 'Agent is not yet registered on-chain. Cannot redeliver.' });
        }
        try {
          await this.stageAndDeliverRemoteIdentity(agent, idchainDomain, agent.token_id || '', agent.metadata as AgentMetadata || {});
          return res.json({ ok: true, redelivered: true, domain: idchainDomain, agent: { id: agent.id } });
        } catch (e: any) {
          return res.status(500).json({ error: e?.message || String(e) });
        }
      }

      try {
        const result = await this.registerOnchainAndUpdateAgent(teamId, agent);

        // Update CLAUDE.md with agent's full identity (local agents only)
        if (result.tokenId && agent.working_directory && !isRemoteEndpointRuntime(agent.runtime)) {
          try {
            const claudeDir = path.join(agent.working_directory, '.claude');
            if (!existsSync(claudeDir)) {
              mkdirSync(claudeDir, { recursive: true });
            }
            this.updateClaudeMdIdentity(path.join(claudeDir, 'CLAUDE.md'), result.domain || result.tokenId || agent.name);
            console.log(`[Register] Updated CLAUDE.md with identity: ${result.domain || result.tokenId || agent.name}`);
          } catch (identityErr: any) {
            console.warn(`[Register] Failed to update CLAUDE.md: ${identityErr.message}`);
          }
        }

        const fresh = await this.dbQueryAgentById(teamId, agent.id);
        res.json({ ok: true, ...result, agent: { id: agent.id, name: agent.name, domain: fresh?.domain, tokenId: fresh?.token_id } });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // Redeliver identity file to remote VPS without re-running on-chain registration.
    this.managementApp.post('/agents/:id/onchain/redeliver-identity', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (!isRemoteEndpointRuntime(agent.runtime)) {
        return res.status(400).json({ error: 'redeliver_not_supported', message: 'Only public-agent-remote agents support identity redelivery.' });
      }
      const idchainDomain = (agent.metadata as any)?.idchain_domain || agent.domain;
      if (!idchainDomain) {
        return res.status(400).json({ error: 'Agent is not yet registered on-chain. Cannot redeliver.' });
      }
      try {
        await this.stageAndDeliverRemoteIdentity(agent, idchainDomain, agent.token_id || '', agent.metadata as AgentMetadata || {});
        return res.json({ ok: true, redelivered: true, domain: idchainDomain, agent: { id: agent.id } });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/agents/by-name/:name/onchain/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      try {
        const result = await this.registerOnchainAndUpdateAgent(teamId, agent);

        // Update CLAUDE.md with agent's full identity (local agents only)
        if (result.tokenId && agent.working_directory && !isRemoteEndpointRuntime(agent.runtime)) {
          try {
            const claudeDir = path.join(agent.working_directory, '.claude');
            if (!existsSync(claudeDir)) {
              mkdirSync(claudeDir, { recursive: true });
            }
            this.updateClaudeMdIdentity(path.join(claudeDir, 'CLAUDE.md'), result.domain || result.tokenId || agent.name);
            console.log(`[Register] Updated CLAUDE.md with identity: ${result.domain || result.tokenId || agent.name}`);
          } catch (identityErr: any) {
            console.warn(`[Register] Failed to update CLAUDE.md: ${identityErr.message}`);
          }
        }

        const fresh = await this.dbQueryAgentById(teamId, agent.id);
        res.json({ ok: true, ...result, agent: { id: agent.id, name: agent.name, domain: fresh?.domain, tokenId: fresh?.token_id } });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/agents/:id/model', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const { model } = req.body;

      if (!model) {
        return res.status(400).json({ error: 'Missing model in request body' });
      }

      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      if (agent.type !== 'claude') {
        return res.status(400).json({ error: 'Only local runtime-backed agents have models' });
      }

      try {
        // Update model in database - agent needs restart to pick up new model
        await this.db.agents.updateStatus(agent.id, 'pending', { model });

        console.log(`[Manager] Updated model for ${agent.name} to ${model} - restart required`);

        res.json({
          id: agent.id,
          name: agent.name,
          model: model,
          status: 'pending',
          message: 'Model updated. Restart the agent to apply the new model.'
        });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /agents/:id/runtime — switch an agent's runtime (harness). Like
    // /model, this updates the row and requires a rebuild to apply (the new
    // runtime changes the harness, skills dir, and spawn env).
    this.managementApp.post('/agents/:id/runtime', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const { runtime } = req.body || {};
      if (!runtime || typeof runtime !== 'string') {
        return res.status(400).json({ error: 'Missing runtime in request body' });
      }
      if (!isSupportedRuntimeSpecifier(runtime)) {
        return res.status(400).json({ error: `Unknown runtime "${runtime}"` });
      }
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (agent.type !== 'claude') {
        return res.status(400).json({ error: 'Only local runtime-backed agents have a switchable runtime' });
      }
      try {
        const metadataBase = { ...((agent.metadata || {}) as AgentMetadata) };
        const providerAssignment = isProviderRuntimeSpecifier(runtime)
          ? this.normalizeProviderRuntimeAssignment(runtime, (req.body || {}).provider)
          : null;
        const resolved = providerAssignment ? 'provider-api' : resolveRuntime(runtime);
        const metadata = providerAssignment
          ? {
              ...metadataBase,
              runtime: providerAssignment.lane,
              providerRuntime: this.providerRuntimeMetadata(providerAssignment),
            }
          : {
              ...metadataBase,
              runtime: resolved,
              providerRuntime: undefined,
            };
        if (providerAssignment) this.providerRuntimeAssignments.set(agent.id, providerAssignment);
        else this.providerRuntimeAssignments.delete(agent.id);
        await this.db.agents.updateStatus(agent.id, 'pending', { runtime: resolved, metadata });
        console.log(`[Manager] Updated runtime for ${agent.name} to ${providerAssignment?.lane ?? resolved} - rebuild required`);
        res.json({
          id: agent.id,
          name: agent.name,
          runtime: providerAssignment?.lane ?? resolved,
          executionRuntime: resolved,
          status: 'pending',
          needsRebuild: true,
          message: 'Runtime updated. Rebuild the agent to apply.',
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        res.status(providerRuntimeErrorStatus(msg)).json({ error: msg });
      }
    });

    // POST /agents/:id/team — move a local runtime-backed agent to another
    // existing team. This is the Control Center primitive used by HR team
    // rename/merge; it deliberately refuses to create target teams or move
    // remote/public endpoints.
    this.managementApp.post('/agents/:id/team', async (req, res) => {
      try {
        if (!this.isAdminRequest(req)) return res.status(403).json({ error: 'admin_required' });
        const { id: sourceTeamId, name: sourceTeamName } = await this.getTeam(req);
        const body = req.body || {};
        const targetName = String(body.team || '').trim();
        const createTarget = Boolean(body.createTarget || body.create);
        if (!targetName) return res.status(400).json({ error: 'Missing target team' });
        const nameCheck = validateName(targetName, 'team');
        if (!nameCheck.valid) return res.status(400).json({ error: nameCheck.error });

        let targetTeam = await this.db.teams.getTeamByName(targetName);
        if (!targetTeam && createTarget) {
          const targetTeamId = await this.db.teams.getOrCreateTeamId(targetName);
          targetTeam = await this.db.teams.getTeam(targetTeamId);
        }
        if (!targetTeam) return res.status(404).json({ error: `Target team "${targetName}" not found` });
        if (targetTeam.id === sourceTeamId) return res.status(400).json({ error: 'Agent is already in that team' });

        const agent = await this.dbQueryAgentById(sourceTeamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        if (isRemoteEndpointRuntime(agent.runtime)) {
          return res.status(400).json({ error: 'team_move_not_supported_for_remote' });
        }
        if (agent.type !== 'claude') {
          return res.status(400).json({ error: 'Only local runtime-backed agents can be moved between teams' });
        }

        const collision = await this.db.agents.getByName(targetTeam.id, agent.name);
        if (collision && collision.id !== agent.id) {
          return res.status(409).json({ error: `Target team already has an agent named "${agent.name}"` });
        }

        const oldServerKey = this.key(sourceTeamId, agent.id);
        const oldServer = this.runningServers.get(oldServerKey);
        if (oldServer) {
          try {
            await oldServer.stop();
          } catch (e) {
            console.error(`⚠️ Failed to stop moved agent server ${agent.name} (${agent.id}):`, e);
          }
          this.runningServers.delete(oldServerKey);
        }

        const shouldRebuild = agent.status === 'running' || agent.status === 'starting' || Boolean(oldServer);
        await this.db.agents.moveToTeam(agent.id, targetTeam.id, shouldRebuild ? 'pending' : undefined);

        let rebuilt = false;
        let warning: string | undefined;
        if (shouldRebuild) {
          const spawnResult = await this.rebuildLocalClaudeAgent(targetTeam.id, targetTeam.name, {
            ...agent,
            team_id: targetTeam.id,
            status: 'pending',
          });
          if (spawnResult.success) {
            rebuilt = true;
          } else {
            warning = `moved but rebuild failed: ${spawnResult.error || 'unknown error'}`;
            await this.db.agents.updateStatus(agent.id, 'error').catch(() => {});
          }
        } else {
          warning = `moved while ${agent.status || 'not running'}; start or rebuild when ready`;
        }

        this.broadcastAgentsChanged(sourceTeamId, { reason: 'remove', removed: [agent.name] });
        this.broadcastAgentsChanged(targetTeam.id, { reason: 'spawn', added: [agent.name] });
        return res.json({
          ok: true,
          agent: agent.name,
          id: agent.id,
          from: sourceTeamName,
          team: targetTeam.name,
          rebuilt,
          warning,
        });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /agents/:id/probe — ad-hoc heartbeat probe for remote-endpoint agents
    this.managementApp.post('/agents/:id/probe', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        if (!isRemoteEndpointRuntime(agent.runtime)) {
          return res.status(400).json({ error: 'probe_only_supported_for_remote' });
        }

        await this.probeOneRemoteAgent(teamId, agent);
        // Re-fetch to get the updated values
        const updated = await this.dbQueryAgentById(teamId, agent.id);
        if (!updated) return res.status(404).json({ error: 'Agent not found after probe' });

        const health = this.deriveRemoteHealth(updated);
        res.json({
          ok: updated.consecutive_failures === 0,
          source: updated.last_error === 'health probe failed, well-known succeeded'
            ? 'well-known'
            : updated.consecutive_failures === 0 ? 'health' : 'none',
          last_seen: updated.last_seen ?? null,
          last_error: updated.last_error ?? null,
          consecutive_failures: updated.consecutive_failures ?? 0,
          health,
        });
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? String(err) });
      }
    });

    // PATCH /agents/:id/metadata — update agent properties (wallet, name, etc.)
    this.managementApp.patch('/agents/:id/metadata', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const { wallet, name: newName } = req.body;
        const hasUpdates = wallet || newName;

        if (!hasUpdates) return res.status(400).json({ error: 'No updates provided' });

        if (wallet) {
          const metadata = { ...(agent.metadata as any || {}), wallet_address: wallet };
          await this.db.agents.updateMetadata(agent.id, metadata);
        }
        if (newName) {
          const nameCheck = validateName(newName, 'agent');
          if (!nameCheck.valid) return res.status(400).json({ error: nameCheck.error });
          await this.db.agents.updateIdentity(agent.id, { name: newName });
        }

        res.json({ ok: true, updated: Object.keys(req.body) });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.managementApp.delete('/agents/:id', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // Stop runtime server if running
      const serverKey = this.key(teamId, agent.id);
      const server = this.runningServers.get(serverKey);
      if (server) {
        try {
          await server.stop();
        } catch (e) {
          console.error(`⚠️ Failed to stop agent server ${agent.name} (${agent.id}):`, e);
        }
        this.runningServers.delete(serverKey);
      }

      // Best-effort delete workspace for claude agents
      if (agent.type === 'claude' && agent.working_directory) {
        try {
          const expectedDir = `${this.baseWorkDir}/agents/${agent.id}`;
          if (agent.working_directory === expectedDir) {
            rmSync(agent.working_directory, { recursive: true, force: true });
          }
        } catch (e) {
          console.error(`⚠️ Failed to delete workspace for ${agent.name} (${agent.id}):`, e);
        }
      }

      // Delete record (cascades wallets/news/queries)
      await this.db.agents.deleteAgent(agent.id);
      res.json({ message: 'Agent deleted', id: agent.id, name: agent.name });
      this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [agent.name] });
    });

    this.managementApp.delete('/agents/by-name/:name', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const serverKey = this.key(teamId, agent.id);
      const server = this.runningServers.get(serverKey);
      if (server) {
        try {
          await server.stop();
        } catch {}
        this.runningServers.delete(serverKey);
      }
      if (agent.type === 'claude' && agent.working_directory) {
        try {
          const expectedDir = `${this.baseWorkDir}/agents/${agent.id}`;
          if (agent.working_directory === expectedDir) rmSync(agent.working_directory, { recursive: true, force: true });
        } catch {}
      }
      await this.db.agents.deleteAgent(agent.id);
      res.json({ message: 'Agent deleted', id: agent.id, name: agent.name });
      this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [agent.name] });
    });

    this.managementApp.post('/registry/push', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const includeVirtual = Boolean(req.body?.includeVirtual);
      const agents = await this.dbListAgents(teamId);
      const targets = includeVirtual ? agents : agents.filter(a => a.type === 'claude');

      const results: any[] = [];
      let registered = 0;
      let skipped = 0;
      let failed = 0;

      for (const agent of targets) {
        if (agent.token_id || agent.domain) {
          skipped++;
          results.push({ name: agent.name, id: agent.id, status: 'skipped', reason: 'already-registered', tokenId: agent.token_id, domain: agent.domain });
          continue;
        }
        if (agent.type === 'virtual' && !agent.metadata?.agent_account) {
          skipped++;
          results.push({ name: agent.name, id: agent.id, status: 'skipped', reason: 'virtual-missing-agent_account' });
          continue;
        }

        try {
          const out = await this.registerOnchainAndUpdateAgent(teamId, agent);
          registered++;
          results.push({ name: agent.name, id: agent.id, status: 'registered', ...out });
        } catch (e: any) {
          failed++;
          results.push({ name: agent.name, id: agent.id, status: 'failed', error: e?.message || String(e) });
        }
      }

      res.json({ ok: true, includeVirtual, summary: { registered, skipped, failed }, results });
    });

    this.managementApp.post('/registry/pull', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const baseUrl = String(req.body?.baseUrl || process.env.ID_INDEXER_BASE_URL || 'https://id-indexer.onrender.com');
      const indexerApiKey = process.env.ID_INDEXER_API_KEY;
      const requestedChainId = req.body?.chainId ? parseInt(String(req.body.chainId)) : undefined;
      const requestedRegistryAddress = req.body?.registryAddress ? String(req.body.registryAddress) : undefined;

      // Require specific agent IDs to prevent pulling too many agents
      const agentIds = Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String).filter(Boolean) : [];
      if (agentIds.length === 0) {
        return res.status(400).json({
          error: 'Missing agent IDs. Use /registry pull <agent-ids> (space or comma separated)'
        });
      }

      // Optional: also spawn local runtime-backed agents (with HTTP servers) for onchain agents we discover.
      // This "materializes" the registry into a runnable local network.
      const spawnServers = req.body?.spawn === undefined ? false : Boolean(req.body?.spawn);

      const discovery: {
        baseUrl: string;
        chainId?: number;
        registryAddress?: string;
        agentIds: string[];
        fetched: number;
        upserted: number;
        spawned?: number;
        total?: number;
        errors: string[];
      } = {
        baseUrl,
        agentIds,
        fetched: 0,
        upserted: 0,
        errors: []
      };

      const discoveredOnchain: Array<{
        chainId: number;
        registryAddress: string;
        tokenId: string;
        nameHint: string;
      }> = [];

      // Also discover agents from the indexer (registry-wide) and upsert them into the local DB.
      // This makes "pull" behave more like "git pull": you can populate your local network from the registry.
      try {
        const defaultReg = await this.getDefaultRegistry(teamId);
        const chainId = requestedChainId || defaultReg.chainId;
        const registryAddress = requestedRegistryAddress || defaultReg.registryAddress;

        discovery.chainId = chainId;
        discovery.registryAddress = registryAddress;

        // Fetch specific agent IDs from the indexer
        for (const agentId of agentIds) {
          try {
            const params = new URLSearchParams();
            params.set('agentId', agentId);
            params.set('chainId', String(chainId));
            if (requestedRegistryAddress) params.set('registry', String(requestedRegistryAddress));

            const agentUrl = `${baseUrl}/api/agents/${agentId}?${params.toString()}`;
            const agentResp = await fetch(agentUrl, {
              headers: indexerApiKey ? { Authorization: `Bearer ${indexerApiKey}` } : undefined
            });

            if (!agentResp.ok) {
              discovery.errors.push(`agent ${agentId}: HTTP ${agentResp.status} ${agentResp.statusText}`);
              continue;
            }

            const ra = await agentResp.json() as any;
            discovery.fetched += 1;

            const tokenId = String(ra.agentId || ra.mintNumber || agentId).trim();
            const regAddr = String(ra.registryAddress || registryAddress).trim();
            if (!tokenId || !regAddr) {
              discovery.errors.push(`agent ${agentId}: missing tokenId or registryAddress`);
              continue;
            }

            const reg = {
              chainId: ra.chainId || chainId,
              registryAddress: regAddr,
              tokenId
            };

            const shortReg = regAddr.slice(0, 6) + '…' + regAddr.slice(-4);
            const nameHint =
              typeof ra.endpointType === 'string' && ra.endpointType.trim()
                ? `${ra.endpointType}:${shortReg}:${tokenId}`
                : `agent:${shortReg}:${tokenId}`;

            discoveredOnchain.push({
              chainId: ra.chainId || chainId,
              registryAddress: regAddr,
              tokenId,
              nameHint
            });

            const isPublicAgentType = (ra.endpointType || '').toLowerCase() === 'public-agent';

            const metadata: any = {
              name: nameHint,
              service_type: ra.endpointType || 'REST-AP',
              endpoint: ra.endpoint,
              agent_account: ra.agentAccount,
              // Discovery-only semantics (Option A): public-agent identities are imported
              // as discovery records — visible in /agents but not routable via inter-agent
              // mesh. mesh_member:false + discovery_only:true signal this to operators.
              // The mesh-membership gate in handleMessage blocks routing without needing
              // a separate DB column (metadata flags are sufficient for Phase 6A).
              // TODO (Phase 6B): add --promote flag to the /registry/pull CLI command
              // so operators can opt a discovered public-agent into the mesh explicitly.
              // See design doc §6A.3 for discovery-only vs full-member semantics.
              ...(isPublicAgentType ? { mesh_member: false, discovery_only: true } : {}),
            };

            // If we already have this onchain agent locally (e.g., a spawned claude agent with the same tokenId),
            // merge into that record instead of creating a separate virtual duplicate.
            // TODO: move to repository — token_id-only lookup across types
            const existing = await this.db.adapter.query<{ id: string; type: string }>(
              `SELECT id, type
               FROM agents
               WHERE team_id = $1
                 AND deleted_at IS NULL
                 AND token_id = $2
               ORDER BY created_at DESC
               LIMIT 1`,
              [teamId, tokenId]
            );

            if (existing.rowCount && existing.rows[0]?.id) {
              const existingId = existing.rows[0].id;
              const existingType = existing.rows[0].type;
              // Merge metadata; don't stomp local endpoint/port for claude agents.
              const currentAgent = await this.db.agents.getById(existingId);
              const currentMeta = (currentAgent?.metadata || {}) as any;
              // When merging a public-agent type, preserve discovery-only flags.
              const mergedMeta = { ...currentMeta, ...metadata, name: currentMeta.name || metadata.name };
              if (isPublicAgentType) {
                mergedMeta.mesh_member = false;
                mergedMeta.discovery_only = true;
              }

              // TODO: move to repository — conditional endpoint update
              await this.db.adapter.query(
                `UPDATE agents
                 SET token_id = $3,
                     metadata = $4,
                     endpoint = CASE WHEN $5 = 'virtual' THEN $6 ELSE endpoint END,
                     deleted_at = NULL
                 WHERE team_id = $1 AND id = $2`,
                [teamId, existingId, tokenId, mergedMeta, existingType, ra.endpoint || null]
              );

              // TODO: move to repository — delete virtual agent by id with type guard
              const onchainId = `onchain_${chainId}_${regAddr}_${tokenId}`;
              await this.db.adapter.query(`DELETE FROM agents WHERE team_id = $1 AND id = $2 AND type = 'virtual'`, [
                teamId,
                onchainId
              ]);

              discovery.upserted += 1;
              continue;
            }

            // Otherwise upsert as a stable virtual id
            const id = `onchain_${chainId}_${regAddr}_${tokenId}`;
            await this.db.agents.upsert({
              team_id: teamId,
              id,
              name: nameHint,
              type: 'virtual',
              model: 'external',
              port: 0,
              endpoint: ra.endpoint || null,
              working_directory: '',
              status: 'running',
              created_at: Date.now(),
              metadata,
              token_id: tokenId,
              runtime: isPublicAgentType ? 'public-agent-remote' : 'claude-agent-sdk',
            });
            discovery.upserted += 1;
          } catch (e: any) {
            discovery.errors.push(`agent ${agentId}: ${e?.message || String(e)}`);
          }
        }
      } catch (e: any) {
        discovery.errors.push(`discovery: ${e?.message || String(e)}`);
      }

      // Optional: spawn local runtime-backed agents for the onchain entries (so they have HTTP servers).
      // NOTE: This does NOT try to contact the remote endpoint; it creates local agents that represent the onchain identities.
      if (spawnServers && discoveredOnchain.length > 0) {
        try {
          const defaultModel = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
          const sharedDirectory = `${this.baseWorkDir}/teams/${teamName}`;
          let spawned = 0;

          // Spawn local runtime-backed agents for the agents we just pulled

          for (const agent of discoveredOnchain) {
            const tokenId = agent.tokenId;

            // Never spawn a local runtime-backed copy for an interactive agent already linked to this token.
            const interactiveAgent = await this.db.agents.findByRegistry(
              teamId, String(agent.chainId), String(agent.registryAddress), tokenId
            );
            if (interactiveAgent && interactiveAgent.type === 'interactive') continue;

            // If a local runtime-backed agent already exists for this token, ensure its server is running.
            const existingClaudeAgent = await this.db.agents.findByRegistry(
              teamId, String(agent.chainId), String(agent.registryAddress), tokenId
            );
            if (existingClaudeAgent && existingClaudeAgent.type === 'claude') {
              const a = existingClaudeAgent;
              const key = this.key(teamId, a.id);
              if (!this.runningServers.get(key)) {
                try {
                  const workingDirectory = a.working_directory || `${this.baseWorkDir}/agents/${a.id}`;
                  if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });
                  const server = new AgentRestServer({
                    model: a.model || defaultModel,
                    workingDirectory,
                    sharedDirectory,
                    agentName: a.name,
                    agentIdentity: { name: a.name, network: teamName, tokenId, metadata: (a.metadata || {}) as any },
                    db: { db: this.db, teamId: teamId, agentId: a.id }
                  });
                  await server.start(a.port);
                  this.runningServers.set(key, server);
                } catch (e: any) {
                  discovery.errors.push(`start-${tokenId}: ${e?.message || String(e)}`);
                }
              }
              continue;
            }

            // Create and start a new local runtime-backed agent representing this onchain identity.
            const claudeId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const port = await this.dbNextPort(teamId);
            const workingDirectory = `${this.baseWorkDir}/agents/${claudeId}`;
            if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });

            const nameHint = agent.nameHint;

            // Ensure handle uniqueness (keep handles stable and unique even if onchain display names collide)
            let handle = nameHint;
            const existingByName = await this.db.agents.getByName(teamId, handle);
            if (existingByName) {
              handle = `${nameHint}_${tokenId}`;
            }

            let metadata: AgentMetadata = {
              name: handle,
              service_type: 'REST-AP',
              endpoint: `http://localhost:${port}`
            };

            await this.db.agents.create({
              team_id: teamId,
              id: claudeId,
              name: handle,
              type: 'claude',
              model: defaultModel,
              port,
              endpoint: null,
              working_directory: workingDirectory,
              status: 'starting',
              created_at: Date.now(),
              metadata,
              token_id: tokenId,
            });

            const deployerAddress = this.getDeployerAddress();
            let finalMeta = metadata;
            if (deployerAddress) {
              finalMeta = { ...metadata, agent_account: deployerAddress };
              await this.db.agents.updateMetadata(claudeId, finalMeta);
            }

            const server = new AgentRestServer({
              model: defaultModel,
              workingDirectory,
              sharedDirectory,
              agentName: handle,
              agentIdentity: { name: handle, network: teamName, tokenId, metadata: finalMeta },
              db: { db: this.db, teamId: teamId, agentId: claudeId }
            });
            await server.start(port);
            this.runningServers.set(this.key(teamId, claudeId), server);
            await this.db.agents.updateStatus(claudeId, 'running');

            spawned++;
          }

          discovery.spawned = spawned;
        } catch (e: any) {
          discovery.errors.push(`spawn: ${e?.message || String(e)}`);
        }
      }

      // Refresh local list after best-effort discovery upsert
      const agents = await this.dbListAgents(teamId);

      const results: any[] = [];
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      const defaultReg = await this.getDefaultRegistry(teamId);
      for (const agent of agents) {
        const tokenId = agent.token_id;
        if (!tokenId) {
          skipped++;
          results.push({ name: agent.name, id: agent.id, status: 'skipped', reason: 'missing-tokenId' });
          continue;
        }

        try {
          const url = `${baseUrl}/api/agents/${defaultReg.chainId}/${defaultReg.registryAddress}/${tokenId}/metadata`;
          const resp = await fetch(url, {
            headers: indexerApiKey ? { Authorization: `Bearer ${indexerApiKey}` } : undefined
          });
          if (!resp.ok) {
            failed++;
            results.push({ name: agent.name, id: agent.id, status: 'failed', error: `HTTP ${resp.status} ${resp.statusText}` });
            continue;
          }

          const meta = (await resp.json()) as any;
          const endpoints: any[] = Array.isArray(meta?.endpoints) ? meta.endpoints : [];

          const agentWalletEndpoint = endpoints.find(
            e => String(e?.name).toLowerCase() === 'agentwallet' || String(e?.name).toLowerCase() === 'agent_wallet'
          );
          const agentWalletStr = agentWalletEndpoint?.endpoint as string | undefined;
          const agentAccount =
            typeof agentWalletStr === 'string' && agentWalletStr.includes(':')
              ? agentWalletStr.split(':').slice(-1)[0]
              : undefined;

          const primaryEndpoint = endpoints.find(e => String(e?.name).toLowerCase() !== 'agentwallet' && typeof e?.endpoint === 'string');

          const isManager = agent.id === 'virtual_manager' || agent.name === 'manager';
          const isReservedManagerName = typeof meta?.name === 'string' && meta.name.trim().toLowerCase() === 'manager';
          const nextMetadata = {
            ...(agent.metadata || {}),
            // The local manager agent is special: never let onchain name changes overwrite it.
            // Also treat "manager" as a reserved display name: don't allow other agents to take it via onchain metadata,
            // since it creates confusing duplicates in the CLI.
            name: isManager
              ? agent.metadata?.name || 'manager'
              : isReservedManagerName
                ? agent.name
                : typeof meta?.name === 'string'
                  ? meta.name
                  : agent.metadata?.name,
            description: typeof meta?.description === 'string' ? meta.description : agent.metadata?.description,
            image: typeof meta?.image === 'string' ? meta.image : agent.metadata?.image,
            service_type: typeof primaryEndpoint?.name === 'string' ? primaryEndpoint.name : agent.metadata?.service_type,
            endpoint: typeof primaryEndpoint?.endpoint === 'string' ? primaryEndpoint.endpoint : agent.metadata?.service,
            agent_account: agentAccount || agent.metadata?.agent_account
          };

          await this.db.agents.updateMetadata(agent.id, nextMetadata);

          // Update running server identity
          const server = this.runningServers.get(this.key(teamId, agent.id));
          if (server && agent.type === 'claude') {
            server.setIdentity({
              name: agent.name,
              metadata: nextMetadata,
              tokenId: agent.token_id || undefined,
              domain: agent.domain || undefined
            });
          }

          updated++;
          results.push({ name: agent.name, id: agent.id, status: 'updated', tokenId });
        } catch (e: any) {
          failed++;
          results.push({ name: agent.name, id: agent.id, status: 'failed', error: e?.message || String(e) });
        }
      }

      res.json({ ok: true, baseUrl, discovery, summary: { updated, skipped, failed }, results });
    });




    // ==================== REMOTE CLI ENDPOINT ====================
    // Allows external tools to execute CLI-style commands

    this.managementApp.post('/remote', async (req, res) => {

      const { command, from } = req.body;
      if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'Missing command in request body' });
      }

      const { id: teamId, name: teamName } = await this.getTeam(req);

      try {
        const result = await this.executeRemoteCommand(
          command.trim(),
          teamId,
          teamName,
          typeof from === 'string' ? from : undefined,
          typeof req.body?.session_id === 'string' ? req.body.session_id : undefined,
        );
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error.message || 'Command execution failed' });
      }
    });

    // Handle /:tokenId without trailing path - returns agent info
    // NOTE: Must be defined BEFORE the wildcard route to take precedence.
    // Non-numeric paths pass through to allow downstream routes (tasks, etc.) to match.
    this.managementApp.get('/:tokenId', async (req, res, next) => {
      const tokenIdParam = req.params.tokenId;

      // Only handle numeric tokenIds; pass all others to downstream routes
      if (!/^\d+$/.test(tokenIdParam)) {
        return next();
      }

      const { id: teamId } = await this.getTeam(req);

      // Find agent by tokenId
      const agents = await this.dbListAgents(teamId, true);
      const agent = agents.find(a => a.token_id === tokenIdParam);

      if (!agent) {
        return res.status(404).json({ error: `Agent with tokenId ${tokenIdParam} not found` });
      }

      // Return agent info with links
      const baseUrl = `${req.protocol}://${req.get('host')}/${tokenIdParam}`;
      res.json({
        agent: this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }),
        links: {
          catalog: `${baseUrl}/.well-known/restap.json`,
          talk: `${baseUrl}/talk`,
          news: `${baseUrl}/news`
        }
      });
    });

    // TokenId-based agent proxy route: /:tokenId/* -> proxy to agent
    // This allows accessing agents via https://idbot.live/23/talk etc.
    // Express 5 uses {*path} syntax for wildcards
    // Use regex for wildcard path matching in Express 5
    // Matches /85/talk, /85/.well-known/restap.json, etc.
    this.managementApp.all(/^\/(\d+)\/(.+)$/, async (req, res) => {
      const tokenIdParam = req.params[0]; // First capture group is tokenId

      const { id: teamId } = await this.getTeam(req);

      // Find agent by tokenId
      const agents = await this.dbListAgents(teamId, true);
      const agent = agents.find(a => a.token_id === tokenIdParam);

      if (!agent) {
        return res.status(404).json({ error: `Agent with tokenId ${tokenIdParam} not found` });
      }

      // Get the agent's internal URL
      const isExternal = agent.type === 'virtual' || agent.type === 'interactive';
      const internalUrl = agent.type === 'claude'
        ? (agent.endpoint || `http://localhost:${agent.port}`)
        : (isExternal ? agent.endpoint : null);
      if (!internalUrl) {
        return res.status(503).json({ error: 'Agent endpoint not available' });
      }

      // Build the proxied path (everything after /:tokenId)
      // Extract path from URL: /23/talk -> talk
      const urlPath = req.path;
      const pathAfterTokenId = urlPath.replace(new RegExp(`^/${tokenIdParam}/?`), '');
      const targetUrl = `${internalUrl.replace(/\/+$/, '')}/${pathAfterTokenId}`;

      try {
        const proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers: {
            'Content-Type': req.headers['content-type'] || 'application/json',
            'Accept': req.headers['accept'] || 'application/json'
          },
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body)
        });

        const contentType = proxyRes.headers.get('content-type') || 'application/json';
        res.status(proxyRes.status).type(contentType);

        const body = await proxyRes.text();
        res.send(body);
      } catch (error: any) {
        res.status(502).json({ error: `Proxy error: ${error.message}` });
      }
    });

    // ==================== TASK REST ENDPOINTS ====================
    // Dedicated task API so agents don't need /remote for task ops

    this.managementApp.post('/tasks', async (req, res) => {
      try {
        let { id: teamId, name: teamName } = await this.getTeam(req);
        const principal = (req as any).ctx?.principal || 'anon';
        const body = req.body || {};
        const { title, name: rawName, description, team: teamRef, from } = body;

        if (!title || typeof title !== 'string') {
          return res.status(400).json({ error: 'Missing required field: title' });
        }

        // Resolve created_by from `from` field first so we can recover the
        // caller's team when no explicit team header was supplied. This lets
        // a deployed agent in a non-default team create a task under its own
        // name using the documented protocol (no team header, just `from`).
        let createdBy: string | null = null;
        let callerAgent: AgentRow | undefined;
        if (from && typeof from === 'string') {
          const first = await this.resolveSingleAgentForCommand(teamId, from);
          callerAgent = first.agent;
          if (!callerAgent && !this.isTeamExplicit(req) && !teamRef) {
            const fallback = await this.resolveCallerAcrossTeams(from);
            if (fallback) {
              callerAgent = fallback.agent;
              teamId = fallback.teamId;
            }
          }
          if (callerAgent) createdBy = callerAgent.id;
        }

        // Resolve team — non-admin principals cannot create tasks in another team
        let taskTeamId: string = teamId;
        if (teamRef) {
          const teamRow = await this.db.teams.getTeamByName(teamRef);
          if (!teamRow) return res.status(404).json({ error: `Team "${teamRef}" not found` });
          if (teamRow.id !== teamId && principal !== 'admin') {
            return res.status(403).json({ error: 'Cannot create task in another team without admin principal' });
          }
          taskTeamId = teamRow.id;
        }

        const taskDescription = appendTaskBriefFieldsToDescription(description, {
          ...body,
          title,
          description,
        });
        const brief = this.validateIncomingTaskBrief({
          ...body,
          title,
          description: taskDescription,
        });
        if (brief.blocked) {
          return res.status(422).json({
            error: 'task_brief_not_dispatch_ready',
            brief_validation: brief.validation,
          });
        }

        const validatorGuard = await this.validateValidatorChildTaskCreation({
          teamId: taskTeamId,
          input: {
            ...body,
            title,
            description: taskDescription,
          },
          fromAgent: callerAgent,
        });
        if (validatorGuard) {
          return res.status(validatorGuard.status).json({
            error: validatorGuard.code,
            message: validatorGuard.message,
            ...(validatorGuard.existingTask ? { existing_task: validatorGuard.existingTask } : {}),
          });
        }

        // Generate or validate name slug, scoped to (team_id, name) uniqueness
        let name = rawName ? normalizeAlias(rawName) : normalizeAlias(title);
        if (rawName) {
          if (await this.db.tasks.getByNameForTeam(name, taskTeamId)) {
            return res.status(409).json({ error: `Task name "${name}" already exists in this team` });
          }
        } else {
          let candidate = name;
          let suffix = 1;
          while (await this.db.tasks.getByNameForTeam(candidate, taskTeamId)) {
            candidate = `${name}-${suffix++}`;
          }
          name = candidate;
        }

        const now = Math.floor(Date.now() / 1000);
        const taskRow: TaskRow = {
          id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          name,
          uuid: crypto.randomUUID(),
          team_id: taskTeamId,
          title,
          description: taskDescription,
          status: 'todo',
          created_by: createdBy,
          owner: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        };

        await this.db.tasks.create(taskRow);
        res.status(201).json({
          ok: true,
          task: await this.buildTaskResult(taskRow, teamId),
          brief_validation: brief.validation,
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/tasks', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { status, owner, team: teamRef, limit: rawLimit } = req.query as Record<string, string>;
        const limit = rawLimit && Number.isFinite(Number(rawLimit))
          ? Math.max(1, Math.min(500, Math.floor(Number(rawLimit))))
          : undefined;

        // Resolve owner
        let ownerIdFilter: string | undefined;
        if (owner) {
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${owner}" not found` });
          ownerIdFilter = agent.id;
        }

        // Resolve team — default to current team for scoped resolution
        let teamIdFilter: string = teamId;
        if (teamRef) {
          const teamRow = await this.db.teams.getTeamByName(teamRef);
          if (!teamRow) return res.status(404).json({ error: `Team "${teamRef}" not found` });
          teamIdFilter = teamRow.id;
        }

        const validStatuses = ['todo', 'doing', 'done'];
        const tasks = await this.db.tasks.list({
          status: status && validStatuses.includes(status) ? status as 'todo' | 'doing' | 'done' : undefined,
          owner: ownerIdFilter,
          teamId: teamIdFilter,
          limit,
        });

        const results = [];
        for (const t of tasks) {
          results.push(await this.buildTaskResult(t, teamId));
        }
        res.json({ ok: true, tasks: results });
      } catch (err: any) {
        console.error('[Manager] Error in GET /tasks:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/tasks/:ref', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { task, error } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: error || `Task "${req.params.ref}" not found` });
        res.json({ ok: true, task: await this.buildTaskResult(task, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in GET /tasks/:ref:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/tasks/:ref/claim', async (req, res) => {
      try {
        let { id: teamId, name: teamName } = await this.getTeam(req);
        const { agent_id, from } = req.body || {};
        const callerRef = agent_id || from;

        if (!callerRef || typeof callerRef !== 'string') {
          return res.status(400).json({ error: 'Missing required field: agent_id (or from)' });
        }

        // Resolve the caller first so we can recover the caller's team when
        // the request omitted the X-Id-Team header. A deployed agent whose
        // CLAUDE.md follows `POST $MANAGER_URL/tasks/<name>/claim` with just
        // `{ agent_id }` would otherwise hit the manager's default team and
        // get "agent not found" even though the agent is registered in its
        // own team. The fallback only runs when the caller didn't specify a
        // team explicitly, so cross-team guards still hold for explicit
        // requests.
        let { agent, error } = await this.resolveSingleAgentForCommand(teamId, callerRef);
        if (!agent && !this.isTeamExplicit(req)) {
          const fallback = await this.resolveCallerAcrossTeams(callerRef);
          if (fallback) {
            agent = fallback.agent;
            teamId = fallback.teamId;
            teamName = (await this.db.teams.getTeam(teamId))?.name || teamName;
          }
        }
        if (!agent) return res.status(404).json({ error: error || `Agent "${callerRef}" not found` });

        const { task, error: taskError } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: taskError || `Task "${req.params.ref}" not found` });

        // Guard against cross-team claim
        if (task.team_id && task.team_id !== teamId) {
          return res.status(404).json({ error: `Task "${req.params.ref}" not found` });
        }

        const claimBrief = this.validateIncomingTaskBrief(this.taskBriefInputFromTask(task));
        if (claimBrief.blocked && !this.canClaimMalformedBriefForRepair(teamName, agent, task)) {
          return res.status(409).json({
            error: 'task_brief_not_dispatch_ready',
            brief_validation: claimBrief.validation,
          });
        }

        const now = Math.floor(Date.now() / 1000);
        const claimed = await this.db.tasks.claim(task.id, agent.id, now, {
          maxDoingForTeam: this.getMaxDoingTasks(),
        });
        if (!claimed) {
          const current = await this.db.tasks.getByNameForTeam(task.name, teamId);
          if (current?.status === 'todo' && !current.owner && !(await this.hasDoingTaskRoom(teamId))) {
            return res.status(409).json({ error: await this.doingTaskLimitMessage(teamId) });
          }
          return res.status(409).json({ error: `Cannot claim "${task.name}" — already owned or not in todo status` });
        }

        const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
        const brainContext = await this.volunteerBrainContext({
          taskId: `task:${updated!.uuid}`,
          agentId: agent.id,
          text: [updated!.title, updated!.description].filter(Boolean).join('\n\n'),
          project: teamName,
        });
        await emitTaskClaimed(this.db.events, {
          teamId,
          taskUuid: updated!.uuid,
          taskName: updated!.name,
          title: updated!.title,
          ownerAgentId: agent.id,
          occurredAt: Date.now(),
          volunteeredSourceIds: brainContext?.cited?.canonical_source_ids || [],
          brainContext: brainContext ? {
            cited: brainContext.cited,
            timelineEventId: brainContext.timelineEventId,
            context_package_id: brainContext.context_package_id ?? brainContext.contextPackageId,
          } : null,
        });
        const taskResult = await this.buildTaskResult(updated!, teamId);
        if (brainContext) (taskResult as any).brain_context = {
          cited: brainContext.cited,
          timelineEventId: brainContext.timelineEventId,
          context_package_id: brainContext.context_package_id ?? brainContext.contextPackageId,
          bundles: brainContext.bundles,
          instructions: brainContext.instructions || [],
        };
        (taskResult as any).brief_validation = claimBrief.validation;
        res.json({ ok: true, task: taskResult });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks/:ref/claim:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/tasks/:ref/done', async (req, res) => {
      try {
        let { id: teamId, name: teamName } = await this.getTeam(req);
        const { agent_id, from } = req.body || {};
        const callerRef = agent_id || from;

        // Mirror the claim endpoint: when a caller is supplied without an
        // explicit team header, recover the caller's team so agents in
        // non-default teams can mark their own tasks done via the default
        // protocol (`POST $MANAGER_URL/tasks/<name>/done { agent_id }`).
        let callerAgent: AgentRow | undefined;
        if (callerRef && typeof callerRef === 'string') {
          const first = await this.resolveSingleAgentForCommand(teamId, callerRef);
          callerAgent = first.agent;
          if (!callerAgent && !this.isTeamExplicit(req)) {
            const fallback = await this.resolveCallerAcrossTeams(callerRef);
            if (fallback) {
              callerAgent = fallback.agent;
              teamId = fallback.teamId;
              teamName = (await this.db.teams.getTeam(teamId))?.name || teamName;
            }
          }
        }

        const { task, error: taskError } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: taskError || `Task "${req.params.ref}" not found` });

        // Guard against cross-team done
        if (task.team_id && task.team_id !== teamId) {
          return res.status(404).json({ error: `Task "${req.params.ref}" not found` });
        }

        // If caller identifies themselves, enforce ownership
        if (callerAgent && task.owner !== callerAgent.id) {
          return res.status(403).json({ error: `Agent "${callerRef}" is not the owner of task "${task.name}"` });
        }

        const completion = this.validateCompletionPayload(req.body || {});
        if (completion.blocked) {
          return res.status(422).json({
            error: 'task_completion_packet_required',
            completion_validation: completion.validation,
          });
        }

        const delegationError = await this.validateTeamLeadDelegationBeforeDone({
          teamId,
          teamName,
          task,
          payload: req.body || {},
        });
        if (delegationError) {
          return res.status(409).json({ error: delegationError });
        }

        const now = Math.floor(Date.now() / 1000);
        await this.db.tasks.updateFields(task.id, {
          status: 'done',
          completed_at: now,
          updated_at: now,
        });

        const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
        const completedAt = Date.now();
        const bodyBrainContext = req.body?.brain_context || req.body?.brainContext || null;
        const claimedBrainContext = bodyBrainContext ? null : await this.latestTaskClaimBrainContext(teamId, updated!.uuid);
        const effectiveBrainContext = bodyBrainContext || claimedBrainContext;
        const usedSourceIds = Array.isArray(req.body?.used_source_ids)
          ? req.body.used_source_ids.map(String)
          : Array.isArray(req.body?.usedSourceIds)
            ? req.body.usedSourceIds.map(String)
            : [];
        const volunteeredSourceIds = Array.isArray(req.body?.volunteered_source_ids)
          ? req.body.volunteered_source_ids.map(String)
          : Array.isArray(req.body?.volunteeredSourceIds)
            ? req.body.volunteeredSourceIds.map(String)
            : Array.isArray(effectiveBrainContext?.cited?.canonical_source_ids)
              ? effectiveBrainContext.cited.canonical_source_ids.map(String)
              : [];
        const learningLoop = normalizeLearningLoopCapture({
          payload: req.body || {},
          subject: {
            kind: 'task',
            ref: `task:${updated!.uuid}`,
            route: 'manager.task_completion',
          },
          teamName,
          agentId: callerAgent?.id ?? updated!.owner ?? null,
          usedSourceIds,
          volunteeredSourceIds,
          occurredAt: completedAt,
        });
        const feedbackContext: BrainVolunteerContext | null = {
          bundles: Array.isArray(effectiveBrainContext?.bundles) ? effectiveBrainContext.bundles : [],
          task_id: `task:${updated!.uuid}`,
          instructions: this.stringArray(req.body?.injected_instruction_ids || req.body?.injectedInstructionIds)
            .map((sourceId) => ({
              source_id: sourceId,
              memory_id: Number(String(sourceId).replace(/^memory:/, '')),
              key: '',
              content: '',
              scope: { project: teamName, task_id: `task:${updated!.uuid}` },
            }))
            .filter((item) => Number.isInteger(item.memory_id)),
        };
        await this.postBrainInstructionFeedback({
          taskId: `task:${updated!.uuid}`,
          agentId: callerAgent?.id ?? updated!.owner ?? null,
          context: feedbackContext,
          payload: req.body || {},
        });
        if (effectiveBrainContext?.cited) {
          (feedbackContext as any).cited = effectiveBrainContext.cited;
          (feedbackContext as any).timelineEventId = effectiveBrainContext.timelineEventId ?? effectiveBrainContext.timeline_event_id;
          (feedbackContext as any).context_package_id = effectiveBrainContext.context_package_id ?? effectiveBrainContext.contextPackageId;
        }
        await this.postBrainEvalCapture({
          queryText: [updated!.title, updated!.description].filter(Boolean).join('\n\n'),
          route: 'manager.task_completion',
          agentId: callerAgent?.id ?? updated!.owner ?? null,
          taskId: `task:${updated!.uuid}`,
          context: feedbackContext,
          usedSourceIds,
          volunteeredSourceIds,
          injectedInstructionIds: this.stringArray(req.body?.injected_instruction_ids || req.body?.injectedInstructionIds),
          latencyMs: updated!.completed_at && updated!.created_at ? Math.max(0, (updated!.completed_at - updated!.created_at) * 1000) : null,
          learningLoop,
        });
        await emitTaskCompleted(this.db.events, {
          teamId,
          taskUuid: updated!.uuid,
          taskName: updated!.name,
          title: updated!.title,
          ownerAgentId: updated!.owner ?? null,
          actorAgentId: callerAgent?.id ?? updated!.owner ?? null,
          occurredAt: completedAt,
          usedSourceIds,
          volunteeredSourceIds,
          learningLoop,
        });
        // Auto-close any active/snoozed checkins linked to this task and
        // emit one checkin:closed event per row. Pure consumer of the
        // task:completed signal we just emitted above.
        await closeLinkedCheckinsForTerminalTask(this.db, {
          teamId,
          taskId: updated!.id,
          taskStatus: updated!.status,
          actorAgentId: callerAgent?.id ?? updated!.owner ?? null,
          occurredAt: completedAt,
        });
        void this.maybeTriggerValidatorRecommendationLoop({
          teamId,
          teamName,
          task: updated!,
          completionPayload: req.body || {},
        });
        res.json({
          ok: true,
          task: await this.buildTaskResult(updated!, teamId),
          completion_validation: completion.validation,
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks/:ref/done:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.delete('/tasks/:ref', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { task, error } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: error || `Task "${req.params.ref}" not found` });
        await this.db.tasks.delete(task.id);
        res.json({ ok: true, removed: task.name });
      } catch (err: any) {
        console.error('[Manager] Error in DELETE /tasks/:ref:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // ==================== WAKEUP SERVICE: GET /events ====================
    // Catch-up read over the team-scoped event log. Wire-format and
    // semantics are defined in output/wakeup-service-design.md
    // ("`GET /events`" section). Auth/team gating is the same as /remote
    // (handled by teamContextMiddleware → getTeam(req)). Producers and
    // SSE/webhook delivery land in separate slices.
    this.managementApp.get('/events', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);

        // since: default 0, must be a non-negative integer.
        const sinceRaw = req.query.since;
        let since = 0;
        if (sinceRaw !== undefined) {
          const parsed = Number(sinceRaw);
          if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
            return res.status(400).json({
              error: 'invalid_since',
              message: '`since` must be a non-negative integer',
            });
          }
          since = parsed;
        }

        // limit: default 100, hard cap 1000, must be a positive integer.
        const limitRaw = req.query.limit;
        let limit = 100;
        if (limitRaw !== undefined) {
          const parsed = Number(limitRaw);
          if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
            return res.status(400).json({
              error: 'invalid_limit',
              message: '`limit` must be a positive integer',
            });
          }
          limit = Math.min(parsed, 1000);
        }

        // topics: optional CSV; alias expansion happens server-side so
        // callers can request `query:terminal` instead of the three
        // concrete topics it covers.
        let topics: string[] | undefined;
        const topicsRaw = req.query.topics;
        if (typeof topicsRaw === 'string' && topicsRaw.length > 0) {
          const requested = topicsRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (requested.length > 0) {
            topics = expandTopicAliases(requested);
          }
        }

        // wait: optional long-poll hold in seconds for live clients. Without
        // this, empty event reads return immediately and Electron renderers can
        // accidentally spin the manager bridge in a tight loop.
        const waitRaw = req.query.wait;
        let waitMs = 0;
        if (waitRaw !== undefined) {
          const parsed = Number(waitRaw);
          if (!Number.isFinite(parsed) || parsed < 0) {
            return res.status(400).json({
              error: 'invalid_wait',
              message: '`wait` must be a non-negative number of seconds',
            });
          }
          waitMs = Math.min(parsed, 30) * 1000;
        }

        // tail=1 is a lightweight cursor bootstrap for live clients. It lets
        // dashboards start at the current event tail without replaying every
        // retained event through the UI on launch or tab switches.
        const tailRaw = req.query.tail;
        const tail = tailRaw === '1' || tailRaw === 'true';
        if (tail) {
          const [earliestAvailableSeq, latestSeq] = await Promise.all([
            this.db.events.earliestSeq(teamId),
            this.db.events.latestSeq(teamId),
          ]);
          return res.json({
            events: [],
            next_seq: latestSeq ?? since,
            replay_truncated: false,
            earliest_available_seq: earliestAvailableSeq,
          });
        }

        const queryRows = () => this.db.events.query({
          teamId,
          sinceSeq: since,
          topics,
          limit,
        });
        let rows = await queryRows();
        if (rows.length === 0 && waitMs > 0) {
          const deadline = Date.now() + waitMs;
          while (rows.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
            rows = await queryRows();
          }
        }
        const earliestAvailableSeq = await this.db.events.earliestSeq(teamId);

        const events = rows.map((row) => ({
          seq: row.seq,
          team: teamName,
          topic: row.topic,
          occurred_at: row.occurred_at,
          actor: row.actor_agent_id,
          subject:
            row.subject_kind === null && row.subject_id === null
              ? null
              : { kind: row.subject_kind, id: row.subject_id },
          data: row.data,
        }));

        const nextSeq = events.length > 0
          ? events[events.length - 1].seq
          : since;

        // replay_truncated: the consumer's cursor predates retained
        // history. `since` is an exclusive cursor, so the consumer next
        // expects `since + 1`; truncation is true only when that next
        // expected seq is strictly less than the earliest retained seq.
        // An empty log (earliestAvailableSeq === null) is never truncated.
        const replayTruncated =
          earliestAvailableSeq !== null && since + 1 < earliestAvailableSeq;

        res.json({
          events,
          next_seq: nextSeq,
          replay_truncated: replayTruncated,
          earliest_available_seq: earliestAvailableSeq,
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /events:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // ==================== CHECKINS API ====================
    // Wire-format and semantics: output/checkin-primitive-design.md.
    // Auth/team gating matches /remote and /events: teamContextMiddleware
    // resolves the team from X-Id-Team and the principal (admin/agent/anon).
    // Event emission (checkin:created/closed/snoozed) is owned by the
    // separate `checkin-events` slice and is not wired here.

    this.managementApp.post('/checkins', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const body = req.body || {};

        // owner: optional. When provided, must resolve to an agent in this team.
        let ownerAgentId: string | null = null;
        let ownerName: string | null = null;
        if (body.owner !== undefined && body.owner !== null) {
          if (typeof body.owner !== 'string') {
            return res.status(400).json({ error: 'invalid_owner' });
          }
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, body.owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${body.owner}" not found` });
          ownerAgentId = agent.id;
          ownerName = (agent.metadata as any)?.alias || agent.name;
        }

        // linked_task: optional but enforces same-team via resolveTaskRef.
        // Reject creation when the linked task is already in a terminal status
        // ('done' is the only terminal status today). Without this guard the
        // row would be created with a future next_fire_at and then immediately
        // auto-closed by closeLinkedCheckinsForTerminalTask on the next task
        // event, leaving a confusing closed-with-no-fires audit trail.
        let linkedTaskId: string | null = null;
        let linkedTaskRow: TaskRow | undefined;
        if (body.linked_task !== undefined && body.linked_task !== null) {
          if (typeof body.linked_task !== 'string') {
            return res.status(400).json({ error: 'invalid_linked_task' });
          }
          const { task, error } = await this.resolveTaskRef(body.linked_task, teamId);
          if (!task) return res.status(404).json({ error: error || `Task "${body.linked_task}" not found` });
          if (task.status === 'done') {
            return res.status(409).json({ error: 'linked_task_terminal', task_status: task.status });
          }
          linkedTaskId = task.id;
          linkedTaskRow = task;
        }

        // interval: default 15m
        let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
        if (body.interval !== undefined) {
          const parsed = parseDurationSeconds(body.interval);
          if (parsed === null) {
            return res.status(400).json({ error: 'invalid_interval' });
          }
          intervalSeconds = parsed;
        }

        // priority: default normal
        let priority: 'low' | 'normal' | 'high' = 'normal';
        if (body.priority !== undefined) {
          if (!isValidPriority(body.priority)) {
            return res.status(400).json({ error: 'invalid_priority' });
          }
          priority = body.priority;
        }

        // close_when: default { task_status: ['done'] }
        let closeWhen = DEFAULT_CLOSE_WHEN;
        if (body.close_when !== undefined) {
          if (!body.close_when || typeof body.close_when !== 'object' || Array.isArray(body.close_when)) {
            return res.status(400).json({ error: 'invalid_close_when' });
          }
          closeWhen = body.close_when as Record<string, unknown>;
        }

        // max_iterations: optional positive int
        let maxIterations: number | null = null;
        if (body.max_iterations !== undefined && body.max_iterations !== null) {
          const n = Number(body.max_iterations);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_max_iterations' });
          }
          maxIterations = n;
        }

        // ttl: optional duration → ttl_expires_at = now + ttl
        let ttlExpiresAt: number | null = null;
        const nowMs = Date.now();
        if (body.ttl !== undefined && body.ttl !== null) {
          const ttl = parseDurationSeconds(body.ttl);
          if (ttl === null) {
            return res.status(400).json({ error: 'invalid_ttl' });
          }
          ttlExpiresAt = nowMs + ttl * 1000;
        }

        // snooze_until: explicit unix-ms cursor. Mutually exclusive with the
        // computed initial next_fire_at.
        let snoozeUntil: number | null = null;
        let initialStatus: 'active' | 'snoozed' = 'active';
        let nextFireAt: number | null = nowMs + intervalSeconds * 1000;
        if (body.snooze_until !== undefined && body.snooze_until !== null) {
          const n = Number(body.snooze_until);
          if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_snooze_until' });
          }
          snoozeUntil = n;
          nextFireAt = n;
          initialStatus = 'snoozed';
        }

        const note = clampNote(body.note);

        const row: CheckinRow = {
          id: generateCheckinId(nowMs),
          team_id: teamId,
          owner_agent_id: ownerAgentId,
          created_by_agent_id: ownerAgentId,
          linked_task_id: linkedTaskId,
          interval_seconds: intervalSeconds,
          priority,
          status: initialStatus,
          close_when: closeWhen,
          max_iterations: maxIterations,
          iteration_count: 0,
          next_fire_at: nextFireAt,
          snooze_until: snoozeUntil,
          ttl_expires_at: ttlExpiresAt,
          last_fire_at: null,
          last_event_seq: null,
          note,
          created_at: nowMs,
          updated_at: nowMs,
          closed_at: null,
          closed_reason: null,
        };

        try {
          await this.db.checkins.create(row);
        } catch (err: any) {
          if (typeof err?.message === 'string' && err.message.includes('different team')) {
            return res.status(409).json({ error: 'cross_team_linked_task' });
          }
          throw err;
        }

        const linkedTask = linkedTaskRow
          ? await this.buildTaskResult(linkedTaskRow, teamId)
          : null;
        res.status(201).json({
          ok: true,
          checkin: buildCheckinResponse(row, { ownerName, linkedTask }),
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/checkins', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const q = req.query as Record<string, string | undefined>;

        let ownerAgentId: string | undefined;
        if (q.owner) {
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, q.owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${q.owner}" not found` });
          ownerAgentId = agent.id;
        }

        let linkedTaskId: string | undefined;
        if (q.linked_task) {
          const { task, error } = await this.resolveTaskRef(q.linked_task, teamId);
          if (!task) return res.status(404).json({ error: error || `Task "${q.linked_task}" not found` });
          linkedTaskId = task.id;
        }

        const statusFilter = parseStatusFilter(q.status);
        if (statusFilter === null) {
          return res.status(400).json({ error: 'invalid_status' });
        }

        let dueBefore: number | undefined;
        if (q.due_before !== undefined) {
          const n = Number(q.due_before);
          if (!Number.isFinite(n) || n < 0) {
            return res.status(400).json({ error: 'invalid_due_before' });
          }
          dueBefore = n;
        }

        let limit: number | undefined;
        if (q.limit !== undefined) {
          const n = Number(q.limit);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_limit' });
          }
          limit = n;
        }

        const rows = await this.db.checkins.list({
          teamId,
          owner: ownerAgentId,
          linkedTaskId,
          status: statusFilter.length > 0 ? statusFilter : undefined,
          dueBefore,
          limit,
        });

        // Resolve owner names so GET returns the same `owner` shape as POST.
        // Cache lookups across rows since the same owner often recurs.
        const ownerNameCache = new Map<string, string | null>();
        const resolveOwnerName = async (agentId: string | null): Promise<string | null> => {
          if (!agentId) return null;
          if (ownerNameCache.has(agentId)) return ownerNameCache.get(agentId)!;
          const agent = await this.db.agents.getById(agentId).catch(() => null);
          const name = agent ? ((agent.metadata as any)?.alias || agent.name) : null;
          ownerNameCache.set(agentId, name);
          return name;
        };
        // Resolve each checkin's linked task → { title, owner, status } so the
        // response is self-describing (the UI can show WHAT is being supervised
        // instead of a raw task/checkin id). One task list per request, mapped by id.
        const allTasks = await this.db.tasks.list({ teamId }).catch(() => [] as TaskRow[]);
        const taskById = new Map(allTasks.map((t) => [t.id, t]));
        const linkedTaskOf = async (taskId: string | null): Promise<Record<string, unknown> | null> => {
          if (!taskId) return null;
          const t = taskById.get(taskId);
          if (!t) return { id: taskId, gone: true };
          return { name: t.name, title: t.title, status: t.status, owner: await resolveOwnerName(t.owner) };
        };
        const checkins = await Promise.all(
          rows.map(async (row) => buildCheckinResponse(row, {
            ownerName: await resolveOwnerName(row.owner_agent_id),
            linkedTask: await linkedTaskOf(row.linked_task_id),
          })),
        );
        res.json({ ok: true, checkins });
      } catch (err: any) {
        console.error('[Manager] Error in GET /checkins:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.delete('/checkins/:id', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const principal = (req as any).ctx?.principal || 'anon';
        if (principal !== 'admin') {
          return res.status(403).json({ error: 'admin_required' });
        }
        const removed = await this.db.checkins.delete(req.params.id, teamId);
        if (!removed) return res.status(404).json({ error: 'checkin_not_found' });
        res.json({ ok: true, removed: req.params.id });
      } catch (err: any) {
        console.error('[Manager] Error in DELETE /checkins/:id:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/checkins/:id/close', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const reason =
          typeof req.body?.reason === 'string' && req.body.reason.length > 0
            ? req.body.reason
            : 'manual';
        const closedAt = Date.now();

        const transitioned = await this.db.checkins.close(req.params.id, teamId, closedAt, reason);
        const row = await this.db.checkins.get(req.params.id, teamId);
        if (!row) return res.status(404).json({ error: 'checkin_not_found' });

        const ownerName = await this.resolveAgentNameById(row.owner_agent_id);
        res.json({
          ok: true,
          alreadyClosed: !transitioned,
          checkin: buildCheckinResponse(row, { ownerName }),
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins/:id/close:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/checkins/:id/snooze', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const body = req.body || {};
        if (body.duration === undefined || body.duration === null) {
          return res.status(400).json({ error: 'missing_duration' });
        }
        const seconds = parseDurationSeconds(body.duration);
        if (seconds === null) {
          return res.status(400).json({ error: 'invalid_duration' });
        }

        const existing = await this.db.checkins.get(req.params.id, teamId);
        if (!existing) return res.status(404).json({ error: 'checkin_not_found' });
        if (existing.status === 'closed' || existing.status === 'expired') {
          return res.status(409).json({ error: 'checkin_terminal' });
        }

        const nowMs = Date.now();
        const snoozeUntil = nowMs + seconds * 1000;
        await this.db.checkins.updateFields(req.params.id, teamId, {
          status: 'snoozed',
          snooze_until: snoozeUntil,
          next_fire_at: snoozeUntil,
          updated_at: nowMs,
        });
        const row = await this.db.checkins.get(req.params.id, teamId);
        const ownerName = await this.resolveAgentNameById(row!.owner_agent_id);
        res.json({ ok: true, checkin: buildCheckinResponse(row!, { ownerName }) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins/:id/snooze:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

  }

  /**
   * Resolve an agent's display name (alias or `agents.name`) from its id, or
   * `null` if the row is missing. Swallows errors so a transient lookup
   * failure does not break the response envelope.
   */
  private async resolveAgentNameById(agentId: string | null): Promise<string | null> {
    if (!agentId) return null;
    const agent = await this.db.agents.getById(agentId).catch(() => null);
    if (!agent) return null;
    return (agent.metadata as any)?.alias || agent.name;
  }

  /**
   * Probe a list of agents by enqueueing a tiny `/talk` query and then
   * waiting for that query to reach a terminal state on `/query/:id`.
   * This is intentionally end-to-end: a 202 Accepted from `/talk` alone
   * is not enough because the harness can still fail later (for example,
   * when the underlying CLI returns an auth error on every dispatch).
   */
  private async probeAgentsViaTalk(
    teamName: string,
    agents: AgentRow[],
  ): Promise<{
    ok: true;
    result: {
      team: string;
      probed: number;
      passed: number;
      failed: number;
      results: Array<
        { name: string; status: 'ok'; duration_ms: number }
        | { name: string; status: 'failed'; error: string; duration_ms: number }
      >;
    };
  }> {
    const PER_AGENT_TIMEOUT_MS = 30_000;
    const CONCURRENCY = 8;
    const POLL_INTERVAL_MS = 200;

    type ProbeResult =
      | { name: string; status: 'ok'; duration_ms: number }
      | { name: string; status: 'failed'; error: string; duration_ms: number };

    const toErrorString = (status: number, bodyText: string): string => (
      bodyText ? `${status}: ${bodyText}` : `${status}`
    );
    const parseJson = (raw: string): any | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const probeOne = async (agent: AgentRow): Promise<ProbeResult> => {
      const start = Date.now();
      const base = (agent.endpoint || (agent.port ? `http://localhost:${agent.port}` : '')).replace(/\/+$/, '');
      const displayName = (agent.metadata as any)?.alias || agent.name;
      if (!base) {
        return { name: displayName, status: 'failed', error: 'no_endpoint', duration_ms: Date.now() - start };
      }

      const deadline = start + PER_AGENT_TIMEOUT_MS;
      const remainingMs = () => Math.max(0, deadline - Date.now());
      const talkUrl = `${base}/talk`;

      try {
        const talkResp = await fetch(talkUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'reply with OK', from: 'probe' }),
          signal: AbortSignal.timeout(Math.max(1, remainingMs())),
        });

        // Parse the full body so /query/:id responses (which can exceed 200
        // chars once result.messages[] / sessionId / timestamps are included)
        // round-trip cleanly. Only truncate when surfacing the body in an
        // error string.
        const talkText = await talkResp.text().catch(() => '');
        const talkBody = parseJson(talkText);

        if (!talkResp.ok) {
          let bodyText = '';
          if (talkBody && typeof talkBody === 'object' && typeof talkBody.error === 'string') {
            bodyText = talkBody.error;
          } else {
            bodyText = talkText.slice(0, 200);
          }
          return {
            name: displayName,
            status: 'failed',
            error: toErrorString(talkResp.status, bodyText),
            duration_ms: Date.now() - start,
          };
        }

        const queryId = talkBody?.query_id || talkBody?.queryId;
        if (!queryId) {
          const bodyText = typeof talkBody?.message === 'string'
            ? talkBody.message
            : talkText.slice(0, 200);
          if (bodyText) {
            return { name: displayName, status: 'ok', duration_ms: Date.now() - start };
          }
          return {
            name: displayName,
            status: 'failed',
            error: 'missing query_id from /talk response',
            duration_ms: Date.now() - start,
          };
        }

        const queryUrl = `${base}/query/${encodeURIComponent(String(queryId))}`;
        while (remainingMs() > 0) {
          const queryResp = await fetch(queryUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs(), 1_000))),
          });

          const queryText = await queryResp.text().catch(() => '');
          const queryBody = parseJson(queryText);

          if (!queryResp.ok) {
            const bodyText = typeof queryBody?.error === 'string'
              ? queryBody.error
              : queryText.slice(0, 200);
            return {
              name: displayName,
              status: 'failed',
              error: toErrorString(queryResp.status, bodyText),
              duration_ms: Date.now() - start,
            };
          }

          const queryStatus = queryBody?.status;
          if (queryStatus === 'completed') {
            return { name: displayName, status: 'ok', duration_ms: Date.now() - start };
          }
          if (queryStatus === 'failed') {
            const error = typeof queryBody?.error === 'string' && queryBody.error.trim()
              ? queryBody.error
              : 'query failed';
            return { name: displayName, status: 'failed', error, duration_ms: Date.now() - start };
          }

          await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingMs())));
        }

        return { name: displayName, status: 'failed', error: 'timeout', duration_ms: Date.now() - start };
      } catch (err: any) {
        const duration_ms = Date.now() - start;
        const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
        const error = isTimeout ? 'timeout' : (err?.message ? String(err.message) : String(err));
        return { name: displayName, status: 'failed', error, duration_ms };
      }
    };

    const results: ProbeResult[] = new Array(agents.length);
    let next = 0;
    const workerCount = Math.min(CONCURRENCY, agents.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= agents.length) return;
        results[idx] = await probeOne(agents[idx]);
      }
    });
    await Promise.all(workers);

    const passed = results.filter((r) => r.status === 'ok').length;
    return {
      ok: true,
      result: {
        team: teamName,
        probed: results.length,
        passed,
        failed: results.length - passed,
        results,
      },
    };
  }

  private async resolveSingleAgentForCommand(teamId: string, agentName: string): Promise<{ agent?: AgentRow; error?: string }> {
    const matches = await this.dbResolveAgents(teamId, agentName);
    if (matches.length === 0) {
      return { error: `Agent "${agentName}" not found` };
    }
    if (matches.length > 1) {
      return { error: `Multiple agents match "${agentName}". Be more specific.` };
    }
    return { agent: matches[0] };
  }

  private async buildTaskResult(task: TaskRow, teamId: string): Promise<Record<string, unknown>> {
    let ownerName: string | null = null;
    let ownerAgent: AgentRow | null = null;
    if (task.owner) {
      ownerAgent = await this.db.agents.getById(task.owner);
      if (ownerAgent) {
        ownerName = (ownerAgent.metadata as any)?.alias || ownerAgent.name;
      }
    }

    let teamName: string | null = null;
    if (task.team_id) {
      const teamRow = await this.db.teams.getTeam(task.team_id);
      if (teamRow) teamName = teamRow.name;
    }

    const links = await this.db.tasks.listEventLinksForTask(task.id);
    const shortId = task.uuid ? `#${task.uuid.replace(/-/g, '').slice(0, 8)}` : null;
    const delegationAudit = await this.buildDelegationAudit(task, teamId, teamName, ownerAgent);

    return {
      name: task.name,
      uuid: task.uuid,
      shortId,
      title: task.title,
      description: task.description,
      status: task.status,
      ownerName,
      teamName,
      linkedEvents: links.map(l => l.schedule_id),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.completed_at,
      ...(delegationAudit ? { delegationAudit } : {}),
    };
  }

  /**
   * Resolve a task reference scoped to a team. Accepts either:
   *   - the kebab-case `name` slug (existing behavior), or
   *   - a short-uuid handle `#xxxxxxxx` (8+ hex chars after the `#`).
   *
   * Short refs match on the dash-stripped uuid prefix. If multiple rows
   * share the prefix (within the team), returns an `error` asking the caller
   * to widen it.
   *
   * @param ref   The task reference string.
   * @param teamId  The team scope. Required for name-based resolution.
   */
  private async resolveTaskRef(ref: string, teamId?: string): Promise<{ task?: TaskRow; error?: string }> {
    if (!ref || typeof ref !== 'string') {
      return { error: 'Task reference is required' };
    }
    if (ref.startsWith('#')) {
      const raw = ref.slice(1).toLowerCase();
      if (!/^[0-9a-f]+$/.test(raw) || raw.length < 4) {
        return { error: `Invalid short id "${ref}". Expected #<hex prefix>` };
      }
      // uuids are stored with dashes; the short form strips dashes for
      // display, so match on either form by trying the first 8 hex chars
      // against the leading hex chunk (uuid v4: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
      const matches = await this.db.tasks.getByUuidPrefix(raw.slice(0, 8));
      const filtered = matches.filter(t => {
        if (!(t.uuid || '').replace(/-/g, '').toLowerCase().startsWith(raw)) return false;
        // When teamId is provided, scope to that team
        if (teamId && t.team_id !== teamId) return false;
        return true;
      });
      if (filtered.length === 0) return { error: `Task ${ref} not found` };
      if (filtered.length > 1) {
        const widened = filtered
          .map(t => `#${(t.uuid || '').replace(/-/g, '').slice(0, raw.length + 2)} (${t.name})`)
          .join(', ');
        return { error: `Short id ${ref} is ambiguous (matches ${filtered.length}): ${widened}. Widen the prefix.` };
      }
      return { task: filtered[0] };
    }
    // Name-based resolution: scope to the team when teamId is provided
    if (teamId) {
      const task = await this.db.tasks.getByNameForTeam(ref, teamId);
      if (!task) return { error: `Task "${ref}" not found` };
      return { task };
    }
    const task = await this.db.tasks.getByName(ref);
    if (!task) return { error: `Task "${ref}" not found` };
    return { task };
  }

  private async listTeamSchedules(teamId: string): Promise<Array<{ definition: ScheduleDefinitionRow; targets: AgentRow[] }>> {
    const teamAgents = await this.dbListAgents(teamId, true);
    const agentsById = new Map(teamAgents.map((agent) => [agent.id, agent]));
    const definitions = await this.db.schedules.listAllDefinitions();
    const schedules: Array<{ definition: ScheduleDefinitionRow; targets: AgentRow[] }> = [];

    for (const definition of definitions) {
      const targetIds = await this.db.schedules.listTargets(definition.id);
      const targets = targetIds
        .map((targetId) => agentsById.get(targetId))
        .filter((target): target is AgentRow => Boolean(target));

      if (targets.length > 0) {
        schedules.push({ definition, targets });
      }
    }

    return schedules;
  }

  private async getTeamScheduleById(teamId: string, scheduleId: string): Promise<{ definition: ScheduleDefinitionRow; targets: AgentRow[] } | null> {
    const definition = await this.db.schedules.getDefinition(scheduleId);
    if (!definition) return null;

    const teamAgents = await this.dbListAgents(teamId, true);
    const agentsById = new Map(teamAgents.map((agent) => [agent.id, agent]));
    const targets = (await this.db.schedules.listTargets(scheduleId))
      .map((targetId) => agentsById.get(targetId))
      .filter((target): target is AgentRow => Boolean(target));

    if (targets.length === 0) return null;
    return { definition, targets };
  }

  private async deleteEmptyTeamByName(
    name: string,
  ): Promise<{ ok: true; result: { success: true; name: string; message: string } } | { ok: false; status: number; error: string }> {
    if (name === 'default') {
      return {
        ok: false,
        status: 400,
        error: 'Cannot delete the "default" team — it is the fallback for all unscoped requests',
      };
    }

    const team = await this.db.teams.getTeamByName(name);
    if (!team) {
      return { ok: false, status: 404, error: `Team "${name}" not found` };
    }

    // NB: no `::text` cast — that's Postgres-only and breaks on SQLite.
    // COUNT(*) returns a number on both backends; parseInt tolerates both.
    const countResult = await this.db.adapter.query<{ count: string | number }>(
      'SELECT COUNT(*) as count FROM agents WHERE team_id = $1 AND deleted_at IS NULL',
      [team.id],
    );
    const agentCount = parseInt(String(countResult.rows[0]?.count ?? '0'));

    if (agentCount > 0) {
      return {
        ok: false,
        status: 400,
        error: `Team "${name}" still has ${agentCount} agent(s). Run /delete --team ${name} first to remove agents, then /team delete ${name} to remove the team.`,
      };
    }

    await this.db.teams.deleteTeam(team.id);
    return {
      ok: true,
      result: { success: true, name, message: `Team "${name}" deleted` },
    };
  }

  /**
   * Execute a CLI-style command and return the result
   */
  private async executeRemoteCommand(
    command: string,
    teamId: string,
    teamName: string,
    callerFrom?: string,
    callerSessionId?: string,
  ): Promise<{ ok: boolean; result?: any; error?: string }> {
    // Remove leading slash if present
    const cmd = command.startsWith('/') ? command.slice(1) : command;
    const parts = tokenizeCommand(cmd);
    const action = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (action) {
      case 'agents': {
        const sub = args[0]?.toLowerCase();
        if (sub === 'probe') {
          // Probe every running agent's /talk dispatch path. Non-running
          // rows are skipped (an offline/stopped agent is expected to
          // fail; including it would skew passed/failed counts toward
          // noise the operator already knows about). For a deliberately
          // selected single agent, see `/agent <name> probe` which does
          // not skip.
          const all = await this.dbListAgents(teamId);
          const running = all.filter((a) => a.status === 'running');
          return this.probeAgentsViaTalk(teamName, running);
        }
        if (sub === 'park-idle') {
          const confirmed = args.includes('--confirm');
          const allTeams = args.includes('--all-teams');
          const includeDefault = args.includes('--include-default');
          const includeLeads = args.includes('--include-leads');
          const includeScheduled = args.includes('--include-scheduled');
          return this.parkIdleAgents({
            teamId,
            teamName,
            confirmed,
            allTeams,
            includeDefault,
            includeLeads,
            includeScheduled,
          });
        }
        if (sub === 'rebuild') {
          if (!args.includes('--confirm')) {
            return { ok: false, error: 'Usage: /agents rebuild --confirm' };
          }

          const agents = await this.dbListAgents(teamId);
          const results: Array<{ name: string; status: 'rebuilt' | 'skipped' | 'failed'; reason: string }> = [];

          for (const agent of agents) {
            if (isRemoteEndpointRuntime(agent.runtime)) {
              results.push({ name: agent.name, status: 'skipped', reason: 'lifecycle_not_supported_for_remote' });
              continue;
            }
            if (agent.type !== 'claude') {
              results.push({ name: agent.name, status: 'skipped', reason: 'only_claude_agents_can_be_rebuilt' });
              continue;
            }

            try {
              const spawnResult = await this.rebuildLocalClaudeAgent(teamId, teamName, agent);
              if (spawnResult.success) {
                results.push({ name: agent.name, status: 'rebuilt', reason: 'rebuilt' });
              } else {
                results.push({ name: agent.name, status: 'failed', reason: spawnResult.error || 'spawn_failed' });
              }
            } catch (err: any) {
              results.push({ name: agent.name, status: 'failed', reason: err?.message || String(err) });
            }
          }

          return {
            ok: true,
            result: {
              action: 'agents-rebuild',
              rebuilt: results.filter(r => r.status === 'rebuilt').length,
              skipped: results.filter(r => r.status === 'skipped').length,
              failed: results.filter(r => r.status === 'failed').length,
              agents: results
            }
          };
        }
        const agents = await this.dbListAgents(teamId);
        return {
          ok: true,
          result: {
            agents: agents.map(a => ({
              name: a.name,
              id: a.id,
              type: a.type,
              status: a.status,
              model: a.model,
              port: a.port,
              url: a.endpoint || (a.port ? `http://localhost:${a.port}` : null)
            }))
          }
        };
      }

      case 'status': {
        const agents = await this.dbListAgents(teamId);
        const running = agents.filter(a => a.status === 'running').length;
        const offline = agents.filter(a => a.status === 'offline').length;
        const agentHealth = agents.map(a => {
          const h = this.getHealthForAgent(a);
          const alias = (a.metadata as any)?.alias || normalizeAlias(a.name);
          return { name: alias, status: a.status, health: h.health, lastHealthCheck: h.lastHealthCheck };
        });
        return {
          ok: true,
          result: {
            team: teamName,
            totalAgents: agents.length,
            runningAgents: running,
            offlineAgents: offline,
            agents: agentHealth,
            status: 'ok'
          }
        };
      }

      case 'schedule': {
        if (!this.schedulerService) {
          return { ok: false, error: 'Scheduler service is not running' };
        }

        const subCmd = args[0]?.toLowerCase() || 'list';

        if (subCmd === 'list') {
          const schedules = await this.listTeamSchedules(teamId);
          // Enrich with the most recent run so the UI can flag missed heartbeats.
          const enriched = await Promise.all(
            schedules.map(async ({ definition, targets }) => {
              const runs = await this.db.schedules.listRuns(definition.id, 1);
              const last = runs[0];
              return {
                id: definition.id,
                title: definition.title,
                kind: definition.kind,
                active: definition.active,
                deliveryMode: definition.delivery_mode,
                sourceType: definition.source_type,
                targets: targets.map((target) => target.name),
                intervalSeconds: definition.interval_seconds,
                timezone: definition.timezone,
                localTimeSeconds: definition.local_time_seconds,
                localDate: definition.local_date,
                daysOfWeek: definition.days_of_week,
                message: definition.message,
                createdAt: definition.created_at,
                lastRunAt: last?.fired_at ?? null,
                lastStatus: last?.status ?? null,
              };
            }),
          );
          return { ok: true, result: { schedules: enriched } };
        }

        if (subCmd === 'show') {
          const scheduleId = args[1];
          if (!scheduleId) {
            return { ok: false, error: 'Usage: /schedule show <id>' };
          }

          const schedule = await this.getTeamScheduleById(teamId, scheduleId);
          if (!schedule) {
            return { ok: false, error: `Schedule "${scheduleId}" not found` };
          }

          const runs = await this.db.schedules.listRuns(scheduleId, 10);
          return {
            ok: true,
            result: {
              schedule: {
                ...schedule.definition,
                targets: schedule.targets.map((target) => ({
                  id: target.id,
                  name: target.name,
                  status: target.status,
                })),
                recentRuns: runs,
              },
            },
          };
        }

        if (subCmd === 'pause' || subCmd === 'resume' || subCmd === 'remove') {
          const scheduleId = args[1];
          if (!scheduleId) {
            return { ok: false, error: `Usage: /schedule ${subCmd} <id>` };
          }

          const schedule = await this.getTeamScheduleById(teamId, scheduleId);
          if (!schedule) {
            return { ok: false, error: `Schedule "${scheduleId}" not found` };
          }

          if (subCmd === 'remove') {
            await this.db.schedules.deleteDefinition(scheduleId);
            return { ok: true, result: { removed: scheduleId } };
          }

          const active = subCmd === 'resume';
          await this.db.schedules.setActive(scheduleId, active);
          return { ok: true, result: { id: scheduleId, active } };
        }

        if (subCmd === 'add') {
          const kind = args[1]?.toLowerCase();
          if (kind !== 'heartbeat' && kind !== 'calendar') {
            return { ok: false, error: 'Usage: /schedule add <heartbeat|calendar> ...' };
          }

          const rawArgs = args.slice(2);
          let delivery: ScheduleDeliveryMode = kind === 'heartbeat' ? 'internal' : 'talk';
          let timezone: string | undefined;
          let sender: string | undefined;
          const positionals: string[] = [];

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--delivery') {
              const value = rawArgs[i + 1];
              if (value !== 'talk' && value !== 'internal') {
                return { ok: false, error: 'Invalid --delivery value. Use talk or internal.' };
              }
              delivery = value;
              i++;
              continue;
            }
            if (token === '--timezone') {
              timezone = rawArgs[i + 1];
              if (!timezone) {
                return { ok: false, error: 'Missing value for --timezone' };
              }
              i++;
              continue;
            }
            if (token === '--sender') {
              sender = rawArgs[i + 1];
              if (!sender) {
                return { ok: false, error: 'Missing value for --sender' };
              }
              i++;
              continue;
            }
            positionals.push(token);
          }

          if (kind === 'heartbeat') {
            const [agentName, secondsRaw, ...messageParts] = positionals;
            const message = messageParts.join(' ').trim();

            if (!agentName || !secondsRaw || !message) {
              return {
                ok: false,
                error: 'Usage: /schedule add heartbeat <agent> <seconds> <message> [--delivery internal|talk]',
              };
            }

            const { agent, error } = await this.resolveSingleAgentForCommand(teamId, agentName);
            if (!agent) return { ok: false, error };

            const seconds = Number(secondsRaw);
            if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
              return { ok: false, error: `Invalid interval: ${secondsRaw}` };
            }
            try {
              validateIntervalSeconds(seconds);
            } catch (err: any) {
              return { ok: false, error: err.message };
            }

            const nowSec = Math.floor(Date.now() / 1000);
            const scheduleId = `sch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const definition: ScheduleDefinitionRow = {
              id: scheduleId,
              kind: 'heartbeat',
              title: `Interval: ${agent.name}`,
              description: null,
              active: true,
              message,
              delivery_mode: delivery,
              timezone: null,
              catch_up_policy: 'fire_once',
              dedupe_window_seconds: 90,
              interval_seconds: seconds,
              anchor_at: nowSec,
              max_runs: null,
              expires_at: null,
              local_time_seconds: null,
              local_date: null,
              days_of_week: null,
              source_type: 'cli',
              source_key: `cli:${teamId}:${scheduleId}`,
              sender: sender ?? 'schedule',
              created_at: nowSec,
              updated_at: nowSec,
            };

            await this.schedulerService.seedSchedule(definition, [agent.id]);
            return {
              ok: true,
              result: {
                schedule: {
                  id: definition.id,
                  kind: definition.kind,
                  target: agent.name,
                  intervalSeconds: seconds,
                  deliveryMode: delivery,
                },
              },
            };
          }

          const [agentName, time, recurrence, ...messageParts] = positionals;
          const message = messageParts.join(' ').trim();
          if (!agentName || !time || !recurrence || !message) {
            return {
              ok: false,
              error: 'Usage: /schedule add calendar <agent> <time> <days|date> <message> [--timezone TZ] [--delivery internal|talk]',
            };
          }

          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, agentName);
          if (!agent) return { ok: false, error };

          const scheduleKey = `cli:${teamId}:${Date.now()}:${Math.random().toString(36).substring(2, 9)}`;
          const isDate = /^\d{4}-\d{2}-\d{2}$/.test(recurrence);
          const spec: CalendarSpec = {
            title: `Calendar: ${agent.name}`,
            time,
            timezone,
            agents: [agent.name],
            message,
            delivery,
            ...(isDate ? { date: recurrence } : { days: recurrence.split(',').map((day) => day.trim()).filter(Boolean) }),
          };

          let definition: ScheduleDefinitionRow;
          try {
            ({ definition } = calendarToSchedule(spec, scheduleKey, [agent.id]));
          } catch (err: any) {
            return { ok: false, error: err.message };
          }
          definition.source_type = 'cli';
          definition.source_key = scheduleKey;
          definition.sender = sender ?? 'schedule';
          await this.schedulerService.seedSchedule(definition, [agent.id]);

          return {
            ok: true,
            result: {
              schedule: {
                id: definition.id,
                kind: definition.kind,
                target: agent.name,
                time,
                recurrence,
                timezone: definition.timezone,
                deliveryMode: delivery,
              },
            },
          };
        }

        return {
          ok: false,
          error: 'Usage: /schedule <list|show|add|pause|resume|remove> ...'
        };
      }

      case 'heartbeat': {
        // /heartbeat <agent> - show heartbeat status for specific agent
        // /heartbeat enable <agent> - enable heartbeat for agent
        // /heartbeat disable <agent> - disable heartbeat for agent
        const subCmd = args[0];

        // Handle enable/disable subcommands
        if (subCmd === 'enable' || subCmd === 'disable') {
          const agentName = args[1];
          if (!agentName) {
            return { ok: false, error: `Usage: /heartbeat ${subCmd} <agent>` };
          }
          const matches = await this.dbResolveAgents(teamId, agentName);
          if (matches.length === 0) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          if (matches.length > 1) {
            return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
          }
          const agent = matches[0];

          if (subCmd === 'enable') {
            if (!agent.working_directory) {
              return { ok: false, error: `Agent "${agent.name}" has no working directory` };
            }
            const config = this.readHeartbeatConfig(agent.working_directory);
            if (!config) {
              return { ok: false, error: `Agent "${agent.name}" has no HEARTBEAT.yaml or HEARTBEAT.md in working directory` };
            }
            const newMetadata = { ...agent.metadata, heartbeat: true };
            await this.db.agents.updateMetadata(agent.id, newMetadata);
            if (this.schedulerService) {
              const { definition, agentIds } = heartbeatToSchedule(agent.id, agent.name, config);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }
            return { ok: true, result: { message: `Heartbeat enabled for ${agent.name} (interval: ${config.interval}s)` } };
          } else {
            // Disable heartbeat
            const newMetadata = { ...agent.metadata, heartbeat: false };
            await this.db.agents.updateMetadata(agent.id, newMetadata);
            if (this.schedulerService) {
              await this.schedulerService.removeAgentSchedules(agent.id);
            }
            return { ok: true, result: { message: `Heartbeat disabled for ${agent.name}` } };
          }
        }

        const agentName = subCmd; // First arg is the agent name for status query

        if (agentName) {
          const matches = await this.dbResolveAgents(teamId, agentName);
          if (matches.length === 0) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          if (matches.length > 1) {
            return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
          }
          const agent = matches[0];
          if (agent.metadata?.heartbeat !== true) {
            return { ok: false, error: `Agent "${agent.name}" does not have heartbeat enabled. Use /heartbeat enable ${agent.name}` };
          }
          if (!agent.working_directory) {
            return { ok: false, error: `Agent "${agent.name}" has no working directory` };
          }
          const config = this.readHeartbeatConfig(agent.working_directory);
          const schedules = await this.db.schedules.listSchedulesForAgent(agent.id);
          const hbSchedule = schedules.find(s => s.source_key === `heartbeat:${agent.id}`);
          const runCount = hbSchedule ? await this.db.schedules.countRuns(hbSchedule.id, agent.id) : 0;
          return {
            ok: true,
            result: {
              agent: {
                name: agent.name,
                id: agent.id,
                status: agent.status,
                scheduleActive: hbSchedule?.active ?? false,
                intervalSeconds: hbSchedule?.interval_seconds || config?.interval || 'no file',
                runsSent: runCount,
                maxRuns: hbSchedule?.max_runs ?? config?.maxBeats ?? 20,
                expiresAt: hbSchedule?.expires_at ?? null
              }
            }
          };
        }

        // No argument - show usage
        return { ok: false, error: 'Usage: /heartbeat <agent> or /heartbeats (to show all)' };
      }

      case 'heartbeats': {
        // /heartbeats - show all agents with heartbeat enabled
        const heartbeatAgents = await this.db.agents.findHeartbeat(teamId);
        const agentResults = [];
        for (const a of heartbeatAgents) {
          const schedules = await this.db.schedules.listSchedulesForAgent(a.id);
          const hbSchedule = schedules.find(s => s.source_key === `heartbeat:${a.id}`);
          const runCount = hbSchedule ? await this.db.schedules.countRuns(hbSchedule.id, a.id) : 0;
          const config = a.working_directory ? this.readHeartbeatConfig(a.working_directory) : null;
          agentResults.push({
            name: a.name,
            id: a.id,
            status: a.status,
            scheduleActive: hbSchedule?.active ?? false,
            intervalSeconds: hbSchedule?.interval_seconds || config?.interval || 'no file',
            runsSent: runCount,
            maxRuns: hbSchedule?.max_runs ?? config?.maxBeats ?? 20,
            expiresAt: hbSchedule?.expires_at ?? null
          });
        }
        return {
          ok: true,
          result: {
            agents: agentResults
          }
        };
      }

      case 'delete': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /delete <agent-name|agent-id> | /delete * | /delete --team <name>' };
        }

        // Bulk delete: /delete * (current team) or /delete --team <name>
        if (agentName === '*' || agentName === '--team') {
          let bulkTeamId = teamId;
          let bulkTeamName = 'current';
          let shouldDeleteTeamRow = false;
          if (agentName === '--team') {
            const targetTeam = args[1];
            if (!targetTeam) {
              return { ok: false, error: 'Usage: /delete --team <team-name>' };
            }
            if (!/^[a-zA-Z0-9_.-]+$/.test(targetTeam)) {
              return { ok: false, error: `Invalid team name: "${targetTeam}"` };
            }
            bulkTeamId = await this.db.teams.getOrCreateTeamId(targetTeam);
            bulkTeamName = targetTeam;
            shouldDeleteTeamRow = targetTeam !== 'default';
          }

          const agents = await this.dbListAgents(bulkTeamId, true);
          if (agents.length === 0 && !shouldDeleteTeamRow) {
            return { ok: true, result: { deleted: [], count: 0, team: bulkTeamName, message: 'No agents to delete' } };
          }

          const deletedNames: string[] = [];
          for (const agent of agents) {
            const serverKey = this.key(bulkTeamId, agent.id);
            const server = this.runningServers.get(serverKey);
            if (server) {
              await server.stop();
              this.runningServers.delete(serverKey);
            }
            if (agent.port) {
              await this.killAgentProcess(agent.port);
            }
            if (this.schedulerService) {
              await this.schedulerService.removeAgentSchedules(agent.id);
            }
            await this.cancelPendingQueriesForAgent(bulkTeamId, agent.id);
            const deleted = await this.dbDeleteAgentRow(bulkTeamId, agent.id);
            if (!deleted) {
              return { ok: false, error: `Failed to delete agent "${agent.name || agent.id}"` };
            }
            deletedNames.push(agent.name || agent.id);
          }

          if (deletedNames.length) {
            this.broadcastAgentsChanged(bulkTeamId, { reason: 'remove', removed: deletedNames });
          }

          let teamDeleted = false;
          if (shouldDeleteTeamRow) {
            const deletedTeam = await this.deleteEmptyTeamByName(bulkTeamName);
            if (!deletedTeam.ok) {
              return { ok: false, error: deletedTeam.error };
            }
            teamDeleted = true;
          }

          return {
            ok: true,
            result: {
              deleted: deletedNames,
              count: deletedNames.length,
              team: bulkTeamName,
              teamDeleted,
              message: teamDeleted
                ? `Deleted ${deletedNames.length} agents and team ${bulkTeamName}${deletedNames.length ? `: ${deletedNames.join(', ')}` : ''}`
                : `Deleted ${deletedNames.length} agents: ${deletedNames.join(', ')}`
            }
          };
        }

        // Single agent delete
        const matches = await this.dbResolveAgents(teamId, agentName);

        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (matches.length > 1) {
          const matchList = matches.map(a => {
            const domain = a.domain || (a.metadata as any)?.idchain_domain;
            const displayId = domain || a.name || a.id;
            return `  - ${displayId} (${a.status})`;
          }).join('\n');
          return {
            ok: false,
            error: `Multiple agents match "${agentName}":\n${matchList}\nUse a specific identifier (e.g., ENS domain or agent_id)`
          };
        }

        const a = matches[0];
        const serverKey = this.key(teamId, a.id);
        const server = this.runningServers.get(serverKey);

        if (server) {
          await server.stop();
          this.runningServers.delete(serverKey);
        }

        if (a.port) {
          await this.killAgentProcess(a.port);
        }

        // Remove any schedules for this agent
        if (this.schedulerService) {
          await this.schedulerService.removeAgentSchedules(a.id);
        }

        // Cancel any pending queries so they don't show as orphaned
        await this.cancelPendingQueriesForAgent(teamId, a.id);

        const deleted = await this.dbDeleteAgentRow(teamId, a.id);
        if (!deleted) {
          return { ok: false, error: `Failed to delete agent "${agentName}"` };
        }

        this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [a.name || a.id] });

        return { ok: true, result: { deleted: agentName } };
      }

      case 'output': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /output <agent-name>' };
        }
        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        const agent = matches[0];
        const outputDir = path.join(agent.working_directory || '', 'output');
        if (!existsSync(outputDir)) {
          return { ok: true, result: { agent: agent.name, files: [] } };
        }
        try {
          const entries = readdirSync(outputDir, { withFileTypes: true });
          const files = entries
            .filter(e => e.isFile())
            .map(e => {
              const st = statSync(path.join(outputDir, e.name));
              return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
            });
          return { ok: true, result: { agent: agent.name, files } };
        } catch {
          return { ok: true, result: { agent: agent.name, files: [] } };
        }
      }

      case 'artifact': {
        const agentName = args[0];
        const filePath = args.slice(1).join(' ');
        if (!agentName || !filePath) {
          return { ok: false, error: 'Usage: /artifact <agent-name> <path>' };
        }
        if (filePath.includes('..') || filePath.startsWith('/')) {
          return { ok: false, error: 'Invalid path: directory traversal not allowed' };
        }
        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        const agent = matches[0];
        const fullPath = path.join(agent.working_directory || '', 'output', filePath);
        if (!existsSync(fullPath)) {
          return { ok: false, error: `File not found: ${filePath}` };
        }
        try {
          const st = statSync(fullPath);
          if (st.size > 1_048_576) {
            return { ok: false, error: `File too large (${(st.size / 1024 / 1024).toFixed(1)}MB). Max: 1MB` };
          }
          const content = readFileSync(fullPath, 'utf-8');
          return { ok: true, result: { agent: agent.name, path: filePath, content, size: st.size } };
        } catch (err: any) {
          return { ok: false, error: `Failed to read file: ${err.message}` };
        }
      }

      case 'ask':
      case 'hey': {
        const agentName = args[0];
        const message = args.slice(1).join(' ');

        if (!agentName || !message) {
          return { ok: false, error: `Usage: /${action} <agent-name|agent-id> <message>` };
        }

        // Resolve the target agent. "<team>/<agent>" delegates ACROSS teams (#9);
        // a bare ref resolves within the current team.
        let a: AgentRow;
        const slash = agentName.indexOf('/');
        if (slash > 0 && !agentName.startsWith('http')) {
          const teamPart = agentName.slice(0, slash);
          const namePart = agentName.slice(slash + 1);
          const targetTeam = await this.db.teams.getTeamByName(teamPart);
          if (!targetTeam) {
            return { ok: false, error: `Team "${teamPart}" not found (cross-team delegation)` };
          }
          // Allow-list: delegation may be restricted by `delegates_to` (array of
          // team names, or "*"). Unset ⇒ permissive. The SOURCE AGENT's own
          // policy (metadata.delegates_to) OVERRIDES the team policy when set —
          // so an individual agent can be granted (or denied) cross-team
          // delegation independently of its team's default.
          const srcCfg = await this.db.teams.getConfig(teamId).catch(() => ({} as Record<string, unknown>));
          const teamPolicy = srcCfg.delegates_to as string[] | string | undefined;
          let agentPolicy: string[] | string | undefined;
          if (callerFrom) {
            const src = await this.dbResolveAgents(teamId, callerFrom).catch(() => [] as AgentRow[]);
            if (src.length === 1) agentPolicy = (src[0].metadata as any)?.delegates_to;
          }
          const policy = agentPolicy !== undefined ? agentPolicy : teamPolicy;
          const allow = policy === '*' ? ['*'] : (Array.isArray(policy) ? policy : undefined);
          if (Array.isArray(allow) && !allow.includes('*') && !allow.includes(teamPart)) {
            const scope = agentPolicy !== undefined ? `agent "${callerFrom}"'s` : "this team's";
            return { ok: false, error: `Delegation to team "${teamPart}" is blocked by ${scope} delegates_to policy.` };
          }
          const found = await this.db.agents.getByName(targetTeam.id, namePart);
          if (!found) {
            return { ok: false, error: `Agent "${namePart}" not found in team "${teamPart}"` };
          }
          a = found;
          this.managerLog(`[delegate] ${teamId} → ${teamPart}/${namePart}`);
        } else {
          const matches = await this.dbResolveAgents(teamId, agentName);
          if (matches.length === 0) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          if (matches.length > 1) {
            const matchList = matches.map(m => {
              const domain = m.domain || (m.metadata as any)?.idchain_domain;
              const displayId = domain || m.name || m.id;
              return `  - ${displayId} (${m.status})`;
            }).join('\n');
            return {
              ok: false,
              error: `Multiple agents match "${agentName}":\n${matchList}\nUse a specific identifier (e.g., ENS domain or agent_id)`
            };
          }
          a = matches[0];
        }
        // Use endpoint if set, otherwise construct from port using localhost
        const baseEndpoint = a.endpoint || `http://localhost:${a.port}`;

        // Discover REST-AP endpoints from the agent's catalog
        const endpoints = await discoverRestAPEndpoints(baseEndpoint);
        const talkUrl = `${baseEndpoint.replace(/\/+$/, '')}${endpoints.talk}`;
        const brainContext = await this.volunteerBrainContext({
          agentId: a.id,
          text: message,
          project: teamName,
          sessionId: callerSessionId || null,
        });
        const outgoingMessage = this.withBrainContextAppendix(message, brainContext);

        // Send message to agent's /talk endpoint
        const talkHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        // Serialize local-model dispatch (#7).
        const askGate = await this.acquireLocalGate(a.runtime);
        const talkResp = await fetch(talkUrl, {
          method: 'POST',
          headers: talkHeaders,
          body: JSON.stringify(callerSessionId ? { message: outgoingMessage, from: 'remote', session_id: callerSessionId } : { message: outgoingMessage, from: 'remote' })
        });

        if (!talkResp.ok) {
          this.bindLocalGate(askGate); // dispatch failed → release now
          const err = await talkResp.text();
          return { ok: false, error: `Failed to send message: ${err}` };
        }

        const talkResult = await talkResp.json() as any;
        const askQueryId = talkResult.query_id || talkResult.queryId;
        this.bindLocalGate(askGate, askQueryId, a.name); // released when the query completes/fails
        if (askQueryId) {
          await this.db.queries.create(
            teamId,
            askQueryId,
            a.id,
            outgoingMessage,
            Date.now(),
            callerSessionId || undefined,
            undefined,
            brainContext ? { brain_context: brainContext } : null,
          );
          if (brainContext) this.queryBrainContext.set(askQueryId, brainContext);
        }
        this.bindLocalGate(askGate, askQueryId); // released when the query completes/fails
        return {
          ok: true,
          result: {
            queryId: askQueryId,
            status: 'processing',
            agent: agentName,
            ...(brainContext ? { brain_context: { cited: brainContext.cited, timelineEventId: brainContext.timelineEventId, context_package_id: brainContext.context_package_id ?? brainContext.contextPackageId, instructions: brainContext.instructions || [] } } : {}),
          }
        };
      }

      case 'news': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /news <agent-name>' };
        }

        const a = await this.db.agents.getByName(teamId, agentName);

        if (!a) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        // Interactive (manager-inbox) agents have no /news HTTP server of
        // their own — the daemon owns the inbox. Read directly from
        // news_items using the same id resolution as GET /news so reads
        // and writes converge on the same row.
        if (a.type === 'interactive') {
          const teamRow = await this.db.teams.getTeam(teamId).catch(() => null);
          const teamName = teamRow?.name ?? 'unknown';
          const managerInbox = this.getManagerInboxRef(teamId, teamName);
          const rows = await this.db.news.pollByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, 0, { limit: 100 });
          const items = rows.map((r: any) => ({
            id: Number(r.id),
            type: r.type,
            timestamp: Number(r.timestamp),
            message: r.message || undefined,
            data: r.data || undefined,
          }));
          return { ok: true, result: { items, total: items.length, timestamp: Date.now() } };
        }

        // Agents without a usable local network endpoint (virtual stubs,
        // remote-only rows that have no `port`/`endpoint` filled in) cannot
        // serve `/news` directly; skipping here avoids a catalog fetch
        // against `http://localhost:0` from the CLI's per-agent news poll.
        if (!a.port || !a.endpoint) {
          return { ok: true, result: { items: [], total: 0, timestamp: Date.now() } };
        }

        const baseEndpoint = a.endpoint;

        // Discover REST-AP endpoints from the agent's catalog
        const endpoints = await discoverRestAPEndpoints(baseEndpoint);
        const newsUrl = `${baseEndpoint.replace(/\/+$/, '')}${endpoints.news}`;

        const newsResp = await fetch(newsUrl);
        if (!newsResp.ok) {
          return { ok: false, error: 'Failed to fetch news' };
        }

        const news = await newsResp.json();
        return { ok: true, result: news };
      }

      case 'register': {
        // Register an agent onchain
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /register <agent-name>' };
        }

        const a = await this.db.agents.getByName(teamId, agentName);

        if (!a) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        // Call the existing onchain register endpoint
        try {
          const regResult = await this.registerOnchainAndUpdateAgent(teamId, a);
          return {
            ok: true,
            result: {
              agent: agentName,
              tokenId: regResult.tokenId,
              domain: regResult.domain,
              txHash: regResult.txHash
            }
          };
        } catch (err: any) {
          return { ok: false, error: `Registration failed: ${err.message}` };
        }
      }

      case 'sync-wallets': {
        // Set multi-chain wallet addresses for all registered agents
        const owsRegWallet = process.env.OWS_REGISTRAR_WALLET;
        const syncPk = !owsRegWallet ? (process.env.ID_REGISTRAR_PRIVATE_KEY || process.env.PRIVATE_KEY) : undefined;
        if (!owsRegWallet && !syncPk) {
          return { ok: false, error: 'Missing signer. Set OWS_REGISTRAR_WALLET or PRIVATE_KEY.' };
        }
        const syncSignerOpts = owsRegWallet ? { wallet: owsRegWallet } : { privateKey: syncPk! };

        const agents = await this.dbListAgents(teamId);
        const results: any[] = [];
        let synced = 0;
        let skipped = 0;
        let failed = 0;

        for (const agent of agents) {
          const domain = agent.domain || (agent.metadata as any)?.idchain_domain;
          const owsWallet = (agent.metadata as any)?.ows_wallet;

          if (!domain) {
            skipped++;
            results.push({ name: agent.name, status: 'skipped', reason: 'no domain' });
            continue;
          }
          if (!owsWallet) {
            skipped++;
            results.push({ name: agent.name, status: 'skipped', reason: 'no OWS wallet' });
            continue;
          }

          try {
            const addrResult = await setMultiChainAddresses({
              name: domain,
              walletName: owsWallet,
              ...syncSignerOpts,
            });
            synced++;
            results.push({ name: agent.name, domain, status: 'synced', set: addrResult.set, skipped: addrResult.skipped });
          } catch (err: any) {
            failed++;
            results.push({ name: agent.name, status: 'failed', error: err.message });
          }
        }

        return { ok: true, result: { synced, skipped, failed, results } };
      }

      case 'sync': {
        // Sync running team with a config file — reconcile the diff
        // Usage: /sync <config> [param=value ...] [--dry-run] [--verbose]
        const syncDryRun = args.includes('--dry-run');
        const syncVerbose = args.includes('--verbose');
        const syncFilteredArgs = args.filter(arg => arg !== '--dry-run' && arg !== '--verbose');
        const syncConfigPath = syncFilteredArgs[0];
        if (!syncConfigPath) {
          return { ok: false, error: 'Usage: /sync <config> [param=value ...] [--dry-run] [--verbose]' };
        }

        // Resolve config path (same shorthand as /deploy)
        let syncFilePath = syncConfigPath;
        if (!syncFilePath.includes('/') && !syncFilePath.includes('\\')) {
          if (!syncFilePath.endsWith('.yaml') && !syncFilePath.endsWith('.yml')) {
            syncFilePath = `configs/${syncFilePath}.yaml`;
          } else {
            syncFilePath = `configs/${syncFilePath}`;
          }
        } else if (!syncFilePath.endsWith('.yaml') && !syncFilePath.endsWith('.yml')) {
          syncFilePath = `${syncFilePath}.yaml`;
        }

        const syncAbsolutePath = path.resolve(process.cwd(), syncFilePath);
        if (!existsSync(syncAbsolutePath)) {
          return { ok: false, error: `Config file not found: ${syncFilePath}` };
        }

        const syncDeployArgs = syncFilteredArgs.slice(1);
        const { agents: syncAgents, errors: syncErrors, teamName: syncConfigTeam, org: syncOrg, calendar: syncCalendar, runtimeCredentialPool: syncRuntimeCredentialPool } =
          processConfig(syncAbsolutePath, this.baseWorkDir, syncDeployArgs);

        let syncTeamId = teamId;
        let syncTeamName = teamName;
        if (syncConfigTeam && syncConfigTeam !== teamName) {
          syncTeamId = await this.db.teams.getOrCreateTeamId(syncConfigTeam);
          syncTeamName = syncConfigTeam;
          const syncTeamDir = `${this.baseWorkDir}/teams/${syncConfigTeam}`;
          if (!existsSync(syncTeamDir)) mkdirSync(syncTeamDir, { recursive: true });
        }

        if (syncErrors.length > 0) {
          return { ok: false, error: `Config errors: ${syncErrors.map(e => `${e.path}: ${e.message}`).join('; ')}` };
        }
        if (syncAgents.length === 0) {
          return { ok: false, error: 'No agents defined in config' };
        }

        await this.db.teams.setOrg(syncTeamId, syncOrg ? syncOrg as unknown as Record<string, unknown> : null);
        await this.db.teams.setRuntimeCredentialPool(syncTeamId, syncRuntimeCredentialPool ? syncRuntimeCredentialPool as unknown as Record<string, unknown> : null);
        if (syncRuntimeCredentialPool) this.runtimeCredentialPoolByTeam.set(syncTeamId, syncRuntimeCredentialPool);
        else this.runtimeCredentialPoolByTeam.delete(syncTeamId);

        // Get running agents for this team (include automators)
        const runningAgents = await this.db.agents.list(syncTeamId, true);
        // Filter to claude/automator types only — skip interactive agents
        const syncableRunning = runningAgents.filter(a => a.type === 'claude' || a.type === 'automator');

        const plan = computeSyncPlan(syncAgents, syncableRunning, this.defaultConfig?.model);

        if (syncDryRun) {
          return {
            ok: true,
            result: {
              dryRun: true,
              summary: formatSyncSummary(plan),
              verbose: formatSyncVerbose(plan),
              plan: {
                added: plan.added.map(i => i.name),
                updated: plan.changed.map(i => ({ name: i.name, changes: i.changes })),
                removed: plan.removed.map(i => i.name),
                unchanged: plan.unchanged.map(i => i.name),
              }
            }
          };
        }

        const syncResult = { added: [] as string[], updated: [] as string[], removed: [] as string[], unchanged: [] as string[] };

        // --- REMOVED agents: kill process, hard-delete DB row ---
        for (const item of plan.removed) {
          const row = syncableRunning.find(r => r.name === item.name);
          if (row) {
            if (row.port) {
              await this.killAgentProcess(row.port);
              await new Promise(r => setTimeout(r, 500));
            }
            await this.db.agents.deleteAgent(row.id);
            console.log(`[Sync] Removed agent: ${item.name}`);
          }
          syncResult.removed.push(item.name);
        }

        // --- UNCHANGED agents: skip ---
        for (const item of plan.unchanged) {
          syncResult.unchanged.push(item.name);
        }

        // --- CHANGED agents: in-place rebuild with same ID/port ---
        for (const item of plan.changed) {
          const row = syncableRunning.find(r => r.name === item.name)!;
          const spec = syncAgents.find(a => (a.domain || a.name) === item.name)!;

          // If workingDirectory changed, treat as destroy + recreate
          const wdChanged = item.changes?.includes('workingDirectory');
          if (wdChanged) {
            if (row.port) {
              await this.killAgentProcess(row.port);
              await new Promise(r => setTimeout(r, 500));
            }
            await this.db.agents.deleteAgent(row.id);
            plan.added.push({ name: item.name, category: 'new' });
            syncResult.updated.push(item.name);
            continue;
          }

          // Kill old process on existing port
          if (row.port) {
            await this.killAgentProcess(row.port);
            await new Promise(r => setTimeout(r, 500));
          }

          // Update config on disk (skills, plugins, heartbeat)
          const workingDirectory = row.working_directory || `${this.baseWorkDir}/agents/${row.id}`;
          if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });

          const effectiveRuntime = resolveRuntime(spec.runtime) as HarnessType;
          const effectiveModel = spec.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
          this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

          const mergedPlugins = spec.plugins || [];
          const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

          const agentSkills: string[] = spec.skills || [];
          let orgContext = '';
          if (syncOrg?.groups) {
            try {
              const { generateAgentOrgContext } = await import('./org-chart.js');
              orgContext = generateAgentOrgContext(spec.name, syncOrg);
            } catch { /* ignore */ }
          }

          const configDomain = spec.domain;
          const normalizedSkills = normalizeConfigSkills(agentSkills);

          // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
          if (spec.agent) {
            copyLibraryAgentOverlay(workingDirectory, spec.agent, effectiveRuntime);
          }

          // 2. Deploy team-level skills (runtime-aware)
          const isAutomator = spec.type === 'automator';
          const walletMeta = this.resolveWalletMetadata(syncTeamName, spec.name, {
            ...(row.metadata as AgentMetadata || {}),
            name: spec.name,
            service_type: isAutomator ? undefined : 'REST-AP',
            endpoint: isAutomator ? undefined : `http://localhost:${row.port}`,
            runtime: effectiveRuntime,
            plugins: localPlugins,
            agent: spec.agent,
            skills: normalizedSkills,
            allowed_tools: spec.allowedTools,
            description: spec.description,
            ...(spec.lead === true && { primaryLead: true }),
            ...(isAutomator && { isAutomator: true }),
            ...(spec.heartbeat && { heartbeat: true }),
            ...(spec.dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: spec.dangerouslySkipPermissions }),
            // Catalog seed from YAML — overwrites any runtime PATCH on redeploy.
            // This is intentional: YAML is the redeploy floor.
            ...(spec.catalog && { catalog: spec.catalog }),
          }, spec.wallet);

          this.deploySkillsToAgent(workingDirectory, agentSkills, {
            DISPLAY_NAME: configDomain || spec.name,
            TEAM: syncTeamName,
            ONCHAIN_IDENTITY: configDomain ? `Your onchain identity is your ENS domain: **${configDomain}**` : '',
            ORG_CONTEXT: orgContext
              ? `\n## Your Role\n\n${orgContext}\n\nSee the full org chart at the shared team folder for details on all groups.`
              : '',
          }, { hasWallet: !!walletMeta.wallet, runtime: effectiveRuntime });

          // 3. Overlay working-directory template files (runtime-aware)
          copyAgentDirOverlay(workingDirectory, spec.name, effectiveRuntime);
          copyHeartbeatMd(workingDirectory, spec.name, effectiveRuntime);

          // 4. Write personality file: framework block (marker-fenced for
          // Codex/Cursor; full overwrite for Claude). Preserves user edits
          // outside the markers on Codex/Cursor refresh paths.
          {
            const parts = [PROTOCOL_DEFAULTS];
            if (spec.roleBody) parts.push(spec.roleBody);
            writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
          }

          // 5. Codex/Cursor: append library persona to AGENTS.md inside
          // marker fences (no-op for Claude).
          if (spec.agent) {
            appendLibraryPersonaToAgentsMd(workingDirectory, spec.agent, effectiveRuntime);
          }

          const updatedMeta: AgentMetadata = walletMeta.metadata;

          await this.db.agents.updateStatus(row.id, 'starting', {
            model: effectiveModel,
            runtime: effectiveRuntime,
            metadata: updatedMeta,
          });

          // Respawn on same port
          const spawnResult = await this.spawnLocalAgentProcess(syncTeamId, syncTeamName, {
            name: spec.name,
            id: row.id,
            port: row.port,
            model: effectiveModel,
            workingDirectory,
            tokenId: spec.tokenId || row.token_id || undefined,
          });

          if (spawnResult.success) {
            await this.db.agents.updateStatus(row.id, 'running');
            console.log(`[Sync] Updated agent: ${item.name} (changes: ${item.changes?.join(', ')})`);
          } else {
            await this.db.agents.updateStatus(row.id, 'error');
            console.error(`[Sync] Failed to restart ${item.name}: ${spawnResult.error}`);
          }

          // Re-seed heartbeat if needed
          if (spec.heartbeat && this.schedulerService) {
            const { definition, agentIds } = heartbeatToSchedule(row.id, spec.name, spec.heartbeat);
            await this.schedulerService.seedSchedule(definition, agentIds);
          }

          syncResult.updated.push(item.name);
        }

        // --- NEW agents: spawn fresh (reuse deploy logic) ---
        for (const item of plan.added) {
          const spec = syncAgents.find(a => (a.domain || a.name) === item.name)!;
          const agentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          try {
            const port = await this.dbNextPort(syncTeamId);
            const workingDirectory = spec.workingDirectory && path.isAbsolute(spec.workingDirectory)
              ? spec.workingDirectory
              : `${this.baseWorkDir}/agents/${agentId}`;
            if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });

            const effectiveRuntime = resolveRuntime(spec.runtime) as HarnessType;
            const effectiveModel = spec.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
            this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

            const localPlugins = this.copyPluginsToAgent(spec.plugins || [], workingDirectory);
            const isAutomator = spec.type === 'automator';
            const agentType = spec.type || 'claude';
            const configDomain = spec.domain;
            const configTokenId = spec.tokenId;
            const agentName = configDomain || spec.name;

            const agentSkills: string[] = spec.skills || [];
            const normalizedSkills = normalizeConfigSkills(agentSkills);
            let orgContext = '';
            if (syncOrg?.groups) {
              try {
                const { generateAgentOrgContext } = await import('./org-chart.js');
                orgContext = generateAgentOrgContext(spec.name, syncOrg);
              } catch { /* ignore */ }
            }
            const walletMeta = this.resolveWalletMetadata(syncTeamName, spec.name, {
              name: spec.name,
              service_type: isAutomator ? undefined : 'REST-AP',
              endpoint: isAutomator ? undefined : `http://localhost:${port}`,
              runtime: effectiveRuntime,
              plugins: localPlugins,
              ...(spec.agent && { agent: spec.agent }),
              skills: normalizedSkills,
              allowed_tools: spec.allowedTools,
              description: spec.description,
              ...(spec.lead === true && { primaryLead: true }),
              ...(isAutomator && { isAutomator: true }),
              ...(spec.heartbeat && { heartbeat: true }),
              ...(spec.openMode !== undefined && { openMode: spec.openMode }),
              ...(spec.dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: spec.dangerouslySkipPermissions }),
              // Catalog seed from YAML — see notes on the sync-update site above.
              ...(spec.catalog && { catalog: spec.catalog }),
            }, spec.wallet);

            // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
            if (spec.agent) {
              copyLibraryAgentOverlay(workingDirectory, spec.agent, effectiveRuntime);
            }

            // 2. Deploy team-level skills (runtime-aware)
            this.deploySkillsToAgent(workingDirectory, agentSkills, {
              DISPLAY_NAME: configDomain || spec.name,
              TEAM: syncTeamName,
              ONCHAIN_IDENTITY: configDomain ? `Your onchain identity is your ENS domain: **${configDomain}**` : '',
              ORG_CONTEXT: orgContext
                ? `\n## Your Role\n\n${orgContext}\n\nSee the full org chart at the shared team folder for details on all groups.`
                : '',
            }, { hasWallet: !!walletMeta.wallet, runtime: effectiveRuntime });

            // 3. Overlay working-directory template files (runtime-aware)
            copyAgentDirOverlay(workingDirectory, spec.name, effectiveRuntime);
            copyHeartbeatMd(workingDirectory, spec.name, effectiveRuntime);

            // 4. Write personality file: framework block (marker-fenced for
            // Codex/Cursor; full overwrite for Claude).
            {
              const parts = [PROTOCOL_DEFAULTS];
              if (spec.roleBody) parts.push(spec.roleBody);
              writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
            }

            // 5. Codex/Cursor: append library persona to AGENTS.md inside
            // marker fences (no-op for Claude).
            if (spec.agent) {
              appendLibraryPersonaToAgentsMd(workingDirectory, spec.agent, effectiveRuntime);
            }

            const metadata: AgentMetadata = walletMeta.metadata;

            if (configDomain) {
              metadata.idchain_domain = configDomain;
              metadata.alias = spec.name;
            }

            await this.db.agents.create({
              team_id: syncTeamId,
              id: agentId,
              name: agentName,
              type: agentType,
              model: effectiveModel,
              port,
              endpoint: null,
              working_directory: workingDirectory,
              status: 'starting',
              created_at: Date.now(),
              metadata,
              runtime: effectiveRuntime,
              token_id: configTokenId || null,
              domain: configDomain || null,
            });

            const url = `http://localhost:${port}`;
            await this.db.agents.updateStatus(agentId, 'pending', {
              port, endpoint: url, metadata: { ...metadata, endpoint: url, local: true },
            });

            const spawnResult = await this.spawnLocalAgentProcess(syncTeamId, syncTeamName, {
              name: spec.name, id: agentId, port, model: effectiveModel,
              workingDirectory, tokenId: configTokenId || undefined,
            });

            if (spawnResult.success) {
              await this.db.agents.updateStatus(agentId, 'running');
              console.log(`[Sync] Added agent: ${item.name} (port ${port})`);
            } else {
              await this.db.agents.updateStatus(agentId, 'error');
              console.error(`[Sync] Failed to spawn ${item.name}: ${spawnResult.error}`);
            }

            if (spec.heartbeat && this.schedulerService) {
              const { definition, agentIds } = heartbeatToSchedule(agentId, spec.name, spec.heartbeat);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }

            syncResult.added.push(item.name);
          } catch (err: any) {
            console.error(`[Sync] Error adding ${item.name}: ${err.message}`);
          }
        }

        // Re-seed calendar schedules
        if (syncCalendar && syncCalendar.length > 0 && this.schedulerService) {
          await this.db.schedules.deleteBySource('yaml', `calendar:${syncAbsolutePath}:`);
          for (let index = 0; index < syncCalendar.length; index++) {
            const spec = syncCalendar[index] as CalendarSpec;
            const targetIds: string[] = [];
            for (const ref of spec.agents) {
              const target = await this.db.agents.getByName(syncTeamId, ref);
              if (target) targetIds.push(target.id);
            }
            if (targetIds.length > 0) {
              const { definition, agentIds } = calendarToSchedule(spec, `calendar:${syncAbsolutePath}:${index}`, targetIds);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }
          }
        }

        // Generate org chart if defined
        if (syncOrg?.groups) {
          try {
            const { generateOrgChart } = await import('./org-chart.js');
            const orgMd = generateOrgChart(syncTeamName, syncOrg, syncAgents.map(a => ({
              name: a.name, description: a.description, domain: a.domain,
            })));
            const teamDir = `${this.baseWorkDir}/teams/${syncTeamName}`;
            if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
            writeFileSync(`${teamDir}/ORG_CHART.md`, orgMd);
          } catch { /* ignore */ }
        }

        if (syncResult.added.length || syncResult.updated.length || syncResult.removed.length) {
          this.broadcastAgentsChanged(syncTeamId, {
            reason: 'sync',
            added: syncResult.added,
            updated: syncResult.updated,
            removed: syncResult.removed,
          });
        }

        return {
          ok: true,
          result: {
            // Echo the effective team back so the CLI can retarget its
            // daemon connection when /sync re-targets a team different
            // from activeTeam.
            team: syncTeamName,
            teamId: syncTeamId,
            summary: formatSyncSummary(plan),
            verbose: formatSyncVerbose(plan),
            ...syncResult,
          }
        };
      }

      case 'deploy': {
        // Deploy agents from a config file
        // Usage: /deploy <config> [param1=value1] [param2=value2] ...
        const dryRun = args.includes('--dry-run');
        const filteredArgs = args.filter(arg => arg !== '--dry-run');
        const configPath = filteredArgs[0];
        if (!configPath) {
          return { ok: false, error: 'Usage: /deploy <config> [param=value ...] [--dry-run]' };
        }

        // Resolve config path (support shorthand like "designer" -> "configs/designer.yaml")
        let filePath = configPath;
        const originalArg = configPath;
        if (!filePath.includes('/') && !filePath.includes('\\')) {
          if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
            filePath = `configs/${filePath}.yaml`;
          } else {
            filePath = `configs/${filePath}`;
          }
        } else if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
          filePath = `${filePath}.yaml`;
        }

        // Resolve to absolute path
        let absolutePath = path.resolve(process.cwd(), filePath);

        // Parse config with provided parameters
        let deployArgs = filteredArgs.slice(1);

        // If config doesn't exist, fall back to default.yaml with the arg as the name
        if (!existsSync(absolutePath)) {
          const defaultPath = path.resolve(process.cwd(), 'configs/default.yaml');
          if (existsSync(defaultPath)) {
            console.log(`[Deploy] Config not found: ${filePath}, using default.yaml with name=${originalArg}`);
            absolutePath = defaultPath;
            // Prepend the original arg as name parameter if not already specified
            if (!deployArgs.some(a => a.startsWith('name='))) {
              deployArgs = [originalArg, ...deployArgs];
            }
          } else {
            return { ok: false, error: `Config file not found: ${filePath}` };
          }
        }
        const preflight = await this.buildDeployPreflightSummary(teamId, teamName, absolutePath, deployArgs);

        if (dryRun) {
          return {
            ok: true,
            result: {
              dryRun: true,
              configPath: preflight.configPath,
              teamName: preflight.teamName,
              calendarCount: preflight.calendarCount,
              agents: preflight.agents,
            }
          };
        }

        const { agents, calendar, errors, onchain, teamName: configTeam, org, runtimeCredentialPool } = processConfig(absolutePath, this.baseWorkDir, deployArgs);

        // If config specifies a team, use that instead of the request's team
        let effectiveTeamId = teamId;
        let effectiveTeamName = teamName;
        if (configTeam && configTeam !== teamName) {
          effectiveTeamId = await this.db.teams.getOrCreateTeamId(configTeam);
          effectiveTeamName = configTeam;
          // Ensure team directory exists
          const configTeamDir = `${this.baseWorkDir}/teams/${configTeam}`;
          if (!existsSync(configTeamDir)) mkdirSync(configTeamDir, { recursive: true });
          console.log(`[Deploy] Using team from config: ${configTeam}`);
        }

        if (errors.length > 0) {
          return {
            ok: false,
            error: `Config errors: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`
          };
        }

        if (agents.length === 0) {
          return { ok: false, error: 'No agents defined in config' };
        }

        await this.db.teams.setOrg(effectiveTeamId, org ? org as unknown as Record<string, unknown> : null);
        await this.db.teams.setRuntimeCredentialPool(effectiveTeamId, runtimeCredentialPool ? runtimeCredentialPool as unknown as Record<string, unknown> : null);
        if (runtimeCredentialPool) this.runtimeCredentialPoolByTeam.set(effectiveTeamId, runtimeCredentialPool);
        else this.runtimeCredentialPoolByTeam.delete(effectiveTeamId);

        for (const agentConfig of agents) {
          const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
          const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
          this.ensureRuntimeReady(effectiveRuntime, effectiveModel);
        }

        // Generate org chart if defined in config
        if (org?.groups) {
          try {
            const { generateOrgChart } = await import('./org-chart.js');
            const orgMd = generateOrgChart(effectiveTeamName, org, agents.map(a => ({
              name: a.name,
              description: a.description,
              domain: a.domain,
            })));
            const teamDir = `${this.baseWorkDir}/teams/${effectiveTeamName}`;
            if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
            writeFileSync(`${teamDir}/ORG_CHART.md`, orgMd);
            console.log(`[Deploy] Org chart written to teams/${effectiveTeamName}/ORG_CHART.md`);
          } catch (err: any) {
            console.warn(`[Deploy] Could not generate org chart: ${err.message}`);
          }
        }

        // Validate automator naming: first automator must be named "lead-automator"
        const automatorAgents = agents.filter(a => a.type === 'automator');
        if (automatorAgents.length > 0) {
          const existingLeadAutomator = await this.db.agents.getByName(effectiveTeamId, 'lead-automator');
          const hasLeadAutomator = existingLeadAutomator !== null && existingLeadAutomator.type === 'automator';

          if (!hasLeadAutomator) {
            const hasLeadAutomatorInConfig = automatorAgents.some(a => a.name === 'lead-automator');
            if (!hasLeadAutomatorInConfig) {
              return {
                ok: false,
                error: 'First automator must be named "lead-automator". Rename the team-local automator and re-deploy.'
              };
            }
          }
        }

        // Deploy each agent
        const results: { name: string; id?: string; port?: number; success: boolean; error?: string; tokenId?: string }[] = [];

        // Re-seed calendar schedules idempotently for this config source.
        if (this.schedulerService) {
          await this.db.schedules.deleteBySource('yaml', `calendar:${absolutePath}:`);
        }

        for (const agentConfig of agents) {
          // Generate unique agent ID outside try so it's available for cleanup
          const agentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          try {
            const port = await this.dbNextPort(effectiveTeamId);
            const workingDirectory = agentConfig.workingDirectory && path.isAbsolute(agentConfig.workingDirectory)
              ? agentConfig.workingDirectory
              : `${this.baseWorkDir}/agents/${agentId}`;

            if (!existsSync(workingDirectory)) {
              mkdirSync(workingDirectory, { recursive: true });
            }

            // Merge plugins from config
            const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
            const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
            this.ensureRuntimeReady(effectiveRuntime, effectiveModel);
            const mergedPlugins = agentConfig.plugins || [];

            // Copy plugins to agent's working directory
            const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

            // Automator agents are team-local planning workers; they don't have REST-AP endpoints
            console.log(`[Deploy] Agent ${agentConfig.name}: type=${agentConfig.type}, isAutomator=${agentConfig.type === 'automator'}`);
            const isAutomator = agentConfig.type === 'automator';
            const agentType = agentConfig.type || 'claude';
            const normalizedSkills = normalizeConfigSkills(agentConfig.skills);

            // Get heartbeat config
            const heartbeatConfig = agentConfig.heartbeat;

            const metadata: AgentMetadata = {
              name: agentConfig.name,
              service_type: isAutomator ? undefined : 'REST-AP',
              endpoint: isAutomator ? undefined : `http://localhost:${port}`,
              runtime: effectiveRuntime,
              plugins: localPlugins,
              ...(agentConfig.agent && { agent: agentConfig.agent }),
              ...(normalizedSkills && { skills: normalizedSkills }),
              allowed_tools: agentConfig.allowedTools,
              description: agentConfig.description,
              ...(agentConfig.lead === true && { primaryLead: true }),
              ...(isAutomator && { isAutomator: true }),
              // Flag that heartbeat is enabled
              ...(heartbeatConfig && { heartbeat: true }),
              ...(agentConfig.openMode !== undefined && { openMode: agentConfig.openMode }),
              ...(agentConfig.dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: agentConfig.dangerouslySkipPermissions }),
              // Catalog seed from YAML — lands in metadata.catalog and surfaces
              // via the agent's /catalog endpoint. Runtime PATCH /catalog still
              // works; the next /deploy or /sync re-applies this YAML floor.
              ...(agentConfig.catalog && { catalog: agentConfig.catalog })
            };

            // Use ENS domain from config if available (preserves registration across redeploys)
            const configDomain = agentConfig.domain;
            const configTokenId = agentConfig.tokenId;
            const agentName = configDomain || agentConfig.name;
            if (configDomain) {
              metadata.idchain_domain = configDomain;
              metadata.alias = agentConfig.name;
            }

            // Wallet opt-in (default off). Record the explicit choice in
            // metadata so the on-demand provisioning command and the
            // onchain auto-provision gate can read it. Only call the `ows`
            // CLI when `wallet: true`.
            if (agentConfig.wallet !== undefined) {
              metadata.wallet = agentConfig.wallet;
            }
            const owsWallet = agentConfig.wallet === true
              ? this.getOrCreateAgentWallet(effectiveTeamName, agentConfig.name)
              : null;
            if (owsWallet) {
              metadata.ows_wallet = owsWallet.walletName;
              metadata.ows_address = owsWallet.address;
            }

            // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
            if (agentConfig.agent) {
              copyLibraryAgentOverlay(workingDirectory, agentConfig.agent, effectiveRuntime);
            }

            // 2. Deploy skills (runtime-aware)
            const agentSkills: string[] = agentConfig.skills || [];
            let orgContext = '';
            if (org?.groups) {
              try {
                const { generateAgentOrgContext } = await import('./org-chart.js');
                orgContext = generateAgentOrgContext(agentConfig.name, org);
              } catch { /* ignore */ }
            }
            this.deploySkillsToAgent(workingDirectory, agentSkills, {
              DISPLAY_NAME: configDomain || agentConfig.name,
              TEAM: effectiveTeamName,
              ONCHAIN_IDENTITY: configDomain
                ? `Your onchain identity is your ENS domain: **${configDomain}**`
                : '',
              ORG_CONTEXT: orgContext
                ? `\n## Your Role\n\n${orgContext}\n\nSee the full org chart at the shared team folder for details on all groups.`
                : '',
            }, { hasWallet: !!owsWallet, runtime: effectiveRuntime });

            // 3. Overlay working-directory template files (runtime-aware)
            copyAgentDirOverlay(workingDirectory, agentConfig.name, effectiveRuntime);
            copyHeartbeatMd(workingDirectory, agentConfig.name, effectiveRuntime);

            // 4. Write personality file: protocol defaults + agent role body (runtime-aware)
            {
              const parts = [PROTOCOL_DEFAULTS];
              if (agentConfig.roleBody) parts.push(agentConfig.roleBody);
              writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
            }

            // 5. Codex/Cursor: append library persona to AGENTS.md inside
            // marker fences (no-op for Claude).
            if (agentConfig.agent) {
              appendLibraryPersonaToAgentsMd(workingDirectory, agentConfig.agent, effectiveRuntime);
            }

            // Remove any existing agent with this name to avoid duplicates on redeploy
            const existing = await this.db.agents.getByName(effectiveTeamId, agentName);
            if (existing) {
              // Kill the old process before deleting the DB row to prevent orphans
              if (existing.port) {
                await this.killAgentProcess(existing.port);
                await new Promise(r => setTimeout(r, 500));
              }
              await this.db.agents.deleteAgent(existing.id);
            }

            // Insert into database
            console.log(`[Deploy] Storing agent: name=${agentName}, type=${agentType}, configType=${agentConfig.type}`);
            await this.db.agents.create({
              team_id: effectiveTeamId,
              id: agentId,
              name: agentName,
              type: agentType,
              model: effectiveModel,
              port,
              endpoint: null,
              working_directory: workingDirectory,
              status: 'starting',
              created_at: Date.now(),
              metadata,
              runtime: effectiveRuntime,
              token_id: configTokenId || null,
              domain: configDomain || null,
            });

            // All agents run locally - set up database and let CLI spawn the process
            const url = `http://localhost:${port}`;
            const finalMeta = { ...metadata, endpoint: url, local: true };
            await this.db.agents.updateStatus(agentId, 'pending', {
              port,
              endpoint: url,
              metadata: finalMeta,
            });

            // Spawn the agent process
            const spawnResult = await this.spawnLocalAgentProcess(effectiveTeamId, effectiveTeamName, {
              name: agentConfig.name,
              id: agentId,
              port,
              model: effectiveModel,
              workingDirectory,
              tokenId: configTokenId || undefined,
              address: (agentConfig as any).address || undefined
            });

            // Seed heartbeat schedule if config specified
            if (heartbeatConfig && this.schedulerService) {
              const { definition, agentIds } = heartbeatToSchedule(agentId, agentConfig.name, heartbeatConfig);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }

            const result: { name: string; id: string; port: number; success: boolean; tokenId?: string; domain?: string; txHash?: string; local: boolean; workingDirectory: string; pid?: number; logFile?: string } = {
              name: agentConfig.name,
              id: agentId,
              port,
              success: true,
              local: true,
              workingDirectory
            };

            if (spawnResult.success) {
              result.pid = spawnResult.pid;
              result.logFile = spawnResult.logFile;
              // Update status to running
              await this.db.agents.updateStatus(agentId, 'running');
            }

            // Auto-register onchain if enabled (automators never register)
            const shouldRegister = !isAutomator && (agentConfig.register !== undefined ? agentConfig.register : onchain?.register);
            if (shouldRegister) {
              try {
                // Fetch the agent row for registration
                const agentRow = await this.db.agents.getById(agentId);
                if (agentRow) {
                  const regResult = await this.registerOnchainAndUpdateAgent(effectiveTeamId, agentRow);
                  console.log(`[Deploy] Registration result: domain=${regResult.domain}, tokenId=${regResult.tokenId}, txHash=${regResult.txHash}`);
                  result.tokenId = regResult.tokenId;
                  result.domain = regResult.domain;
                  result.txHash = regResult.txHash;

                  // Update CLAUDE.md with agent's full identity after registration
                  if (regResult.tokenId) {
                    console.log(`[Deploy] Writing identity to CLAUDE.md at ${workingDirectory}`);
                    try {
                      const claudeDir = path.join(workingDirectory, '.claude');
                      if (!existsSync(claudeDir)) {
                        console.log(`[Deploy] Creating .claude directory: ${claudeDir}`);
                        mkdirSync(claudeDir, { recursive: true });
                      }
                      this.updateClaudeMdIdentity(path.join(claudeDir, 'CLAUDE.md'), regResult.domain || agentConfig.name);
                      console.log(`[Deploy] Updated CLAUDE.md with identity: ${regResult.domain || agentConfig.name}`);
                    } catch (identityErr: any) {
                      console.warn(`[Deploy] Failed to update identity in CLAUDE.md: ${identityErr.message}`);
                    }
                  }
                }
              } catch (regErr: any) {
                // Registration failure is non-fatal
                console.warn(`[Deploy] Auto-register failed for ${agentConfig.name}: ${regErr.message}`);
              }
            }

            results.push(result);
          } catch (err: any) {
            // Clean up the database record if deployment failed
            if (agentId) {
              try {
                await this.db.agents.deleteAgent(agentId);
                console.log(`[Deploy] Cleaned up failed agent record: ${agentId}`);
              } catch (cleanupErr) {
                console.warn(`[Deploy] Failed to clean up agent record: ${cleanupErr}`);
              }
            }
            results.push({ name: agentConfig.name, success: false, error: err.message });
          }
        }

        if (calendar.length > 0 && this.schedulerService) {
          for (let index = 0; index < calendar.length; index++) {
            const spec = calendar[index] as CalendarSpec;
            const targetIds: string[] = [];

            for (const ref of spec.agents) {
              const target = await this.db.agents.getByName(effectiveTeamId, ref);
              if (!target) {
                console.warn(`[Scheduler] Calendar event "${spec.title}" target not found: ${ref}`);
                continue;
              }
              targetIds.push(target.id);
            }

            if (targetIds.length === 0) {
              console.warn(`[Scheduler] Skipping calendar event "${spec.title}" with no resolved targets`);
              continue;
            }

            const { definition, agentIds } = calendarToSchedule(
              spec,
              `calendar:${absolutePath}:${index}`,
              targetIds,
            );
            await this.schedulerService.seedSchedule(definition, agentIds);
          }
        }

        const deployedNames = results.filter(r => r.success).map(r => r.name);
        if (deployedNames.length) {
          this.broadcastAgentsChanged(effectiveTeamId, { reason: 'deploy', added: deployedNames });
        }

        return {
          ok: true,
          result: {
            // Echo the effective team back so the CLI can retarget its
            // daemon connection when /deploy targets a team different
            // from activeTeam.
            team: effectiveTeamName,
            teamId: effectiveTeamId,
            deployed: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            agents: results
          }
        };
      }

      case 'agent': {
        // Control individual agent: /agent <name> <start|stop|rebuild|logs|heartbeat|wallet provision>
        const agentName = args[0];
        const subAction = args[1]?.toLowerCase();

        if (!agentName || !subAction) {
          return { ok: false, error: 'Usage: /agent <name> <start|stop|rebuild|logs|heartbeat|probe|wallet provision>' };
        }

        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (subAction === 'probe') {
          // Single named agent — do NOT filter on status. The operator
          // explicitly asked to probe this agent; a downed agent should
          // surface as `failed` (with the timeout/network error string),
          // not be silently skipped.
          return this.probeAgentsViaTalk(teamName, [agent]);
        }

        if (subAction === 'wallet') {
          const walletAction = args[2]?.toLowerCase();
          if (walletAction !== 'provision') {
            return { ok: false, error: 'Usage: /agent <name> wallet provision' };
          }
          const meta = (agent.metadata || {}) as Record<string, any>;
          if (meta.ows_wallet) {
            return {
              ok: true,
              result: {
                action: 'wallet-provision',
                name: agent.name,
                status: 'already-provisioned',
                ows_wallet: meta.ows_wallet,
                ows_address: meta.ows_address || null,
              },
            };
          }
          if (!this.checkOwsInstalled()) {
            return { ok: false, error: 'OWS CLI not installed; cannot provision wallet on demand' };
          }
          const refreshed = await this.provisionAgentWalletForRow(teamId, teamName, agent);
          if (!refreshed) {
            return { ok: false, error: `Failed to provision OWS wallet for ${agent.name}` };
          }
          const provisionedMeta = (refreshed.metadata || {}) as Record<string, any>;
          return {
            ok: true,
            result: {
              action: 'wallet-provision',
              name: refreshed.name,
              status: 'provisioned',
              ows_wallet: provisionedMeta.ows_wallet,
              ows_address: provisionedMeta.ows_address || null,
            },
          };
        }

        // Remote-endpoint runtimes are lifecycled by the operator, not the manager.
        if (isRemoteEndpointRuntime(agent.runtime)) {
          return { ok: false, error: 'lifecycle_not_supported_for_remote' };
        }

        if (agent.type !== 'claude') {
          return { ok: false, error: 'Only claude agents can be controlled' };
        }

        try {
          switch (subAction) {
            case 'start': {
              const spawnResult = await this.spawnLocalAgentProcess(teamId, teamName, {
                name: agent.name, id: agent.id, port: agent.port,
                model: agent.model, workingDirectory: agent.working_directory ?? undefined,
                tokenId: agent.token_id ?? undefined
              });
              if (spawnResult.success) {
                await this.db.agents.updateStatus(agent.id, 'running');
                return { ok: true, result: { action: 'started', name: agent.name, pid: spawnResult.pid, logFile: spawnResult.logFile } };
              } else {
                return { ok: false, error: `Failed to start ${agent.name}: ${spawnResult.error}` };
              }
            }
            case 'stop': {
              const killResult = await this.killAgentProcess(agent.port);
              const cancelled = await this.cancelPendingQueriesForAgent(teamId, agent.id);
              await this.db.agents.updateStatus(agent.id, 'stopped');
              await this.clearAgentPid(agent.id);
              return { ok: true, result: { action: 'stopped', name: agent.name, ...killResult, queriesCancelled: cancelled } };
            }
            case 'rebuild': {
              const spawnResult = await this.rebuildLocalClaudeAgent(teamId, teamName, agent);
              if (spawnResult.success) {
                return { ok: true, result: { action: 'rebuilt', name: agent.name, pid: spawnResult.pid, logFile: spawnResult.logFile } };
              } else {
                return { ok: false, error: `Failed to rebuild ${agent.name}: ${spawnResult.error}` };
              }
            }
            case 'logs': {
              return { ok: false, error: 'Logs not available for local agents' };
            }
            case 'heartbeat': {
              // Send heartbeat and reset timer
              if (agent.metadata?.heartbeat !== true) {
                return { ok: false, error: `Agent "${agent.name}" does not have heartbeat enabled` };
              }
              if (agent.status !== 'running') {
                return { ok: false, error: `Agent "${agent.name}" is not running` };
              }
              if (!agent.working_directory) {
                return { ok: false, error: `Agent "${agent.name}" has no working directory` };
              }
              // Read config from file
              const config = this.readHeartbeatConfig(agent.working_directory);
              if (!config) {
                return { ok: false, error: `Agent "${agent.name}" has no HEARTBEAT.yaml or HEARTBEAT.md file` };
              }
              // Send one immediate message and reseed the schedule
              if (agent.endpoint) {
                try {
                  await fetch(`${agent.endpoint}/talk`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ from: 'schedule', message: config.message }),
                  });
                } catch { /* ignore */ }
              }
              if (this.schedulerService) {
                const { definition, agentIds } = heartbeatToSchedule(agent.id, agent.name, config);
                await this.schedulerService.seedSchedule(definition, agentIds);
              }
              return { ok: true, result: { action: 'heartbeat', name: agent.name, intervalSeconds: config.interval, message: 'Heartbeat sent and schedule reseeded' } };
            }
            default:
              return { ok: false, error: `Unknown agent action: ${subAction}. Available: start, stop, rebuild, logs, heartbeat, probe, wallet provision` };
          }
        } catch (err: any) {
          return { ok: false, error: `Agent ${subAction} failed: ${err.message}` };
        }
      }

      case 'model': {
        // Change agent model: /model <agent> <model>
        const agentName = args[0];
        const newModel = args[1];

        if (!agentName || !newModel) {
          return { ok: false, error: 'Usage: /model <agent-name> <model>' };
        }

        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        // Resolve model alias
        const resolvedModel = resolveModelAlias(newModel);

        // Update model and mark for restart if running
        const newStatus = agent.status === 'running' ? 'pending' : agent.status;
        await this.db.agents.updateStatus(agent.id, newStatus, { model: resolvedModel });

        return {
          ok: true,
          result: {
            name: agent.name,
            model: resolvedModel,
            ...(agent.status === 'running' && { message: 'Model updated. Agent marked for restart.' })
          }
        };
      }

      case 'configs': {
        // List available deployment configs
        const configsDir = path.resolve(process.cwd(), 'configs');
        if (!existsSync(configsDir)) {
          return { ok: true, result: { configs: [] } };
        }
        const files = readdirSync(configsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        const configs = files.map(f => {
          const name = f.replace(/\.(yaml|yml)$/, '');
          const filePath = path.join(configsDir, f);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const parsed = yaml.load(content) as any;
            return {
              name,
              description: parsed?.description || null,
              agents: parsed?.agents?.length || 0
            };
          } catch {
            return { name, description: null, agents: 0 };
          }
        });
        return { ok: true, result: { configs } };
      }

      case 'registry': {
        // /registry - show default registry
        // /registry push - push agents to registry
        // /registry pull <ids> - pull agents from registry
        // /registry set <chainId> <address> - set default registry
        // /registry set-registrar <address> - set registrar
        const subCmd = args[0];

        if (!subCmd) {
          // Show default registry
          const chainId = process.env.REGISTRY_CHAIN_ID || '8453';
          const registryAddress = process.env.REGISTRY_ADDRESS || '';
          const registrarAddress = process.env.REGISTRAR_ADDRESS || '';
          return {
            ok: true,
            result: {
              chainId,
              registryAddress: registryAddress || '(not set)',
              registrarAddress: registrarAddress || '(not set)'
            }
          };
        }

        if (subCmd === 'push') {
          // Push all unregistered agents to registry
          const agents = await this.dbListAgents(teamId);
          const unregistered = agents.filter(a => !a.token_id && a.type === 'claude');
          const results: { name: string; tokenId?: string; domain?: string; error?: string }[] = [];

          for (const agent of unregistered) {
            try {
              const regResult = await this.registerOnchainAndUpdateAgent(teamId, agent);
              results.push({ name: agent.name, tokenId: regResult.tokenId, domain: regResult.domain });
            } catch (err: any) {
              results.push({ name: agent.name, error: err.message });
            }
          }

          return { ok: true, result: { registered: results } };
        }

        if (subCmd === 'pull') {
          const agentIds = args.slice(1).join(' ').split(/[\s,]+/).filter(Boolean);
          if (agentIds.length === 0) {
            return { ok: false, error: 'Usage: /registry pull <agent-ids>' };
          }
          // This would need the actual registry pull implementation
          return { ok: false, error: 'Registry pull not yet implemented in remote endpoint' };
        }

        if (subCmd === 'set') {
          return { ok: false, error: 'Registry set requires environment variable changes (REGISTRY_CHAIN_ID, REGISTRY_ADDRESS)' };
        }

        if (subCmd === 'set-registrar') {
          return { ok: false, error: 'Registry set-registrar requires environment variable changes (REGISTRAR_ADDRESS)' };
        }

        return { ok: false, error: 'Usage: /registry [push|pull <ids>]' };
      }

      case 'teams': {
        // List all teams
        const teams = await this.db.teams.listTeams();
        const teamList = await Promise.all(
          teams.map(async (team) => {
            const agentCount = await this.db.agents.count(team.id);
            return {
              id: team.id,
              name: team.name,
              agentCount: parseInt(agentCount || '0')
            };
          })
        );
        return { ok: true, result: { teams: teamList } };
      }

      case 'team': {
        // /team - show current team (from header)
        // /team delete <name> - delete an empty, inactive team.
        // /team <name> - switch to an existing team.
        const targetName = args[0];
        const subcommand = targetName?.toLowerCase();
        if (subcommand === 'delete' || subcommand === 'remove') {
          const nameArg = args[1];
          if (!nameArg || args.length !== 2) {
            return { ok: false, error: 'Usage: /team delete <name>' };
          }
          const nameCheck = validateName(nameArg, 'team');
          if (!nameCheck.valid) {
            return { ok: false, error: nameCheck.error };
          }
          if (nameArg === teamName) {
            return { ok: false, error: `Cannot delete the active team "${nameArg}". Switch to another team first.` };
          }

          const deleted = await this.deleteEmptyTeamByName(nameArg);
          if (!deleted.ok) {
            return { ok: false, error: deleted.error };
          }
          return { ok: true, result: deleted.result };
        }

        if (targetName) {
          if (args.length !== 1) {
            return { ok: false, error: 'Usage: /team [name] | /team delete <name>' };
          }
          const nameCheck = validateName(targetName, 'team');
          if (!nameCheck.valid) {
            return { ok: false, error: nameCheck.error };
          }

          const targetTeam = await this.db.teams.getTeamByName(targetName);
          if (!targetTeam) {
            return {
              ok: false,
              error: `Team ${targetName} not found. Create configs/${targetName}.yaml and run :deploy ${targetName}, or :sync ${targetName} to materialize an existing YAML.`
            };
          }

          const targetAgentCount = await this.db.agents.count(targetTeam.id);
          return {
            ok: true,
            result: {
              id: targetTeam.id,
              name: targetTeam.name,
              agentCount: parseInt(targetAgentCount || '0'),
              switched: true
            }
          };
        }

        const team = await this.db.teams.getTeam(teamId);
        if (!team) {
          return { ok: false, error: 'Team not found' };
        }
        const agentCount = await this.db.agents.count(teamId);
        return {
          ok: true,
          result: {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0')
          }
        };
      }

      case 'meta': {
        // /meta <agent> - show metadata
        // /meta set <agent> <key> <value> - set metadata key
        // /meta setid <agent> <domain> [tokenId] - set agent identity
        const subCmd = args[0];

        if (subCmd === 'set') {
          const agentName = args[1];
          const key = args[2];
          const value = args.slice(3).join(' ');
          if (!agentName || !key) {
            return { ok: false, error: 'Usage: /meta set <agent> <key> <value>' };
          }
          const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
          if (!agent) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          const newMetadata = { ...(agent.metadata || {}), [key]: value || null };
          // When setting 'endpoint', also update the endpoint column (used for routing)
          if (key === 'endpoint') {
            await this.db.agents.updateIdentity(agent.id, {
              endpoint: value || undefined,
              metadata: newMetadata,
            });
          } else {
            await this.db.agents.updateMetadata(agent.id, newMetadata);
          }
          return { ok: true, result: { name: agent.name, metadata: newMetadata } };
        }

        if (subCmd === 'setid') {
          const agentName = args[1];
          const domainArg = args[2];
          const tokenIdArg = args[3];
          if (!agentName || !domainArg) {
            return { ok: false, error: 'Usage: /meta setid <agent> <domain> [tokenId]' };
          }
          const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
          if (!agent) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          await this.db.agents.updateIdentity(agent.id, {
            domain: domainArg,
            token_id: tokenIdArg || undefined,
          });
          return { ok: true, result: { name: agent.name, domain: domainArg, tokenId: tokenIdArg || null } };
        }

        // /meta <agent> - show metadata
        const agentName = subCmd;
        if (!agentName) {
          return { ok: false, error: 'Usage: /meta <agent> or /meta set <agent> <key> <value>' };
        }
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        return {
          ok: true,
          result: {
            name: agent.name,
            id: agent.id,
            tokenId: agent.token_id,
            domain: agent.domain,
            metadata: agent.metadata
          }
        };
      }

      case 'cancel': {
        // /cancel <agent> - Cancel running query
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /cancel <agent-name>' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }

        const agent = matches[0];
        const baseEndpoint = agent.endpoint || `http://localhost:${agent.port}`;

        // Write the cancellation marker BEFORE killing the running query so it
        // shows up before the agent's /cancel handler races the process kill.
        // Two writes for two surfaces:
        //   1. Agent-owned row → visible in the TUI's per-agent NewsView
        //      (which fetches /news <agent> → the agent's local /news, which
        //      reads news_items keyed by agent_id).
        //   2. Manager-inbox-owned row → visible to any operator-side tool
        //      that reads the team-level GET /news feed.
        // May duplicate the agent's own /cancel news entry (claude-agent-server
        // line 817) in the no-race case; the duplication is intentional so the
        // marker is guaranteed even when the kill wins the race.
        {
          const cancelTs = Date.now();
          const managerInbox = this.getManagerInboxRef(teamId, teamName);
          await this.db.news.add(teamId, null, {
            timestamp: cancelTs,
            type: 'query.cancelled',
            message: `Cancelled by operator: ${agent.name}`,
            data: { reason: 'operator_cancel', agent: agent.name },
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
          await this.db.news.add(teamId, agent.id, {
            timestamp: cancelTs,
            type: 'query.cancelled',
            message: 'Cancelled by operator',
            data: { reason: 'operator_cancel', agent: agent.name },
          });
        }

        try {
          const cancelResp = await fetch(`${baseEndpoint}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (!cancelResp.ok) {
            const err = await cancelResp.text();
            return { ok: false, error: `Cancel failed: ${err}` };
          }

          const result = await cancelResp.json() as any;
          return { ok: true, result: { agent: agent.name, ...result } };
        } catch (err: any) {
          return { ok: false, error: `Failed to cancel: ${err.message}` };
        }
      }

      case 'clear': {
        // /clear <agent> - Clear agent session
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /clear <agent-name>' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }

        const agent = matches[0];
        const baseEndpoint = agent.endpoint || `http://localhost:${agent.port}`;

        try {
          const clearResp = await fetch(`${baseEndpoint}/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (!clearResp.ok) {
            const err = await clearResp.text();
            return { ok: false, error: `Clear failed: ${err}` };
          }

          return { ok: true, result: { agent: agent.name, message: 'Session cleared' } };
        } catch (err: any) {
          return { ok: false, error: `Failed to clear session: ${err.message}` };
        }
      }

      case 'list': {
        // /list - Show all pending queries
        const newsItems = await this.db.news.getRecent(teamId, ['query', 'query.pending', 'pending_question'], 50);

        return {
          ok: true,
          result: {
            queries: newsItems.map((r: any) => ({
              id: r.query_id || r.id,
              type: r.type,
              message: r.message,
              timestamp: Number(r.timestamp),
              from: r.data?.from
            }))
          }
        };
      }

      case 'update': {
        // /update <agent> --wallet <address> --name <newname>
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /update <agent> [--wallet <address>] [--name <newname>]' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }
        const agent = matches[0];
        const updates: string[] = [];
        const newMetadata = { ...agent.metadata };

        // Parse --wallet and --name flags
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--wallet' && args[i + 1]) {
            const walletAddr = args[i + 1];
            newMetadata.ows_address = walletAddr;
            updates.push(`wallet → ${walletAddr}`);
            i++;
          } else if (args[i] === '--name' && args[i + 1]) {
            const newName = args[i + 1];
            const nameCheck = validateName(newName, 'agent');
            if (!nameCheck.valid) return { ok: false, error: nameCheck.error };
            await this.db.agents.updateIdentity(agent.id, { name: newName });
            newMetadata.alias = newMetadata.alias || agent.name;
            updates.push(`name → ${newName}`);
            i++;
          }
        }

        if (updates.length === 0) {
          return { ok: false, error: 'Nothing to update. Use --wallet <address> or --name <newname>' };
        }

        await this.db.agents.updateMetadata(agent.id, newMetadata);

        return { ok: true, result: { message: `Updated ${agent.name}: ${updates.join(', ')}` } };
      }

      case 'task': {
        const subCmd = args[0]?.toLowerCase() || 'list';

        if (subCmd === 'create') {
          // /task create "<title>" [--name <slug>] [--description "..."] [--team <team>] [--owner <agent>] [--event <schedule-id>]...
          const rawArgs = args.slice(1);
          let title: string | undefined;
          let name: string | undefined;
          let description: string | undefined;
          let teamRef: string | undefined;
          let ownerRef: string | undefined;
          let goalId: string | undefined;
          let expectedOutput: string | undefined;
          const acceptanceCriteria: string[] = [];
          let validationPath: string | undefined;
          let outOfScope: string | undefined;
          let backlogPolicy: string | undefined;
          let bittreesRelevance: string | undefined;
          let parentTask: string | undefined;
          let validationPurpose: string | undefined;
          const eventIds: string[] = [];

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--name') { name = rawArgs[++i]; continue; }
            if (token === '--description') { description = rawArgs[++i]; continue; }
            if (token === '--team') { teamRef = rawArgs[++i]; continue; }
            if (token === '--owner') { ownerRef = rawArgs[++i]; continue; }
            if (token === '--event') { eventIds.push(rawArgs[++i]); continue; }
            if (token === '--goal' || token === '--goal-id') { goalId = rawArgs[++i]; continue; }
            if (token === '--expected-output') { expectedOutput = rawArgs[++i]; continue; }
            if (token === '--acceptance' || token === '--acceptance-criteria') { acceptanceCriteria.push(rawArgs[++i]); continue; }
            if (token === '--validation-path') { validationPath = rawArgs[++i]; continue; }
            if (token === '--out-of-scope') { outOfScope = rawArgs[++i]; continue; }
            if (token === '--backlog-policy') { backlogPolicy = rawArgs[++i]; continue; }
            if (token === '--bittrees-relevance' || token === '--relevance') { bittreesRelevance = rawArgs[++i]; continue; }
            if (token === '--parent-task' || token === '--parent-ref') { parentTask = rawArgs[++i]; continue; }
            if (token === '--validation-purpose') { validationPurpose = rawArgs[++i]; continue; }
            if (!title) { title = token; continue; }
          }

          if (!title) {
            return { ok: false, error: 'Usage: /task create "<title>" [--name <slug>] [--description "..."] [--team <team>] [--owner <agent>] [--event <schedule-id>]...' };
          }

          // Resolve optional team first (needed for name uniqueness check)
          let taskTeamId: string = teamId;
          if (teamRef) {
            const teamRow = await this.db.teams.getTeamByName(teamRef);
            if (!teamRow) return { ok: false, error: `Team "${teamRef}" not found` };
            taskTeamId = teamRow.id;
          }

          const taskDescription = appendTaskBriefFieldsToDescription(description, {
            title,
            description,
            goal_id: goalId,
            expected_output: expectedOutput,
            acceptance_criteria: acceptanceCriteria,
            validation_path: validationPath,
            out_of_scope: outOfScope,
            backlog_policy: backlogPolicy,
            bittrees_relevance: bittreesRelevance,
            parent_task: parentTask,
            validation_purpose: validationPurpose,
          });
          const brief = this.validateIncomingTaskBrief({
            title,
            description: taskDescription,
            goal_id: goalId,
            expected_output: expectedOutput,
            acceptance_criteria: acceptanceCriteria,
            validation_path: validationPath,
            out_of_scope: outOfScope,
            backlog_policy: backlogPolicy,
            bittrees_relevance: bittreesRelevance,
            parent_task: parentTask,
            validation_purpose: validationPurpose,
          }, { immediateExecution: Boolean(ownerRef) });
          if (brief.blocked) {
            return {
              ok: false,
              error: 'task_brief_not_dispatch_ready',
              result: { brief_validation: brief.validation },
            };
          }

          // Generate name from title if not provided
          if (!name) {
            name = normalizeAlias(title);
            // Ensure uniqueness by appending numeric suffix on conflict (scoped to team)
            let candidate = name;
            let suffix = 1;
            while (await this.db.tasks.getByNameForTeam(candidate, taskTeamId)) {
              candidate = `${name}-${suffix++}`;
            }
            name = candidate;
          } else {
            name = normalizeAlias(name);
            if (await this.db.tasks.getByNameForTeam(name, taskTeamId)) {
              return { ok: false, error: `Task name "${name}" already exists in this team` };
            }
          }

          // Resolve optional owner
          let ownerId: string | null = null;
          let ownerAgentForGuard: AgentRow | null = null;
          if (ownerRef) {
            const resolveTeam = taskTeamId || teamId;
            const { agent, error } = await this.resolveSingleAgentForCommand(resolveTeam, ownerRef);
            if (!agent) return { ok: false, error: error || `Agent "${ownerRef}" not found` };
            ownerAgentForGuard = agent;
            if (await this.hasDoingTaskRoom(taskTeamId)) {
              ownerId = agent.id;
            }
          }

          let callerAgentForGuard: AgentRow | null = null;
          if (callerFrom) {
            const { agent: callerAgent } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
            callerAgentForGuard = callerAgent ?? null;
          }
          const validatorGuard = await this.validateValidatorChildTaskCreation({
            teamId: taskTeamId,
            input: {
              title,
              description: taskDescription,
              parent_task: parentTask,
              validation_purpose: validationPurpose,
            },
            fromAgent: callerAgentForGuard,
            targetAgent: ownerAgentForGuard,
          });
          if (validatorGuard) {
            return {
              ok: false,
              error: validatorGuard.code,
              result: {
                message: validatorGuard.message,
                ...(validatorGuard.existingTask ? { existing_task: validatorGuard.existingTask } : {}),
              },
            };
          }

          // Validate event links
          for (const eid of eventIds) {
            const sDef = await this.db.schedules.getDefinition(eid);
            if (!sDef) return { ok: false, error: `Schedule "${eid}" not found` };
            if (sDef.kind !== 'calendar') return { ok: false, error: `Schedule "${eid}" is not a calendar event (kind: ${sDef.kind})` };
          }

          const now = Math.floor(Date.now() / 1000);
          const status = ownerId ? 'doing' : 'todo';
          const queuedByDoingLimit = Boolean(ownerRef && !ownerId);
          // Resolve created_by from callerFrom if present
          let createdBy: string | null = null;
          if (callerFrom) {
            const callerAgent = callerAgentForGuard
              || (await this.resolveSingleAgentForCommand(teamId, callerFrom)).agent;
            if (callerAgent) createdBy = callerAgent.id;
          }

          const taskRow: TaskRow = {
            id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            name,
            uuid: crypto.randomUUID(),
            team_id: taskTeamId,
            title,
            description: taskDescription,
            status,
            created_by: createdBy,
            owner: ownerId,
            created_at: now,
            updated_at: now,
            completed_at: null,
          };

          await this.db.tasks.create(taskRow, eventIds.length > 0 ? eventIds : undefined);

          return {
            ok: true,
            result: {
              task: await this.buildTaskResult(taskRow, teamId),
              warning: queuedByDoingLimit ? await this.doingTaskLimitMessage(taskTeamId) : undefined,
              brief_validation: brief.validation,
            },
          };
        }

        if (subCmd === 'list') {
          // /task list [--status todo|doing|done] [--owner <agent>] [--team <team>]
          const rawArgs = args.slice(1);
          let statusFilter: 'todo' | 'doing' | 'done' | undefined;
          let ownerFilter: string | undefined;
          let teamFilter: string | undefined;

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--status') { statusFilter = rawArgs[++i] as any; continue; }
            if (token === '--owner') { ownerFilter = rawArgs[++i]; continue; }
            if (token === '--team') { teamFilter = rawArgs[++i]; continue; }
          }

          // Resolve owner id
          let ownerIdFilter: string | undefined;
          if (ownerFilter) {
            const { agent, error } = await this.resolveSingleAgentForCommand(teamId, ownerFilter);
            if (!agent) return { ok: false, error: error || `Agent "${ownerFilter}" not found` };
            ownerIdFilter = agent.id;
          }

          // Resolve team id — default to current team for scoped resolution
          let teamIdFilter: string = teamId;
          if (teamFilter) {
            const teamRow = await this.db.teams.getTeamByName(teamFilter);
            if (!teamRow) return { ok: false, error: `Team "${teamFilter}" not found` };
            teamIdFilter = teamRow.id;
          }

          const tasks = await this.db.tasks.list({
            status: statusFilter,
            owner: ownerIdFilter,
            teamId: teamIdFilter,
          });

          const results = [];
          for (const t of tasks) {
            results.push(await this.buildTaskResult(t, teamId));
          }

          return { ok: true, result: { tasks: results } };
        }

        if (subCmd === 'assign') {
          // /task assign <task-name> <agent> [--team <team>]
          const taskName = args[1];
          const agentRef = args[2];
          if (!taskName || !agentRef) {
            return { ok: false, error: 'Usage: /task assign <task-name|#shortid> <agent> [--team <team>]' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskName, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskName}" not found` };

          // Check for --team flag
          let resolveTeam = teamId;
          for (let i = 3; i < args.length; i++) {
            if (args[i] === '--team' && args[i + 1]) {
              const teamRow = await this.db.teams.getTeamByName(args[i + 1]);
              if (!teamRow) return { ok: false, error: `Team "${args[i + 1]}" not found` };
              resolveTeam = teamRow.id;
              break;
            }
          }

          const { agent, error } = await this.resolveSingleAgentForCommand(resolveTeam, agentRef);
          if (!agent) return { ok: false, error: error || `Agent "${agentRef}" not found` };

          const now = Math.floor(Date.now() / 1000);
          if (task.status !== 'doing' && !(await this.hasDoingTaskRoom(task.team_id || teamId))) {
            return { ok: false, error: await this.doingTaskLimitMessage(task.team_id || teamId) };
          }
          await this.db.tasks.updateFields(task.id, {
            owner: agent.id,
            status: 'doing',
            updated_at: now,
          });

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          const teamRow = await this.db.teams.getTeam(teamId).catch(() => null);
          void this.maybeTriggerValidatorRecommendationLoop({
            teamId,
            teamName: teamRow?.name || 'default',
            task: updated!,
            completionPayload: {},
          });
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId) } };
        }

        if (subCmd === 'claim') {
          // /task claim <task-name|#shortid> (agent API via /remote with from field)
          const taskRef = args[1];
          if (!taskRef) {
            return { ok: false, error: 'Usage: /task claim <task-name|#shortid>' };
          }

          if (!callerFrom) {
            return { ok: false, error: 'Claim requires agent identity. Use /remote with a "from" field.' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          // Cross-team claim guard
          if (task.team_id && task.team_id !== teamId) {
            return { ok: false, error: `Task "${taskRef}" not found` };
          }

          // Resolve caller agent
          const { agent: callerAgent, error: callerError } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
          if (!callerAgent) return { ok: false, error: callerError || `Caller agent "${callerFrom}" not found` };

          const claimBrief = this.validateIncomingTaskBrief(this.taskBriefInputFromTask(task));
          if (claimBrief.blocked && !this.canClaimMalformedBriefForRepair(teamName, callerAgent, task)) {
            return {
              ok: false,
              error: 'task_brief_not_dispatch_ready',
              result: { brief_validation: claimBrief.validation },
            };
          }

          const now = Math.floor(Date.now() / 1000);
          const claimed = await this.db.tasks.claim(task.id, callerAgent.id, now, {
            maxDoingForTeam: this.getMaxDoingTasks(),
          });
          if (!claimed) {
            const current = await this.db.tasks.getByNameForTeam(task.name, teamId);
            if (current?.status === 'todo' && !current.owner && !(await this.hasDoingTaskRoom(teamId))) {
              return { ok: false, error: await this.doingTaskLimitMessage(teamId) };
            }
            return { ok: false, error: `Cannot claim "${task.name}" — task is already owned or not in todo status` };
          }

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId), brief_validation: claimBrief.validation } };
        }

        if (subCmd === 'done') {
          // /task done <task-name|#shortid> [--acceptance "..."] [--failure-note "..."] [--delegated-task-names "child-a,child-b"]
          // Manager can mark any task done; agent can only mark its own task done
          const taskRef = args[1];
          if (!taskRef) {
            return { ok: false, error: 'Usage: /task done <task-name|#shortid> [--acceptance "..."] [--failure-note "..."] [--delegated-task-names "child-a,child-b"]' };
          }
          const acceptanceCoverage: string[] = [];
          const delegatedTaskNames: string[] = [];
          let failureNote: string | undefined;
          let noDelegationReason: string | undefined;
          let advisoryQuery = false;
          for (let i = 2; i < args.length; i++) {
            const token = args[i];
            if (token === '--acceptance' || token === '--acceptance-coverage') { acceptanceCoverage.push(args[++i]); continue; }
            if (token === '--failure-note' || token === '--failure') { failureNote = args[++i]; continue; }
            if (token === '--delegated-task-names' || token === '--child-task-names' || token === '--delegated-tasks' || token === '--child-tasks') {
              const value = args[++i] || '';
              delegatedTaskNames.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
              continue;
            }
            if (token === '--delegated-task' || token === '--child-task') {
              const value = args[++i];
              if (value) delegatedTaskNames.push(value);
              continue;
            }
            if (token === '--no-delegation-reason') { noDelegationReason = args[++i]; continue; }
            if (token === '--advisory-query') { advisoryQuery = true; continue; }
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          // Cross-team done guard
          if (task.team_id && task.team_id !== teamId) {
            return { ok: false, error: `Task "${taskRef}" not found` };
          }

          // If called by an agent (callerFrom set), enforce ownership
          if (callerFrom) {
            const { agent: callerAgent } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
            if (callerAgent && task.owner !== callerAgent.id) {
              return { ok: false, error: `Agent "${callerFrom}" is not the owner of task "${task.name}"` };
            }
          }

          const completionPayload = {
            acceptance_coverage: acceptanceCoverage,
            delegated_task_names: delegatedTaskNames,
            failure_note: failureNote,
            no_delegation_reason: noDelegationReason,
            advisory_query: advisoryQuery,
          };
          const completion = this.validateCompletionPayload(completionPayload);
          if (completion.blocked) {
            return {
              ok: false,
              error: 'task_completion_packet_required',
              result: { completion_validation: completion.validation },
            };
          }

          const teamRow = await this.db.teams.getTeam(teamId).catch(() => null);
          const delegationError = await this.validateTeamLeadDelegationBeforeDone({
            teamId,
            teamName: teamRow?.name || 'default',
            task,
            payload: completionPayload,
          });
          if (delegationError) {
            return { ok: false, error: delegationError };
          }

          const now = Math.floor(Date.now() / 1000);
          await this.db.tasks.updateFields(task.id, {
            status: 'done',
            completed_at: now,
            updated_at: now,
          });

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId), completion_validation: completion.validation } };
        }

        if (subCmd === 'status') {
          // /task status <task-name|#shortid> <todo|doing|done>
          // Sets the status field directly. Does not touch `owner` — use
          // /task assign or /task claim to change ownership.
          const taskRef = args[1];
          const newStatus = args[2]?.toLowerCase();
          if (!taskRef || !newStatus) {
            return { ok: false, error: 'Usage: /task status <task-name|#shortid> <todo|doing|done>' };
          }
          if (newStatus !== 'todo' && newStatus !== 'doing' && newStatus !== 'done') {
            return { ok: false, error: `Invalid status "${newStatus}". Must be todo, doing, or done.` };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          if (task.team_id && task.team_id !== teamId) {
            return { ok: false, error: `Task "${taskRef}" not found` };
          }

          if (newStatus === 'done') {
            const completion = this.validateCompletionPayload({});
            if (completion.blocked) {
              return {
                ok: false,
                error: 'task_completion_packet_required',
                result: { completion_validation: completion.validation },
              };
            }
          }

          const now = Math.floor(Date.now() / 1000);
          await this.db.tasks.updateFields(task.id, {
            status: newStatus,
            completed_at: newStatus === 'done' ? now : null,
            updated_at: now,
          });

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId) } };
        }

        if (subCmd === 'remove' || subCmd === 'delete') {
          // /task remove <task-name|#shortid>
          // /task remove *                  → delete all tasks in active team
          // /task remove --team <team>      → delete all tasks in named team
          const first = args[1];
          if (!first) {
            return { ok: false, error: 'Usage: /task remove <task-name|#shortid> | /task remove * | /task remove --team <team>' };
          }

          if (first === '*') {
            const tasks = await this.db.tasks.list({ teamId });
            const removed: string[] = [];
            for (const t of tasks) {
              await this.db.tasks.delete(t.id);
              removed.push(t.name);
            }
            return { ok: true, result: { removed, count: removed.length, scope: 'active-team' } };
          }

          if (first === '--team') {
            const teamRef = args[2];
            if (!teamRef) {
              return { ok: false, error: 'Usage: /task remove --team <team>' };
            }
            const teamRow = await this.db.teams.getTeamByName(teamRef);
            if (!teamRow) return { ok: false, error: `Team "${teamRef}" not found` };
            const tasks = await this.db.tasks.list({ teamId: teamRow.id });
            const removed: string[] = [];
            for (const t of tasks) {
              await this.db.tasks.delete(t.id);
              removed.push(t.name);
            }
            return { ok: true, result: { removed, count: removed.length, team: teamRow.name } };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(first, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${first}" not found` };

          await this.db.tasks.delete(task.id);
          return { ok: true, result: { removed: task.name } };
        }

        return {
          ok: false,
          error: 'Usage: /task <create|list|assign|claim|done|remove|delete> ...',
        };
      }

      default:
        return { ok: false, error: `Unknown command: ${action}. Available: agents, status, schedule, delete, ask, hey, news, register, deploy, agent, model, tasks, task, configs, registry, teams, team, keys, meta, pay, heartbeat, heartbeats, cancel, clear, list, update, sync-wallets` };
    }
  }

  /**
   * Derive a health status string for a remote-endpoint agent from its DB probe columns.
   */
  private deriveRemoteHealth(a: AgentRow): 'online' | 'unstable' | 'offline' | 'unknown' {
    if (a.last_probed_at == null) return 'unknown';
    if (a.consecutive_failures === 0) return 'online';
    if (a.consecutive_failures <= 2) return 'unstable';
    return 'offline';
  }

  /**
   * Get health info for an agent to include in API responses.
   */
  private getHealthForAgent(a: AgentRow): { health: string; lastHealthCheck: number | null } {
    const key = `${a.team_id}:${a.id}`;
    const h = this.healthStatus.get(key);
    if (!h) return { health: 'unknown', lastHealthCheck: null };
    return { health: h.status, lastHealthCheck: h.lastCheck };
  }

  /**
   * Start periodic health monitoring of all running agents (every 30s).
   * Also starts the remote heartbeat loop in parallel.
   */
  private startHealthMonitor(): void {
    // Run immediately, then every 30 seconds
    this.runHealthChecks();
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), 30_000);

    // Remote probe loop — same cadence, parallel to local loop
    this.runRemoteHeartbeat();
    this.remoteProbeInterval = setInterval(() => this.runRemoteHeartbeat(), 30_000);
  }

  /**
   * Start the stuck-query sweeper.
   *
   * Agents that crash mid-query never transition their queries out of
   * 'pending'/'processing' (the agent process is the thing that would have
   * written 'completed' or 'failed'). Without this sweeper the queries table
   * accumulates ghosts and callers polling /query/:id see 'pending' forever.
   *
   * We run every 5 minutes and mark any pending/processing query older than
   * QUERY_EXPIRY_MINUTES as 'expired'. See expireStale() for the actual SQL.
   */
  private startQuerySweeper(): void {
    const intervalMs = 5 * 60 * 1000;
    const runSweep = () => {
      this.sweepStaleQueries().catch((err) => {
        console.error('[Manager] Query sweeper failed:', err);
      });
    };
    runSweep();
    this.querySweeperInterval = setInterval(runSweep, intervalMs);
  }

  /**
   * Always-on supervision sweep: re-nudge tasks stuck in 'doing'. Conservative by design —
   * long stall threshold + long re-nudge throttle + a per-sweep cap — so it never spams the
   * fleet. Disable with STALL_SWEEP_DISABLED=true. This is the manager-side counterpart to the
   * control center's auto-pilot, so reconcile runs even when no UI is open.
   */
  private startStalledTaskSweeper(): void {
    if (process.env.STALL_SWEEP_DISABLED === 'true') return;
    const intervalMs = 5 * 60 * 1000;
    const run = () => { this.sweepStalledTasks().catch((e) => console.error('[Manager] Stalled-task sweep failed:', e)); };
    setTimeout(run, 90_000); // let the fleet settle after boot before the first sweep
    this.stalledSweepInterval = setInterval(run, intervalMs);
  }

  private isLiveForSupervision(agent: AgentRow | null | undefined): agent is AgentRow {
    return !!agent && /running|online|ok/i.test(agent.status || '');
  }

  private isPrimaryLead(agent: AgentRow): boolean {
    return (agent.metadata as AgentMetadata | null | undefined)?.primaryLead === true;
  }

  private findConfiguredGroupLead(org: OrgConfig | null | undefined): string | null {
    if (!org?.groups) return null;
    const stack = Object.values(org.groups);
    while (stack.length > 0) {
      const group = stack.shift();
      if (!group) continue;
      if (typeof group.lead === 'string' && group.lead.trim()) return group.lead.trim();
      if (group.groups) stack.push(...Object.values(group.groups));
    }
    return null;
  }

  private async findSupervisionLead(teamId: string): Promise<AgentRow | null> {
    const agents = await this.db.agents.list(teamId).catch(() => [] as AgentRow[]);
    const live = agents.filter((agent) => this.isLiveForSupervision(agent));

    const flagged = agents.filter((agent) => this.isPrimaryLead(agent));
    const liveFlagged = flagged.filter((agent) => this.isLiveForSupervision(agent));
    if (liveFlagged.length > 1) {
      console.warn(`[Supervision] Multiple live primary lead agents configured for team ${teamId}; using ${liveFlagged[0].name}`);
    }
    if (liveFlagged.length > 0) return liveFlagged[0];
    if (flagged.length > 1) {
      console.warn(`[Supervision] Multiple primary lead agents configured for team ${teamId}, but none are live`);
    }

    const teamConfig = await this.db.teams.getConfig(teamId).catch(() => ({} as Record<string, unknown>));
    const configuredLead = this.findConfiguredGroupLead(teamConfig.org as OrgConfig | undefined);
    if (configuredLead) {
      const groupLead = await this.db.agents.getByName(teamId, configuredLead).catch(() => null);
      if (this.isLiveForSupervision(groupLead)) return groupLead;
    }

    const explicit = await this.resolveSingleAgentForCommand(teamId, 'lead').catch(
      (): { agent?: AgentRow; error?: string } => ({}),
    );
    if (this.isLiveForSupervision(explicit.agent)) return explicit.agent;

    return (
      live.find((agent) => /(^|[-_\s])lead$/i.test(agent.name)) ||
      live.find((agent) => /lead/i.test(agent.name)) ||
      live.find((agent) => /manager|coordinator/i.test(agent.name)) ||
      live[0] ||
      null
    );
  }

  private async sendSupervisionAsk(teamName: string, agentName: string, message: string): Promise<boolean> {
    const quoted = `"${message.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    try {
      const res = await fetch(`http://127.0.0.1:${this.managementPort}/remote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Id-Admin': '1', 'X-Id-Team': teamName },
        body: JSON.stringify({ command: `/ask ${agentName} ${quoted}` }),
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private taskShortRef(task: TaskRow): string {
    return task.uuid ? `#${task.uuid.replace(/-/g, '').slice(0, 8)}` : task.name;
  }

  private taskTimestampMs(timestamp: number): number {
    return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  }

  private taskLastActivityMs(task: TaskRow): number {
    return this.taskTimestampMs(task.updated_at || task.created_at || 0);
  }

  private async recordTaskSupervision(
    task: TaskRow,
    teamId: string,
    actorAgentId: string | null,
    reason: 'owner_refresh' | 'owner_unavailable' | 'unclaimed' | 'checkin_heartbeat_probe' | 'probe_limit_reached' | 'validator_stalled_terminal' | 'lead_delegation_required' | 'lead_owner_unavailable',
    stalledMinutes: number,
    nowMs: number,
  ): Promise<void> {
    const input = {
      teamId,
      taskUuid: task.uuid,
      taskName: task.name,
      title: task.title,
      ownerAgentId: task.owner,
      actorAgentId,
      occurredAt: nowMs,
      reason,
      stalledMinutes,
    };
    if (reason === 'owner_refresh' || reason === 'checkin_heartbeat_probe') {
      await emitTaskRefreshed(this.db.events, input);
    } else {
      await emitTaskTriaged(this.db.events, input);
    }
  }

  private async closeStalledValidatorTaskTerminal(params: {
    task: TaskRow;
    teamRow: { id: string; name: string };
    ownerAgent: AgentRow | null;
    stalledMinutes: number;
    nowMs: number;
    maxProbes: number;
  }): Promise<boolean> {
    const validatorName = this.defaultValidatorName(params.ownerAgent);
    if (!validatorName) return false;
    if (!this.isValidationTask(params.task)) return false;

    const nowSec = Math.floor(params.nowMs / 1000);
    const failureNote = `stalled_validation_terminal: ${validatorName} remained processing after ${params.maxProbes} bounded probe(s) and one retry over ${params.stalledMinutes}m; closed without automatic redispatch.`;
    await this.db.tasks.updateFields(params.task.id, {
      status: 'done',
      completed_at: nowSec,
      updated_at: nowSec,
    });
    await emitTaskCompleted(this.db.events, {
      teamId: params.teamRow.id,
      taskUuid: params.task.uuid,
      taskName: params.task.name,
      title: params.task.title,
      ownerAgentId: params.task.owner ?? null,
      actorAgentId: params.ownerAgent?.id ?? params.task.owner ?? null,
      occurredAt: params.nowMs,
      failureNote,
    });
    await closeLinkedCheckinsForTerminalTask(this.db, {
      teamId: params.teamRow.id,
      taskId: params.task.id,
      taskStatus: 'done',
      actorAgentId: params.ownerAgent?.id ?? params.task.owner ?? null,
      occurredAt: params.nowMs,
    });
    await this.recordTaskSupervision(
      params.task,
      params.teamRow.id,
      params.ownerAgent?.id ?? params.task.owner ?? null,
      'validator_stalled_terminal',
      params.stalledMinutes,
      params.nowMs,
    );
    this.managerLog(`Closed stalled validation task ${params.task.name}: ${failureNote}`);
    return true;
  }

  private hasExhaustedCheckinProbe(checkins: CheckinRow[], maxProbes: number): boolean {
    return checkins.some((checkin) => this.canEscalateStalledProbe(`checkin:${checkin.id}`, maxProbes));
  }

  private markCheckinProbeEscalated(checkins: CheckinRow[], nowMs: number, maxProbes: number): void {
    for (const checkin of checkins) {
      const key = `checkin:${checkin.id}`;
      if (this.canEscalateStalledProbe(key, maxProbes)) {
        this.markStalledProbeEscalated(key, nowMs);
      }
    }
  }

  private async probeStalledTaskCheckins(
    task: TaskRow,
    teamRow: { id: string; name: string },
    checkins: CheckinRow[],
    stalledMinutes: number,
    nowMs: number,
    renudgeMs: number,
    maxProbes: number,
  ): Promise<boolean> {
    for (const checkin of checkins) {
      if (checkin.status !== 'active') continue;
      if (!checkin.owner_agent_id) continue;
      if (checkin.max_iterations !== null && checkin.iteration_count >= checkin.max_iterations) continue;
      const key = `checkin:${checkin.id}`;
      if (!this.canRunStalledProbe(key, nowMs, renudgeMs, maxProbes)) continue;
      this.markStalledProbe(key, nowMs);
      await this.db.checkins.updateFields(checkin.id, teamRow.id, {
        next_fire_at: Math.min(checkin.next_fire_at ?? nowMs, nowMs),
        updated_at: nowMs,
      });
      await this.recordTaskSupervision(
        task,
        teamRow.id,
        checkin.owner_agent_id,
        'checkin_heartbeat_probe',
        stalledMinutes,
        nowMs,
      );
      return true;
    }
    return false;
  }

  private async sweepStalledTasks(): Promise<void> {
    const STALL_MS = Number(process.env.STALL_SWEEP_MS) || 45 * 60 * 1000;     // 'doing' this long with no update
    const RENUDGE_MS = Number(process.env.STALL_RENUDGE_MS) || 90 * 60 * 1000; // don't re-nudge a task within this
    const MAX_PER_SWEEP = Math.max(1, Number(process.env.STALL_SWEEP_MAX_PER_SWEEP) || 2);
    const MAX_PROBES = this.getMaxStalledTaskProbes();
    const now = Date.now();
    const doing = await this.db.tasks.list({ status: 'doing' }).catch(() => [] as TaskRow[]);
    let nudged = 0;
    for (const t of doing) {
      if (nudged >= MAX_PER_SWEEP) break;
      if (!t.owner) continue;
      const updated = this.taskLastActivityMs(t);
      // Resolve owner id → agent name + the task's team name for the dispatch.
      const ownerAgent = await this.db.agents.getById(t.owner).catch(() => null);
      const ownerName = ownerAgent?.name || t.owner;
      const teamRow = t.team_id ? await this.db.teams.getTeam(t.team_id).catch(() => null) : null;
      if (!teamRow) continue;
      const teamName = teamRow?.name || 'default';
      const ref = this.taskShortRef(t);
      const mins = Math.round((now - updated) / 60000);

      if (this.isLiveForSupervision(ownerAgent) && this.isConfiguredTeamLead(teamName, ownerAgent)) {
        const nudgeKey = `task:${t.id}:lead-delegation`;
        const canRun = this.canRunStalledProbe(nudgeKey, now, RENUDGE_MS, MAX_PROBES);
        const canEscalate = !canRun && this.canEscalateStalledProbe(nudgeKey, MAX_PROBES);
        if (canRun || canEscalate) {
          const attempt = canRun ? this.markStalledProbe(nudgeKey, now) : MAX_PROBES;
          const msg = await this.buildLeadDelegationNudge(
            t,
            teamRow.id,
            teamName,
            ownerAgent,
            ref,
            attempt,
            MAX_PROBES,
            mins,
          );
          if (msg) {
            if (canEscalate) this.markStalledProbeEscalated(nudgeKey, now);
            if (await this.sendSupervisionAsk(teamName, ownerName, msg)) {
              await this.recordTaskSupervision(
                t,
                teamRow.id,
                ownerAgent.id,
                canEscalate ? 'probe_limit_reached' : 'lead_delegation_required',
                mins,
                now,
              );
              nudged++;
            }
            continue;
          }
          if (canRun) this.stalledNudges.delete(nudgeKey);
        }
      }

      if (!this.isLiveForSupervision(ownerAgent) && this.isConfiguredTeamLead(teamName, ownerAgent)) {
        const audit = await this.buildDelegationAudit(t, teamRow.id, teamName, ownerAgent);
        if (audit?.status === 'needs-delegation') {
          const nowSec = Math.floor(now / 1000);
          await this.db.tasks.updateFields(t.id, {
            status: 'todo',
            owner: null,
            updated_at: nowSec,
          });
          await this.recordTaskSupervision(
            t,
            teamRow.id,
            t.owner ?? null,
            'lead_owner_unavailable',
            mins,
            now,
          );
          this.managerLog(`Parked lead-owned task ${t.name}: owner ${ownerName} is unavailable and no delegated child task was detected`);
          nudged++;
          continue;
        }
      }

      if (now - updated < STALL_MS) continue;

      // Heartbeat probes for checkin-supervised stalled work. A linked checkin
      // remains the single owner-facing supervisor; the sweeper only pulls its
      // next fire forward, bounded by the same max-probe guard as direct nudges.
      const active = await this.db.checkins
        .list({ teamId: teamRow.id, linkedTaskId: t.id, status: ['active'], limit: 5 })
        .catch(() => [] as CheckinRow[]);
      if (active.length) {
        if (await this.probeStalledTaskCheckins(t, teamRow, active, mins, now, RENUDGE_MS, MAX_PROBES)) {
          nudged++;
        } else if (this.hasExhaustedCheckinProbe(active, MAX_PROBES)) {
          this.markCheckinProbeEscalated(active, now, MAX_PROBES);
          if (await this.closeStalledValidatorTaskTerminal({
            task: t,
            teamRow,
            ownerAgent,
            stalledMinutes: mins,
            nowMs: now,
            maxProbes: MAX_PROBES,
          })) {
            nudged++;
          }
        }
        continue;
      }

      const unavailable = ownerAgent ? `owner ${ownerName} is ${ownerAgent.status || 'not live'}` : `owner id ${t.owner} is missing`;
      if (this.isLiveForSupervision(ownerAgent)) {
        const nudgeKey = `task:${t.id}:owner-refresh`;
        if (!this.canRunStalledProbe(nudgeKey, now, RENUDGE_MS, MAX_PROBES)) {
          if (this.canEscalateStalledProbe(nudgeKey, MAX_PROBES)) {
            if (await this.closeStalledValidatorTaskTerminal({
              task: t,
              teamRow,
              ownerAgent,
              stalledMinutes: mins,
              nowMs: now,
              maxProbes: MAX_PROBES,
            })) {
              this.markStalledProbeEscalated(nudgeKey, now);
              nudged++;
              continue;
            }
            const lead = await this.findSupervisionLead(teamRow.id);
            if (lead) {
              this.markStalledProbeEscalated(nudgeKey, now);
              const msg = `Supervision: task ${ref} ("${t.title}") is still in progress after ${MAX_PROBES} stalled owner probes over ${mins}m. Please triage it: close it if finished, unblock it, reassign it, or split it into a new tracked task.`;
              if (await this.sendSupervisionAsk(teamRow.name, lead.name, msg)) {
                await this.recordTaskSupervision(t, teamRow.id, lead.id, 'probe_limit_reached', mins, now);
                nudged++;
              }
            }
          }
          continue;
        }
        const attempt = this.markStalledProbe(nudgeKey, now);
        const msg = `Supervision: task ${ref} ("${t.title}") has been in progress ${mins}m with no completion (probe ${attempt}/${MAX_PROBES}). If the work is done, mark it done now with \`/task done ${ref}\`. If you're blocked, reply briefly with what's blocking it. If it isn't started, start and finish it.`;
        if (await this.sendSupervisionAsk(teamName, ownerName, msg)) {
          await this.recordTaskSupervision(t, teamRow.id, ownerAgent.id, 'owner_refresh', mins, now);
          nudged++;
        }
        continue;
      }

      const lead = await this.findSupervisionLead(teamRow.id);
      if (!lead) continue;
      const nudgeKey = `task:${t.id}:owner-unavailable`;
      if (!this.canRunStalledProbe(nudgeKey, now, RENUDGE_MS, MAX_PROBES)) continue;
      const attempt = this.markStalledProbe(nudgeKey, now);
      const msg = `Supervision: task ${ref} ("${t.title}") has been in progress ${mins}m, but ${unavailable} (triage probe ${attempt}/${MAX_PROBES}). Please triage it: claim it, reassign it, or route it to the right teammate.`;
      if (await this.sendSupervisionAsk(teamRow.name, lead.name, msg)) {
        await this.recordTaskSupervision(t, teamRow.id, lead.id, 'owner_unavailable', mins, now);
        nudged++;
      }
    }

    const todo = nudged < MAX_PER_SWEEP
      ? await this.db.tasks.list({ status: 'todo' }).catch(() => [] as TaskRow[])
      : [];
    for (const t of todo) {
      if (nudged >= MAX_PER_SWEEP) break;
      if (t.owner || !t.team_id) continue;
      const updated = this.taskLastActivityMs(t);
      if (now - updated < STALL_MS) continue;
      const nudgeKey = `todo:${t.id}`;
      if (!this.canRunStalledProbe(nudgeKey, now, RENUDGE_MS, MAX_PROBES)) continue;

      const teamRow = await this.db.teams.getTeam(t.team_id).catch(() => null);
      if (!teamRow) continue;
      const active = await this.db.checkins
        .list({ teamId: teamRow.id, linkedTaskId: t.id, status: ['active', 'snoozed'], limit: 1 })
        .catch(() => [] as CheckinRow[]);
      if (active.length) continue;

      const lead = await this.findSupervisionLead(teamRow.id);
      if (!lead) continue;
      const ref = this.taskShortRef(t);
      const mins = Math.round((now - updated) / 60000);
      const attempt = this.markStalledProbe(nudgeKey, now);
      const msg = `Supervision: unclaimed task ${ref} ("${t.title}") has been waiting ${mins}m with no owner (triage probe ${attempt}/${MAX_PROBES}). Please claim it if it is yours, or route it to the right teammate.`;
      if (await this.sendSupervisionAsk(teamRow.name, lead.name, msg)) {
        await this.recordTaskSupervision(t, teamRow.id, lead.id, 'unclaimed', mins, now);
        nudged++;
      }
    }

    if (nudged < MAX_PER_SWEEP) {
      const teams = await this.db.teams.listTeams().catch(() => []);
      for (const team of teams) {
        if (nudged >= MAX_PER_SWEEP) break;
        const managerInbox = this.getManagerInboxRef(team.id, team.name);
        const pending = await this.db.queries
          .getPendingByOwner(team.id, managerInbox.ownerKind, managerInbox.ownerId)
          .catch(() => [] as QueryRow[]);
        for (const q of pending) {
          if (nudged >= MAX_PER_SWEEP) break;
          if (now - q.created < STALL_MS) continue;
          const nudgeKey = `manager-query:${q.query_id}`;
          if (!this.canRunStalledProbe(nudgeKey, now, RENUDGE_MS, MAX_PROBES)) continue;
          const lead = await this.findSupervisionLead(team.id);
          if (!lead) continue;
          const mins = Math.round((now - q.created) / 60000);
          const prompt = q.prompt ? ` ("${q.prompt.slice(0, 120)}${q.prompt.length > 120 ? '...' : ''}")` : '';
          const attempt = this.markStalledProbe(nudgeKey, now);
          const msg = `Supervision: manager inbox request ${q.query_id}${prompt} has been pending ${mins}m (triage probe ${attempt}/${MAX_PROBES}). Please answer it, claim it, or route it to the right teammate.`;
          if (await this.sendSupervisionAsk(team.name, lead.name, msg)) nudged++;
        }
      }
    }
    // Keep the throttle map from growing without bound.
    if (this.stalledNudges.size > 2000) {
      for (const [k, state] of this.stalledNudges) {
        if (state.attempts < MAX_PROBES && now - state.lastAt > 2 * RENUDGE_MS) {
          this.stalledNudges.delete(k);
        }
      }
    }
    if (nudged) console.log(`[Manager] Stalled-task sweep: probed ${nudged} stalled item(s)`);
  }

  /**
   * Start the event_log retention sweep.
   *
   * Audit #6 (output/security-review-wakeup-service.md): the design promises
   * a 7-day age cap and 100k-events-per-team count cap on `event_log`.
   * This loop enforces both, default every 5 minutes. Constants and env
   * overrides live in src/wakeup-service/retention.ts.
   */
  private startEventLogRetentionSweep(): void {
    this.retentionService = new RetentionService({ events: this.db.events, teams: this.db.teams });
    this.retentionService.start();
  }

  private async sweepStaleQueries(): Promise<void> {
    const cutoff = Date.now() - this.QUERY_EXPIRY_MINUTES * 60 * 1000;
    const expired = await this.db.queries.expireStale(cutoff, ['pending', 'processing']);
    const count = expired.length;
    if (count > 0) {
      const occurredAt = Date.now();
      for (const row of expired) {
        await emitQueryExpired(this.db.events, {
          teamId: row.team_id,
          queryId: row.query_id,
          agentId: row.agent_id,
          occurredAt,
        }).catch((err) => {
          console.error('[Manager] Failed to emit query:expired event:', err);
        });
      }
      this.managerLog(
        `Expired ${count} stale queries older than ${this.QUERY_EXPIRY_MINUTES} minutes`,
      );
      console.log(
        `[Manager] Query sweeper expired ${count} stale queries (>${this.QUERY_EXPIRY_MINUTES} min old)`,
      );
    }
  }

  /**
   * Local-agent health check loop.
   *
   * IMPORTANT: NEVER probe remote-endpoint agents here.  Remote agents
   * (public-agent-remote runtime) are handled exclusively by runRemoteHeartbeat().
   * Attempting to probe them from this path would hit their public internet
   * endpoint from the wrong loop, double-count failures, and bypass the
   * concurrency cap enforced by runRemoteHeartbeat.
   *
   * The isRemoteEndpointRuntime() guard below is the canonical firewall.
   * It MUST remain the first runtime check inside the per-agent loop body.
   */
  private async runHealthChecks(): Promise<void> {
    try {
      const teams = await this.db.teams.listTeams();
      for (const team of teams) {
        const agents = await this.dbListAgents(team.id, true);
        for (const agent of agents) {
          // Skip virtual agents — they don't have a local /health endpoint
          if (agent.type === 'virtual') continue;
          // GUARD: Skip remote-endpoint agents — handled exclusively by runRemoteHeartbeat().
          // This check must come before any network I/O so remote agents can never
          // be reached from this local-heartbeat path.
          if (isRemoteEndpointRuntime(agent.runtime)) continue;

          const key = this.key(team.id, agent.id);
          const agentUrl = agent.type === 'interactive' ? agent.endpoint : `http://localhost:${agent.port}`;

          if (!agentUrl) {
            this.healthStatus.set(key, { status: 'unknown', lastCheck: Date.now() });
            continue;
          }

          try {
            const resp = await fetch(`${agentUrl}/health`, {
              signal: AbortSignal.timeout(3000)
            });
            const isOnline = resp.ok;
            this.healthStatus.set(key, { status: isOnline ? 'online' : 'offline', lastCheck: Date.now() });

            // Update DB status if it changed. A stale local-agent shutdown can
            // leave a replacement process labeled "stopped"; a successful
            // local /health probe is authoritative for local-process liveness.
            if (isOnline && agent.status !== 'running') {
              await this.db.agents.updateStatus(agent.id, 'running');
            } else if (!isOnline && agent.status === 'running') {
              await this.db.agents.updateStatus(agent.id, 'offline');
            }
          } catch {
            this.healthStatus.set(key, { status: 'offline', lastCheck: Date.now() });
            if (agent.status === 'running') {
              await this.db.agents.updateStatus(agent.id, 'offline').catch(() => {});
            }
          }
        }
      }
    } catch (err: any) {
      // Don't crash the interval on transient DB errors
    }
  }

  /**
   * Run a single heartbeat probe tick for all remote-endpoint agents.
   * Probes are bounded to 8 concurrent in-flight requests.
   */
  private async runRemoteHeartbeat(): Promise<void> {
    try {
      const teams = await this.db.teams.listTeams();
      const remoteAgents: Array<{ team: { id: string }; agent: AgentRow }> = [];
      for (const team of teams) {
        const agents = await this.dbListAgents(team.id, true);
        for (const agent of agents) {
          if (isRemoteEndpointRuntime(agent.runtime)) {
            remoteAgents.push({ team, agent });
          }
        }
      }

      // Bounded concurrency: chunks of 8
      const CONCURRENCY = 8;
      for (let i = 0; i < remoteAgents.length; i += CONCURRENCY) {
        const chunk = remoteAgents.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(({ team, agent }) =>
          this.probeOneRemoteAgent(team.id, agent).catch(() => {
            // Swallow errors — don't let one failure kill the loop
          }),
        ));
      }
    } catch {
      // Don't crash the interval on transient DB errors
    }
  }

  /**
   * Probe a single remote agent, persist the result, and update healthStatus.
   */
  private async probeOneRemoteAgent(teamId: string, agent: AgentRow): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await probeRemoteAgent(agent, { fetch: this.healthProbeFn });

    if (result.ok) {
      await this.db.agents.updateProbeResult(agent.id, {
        last_seen: result.last_seen,
        last_probed_at: now,
        last_error: result.last_error,
        consecutive_failures: 0,
      });
      const updated = { ...agent, last_seen: result.last_seen, last_probed_at: now, last_error: result.last_error, consecutive_failures: 0 };
      const health = this.deriveRemoteHealth(updated);
      this.healthStatus.set(this.key(teamId, agent.id), { status: health as any, lastCheck: Date.now() });
    } else {
      const newFailures = (agent.consecutive_failures ?? 0) + 1;
      await this.db.agents.updateProbeResult(agent.id, {
        last_probed_at: now,
        last_error: result.last_error,
        consecutive_failures: newFailures,
      });
      const updated = { ...agent, last_probed_at: now, consecutive_failures: newFailures };
      const health = this.deriveRemoteHealth(updated);
      this.healthStatus.set(this.key(teamId, agent.id), { status: health as any, lastCheck: Date.now() });
    }
  }

  async start(port: number = 4100): Promise<void> {
    this.managementPort = port;
    return new Promise((resolve) => {
      // Create HTTP server from Express app
      this.httpServer = createHttpServer(this.managementApp);
      const keepAliveRaw = Number(process.env.ID_MANAGER_KEEPALIVE_TIMEOUT_MS || 5_000);
      const headersRaw = Number(process.env.ID_MANAGER_HEADERS_TIMEOUT_MS || 10_000);
      const maxRequestsRaw = Number(process.env.ID_MANAGER_MAX_REQUESTS_PER_SOCKET || 500);
      const keepAliveTimeoutMs = Number.isFinite(keepAliveRaw) ? Math.max(1_000, keepAliveRaw) : 5_000;
      this.httpServer.keepAliveTimeout = keepAliveTimeoutMs;
      this.httpServer.headersTimeout = Number.isFinite(headersRaw) ? Math.max(keepAliveTimeoutMs + 1_000, headersRaw) : 10_000;
      this.httpServer.maxRequestsPerSocket = Number.isFinite(maxRequestsRaw) ? Math.max(1, maxRequestsRaw) : 500;

      // Create WebSocket server attached to HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

      this.wss.on('connection', (ws, req) => {
        this.handleWebSocketConnection(ws, req);
      });

      this.httpServer.listen(port, '127.0.0.1', async () => {
        console.log(`\n🚀 ID Agent Manager (DB-backed)`);
        console.log(`===============================`);
        console.log(`Management API: http://localhost:${port}`);
        console.log(`WebSocket: ws://localhost:${port}/ws`);
        console.log(`\n`);

        // Initialize and start the scheduler service
        this.schedulerService = new SchedulerService(this.db, async (agentId: string) => {
          const agent = await this.db.agents.getById(agentId);
          if (!agent) return null;
          if (agent.status !== 'running') {
            return {
              id: agent.id,
              name: agent.name,
              endpoint: agent.endpoint?.replace(/\/+$/, '') ?? '',
              talkPath: '/talk',
              schedulePath: null,
              status: agent.status,
            };
          }
          if (!agent.endpoint) return null;
          const endpoints = await discoverRestAPEndpoints(agent.endpoint);
          return {
            id: agent.id,
            name: agent.name,
            endpoint: agent.endpoint.replace(/\/+$/, ''),
            talkPath: endpoints.talk || '/talk',
            schedulePath: endpoints.schedule || null,
            status: agent.status,
          };
        });
        this.schedulerService.start();

        // Seed well-known teams (idempotent — getOrCreateTeamId is safe to call repeatedly)
        await this.seedWellKnownTeams();
        await this.clearInactiveAgentPids();

        // Rehydrate runtime credential pools and lane cooldowns from team config
        // before any spawned agents select a lane.
        await this.hydrateRuntimeStateFromTeams();

        // Keep the durable default config authoritative for the default-team
        // coder row only. This avoids silent recurrence after one-off repairs
        // while leaving researcher and the rest of the fleet untouched.
        await this.reconcileDefaultCoderRuntimeFromConfig();

        // Start periodic health monitoring (every 30s)
        this.startHealthMonitor();

        // Start stuck-query sweeper (every 5 min, expires >15 min old)
        this.startQuerySweeper();

        // Always-on supervision: re-nudge tasks stuck in 'doing' so reconcile no longer
        // depends on the control center sitting on the Work board.
        this.startStalledTaskSweeper();

        // Start event_log retention sweep (every 5 min, 7d / 100k-per-team caps)
        this.startEventLogRetentionSweep();

        // Start checkin due-service tick (default 30s) so active checkins
        // actually fire instead of accumulating with `next_fire_at <= now`.
        // Wake on every fire: every priority POSTs to the owner's /news
        // with trigger:true so the dispatcher's LLM is actually woken.
        // Priority is preserved on the payload as metadata (the LLM reads
        // it to decide urgency); it does NOT gate whether the wake fires —
        // an un-woken check-in is operationally identical to no check-in.
        // Loop safety lives in the receiver's /news handler (noAutoReply on
        // triggered queries).
        this.checkinService = new CheckinService(this.db, {
          dispatchWake: async (input) => {
            const owner = await this.db.agents.getById(input.ownerAgentId).catch(() => null);
            if (!owner || !owner.endpoint) return;
            const url = `${owner.endpoint.replace(/\/+$/, '')}/news`;
            // skip_persist:true: CheckinService.writeOwnerNews already wrote
            // the canonical inbox row before this dispatch ran. The wake POST
            // must trigger startQuery on the receiver but must NOT persist a
            // second news_item — otherwise high-priority fires would create
            // duplicate visible inbox entries.
            //
            // Bounded timeout: fireRow awaits dispatchWake and CheckinService
            // serializes ticks, so a hung owner endpoint would stall the
            // entire due-service loop. 5s matches the /news-to forward path.
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'checkin-service',
                trigger: true,
                skip_persist: true,
                type: 'checkin_due',
                message: input.message,
                data: input.data,
              }),
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              throw new Error(`wake POST ${url} returned ${res.status}`);
            }
          },
        });
        this.checkinService.start();
        console.log('[Manager] CheckinService started (wake on every fire)');

        resolve();
      });
    });
  }

  /**
   * Stop background services and close the HTTP/WS server. Safe to call
   * multiple times. Wired into SIGTERM/SIGINT in start-agent-manager.ts so
   * the manager shuts down cleanly without leaking timers or sockets.
   */
  async shutdown(): Promise<void> {
    if (this.checkinService) {
      this.checkinService.stop();
      this.checkinService = null;
    }
    if (this.schedulerService) {
      this.schedulerService.stop();
      this.schedulerService = null;
    }
    if (this.retentionService) {
      this.retentionService.stop();
      this.retentionService = null;
    }
    if (this.querySweeperInterval) {
      clearInterval(this.querySweeperInterval);
      this.querySweeperInterval = null;
    }
    if (this.stalledSweepInterval) {
      clearInterval(this.stalledSweepInterval);
      this.stalledSweepInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.remoteProbeInterval) {
      clearInterval(this.remoteProbeInterval);
      this.remoteProbeInterval = null;
    }
    if (this.wss) {
      try { this.wss.close(); } catch { /* swallow */ }
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((res) => this.httpServer!.close(() => res()));
      this.httpServer = null;
    }
  }

  private async initSchedules(): Promise<void> {
    // Intentionally left unused. Schedules persist in the DB and should not be reseeded on boot,
    // because reseeding interval schedules would reset their anchor and expiry.
  }

  /**
   * Ensure well-known teams exist: `default` (fallback for unscoped requests)
   * and `public` (public-agent registrations). Created idempotently on every
   * manager start. User-specific project teams are NOT seeded here — deploy
   * them with `/deploy <config>` instead.
   */
  private async seedWellKnownTeams(): Promise<void> {
    try {
      const seeded: string[] = [];
      for (const name of ['default', 'public']) {
        await this.db.teams.getOrCreateTeamId(name);
        const teamDir = `${this.baseWorkDir}/teams/${name}`;
        if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        seeded.push(name);
      }
      console.log(`[Manager] Well-known teams seeded: ${seeded.join(', ')}`);
    } catch (err: any) {
      // Non-fatal: log and continue
      console.warn('[Manager] Failed to seed well-known teams:', err?.message);
    }
  }

  private async clearInactiveAgentPids(): Promise<void> {
    try {
      let cleared = 0;
      const teams = await this.db.teams.listTeams();
      for (const team of teams) {
        const agents = await this.dbListAgents(team.id, true);
        for (const agent of agents) {
          const metadata = (agent.metadata as Record<string, unknown> | null | undefined) ?? {};
          if (agent.status === 'running' || !('pid' in metadata)) continue;
          await this.clearAgentPid(agent.id);
          cleared += 1;
        }
      }
      if (cleared > 0) console.log(`[Manager] Cleared ${cleared} stale pid metadata entr${cleared === 1 ? 'y' : 'ies'} for inactive agents`);
    } catch (err: any) {
      console.warn('[Manager] Failed to clear inactive agent pid metadata:', err?.message || err);
    }
  }


  /**
   * Handle a new WebSocket connection
   */
  private async handleWebSocketConnection(ws: WebSocket, req: any) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const teamHeader = req.headers['x-id-team'] || req.headers['x-id-project'] || url.searchParams.get('team');

    // Resolve team — look up only; do NOT auto-create. A stale client
    // reconnecting with a team name that was deleted must not resurrect it.
    const teamName = teamHeader ? String(teamHeader) : (process.env.ID_TEAM || 'default');
    const teamRow = await this.db.teams.getTeamByName(teamName);
    if (!teamRow) {
      console.log(`[WS] Rejecting connection for unknown team "${teamName}"`);
      try {
        ws.send(JSON.stringify({ type: 'error', error: 'team_not_found', team: teamName }));
      } catch { /* swallow */ }
      ws.close(1008, 'team_not_found');
      return;
    }
    const teamId = teamRow.id;

    const client: WSClient = { ws, teamId, teamName, authenticated: true };
    this.wsClients.add(client);

    console.log(`[WS] Client connected (team: ${teamName})`);

    ws.send(JSON.stringify({
      type: 'connected',
      team: teamName,
      timestamp: Date.now()
    }));

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleWebSocketMessage(client, message);
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    });

    ws.on('close', () => {
      this.wsClients.delete(client);
      console.log(`[WS] Client disconnected (team: ${teamName})`);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error for client (team: ${teamName}):`, err.message);
      this.wsClients.delete(client);
    });
  }

  /**
   * Handle an incoming WebSocket message
   */
  private async handleWebSocketMessage(client: WSClient, message: any) {
    const { type, command, ...rest } = message;

    switch (type) {
      case 'command': {
        // Execute a CLI-style command (reuse /remote logic)
        if (!command || typeof command !== 'string') {
          client.ws.send(JSON.stringify({ type: 'error', error: 'Missing command' }));
          return;
        }
        const result = await this.executeRemoteCommand(command.trim(), client.teamId, client.teamName);
        client.ws.send(JSON.stringify({ type: 'result', command, ...result }));
        break;
      }

      case 'ping': {
        client.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      }

      default: {
        client.ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${type}` }));
      }
    }
  }

  /**
   * Broadcast a news item to all connected WebSocket clients for a team
   */
  broadcastNews(teamId: string, newsItem: { type: string; from?: string; message?: string; in_reply_to?: string; data?: any; timestamp: number }) {
    for (const client of this.wsClients) {
      if (client.teamId === teamId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'news',
          newsType: newsItem.type,
          from: newsItem.from,
          message: newsItem.message,
          in_reply_to: newsItem.in_reply_to,
          data: newsItem.data,
          timestamp: newsItem.timestamp
        }));
      }
    }
  }

  /**
   * Notify connected CLIs that the agent registry for a team changed.
   * Lets the CLI clear stale per-name session state and surface a one-line
   * "registry updated" hint without forcing the operator to restart.
   */
  broadcastAgentsChanged(
    teamId: string,
    change: {
      reason: 'sync' | 'deploy' | 'spawn' | 'remove' | 'update';
      added?: string[];
      updated?: string[];
      removed?: string[];
    }
  ) {
    const payload = JSON.stringify({
      type: 'agents_changed',
      teamId,
      change: {
        reason: change.reason,
        added: change.added || [],
        updated: change.updated || [],
        removed: change.removed || [],
      },
      timestamp: Date.now(),
    });
    for (const client of this.wsClients) {
      if (client.teamId === teamId && client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(payload);
        } catch {
          /* drop send errors — closing handler will clean up */
        }
      }
    }
  }

  // ==================== Heartbeat System ====================

  /**
   * Read heartbeat config from agent's working directory.
   * Checks HEARTBEAT.yaml (legacy) first, then HEARTBEAT.md (new model).
   */
  private readHeartbeatConfig(workingDirectory: string): HeartbeatConfig | null {
    // Legacy: HEARTBEAT.yaml with interval + message
    const yamlPath = path.join(workingDirectory, 'HEARTBEAT.yaml');
    if (existsSync(yamlPath)) {
      try {
        const content = readFileSync(yamlPath, 'utf-8');
        const config = yaml.load(content) as { interval?: number; message?: string; maxBeats?: number; expiresAfter?: number };
        if (typeof config?.interval === 'number' && typeof config?.message === 'string') {
          return {
            interval: config.interval,
            message: config.message.trim(),
            ...(typeof config.maxBeats === 'number' && { maxBeats: config.maxBeats }),
            ...(typeof config.expiresAfter === 'number' && { expiresAfter: config.expiresAfter })
          };
        }
      } catch (error: any) {
        console.log(`[Heartbeat] Error reading ${yamlPath}: ${error.message}`);
      }
    }

    // New model: HEARTBEAT.md exists → agent-driven, use generic message
    const mdPath = path.join(workingDirectory, 'HEARTBEAT.md');
    if (existsSync(mdPath)) {
      return {
        interval: 86400,  // default interval for manual enable; overridden by config
        message: HEARTBEAT_GENERIC_MESSAGE,
      };
    }

    return null;
  }


  /**
   * Cancel all pending/processing queries for an agent when it stops.
   * This prevents orphaned queries from showing up in status.
   */
  async cancelPendingQueriesForAgent(teamId: string, agentId: string): Promise<number> {
    try {
      const ts = Date.now();

      // Cancel all pending/processing queries and get their IDs
      const queryIds = await this.db.queries.cancel(agentId, ts);

      if (queryIds.length === 0) {
        return 0;
      }

      // Add query.cancelled news items for each, and wake any long-poll waiters.
      for (const queryId of queryIds) {
        await this.db.news.add(teamId, agentId, {
          timestamp: ts,
          type: 'query.cancelled',
          message: 'Query cancelled (agent stopped)',
          data: { reason: 'agent_stopped', query_id: queryId },
          query_id: queryId,
        });
        this.notifyQueryStatusWaiters(teamId, queryId);
      }

      console.log(`[Manager] Cancelled ${queryIds.length} pending queries for agent ${agentId}`);
      return queryIds.length;
    } catch (err) {
      console.error(`[Manager] Error cancelling queries for agent ${agentId}:`, err);
      return 0;
    }
  }

  // -- long-poll helpers for GET /query/:id?wait= ---------------------------

  private addQueryStatusWaiter(teamId: string, queryId: string, fn: () => void): void {
    const key = `${teamId}:${queryId}`;
    let set = this.queryStatusWaiters.get(key);
    if (!set) {
      set = new Set();
      this.queryStatusWaiters.set(key, set);
    }
    set.add(fn);
  }

  private removeQueryStatusWaiter(teamId: string, queryId: string, fn: () => void): void {
    const key = `${teamId}:${queryId}`;
    const set = this.queryStatusWaiters.get(key);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this.queryStatusWaiters.delete(key);
  }

  private notifyQueryStatusWaiters(teamId: string, queryId: string): void {
    const key = `${teamId}:${queryId}`;
    const set = this.queryStatusWaiters.get(key);
    if (!set) return;
    const waiters = Array.from(set);
    this.queryStatusWaiters.delete(key);
    for (const fn of waiters) {
      try { fn(); } catch { /* non-fatal */ }
    }
  }

  /**
   * Wallet opt-in: produce the metadata that should be persisted for an
   * agent based on its config. Honors `walletOptIn === true` by calling
   * `getOrCreateAgentWallet` once and merging the resulting wallet name
   * and address into the metadata. Honors `walletOptIn === false` by
   * recording the explicit opt-out flag without calling the OWS CLI.
   * `walletOptIn === undefined` leaves the metadata untouched, preserving
   * legacy behaviour for configs that pre-date the flag.
   *
   * Returns the (possibly updated) metadata and the provisioned wallet
   * descriptor (or null) so callers that need to know about the wallet
   * (e.g. `deploySkillsToAgent`'s `hasWallet` flag) can branch on it.
   */
  private resolveWalletMetadata(
    teamName: string,
    agentName: string,
    metadata: AgentMetadata,
    walletOptIn: boolean | undefined,
  ): { metadata: AgentMetadata; wallet: { walletName: string; address: string } | null } {
    const nextMetadata = this.withWalletConfigMetadata(metadata, walletOptIn);
    if (walletOptIn !== true) {
      return { metadata: nextMetadata, wallet: null };
    }

    const wallet = this.getOrCreateAgentWallet(teamName, agentName);
    if (!wallet) {
      return { metadata: nextMetadata, wallet: null };
    }

    return {
      metadata: {
        ...nextMetadata,
        ows_wallet: wallet.walletName,
        ows_address: wallet.address,
      },
      wallet,
    };
  }

  private isWalletProvisioningEnabled(metadata: unknown): boolean {
    return (metadata as Record<string, unknown> | null | undefined)?.wallet === true;
  }

  private withoutProvisionedWalletMetadata(metadata: AgentMetadata): AgentMetadata {
    const next = { ...metadata };
    delete next.ows_wallet;
    delete next.ows_address;
    return next;
  }

  private withWalletConfigMetadata(metadata: AgentMetadata, walletOptIn: boolean | undefined): AgentMetadata {
    const next = this.withoutProvisionedWalletMetadata(metadata);
    if (walletOptIn !== undefined) {
      next.wallet = walletOptIn;
    } else {
      delete next.wallet;
    }
    return next;
  }

  /**
   * Wallet opt-in: provision (or reuse) an OWS wallet for an existing
   * agent row, persist `wallet: true` plus the wallet identifiers on the
   * row's metadata, and return the refreshed row. Returns `null` if OWS
   * is not installed or wallet creation fails. Used by both the on-demand
   * `/agent <name> wallet provision` command and the onchain registration
   * auto-provision path.
   */
  private async provisionAgentWalletForRow(
    teamId: string,
    walletTeam: string,
    agent: AgentRow,
  ): Promise<AgentRow | null> {
    const meta = (agent.metadata || {}) as Record<string, any>;
    if (meta.ows_wallet) return agent;
    const walletAlias = meta.alias || agent.name;
    const provisioned = this.getOrCreateAgentWallet(walletTeam, walletAlias);
    if (!provisioned) return null;

    const mergedMeta: AgentMetadata = {
      ...((agent.metadata || {}) as AgentMetadata),
      wallet: true,
      ows_wallet: provisioned.walletName,
      ows_address: provisioned.address,
    };
    await this.db.agents.updateMetadata(agent.id, mergedMeta);
    return this.dbQueryAgentById(teamId, agent.id);
  }

  /**
   * Check if the OWS (Open Wallet Standard) CLI is installed and on PATH.
   */
  private checkOwsInstalled(): boolean {
    try {
      execFileSync('ows', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get or create an OWS wallet for an agent.
   * Returns { walletName, address } or null if OWS is not installed or creation fails.
   */
  private getOrCreateAgentWallet(team: string, agentName: string): { walletName: string; address: string } | null {
    if (!this.checkOwsInstalled()) return null;
    const walletName = `${team}-${agentName}`;
    try {
      // Check if wallet exists by parsing `ows wallet list` output
      const listOutput = execFileSync('ows', ['wallet', 'list'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      let found = false;
      let ethAddress = '';
      let inWallet = false;
      for (const line of listOutput.split('\n')) {
        if (line.includes('Name:') && line.includes(walletName)) {
          inWallet = true;
          found = true;
          continue;
        }
        if (inWallet && line.includes('Name:')) break;
        if (inWallet) {
          const match = line.trim().match(/^eip155:1\s.*→\s*(0x[0-9a-fA-F]+)/);
          if (match) ethAddress = match[1];
        }
      }
      if (found && ethAddress) {
        console.log(`[OWS] Found existing wallet "${walletName}": ${ethAddress}`);
        return { walletName, address: ethAddress };
      }
    } catch {
      // ows wallet list failed, try creating
    }
    try {
      const output = execFileSync('ows', ['wallet', 'create', '--name', walletName], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      // Parse EVM address from create output
      for (const line of output.split('\n')) {
        const match = line.trim().match(/eip155:1\s.*→\s*(0x[0-9a-fA-F]+)/);
        if (match) {
          console.log(`[OWS] Created wallet "${walletName}": ${match[1]}`);
          return { walletName, address: match[1] };
        }
      }
      console.log(`[OWS] Created wallet "${walletName}" (no EVM address found in output)`);
      return { walletName, address: '' };
    } catch (err: any) {
      console.warn(`[OWS] Failed to create wallet "${walletName}": ${err.message}`);
      return null;
    }
  }

  private buildLocalAgentEnv(
    teamId: string,
    teamName: string,
    port: number,
    agentRow: AgentRow | null,
    model?: string,
    tokenId?: string,
  ): Record<string, string> {
    const owsWallet = (agentRow?.metadata as any)?.ows_wallet || null;
    const skipPermsRaw = (agentRow?.metadata as any)?.dangerouslySkipPermissions;
    const skipPermissions = skipPermsRaw === false ? false : true;
    const catalogSeed = (agentRow?.metadata as any)?.catalog;
    const catalogEnv = catalogSeed && typeof catalogSeed === 'object'
      ? Buffer.from(JSON.stringify(catalogSeed), 'utf8').toString('base64')
      : undefined;
    const metadata = (agentRow?.metadata || {}) as AgentMetadata;

    // Reasoning effort for cloud-subscription runtimes (codex / claude-code-cli) —
    // lower effort = fewer reasoning tokens. Read by those harnesses; n/a for ollama.
    const effortRaw = (agentRow?.metadata as any)?.effort;
    const effort = (typeof effortRaw === 'string' && /^(minimal|low|medium|high|xhigh)$/.test(effortRaw)) ? effortRaw : undefined;
    const speedRaw = (agentRow?.metadata as any)?.speed;
    const speed = (typeof speedRaw === 'string' && /^(default|fast)$/.test(speedRaw) && speedRaw !== 'default') ? speedRaw : undefined;

    // External MCP servers attached to this agent (Modules view → metadata).
    // Serialized as JSON for claude-agent-server to parse into HarnessOptions.
    const mcpServers = (agentRow?.metadata as any)?.mcpServers;
    const mcpEnv = Array.isArray(mcpServers) && mcpServers.length > 0
      ? JSON.stringify(mcpServers)
      : undefined;
    const runtime = resolveRuntime((agentRow?.runtime || metadata.runtime) as string | undefined);
    const providerRuntime = this.providerRuntimeForAgent(agentRow, metadata);
    const providerApiKey = providerRuntime?.apiKey
      || (providerRuntime?.keyEnv ? process.env[providerRuntime.keyEnv] : undefined)
      || undefined;
    const previousLaneId = typeof metadata.runtimeCredentialLane === 'string'
      ? metadata.runtimeCredentialLane
      : undefined;
    const runtimeLane = this.chooseRuntimeCredentialLane(runtime, previousLaneId, teamId);
    const laneEnv = runtimeLane.env || {};
    const { ANTHROPIC_API_KEY: laneAnthropicApiKey, ...safeLaneEnv } = laneEnv;
    const useMeteredOverflow = runtimeLane.kind === 'metered-api'
      && (runtime === 'claude-code-cli' || runtime === 'claude-code-local')
      && Boolean(laneAnthropicApiKey || process.env.ID_AGENT_OVERFLOW_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
    const childAnthropicApiKey = useMeteredOverflow
      ? (laneAnthropicApiKey || process.env.ID_AGENT_OVERFLOW_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)
      : runtime === 'claude-agent-sdk'
        ? (laneAnthropicApiKey || process.env.ANTHROPIC_API_KEY)
        : undefined;
    const skillmeshProviderEnabled = this.isSkillmeshProviderEnabled(teamName, metadata);
    const skillmeshKey = skillmeshProviderEnabled && typeof metadata.skillmesh_private_key === 'string'
      ? metadata.skillmesh_private_key
      : undefined;
    const skillmeshCreatorKey = skillmeshProviderEnabled && typeof metadata.skillmesh_creator_key === 'string'
      ? metadata.skillmesh_creator_key
      : undefined;

    return {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      SHELL: process.env.SHELL || '',
      TMPDIR: process.env.TMPDIR || '',
      USER: process.env.USER || '',
      LANG: process.env.LANG || '',
      TERM: process.env.TERM || 'xterm-256color',
      ...(process.env.NVM_DIR && { NVM_DIR: process.env.NVM_DIR }),
      ...(process.env.XDG_CONFIG_HOME && { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
      ...filterClaudeEnvVars(process.env),
      ...(agentRow?.runtime && { ID_HARNESS: runtime }),
      ID_TEAM: teamName,
      ID_AGENT_PORT: String(port),
      ID_RUNTIME_LANE_ID: runtimeLane.id,
      ID_RUNTIME_LANE_KIND: runtimeLane.kind,
      MANAGER_URL: `http://127.0.0.1:4100`,
      ID_AGENT_SKIP_PERMISSIONS: skipPermissions ? 'true' : 'false',
      ...safeLaneEnv,
      ...(useMeteredOverflow && { ID_AGENT_CLAUDE_BARE: '1' }),
      ...(model && { CLAUDE_MODEL: resolveModelAlias(model) }),
      ...(tokenId && { ID_AGENT_TOKEN_ID: tokenId }),
      ...(owsWallet && { OWS_WALLET: owsWallet }),
      ...(catalogEnv && { ID_AGENT_CATALOG: catalogEnv }),
      ...(effort && { ID_AGENT_EFFORT: effort }),
      ...(speed && { ID_AGENT_SPEED: speed }),
      ...(mcpEnv && { ID_MCP_SERVERS: mcpEnv }),
      ...(providerRuntime && {
        ID_PROVIDER_LANE: providerRuntime.lane,
        ID_PROVIDER_NAME: providerRuntime.name,
        ID_PROVIDER_BASE_URL: providerRuntime.baseUrl,
      }),
      ...(providerApiKey && { ID_PROVIDER_API_KEY: providerApiKey }),
      ...(childAnthropicApiKey && { ANTHROPIC_API_KEY: childAnthropicApiKey }),
      ...(process.env.OPENAI_API_KEY && { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
      ...(skillmeshKey && {
        SKILLMESH_PRIVATE_KEY: skillmeshKey,
        SKILLMESH_APP_URL: process.env.SKILLMESH_APP_URL || 'https://skillmesh.bittrees.org',
        SKILLMESH_RPC_URL: process.env.SKILLMESH_RPC_URL || 'https://sepolia.drpc.org',
      }),
      ...(skillmeshCreatorKey && { SKILLMESH_CREATOR_PRIVATE_KEY: skillmeshCreatorKey }),
    };
  }

  /**
   * Deploy skill files from skills/ templates to an agent's .claude/skills/ folder.
   * Reads skill.md from each skill directory, substitutes {{VAR}} placeholders,
   * and writes to the agent's working directory.
   */
  /**
   * Deploy skill files from skills/ templates to an agent's .claude/skills/ folder.
   * Uses standard Claude Code skill format: .claude/skills/<name>/SKILL.md
   *
   * Skills are specified in the YAML config (defaults.skills + per-agent skills).
   * Plugins can also bundle skills in their own skills/ subdirectory.
   * Substitutes {{VAR}} placeholders with deploy-time values.
   */
  private deploySkillsToAgent(
    workDir: string,
    skillNames: string[],
    vars: Record<string, string>,
    opts: { hasWallet?: boolean; runtime?: HarnessType | string; skillsRoot?: string } = {}
  ): void {
    if (skillNames.length === 0) return;
    try {
      const skillsSource = opts.skillsRoot ?? path.resolve(__dirname, '..', 'skills');
      if (!existsSync(skillsSource)) return;

      const rp = getRuntimePaths(opts.runtime);
      let deployed = 0;

      for (const skillName of skillNames) {
        // Defense in depth: skill names also arrive from persisted
        // metadata.skills on rebuild — never let a traversal string reach a join.
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillName)) {
          console.warn(`[Deploy] Skipping invalid skill name "${skillName}"`);
          continue;
        }
        const skillFile = path.join(skillsSource, skillName, 'SKILL.md');
        if (!existsSync(skillFile)) {
          console.warn(`[Deploy] Skill "${skillName}" not found at ${skillFile}`);
          continue;
        }

        // Skip wallet skill if agent has no wallet
        if (skillName === 'wallet' && !opts.hasWallet) continue;

        let content = readFileSync(skillFile, 'utf8');

        // Substitute {{VAR}} placeholders
        for (const [key, value] of Object.entries(vars)) {
          content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
        }

        // Write to runtime-aware skills directory
        const targetSkillDir = path.join(workDir, rp.skillsDir, skillName);
        if (!existsSync(targetSkillDir)) mkdirSync(targetSkillDir, { recursive: true });
        writeFileSync(path.join(targetSkillDir, 'SKILL.md'), content);
        deployed++;
      }

      if (deployed > 0) {
        console.log(`[Deploy] Copied ${deployed} skills to ${path.basename(workDir)}/${rp.skillsDir}/`);
      }
    } catch (err: any) {
      console.warn(`[Deploy] Could not deploy skills: ${err.message}`);
    }
  }

  /**
   * Spawn a local agent process on the server.
   * Used by executeRemoteCommand to start agents server-side.
   */
  private async spawnLocalAgentProcess(
    teamId: string,
    teamName: string,
    agentData: { name: string; id: string; port: number; model?: string; workingDirectory?: string; tokenId?: string; address?: string }
  ): Promise<{ success: boolean; pid?: number; logFile?: string; error?: string }> {
    const key = this.agentLifecycleKey(teamId, agentData);
    return this.withAgentLifecycleLock(key, () => this.spawnLocalAgentProcessUnlocked(teamId, teamName, agentData));
  }

  private agentLifecycleKey(
    teamId: string,
    agentData: { id?: string; name?: string; port?: number },
  ): string {
    return `${teamId}:${agentData.id || agentData.name || 'unknown'}:${agentData.port || 'no-port'}`;
  }

  private async withAgentLifecycleLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.agentLifecycleLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const gate = previous.catch(() => {}).then(() => current);
    this.agentLifecycleLocks.set(key, gate);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.agentLifecycleLocks.get(key) === gate) {
        this.agentLifecycleLocks.delete(key);
      }
    }
  }

  private async waitForAgentPortToBind(
    proc: ChildProcess,
    port: number,
    timeoutMs: number = 10_000,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const pid = proc.pid;
    if (!pid) return { ok: false, error: 'spawn did not return a process id' };

    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exited = { code, signal };
    };
    proc.once('exit', onExit);

    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (exited !== null) {
          const exitInfo = exited as { code: number | null; signal: NodeJS.Signals | null };
          const exit = exitInfo.signal ? `signal ${exitInfo.signal}` : `code ${exitInfo.code ?? 'unknown'}`;
          return { ok: false, error: `agent process ${pid} exited before listening on port ${port} (${exit})` };
        }

        if (this.listPidsListeningOnPort(port).includes(pid)) {
          return { ok: true };
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      proc.off('exit', onExit);
    }

    return { ok: false, error: `agent process ${pid} did not listen on port ${port} within ${timeoutMs}ms` };
  }

  private async spawnLocalAgentProcessUnlocked(
    teamId: string,
    teamName: string,
    agentData: { name: string; id: string; port: number; model?: string; workingDirectory?: string; tokenId?: string; address?: string }
  ): Promise<{ success: boolean; pid?: number; logFile?: string; error?: string }> {
    try {
      const scriptPath = path.resolve(__dirname, 'local-agent-server.js');
      const { name, id, port, model, workingDirectory, tokenId, address } = agentData;

      // Kill any existing process on this port
      await this.killAgentProcess(port);
      await this.clearAgentPid(id);
      await new Promise(r => setTimeout(r, 500));

      // Build command arguments
      const spawnArgs = [
        scriptPath,
        name,
        '--team', teamName,
        '--port', String(port),
        '--id', id
      ];
      if (workingDirectory) {
        spawnArgs.push('--dir', workingDirectory);
      }

      // Set environment
      // Look up OWS wallet name and permissions flag from agent metadata
      const agentRow = await this.dbQueryAgentById(teamId, id);
      const localEnv = this.buildLocalAgentEnv(teamId, teamName, port, agentRow, model, tokenId);

      // Create log file
      const logFile = `/tmp/${name}.log`;
      const logFd = openSync(logFile, 'a');

      console.log(`[Manager] Spawning agent process: ${name} (port ${port}, id ${id})`);

      const proc = spawn('node', spawnArgs, {
        env: localEnv,
        stdio: ['ignore', logFd, logFd],
        detached: true
      });

      proc.unref();
      closeSync(logFd);

      console.log(`[Manager] Agent ${name} spawned with PID ${proc.pid}`);

      const bindResult = await this.waitForAgentPortToBind(proc, port);
      if (!bindResult.ok) {
        if (proc.pid) {
          try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already exited */ }
          await this.clearAgentPid(id, proc.pid);
        }
        return { success: false, pid: proc.pid, logFile, error: bindResult.error };
      }

      // Persist pid into agent metadata so /agents responses can carry it.
      // The TUI uses this to resolve per-agent RSS via a batched `ps` call.
      if (proc.pid) {
        try {
          const cur = (agentRow?.metadata as Record<string, unknown>) || {};
          await this.db.agents.updateMetadata(id, { ...cur, pid: proc.pid });
        } catch (metaErr: any) {
          console.warn(`[Manager] Failed to persist pid for ${name}: ${metaErr?.message || metaErr}`);
        }
      }

      return { success: true, pid: proc.pid, logFile };
    } catch (err: any) {
      console.error(`[Manager] Failed to spawn agent ${agentData.name}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  private isLeadLikeAgentName(name: string): boolean {
    return /(^lead$|[-_]lead$|manager$|coordinator$|counsel$)/i.test(name);
  }

  private async countOpenOwnedTasks(agentId: string): Promise<number> {
    const { rows } = await this.db.adapter.query<{ c: string | number }>(
      `SELECT COUNT(*) AS c
         FROM tasks
        WHERE owner = $1
          AND LOWER(status) NOT IN ('done', 'completed', 'archived', 'cancelled', 'canceled')`,
      [agentId],
    );
    return Number(rows[0]?.c ?? 0) || 0;
  }

  private async countActiveSchedules(agentId: string): Promise<number> {
    const { rows } = await this.db.adapter.query<{ c: string | number }>(
      `SELECT COUNT(*) AS c
         FROM schedule_targets st
         JOIN schedule_definitions sd ON sd.id = st.schedule_id
        WHERE st.agent_id = $1
          AND sd.active = 1`,
      [agentId],
    );
    return Number(rows[0]?.c ?? 0) || 0;
  }

  private async countActiveCheckins(agentId: string): Promise<number> {
    const { rows } = await this.db.adapter.query<{ c: string | number }>(
      `SELECT COUNT(*) AS c
         FROM checkins
        WHERE owner_agent_id = $1
          AND status IN ('active', 'snoozed')`,
      [agentId],
    );
    return Number(rows[0]?.c ?? 0) || 0;
  }

  private async parkIdleAgents(opts: {
    teamId: string;
    teamName: string;
    confirmed: boolean;
    allTeams: boolean;
    includeDefault: boolean;
    includeLeads: boolean;
    includeScheduled: boolean;
  }): Promise<{ ok: boolean; result: {
    action: 'agents-park-idle';
    dryRun: boolean;
    scope: string;
    parked: number;
    skipped: number;
    failed: number;
    agents: Array<{ team: string; name: string; status: 'candidate' | 'parked' | 'skipped' | 'failed'; reason: string; pids?: number[] }>;
  } }> {
    const teams = opts.allTeams
      ? await this.db.teams.listTeams()
      : [{ id: opts.teamId, name: opts.teamName } as { id: string; name: string }];
    const rows: Array<{ team: string; name: string; status: 'candidate' | 'parked' | 'skipped' | 'failed'; reason: string; pids?: number[] }> = [];

    for (const team of teams) {
      if (team.name === 'default' && !opts.includeDefault) {
        rows.push({ team: team.name, name: '*', status: 'skipped', reason: 'default_team_requires_--include-default' });
        continue;
      }
      const agents = await this.dbListAgents(team.id, true);
      for (const agent of agents) {
        if (agent.status !== 'running') continue;
        if (isRemoteEndpointRuntime(agent.runtime)) {
          rows.push({ team: team.name, name: agent.name, status: 'skipped', reason: 'remote_endpoint_runtime' });
          continue;
        }
        if (agent.type !== 'claude') {
          rows.push({ team: team.name, name: agent.name, status: 'skipped', reason: 'unsupported_agent_type' });
          continue;
        }
        if (!opts.includeLeads && this.isLeadLikeAgentName(agent.name)) {
          rows.push({ team: team.name, name: agent.name, status: 'skipped', reason: 'lead_like_requires_--include-leads' });
          continue;
        }

        const [openTasks, schedules, checkins] = await Promise.all([
          this.countOpenOwnedTasks(agent.id),
          this.countActiveSchedules(agent.id),
          this.countActiveCheckins(agent.id),
        ]);
        if (openTasks > 0) {
          rows.push({ team: team.name, name: agent.name, status: 'skipped', reason: `owns_${openTasks}_open_task${openTasks === 1 ? '' : 's'}` });
          continue;
        }
        if (!opts.includeScheduled && schedules > 0) {
          rows.push({ team: team.name, name: agent.name, status: 'skipped', reason: `has_${schedules}_active_schedule${schedules === 1 ? '' : 's'}` });
          continue;
        }
        if (checkins > 0) {
          rows.push({ team: team.name, name: agent.name, status: 'skipped', reason: `has_${checkins}_active_checkin${checkins === 1 ? '' : 's'}` });
          continue;
        }

        if (!opts.confirmed) {
          rows.push({ team: team.name, name: agent.name, status: 'candidate', reason: 'idle_running_agent' });
          continue;
        }

        try {
          const killResult = await this.killAgentProcess(agent.port);
          const cancelled = await this.cancelPendingQueriesForAgent(team.id, agent.id);
          await this.db.agents.updateStatus(agent.id, 'stopped');
          await this.clearAgentPid(agent.id);
          rows.push({
            team: team.name,
            name: agent.name,
            status: 'parked',
            reason: cancelled > 0 ? `idle; cancelled_${cancelled}_queries` : 'idle',
            pids: killResult.pids,
          });
        } catch (err: any) {
          rows.push({ team: team.name, name: agent.name, status: 'failed', reason: err?.message || String(err) });
        }
      }
    }

    return {
      ok: true,
      result: {
        action: 'agents-park-idle',
        dryRun: !opts.confirmed,
        scope: opts.allTeams ? 'all-teams' : opts.teamName,
        parked: rows.filter((row) => row.status === 'parked').length,
        skipped: rows.filter((row) => row.status === 'skipped').length,
        failed: rows.filter((row) => row.status === 'failed').length,
        agents: rows,
      },
    };
  }

  /**
   * Update or create a CLAUDE.md file with the agent's identity.
   * Replaces any existing identity section to prevent duplicates.
   */
  private updateClaudeMdIdentity(claudeMdPath: string, identityName: string): void {
    const identitySection = `# Your Identity\n\nYou are **${identityName}** - always use this full name when introducing yourself or signing messages.\n`;
    let existingContent = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : '';
    // Strip any existing identity sections to prevent duplicates
    existingContent = existingContent.replace(/# Your Identity\n\nYou are \*\*[^*]+\*\*[^\n]*\n+/g, '').replace(/^\n+/, '');
    writeFileSync(claudeMdPath, identitySection + (existingContent ? '\n' + existingContent : ''));
  }

  private listPidsListeningOnPort(port: number): number[] {
    try {
      const lsofOutput = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (!lsofOutput) return [];
      return lsofOutput
        .split('\n')
        .filter(Boolean)
        .map(value => parseInt(value, 10))
        .filter(pid => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  private inspectProcess(pid: number): ProcessInspection | null {
    try {
      const output = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (!output) return null;

      const match = output.match(/^\s*(\d+)\s+(.*)$/s);
      if (!match) return null;

      const ppid = parseInt(match[1], 10);
      const commandLine = match[2].trim();
      const argv0 = tokenizeCommand(commandLine)[0] || '';
      return {
        pid,
        ppid: Number.isInteger(ppid) ? ppid : null,
        argv0,
        commandLine,
      };
    } catch {
      return null;
    }
  }

  private getManagerProcessSignatures(): string[] {
    const signatures = new Set<string>(['start-agent-manager.js', 'start-agent-manager.ts']);
    const currentEntry = process.argv[1] ? path.basename(process.argv[1]).toLowerCase() : '';
    if (currentEntry && currentEntry !== 'node' && currentEntry !== 'tsx') {
      signatures.add(currentEntry);
    }
    return [...signatures];
  }

  private matchesManagerProcessSignature(info: ProcessInspection | null): boolean {
    if (!info) return false;
    const argv0 = path.basename(info.argv0 || '').toLowerCase();
    const commandLine = info.commandLine.toLowerCase();
    return this.getManagerProcessSignatures().some(signature =>
      argv0 === signature || commandLine.includes(signature)
    );
  }

  private isManagerProcess(pid: number): boolean {
    if (pid === process.pid) return true;
    return this.matchesManagerProcessSignature(this.inspectProcess(pid));
  }

  /**
   * Kill the agent process running on a given port.
   */
  private async killAgentProcess(port: number): Promise<{ killed: boolean; pids: number[] }> {
    if (!port) return { killed: false, pids: [] };
    const candidatePids = this.listPidsListeningOnPort(port);
    if (candidatePids.length === 0) return { killed: false, pids: [] };

    const killedPids: number[] = [];
    for (const pid of candidatePids) {
      if (this.isManagerProcess(pid)) {
        console.warn(`[Manager] Skipping manager PID ${pid} on port ${port}`);
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        killedPids.push(pid);
        console.log(`[Manager] Killed process PID ${pid} on port ${port}`);
      } catch {
        // Process may have already exited
      }
    }
    return { killed: killedPids.length > 0, pids: killedPids };
  }

  private async clearAgentPid(agentId: string, expectedPid?: number): Promise<void> {
    try {
      const row = await this.db.agents.getById(agentId);
      const metadata = { ...((row?.metadata as Record<string, unknown> | null | undefined) ?? {}) };
      const currentPid = metadata.pid;
      const currentPidNumber = typeof currentPid === 'number' ? currentPid : Number(currentPid);
      if (expectedPid && currentPidNumber !== expectedPid) return;
      if (!('pid' in metadata)) return;
      delete metadata.pid;
      await this.db.agents.updateMetadata(agentId, metadata);
    } catch {
      // PID metadata is diagnostic only; lifecycle status is the source of truth.
    }
  }

}
