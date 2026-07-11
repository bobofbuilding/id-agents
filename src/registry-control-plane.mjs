import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * This module is deliberately a control-plane data model.  In particular, the
 * authority flags below are constants: accepting a heartbeat can never grant
 * execution, spending, or authority-change capability.
 */
export const HEARTBEAT_SCHEMA_VERSION = 'agent.registry.heartbeat.v1';
export const EMITTED_RECORD_SCHEMA_VERSION = 'agent.registry.record.v1';

const STATE_SCHEMA_VERSION = 'agent.registry.state.v1';
const HEARTBEAT_SIGNING_DOMAIN = 'agent-registry-heartbeat-v1\0';
const CONTROLLER_ROTATION_SIGNING_DOMAIN = 'agent-registry-rotate-v1\0';
const REDACTED = '[REDACTED]';

export class RegistryRejectedError extends Error {
  constructor({ code, message } = {}) {
    super(message ?? `Registry heartbeat rejected: ${code ?? 'unknown'}`);
    this.name = 'RegistryRejectedError';
    this.code = code ?? 'rejected';
  }
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function lockedAuthorityState() {
  return {
    execution_allowed: false,
    spend_allowed: false,
    authority_changes_allowed: false,
  };
}

function canonicalJson(value, inArray = false) {
  if (value === null) return 'null';
  if (value === undefined) return inArray ? 'null' : undefined;

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not permit non-finite numbers');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`Canonical JSON does not permit ${typeof value} values`);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry, true)).join(',')}]`;
      }
      return `{${Object.keys(value).sort().flatMap((key) => {
        const encoded = canonicalJson(value[key]);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      }).join(',')}}`;
    default:
      throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }
}

function heartbeatForSigning(heartbeat) {
  if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)) {
    throw new TypeError('Heartbeat must be an object');
  }
  const { signature: _signature, ...unsignedHeartbeat } = heartbeat;
  return unsignedHeartbeat;
}

function signingBytes(heartbeat) {
  return Buffer.from(`${HEARTBEAT_SIGNING_DOMAIN}${canonicalJson(heartbeatForSigning(heartbeat))}`, 'utf8');
}

function rotationForSigning(rotation) {
  if (!rotation || typeof rotation !== 'object' || Array.isArray(rotation)) {
    throw new TypeError('Controller rotation request must be an object');
  }
  return {
    agentId: rotation.agentId,
    newControllerPublicKey: rotation.newControllerPublicKey,
  };
}

function rotationSigningBytes(rotation) {
  return Buffer.from(
    `${CONTROLLER_ROTATION_SIGNING_DOMAIN}${canonicalJson(rotationForSigning(rotation))}`,
    'utf8',
  );
}

/**
 * Signs a domain-separated canonical heartbeat representation.  The signature
 * is intentionally not reusable as a signature for a different protocol.
 */
export function signHeartbeat(heartbeatObjectWithoutSignature, privateKey) {
  return cryptoSign(null, signingBytes(heartbeatObjectWithoutSignature), privateKey).toString('base64url');
}

/**
 * Signs an agent-bound controller-key rotation request.  The distinct domain
 * prevents a rotation proof from being valid as a heartbeat proof (or vice
 * versa).  Include `agentId` and `newControllerPublicKey` in the request.
 */
export function signControllerRotation(rotationObjectWithoutSignature, privateKey) {
  return cryptoSign(null, rotationSigningBytes(rotationObjectWithoutSignature), privateKey).toString('base64url');
}

function heartbeatDigest(heartbeat) {
  return createHash('sha256').update(canonicalJson(heartbeat), 'utf8').digest('base64url');
}

function isSecretishKey(key) {
  const normalized = String(key).replace(/[_-]/g, '').toLowerCase();
  if (normalized === 'publickey' || normalized.includes('publickey')) return false;

  return normalized.includes('secret')
    || normalized.includes('token')
    || normalized.includes('password')
    || normalized.includes('passwd')
    || normalized.includes('private')
    || normalized.includes('credential')
    || normalized.includes('authorization')
    || normalized.includes('auth')
    || normalized.includes('bearer')
    || normalized.includes('key')
    || normalized.includes('signature');
}

/** Structural redaction: decisions are based on field names, not field values. */
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') {
    // A private-key PEM is always sensitive even when a hostile input gives it
    // an innocuous field name.  This complements structural field redaction.
    return typeof value === 'string' && /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i.test(value)
      ? REDACTED
      : value;
  }

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isSecretishKey(key) ? REDACTED : redactSecrets(nested);
  }
  return result;
}

function containsAuthorityMutation(value) {
  if (Array.isArray(value)) return value.some(containsAuthorityMutation);
  if (!value || typeof value !== 'object') return false;

  return Object.entries(value).some(([key, nested]) => (
    /authority|spend/i.test(key) || containsAuthorityMutation(nested)
  ));
}

function freshState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    version: 0,
    records: Object.create(null),
    quarantine: [],
    audit: [],
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizePublicKey(value) {
  if (typeof value !== 'string' || !/^\s*-----BEGIN PUBLIC KEY-----/.test(value)) return undefined;
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') return undefined;
    return key.export({ format: 'pem', type: 'spki' }).toString();
  } catch {
    return undefined;
  }
}

function normalizeRecord(agentId, candidate) {
  const record = candidate && typeof candidate === 'object' ? candidate : {};
  const nonces = Object.create(null);
  if (record.nonces && typeof record.nonces === 'object') {
    for (const [nonce, digest] of Object.entries(record.nonces)) {
      if (typeof digest === 'string') nonces[nonce] = digest;
    }
  }

  return {
    agent_id: agentId,
    controller_id: typeof record.controller_id === 'string' ? record.controller_id : undefined,
    // This is a public verification key.  Private keys are neither accepted nor stored.
    controller_public_key: normalizePublicKey(record.controller_public_key),
    sequence: safeInteger(record.sequence),
    last_seen: typeof record.last_seen === 'string' ? record.last_seen : undefined,
    last_heartbeat_sequence: safeInteger(record.last_heartbeat_sequence),
    metadata: redactSecrets(record.metadata && typeof record.metadata === 'object' ? record.metadata : {}),
    authority_state: lockedAuthorityState(),
    revoked: record.revoked === true,
    revocation_reason: redactSecrets(record.revocation_reason),
    nonces,
  };
}

function normalizeState(candidate) {
  const state = freshState();
  if (!candidate || typeof candidate !== 'object') return state;

  state.version = safeInteger(candidate.version);
  if (candidate.records && typeof candidate.records === 'object') {
    for (const [agentId, record] of Object.entries(candidate.records)) {
      state.records[agentId] = normalizeRecord(agentId, record);
    }
  }
  state.quarantine = Array.isArray(candidate.quarantine) ? candidate.quarantine.map(redactSecrets) : [];
  state.audit = Array.isArray(candidate.audit) ? candidate.audit.map(redactSecrets) : [];
  return state;
}

export class MemoryRegistryStore {
  constructor(initialState) {
    this.state = initialState === undefined ? undefined : normalizeState(initialState);
  }

  async load() {
    return this.state === undefined ? undefined : cloneJson(this.state);
  }

  async save(state) {
    this.state = cloneJson(state);
    return cloneJson(this.state);
  }
}

export class JsonFileRegistryStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('JsonFileRegistryStore requires a file path');
    }
    this.filePath = filePath;
    this.version = 0;
  }

  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return undefined;
      throw error;
    }

    if (!parsed || parsed.schema_version !== STATE_SCHEMA_VERSION) {
      throw new Error(`Unsupported registry state schema in ${this.filePath}`);
    }
    this.version = safeInteger(parsed.version);
    return normalizeState(parsed);
  }

  async save(state) {
    const nextVersion = Math.max(this.version, safeInteger(state.version)) + 1;
    const persisted = {
      ...cloneJson(state),
      schema_version: STATE_SCHEMA_VERSION,
      version: nextVersion,
    };
    const temporaryPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );

    try {
      await writeFile(temporaryPath, JSON.stringify(persisted), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }

    this.version = nextVersion;
    return cloneJson(persisted);
  }
}

export class RegistryControlPlane {
  constructor({ store = new MemoryRegistryStore(), clock = () => Date.now() } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('RegistryControlPlane requires a registry store');
    }
    if (typeof clock !== 'function') throw new TypeError('RegistryControlPlane clock must be a function');

    this.store = store;
    this.clock = clock;
    this.state = freshState();
    this.loadPromise = undefined;
    this.locks = new Map();
    this.persistQueue = Promise.resolve();
  }

  async bootstrapAgent({ agentId, controllerId, controllerPublicKey } = {}) {
    this.#assertIdentifier(agentId, 'agentId');
    this.#assertIdentifier(controllerId, 'controllerId');
    if (typeof controllerPublicKey !== 'string' || controllerPublicKey.length === 0) {
      throw new TypeError('controllerPublicKey must be a PEM SPKI string');
    }

    const normalizedPublicKey = normalizePublicKey(controllerPublicKey);
    if (!normalizedPublicKey) {
      throw new TypeError('controllerPublicKey must be a valid PEM SPKI key');
    }

    return this.#withAgentLock(agentId, async () => {
      await this.#ensureLoaded();
      const existing = this.state.records[agentId];
      if (existing) {
        if (existing.controller_id !== controllerId || existing.controller_public_key !== normalizedPublicKey) {
          throw new RegistryRejectedError({ code: 'controller_binding_conflict' });
        }
        return { status: 'idempotent', agentId };
      }

      this.state.records[agentId] = normalizeRecord(agentId, {
        controller_id: controllerId,
        controller_public_key: normalizedPublicKey,
      });
      await this.#persist();
      return { status: 'bootstrapped', agentId };
    });
  }

  async ingestHeartbeat(heartbeat) {
    const agentId = heartbeat && typeof heartbeat === 'object' && typeof heartbeat.agentId === 'string'
      ? heartbeat.agentId
      : '__invalid_agent__';
    return this.#withAgentLock(agentId, async () => {
      await this.#ensureLoaded();
      return this.#ingestHeartbeatUnlocked(heartbeat);
    });
  }

  async revokeAgent(agentId, { reason } = {}) {
    this.#assertIdentifier(agentId, 'agentId');
    return this.#withAgentLock(agentId, async () => {
      await this.#ensureLoaded();
      const record = this.state.records[agentId];
      if (!record) throw new RegistryRejectedError({ code: 'unbound_agent' });
      if (record.revoked) return { status: 'idempotent', agentId };

      record.revoked = true;
      record.revocation_reason = redactSecrets(reason);
      this.state.audit.push({
        event_type: 'agent.revoked',
        agent_id: agentId,
        reason: redactSecrets(reason),
        recorded_at: this.#timestamp(),
      });
      await this.#persist();
      return { status: 'revoked', agentId };
    });
  }

  /**
   * Binds a new controller verification key only when the currently bound
   * controller proves possession of its outgoing private key.  Rotation is a
   * credential change, not a new registration: heartbeat sequence and nonce
   * history deliberately remain intact.
   */
  async rotateController(agentId, rotationRequest = {}) {
    this.#assertIdentifier(agentId, 'agentId');
    const { newControllerPublicKey, signature } = rotationRequest && typeof rotationRequest === 'object' && !Array.isArray(rotationRequest)
      ? rotationRequest
      : {};
    const rotation = { agentId, newControllerPublicKey, signature };
    return this.#withAgentLock(agentId, async () => {
      await this.#ensureLoaded();
      const record = this.state.records[agentId];
      if (!record) return this.#reject('unbound_agent', rotation);
      if (record.revoked) return this.#reject('revoked', rotation);

      // Validate the proof before accepting or storing the proposed key.  This
      // makes knowledge of an agent id insufficient to take over its record.
      if (!this.#validRotationSignature(rotation, record.controller_public_key, signature)) {
        return this.#reject('invalid_rotation_signature', rotation);
      }

      const normalizedPublicKey = normalizePublicKey(newControllerPublicKey);
      if (!normalizedPublicKey) return this.#reject('invalid_controller_public_key', rotation);

      record.controller_public_key = normalizedPublicKey;
      // Explicitly retain the locked authority state; a key rotation can never
      // enable execution, spending, or authority changes.
      record.authority_state = lockedAuthorityState();
      this.state.audit.push(redactSecrets({
        event_type: 'controller.rotated',
        agent_id: agentId,
        recorded_at: this.#timestamp(),
      }));
      await this.#persist();
      return { status: 'rotated', agentId };
    });
  }

  async getRecord(agentId) {
    await this.#ensureLoaded();
    const record = this.state.records[agentId];
    if (!record) return undefined;
    return {
      sequence: record.sequence,
      last_seen: record.last_seen,
      authority_state: lockedAuthorityState(),
    };
  }

  async emitRecord(agentId) {
    await this.#ensureLoaded();
    const record = this.state.records[agentId];
    if (!record) return undefined;
    return {
      schemaVersion: EMITTED_RECORD_SCHEMA_VERSION,
      agentId,
      lastSeen: record.last_seen,
      authorityState: {
        authorityChangesAllowed: false,
        spendAllowed: false,
        executionAllowed: false,
      },
      metadata: redactSecrets(record.metadata),
    };
  }

  async quarantineRecords() {
    await this.#ensureLoaded();
    return redactSecrets(this.state.quarantine);
  }

  async auditEvents() {
    await this.#ensureLoaded();
    return redactSecrets(this.state.audit);
  }

  async snapshot() {
    await this.#ensureLoaded();
    return redactSecrets(cloneJson(this.state));
  }

  async #ingestHeartbeatUnlocked(heartbeat) {
    if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)) {
      return this.#reject('invalid_heartbeat', heartbeat);
    }
    const { agentId, controllerId, nonce, issuedAt, expiresAt, sequence, payload, signature, schemaVersion } = heartbeat;
    if (typeof agentId !== 'string' || agentId.length === 0) return this.#reject('invalid_agent_id', heartbeat);

    const record = this.state.records[agentId];
    if (!record) return this.#reject('unbound_agent', heartbeat);
    if (record.revoked) return this.#reject('revoked', heartbeat);
    if (schemaVersion !== HEARTBEAT_SCHEMA_VERSION) return this.#reject('unsupported_schema', heartbeat);
    if (controllerId !== record.controller_id) return this.#reject('controller_binding_mismatch', heartbeat);
    if (typeof nonce !== 'string' || nonce.length === 0) return this.#reject('invalid_nonce', heartbeat);

    if (!this.#validHeartbeatSignature(heartbeat, record.controller_public_key, signature)) {
      return this.#reject('invalid_signature', heartbeat);
    }
    if (containsAuthorityMutation(payload)) return this.#reject('authority_mutation', heartbeat);

    const issuedAtMs = Date.parse(issuedAt);
    const expiresAtMs = Date.parse(expiresAt);
    const now = Number(this.clock());
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || !Number.isFinite(now)) {
      return this.#reject('invalid_timestamp', heartbeat);
    }
    if (issuedAtMs > now) return this.#reject('issued_at_in_future', heartbeat);
    if (expiresAtMs <= now) return this.#reject('expired', heartbeat);

    let digest;
    try {
      digest = heartbeatDigest(heartbeat);
    } catch {
      return this.#reject('invalid_heartbeat', heartbeat);
    }
    if (hasOwn(record.nonces, nonce)) {
      if (record.nonces[nonce] === digest) {
        return { status: 'idempotent', sequence: record.sequence };
      }
      return this.#reject('replay', heartbeat);
    }

    if (!Number.isSafeInteger(sequence) || sequence < 1) return this.#reject('invalid_sequence', heartbeat);
    if (record.last_heartbeat_sequence > 0 && sequence <= record.last_heartbeat_sequence) {
      return this.#reject('non_monotonic_sequence', heartbeat);
    }

    record.nonces[nonce] = digest;
    record.last_heartbeat_sequence = sequence;
    record.sequence += 1;
    record.last_seen = issuedAt;
    record.metadata = redactSecrets(payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload.metadata
      : {});
    // Never copy authority values from an untrusted heartbeat.
    record.authority_state = lockedAuthorityState();
    this.state.audit.push({
      event_type: 'heartbeat.accepted',
      agent_id: agentId,
      sequence: record.sequence,
      heartbeat_sequence: sequence,
      recorded_at: this.#timestamp(),
    });
    await this.#persist();
    return { status: 'accepted', sequence: record.sequence };
  }

  #validHeartbeatSignature(heartbeat, controllerPublicKey, signature) {
    return this.#validSignature(signingBytes, heartbeat, controllerPublicKey, signature);
  }

  #validRotationSignature(rotation, controllerPublicKey, signature) {
    return this.#validSignature(rotationSigningBytes, rotation, controllerPublicKey, signature);
  }

  #validSignature(bytesForSigning, signedObject, controllerPublicKey, signature) {
    if (typeof signature !== 'string' || signature.length === 0 || typeof controllerPublicKey !== 'string') return false;
    try {
      return cryptoVerify(null, bytesForSigning(signedObject), controllerPublicKey, Buffer.from(signature, 'base64url'));
    } catch {
      return false;
    }
  }

  async #reject(code, heartbeat) {
    this.state.quarantine.push({
      reason_code: code,
      recorded_at: this.#timestamp(),
      heartbeat: redactSecrets(heartbeat),
    });
    await this.#persist();
    throw new RegistryRejectedError({ code });
  }

  #assertIdentifier(value, name) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  }

  #timestamp() {
    const now = Number(this.clock());
    return Number.isFinite(now) ? new Date(now).toISOString() : new Date(0).toISOString();
  }

  async #ensureLoaded() {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        this.state = normalizeState(await this.store.load());
      })();
    }
    return this.loadPromise;
  }

  async #persist() {
    const work = this.persistQueue.then(async () => {
      const saved = await this.store.save(this.state);
      this.state.version = safeInteger(saved && saved.version, this.state.version);
    });
    this.persistQueue = work.catch(() => {});
    return work;
  }

  async #withAgentLock(agentId, operation) {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    const work = previous.then(operation, operation);
    const tail = work.catch(() => {});
    this.locks.set(agentId, tail);
    try {
      return await work;
    } finally {
      if (this.locks.get(agentId) === tail) this.locks.delete(agentId);
    }
  }
}
