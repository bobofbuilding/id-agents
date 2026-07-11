import { RegistryRejectedError as CoreRegistryRejectedError } from './registry-control-plane.mjs';

/**
 * Operational controls for the registry control-plane.
 *
 * This module deliberately does not implement authentication, signature
 * verification, replay protection, or persistence.  Those responsibilities
 * stay in RegistryControlPlane.  This layer is the small, fail-closed shell
 * around it: capability checks, admission limiting, emergency pause, and
 * write serialization.
 */

export const REGISTRY_SECURITY_OPERATIONS = Object.freeze({
  READ: Object.freeze(['getRecord', 'emitRecord', 'quarantineRecords', 'auditEvents', 'snapshot']),
  WRITE: Object.freeze(['ingestHeartbeat', 'revokeAgent', 'rotateController']),
});

/**
 * Error used by this layer for operational policy failures.
 *
 * The core module has its own RegistryRejectedError for registry validation
 * failures.  Keeping the same `code` contract here lets callers handle both
 * sources uniformly without coupling this optional layer to a not-yet-loaded
 * core module.
 */
export class RegistryRejectedError extends CoreRegistryRejectedError {
  constructor({ code, message = code, details } = {}) {
    if (!code) throw new TypeError('RegistryRejectedError requires a code');
    super({ code, message });
    this.name = 'RegistryRejectedError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function createRegistryCredential(role, id = undefined) {
  if (role !== 'reader' && role !== 'controller' && role !== 'operator' && role !== 'admin') {
    throw new TypeError(`unsupported registry credential role: ${role}`);
  }
  return Object.freeze({ role, ...(id === undefined ? {} : { id }) });
}

function asNow(clock) {
  if (typeof clock === 'function') return () => {
    const value = clock();
    return Number.isFinite(value) ? value : Date.now();
  };
  if (typeof clock === 'number') return () => clock;
  return () => Date.now();
}

function roleOf(credential) {
  if (credential === undefined || credential === null) return undefined;
  if (typeof credential === 'string') return credential;
  if (typeof credential !== 'object') return undefined;
  if (typeof credential.role === 'string') return credential.role;
  if (typeof credential.capability === 'string') return credential.capability;
  if (typeof credential.credential === 'string') return credential.credential;
  if (Array.isArray(credential.capabilities)) {
    if (credential.capabilities.includes('controller')) return 'controller';
    if (credential.capabilities.includes('reader')) return 'reader';
  }
  if (Array.isArray(credential.scopes)) {
    if (credential.scopes.includes('controller')) return 'controller';
    if (credential.scopes.includes('reader')) return 'reader';
  }
  return undefined;
}

function isPromise(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

function withPauseView(view, paused) {
  if (view === null || typeof view !== 'object') return view;
  const result = Array.isArray(view) ? [...view] : { ...view };
  result.paused = paused;
  if (result.authorityState && typeof result.authorityState === 'object') {
    result.authorityState = { ...result.authorityState, paused };
  } else if (result.authority_state && typeof result.authority_state === 'object') {
    result.authority_state = { ...result.authority_state, paused };
  } else {
    result.authorityState = { paused };
  }
  return result;
}

function stripCredential(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return { options: options ?? {}, credential: undefined };
  }
  // Support revokeAgent(agentId, credential) as well as
  // revokeAgent(agentId, { reason, credential }).
  if (roleOf(options) && options.reason === undefined && options.credential === undefined) {
    return { options: {}, credential: options };
  }
  const { credential, ...coreOptions } = options;
  return { options: coreOptions, credential };
}

/**
 * A bounded token bucket keyed by controller, agent, or a caller-supplied
 * function.  `consume` is synchronous, so concurrent JavaScript calls cannot
 * race between checking and decrementing the same bucket.
 */
export class TokenBucketRateLimiter {
  constructor({ limit = 60, maxCalls = limit, windowMs = 60_000, clock = Date.now } = {}) {
    const capacity = Number(maxCalls);
    const window = Number(windowMs);
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError('rate limit maxCalls must be a positive integer');
    }
    if (!Number.isFinite(window) || window <= 0) {
      throw new TypeError('rate limit windowMs must be positive');
    }
    this.capacity = capacity;
    this.windowMs = window;
    this.now = asNow(clock);
    this.buckets = new Map();
  }

  consume(key) {
    const bucketKey = String(key ?? '__unknown__');
    const now = this.now();
    const previous = this.buckets.get(bucketKey);
    const refillPerMs = this.capacity / this.windowMs;
    const bucket = previous ?? { tokens: this.capacity, at: now };
    if (previous) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.at) * refillPerMs);
      bucket.at = now;
    }
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs));
      this.buckets.set(bucketKey, bucket);
      throw new RegistryRejectedError({
        code: 'rate_limited',
        message: 'registry heartbeat rate limit exceeded',
        details: { key: bucketKey, limit: this.capacity, windowMs: this.windowMs, retryAfterMs },
      });
    }
    bucket.tokens -= 1;
    this.buckets.set(bucketKey, bucket);
    return { remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  reset(key = undefined) {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(String(key));
  }
}

function defaultRateLimiterOptions(options) {
  const configured = options.rateLimit && typeof options.rateLimit === 'object'
    ? options.rateLimit
    : {};
  return {
    limit: options.limit ?? configured.limit ?? configured.max ?? configured.maxCalls ?? 60,
    maxCalls: options.maxCalls ?? configured.maxCalls ?? configured.max ?? configured.limit ?? 60,
    windowMs: options.windowMs ?? configured.windowMs ?? 60_000,
    clock: options.clock ?? configured.clock ?? Date.now,
  };
}

function controllerAndAgentKey(heartbeat, keyBy) {
  if (typeof keyBy === 'function') return keyBy(heartbeat);
  switch (keyBy) {
    case 'agent':
    case 'agentId':
      return heartbeat?.agentId ?? heartbeat?.agent_id ?? '__unknown_agent__';
    case 'controller+agent':
    case 'controller_agent':
      return `${heartbeat?.controllerId ?? heartbeat?.controller_id ?? '__unknown_controller__'}:${heartbeat?.agentId ?? heartbeat?.agent_id ?? '__unknown_agent__'}`;
    case 'controller':
    case 'controllerId':
    default:
      return heartbeat?.controllerId ?? heartbeat?.controller_id ?? '__unknown_controller__';
  }
}

function looksLikeEnvelope(value) {
  return value && typeof value === 'object' && value.heartbeat &&
    (value.credential !== undefined || value.auth !== undefined) &&
    !value.agentId && !value.agent_id;
}

/**
 * Operational wrapper around a RegistryControlPlane instance.
 */
export class RegistrySecurityControls {
  constructor(options = {}) {
    const core = options.controlPlane ?? options.registry ?? options.core;
    if (!core || typeof core.ingestHeartbeat !== 'function') {
      throw new TypeError('RegistrySecurityControls requires a RegistryControlPlane instance');
    }
    this.controlPlane = core;
    this.registry = core;
    this.defaultCredential = options.defaultCredential;
    this.keyBy = options.keyBy ?? options.rateLimitKey ?? 'controllerId';
    this.clock = asNow(options.clock);
    this.rateLimiter = options.rateLimiter ?? new TokenBucketRateLimiter(defaultRateLimiterOptions(options));
    this.paused = Boolean(options.paused ?? false);
    this._agentQueues = new Map();
  }

  get emergencyPaused() {
    return this.paused;
  }

  isEmergencyPaused() {
    return this.paused;
  }

  /**
   * Pause is intentionally synchronous and local.  A supplied reader
   * credential cannot operate this control; an omitted credential is treated
   * as an in-process operator call, which is useful for incident handlers.
   */
  setEmergencyPause(value, credential = undefined) {
    const suppliedRole = roleOf(credential ?? this.defaultCredential);
    if (suppliedRole === 'reader') this._rejectPrivilege('setEmergencyPause');
    if (typeof value !== 'boolean') throw new TypeError('emergency pause must be boolean');
    this.paused = value;
    return { paused: this.paused };
  }

  pauseAll(credential = undefined) {
    return this.setEmergencyPause(true, credential);
  }

  resumeAll(credential = undefined) {
    return this.setEmergencyPause(false, credential);
  }

  _credential(explicit) {
    return explicit ?? this.defaultCredential;
  }

  _rejectPrivilege(operation) {
    throw new RegistryRejectedError({
      code: 'insufficient_privilege',
      message: `credential cannot call ${operation}`,
    });
  }

  _authorize(credential, operation) {
    const role = roleOf(this._credential(credential));
    const read = REGISTRY_SECURITY_OPERATIONS.READ.includes(operation);
    if ((read && (role === 'reader' || role === 'controller' || role === 'operator' || role === 'admin')) ||
        (!read && role === 'controller')) {
      return role;
    }
    this._rejectPrivilege(operation);
  }

  _pauseCheck() {
    if (this.paused) {
      throw new RegistryRejectedError({
        code: 'paused',
        message: 'registry heartbeat ingestion is emergency-paused',
      });
    }
  }

  async _withAgentLock(agentId, operation) {
    const key = String(agentId ?? '__unknown_agent__');
    const previous = this._agentQueues.get(key) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const queue = previous.then(() => turn);
    this._agentQueues.set(key, queue);
    try {
      await previous;
      return await operation();
    } finally {
      release();
      if (this._agentQueues.get(key) === queue) this._agentQueues.delete(key);
    }
  }

  async ingestHeartbeat(heartbeat, credential = undefined) {
    if (looksLikeEnvelope(heartbeat)) {
      credential = heartbeat.credential ?? heartbeat.auth;
      heartbeat = heartbeat.heartbeat;
    }
    // Pause is checked before even inspecting or authorizing the heartbeat so
    // an incident stop masks malformed or unauthorized writes fail-closed.
    this._pauseCheck();
    this._authorize(credential, 'ingestHeartbeat');
    this.rateLimiter.consume(controllerAndAgentKey(heartbeat, this.keyBy));
    const agentId = heartbeat?.agentId ?? heartbeat?.agent_id;
    return this._withAgentLock(agentId, async () => {
      this._pauseCheck();
      return this.controlPlane.ingestHeartbeat(heartbeat);
    });
  }

  async revokeAgent(agentId, options = {}, credential = undefined) {
    const extracted = stripCredential(options);
    credential = credential ?? extracted.credential;
    this._authorize(credential, 'revokeAgent');
    return this._withAgentLock(agentId, () => this.controlPlane.revokeAgent(agentId, extracted.options));
  }

  async rotateController(agentId, options = {}, credential = undefined) {
    const extracted = stripCredential(options);
    credential = credential ?? extracted.credential;
    this._pauseCheck();
    this._authorize(credential, 'rotateController');
    return this._withAgentLock(agentId, async () => {
      this._pauseCheck();
      return this.controlPlane.rotateController(agentId, extracted.options);
    });
  }

  async getRecord(agentId, credential = undefined) {
    this._authorize(credential, 'getRecord');
    return this.controlPlane.getRecord(agentId);
  }

  async emitRecord(agentId, credential = undefined) {
    this._authorize(credential, 'emitRecord');
    const emitted = this.controlPlane.emitRecord(agentId);
    return isPromise(emitted) ? emitted.then((view) => withPauseView(view, this.paused)) : withPauseView(emitted, this.paused);
  }

  async quarantineRecords(credential = undefined) {
    this._authorize(credential, 'quarantineRecords');
    return this.controlPlane.quarantineRecords();
  }

  async auditEvents(credential = undefined) {
    this._authorize(credential, 'auditEvents');
    return this.controlPlane.auditEvents();
  }

  snapshot(credential = undefined) {
    this._authorize(credential, 'snapshot');
    const snapshot = this.controlPlane.snapshot();
    const decorate = (value) => {
      if (value === null || typeof value !== 'object') return value;
      return { ...value, paused: this.paused };
    };
    return isPromise(snapshot) ? snapshot.then(decorate) : decorate(snapshot);
  }
}

// Friendly aliases for callers that describe the module as a security layer.
export const RegistrySecurityLayer = RegistrySecurityControls;
export const RegistryOperationalControls = RegistrySecurityControls;
